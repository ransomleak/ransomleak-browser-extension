// "What we know about you": the popup asks the background, which holds the token (spec section 11.4).
import { UUID_RE } from '../lib/origin.ts';
import { apiFetch, AuthPausedError } from './api.ts';

const PERIODS = new Set<unknown>([7, 30, 90, 'all']);

export type MeSignalsResult = { ok: true; data: unknown } | { ok: false; reason: string };

export async function meSignals(days: unknown): Promise<MeSignalsResult> {
  if (!PERIODS.has(days)) return { ok: false, reason: 'bad-request' };
  try {
    const res = await apiFetch(`/api/browser-ext/me/signals?days=${days}`);
    if (!res.ok) return { ok: false, reason: `http-${res.status}` };
    return { ok: true, data: await res.json() };
  } catch (e) {
    return { ok: false, reason: e instanceof AuthPausedError ? 'unauthenticated' : 'offline' };
  }
}

/** "Not now" on the popup's recommended drill: dismisses the caller's own recommendation. */
export async function dismissRecommendation(exerciseId: unknown): Promise<{ ok: boolean }> {
  if (typeof exerciseId !== 'string' || !UUID_RE.test(exerciseId)) return { ok: false };
  try {
    const res = await apiFetch(`/api/browser-ext/me/recommendations/${exerciseId}/dismiss`, { method: 'POST' });
    return { ok: res.ok || res.status === 404 }; // 404 = already dismissed: hide it either way
  } catch {
    return { ok: false };
  }
}
