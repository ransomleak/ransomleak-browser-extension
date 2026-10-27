// Sensitive paste into AI tools (registered dynamically, only on AI tool hosts, only while the optional
// host permission is granted and the admin turned the detector on). Isolated world, top frame only.
// The pasted text is checked here, in the page, and never leaves it: it is not stored, logged or sent.
// Only the category (secret | card | emails | large) and the person's choice go to the background.
import { detectSensitive, type PasteCategory } from '../../detect/sensitive-paste.ts';
import { brandMark } from '../../lib/brand.ts';
import { OVERLAY_CSS } from '../overlay-style.ts';
import { pasteText, pickLocale, type PasteText } from './i18n.ts';

export type PasteMode = 'warn' | 'block' | 'off';
export interface PasteConfig { mode: PasteMode; locale?: string }
type Send = (m: unknown) => Promise<unknown>;
type Choice = 'cancel' | 'paste';

const TEXT_INPUT = new Set(['text', 'search', 'url', 'email', 'tel', '']);

/** The editable element a paste lands in: a text input, a textarea or a contenteditable host. */
export function editableTarget(t: EventTarget | null): HTMLElement | null {
  if (t instanceof HTMLTextAreaElement) return t;
  if (t instanceof HTMLInputElement) return TEXT_INPUT.has(t.type.toLowerCase()) ? t : null;
  const el = t instanceof HTMLElement ? t : t instanceof Node ? t.parentElement : null;
  return el?.isContentEditable ? el : null;
}

/** Builds the overlay in a closed shadow root. No innerHTML: AI tool pages may enforce Trusted Types. */
export function showOverlay(doc: Document, text: PasteText, block: boolean, lang: string, onChoice: (c: Choice) => void, onLearn?: () => void): HTMLElement {
  const host = doc.createElement('div');
  host.setAttribute('data-rl-paste-warning', '');
  const root = host.attachShadow({ mode: 'closed' });
  const style = doc.createElement('style');
  style.textContent = OVERLAY_CSS;
  const wrap = doc.createElement('div');
  wrap.className = 'wrap';
  wrap.setAttribute('role', 'alertdialog');
  wrap.setAttribute('aria-modal', 'true');
  wrap.setAttribute('aria-labelledby', 'rl-t');
  wrap.lang = lang;
  const card = doc.createElement('div');
  card.className = 'card';
  const h = doc.createElement('h2');
  h.id = 'rl-t';
  h.textContent = text.title;
  const p = doc.createElement('p');
  p.textContent = text.body;
  const actions = doc.createElement('div');
  actions.className = 'actions';
  const mk = (cls: string, label: string, c: Choice): HTMLButtonElement => {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    b.dataset['action'] = c;
    // The closed shadow root keeps page scripts away from these buttons.
    b.addEventListener('click', () => {
      host.remove();
      onChoice(c);
    });
    actions.append(b);
    return b;
  };
  const primary = mk('back', block ? text.ok : text.cancel, 'cancel');
  if (!block) mk('cont', text.paste, 'paste');
  card.append(brandMark(doc, 'compact'), h, p, actions);
  if (onLearn) {
    // Quiet text link after the choices; opens the lesson and leaves the overlay and its choices as they are.
    const learn = doc.createElement('button');
    learn.type = 'button';
    learn.className = 'learn';
    learn.textContent = text.learn;
    learn.dataset['action'] = 'learn';
    learn.addEventListener('click', onLearn);
    card.append(learn);
  }
  wrap.append(card);
  root.append(style, wrap);
  (doc.body ?? doc.documentElement).append(host);
  primary.focus();
  return host;
}

/** Inserts text the way a real paste would: setRangeText + input event, or insertText for contenteditable. */
export function insertText(doc: Document, target: HTMLElement, text: string, range: Range | null): void {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    target.focus();
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? start;
    target.setRangeText(text, start, end, 'end');
    target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: text }));
    return;
  }
  target.focus();
  const sel = doc.getSelection();
  if (sel && range) {
    sel.removeAllRanges();
    sel.addRange(range);
  }
  // Goes through the editor's own beforeinput/input handling (ProseMirror, Lexical, Quill...).
  doc.execCommand('insertText', false, text);
}

/** Wires the paste listener; resolves (once the config is known) to a function that removes it. Exported for tests. */
export function install(
  doc: Document,
  send: Send,
  browserLang: string | null | undefined,
  // Synthetic (page-script) pastes are ignored. Tests inject a stand-in.
  isTrusted: (e: Event) => boolean = (e) => e.isTrusted,
): Promise<() => void> {
  let config: PasteConfig = { mode: 'off' };
  let pending: { host: HTMLElement; reshow: () => void } | null = null;

  const observer = new MutationObserver(() => {
    if (pending && !pending.host.isConnected) pending.reshow(); // a page script removed the overlay: put it back
  });
  observer.observe(doc.documentElement, { childList: true, subtree: true });

  const onPaste = (e: Event): void => {
    if (!isTrusted(e) || config.mode === 'off') return;
    const target = editableTarget(e.target);
    if (!target) return;
    if (pending) { // one decision at a time
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    // Read synchronously: clipboardData is only readable during the event.
    let text: string | null = (e as ClipboardEvent).clipboardData?.getData('text/plain') ?? null;
    const category: PasteCategory | null = detectSensitive(text);
    if (!category) {
      text = null;
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    const block = config.mode === 'block';
    const lang = pickLocale(config.locale, browserLang);
    const sel = doc.getSelection();
    const range = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    const record = (action: 'proceeded' | 'went_back' | 'blocked'): void => {
      void send({ type: 'aipaste-event', category, action }).catch(() => {});
    };
    if (block) record('blocked');
    const choose = (c: Choice): void => {
      pending = null;
      const t = text;
      text = null; // the only copy is dropped as soon as the person decides
      if (block) { target.focus(); return; }
      if (c === 'paste' && t !== null) {
        insertText(doc, target, t, range);
        record('proceeded');
      } else {
        target.focus();
        record('went_back');
      }
    };
    const show = (): HTMLElement => showOverlay(doc, pasteText(category, block, lang), block, lang, choose,
      () => { void send({ type: 'open-lesson', kind: 'aipaste' }).catch(() => console.warn('RansomLeak: could not open the lesson')); });
    pending = { host: show(), reshow: () => { if (pending) pending.host = show(); } };
  };
  doc.addEventListener('paste', onPaste, true);
  const dispose = (): void => {
    doc.removeEventListener('paste', onPaste, true);
    observer.disconnect();
  };

  return (send({ type: 'aipaste-config' }) as Promise<PasteConfig | undefined>).then((c) => {
    if (c && (c.mode === 'warn' || c.mode === 'block')) config = { mode: c.mode, locale: typeof c.locale === 'string' ? c.locale : undefined };
    return dispose;
  }, () => dispose);
}

if (typeof chrome !== 'undefined' && chrome.runtime?.id && typeof document !== 'undefined' && window.top === window) {
  void install(document, (m) => chrome.runtime.sendMessage(m), navigator.language);
}
