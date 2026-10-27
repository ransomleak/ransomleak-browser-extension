// Prerender activation, risky downloads, site reports, extra-protection wiring.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { installChrome, makeDownloads, sendMessage, type ChromeStub } from './chrome-stub.ts';
import { categoryOf } from '../src/background/downloads.ts';
import { AI_ORIGINS } from '../src/manifest.ts';

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

describe('prerendered pages', () => {
  const prerender = { tabId: 7, frameId: 3, frameType: 'outermost_frame', documentLifecycle: 'prerender', documentId: 'DOC1', url: 'https://acrne.com/login' };

  it('a prerender is not judged until shown; activation events (lifecycle active, same documentId) judge it once', async () => {
    await boot();
    await Promise.all(chrome.webNavigation.onBeforeNavigate.dispatch(prerender));
    await Promise.all(chrome.webNavigation.onCommitted.dispatch(prerender));
    await settle();
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(queue()).toHaveLength(0);
    // Activation: Chrome fires onBeforeNavigate/onCommitted/onCompleted with lifecycle 'active'.
    const active = { ...prerender, frameId: 0, documentLifecycle: 'active' };
    chrome.webNavigation._frames.set('DOC1', { url: prerender.url, documentLifecycle: 'active', parentFrameId: -1, frameId: 0 });
    await Promise.all(chrome.webNavigation.onBeforeNavigate.dispatch(active));
    await Promise.all(chrome.webNavigation.onCommitted.dispatch(active));
    await Promise.all(chrome.webNavigation.onCompleted.dispatch(active));
    chrome.tabs.onUpdated.dispatch(7, { status: 'complete' }, { id: 7 });
    await settle();
    expect(chrome.tabs.update).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.update).toHaveBeenCalledWith(7, { url: `${WARNING}?d=acrne.com&k=tenant` });
    expect(queue()).toHaveLength(1);
  });

  it('activation with a non-zero frameId but outermost_frame + active is still judged', async () => {
    await boot();
    await Promise.all(chrome.webNavigation.onCommitted.dispatch(prerender));
    await Promise.all(chrome.webNavigation.onCommitted.dispatch({ ...prerender, documentLifecycle: 'active' }));
    await settle();
    expect(chrome.tabs.update).toHaveBeenCalledTimes(1);
  });

  it('fallback: an activation without navigation events is caught by tabs.onUpdated + getFrame', async () => {
    await boot();
    await Promise.all(chrome.webNavigation.onCommitted.dispatch(prerender));
    chrome.webNavigation._frames.set('DOC1', { url: prerender.url, documentLifecycle: 'prerender', parentFrameId: -1, frameId: 3 });
    chrome.tabs.onUpdated.dispatch(7, { title: 'x' }, { id: 7 });
    await settle();
    expect(chrome.tabs.update).not.toHaveBeenCalled(); // still a prerender: never acted on
    chrome.webNavigation._frames.set('DOC1', { url: prerender.url, documentLifecycle: 'active', parentFrameId: -1, frameId: 0 });
    chrome.tabs.onUpdated.dispatch(7, { status: 'loading' }, { id: 7 });
    await settle();
    expect(chrome.tabs.update).toHaveBeenCalledTimes(1);
    // The late activation commit is a duplicate and does nothing.
    await Promise.all(chrome.webNavigation.onCommitted.dispatch({ ...prerender, frameId: 0, documentLifecycle: 'active' }));
    await settle();
    expect(chrome.tabs.update).toHaveBeenCalledTimes(1);
    expect(queue()).toHaveLength(1);
  });

  it('a discarded prerender (getFrame null) is never judged', async () => {
    await boot();
    await Promise.all(chrome.webNavigation.onCommitted.dispatch(prerender));
    chrome.tabs.onUpdated.dispatch(7, { status: 'complete' }, { id: 7 });
    await settle();
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(queue()).toHaveLength(0);
  });

  it('subframes (not outermost) are still ignored', async () => {
    await boot();
    await Promise.all(chrome.webNavigation.onCommitted.dispatch({ tabId: 7, frameId: 4, frameType: 'sub_frame', documentLifecycle: 'active', documentId: 'D', url: 'https://acrne.com/' }));
    await settle();
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });
});

