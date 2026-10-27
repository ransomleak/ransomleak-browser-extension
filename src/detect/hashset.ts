// RLHS2 hashed-prefix set reader (popularity allowlist). Wire format: docs/rlhs-format.md (backend must match).
// Unlike a Bloom filter, a public set of 128-bit SHA-256 prefixes cannot be brute-forced
// into a colliding lookalike name.
const MAGIC = [0x52, 0x4c, 0x48, 0x53, 0x32]; // "RLHS2"
const HEADER = 9; // magic + uint32 LE count
const ENTRY = 16;

export class HashSetFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HashSetFormatError';
  }
}

export type Key128 = [number, number, number, number];

/** First 16 bytes of SHA-256(UTF-8 lowercase name), as four big-endian uint32 words. */
export async function prefix128(name: string): Promise<Key128> {
  const d = new DataView(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(name.toLowerCase())));
  return [d.getUint32(0, false), d.getUint32(4, false), d.getUint32(8, false), d.getUint32(12, false)];
}

export class HashSet {
  private constructor(private readonly view: DataView, readonly count: number) {}

  /** Compares entry `i` with `key` as four uint32 words: <0, 0, >0. */
  private cmp(i: number, key: readonly number[]): number {
    for (let w = 0; w < 4; w++) {
      const a = this.view.getUint32(i * ENTRY + w * 4);
      if (a !== key[w]) return a < key[w]! ? -1 : 1;
    }
    return 0;
  }

  static fromBytes(buf: ArrayBuffer): HashSet {
    const u8 = new Uint8Array(buf);
    if (u8.length < HEADER || MAGIC.some((b, i) => u8[i] !== b)) throw new HashSetFormatError('bad header');
    const dv = new DataView(buf);
    const n = dv.getUint32(5, true);
    if (u8.length !== HEADER + n * ENTRY) throw new HashSetFormatError('length mismatch');
    const set = new HashSet(new DataView(buf, HEADER, n * ENTRY), n);
    for (let i = 1; i < n; i++) {
      const prev = [0, 1, 2, 3].map((w) => set.view.getUint32((i - 1) * ENTRY + w * 4));
      if (set.cmp(i, prev) <= 0) throw new HashSetFormatError('entries not sorted and unique');
    }
    return set;
  }

  async has(registrable: string): Promise<boolean> {
    const key = await prefix128(registrable);
    let lo = 0, hi = this.count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const c = this.cmp(mid, key);
      if (c === 0) return true;
      if (c < 0) lo = mid + 1;
      else hi = mid - 1;
    }
    return false;
  }
}
