// Top-frame navigation verdicts (spec §6.4) and the warning page's actions.
import { DEFAULT_BRAND_OWNERS } from '../detect/brands.ts';
import { buildLookalikeIndex, checkLookalikeIndexed, type LookalikeIndex } from '../detect/lookalike.ts';
import { isNewDomain } from '../detect/nrd.ts';
import { parseHost, sharedSuffixSet, under } from '../lib/domain.ts';
import { appLinks, safeTenantOrigin, trainingUrl } from '../lib/origin.ts';
import { countAiVisit } from './ai-usage.ts';
import { postJson } from './api.ts';
import { captureOAuthRequest, oauthRequestKey } from './oauth-request.ts';
import { activationDone, claimActivation, forgetPrerenders, prerendersOf, rememberPrerender } from './prerender.ts';
import { apiBaseFor } from './config.ts';
import { enqueue, enqueueAll, flush } from './events.ts';
import { lessonKindFor } from '../lesson/content.ts';
import { genuineDomain } from '../lesson/quiz.ts';
import { recordLesson } from './lesson.ts';
import { loadFeed } from './policy.ts';
import {
  actionFor, chromeLocalStore, claimOnce, pruneOnce, getAuth, getAuthAndPolicy, getLocal, getPolicy, getSession, locked, modeOf, setLocal, setSession,
  THROTTLE_MS, type Mode, type Policy, type Signal,
} from './store.ts';

export const WARNING_PATH = 'src/warning/warning.html';

/** `watch` = the tenant's brand-watch look-alikes (policy.knownBad). */
type Kind = 'tenant' | 'brand' | 'risky' | 'known' | 'watch';
interface Pending {
  url: string;
  domain: string;
  /** Allow / throttle key: the host for `known`, the matched entry for `watch`, else the wire domain. */
  key?: string;
  kind: Kind;
  mode: 'warn' | 'block';
  highlight: [number, number];
  signal: Signal;
  /** The look-alike hit's matched brand key / protected domain, or the brand-watch entry. */
  matched?: string;
}

const RANK: Record<Mode, number> = { off: 0, log: 1, warn: 2, block: 3 };

async function confirmAge(domain: string): Promise<number | null> {
  try {
    const res = await postJson('/api/browser-ext/domain-age', { domain });
    if (!res.ok) return null;
    const { ageDays } = (await res.json()) as { ageDays?: unknown };
    return typeof ageDays === 'number' && Number.isFinite(ageDays) ? ageDays : null;
  } catch {
    return null; // offline or paused: unknown age
  }
}


async function bump(key: 'nrdBloomHitsUnconfirmed'): Promise<void> {
  await locked(async () => setLocal({ [key]: ((await getLocal<number>(key)) ?? 0) + 1 }));
}

/** Claims the 24 h warning slot for a domain; false when already warned within 24 h. Prunes expired slots. */
const claimThrottle = (domain: string): Promise<boolean> => claimOnce('throttle', domain, THROTTLE_MS, true);

/** Drops expired (and future-dated) throttle slots; same rule as claimOnce. */
export async function pruneThrottle(): Promise<void> {
  await pruneOnce('throttle', THROTTLE_MS);
}

/** Policy-derived lookup structures, rebuilt only when the policy version changes. */
interface PolicyIndex {
  sharedSet: ReadonlySet<string>;
  allowLower: string[];
  knownBadLower: string[];
  lookalike: LookalikeIndex;
}
let indexMemo: { version: string; index: PolicyIndex } | null = null;
try {
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area === 'local' && 'policy' in changes) indexMemo = null;
  });
} catch {
  /* no onChanged (tests): the version key alone guards the memo */
}

function buildIndex(policy: Policy): PolicyIndex {
  const extraShared = policy.sharedHosting ?? [];
  const allowDomains = policy.allowDomains ?? [];
  return {
    sharedSet: sharedSuffixSet(extraShared),
    allowLower: allowDomains.map((a) => a.toLowerCase()),
    knownBadLower: (policy.knownBad ?? []).filter((k) => typeof k === 'string').map((k) => k.toLowerCase()),
    lookalike: buildLookalikeIndex(
      { domains: policy.protected?.domains ?? [], brands: policy.protected?.brands ?? [] },
      allowDomains,
      policy.brandOwners ?? DEFAULT_BRAND_OWNERS,
      { extraShared, singleTenantOwners: policy.singleTenantOwners ?? [], strictBrands: policy.strictBrands ?? [] },
    ),
  };
}

