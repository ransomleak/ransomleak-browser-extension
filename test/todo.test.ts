// Assigned training: GET /me/todo -> storage -> toolbar badge, optional reminders, notification clicks.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { installChrome, makeNotifications, sendMessage, type ChromeStub } from './chrome-stub.ts';
import { BADGE_OPEN, BADGE_OVERDUE } from '../src/background/badge.ts';
import { dueMs, normalizeTodo, todoUrl } from '../src/lib/todo.ts';
import en from '../src/lib/i18n/en.json';

const API = 'https://app.ransomleak.com';
const AUTH = {
  token: 'tok', refreshToken: 'rt', expiresAt: '2099-01-01T00:00:00Z', tenant: 'acme', tenantName: 'Acme',
  tenantOrigin: 'https://acme.ransomleak.com', apiBaseUrl: API, locale: 'en', userId: 'u-a',
};
const POLICY = { version: '1:abc', detectors: {}, notifications: { reminders: true } };
const bound = { auth: AUTH, policy: POLICY, etag: '"p1"', deviceId: 'dev-1' };
const fromPopup = { id: 'extid', url: 'chrome-extension://extid/src/popup/popup.html' };

const ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const camp = (n: number, extra: Record<string, unknown> = {}) => ({
  kind: 'campaign', id: ID(n), title: `Campaign ${n}`, dueAt: null, overdue: false, path: `/app/campaigns/${ID(n)}`, ...extra,
});

let todo: { items: unknown[]; total: number };
let todoStatus: number;
let calls: string[];
let chrome: ChromeStub;
const json = (b: unknown, status = 200): Response => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const settle = async (): Promise<void> => { for (let i = 0; i < 15; i++) { for (let j = 0; j < 20; j++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); } };

async function boot(local: Record<string, unknown> = bound, setup?: (c: ChromeStub) => void) {
  vi.resetModules();
  chrome = installChrome();
  chrome.storage.local.reset(local);
  setup?.(chrome);
  const mod = await import('../src/background/index.ts');
  await mod.ready;
  return mod;
}
const withReminders = (c: ChromeStub): void => {
  c.notifications = makeNotifications();
  c.permissions._granted.permissions.push('notifications');
};
const policyAlarm = async (): Promise<void> => {
  await Promise.all(chrome.alarms.onAlarm.dispatch({ name: 'policy' }));
  await settle();
};
const todoCalls = (): number => calls.filter((u) => u.endsWith('/api/browser-ext/me/todo')).length;

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  calls = [];
  todo = { items: [], total: 0 };
  todoStatus = 200;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(String(url));
    const path = String(url).split('?')[0]!;
    if (path.endsWith('/api/browser-ext/me/todo')) return todoStatus === 200 ? json(todo) : new Response('x', { status: todoStatus });
    if (path.endsWith('/api/browser-ext/policy')) return new Response(null, { status: 304 });
    if (path.endsWith('/api/browser-ext/heartbeat')) return new Response(null, { status: 204 });
    return new Response('nf', { status: 404 });
  }));
});
afterEach(async () => {
  await settle();
  vi.unstubAllGlobals();
});

