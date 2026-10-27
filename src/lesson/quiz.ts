import { parse } from 'tldts';
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
 * Fakes never equal the genuine domain, the person's own (fake) domain, or each other, and never live under
 * the genuine registrable domain or any brand-owned domain (`deny` plus DEFAULT_BRAND_OWNERS).
 * Returns null when a safe quiz cannot be generated (IDN / punycode / unparsable genuine domain);
 * the caller then uses `fixedQuiz`.
 */
export function lookalikeQuiz(
  genuine: string,
  caseDomain: string,
  rand: () => number = Math.random,
  deny: string[] = [],
): QuizOption[] | null {
  const real = genuine.toLowerCase();
  const own = caseDomain.toLowerCase();
  const p = parse(real);
  const label = p.domainWithoutSuffix ?? '';
  const suffix = p.publicSuffix ?? '';
  const realReg = p.domain ?? '';
  if (!realReg || !label || !suffix) return null;
  if (!/^[a-z0-9-]+$/.test(label) || label.startsWith('xn--') || !/^[a-z0-9.-]+$/.test(suffix) || suffix.includes('xn--')) return null;

  const blocked = new Set<string>(deny.map((d) => d.toLowerCase()));
  for (const list of Object.values(DEFAULT_BRAND_OWNERS)) for (const d of list) blocked.add(d.toLowerCase());
  blocked.add(realReg);

  const taken = new Set<string>([real, own]);
  const fakes: string[] = [];
  const add = (l: string): boolean => {
    const c = `${l}.${suffix}`;
    if (taken.has(c) || !/^[a-z0-9-]+$/.test(l) || l.startsWith('-') || l.endsWith('-') || l.length > 63) return false;
    const reg = parse(c).domain;
    if (!reg || reg !== c || blocked.has(reg)) return false;
    taken.add(c);
    fakes.push(c);
    return true;
  };

  // Pattern 1: one look-alike character swap inside the label.
  const swaps = asciiSwaps();
  outer: for (const [from, to] of swaps) {
    for (let idx = label.indexOf(from); idx !== -1; idx = label.indexOf(from, idx + 1)) {
      if (add(label.slice(0, idx) + to + label.slice(idx + from.length))) break outer;
    }
  }
  // Pattern 2: real name plus a suffix word; then bounded fallbacks.
  for (const w of ['secure', 'login', 'verify', 'support']) if (fakes.length < 2) add(`${label}-${w}`);
  for (let n = 1; n <= 20 && fakes.length < 2; n++) add(`${label}-${n}`);
  if (fakes.length < 2) return null;

  return shuffle(
    [{ text: real, correct: true }, ...fakes.slice(0, 2).map((text) => ({ text, correct: false }))],
    rand,
  );
}

/** Looks up a lesson string by dynamic key; missing keys give ''. */
export function lessonText(s: Strings): (key: string) => string {
  const g = s as unknown as Record<string, string>;
  return (k) => g[k] ?? '';
}

/** Fixed three-option quiz from the locale strings. */
export function fixedQuiz(s: Strings, kind: LessonKind, rand: () => number = Math.random): QuizOption[] {
  const t = lessonText(s);
  return shuffle(
    [
      { text: t(`lesson_${kind}_a`), correct: true },
      { text: t(`lesson_${kind}_w1`), correct: false },
      { text: t(`lesson_${kind}_w2`), correct: false },
    ],
    rand,
  );
}
