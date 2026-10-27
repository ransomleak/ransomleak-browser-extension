// Prerendered pages (omnibox / speculation rules). A prerender commits in the background with
// documentLifecycle 'prerender' and is judged only once it is shown. Chrome reports the activation as
// onBeforeNavigate/onCommitted/onCompleted with lifecycle 'active' and the SAME documentId; as a
// fallback (should an activation arrive without those events), tabs.onUpdated for the tab asks
// webNavigation.getFrame({documentId}) whether the remembered document is now active.
// A prerender that is never shown stays 'prerender' until discarded and is never judged.
import { getSession, locked, setSession } from './store.ts';

/** Remembered prerenders expire: a speculation the user never opened is dropped. */
export const PRERENDER_TTL_MS = 10 * 60_000;
const MAX_PER_TAB = 5;

export interface PrerenderEntry { doc: string; url: string; at: number }

const key = (tabId: number): string => `prerender:${tabId}`;
const doneKey = (tabId: number): string => `prerenderDone:${tabId}`;
const live = (e: { at: number }, now = Date.now()): boolean => now >= e.at && now - e.at < PRERENDER_TTL_MS;

export async function rememberPrerender(tabId: number, doc: string | undefined, url: string): Promise<void> {
  if (!doc) return; // without a documentId the activation cannot be matched
  await locked(async () => {
    const list = ((await getSession<PrerenderEntry[]>(key(tabId))) ?? []).filter((e) => live(e) && e.doc !== doc);
    list.push({ doc, url: url.split('#')[0]!, at: Date.now() });
    await setSession({ [key(tabId)]: list.slice(-MAX_PER_TAB) });
  });
}

/** Live remembered prerenders of a tab. */
export async function prerendersOf(tabId: number): Promise<PrerenderEntry[]> {
  return ((await getSession<PrerenderEntry[]>(key(tabId))) ?? []).filter((e) => live(e));
}

/**
 * Consumes a remembered prerender once it is active. 'fresh' = remembered and now claimed by this
 * caller; 'dup' = already claimed (judged); 'none' = not a remembered prerender (an ordinary page).
 */
export function claimActivation(tabId: number, doc: string): Promise<'fresh' | 'dup' | 'none'> {
  return locked(async () => {
    const done = ((await getSession<{ doc: string; at: number }[]>(doneKey(tabId))) ?? []).filter((e) => live(e));
    if (done.some((e) => e.doc === doc)) return 'dup';
    const list = (await getSession<PrerenderEntry[]>(key(tabId))) ?? [];
    if (!list.some((e) => e.doc === doc && live(e))) return 'none';
    done.push({ doc, at: Date.now() });
    await setSession({ [key(tabId)]: list.filter((e) => e.doc !== doc && live(e)), [doneKey(tabId)]: done.slice(-MAX_PER_TAB) });
    return 'fresh';
  });
}

export async function activationDone(tabId: number, doc: string): Promise<boolean> {
  const done = (await getSession<{ doc: string; at: number }[]>(doneKey(tabId))) ?? [];
  return done.some((e) => e.doc === doc && live(e));
}

export async function forgetPrerenders(tabId: number): Promise<void> {
  await chrome.storage.session.remove([key(tabId), doneKey(tabId)]);
}
