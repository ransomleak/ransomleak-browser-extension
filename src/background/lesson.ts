// In-browser lessons: the completion event and the standalone lesson tab (consent / AI paste).
import { LESSON_KINDS, type LessonKind } from '../lesson/content.ts';
import { enqueue, flush } from './events.ts';
import { claimOnce, getAuth } from './store.ts';

export const LESSON_SEEN_KEY = 'lessonSeen';
const LESSON_SEEN_MS = 36 * 60 * 60 * 1000;
const WARNING_PATH = 'src/warning/warning.html';

/** Lowercase hostname: 1-253 chars, at least one dot, labels of [a-z0-9-] (punycode allowed). */
export function isHostname(d: unknown): d is string {
  if (typeof d !== 'string' || d.length < 1 || d.length > 253 || d !== d.toLowerCase()) return false;
  const labels = d.split('.');
  return labels.length >= 2 && labels.every((l) => l.length >= 1 && l.length <= 63 && /^[a-z0-9-]+$/.test(l));
}

export const isLessonKind = (k: unknown): k is LessonKind => typeof k === 'string' && (LESSON_KINDS as readonly string[]).includes(k);

/** Queues `browser.lesson_completed` at most once per kind + domain + UTC day. Returns whether it recorded. */
export async function recordLesson(kind: LessonKind, domain: string): Promise<boolean> {
  if (!isLessonKind(kind) || !isHostname(domain)) return false;
  const utcDay = new Date().toISOString().slice(0, 10);
  if (!(await claimOnce(LESSON_SEEN_KEY, `${kind}|${domain}|${utcDay}`, LESSON_SEEN_MS, true))) return false;
  await enqueue('browser.lesson_completed', domain, 'logged', kind);
  void flush();
  return true;
}

/** `open-lesson` from the consent / AI paste content script in a tab's top frame; the host comes from the sender. */
export async function openLesson(msg: { kind?: unknown }, sender: chrome.runtime.MessageSender): Promise<{ ok: boolean }> {
  if (msg.kind !== 'consent' && msg.kind !== 'aipaste') return { ok: false };
  if (!sender.tab || sender.frameId !== 0 || !sender.url) return { ok: false };
  let u: URL;
  try {
    u = new URL(sender.url);
  } catch {
    return { ok: false };
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !isHostname(u.hostname)) return { ok: false };
  const page = new URL(chrome.runtime.getURL(WARNING_PATH));
  page.searchParams.set('lesson', msg.kind);
  page.searchParams.set('d', u.hostname);
  const locale = (await getAuth())?.locale;
  if (locale && (['en', 'de', 'fr', 'it', 'nl', 'uk'] as string[]).includes(locale)) page.searchParams.set('l', locale);
  await chrome.tabs.create({ url: page.href });
  return { ok: true };
}

/** `lesson-done` from the standalone lesson page. */
export async function lessonDone(msg: { kind?: unknown; domain?: unknown }): Promise<{ ok: boolean }> {
  if (!isLessonKind(msg.kind) || !isHostname(msg.domain)) return { ok: false };
  return { ok: await recordLesson(msg.kind, msg.domain) };
}