/** Memoised per policy version; a policy without a version is indexed fresh every time. */
function policyIndex(policy: Policy): PolicyIndex {
  const version = policy.version;
  if (typeof version !== 'string' || !version) return buildIndex(policy);
  if (indexMemo?.version !== version) indexMemo = { version, index: buildIndex(policy) };
  return indexMemo.index;
}

/** Last URL written as each tab's "last safe" page in this worker lifetime (skips identical rewrites). */
const lastSafeWritten = new Map<number, string>();

const DEDUPE_MS = 5_000;
type Nav = { tabId: number; frameId: number; url: string; documentLifecycle?: string; documentId?: string; frameType?: string };

/** Block mode reacts before the page loads, so a blocked page's scripts never run. */
export const onBeforeNavigate = (d: Nav): Promise<void> => evaluate(d, 'before');
/** Backstop for block, and the trigger for warn and log. */
export const onCommitted = (d: Nav): Promise<void> => evaluate(d, 'committed');

async function alreadyHandled(d: Nav): Promise<boolean> {
  const h = await getSession<{ url: string; at: number }>(`handled:${d.tabId}`);
  return !!h && h.url === d.url && Date.now() - h.at < DEDUPE_MS && Date.now() >= h.at;
}

async function evaluate(d: Nav, phase: 'before' | 'committed'): Promise<void> {
  // frameId 0 is the outermost frame of the tab's ACTIVE page; a prerendered page's outermost frame has
  // another id, so `frameType` identifies it.
  if (d.frameId !== 0 && d.frameType !== 'outermost_frame') return;
  // Prerendered/speculative documents are not shown to the user: acting would redirect the tab the
  // user is actually on. A committed prerender is remembered and judged when it becomes active
  // (prerender.ts): either by the activation's own navigation events or by the tabs.onUpdated fallback.
  if (d.documentLifecycle === 'prerender') {
    if (phase === 'committed') await rememberPrerender(d.tabId, d.documentId, d.url);
    return;
  }
  if (d.documentLifecycle !== undefined && d.documentLifecycle !== 'active') return;
  if (d.frameId !== 0 && !d.documentId) return;
  // An activated prerender already judged by the fallback must not be judged twice.
  if (d.documentId) {
    const claim = phase === 'committed' ? await claimActivation(d.tabId, d.documentId) : (await activationDone(d.tabId, d.documentId)) ? 'dup' : 'none';
    if (claim === 'dup') return;
  }
  return judge(d, phase);
}

