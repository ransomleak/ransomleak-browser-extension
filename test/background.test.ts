import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IDBFactory } from 'fake-indexeddb';
import { installChrome, sendMessage, type ChromeStub } from './chrome-stub.ts';

const API = 'https://app.ransomleak.com';
const EU = 'https://app.eu.ransomleak.com';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WARNING = 'chrome-extension://extid/src/warning/warning.html';

const AUTH = {
  token: 'tok', refreshToken: 'rt', expiresAt: '2099-01-01T00:00:00Z', tenant: 'acme', tenantName: 'Acme',
  tenantOrigin: 'https://acme.ransomleak.com', apiBaseUrl: API, locale: 'en', userId: 'u-a',
};
const POLICY = {
  version: '1:abc',
  detectors: { lookalike: 'warn', nrd: 'warn', oauth: 'warn' },
  protected: { domains: ['acme.com'], brands: ['microsoft'] },
  brandOwners: { microsoft: ['microsoft.com'] }, singleTenantOwners: [], allowDomains: [],
  approvedOAuthAppIds: [], riskyScopes: {}, sharedHosting: [], knownBad: ['evil-known.com'],
  nrd: { version: 'v1', url: 'https://cdn.ransomleak.com/nrd/v1.rlbf' },
  jit: { 'browser.lookalike_visit': { exerciseId: 'ex-42', title: 'Spot fake logins' } }, hrsEnabled: true,
};
const ENROLL_RES = { ...AUTH, token: 'newtok', refreshToken: 'newrt', locale: 'de' };

type Call = { url: string; init: RequestInit };
let calls: Call[];
let routes: Record<string, (init: RequestInit) => Response | Promise<Response>>;
const json = (b: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json', ...headers } });
const body = (c: Call): any => JSON.parse(String(c.init.body));
const callsTo = (p: string): Call[] => calls.filter((c) => c.url.endsWith(p) || c.url.includes(p + '?'));

let chrome: ChromeStub;

async function boot(opts: { managed?: Record<string, unknown>; local?: Record<string, unknown> } = {}) {
  vi.resetModules();
  chrome = installChrome({ managed: opts.managed });
  chrome.storage.local.reset(opts.local ?? {});
  const mod = await import('../src/background/index.ts');
  await mod.ready;
  return mod;
}

const STATE = 'S'.repeat(43);
/** Seeds a pending bind state, as openBind would, and adds it to the message. */
function arm(m: Record<string, unknown>): Record<string, unknown> {
  chrome.storage.session.dump['pendingBind'] = { state: STATE, createdAt: Date.now() };
  return { ...m, state: STATE };
}

const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };

