// Password-entry warning (registered dynamically only after the optional host permission is granted).
// Isolated world, top frame only. It never reads, stores or sends any field value: it only notices
// that focus or a keystroke landed in an <input type=password> and asks the background (which knows
// the frame URL from the message sender) whether this site is flagged.

import { brandMark } from '../../lib/brand.ts';
import { OVERLAY_CSS } from '../overlay-style.ts';

type Check = { show: false } | { show: true; lang: string; text: { title: string; body: string; back: string; cont: string } };
type Send = (m: unknown) => Promise<unknown>;

const isPassword = (t: EventTarget | null): t is HTMLInputElement =>
  t instanceof HTMLInputElement && t.type.toLowerCase() === 'password';

/** Builds the overlay in a closed shadow root (page CSS and scripts cannot reach into it). */
export function showOverlay(doc: Document, c: Extract<Check, { show: true }>, onChoice: (a: 'back' | 'continue') => void): HTMLElement {
  const host = doc.createElement('div');
  host.setAttribute('data-rl-password-warning', '');
  const root = host.attachShadow({ mode: 'closed' });
  const style = doc.createElement('style');
  style.textContent = OVERLAY_CSS;
  const wrap = doc.createElement('div');
  wrap.className = 'wrap';
  wrap.setAttribute('role', 'alertdialog');
  wrap.setAttribute('aria-modal', 'true');
  wrap.lang = c.lang;
  const card = doc.createElement('div');
  card.className = 'card';
  const h = doc.createElement('h2');
  h.id = 'rl-t';
  h.textContent = c.text.title;
  const p = doc.createElement('p');
  p.textContent = c.text.body;
  wrap.setAttribute('aria-labelledby', 'rl-t');
  const actions = doc.createElement('div');
  actions.className = 'actions';
  const mk = (cls: string, text: string, a: 'back' | 'continue'): HTMLButtonElement => {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = text;
    b.dataset['action'] = a;
    b.addEventListener('click', () => { host.remove(); onChoice(a); });
    actions.append(b);
    return b;
  };
  const back = mk('back', c.text.back, 'back');
  mk('cont', c.text.cont, 'continue');
  card.append(brandMark(doc, 'compact'), h, p, actions);
  wrap.append(card);
  root.append(style, wrap);
  (doc.body ?? doc.documentElement).append(host);
  back.focus();
  return host;
}

/** Wires the listeners. Exported for tests. */
export function install(
  doc: Document,
  win: { history: { back(): void } },
  send: Send,
  // Synthetic (page-script) events never trigger or dismiss the warning. Tests inject a stand-in.
  isTrusted: (e: Event) => boolean = (e) => e.isTrusted,
): void {
  let asked: Promise<Check> | null = null;
  // 'idle' → checking → 'shown' (overlay up, typing blocked) → 'decided'. Only a real choice ends it.
  let state: 'idle' | 'shown' | 'decided' = 'idle';
  let overlay: HTMLElement | null = null;
  let lastCheck: Extract<Check, { show: true }> | null = null;
  let lastField: HTMLElement | null = null;

  const choose = (a: 'back' | 'continue'): void => {
    state = 'decided';
    overlay = null;
    void (send({ type: 'password-action', action: a }) as Promise<{ history?: boolean } | undefined>).then((r) => {
      if (a === 'back' && r?.history) win.history.back();
    }, () => {});
    if (a === 'continue') lastField?.focus();
  };
  const show = (): void => {
    if (!lastCheck) return;
    state = 'shown';
    lastField?.blur();
    overlay = showOverlay(doc, lastCheck, choose);
  };
  // A page script removing the overlay must not dismiss the warning: put it back.
  new MutationObserver(() => {
    if (state === 'shown' && overlay && !overlay.isConnected) show();
  }).observe(doc.documentElement, { childList: true, subtree: true });

  const onEvent = (e: Event): void => {
    if (!isTrusted(e) || state === 'decided' || !isPassword(e.target)) return;
    // While the warning is up, nothing reaches the password field.
    if (state === 'shown') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type === 'focusin') (e.target as HTMLElement).blur();
      return;
    }
    lastField = e.target;
    asked ??= (send({ type: 'password-check' }) as Promise<Check | undefined>).then((r) => r ?? { show: false }, () => ({ show: false }));
    void asked.then((c) => {
      if (state !== 'idle') return;
      if (!c.show) {
        state = 'decided';
        return;
      }
      lastCheck = c as Extract<Check, { show: true }>;
      show();
    });
  };
  doc.addEventListener('focusin', onEvent, true);
  doc.addEventListener('keydown', onEvent, true);
}

if (typeof chrome !== 'undefined' && chrome.runtime?.id && typeof document !== 'undefined' && window.top === window) {
  install(document, window, (m) => chrome.runtime.sendMessage(m));
}