describe('To do sync and badge', () => {
  it('the 30-min policy alarm fetches /me/todo, stores it and shows the count in sage', async () => {
    await boot();
    todo = { items: [camp(1), camp(2)], total: 2 };
    await policyAlarm();
    expect(todoCalls()).toBe(1);
    const stored = chrome.storage.local.dump['todo'] as { items: unknown[]; total: number };
    expect(stored.total).toBe(2);
    expect(stored.items).toHaveLength(2);
    expect(chrome.action._text).toBe('2');
    expect(chrome.action._color).toBe(BADGE_OPEN);
  });
  it('an overdue item turns the badge amber; total counts beyond the listed items; 100+ shows 99+', async () => {
    await boot();
    todo = { items: [camp(1, { overdue: true }), camp(2)], total: 7 };
    await policyAlarm();
    expect(chrome.action._text).toBe('7');
    expect(chrome.action._color).toBe(BADGE_OVERDUE);
    todo = { items: [camp(1)], total: 150 };
    await policyAlarm();
    expect(chrome.action._text).toBe('99+');
  });
  it('no open items: empty badge', async () => {
    await boot();
    todo = { items: [camp(1)], total: 1 };
    await policyAlarm();
    todo = { items: [], total: 0 };
    await policyAlarm();
    expect(chrome.action._text).toBe('');
  });
  it('a server error keeps the last list and badge', async () => {
    await boot();
    todo = { items: [camp(1)], total: 1 };
    await policyAlarm();
    todoStatus = 500;
    await policyAlarm();
    expect(chrome.action._text).toBe('1');
    expect((chrome.storage.local.dump['todo'] as { total: number }).total).toBe(1);
  });
  it('not connected: nothing is fetched and the badge stays empty', async () => {
    await boot({});
    await policyAlarm();
    expect(todoCalls()).toBe(0);
    expect(chrome.action._text).toBe('');
    await boot({ ...bound, auth: { ...AUTH, needsReauth: true }, todo: { items: [camp(1)], total: 1, at: 1 } });
    expect(chrome.action._text).toBe(''); // worker start does not restore a paused binding's count
  });
  it('worker start restores the badge from storage', async () => {
    await boot({ ...bound, todo: { items: [camp(1, { overdue: true })], total: 3, at: 1 } });
    expect(chrome.action._text).toBe('3');
    expect(chrome.action._color).toBe(BADGE_OVERDUE);
  });
  it('a revoked device signs out: the list is dropped and the badge cleared', async () => {
    await boot();
    todo = { items: [camp(1)], total: 1 };
    await policyAlarm();
    expect(chrome.action._text).toBe('1');
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      calls.push(String(url));
      return json({ code: 'EXT_DEVICE_REVOKED' }, 401);
    });
    await policyAlarm();
    expect(chrome.storage.local.dump['auth']).toBeUndefined();
    expect(chrome.storage.local.dump['todo']).toBeUndefined();
    expect(chrome.action._text).toBe('');
  });
  it('opening the popup refreshes the list (debounced) and returns it with the reminder flag', async () => {
    await boot();
    todo = { items: [camp(1)], total: 1 };
    const info = (await sendMessage(chrome.runtime.onMessage, { type: 'popup-info' }, fromPopup)) as Record<string, any>;
    expect(todoCalls()).toBe(1);
    expect(info['todo'].total).toBe(1);
    expect(info['todo'].items[0].id).toBe(ID(1));
    expect(info['reminders']).toEqual({ allowed: true });
    await sendMessage(chrome.runtime.onMessage, { type: 'popup-info' }, fromPopup);
    expect(todoCalls()).toBe(1); // within the 60 s window
  });
});

