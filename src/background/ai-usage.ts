// AI tool usage (spec section 9): DAILY COUNTS PER TOOL only. No URL, path, title or content is stored
// or sent; the host is matched against the directory and dropped.
import { buildAiToolIndex, DEFAULT_AI_TOOLS, matchAiTool, sanitizeAiTools, type AiToolIndex } from '../detect/ai-tools.ts';
import { apiFetch, AuthPausedError, postJson } from './api.ts';
import { claimOnce, getAuth, getLocal, locked, setLocal, type Policy } from './store.ts';

/** storage.local: { 'YYYY-MM-DD' (UTC day, matching the server's attribution window): { toolId: visits } }. */
export const AI_USAGE_KEY = 'aiUsageUtc';
/** Pre-UTC key (local-day buckets); dropped on worker start (dev builds only ever wrote it). */
export const LEGACY_AI_USAGE_KEY = 'aiUsage';
/** storage.local claimOnce map: `${tabId}:${toolId}` -> time counted. */
export const AI_SEEN_KEY = 'aiSeen';
export const AI_SEEN_MS = 30 * 60_000;
export const AI_MAX_DAYS = 14;
/** storage.local: JSON of today's counts as last sent, so an unchanged day is not resent. */
export const AI_SENT_TODAY_KEY = 'aiSentToday';
const MAX_COUNT = 10_000;

type Usage = Record<string, Record<string, number>>;

/** UTC calendar day, YYYY-MM-DD (the server's attribution window is in UTC days). */
export function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

let memo: { version: string | undefined; raw: unknown; index: AiToolIndex } | null = null;
/** The AI tool index for a policy (memoised per policy version). */
export function indexFor(policy: Policy): AiToolIndex {
  if (memo && memo.version === policy.version && memo.raw === policy.aiTools) return memo.index;
  const tools = sanitizeAiTools(policy.aiTools) ?? [...DEFAULT_AI_TOOLS];
  memo = { version: policy.version, raw: policy.aiTools, index: buildAiToolIndex(tools) };
  return memo.index;
}

/** Keeps the newest AI_MAX_DAYS days. */
function prune(u: Usage): Usage {
  const days = Object.keys(u).sort();
  for (const d of days.slice(0, Math.max(0, days.length - AI_MAX_DAYS))) delete u[d];
  return u;
}

/**
 * Counts a committed top-frame navigation to an AI tool, at most once per tab per tool per 30 min (reloads
 * and in-app navigations do not inflate it). Nothing is counted when the detector is off.
 */
export async function countAiVisit(tabId: number, host: string, policy: Policy, now = new Date()): Promise<string | null> {
  if (policy.detectors?.aiUsage === 'off') return null;
  const toolId = matchAiTool(host, indexFor(policy));
  if (!toolId) return null;
  if (!(await claimOnce(AI_SEEN_KEY, `${tabId}:${toolId}`, AI_SEEN_MS, true))) return null;
  const day = utcDay(now);
  await locked(async () => {
    const u = (await getLocal<Usage>(AI_USAGE_KEY)) ?? {};
    const counts = (u[day] ??= {});
    counts[toolId] = Math.min(MAX_COUNT, (counts[toolId] ?? 0) + 1);
    await setLocal({ [AI_USAGE_KEY]: prune(u) });
  });
  return toolId;
}

/**
 * Sends every stored day, today's running count included, so the admin page is current within about
 * half an hour. Completed days are deleted after a 2xx; today stays and is resent as it grows (the server
 * keeps the larger count, so resends are idempotent). Nothing is sent when only today is stored and it has
 * not changed since the last send. The batch is read with the binding generation and never sent under a
 * newer binding; failures keep the days for the next alarm.
 */
export async function sendAiUsage(now = new Date()): Promise<void> {
  const today = utcDay(now);
  const { days, generation, userId, lastToday } = await locked(async () => {
    const u = prune((await getLocal<Usage>(AI_USAGE_KEY)) ?? {});
    const a = await getAuth();
    return {
      days: Object.keys(u).sort().filter((d) => d <= today).map((date) => ({ date, counts: u[date]! })),
      generation: a?.generation ?? 0,
      userId: a?.userId,
      lastToday: await getLocal<string>(AI_SENT_TODAY_KEY),
    };
  });
  // Counts belong to the bound user: never sent without a known user, nor under another one.
  if (!days.length || !userId) return;
  const todaySnapshot = JSON.stringify(days.find((d) => d.date === today) ?? null);
  if (days.every((d) => d.date === today) && todaySnapshot === lastToday) return;
  if ((await getAuth())?.userId !== userId) return;
  let res: Response;
  try {
    res = await postJson('/api/browser-ext/ai-usage', { days }, generation);
  } catch {
    return; // offline, paused or re-bound: retry next time
  }
  if (!res.ok) return;
  await locked(async () => {
    const a = await getAuth();
    if ((a?.generation ?? 0) !== generation || a?.userId !== userId) return; // re-bound meanwhile: state already handled
    const u = (await getLocal<Usage>(AI_USAGE_KEY)) ?? {};
    for (const d of days) if (d.date < today) delete u[d.date];
    await setLocal({ [AI_USAGE_KEY]: u, [AI_SENT_TODAY_KEY]: todaySnapshot });
  });
}

export type MeAiUsageResult = { ok: true; data: unknown } | { ok: false; reason: string };

/** The employee's own AI tools (popup). The server answers 403 while attribution is off. */
export async function meAiUsage(): Promise<MeAiUsageResult> {
  try {
    const res = await apiFetch('/api/browser-ext/me/ai-usage');
    if (!res.ok) return { ok: false, reason: `http-${res.status}` };
    return { ok: true, data: await res.json() };
  } catch (e) {
    return { ok: false, reason: e instanceof AuthPausedError ? 'unauthenticated' : 'offline' };
  }
}
