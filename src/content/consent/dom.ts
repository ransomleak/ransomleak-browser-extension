import { CONSENT_PATHS, DEDICATED_CONSENT, scopesFromUrl, type OAuthRequest } from '../../lib/oauth-request.ts';
import type { ConsentInfo, Provider } from './types.ts';

// Text extraction that never reads form controls: it walks text nodes and skips
// input-like subtrees entirely (and never touches `.value`).
const SKIP = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'SCRIPT', 'STYLE', 'NOSCRIPT']);

const editable = (el: Element): boolean => {
  const ce = el.getAttribute('contenteditable');
  return (ce !== null && ce !== 'false') || el.getAttribute('role') === 'textbox';
};

export function safeText(node: Node): string {
  for (let a: Element | null = node.nodeType === 1 ? (node as Element) : node.parentElement; a; a = a.parentElement) {
    if (editable(a) || SKIP.has(a.tagName.toUpperCase())) return '';
  }
  const parts: string[] = [];
  const walk = (n: Node): void => {
    if (n.nodeType === 3) { parts.push(n.nodeValue ?? ''); return; }
    if (n.nodeType !== 1) return;
    const el = n as Element;
    if (SKIP.has(el.tagName.toUpperCase())) return;
    if (editable(el)) return;
    el.childNodes.forEach(walk);
  };
  walk(node);
  return norm(parts.join(' '));
}

export const norm = (s: string): string => s.replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();

export function headings(doc: Document): string[] {
  return Array.from(doc.querySelectorAll('h1,h2,h3,[role="heading"]')).map(safeText).filter(Boolean);
}

/** The page's main heading: the first h1, else the first level-1 ARIA heading, else the first heading. */
export function mainHeading(doc: Document): Element | null {
  return doc.querySelector('h1') ?? doc.querySelector('[role="heading"][aria-level="1"]') ?? doc.querySelector('h2,h3,[role="heading"]');
}

/** The consent panel: the main heading's enclosing main/form region, else the page's main region. */
export function consentContainer(doc: Document): Element | null {
  return mainHeading(doc)?.closest('main,[role="main"],form') ?? doc.querySelector('main,[role="main"]');
}

/** <li> text inside the consent container only (never language pickers or footers); none without a container. */
export function listItems(doc: Document): string[] {
  const c = consentContainer(doc);
  return c ? Array.from(c.querySelectorAll('li')).map(safeText).filter(Boolean) : [];
}

/**
 * Language-independent app name: the first link or emphasized element inside the main heading
 * (Google renders "<App>" as a link/span inside a localized sentence). Never the whole heading.
 */
export function headingEmphasis(doc: Document): string | null {
  const h = mainHeading(doc);
  if (!h) return null;
  const whole = safeText(h);
  for (const e of Array.from(h.querySelectorAll('a,strong,b,em,span'))) {
    const t = safeText(e);
    if (t && t.length < whole.length) return t;
  }
  // Google's localized heading is plain text ("<App> needs access…" in any language), while the same
  // name appears as a link elsewhere on the page: take the longest link/emphasis text the heading contains.
  const scope = consentContainer(doc) ?? doc.body;
  if (!scope) return null;
  let best: string | null = null;
  for (const e of Array.from(scope.querySelectorAll('a,button,[role="link"],strong,b,em'))) {
    if (h.contains(e)) continue;
    const t = safeText(e);
    if (t && t.length >= 3 && t.length <= 80 && t.length < whole.length && whole.includes(t) && (!best || t.length > best.length)) best = t;
  }
  return best;
}

export { splitScopes } from '../../lib/oauth-request.ts';

/** Strip control and bidi characters, cap at 80 chars. Returns null when nothing is left. */
export function cleanName(s: string): string | null {
  const out = norm(s.replace(/[\u0000-\u001F\u202A-\u202E\u2066-\u2069]/g, ' ')).slice(0, 80).trim();
  return out || null;
}

/**
 * Positive-only verification: true only if a non-heading, non-list element has own text or
 * aria-label exactly equal to a known badge string and does not contain the app name.
 */
export function hasBadge(doc: Document, appName: string, known: string[]): boolean {
  const name = appName.toLowerCase();
  const ok = (v: string): boolean => {
    const l = norm(v).toLowerCase();
    return known.includes(l) && !l.includes(name) && !name.includes(l);
  };
  for (const e of Array.from(doc.querySelectorAll('span,p,div,[aria-label]'))) {
    if (e.closest('li,ul,ol,h1,h2,h3,[role="heading"]')) continue;
    if (ok(e.getAttribute('aria-label') ?? '') || ok(safeText(e))) return true;
  }
  return false;
}

export const UNVERIFIED = /\bunverified\b|not verified|hasn't verified|has not verified/i;

/**
 * Shared tail of the provider parsers. Scopes are the union of the page URL, the request captured by
 * the background from earlier authorize URLs in this tab (only on a consent path, only for the same
 * client) and <li> text inside the consent container. appId is the page's own client_id only. A missing app name falls back to the client id
 * on rendered pages (a main heading exists) that are consent screens by path. No scopes -> null (fail closed).
 */
export function finish(
  doc: Document,
  url: URL,
  o: { provider: Provider; appName: string | null; badges: string[]; stored?: OAuthRequest | null },
): ConsentInfo | null {
  const { provider } = o;
  const pageClient = url.searchParams.get('client_id');
  const stored = o.stored && o.stored.provider === provider && (!pageClient || pageClient === o.stored.clientId)
    && CONSENT_PATHS[provider].test(url.pathname) ? o.stored : null;
  const displayAppId = pageClient ?? stored?.clientId ?? null;
  const appName = o.appName ?? (displayAppId && mainHeading(doc) && DEDICATED_CONSENT[provider].test(url.pathname) ? cleanName(displayAppId) : null);
  if (!appName) return null;
  // Union of every source, failing toward risky: the page may show more than an earlier URL asked for.
  const urlScopes = scopesFromUrl(provider, url);
  const storedScopes = stored?.scopes ?? [];
  const domScopes = listItems(doc);
  const scopes = Array.from(new Set([...urlScopes, ...storedScopes, ...domScopes]));
  if (!scopes.length) return null; // before the badge walk: no scopes means nothing to report
  const scopeSource: ConsentInfo['scopeSource'] = urlScopes.length || storedScopes.length ? 'url' : 'dom';
  const unverifiedScopes = !urlScopes.length && !!storedScopes.length && !!domScopes.length;
  const verified = hasBadge(doc, appName, o.badges);
  const appId = pageClient;
  return { provider, appName, appId, displayAppId, verified, scopes, scopeSource, ...(unverifiedScopes ? { unverifiedScopes } : {}) };
}