describe('reminders (optional notifications permission)', () => {
  it('first sync after turning on seeds silently, even with an item due soon', async () => {
    await boot(bound, withReminders);
    todo = { items: [camp(1), camp(2, { dueAt: new Date(Date.now() + 3 * 3600e3).toISOString() })], total: 2 };
    await policyAlarm();
    expect(chrome.notifications!.create).not.toHaveBeenCalled();
  });
  it('a new item notifies once; several new at once give one summary', async () => {
    await boot(bound, withReminders);
    todo = { items: [camp(1)], total: 1 };
    await policyAlarm();
    todo = { items: [camp(1), camp(2, { dueAt: '2099-11-04' })], total: 2 };
    await policyAlarm();
    await policyAlarm();
    const n = chrome.notifications!;
    expect(n._shown).toHaveLength(1);
    expect(n._shown[0]!.id).toBe(`rl-todo:campaign:${ID(2)}`);
    expect(n._shown[0]!.opts.title).toBe(en.notif_new_title);
    expect(n._shown[0]!.opts.message).toBe(en.notif_new_due.replace('{title}', 'Campaign 2').replace('{date}', 'Nov 4'));
    todo = { items: [camp(1), camp(2), camp(3), camp(4)], total: 4 };
    await policyAlarm();
    expect(n._shown).toHaveLength(2);
    expect(n._shown[1]!.id).toBe('rl-todo:more');
    expect(n._shown[1]!.opts.title).toBe(en.notif_new_many_title.replace('{n}', '2'));
  });
  it('an item that becomes due within 24 hours is reminded once', async () => {
    await boot(bound, withReminders);
    todo = { items: [camp(1, { dueAt: new Date(Date.now() + 5 * 86400e3).toISOString() })], total: 1 };
    await policyAlarm();
    todo = { items: [camp(1, { dueAt: new Date(Date.now() + 2 * 3600e3).toISOString() })], total: 1 };
    await policyAlarm();
    await policyAlarm();
    const n = chrome.notifications!;
    expect(n._shown).toHaveLength(1);
    expect(n._shown[0]!.opts.title).toBe(en.notif_due_title);
    expect(n._shown[0]!.opts.message).toBe(en.notif_due_body.replace('{title}', 'Campaign 1'));
  });
  it('the admin has not allowed reminders: nothing is shown even with the permission', async () => {
    await boot({ ...bound, policy: { ...POLICY, notifications: { reminders: false } } }, withReminders);
    todo = { items: [camp(1)], total: 1 };
    await policyAlarm();
    todo = { items: [camp(1), camp(2)], total: 2 };
    await policyAlarm();
    expect(chrome.notifications!.create).not.toHaveBeenCalled();
  });
  it('reminders-sync (popup only) seeds without notifying and reports the state', async () => {
    await boot(bound, withReminders);
    todo = { items: [camp(1)], total: 1 };
    expect(await sendMessage(chrome.runtime.onMessage, { type: 'reminders-sync' }, { id: 'extid', url: 'https://evil.example/', tab: { id: 1 } })).toBeUndefined();
    expect(await sendMessage(chrome.runtime.onMessage, { type: 'reminders-sync' }, fromPopup)).toEqual({ ok: true });
    expect(chrome.notifications!.create).not.toHaveBeenCalled();
    expect((chrome.storage.local.dump['todoNotify'] as { seen: string[] }).seen).toEqual([`campaign:${ID(1)}`]);
  });
  it('clicking a reminder opens the item in the tenant app; "more" or a finished item opens My campaigns', async () => {
    await boot(bound, withReminders);
    todo = { items: [camp(1)], total: 1 };
    await policyAlarm();
    const click = async (id: string): Promise<void> => {
      chrome.notifications!.onClicked.dispatch(id);
      await settle();
    };
    await click(`rl-todo:campaign:${ID(1)}`);
    expect(chrome.tabs.create).toHaveBeenLastCalledWith({ url: `https://acme.ransomleak.com/app/campaigns/${ID(1)}` });
    expect(chrome.notifications!.clear).toHaveBeenCalledWith(`rl-todo:campaign:${ID(1)}`);
    await click('rl-todo:more');
    expect(chrome.tabs.create).toHaveBeenLastCalledWith({ url: 'https://acme.ransomleak.com/app/campaigns' });
    await click(`rl-todo:campaign:${ID(9)}`);
    expect(chrome.tabs.create).toHaveBeenLastCalledWith({ url: 'https://acme.ransomleak.com/app/campaigns' });
    const n = (chrome.tabs.create as ReturnType<typeof vi.fn>).mock.calls.length;
    await click('someone-else');
    expect(chrome.tabs.create).toHaveBeenCalledTimes(n);
  });
});

describe('todo helpers', () => {
  it('normalizeTodo drops items with bad ids, kinds, titles or unsafe paths, and caps total', () => {
    const out = normalizeTodo({
      items: [
        camp(1),
        camp(2, { path: 'https://evil.example/app/x' }),
        camp(3, { path: '/app/../admin' }),
        camp(4, { id: 'nope' }),
        camp(5, { kind: 'quiz' }),
        camp(6, { title: '   ' }),
        camp(7, { dueAt: 'garbage' }),
      ],
      total: -3,
    });
    expect(out.items.map((i) => i.id)).toEqual([ID(1), ID(7)]);
    expect(out.items[1]!.dueAt).toBeNull();
    expect(out.total).toBe(2);
  });
  it('a date-only due date ends at local midnight of that day', () => {
    const t = new Date(dueMs('2026-11-04')!);
    expect([t.getFullYear(), t.getMonth(), t.getDate(), t.getHours()]).toEqual([2026, 10, 4, 23]);
  });
  it('todoUrl only builds https tenant links to /app paths', () => {
    expect(todoUrl('https://acme.ransomleak.com', '/app/learning-paths/x')).toBe('https://acme.ransomleak.com/app/learning-paths/x');
    expect(todoUrl('http://acme.ransomleak.com', '/app/campaigns')).toBeNull();
    expect(todoUrl('https://u:p@acme.ransomleak.com', '/app/campaigns')).toBeNull();
    expect(todoUrl('https://acme.ransomleak.com', '//evil.example/app')).toBeNull();
    expect(todoUrl('https://acme.ransomleak.com', null)).toBe('https://acme.ransomleak.com/app/campaigns');
  });
  it('todoUrl(null) opens the server-supplied to-do page when given', () => {
    expect(todoUrl('https://acme.ransomleak.com', null, '/app/my-training')).toBe('https://acme.ransomleak.com/app/my-training');
    expect(todoUrl('https://acme.ransomleak.com', '/app/campaigns/x', '/app/my-training')).toBe('https://acme.ransomleak.com/app/campaigns/x');
  });
});