describe('extra-protection wiring', () => {
  it('removes the password-entry script an older version registered', async () => {
    await boot(bound, (c) => { c.scripting._registered.set('rl-password', { id: 'rl-password' }); });
    expect(chrome.scripting._registered.has('rl-password')).toBe(false);
  });

  it('popup-info carries the extra modes', async () => {
    await boot({ ...bound, policy: { ...POLICY, detectors: { ...POLICY.detectors, downloads: 'log' } } });
    expect(await sendMessage(chrome.runtime.onMessage, { type: 'popup-info' }, { id: 'extid', url: 'chrome-extension://extid/src/popup/popup.html' }))
      .toMatchObject({ extra: { downloads: 'log', aiPaste: 'off' } });
  });
});

describe('sensitive paste into AI tools', () => {
  const GRANTED = (c: ChromeStub) => { c.permissions._granted.origins = [...AI_ORIGINS]; };
  const withMode = (mode?: string) => ({ ...bound, policy: { ...POLICY, detectors: { ...POLICY.detectors, ...(mode ? { aiPaste: mode } : {}) } } });
  const tab = (url: string, frameId = 0) => ({ id: 'extid', url, tab: { id: 7 }, frameId });

  it('is off by default: no script, config off, events dropped', async () => {
    await boot(withMode(), GRANTED);
    expect(chrome.scripting._registered.has('rl-aipaste')).toBe(false);
    expect(await sendMessage(chrome.runtime.onMessage, { type: 'aipaste-config' }, tab('https://chatgpt.com/c/1'))).toEqual({ mode: 'off' });
    expect(await sendMessage(chrome.runtime.onMessage, { type: 'aipaste-event', category: 'secret', action: 'proceeded' }, tab('https://chatgpt.com/'))).toEqual({ ok: false });
    expect(queue()).toEqual([]);
  });

  it('registers only on AI tool hosts, only while granted and on', async () => {
    await boot(withMode('warn'));
    expect(chrome.scripting._registered.has('rl-aipaste')).toBe(false);
    GRANTED(chrome);
    chrome.permissions.onAdded.dispatch({ origins: chrome.permissions._granted.origins });
    await settle();
    const reg = chrome.scripting._registered.get('rl-aipaste') as any;
    expect(reg).toMatchObject({ js: ['content-aipaste.js'], allFrames: false, runAt: 'document_idle' });
    expect(reg.matches).toContain('https://chatgpt.com/*');
    expect(reg.matches).toContain('https://*.chatgpt.com/*');
    expect(reg.matches).toContain('https://chat.openai.com/*');
    expect(reg.matches).not.toContain('https://*.chat.openai.com/*');
    expect(reg.matches).not.toContain('https://*/*');
    expect(reg.matches.every((m: string) => m.startsWith('https://'))).toBe(true);
    chrome.permissions._granted.origins = [];
    chrome.permissions.onRemoved.dispatch({ origins: ['https://chatgpt.com/*'] });
    await settle();
    expect(chrome.scripting._registered.has('rl-aipaste')).toBe(false);
  });

  it('follows policy changes (on, tool list, off)', async () => {
    let policy: any = { ...POLICY, detectors: { ...POLICY.detectors, aiPaste: 'block' }, aiTools: [{ id: 'chatgpt', name: 'ChatGPT', domains: ['chatgpt.com'] }] };
    routes['/api/browser-ext/policy'] = () => json(policy, 200);
    await boot(withMode('off'), GRANTED);
    expect(chrome.scripting._registered.has('rl-aipaste')).toBe(false);
    chrome.alarms.onAlarm.dispatch({ name: 'policy' });
    await settle();
    expect((chrome.scripting._registered.get('rl-aipaste') as any).matches).toEqual(['https://*.chatgpt.com/*', 'https://chatgpt.com/*']);
    // A tool the manifest cannot grant (not in the built-in list) is left out until a release adds it.
    policy = { ...policy, version: '1b', aiTools: [...policy.aiTools, { id: 'new', name: 'New AI', domains: ['new-ai-tool.example'] }] };
    chrome.alarms.onAlarm.dispatch({ name: 'policy' });
    await settle();
    expect((chrome.scripting._registered.get('rl-aipaste') as any).matches).toEqual(['https://*.chatgpt.com/*', 'https://chatgpt.com/*']);
    policy = { ...policy, version: '2', detectors: { ...policy.detectors, aiPaste: 'off' } };
    chrome.alarms.onAlarm.dispatch({ name: 'policy' });
    await settle();
    expect(chrome.scripting._registered.has('rl-aipaste')).toBe(false);
  });

  it('config: mode + tenant locale on AI tools only, top frame only', async () => {
    await boot(withMode('block'), GRANTED);
    expect(await sendMessage(chrome.runtime.onMessage, { type: 'aipaste-config' }, tab('https://chatgpt.com/c/1'))).toEqual({ mode: 'block', locale: 'en' });
    expect(await sendMessage(chrome.runtime.onMessage, { type: 'aipaste-config' }, tab('https://example.com/'))).toEqual({ mode: 'off' });
    expect(await sendMessage(chrome.runtime.onMessage, { type: 'aipaste-config' }, tab('https://chatgpt.com/', 3))).toEqual({ mode: 'off' });
  });

  it('records category + action against the tool domain, once per tool+category+action per day', async () => {
    await boot(withMode('warn'), GRANTED);
    const ev = (category: string, action: string, url = 'https://www.chatgpt.com/c/abc?q=secret') =>
      sendMessage(chrome.runtime.onMessage, { type: 'aipaste-event', category, action }, tab(url));
    expect(await ev('secret', 'proceeded')).toEqual({ ok: true });
    expect(await ev('secret', 'proceeded')).toEqual({ ok: true });
    await ev('secret', 'went_back');
    await ev('card', 'went_back', 'https://claude.ai/new');
    expect(await ev('secret', 'blocked')).toEqual({ ok: false }); // not a warn-mode action
    expect(await ev('password', 'proceeded')).toEqual({ ok: false }); // unknown category
    expect(await ev('secret', 'proceeded', 'https://example.com/')).toEqual({ ok: false }); // not an AI tool
    const q = queue();
    expect(q.map((e) => [e.signal, e.domain, e.value, e.action])).toEqual([
      ['browser.ai_sensitive_paste', 'chatgpt.com', 'secret', 'proceeded'],
      ['browser.ai_sensitive_paste', 'chatgpt.com', 'secret', 'went_back'],
      ['browser.ai_sensitive_paste', 'claude.ai', 'card', 'went_back'],
    ]);
    expect(JSON.stringify(q)).not.toContain('/c/abc');
    expect(Object.keys(q[0]).sort()).toEqual(['action', 'domain', 'id', 'occurredAt', 'signal', 'value']);
  });

  it('popup-info carries aiPaste', async () => {
    await boot(withMode('warn'));
    expect(await sendMessage(chrome.runtime.onMessage, { type: 'popup-info' }, { id: 'extid', url: 'chrome-extension://extid/src/popup/popup.html' }))
      .toMatchObject({ extra: { aiPaste: 'warn' } });
  });
});

