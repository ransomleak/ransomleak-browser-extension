import { describe, expect, it } from 'vitest';
import { LESSON_KINDS, lessonKindFor } from '../src/lesson/content';
import de from '../src/lib/i18n/de.json';
import en from '../src/lib/i18n/en.json';
import fr from '../src/lib/i18n/fr.json';
import itL from '../src/lib/i18n/it.json';
import nl from '../src/lib/i18n/nl.json';
import uk from '../src/lib/i18n/uk.json';

const LOCALES: Record<string, Record<string, string>> = { en, de, fr, it: itL, nl, uk };
const PARTS = ['title', 'what', 'habit1', 'habit2', 'q', 'a', 'w1', 'w2', 'why'];
const SHARED = ['next', 'check', 'retry', 'done_title', 'done_body', 'back_safety', 'open_course', 'real_one', 'genuine_q', 'step'];

describe('lesson content', () => {
  it('every lesson kind has every string in every locale, non-empty', () => {
    for (const [loc, strings] of Object.entries(LOCALES)) {
      for (const kind of LESSON_KINDS) {
        for (const part of PARTS) {
          const v = strings[`lesson_${kind}_${part}`];
          expect(typeof v === 'string' && v.trim().length > 0, `${loc} lesson_${kind}_${part}`).toBe(true);
        }
      }
      for (const key of SHARED) {
        const v = strings[`lesson_${key}`];
        expect(typeof v === 'string' && v.trim().length > 0, `${loc} lesson_${key}`).toBe(true);
      }
    }
  });

  it('keeps placeholders in every locale', () => {
    for (const [loc, s] of Object.entries(LOCALES)) {
      expect(s['lesson_genuine_q'], loc).toContain('{brand}');
      expect(s['lesson_step'], loc).toContain('{n}');
      expect(s['lesson_step'], loc).toContain('{total}');
    }
  });

  it('lessonKindFor maps tenant/brand/watch→lookalike, risky→new_domain, known→reported, download→download', () => {
    expect(lessonKindFor('tenant')).toBe('lookalike');
    expect(lessonKindFor('brand')).toBe('lookalike');
    expect(lessonKindFor('watch')).toBe('lookalike');
    expect(lessonKindFor('risky')).toBe('new_domain');
    expect(lessonKindFor('known')).toBe('reported');
    expect(lessonKindFor('download')).toBe('download');
  });
});
