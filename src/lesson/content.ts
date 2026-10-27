// Lesson kinds. The copy lives in src/lib/i18n/*.json under `lesson_<kind>_<part>`.
export type LessonKind = 'lookalike' | 'new_domain' | 'reported' | 'download' | 'consent' | 'aipaste';

export const LESSON_KINDS: readonly LessonKind[] = ['lookalike', 'new_domain', 'reported', 'download', 'consent', 'aipaste'];

/** Kinds that run as a standalone lesson tab (opened from an in-page overlay), not from a warning. */
export const STANDALONE_KINDS = ['consent', 'aipaste'] as const;
export type StandaloneKind = (typeof STANDALONE_KINDS)[number];
export const isStandaloneKind = (k: unknown): k is StandaloneKind => typeof k === 'string' && (STANDALONE_KINDS as readonly string[]).includes(k);

export type WarningKind = 'tenant' | 'brand' | 'watch' | 'risky' | 'known' | 'download';

export function lessonKindFor(warningKind: WarningKind): LessonKind {
  switch (warningKind) {
    case 'tenant':
    case 'brand':
    case 'watch':
      return 'lookalike';
    case 'risky':
      return 'new_domain';
    case 'known':
      return 'reported';
    case 'download':
      return 'download';
  }
}