/** Judges a top-frame document the user is looking at. Exported for the prerender fallback. */
export async function judge(d: Nav, phase: 'before' | 'committed'): Promise<void> {
  await captureOAuthRequest(d.tabId, d.url).catch(() => {});
  // Only a committed, rule-free page becomes the tab's "last safe" URL.
  const rememberSafe = async (tabId: number, rawUrl: string): Promise<void> => {
    const url = rawUrl.split('#')[0]!; // never keep fragments (e.g. a bind code) in storage
    if (phase !== 'committed' || lastSafeWritten.get(tabId) === url) return;
    await setSession({ [`lastSafe:${tabId}`]: url });
    lastSafeWritten.set(tabId, url);
  };
  let u: URL;
  try {
    u = new URL(d.url);
  } catch {
    return;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return; // also skips our own chrome-extension:// pages
  const { auth, policy } = await getAuthAndPolicy();
  // AI tool usage: a daily count per tool, host-only, for bound extensions (independent of the detectors).
  if (phase === 'committed' && auth) await countAiVisit(d.tabId, u.hostname, policy).catch(() => null);
  if ((auth?.tenantOrigin && u.origin === auth.tenantOrigin) || apiBaseFor(u.origin)) return rememberSafe(d.tabId, d.url);
  const lmode = modeOf(policy.detectors?.lookalike);
  const nmode = modeOf(policy.detectors?.nrd);
  const kmode = modeOf(policy.detectors?.knownBad);
  // Only block acts before the page loads; warn/log wait for commit. No detection work otherwise.
  if (phase === 'before' && lmode !== 'block' && nmode !== 'block' && kmode !== 'block') return;
  const c = await classify(d.url, policy);
  if (!c) return rememberSafe(d.tabId, d.url);
  if (!c.verdict) {
    if (c.bloomHit && phase === 'committed') await bump('nrdBloomHitsUnconfirmed'); // once per navigation
    return rememberSafe(d.tabId, d.url);
  }
  const { h, domain, kind, key, signals, mode, matched } = c.verdict;
  // Lets the download check attribute a script-built (blob:/data:) download to the flagged page in view.
  if (phase === 'committed') await setSession({ recentFlagged: { domain, at: Date.now() } }); // = RECENT_FLAGGED_KEY

  // A "Continue anyway" allow is honoured only while the domain's mode is still 'warn'.
  // From here on the URL tripped a rule: it is never recorded as a safe page.
  const allow = (await getSession<Record<string, Mode>>('allow')) ?? {};
  if (mode === 'warn' && allow[key] === 'warn') return;
  if (phase === 'before' && mode !== 'block') return; // warn/log are handled on commit
  // One verdict per navigation: onBeforeNavigate marks it, and the matching onCommitted (if the
  // redirect lost the race) consumes the mark instead of acting twice. Any new navigation acts again.
  if (phase === 'before') await setSession({ [`handled:${d.tabId}`]: { url: d.url, at: Date.now() } });
  else if (await alreadyHandled(d)) {
    await chrome.storage.session.remove(`handled:${d.tabId}`);
    return;
  }

  const fresh = await claimThrottle(key);
  if (fresh) {
    await enqueueAll(signals.map((s) => ({ signal: s.signal, domain, action: actionFor(mode), value: s.value })));
    void flush();
  }
  // Block mode always blocks; warn mode shows at most one warning per domain per 24 h.
  if (mode !== 'block' && (mode !== 'warn' || !fresh)) return;

  const start = h.sharedHost ? domain.length - h.registrable.length : 0;
  const pending: Pending = {
    url: d.url, domain, key, kind, mode, highlight: [start, start + h.label.length], signal: signals[0]!.signal,
    ...(matched ? { matched } : {}),
  };
  await setSession({ [`pending:${d.tabId}`]: pending });
  const page = new URL(chrome.runtime.getURL(WARNING_PATH));
  page.searchParams.set('d', domain);
  page.searchParams.set('k', kind);
  await chrome.tabs.update(d.tabId, { url: page.href });
}

export interface Verdict {
  h: NonNullable<ReturnType<typeof parseHost>>;
  /** Wire domain: never a path, query or title. */
  domain: string;
  kind: Kind;
  /** Allow / throttle key. */
  key: string;
  signals: { signal: Signal; value?: string; mode: Mode }[];
  /** The strictest mode among the fired signals. */
  mode: Mode;
  /** Look-alike hit's matched brand key / protected domain, or the brand-watch entry. */
  matched?: string;
}

/**
 * The one site classifier (navigation, password-entry and download checks share it): look-alike,
 * reported (known-bad feed), brand watch, and newly-registered-and-look-alike, under the policy's
 * detector modes and exemptions. null = not judged (no host, tenant/API origin, allow-listed).
 */
export async function classify(url: string, policy: Policy, tenantOrigin?: string): Promise<{ verdict: Verdict | null; bloomHit: boolean } | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if ((tenantOrigin && u.origin === tenantOrigin) || apiBaseFor(u.origin)) return null;
  const lmode = modeOf(policy.detectors?.lookalike);
  const nmode = modeOf(policy.detectors?.nrd);
  const kmode = modeOf(policy.detectors?.knownBad);
  const idx = policyIndex(policy);
  const extraShared = policy.sharedHosting ?? [];
  const h = parseHost(url, extraShared, idx.sharedSet);
  if (!h) return null;
  const domain = h.sharedHost ? h.host : h.registrable; // wire domain: never a path, query or title

  if (idx.allowLower.some((a) => under(h.host, a))) return null;
  // Reported dangerous sites (public phishing / malware feeds): the exact host, or the host without
  // `www.`. Never exempted by popularity or brand-owner rules (only the tenant's allowDomains, above);
  // the other detectors still run and their signals are emitted too. No set = no match.
  const reported = kmode !== 'off' && (await isReported(h.host));
  // Tenant brand watch (policy.knownBad: registrables or shared-hosting hosts, subtree match). Same detector
  // and exemptions as the reported-sites feed: only allowDomains (above) overrides it.
  const watched = kmode === 'off' ? undefined : idx.knownBadLower.find((k) => under(h.host, k));
  // Popularity exemption: a Tranco top-100k registrable is not a fresh lookalike. Only for the apex
  // or www. of a non-shared host (other subdomains, and a shared platform's customer subdomains, are
  // judged normally); knownBad still warns and OAuth consent checks are separate. No set = no exemption.
  const apex = h.host === h.registrable || h.host === `www.${h.registrable}`;
  const popularSet = lmode !== 'off' && !h.sharedHost && apex ? await loadFeed('popular') : null;
  const bloom = nmode === 'off' && !popularSet ? null : await loadFeed('nrd');
  const bloomHit = nmode !== 'off' && !!bloom && bloom.has(h.registrable);
  // Defense in depth: a registrable in the NRD bloom is never popular.
  const popular = !!popularSet && !(bloom && bloom.has(h.registrable)) && (await popularSet.has(h.registrable));
  let hit = lmode === 'off' ? null : checkLookalikeIndexed(url, idx.lookalike);
  // Popularity may suppress only brand-embedding and TLD-swap verdicts, never homoglyph or edit-distance ones.
  if (hit && popular && (hit.via === 'embedding' || hit.via === 'tld')) hit = null;
  // Privacy (spec section 11): a domain leaves the device for age confirmation only when the bloom
  // hits AND there is a lookalike match (a known-bad match alone is already decided locally).
  // A bare bloom hit is counted locally. Shared-hosting subdomains are not registrations and never
  // match the backend's eTLD+1 keys.
  const nrd = !h.sharedHost && bloomHit && !!hit ? await isNewDomain(h.registrable, bloom, confirmAge, { storage: chromeLocalStore }) : false;

  const risky = nrd && !!hit;
  if (!hit && !risky && !reported && !watched) return { verdict: null, bloomHit };
  // Every fired signal is emitted; the strictest mode wins; the warning shows `known`, then `watch` first.
  const kind: Kind = reported ? 'known' : watched ? 'watch' : hit ? hit.kind : 'risky';
  const signals: { signal: Signal; value?: string; mode: Mode }[] = [];
  if (reported) signals.push({ signal: 'browser.risky_domain_visit', value: 'known_bad', mode: kmode });
  if (watched) signals.push({ signal: 'browser.risky_domain_visit', value: 'brand_watch', mode: kmode });
  if (hit) signals.push({ signal: 'browser.lookalike_visit', value: hit.kind === 'brand' ? 'brand' : undefined, mode: lmode });
  if (risky) signals.push({ signal: 'browser.risky_domain_visit', mode: nmode === 'off' ? 'warn' : nmode });

  const mode = signals.reduce<Mode>((m, s) => (RANK[s.mode] > RANK[m] ? s.mode : m), 'off');
  // A reported host is judged per host: continuing on one must not silence its sibling hosts.
  const key = kind === 'known' ? h.host : kind === 'watch' ? watched! : domain;
  const matched = kind === 'watch' ? watched : hit?.matched;
  return { verdict: { h, domain, kind, key, signals, mode, ...(matched ? { matched } : {}) }, bloomHit };
}

