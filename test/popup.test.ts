// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { run, type Deps } from '../src/popup/popup.ts';
import en from '../src/lib/i18n/en.json';

const INFO = { connected: true, tenantName: 'Acme', needsReauth: false, tenantOrigin: 'https://acme.ransomleak.com', locale: 'en' };
const noon = (d: string): string => new Date(`${d}T12:00:00`).toISOString();
const DATA = {
  signals: [
    { key: 'browser.lookalike_visit', label: 'Visited a look-alike site', occurredAt: noon('2026-10-20'), source: 'extension', domain: 'acrne.com', action: 'warned' },
    { key: 'browser.warning_overridden', label: 'Continued past a warning', occurredAt: noon('2026-10-20'), source: 'extension', domain: 'acrne.com', action: 'proceeded' },
    { key: 'entra.risky_signin', label: 'Risky sign-in', occurredAt: noon('2026-10-18'), source: 'entra' },
    { key: 'chrome.unsafe_site', label: 'Unsafe site', occurredAt: noon('2026-10-18'), source: 'chrome_enterprise', domain: 'bad.example' },
  ],
  device: { lastSeenAt: noon('2026-10-21'), extVersion: '0.1.0' },
  aiAttribution: true,
};

let send: ReturnType<typeof vi.fn>;
let reported: unknown[];
let tabUrl: string | undefined;
let granted: boolean;
let remindersGranted: boolean;
let request: ReturnType<typeof vi.fn>;
const deps = (): Deps => ({
  send: send as Deps['send'],
  readReported: async () => reported as never,
  activeTabUrl: async () => tabUrl,
  permissions: { contains: async (p) => (p.permissions?.includes('notifications') ? remindersGranted : granted), request: request as Deps['permissions']['request'] },
});
const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
const mount = async (info: unknown = INFO, signals: unknown = { ok: true, data: DATA }): Promise<void> => {
  send = vi.fn(async (m: { type: string }) => (m.type === 'popup-info' ? info : m.type === 'me-signals' ? signals : undefined));
  document.body.replaceChildren();
  await run(document, deps());
  await flush();
};
const $ = (s: string): Element | null => document.querySelector(s);
const text = (): string => document.body.textContent ?? '';

beforeEach(() => { remindersGranted = false; reported = []; tabUrl = 'https://phish.example.com/login?u=me#x'; granted = true; request = vi.fn(async () => true); });

