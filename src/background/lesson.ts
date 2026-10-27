// In-browser lessons: the completion event and the standalone lesson tab (consent / AI paste).
import { LESSON_KINDS, lessonKindFor, type LessonKind, type WarningKind } from '../lesson/content.ts';
import { isHostname } from '../lib/domain.ts';
import { enqueue, flush } from './events.ts';
import { claimOnce } from './store.ts';

export const LESSON_SEEN_KEY = 'lessonSeen';
const LESSON_SEEN_MS = 36 * 60 * 60 * 1000;

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

/** The `lesson` field of the warning page's info; defaults suit a lesson with no brand to compare against. */
export function lessonPayload(
  kind: WarningKind | LessonKind,
  o: { genuine?: string | null; deny?: string[]; course?: boolean } = {},
): { kind: LessonKind; genuine: string | null; deny: string[]; course: boolean } {
  const k = isLessonKind(kind) ? kind : lessonKindFor(kind);
  return { kind: k, genuine: o.genuine ?? null, deny: o.deny ?? [], course: o.course ?? false };
}