/** True when the host (or the host without `www.`) is in the known-bad feed. */
async function isReported(host: string): Promise<boolean> {
  const set = await loadFeed('knownbad');
  if (!set) return false;
  if (await set.has(host)) return true;
  return host.startsWith('www.') && (await set.has(host.slice(4)));
}

function fromWarningPage(sender: chrome.runtime.MessageSender): number | null {
  if (sender.id !== chrome.runtime.id || !sender.url || typeof sender.tab?.id !== 'number') return null;
  const page = chrome.runtime.getURL(WARNING_PATH);
  if (sender.url !== page && !sender.url.startsWith(page + '?')) return null;
  return sender.tab.id;
}

function learnUrl(
  origin: string | undefined,
  entry: { exerciseId?: unknown; path?: unknown } | undefined,
  links: unknown,
): string | null {
  return trainingUrl(origin, entry?.path, entry?.exerciseId, appLinks(links).training);
}

/** Handles 'warning-info' / 'warning-action'. Returns undefined to ignore the message. */
export async function handleWarning(msg: { type: string; action?: unknown }, sender: chrome.runtime.MessageSender): Promise<unknown> {
  const tabId = fromWarningPage(sender);
  if (tabId === null) return undefined;
  const key = `pending:${tabId}`;
  const p = await getSession<Pending>(key);
  if (!p) return { error: 'no-warning' };
  const auth = await getAuth();
  const policy = await getPolicy();
  const learn = learnUrl(auth?.tenantOrigin, policy.jit?.[p.signal], policy.links);

  if (msg.type === 'warning-info') {
    const lessonKind = lessonKindFor(p.kind);
    const owners = policy.brandOwners ?? DEFAULT_BRAND_OWNERS;
    const lookalike = lessonKind === 'lookalike' && !!p.matched;
    const genuine = lookalike ? genuineDomain(p.matched!, owners, policy.protected?.domains) : null;
    const deny = lookalike ? [...(owners[p.matched!.toLowerCase()] ?? [])] : [];
    return {
      domain: p.domain, kind: p.kind, mode: p.mode, highlight: p.highlight, learn: !!learn, locale: auth?.locale ?? 'en',
      lesson: { kind: lessonKind, genuine, deny, course: !!learn },
    };
  }
  switch (msg.action) {
    case 'back': {
      const safe = await getSession<string>(`lastSafe:${tabId}`);
      await chrome.tabs.update(tabId, { url: safe ?? 'about:blank' });
      return { ok: true };
    }
    case 'continue': {
      if (p.mode === 'block') return { ok: false };
      await enqueue('browser.warning_overridden', p.domain, 'proceeded');
      void flush();
      await locked(async () => {
        const allow = (await getSession<Record<string, Mode>>('allow')) ?? {};
        allow[p.key ?? p.domain] = 'warn';
        await setSession({ allow });
      });
      await chrome.storage.session.remove(key);
      await chrome.tabs.update(tabId, { url: p.url });
      return { ok: true };
    }
    case 'request': {
      if (p.mode !== 'block') return { ok: false };
      return { ok: await blockRequest('domain', p.domain) };
    }
    case 'learn': {
      if (!learn) return { ok: false };
      await chrome.tabs.create({ url: learn });
      return { ok: true };
    }
    case 'lesson-done':
      return { ok: await recordLesson(lessonKindFor(p.kind), p.domain) };
    default:
      return { ok: false };
  }
}

