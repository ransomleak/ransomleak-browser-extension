// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseConsent } from '../src/content/consent/parse.ts';
import { isRisky } from '../src/content/consent/risk.ts';
import { DEFAULT_RISKY_SCOPES } from '../src/content/consent/risky-scopes.ts';
import { showOverlay } from '../src/content/consent/overlay.ts';
import { pickLocale } from '../src/content/consent/i18n.ts';
import type { ConsentInfo } from '../src/content/consent/types.ts';

const load = (name: string): Document =>
  new DOMParser().parseFromString(readFileSync(join(process.cwd(), 'test/fixtures/consent', name + '.html'), 'utf8'), 'text/html');

const MS_URL = new URL('https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=11111111-2222-3333-4444-555555555555&scope=openid%20offline_access%20https%3A%2F%2Fgraph.microsoft.com%2FMail.ReadWrite');
const G_URL = new URL('https://accounts.google.com/o/oauth2/v2/auth?client_id=1234.apps.googleusercontent.com&scope=https%3A%2F%2Fmail.google.com%2F%20email');
const S_URL = new URL('https://slack.com/oauth/v2/authorize?client_id=123.456&scope=channels:history,chat:write&user_scope=chat:write,files:read');

describe('parseConsent', () => {
  it('parses the Microsoft fixture', () => {
    expect(parseConsent(load('microsoft'), 'microsoft', MS_URL)).toMatchObject({
      provider: 'microsoft', appName: 'Contoso Mail Helper', appId: '11111111-2222-3333-4444-555555555555',
      verified: false, scopeSource: 'url', scopes: expect.arrayContaining(['openid', 'offline_access', 'https://graph.microsoft.com/Mail.ReadWrite']),
    });
  });
  it('parses the Google fixture', () => {
    expect(parseConsent(load('google'), 'google', G_URL)).toMatchObject({
      provider: 'google', appName: 'Mail Merge Pro', appId: '1234.apps.googleusercontent.com',
      verified: false, scopeSource: 'url', scopes: expect.arrayContaining(['https://mail.google.com/', 'email']),
    });
  });
  it('parses the Slack fixture', () => {
    expect(parseConsent(load('slack'), 'slack', S_URL)).toMatchObject({
      provider: 'slack', appName: 'Acme Reports', appId: '123.456', verified: true, scopeSource: 'url',
      scopes: expect.arrayContaining(['channels:history', 'chat:write', 'user:chat:write', 'user:files:read']),
    });
  });
  it('parses the Slack workspace-host fixture', () => {
    const url = new URL('https://acme.slack.com/oauth?client_id=123.456&scope=channels:history,chat:write&user_scope=chat:write,files:read');
    expect(parseConsent(load('slack-workspace'), 'slack', url)).toMatchObject({
      provider: 'slack', appName: 'Acme Reports', appId: '123.456', verified: true, scopeSource: 'url',
      scopes: expect.arrayContaining(['channels:history', 'chat:write', 'user:chat:write', 'user:files:read']),
    });
  });
  it('falls back to DOM list items when the URL has no scope', () => {
    const info = parseConsent(load('google'), 'google', new URL('https://accounts.google.com/signin/oauth/consent?authuser=0'));
    expect(info?.scopes).toEqual(['Read, compose, send, and permanently delete all your email from Gmail']);
    expect(info?.appId).toBeNull();
    expect(info?.scopeSource).toBe('dom');
  });
  it('yields null for unknown markup', () => {
    const empty = new DOMParser().parseFromString('<body></body>', 'text/html');
    expect(parseConsent(empty, 'microsoft', MS_URL)).toBeNull();
    expect(parseConsent(empty, 'google', G_URL)).toBeNull();
    expect(parseConsent(empty, 'slack', S_URL)).toBeNull();
    const changed = new DOMParser().parseFromString('<body><div class="x9">Hello</div><p>Nothing here</p></body>', 'text/html');
    expect(parseConsent(changed, 'microsoft', new URL('https://login.microsoftonline.com/common/oauth2/v2.0/authorize'))).toBeNull();
  });
  it('treats hostile app names as plain text', () => {
    const doc = load('microsoft');
    const h = doc.querySelectorAll('[role=heading]')[1]!;
    h.textContent = '<img src=x onerror=alert(1)>';
    expect(parseConsent(doc, 'microsoft', MS_URL)?.appName).toBe('<img src=x onerror=alert(1)>');
  });
});

