// Test-only RLBF1 writer. Spec: docs/rlbf-format.md. Deliberately independent of src/detect/bloom.ts
// so the tests cross-check two implementations. The backend reproduces the committed fixture byte-for-byte.
// Usage: node scripts/bloom-write.mjs <domains.txt> <out.rlbf> [targetFp=0.001]
import { readFileSync, writeFileSync } from 'node:fs';

export function fnv1a32(bytes) {
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function murmur3_32(bytes, seed = 0) {
  let h = seed >>> 0;
  const len = bytes.length;
  const nblocks = len >> 2;
  for (let i = 0; i < nblocks; i++) {
    let k = (bytes[i * 4] | (bytes[i * 4 + 1] << 8) | (bytes[i * 4 + 2] << 16) | (bytes[i * 4 + 3] << 24)) >>> 0;
    k = Math.imul(k, 0xcc9e2d51);
    k = ((k << 15) | (k >>> 17)) >>> 0;
    k = Math.imul(k, 0x1b873593);
    h ^= k;
    h = ((h << 13) | (h >>> 19)) >>> 0;
    h = (Math.imul(h, 5) + 0xe6546b64) >>> 0;
  }
  let k = 0;
  const tail = nblocks * 4;
  switch (len & 3) {
    case 3: k ^= bytes[tail + 2] << 16; // falls through
    case 2: k ^= bytes[tail + 1] << 8; // falls through
    case 1:
      k ^= bytes[tail];
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

export function size(n, p) {
  const raw = Math.ceil((-n * Math.log(p)) / (Math.LN2 * Math.LN2));
  const m = Math.max(8, Math.ceil(raw / 8) * 8);
  const k = Math.min(32, Math.max(1, Math.floor((m / n) * Math.LN2 + 0.5))); // half-up, not banker's
  return { raw, m, k };
}

export function build(domains, p = 0.001) {
  const set = [...new Set(domains.map((d) => d.trim().toLowerCase()).filter((d) => d && !d.startsWith('#')))];
  const n = Math.max(1, set.length);
  const { m, k } = size(n, p);
  const out = new Uint8Array(10 + m / 8);
  out.set([0x52, 0x4c, 0x42, 0x46, 0x31]); // "RLBF1"
  new DataView(out.buffer).setUint32(5, m, true);
  out[9] = k;
  const enc = new TextEncoder();
  for (const d of set) {
    const b = enc.encode(d);
    const h1 = fnv1a32(b);
    const h2 = murmur3_32(b, 0);
    for (let i = 0; i < k; i++) {
      const idx = ((h1 + Math.imul(i, h2)) >>> 0) % m;
      out[10 + (idx >>> 3)] |= 1 << (idx & 7);
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , inPath, outPath, fp] = process.argv;
  if (!inPath || !outPath) {
    console.error('usage: node scripts/bloom-write.mjs <domains.txt> <out.rlbf> [targetFp]');
    process.exit(2);
  }
  const bytes = build(readFileSync(inPath, 'utf8').split('\n'), fp ? Number(fp) : 0.001);
  writeFileSync(outPath, bytes);
  console.log(`wrote ${outPath}: ${bytes.length} bytes`);
}
