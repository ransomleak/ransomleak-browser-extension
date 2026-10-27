// Offline-first event queue. Events carry only the Global-Constraints fields.
import { errorCode, postJson, REVOKED_CODES, StaleBindingError } from './api.ts';
import { getAuth, getLocal, locked, setLocal, type Action, type Auth, type Signal, type WireEvent } from './store.ts';

export const QUEUE_CAP = 1000;
export const BATCH = 100;
const REPORTED_MS = 7 * 24 * 3_600_000;

export interface NewEvent { signal: Signal; domain: string; action: Action; value?: string }

/** Appends events in order with one read-modify-write of the queue. */
export async function enqueueAll(items: readonly NewEvent[]): Promise<WireEvent[]> {
  const evs = items.map(({ signal, domain, action, value }) => {
    const ev: WireEvent = { id: crypto.randomUUID(), signal, domain, occurredAt: new Date().toISOString(), action };
    if (value !== undefined) ev.value = value;
    return ev;
  });
  if (!evs.length) return evs;
  await locked(async () => {
    const q = (await getLocal<WireEvent[]>('queue')) ?? [];
    q.push(...evs);
    await setLocal({ queue: q.length > QUEUE_CAP ? q.slice(q.length - QUEUE_CAP) : q });
  });
  return evs;
}

export async function enqueue(signal: Signal, domain: string, action: Action, value?: string): Promise<WireEvent> {
  return (await enqueueAll([{ signal, domain, action, value }]))[0]!;
}

/** Identity of a binding (region + tenant + user); '' when unbound. */
const ownerOf = (a: Auth | undefined): string => (a ? `${a.apiBaseUrl}|${a.tenant}|${a.userId ?? ''}` : '');

// In-memory single-flight guard; see the note on `locked` in store.ts.
let flushing: Promise<void> | null = null;

/**
 * 4xx other than 401 (handled by apiFetch) and 429 will never succeed on retry. A 403 is permanent only
 * with a known backend code; a bare or unknown 403 (WAF, IP allowlist on a roaming laptop) is retried.
 */
async function permanent(res: Response): Promise<boolean> {
  const s = res.status;
  if (s < 400 || s >= 500 || s === 401 || s === 429) return false;
  if (s !== 403) return true;
  const code = await errorCode(res);
  return code !== null && REVOKED_CODES.has(code);
}

async function removeIds(ids: Set<string>): Promise<void> {
  const q = (await getLocal<WireEvent[]>('queue')) ?? [];
  await setLocal({ queue: q.filter((e) => !ids.has(e.id)) });
}

/**
 * Sends the queue in batches of ≤100. 429/5xx/network errors keep the batch and stop until the
 * next flush alarm; a permanent 4xx drops the batch (counted in `droppedEvents`). The batch is
 * read together with the binding generation, and is never sent under a newer binding.
 */
export function flush(): Promise<void> {
  flushing ??= (async () => {
    try {
      for (;;) {
        const { batch, generation, owner } = await locked(async () => {
          const a = await getAuth();
          return {
            batch: ((await getLocal<WireEvent[]>('queue')) ?? []).slice(0, BATCH),
            generation: a?.generation ?? 0,
            owner: ownerOf(a),
          };
        });
        const sameOwner = async (): Promise<boolean> => {
          const a = await getAuth();
          return !!a && ownerOf(a) === owner;
        };
        if (!batch.length) return;
        const sent = new Set(batch.map((e) => e.id));
        let res: Response;
        try {
          res = await postJson('/api/browser-ext/events', { events: batch }, generation);
        } catch (e) {
          if (e instanceof StaleBindingError) {
            // Same tenant re-bound: keep the queue and resend with the new token. Another tenant or
            // region: never send the old tenant's events (bind already cleared them).
            if (!(await sameOwner())) await locked(() => removeIds(sent));
            continue;
          }
          return; // offline or paused: retry on the next alarm
        }
        if (!res.ok) {
          if (!(await permanent(res))) return; // 429/5xx/transient 403: back off until the next alarm
          await locked(async () => {
            await removeIds(sent);
            await setLocal({ droppedEvents: ((await getLocal<number>('droppedEvents')) ?? 0) + batch.length });
          });
          continue;
        }
        let rejected = new Set<string>();
        try {
          const b = (await res.json()) as { rejected?: { id?: unknown }[] };
          rejected = new Set((b.rejected ?? []).map((r) => String(r.id)));
        } catch {
          /* treat as all accepted */
        }
        await locked(async () => {
          if (((await getAuth())?.generation ?? 0) !== generation && !(await sameOwner())) return; // other tenant: state already cleared
          await removeIds(sent);
          const cutoff = Date.now() - REPORTED_MS;
          const rep = ((await getLocal<WireEvent[]>('reported')) ?? []).filter((e) => Date.parse(e.occurredAt) >= cutoff);
          for (const e of batch) if (!rejected.has(e.id) && Date.parse(e.occurredAt) >= cutoff) rep.push(e);
          await setLocal({ reported: rep.slice(-QUEUE_CAP) });
        });
      }
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}
