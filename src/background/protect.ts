// Extra protection (optional permissions): the AI paste content script registration and its messages,
// and the popup's "Report this site" call.
import { parse } from 'tldts';
import { aiToolMatches, DEFAULT_AI_TOOLS, matchAiTool, sanitizeAiTools } from '../detect/ai-tools.ts';
import { PASTE_CATEGORIES, type PasteCategory } from '../detect/sensitive-paste.ts';
import { indexFor } from './ai-usage.ts';
import { AuthPausedError, errorCode, postJson } from './api.ts';
import { enqueue, flush } from './events.ts';
import {
  aiPasteModeOf, claimOnce, extraModeOf, getAuthAndPolicy, getPolicy, THROTTLE_MS,
  type AiPasteMode, type ExtraMode, type Policy,
} from './store.ts';

import { AI_ORIGINS } from '../manifest.ts';

export { AI_ORIGINS };
/** The password-entry script of 1.0–1.1 pre-releases; unregistered on start (the feature was removed). */
export const LEGACY_PASSWORD_SCRIPT_ID = 'rl-password';

export const AIPASTE_SCRIPT_ID = 'rl-aipaste';
/** Built as a self-contained IIFE next to the manifest (vite.config.ts). */
export const AIPASTE_SCRIPT_FILE = 'content-aipaste.js';

export async function extraModes(): Promise<{ downloads: ExtraMode; aiPaste: AiPasteMode }> {
  const p = await getPolicy();
  return {
    downloads: extraModeOf(p.detectors?.downloads),
    aiPaste: aiPasteModeOf(p.detectors?.aiPaste),
  };
}

/**
 * Match patterns for the AI tool directory (policy `aiTools`, else the built-in copy): each listed host,
 * plus its subdomains when the entry is a registrable domain (same rule as matchAiTool). Sorted, unique.
 */
export function aiPasteMatches(policy: Policy): string[] {
  // Only hosts the manifest can grant: a policy tool outside the built-in list waits for a release.
  const grantable = new Set(AI_ORIGINS);
  return aiToolMatches(sanitizeAiTools(policy.aiTools) ?? DEFAULT_AI_TOOLS).filter((m) => grantable.has(m));
}

/** Drops the removed password-entry script left registered by an older version. */
export async function removeLegacyPasswordScript(): Promise<void> {
  if (!chrome.scripting?.unregisterContentScripts) return;
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [LEGACY_PASSWORD_SCRIPT_ID] }).catch(() => []);
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [LEGACY_PASSWORD_SCRIPT_ID] }).catch(() => {});
}

/**
 * Registers the sensitive-paste content script on AI tool hosts while the optional host permission is
 * granted and the detector is on; unregisters it otherwise. Re-registers when the tool list changes.
 * Idempotent; runs on worker start, permission changes and policy changes.
 */
export async function syncAiPasteScript(): Promise<void> {
  if (!chrome.scripting?.registerContentScripts || !chrome.permissions?.contains) return;
  const granted = await chrome.permissions.contains({ origins: AI_ORIGINS }).catch(() => false);
  const policy = await getPolicy();
  const on = granted && aiPasteModeOf(policy.detectors?.aiPaste) !== 'off';
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [AIPASTE_SCRIPT_ID] }).catch(() => []);
  const matches = on ? aiPasteMatches(policy) : [];
  const same = existing.length > 0 && JSON.stringify([...(existing[0]!.matches ?? [])].sort()) === JSON.stringify(matches);
  if (on && same) return;
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [AIPASTE_SCRIPT_ID] });
  if (on && matches.length) {
    await chrome.scripting.registerContentScripts([{
      id: AIPASTE_SCRIPT_ID, matches, js: [AIPASTE_SCRIPT_FILE],
      runAt: 'document_idle', allFrames: false, persistAcrossSessions: true,
    }]);
  }
}

const hostOf = (url: string): string | null => {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
};

/** storage.local claimOnce map: `${toolId}|${category}|${action}` -> time recorded. */
export const AIPASTE_SEEN_KEY = 'aiPasteSeen';

