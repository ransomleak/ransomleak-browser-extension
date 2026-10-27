import { parseHost, sharedSuffixSet, skeleton, under } from '../lib/domain.ts';
import { DEFAULT_BRAND_OWNERS, SINGLE_TENANT_OWNERS, STRICT_BRANDS } from './brands.ts';

export type Protected = { domains: string[]; brands: string[] };
export type LookalikeVia = 'skeleton' | 'distance' | 'embedding' | 'tld';
export type LookalikeHit = { kind: 'tenant' | 'brand'; matched: string; registrable: string; via: LookalikeVia };

/** Two-letter TLDs marketed for generic use; a brand label there is not a country site. */
const GENERIC_CCTLDS: ReadonlySet<string> = new Set([
  'io', 'co', 'me', 'ai', 'cc', 'tv', 'ws', 'ly', 'gg', 'to', 'sh', 'so', 'la', 'fm', 'vc', 'ac', 'pw', 'tk',
  'ml', 'ga', 'cf', 'gq', 'nu', 'st', 'is', 'im', 'gl', 'bz', 'cx', 'su', 'ag', 'sc', 'mn', 'ps', 're', 'lc',
]);

/** Damerau-Levenshtein (optimal string alignment) distance. */
function dl(a: string, b: string): number {
  const m = a.length, n = b.length;
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array<number>(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + c);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
      }
    }
  }
  return d[m]![n]!;
}

const maxDist = (len: number): number => (len < 5 ? 0 : len <= 8 ? 1 : 2);

/** strict: exact skeleton / whole-token matches only (no edit distance, no substring embedding). */
interface Target { kind: 'tenant' | 'brand'; matched: string; sk: string; raw: string; strict: boolean }

/**
 * Leftmost labels too generic to stand for an organization (app.ransomleak.com, portal.acme-hr.com):
 * as a look-alike name they would match app.slack.com, app.asana.com and so on. The exact protected
 * host stays exempt and the registrable label (ransomleak, acme-hr) is used as the target instead.
 */
const GENERIC_SUBDOMAIN_LABELS = new Set([
  'app', 'apps', 'my', 'id', 'sso', 'auth', 'login', 'signin', 'portal', 'www', 'web', 'mail', 'email',
  'admin', 'secure', 'account', 'accounts', 'home', 'hr', 'it', 'intranet', 'dev', 'test', 'staging',
  'stage', 'demo', 'api', 'cdn', 'static', 'eu', 'us', 'learn', 'training', 'academy', 'lms',
]);
const MIN_SUBDOMAIN_LABEL = 4;

/** Policy-derived structures for checkLookalike; build once per policy and reuse across navigations. */
export interface LookalikeIndex {
  sharedSet: ReadonlySet<string>;
  singles: string[];
  allowLower: string[];
  domainsLower: string[];
  brands: string[];
  ownersLower: Map<string, string[]>;
  targets: Target[];
}

/** Policy extensions of the built-in lists (union, never a replacement). */
export interface LookalikeOpts { extraShared?: string[]; singleTenantOwners?: string[]; strictBrands?: string[] }

export function buildLookalikeIndex(
  p: Protected,
  allow: string[],
  brandOwners: Record<string, string[]> = DEFAULT_BRAND_OWNERS,
  opts: LookalikeOpts = {},
): LookalikeIndex {
  const sharedSet = sharedSuffixSet(opts.extraShared ?? []);
  const targets: Target[] = [];
  for (const d of p.domains) {
    const ph = parseHost('https://' + d, [], sharedSet);
    if (!ph) continue;
    // For a protected subdomain (acme.okta.com) the tenant identity is its leftmost label.
    // A generic leftmost label (app.ransomleak.com, portal.acme-hr.com) falls back to the registrable label;
    // a short distinctive one stays a target but only for skeleton equality (homoglyphs), like strict brands.
    const sub = ph.host !== ph.registrable ? ph.host.split('.')[0]! : null;
    const raw = sub && !GENERIC_SUBDOMAIN_LABELS.has(sub) ? sub : ph.label;
    const strict = !!sub && raw === sub && raw.length < MIN_SUBDOMAIN_LABEL;
    targets.push({ kind: 'tenant', matched: d, sk: skeleton(raw), raw, strict });
  }
  const strict = new Set([...STRICT_BRANDS, ...(opts.strictBrands ?? [])]);
  for (const b of p.brands) targets.push({ kind: 'brand', matched: b, sk: skeleton(b), raw: b, strict: strict.has(b) });
  return {
    sharedSet,
    singles: [...SINGLE_TENANT_OWNERS, ...(opts.singleTenantOwners ?? []).map((o) => o.toLowerCase())],
    allowLower: allow.map((a) => a.toLowerCase()),
    domainsLower: p.domains.map((d) => d.toLowerCase()),
    brands: [...p.brands],
    ownersLower: new Map(p.brands.map((b) => [b, (brandOwners[b] ?? []).map((o) => o.toLowerCase())])),
    targets,
  };
}

