// Transparency popup ("What we know about you"). Keeps no state: Chrome destroys it on blur.
// Every server- or page-derived string goes in via textContent; the token never reaches this page
// (the background does the authenticated fetch).
import { stringsFor } from '../lib/i18n.ts';
import { el } from '../lib/dom.ts';
import { brandMark } from '../lib/brand.ts';
import { getLocal, type WireEvent } from '../background/store.ts';
import { appLinks, DEFAULT_APP_LINKS, isSafeAppPath, safeTenantOrigin, trainingUrl, UUID_RE, type AppLinks } from '../lib/origin.ts';
import { dueMs, formatDueDate, normalizeTodo, REMINDER_PERMISSIONS, todoUrl, type TodoItem } from '../lib/todo.ts';
import { AI_ORIGINS } from '../manifest.ts';

type Days = 7 | 30 | 90 | 'all';
const PERIODS: readonly { days: Days; key: 'pop_p7' | 'pop_p30' | 'pop_p90' | 'pop_pall' }[] = [
  { days: 7, key: 'pop_p7' },
  { days: 30, key: 'pop_p30' },
  { days: 90, key: 'pop_p90' },
  { days: 'all', key: 'pop_pall' },
];
const SOURCES = ['extension', 'chrome_enterprise', 'entra', 'defender', 'other'];
const ACTIONS = ['warned', 'blocked', 'proceeded', 'went_back', 'logged'];
const PUBLIC_DOCS = 'https://docs.ransomleak.com/browser-extension/what-we-collect/';

export interface PopupInfo {
  connected: boolean;
  tenantName: string | null;
  needsReauth: boolean;
  /** Signed out by the organization (device revoked / user disabled); absent from older workers. */
  disconnected?: 'revoked' | 'disabled' | null;
  tenantOrigin: string;
  locale: string;
  /** Extra-protection detector modes (policy); absent from older workers. */
  extra?: { downloads?: string; aiPaste?: string };
  /** Stored open assigned training (GET /me/todo); null before the first sync, absent from older workers. */
  todo?: { items?: unknown; total?: unknown } | null;
  /** The admin lets employees turn on training reminders; absent from older workers. */
  reminders?: { allowed?: boolean };
  /** Learner pages from the policy (validated again here); absent from older workers. */
  links?: unknown;
}
export interface Signal { key: string; label: string; occurredAt: string; source: string; domain?: string; action?: string }
export interface BlockRequest { kind: string; target: string; status: string; createdAt: string }
/** The person's own "Report this site" reports (last 90 days, newest first) and what admins decided. */
export interface SiteReport { domain: string; status: 'pending' | 'confirmed' | 'dismissed'; createdAt: string }
const SITE_REPORT_STATUSES: ReadonlySet<string> = new Set(['pending', 'confirmed', 'dismissed']);
export interface Recommendation { exerciseId: string; title: string; path?: string; createdAt?: string }
interface Data { signals: Signal[]; capped: boolean; device: { lastSeenAt?: string; extVersion?: string } | null; aiAttribution: boolean; blockRequests: BlockRequest[]; siteReports: SiteReport[]; recommendation: Recommendation | null }
export type SignalsResult = { ok: true; data: unknown } | { ok: false; reason?: string } | undefined;
export interface Deps {
  send: (
    m: { type: 'popup-info' } | { type: 'bind-start' } | { type: 'me-signals'; days: Days } | { type: 'me-ai-usage' } | { type: 'me-dismiss-recommendation'; exerciseId: string }
      | { type: 'site-report'; domain: string; note?: string } | { type: 'extra-protection-sync' } | { type: 'reminders-sync' },
  ) => Promise<unknown>;
  readReported: () => Promise<WireEvent[]>;
  /** The current tab's URL (activeTab, granted by opening the popup); undefined when unavailable. */
  activeTabUrl: () => Promise<string | undefined>;
  /** chrome.permissions; request must run inside the click handler (user gesture). */
  permissions: {
    contains: (p: chrome.permissions.Permissions) => Promise<boolean>;
    request: (p: chrome.permissions.Permissions) => Promise<boolean>;
  };
  /** Per-person popup preferences (chrome.storage.local); absent → defaults. */
  prefs?: {
    get: (key: string) => Promise<unknown>;
    set: (key: string, value: unknown) => Promise<void>;
  };
}

