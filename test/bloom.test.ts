import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error untyped test-only JS writer
import { build, fnv1a32, murmur3_32, size } from '../scripts/bloom-write.mjs';
import { BloomFilter, BloomFormatError, fnv1a, murmur3 } from '../src/detect/bloom.ts';
import { isNewDomain, type KeyValueStore } from '../src/detect/nrd.ts';

const enc = new TextEncoder();
const toBuf = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
const bloomOf = (domains: string[], p = 0.001) => BloomFilter.fromBytes(toBuf(build(domains, p)));

describe('hash test vectors (docs/rlbf-format.md)', () => {
  const vectors: [string, number, number][] = [
    ['example-new.com', 1044708521, 3947312074],
    ['a.io', 2406334646, 1379151513],
    ['ransomleak.com', 465442287, 268822097],
  ];
  it.each(vectors)('%s', (d, h1, h2) => {
    expect(fnv1a(enc.encode(d))).toBe(h1);
    expect(murmur3(enc.encode(d))).toBe(h2);
    expect(fnv1a32(enc.encode(d))).toBe(h1);
    expect(murmur3_32(enc.encode(d))).toBe(h2);
  });
  it('matches published primitive vectors', () => {
    expect(murmur3(enc.encode('hello'))).toBe(0x248bfa47);
    expect(fnv1a(enc.encode('a'))).toBe(0xe40c292c);
    expect(fnv1a(new Uint8Array())).toBe(0x811c9dc5);
    expect(murmur3(new Uint8Array())).toBe(0);
  });
  it('agrees with the writer across tail lengths and non-ASCII', () => {
    for (const s of ['', 'a', 'ab', 'abc', 'abcd', 'abcde', 'xn--bcher-kva.example', 'пример.рф']) {
      expect(murmur3(enc.encode(s))).toBe(murmur3_32(enc.encode(s)));
      expect(fnv1a(enc.encode(s))).toBe(fnv1a32(enc.encode(s)));
    }
  });
});

describe('sizing table (docs/rlbf-format.md)', () => {
  it.each([
    [1000, 0.001, 14378, 14384, 10],
    [150000, 0.001, 2156639, 2156640, 10],
    [5000000, 0.001, 71887938, 71887944, 10],
    [1, 0.001, 15, 16, 11],
    [7, 0.01, 68, 72, 7],
    [1000, 0.00552, 10822, 10824, 8],
  ])('n=%i p=%f', (n, p, raw, m, k) => {
    expect(size(n, p)).toEqual({ raw, m, k });
  });
});

describe('BloomFilter', () => {
  it('contains all 10,000 inserted domains', () => {
    const ds = Array.from({ length: 10_000 }, (_, i) => `member-${i}.example${i % 7}.com`);
    const b = bloomOf(ds);
    for (const d of ds) expect(b.has(d)).toBe(true);
  });
  it('has FP rate < 0.2% on 100,000 non-members (sized for 0.1%)', () => {
    const b = bloomOf(Array.from({ length: 10_000 }, (_, i) => `member-${i}.example.com`));
    let fp = 0;
    for (let i = 0; i < 100_000; i++) if (b.has(`other-${i}.nonmember.org`)) fp++;
    expect(fp / 100_000).toBeLessThan(0.002);
  });
  it('answers true for example-new.com from the committed fixture', () => {
    const bytes = readFileSync(new URL('./fixtures/sample.rlbf', import.meta.url));
    const b = BloomFilter.fromBytes(toBuf(new Uint8Array(bytes)));
    expect(b.has('example-new.com')).toBe(true);
    expect(b.has('definitely-not-there.com')).toBe(false);
  });
  it('fixture is exactly what the writer produces from sample-domains.txt', () => {
    const txt = readFileSync(new URL('./fixtures/sample-domains.txt', import.meta.url), 'utf8');
    const fixture = new Uint8Array(readFileSync(new URL('./fixtures/sample.rlbf', import.meta.url)));
    expect(Buffer.from(build(txt.split('\n'), 0.001)).equals(Buffer.from(fixture))).toBe(true);
    expect(size(1000, 0.001)).toEqual({ raw: 14378, m: 14384, k: 10 });
  });
  it('is case-insensitive on lookup input', () => {
    expect(bloomOf(['example-new.com']).has('Example-NEW.com')).toBe(true);
  });

  describe('fromBytes rejects malformed input', () => {
    const good = build(['a.com', 'b.com']);
    const expectBad = (u: Uint8Array) => {
      expect(() => BloomFilter.fromBytes(toBuf(u))).toThrow(BloomFormatError);
    };
    it('bad header', () => {
      const u = good.slice();
      u[4] = 0x32;
      expectBad(u);
    });
    it('too short for header', () => expectBad(good.slice(0, 9)));
    it('truncated bits', () => expectBad(good.slice(0, good.length - 1)));
    it('trailing bytes (m does not match length)', () => expectBad(new Uint8Array([...good, 0])));
    it('m not a multiple of 8 / zero', () => {
      const u = good.slice();
      new DataView(u.buffer).setUint32(5, 12, true);
      expectBad(u);
      new DataView(u.buffer).setUint32(5, 0, true);
      expectBad(u.slice(0, 10));
    });
    it('k = 0 or > 32', () => {
      for (const k of [0, 33, 255]) {
        const u = good.slice();
        u[9] = k;
        expectBad(u);
      }
    });
  });
});

