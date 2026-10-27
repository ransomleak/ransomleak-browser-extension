// Assigned training ("To do"): the caller's open campaigns and learning paths from GET /me/todo, kept in
// storage for the popup, shown as the toolbar badge, and (optional `notifications` permission, admin
// opt-in) announced as desktop reminders. Only titles, due dates and ids of the person's own items are
// fetched; nothing is sent.
import { stringsFor } from '../lib/i18n.ts';
import { dueMs, formatDueDate, normalizeTodo, REMINDER_PERMISSIONS, todoUrl, type TodoItem } from '../lib/todo.ts';
import { appLinks } from '../lib/origin.ts';
import { apiFetch, AuthPausedError } from './api.ts';
import { clearBadge, setTodoBadge } from './badge.ts';
import { getAuth, getLocal, getPolicy, locked, setLocal, type Auth } from './store.ts';

export const TODO_KEY = 'todo';
export const NOTIFY_KEY = 'todoNotify';
export const TODO_PATH = '/api/browser-ext/me/todo';
/** Reminder for an item due within this window (once per item). */
export const DUE_SOON_MS = 24 * 3_600_000;
/** Notification ids start with this; the rest is `<kind>:<id>` or `more`. */
export const NOTIFICATION_PREFIX = 'rl-todo:';
/** Remembered item keys (seen / reminded) are capped so storage cannot grow without bound. */
const KEYS_CAP = 500;

export interface TodoState { items: TodoItem[]; total: number; at: number }
/** `seen` null = not seeded yet: the next sync records the current items without notifying. */
interface NotifyState { seen: string[] | null; reminded: string[] }

const keyOf = (i: Pick<TodoItem, 'kind' | 'id'>): string => `${i.kind}:${i.id}`;

async function applyBadge(state: TodoState | undefined): Promise<void> {
  if (!state) return clearBadge();
  await setTodoBadge(state.total, state.items.some((i) => i.overdue));
}

/**
 * Fetches GET /me/todo, stores it and updates the badge, then sends any due reminders. Signed out or
 * paused: clears the badge. Offline / server error: keeps the last list. Results of a superseded binding
 * are dropped.
 */
export async function syncTodo(): Promise<void> {
  const auth = await getAuth();
  if (!auth || auth.needsReauth) {
    await clearBadge();
    return;
  }
  const generation = auth.generation ?? 0;
  let res: Response;
  try {
    res = await apiFetch(TODO_PATH, {}, generation);
  } catch (e) {
    if (e instanceof AuthPausedError) await clearBadge();
    return;
  }
  if (!res.ok) return;
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return;
  }
  const { items, total } = normalizeTodo(body);
  const state: TodoState = { items, total, at: Date.now() };
  const stored = await locked(async () => {
    const a = await getAuth();
    if (!a || a.needsReauth || (a.generation ?? 0) !== generation) return false;
    // Unchanged list: no storage write (the popup does not read `at`).
    const prev = await storedTodo();
    if (!prev || prev.total !== total || JSON.stringify(prev.items) !== JSON.stringify(items)) await setLocal({ [TODO_KEY]: state });
    return true;
  });
  if (!stored) return;
  await applyBadge(state);
  await notifyChanges(auth, state).catch(() => {});
}

/** The stored list (for the popup); undefined before the first sync. */
export async function storedTodo(): Promise<TodoState | undefined> {
  const s = await getLocal<TodoState>(TODO_KEY);
  return s && Array.isArray(s.items) ? s : undefined;
}

/** Re-applies the badge from storage (worker start). */
export async function restoreBadge(): Promise<void> {
  const auth = await getAuth();
  if (!auth || auth.needsReauth) return clearBadge();
  await applyBadge(await storedTodo());
}

/** Reminders are on for this person: admin allows them and the optional permission is granted. */
export async function remindersActive(): Promise<boolean> {
  const policy = await getPolicy();
  if (policy.notifications?.reminders !== true) return false;
  if (!chrome.notifications?.create || !chrome.permissions?.contains) return false;
  return chrome.permissions.contains(REMINDER_PERMISSIONS).catch(() => false);
}

const cap = (keys: string[]): string[] => keys.slice(-KEYS_CAP);

/**
 * Desktop reminders. While reminders are off the state is reset, so the first sync after they turn on
 * only records what is already there (no burst of old items). Afterwards: one notification for new items
 * (a summary when several arrive at once) and one reminder per item due within 24 hours.
 */
