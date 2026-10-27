// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { install } from '../src/content/password/index.ts';

const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
const SHOW = { show: true, lang: 'en', text: { title: 'T', body: 'B', back: 'Go back', cont: 'Continue' } };

function setup(check: unknown, action: unknown = { ok: true }) {
  document.body.innerHTML = '<input id="u" type="text"><input id="p" type="password">';
  const send = vi.fn(async (m: unknown) => ((m as { type: string }).type === 'password-check' ? check : action));
  const win = { history: { back: vi.fn() } };
  install(document, win, send, () => true);
  return { send, win, pw: document.getElementById('p') as HTMLInputElement, user: document.getElementById('u') as HTMLInputElement };
}
// The overlay lives in a closed shadow root; reach it through attachShadow.
function captureShadow(): () => ShadowRoot | undefined {
  let root: ShadowRoot | undefined;
  const orig = HTMLElement.prototype.attachShadow;
  vi.spyOn(HTMLElement.prototype, 'attachShadow').mockImplementation(function (this: HTMLElement, init) { root = orig.call(this, init); return root; });
  return () => root;
}

describe('password content script', () => {
  it('ignores non-password fields; asks once on the first password focus; never sends values', async () => {
    const shadow = captureShadow();
    const { send, pw, user } = setup(SHOW);
    user.value = 'alice';
    user.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(send).not.toHaveBeenCalled();
    pw.value = 'hunter2';
    pw.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    pw.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a' }));
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ type: 'password-check' });
    expect(JSON.stringify(send.mock.calls)).not.toContain('hunter2');
    expect(JSON.stringify(send.mock.calls)).not.toContain('alice');
    const root = shadow()!;
    expect(root.querySelector('h2')!.textContent).toBe('T');
    (root.querySelector('[data-action=continue]') as HTMLButtonElement).click();
    await flush();
    expect(send).toHaveBeenLastCalledWith({ type: 'password-action', action: 'continue' });
    expect(document.querySelector('[data-rl-password-warning]')).toBeNull();
    pw.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    await flush();
    expect(send).toHaveBeenCalledTimes(2); // no further checks this page load
    vi.restoreAllMocks();
  });

  it('Go back uses page history when the background has no safe page', async () => {
    const shadow = captureShadow();
    const { win, pw } = setup(SHOW, { ok: true, history: true });
    pw.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    await flush();
    (shadow()!.querySelector('[data-action=back]') as HTMLButtonElement).click();
    await flush();
    expect(win.history.back).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('show:false (safe site / log / off) renders nothing', async () => {
    const { pw } = setup({ show: false });
    pw.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    await flush();
    expect(document.querySelector('[data-rl-password-warning]')).toBeNull();
  });
  it('synthetic page events neither trigger nor dismiss; a removed overlay comes back; typing is held while shown', async () => {
    const shadow = captureShadow();
    document.body.innerHTML = '<input id="p" type="password">';
    const send = vi.fn(async (m: unknown) => ((m as { type: string }).type === 'password-check' ? SHOW : { ok: true }));
    const trusted = new WeakSet<Event>();
    install(document, { history: { back: vi.fn() } }, send, (e) => trusted.has(e));
    const pw = document.getElementById('p') as HTMLInputElement;
    pw.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); // untrusted
    await flush();
    expect(send).not.toHaveBeenCalled();
    const real = new FocusEvent('focusin', { bubbles: true });
    trusted.add(real);
    pw.dispatchEvent(real);
    await flush();
    const host = shadow()!.host as HTMLElement;
    expect(host.isConnected).toBe(true);
    host.remove(); // page script tries to dismiss the warning
    await flush();
    expect(shadow()!.host.isConnected).toBe(true);
    const key = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'a' });
    trusted.add(key);
    pw.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(true);
  });
});
