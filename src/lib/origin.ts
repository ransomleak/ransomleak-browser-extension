// Tenant origins come from the server; a link is built from one only when it is https without
// credentials (this also covers dev's https://*.localhost). Anything else hides the link.
export function safeTenantOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && !u.username && !u.password ? u.origin : null;
  } catch {
    return null;
  }
}

/** A canonical UUID (server ids: exercises, campaigns, learning paths). */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Same cap the backend enforces on a recommendation path. */
export const TRAINING_PATH_MAX = 512;
const TRAINING_PATH_RE = /^\/app\/[A-Za-z0-9\-._~/?=&%]*$/;

/** A server-sent learner path: relative `/app/...`, no scheme / host / backslash / traversal, capped. */
export function isSafeAppPath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.length <= TRAINING_PATH_MAX &&
    TRAINING_PATH_RE.test(path) &&
    !path.includes('//') &&
    !path.split(/[/?]/).includes('..')
  );
}

/** `path` resolved on the tenant origin when both are safe and it stays under `/app/`; else null. */
export function safeAppUrl(origin: unknown, path: unknown): string | null {
  const safe = safeTenantOrigin(origin);
  if (!safe || !isSafeAppPath(path)) return null;
  const u = new URL(path, safe);
  return u.origin === safe && u.pathname.startsWith('/app/') ? u.href : null;
}

/** Learner pages the extension links to, relative to the tenant origin. */
export interface AppLinks { todo: string; training: string }
/** Built-in learner pages, used when the server sends none (backends before policy `links`) or an unsafe one. */
export const DEFAULT_APP_LINKS: Readonly<AppLinks> = Object.freeze({ todo: '/app/campaigns', training: '/app/microlearning' });

/** The policy's `links`, each kept only when it is a safe `/app/...` path, else the built-in page. */
export function appLinks(raw: unknown): AppLinks {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const pick = (k: keyof AppLinks): string => {
    const v = o[k];
    return isSafeAppPath(v) && !v.includes('?') ? v : DEFAULT_APP_LINKS[k];
  };
  return { todo: pick('todo'), training: pick('training') };
}

/**
 * Link to a recommended training on the tenant: the server's `path` when it is a safe `/app/...` path,
 * else (older backend, or a rejected path) the Microlearning tab (`trainingPath`, the policy's
 * `links.training`) highlighting `exerciseId`.
 * Null when the origin is unsafe or neither input is usable.
 */
export function trainingUrl(
  origin: unknown,
  path: unknown,
  exerciseId: unknown,
  trainingPath: string = DEFAULT_APP_LINKS.training,
): string | null {
  const safe = safeTenantOrigin(origin);
  if (!safe) return null;
  const direct = safeAppUrl(safe, path);
  if (direct) return direct;
  if (typeof exerciseId !== 'string' || !exerciseId || exerciseId.length > 128) return null;
  const base = safeAppUrl(safe, trainingPath) ?? safeAppUrl(safe, DEFAULT_APP_LINKS.training);
  if (!base) return null;
  const u = new URL(base);
  u.searchParams.set('highlight', exerciseId);
  return u.href;
}
