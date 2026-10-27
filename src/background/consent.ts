// Messages from the OAuth consent content script (E5). Page-derived fields are validated and
// never put on the wire: events carry only the provider and the consent page's registrable domain.
import { parseHost } from '../lib/domain.ts';
import { enqueue, flush } from './events.ts';
import { blockRequest } from './navigation.ts';
import { actionFor, claimOnce, getLocal, getPolicy, locked, modeOf, setLocal, THROTTLE_MS } from './store.ts';
import { isProvider } from '../lib/providers.ts';

const cap = (s: unknown, n: number): string => (typeof s === 'string' ? s.slice(0, n) : '');

export async function handleConsent(msg: { info?: unknown; risky?: unknown }, sender: chrome.runtime.MessageSender): Promise<void> {
  const info = msg.info as { provider?: unknown; appName?: unknown; appId?: unknown } | undefined;
  if (!info || !isProvider(info.provider) || msg.risky !== true || !sender.url) return;
  const h = parseHost(sender.url);
  if (!h) return;
  const mode = modeOf((await getPolicy()).detectors?.oauth);
  if (mode === 'off') return;
  // Local-only throttle key (app id or capped name), one event per app per 24 h.
  const app = cap(info.appId, 200) || cap(info.appName, 80);
  const key = `${info.provider}:${app}`;
  const fresh = await claimOnce('consentThrottle', key, THROTTLE_MS, true);
  if (!fresh) return;
  await enqueue('browser.oauth_risky_consent_shown', h.sharedHost ? h.host : h.registrable, actionFor(mode), info.provider);
  void flush();
}

/** 'consent-action' {action:'continue'}: the user went past a risky-consent warning (warn mode only). */
export async function handleConsentContinue(msg: { action?: unknown; info?: unknown }, sender: chrome.runtime.MessageSender): Promise<void> {
  const info = msg.info as { provider?: unknown; appName?: unknown; appId?: unknown } | undefined;
  if (msg.action !== 'continue' || !info || !isProvider(info.provider) || !sender.url) return;
  const h = parseHost(sender.url);
  if (!h) return;
  if (modeOf((await getPolicy()).detectors?.oauth) !== 'warn') return;
  const app = cap(info.appId, 200) || cap(info.appName, 80);
  if (!(await claimOnce('consentContinueThrottle', `${info.provider}:${app}`, THROTTLE_MS, true))) return;
  await enqueue('browser.oauth_risky_consent_shown', h.sharedHost ? h.host : h.registrable, 'proceeded', info.provider);
  void flush();
}

export async function handleConsentMiss(msg: { provider?: unknown }): Promise<void> {
  if (!isProvider(msg.provider)) return;
  const p = msg.provider;
  await locked(async () => {
    const c = (await getLocal<Record<string, number>>('consentMiss')) ?? {};
    c[p] = (c[p] ?? 0) + 1;
    await setLocal({ consentMiss: c });
  });
}

// Display name parsed from the consent page: plain text, control chars stripped, trimmed, <= 200 chars.
// Admin-only (shown next to the client ID); omitted when empty or identical to the target.
export function cleanLabel(s: unknown, target: string): string | undefined {
  if (typeof s !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const v = s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200).trim();
  return v && v !== target ? v : undefined;
}

export async function handleConsentBlockRequest(msg: { kind?: unknown; target?: unknown; label?: unknown }): Promise<boolean> {
  if (msg.kind !== 'oauth_app' || typeof msg.target !== 'string' || !msg.target.trim()) return false;
  const target = msg.target.trim().slice(0, 200);
  return blockRequest('oauth_app', target, cleanLabel(msg.label, target));
}