/** chrome.storage.local key: whether "What we know about you" is expanded. */
export const ACTIVITY_OPEN_KEY = 'popupActivityOpen';

/** Optional permissions behind "Turn on extra protection" (manifest optional_*). */
/** "Extra protection": downloads always; AI-site access only when the AI paste check is on (no needless site prompt). */
export function extraPermissions(aiPaste: boolean): chrome.permissions.Permissions {
  return aiPaste ? { origins: AI_ORIGINS, permissions: ['downloads'] } : { permissions: ['downloads'] };
}

/** The host of a web page URL (lowercased, no path/query), or null for chrome://, extension pages, files. */
export function reportableHost(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const h = u.hostname.toLowerCase().replace(/\.$/, '');
    return h && h.length <= 253 ? h : null;
  } catch {
    return null;
  }
}

/** Protections in the last 7 days (warned + blocked), or 0 when absent/malformed. */
export function weeklyCount(raw: unknown): number {
  const w = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)['weekly'] : undefined;
  if (!w || typeof w !== 'object') return 0;
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  const o = w as Record<string, unknown>;
  return n(o['warned']) + n(o['blocked']);
}

function renderReport(doc: Document, host: string | null, str: S, send: Deps['send']): HTMLElement {
  const sec = el(doc, 'section', undefined, 'report');
  const open = el(doc, 'button', str['pop_report'], 'secondary report-open');
  open.type = 'button';
  const status = el(doc, 'p', undefined, 'report-status');
  status.setAttribute('role', 'status');
  sec.append(open);
  if (!host) {
    open.disabled = true;
    status.textContent = str['pop_report_not_web']!;
    sec.append(status);
    return sec;
  }
  const form = el(doc, 'div', undefined, 'report-form');
  form.hidden = true;
  form.append(el(doc, 'p', host, 'domain'));
  const label = el(doc, 'label', str['pop_report_note']);
  const note = el(doc, 'textarea');
  note.maxLength = 500;
  note.rows = 2;
  label.append(note);
  const sendBtn = el(doc, 'button', str['pop_report_send'], 'primary report-send');
  sendBtn.type = 'button';
  form.append(label, sendBtn);
  sec.append(form, status);
  open.addEventListener('click', () => {
    form.hidden = false;
    open.hidden = true;
    note.focus();
  });
  sendBtn.addEventListener('click', () => {
    sendBtn.disabled = true;
    const text = note.value.trim().slice(0, 500);
    void (async () => {
      let r: { status?: unknown } | undefined;
      try {
        r = (await send(text ? { type: 'site-report', domain: host, note: text } : { type: 'site-report', domain: host })) as typeof r;
      } catch {
        r = undefined;
      }
      const st = r?.status;
      const key = st === 'sent' ? 'pop_report_sent' : st === 'already' ? 'pop_report_already' : st === 'rate_limited' ? 'pop_report_limited' : st === 'invalid' ? 'pop_report_not_web' : 'pop_report_failed';
      status.textContent = str[key]!.replace('{host}', host);
      sec.dataset['state'] = typeof st === 'string' ? st : 'failed';
      if (st === 'sent' || st === 'already' || st === 'rate_limited' || st === 'invalid') form.hidden = true;
      else sendBtn.disabled = false; // failed: let the person retry
    })();
  });
  return sec;
}

interface PermissionCardConfig {
  /** Section class besides `card` (e.g. `extra`). */
  cls: string;
  /** Button class besides `secondary` (e.g. `extra-on`). */
  buttonCls: string;
  permissions: chrome.permissions.Permissions;
  /** String keys: `<prefix>_title`, `_body`, `_button`, `_denied`. */
  prefix: 'pop_extra' | 'pop_reminders';
  /** Message telling the background to apply the newly granted permission. */
  sync: { type: 'extra-protection-sync' } | { type: 'reminders-sync' };
}

