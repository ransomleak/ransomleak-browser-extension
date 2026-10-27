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
const SHARED = ['next', 'done_title', 'done_body', 'back_safety', 'open_course', 'real_one', 'genuine_q', 'step'];

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

import { DEFAULT_BRAND_OWNERS } from '../src/detect/brands';
import { fixedQuiz, genuineDomain, lookalikeQuiz } from '../src/lesson/quiz';
import { stringsFor } from '../src/lib/i18n';

function seeded(seed: number): () => number {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
}

describe('lesson quiz', () => {
  it('genuineDomain resolves brand keys and protected domains', () => {
    expect(genuineDomain('microsoft', DEFAULT_BRAND_OWNERS, [])).toBe('microsoft.com');
    expect(genuineDomain('acme.com', {}, ['acme.com'])).toBe('acme.com');
    expect(genuineDomain('nobrand', {}, [])).toBeNull();
  });

  it('lookalikeQuiz never offers the person\'s own domain and has one correct answer', () => {
    const q = lookalikeQuiz('microsoft.com', 'micros0ft-login.com')!;
    expect(new Set(q.map((o) => o.text)).size).toBe(3);
    expect(q.filter((o) => o.correct)).toHaveLength(1);
    expect(q.find((o) => o.correct)!.text).toBe('microsoft.com');
    expect(q.some((o) => o.text === 'micros0ft-login.com')).toBe(false);
  });

  it('lookalikeQuiz keeps three distinct options for very short domains and colliding case domains', () => {
    for (const [g, c] of [['x.com', 'x-login.com'], ['x.com', 'x-secure.com'], ['x.com', 'x.com-login.co'], ['paypal.com', 'paypa1.com'], ['a.io', 'a-secure.io']] as Array<[string, string]>) {
      const q = lookalikeQuiz(g, c, seeded(3))!;
      expect(new Set(q.map((o) => o.text)).size, g + c).toBe(3);
      expect(q.some((o) => o.text === c)).toBe(false);
      expect(q.filter((o) => o.correct).map((o) => o.text)).toEqual([g]);
    }
  });

  it('is deterministic with a seeded rand', () => {
    expect(lookalikeQuiz('microsoft.com', 'micros0ft-login.com', seeded(7))).toEqual(
      lookalikeQuiz('microsoft.com', 'micros0ft-login.com', seeded(7)),
    );
  });

  it('fixedQuiz returns a/w1/w2 with one correct', () => {
    const q = fixedQuiz(stringsFor('en'), 'download', seeded(1));
    expect(q).toHaveLength(3);
    expect(q.filter((o) => o.correct)).toHaveLength(1);
  });

  it('returns null (caller uses fixedQuiz) for IDN and punycode genuine domains, without hanging', () => {
    expect(lookalikeQuiz('bücher.de', 'evil.com')).toBeNull();
    expect(lookalikeQuiz('xn--bcher-kva.de', 'evil.com')).toBeNull();
    expect(lookalikeQuiz('', 'evil.com')).toBeNull();
  });

  it('multi-label genuine domains: fakes are never under the genuine registrable domain', () => {
    const q = lookalikeQuiz('login.microsoftonline.com', 'evil.com', seeded(5))!;
    const fakes = q.filter((o) => !o.correct).map((o) => o.text);
    expect(fakes).toHaveLength(2);
    for (const f of fakes) {
      expect(f.endsWith('microsoftonline.com')).toBe(false);
      expect(f.split('.').length).toBe(2);
    }
  });

  it('respects the deny list and brand-owned domains', () => {
    const q = lookalikeQuiz('acme.com', 'evil.com', seeded(2), ['acme-secure.com', 'acme-login.com'])!;
    const fakes = q.filter((o) => !o.correct).map((o) => o.text);
    expect(fakes).not.toContain('acme-secure.com');
    expect(fakes).not.toContain('acme-login.com');
    expect(fakes).toHaveLength(2);
    const ms = lookalikeQuiz('microsoft.com', 'evil.com')!.filter((o) => !o.correct).map((o) => o.text);
    expect(ms).not.toContain('microsoft.com');
  });
});