describe('popup', () => {
  it('shows connected state and tenant name', async () => {
    await mount();
    expect(text()).toContain('Acme');
    expect(document.querySelector('.state')!.getAttribute('aria-label')).toBe(en.pop_connected.replace('{tenant}', 'Acme'));
  });
  it('lists signals grouped by day with source chips, domain and action', async () => {
    await mount();
    const days = document.querySelectorAll('[data-day]');
    expect(days).toHaveLength(2);
    expect(days[0]!.querySelectorAll('li')).toHaveLength(2);
    expect(days[0]!.textContent).toContain('Visited a look-alike site');
    expect(days[0]!.textContent).toContain('acrne.com');
    expect(days[0]!.textContent).toContain(en.pop_act_warned);
    const chips = [...document.querySelectorAll('.chip')].map((c) => c.textContent);
    expect(chips).toEqual([en.pop_src_entra, en.pop_src_chrome_enterprise]);
    expect(document.querySelector('.act-warned')!.textContent).toBe(en.pop_act_warned);
    expect(document.querySelector('.act-proceeded')!.textContent).toBe(en.pop_act_proceeded);
  });
  it('shows the newest 5 events, then 20 more per Show more, with a period summary', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      key: 'browser.lookalike_visit', label: `Event ${i}`, occurredAt: new Date(Date.UTC(2026, 9, 20, 12) - i * 3600e3).toISOString(),
      source: 'extension', domain: 'acrne.com', action: i < 20 ? 'warned' : 'blocked',
    }));
    await mount(INFO, { ok: true, data: { ...DATA, signals: many } });
    const items = (): number => document.querySelectorAll('.signals li').length;
    expect(items()).toBe(5);
    expect($('.summary')!.textContent).toBe(`30 events · 20 ${en.pop_act_warned} · 10 ${en.pop_act_blocked}`);
    const more = $('.show-more') as HTMLButtonElement;
    expect(more.hidden).toBe(false);
    more.click();
    expect(items()).toBe(25);
    more.click();
    expect(items()).toBe(30);
    expect(more.hidden).toBe(true);
  });
  it('marks a full list as capped and hides Show more for short lists', async () => {
    const full = Array.from({ length: 200 }, (_, i) => ({ key: 'k', label: 'E', occurredAt: new Date(Date.UTC(2026, 9, 20) - i * 60e3).toISOString(), source: 'extension' }));
    await mount(INFO, { ok: true, data: { ...DATA, signals: full } });
    expect($('.summary')!.textContent).toBe('200+ events'); // older server: no `capped`, full list
    await mount(INFO, { ok: true, data: { ...DATA, signals: full, capped: false } });
    expect($('.summary')!.textContent).toBe('200 events'); // the server's flag wins
    await mount(INFO, { ok: true, data: { ...DATA, signals: full.slice(0, 3), capped: true } });
    expect($('.summary')!.textContent).toBe('200+ events');
    await mount();
    expect(($('.show-more') as HTMLButtonElement).hidden).toBe(true);
  });
  it('shows device line and AI attribution flag (on and off)', async () => {
    await mount();
    expect(text()).toContain('0.1.0');
    expect(text()).toContain(en.pop_ai_on);
    await mount(INFO, { ok: true, data: { ...DATA, aiAttribution: false } });
    expect(text()).toContain(en.pop_ai_off);
  });
  it('shows the own AI tool list only when attribution is on', async () => {
    const ai = { ok: true, data: { tools: [{ id: 'claude', name: 'Claude', days: 4 }] } };
    send = vi.fn(async (m: { type: string }) =>
      m.type === 'popup-info' ? INFO : m.type === 'me-signals' ? { ok: true, data: DATA } : m.type === 'me-ai-usage' ? ai : undefined);
    document.body.replaceChildren();
    await run(document, deps());
    await flush();
    expect($('.ai-tools')?.textContent).toContain('Claude');
    expect($('.ai-tools')?.textContent).toContain(en.pop_ai_days.replace('{n}', '4'));
    await mount(INFO, { ok: true, data: { ...DATA, aiAttribution: false } });
    expect($('.ai-tools')).toBeNull();
    expect(send.mock.calls.some((c) => c[0].type === 'me-ai-usage')).toBe(false);
  });
  it('shows the recommended drill with an https Start link and Not now', async () => {
    const rec = { exerciseId: '11111111-2222-4333-8444-555555555555', title: '<b>Spot fake logins</b>' };
    send = vi.fn(async (m: { type: string }) =>
      m.type === 'popup-info' ? INFO
        : m.type === 'me-signals' ? { ok: true, data: { ...DATA, aiAttribution: false, recommendation: rec } }
          : m.type === 'me-dismiss-recommendation' ? { ok: true } : undefined);
    document.body.replaceChildren();
    await run(document, deps());
    await flush();
    const card = $('.recommendation')!;
    expect(card.querySelector('b')).toBeNull(); // textContent only
    expect(card.textContent).toContain(en.pop_rec_text.replace('{title}', rec.title));
    expect((card.querySelector('a') as HTMLAnchorElement).href).toBe(`https://acme.ransomleak.com/app/microlearning?highlight=${rec.exerciseId}`);
    (card.querySelector('button') as HTMLButtonElement).click();
    await flush();
    expect(send).toHaveBeenCalledWith({ type: 'me-dismiss-recommendation', exerciseId: rec.exerciseId });
    expect($('.recommendation')).toBeNull();
  });
  it('hides the recommendation without an https tenant origin or a valid id', async () => {
    const rec = { exerciseId: '11111111-2222-4333-8444-555555555555', title: 'Drill' };
    await mount({ ...INFO, tenantOrigin: 'http://acme.ransomleak.com' }, { ok: true, data: { ...DATA, recommendation: rec } });
    expect($('.recommendation')).toBeNull();
    await mount(INFO, { ok: true, data: { ...DATA, recommendation: { ...rec, exerciseId: 'x' } } });
    expect($('.recommendation')).toBeNull();
    await mount(INFO, { ok: true, data: { ...DATA, recommendation: null } });
    expect($('.recommendation')).toBeNull();
  });
  it('shows the empty state', async () => {
    await mount(INFO, { ok: true, data: { ...DATA, signals: [] } });
    expect(text()).toContain('Nothing recorded about you in this period.');
  });
  it('period selector defaults to 7 and re-requests with the chosen days', async () => {
    await mount();
    expect(send).toHaveBeenCalledWith({ type: 'me-signals', days: 7 });
    for (const [d, key] of [[30, 'p30'], [90, 'p90'], ['all', 'pall']] as const) {
      (document.querySelector(`[data-days="${d}"]`) as HTMLButtonElement).click();
      await flush();
      expect(send).toHaveBeenCalledWith({ type: 'me-signals', days: d });
      expect(document.querySelector(`[data-days="${d}"]`)!.getAttribute('aria-pressed')).toBe('true');
      expect(document.querySelector(`[data-days="${d}"]`)!.textContent).toBe((en as Record<string, string>)[`pop_${key}`]);
    }
    expect(document.querySelector('[data-days="7"]')!.getAttribute('aria-pressed')).toBe('false');
  });
  it('renders hostile labels and domains as text only', async () => {
    const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    await mount({ ...INFO, tenantName: evil }, {
      ok: true,
      data: { ...DATA, signals: [{ key: 'k', label: evil, occurredAt: noon('2026-10-20'), source: 'other', domain: evil, action: evil }], blockRequests: [{ kind: evil, target: evil, status: 'pending', createdAt: noon('2026-10-20') }] },
    });
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(text()).toContain(evil);
  });
  it('shows block requests with their status', async () => {
    const blockRequests = [
      { kind: 'domain', target: 'tool.example', status: 'approved', createdAt: noon('2026-10-19') },
      { kind: 'oauth', target: 'App X', status: 'rejected', createdAt: noon('2026-10-19') },
      { kind: 'domain', target: 'wait.example', status: 'pending', createdAt: noon('2026-10-19') },
    ];
    await mount(INFO, { ok: true, data: { ...DATA, blockRequests } });
    const items = [...document.querySelectorAll('[data-block] li')].map((l) => l.textContent);
    expect(items).toHaveLength(3);
    expect(items[0]).toContain('tool.example');
    expect(items[0]).toContain(en.pop_bs_approved);
    expect(items[1]).toContain(en.pop_bs_rejected);
    expect(items[2]).toContain(en.pop_bs_pending);
  });
  it('shows the person\'s own site reports with outcome chips and drops malformed rows', async () => {
    const siteReports = [
      { domain: 'phish.example', status: 'confirmed', createdAt: noon('2026-10-19'), decidedAt: noon('2026-10-20') },
      { domain: 'odd.example', status: 'dismissed', createdAt: noon('2026-10-18'), decidedAt: noon('2026-10-19') },
      { domain: 'new.example', status: 'pending', createdAt: noon('2026-10-17'), decidedAt: null },
      { domain: 'bad.example', status: 'weird', createdAt: noon('2026-10-17') },
      { domain: '', status: 'pending', createdAt: noon('2026-10-17') },
    ];
    await mount(INFO, { ok: true, data: { ...DATA, siteReports } });
    expect($('[data-site-reports] h3')!.textContent).toBe(en.pop_sr_title);
    const items = [...document.querySelectorAll('[data-site-reports] li')];
    expect(items).toHaveLength(3);
    expect(items[0]!.textContent).toContain('phish.example');
    expect(items[0]!.querySelector('.chip.status-confirmed')!.textContent).toBe(en.pop_sr_confirmed);
    expect(items[1]!.querySelector('.chip.status-dismissed')!.textContent).toBe(en.pop_sr_dismissed);
    expect(items[2]!.querySelector('.chip.status-pending')!.textContent).toBe(en.pop_sr_pending);
  });
  it('omits the site report section when there are none (or the server is older)', async () => {
    await mount();
    expect($('[data-site-reports]')).toBeNull();
  });
  it('omits the block request section when there are none', async () => {
    await mount();
    expect($('[data-block]')).toBeNull();
  });
  it('offline: falls back to the reported cache with the plain-language note', async () => {
    reported = [{ id: '1', signal: 'browser.lookalike_visit', domain: 'acrne.com', occurredAt: noon('2026-10-20'), action: 'warned' }];
    await mount(INFO, { ok: false, reason: 'offline' });
    expect(text()).toContain("Showing what this browser sent recently. The full list couldn't be loaded.");
    expect(text()).not.toContain('incomplete');
    expect(text()).toContain('acrne.com');
    expect(text()).toContain(en.pop_sig_lookalike_visit);
    expect(document.querySelector('.chip')).toBeNull(); // extension-sourced: no badge
  });
  it('always links to the public what-we-collect docs, never a tenant /help route', async () => {
    await mount();
    expect(($('a.collects') as HTMLAnchorElement).href).toBe('https://docs.ransomleak.com/browser-extension/what-we-collect/');
    expect($('a.collects')!.textContent).toBe('What this extension collects');
    await mount({ ...INFO, tenantOrigin: '' });
    expect(($('a.collects') as HTMLAnchorElement).href).toBe('https://docs.ransomleak.com/browser-extension/what-we-collect/');
  });
  it('not connected: one Connect button that sends bind-start; no signal request', async () => {
    await mount({ connected: false, tenantName: null, needsReauth: false, tenantOrigin: '', locale: 'en' });
    const buttons = document.querySelectorAll('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.textContent).toBe('Connect your work account');
    buttons[0]!.click();
    expect(send).toHaveBeenCalledWith({ type: 'bind-start' });
    expect(send.mock.calls.some((c) => c[0].type === 'me-signals')).toBe(false);
  });
  it('needsReauth: shows Sign in again which sends bind-start', async () => {
    await mount({ ...INFO, connected: false, needsReauth: true });
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent === 'Sign in again')!;
    b.click();
    expect(send).toHaveBeenCalledWith({ type: 'bind-start' });
    expect(send.mock.calls.some((c) => c[0].type === 'me-signals')).toBe(false);
  });
  it('needsReauth (plain expiry) keeps the expired-sign-in copy', async () => {
    await mount({ ...INFO, connected: false, needsReauth: true, disconnected: null });
    expect(text()).toContain(en.pop_reauth_title);
    expect(text()).not.toContain(en.pop_disconnected_title);
  });
  it('disconnected by the organization: explains it and still offers Sign in again', async () => {
    for (const reason of ['revoked', 'disabled'] as const) {
      await mount({ connected: false, tenantName: null, needsReauth: false, disconnected: reason, tenantOrigin: '', locale: 'en' });
      expect(document.querySelector('.state')!.textContent).toBe(en.pop_not_connected);
      expect(document.querySelector('.status-title')!.textContent).toBe('Your organization disconnected this browser');
      expect(text()).toContain('Protection is off on this browser. Contact your IT team if this is a mistake.');
      expect(text()).not.toContain(en.pop_reauth_title);
      const buttons = document.querySelectorAll('button');
      expect(buttons).toHaveLength(1);
      expect(buttons[0]!.textContent).toBe('Sign in again');
      buttons[0]!.click();
      expect(send).toHaveBeenCalledWith({ type: 'bind-start' });
    }
  });
  it('uses the binding locale for strings', async () => {
    const de = (await import('../src/lib/i18n/de.json')).default;
    await mount({ ...INFO, locale: 'de' }, { ok: true, data: { ...DATA, signals: [] } });
    expect(text()).toContain(de.pop_empty);
    expect(document.documentElement.lang).toBe('de');
  });
  it('tolerates a malformed server response', async () => {
    await mount(INFO, { ok: true, data: { signals: 'nope', device: null } });
    expect(text()).toContain(en.pop_empty);
  });

  describe('report this site', () => {
    const mountReport = async (result: unknown): Promise<void> => {
      send = vi.fn(async (m: { type: string }) =>
        m.type === 'popup-info' ? INFO : m.type === 'me-signals' ? { ok: true, data: DATA } : m.type === 'site-report' ? result : undefined);
      document.body.replaceChildren();
      await run(document, deps());
      await flush();
    };
    it('sends the host only (no path, query or fragment) with the optional note', async () => {
      await mountReport({ status: 'sent' });
      const open = $('.report-open') as HTMLButtonElement;
      expect(open.textContent).toBe(en.pop_report);
      open.click();
      expect($('.report-form .domain')!.textContent).toBe('phish.example.com');
      ($('.report-form textarea') as HTMLTextAreaElement).value = ' looks fake ';
      ($('.report-send') as HTMLButtonElement).click();
      await flush();
      expect(send).toHaveBeenCalledWith({ type: 'site-report', domain: 'phish.example.com', note: 'looks fake' });
      expect($('.report-status')!.textContent).toBe(en.pop_report_sent.replace('{host}', 'phish.example.com'));
      expect(JSON.stringify(send.mock.calls)).not.toContain('login');
    });
    it('shows already reported / rate limited / failed (retry allowed)', async () => {
      for (const [st, key] of [['already', 'pop_report_already'], ['rate_limited', 'pop_report_limited'], ['failed', 'pop_report_failed']] as const) {
        await mountReport({ status: st });
        ($('.report-open') as HTMLButtonElement).click();
        ($('.report-send') as HTMLButtonElement).click();
        await flush();
        expect($('.report-status')!.textContent).toBe((en as Record<string, string>)[key]!.replace('{host}', 'phish.example.com'));
        expect(($('.report-send') as HTMLButtonElement).disabled).toBe(st !== 'failed');
      }
      expect(send).toHaveBeenCalledWith({ type: 'site-report', domain: 'phish.example.com' });
    });
    it('not a web page: disabled with an explanation', async () => {
      for (const u of ['chrome://settings/', 'chrome-extension://extid/src/warning/warning.html', undefined]) {
        tabUrl = u;
        await mountReport({ status: 'sent' });
        expect(($('.report-open') as HTMLButtonElement).disabled).toBe(true);
        expect($('.report-status')!.textContent).toBe(en.pop_report_not_web);
      }
    });
    it('absent when not connected', async () => {
      await mount({ connected: false, tenantName: null, needsReauth: false, tenantOrigin: '', locale: 'en' });
      expect($('.report')).toBeNull();
      expect($('.extra')).toBeNull();
    });
  });

  describe('extra protection', () => {
    it('offered when a permission is missing; the click requests both and syncs on grant', async () => {
      granted = false;
      await mount();
      expect($('.extra')!.textContent).toContain(en.pop_extra_body);
      ($('.extra-on') as HTMLButtonElement).click();
      expect(request).toHaveBeenCalledWith({ origins: ['https://*/*', 'http://*/*'], permissions: ['downloads'] });
      await flush();
      expect(send).toHaveBeenCalledWith({ type: 'extra-protection-sync' });
      expect($('.extra')).toBeNull();
    });
    it('denied: explains and keeps the button', async () => {
      granted = false;
      request = vi.fn(async () => false);
      await mount();
      ($('.extra-on') as HTMLButtonElement).click();
      await flush();
      expect($('.extra-status')!.textContent).toBe(en.pop_extra_denied);
      expect(($('.extra-on') as HTMLButtonElement).disabled).toBe(false);
    });
    it('hidden when granted, or when both modes are off', async () => {
      await mount();
      expect($('.extra')).toBeNull();
      granted = false;
      await mount({ ...INFO, extra: { passwordEntry: 'off', downloads: 'off' } });
      expect($('.extra')).toBeNull();
      await mount({ ...INFO, extra: { passwordEntry: 'off', downloads: 'warn' } });
      expect($('.extra')).not.toBeNull();
      await mount({ ...INFO, extra: { passwordEntry: 'off', downloads: 'off', aiPaste: 'off' } });
      expect($('.extra')).toBeNull();
      await mount({ ...INFO, extra: { passwordEntry: 'off', downloads: 'off', aiPaste: 'block' } });
      expect($('.extra')).not.toBeNull();
    });
  });

  describe('weekly note', () => {
    it('shows warned + blocked of the last 7 days; singular; hidden when zero or absent', async () => {
      const since = '2026-10-15T00:00:00Z';
      await mount(INFO, { ok: true, data: { ...DATA, weekly: { warned: 3, blocked: 1, wentBack: 2, since } } });
      expect(($('.weekly') as HTMLElement).hidden).toBe(false);
      expect($('.weekly')!.textContent).toBe(en.pop_weekly.replace('{n}', '4'));
      await mount(INFO, { ok: true, data: { ...DATA, weekly: { warned: 1, blocked: 0, wentBack: 0, since } } });
      expect($('.weekly')!.textContent).toBe(en.pop_weekly_one);
      await mount(INFO, { ok: true, data: { ...DATA, weekly: { warned: 0, blocked: 0, wentBack: 0, since } } });
      expect(($('.weekly') as HTMLElement).hidden).toBe(true);
      await mount(INFO, { ok: true, data: { ...DATA, weekly: { warned: 'x', blocked: -2 } } });
      expect(($('.weekly') as HTMLElement).hidden).toBe(true);
      await mount();
      expect(($('.weekly') as HTMLElement).hidden).toBe(true);
    });
  });
  describe('to do', () => {
    const ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const item = (n: number, extra: Record<string, unknown> = {}) => ({
      kind: n % 2 ? 'campaign' : 'learning_path', id: ID(n), title: `Training ${n}`, dueAt: null, overdue: false,
      path: n % 2 ? `/app/campaigns/${ID(n)}` : `/app/learning-paths/${ID(n)}`, ...extra,
    });
    it('lists up to 5 items as tenant links with due date or Overdue, and +N more to My campaigns', async () => {
      const items = [item(1, { overdue: true, dueAt: '2026-10-01' }), item(2, { dueAt: '2026-11-04' }), item(3), item(4), item(5), item(6)];
      await mount({ ...INFO, todo: { items, total: 9 } });
      const card = $('.card.todo')!;
      expect(card.querySelector('.card-title')!.textContent).toBe(en.pop_todo_title);
      expect(card.querySelector('.todo-count')!.textContent).toBe('9');
      const links = [...card.querySelectorAll<HTMLAnchorElement>('a.todo-item')];
      expect(links).toHaveLength(5);
      expect(links[0]!.href).toBe(`https://acme.ransomleak.com/app/campaigns/${ID(1)}`);
      expect(links[1]!.href).toBe(`https://acme.ransomleak.com/app/learning-paths/${ID(2)}`);
      expect(links.every((a) => a.target === '_blank' && a.rel === 'noopener noreferrer')).toBe(true);
      expect(links[0]!.querySelector('.todo-due.overdue')!.textContent).toBe(en.pop_todo_overdue);
      expect(links[1]!.querySelector('.todo-due')!.textContent).toBe(en.pop_todo_due.replace('{date}', 'Nov 4'));
      expect(links[2]!.querySelector('.todo-due')).toBeNull();
      const more = card.querySelector<HTMLAnchorElement>('a.todo-more')!;
      expect(more.textContent).toBe(en.pop_todo_more.replace('{n}', '4'));
      expect(more.href).toBe('https://acme.ransomleak.com/app/campaigns');
      // Above the recommendation slot.
      expect(card.nextElementSibling!.classList.contains('rec-slot')).toBe(true);
    });
    it('titles are text; an item with an unsafe path is not linked but still counted in +N more', async () => {
      await mount({ ...INFO, todo: { items: [item(1, { title: '<img src=x onerror=alert(1)>' }), item(3, { path: 'javascript:alert(1)' })], total: 2 } });
      const links = document.querySelectorAll<HTMLAnchorElement>('a.todo-item');
      expect(links).toHaveLength(1);
      expect(links[0]!.textContent).toContain('<img src=x onerror=alert(1)>');
      expect(document.querySelector('.card.todo img')).toBeNull();
      expect($('a.todo-more')!.textContent).toBe(en.pop_todo_more.replace('{n}', '1'));
      await mount({ ...INFO, todo: { items: [item(1)], total: 1 } });
      expect($('a.todo-more')).toBeNull();
    });
    it('a recommendation from the last day sits above To do; an older one below', async () => {
      const rec = (hoursAgo: number) => ({ exerciseId: '11111111-2222-4333-8444-555555555555', title: 'Drill', createdAt: new Date(Date.now() - hoursAgo * 3600e3).toISOString() });
      const order = (): string[] => [...document.querySelectorAll('.card.todo, .card.recommendation')].map((e) => (e.classList.contains('todo') ? 'todo' : 'rec'));
      await mount({ ...INFO, todo: { items: [item(1)], total: 1 } }, { ok: true, data: { ...DATA, recommendation: rec(2) } });
      expect(order()).toEqual(['rec', 'todo']);
      await mount({ ...INFO, todo: { items: [item(1)], total: 1 } }, { ok: true, data: { ...DATA, recommendation: rec(30) } });
      expect(order()).toEqual(['todo', 'rec']);
      await mount({ ...INFO, todo: { items: [item(1)], total: 1 } }, { ok: true, data: { ...DATA, recommendation: { ...rec(2), createdAt: undefined } } });
      expect(order()).toEqual(['todo', 'rec']); // older servers: required work first
    });
    it('hidden when there is nothing to do, before the first sync, or on an unsafe tenant origin', async () => {
      await mount({ ...INFO, todo: { items: [], total: 0 } });
      expect($('.card.todo')).toBeNull();
      await mount({ ...INFO, todo: null });
      expect($('.card.todo')).toBeNull();
      await mount({ ...INFO, tenantOrigin: 'http://acme.ransomleak.com', todo: { items: [item(1)], total: 1 } });
      expect($('.card.todo')).toBeNull();
    });
  });

  describe('open RansomLeak', () => {
    it('a labelled external link next to the pill opens the tenant app home', async () => {
      await mount();
      const a = $('header .header-end a.open-app') as HTMLAnchorElement;
      expect(a.href).toBe('https://acme.ransomleak.com/app');
      expect(a.getAttribute('aria-label')).toBe(en.pop_open_app);
      expect(a.target).toBe('_blank');
      expect(a.rel).toBe('noopener noreferrer');
      expect(a.previousElementSibling!.classList.contains('state')).toBe(true);
    });
    it('absent when not connected or the origin is unsafe', async () => {
      await mount({ connected: false, tenantName: null, needsReauth: false, tenantOrigin: '', locale: 'en' });
      expect($('a.open-app')).toBeNull();
      await mount({ ...INFO, tenantOrigin: 'javascript:alert(1)' });
      expect($('a.open-app')).toBeNull();
    });
  });

  describe('reminders', () => {
    const ON = { ...INFO, reminders: { allowed: true } };
    it('offered when the admin allows it and the permission is missing; the click requests notifications and syncs', async () => {
      await mount(ON);
      expect($('.reminders')!.textContent).toContain(en.pop_reminders_body);
      ($('.reminders-on') as HTMLButtonElement).click();
      expect(request).toHaveBeenCalledWith({ permissions: ['notifications'] });
      await flush();
      expect(send).toHaveBeenCalledWith({ type: 'reminders-sync' });
      expect($('.reminders')).toBeNull();
    });
    it('a denied request keeps the card with a note and re-enables the button', async () => {
      request = vi.fn(async () => false);
      await mount(ON);
      ($('.reminders-on') as HTMLButtonElement).click();
      await flush();
      expect($('.reminders .extra-status')!.textContent).toBe(en.pop_reminders_denied);
      expect(($('.reminders-on') as HTMLButtonElement).disabled).toBe(false);
      expect(send).not.toHaveBeenCalledWith({ type: 'reminders-sync' });
    });
    it('hidden when the admin has not allowed it, or once granted', async () => {
      await mount();
      expect($('.reminders')).toBeNull();
      await mount({ ...INFO, reminders: { allowed: false } });
      expect($('.reminders')).toBeNull();
      remindersGranted = true;
      await mount(ON);
      expect($('.reminders')).toBeNull();
    });
  });
});