/** A "turn on" card for an optional permission; null when already granted (or the check fails). */
async function permissionCard(doc: Document, str: S, deps: Deps, c: PermissionCardConfig): Promise<HTMLElement | null> {
  try {
    if (await deps.permissions.contains(c.permissions)) return null;
  } catch {
    return null;
  }
  const sec = el(doc, 'section', undefined, `card ${c.cls}`);
  sec.append(el(doc, 'h2', str[`${c.prefix}_title`], 'card-title'), el(doc, 'p', str[`${c.prefix}_body`], 'card-text'));
  const b = el(doc, 'button', str[`${c.prefix}_button`], `secondary ${c.buttonCls}`);
  b.type = 'button';
  const status = el(doc, 'p', undefined, 'extra-status');
  status.setAttribute('role', 'status');
  const denied = (): void => {
    status.textContent = str[`${c.prefix}_denied`]!;
    b.disabled = false;
  };
  b.addEventListener('click', () => {
    b.disabled = true;
    // Called synchronously from the click: chrome.permissions.request needs the user gesture.
    deps.permissions.request(c.permissions).then(async (ok) => {
      if (!ok) return denied();
      await deps.send(c.sync).catch(() => undefined);
      sec.remove();
    }, denied);
  });
  sec.append(b, status);
  return sec;
}

/** "Turn on extra protection": when any detector is on and the optional permissions are not granted. */
function renderExtra(doc: Document, info: PopupInfo, str: S, deps: Deps): Promise<HTMLElement | null> {
  const modes = info.extra ?? {};
  const dl = modes.downloads ?? 'warn';
  const ai = modes.aiPaste ?? 'off';
  if (dl === 'off' && ai === 'off') return Promise.resolve(null);
  return permissionCard(doc, str, deps, {
    cls: 'extra', buttonCls: 'extra-on', permissions: extraPermissions(ai !== 'off'), prefix: 'pop_extra', sync: { type: 'extra-protection-sync' },
  });
}

/** At most this many To do items in the popup; the rest behind "+N more". */
export const TODO_SHOWN = 5;

/** "To do": the person's open assigned training, each a link into the tenant app. Null when empty. */
export function renderTodo(
  doc: Document,
  raw: PopupInfo['todo'],
  origin: string,
  str: S,
  locale: string,
  appPaths: AppLinks = DEFAULT_APP_LINKS,
): HTMLElement | null {
  const { items, total } = normalizeTodo(raw ?? {});
  const links = items
    .map((i) => ({ i, href: todoUrl(origin, i.path) }))
    .filter((x): x is { i: TodoItem; href: string } => !!x.href)
    .slice(0, TODO_SHOWN);
  if (!links.length) return null;
  const card = el(doc, 'section', undefined, 'card todo');
  card.setAttribute('aria-label', str['pop_todo_title']!);
  const head = el(doc, 'div', undefined, 'todo-head');
  head.append(el(doc, 'h2', str['pop_todo_title'], 'card-title'), el(doc, 'span', String(total), 'todo-count'));
  const ul = el(doc, 'ul', undefined, 'todo-list');
  for (const { i, href } of links) {
    const li = el(doc, 'li');
    const a = el(doc, 'a', undefined, 'todo-item');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.append(el(doc, 'span', i.title, 'todo-name'));
    const t = dueMs(i.dueAt);
    if (i.overdue) a.append(el(doc, 'span', str['pop_todo_overdue'], 'todo-due overdue'));
    else if (t !== null) a.append(el(doc, 'span', str['pop_todo_due']!.replace('{date}', formatDueDate(locale, t)), 'todo-due'));
    li.append(a);
    ul.append(li);
  }
  card.append(head, ul);
  const more = total - links.length;
  const moreHref = more > 0 ? todoUrl(origin, null, appPaths.todo) : null;
  if (moreHref) {
    const a = el(doc, 'a', str['pop_todo_more']!.replace('{n}', String(more)), 'todo-more');
    a.href = moreHref;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    card.append(a);
  }
  return card;
}

