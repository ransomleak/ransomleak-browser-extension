// OAuth authorize/consent URL parsing, shared by the background (capture) and the consent content script.
import { providerForHost, type Provider } from './providers.ts';

export type OAuthRequest = { provider: Provider; clientId: string | null; scopes: string[]; at: number };

/** Top-frame paths whose query can carry the OAuth request (authorize, account chooser, consent). */
const REQUEST_PATHS: Record<Provider, RegExp> = {
  google: /^\/(?:o\/oauth2\/|signin\/oauth\/|v3\/signin\/)/i,
  microsoft: /^\/(?:[^/]+\/)?oauth2\/(?:v2\.0\/)?authorize\/?$/i,
  slack: /^\/oauth(?:\/(?:v2\/)?authorize)?\/?$/i,
};

/** Authorize/consent pages per provider; anything else (account chooser, sign-in) is not a consent step. */
export const CONSENT_PATHS: Record<Provider, RegExp> = {
  microsoft: /^\/[^/]+\/oauth2\/(?:v2\.0\/)?authorize\/?$/i,
  google: /^\/(?:o\/oauth2\/(?:v2\/)?auth|signin\/oauth\/(?:v\d+\/)?consent(?:summary)?|signin\/oauth\/v2\/consentsummary)\/?$/i,
  // slack.com/oauth/v2/authorize and workspace hosts (<team>.slack.com/oauth?client_id=...&scope=...)
  slack: /^\/oauth(?:\/(?:v2\/)?authorize)?\/?$/i,
};

/** Pages whose path alone marks them as a consent screen (Google's sign-in/chooser live elsewhere). */
export const DEDICATED_CONSENT: Record<Provider, RegExp> = {
  microsoft: /$^/, // sign-in and consent share the authorize URL
  google: /^\/signin\/oauth\/(?:v\d+\/)?consent/i,
  slack: CONSENT_PATHS.slack,
};

export function splitScopes(raw: string | null, sep: RegExp): string[] {
  if (!raw) return [];
  return Array.from(new Set(raw.split(sep).map((s) => s.trim()).filter(Boolean)));
}

/** Scopes carried by a provider URL query (Slack user scopes get a `user:` prefix). */
export function scopesFromUrl(provider: Provider, url: URL): string[] {
  const q = url.searchParams;
  if (provider === 'google') return splitScopes(q.get('scope'), /\s+/);
  if (provider === 'microsoft') return splitScopes([q.get('scope'), q.get('resource')].filter(Boolean).join(' '), /[\s,]+/);
  return [
    ...splitScopes(q.get('scope'), /[,\s]+/),
    ...splitScopes(q.get('user_scope'), /[,\s]+/).map((s) => `user:${s}`),
  ];
}

/** Extracts provider, client_id and scopes from a known authorize/consent URL; null for anything else. */
export function requestFromUrl(raw: string): Omit<OAuthRequest, 'at'> | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const provider = providerForHost(u.hostname);
  if (!provider || !REQUEST_PATHS[provider].test(u.pathname)) return null;
  const clientId = u.searchParams.get('client_id')?.slice(0, 200) || null;
  const scopes = scopesFromUrl(provider, u).slice(0, 100).map((s) => s.slice(0, 300));
  if (!clientId && !scopes.length) return null;
  return { provider, clientId, scopes };
}
