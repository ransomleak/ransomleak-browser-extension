// Extra protection (optional permissions): the password-entry content script registration, its
// check/action messages, and the popup's "Report this site" call. Sites are judged by navigation.ts's
// classify(), the same classifier the navigation warnings use.
import { parse } from 'tldts';
import { DEFAULT_AI_TOOLS, matchAiTool, sanitizeAiTools } from '../detect/ai-tools.ts';
import { PASTE_CATEGORIES, type PasteCategory } from '../detect/sensitive-paste.ts';
import { stringsFor } from '../lib/i18n.ts';
import { indexFor } from './ai-usage.ts';
import { AuthPausedError, errorCode, postJson } from './api.ts';
import { enqueue, flush } from './events.ts';
import { classify } from './navigation.ts';
import {
  aiPasteModeOf, claimOnce, extraModeOf, getAuthAndPolicy, getPolicy, getSession, locked, setSession, THROTTLE_MS,
  type AiPasteMode, type ExtraMode, type Policy,
} from './store.ts';

import { EXTRA_ORIGINS } from '../manifest.ts';

export { EXTRA_ORIGINS };
export const PASSWORD_SCRIPT_ID = 'rl-password';
/** Built as a self-contained IIFE next to the manifest (vite.config.ts). */
export const PASSWORD_SCRIPT_FILE = 'content-password.js';

export const AIPASTE_SCRIPT_ID = 'rl-aipaste';
/** Built as a self-contained IIFE next to the manifest (vite.config.ts). */
export const AIPASTE_SCRIPT_FILE = 'content-aipaste.js';

export async function extraModes(): Promise<{ passwordEntry: ExtraMode; downloads: ExtraMode; aiPaste: AiPasteMode }> {
  const p = await getPolicy();
  return {
    passwordEntry: extraModeOf(p.detectors?.passwordEntry),
    downloads: extraModeOf(p.detectors?.downloads),
    aiPaste: aiPasteModeOf(p.detectors?.aiPaste),
  };
}

/**
 * Registers the password-entry content script while the optional host permission is granted, and
 * unregisters it once revoked. Idempotent; runs on every worker start and on permission changes.
 */
export async function syncPasswordScript(): Promise<void> {
  if (!chrome.scripting?.registerContentScripts || !chrome.permissions?.contains) return;
  const granted = await chrome.permissions.contains({ origins: EXTRA_ORIGINS }).catch(() => false);
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [PASSWORD_SCRIPT_ID] }).catch(() => []);
  if (granted && !existing.length) {
    await chrome.scripting.registerContentScripts([{
      id: PASSWORD_SCRIPT_ID, matches: EXTRA_ORIGINS, js: [PASSWORD_SCRIPT_FILE],
      runAt: 'document_idle', allFrames: false, persistAcrossSessions: true,
    }]);
  } else if (!granted && existing.length) {
    await chrome.scripting.unregisterContentScripts({ ids: [PASSWORD_SCRIPT_ID] });
  }
}

/**
 * Match patterns for the AI tool directory (policy `aiTools`, else the built-in copy): each listed host,
 * plus its subdomains when the entry is a registrable domain (same rule as matchAiTool). Sorted, unique.
 */
export function aiPasteMatches(policy: Policy): string[] {
  const out = new Set<string>();
  for (const t of sanitizeAiTools(policy.aiTools) ?? DEFAULT_AI_TOOLS) {
    for (const d of t.domains) {
      if (!/^[a-z0-9.-]+$/.test(d)) continue;
      out.add(`https://${d}/*`);
      if (parse(d).domain === d) out.add(`https://*.${d}/*`);
    }
  }
  return [...out].sort();
}

/**
 * Registers the sensitive-paste content script on AI tool hosts while the optional host permission is
 * granted and the detector is on; unregisters it otherwise. Re-registers when the tool list changes.
 * Idempotent; runs on worker start, permission changes and policy changes.
 */
export async function syncAiPasteScript(): Promise<void> {
  if (!chrome.scripting?.registerContentScripts || !chrome.permissions?.contains) return;
  const granted = await chrome.permissions.contains({ origins: EXTRA_ORIGINS }).catch(() => false);
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

export type PasswordCheck = { show: false } | { show: true; text: { title: string; body: string; back: string; cont: string }; lang: string };

/**
 * 'password-check' from the content script (top frame only), sent on the first focus or keystroke in a
 * password field. The script never sends field values; only the frame URL Chrome attaches is used.
 */
export async function passwordCheck(sender: chrome.runtime.MessageSender): Promise<PasswordCheck> {
  const tabId = sender.tab?.id;
  const host = sender.url ? hostOf(sender.url) : null;
  if (typeof tabId !== 'number' || sender.frameId !== 0 || !host || !sender.url) return { show: false };
  const { auth, policy } = await getAuthAndPolicy();
  if (!auth || auth.needsReauth) return { show: false };
  const mode = extraModeOf(policy.detectors?.passwordEntry);
  if (mode === 'off') return { show: false };
  const tk = `${tabId}|${host}`;
  if ((await getSession<Record<string, true>>('pwAllow'))?.[tk]) return { show: false };
  const verdict = (await classify(sender.url, policy, auth.tenantOrigin))?.verdict;
  if (!verdict) return { show: false };
  const first = await locked(async () => {
    const seen = (await getSession<Record<string, string>>('pwSeen')) ?? {};
    if (seen[tk]) return false;
    seen[tk] = verdict.domain;
    await setSession({ pwSeen: seen });
    return true;
  });
  if (first) {
    await enqueue('browser.password_entry_warned', verdict.domain, mode === 'warn' ? 'warned' : 'logged');
    void flush();
  }
  if (mode === 'log') return { show: false };
  const s = stringsFor(auth.locale);
  return { show: true, lang: auth.locale, text: { title: s.pw_title, body: s.pw_body, back: s.back, cont: s.pw_continue } };
}

/** 'password-action' {action: 'back' | 'continue'}: records the choice; Continue silences this tab+host for the session. */
export async function passwordAction(msg: { action?: unknown }, sender: chrome.runtime.MessageSender): Promise<{ ok: boolean; history?: boolean }> {
  const tabId = sender.tab?.id;
  const host = sender.url ? hostOf(sender.url) : null;
  if (typeof tabId !== 'number' || sender.frameId !== 0 || !host) return { ok: false };
  const tk = `${tabId}|${host}`;
  const domain = (await getSession<Record<string, string>>('pwSeen'))?.[tk];
  if (!domain || (msg.action !== 'back' && msg.action !== 'continue')) return { ok: false };
  if (msg.action === 'continue') {
    await locked(async () => {
      const allow = (await getSession<Record<string, true>>('pwAllow')) ?? {};
      allow[tk] = true;
      await setSession({ pwAllow: allow });
    });
    await enqueue('browser.password_entry_warned', domain, 'proceeded');
    void flush();
    return { ok: true };
  }
  await enqueue('browser.password_entry_warned', domain, 'went_back');
  void flush();
  const safe = await getSession<string>(`lastSafe:${tabId}`);
  if (!safe) return { ok: true, history: true }; // the page goes back in its own history
  await chrome.tabs.update(tabId, { url: safe });
  return { ok: true };
}

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