/** "Turn on reminders": only when the admin allows reminders and the permission is not granted yet. */
function renderReminders(doc: Document, info: PopupInfo, str: S, deps: Deps): Promise<HTMLElement | null> {
  if (info.reminders?.allowed !== true) return Promise.resolve(null);
  return permissionCard(doc, str, deps, {
    cls: 'reminders', buttonCls: 'reminders-on', permissions: REMINDER_PERMISSIONS, prefix: 'pop_reminders', sync: { type: 'reminders-sync' },
  });
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Small external-link button next to the status pill: opens the tenant app home. Null when the origin is unsafe. */
export function renderOpenApp(doc: Document, origin: string, str: S): HTMLAnchorElement | null {
  const safe = safeTenantOrigin(origin);
  if (!safe) return null;
  const a = el(doc, 'a', undefined, 'open-app');
  a.href = new URL('/app', safe).href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.setAttribute('aria-label', str['pop_open_app']!);
  a.title = str['pop_open_app']!;
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5']) {
    const path = doc.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  a.append(svg);
  return a;
}

type S = Record<string, string>;
const MAX = 300;
const s = (v: unknown): string => (typeof v === 'string' ? v.slice(0, MAX) : '');
const validTime = (v: string): boolean => Number.isFinite(Date.parse(v));

/** Defensive normalisation: the server shape is not trusted to be well-formed. */
function normalize(raw: unknown): Data {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
  const signals = arr(o['signals'])
    .map((x) => ({
      key: s(x['key']), label: s(x['label']), occurredAt: s(x['occurredAt']), source: s(x['source']),
      domain: s(x['domain']) || undefined, action: s(x['action']) || undefined,
    }))
    .filter((x) => validTime(x.occurredAt))
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
  const d = o['device'] && typeof o['device'] === 'object' ? (o['device'] as Record<string, unknown>) : null;
  return {
    signals,
    // Older servers send no `capped`: a full list (the server's row cap) then means "at least this many".
    capped: typeof o['capped'] === 'boolean' ? o['capped'] : signals.length >= SIGNALS_CAP,
    device: d ? { lastSeenAt: s(d['lastSeenAt']), extVersion: s(d['extVersion']) } : null,
    aiAttribution: o['aiAttribution'] === true,
    recommendation: normalizeRecommendation(o['recommendation']),
    blockRequests: arr(o['blockRequests']).map((x) => ({ kind: s(x['kind']), target: s(x['target']), status: s(x['status']), createdAt: s(x['createdAt']) })),
    // Absent from older servers; unknown statuses and empty domains are dropped.
    siteReports: arr(o['siteReports'])
      .map((x) => ({ domain: s(x['domain']), status: s(x['status']) as SiteReport['status'], createdAt: s(x['createdAt']) }))
      .filter((x) => x.domain.length > 0 && SITE_REPORT_STATUSES.has(x.status)),
  };
}

function normalizeRecommendation(v: unknown): Recommendation | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const exerciseId = s(o['exerciseId']);
  const title = s(o['title']);
  if (!UUID_RE.test(exerciseId) || !title) return null;
  const path = isSafeAppPath(o['path']) ? o['path'] : undefined;
  const createdAt = validTime(s(o['createdAt'])) ? s(o['createdAt']) : undefined;
  return { exerciseId, title, ...(path ? { path } : {}), ...(createdAt ? { createdAt } : {}) };
}

/** Start link: only on an https tenant origin without credentials (same rule as the warning page's Learn link). */
export function recommendationUrl(
  tenantOrigin: unknown,
  exerciseId: string,
  path?: unknown,
  trainingPath: string = DEFAULT_APP_LINKS.training,
): string | null {
  if (!UUID_RE.test(exerciseId)) return null;
  return trainingUrl(tenantOrigin, path, exerciseId, trainingPath);
}

function renderRecommendation(doc: Document, r: Recommendation, href: string, str: S, dismiss: () => Promise<boolean>): HTMLElement {
  const card = el(doc, 'section', undefined, 'card recommendation');
  card.setAttribute('aria-label', str['pop_rec_label']!);
  card.append(el(doc, 'h2', str['pop_rec_label'], 'card-title'), el(doc, 'p', str['pop_rec_text']!.replace('{title}', r.title), 'card-text'));
  const actions = el(doc, 'div', undefined, 'rec-actions');
  const start = el(doc, 'a', str['pop_rec_start'], 'primary');
  start.href = href;
  start.target = '_blank';
  start.rel = 'noopener noreferrer';
  const later = el(doc, 'button', str['pop_rec_later'], 'link');
  later.type = 'button';
  later.addEventListener('click', () => {
    later.disabled = true;
    void dismiss().then((ok) => (ok ? card.remove() : (later.disabled = false)));
  });
  actions.append(start, later);
  card.append(actions);
  return card;
}

function fromReported(events: WireEvent[], str: S): Signal[] {
  return (Array.isArray(events) ? events : [])
    .filter((e) => e && validTime(String(e.occurredAt)))
    .map((e) => {
      const name = String(e.signal).replace(/^browser\./, '');
      return { key: String(e.signal), label: str[`pop_sig_${name}`] ?? String(e.signal), occurredAt: e.occurredAt, source: 'extension', domain: s(e.domain) || undefined, action: s(e.action) || undefined };
    })
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
}

