// Region hosts. The bind page lives on these fixed hosts only (the externally_connectable matches).

const env = (import.meta as unknown as { env?: { MODE?: string; VITE_DEV_BIND_BASE?: string; VITE_STAGING_BASE?: string } }).env;
export const DEV_BUILD: boolean = env?.MODE === 'dev';
/** Local test builds against staging only (`npm run build:staging`); never shipped to the stores. */
export const STAGING_BUILD: boolean = env?.MODE === 'staging';

const PROD_BASES = ['https://app.ransomleak.com', 'https://app.eu.ransomleak.com'] as const;
/** From .env.staging, so the store build carries no staging host. */
const STAGING_BASE = STAGING_BUILD ? env?.VITE_STAGING_BASE : undefined;
const DEV_ORIGIN = /^https:\/\/app\.localhost(:\d{1,5})?$/;

export const DEFAULT_BIND_BASE = DEV_BUILD
  ? (env?.VITE_DEV_BIND_BASE && DEV_ORIGIN.test(env.VITE_DEV_BIND_BASE) ? env.VITE_DEV_BIND_BASE : 'https://app.localhost:5172')
  : STAGING_BASE ?? PROD_BASES[0];

/**
 * Maps a sender/config origin to its API base, or null when it is not one of ours.
 * Exact match only: never derive a base from an arbitrary origin.
 */
export function apiBaseFor(origin: string | undefined, dev: boolean = DEV_BUILD): string | null {
  if (!origin) return null;
  let o: string;
  try {
    o = new URL(origin).origin;
  } catch {
    return null;
  }
  if (o !== origin.replace(/\/+$/, '')) return null; // reject paths, credentials, etc.
  if ((PROD_BASES as readonly string[]).includes(o)) return o;
  if (dev && DEV_ORIGIN.test(o)) return o;
  if (STAGING_BASE && o === STAGING_BASE) return o;
  return null;
}

/** Origin of a runtime MessageSender (sender.origin, falling back to sender.url). */
export function senderOrigin(sender: chrome.runtime.MessageSender): string | undefined {
  if (sender.origin) return sender.origin;
  try {
    return sender.url ? new URL(sender.url).origin : undefined;
  } catch {
    return undefined;
  }
}
