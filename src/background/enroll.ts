// Enrollment: managed storage, the bind tab, and the bind code exchange (spec §4).
import { toAuth } from './api.ts';
import { apiBaseFor, DEFAULT_BIND_BASE, senderOrigin } from './config.ts';
import { clearBindingState, DISCONNECTED_KEY, type Disconnected, type DisconnectReason } from './signout.ts';
import { getAuth, getLocal, getSession, locked, setLocal, setSession } from './store.ts';

export interface Managed {
  tenantSubdomain?: string;
  apiBaseUrl?: string;
  enrollmentToken?: string;
}

export async function readManaged(): Promise<Managed> {
  try {
    const m = (await chrome.storage.managed.get(null)) as Record<string, unknown>;
    const s = (k: string): string | undefined => (typeof m[k] === 'string' && m[k] ? (m[k] as string) : undefined);
    return { tenantSubdomain: s('tenantSubdomain'), apiBaseUrl: s('apiBaseUrl'), enrollmentToken: s('enrollmentToken') };
  } catch {
    return {}; // no managed storage (manual install, or unsupported browser)
  }
}

export async function deviceId(): Promise<string> {
  let id = await getLocal<string>('deviceId');
  if (!id) {
    id = crypto.randomUUID();
    await setLocal({ deviceId: id });
  }
  return id;
}

export function browserInfo(): { browser: string; browserVersion: string } {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const edge = /Edg\/([\d.]+)/.exec(ua);
  if (edge) return { browser: 'edge', browserVersion: edge[1]! };
  const chromeV = /Chrome\/([\d.]+)/.exec(ua);
  return { browser: 'chrome', browserVersion: chromeV?.[1] ?? '' };
}

const BIND_REOPEN_MS = 60_000;
const BIND_STATE_TTL_MS = 10 * 60_000;
const MAX_PENDING_BINDS = 3;