/** A recommendation younger than this is shown above To do. */
export const FRESH_RECOMMENDATION_MS = 24 * 3600e3;

/** First batch shown, then "Show more" adds MORE_STEP at a time (re-rendered so day headings stay correct). */
export const FIRST_SHOWN = 5;
export const MORE_STEP = 20;
/** Mirrors the server's ME_SIGNALS_ROW_CAP; only a fallback for servers that send no `capped` (and the offline list). */
export const SIGNALS_CAP = 200;

/** "23 events · 18 Warned · 3 Blocked": totals for the period, so the full picture needs no scrolling. */
function summaryLine(list: Signal[], capped: boolean, str: S): string {
  const n = list.length;
  const total = capped
    ? str['pop_summary_capped']!.replace('{n}', String(SIGNALS_CAP))
    : n === 1 ? str['pop_summary_one']! : str['pop_summary']!.replace('{n}', String(n));
  const byAction = new Map<string, number>();
  for (const sig of list) if (sig.action) byAction.set(sig.action, (byAction.get(sig.action) ?? 0) + 1);
  const parts = [...byAction].sort((x, y) => y[1] - x[1]).map(([a, c]) => `${c} ${str[`pop_act_${a}`] ?? a}`);
  return [total, ...parts].join(' · ');
}

function renderSignals(doc: Document, list: Signal[], str: S, locale: string, capped = list.length >= SIGNALS_CAP): HTMLElement {
  const wrap = el(doc, 'div', undefined, 'signals');
  if (!list.length) {
    wrap.append(el(doc, 'p', str['pop_empty'], 'empty'));
    return wrap;
  }
  const dayName = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const clock = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' });
  const summary = el(doc, 'p', summaryLine(list, capped, str), 'summary');
  const days = el(doc, 'div', undefined, 'days');
  const more = el(doc, 'button', str['pop_show_more'], 'secondary show-more');
  more.type = 'button';
  let shown = Math.min(FIRST_SHOWN, list.length);
  const draw = (): void => {
    const groups = new Map<string, Signal[]>();
    for (const sig of list.slice(0, shown)) {
      const d = new Date(sig.occurredAt);
      const k = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      groups.set(k, [...(groups.get(k) ?? []), sig]);
    }
    const sections: HTMLElement[] = [];
    for (const [k, items] of groups) {
      const sec = el(doc, 'section', undefined, 'day');
      sec.dataset['day'] = k;
      sec.append(el(doc, 'h3', dayName.format(new Date(items[0]!.occurredAt))));
      const ul = el(doc, 'ul');
      for (const sig of items) {
        const li = el(doc, 'li');
        const head = el(doc, 'div', undefined, 'row');
        head.append(el(doc, 'time', clock.format(new Date(sig.occurredAt))), el(doc, 'span', sig.label, 'label'));
        const meta = el(doc, 'div', undefined, 'meta');
        if (sig.domain) meta.append(el(doc, 'span', sig.domain, 'domain'));
        if (sig.action) {
          const known = ACTIONS.includes(sig.action) ? sig.action : 'other';
          meta.append(el(doc, 'span', str[`pop_act_${sig.action}`] ?? sig.action, `action act-${known}`));
        }
        // Source badge only when it is not the extension itself (most events): Entra, Defender etc. stand out.
        if (sig.source !== 'extension') {
          meta.append(el(doc, 'span', str[`pop_src_${SOURCES.includes(sig.source) ? sig.source : 'other'}`], 'chip'));
        }
        li.append(head, meta);
        ul.append(li);
      }
      sec.append(ul);
      sections.push(sec);
    }
    days.replaceChildren(...sections);
    more.hidden = shown >= list.length;
  };
  more.addEventListener('click', () => {
    shown = Math.min(shown + MORE_STEP, list.length);
    draw();
  });
  draw();
  wrap.append(summary, days, more);
  return wrap;
}

