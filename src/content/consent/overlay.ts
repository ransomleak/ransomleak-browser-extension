import { el } from '../../lib/dom.ts';
import { brandMark } from '../../lib/brand.ts';
import { t as tr, type MsgKey } from './i18n.ts';
import type { ConsentInfo } from './types.ts';

export type OverlayOpts = {
  onRequest: (msg: { type: 'block-request'; kind: 'oauth_app'; target: string; label: string }) => void;
  /** The user chose Continue anyway (warn mode): recorded as a proceeded consent. */
  onContinue?: () => void;
  /** The user opened the optional lesson; the overlay and its choices stay as they are. */
  onLearn?: () => void;
  navigate?: (url: string) => void;
  /** Supported locale code (see pickLocale); defaults to English. */
  locale?: string;
  exposeRootForTest?: boolean;
};
export type OverlayHandle = { remove: () => void; root?: ShadowRoot };

const CSS = `
:host{all:initial;color-scheme:dark;
 --scrim:oklch(0.10 0.015 160 / 0.62);--surface:oklch(0.17 0.012 160);--plate:oklch(0.14 0.012 160);--line:oklch(0.28 0.010 160);
 --fg:oklch(0.96 0.010 160);--fg-2:oklch(0.78 0.015 160);--fg-3:oklch(0.64 0.010 160);
 --sage:oklch(0.72 0.17 160);--sage-hi:oklch(0.80 0.15 155);--on-sage:oklch(0.14 0.015 160);
 --sev:oklch(0.82 0.16 85);--sev-soft:oklch(0.82 0.16 85 / 0.14);--focus:oklch(0.80 0.15 155)}
:host([data-mode=block]){--sev:oklch(0.68 0.20 25);--sev-soft:oklch(0.68 0.20 25 / 0.16)}
@media (prefers-color-scheme:light){
 :host{color-scheme:light;--scrim:oklch(0.20 0.020 165 / 0.45);--surface:oklch(1 0 0);--plate:oklch(0.97 0.008 160);--line:oklch(0.89 0.012 160);
  --fg:oklch(0.20 0.020 165);--fg-2:oklch(0.40 0.020 165);--fg-3:oklch(0.50 0.015 165);
  --sage:oklch(0.48 0.11 166);--sage-hi:oklch(0.42 0.10 168);--on-sage:oklch(0.99 0 0);
  --sev:oklch(0.55 0.13 70);--sev-soft:oklch(0.80 0.15 85 / 0.22);--focus:oklch(0.48 0.11 166)}
 :host([data-mode=block]){--sev:oklch(0.52 0.19 27);--sev-soft:oklch(0.65 0.20 25 / 0.12)}}
*{box-sizing:border-box}
.wrap{width:100%;height:100%;overflow:auto;display:flex;justify-content:center;align-items:flex-start;
 padding:max(24px,10vh) 16px 24px;background:var(--scrim);-webkit-backdrop-filter:blur(6px) saturate(.8);backdrop-filter:blur(6px) saturate(.8);
 animation:rl-fade .24s cubic-bezier(.16,1,.3,1)}
.panel{width:100%;max-width:30rem;font:15px/1.5 "Hanken Grotesk",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
 color:var(--fg);background:var(--surface);border:1px solid var(--line);border-top:3px solid var(--sev);border-radius:14px;
 padding:22px 24px 24px;display:flex;flex-direction:column;gap:18px;
 box-shadow:0 24px 64px -16px oklch(0 0 0 / .55),0 2px 6px oklch(0 0 0 / .2);animation:rl-rise .32s cubic-bezier(.16,1,.3,1)}
.brand{display:flex;align-items:center;gap:10px}
.brand span{font-size:17px;font-weight:700;line-height:1;letter-spacing:-.02em;color:var(--fg)}
.brand svg{width:30px;height:30px;flex:none;display:block}
.lede{display:flex;flex-direction:column;gap:6px}
h2{margin:0;font-size:21px;line-height:1.25;font-weight:700;letter-spacing:-.015em;text-wrap:balance}
.body{margin:0;color:var(--fg-2)}
.app{background:var(--plate);border:1px solid var(--line);border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:10px}
.label{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--fg-3)}
.name{margin:2px 0 0;font-size:16px;font-weight:650;overflow-wrap:anywhere}
ul{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px}
li{display:flex;gap:9px;align-items:flex-start;font-size:14px;color:var(--fg)}
li svg{flex:none;width:16px;height:16px;margin-top:2px;color:var(--sev)}
.actions{display:flex;flex-wrap:wrap;gap:10px}
button{font:inherit;font-size:14px;font-weight:600;border-radius:9px;padding:10px 16px;cursor:pointer;
 border:1px solid var(--line);background:transparent;color:var(--fg);transition:background-color .15s,border-color .15s,color .15s}
button:hover:not(:disabled){border-color:var(--fg-3);background:var(--sev-soft)}
button.primary{background:var(--sage);border-color:var(--sage);color:var(--on-sage)}
button.primary:hover:not(:disabled){background:var(--sage-hi);border-color:var(--sage-hi)}
button.learn{display:block;align-self:flex-start;margin-top:-6px;padding:2px 0;border:0;border-radius:4px;background:none;color:var(--sage);font-size:14px;font-weight:500;text-decoration:underline;text-underline-offset:3px}
button.learn:hover:not(:disabled){background:none;color:var(--sage-hi)}
button:disabled{opacity:.55;cursor:default}
button:focus-visible{outline:2px solid var(--focus);outline-offset:3px}
.status{margin:0;font-size:13px;color:var(--fg-2)}
.status:empty{display:none}
@keyframes rl-fade{from{opacity:0}}
@keyframes rl-rise{from{opacity:0;transform:translateY(-10px) scale(.985)}}
@media (prefers-reduced-motion:reduce){.wrap,.panel{animation:none}}
@media (max-width:420px){.panel{padding:18px 18px 20px}.actions button{flex:1 1 100%}}
`;


