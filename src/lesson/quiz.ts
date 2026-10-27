import { DEFAULT_BRAND_OWNERS } from '../detect/brands';
import { CONFUSABLES } from '../lib/confusables';
import type { Strings } from '../lib/i18n';
import type { LessonKind } from './content';

export interface QuizOption { text: string; correct: boolean }

/** The real domain for a matched brand key / protected domain, or null when unknown. */
export function genuineDomain(
  matched: string,
  brandOwners: Record<string, string[]> | undefined,
  protectedDomains: string[] | undefined,
): string | null {
  const key = matched.toLowerCase();
  const owners = (brandOwners ?? DEFAULT_BRAND_OWNERS)[key];
  if (owners && owners.length > 0) return owners[0] ?? null;
  const hit = (protectedDomains ?? []).find((d) => d.toLowerCase() === key);
  return hit ? hit.toLowerCase() : null;
}

/** ASCII-only look-alike swaps derived from the confusables table (e.g. 0<->o, 1<->l, m<->rn). */
function asciiSwaps(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [cp, target] of Object.entries(CONFUSABLES)) {
    const src = String.fromCodePoint(Number(cp));
    if (!/^[a-z0-9]$/.test(src)) continue;
    const t = target.toLowerCase();
    if (!/^[a-z0-9]+$/.test(t) || t === src) continue;
    out.push([t, src]); // genuine text `t` can be disguised as `src`
    out.push([src, t]); // and the other way round
  }
  return out;
}

function shuffle<T>(items: T[], rand: () => number): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = a[i] as T;
    a[i] = a[j] as T;
    a[j] = tmp;
  }
  return a;
}

/**
 * Three options for "which one is the real address": the genuine domain plus two generated fakes.
 * Fakes never equal the genuine domain, the person's own (fake) domain, or each other.
 */
export function lookalikeQuiz(genuine: string, caseDomain: string, rand: () => number = Math.random): QuizOption[] {
  const real = genuine.toLowerCase();
  const own = caseDomain.toLowerCase();
  const dot = real.indexOf('.');
  const label = dot > 0 ? real.slice(0, dot) : real;
  const rest = dot > 0 ? real.slice(dot) : '.com';

  const taken = new Set<string>([real, own]);
  const fakes: string[] = [];
  const add = (c: string): boolean => {
    if (!c || taken.has(c) || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(c)) return false;
    taken.add(c);
    fakes.push(c);
    return true;
  };

  // Pattern 1: one look-alike character swap inside the label.
  const swaps = asciiSwaps();
  for (const [from, to] of swaps) {
    let idx = label.indexOf(from);
    while (idx !== -1) {
      if (add(label.slice(0, idx) + to + label.slice(idx + from.length) + rest)) break;
      idx = label.indexOf(from, idx + 1);
    }
    if (fakes.length) break;
  }
  // Pattern 2: real name plus a suffix.
  add(`${label}-secure${rest}`);
  add(`${real}-login.co`);
  // Fallbacks (always succeed, so there are always exactly two distinct fakes).
  add(`${label}-verify${rest}`);
  add(`${label}-support${rest}`);
  for (let n = 1; fakes.length < 2; n++) add(`${label}-${n}${rest}`);

  return shuffle(
    [{ text: real, correct: true }, ...fakes.slice(0, 2).map((text) => ({ text, correct: false }))],
    rand,
  );
}

/** Fixed three-option quiz from the locale strings. */
export function fixedQuiz(s: Strings, kind: LessonKind, rand: () => number = Math.random): QuizOption[] {
  const g = s as unknown as Record<string, string>;
  const t = (k: string): string => g[k] ?? '';
  return shuffle(
    [
      { text: t(`lesson_${kind}_a`), correct: true },
      { text: t(`lesson_${kind}_w1`), correct: false },
      { text: t(`lesson_${kind}_w2`), correct: false },
    ],
    rand,
  );
}
