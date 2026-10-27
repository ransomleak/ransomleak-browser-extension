import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

afterEach(() => vi.unstubAllGlobals());

describe('idb wrapper', () => {
  it('does not cache a failed open', async () => {
    vi.resetModules();
    const real = new IDBFactory();
    let fail = true;
    vi.stubGlobal('indexedDB', { open: (...a: [string, number]) => { if (fail) throw new Error('boom'); return real.open(...a); } });
    const { idbGet, idbPut } = await import('../src/background/idb.ts');
    await expect(idbGet('k')).rejects.toThrow('boom');
    fail = false;
    await idbPut('k', new Uint8Array([1, 2]).buffer);
    expect(new Uint8Array((await idbGet<ArrayBuffer>('k'))!)).toEqual(new Uint8Array([1, 2]));
  });
});
