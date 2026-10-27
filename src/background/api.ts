// Authenticated calls to /api/browser-ext. One refresh attempt on 401; a second 401 (or a revoked
// refresh) pauses all calls and flags reauth until the user binds again.
import { clearBadge } from './badge.ts';
import { safeTenantOrigin } from '../lib/origin.ts';
import { disconnect, disconnectReasonFor } from './signout.ts';
import { getAuth, LOCALES, locked, setLocal, type Auth, type Locale } from './store.ts';

export class AuthPausedError extends Error {
  constructor() {
    super('extension token needs re-binding');
  }
}

export interface EnrollResponse {
  token: string;
  refreshToken: string;
  expiresAt: string;
  tenant: string;
  tenantName: string;
  tenantOrigin: string;
  apiBaseUrl: string;
  locale: string;
  userId?: string;
}

const str = (v: unknown, max = 4096): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

/** Validates an enroll/refresh response into stored auth. The API base is pinned by the caller. */
export function toAuth(r: unknown, apiBaseUrl: string): Auth | null {
  if (!r || typeof r !== 'object') return null;
  const o = r as Record<string, unknown>;
  if (!str(o['token']) || !str(o['refreshToken'])) return null;
  const tenantOrigin = safeTenantOrigin(o['tenantOrigin']) ?? ''; // no Learn link without a valid origin
  const locale = LOCALES.includes(o['locale'] as Locale) ? (o['locale'] as Locale) : 'en';
  return {
    token: o['token'],
    refreshToken: o['refreshToken'],
    expiresAt: str(o['expiresAt'], 64) ? o['expiresAt'] : '',
    tenant: str(o['tenant'], 128) ? o['tenant'] : '',
    tenantName: str(o['tenantName'], 200) ? o['tenantName'] : '',
    tenantOrigin,
    apiBaseUrl,
    locale,
    ...(str(o['userId'], 128) ? { userId: o['userId'] } : {}),
  };
}

/**
 * Applies a refresh response to the current binding. token/refreshToken/expiresAt always come from the
 * response; tenant fields and locale are replaced only when the response carries them, so a minimal
 * {token, refreshToken, expiresAt} keeps the binding intact. apiBaseUrl and generation never change.
 */
export function mergeRefresh(cur: Auth, r: unknown): Auth | null {
  const parsed = toAuth(r, cur.apiBaseUrl);
  if (!parsed) return null;
  const o = r as Record<string, unknown>;
  const has = (k: string): boolean => o[k] !== undefined && o[k] !== null;
  return {
    ...cur,
    token: parsed.token,
    refreshToken: parsed.refreshToken,
    expiresAt: parsed.expiresAt,
    tenant: has('tenant') ? parsed.tenant : cur.tenant,
    tenantName: has('tenantName') ? parsed.tenantName : cur.tenantName,
    tenantOrigin: has('tenantOrigin') ? parsed.tenantOrigin : cur.tenantOrigin,
    locale: has('locale') ? parsed.locale : cur.locale,
    userId: has('userId') && parsed.userId ? parsed.userId : cur.userId,
    needsReauth: undefined,
    generation: cur.generation ?? 0,
  };
}

/** Backend error codes (EXT_ERROR_CODES) that mean the credential is gone for good. */
export const REVOKED_CODES: ReadonlySet<string> = new Set(['EXT_TOKEN_INVALID', 'USER_DISABLED', 'EXT_DEVICE_REVOKED']);

/** The JSON `code` of an error response, or null. Never throws. */
export async function errorCode(res: Response): Promise<string | null> {
  try {
    const b = (await res.clone().json()) as { code?: unknown };
    return typeof b?.code === 'string' ? b.code : null;
  } catch {
    return null;
  }
}

/** A refresh is refused for good on 401, or on 400/403 carrying an explicit revocation code. */
async function refreshRevoked(res: Response): Promise<boolean> {
  if (res.status === 401) return true;
  if (res.status !== 400 && res.status !== 403) return false;
  const code = await errorCode(res);
  return code !== null && REVOKED_CODES.has(code);
}

/**
 * A 401 from the guard or the refresh endpoint: EXT_DEVICE_REVOKED / USER_DISABLED sign out for good
 * (signout.ts); anything else (plain expiry, unknown token) flags reauth as before.
 */
async function refused(used: Auth, code: string | null): Promise<never> {
  const reason = disconnectReasonFor(code);
  if (reason) await disconnect(used, reason);
  else await flagReauth(used);
  throw new AuthPausedError();
}

