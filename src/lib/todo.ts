// Assigned training ("To do") helpers shared by the background and the popup. Pure: no chrome.* calls.
import { DEFAULT_APP_LINKS, isSafeAppPath, safeAppUrl, UUID_RE } from './origin.ts';

/** Optional permission behind "Turn on reminders" (manifest optional_permissions). */
export const REMINDER_PERMISSIONS: chrome.permissions.Permissions = { permissions: ['notifications'] };

const TITLE_MAX = 200;
const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** Items kept from one response (the server caps at 20). */
export const TODO_CAP = 20;

export type TodoKind = 'campaign' | 'learning_path';
export interface TodoItem { kind: TodoKind; id: string; title: string; dueAt: string | null; overdue: boolean; path: string }

/**
 * Due time in ms. A campaign deadline is a calendar date (`YYYY-MM-DD`): due at the end of that day in
 * the person's own time zone. Learning paths send a full timestamp.
 */
export function dueMs(dueAt: string | null): number | null {
  if (!dueAt) return null;
  if (DAY_ONLY.test(dueAt)) {
    const [y, m, d] = dueAt.split('-').map(Number) as [number, number, number];
    return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
  }
  const t = Date.parse(dueAt);
  return Number.isFinite(t) ? t : null;
}

/** Defensive normalisation of the server shape: bad items are dropped, never trusted. */
export function normalizeTodo(raw: unknown): { items: TodoItem[]; total: number } {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const list = Array.isArray(o['items']) ? o['items'] : [];
  const items: TodoItem[] = [];
  for (const x of list) {
    if (!x || typeof x !== 'object') continue;
    const r = x as Record<string, unknown>;
    const kind = r['kind'];
    if (kind !== 'campaign' && kind !== 'learning_path') continue;
    const id = r['id'];
    const title = typeof r['title'] === 'string' ? r['title'].trim().slice(0, TITLE_MAX) : '';
    if (typeof id !== 'string' || !UUID_RE.test(id) || !title || !isSafeAppPath(r['path'])) continue;
    const dueAt = typeof r['dueAt'] === 'string' && dueMs(r['dueAt']) !== null ? r['dueAt'] : null;
    items.push({ kind, id, title, dueAt, overdue: r['overdue'] === true, path: r['path'] });
    if (items.length >= TODO_CAP) break;
  }
  const t = o['total'];
  const total = typeof t === 'number' && Number.isFinite(t) && t >= items.length ? Math.min(Math.floor(t), 10_000) : items.length;
  return { items, total };
}

/**
 * Link to an item (or, for `null`, the learner's open-assignments page: `todoPath`, the policy's
 * `links.todo`) on the tenant; null when unsafe.
 */
export function todoUrl(origin: unknown, path: unknown, todoPath: string = DEFAULT_APP_LINKS.todo): string | null {
  return safeAppUrl(origin, path === null ? todoPath : path);
}

/** Short due date ("Oct 24") in the person's locale. */
export function formatDueDate(locale: string, ms: number): string {
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(new Date(ms));
}