/** The AI tool of a top-frame sender, or null. */
async function aiToolOf(sender: chrome.runtime.MessageSender, policy: Policy): Promise<{ toolId: string; domain: string } | null> {
  const host = sender.url ? hostOf(sender.url) : null;
  if (typeof sender.tab?.id !== 'number' || sender.frameId !== 0 || !host) return null;
  const toolId = matchAiTool(host, indexFor(policy));
  if (!toolId) return null;
  return { toolId, domain: parse(host).domain ?? host };
}

/** 'aipaste-config' from the content script: the mode and tenant locale (never anything about the page). */
export async function aiPasteConfig(sender: chrome.runtime.MessageSender): Promise<{ mode: AiPasteMode; locale?: string }> {
  const { auth, policy } = await getAuthAndPolicy();
  if (!auth || auth.needsReauth) return { mode: 'off' };
  const mode = aiPasteModeOf(policy.detectors?.aiPaste);
  if (mode === 'off' || !(await aiToolOf(sender, policy))) return { mode: 'off' };
  return { mode, locale: auth.locale };
}

/**
 * 'aipaste-event' {category, action}: records a sensitive paste. The message carries only the category
 * enum and the choice (the pasted text never leaves the page). One event per tool + category + action per
 * 24 h. The tool comes from the sender URL Chrome attaches, reduced to its registrable domain.
 */
export async function aiPasteEvent(msg: { category?: unknown; action?: unknown }, sender: chrome.runtime.MessageSender): Promise<{ ok: boolean }> {
  const { auth, policy } = await getAuthAndPolicy();
  if (!auth || auth.needsReauth) return { ok: false };
  const mode = aiPasteModeOf(policy.detectors?.aiPaste);
  const category = PASTE_CATEGORIES.find((c) => c === msg.category) as PasteCategory | undefined;
  const allowed = mode === 'block' ? ['blocked'] : mode === 'warn' ? ['proceeded', 'went_back'] : [];
  const action = allowed.find((a) => a === msg.action) as 'proceeded' | 'went_back' | 'blocked' | undefined;
  const tool = await aiToolOf(sender, policy);
  if (!category || !action || !tool) return { ok: false };
  if (!(await claimOnce(AIPASTE_SEEN_KEY, `${tool.toolId}|${category}|${action}`, THROTTLE_MS, true))) return { ok: true };
  await enqueue('browser.ai_sensitive_paste', tool.domain, action, category);
  void flush();
  return { ok: true };
}

export type SiteReportResult = { status: 'sent' | 'already' | 'rate_limited' | 'invalid' | 'failed' | 'unauthenticated' };
const HOST = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?:\.(?!-)[a-z0-9-]{1,63})*$/;

/** Popup "Report this site": host only (never path or query), optional plain-text note ≤ 500. */
export async function siteReport(msg: { domain?: unknown; note?: unknown }): Promise<SiteReportResult> {
  const domain = typeof msg.domain === 'string' ? msg.domain.trim().toLowerCase().replace(/\.$/, '') : '';
  if (!HOST.test(domain)) return { status: 'invalid' };
  const note = typeof msg.note === 'string' ? msg.note.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, 500) : '';
  let res: Response;
  try {
    res = await postJson('/api/browser-ext/site-reports', note ? { domain, note } : { domain });
  } catch (e) {
    return { status: e instanceof AuthPausedError ? 'unauthenticated' : 'failed' };
  }
  if (res.ok) {
    // Idempotent replay of an open report (200, or a 2xx body flag).
    let b: { alreadyReported?: unknown; created?: unknown } = {};
    try { b = (await res.clone().json()) as typeof b; } catch { /* empty body */ }
    return { status: b.alreadyReported === true || b.created === false || res.status === 200 ? 'already' : 'sent' };
  }
  if (res.status === 409) return { status: 'already' };
  const code = await errorCode(res);
  if (res.status === 429 || code === 'SITE_REPORT_RATE_LIMITED') return { status: 'rate_limited' };
  if (res.status === 400 || code === 'INVALID_TARGET') return { status: 'invalid' };
  return { status: 'failed' };
}
