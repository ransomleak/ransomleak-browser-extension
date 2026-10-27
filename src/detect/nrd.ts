import type { BloomFilter } from './bloom.ts';

export interface KeyValueStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

const NEW_DAYS = 30;
const CONFIRM_TTL_MS = 7 * 24 * 3_600_000;
const UNKNOWN_TTL_MS = 3_600_000;

interface CacheEntry {
  isNew: boolean | null; // null = confirm gave no answer
  at: number;
}

function parseEntry(v: unknown): CacheEntry | null {
  if (!v || typeof v !== 'object') return null;
  const { isNew, at } = v as Record<string, unknown>;
  if (typeof at !== 'number' || (isNew !== null && typeof isNew !== 'boolean')) return null;
  return { isNew, at };
}

/** True only if the Bloom filter hits AND `confirm` (domain age in days) says < 30 days. */
export async function isNewDomain(
  registrable: string,
  bloom: BloomFilter | null,
  confirm: (d: string) => Promise<number | null>,
  opts: { storage: KeyValueStore; now?: () => number },
): Promise<boolean> {
  if (!bloom || !bloom.has(registrable)) return false;
  const { storage } = opts;
  const now = (opts.now ?? Date.now)();
  const key = `nrd:${registrable.toLowerCase()}`;

  try {
    const hit = parseEntry(await storage.get(key));
    if (hit) {
      const ttl = hit.isNew === null ? UNKNOWN_TTL_MS : CONFIRM_TTL_MS;
      if (now - hit.at >= 0 && now - hit.at < ttl) return hit.isNew === true;
    }
  } catch {
    // cache unavailable: fall through to confirm
  }

  let age: number | null;
  try {
    age = await confirm(registrable);
  } catch {
    age = null; // unknown; cached briefly below so we do not retry on every navigation
  }
  const isNew = age === null || !Number.isFinite(age) ? null : age < NEW_DAYS;
  try {
    await storage.set(key, { isNew, at: now } satisfies CacheEntry);
  } catch {
    // best effort
  }
  return isNew === true;
}