async function idbBloom(): Promise<unknown> {
  const { idbGet } = await import('../src/background/idb.ts');
  return idbGet('nrdBloom');
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  calls = [];
  routes = {
    '/api/browser-ext/events': (init) => {
      const evs = JSON.parse(String(init.body)).events as { id: string }[];
      return json({ accepted: evs.length, rejected: [] });
    },
    '/api/browser-ext/heartbeat': () => new Response(null, { status: 204 }),
    '/api/browser-ext/policy': () => json(POLICY, 200, { etag: '"p1"' }),
    '/api/browser-ext/domain-age': () => json({ ageDays: null }),
    '/api/browser-ext/enroll': () => json(ENROLL_RES),
    '/api/browser-ext/token/refresh': () => json(ENROLL_RES),
    '/api/browser-ext/block-requests': () => new Response(null, { status: 201 }),
    'nrd/v1.rlbf': () => new Response(readFileSync(join(process.cwd(), 'test/fixtures/sample.rlbf'))),
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const key = Object.keys(routes).find((k) => String(url).split('?')[0]!.endsWith(k));
    if (!key) return new Response('nf', { status: 404 });
    return routes[key]!(init);
  }));
});
afterEach(async () => {
  await settle();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const nav = (url: string, extra: Record<string, unknown> = {}) =>
  Promise.all(chrome.webNavigation.onCommitted.dispatch({ tabId: 7, frameId: 0, url, transitionType: 'link', ...extra }));
const fromWarning = { id: 'extid', url: `${WARNING}?d=x`, tab: { id: 7 } };
const fromPopup = { id: 'extid', url: 'chrome-extension://extid/src/popup/popup.html' };
const queue = (): any[] => (chrome.storage.local.dump['queue'] as any[]) ?? [];
const bound = { auth: AUTH, policy: POLICY, etag: '"p1"', deviceId: 'dev-1' };

describe('popup messages', () => {
  const SIG = { signals: [], device: { lastSeenAt: '2026-10-21T00:00:00Z', extVersion: '0.1.0' }, aiAttribution: false };
  it('popup-info reports state without opening the bind page', async () => {
    await boot();
    expect(await sendMessage(chrome.runtime.onMessage, { type: 'popup-info' }, fromPopup)).toEqual({ connected: false, tenantName: null, needsReauth: false, disconnected: null, tenantOrigin: '', locale: 'en', extra: { downloads: 'warn', aiPaste: 'off' }, todo: null, reminders: { allowed: false }, links: { todo: '/app/campaigns', training: '/app/microlearning' } });
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    await boot({ local: bound });
    expect(await sendMessage(chrome.runtime.onMessage, { type: 'popup-info' }, fromPopup)).toEqual({ connected: true, tenantName: 'Acme', needsReauth: false, disconnected: null, tenantOrigin: 'https://acme.ransomleak.com', locale: 'en', extra: { downloads: 'warn', aiPaste: 'off' }, todo: null, reminders: { allowed: false }, links: { todo: '/app/campaigns', training: '/app/microlearning' } });
  });
  it('bind-start opens the bind page on demand, even right after an earlier open', async () => {
    await boot();
    await sendMessage(chrome.runtime.onMessage, { type: 'bind-start' }, fromPopup);
    await sendMessage(chrome.runtime.onMessage, { type: 'bind-start' }, fromPopup);
    expect(chrome.tabs.create).toHaveBeenCalledTimes(2);
    expect(await sendMessage(chrome.runtime.onMessage, { type: 'status' }, fromPopup)).toBeUndefined(); // removed handler
  });
  it('drops legacy local-day AI usage buckets on start, keeps UTC ones', async () => {
    await boot({ local: { ...bound, aiUsage: { '2026-10-01': { claude: 1 } }, aiUsageUtc: { '2026-10-02': { claude: 2 } } } });
    expect(chrome.storage.local.dump['aiUsage']).toBeUndefined();
    expect(chrome.storage.local.dump['aiUsageUtc']).toEqual({ '2026-10-02': { claude: 2 } });
  });
  it('me-dismiss-recommendation POSTs the dismiss for a valid id only, from extension pages only', async () => {
    const id = '11111111-2222-4333-8444-555555555555';
    routes[`/api/browser-ext/me/recommendations/${id}/dismiss`] = () => new Response(null, { status: 204 });
    await boot({ local: bound });
    expect(await sendMessage(chrome.runtime.onMessage, { type: 'me-dismiss-recommendation', exerciseId: id }, fromPopup)).toEqual({ ok: true });
    const c = callsTo(`/api/browser-ext/me/recommendations/${id}/dismiss`);
    expect(c).toHaveLength(1);
    expect(c[0]!.init.method).toBe('POST');
    expect(await sendMessage(chrome.runtime.onMessage, { type: 'me-dismiss-recommendation', exerciseId: '../x' }, fromPopup)).toEqual({ ok: false });
    expect(await sendMessage(chrome.runtime.onMessage, { type: 'me-dismiss-recommendation', exerciseId: id }, { id: 'extid', url: 'https://evil.com/', tab: { id: 1 } })).toBeUndefined();
    expect(callsTo('/dismiss')).toHaveLength(1);
  });
  it('me-signals proxies the authenticated GET with a validated period', async () => {
    routes['/api/browser-ext/me/signals'] = () => json(SIG);
    await boot({ local: bound });
    for (const days of [7, 30, 90, 'all']) {
      expect(await sendMessage(chrome.runtime.onMessage, { type: 'me-signals', days }, fromPopup)).toEqual({ ok: true, data: SIG });
    }
    const c = callsTo('/api/browser-ext/me/signals');
    expect(c.map((x) => x.url)).toEqual([7, 30, 90, 'all'].map((d) => `${API}/api/browser-ext/me/signals?days=${d}`));
    expect((c[0]!.init.headers as Record<string, string>)['authorization']).toBe('Bearer tok');
    expect(await sendMessage(chrome.runtime.onMessage, { type: 'me-signals', days: '7&x=1' }, fromPopup)).toEqual({ ok: false, reason: 'bad-request' });
    expect(callsTo('/api/browser-ext/me/signals')).toHaveLength(4);
  });
  it('me-signals refuses senders that are not extension pages, and fails soft offline/unbound', async () => {
    routes['/api/browser-ext/me/signals'] = () => json(SIG);
    await boot({ local: bound });
    expect(await sendMessage(chrome.runtime.onMessage, { type: 'me-signals', days: 7 }, { id: 'extid', url: 'https://evil.com/', tab: { id: 1 } })).toBeUndefined();
    routes['/api/browser-ext/me/signals'] = () => new Response('x', { status: 503 });
    expect(await sendMessage(chrome.runtime.onMessage, { type: 'me-signals', days: 7 }, fromPopup)).toEqual({ ok: false, reason: 'http-503' });
    await boot();
    expect(await sendMessage(chrome.runtime.onMessage, { type: 'me-signals', days: 7 }, fromPopup)).toEqual({ ok: false, reason: 'unauthenticated' });
  });
  it('a 401 on me-signals goes through refresh like every other call', async () => {
    let n = 0;
    routes['/api/browser-ext/me/signals'] = () => (n++ === 0 ? new Response('no', { status: 401 }) : json(SIG));
    await boot({ local: bound });
    expect(await sendMessage(chrome.runtime.onMessage, { type: 'me-signals', days: 7 }, fromPopup)).toEqual({ ok: true, data: SIG });
    expect(callsTo('/api/browser-ext/token/refresh')).toHaveLength(1);
  });
});

describe('enrollment', () => {
  it('reads storage.managed; managed values drive the bind tab and enroll', async () => {
    await boot({ managed: { tenantSubdomain: 'acme', apiBaseUrl: EU, enrollmentToken: 'et-1' } });
    await sendMessage(chrome.runtime.onMessage, { type: 'bind-start' }, fromPopup);
    expect(chrome.storage.managed.get).toHaveBeenCalled();
    const url = new URL(chrome.tabs.create.mock.calls[0]![0].url!);
    expect(url.origin + url.pathname).toBe(`${EU}/app/browser-extension/bind`);
    expect(url.searchParams.get('tenant')).toBe('acme');
    expect(url.searchParams.get('ext')).toBe('extid');
    await sendMessage(chrome.runtime.onMessageExternal, arm({ type: 'bind', code: 'c0de' }), { origin: EU, url: `${EU}/app/browser-extension/bind` });
    const e = callsTo('/api/browser-ext/enroll')[0]!;
    expect(e.url).toBe(`${EU}/api/browser-ext/enroll`);
    expect(body(e)).toMatchObject({ code: 'c0de', managed: true, enrollmentToken: 'et-1', extVersion: '0.1.0' });
  });
  it('without managed values, bind-start opens the US bind page', async () => {
    await boot();
    expect(await sendMessage(chrome.runtime.onMessage, { type: 'bind-start' }, fromPopup)).toEqual({ ok: true });
    expect(chrome.tabs.create).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.create.mock.calls[0]![0].url).toMatch(/^https:\/\/app\.ransomleak\.com\/app\/browser-extension\/bind\?/);
  });
  it('bind state handshake: missing, wrong, expired and replayed states are rejected without a backend call', async () => {
    await boot();
    const ext = chrome.runtime.onMessageExternal;
    const from = { origin: API };
    expect(await sendMessage(ext, { type: 'bind', code: 'c' }, from)).toMatchObject({ ok: false });
    expect(await sendMessage(ext, { type: 'bind', code: 'c', state: STATE }, from)).toEqual({ ok: false, reason: 'no_pending_connect' }); // no pending bind
    await sendMessage(chrome.runtime.onMessage, { type: 'bind-start' }, fromPopup);
    const state = new URL(chrome.tabs.create.mock.calls[0]![0].url!).searchParams.get('state')!;
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await sendMessage(ext, { type: 'bind', code: 'c', state: state.slice(0, -1) + (state.endsWith('A') ? 'B' : 'A') }, from)).toMatchObject({ ok: false });
    chrome.storage.session.dump['pendingBind'] = { state, createdAt: Date.now() - 11 * 60_000 };
    expect(await sendMessage(ext, { type: 'bind', code: 'c', state }, from)).toMatchObject({ ok: false }); // expired
    expect(callsTo('/api/browser-ext/enroll')).toHaveLength(0);
    chrome.storage.session.dump['pendingBind'] = { state, createdAt: Date.now() };
    expect(await sendMessage(ext, { type: 'bind', code: 'c', state }, from)).toEqual({ ok: true });
    expect(body(callsTo('/api/browser-ext/enroll')[0]!)).toMatchObject({ code: 'c', state });
    expect(chrome.storage.session.dump['pendingBind']).toBeUndefined();
    expect(await sendMessage(ext, { type: 'bind', code: 'c', state }, from)).toMatchObject({ ok: false }); // replay
    expect(callsTo('/api/browser-ext/enroll')).toHaveLength(1);
  });
  it('an earlier bind tab still works after a second bind-start; one success clears every pending state', async () => {
    await boot();
    const ext = chrome.runtime.onMessageExternal;
    const from = { origin: API };
    await sendMessage(chrome.runtime.onMessage, { type: 'bind-start' }, fromPopup);
    await sendMessage(chrome.runtime.onMessage, { type: 'bind-start' }, fromPopup);
    const states = chrome.tabs.create.mock.calls.map((c) => new URL(c[0].url!).searchParams.get('state')!);
    expect(states).toHaveLength(2);
    expect(states[0]).not.toBe(states[1]);
    expect(await sendMessage(ext, { type: 'bind', code: 'c', state: states[0] }, from)).toEqual({ ok: true });
    expect(chrome.storage.session.dump['pendingBind']).toBeUndefined();
    expect(await sendMessage(ext, { type: 'bind', code: 'c', state: states[1] }, from)).toMatchObject({ ok: false });
    expect(callsTo('/api/browser-ext/enroll')).toHaveLength(1);
  });
  it('keeps at most three pending bind states', async () => {
    await boot();
    for (let i = 0; i < 5; i++) await sendMessage(chrome.runtime.onMessage, { type: 'bind-start' }, fromPopup);
    expect((chrome.storage.session.dump['pendingBind'] as unknown[]).length).toBe(3);
  });
  it('first install without a binding opens the bind page', async () => {
    await boot({ managed: { tenantSubdomain: 'acme' } });
    await Promise.all(chrome.runtime.onInstalled.dispatch({ reason: 'install' }));
    expect(new URL(chrome.tabs.create.mock.calls[0]![0].url!).searchParams.get('tenant')).toBe('acme');
  });
  it('ignores onMessageExternal from non-allowed origins', async () => {
    await boot();
    for (const origin of ['https://evil.com', 'https://app.ransomleak.com.evil.com', 'http://app.ransomleak.com', 'https://app.localhost:5172']) {
      const r = await sendMessage(chrome.runtime.onMessageExternal, arm({ type: 'bind', code: 'x' }), { origin, url: origin + '/app/browser-extension/bind' });
      expect(r).toBeUndefined();
    }
    expect(callsTo('/api/browser-ext/enroll')).toHaveLength(0);
  });
  it('allowed origin bind calls POST /enroll on that region and stores auth', async () => {
    await boot();
    const r = await sendMessage(chrome.runtime.onMessageExternal, arm({ type: 'bind', code: 'abc_123' }), { origin: EU, url: `${EU}/app/browser-extension/bind?x=1` });
    expect(r).toEqual({ ok: true });
    const e = callsTo('/api/browser-ext/enroll')[0]!;
    expect(e.url).toBe(`${EU}/api/browser-ext/enroll`);
    expect(body(e)).toMatchObject({ code: 'abc_123', managed: false, extVersion: '0.1.0' });
    expect(body(e).deviceId).toMatch(UUID_V4);
    expect(body(e)).not.toHaveProperty('enrollmentToken');
    const auth = chrome.storage.local.dump['auth'] as any;
    expect(auth).toMatchObject({ token: 'newtok', refreshToken: 'newrt', tenant: 'acme', tenantOrigin: 'https://acme.ransomleak.com', locale: 'de' });
    // apiBaseUrl from response (US) is in the allowed set but must match the binding region
    expect(auth.apiBaseUrl).toBe(EU);
  });
  it('rejects malformed codes and a managed region mismatch', async () => {
    await boot({ managed: { apiBaseUrl: EU } });
    expect(await sendMessage(chrome.runtime.onMessageExternal, arm({ type: 'bind', code: '<x>' }), { origin: EU })).toMatchObject({ ok: false });
    expect(await sendMessage(chrome.runtime.onMessageExternal, arm({ type: 'bind', code: 'ok' }), { origin: API })).toMatchObject({ ok: false });
    expect(callsTo('/api/browser-ext/enroll')).toHaveLength(0);
  });
  it('binding to another tenant drops the old tenant state before storing auth', async () => {
    routes['/api/browser-ext/enroll'] = () => json({ ...ENROLL_RES, tenant: 'other' });
    const q = [{ id: crypto.randomUUID(), signal: 'browser.lookalike_visit', domain: 'a-old.com', occurredAt: new Date().toISOString(), action: 'warned' }];
    await boot({ local: { ...bound, queue: q, throttle: { 'x.com': Date.now() }, 'nrd:x.com': { isNew: true, at: 1 }, consentMiss: { google: 1 } } });
    chrome.storage.session.dump['allow'] = { 'x.com': 'warn' };
    chrome.storage.session.dump['pending:7'] = {};
    chrome.storage.session.dump['oauthReq:7'] = { provider: 'google', clientId: 'c', scopes: ['email'], at: Date.now() };
    expect(await sendMessage(chrome.runtime.onMessageExternal, arm({ type: 'bind', code: 'b' }), { origin: API })).toEqual({ ok: true });
    await settle();
    const d = chrome.storage.local.dump;
    for (const k of ['queue', 'throttle', 'nrd:x.com', 'consentMiss', 'reported']) expect(Object.keys((d[k] as object) ?? {})).toEqual([]);
    expect(Object.keys(chrome.storage.session.dump).filter((k) => k !== 'bindOpenedAt')).toEqual([]);
    expect(JSON.stringify(callsTo('/api/browser-ext/events').map((c) => c.init.body))).not.toContain('a-old.com');
    expect((d['auth'] as any).tenant).toBe('other');
  });
  it('same tenant + a different user drops all per-user state; nothing of user A is sent with B\'s token', async () => {
    routes['/api/browser-ext/enroll'] = () => json({ ...ENROLL_RES, userId: 'u-b' });
    routes['/api/browser-ext/ai-usage'] = () => json({ accepted: 1 });
    const q = [{ id: crypto.randomUUID(), signal: 'browser.lookalike_visit', domain: 'a-old.com', occurredAt: new Date().toISOString(), action: 'warned' }];
    await boot({ local: { ...bound, queue: q, aiUsage: { '2026-10-01': { claude: 5 } }, aiUsageUtc: { '2026-10-01': { claude: 5 } }, aiSeen: { '1:claude': Date.now() }, throttle: { 'x.com': Date.now() }, consentThrottle: { a: Date.now() } } });
    chrome.storage.session.dump['allow'] = { 'x.com': 'warn' };
    chrome.storage.session.dump['lastSafe:7'] = 'https://x.com/';
    expect(await sendMessage(chrome.runtime.onMessageExternal, arm({ type: 'bind', code: 'b' }), { origin: API })).toEqual({ ok: true });
    await settle();
    const d = chrome.storage.local.dump;
    for (const k of ['queue', 'aiUsage', 'aiUsageUtc', 'aiSeen', 'throttle', 'consentThrottle', 'reported']) expect(Object.keys((d[k] as object) ?? {})).toEqual([]);
    expect(Object.keys(chrome.storage.session.dump).filter((k) => k !== 'bindOpenedAt')).toEqual([]);
    expect(JSON.stringify(callsTo('/api/browser-ext/events').map((c) => c.init.body))).not.toContain('a-old.com');
    expect(callsTo('/api/browser-ext/ai-usage')).toHaveLength(0);
    expect((d['auth'] as any).userId).toBe('u-b');
  });
  it('a same-user re-bind keeps the queue', async () => {
    routes['/api/browser-ext/events'] = () => json({ accepted: 0 }, 503);
    const q = [{ id: crypto.randomUUID(), signal: 'browser.lookalike_visit', domain: 'keep.com', occurredAt: new Date().toISOString(), action: 'warned' }];
    await boot({ local: { ...bound, queue: q } });
    expect(await sendMessage(chrome.runtime.onMessageExternal, arm({ type: 'bind', code: 'b' }), { origin: API })).toEqual({ ok: true });
    await settle();
    expect((chrome.storage.local.dump['queue'] as unknown[]).length).toBe(1);
    expect((chrome.storage.local.dump['auth'] as any).userId).toBe('u-a');
  });
  it('managed tenantSubdomain rejects a bind to another tenant', async () => {
    routes['/api/browser-ext/enroll'] = () => json({ ...ENROLL_RES, tenant: 'other' });
    await boot({ managed: { tenantSubdomain: 'acme' } });
    expect(await sendMessage(chrome.runtime.onMessageExternal, arm({ type: 'bind', code: 'b' }), { origin: API })).toMatchObject({ ok: false });
    expect(chrome.storage.local.dump['auth']).toBeUndefined();
  });
  it('popup-info reports connection', async () => {
    await boot({ local: bound });
    expect(await sendMessage(chrome.runtime.onMessage, { type: 'popup-info' }, fromPopup)).toMatchObject({ connected: true, tenantName: 'Acme', needsReauth: false });
  });
});

