// Full sign-out when the organization revokes this browser or disables the user (EXT_DEVICE_REVOKED /
// USER_DISABLED). Everything tied to the binding is dropped; only a `disconnected` marker stays so the
// popup can say why. With no auth and no policy the extension behaves exactly as if it was never
// enrolled (detectors run on built-in defaults, no tenant policy, feeds or allow overrides, nothing sent).
import { clearBadge } from './badge.ts';
import { clearFeeds } from './policy.ts';
import { getAuth, locked, setLocal, type Auth } from './store.ts';

export type DisconnectReason = 'revoked' | 'disabled';
export interface Disconnected { reason: DisconnectReason; at: string }
export const DISCONNECTED_KEY = 'disconnected';

/** Backend code -> deliberate disconnect reason; null for anything else (plain expiry keeps needsReauth). */
export function disconnectReasonFor(code: string | null): DisconnectReason | null {
  return code === 'EXT_DEVICE_REVOKED' ? 'revoked' : code === 'USER_DISABLED' ? 'disabled' : null;
}

/**
 * Drops everything tied to the previous binding (region, tenant or user): policy and etag, feeds, queued
 * events, AI usage, throttles, per-tab session state and allow overrides. Caller holds `locked`.
 */
export async function clearBindingState(): Promise<void> {
  const all = (await chrome.storage.local.get(null)) as Record<string, unknown>;
  const keys = [
    'policy', 'etag', 'nrdBloom', 'popularBloom', 'knownBadSet', 'queue', 'reported', 'throttle', 'consentThrottle', 'consentMiss',
    'nrdBloomHitsUnconfirmed', 'droppedEvents', 'aiUsage', 'aiUsageUtc', 'aiSeen', 'todo', 'todoNotify', ...Object.keys(all).filter((k) => k.startsWith('nrd:')),
  ];
  await chrome.storage.local.remove(keys);
  await clearFeeds();
  await clearBadge();
  const sess = (await chrome.storage.session.get(null)) as Record<string, unknown>;
  await chrome.storage.session.remove(
    Object.keys(sess).filter((k) => k === 'allow' || /^(pending|lastSafe|handled|oauthReq):/.test(k)),
  );
}

/**
 * Signs out for good, but only if `used` is still the stored binding (a re-bind in the meantime wins).
 * Returns true when it signed out.
 */
export function disconnect(used: Auth, reason: DisconnectReason): Promise<boolean> {
  return locked(async () => {
    const a = await getAuth();
    if (!a || (a.generation ?? 0) !== (used.generation ?? 0)) return false;
    await clearBindingState();
    await chrome.storage.local.remove(['auth', 'aiSentToday']);
    await setLocal({ [DISCONNECTED_KEY]: { reason, at: new Date().toISOString() } satisfies Disconnected });
    return true;
  });
}
