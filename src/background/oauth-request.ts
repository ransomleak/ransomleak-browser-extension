// Captures the OAuth request (provider, client_id, scopes) from top-frame authorize/consent navigations,
// so the consent page can be judged even when its own URL drops `scope` and its text is localized.
// Stored only in chrome.storage.session per tab; never sent anywhere.
import { requestFromUrl, type OAuthRequest } from '../lib/oauth-request.ts';
import { providerForHost } from '../lib/providers.ts';
import { getSession, setSession } from './store.ts';

export const OAUTH_REQ_TTL_MS = 5 * 60_000;
const NO_CLIENT_ID_MAX_AGE_MS = 2 * 60_000;
const key = (tabId: number): string => `oauthReq:${tabId}`;

export async function captureOAuthRequest(tabId: number, url: string): Promise<void> {
  const r = requestFromUrl(url);
  if (!r) {
    // Leaving the provider hosts ends the OAuth flow for this tab.
    let host: string | null = null;
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') host = u.hostname;
    } catch {
      /* not a URL */
    }
    if (host && !providerForHost(host)) await chrome.storage.session.remove(key(tabId));
    return;
  }
  const prev = await getSession<OAuthRequest>(key(tabId));
  const fresh = prev && Date.now() - prev.at < OAUTH_REQ_TTL_MS && prev.at <= Date.now() ? prev : null;
  // A missing client_id on either side counts as a different request: replace, never merge.
  const same = !!fresh && fresh.provider === r.provider && !!r.clientId && fresh.clientId === r.clientId;
  // Scopes present: always replace (a different scope set is a new request). No scopes: keep the same client's entry.
  if (r.scopes.length || !same) await setSession({ [key(tabId)]: { ...r, at: Date.now() } });
}

/** Answers the consent content script for its own tab only. */
export async function handleConsentRequest(sender: chrome.runtime.MessageSender): Promise<OAuthRequest | null> {
  const tabId = sender.tab?.id;
  if (typeof tabId !== 'number' || !sender.url) return null;
  let page: URL;
  try {
    page = new URL(sender.url);
  } catch {
    return null;
  }
  const r = await getSession<OAuthRequest>(key(tabId));
  if (!r || providerForHost(page.hostname) !== r.provider) return null;
  const age = Date.now() - r.at;
  if (age < 0 || age >= OAUTH_REQ_TTL_MS) return null;
  const pageClient = page.searchParams.get('client_id');
  if (pageClient) {
    if (pageClient !== r.clientId) return null;
  } else if (age >= NO_CLIENT_ID_MAX_AGE_MS) return null;
  return { provider: r.provider, clientId: r.clientId, scopes: r.scopes, at: r.at };
}

export const oauthRequestKey = key;
