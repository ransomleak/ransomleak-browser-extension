// Remote policy (ETag poll) and the domain feeds (NRD, popular, known-bad; daily refresh).
import { BloomFilter } from '../detect/bloom.ts';
import { HashSet } from '../detect/hashset.ts';
import { idbDelete, idbGet, idbPut } from './idb.ts';
import { apiFetch } from './api.ts';
import { getAuth, getLocal, getPolicy, locked, setLocal, type Policy } from './store.ts';

const generationOf = async (): Promise<number> => (await getAuth())?.generation ?? 0;

/** GET /policy with If-None-Match. Returns true when a new policy was stored. Results of a superseded binding are dropped. */
export async function syncPolicy(): Promise<boolean> {
  const generation = await generationOf();
  const etag = await getLocal<string>('etag');
  let res: Response;
  try {
    res = await apiFetch('/api/browser-ext/policy', { headers: etag ? { 'if-none-match': etag } : {} }, generation);
  } catch {
    return false; // offline or paused
  }
  if (res.status === 304 || !res.ok) return false;
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return false;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const policy = body as Policy;
  const prev = await locked(async () => {
    if ((await generationOf()) !== generation) return null; // re-bound mid-request: not this binding's policy
    const p = await getPolicy();
    await setLocal({ policy, etag: res.headers.get('etag') ?? null });
    return p;
  });
  if (!prev) return false;
  await chrome.storage.session.remove('allow'); // overrides were granted under the old policy
  for (const kind of FEEDS) if (feedInfo(policy, kind)?.version !== feedInfo(prev, kind)?.version) await refreshFeed(kind);
  return true;
}

// Domain feeds: `nrd` is an RLBF1 Bloom (newly registered domains, ~9-11 MB raw at p=0.001);
// `popular` is an RLHS2 hashed-prefix set (Tranco top-100k registrables, the lookalike exemption;
// not a Bloom, so a colliding lookalike cannot be brute-forced); `knownbad` is an RLHS2 set of exact
// hosts reported for phishing / malware (policy field `knownBadFeed`). They live in IndexedDB as ArrayBuffers:
// base64 in storage.local would exceed its 10 MB quota. Decoded once per worker lifetime.
export type FeedKind = 'nrd' | 'popular' | 'knownbad';
export const FEEDS: readonly FeedKind[] = ['nrd', 'popular', 'knownbad'];
const KEYS: Record<FeedKind, string> = { nrd: 'nrdBloom', popular: 'popularBloom', knownbad: 'knownBadSet' };
/** Policy field that describes each feed (wire names). */
const FIELD = { nrd: 'nrd', popular: 'popular', knownbad: 'knownBadFeed' } as const satisfies Record<FeedKind, keyof Policy>;
export const feedInfo = (policy: Policy, kind: FeedKind): { version?: string | null; url?: string | null } | undefined =>
  policy[FIELD[kind]];
interface StoredBloom { version: string; data: ArrayBuffer; at: number }
interface Parsed { nrd: BloomFilter; popular: HashSet; knownbad: HashSet }
const PARSE: { [K in FeedKind]: (buf: ArrayBuffer) => Parsed[K] } = {
  nrd: BloomFilter.fromBytes, popular: HashSet.fromBytes, knownbad: HashSet.fromBytes,
};
/**
 * Allow lists are used only when their version equals the policy's (stale = no exemption, fail closed).
 * Deny lists (nrd, knownbad) keep the last good copy until a newer one is downloaded and parsed.
 */
const VERSIONED: ReadonlySet<FeedKind> = new Set(['popular']);
const cached: { [K in FeedKind]?: { version: string; at: number; feed: Parsed[K] } } = {};

/** Downloads policy[kind].url. A bad file keeps the previous filter (or none). */
export async function refreshFeed<K extends FeedKind>(kind: K): Promise<void> {
  const policy = await getPolicy();
  const url = feedInfo(policy, kind)?.url;
  if (!url) {
    await dropFeed(kind); // policy no longer defines this feed
    return;
  }
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return;
  }
  if (u.protocol !== 'https:') return;
  const auth = await getAuth();
  if (!auth || auth.needsReauth) return;
  const generation = auth.generation ?? 0;
  let buf: ArrayBuffer;
  try {
    // Bearer only to our own API origin; a CDN URL is fetched anonymously.
    const res = u.origin === auth.apiBaseUrl
      ? await apiFetch(u.pathname + u.search, {}, generation)
      : await fetch(u.href, { credentials: 'omit' });
    if (!res.ok) return;
    buf = await res.arrayBuffer();
  } catch {
    return;
  }
  let feed: Parsed[K];
  try {
    feed = PARSE[kind](buf);
  } catch {
    return; // BloomFormatError / HashSetFormatError (or anything else): keep the previous filter
  }
  if ((await generationOf()) !== generation) return; // re-bound mid-download: another tenant's filter
  const version = String(feedInfo(policy, kind)?.version ?? '');
  const at = Date.now();
  cached[kind] = { version, at, feed } as (typeof cached)[K];
  try {
    await idbPut(KEYS[kind], { version, data: buf, at } satisfies StoredBloom);
  } catch {
    // IndexedDB unavailable: keep the filter in memory for this worker lifetime only
  }
}

/** Refreshes every feed; one failing feed never stops the others. */
export async function refreshFeeds(): Promise<void> {
  for (const kind of FEEDS) await refreshFeed(kind).catch(() => {});
}

/** The stored filter, or null (none yet, or unreadable: no filter means no NRD hit and no exemption). */
export async function loadFeed<K extends FeedKind>(kind: K): Promise<Parsed[K] | null> {
  // A feed the policy no longer defines is deleted. The popular allow list is also used only when its
  // version equals the policy's (a stale set grants no exemption); deny lists keep their last good copy.
  const want = feedInfo(await getPolicy(), kind);
  if (!want?.url) {
    await dropFeed(kind);
    return null;
  }
  const current = (v: string): boolean => !VERSIONED.has(kind) || v === String(want.version ?? '');
  const c = cached[kind];
  if (c) return current(c.version) ? (c.feed as Parsed[K]) : null;
  try {
    const stored = await idbGet<StoredBloom>(KEYS[kind]);
    if (!stored) return null;
    if (!current(stored.version)) return null;
    const feed = PARSE[kind](stored.data);
    cached[kind] = { version: stored.version, at: stored.at, feed } as (typeof cached)[K];
    return feed;
  } catch {
    return null;
  }
}

/** Stale: none stored, older than 24 h, or a version other than the policy's (a failed refresh is retried). */
export async function feedStale(kind: FeedKind): Promise<boolean> {
  let stored: { version: string; at: number } | undefined = cached[kind];
  if (!stored) {
    try {
      stored = await idbGet<StoredBloom>(KEYS[kind]);
    } catch {
      /* treat as stale */
    }
  }
  const want = feedInfo(await getPolicy(), kind)?.version;
  if (want != null && stored && stored.version !== String(want)) return true;
  return !stored?.at || Date.now() - stored.at > 24 * 3_600_000;
}

async function dropFeed(kind: FeedKind): Promise<void> {
  delete cached[kind];
  try {
    await idbDelete(KEYS[kind]);
  } catch {
    /* nothing stored */
  }
}

/** Tenant switch: the old tenant's filters must not be used. */
export async function clearFeeds(): Promise<void> {
  for (const kind of FEEDS) await dropFeed(kind);
}
