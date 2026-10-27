// Lesson kinds. The copy lives in src/lib/i18n/*.json under `lesson_<kind>_<part>`.
export type LessonKind = 'lookalike' | 'new_domain' | 'reported' | 'download' | 'consent' | 'aipaste';

export const LESSON_KINDS: readonly LessonKind[] = ['lookalike', 'new_domain', 'reported', 'download', 'consent', 'aipaste'];

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