const mkMs = (name: string, extra = ''): Document => new DOMParser().parseFromString(
  `<body><div role="heading">Permissions requested</div><div role="heading">${name}</div>${extra}<ul><li>x</li></ul></body>`, 'text/html');

describe('verification is positive-only', () => {
  it('an app named like a badge is unverified', () => {
    expect(parseConsent(mkMs('Publisher verified'), 'microsoft', MS_URL)?.verified).toBe(false);
    expect(parseConsent(mkMs('Publisher verified', '<span>Publisher verified</span>'), 'microsoft', MS_URL)?.verified).toBe(false);
    const slack = new DOMParser().parseFromString('<body><h1>Verified is requesting permission to access W</h1><span>Verified</span></body>', 'text/html');
    expect(parseConsent(slack, 'slack', S_URL)?.verified).toBe(false);
  });
  it('a description claiming verification is not a badge', () => {
    const doc = mkMs('Evil', '<p>This publisher is verified by Microsoft</p><ul><li>Publisher verified</li></ul>');
    expect(parseConsent(doc, 'microsoft', MS_URL)?.verified).toBe(false);
  });
  it('the real badge verifies', () => {
    expect(parseConsent(mkMs('Good', '<span>Publisher verified</span>'), 'microsoft', MS_URL)?.verified).toBe(true);
    const g = new DOMParser().parseFromString('<body><h1>Good wants access to your Google Account</h1><span>Verified by Google</span></body>', 'text/html');
    expect(parseConsent(g, 'google', G_URL)?.verified).toBe(true);
  });
  it('google without a badge is unverified', () => {
    expect(parseConsent(load('google'), 'google', G_URL)?.verified).toBe(false);
    const g = new DOMParser().parseFromString('<body><h1>Plain wants access to your Google Account</h1></body>', 'text/html');
    expect(parseConsent(g, 'google', G_URL)?.verified).toBe(false);
  });
});

describe('appName sanitising and editable ancestors', () => {
  it('strips control/bidi chars and caps at 80', () => {
    const n = parseConsent(mkMs('A\u202Eb\u0007' + 'x'.repeat(200)), 'microsoft', MS_URL)!.appName;
    expect(n.length).toBeLessThanOrEqual(80);
    expect(/[\u0000-\u001F\u202A-\u202E\u2066-\u2069]/.test(n)).toBe(false);
  });
  it('ignores text inside contenteditable ancestors and role=textbox', () => {
    const d = new DOMParser().parseFromString(
      '<body><div contenteditable="true"><h1>Fake wants access to your Google Account</h1></div><div role="textbox"><h2>Fake2 wants access to x</h2></div></body>', 'text/html');
    expect(parseConsent(d, 'google', G_URL)).toBeNull();
  });
});

describe('never touches inputs', () => {
  afterEach(() => vi.restoreAllMocks());
  it('selects no input-like element and reads no .value', () => {
    const selectors: string[] = [];
    const record = (proto: object, fn: string) => {
      const orig = (proto as any)[fn];
      vi.spyOn(proto as any, fn).mockImplementation(function (this: unknown, ...a: unknown[]) {
        selectors.push(String(a[0]));
        return orig.apply(this, a);
      });
    };
    for (const proto of [Document.prototype, Element.prototype]) {
      for (const fn of ['querySelector', 'querySelectorAll', 'getElementsByTagName', 'getElementsByClassName']) record(proto, fn);
    }
    record(Document.prototype, 'getElementsByName');
    record(Document.prototype, 'getElementById');
    const valueGet = vi.fn(() => '');
    for (const C of [HTMLInputElement, HTMLTextAreaElement, HTMLSelectElement]) {
      Object.defineProperty(C.prototype, 'value', { configurable: true, get: valueGet, set() {} });
    }
    const cases: [string, 'microsoft' | 'google' | 'slack', URL][] = [['microsoft', 'microsoft', MS_URL], ['google', 'google', G_URL], ['slack', 'slack', S_URL]];
    for (const [f, p, u] of cases) parseConsent(load(f), p, u);
    parseConsent(load('google'), 'google', new URL('https://accounts.google.com/signin/oauth/consent'));
    expect(selectors.length).toBeGreaterThan(0);
    const bad = /input|textarea|contenteditable|select|password/i;
    expect(selectors.filter((s) => bad.test(s))).toEqual([]);
    expect(valueGet).not.toHaveBeenCalled();
  });
});