describe('popup activity disclosure', () => {
  const mountWith = async (stored: unknown, signals: unknown = { ok: true, data: DATA }) => {
    const store: Record<string, unknown> = { popupActivityOpen: stored };
    const set = vi.fn(async (k: string, v: unknown) => { store[k] = v; });
    send = vi.fn(async (m: { type: string }) => (m.type === 'popup-info' ? INFO : m.type === 'me-signals' ? signals : undefined));
    document.body.replaceChildren();
    await run(document, { ...deps(), prefs: { get: async (k) => store[k], set } });
    await flush();
    return { store, set };
  };
  const toggle = (): HTMLButtonElement => $('.activity-toggle') as HTMLButtonElement;
  it('is collapsed by default with an accessible toggle', async () => {
    await mount();
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(toggle().getAttribute('aria-controls')).toBe('activity-content');
    expect(($('#activity-content') as HTMLElement).hidden).toBe(true);
    expect(toggle().textContent).toContain(en.pop_heading);
    expect(($('footer') as HTMLElement).hidden).toBe(false);
    expect($('footer .device')).not.toBeNull();
  });
  it('summarizes the week for N, 1 and 0 signals', async () => {
    await mount();
    expect($('.activity-summary')!.textContent).toBe(en.pop_summary_week.replace('{n}', '4'));
    await mount(INFO, { ok: true, data: { ...DATA, signals: DATA.signals.slice(0, 1) } });
    expect($('.activity-summary')!.textContent).toBe(en.pop_summary_week_one);
    await mount(INFO, { ok: true, data: { ...DATA, signals: [] } });
    expect($('.activity-summary')!.textContent).toBe(en.pop_summary_week_none);
  });
  it('keeps describing this week after switching period', async () => {
    await mount();
    send.mockImplementation(async (m: { type: string }) => (m.type === 'me-signals' ? { ok: true, data: { ...DATA, signals: [] } } : undefined));
    (document.querySelector('button[data-days="30"]') as HTMLButtonElement).click();
    await flush();
    expect($('.activity-summary')!.textContent).toBe(en.pop_summary_week.replace('{n}', '4'));
  });
  it('expanding shows the list and persists; reopening restores it', async () => {
    const { store, set } = await mountWith(undefined);
    toggle().click();
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(($('#activity-content') as HTMLElement).hidden).toBe(false);
    expect($('#activity-content [data-day] li')).not.toBeNull();
    expect(set).toHaveBeenCalledWith('popupActivityOpen', true);
    const again = await mountWith(store['popupActivityOpen']);
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    toggle().click();
    expect(again.set).toHaveBeenLastCalledWith('popupActivityOpen', false);
  });
  it('falls back to closed when storage fails', async () => {
    send = vi.fn(async (m: { type: string }) => (m.type === 'popup-info' ? INFO : m.type === 'me-signals' ? { ok: true, data: DATA } : undefined));
    document.body.replaceChildren();
    await run(document, { ...deps(), prefs: { get: async () => { throw new Error('x'); }, set: async () => { throw new Error('y'); } } });
    await flush();
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    toggle().click();
    await flush();
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
  });
});