const BACK_FALLBACK_MS = 1500;
const MAX_REINSERTS = 3;

function setStyles(e: HTMLElement, props: Record<string, string>): void {
  for (const [k, v] of Object.entries(props)) e.style.setProperty(k, v, 'important');
}

let current: OverlayHandle | null = null;

const SVG_NS = 'http://www.w3.org/2000/svg';

type Shape = [tag: string, attrs: Record<string, string>];

/** Builds an icon with DOM calls (no innerHTML: provider pages enforce Trusted Types). */
function svg(doc: Document, viewBox: string, shapes: Shape[]): SVGSVGElement {
  const root = doc.createElementNS(SVG_NS, 'svg');
  root.setAttribute('viewBox', viewBox);
  root.setAttribute('aria-hidden', 'true');
  for (const [tag, attrs] of shapes) {
    const n = doc.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    root.append(n);
  }
  return root;
}

const ALERT: Shape[] = [
  ['path', { d: 'M8 1.5 15 14H1z', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linejoin': 'round' }],
  ['path', { d: 'M8 6v3.5', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round' }],
  ['circle', { cx: '8', cy: '11.6', r: '.9', fill: 'currentColor' }],
];

export function showOverlay(doc: Document, info: ConsentInfo, mode: 'warn' | 'block', opts: OverlayOpts): OverlayHandle {
  current?.remove(); // full teardown of the previous overlay (observer, listeners, timers)
  doc.querySelector('[data-rl-consent]')?.remove();
  const win = doc.defaultView!;
  const lang = opts.locale ?? 'en';
  const t = (k: MsgKey): string => tr(k, lang);
  const host = el(doc, 'div');
  host.setAttribute('data-rl-consent', '');
  host.setAttribute('data-mode', mode);
  // Both modes hold the page: the provider's own Allow/Continue sits under the scrim until the user chooses.
  setStyles(host, { position: 'fixed', top: '0', left: '0', right: '0', bottom: '0', 'z-index': '2147483647', 'pointer-events': 'auto', display: 'block' });
  const root = host.attachShadow({ mode: 'closed' });
  const style = el(doc, 'style', CSS);
  const wrap = el(doc, 'div', undefined, 'wrap');
  const panel = el(doc, 'div', undefined, 'panel');
  const title = t(mode === 'block' ? 'titleBlock' : 'titleWarn');
  panel.setAttribute('role', 'alertdialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', title);
  panel.lang = lang;

  const brand = brandMark(doc, 'compact');

  const lede = el(doc, 'div', undefined, 'lede');
  lede.append(el(doc, 'h2', title), el(doc, 'p', t(mode === 'block' ? 'bodyBlock' : 'bodyWarn'), 'body'));

  const app = el(doc, 'div', undefined, 'app');
  const head = el(doc, 'div');
  head.append(el(doc, 'span', t('appLabel'), 'label'), el(doc, 'p', info.appName, 'name'));
  const reasons = el(doc, 'ul');
  for (const key of info.verified ? (['reasonBroad'] as const) : (['reasonBroad', 'reasonUnverified'] as const)) {
    const li = el(doc, 'li');
    li.append(svg(doc, '0 0 16 16', ALERT), el(doc, 'span', t(key)));
    reasons.append(li);
  }
  app.append(head, reasons);

  let shown = true;
  let fallback: ReturnType<typeof setTimeout> | undefined;
  let unloaded = false;
  let reinserts = 0;
  const onPageHide = (): void => { unloaded = true; };
  win.addEventListener('pagehide', onPageHide);

  // Cancel page interaction that targets anything outside our host (events inside the shadow root retarget to it).
  const guard = (ev: Event): void => {
    if (ev.target === host) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
  };
  const keyGuard = (ev: Event): void => {
    const k = (ev as KeyboardEvent).key;
    if (k === 'Enter' || k === ' ' || k === 'Spacebar') guard(ev);
    // Keep Tab inside the panel.
    if (k === 'Tab') {
      const btns = [...root.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      if (!btns.length) return;
      const i = btns.indexOf(root.activeElement as HTMLButtonElement);
      ev.preventDefault();
      ev.stopImmediatePropagation();
      const step = (ev as KeyboardEvent).shiftKey ? -1 : 1;
      btns[(i + step + btns.length) % btns.length]!.focus();
    }
  };
  win.addEventListener('click', guard, true);
  win.addEventListener('submit', guard, true);
  win.addEventListener('keydown', keyGuard, true);
  // Re-insert if the page removes the host (bounded).
  const mo = new MutationObserver(() => {
    if (shown && !host.isConnected && reinserts < MAX_REINSERTS) {
      reinserts++;
      (doc.body ?? doc.documentElement).append(host);
    }
  });
  mo.observe(doc.documentElement, { childList: true, subtree: true });

  const remove = (): void => {
    shown = false;
    clearTimeout(fallback);
    mo.disconnect();
    win.removeEventListener('pagehide', onPageHide);
    win.removeEventListener('click', guard, true);
    win.removeEventListener('submit', guard, true);
    win.removeEventListener('keydown', keyGuard, true);
    host.remove();
    if (current === handle) current = null;
  };

  const actions = el(doc, 'div', undefined, 'actions');
  const back = el(doc, 'button', t('back'), 'primary');
  back.type = 'button';
  back.setAttribute('data-action', 'back');
  const second = el(doc, 'button', t(mode === 'block' ? 'request' : 'cont'));
  second.type = 'button';
  second.setAttribute('data-action', mode === 'block' ? 'request' : 'continue');
  actions.append(back, second);
  const status = el(doc, 'p', undefined, 'status');
  status.setAttribute('role', 'status');

  back.addEventListener('click', () => {
    back.disabled = true;
    second.disabled = true;
    const before = win.location.href;
    history.back();
    fallback = setTimeout(() => {
      if (shown && !unloaded && doc.visibilityState !== 'hidden' && win.location.href === before) {
        (opts.navigate ?? ((u) => win.location.assign(u)))('about:blank');
      }
    }, BACK_FALLBACK_MS);
  });
  if (mode === 'block') {
    second.addEventListener('click', () => {
      opts.onRequest({ type: 'block-request', kind: 'oauth_app', target: info.appId ?? info.displayAppId ?? info.appName, label: info.appName });
      second.disabled = true;
      status.textContent = t('requested');
    });
  } else {
    second.addEventListener('click', () => { clearTimeout(fallback); opts.onContinue?.(); remove(); });
  }
  panel.append(brand, lede, app, actions);
  const onLearn = opts.onLearn;
  if (onLearn) {
    const learn = el(doc, 'button', t('learn'), 'learn');
    learn.type = 'button';
    learn.setAttribute('data-action', 'learn');
    learn.addEventListener('click', () => onLearn());
    panel.append(learn);
  }
  panel.append(status);
  wrap.append(panel);
  root.append(style, wrap);
  (doc.body ?? doc.documentElement).append(host);
  back.focus();
  const handle: OverlayHandle = { remove, root: opts.exposeRootForTest ? root : undefined };
  current = handle;
  return handle;
}