const info = (over: Partial<ConsentInfo> = {}): ConsentInfo => ({
  provider: 'microsoft', appName: 'X', appId: 'app-1', verified: false, scopes: ['Mail.ReadWrite'], scopeSource: 'url', ...over,
});

describe('isRisky', () => {
  const R = DEFAULT_RISKY_SCOPES;
  it('is true for Mail.ReadWrite with an unverified publisher', () => {
    expect(isRisky(info(), R, [])).toBe(true);
  });
  it('is false when the appId is approved', () => {
    expect(isRisky(info(), R, ['app-1'])).toBe(false);
    expect(isRisky(info({ scopes: ['full_access_as_user'] }), R, ['app-1'])).toBe(false);
  });
  it('is false for a verified publisher with only ordinary risky scopes', () => {
    expect(isRisky(info({ verified: true }), R, [])).toBe(false);
  });
  it('is false for harmless scopes', () => {
    expect(isRisky(info({ scopes: ['openid', 'profile'] }), R, [])).toBe(false);
  });
  it('always-risky scopes warn even when verified', () => {
    expect(isRisky(info({ verified: true, scopes: ['Mail.ReadWrite', 'offline_access'] }), R, [])).toBe(true);
    expect(isRisky(info({ verified: true, scopes: ['https://graph.microsoft.com/full_access_as_user'] }), R, [])).toBe(true);
    expect(isRisky(info({ provider: 'google', verified: true, scopes: ['https://mail.google.com/'] }), R, [])).toBe(true);
    expect(isRisky(info({ provider: 'slack', verified: true, scopes: ['admin.teams:read'] }), R, [])).toBe(true);
  });
  it('matches google tails and wildcards, and slack user scopes', () => {
    const g = (s: string) => info({ provider: 'google', scopes: [s] });
    expect(isRisky(g('https://www.googleapis.com/auth/gmail.modify'), R, [])).toBe(true);
    expect(isRisky(g('https://www.googleapis.com/auth/drive'), R, [])).toBe(true);
    expect(isRisky(g('https://www.googleapis.com/auth/drive.readonly'), R, [])).toBe(false);
    expect(isRisky(g('https://www.googleapis.com/auth/admin.directory.user'), R, [])).toBe(true);
    const s = (x: string) => info({ provider: 'slack', scopes: [x] });
    expect(isRisky(s('user:chat:write'), R, [])).toBe(true);
    expect(isRisky(s('chat:write'), R, [])).toBe(false);
    expect(isRisky(s('user:files:read'), R, [])).toBe(true);
  });
  it('dom-sourced scopes fail closed unless approved', () => {
    const i = info({ verified: true, scopes: ['Read your mail'], scopeSource: 'dom' });
    expect(isRisky(i, R, [])).toBe(true);
    expect(isRisky(i, R, ['app-1'])).toBe(false);
  });
  it('uses the supplied policy list', () => {
    expect(isRisky(info({ scopes: ['Foo.Bar'] }), { microsoft: ['Foo.Bar'] }, [])).toBe(true);
  });
});

