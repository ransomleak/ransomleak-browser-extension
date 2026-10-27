// Daily heartbeat (coverage data) and alarm scheduling.
import { postJson } from './api.ts';
import { browserInfo } from './enroll.ts';
import { getLocal, locked, setLocal } from './store.ts';

export const ALARMS = {
  heartbeat: 24 * 60,
  policy: 30,
  nrd: 24 * 60,
  flush: 5,
} as const;

/** Creates missing alarms; existing ones keep their schedule across worker restarts. */
export async function ensureAlarms(): Promise<void> {
  const existing = new Map((await chrome.alarms.getAll()).map((a) => [a.name, a]));
  for (const [name, periodInMinutes] of Object.entries(ALARMS)) {
    const a = existing.get(name);
    if (!a || a.periodInMinutes !== periodInMinutes) await chrome.alarms.create(name, { periodInMinutes, delayInMinutes: periodInMinutes });
  }
}

export async function sendHeartbeat(): Promise<void> {
  const got = await chrome.storage.local.get(['consentMiss', 'droppedEvents', 'nrdBloomHitsUnconfirmed']);
  const consentMiss = (got['consentMiss'] as Record<string, number> | undefined) ?? {};
  const droppedEvents = (got['droppedEvents'] as number | undefined) ?? 0;
  const nrdBloomHitsUnconfirmed = (got['nrdBloomHitsUnconfirmed'] as number | undefined) ?? 0;
  try {
    const res = await postJson('/api/browser-ext/heartbeat', {
      extVersion: chrome.runtime.getManifest().version,
      ...browserInfo(),
      consentMiss,
      droppedEvents,
      nrdBloomHitsUnconfirmed,
    });
    if (!res.ok) return;
  } catch {
    return;
  }
  // Counts are per heartbeat period: subtract what we just reported.
  await locked(async () => {
    const now = (await getLocal<Record<string, number>>('consentMiss')) ?? {};
    for (const [k, v] of Object.entries(consentMiss)) {
      const left = (now[k] ?? 0) - v;
      if (left > 0) now[k] = left;
      else delete now[k];
    }
    const dropped = ((await getLocal<number>('droppedEvents')) ?? 0) - droppedEvents;
    const bloom = ((await getLocal<number>('nrdBloomHitsUnconfirmed')) ?? 0) - nrdBloomHitsUnconfirmed;
    await setLocal({ consentMiss: now, droppedEvents: Math.max(0, dropped), nrdBloomHitsUnconfirmed: Math.max(0, bloom) });
  });
}