describe('risky downloads', () => {
  const item = (o: Record<string, unknown> = {}) => ({ id: 42, url: 'https://acrne.com/files/setup.exe', finalUrl: 'https://acrne.com/files/setup.exe', referrer: '', filename: 'setup.exe', ...o });
  const decide = async (it: Record<string, unknown>): Promise<ReturnType<typeof vi.fn>> => {
    const suggest = vi.fn();
    const ret = chrome.downloads!.onDeterminingFilename.dispatch(it, suggest);
    expect(ret).toEqual([true]);
    await settle();
    return suggest;
  };
  const withDownloads = (c: ChromeStub) => { c.downloads = makeDownloads(); };

  it('categories by extension', () => {
    expect(categoryOf('a.EXE')).toBe('executable');
    expect(categoryOf('C:\\x\\run.ps1')).toBe('script');
    expect(categoryOf('report.xlsm')).toBe('macro_office');
    expect(categoryOf('disk.dmg')).toBe('disk_image');
    expect(categoryOf('a.7z')).toBe('archive');
    expect(categoryOf('report.pdf')).toBeNull();
    expect(categoryOf('noext')).toBeNull();
  });

  it('warn: pauses, then settles the name, opens the download warning; Keep resumes', async () => {
    await boot(bound, withDownloads);
    const suggest = await decide(item());
    expect(chrome.downloads!.pause).toHaveBeenCalledWith(42);
    expect(suggest).toHaveBeenCalledTimes(1);
    expect(chrome.downloads!.pause.mock.invocationCallOrder[0]!).toBeLessThan(suggest.mock.invocationCallOrder[0]!);
    expect(queue().map((e) => [e.signal, e.domain, e.action, e.value])).toEqual([['browser.risky_download_warned', 'acrne.com', 'warned', 'executable']]);
    const url = `${WARNING}?k=download&dl=42`;
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url });
    const sender = { id: 'extid', url, tab: { id: 100 } };
    expect(await sendMessage(chrome.runtime.onMessage, { type: 'warning-info' }, sender)).toMatchObject({ kind: 'download', domain: 'acrne.com', filename: 'setup.exe' });
    expect(await sendMessage(chrome.runtime.onMessage, { type: 'warning-action', action: 'keep' }, sender)).toEqual({ ok: true });
    expect(chrome.downloads!.resume).toHaveBeenCalledWith(42);
    expect(chrome.tabs.remove).toHaveBeenCalledWith(100);
    expect(queue().at(-1)).toMatchObject({ action: 'proceeded', value: 'executable' });
    expect(await sendMessage(chrome.runtime.onMessage, { type: 'warning-info' }, sender)).toEqual({ error: 'no-warning' });
  });

  it('Go back cancels, removes and erases the download', async () => {
    await boot(bound, withDownloads);
    await decide(item({ filename: 'invoice.docm', url: 'https://cdn.example/x', finalUrl: 'https://cdn.example/x', referrer: 'https://acrne.com/mail' }));
    const sender = { id: 'extid', url: `${WARNING}?k=download&dl=42`, tab: { id: 100 } };
    expect(await sendMessage(chrome.runtime.onMessage, { type: 'warning-action', action: 'back' }, sender)).toEqual({ ok: true });
    expect(chrome.downloads!.cancel).toHaveBeenCalledWith(42);
    expect(chrome.downloads!.erase).toHaveBeenCalledWith({ id: 42 });
    expect(queue().map((e) => e.action)).toEqual(['warned', 'went_back']);
    expect(queue()[0]).toMatchObject({ domain: 'acrne.com', value: 'macro_office' });
  });

  it('log mode records only; safe hosts, harmless types and off mode do nothing', async () => {
    await boot({ ...bound, policy: { ...POLICY, detectors: { ...POLICY.detectors, downloads: 'log' } } }, withDownloads);
    await decide(item());
    expect(chrome.downloads!.pause).not.toHaveBeenCalled();
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(queue().map((e) => e.action)).toEqual(['logged']);
    await boot(bound, withDownloads);
    await decide(item({ url: 'https://example.org/setup.exe', finalUrl: 'https://example.org/setup.exe' }));
    await decide(item({ filename: 'a.pdf', url: 'https://acrne.com/a.pdf', finalUrl: 'https://acrne.com/a.pdf' }));
    await boot({ ...bound, policy: { ...POLICY, detectors: { ...POLICY.detectors, downloads: 'off' } } }, withDownloads);
    const s = await decide(item());
    expect(s).toHaveBeenCalledTimes(1);
    expect(chrome.downloads!.pause).not.toHaveBeenCalled();
    expect(queue()).toHaveLength(0);
  });

  it('a blob: download from a flagged page is judged by its inner origin', async () => {
    await boot(bound, withDownloads);
    await decide(item({ filename: 'setup.exe', url: 'blob:https://acrne.com/6a1f', finalUrl: 'blob:https://acrne.com/6a1f', referrer: '' }));
    expect(chrome.downloads!.pause).toHaveBeenCalledWith(42);
    expect(queue()[0]).toMatchObject({ domain: 'acrne.com', value: 'executable' });
  });

  it('a very long file name is classified by its real extension, and shown with the end kept', async () => {
    await boot(bound, withDownloads);
    const long = `${'a'.repeat(400)}.exe`;
    await decide(item({ filename: long }));
    expect(chrome.downloads!.pause).toHaveBeenCalledWith(42);
    const sender = { id: 'extid', url: `${WARNING}?k=download&dl=42`, tab: { id: 100 } };
    const info = (await sendMessage(chrome.runtime.onMessage, { type: 'warning-info' }, sender)) as { filename: string };
    expect(info.filename.endsWith('.exe')).toBe(true);
    expect(info.filename.length).toBeLessThanOrEqual(200);
  });

  it('the listener is added when the permission is granted later', async () => {
    await boot();
    chrome.downloads = makeDownloads();
    chrome.permissions.onAdded.dispatch({ permissions: ['downloads'] });
    await settle();
    expect(chrome.downloads.onDeterminingFilename.listeners).toHaveLength(1);
    chrome.permissions.onAdded.dispatch({ permissions: ['downloads'] });
    await settle();
    expect(chrome.downloads.onDeterminingFilename.listeners).toHaveLength(1);
  });
});

