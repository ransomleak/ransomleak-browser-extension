// Warning page. All text goes in via textContent; the background owns every decision.
import { brandMark } from '../lib/brand.ts';
import { el } from '../lib/dom.ts';
import { stringsFor, type Strings } from '../lib/i18n.ts';
import type { LessonKind } from '../lesson/content.ts';
import { isSupportedLocale } from '../lib/locales.ts';
import { renderLesson, standaloneFromUrl } from './lesson.ts';

export interface WarningInfo {
  domain: string;
  kind: 'tenant' | 'brand' | 'risky' | 'known' | 'watch' | 'download';
  mode: 'warn' | 'block';
  /** Download variant only: the file's base name (shown as text). */
  filename?: string;
  highlight: [number, number];
  locale: string;
  lesson: { kind: LessonKind; genuine: string | null; deny: string[]; course: boolean };
}
export type WarningAction = 'back' | 'continue' | 'request' | 'learn' | 'keep' | 'lesson-done';

/** Opens the lesson in place of the warning content; "Back to warning" re-renders the warning. */
function openLesson(doc: Document, info: WarningInfo, s: Strings, act: (a: WarningAction) => void | Promise<unknown>): void {
  const l = info.lesson;
  renderLesson(
    doc,
    { kind: l.kind, domain: info.domain, highlight: info.highlight, genuine: l.genuine, deny: l.deny, course: l.course, standalone: false },
    s,
    (a) => void act(a === 'course' ? 'learn' : 'back'),
    () => void act('lesson-done'),
    () => render(doc, info, s, act),
  );
}

export function render(doc: Document, info: WarningInfo, s: Strings, act: (a: WarningAction) => void | Promise<unknown>): void {
  doc.documentElement.lang = info.locale;
  doc.title = s.page_title;
  doc.documentElement.classList.toggle('block', info.mode === 'block');
  const main = el(doc, 'main');
  main.append(brandMark(doc));
  const lede = el(doc, 'div', undefined, 'lede');
  lede.append(el(doc, 'h1', s[`title_${info.kind}`]), el(doc, 'p', s[`body_${info.kind}`], 'body'));
  main.append(lede);

  const buttons = el(doc, 'div', undefined, 'actions');
  const button = (action: WarningAction, text: string, cls: string): HTMLButtonElement => {
    const btn = el(doc, 'button', text, cls);
    btn.type = 'button';
    btn.dataset['action'] = action;
    // "Learn why" opens the lesson here; the course link moves to the lesson's done step.
    btn.addEventListener('click', () => (action === 'learn' ? openLesson(doc, info, s, act) : void act(action)));
    buttons.append(btn);
    return btn;
  };

  if (info.kind === 'download') {
    // File name and source host are page/server-derived: text only.
    const box = el(doc, 'div', undefined, 'domain download');
    box.append(el(doc, 'span', s.dl_file_label, 'label'), el(doc, 'p', info.filename ?? '', 'name file'));
    box.append(el(doc, 'span', s.dl_from_label, 'label'), el(doc, 'p', info.domain, 'name from'));
    main.append(box);
    button('back', s.back, 'primary').autofocus = true;
    button('keep', s.dl_keep, 'secondary');
    button('learn', s.learn, 'link');
    main.append(buttons);
    doc.body.replaceChildren(main);
    return;
  }

  const box = el(doc, 'div', undefined, 'domain');
  box.append(el(doc, 'span', s.domain_label, 'label'));
  const name = el(doc, 'p', undefined, 'name');
  const d = info.domain;
  const [a, b] = info.highlight;
  const valid = Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b > a && b <= d.length;
  if (valid) name.append(doc.createTextNode(d.slice(0, a)), el(doc, 'mark', d.slice(a, b)), doc.createTextNode(d.slice(b)));
  else name.textContent = d;
  box.append(name, el(doc, 'span', s.hint, 'hint'));
  main.append(box);
  if (info.mode === 'block') main.append(el(doc, 'p', s.block_note, 'note'));

  button('back', s.back, 'primary').autofocus = true;
  if (info.mode === 'block') {
    const req = button('request', s.request, 'secondary');
    const status = el(doc, 'p', undefined, 'status');
    status.setAttribute('role', 'status');
    req.addEventListener('click', () => { req.disabled = true; });
    main.append(status);
  } else {
    button('continue', s.continue, 'secondary');
  }
  button('learn', s.learn, 'link');
  main.append(buttons);
  doc.body.replaceChildren(main);
}

/** Standalone lesson (`?lesson=consent|aipaste&d=<host>`), opened from the in-page overlays. */
export function renderStandalone(doc: Document, search: string, locale: string, send: (m: unknown) => unknown, close: () => void): boolean {
  const st = standaloneFromUrl(search);
  if (!st) return false;
  const s = stringsFor(locale);
  doc.documentElement.lang = isSupportedLocale(locale) ? locale : 'en';
  doc.title = s.page_title;
  renderLesson(
    doc,
    { kind: st.kind, domain: st.domain, genuine: null, course: false, standalone: true },
    s,
    () => close(),
    () => { if (st.domain) void send({ type: 'lesson-done', kind: st.kind, domain: st.domain }); },
  );
  return true;
}

async function main(): Promise<void> {
  const send = (m: unknown): Promise<unknown> => chrome.runtime.sendMessage(m);
  const l = new URLSearchParams(location.search).get('l');
  const locale = isSupportedLocale(l) ? l : (navigator.language || 'en').slice(0, 2).toLowerCase();
  if (renderStandalone(doc(), location.search, locale, send, () => window.close())) return;
  const info = (await send({ type: 'warning-info' })) as WarningInfo | { error: string } | undefined;
  if (!info || 'error' in info) {
    doc().body.textContent = '';
    return;
  }
  const s = stringsFor(info.locale);
  render(doc(), info, s, async (action) => {
    const r = (await send({ type: 'warning-action', action })) as { ok?: boolean } | undefined;
    if (action === 'request') {
      const status = doc().querySelector('.status');
      if (status) status.textContent = r?.ok ? s.requested : s.request_failed;
    }
  });
}

const doc = (): Document => document;
if (typeof chrome !== 'undefined' && chrome.runtime?.id && location.protocol === 'chrome-extension:') void main();
