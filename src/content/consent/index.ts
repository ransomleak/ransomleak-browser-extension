import { parseConsent, providerForHost } from './parse.ts';
import { isRisky } from './risk.ts';
import { DEFAULT_RISKY_SCOPES } from './risky-scopes.ts';
import { showOverlay } from './overlay.ts';
import { consentMode, readLocale, readPolicy } from './policy.ts';
import { pickLocale } from './i18n.ts';
import { CONSENT_PATHS, type OAuthRequest } from '../../lib/oauth-request.ts';
import type { ConsentInfo, Provider } from './types.ts';

// Isolated-world content script. Reads only DOM text/attributes of the consent panel.
const BUDGET_MS = 10_000;
const PARSE_THROTTLE_MS = 500;
const URL_POLL_MS = 1_000;

/**
 * A parser miss counts only on a page that looks like a consent step: known path AND scopes in the URL
 * or in the request the background captured for this tab.
 */
function looksLikeConsent(provider: Provider, url: URL, stored: OAuthRequest | null): boolean {
  const scoped = !!url.searchParams.get('scope') || (provider === 'slack' && !!url.searchParams.get('user_scope'))
    || !!stored?.scopes.length;
  return scoped && CONSENT_PATHS[provider].test(url.pathname);
}

function send(message: unknown): void {
  try {
    // Orphaned scripts (extension updated/reloaded) lose chrome.runtime: ignore silently.
    if (!chrome.runtime?.id) return;
    const p = chrome.runtime.sendMessage(message) as Promise<unknown> | undefined;
    p?.catch?.(() => {});
  } catch {
    /* context invalidated */
  }
}

function openLesson(): void {
  const warn = (): void => console.warn('RansomLeak: could not open the lesson');
  try {
    if (!chrome.runtime?.id) return;
    const p = chrome.runtime.sendMessage({ type: 'open-lesson', kind: 'consent' }) as Promise<unknown> | undefined;
    p?.catch?.(warn);
  } catch {
    warn();
  }
}

/** Asks the background for the OAuth request captured from this tab's authorize URLs (null if none). */
async function storedRequest(provider: Provider): Promise<OAuthRequest | null> {
  try {
    if (!chrome.runtime?.id) return null;
    const r = (await chrome.runtime.sendMessage({ type: 'consent-request' })) as OAuthRequest | null | undefined;
    if (!r || r.provider !== provider || !Array.isArray(r.scopes)) return null;
    const scopes = r.scopes.filter((x): x is string => typeof x === 'string');
    return { provider, clientId: typeof r.clientId === 'string' ? r.clientId : null, scopes, at: Number(r.at) || 0 };
  } catch {
    return null;
  }
}

async function handle(info: ConsentInfo): Promise<void> {
  const policy = await readPolicy();
  const mode = consentMode(policy);
  if (mode === 'off') return;
  const risky = isRisky(info, policy.riskyScopes ?? DEFAULT_RISKY_SCOPES, policy.approvedOAuthAppIds ?? []);
  send({ type: 'consent', info, risky });
  if (risky && (mode === 'warn' || mode === 'block')) {
    const locale = pickLocale(await readLocale(), navigator.language);
    showOverlay(document, info, mode, { locale, onRequest: send, onContinue: () => send({ type: 'consent-action', action: 'continue', info }),
      onLearn: openLesson });
  }
}

function main(): void {
  const provider = providerForHost(location.hostname);
  if (!provider) return;
  let handledHref: string | null = null;
  let observer: MutationObserver | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last = 0;
  let budget: ReturnType<typeof setTimeout> | undefined;
  let missReported = false;
  let armedHref = location.href;
  let stored: OAuthRequest | null = null;

  const stop = (): void => {
    observer?.disconnect();
    observer = null;
    clearTimeout(timer);
    timer = undefined;
    clearTimeout(budget);
  };
  const attempt = (): void => {
    const href = location.href;
    if (handledHref === href) return;
    const info = parseConsent(document, provider, new URL(href), stored);
    if (!info) return;
    handledHref = href; // at most once per document per URL
    stop();
    void handle(info);
  };
  const start = (): void => {
    stop();
    armedHref = location.href;
    const armed = armedHref;
    stored = null;
    void storedRequest(provider).then((r) => {
      if (armedHref !== armed || !r) return;
      stored = r;
      if (handledHref !== armed) attempt();
    });
    attempt();
    if (handledHref === location.href) return;
    // Throttle: leading call plus a trailing call, so churn cannot starve parsing.
    observer = new MutationObserver(() => {
      const now = Date.now();
      if (now - last >= PARSE_THROTTLE_MS) {
        last = now;
        attempt();
      } else if (!timer) {
        timer = setTimeout(() => {
          timer = undefined;
          last = Date.now();
          attempt();
        }, PARSE_THROTTLE_MS - (now - last));
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    budget = setTimeout(() => {
      stop();
      // Fail closed with telemetry: markup we could not parse (spec section 6.3 "parser miss").
      if (handledHref !== location.href && !missReported && looksLikeConsent(provider, new URL(location.href), stored)) {
        missReported = true;
        send({ type: 'consent-miss', provider });
      }
    }, BUDGET_MS);
  };

  start();
  // URL changes without a reload (SPA): re-arm once per new URL. Isolated-world scripts cannot hook
  // pushState, so a cheap href poll (only while visible) catches the rest.
  window.addEventListener('popstate', start);
  window.addEventListener('hashchange', start);
  setInterval(() => {
    if (document.visibilityState === 'visible' && location.href !== armedHref) start();
  }, URL_POLL_MS);
}

main();
