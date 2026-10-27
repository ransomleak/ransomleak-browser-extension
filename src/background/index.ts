// Service worker entry. Every listener is registered synchronously at top level (MV3 rule);
// all state is in chrome.storage because the worker is killed after ~30 s idle.
import { LEGACY_AI_USAGE_KEY, meAiUsage, sendAiUsage } from './ai-usage.ts';
import { handleConsent, handleConsentBlockRequest, handleConsentContinue, handleConsentMiss } from './consent.ts';
import { handleBind, openBind, popupInfo } from './enroll.ts';
import { handleConsentRequest } from './oauth-request.ts';
import { flush } from './events.ts';
import { ensureAlarms, sendHeartbeat } from './heartbeat.ts';
import { handleDownloadWarning, wireDownloads } from './downloads.ts';
import {
  aiPasteConfig, aiPasteEvent, extraModes, removeLegacyPasswordScript, siteReport, syncAiPasteScript,
} from './protect.ts';
import { forgetTab, handleWarning, WARNING_PATH, onBeforeNavigate, onCommitted, onTabUpdated, pruneThrottle } from './navigation.ts';
import { lessonDone, openLesson } from './lesson.ts';
import { FEEDS, feedInfo, feedStale, refreshFeed, refreshFeeds, syncPolicy } from './policy.ts';
import { dismissRecommendation, meSignals } from './signals.ts';
import { remindersActive, restoreBadge, storedTodo, syncTodo, wireNotifications } from './todo.ts';
import { claimOnce, getAuth, getPolicy } from './store.ts';
import { appLinks, type AppLinks } from '../lib/origin.ts';

type Msg = { type?: unknown; [k: string]: unknown };

/** Policy (and scripts) then the To do list: the startup and 30-min alarm sync. */
async function syncAll(): Promise<void> {
  await syncPolicyAndScripts();
  await syncTodo();
}

async function onStart(): Promise<void> {
  await Promise.allSettled([syncAll(), sendHeartbeat(), flush(), sendAiUsage()]);
}

/** At most one popup-open token check per this window, however often the popup is opened. */
export const POPUP_CHECK_MS = 60_000;
/** The popup waits this long for the checks before rendering the stored state. */
const POPUP_CHECK_WAIT_MS = 2_500;

/**
 * Popup-open refresh (each debounced on its own key): the token check (the ETag policy poll is the
 * cheapest authenticated call, and a revoked device / disabled user signs out through apiFetch) and the
 * To do list, so the card and badge are current without a faster alarm. onStartup runs the same syncs
 * via onStart(); the 30-min policy alarm covers the rest.
 */
async function popupRefresh(): Promise<void> {
  const auth = await getAuth();
  if (!auth || auth.needsReauth) return;
  const run = async (key: string, sync: () => Promise<unknown>): Promise<void> => {
    if (await claimOnce(key, 'popup', POPUP_CHECK_MS)) await sync().catch(() => {});
  };
  const syncs = Promise.all([run('authCheck', syncPolicyAndScripts), run('todoCheck', syncTodo)]);
  await Promise.race([syncs, new Promise((r) => setTimeout(r, POPUP_CHECK_WAIT_MS))]);
}

/** The To do list and reminder state for the popup. */
async function popupTodoInfo(): Promise<{
  todo: { items: unknown[]; total: number } | null;
  reminders: { allowed: boolean };
  links: AppLinks;
}> {
  const [todo, policy] = await Promise.all([storedTodo(), getPolicy()]);
  return {
    todo: todo ? { items: todo.items, total: todo.total } : null,
    reminders: { allowed: policy.notifications?.reminders === true },
    links: appLinks(policy.links),
  };
}

/** The download variant of our warning page (`?k=download&dl=<id>`), from this extension's own tab. */
function downloadWarning(sender: chrome.runtime.MessageSender): { tabId: number; id: number } | null {
  if (sender.id !== chrome.runtime.id || !sender.url || typeof sender.tab?.id !== 'number') return null;
  const page = chrome.runtime.getURL(WARNING_PATH);
  if (!sender.url.startsWith(page + '?')) return null;
  const q = new URL(sender.url).searchParams;
  const id = Number(q.get('dl'));
  return q.get('k') === 'download' && Number.isSafeInteger(id) && id >= 0 ? { tabId: sender.tab.id, id } : null;
}

/** Applies the current optional-permission state (content script registration, download / notification listeners). */
async function syncExtra(): Promise<void> {
  wireDownloads();
  wireNotifications();
  await removeLegacyPasswordScript();
  await syncAiPasteScript();
}

/** Policy poll; a changed policy may turn the AI paste detector on or off or change the tool list. */
async function syncPolicyAndScripts(): Promise<boolean> {
  const changed = await syncPolicy();
  if (changed) await syncAiPasteScript().catch(() => {});
  return changed;
}