function fakeStore(): KeyValueStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return { data, get: async (k) => data.get(k), set: async (k, v) => void data.set(k, v) };
}
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('isNewDomain', () => {
  const bloom = bloomOf(['fresh.com']);

  it('does not call confirm when has() is false or bloom is null', async () => {
    const confirm = vi.fn(async () => 1);
    expect(await isNewDomain('old.org', bloom, confirm, { storage: fakeStore() })).toBe(false);
    expect(await isNewDomain('fresh.com', null, confirm, { storage: fakeStore() })).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });
  it('true when confirmed age < 30 days, false otherwise', async () => {
    expect(await isNewDomain('fresh.com', bloom, async () => 3, { storage: fakeStore() })).toBe(true);
    expect(await isNewDomain('fresh.com', bloom, async () => 29.9, { storage: fakeStore() })).toBe(true);
    expect(await isNewDomain('fresh.com', bloom, async () => 30, { storage: fakeStore() })).toBe(false);
    expect(await isNewDomain('fresh.com', bloom, async () => 900, { storage: fakeStore() })).toBe(false);
  });
  it('caches confirms for 7 days', async () => {
    const storage = fakeStore();
    const confirm = vi.fn(async () => 2);
    let now = 1_000_000;
    const o = { storage, now: () => now };
    expect(await isNewDomain('fresh.com', bloom, confirm, o)).toBe(true);
    now += 6 * DAY;
    expect(await isNewDomain('fresh.com', bloom, confirm, o)).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    now += 2 * DAY;
    await isNewDomain('fresh.com', bloom, confirm, o);
    expect(confirm).toHaveBeenCalledTimes(2);
  });
  it('null confirm is unknown (not new) and cached at most 1 hour', async () => {
    const storage = fakeStore();
    const confirm = vi.fn(async () => null as number | null);
    let now = 5_000_000;
    const o = { storage, now: () => now };
    expect(await isNewDomain('fresh.com', bloom, confirm, o)).toBe(false);
    now += 30 * 60_000;
    expect(await isNewDomain('fresh.com', bloom, confirm, o)).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    now += 31 * 60_000;
    confirm.mockResolvedValueOnce(1);
    expect(await isNewDomain('fresh.com', bloom, confirm, o)).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(2);
  });
  it('confirm throwing is unknown, not new, cached as null for 1 hour', async () => {
    const storage = fakeStore();
    const confirm = vi.fn(async (): Promise<number | null> => { throw new Error('net'); });
    let now = 9_000_000;
    const o = { storage, now: () => now };
    expect(await isNewDomain('fresh.com', bloom, confirm, o)).toBe(false);
    expect(storage.data.get('nrd:fresh.com')).toEqual({ isNew: null, at: now });
    now += 30 * 60_000;
    expect(await isNewDomain('fresh.com', bloom, confirm, o)).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    now += 31 * 60_000;
    await isNewDomain('fresh.com', bloom, confirm, o);
    expect(confirm).toHaveBeenCalledTimes(2);
  });
  it('ignores corrupt cache entries', async () => {
    const storage = fakeStore();
    storage.data.set('nrd:fresh.com', 'garbage');
    expect(await isNewDomain('fresh.com', bloom, async () => 1, { storage })).toBe(true);
  });
});
