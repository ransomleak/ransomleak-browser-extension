// Standalone lesson tab (consent / AI paste): opening it and recording its completion.
import { isHostname } from '../lib/domain.ts';
import { isSupportedLocale } from '../lib/locales.ts';
import { isStandaloneKind } from '../lesson/content.ts';
import { recordLesson } from './lesson.ts';
import { WARNING_PATH } from './navigation.ts';
import { claimOnce, getAuth } from './store.ts';

const OPEN_LESSON_MS = 5000;
export const OPEN_LESSON_KEY = 'lessonOpened';

/** `open-lesson` from the consent / AI paste content script in a tab's top frame; the host comes from the sender. */
export async function openLesson(msg: { kind?: unknown }, sender: chrome.runtime.MessageSender): Promise<{ ok: boolean }> {
  if (!isStandaloneKind(msg.kind)) return { ok: false };
  if (!sender.tab || sender.frameId !== 0 || !sender.url) return { ok: false };
  let u: URL;
  try {
    u = new URL(sender.url);
  } catch {
    return { ok: false };
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !isHostname(u.hostname)) return { ok: false };
  if (!(await claimOnce(OPEN_LESSON_KEY, `${sender.tab.id}|${msg.kind}`, OPEN_LESSON_MS, true))) return { ok: false };
  const page = new URL(chrome.runtime.getURL(WARNING_PATH));
  page.searchParams.set('lesson', msg.kind);
  page.searchParams.set('d', u.hostname);
  const locale = (await getAuth())?.locale;
  if (isSupportedLocale(locale)) page.searchParams.set('l', locale);
  await chrome.tabs.create({ url: page.href });
  return { ok: true };
}

/** `lesson-done` from the standalone lesson page (consent / AI paste only; the warning page records the rest). */
export async function lessonDone(msg: { kind?: unknown; domain?: unknown }): Promise<{ ok: boolean }> {
  if (!isStandaloneKind(msg.kind) || !isHostname(msg.domain)) return { ok: false };
  return { ok: await recordLesson(msg.kind, msg.domain) };
}