/** Internal messages: popup, warning page and consent content script (this extension only). */
async function handleMessage(msg: Msg, sender: chrome.runtime.MessageSender): Promise<unknown> {
  if (sender.id !== chrome.runtime.id || !msg || typeof msg !== 'object') return undefined;
  const fromExtensionPage = !!sender.url?.startsWith(chrome.runtime.getURL(''));
  switch (msg.type) {
    case 'popup-info':
      if (!fromExtensionPage) return undefined;
      await popupRefresh().catch(() => {});
      {
        const [info, extra, todo] = await Promise.all([popupInfo(), extraModes(), popupTodoInfo()]);
        return { ...info, extra, ...todo };
      }
    case 'site-report':
      return fromExtensionPage ? siteReport(msg as { domain?: unknown; note?: unknown }) : undefined;
    case 'extra-protection-sync':
      if (!fromExtensionPage) return undefined;
      await syncExtra();
      return { ok: true };
    case 'reminders-sync':
      // After "Turn on reminders": wire the click listener and seed the seen list silently.
      if (!fromExtensionPage) return undefined;
      wireNotifications();
      await syncTodo().catch(() => {});
      return { ok: await remindersActive() };
    case 'aipaste-config':
      if (!sender.tab || fromExtensionPage) return undefined;
      return aiPasteConfig(sender);
    case 'aipaste-event':
      if (!sender.tab || fromExtensionPage) return undefined;
      return aiPasteEvent(msg as { category?: unknown; action?: unknown }, sender);
    case 'bind-start':
      if (!fromExtensionPage) return undefined;
      await openBind(true);
      return { ok: true };
    case 'me-signals':
      return fromExtensionPage ? meSignals(msg.days) : undefined;
    case 'me-dismiss-recommendation':
      return fromExtensionPage ? dismissRecommendation(msg.exerciseId) : undefined;
    case 'me-ai-usage':
      return fromExtensionPage ? meAiUsage() : undefined;
    case 'warning-info':
    case 'warning-action': {
      const dl = downloadWarning(sender);
      if (dl) return handleDownloadWarning(msg as { type: string; action?: unknown }, dl.tabId, dl.id);
      return handleWarning(msg as { type: string; action?: unknown }, sender);
    }
    case 'open-lesson':
      if (!sender.tab || fromExtensionPage) return undefined;
      return openLesson(msg as { kind?: unknown }, sender);
    case 'lesson-done':
      return fromExtensionPage ? lessonDone(msg as { kind?: unknown; domain?: unknown }) : undefined;
    case 'consent':
      if (!sender.tab || fromExtensionPage) return undefined;
      await handleConsent(msg as { info?: unknown; risky?: unknown }, sender);
      return { ok: true };
    case 'consent-request':
      if (!sender.tab || fromExtensionPage) return undefined;
      return handleConsentRequest(sender);
    case 'consent-action':
      if (!sender.tab || fromExtensionPage) return undefined;
      await handleConsentContinue(msg as { action?: unknown; info?: unknown }, sender);
      return { ok: true };
    case 'consent-miss':
      if (!sender.tab || fromExtensionPage) return undefined;
      await handleConsentMiss(msg as { provider?: unknown });
      return { ok: true };
    case 'block-request':
      if (!sender.tab || fromExtensionPage) return undefined;
      return { ok: await handleConsentBlockRequest(msg as { kind?: unknown; target?: unknown; label?: unknown }) };
    default:
      return undefined;
  }
}

chrome.runtime.onMessage.addListener((msg: Msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(
    (r) => sendResponse(r),
    () => sendResponse(undefined),
  );
  return true; // async sendResponse
});

chrome.runtime.onMessageExternal.addListener((msg: Msg, sender, sendResponse) => {
  handleBind(msg, sender).then(
    async (r) => {
      if (r === null) return sendResponse(undefined);
      sendResponse(r);
      if (r.ok) await onStart();
    },
    () => sendResponse(undefined),
  );
  return true;
});

chrome.webNavigation.onBeforeNavigate.addListener((d) => onBeforeNavigate(d).catch(() => {}));
chrome.webNavigation.onCommitted.addListener((d) => onCommitted(d).catch(() => {}));
// Prerender activation fallback (see prerender.ts): cheap when the tab has no remembered prerender.
chrome.webNavigation.onCompleted?.addListener((d) => void onTabUpdated(d.tabId).catch(() => {}));
chrome.tabs.onUpdated?.addListener((tabId) => void onTabUpdated(tabId).catch(() => {}));
chrome.tabs.onRemoved.addListener((tabId) => void forgetTab(tabId).catch(() => {}));

chrome.alarms.onAlarm.addListener(async (alarm) => {
  try {
    if (alarm.name === 'heartbeat') await Promise.allSettled([sendHeartbeat(), sendAiUsage()]);
    else if (alarm.name === 'policy') await Promise.allSettled([syncAll(), sendAiUsage()]); // AI counts and the To do list ride the 30-min alarm
    else if (alarm.name === 'nrd') await refreshFeeds(); // one daily alarm refreshes every feed
    else if (alarm.name === 'flush') await flush();
  } catch {
    /* next alarm retries */
  }
});

// Optional permissions granted from the popup, or revoked in chrome://extensions.
chrome.permissions?.onAdded?.addListener(() => void syncExtra().catch(() => {}));
chrome.permissions?.onRemoved?.addListener(() => void syncExtra().catch(() => {}));
wireDownloads(); // top level: the listener must exist when a download wakes the worker
wireNotifications(); // top level: a reminder click can wake the worker

chrome.runtime.onStartup.addListener(() => onStart());
chrome.runtime.onInstalled.addListener(async (details) => {
  // First run with no binding: open the bind page (spec section 4).
  if (details?.reason === 'install' && !(await getAuth())) await openBind().catch(() => {});
  await onStart();
});

/** Runs on every worker start (including idle wake-ups). Exported for tests. */
export const ready: Promise<void> = (async () => {
  try {
    await pruneThrottle();
    await chrome.storage.local.remove(LEGACY_AI_USAGE_KEY); // local-day buckets: replaced by UTC days
    await ensureAlarms();
    const [, , auth, policy] = await Promise.all([
      syncExtra().catch(() => {}),
      restoreBadge().catch(() => {}),
      getAuth(),
      getPolicy(),
    ]);
    if (auth && !auth.needsReauth) {
      for (const kind of FEEDS) if (feedInfo(policy, kind)?.url && (await feedStale(kind))) void refreshFeed(kind).catch(() => {});
    }
  } catch {
    /* storage unavailable: listeners still work */
  }
})();
