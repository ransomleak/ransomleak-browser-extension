// Minimal IndexedDB key-value wrapper (no dependency). Holds binary blobs too large for
// chrome.storage.local (e.g. the ~10 MB NRD bloom), stored as ArrayBuffer without base64.
const DB = 'ransomleak';
const STORE = 'kv';

let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  const p = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  // Never cache a failure (a sync throw from open() or an error event): the next call retries.
  p.catch(() => {
    if (dbp === p) dbp = null;
  });
  dbp = p;
  return p;
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req.result as T);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

export const idbGet = <T>(key: string): Promise<T | undefined> => run<T | undefined>('readonly', (s) => s.get(key));
export const idbPut = (key: string, value: unknown): Promise<void> => run<void>('readwrite', (s) => s.put(value, key)).then(() => {});
export const idbDelete = (key: string): Promise<void> => run<void>('readwrite', (s) => s.delete(key)).then(() => {});

/** Test hook: forget the open handle (fake-indexeddb is reset between tests). */
export function idbResetForTest(): void {
  dbp = null;
}