describe('navigation', () => {
  it('a lookalike redirects to warning.html?d=&k= and queues lookalike_visit warned; second hit in 24h does neither', async () => {
    routes['/api/browser-ext/events'] = () => new Response('down', { status: 503 });
    await boot({ local: bound });
    await nav('https://acrne.com/login?user=bob');
    expect(chrome.tabs.update).toHaveBeenCalledWith(7, { url: `${WARNING}?d=acrne.com&k=tenant` });
    expect(queue()).toHaveLength(1);
    expect(queue()[0]).toMatchObject({ signal: 'browser.lookalike_visit', domain: 'acrne.com', action: 'warned' });
    expect(queue()[0]).not.toHaveProperty('value');
    expect(Object.keys(queue()[0]).sort()).toEqual(['action', 'domain', 'id', 'occurredAt', 'signal']);
    await nav('https://www.acrne.com/other');
    expect(chrome.tabs.update).toHaveBeenCalledTimes(1);
    expect(queue()).toHaveLength(1);
  });
  it('brand lookalike carries value brand', async () => {
    routes['/api/browser-ext/events'] = () => new Response('down', { status: 503 });
    await boot({ local: bound });
    await nav('https://micros0ft-login.xyz/');
    await nav('https://rnicrosoft.com/');
    expect(queue().at(-1)).toMatchObject({ signal: 'browser.lookalike_visit', value: 'brand', domain: 'rnicrosoft.com' });
  });
  it('only frameId 0, http(s), non-extension, non-tenant navigations are evaluated', async () => {
    await boot({ local: bound });
    await nav('https://acrne.com/', { frameId: 3 });
    await nav('ftp://acrne.com/');
    await nav(`${WARNING}?d=acrne.com`);
    await nav('https://acme.ransomleak.com/dashboard');
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(queue()).toHaveLength(0);
  });
  it('Continue anyway queues warning_overridden, adds a session allow and resumes', async () => {
    routes['/api/browser-ext/events'] = () => new Response('down', { status: 503 });
    await boot({ local: bound });
    await nav('https://acrne.com/a');
    const info = (await sendMessage(chrome.runtime.onMessage, { type: 'warning-info' }, fromWarning)) as any;
    expect(info).toMatchObject({ domain: 'acrne.com', kind: 'tenant', mode: 'warn', highlight: [0, 5], locale: 'en', lesson: expect.objectContaining({ course: true }) });
    await sendMessage(chrome.runtime.onMessage, { type: 'warning-action', action: 'continue' }, fromWarning);
    expect(queue().at(-1)).toMatchObject({ signal: 'browser.warning_overridden', domain: 'acrne.com', action: 'proceeded' });
    expect(chrome.storage.session.dump['allow']).toEqual({ 'acrne.com': 'warn' });
    expect(chrome.tabs.update).toHaveBeenLastCalledWith(7, { url: 'https://acrne.com/a' });
    chrome.storage.local.dump['throttle'] = {}; // even without the throttle, the allow suppresses
    await nav('https://acrne.com/a');
    expect(chrome.tabs.update).toHaveBeenCalledTimes(2);
  });
  it('block mode: no Continue; queues blocked; continue is refused; request posts block-requests', async () => {
    routes['/api/browser-ext/events'] = () => new Response('down', { status: 503 });
    await boot({ local: { ...bound, policy: { ...POLICY, detectors: { ...POLICY.detectors, lookalike: 'block' } } } });
    await nav('https://acrne.com/');
    expect(queue()[0]).toMatchObject({ action: 'blocked' });
    const info = (await sendMessage(chrome.runtime.onMessage, { type: 'warning-info' }, fromWarning)) as any;
    expect(info.mode).toBe('block');
    await sendMessage(chrome.runtime.onMessage, { type: 'warning-action', action: 'continue' }, fromWarning);
    expect(chrome.storage.session.dump['allow']).toBeUndefined();
    expect(queue()).toHaveLength(1);
    await sendMessage(chrome.runtime.onMessage, { type: 'warning-action', action: 'request' }, fromWarning);
    expect(body(callsTo('/api/browser-ext/block-requests')[0]!)).toEqual({ kind: 'domain', target: 'acrne.com' });
  });
  it('Go back navigates to the last safe URL, else about:blank; Learn opens the tenant microlearning', async () => {
    await boot({ local: bound });
    await nav('https://news.example.org/story');
    await nav('https://acrne.com/');
    await sendMessage(chrome.runtime.onMessage, { type: 'warning-action', action: 'back' }, fromWarning);
    expect(chrome.tabs.update).toHaveBeenLastCalledWith(7, { url: 'https://news.example.org/story' });
    await sendMessage(chrome.runtime.onMessage, { type: 'warning-action', action: 'learn' }, fromWarning);
    expect(chrome.tabs.create).toHaveBeenLastCalledWith({ url: 'https://acme.ransomleak.com/app/microlearning?highlight=ex-42' });
    await nav('https://acrne.net/', { tabId: 9 });
    await sendMessage(chrome.runtime.onMessage, { type: 'warning-action', action: 'back' }, { ...fromWarning, tab: { id: 9 } });
    expect(chrome.tabs.update).toHaveBeenLastCalledWith(9, { url: 'about:blank' });
  });
  it('hides Learn when the stored tenant origin is not https', async () => {
    await boot({ local: { ...bound, auth: { ...AUTH, tenantOrigin: 'http://acme.ransomleak.com' } } });
    await nav('https://acrne.com/');
    const info = (await sendMessage(chrome.runtime.onMessage, { type: 'warning-info' }, fromWarning)) as { lesson: { course: boolean } };
    expect(info.lesson.course).toBe(false);
  });
  it('warning messages from other senders are ignored', async () => {
    await boot({ local: bound });
    await nav('https://acrne.com/');
    const r = await sendMessage(chrome.runtime.onMessage, { type: 'warning-action', action: 'continue' }, { id: 'extid', url: 'https://acrne.com/', tab: { id: 7 } });
    expect(r).toBeUndefined();
    expect(chrome.storage.session.dump['allow']).toBeUndefined();
  });
  it('NRD alone only counts locally; NRD + lookalike adds risky_domain_visit; known-bad warns', async () => {
    routes['/api/browser-ext/events'] = () => new Response('down', { status: 503 });
    routes['/api/browser-ext/domain-age'] = () => json({ ageDays: 3 });
    await boot({ local: bound });
    await settle();
    const domains = readFileSync(join(process.cwd(), 'test/fixtures/sample-domains.txt'), 'utf8').split(/\s+/).filter(Boolean);
    const plain = domains.find((d) => !d.includes('acme') && !d.includes('micro'))!;
    const before = calls.length;
    await nav(`https://${plain}/`);
    await settle();
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(queue()).toHaveLength(0);
    expect(chrome.storage.local.dump['nrdBloomHitsUnconfirmed']).toBe(1);
    expect(calls.length).toBe(before); // a bare bloom hit makes no network call
    expect(callsTo('/api/browser-ext/domain-age')).toHaveLength(0);
    await nav('https://evil-known.com/');
    expect(queue()[0]).toMatchObject({ signal: 'browser.risky_domain_visit', value: 'brand_watch', domain: 'evil-known.com', action: 'warned' });
    expect(chrome.tabs.update).toHaveBeenLastCalledWith(7, { url: `${WARNING}?d=evil-known.com&k=watch` });
  });
  it('skips the NRD check for shared-hosting subdomains (no domain-age lookup, no risky_domain_visit)', async () => {
    routes['/api/browser-ext/events'] = () => new Response('down', { status: 503 });
    routes['/api/browser-ext/domain-age'] = () => json({ ageDays: 3 });
    const domains = readFileSync(join(process.cwd(), 'test/fixtures/sample-domains.txt'), 'utf8').split(/\s+/).filter(Boolean);
    const plain = domains.find((d) => !d.includes('acme') && !d.includes('micro'))!;
    await boot({ local: { ...bound, policy: { ...POLICY, sharedHosting: [plain] } } });
    await settle();
    await nav(`https://acme-login.${plain}/`);
    await settle();
    expect(callsTo('/api/browser-ext/domain-age')).toHaveLength(0);
    expect(queue().some((e: any) => e.signal === 'browser.risky_domain_visit')).toBe(false);
  });
  it('a warn-mode allow does not bypass block mode; a policy change clears allows', async () => {
    routes['/api/browser-ext/events'] = () => new Response('down', { status: 503 });
    await boot({ local: bound });
    await nav('https://acrne.com/a');
    await sendMessage(chrome.runtime.onMessage, { type: 'warning-action', action: 'continue' }, fromWarning);
    chrome.storage.local.dump['policy'] = { ...POLICY, detectors: { ...POLICY.detectors, lookalike: 'block' } };
    await nav('https://acrne.com/a');
    expect(chrome.tabs.update).toHaveBeenLastCalledWith(7, { url: `${WARNING}?d=acrne.com&k=tenant` });
    await Promise.all(chrome.alarms.onAlarm.dispatch({ name: 'policy' }));
    expect(chrome.storage.session.dump['allow']).toBeUndefined();
  });
  it('a flagged-but-throttled URL is never recorded as the last safe page', async () => {
    routes['/api/browser-ext/events'] = () => new Response('down', { status: 503 });
    await boot({ local: bound });
    await nav('https://news.example.org/story');
    await nav('https://acrne.com/1'); // warned
    await nav('https://acrne.com/2'); // throttled: no warning, but still flagged
    expect(chrome.storage.session.dump['lastSafe:7']).toBe('https://news.example.org/story');
    await nav('https://acrne.net/'); // next warning
    await sendMessage(chrome.runtime.onMessage, { type: 'warning-action', action: 'back' }, fromWarning);
    expect(chrome.tabs.update).toHaveBeenLastCalledWith(7, { url: 'https://news.example.org/story' });
  });
  it('block mode redirects on onBeforeNavigate; onCommitted for the same navigation does not double-act', async () => {
    routes['/api/browser-ext/events'] = () => new Response('down', { status: 503 });
    await boot({ local: { ...bound, policy: { ...POLICY, detectors: { ...POLICY.detectors, lookalike: 'block' } } } });
    await Promise.all(chrome.webNavigation.onBeforeNavigate.dispatch({ tabId: 7, frameId: 0, url: 'https://acrne.com/x' }));
    await settle();
    expect(chrome.tabs.update).toHaveBeenCalledWith(7, { url: `${WARNING}?d=acrne.com&k=tenant` });
    expect(queue()).toHaveLength(1);
    await nav('https://acrne.com/x');
    await settle();
    expect(chrome.tabs.update).toHaveBeenCalledTimes(1);
    expect(queue()).toHaveLength(1);
    await Promise.all(chrome.webNavigation.onBeforeNavigate.dispatch({ tabId: 7, frameId: 2, url: 'https://acrne.net/' }));
    await settle();
    expect(chrome.tabs.update).toHaveBeenCalledTimes(1);
  });
  it('warn mode ignores onBeforeNavigate and acts on commit', async () => {
    routes['/api/browser-ext/events'] = () => new Response('down', { status: 503 });
    await boot({ local: bound });
    await Promise.all(chrome.webNavigation.onBeforeNavigate.dispatch({ tabId: 7, frameId: 0, url: 'https://acrne.com/' }));
    await settle();
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(queue()).toHaveLength(0);
    await nav('https://acrne.com/');
    expect(chrome.tabs.update).toHaveBeenCalledTimes(1);
    expect(queue()).toHaveLength(1);
  });
  it('prerendered navigations are ignored; active ones act normally', async () => {
    routes['/api/browser-ext/events'] = () => new Response('down', { status: 503 });
    await boot({ local: { ...bound, policy: { ...POLICY, detectors: { ...POLICY.detectors, lookalike: 'block' } } } });
    for (const lc of ['prerender', 'cached', 'pending_deletion']) {
      await Promise.all(chrome.webNavigation.onBeforeNavigate.dispatch({ tabId: 7, frameId: 0, url: 'https://acrne.com/', documentLifecycle: lc }));
      await nav('https://acrne.com/', { documentLifecycle: lc });
    }
    await settle();
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(queue()).toHaveLength(0);
    await nav('https://acrne.com/', { documentLifecycle: 'active' });
    expect(chrome.tabs.update).toHaveBeenCalledTimes(1);
    expect(queue()).toHaveLength(1);
  });
  it('log mode queues action logged without redirecting', async () => {
    routes['/api/browser-ext/events'] = () => new Response('down', { status: 503 });
    await boot({ local: { ...bound, policy: { ...POLICY, detectors: { ...POLICY.detectors, lookalike: 'log' } } } });
    await nav('https://acrne.com/');
    expect(queue()[0]).toMatchObject({ action: 'logged' });
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });
  it('policy sharedHosting and singleTenantOwners take effect', async () => {
    routes['/api/browser-ext/events'] = () => new Response('down', { status: 503 });
    await boot({ local: { ...bound, policy: { ...POLICY, sharedHosting: ['acmehost.io'], protected: { domains: ['acme.com'], brands: ['microsoft'] }, brandOwners: { microsoft: ['microsoft.com', 'msft.net'] }, singleTenantOwners: ['msft.net'] } } });
    await nav('https://acrne.acmehost.io/');
    expect(queue()[0]).toMatchObject({ domain: 'acrne.acmehost.io' });
    await nav('https://login.msft.net/');
    expect(queue()).toHaveLength(1);
  });
  it('shared hosting reports the full host', async () => {
    routes['/api/browser-ext/events'] = () => new Response('down', { status: 503 });
    await boot({ local: bound });
    await nav('https://acrne.pages.dev/x?q=1');
    expect(queue()[0]).toMatchObject({ domain: 'acrne.pages.dev' });
  });
  it('prunes throttle entries older than 24h on startup', async () => {
    const now = Date.now();
    await boot({ local: { ...bound, throttle: { 'old.com': now - 25 * 3_600_000, 'new.com': now - 1000 } } });
    expect(chrome.storage.local.dump['throttle']).toEqual({ 'new.com': now - 1000 });
  });
});