describe('site reports', () => {
  const fromPopup = { id: 'extid', url: 'chrome-extension://extid/src/popup/popup.html' };
  const report = (m: Record<string, unknown>) => sendMessage(chrome.runtime.onMessage, { type: 'site-report', ...m }, fromPopup);

  it('posts host + note only', async () => {
    await boot();
    expect(await report({ domain: 'Phish.Example.com', note: '  odd login\u0007 ' })).toEqual({ status: 'sent' });
    const c = calls.find((x) => x.url.endsWith('/api/browser-ext/site-reports'))!;
    expect(JSON.parse(String(c.init.body))).toEqual({ domain: 'phish.example.com', note: 'odd login' });
    expect(await report({ domain: 'a.com' })).toEqual({ status: 'sent' });
    expect(JSON.parse(String(calls.at(-1)!.init.body))).toEqual({ domain: 'a.com' });
  });

  it('maps already / rate limited / invalid / failed, and rejects non-hosts locally', async () => {
    await boot();
    routes['/api/browser-ext/site-reports'] = () => json({ alreadyReported: true }, 201);
    expect(await report({ domain: 'a.com' })).toEqual({ status: 'already' });
    routes['/api/browser-ext/site-reports'] = () => json({ code: 'SITE_REPORT_RATE_LIMITED' }, 429);
    expect(await report({ domain: 'a.com' })).toEqual({ status: 'rate_limited' });
    routes['/api/browser-ext/site-reports'] = () => json({ code: 'INVALID_TARGET' }, 400);
    expect(await report({ domain: 'a.com' })).toEqual({ status: 'invalid' });
    routes['/api/browser-ext/site-reports'] = () => new Response('x', { status: 500 });
    expect(await report({ domain: 'a.com' })).toEqual({ status: 'failed' });
    const n = calls.length;
    for (const d of ['https://a.com/x', 'a.com/path', '', 'a'.repeat(300)]) expect(await report({ domain: d })).toEqual({ status: 'invalid' });
    expect(calls.length).toBe(n);
  });

  it('unbound: unauthenticated; content scripts cannot report', async () => {
    await boot({});
    expect(await report({ domain: 'a.com' })).toEqual({ status: 'unauthenticated' });
    expect(await sendMessage(chrome.runtime.onMessage, { type: 'site-report', domain: 'a.com' }, { id: 'extid', url: 'https://a.com/', tab: { id: 1 } })).toBeUndefined();
  });
});