function renderExtras(doc: Document, d: Data, str: S, locale: string): HTMLElement {
  const wrap = el(doc, 'div', undefined, 'extras');
  if (d.blockRequests.length) {
    const sec = el(doc, 'section');
    sec.dataset['block'] = '';
    sec.append(el(doc, 'h3', str['pop_blocks']));
    const ul = el(doc, 'ul');
    const fmt = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
    for (const b of d.blockRequests) {
      const li = el(doc, 'li');
      const row = el(doc, 'div', undefined, 'row');
      row.append(el(doc, 'span', b.target, 'domain'), el(doc, 'span', str[`pop_bs_${b.status}`] ?? b.status, `chip status-${/^\w+$/.test(b.status) ? b.status : 'x'}`));
      li.append(row);
      if (validTime(b.createdAt)) li.append(el(doc, 'div', fmt.format(new Date(b.createdAt)), 'meta'));
      ul.append(li);
    }
    sec.append(ul);
    wrap.append(sec);
  }
  if (d.siteReports.length) {
    const sec = el(doc, 'section');
    sec.dataset['siteReports'] = '';
    sec.append(el(doc, 'h3', str['pop_sr_title']));
    const ul = el(doc, 'ul');
    const fmt = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
    for (const r of d.siteReports) {
      const li = el(doc, 'li');
      const row = el(doc, 'div', undefined, 'row');
      row.append(el(doc, 'span', r.domain, 'domain'), el(doc, 'span', str[`pop_sr_${r.status}`], `chip status-${r.status}`));
      li.append(row);
      if (validTime(r.createdAt)) li.append(el(doc, 'div', fmt.format(new Date(r.createdAt)), 'meta'));
      ul.append(li);
    }
    sec.append(ul);
    wrap.append(sec);
  }
  return wrap;
}

export interface AiToolUse { name: string; days: number }

/** The caller's own AI tools (GET /me/ai-usage via the background), or null when unavailable. */
function normalizeAiTools(res: unknown): AiToolUse[] | null {
  if (!res || typeof res !== 'object' || (res as { ok?: unknown }).ok !== true) return null;
  const tools = ((res as { data?: { tools?: unknown } }).data?.tools);
  if (!Array.isArray(tools)) return null;
  return tools
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
    .map((t) => ({ name: s(t['name']), days: typeof t['days'] === 'number' && Number.isFinite(t['days']) ? Math.max(0, Math.floor(t['days'])) : 0 }))
    .filter((t) => t.name.length > 0);
}

function renderAiTools(doc: Document, tools: AiToolUse[], str: S): HTMLElement {
  const sec = el(doc, 'section', undefined, 'ai-tools');
  sec.append(el(doc, 'h3', str['pop_ai_title']));
  if (!tools.length) {
    sec.append(el(doc, 'p', str['pop_ai_none'], 'empty'));
    return sec;
  }
  const ul = el(doc, 'ul');
  for (const t of tools) {
    const li = el(doc, 'li');
    const row = el(doc, 'div', undefined, 'row');
    row.append(el(doc, 'span', t.name, 'label'), el(doc, 'span', str['pop_ai_days']!.replace('{n}', String(t.days)), 'meta'));
    li.append(row);
    ul.append(li);
  }
  sec.append(ul);
  return sec;
}

function deviceLine(d: Data, str: S, locale: string): string {
  const when = d.device?.lastSeenAt && validTime(d.device.lastSeenAt)
    ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(d.device.lastSeenAt))
    : str['pop_unknown']!;
  return str['pop_device']!.replace('{when}', when).replace('{version}', d.device?.extVersion || str['pop_unknown']!);
}

