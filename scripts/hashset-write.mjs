// Test-only RLHS2 writer. Spec: docs/rlhs-format.md. Independent of src/detect/hashset.ts.
// Usage: node scripts/hashset-write.mjs <domains.txt> <out.rlhs>
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const prefixHex = (name) => createHash('sha256').update(name.toLowerCase(), 'utf8').digest().subarray(0, 16).toString('hex');

export function build(domains) {
  const keys = [...new Set(domains.map((d) => d.trim()).filter(Boolean).map(prefixHex))].sort();
  const out = Buffer.alloc(9 + keys.length * 16);
  out.write('RLHS2', 0, 'ascii');
  out.writeUInt32LE(keys.length, 5);
  keys.forEach((k, i) => Buffer.from(k, 'hex').copy(out, 9 + i * 16));
  return new Uint8Array(out);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , inp, outp] = process.argv;
  if (!inp || !outp) {
    console.error('usage: node scripts/hashset-write.mjs <domains.txt> <out.rlhs>');
    process.exit(1);
  }
  writeFileSync(outp, build(readFileSync(inp, 'utf8').split('\n')));
}