export async function notifyChanges(auth: Auth, state: TodoState): Promise<void> {
  if (!(await remindersActive())) {
    const prev = await getLocal<NotifyState>(NOTIFY_KEY);
    if (!prev || prev.seen !== null || !Array.isArray(prev.reminded) || prev.reminded.length > 0) {
      await setLocal({ [NOTIFY_KEY]: { seen: null, reminded: [] } satisfies NotifyState });
    }
    return;
  }
  const now = Date.now();
  const toSend = await locked(async () => {
    const prev = (await getLocal<NotifyState>(NOTIFY_KEY)) ?? { seen: null, reminded: [] };
    const current = state.items.map(keyOf);
    const dueSoon = state.items.filter((i) => {
      const t = dueMs(i.dueAt);
      return !i.overdue && t !== null && t > now && t - now <= DUE_SOON_MS;
    });
    if (!Array.isArray(prev.seen)) {
      // First sync with reminders on: seed silently.
      await setLocal({ [NOTIFY_KEY]: { seen: cap(current), reminded: cap(dueSoon.map(keyOf)) } satisfies NotifyState });
      return { fresh: [] as TodoItem[], soon: [] as TodoItem[] };
    }
    const seen = new Set(prev.seen);
    const reminded = new Set(Array.isArray(prev.reminded) ? prev.reminded : []);
    const fresh = state.items.filter((i) => !seen.has(keyOf(i)));
    // An item announced as new now is not reminded again in the same breath.
    const soon = dueSoon.filter((i) => !reminded.has(keyOf(i)) && !fresh.includes(i));
    for (const i of dueSoon) reminded.add(keyOf(i));
    for (const k of current) seen.add(k);
    // Nothing new seen or reminded: the stored state is already current.
    if (!fresh.length && seen.size === prev.seen.length && reminded.size === (Array.isArray(prev.reminded) ? prev.reminded.length : -1)) {
      return { fresh, soon };
    }
    await setLocal({ [NOTIFY_KEY]: { seen: cap([...seen]), reminded: cap([...reminded]) } satisfies NotifyState });
    return { fresh, soon };
  });
  const str = stringsFor(auth.locale) as unknown as Record<string, string>;
  const icon = chrome.runtime.getURL('icons/icon-128.png');
  const show = (id: string, title: string, message: string): Promise<unknown> =>
    chrome.notifications.create(`${NOTIFICATION_PREFIX}${id}`, { type: 'basic', iconUrl: icon, title, message, priority: 0 });
  if (toSend.fresh.length === 1) {
    const i = toSend.fresh[0]!;
    const t = dueMs(i.dueAt);
    const message = t !== null ? str['notif_new_due']!.replace('{title}', i.title).replace('{date}', formatDueDate(auth.locale, t)) : i.title;
    await show(keyOf(i), str['notif_new_title']!, message);
  } else if (toSend.fresh.length > 1) {
    await show('more', str['notif_new_many_title']!.replace('{n}', String(toSend.fresh.length)), str['notif_new_many_body']!);
  }
  for (const i of toSend.soon) await show(keyOf(i), str['notif_due_title']!, str['notif_due_body']!.replace('{title}', i.title));
}

/** Clicking a reminder opens the item (or the campaigns page) in the tenant app. */
export async function onNotificationClicked(notificationId: string): Promise<void> {
  if (!notificationId.startsWith(NOTIFICATION_PREFIX)) return;
  const rest = notificationId.slice(NOTIFICATION_PREFIX.length);
  await chrome.notifications?.clear?.(notificationId);
  const [auth, policy] = await Promise.all([getAuth(), getPolicy()]);
  if (!auth || auth.needsReauth) return;
  let path: string | null = null;
  if (rest !== 'more') {
    const item = (await storedTodo())?.items.find((i) => keyOf(i) === rest);
    path = item?.path ?? null; // completed meanwhile: the campaigns page instead
  }
  const url = todoUrl(auth.tenantOrigin, path, appLinks(policy.links).todo);
  if (url) await chrome.tabs.create({ url });
}

/** Registers the click listener once the optional permission (and with it chrome.notifications) exists. */
export function wireNotifications(): void {
  const ev = chrome.notifications?.onClicked;
  if (ev && !ev.hasListener(clickListener)) ev.addListener(clickListener);
}
const clickListener = (id: string): void => void onNotificationClicked(id).catch(() => {});