describe('overlay', () => {
  const handles: { remove: () => void }[] = [];
  const show: typeof showOverlay = (...a) => { const h = showOverlay(...a); handles.push(h); return h; };
  afterEach(() => { handles.splice(0).forEach((h) => h.remove()); document.body.innerHTML = ''; vi.useRealTimers(); vi.restoreAllMocks(); });
  it('uses a closed shadow root, textContent only, fixed host', () => {
    const handle = show(document, info({ appName: '<b>evil</b>' }), 'warn', { onRequest: () => {}, exposeRootForTest: true });
    const host = document.querySelector('[data-rl-consent]') as HTMLElement;
    expect(host).toBeTruthy();
    expect(host.shadowRoot).toBeNull();
    expect(host.style.position).toBe('fixed');
    const root = handle.root!;
    expect(root.querySelector('b')).toBeNull();
    expect(root.textContent).toContain('<b>evil</b>');
    expect(root.querySelectorAll('button').length).toBe(2);
  });
  it('Continue anyway hides it and reports the choice', () => {
    const onContinue = vi.fn();
    const h = show(document, info(), 'warn', { onRequest: () => {}, onContinue, exposeRootForTest: true });
    (h.root!.querySelector('[data-action=continue]') as HTMLButtonElement).click();
    expect(document.querySelector('[data-rl-consent]')).toBeNull();
    expect(onContinue).toHaveBeenCalledTimes(1);
  });
  it('lists the unverified publisher only when unverified', () => {
    const a = show(document, info({ verified: false }), 'warn', { onRequest: () => {}, exposeRootForTest: true });
    expect(a.root!.querySelectorAll('li').length).toBe(2);
    const b = show(document, info({ verified: true }), 'warn', { onRequest: () => {}, exposeRootForTest: true });
    expect(b.root!.querySelectorAll('li').length).toBe(1);
  });
  it('Go back calls history.back and falls back to about:blank after 1500ms', () => {
    vi.useFakeTimers();
    const back = vi.spyOn(history, 'back').mockImplementation(() => {});
    const nav = vi.fn();
    const h = show(document, info(), 'warn', { onRequest: () => {}, exposeRootForTest: true, navigate: nav });
    (h.root!.querySelector('[data-action=back]') as HTMLButtonElement).click();
    expect(back).toHaveBeenCalled();
    vi.advanceTimersByTime(1499);
    expect(nav).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(nav).toHaveBeenCalledWith('about:blank');
  });
  it('block mode swaps Continue for Request access', () => {
    const onRequest = vi.fn();
    const h = show(document, info({ appId: null, appName: 'Zed' }), 'block', { onRequest, exposeRootForTest: true });
    expect(h.root!.querySelector('[data-action=continue]')).toBeNull();
    (h.root!.querySelector('[data-action=request]') as HTMLButtonElement).click();
    expect(onRequest).toHaveBeenCalledWith({ type: 'block-request', kind: 'oauth_app', target: 'Zed', label: 'Zed' });
  });
  it('block-request target prefers appId', () => {
    const onRequest = vi.fn();
    const h = show(document, info(), 'block', { onRequest, exposeRootForTest: true });
    (h.root!.querySelector('[data-action=request]') as HTMLButtonElement).click();
    expect(onRequest.mock.calls[0]![0].target).toBe('app-1');
  });
  it('warn mode also holds the page until the user chooses', () => {
    const h = show(document, info(), 'warn', { onRequest: () => {}, exposeRootForTest: true });
    const host = document.querySelector('[data-rl-consent]') as HTMLElement;
    expect(host.style.getPropertyPriority('bottom')).toBe('important');
    const btn = document.createElement('button');
    document.body.append(btn);
    const spy = vi.fn();
    btn.addEventListener('click', spy);
    btn.click();
    expect(spy).not.toHaveBeenCalled();
    (h.root!.querySelector('[data-action=continue]') as HTMLButtonElement).click();
    btn.click();
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it('block mode covers the viewport and cancels page click/submit/Enter/Space', () => {
    show(document, info(), 'block', { onRequest: () => {} });
    const host = document.querySelector('[data-rl-consent]') as HTMLElement;
    expect(host.style.getPropertyValue('top')).toBe('0px');
    expect(host.style.getPropertyPriority('bottom')).toBe('important');
    const btn = document.createElement('button');
    const form = document.createElement('form');
    document.body.append(btn, form);
    const spy = vi.fn();
    btn.addEventListener('click', spy);
    form.addEventListener('submit', spy);
    btn.click();
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    for (const key of ['Enter', ' ']) btn.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    const other = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });
    btn.addEventListener('keydown', spy);
    btn.dispatchEvent(other);
    expect(spy).toHaveBeenCalledTimes(1); // only the 'a' keydown reached the page
  });
  it('re-inserts a removed host at most 3 times', async () => {
    show(document, info(), 'warn', { onRequest: () => {} });
    for (let i = 0; i < 5; i++) {
      document.querySelector('[data-rl-consent]')?.remove();
      await Promise.resolve(); await new Promise((r) => setTimeout(r, 0));
    }
    expect(document.querySelector('[data-rl-consent]')).toBeNull();
  });
  it('Go back disables both buttons; Continue after cancels nothing harmful; no navigate when hidden', () => {
    vi.useFakeTimers();
    vi.spyOn(history, 'back').mockImplementation(() => {});
    const nav = vi.fn();
    const h = show(document, info(), 'warn', { onRequest: () => {}, exposeRootForTest: true, navigate: nav });
    (h.root!.querySelector('[data-action=back]') as HTMLButtonElement).click();
    expect((h.root!.querySelector('[data-action=continue]') as HTMLButtonElement).disabled).toBe(true);
    window.dispatchEvent(new Event('pagehide'));
    vi.advanceTimersByTime(2000);
    expect(nav).not.toHaveBeenCalled();
  });
  it('a second overlay fully tears down the first', async () => {
    show(document, info(), 'block', { onRequest: () => {} });
    const h2 = show(document, info(), 'warn', { onRequest: () => {}, exposeRootForTest: true });
    expect(document.querySelectorAll('[data-rl-consent]').length).toBe(1);
    // only the second overlay's guard is active
    const btn = document.createElement('button');
    document.body.append(btn);
    const spy = vi.fn();
    btn.addEventListener('click', spy);
    btn.click();
    expect(spy).toHaveBeenCalledTimes(0);
    // removing the second host re-inserts only one host
    document.querySelector('[data-rl-consent]')!.remove();
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelectorAll('[data-rl-consent]').length).toBe(1);
    (h2.root!.querySelector('[data-action=continue]') as HTMLButtonElement).click();
    expect(document.querySelectorAll('[data-rl-consent]').length).toBe(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelectorAll('[data-rl-consent]').length).toBe(0);
    btn.click();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('localized Google consent (scope-less v3 consent URL)', () => {
  const CLIENT = '407408718192.apps.googleusercontent.com';
  const V3 = new URL(`https://accounts.google.com/signin/oauth/v3/consent?authuser=0&part=AJi8hAOPAQUE&client_id=${CLIENT}&as=S1&rart=x`);
  const stored = { provider: 'google' as const, clientId: CLIENT, scopes: ['https://mail.google.com/'], at: Date.now() };
  afterEach(() => { document.body.innerHTML = ''; });

  it('uses the stored request: risky, app name from the heading link, overlay in warn mode', () => {
    const info = parseConsent(load('google-uk'), 'google', V3, stored);
    expect(info).toMatchObject({
      provider: 'google', appName: 'Google OAuth 2.0 Playground', appId: CLIENT, displayAppId: CLIENT,
      verified: false, scopeSource: 'url', scopes: expect.arrayContaining(['https://mail.google.com/']),
    });
    expect(info!.scopes.join()).not.toMatch(/Deutsch|Довідка/);
    expect(isRisky(info!, DEFAULT_RISKY_SCOPES, [])).toBe(true);
    const h = showOverlay(document, info!, 'warn', { onRequest: () => {}, exposeRootForTest: true });
    expect(document.querySelector('[data-rl-consent]')).toBeTruthy();
    expect(h.root!.textContent).toContain('Google OAuth 2.0 Playground');
    expect(h.root!.querySelector('[data-action=continue]')).toBeTruthy();
    h.remove();
  });
  it('renders the overlay in the requested locale', () => {
    const info = parseConsent(load('google-uk'), 'google', V3, stored)!;
    const h = showOverlay(document, info, 'warn', { onRequest: () => {}, exposeRootForTest: true, locale: 'de' });
    expect(h.root!.textContent).toContain('Prüfen Sie diese App');
    expect(h.root!.querySelector('[data-action=continue]')!.textContent).toBe('Trotzdem fortfahren');
    h.remove();
    const u = showOverlay(document, info, 'block', { onRequest: () => {}, exposeRootForTest: true, locale: pickLocale(undefined, 'uk-UA') });
    expect(u.root!.textContent).toContain('Ваша організація блокує цей застосунок');
    u.remove();
  });
  it('pickLocale: tenant locale first, then browser language, then English', () => {
    expect(pickLocale('fr', 'de-DE')).toBe('fr');
    expect(pickLocale(undefined, 'nl-BE')).toBe('nl');
    expect(pickLocale('xx', 'es-ES')).toBe('en');
  });
  it('live layout: plain-text heading, app name taken from the matching link elsewhere on the page', () => {
    const info = parseConsent(load('google-uk-live'), 'google', V3, stored);
    expect(info).toMatchObject({ appName: 'Google OAuth 2.0 Playground', displayAppId: CLIENT });
  });
  it('ignores a stored request for another client_id', () => {
    const info = parseConsent(load('google-uk'), 'google', V3, { ...stored, clientId: 'other.apps.googleusercontent.com' });
    expect(info?.scopes).not.toContain('https://mail.google.com/');
    expect(info?.scopeSource).toBe('dom');
  });
  it('a stale benign request plus broader DOM scopes on the page is risky', () => {
    const info = parseConsent(load('google-uk'), 'google', V3, { ...stored, scopes: ['email'] })!;
    expect(info.scopes).toEqual(expect.arrayContaining(['email', 'Читати, створювати, надсилати й назавжди видаляти всі ваші електронні листи з Gmail']));
    expect(isRisky(info, DEFAULT_RISKY_SCOPES, [])).toBe(true);
  });
  it('the approved-app exemption trusts only the page URL client_id', () => {
    const noId = new URL('https://accounts.google.com/signin/oauth/v3/consent?authuser=0&part=x');
    const info = parseConsent(load('google-uk'), 'google', noId, stored)!;
    expect(info.appId).toBeNull();
    expect(info.displayAppId).toBe(CLIENT);
    expect(isRisky(info, DEFAULT_RISKY_SCOPES, [CLIENT])).toBe(true);
    const withId = parseConsent(load('google-uk'), 'google', V3, stored)!;
    expect(isRisky(withId, DEFAULT_RISKY_SCOPES, [CLIENT])).toBe(false);
  });
  it('the DOM fallback reads only the consent container, never the language picker', () => {
    const info = parseConsent(load('google-uk'), 'google', V3, null);
    expect(info?.scopes).toEqual(['Читати, створювати, надсилати й назавжди видаляти всі ваші електронні листи з Gmail']);
  });
  it('no stored request and no consent container -> null', () => {
    const doc = load('google-uk');
    doc.querySelector('[role=main]')!.removeAttribute('role');
    expect(parseConsent(doc, 'google', V3, null)).toBeNull();
  });
  it('a missing app name falls back to the client id', () => {
    const doc = load('google-uk');
    doc.querySelector('h1')!.textContent = 'Додатку потрібен доступ';
    expect(parseConsent(doc, 'google', V3, stored)?.appName).toBe(CLIENT);
  });
  it('the account chooser never uses the stored request', () => {
    const chooser = new URL(`https://accounts.google.com/v3/signin/accountchooser?client_id=${CLIENT}`);
    expect(parseConsent(load('google-uk'), 'google', chooser, stored)?.scopeSource).not.toBe('url');
  });
});