/** Renders the popup. Safe to call repeatedly; it replaces the body. */
export async function run(doc: Document, deps: Deps): Promise<void> {
  const info = (await deps.send({ type: 'popup-info' })) as PopupInfo | undefined;
  const locale = info?.locale ?? 'en';
  const str = stringsFor(locale) as unknown as S;
  doc.documentElement.lang = locale;
  doc.title = str['pop_page_title']!;

  const main = el(doc, 'main');
  const header = el(doc, 'header');
  header.append(brandMark(doc));
  const state = el(doc, 'p', undefined, 'state');
  const headerEnd = el(doc, 'div', undefined, 'header-end');
  headerEnd.append(state);
  header.append(headerEnd);
  // Weekly note (connected) or what to do next (not connected); hidden while empty.
  const status = el(doc, 'section', undefined, 'status');
  main.append(header, status);
  doc.body.replaceChildren(main);

  const bindButton = (text: string): HTMLButtonElement => {
    const b = el(doc, 'button', text, 'primary');
    b.type = 'button';
    b.addEventListener('click', () => void deps.send({ type: 'bind-start' }));
    return b;
  };

  if (!info || !info.connected) {
    const reauth = info?.needsReauth === true;
    const gone = !reauth && !!info?.disconnected; // the organization signed this browser out
    const [title, lead, button] = gone
      ? ['pop_disconnected_title', 'pop_disconnected_body', 'pop_reauth']
      : reauth
        ? ['pop_reauth_title', 'pop_reauth_body', 'pop_reauth']
        : ['pop_not_connected', 'pop_not_connected_body', 'pop_connect'];
    // The pill stays short; a specific reason (revoked, expired) gets its own heading below it.
    state.textContent = str['pop_not_connected']!;
    state.classList.add('off');
    if (title !== 'pop_not_connected') status.append(el(doc, 'h2', str[title], 'status-title'));
    status.append(el(doc, 'p', str[lead], 'lead'));
    main.append(bindButton(str[button]!));
    return;
  }

  // Pill shows just the workspace name; the full sentence is the tooltip and accessible name.
  const connected = str['pop_connected']!.replace('{tenant}', info.tenantName ?? '');
  state.textContent = info.tenantName || connected;
  state.title = connected;
  state.setAttribute('aria-label', connected);
  state.classList.add('on');
  const openApp = renderOpenApp(doc, info.tenantOrigin, str);
  if (openApp) headerEnd.append(openApp);
  const weekly = el(doc, 'p', undefined, 'weekly');
  weekly.hidden = true;
  status.append(weekly);
  const links = appLinks(info.links);
  const todo = renderTodo(doc, info.todo, info.tenantOrigin, str, locale, links);
  if (todo) main.append(todo);
  const recSlot = el(doc, 'div', undefined, 'rec-slot');
  main.append(recSlot);
  const reminders = await renderReminders(doc, info, str, deps);
  if (reminders) main.append(reminders);
  const extra = await renderExtra(doc, info, str, deps);
  if (extra) main.append(extra);
  let tabUrl: string | undefined;
  try { tabUrl = await deps.activeTabUrl(); } catch { tabUrl = undefined; }
  main.append(renderReport(doc, reportableHost(tabUrl), str, deps.send));

  const bar = el(doc, 'div', undefined, 'periods');
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', str['pop_period']!);
  const body = el(doc, 'div', undefined, 'body');
  body.setAttribute('aria-live', 'polite');
  const footer = el(doc, 'footer');
  const link = el(doc, 'a', str['pop_collects'], 'collects');
  link.href = PUBLIC_DOCS; // always the public docs (the tenant app has no /help route)
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  footer.append(link);
  const activity = el(doc, 'section', undefined, 'activity');
  // Collapsible: the header is a real disclosure button; the content keeps its existing structure.
  const heading = el(doc, 'h2', undefined, 'section-title');
  const toggle = el(doc, 'button', undefined, 'activity-toggle');
  toggle.type = 'button';
  toggle.id = 'activity-toggle';
  toggle.setAttribute('aria-controls', 'activity-content');
  const chevron = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  chevron.setAttribute('viewBox', '0 0 16 16');
  chevron.setAttribute('aria-hidden', 'true');
  chevron.setAttribute('class', 'chevron');
  const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M6 4l4 4-4 4');
  chevron.append(path);
  const weekSummary = el(doc, 'span', '…', 'activity-summary');
  toggle.append(chevron, el(doc, 'span', str['pop_heading'], 'activity-title'), weekSummary);
  heading.append(toggle);
  const content = el(doc, 'div', undefined, 'activity-content');
  content.id = 'activity-content';
  content.setAttribute('role', 'region');
  content.setAttribute('aria-labelledby', 'activity-toggle');
  content.append(el(doc, 'p', str['pop_intro'], 'section-text'), bar, body);
  activity.append(heading, content);
  const setOpen = (open: boolean): void => {
    toggle.setAttribute('aria-expanded', String(open));
    content.hidden = !open;
    activity.classList.toggle('open', open);
  };
  let open = false;
  try { open = (await deps.prefs?.get(ACTIVITY_OPEN_KEY)) === true; } catch { open = false; }
  setOpen(open);
  toggle.addEventListener('click', () => {
    open = !open;
    setOpen(open);
    void deps.prefs?.set(ACTIVITY_OPEN_KEY, open).catch(() => undefined);
  });
  const setWeekSummary = (n: number): void => {
    weekSummary.textContent = n === 0 ? str['pop_summary_week_none']! : n === 1 ? str['pop_summary_week_one']! : str['pop_summary_week']!.replace('{n}', String(n));
  };
  main.append(activity, footer);

  let seq = 0;
  const load = async (days: Days): Promise<void> => {
    const mine = ++seq;
    for (const b of bar.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset['days'] === String(days)));
    body.setAttribute('aria-busy', 'true');
    body.replaceChildren(el(doc, 'p', str['pop_loading'], 'empty'));
    let res: SignalsResult;
    try {
      res = (await deps.send({ type: 'me-signals', days })) as SignalsResult;
    } catch {
      res = undefined;
    }
    if (mine !== seq) return; // a newer period was picked
    body.removeAttribute('aria-busy');
    if (res && res.ok) {
      const d = normalize(res.data);
      if (days === 7) setWeekSummary(d.signals.length);
      // "This week ... N times": a small positive note, hidden when absent or zero.
      const n = weeklyCount(res.data);
      weekly.hidden = n === 0;
      weekly.textContent = n === 0 ? '' : n === 1 ? str['pop_weekly_one']! : str['pop_weekly']!.replace('{n}', String(n));
      const recHref = d.recommendation ? recommendationUrl(info.tenantOrigin, d.recommendation.exerciseId, d.recommendation.path, links.training) : null;
      const rec = d.recommendation && recHref
        ? [renderRecommendation(doc, d.recommendation, recHref, str, async () => {
            try {
              const r = (await deps.send({ type: 'me-dismiss-recommendation', exerciseId: d.recommendation!.exerciseId })) as { ok?: unknown } | undefined;
              return r?.ok === true;
            } catch {
              return false;
            }
          })]
        : [];
      recSlot.replaceChildren(...rec);
      // A recommendation from the last day follows a risky moment the person just had: show it above To do.
      // Older ones (or from servers without createdAt) sit below the required work.
      if (todo) {
        const fresh = !!d.recommendation?.createdAt && Date.now() - Date.parse(d.recommendation.createdAt) < FRESH_RECOMMENDATION_MS;
        if (fresh) todo.before(recSlot);
        else todo.after(recSlot);
      }
      body.replaceChildren(
        renderSignals(doc, d.signals, str, locale, d.capped),
        renderExtras(doc, d, str, locale),
      );
      footer.replaceChildren(
        el(doc, 'p', deviceLine(d, str, locale), 'device'),
        el(doc, 'p', str[d.aiAttribution ? 'pop_ai_on' : 'pop_ai_off'], 'ai'),
        link,
      );
      if (d.aiAttribution) {
        let ai: unknown;
        try {
          ai = await deps.send({ type: 'me-ai-usage' });
        } catch {
          ai = undefined;
        }
        const tools = normalizeAiTools(ai);
        if (mine === seq && tools) body.append(renderAiTools(doc, tools, str));
      }
      return;
    }
    let cached: WireEvent[] = [];
    try { cached = await deps.readReported(); } catch { /* none */ }
    if (mine !== seq) return;
    const offline = fromReported(cached, str);
    if (days === 7) setWeekSummary(offline.filter((x) => Date.now() - Date.parse(x.occurredAt) < 7 * 864e5).length);
    const note = el(doc, 'p', str['pop_offline'], 'note');
    note.setAttribute('role', 'status');
    body.replaceChildren(note, renderSignals(doc, offline, str, locale));
  };

  for (const p of PERIODS) {
    const b = el(doc, 'button', str[p.key], 'period');
    b.type = 'button';
    b.dataset['days'] = String(p.days);
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => void load(p.days));
    bar.append(b);
  }
  await load(7);
}

if (typeof chrome !== 'undefined' && chrome.runtime?.id && location.protocol === 'chrome-extension:') {
  void run(document, {
    send: (m) => chrome.runtime.sendMessage(m),
    readReported: async () => (await getLocal<WireEvent[]>('reported')) ?? [],
    activeTabUrl: async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.url,
    permissions: {
      contains: (p) => chrome.permissions.contains(p),
      request: (p) => chrome.permissions.request(p),
    },
    prefs: {
      get: async (key) => (await chrome.storage.local.get(key))[key],
      set: (key, value) => chrome.storage.local.set({ [key]: value }),
    },
  });
}
