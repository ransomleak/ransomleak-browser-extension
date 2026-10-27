// Sensitive-paste detection for AI tools. Runs entirely in the content script on the pasted text,
// which is never stored, logged or sent anywhere: only the resulting category leaves the page.

export type PasteCategory = 'secret' | 'card' | 'emails' | 'large';
export const PASTE_CATEGORIES: readonly PasteCategory[] = ['secret', 'card', 'emails', 'large'];

/** Pastes longer than this many characters count as `large`. */
export const LARGE_PASTE_CHARS = 2000;
/** This many distinct email addresses or more count as `emails`. */
export const MIN_EMAILS = 5;
/** Texts longer than this are only scanned in their first part (keeps a huge paste cheap). */
const SCAN_CHARS = 200_000;

const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_)
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/, // GitHub fine-grained token
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, // Slack tokens
  /\bAIza[0-9A-Za-z_-]{35}\b/, // Google API key
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/, // OpenAI / Anthropic keys
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/, // PEM / PGP private keys
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/, // JWT
];

export function hasSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

/** Luhn checksum over a string of digits. */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** A Luhn-valid 13 to 19 digit sequence, digits optionally grouped by single spaces or dashes. */
export function hasCard(text: string): boolean {
  for (const m of text.matchAll(/(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g)) {
    const digits = m[0].replace(/[ -]/g, '');
    if (/^(\d)\1+$/.test(digits)) continue; // 0000 0000 0000 0000 and the like
    if (luhnValid(digits)) return true;
  }
  return false;
}

export function countEmails(text: string, stopAt = Infinity): number {
  const seen = new Set<string>();
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g)) {
    seen.add(m[0].toLowerCase());
    if (seen.size >= stopAt) break;
  }
  return seen.size;
}

/** First matching category by priority secret > card > emails > large, or null. */
export function detectSensitive(text: string | null | undefined): PasteCategory | null {
  if (!text) return null;
  const s = text.length > SCAN_CHARS ? text.slice(0, SCAN_CHARS) : text;
  if (hasSecret(s)) return 'secret';
  if (hasCard(s)) return 'card';
  if (countEmails(s, MIN_EMAILS) >= MIN_EMAILS) return 'emails';
  if (text.length > LARGE_PASTE_CHARS) return 'large';
  return null;
}
