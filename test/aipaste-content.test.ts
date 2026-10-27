// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { editableTarget, install } from '../src/content/aipaste/index.ts';
import { pasteText, pickLocale } from '../src/content/aipaste/i18n.ts';

// jsdom does not implement isContentEditable.
Object.defineProperty(HTMLElement.prototype, 'isContentEditable', {
  configurable: true,
  get(this: HTMLElement) { return this.closest('[contenteditable=true]') !== null; },
});
const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
const SECRET = 'here is my key AKIAIOSFODNN7EXAMPLE please debug';

function captureShadow(): () => ShadowRoot | undefined {
  let root: ShadowRoot | undefined;
  const orig = HTMLElement.prototype.attachShadow;
  vi.spyOn(HTMLElement.prototype, 'attachShadow').mockImplementation(function (this: HTMLElement, init) { root = orig.call(this, init); return root; });
  return () => root;
}
function paste(target: EventTarget, text: string): Event {
  const e = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'clipboardData', { value: { getData: (t: string) => (t === 'text/plain' ? text : '') } });
  target.dispatchEvent(e);
  return e;
}
let disposers: (() => void)[] = [];
async function setup(mode: 'warn' | 'block' | 'off', trusted = true) {
  document.body.innerHTML = '<textarea id="t">ab</textarea><div id="ce" contenteditable="true"></div><input id="pw" type="password">';
  const send = vi.fn(async (m: unknown) => ((m as { type: string }).type === 'aipaste-config' ? { mode, locale: 'en' } : { ok: true }));
  disposers.push(await install(document, send, 'en-US', () => trusted));
  const ta = document.getElementById('t') as HTMLTextAreaElement;
  ta.setSelectionRange(1, 1);
  return { send, ta, ce: document.getElementById('ce') as HTMLElement, pw: document.getElementById('pw') as HTMLInputElement };
}
afterEach(() => { for (const d of disposers) d(); disposers = []; vi.restoreAllMocks(); document.body.innerHTML = ''; });

describe('AI paste content script', () => {
  it('lets normal pastes through untouched and sends nothing', async () => {
    const { send, ta } = await setup('warn');
    const e = paste(ta, 'Summarise this short paragraph');
    expect(e.defaultPrevented).toBe(false);
    expect(send).toHaveBeenCalledTimes(1); // config only
  });

  it('warn: cancels the paste; Paste anyway inserts the same text and records proceeded, never the text', async () => {
    const shadow = captureShadow();
    const { send, ta } = await setup('warn');
    const inputs: InputEvent[] = [];
    ta.addEventListener('input', (e) => inputs.push(e as InputEvent));
    const e = paste(ta, SECRET);
    expect(e.defaultPrevented).toBe(true);
    expect(ta.value).toBe('ab');
    const root = shadow()!;
    expect(root.querySelector('p')!.textContent).toContain('a password, API key or access token');
    (root.querySelector('[data-action=paste]') as HTMLButtonElement).click();
    await flush();
    expect(ta.value).toBe(`a${SECRET}b`);
    expect(inputs[0]?.inputType).toBe('insertFromPaste');
    expect(send).toHaveBeenLastCalledWith({ type: 'aipaste-event', category: 'secret', action: 'proceeded' });
    expect(JSON.stringify(send.mock.calls)).not.toContain('AKIA');
    expect(document.querySelector('[data-rl-paste-warning]')).toBeNull();
  });

  it("warn: Don't paste keeps the field unchanged and records went_back", async () => {
    const shadow = captureShadow();
    const { send, ta } = await setup('warn');
    paste(ta, '4111 1111 1111 1111');
    (shadow()!.querySelector('[data-action=cancel]') as HTMLButtonElement).click();
    await flush();
    expect(ta.value).toBe('ab');
    expect(send).toHaveBeenLastCalledWith({ type: 'aipaste-event', category: 'card', action: 'went_back' });
  });

  it('warn: contenteditable re-insert goes through insertText', async () => {
    const shadow = captureShadow();
    const { ce } = await setup('warn');
    const exec = vi.fn(() => true);
    (document as unknown as { execCommand: unknown }).execCommand = exec;
    paste(ce, 'x'.repeat(2500));
    (shadow()!.querySelector('[data-action=paste]') as HTMLButtonElement).click();
    expect(exec).toHaveBeenCalledWith('insertText', false, 'x'.repeat(2500));
  });

  it('block: cancels, offers no Paste anyway, records blocked', async () => {
    const shadow = captureShadow();
    const { send, ta } = await setup('block');
    const e = paste(ta, 'a@x.com b@x.com c@x.com d@x.com e@x.com');
    expect(e.defaultPrevented).toBe(true);
    await flush();
    expect(send).toHaveBeenLastCalledWith({ type: 'aipaste-event', category: 'emails', action: 'blocked' });
    const root = shadow()!;
    expect(root.querySelector('[data-action=paste]')).toBeNull();
    (root.querySelector('[data-action=cancel]') as HTMLButtonElement).click();
    expect(ta.value).toBe('ab');
  });

  it('Learn why opens the lesson and leaves the overlay and its choices alone', async () => {
    const shadow = captureShadow();
    const { send, ta } = await setup('warn');
    paste(ta, SECRET);
    const root = shadow()!;
    const learn = root.querySelector('[data-action=learn]') as HTMLButtonElement;
    expect(learn.textContent).toBe('Learn why (60 s)');
    learn.click();
    await flush();
    expect(send).toHaveBeenLastCalledWith({ type: 'open-lesson', kind: 'aipaste' });
    expect(root.querySelector('[data-action=paste]')).toBeTruthy();
    expect(root.querySelector('[data-action=cancel]')).toBeTruthy();
    expect(ta.value).toBe('ab');
    expect(send.mock.calls.some((c) => (c[0] as { type: string }).type === 'aipaste-event')).toBe(false);
  });

  it('puts the overlay back when a page script removes it', async () => {
    await setup('warn');
    paste(document.getElementById('t')!, SECRET);
    document.querySelector('[data-rl-paste-warning]')!.remove();
    await flush();
    expect(document.querySelector('[data-rl-paste-warning]')).not.toBeNull();
  });

  it('ignores untrusted pastes, non-text fields and mode off', async () => {
    let s = await setup('warn', false);
    expect(paste(s.ta, SECRET).defaultPrevented).toBe(false);
    disposers.pop()!();
    s = await setup('warn');
    expect(paste(s.pw, SECRET).defaultPrevented).toBe(false);
    disposers.pop()!();
    s = await setup('off');
    expect(paste(s.ta, SECRET).defaultPrevented).toBe(false);
  });

  it('editableTarget and locale selection', () => {
    document.body.innerHTML = '<div contenteditable="true"><span id="s">x</span></div><input id="n" type="number">';
    expect(editableTarget(document.getElementById('n'))).toBeNull();
    expect(editableTarget(document.getElementById('s'))?.tagName).toBe('SPAN');
    expect(pickLocale('de', 'fr-FR')).toBe('de');
    expect(pickLocale(undefined, 'uk-UA')).toBe('uk');
    expect(pickLocale('xx', 'zz')).toBe('en');
    expect(pasteText('card', true, 'fr').body).toContain('un numéro de carte de paiement');
  });
});
