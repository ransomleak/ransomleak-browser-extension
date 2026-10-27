// Hand-written chrome.* stub for background tests. Only what the extension uses.
import { vi } from 'vitest';

type Listener = (...args: any[]) => any;

export class StubEvent {
  listeners: Listener[] = [];
  addListener = (fn: Listener): void => { this.listeners.push(fn); };
  removeListener = (fn: Listener): void => { this.listeners = this.listeners.filter((l) => l !== fn); };
  hasListener = (fn: Listener): boolean => this.listeners.includes(fn);
  /** Calls every listener; returns their results. */
  dispatch(...args: unknown[]): unknown[] { return this.listeners.map((l) => l(...args)); }
}

function area(initial: Record<string, unknown> = {}) {
  let data: Record<string, unknown> = structuredClone(initial);
  const pick = (keys?: string | string[] | Record<string, unknown> | null): Record<string, unknown> => {
    if (keys === undefined || keys === null) return structuredClone(data);
    if (typeof keys === 'string') keys = [keys];
    const out: Record<string, unknown> = {};
    if (Array.isArray(keys)) {
      for (const k of keys) if (k in data) out[k] = structuredClone(data[k]);
    } else {
      for (const [k, d] of Object.entries(keys)) out[k] = k in data ? structuredClone(data[k]) : d;
    }
    return out;
  };
  return {
    get dump() { return data; },
    reset(v: Record<string, unknown> = {}) { data = structuredClone(v); },
    get: vi.fn(async (keys?: string | string[] | Record<string, unknown> | null) => pick(keys)),
    set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(data, structuredClone(items)); }),
    remove: vi.fn(async (keys: string | string[]) => { for (const k of [keys].flat()) delete data[k]; }),
    clear: vi.fn(async () => { data = {}; }),
  };
}

export function makeDownloads() {
  return {
    onDeterminingFilename: new StubEvent(),
    pause: vi.fn(async (_id: number) => {}),
    resume: vi.fn(async (_id: number) => {}),
    cancel: vi.fn(async (_id: number) => {}),
    removeFile: vi.fn(async (_id: number) => {}),
    erase: vi.fn(async (_q: { id: number }) => [] as number[]),
  };
}

export function makeNotifications() {
  const n = {
    _shown: [] as { id: string; opts: { title: string; message: string; iconUrl?: string; type?: string } }[],
    create: vi.fn(async (id: string, opts: { title: string; message: string }) => { n._shown.push({ id, opts }); return id; }),
    clear: vi.fn(async (_id: string) => true),
    onClicked: new StubEvent(),
  };
  return n;
}

export type ChromeStub = ReturnType<typeof makeChrome>;

export function makeChrome(opts: { managed?: Record<string, unknown> } = {}) {
  const alarms = new Map<string, { name: string; periodInMinutes?: number; scheduledTime: number }>();
  let nextTab = 100;
  const c = {
    runtime: {
      id: 'extid',
      getURL: (p: string) => `chrome-extension://extid/${p.replace(/^\//, '')}`,
      getManifest: () => ({ version: '0.1.0' }),
      onMessage: new StubEvent(),
      onMessageExternal: new StubEvent(),
      onStartup: new StubEvent(),
      onInstalled: new StubEvent(),
      sendMessage: vi.fn(async () => undefined),
    },
    storage: {
      local: area(),
      session: area(),
      managed: area(opts.managed ?? {}),
    },
    alarms: {
      onAlarm: new StubEvent(),
      create: vi.fn(async (name: string, info: { periodInMinutes?: number; delayInMinutes?: number; when?: number }) => {
        const delay = info.delayInMinutes ?? info.periodInMinutes ?? 0;
        alarms.set(name, { name, periodInMinutes: info.periodInMinutes, scheduledTime: info.when ?? Date.now() + delay * 60_000 });
      }),
      get: vi.fn(async (name: string) => alarms.get(name)),
      getAll: vi.fn(async () => [...alarms.values()]),
      clear: vi.fn(async (name: string) => alarms.delete(name)),
      _all: alarms,
      /** Fires every alarm due by Date.now() (use with fake timers). */
      async _tick(): Promise<void> {
        for (const a of [...alarms.values()]) {
          while (a.scheduledTime <= Date.now()) {
            if (a.periodInMinutes) a.scheduledTime += a.periodInMinutes * 60_000;
            else alarms.delete(a.name);
            await Promise.all(c.alarms.onAlarm.dispatch({ name: a.name, scheduledTime: a.scheduledTime }));
            if (!a.periodInMinutes) break;
          }
        }
      },
    },
    webNavigation: {
      onCommitted: new StubEvent(), onBeforeNavigate: new StubEvent(), onCompleted: new StubEvent(),
      /** documentId -> frame, for getFrame({documentId}) (prerender activation fallback). */
      _frames: new Map<string, { url: string; documentLifecycle: string; parentFrameId: number; frameId: number }>(),
      getFrame: vi.fn(async (d: { documentId?: string }) => (d.documentId ? c.webNavigation._frames.get(d.documentId) ?? null : null)),
    },
    tabs: {
      update: vi.fn(async (_id: number, _p: { url?: string }) => ({})),
      create: vi.fn(async (p: { url?: string }) => ({ id: nextTab++, url: p.url })),
      remove: vi.fn(async (_id: number) => {}),
      query: vi.fn(async () => [] as { url?: string }[]),
      onRemoved: new StubEvent(),
      onUpdated: new StubEvent(),
    },
    permissions: {
      _granted: { origins: [] as string[], permissions: [] as string[] },
      contains: vi.fn(async (p: { origins?: string[]; permissions?: string[] }) =>
        (p.origins ?? []).every((o) => c.permissions._granted.origins.includes(o))
        && (p.permissions ?? []).every((o) => c.permissions._granted.permissions.includes(o))),
      request: vi.fn(async () => false),
      onAdded: new StubEvent(),
      onRemoved: new StubEvent(),
    },
    scripting: {
      _registered: new Map<string, unknown>(),
      registerContentScripts: vi.fn(async (list: { id: string }[]) => { for (const x of list) c.scripting._registered.set(x.id, x); }),
      unregisterContentScripts: vi.fn(async (f: { ids: string[] }) => { for (const id of f.ids) c.scripting._registered.delete(id); }),
      getRegisteredContentScripts: vi.fn(async (f: { ids?: string[] } = {}) =>
        [...c.scripting._registered.entries()].filter(([id]) => !f.ids || f.ids.includes(id)).map(([, v]) => v)),
    },
    action: {
      _text: '' as string,
      _color: '' as string,
      setBadgeText: vi.fn(async (d: { text: string }) => { c.action._text = d.text; }),
      setBadgeBackgroundColor: vi.fn(async (d: { color: string }) => { c.action._color = d.color; }),
    },
    /** Present only when the optional permission is granted; tests install it with makeNotifications(). */
    notifications: undefined as undefined | ReturnType<typeof makeNotifications>,
    /** Present only when the optional permission is granted; tests install it with addDownloads(). */
    downloads: undefined as undefined | ReturnType<typeof makeDownloads>,
  };
  return c;
}

export function installChrome(opts: { managed?: Record<string, unknown> } = {}): ChromeStub {
  const c = makeChrome(opts);
  vi.stubGlobal('chrome', c);
  return c;
}

/** Sends a runtime message as the service worker sees it; resolves with the sendResponse value. */
export function sendMessage(ev: StubEvent, msg: unknown, sender: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve) => {
    let responded = false;
    const results = ev.dispatch(msg, sender, (r: unknown) => { responded = true; resolve(r); });
    if (!results.includes(true) && !responded) resolve(undefined);
  });
}