export function checkLookalike(
  url: string,
  p: Protected,
  allow: string[],
  brandOwners: Record<string, string[]> = DEFAULT_BRAND_OWNERS,
  opts: LookalikeOpts = {},
  index: LookalikeIndex = buildLookalikeIndex(p, allow, brandOwners, opts),
): LookalikeHit | null {
  return checkLookalikeIndexed(url, index);
}

/** Hot path: judges `url` against a prebuilt index only. */
export function checkLookalikeIndexed(url: string, index: LookalikeIndex): LookalikeHit | null {
  const { singles, targets } = index;
  const h = parseHost(url, [], index.sharedSet);
  if (!h) return null;
  const { host, registrable } = h;
  if (index.allowLower.some((a) => under(host, a))) return null;
  if (index.domainsLower.some((d) => under(host, d))) return null;
  // Owner exemption: exact owner or www.owner; deeper subdomains only for documented single-tenant
  // owners off shared hosting. Everything else is judged on its own label.
  for (const b of index.brands) {
    const owned = (index.ownersLower.get(b) ?? []).some(
      (d) => host === d || host === 'www.' + d || (!h.sharedHost && singles.includes(d) && under(host, d)),
    );
    if (owned) return null;
  }

  // A plain-ASCII exact brand label on another country-code TLD (google.de, google.co.uk) is
  // legitimate; gTLDs (microsoft.xyz) and shared hosting are not. Country codes sold as generic
  // TLDs (.io, .co, .me, .ai, ...) are not a country presence: paypal.io is judged, while the real
  // ones (paypal.me, metamask.io) are in the owner lists and returned above.
  const lastTld = h.tld.split('.').pop() ?? '';
  const ccTld = lastTld.length === 2 && !GENERIC_CCTLDS.has(lastTld);
  const exactBrand = (t: Target): boolean => t.kind === 'brand' && !h.sharedHost && ccTld && h.label === t.raw;
  const hit = (t: Target, via: LookalikeVia): LookalikeHit => ({ kind: t.kind, matched: t.matched, registrable, via });
  // Shared hosts often put a region/zone next to the suffix (acrne.eastus.cloudapp.azure.com),
  // so every label left of the shared suffix is a candidate; elsewhere only the registrable label.
  const suffix = registrable.slice(h.label.length + 1);
  const segments = host.slice(0, host.length - suffix.length - 1).split('.');
  const segSk = segments.map(skeleton);
  const candidates = h.sharedHost ? segSk : [skeleton(h.label)];

  // 1. Skeleton equality (homoglyphs, multi-char confusables, TLD swap).
  // Same plain label under a different TLD is 'tld'; any other skeleton equality (homoglyphs) is 'skeleton'.
  for (const t of targets) {
    if (!exactBrand(t) && candidates.includes(t.sk)) return hit(t, !h.sharedHost && h.label === t.raw ? 'tld' : 'skeleton');
  }

  // 2. Edit distance on the candidate labels.
  for (const t of targets) {
    if (exactBrand(t) || t.strict) continue;
    if (candidates.some((c) => dl(c, t.sk) <= maxDist(t.sk.length))) return hit(t, 'distance');
  }

  // 3. Embedding: tokens split on '-' and '.' across the host (public suffix excluded).
  // The shared platform / public suffix is excluded. Labels are decoded and skeletonised
  // before splitting, so punycode labels cannot hide the '-' separators.
  const tokens = segSk.flatMap((s) => s.split('-')).filter(Boolean);
  for (const t of targets) {
    if (exactBrand(t)) continue;
    // Strict brands still match as a whole token; a short tenant label (strict tenant) only by skeleton.
    if ((t.kind === 'brand' || !t.strict) && tokens.includes(t.sk)) return hit(t, 'embedding');
    if (t.kind === 'brand' && !t.strict && t.raw.length >= 6 && segSk.some((s) => s.length >= t.sk.length + 3 && s.includes(t.sk))) {
      return hit(t, 'embedding');
    }
  }
  return null;
}