/** Flags reauth only if the binding and the refresh token that failed are still the stored ones. */
async function flagReauth(used: Auth): Promise<void> {
  await locked(async () => {
    const a = await getAuth();
    if (a && (a.generation ?? 0) === (used.generation ?? 0) && a.refreshToken === used.refreshToken) {
      await setLocal({ auth: { ...a, needsReauth: true } });
      await clearBadge();
    }
  });
}

// Single-flight per (generation, refresh token): a caller on a newer binding never gets an old result.
type Refused = { refused: true; code: string | null };
const refreshing = new Map<string, Promise<Auth | Refused>>();
const isRefused = (r: Auth | Refused): r is Refused => 'refused' in r;

/** Returns fresh auth, or Refused (with the backend code) when the server refused the refresh token. Throws on network/transient errors. */
function refresh(auth: Auth): Promise<Auth | Refused> {
  const key = `${auth.generation ?? 0}|${auth.refreshToken}`;
  let p = refreshing.get(key);
  if (p) return p;
  p = (async () => {
    try {
      const res = await fetch(`${auth.apiBaseUrl}/api/browser-ext/token/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: auth.refreshToken }),
      });
      if (!res.ok) {
        if (await refreshRevoked(res)) return { refused: true, code: await errorCode(res) };
        throw new Error(`refresh ${res.status}`);
      }
      // Never let a response move us to another region.
      const next = mergeRefresh(auth, await res.json());
      if (!next) return { refused: true, code: null };
      // Only replace the binding we refreshed; a bind in the meantime wins.
      const stored = await locked(async () => {
        const cur = await getAuth();
        if ((cur?.generation ?? 0) !== (auth.generation ?? 0) || cur?.refreshToken !== auth.refreshToken) return false;
        await setLocal({ auth: next });
        return true;
      });
      return stored ? next : { refused: true, code: null };
    } finally {
      refreshing.delete(key);
    }
  })();
  refreshing.set(key, p);
  return p;
}

/**
 * Refreshes from the CURRENTLY stored auth. When someone already rotated past `used`, returns the stored
 * auth without refreshing. Flags reauth (and throws) only when this binding's current token was refused.
 */
async function renew(used: Auth): Promise<Auth> {
  const cur = await getAuth();
  if (!cur || cur.needsReauth) throw new AuthPausedError();
  if ((cur.generation ?? 0) !== (used.generation ?? 0)) throw new StaleBindingError();
  if (cur.token !== used.token) return cur; // a sibling already refreshed: just retry with it
  const next = await refresh(cur);
  if (!isRefused(next)) return next;
  // A deliberate disconnect is final whatever a sibling did with the refresh token.
  if (disconnectReasonFor(next.code)) return refused(cur, next.code);
  const after = await getAuth();
  // Refresh "lost" because a sibling rotated or a rebind happened: not a revocation.
  if (after && !after.needsReauth && (after.generation ?? 0) === (cur.generation ?? 0) && after.refreshToken !== cur.refreshToken) {
    return after;
  }
  return refused(cur, null);
}

const expired = (a: Auth): boolean => {
  const t = Date.parse(a.expiresAt);
  return Number.isFinite(t) && t <= Date.now();
};

export class StaleBindingError extends Error {
  constructor() {
    super('binding changed');
  }
}

/**
 * Fetch with Bearer auth. Throws AuthPausedError when unbound or paused. With `expectGeneration`,
 * throws StaleBindingError if the extension was re-bound since the caller read its data.
 */
export async function apiFetch(path: string, init: RequestInit = {}, expectGeneration?: number): Promise<Response> {
  let auth = await getAuth();
  if (!auth || auth.needsReauth) throw new AuthPausedError();
  if (expectGeneration !== undefined && (auth.generation ?? 0) !== expectGeneration) throw new StaleBindingError();
  const go = (a: Auth): Promise<Response> =>
    fetch(`${a.apiBaseUrl}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${a.token}` },
    });
  let refreshed = false;
  if (expired(auth)) {
    auth = await renew(auth);
    refreshed = true;
  }
  let res = await go(auth);
  if (res.status === 401) {
    const code = await errorCode(res);
    // Revoked device / disabled user: refreshing cannot help, sign out now.
    if (refreshed || disconnectReasonFor(code)) return refused(auth, code);
    const next = await renew(auth);
    res = await go(next);
    if (res.status === 401) return refused(next, await errorCode(res));
  }
  return res;
}

export async function postJson(path: string, body: unknown, expectGeneration?: number): Promise<Response> {
  return apiFetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, expectGeneration);
}
