// Typed chrome.storage helpers and shared types. All state lives in storage: the worker dies after ~30 s.

import type { Mode } from '../lib/mode.ts';

export { modeOf, type Mode } from '../lib/mode.ts';
/** One warning/event per domain (or consent app) per 24 h. */
export const THROTTLE_MS = 24 * 3_600_000;
/** Detector mode -> event action. */
export const actionFor = (m: Mode): Action => (m === 'block' ? 'blocked' : m === 'warn' ? 'warned' : 'logged');

export type Locale = 'en' | 'de' | 'fr' | 'it' | 'nl' | 'uk';
export const LOCALES: readonly Locale[] = ['en', 'de', 'fr', 'it', 'nl', 'uk'];

export interface Auth {
  token: string;
  refreshToken: string;
  expiresAt: string;
  tenant: string;
  tenantName: string;
  tenantOrigin: string;
  apiBaseUrl: string;
  locale: Locale;
  /** The bound user's id (enroll/refresh). A different user re-binding clears all per-user state. */
  userId?: string;
  needsReauth?: boolean;
  /** Incremented on every bind; ties queued events and in-flight requests to one binding. */
  generation?: number;
}

/** Modes of the extra-protection detectors (no block). */
export type ExtraMode = 'warn' | 'log' | 'off';
export const extraModeOf = (m: unknown): ExtraMode => (m === 'log' || m === 'off' ? m : 'warn');
/** Sensitive paste into AI tools: admin opt-in, so anything unknown or missing is 'off'. */
export type AiPasteMode = 'warn' | 'block' | 'off';
export const aiPasteModeOf = (m: unknown): AiPasteMode => (m === 'warn' || m === 'block' ? m : 'off');

export interface Policy {
  version?: string;
  detectors?: {
    lookalike?: Mode; nrd?: Mode; oauth?: Mode; knownBad?: Mode; aiUsage?: 'on' | 'off';
    /** Risky file downloaded from a flagged site (optional downloads permission). Missing = 'warn'. */
    downloads?: ExtraMode;
    /** Sensitive paste into an AI tool (optional AI-site access). Missing = 'off'. */
    aiPaste?: AiPasteMode;
  };
  protected?: { domains?: string[]; brands?: string[] };
  brandOwners?: Record<string, string[]>;
  singleTenantOwners?: string[];
  /** Brands matched by exact skeleton / whole token only (added to the built-in STRICT_BRANDS). */
  strictBrands?: string[];
  allowDomains?: string[];
  approvedOAuthAppIds?: string[];
  riskyScopes?: Record<string, string[]>;
  sharedHosting?: string[];
  knownBad?: string[];
  nrd?: { version?: string; url?: string };
  popular?: { version?: string | null; url?: string | null };
  /** Reported phishing / malware hosts (RLHS2 exact host set). */
  knownBadFeed?: { version?: string | null; url?: string | null };
  jit?: Record<string, { exerciseId?: string; title?: string; path?: string }>;
  hrsEnabled?: boolean;
  /** AI tool directory (host-only match; daily counts per tool). */
  aiTools?: unknown;
  /** Per-person AI attribution is on for this tenant. */
  aiAttribution?: boolean;
  /** Employees may turn on training reminders (optional notifications permission). Missing = off. */
  notifications?: { reminders?: boolean };
  /** Learner pages to link to (`/app/...`); read through appLinks(). Missing on older backends. */
  links?: { todo?: unknown; training?: unknown; home?: unknown };
}

// 'went_back' is emitted only by the download and AI paste warnings (and the password-entry warning of earlier versions, still in history).
export type Action = 'warned' | 'proceeded' | 'went_back' | 'blocked' | 'logged';
export type Signal =
  | 'browser.lookalike_visit'
  | 'browser.risky_domain_visit'
  | 'browser.oauth_risky_consent_shown'
  | 'browser.warning_overridden'
  | 'browser.password_entry_warned' // removed in 1.1.0; kept so older history entries still type
  | 'browser.risky_download_warned'
  | 'browser.ai_sensitive_paste'
  | 'browser.lesson_completed';

export interface WireEvent {
  id: string;
  signal: Signal;
  value?: string;
  domain: string;
  occurredAt: string;
  action: Action;
}

export async function getLocal<T>(key: string): Promise<T | undefined> {
  return (await chrome.storage.local.get(key))[key] as T | undefined;
}
export async function setLocal(items: Record<string, unknown>): Promise<void> {
  await chrome.storage.local.set(items);
}
export async function getSession<T>(key: string): Promise<T | undefined> {
  return (await chrome.storage.session.get(key))[key] as T | undefined;
}
export async function setSession(items: Record<string, unknown>): Promise<void> {
  await chrome.storage.session.set(items);
}

/** chrome.storage.local as the detect/ KeyValueStore seam (detect/ never imports background/). */
export const chromeLocalStore = {
  get: (key: string): Promise<unknown> => getLocal(key),
  set: (key: string, value: unknown): Promise<void> => setLocal({ [key]: value }),
};

export const getAuth = (): Promise<Auth | undefined> => getLocal<Auth>('auth');
/** auth + policy in one storage read (the navigation hot path). */
export async function getAuthAndPolicy(): Promise<{ auth: Auth | undefined; policy: Policy }> {
  const got = await chrome.storage.local.get(['auth', 'policy']);
  return { auth: got['auth'] as Auth | undefined, policy: (got['policy'] as Policy | undefined) ?? {} };
}
export const getPolicy = async (): Promise<Policy> => (await getLocal<Policy>('policy')) ?? {};


/**
 * Serialises read-modify-write sequences on storage within one worker lifetime.
 * In-memory is enough: Chrome runs at most one instance of the service worker, so all callers
 * share this chain; if the worker is killed mid-flush, unacknowledged events stay queued and the
 * per-event idempotency ids make a resend harmless.
 */
let chain: Promise<unknown> = Promise.resolve();
export function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

/**
 * Claims a once-per-`ttlMs` slot for `key` in the `storageKey` map (under the lock). False while a claim
 * made within the window exists; a future-dated claim (clock moved back) counts as expired.
 * `prune` also drops every expired entry in the same write.
 */
const liveAt = (at: unknown, now: number, ttlMs: number): boolean => typeof at === 'number' && now - at < ttlMs && now >= at;
const pruneMap = (t: Record<string, number>, now: number, ttlMs: number): void => {
  for (const [k, at] of Object.entries(t)) if (!liveAt(at, now, ttlMs)) delete t[k];
};

export function claimOnce(storageKey: string, key: string, ttlMs: number, prune = false): Promise<boolean> {
  return locked(async () => {
    const t = (await getLocal<Record<string, number>>(storageKey)) ?? {};
    const now = Date.now();
    const live = (at: unknown): boolean => liveAt(at, now, ttlMs);
    if (prune) pruneMap(t, now, ttlMs);
    if (live(t[key])) return false;
    t[key] = now;
    await setLocal({ [storageKey]: t });
    return true;
  });
}

/** Drops every expired (or future-dated) entry of a claimOnce map. */
export function pruneOnce(storageKey: string, ttlMs: number): Promise<void> {
  return locked(async () => {
    const t = (await getLocal<Record<string, number>>(storageKey)) ?? {};
    pruneMap(t, Date.now(), ttlMs);
    await setLocal({ [storageKey]: t });
  });
}
