// RLBF1 Bloom filter reader. Wire format and hashing: docs/rlbf-format.md (backend must match).
const MAGIC = [0x52, 0x4c, 0x42, 0x46, 0x31]; // "RLBF1"
const HEADER = 10;

export class BloomFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BloomFormatError';
  }
}

export function fnv1a(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function murmur3(bytes: Uint8Array, seed = 0): number {
  let h = seed >>> 0;
  const len = bytes.length;
  const nblocks = len >> 2;
  for (let i = 0; i < nblocks; i++) {
    const o = i * 4;
    let k = (bytes[o]! | (bytes[o + 1]! << 8) | (bytes[o + 2]! << 16) | (bytes[o + 3]! << 24)) >>> 0;
    k = Math.imul(k, 0xcc9e2d51);
    k = ((k << 15) | (k >>> 17)) >>> 0;
    k = Math.imul(k, 0x1b873593);
    h ^= k;
    h = ((h << 13) | (h >>> 19)) >>> 0;
    h = (Math.imul(h, 5) + 0xe6546b64) >>> 0;
  }
  const tail = nblocks * 4;
  let k = 0;
  const rem = len & 3;
  if (rem >= 3) k ^= bytes[tail + 2]! << 16;
  if (rem >= 2) k ^= bytes[tail + 1]! << 8;
  if (rem >= 1) {
    k ^= bytes[tail]!;
    k = Math.imul(k, 0xcc9e2d51);
    k = ((k << 15) | (k >>> 17)) >>> 0;
    k = Math.imul(k, 0x1b873593);
    h ^= k;
  }
  h ^= len;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

const encoder = new TextEncoder();

export class BloomFilter {
  private constructor(
    private readonly bits: Uint8Array,
    private readonly m: number,
    private readonly k: number,
  ) {}

  static fromBytes(buf: ArrayBuffer): BloomFilter {
    const u = new Uint8Array(buf);
    if (u.length < HEADER) throw new BloomFormatError('truncated header');
    for (let i = 0; i < MAGIC.length; i++) if (u[i] !== MAGIC[i]) throw new BloomFormatError('bad header');
    const m = new DataView(buf).getUint32(5, true);
    const k = u[9]!;
    if (m === 0 || m % 8 !== 0) throw new BloomFormatError('invalid m');
    if (k < 1 || k > 32) throw new BloomFormatError('invalid k');
    if (u.length !== HEADER + m / 8) throw new BloomFormatError('length does not match m');
    return new BloomFilter(u.subarray(HEADER), m, k);
  }

  has(s: string): boolean {
    const b = encoder.encode(s.toLowerCase());
    const h1 = fnv1a(b);
    const h2 = murmur3(b, 0);
    for (let i = 0; i < this.k; i++) {
      const idx = ((h1 + Math.imul(i, h2)) >>> 0) % this.m;
      if ((this.bits[idx >>> 3]! & (1 << (idx & 7))) === 0) return false;
    }
    return true;
  }
}
