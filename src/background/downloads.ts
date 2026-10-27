// Risky download warning (optional `downloads` permission). A file of a risky type from a site the
// shared classifier flags is paused before its name is settled; warn mode opens the warning page's
// download variant (Go back = cancel and erase, Keep download = resume); log mode records only.
import { enqueue, flush } from './events.ts';
import { classify, WARNING_PATH } from './navigation.ts';
import { extraModeOf, getAuthAndPolicy, getSession, setSession } from './store.ts';

export type FileCategory = 'executable' | 'script' | 'macro_office' | 'archive' | 'disk_image';
const EXT: Record<string, FileCategory> = {
  exe: 'executable', msi: 'executable', scr: 'executable', jar: 'executable',
  bat: 'script', cmd: 'script', ps1: 'script', vbs: 'script', js: 'script',
  docm: 'macro_office', xlsm: 'macro_office', pptm: 'macro_office',
  iso: 'disk_image', img: 'disk_image', dmg: 'disk_image',
  zip: 'archive', rar: 'archive', '7z': 'archive',
};

/** The risky category of a file name (last extension, case-insensitive), or null. */
export function categoryOf(name: string | undefined): FileCategory | null {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  const m = /\.([a-z0-9]{1,5})$/i.exec(base);
  return m ? EXT[m[1]!.toLowerCase()] ?? null : null;
}

const baseName = (name: string): string => name.split(/[\\/]/).pop() ?? '';
/** Display copy only: keeps the end so the extension stays visible. Never used for classification. */
const displayName = (name: string): string => (name.length > 200 ? `…${name.slice(-199)}` : name);
/** blob:https://host/uuid → https://host/uuid; data: and other non-web schemes → null. */
const webSource = (u: string | undefined): string | null => {
  if (!u) return null;
  const raw = u.startsWith('blob:') ? u.slice(5) : u;
  try {
    const p = new URL(raw).protocol;
    return p === 'http:' || p === 'https:' ? raw : null;
  } catch {
    return null;
  }
};
/** The last flagged page the user was on (set by navigation), used when a download has no web source. */
export const RECENT_FLAGGED_KEY = 'recentFlagged';
const RECENT_FLAGGED_MS = 10 * 60_000;
const pathName = (url: string): string => {
  try { return decodeURIComponent(new URL(url).pathname); } catch { return ''; }
};

export interface PendingDownload { id: number; filename: string; domain: string; category: FileCategory }
export const downloadKey = (id: number): string => `download:${id}`;

/** Decides one download. Exported for tests. */
export async function judgeDownload(item: chrome.downloads.DownloadItem): Promise<void> {
  // Classify the full, untruncated names: the saved file name and every URL path we know.
  const name = baseName(item.filename || pathName(webSource(item.finalUrl || item.url) ?? ''));
  const category =
    categoryOf(item.filename) ??
    categoryOf(pathName(webSource(item.finalUrl) ?? '')) ??
    categoryOf(pathName(webSource(item.url) ?? ''));
  if (!category) return;
  const { auth, policy } = await getAuthAndPolicy();
  if (!auth || auth.needsReauth) return;
  const mode = extraModeOf(policy.detectors?.downloads);
  if (mode === 'off') return;
  let domain: string | null = null;
  for (const raw of [item.finalUrl, item.url, item.referrer]) {
    const src = webSource(raw);
    if (!src) continue;
    const v = (await classify(src, policy, auth.tenantOrigin))?.verdict;
    if (v) { domain = v.domain; break; }
  }
  // blob:/data: downloads built by a page's script may carry no usable source or referrer: fall back to
  // the flagged page the user was last on.
  if (!domain && ![item.finalUrl, item.url, item.referrer].some((u) => webSource(u))) {
    const recent = await getSession<{ domain: string; at: number }>(RECENT_FLAGGED_KEY);
    if (recent && Date.now() - recent.at < RECENT_FLAGGED_MS) domain = recent.domain;
  }
  if (!domain) return;
  if (mode === 'log') {
    await enqueue('browser.risky_download_warned', domain, 'logged', category);
    void flush();
    return;
  }
  await chrome.downloads.pause(item.id).catch(() => {}); // may already be complete: Go back then removes the file
  const pending: PendingDownload = { id: item.id, filename: displayName(name) || '?', domain, category };
  await setSession({ [downloadKey(item.id)]: pending });
  await enqueue('browser.risky_download_warned', domain, 'warned', category);
  void flush();
  const page = new URL(chrome.runtime.getURL(WARNING_PATH));
  page.searchParams.set('k', 'download');
  page.searchParams.set('dl', String(item.id));
  await chrome.tabs.create({ url: page.href });
}

/** onDeterminingFilename: the name is settled only after the download has been paused (when warned). */
function onDeterminingFilename(item: chrome.downloads.DownloadItem, suggest: (s?: chrome.downloads.FilenameSuggestion) => void): boolean {
  judgeDownload(item).catch(() => {}).finally(() => {
    try { suggest(); } catch { /* already suggested */ }
  });
  return true; // suggest is called asynchronously
}

/** Adds the listener when the permission is present (at start, and after it is granted). Idempotent. */
export function wireDownloads(): void {
  const ev = chrome.downloads?.onDeterminingFilename;
  if (ev && !ev.hasListener(onDeterminingFilename)) ev.addListener(onDeterminingFilename);
}

/** The download variant of the warning page. */
export async function handleDownloadWarning(msg: { type: string; action?: unknown }, tabId: number, id: number): Promise<unknown> {
  const p = await getSession<PendingDownload>(downloadKey(id));
  if (!p) return { error: 'no-warning' };
  if (msg.type === 'warning-info') {
    const { auth } = await getAuthAndPolicy();
    return { domain: p.domain, filename: p.filename, kind: 'download', mode: 'warn', highlight: [0, 0], learn: false, locale: auth?.locale ?? 'en' };
  }
  if (msg.action !== 'back' && msg.action !== 'keep') return { ok: false };
  await chrome.storage.session.remove(downloadKey(id));
  if (msg.action === 'keep') {
    await chrome.downloads.resume(id).catch(() => {});
    await enqueue('browser.risky_download_warned', p.domain, 'proceeded', p.category);
  } else {
    await chrome.downloads.cancel(id).catch(() => {});
    await chrome.downloads.removeFile(id).catch(() => {}); // finished before the pause landed
    await chrome.downloads.erase({ id }).catch(() => {});
    await enqueue('browser.risky_download_warned', p.domain, 'went_back', p.category);
  }
  void flush();
  await chrome.tabs.remove(tabId).catch(() => {});
  return { ok: true };
}
