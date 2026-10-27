import { describe, expect, it } from 'vitest';
// @ts-expect-error untyped test-only JS writer
import { build } from '../scripts/hashset-write.mjs';
import { HashSet, HashSetFormatError, prefix128 } from '../src/detect/hashset.ts';

const buf = (u8: Uint8Array): ArrayBuffer => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
const hex = (k: number[]): string => k.map((w) => w.toString(16).padStart(8, '0')).join('');

describe('RLHS2', () => {
  it('matches the documented vectors', async () => {
    expect(hex(await prefix128('google.com'))).toBe('d4c9d9027326271a89ce51fcaf328ed6');
    expect(hex(await prefix128('Example.COM'))).toBe('a379a6f6eeafb9a55e378c118034e275');
    expect(hex(await prefix128('xn--80ak6aa92e.com'))).toBe('dc7b4e6ffcc676f053589c2b8f8922f7');
    expect(hex(await prefix128('example-new.com'))).toBe('90e340f231294b39801fe713cd2d18e1');
    expect(hex(await prefix128('a.io'))).toBe('0df92fb080b9111416f49b4b42d0be1a');
    expect(hex(await prefix128('ransomleak.com'))).toBe('3855835fe23ddd3ac1afd75dfba305a3');
  });
  it('the 3-domain file has the exact expected bytes', () => {
    const out = Buffer.from(build(['example-new.com', 'a.io', 'ransomleak.com']) as Uint8Array).toString('hex');
    expect(out).toBe(
      '524c485332' + '03000000' +
      '0df92fb080b9111416f49b4b42d0be1a' + '3855835fe23ddd3ac1afd75dfba305a3' + '90e340f231294b39801fe713cd2d18e1',
    );
  });
  it('finds members by binary search', async () => {
    const names = Array.from({ length: 500 }, (_, i) => `d${i}.com`);
    const set = HashSet.fromBytes(buf(build(names)));
    expect(set.count).toBe(500);
    for (const n of names) expect(await set.has(n)).toBe(true);
    expect(await set.has('D7.COM')).toBe(true);
    expect(await set.has('nope.com')).toBe(false);
    expect(await HashSet.fromBytes(buf(build([]))).has('a.com')).toBe(false);
  });
  it('rejects bad header, length mismatch and unsorted entries', () => {
    const good = build(['a.com', 'b.com']) as Uint8Array;
    const bad = (u8: Uint8Array) => expect(() => HashSet.fromBytes(buf(u8))).toThrow(HashSetFormatError);
    bad(new Uint8Array([1, 2, 3]));
    const magic = good.slice(); magic[4] = 0x31; bad(magic);
    bad(good.slice(0, good.length - 1));
    const swapped = good.slice(); swapped.set(good.subarray(25, 41), 9); swapped.set(good.subarray(9, 25), 25); bad(swapped);
    const dup = good.slice(); dup.set(good.subarray(9, 25), 25); bad(dup);
  });
});