describe('consent messages', () => {
  const fromConsent = { id: 'extid', url: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', tab: { id: 3 } };
  const info = { provider: 'microsoft', appName: 'x'.repeat(500), appId: 'a1', verified: false, scopes: ['Mail.ReadWrite'], scopeSource: 'url' };
  it('risky consent queues oauth_risky_consent_shown with provider value and registrable domain only', async () => {
    routes['/api/browser-ext/events'] = () => new Response('down', { status: 503 });
    await boot({ local: bound });
    await sendMessage(chrome.runtime.onMessage, { type: 'consent', info, risky: true }, fromConsent);
    expect(queue()).toHaveLength(1);
    expect(queue()[0]).toMatchObject({ signal: 'browser.oauth_risky_consent_shown', value: 'microsoft', domain: 'microsoftonline.com', action: 'warned' });
    expect(JSON.stringify(queue())).not.toContain('xxxx');
    expect(JSON.stringify(queue())).not.toContain('Mail');
    await sendMessage(chrome.runtime.onMessage, { type: 'consent', info: { ...info, provider: 'evil' }, risky: true }, fromConsent);
    await sendMessage(chrome.runtime.onMessage, { type: 'consent', info, risky: false }, fromConsent);
    expect(queue()).toHaveLength(1);
  });
  it('Continue anyway queues one proceeded event per app, warn mode only', async () => {
    routes['/api/browser-ext/events'] = () => new Response('down', { status: 503 });
    await boot({ local: bound });
    await sendMessage(chrome.runtime.onMessage, { type: 'consent-action', action: 'continue', info }, fromConsent);
    await sendMessage(chrome.runtime.onMessage, { type: 'consent-action', action: 'continue', info }, fromConsent);
    await sendMessage(chrome.runtime.onMessage, { type: 'consent-action', action: 'other', info: { ...info, appId: 'a2' } }, fromConsent);
    expect(queue()).toHaveLength(1);
    expect(queue()[0]).toMatchObject({ signal: 'browser.oauth_risky_consent_shown', value: 'microsoft', domain: 'microsoftonline.com', action: 'proceeded' });
    chrome.storage.local.dump['policy'] = { ...POLICY, detectors: { ...POLICY.detectors, oauth: 'block' } };
    await sendMessage(chrome.runtime.onMessage, { type: 'consent-action', action: 'continue', info: { ...info, appId: 'a3' } }, fromConsent);
    expect(queue()).toHaveLength(1);
  });
  it('oauth off queues nothing; block queues blocked', async () => {
    routes['/api/browser-ext/events'] = () => new Response('down', { status: 503 });
    await boot({ local: { ...bound, policy: { ...POLICY, detectors: { ...POLICY.detectors, oauth: 'off' } } } });
    await sendMessage(chrome.runtime.onMessage, { type: 'consent', info, risky: true }, fromConsent);
    expect(queue()).toHaveLength(0);
    chrome.storage.local.dump['policy'] = { ...POLICY, detectors: { ...POLICY.detectors, oauth: 'block' } };
    await sendMessage(chrome.runtime.onMessage, { type: 'consent', info: { ...info, appId: 'a2' }, risky: true }, fromConsent);
    expect(queue()[0]).toMatchObject({ action: 'blocked' });
  });
  it('block-request from the overlay posts oauth_app; consent-miss counts into the heartbeat', async () => {
    await boot({ local: bound });
    await sendMessage(chrome.runtime.onMessage, { type: 'block-request', kind: 'oauth_app', target: 'a1' }, fromConsent);
    expect(body(callsTo('/api/browser-ext/block-requests')[0]!)).toEqual({ kind: 'oauth_app', target: 'a1' });
    await sendMessage(chrome.runtime.onMessage, { type: 'block-request', kind: 'oauth_app', target: 'a2', label: `  Acme\u0007 ${'x'.repeat(300)}` }, fromConsent);
    const withLabel = body(callsTo('/api/browser-ext/block-requests')[1]!) as { label: string };
    expect(withLabel.label.startsWith('Acme x')).toBe(true);
    expect(withLabel.label.length).toBe(200);
    await sendMessage(chrome.runtime.onMessage, { type: 'consent-miss', provider: 'google' }, fromConsent);
    await sendMessage(chrome.runtime.onMessage, { type: 'consent-miss', provider: 'google' }, fromConsent);
    await sendMessage(chrome.runtime.onMessage, { type: 'consent-miss', provider: 'nope' }, fromConsent);
    expect(chrome.storage.local.dump['consentMiss']).toEqual({ google: 2 });
    calls = [];
    await Promise.all(chrome.alarms.onAlarm.dispatch({ name: 'heartbeat' }));
    expect(body(callsTo('/api/browser-ext/heartbeat')[0]!)).toMatchObject({ extVersion: '0.1.0', consentMiss: { google: 2 } });
  });
});

describe('OAuth request capture', () => {
  const req = (): any => chrome.storage.session.dump['oauthReq:7'];
  const G = 'https://accounts.google.com';
  it('captures Google scopes through the redirect chain and serves the scope-less v3 consent page', async () => {
    await boot({ local: bound });
    await Promise.all(chrome.webNavigation.onBeforeNavigate.dispatch({ tabId: 7, frameId: 0, url: `${G}/o/oauth2/v2/auth?client_id=407.apps&scope=https%3A%2F%2Fmail.google.com%2F%20email&response_type=code` }));
    expect(req()).toMatchObject({ provider: 'google', clientId: '407.apps', scopes: ['https://mail.google.com/', 'email'] });
    await nav(`${G}/v3/signin/accountchooser?client_id=407.apps&scope=https://mail.google.com/`);
    await nav(`${G}/signin/oauth/v3/consent?authuser=0&part=opaque&client_id=407.apps`);
    expect(req()).toMatchObject({ clientId: '407.apps', scopes: ['https://mail.google.com/'] });
    const sender = (url: string, id = 7) => ({ id: 'extid', url, tab: { id } });
    const consent = `${G}/signin/oauth/v3/consent?authuser=0&part=opaque&client_id=407.apps`;
    expect(await sendMessage(chrome.runtime.onMessage, { type: 'consent-request' }, sender(consent))).toMatchObject({ provider: 'google', clientId: '407.apps', scopes: ['https://mail.google.com/'] });
    expect(await sendMessage(chrome.runtime.onMessage, { type: 'consent-request' }, sender(consent.replace('407.apps', 'evil.apps')))).toBeNull();
    expect(await sendMessage(chrome.runtime.onMessage, { type: 'consent-request' }, sender(consent, 8))).toBeNull();
    expect(await sendMessage(chrome.runtime.onMessage, { type: 'consent-request' }, sender('https://slack.com/oauth/v2/authorize?client_id=407.apps'))).toBeNull();
    expect(JSON.stringify(calls.map((c) => [c.url, c.init.body]))).not.toContain('mail.google.com');
  });
  it('captures Microsoft v2 scope and v1 resource; a page without client_id accepts only a fresh entry', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await boot({ local: bound });
    await nav('https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=ms-1&scope=openid%20Mail.ReadWrite');
    expect(req()).toMatchObject({ provider: 'microsoft', clientId: 'ms-1', scopes: ['openid', 'Mail.ReadWrite'] });
    await nav('https://login.microsoftonline.com/contoso.com/oauth2/authorize?client_id=ms-2&resource=https%3A%2F%2Fgraph.microsoft.com');
    expect(req()).toMatchObject({ clientId: 'ms-2', scopes: ['https://graph.microsoft.com'] });
    const sender = { id: 'extid', url: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', tab: { id: 7 } };
    expect(await sendMessage(chrome.runtime.onMessage, { type: 'consent-request' }, sender)).toMatchObject({ clientId: 'ms-2' });
    vi.setSystemTime(Date.now() + 3 * 60_000);
    expect(await sendMessage(chrome.runtime.onMessage, { type: 'consent-request' }, sender)).toBeNull();
    const withId = { ...sender, url: sender.url + '?client_id=ms-2' };
    expect(await sendMessage(chrome.runtime.onMessage, { type: 'consent-request' }, withId)).toMatchObject({ clientId: 'ms-2' });
    vi.setSystemTime(Date.now() + 5 * 60_000);
    expect(await sendMessage(chrome.runtime.onMessage, { type: 'consent-request' }, withId)).toBeNull();
  });
  it('captures Slack scope and user_scope on slack.com and workspace hosts; ignores unrelated paths', async () => {
    await boot({ local: bound });
    await nav('https://slack.com/oauth/v2/authorize?client_id=1.2&scope=channels:history,chat:write&user_scope=files:read');
    expect(req()).toMatchObject({ provider: 'slack', clientId: '1.2', scopes: ['channels:history', 'chat:write', 'user:files:read'] });
    await nav('https://acme.slack.com/oauth?client_id=3.4&scope=chat:write');
    expect(req()).toMatchObject({ clientId: '3.4', scopes: ['chat:write'] });
    await nav('https://acme.slack.com/messages/C1?client_id=9&scope=admin');
    expect(req()).toMatchObject({ clientId: '3.4' });
  });
  it('a missing client_id on either side replaces the entry instead of merging', async () => {
    await boot({ local: bound });
    await nav('https://accounts.google.com/o/oauth2/v2/auth?client_id=a.apps&scope=email');
    await nav('https://accounts.google.com/o/oauth2/v2/auth?scope=https://mail.google.com/');
    expect(req()).toMatchObject({ clientId: null, scopes: ['https://mail.google.com/'] });
    await nav('https://accounts.google.com/signin/oauth/v3/consent?client_id=b.apps');
    expect(req()).toMatchObject({ clientId: 'b.apps', scopes: [] });
  });
  it('navigating to a non-provider host clears the entry', async () => {
    await boot({ local: bound });
    await nav('https://slack.com/oauth/v2/authorize?client_id=1.2&scope=chat:write');
    await nav('https://evil.example/oauth/v2/authorize?client_id=9&scope=admin');
    expect(req()).toBeUndefined();
  });
  it('forgetTab (tab closed) clears the entry', async () => {
    await boot({ local: bound });
    await nav('https://slack.com/oauth/v2/authorize?client_id=1.2&scope=chat:write');
    expect(req()).toBeTruthy();
    await Promise.all(chrome.tabs.onRemoved.dispatch(7));
    await settle();
    expect(req()).toBeUndefined();
  });
});

describe('event queue', () => {
  it('queues while offline and caps at 1000', async () => {
    routes['/api/browser-ext/events'] = () => { throw new TypeError('Failed to fetch'); };
    const old = Array.from({ length: 1000 }, (_, i) => ({ id: `old-${i}`, signal: 'browser.lookalike_visit', domain: 'a.com', occurredAt: '2026-01-01T00:00:00Z', action: 'warned' }));
    await boot({ local: { ...bound, queue: old } });
    await nav('https://acrne.com/');
    await settle();
    expect(queue()).toHaveLength(1000);
    expect(queue()[0].id).toBe('old-1');
    expect(queue().at(-1).domain).toBe('acrne.com');
  });
  it('flush sends at most 100 per call with a uuid v4 idempotency key per event, and records reported', async () => {
    const old = Array.from({ length: 250 }, (_, i) => ({ id: crypto.randomUUID(), signal: 'browser.lookalike_visit', domain: `d${i}.com`, occurredAt: new Date().toISOString(), action: 'warned' }));
    await boot({ local: { ...bound, queue: old } });
    await Promise.all(chrome.alarms.onAlarm.dispatch({ name: 'flush' }));
    await settle();
    const sent = callsTo('/api/browser-ext/events');
    expect(sent.map((c) => body(c).events.length)).toEqual([100, 100, 50]);
    for (const c of sent) {
      expect((c.init.headers as Record<string, string>)['authorization']).toBe('Bearer tok');
      for (const e of body(c).events) expect(e.id).toMatch(UUID_V4);
    }
    expect(queue()).toHaveLength(0);
    expect((chrome.storage.local.dump['reported'] as unknown[]).length).toBe(250);
  });
  it('new events get uuid v4 ids', async () => {
    routes['/api/browser-ext/events'] = () => new Response('down', { status: 503 });
    await boot({ local: bound });
    await nav('https://acrne.com/');
    expect(queue()[0].id).toMatch(UUID_V4);
    expect(queue()[0].occurredAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  });
  it('401 pauses the queue and flags reauth after one refresh attempt; no retries until re-bind', async () => {
    routes['/api/browser-ext/events'] = () => new Response('no', { status: 401 });
    routes['/api/browser-ext/token/refresh'] = () => new Response('no', { status: 401 });
    const q = [{ id: crypto.randomUUID(), signal: 'browser.lookalike_visit', domain: 'a.com', occurredAt: '2026-10-01T00:00:00Z', action: 'warned' }];
    await boot({ local: { ...bound, queue: q } });
    await Promise.all(chrome.alarms.onAlarm.dispatch({ name: 'flush' }));
    await settle();
    expect(callsTo('/api/browser-ext/token/refresh')).toHaveLength(1);
    expect(body(callsTo('/api/browser-ext/token/refresh')[0]!)).toEqual({ refreshToken: 'rt' });
    expect((chrome.storage.local.dump['auth'] as any).needsReauth).toBe(true);
    expect(queue()).toHaveLength(1);
    const n = calls.length;
    await Promise.all(chrome.alarms.onAlarm.dispatch({ name: 'flush' }));
    await Promise.all(chrome.alarms.onAlarm.dispatch({ name: 'heartbeat' }));
    await Promise.all(chrome.alarms.onAlarm.dispatch({ name: 'policy' }));
    await settle();
    expect(calls.length).toBe(n);
    expect(await sendMessage(chrome.runtime.onMessage, { type: 'popup-info' }, fromPopup)).toMatchObject({ connected: false, tenantName: 'Acme', needsReauth: true });
    // re-bind resumes
    routes['/api/browser-ext/events'] = (init) => json({ accepted: JSON.parse(String(init.body)).events.length, rejected: [] });
    await sendMessage(chrome.runtime.onMessageExternal, arm({ type: 'bind', code: 'again' }), { origin: API });
    await settle();
    expect(queue()).toHaveLength(0);
  });
  it('a refreshed token retries once and succeeds', async () => {
    let n = 0;
    routes['/api/browser-ext/events'] = (init) => (n++ === 0 ? new Response('no', { status: 401 }) : json({ accepted: 1, rejected: [] }));
    const q = [{ id: crypto.randomUUID(), signal: 'browser.lookalike_visit', domain: 'a.com', occurredAt: '2026-10-01T00:00:00Z', action: 'warned' }];
    await boot({ local: { ...bound, queue: q } });
    await Promise.all(chrome.alarms.onAlarm.dispatch({ name: 'flush' }));
    await settle();
    const ev = callsTo('/api/browser-ext/events');
    expect((ev.at(-1)!.init.headers as Record<string, string>)['authorization']).toBe('Bearer newtok');
    expect(queue()).toHaveLength(0);
    expect((chrome.storage.local.dump['auth'] as any).needsReauth).toBeFalsy();
  });
  it('a permanent 4xx drops the batch and counts it in the heartbeat; 429/5xx keep it', async () => {
    const mk = (n: number) => Array.from({ length: n }, () => ({ id: crypto.randomUUID(), signal: 'browser.lookalike_visit', domain: 'a.com', occurredAt: new Date().toISOString(), action: 'warned' }));
    for (const status of [429, 500, 503]) {
      routes['/api/browser-ext/events'] = () => new Response('x', { status });
      await boot({ local: { ...bound, queue: mk(3) } });
      await Promise.all(chrome.alarms.onAlarm.dispatch({ name: 'flush' }));
      await settle();
      expect(queue()).toHaveLength(3);
      expect(chrome.storage.local.dump['droppedEvents']).toBeUndefined();
    }
    let n = 0;
    routes['/api/browser-ext/events'] = (init) => (n++ === 0 ? new Response('bad', { status: 422 }) : json({ accepted: JSON.parse(String(init.body)).events.length, rejected: [] }));
    await boot({ local: { ...bound, queue: mk(150) } });
    await Promise.all(chrome.alarms.onAlarm.dispatch({ name: 'flush' }));
    await settle();
    expect(queue()).toHaveLength(0); // the bad batch did not starve the rest
    expect(chrome.storage.local.dump['droppedEvents']).toBe(100);
    await Promise.all(chrome.alarms.onAlarm.dispatch({ name: 'heartbeat' }));
    expect(body(callsTo('/api/browser-ext/heartbeat').at(-1)!).droppedEvents).toBe(100);
    expect(chrome.storage.local.dump['droppedEvents']).toBe(0);
  });
  it('a bind interleaved with a flush never sends the old batch with the new token', async () => {
    routes['/api/browser-ext/enroll'] = () => json({ ...ENROLL_RES, tenant: 'other' });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const bodies: { auth: string; ids: string[] }[] = [];
    routes['/api/browser-ext/events'] = async (init) => {
      const ids = JSON.parse(String(init.body)).events.map((e: { id: string }) => e.id);
      bodies.push({ auth: (init.headers as Record<string, string>)['authorization']!, ids });
      if (bodies.length === 1) await gate;
      return json({ accepted: ids.length, rejected: [] });
    };
    const old = Array.from({ length: 150 }, () => ({ id: crypto.randomUUID(), signal: 'browser.lookalike_visit', domain: 'a-old.com', occurredAt: new Date().toISOString(), action: 'warned' }));
    await boot({ local: { ...bound, queue: old } });
    const f = Promise.all(chrome.alarms.onAlarm.dispatch({ name: 'flush' }));
    await settle(); // first batch is in flight with the old token
    await sendMessage(chrome.runtime.onMessageExternal, arm({ type: 'bind', code: 'b' }), { origin: API });
    release();
    await f;
    await settle();
    const oldIds = new Set<string>(old.map((e) => e.id));
    for (const b of bodies) if (b.auth === 'Bearer newtok') expect(b.ids.some((id) => oldIds.has(id))).toBe(false);
    expect(bodies.filter((b) => b.ids.some((id) => oldIds.has(id)))).toHaveLength(1); // only the in-flight one, old token
    expect((chrome.storage.local.dump['auth'] as any).generation).toBe(1);
    expect(queue()).toHaveLength(0);
  });
  it('a same-tenant re-bind during a flush keeps the queue and resends with the new token', async () => {
    const q = Array.from({ length: 2 }, () => ({ id: crypto.randomUUID(), signal: 'browser.lookalike_visit', domain: 'a.com', occurredAt: new Date().toISOString(), action: 'warned' }));
    await boot({ local: { ...bound, queue: q } });
    // Simulate a re-bind between reading the batch and sending it: bump the generation on first read.
    const get = chrome.storage.local.get.getMockImplementation()!;
    let bumped = false;
    chrome.storage.local.get.mockImplementation(async (k?: any) => {
      const r = await get(k);
      if (!bumped && k === 'queue') {
        bumped = true;
        chrome.storage.local.dump['auth'] = { ...AUTH, token: 'newtok', generation: 1 };
      }
      return r;
    });
    await Promise.all(chrome.alarms.onAlarm.dispatch({ name: 'flush' }));
    await settle();
    const ev = callsTo('/api/browser-ext/events');
    expect(ev).toHaveLength(1);
    expect((ev[0]!.init.headers as Record<string, string>)['authorization']).toBe('Bearer newtok');
    expect(body(ev[0]!).events.map((e: { id: string }) => e.id)).toEqual(q.map((e) => e.id));
    expect(queue()).toHaveLength(0);
  });
  it('rejected events are dropped, not retried', async () => {
    routes['/api/browser-ext/events'] = (init) => {
      const evs = JSON.parse(String(init.body)).events as { id: string }[];
      return json({ accepted: 0, rejected: evs.map((e) => ({ id: e.id, reason: 'bad' })) });
    };
    const q = [{ id: crypto.randomUUID(), signal: 'browser.lookalike_visit', domain: 'a.com', occurredAt: '2026-10-01T00:00:00Z', action: 'warned' }];
    await boot({ local: { ...bound, queue: q } });
    await Promise.all(chrome.alarms.onAlarm.dispatch({ name: 'flush' }));
    await settle();
    expect(queue()).toHaveLength(0);
    expect(chrome.storage.local.dump['reported'] ?? []).toEqual([]);
  });
});

describe('alarms, heartbeat and policy', () => {
  it('heartbeat runs on startup and every 24h via alarms', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await boot({ local: bound });
    await Promise.all(chrome.runtime.onStartup.dispatch());
    await settle();
    expect(callsTo('/api/browser-ext/heartbeat')).toHaveLength(1);
    expect(chrome.alarms._all.get('heartbeat')?.periodInMinutes).toBe(1440);
    expect(chrome.alarms._all.get('policy')?.periodInMinutes).toBe(30);
    expect(chrome.alarms._all.get('nrd')?.periodInMinutes).toBe(1440);
    vi.setSystemTime(Date.now() + 24 * 3_600_000 + 1000);
    await chrome.alarms._tick();
    await settle();
    expect(callsTo('/api/browser-ext/heartbeat')).toHaveLength(2);
    const hb = body(callsTo('/api/browser-ext/heartbeat')[0]!);
    expect(Object.keys(hb).sort()).toEqual(['browser', 'browserVersion', 'consentMiss', 'droppedEvents', 'extVersion', 'nrdBloomHitsUnconfirmed']);
  });
  it('policy sync sends If-None-Match, stores policy + etag, keeps policy on 304', async () => {
    await boot({ local: { auth: AUTH, etag: '"p0"', policy: { ...POLICY, version: '0:old' } } });
    await Promise.all(chrome.alarms.onAlarm.dispatch({ name: 'policy' }));
    const p = callsTo('/api/browser-ext/policy').at(-1)!;
    expect((p.init.headers as Record<string, string>)['if-none-match']).toBe('"p0"');
    expect(chrome.storage.local.dump['etag']).toBe('"p1"');
    expect((chrome.storage.local.dump['policy'] as any).version).toBe('1:abc');
    routes['/api/browser-ext/policy'] = () => new Response(null, { status: 304 });
    await Promise.all(chrome.alarms.onAlarm.dispatch({ name: 'policy' }));
    expect((chrome.storage.local.dump['policy'] as any).version).toBe('1:abc');
  });
  it('a bad bloom keeps the previous filter', async () => {
    await boot({ local: bound });
    await Promise.all(chrome.alarms.onAlarm.dispatch({ name: 'nrd' }));
    const good = (await idbBloom()) as { data: ArrayBuffer };
    expect(good.data).toBeInstanceOf(ArrayBuffer);
    expect(chrome.storage.local.dump['nrdBloom']).toBeUndefined();
    routes['nrd/v1.rlbf'] = () => new Response(new Uint8Array([1, 2, 3]));
    await Promise.all(chrome.alarms.onAlarm.dispatch({ name: 'nrd' }));
    expect(await idbBloom()).toEqual(good);
    // bearer token never goes to a non-API host
    const nrdCall = calls.find((c) => c.url.includes('nrd/v1.rlbf'))!;
    expect(JSON.stringify(nrdCall.init.headers ?? {})).not.toContain('tok');
  });
});

describe('popularity allowlist', () => {
  const POP_URL = `${API}/api/browser-ext/feeds/popular/v1`;
  const withPopular = { ...bound, policy: { ...POLICY, popular: { version: 'p1', url: POP_URL } } };
  async function bootPopular(domains: string[]): Promise<void> {
    // @ts-expect-error untyped test-only JS writer
    const { build } = await import('../scripts/hashset-write.mjs');
    routes['popular/v1'] = () => new Response(build(domains));
    routes['/api/browser-ext/events'] = () => new Response('down', { status: 503 });
    await boot({ local: withPopular });
    await Promise.all(chrome.alarms.onAlarm.dispatch({ name: 'nrd' }));
  }

  it('a popular non-shared domain resembling a brand is not warned', async () => {
    await bootPopular(['microsoft365.com']);
    await nav('https://microsoft365.com/');
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(queue()).toHaveLength(0);
    const { idbGet } = await import('../src/background/idb.ts');
    expect(await idbGet('popularBloom')).toMatchObject({ version: 'p1' });
  });
  it('the same resemblance on a shared host is still a hit', async () => {
    await bootPopular(['microsoft-login.pages.dev', 'pages.dev']);
    await nav('https://microsoft-login.pages.dev/');
    expect(queue()[0]).toMatchObject({ signal: 'browser.lookalike_visit', value: 'brand' });
  });
  it('a non-www subdomain of a popular domain is still evaluated', async () => {
    await bootPopular(['popular-example.com']);
    await nav('https://popular-example.com/');
    expect(queue()).toHaveLength(0);
    await nav('https://login-microsoft.popular-example.com/');
    expect(queue()[0]).toMatchObject({ signal: 'browser.lookalike_visit', value: 'brand' });
  });
  it('www. of a popular domain is exempt too', async () => {
    await bootPopular(['microsoft365.com']);
    await nav('https://www.microsoft365.com/');
    expect(queue()).toHaveLength(0);
  });
  it('a known-bad popular domain still warns', async () => {
    await bootPopular(['evil-known.com']);
    await nav('https://evil-known.com/');
    expect(queue()[0]).toMatchObject({ signal: 'browser.risky_domain_visit', domain: 'evil-known.com' });
  });
  it('without a popular filter (or with a bad one) behaviour is unchanged', async () => {
    routes['popular/v1'] = () => new Response(new Uint8Array([1, 2, 3]));
    routes['/api/browser-ext/events'] = () => new Response('down', { status: 503 });
    await boot({ local: withPopular });
    await Promise.all(chrome.alarms.onAlarm.dispatch({ name: 'nrd' }));
    await nav('https://microsoft365.com/');
    expect(queue()[0]).toMatchObject({ signal: 'browser.lookalike_visit', value: 'brand', domain: 'microsoft365.com' });
  });
  it('popularity suppresses embedding and TLD-swap verdicts only', async () => {
    await bootPopular(['microsoft365.com', 'microsoft.xyz']);
    await nav('https://microsoft365.com/');
    await nav('https://microsoft.xyz/');
    expect(queue()).toHaveLength(0);
  });
  it('a popular edit-distance typo still warns', async () => {
    await bootPopular(['micrsoft.com']);
    await nav('https://micrsoft.com/');
    expect(queue()[0]).toMatchObject({ signal: 'browser.lookalike_visit', value: 'brand', domain: 'micrsoft.com' });
  });
  it('a popular skeleton (rn / Cyrillic homoglyph) domain still warns', async () => {
    const cyr = new URL('https://m\u0456crosoft.com/').hostname; // punycode registrable
    await bootPopular(['rnicrosoft.com', cyr]);
    await nav('https://rnicrosoft.com/');
    expect(queue()[0]).toMatchObject({ signal: 'browser.lookalike_visit', domain: 'rnicrosoft.com' });
    await nav('https://m\u0456crosoft.com/');
    expect(queue().at(-1)).toMatchObject({ signal: 'browser.lookalike_visit', domain: cyr });
  });
  it('a registrable in the NRD bloom is never popular', async () => {
    // example-new.com is in the NRD fixture; make it an embedding hit for brand "example".
    const pol = { ...POLICY, protected: { domains: [], brands: ['example'] }, brandOwners: {}, popular: { version: 'p1', url: POP_URL } };
    // @ts-expect-error untyped test-only JS writer
    const { build } = await import('../scripts/hashset-write.mjs');
    routes['popular/v1'] = () => new Response(build(['example-new.com']));
    routes['/api/browser-ext/events'] = () => new Response('down', { status: 503 });
    await boot({ local: { ...bound, policy: pol } });
    await Promise.all(chrome.alarms.onAlarm.dispatch({ name: 'nrd' }));
    await nav('https://example-new.com/');
    expect(queue()[0]).toMatchObject({ signal: 'browser.lookalike_visit', domain: 'example-new.com' });
  });
  it('a stale popular set (version differs from policy) grants no exemption', async () => {
    await bootPopular(['microsoft365.com']);
    const { idbGet, idbPut } = await import('../src/background/idb.ts');
    const stored = (await idbGet('popularBloom')) as { version: string };
    await idbPut('popularBloom', { ...stored, version: 'old' });
    routes['popular/v1'] = () => new Response('down', { status: 503 }); // the retry fails
    await boot({ local: withPopular }); // fresh worker: nothing in memory, stored copy is stale
    await nav('https://microsoft365.com/');
    expect(queue()[0]).toMatchObject({ signal: 'browser.lookalike_visit', domain: 'microsoft365.com' });
  });
  it('a policy without popular (or nrd) deletes the cached copies', async () => {
    await bootPopular(['microsoft365.com']);
    const { idbGet } = await import('../src/background/idb.ts');
    expect(await idbGet('popularBloom')).toBeDefined();
    expect(await idbGet('nrdBloom')).toBeDefined();
    const { loadFeed } = await import('../src/background/policy.ts');
    chrome.storage.local.dump['policy'] = { ...POLICY, nrd: undefined, popular: undefined };
    expect(await loadFeed('popular')).toBeNull();
    expect(await loadFeed('nrd')).toBeNull();
    expect(await idbGet('popularBloom')).toBeUndefined();
    expect(await idbGet('nrdBloom')).toBeUndefined();
  });
  it('a tenant switch clears the popular filter', async () => {
    await bootPopular(['microsoft365.com']);
    const { clearFeeds } = await import('../src/background/policy.ts');
    await clearFeeds();
    const { idbGet } = await import('../src/background/idb.ts');
    expect(await idbGet('popularBloom')).toBeUndefined();
    await nav('https://microsoft365.com/');
    expect(queue()[0]).toMatchObject({ signal: 'browser.lookalike_visit', domain: 'microsoft365.com' });
  });
});

describe('known-bad feed', () => {
  const KB_URL = `${API}/api/browser-ext/feeds/knownbad/k1`;
  const POP_URL = `${API}/api/browser-ext/feeds/popular/v1`;
  const kbPolicy = (extra: Record<string, unknown> = {}) => ({
    ...POLICY,
    popular: { version: 'p1', url: POP_URL },
    knownBadFeed: { version: 'k1', url: KB_URL },
    ...extra,
  });
  async function bootKb(hosts: string[], extra: Record<string, unknown> = {}, popular: string[] = ['microsoft.com', 'popular-site.com']): Promise<void> {
    // @ts-expect-error untyped test-only JS writer
    const { build } = await import('../scripts/hashset-write.mjs');
    routes['knownbad/k1'] = () => new Response(build(hosts));
    routes['popular/v1'] = () => new Response(build(popular));
    routes['/api/browser-ext/events'] = () => new Response('down', { status: 503 });
    await boot({ local: { ...bound, policy: kbPolicy(extra) } });
    await Promise.all(chrome.alarms.onAlarm.dispatch({ name: 'nrd' }));
  }

  it('brand watch: block mode blocks a subdomain of a watched entry; allow/throttle keyed on the entry', async () => {
    await bootKb([], { detectors: { lookalike: 'warn', nrd: 'warn', oauth: 'warn', knownBad: 'block' } });
    await nav('https://login.evil-known.com/x');
    expect(chrome.tabs.update).toHaveBeenCalledWith(7, { url: `${WARNING}?d=evil-known.com&k=watch` });
    expect(queue()[0]).toMatchObject({ signal: 'browser.risky_domain_visit', value: 'brand_watch', action: 'blocked' });
    expect((chrome.storage.session.dump['pending:7'] as { key: string; mode: string })).toMatchObject({ key: 'evil-known.com', mode: 'block' });
  });
  it('brand watch: off when the knownBad detector is off; strictest mode wins with other detectors', async () => {
    await bootKb([], { detectors: { lookalike: 'block', nrd: 'warn', oauth: 'warn', knownBad: 'off' } });
    await nav('https://evil-known.com/');
    expect(queue()).toHaveLength(0);
    // a look-alike of a protected domain that is also watched: lookalike=log, knownBad=block -> block, both emitted
    await bootKb([], { detectors: { lookalike: 'log', nrd: 'warn', oauth: 'warn', knownBad: 'block' }, knownBad: ['acrne.com'] });
    await nav('https://acrne.com/');
    expect(queue().map((e) => [e.signal, e.value ?? null, e.action])).toEqual([
      ['browser.risky_domain_visit', 'brand_watch', 'blocked'],
      ['browser.lookalike_visit', null, 'blocked'],
    ]);
    expect(chrome.tabs.update).toHaveBeenCalledWith(7, { url: `${WARNING}?d=acrne.com&k=watch` });
  });
  it('brand watch: only allowDomains overrides it (not popularity)', async () => {
    await bootKb([], { allowDomains: ['evil-known.com'] }, ['evil-known.com']);
    await nav('https://evil-known.com/');
    expect(queue()).toHaveLength(0);
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    await bootKb([], {}, ['evil-known.com']);
    await nav('https://evil-known.com/');
    expect(queue()[0]).toMatchObject({ value: 'brand_watch' });
  });
  it('known-bad feed + brand watch on the same host emits both values; the warning shows known', async () => {
    await bootKb(['evil-known.com']);
    await nav('https://evil-known.com/');
    expect(queue().map((e) => e.value)).toEqual(['known_bad', 'brand_watch']);
    expect(chrome.tabs.update).toHaveBeenCalledWith(7, { url: `${WARNING}?d=evil-known.com&k=known` });
  });
  it('a known-bad host on a popular, brand-owned registrable warns with k=known', async () => {
    await bootKb(['phish.microsoft.com']);
    await nav('https://phish.microsoft.com/login');
    expect(chrome.tabs.update).toHaveBeenCalledWith(7, { url: `${WARNING}?d=microsoft.com&k=known` });
    expect(queue()).toHaveLength(1);
    expect(queue()[0]).toMatchObject({ signal: 'browser.risky_domain_visit', value: 'known_bad', action: 'warned' });
    const { idbGet } = await import('../src/background/idb.ts');
    expect(await idbGet('knownBadSet')).toMatchObject({ version: 'k1' });
  });
  it('a known-bad popular apex warns, and www. is stripped', async () => {
    await bootKb(['popular-site.com']);
    await nav('https://www.popular-site.com/');
    expect(chrome.tabs.update).toHaveBeenCalledWith(7, { url: `${WARNING}?d=popular-site.com&k=known` });
  });
  it('matching is exact: other hosts on the registrable are not known-bad', async () => {
    await bootKb(['phish.microsoft.com']);
    await nav('https://www.microsoft.com/');
    await nav('https://popular-site.com/');
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(queue()).toHaveLength(0);
  });
  it('the tenant allowDomains overrides a known-bad match', async () => {
    await bootKb(['phish.microsoft.com'], { allowDomains: ['phish.microsoft.com'] });
    await nav('https://phish.microsoft.com/');
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(queue()).toHaveLength(0);
  });
  it('block mode for knownBad blocks on onBeforeNavigate', async () => {
    await bootKb(['bad-host.example.org'], { detectors: { ...POLICY.detectors, knownBad: 'block' } });
    await Promise.all(chrome.webNavigation.onBeforeNavigate.dispatch({ tabId: 7, frameId: 0, url: 'https://bad-host.example.org/' }));
    expect(chrome.tabs.update).toHaveBeenCalledWith(7, { url: `${WARNING}?d=example.org&k=known` });
    expect(queue()[0]).toMatchObject({ value: 'known_bad', action: 'blocked' });
  });
  it('knownBad off (or log) never redirects', async () => {
    await bootKb(['bad-host.example.org'], { detectors: { ...POLICY.detectors, knownBad: 'log' } });
    await nav('https://bad-host.example.org/');
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(queue()[0]).toMatchObject({ value: 'known_bad', action: 'logged' });
  });
  it('no set (no feed or a bad file) means no match', async () => {
    routes['knownbad/k1'] = () => new Response(new Uint8Array([1, 2, 3]));
    routes['/api/browser-ext/events'] = () => new Response('down', { status: 503 });
    await boot({ local: { ...bound, policy: kbPolicy() } });
    await Promise.all(chrome.alarms.onAlarm.dispatch({ name: 'nrd' }));
    await nav('https://bad-host.example.org/');
    expect(queue()).toHaveLength(0);
    const { loadFeed } = await import('../src/background/policy.ts');
    expect(await loadFeed('knownbad')).toBeNull();
  });
  it('a stale known-bad set still matches until a newer one replaces it, and counts as stale', async () => {
    await bootKb(['bad-host.example.org']);
    const { idbGet, idbPut } = await import('../src/background/idb.ts');
    const stored = (await idbGet('knownBadSet')) as { version: string };
    await idbPut('knownBadSet', { ...stored, version: 'old', at: Date.now() });
    routes['knownbad/k1'] = () => new Response('down', { status: 503 }); // the refresh fails
    await boot({ local: { ...bound, policy: kbPolicy() } }); // fresh worker, stale stored copy
    const { feedStale } = await import('../src/background/policy.ts');
    expect(await feedStale('knownbad')).toBe(true);
    await nav('https://bad-host.example.org/');
    expect(queue()[0]).toMatchObject({ value: 'known_bad' });
  });
  it('a known-bad host that is also a lookalike emits both signals; the strictest mode wins', async () => {
    await bootKb(['login-microsoft.evil.org'], { detectors: { ...POLICY.detectors, lookalike: 'block', knownBad: 'log' } });
    await Promise.all(chrome.webNavigation.onBeforeNavigate.dispatch({ tabId: 7, frameId: 0, url: 'https://login-microsoft.evil.org/' }));
    expect(chrome.tabs.update).toHaveBeenCalledWith(7, { url: `${WARNING}?d=evil.org&k=known` });
    expect(queue().map((e) => [e.signal, e.value, e.action])).toEqual([
      ['browser.risky_domain_visit', 'known_bad', 'blocked'],
      ['browser.lookalike_visit', 'brand', 'blocked'],
    ]);
  });
  it('throttle and Continue anyway are per reported host, not per registrable', async () => {
    await bootKb(['a.evil.org', 'b.evil.org']);
    await nav('https://a.evil.org/');
    expect(chrome.tabs.update).toHaveBeenLastCalledWith(7, { url: `${WARNING}?d=evil.org&k=known` });
    expect(await sendMessage(chrome.runtime.onMessage, { type: 'warning-action', action: 'continue' }, fromWarning)).toEqual({ ok: true });
    chrome.tabs.update.mockClear();
    await nav('https://a.evil.org/'); // allowed: same host
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    await nav('https://b.evil.org/'); // sibling host still warns
    expect(chrome.tabs.update).toHaveBeenCalledWith(7, { url: `${WARNING}?d=evil.org&k=known` });
    expect(queue().filter((e) => e.value === 'known_bad').map((e) => e.domain)).toEqual(['evil.org', 'evil.org']);
  });
  it('a tenant switch clears the known-bad set', async () => {
    await bootKb(['bad-host.example.org']);
    const { clearFeeds } = await import('../src/background/policy.ts');
    await clearFeeds();
    const { idbGet } = await import('../src/background/idb.ts');
    expect(await idbGet('knownBadSet')).toBeUndefined();
  });
});

describe('review fixes', () => {
  const bloomDomains = (): string[] => readFileSync(join(process.cwd(), 'test/fixtures/sample-domains.txt'), 'utf8').split(/\s+/).filter(Boolean);
  const plainBloom = (): string => bloomDomains().find((d) => !d.includes('acme') && !d.includes('micro') && !d.includes('acrne'))!;
  const before = (url: string) => Promise.all(chrome.webNavigation.onBeforeNavigate.dispatch({ tabId: 7, frameId: 0, url }));

  it('two parallel 401s share one refresh, both retry with the new token, no reauth', async () => {
    routes['/api/browser-ext/me/signals'] = (init) =>
      (init.headers as Record<string, string>)['authorization'] === 'Bearer newtok' ? json({ ok: 1 }) : new Response('no', { status: 401 });
    await boot({ local: bound });
    const { apiFetch } = await import('../src/background/api.ts');
    const [a, b] = await Promise.all([apiFetch('/api/browser-ext/me/signals'), apiFetch('/api/browser-ext/me/signals')]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(callsTo('/api/browser-ext/token/refresh')).toHaveLength(1);
    expect((chrome.storage.local.dump['auth'] as any).needsReauth).toBeFalsy();
    expect((chrome.storage.local.dump['auth'] as any).token).toBe('newtok');
  });
  it('a 401 after a sibling already refreshed retries with the stored token without refreshing', async () => {
    routes['/api/browser-ext/me/signals'] = (init) => {
      if ((init.headers as Record<string, string>)['authorization'] === 'Bearer tok') {
        chrome.storage.local.dump['auth'] = { ...AUTH, token: 'sib', refreshToken: 'rt2' };
        return new Response('no', { status: 401 });
      }
      return json({ ok: 1 });
    };
    await boot({ local: bound });
    const { apiFetch } = await import('../src/background/api.ts');
    expect((await apiFetch('/api/browser-ext/me/signals')).status).toBe(200);
    expect(callsTo('/api/browser-ext/token/refresh')).toHaveLength(0);
  });
  it('a stale caller whose refresh fails after a rebind does not flag reauth on the new binding', async () => {
    routes['/api/browser-ext/me/signals'] = () => new Response('no', { status: 401 });
    routes['/api/browser-ext/token/refresh'] = () => {
      chrome.storage.local.dump['auth'] = { ...AUTH, token: 'g1', refreshToken: 'rt-g1', generation: 1 };
      return new Response('no', { status: 401 });
    };
    await boot({ local: bound });
    const { apiFetch } = await import('../src/background/api.ts');
    await expect(apiFetch('/api/browser-ext/me/signals')).rejects.toThrow();
    expect((chrome.storage.local.dump['auth'] as any)).toMatchObject({ generation: 1, token: 'g1' });
    expect((chrome.storage.local.dump['auth'] as any).needsReauth).toBeFalsy();
  });
  it('refresh: bare 403/400 are transient; a 403 with a revocation code flags reauth (USER_DISABLED signs out)', async () => {
    routes['/api/browser-ext/me/signals'] = () => new Response('no', { status: 401 });
    for (const [res, reauth] of [
      [() => new Response('waf', { status: 403 }), false],
      [() => json({ code: 'IP_BLOCKED' }, 403), false],
      [() => json({ message: 'bad' }, 400), false],
      [() => json({ code: 'USER_DISABLED' }, 403), 'signed-out'],
      [() => json({ code: 'EXT_TOKEN_INVALID' }, 400), true],
    ] as const) {
      routes['/api/browser-ext/token/refresh'] = res;
      await boot({ local: bound });
      const { apiFetch } = await import('../src/background/api.ts');
      await expect(apiFetch('/api/browser-ext/me/signals')).rejects.toThrow();
      const a = chrome.storage.local.dump['auth'] as any;
      expect(a ? !!a.needsReauth : 'signed-out').toBe(reauth); // USER_DISABLED = full sign-out
    }
  });
  it('events: a 403 without a known code is retried; with USER_DISABLED the batch is dropped', async () => {
    const q = () => [{ id: crypto.randomUUID(), signal: 'browser.lookalike_visit', domain: 'a.com', occurredAt: new Date().toISOString(), action: 'warned' }];
    routes['/api/browser-ext/events'] = () => new Response('waf', { status: 403 });
    await boot({ local: { ...bound, queue: q() } });
    await Promise.all(chrome.alarms.onAlarm.dispatch({ name: 'flush' }));
    await settle();
    expect(queue()).toHaveLength(1);
    expect(chrome.storage.local.dump['droppedEvents']).toBeUndefined();
    routes['/api/browser-ext/events'] = () => json({ code: 'USER_DISABLED' }, 403);
    await boot({ local: { ...bound, queue: q() } });
    await Promise.all(chrome.alarms.onAlarm.dispatch({ name: 'flush' }));
    await settle();
    expect(queue()).toHaveLength(0);
    expect(chrome.storage.local.dump['droppedEvents']).toBe(1);
  });
  it('a known-bad bloom hit without a lookalike never sends the domain for age confirmation', async () => {
    routes['/api/browser-ext/events'] = () => new Response('down', { status: 503 });
    routes['/api/browser-ext/domain-age'] = () => json({ ageDays: 3 });
    const d = plainBloom();
    await boot({ local: { ...bound, policy: { ...POLICY, knownBad: [d] } } });
    await nav(`https://${d}/`);
    await settle();
    expect(callsTo('/api/browser-ext/domain-age')).toHaveLength(0);
    expect(queue()[0]).toMatchObject({ signal: 'browser.risky_domain_visit', domain: d });
  });
  it('bare bloom hits count once per navigation, ride the heartbeat, and reset after it', async () => {
    const block = { ...POLICY, detectors: { lookalike: 'block', nrd: 'block', oauth: 'warn' } };
    await boot({ local: { ...bound, policy: block } });
    await settle();
    const url = `https://${plainBloom()}/`;
    await before(url);
    await nav(url);
    expect(chrome.storage.local.dump['nrdBloomHitsUnconfirmed']).toBe(1);
    await Promise.all(chrome.alarms.onAlarm.dispatch({ name: 'heartbeat' }));
    expect(body(callsTo('/api/browser-ext/heartbeat').at(-1)!).nrdBloomHitsUnconfirmed).toBe(1);
    expect(chrome.storage.local.dump['nrdBloomHitsUnconfirmed']).toBe(0);
  });
  it('the before phase does nothing unless a detector blocks', async () => {
    await boot({ local: bound });
    await settle();
    const n = calls.length;
    await before('https://acrne.com/');
    await before(`https://${plainBloom()}/`);
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(chrome.storage.session.dump['handled:7']).toBeUndefined();
    expect(chrome.storage.local.dump['nrdBloomHitsUnconfirmed']).toBeUndefined();
    expect(calls.length).toBe(n);
  });
  it('a policy fetched under a binding that was replaced mid-request is dropped', async () => {
    routes['/api/browser-ext/policy'] = () => {
      chrome.storage.local.dump['auth'] = { ...AUTH, token: 'g1', refreshToken: 'rt-g1', generation: 1 };
      return json({ ...POLICY, version: '9:other' }, 200, { etag: '"p9"' });
    };
    await boot({ local: { ...bound, policy: { ...POLICY, version: '0:old' } } });
    await settle();
    const { syncPolicy } = await import('../src/background/policy.ts');
    chrome.storage.local.dump['auth'] = { ...AUTH };
    expect(await syncPolicy()).toBe(false);
    expect((chrome.storage.local.dump['policy'] as any).version).toBe('0:old');
  });
});

describe('organization disconnect (revoked device / disabled user)', () => {
  const q = () => [{ id: crypto.randomUUID(), signal: 'browser.lookalike_visit', domain: 'a.com', occurredAt: '2026-10-01T00:00:00Z', action: 'warned' }];
  const full = () => ({
    ...bound, queue: q(), reported: q(), aiUsageUtc: { '2026-10-01': { chatgpt: 2 } }, aiSentToday: '2026-10-01',
    throttle: { 'a.com': Date.now() }, droppedEvents: 3,
  });
  const revoked = () => json({ message: 'Device revoked', code: 'EXT_DEVICE_REVOKED' }, 401);

  it('EXT_DEVICE_REVOKED on the guard signs out fully, keeps a marker, and the popup says so', async () => {
    routes['/api/browser-ext/policy'] = revoked;
    await boot({ local: full() });
    chrome.storage.session.dump['allow'] = { 'a.com': 'warn' };
    chrome.storage.session.dump['pending:7'] = { url: 'https://a.com/' };
    await Promise.all(chrome.alarms.onAlarm.dispatch({ name: 'policy' }));
    await settle();
    const local = chrome.storage.local.dump;
    for (const k of ['auth', 'policy', 'etag', 'queue', 'reported', 'aiUsageUtc', 'aiSentToday', 'throttle', 'droppedEvents']) expect(local[k]).toBeUndefined();
    expect(local['deviceId']).toBe('dev-1');
    expect(local['disconnected']).toMatchObject({ reason: 'revoked' });
    expect(chrome.storage.session.dump['allow']).toBeUndefined();
    expect(chrome.storage.session.dump['pending:7']).toBeUndefined();
    // No refresh attempt for a deliberate revoke, and nothing more is sent.
    expect(callsTo('/api/browser-ext/token/refresh')).toHaveLength(0);
    const n = calls.length;
    await Promise.all(chrome.alarms.onAlarm.dispatch({ name: 'heartbeat' }));
    await settle();
    expect(calls.length).toBe(n);
    expect(await sendMessage(chrome.runtime.onMessage, { type: 'popup-info' }, fromPopup)).toEqual({
      connected: false, tenantName: null, needsReauth: false, disconnected: 'revoked', tenantOrigin: '', locale: 'en', extra: { downloads: 'warn', aiPaste: 'off' }, todo: null, reminders: { allowed: false }, links: { todo: '/app/campaigns', training: '/app/microlearning' },
    });
    // Signing in again clears the marker.
    routes['/api/browser-ext/policy'] = () => json(POLICY, 200, { etag: '"p1"' });
    await sendMessage(chrome.runtime.onMessageExternal, arm({ type: 'bind', code: 'again' }), { origin: API });
    await settle();
    expect(chrome.storage.local.dump['disconnected']).toBeUndefined();
    expect(await sendMessage(chrome.runtime.onMessage, { type: 'popup-info' }, fromPopup)).toMatchObject({ connected: true, disconnected: null });
  });

  it('a refresh refused with EXT_DEVICE_REVOKED / USER_DISABLED also signs out', async () => {
    for (const [code, reason] of [['EXT_DEVICE_REVOKED', 'revoked'], ['USER_DISABLED', 'disabled']] as const) {
      routes['/api/browser-ext/events'] = () => json({ code: 'EXT_TOKEN_INVALID' }, 401);
      routes['/api/browser-ext/token/refresh'] = () => json({ code }, 401);
      await boot({ local: full() });
      await Promise.all(chrome.alarms.onAlarm.dispatch({ name: 'flush' }));
      await settle();
      expect(callsTo('/api/browser-ext/token/refresh')).toHaveLength(1);
      expect(chrome.storage.local.dump['auth']).toBeUndefined();
      expect(chrome.storage.local.dump['queue']).toBeUndefined();
      expect(chrome.storage.local.dump['disconnected']).toMatchObject({ reason });
      calls = [];
    }
  });

  it('plain expiry keeps the needsReauth path: nothing is cleared, no marker', async () => {
    routes['/api/browser-ext/events'] = () => json({ code: 'EXT_TOKEN_INVALID' }, 401);
    routes['/api/browser-ext/token/refresh'] = () => json({ code: 'EXT_TOKEN_INVALID' }, 401);
    await boot({ local: full() });
    await Promise.all(chrome.alarms.onAlarm.dispatch({ name: 'flush' }));
    await settle();
    expect((chrome.storage.local.dump['auth'] as any).needsReauth).toBe(true);
    expect(chrome.storage.local.dump['policy']).toEqual(POLICY);
    expect(queue()).toHaveLength(1);
    expect(chrome.storage.local.dump['disconnected']).toBeUndefined();
    expect(await sendMessage(chrome.runtime.onMessage, { type: 'popup-info' }, fromPopup)).toMatchObject({ needsReauth: true, disconnected: null });
  });

  it('opening the popup verifies the token at most once a minute', async () => {
    await boot({ local: bound });
    const t0 = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0);
    for (let i = 0; i < 3; i++) await sendMessage(chrome.runtime.onMessage, { type: 'popup-info' }, fromPopup);
    expect(callsTo('/api/browser-ext/policy')).toHaveLength(1);
    now.mockReturnValue(t0 + 61_000);
    await sendMessage(chrome.runtime.onMessage, { type: 'popup-info' }, fromPopup);
    expect(callsTo('/api/browser-ext/policy')).toHaveLength(2);
    now.mockRestore();
  });

  it('the popup-open check picks up a revoke before the popup renders', async () => {
    routes['/api/browser-ext/policy'] = revoked;
    await boot({ local: bound });
    expect(await sendMessage(chrome.runtime.onMessage, { type: 'popup-info' }, fromPopup)).toMatchObject({ connected: false, disconnected: 'revoked' });
  });

  it('browser start verifies the token', async () => {
    routes['/api/browser-ext/policy'] = revoked;
    await boot({ local: bound });
    await Promise.all(chrome.runtime.onStartup.dispatch());
    await settle();
    expect(chrome.storage.local.dump['disconnected']).toMatchObject({ reason: 'revoked' });
  });
});
