// Warning page. All text goes in via textContent; the background owns every decision.
import { brandMark } from '../lib/brand.ts';
import { el } from '../lib/dom.ts';
import { stringsFor, type Strings } from '../lib/i18n.ts';

export interface WarningInfo {
  domain: string;
  kind: 'tenant' | 'brand' | 'risky' | 'known' | 'watch' | 'download';
  mode: 'warn' | 'block';
  /** Download variant only: the file's base name (shown as text). */
  filename?: string;
  highlight: [number, number];
  learn: boolean;
  locale: string;
}
export type WarningAction = 'back' | 'continue' | 'request' | 'learn' | 'keep';

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
    btn.addEventListener('click', () => void act(action));
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
  if (info.learn) button('learn', s.learn, 'link');
  main.append(buttons);
  doc.body.replaceChildren(main);
}

async function main(): Promise<void> {
  const send = (m: unknown): Promise<unknown> => chrome.runtime.sendMessage(m);
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