export async function blockRequest(kind: 'domain' | 'oauth_app', target: string, label?: string): Promise<boolean> {
  try {
    const res = await postJson('/api/browser-ext/block-requests', label ? { kind, target, label } : { kind, target });
    return res.ok;
  } catch {
    return false;
  }
}

export async function forgetTab(tabId: number): Promise<void> {
  lastSafeWritten.delete(tabId);
  await chrome.storage.session.remove([`pending:${tabId}`, `lastSafe:${tabId}`, `handled:${tabId}`, oauthRequestKey(tabId)]);
  await forgetPrerenders(tabId);
}

/**
 * Fallback for a prerender activation that arrives without navigation events: on any update of a tab
 * with remembered prerenders, judge the one whose document Chrome now reports as active. Needs only
 * the webNavigation permission (getFrame), not `tabs` (the update itself carries no URL).
 */
export async function onTabUpdated(tabId: number): Promise<void> {
  const list = await prerendersOf(tabId);
  for (const e of list) {
    let frame: chrome.webNavigation.GetFrameResultDetails | null = null;
    try {
      frame = await chrome.webNavigation.getFrame({ tabId, documentId: e.doc } as chrome.webNavigation.GetFrameDetails);
    } catch {
      frame = null; // discarded prerender
    }
    if (!frame || frame.documentLifecycle !== 'active' || frame.parentFrameId !== -1) continue;
    if ((await claimActivation(tabId, e.doc)) !== 'fresh') continue;
    await judge({ tabId, frameId: 0, url: frame.url || e.url, documentLifecycle: 'active', documentId: e.doc }, 'committed');
  }
}
