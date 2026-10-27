import { parse } from 'tldts';
import { toUnicode } from 'punycode/';
import { CONFUSABLES } from './confusables.ts';

/** Lowercase hostname: 1-253 chars, at least one dot, labels of [a-z0-9-] (punycode allowed). */
export function isHostname(d: unknown): d is string {
  if (typeof d !== 'string' || d.length < 1 || d.length > 253 || d !== d.toLowerCase()) return false;
  const labels = d.split('.');
  return labels.length >= 2 && labels.every((l) => l.length >= 1 && l.length <= 63 && /^[a-z0-9-]+$/.test(l));
}

/** host is d or a subdomain of d. */
export const under = (host: string, d: string): boolean => host === d || host.endsWith('.' + d);

export interface ParsedHost {
  host: string;
  registrable: string;
  /** Leftmost label of the registrable domain (for shared hosts: the shared subdomain's label). */
  label: string;
  tld: string;
  sharedHost: boolean;
}

/** Platforms where subdomains belong to different tenants; policy can extend this. */
export const SHARED_HOSTING: readonly string[] = [
  'wetransfer.com', // Pro accounts get customer subdomains (acme.wetransfer.com)
  'glitch.me',
  'weebly.com',
  'sites.google.com',
  'sharepoint.com',
  'okta.com',
  'oktapreview.com',
  'okta-emea.com',
  'googleusercontent.com',
  'ggpht.com',
  'googlesource.com',
  'my.salesforce.com',
  'force.com',
  'cloudapp.azure.com',
  'storage.googleapis.com',
  'firebasestorage.googleapis.com',
  'queue.core.windows.net',
  'table.core.windows.net',
  'dfs.core.windows.net',
  'database.windows.net',
  // Multi-tenant brand-owner domains (customer / workspace / seller subdomains), not in the PSL.
  'onmicrosoft.com',
  'zoom.us',
  'zoomgov.com',
  'webex.com',
  'slack.com',
  'salesforce.com',
  'salesforce-sites.com',
  'atlassian.net',
  'app.github.dev',
  'amazonaws.com',
  'amazoncognito.com',
  'dropboxusercontent.com',
  'cloudflareaccess.com',
  'canva.site',
  'alibaba.com',
  'etsy.com',
];

/** Lowercased, non-empty shared-hosting suffixes (built-in + policy extras), for repeated parseHost calls. */
export function sharedSuffixSet(extraShared: readonly string[] = []): ReadonlySet<string> {
  const out = new Set<string>();
  for (const raw of [...SHARED_HOSTING, ...extraShared]) {
    const e = raw.toLowerCase();
    if (e) out.add(e);
  }
  return out;
}

/** Longest entry of `set` that `host` ends with on a label boundary (`.entry`), or null. */
function longestSharedSuffix(host: string, set: ReadonlySet<string>): string | null {
  for (let i = host.indexOf('.'); i !== -1; i = host.indexOf('.', i + 1)) {
    const e = host.slice(i + 1);
    if (set.has(e)) return e; // leftmost dot = longest suffix
  }
  return null;
}

/** For a suffix produced by a wildcard PSL rule (`*.base`), the base; otherwise null. */
function wildcardBase(suffix: string): string | null {
  const dot = suffix.indexOf('.');
  if (dot === -1) return null;
  const base = suffix.slice(dot + 1);
  const probe = `x0probe.${base}`;
  return parse(probe, { allowPrivateDomains: true }).publicSuffix === probe ? base : null;
}

/** `sharedSet` (from sharedSuffixSet) replaces scanning SHARED_HOSTING + `extraShared` on each call. */
export function parseHost(url: string, extraShared: readonly string[] = [], sharedSet?: ReadonlySet<string>): ParsedHost | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const r = parse(u.hostname, { allowPrivateDomains: true });
  if (r.isIp || !r.hostname || r.hostname === 'localhost') return null;
  const host = r.hostname;
  // Manual shared-hosting list: entries need not be PSL suffixes (e.g. sites.google.com), and some
  // are wildcard PSL suffixes where tldts reports no domain (e.g. run.app).
  const shared = longestSharedSuffix(host, sharedSet ?? sharedSuffixSet(extraShared));
  if (shared !== null) {
    const above = host.slice(0, host.length - shared.length - 1).split('.').pop() ?? '';
    return { host, registrable: `${above}.${shared}`, label: above, tld: r.publicSuffix ?? shared, sharedHost: true };
  }
  // PSL private section = shared hosting. A wildcard private rule (e.g. `*.run.app`) makes the
  // customer label part of the suffix (tldts reports google-login.run.app as the suffix, no domain);
  // judge the label directly above the rule's base, as the manual list did.
  if (r.isPrivate && r.publicSuffix) {
    const base = wildcardBase(r.publicSuffix);
    if (base !== null) {
      const above = host.slice(0, host.length - base.length - 1).split('.').pop() ?? '';
      return { host, registrable: `${above}.${base}`, label: above, tld: r.publicSuffix, sharedHost: true };
    }
  }
  if (!r.domain || !r.publicSuffix || (!r.isIcann && !r.isPrivate)) return null;
  const registrable = r.domain;
  return {
    host,
    registrable,
    label: registrable.slice(0, registrable.length - r.publicSuffix.length - 1).split('.').pop() ?? '',
    tld: r.publicSuffix,
    sharedHost: r.isPrivate === true,
  };
}

// Only ASCII is lowercased up front: full Unicode lowercasing would turn e.g. Cyrillic capital
// M (maps to Latin M) into small m (maps to something else), bypassing the table.
const asciiLower = (str: string): string => str.replace(/[A-Z]/g, (c) => c.toLowerCase());

/**
 * UTS #39 skeleton of a host or label, after punycode decoding and lowercasing.
 * The 0/o and 1/l collapse (table maps 0->O, 1->l) is deliberate UTS #39 behaviour.
 */
export function skeleton(s: string): string {
  const lower = asciiLower(s);
  let decoded: string;
  try {
    decoded = asciiLower(toUnicode(lower));
  } catch {
    decoded = lower; // malformed punycode: fall back to the raw label
  }
  const map = (str: string): string => {
    let out = '';
    for (const ch of str) out += CONFUSABLES[ch.codePointAt(0)!] ?? ch;
    return out;
  };
  // Iterate to a fixpoint: a mapping can yield a capital that only maps further once lowercased.
  let cur = decoded.normalize('NFD');
  for (let i = 0; i < 8; i++) {
    const next = map(i === 0 ? cur : cur.toLowerCase()).normalize('NFD');
    if (i > 0 && next === cur) break;
    cur = next;
  }
  return cur;
}
