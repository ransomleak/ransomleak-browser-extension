// In-browser lessons: warning-info lesson, completion event, standalone lesson tabs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { installChrome, sendMessage as send, type ChromeStub } from './chrome-stub.ts';

const API = 'https://app.ransomleak.com';
const WARNING = 'chrome-extension://extid/src/warning/warning.html';
const AUTH = {
  token: 'tok', refreshToken: 'rt', expiresAt: '2099-01-01T00:00:00Z', tenant: 'acme', tenantName: 'Acme',
  tenantOrigin: 'https://acme.ransomleak.com', apiBaseUrl: API, locale: 'en', userId: 'u-a',
};
const POLICY = {
  version: '1:abc',
  detectors: { lookalike: 'warn', nrd: 'warn', oauth: 'warn' } as Record<string, string>,
  protected: { domains: ['acme.com'], brands: ['microsoft'] },
  brandOwners: { microsoft: ['microsoft.com'] }, singleTenantOwners: [], allowDomains: [],
  approvedOAuthAppIds: [], riskyScopes: {}, sharedHosting: [], knownBad: ['evil-known.com'],
};
const bound = { auth: AUTH, policy: POLICY, etag: '"p1"', deviceId: 'dev-1' };

type Call = { url: string; init: RequestInit };
let calls: Call[];
let routes: Record<string, (init: RequestInit) => Response>;
const json = (b: unknown, status = 200): Response => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
let chrome: ChromeStub;
const settle = async (): Promise<void> => { for (let i = 0; i < 15; i++) { for (let j = 0; j < 20; j++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); } };
const queue = (): any[] => (chrome.storage.local.dump['queue'] as any[]) ?? [];

async function boot(local: Record<string, unknown> = bound, setup?: (c: ChromeStub) => void) {
  vi.resetModules();
  chrome = installChrome();
  chrome.storage.local.reset(local);
  setup?.(chrome);
  const mod = await import('../src/background/index.ts');
  await mod.ready;
  return mod;
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  calls = [];
  routes = {
    '/api/browser-ext/events': () => new Response('down', { status: 503 }), // keep events queued for assertions
    '/api/browser-ext/heartbeat': () => new Response(null, { status: 204 }),
    '/api/browser-ext/policy': () => new Response(null, { status: 304 }),
    '/api/browser-ext/site-reports': () => json({ id: 'r1' }, 201),
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const key = Object.keys(routes).find((k) => String(url).split('?')[0]!.endsWith(k));
    return key ? routes[key]!(init) : new Response('nf', { status: 404 });
  }));
});
afterEach(async () => {
  await settle();
  vi.unstubAllGlobals();
});


const fromWarning = { id: 'extid', url: `${WARNING}?d=x`, tab: { id: 7 } };
const fromPage = { id: 'extid', url: `${WARNING}?lesson=consent&d=accounts.google.com`, tab: { id: 9 } };
const nav = (url: string) => Promise.all(chrome.webNavigation.onCommitted.dispatch({ tabId: 7, frameId: 0, url, transitionType: 'link' }));
const lessons = () => queue().filter((e) => e.signal === 'browser.lesson_completed');

describe('lesson background', () => {
  it('warning-info carries the lesson for a brand look-alike', async () => {
    await boot();
    await nav('https://rnicrosoft.com/login');
    const info = (await send(chrome.runtime.onMessage, { type: 'warning-info' }, fromWarning)) as any;
    expect(info.kind).toBe('brand');
    expect(info.lesson).toMatchObject({ kind: 'lookalike', genuine: 'microsoft.com', deny: ['microsoft.com'] });
    expect(typeof info.lesson.course).toBe('boolean');
  });

  it('lesson-done twice, and after a worker restart, queues one event', async () => {
    await boot();
    await nav('https://rnicrosoft.com/login');
    await send(chrome.runtime.onMessage, { type: 'warning-action', action: 'lesson-done' }, fromWarning);
    await send(chrome.runtime.onMessage, { type: 'warning-action', action: 'lesson-done' }, fromWarning);
    expect(lessons()).toHaveLength(1);
    expect(lessons()[0]).toMatchObject({ domain: 'rnicrosoft.com', action: 'logged', value: 'lookalike' });
    const local = structuredClone(chrome.storage.local.dump) as Record<string, unknown>;
    await boot(local);
    await send(chrome.runtime.onMessage, { type: 'lesson-done', kind: 'lookalike', domain: 'rnicrosoft.com' }, fromPage);
    expect(lessons()).toHaveLength(1);
  });

  it('recordLesson rejects empty or invalid domains', async () => {
    await boot();
    const { recordLesson } = await import('../src/background/lesson.ts');
    expect(await recordLesson('consent', '')).toBe(false);
    expect(await recordLesson('consent', 'javascript:x')).toBe(false);
    expect(await recordLesson('consent', 'a b.com')).toBe(false);
    expect(await recordLesson('consent', 'a'.repeat(300) + '.com')).toBe(false);
    await send(chrome.runtime.onMessage, { type: 'lesson-done', kind: 'consent', domain: 'javascript:x' }, fromPage);
    expect(lessons()).toHaveLength(0);
    expect(await recordLesson('consent', 'accounts.google.com')).toBe(true);
    expect(lessons()).toHaveLength(1);
  });

  it('open-lesson from a top-frame content script opens the standalone lesson', async () => {
    await boot();
    const r = await send(chrome.runtime.onMessage, { type: 'open-lesson', kind: 'consent' },
      { id: 'extid', url: 'https://accounts.google.com/o/oauth2/auth?x=1', tab: { id: 3 }, frameId: 0 });
    expect(r).toEqual({ ok: true });
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: `${WARNING}?lesson=consent&d=accounts.google.com` });
  });

  it('open-lesson is ignored from an extension page, a subframe, or with another kind', async () => {
    await boot();
    await send(chrome.runtime.onMessage, { type: 'open-lesson', kind: 'consent' }, fromPage);
    await send(chrome.runtime.onMessage, { type: 'open-lesson', kind: 'consent' },
      { id: 'extid', url: 'https://accounts.google.com/', tab: { id: 3 }, frameId: 2 });
    await send(chrome.runtime.onMessage, { type: 'open-lesson', kind: 'lookalike' },
      { id: 'extid', url: 'https://accounts.google.com/', tab: { id: 3 }, frameId: 0 });
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });
});