function newState(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Constant-time comparison for equal-length strings (length mismatch fails fast; lengths are public). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Consumes the pending bind state if `state` matches it and it has not expired. */
// One worker instance at a time, so an in-memory chain is enough to serialize the bind-state store.
let bindStatesChain: Promise<unknown> = Promise.resolve();
function withBindStates<T>(fn: () => Promise<T>): Promise<T> {
  const run = bindStatesChain.then(fn, fn);
  bindStatesChain = run.catch(() => undefined);
  return run;
}

function consumeState(state: unknown): Promise<boolean> {
  return withBindStates(() => consumeStateUnlocked(state));
}

async function consumeStateUnlocked(state: unknown): Promise<boolean> {
  if (typeof state !== 'string') return false;
  const now = Date.now();
  const live = (await pendingBinds()).filter((p) => now - p.createdAt >= 0 && now - p.createdAt < BIND_STATE_TTL_MS);
  // Constant-time compare against every live state (more than one bind tab can be open).
  let match = false;
  for (const p of live) if (safeEqual(state, p.state)) match = true;
  if (!match) return false;
  await chrome.storage.session.remove('pendingBind'); // single use: all states cleared before any network call
  return true;
}

type PendingBind = { state: string; createdAt: number };

/** Live bind states, newest last. Accepts the legacy single-object shape. */
async function pendingBinds(): Promise<PendingBind[]> {
  const raw = await getSession<unknown>('pendingBind');
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.filter(
    (p): p is PendingBind =>
      !!p && typeof (p as PendingBind).state === 'string' && typeof (p as PendingBind).createdAt === 'number',
  );
}

/**
 * Opens the bind page (at most once a minute unless the user asked: `force`). Managed values pick
 * the region and tenant.
 */
export async function openBind(force = false): Promise<void> {
  const last = (await getSession<number>('bindOpenedAt')) ?? 0;
  if (!force && Date.now() - last < BIND_REOPEN_MS) return;
  await setSession({ bindOpenedAt: Date.now() });
  const managed = await readManaged();
  const auth = await getAuth();
  const base = apiBaseFor(managed.apiBaseUrl) ?? (auth ? apiBaseFor(auth.apiBaseUrl) : null) ?? DEFAULT_BIND_BASE;
  const u = new URL(`${base}/app/browser-extension/bind`);
  const tenant = managed.tenantSubdomain ?? auth?.tenant;
  if (tenant) u.searchParams.set('tenant', tenant);
  u.searchParams.set('ext', chrome.runtime.id);
  // Anti-fixation: only a bind that echoes one of our recent states is accepted. Keep the last few, so a
  // bind tab opened earlier (e.g. on startup) still works after the user clicks Connect again.
  // Serialized: the install-time open and a user's Connect click can race, and an unserialized
  // read-modify-write would drop one tab's state.
  const state = newState();
  await withBindStates(async () => {
    const now = Date.now();
    const keep = (await pendingBinds()).filter((p) => now - p.createdAt < BIND_STATE_TTL_MS).slice(-(MAX_PENDING_BINDS - 1));
    await setSession({ pendingBind: [...keep, { state, createdAt: now }] });
  });
  u.searchParams.set('state', state);
  await chrome.tabs.create({ url: u.href });
}

/** Popup state. Never opens the bind page: the popup has a button for that. */
export async function popupInfo(): Promise<{
  connected: boolean; tenantName: string | null; needsReauth: boolean; disconnected: DisconnectReason | null; tenantOrigin: string; locale: string;
}> {
  const auth = await getAuth();
  const needsReauth = auth?.needsReauth === true;
  const d = auth ? undefined : await getLocal<Disconnected>(DISCONNECTED_KEY);
  return {
    connected: !!auth && !needsReauth,
    tenantName: auth?.tenantName || null,
    needsReauth,
    disconnected: d?.reason === 'revoked' || d?.reason === 'disabled' ? d.reason : null,
    tenantOrigin: auth?.tenantOrigin ?? '',
    locale: auth?.locale ?? 'en',
  };
}

const CODE = /^[A-Za-z0-9_-]{1,512}$/;

/**
 * onMessageExternal handler. Returns null (ignore, no response) for anything not from our bind hosts.
 * The API base is the region of the sending host, mapped explicitly; managed config pins it.
 */
/** `reason` is a short, non-sensitive code shown on the bind page so support can tell failures apart. */
export type BindResult = { ok: boolean; reason?: 'bad_code' | 'no_pending_connect' | 'region_mismatch' | 'server_rejected' | 'bad_response' | 'tenant_mismatch' | 'network' };

export async function handleBind(msg: unknown, sender: chrome.runtime.MessageSender): Promise<BindResult | null> {
  const base = apiBaseFor(senderOrigin(sender));
  if (!base) return null;
  const m = msg as { type?: unknown; code?: unknown; state?: unknown } | null;
  if (!m || m.type !== 'bind') return null;
  if (typeof m.code !== 'string' || !CODE.test(m.code)) return { ok: false, reason: 'bad_code' };
  if (!(await consumeState(m.state))) return { ok: false, reason: 'no_pending_connect' };
  const managed = await readManaged();
  if (managed.apiBaseUrl && apiBaseFor(managed.apiBaseUrl) !== base) return { ok: false, reason: 'region_mismatch' };
  const body: Record<string, unknown> = {
    code: m.code,
    state: m.state,
    deviceId: await deviceId(),
    ...browserInfo(),
    extVersion: chrome.runtime.getManifest().version,
    managed: !!(managed.tenantSubdomain || managed.apiBaseUrl || managed.enrollmentToken),
  };
  if (managed.enrollmentToken) body['enrollmentToken'] = managed.enrollmentToken;
  try {
    const res = await fetch(`${base}/api/browser-ext/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, reason: 'server_rejected' };
    // The response's apiBaseUrl is deliberately ignored: the region is pinned to the allow-listed bind
    // host the code came from (or managed config). Trusting the response would let a compromised or
    // misconfigured server redirect the extension token and all events to another host.
    const auth = toAuth(await res.json(), base);
    if (!auth) return { ok: false, reason: 'bad_response' };
    // Managed installs are pinned to their tenant.
    if (managed.tenantSubdomain && auth.tenant !== managed.tenantSubdomain) return { ok: false, reason: 'tenant_mismatch' };
    // Same lock as flush: a flush can never pair the old tenant's batch with the new token.
    await locked(async () => {
      const prev = await getAuth();
      // Another region, tenant or USER (or a legacy binding with no user id): nothing of the previous
      // person's may be sent under the new token. Only a same-user rebind keeps the queue.
      if (prev && (prev.apiBaseUrl !== base || prev.tenant !== auth.tenant || !prev.userId || prev.userId !== auth.userId)) {
        await clearBindingState();
      }
      await chrome.storage.session.remove('allow');
      await chrome.storage.local.remove(DISCONNECTED_KEY); // signed in again: the disconnect notice is done
      await setLocal({ auth: { ...auth, generation: (prev?.generation ?? 0) + 1 } });
    });
    await setSession({ bindOpenedAt: 0 });
    return { ok: true };
  } catch {
    return { ok: false, reason: 'network' };
  }
}
