// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, renderStandalone, type WarningInfo } from '../src/warning/warning.ts';
import { renderLesson } from '../src/warning/lesson.ts';
import { stringsFor } from '../src/lib/i18n.ts';
import en from '../src/lib/i18n/en.json';

const LOCALES = ['en', 'de', 'fr', 'it', 'nl', 'uk'];

const base = { domain: 'acrne.com', kind: 'tenant' as const, mode: 'warn' as const, highlight: [0, 5] as [number, number], locale: 'en',
  lesson: { kind: 'lookalike' as const, genuine: null, deny: [] as string[], course: false } };

describe('warning page', () => {
  it('renders the domain with the lookalike part highlighted as text, and warn buttons', () => {
    const act = vi.fn();
    render(document, { ...base, domain: '<img src=x onerror=alert(1)>.com', highlight: [0, 4] }, stringsFor('en'), act);
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('mark')!.textContent).toBe('<img');
    const actions = [...document.querySelectorAll('button')].map((b) => b.dataset['action']);
    expect(actions).toEqual(['back', 'continue', 'learn']);
    expect(document.querySelectorAll('main > .brand svg .eye')).toHaveLength(2); // the shared full owl
    (document.querySelector('[data-action=back]') as HTMLButtonElement).click();
    expect(act).toHaveBeenCalledWith('back');
  });
  it('block mode replaces Continue with Request access; Learn why is always present', () => {
    const act = vi.fn();
    render(document, { ...base, mode: 'block' }, stringsFor('en'), act);
    const actions = [...document.querySelectorAll('button')].map((b) => b.dataset['action']);
    expect(actions).toEqual(['back', 'request', 'learn']);
    (document.querySelector('[data-action=request]') as HTMLButtonElement).click();
    expect(act).toHaveBeenCalledWith('request');
  });
  it('the brand-watch variant has its own title and body', () => {
    render(document, { ...base, kind: 'watch' }, stringsFor('en'), vi.fn());
    expect(document.querySelector('h1')!.textContent).toBe('This site imitates your company');
    expect(document.body.textContent).toContain(en.body_watch);
  });
  it('download variant: file name and host as text, Go back / Keep download', () => {
    const act = vi.fn();
    render(document, { ...base, kind: 'download', filename: '<img src=x>.exe', domain: 'acrne.com' }, stringsFor('en'), act);
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('h1')!.textContent).toBe(en.title_download);
    expect(document.querySelector('.file')!.textContent).toBe('<img src=x>.exe');
    expect(document.querySelector('.from')!.textContent).toBe('acrne.com');
    const actions = [...document.querySelectorAll('button')].map((b) => b.dataset['action']);
    expect(actions).toEqual(['back', 'keep', 'learn']);
    (document.querySelector('[data-action=keep]') as HTMLButtonElement).click();
    expect(act).toHaveBeenCalledWith('keep');
  });
  it('every locale has every key; unknown locale falls back to en', async () => {
    for (const l of LOCALES) {
      const s = (await import(`../src/lib/i18n/${l}.json`)).default as Record<string, string>;
      expect(Object.keys(s).sort()).toEqual(Object.keys(en).sort());
      for (const v of Object.values(s)) expect(v.trim()).not.toBe('');
    }
    expect(stringsFor('xx')).toEqual(en);
  });
});

const click = (sel: string): void => (document.querySelector(sel) as HTMLButtonElement).click();
const next = (): void => click('button.primary');
const options = (): HTMLButtonElement[] => [...document.querySelectorAll<HTMLButtonElement>('.options button')];

describe('lesson inside the warning page', () => {
  const info: WarningInfo = {
    ...base, domain: 'paypa1-login.com', highlight: [0, 6],
    lesson: { kind: 'lookalike', genuine: 'paypal.com', deny: ['paypal.com'], course: true },
  };

  it('Learn why opens the 4 steps; wrong answer explains, right one records once', () => {
    const act = vi.fn();
    render(document, info, stringsFor('en'), act);
    click('[data-action=learn]');
    expect(act).not.toHaveBeenCalled();
    expect(document.querySelector('main > .brand')).not.toBeNull();
    expect(document.querySelectorAll('.dots i.on')).toHaveLength(1);
    expect(document.activeElement).toBe(document.querySelector('h1'));
    expect(document.querySelector('.case mark')!.textContent).toBe('paypa1');
    expect(document.querySelector('.real')!.textContent).toBe('paypal.com');
    expect(document.body.textContent).toContain(en.lesson_real_one);
    next();
    expect(document.querySelectorAll('.habits li')).toHaveLength(2);
    next();
    expect(document.querySelector('h1')!.textContent).toBe('Which one is really paypal.com?');
    const opts = options();
    expect(opts).toHaveLength(3);
    expect(opts.map((o) => o.textContent)).not.toContain('paypa1-login.com');
    opts.find((o) => o.textContent !== 'paypal.com')!.click();
    expect(document.querySelector('.why')!.textContent).toBe(en.lesson_lookalike_why);
    expect(document.querySelector('.why')!.getAttribute('role')).toBe('status');
    expect(options().filter((o) => o.getAttribute('aria-pressed') === 'true')).toHaveLength(1);
    expect(options().filter((o) => o.getAttribute('aria-pressed') === 'false')).toHaveLength(2);
    expect(options().every((o) => !o.disabled)).toBe(true);
    expect(act).not.toHaveBeenCalledWith('lesson-done');
    options().find((o) => o.textContent === 'paypal.com')!.click();
    expect(act.mock.calls.filter((c) => c[0] === 'lesson-done')).toHaveLength(1);
    expect(document.querySelector('h1')!.textContent).toBe(en.lesson_done_title);
    expect([...document.querySelectorAll('.actions button')].map((b) => b.textContent)).toEqual([en.lesson_back_safety, en.lesson_open_course]);
    expect(document.activeElement).toBe(document.querySelector('h1'));
    click('button.secondary');
    expect(act).toHaveBeenCalledWith('learn');
    click('button.primary');
    expect(act).toHaveBeenCalledWith('back');
  });

  it('done has no course button when course is false; Back to warning restores the warning', () => {
    const act = vi.fn();
    render(document, { ...info, kind: 'risky', lesson: { kind: 'new_domain', genuine: null, deny: [], course: false } }, stringsFor('en'), act);
    click('[data-action=learn]');
    expect(document.body.textContent).toContain(en.lesson_new_domain_what);
    click('.back-warning');
    expect([...document.querySelectorAll('button')].map((b) => b.dataset['action'])).toEqual(['back', 'continue', 'learn']);
    click('[data-action=learn]');
    next(); next();
    expect(document.querySelector('h1')!.textContent).toBe(en.lesson_new_domain_q);
    options().find((o) => o.textContent === en.lesson_new_domain_a)!.click();
    expect([...document.querySelectorAll('.actions button')].map((b) => b.textContent)).toEqual([en.lesson_back_safety]);
  });

  it('lookalike without a genuine domain uses the fixed PayPal question', () => {
    const record = vi.fn();
    renderLesson(document, { kind: 'lookalike', domain: 'acrne.com', highlight: [0, 5], genuine: null, course: false, standalone: false }, stringsFor('en'), vi.fn(), record);
    expect(document.querySelector('.real')).toBeNull();
    next(); next();
    expect(document.querySelector('h1')!.textContent).toBe(en.lesson_lookalike_q);
    options().find((o) => o.textContent === 'paypal.com')!.click();
    expect(record).toHaveBeenCalledTimes(1);
  });
});

describe('standalone lesson', () => {
  const finish = (): void => {
    next(); next();
    options().find((o) => o.textContent === en.lesson_aipaste_a)!.click();
  };
  it('?lesson=aipaste&d=chatgpt.com: fixed copy, records once, Back to safety closes the tab', () => {
    const send = vi.fn();
    const close = vi.fn();
    expect(renderStandalone(document, '?lesson=aipaste&d=chatgpt.com', 'en', send, close)).toBe(true);
    expect(document.body.textContent).toContain(en.lesson_aipaste_what);
    expect(document.querySelector('.back-warning')).toBeNull();
    finish();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ type: 'lesson-done', kind: 'aipaste', domain: 'chatgpt.com' });
    click('button.primary');
    expect(close).toHaveBeenCalled();
  });
  it.each(['java script', 'javascript:alert(1)', 'a b', 'x'.repeat(300) + '.com', 'Chatgpt.com', 'localhost'])('invalid d=%s renders but never records', (d) => {
    const send = vi.fn();
    expect(renderStandalone(document, `?lesson=aipaste&d=${encodeURIComponent(d)}`, 'en', send, vi.fn())).toBe(true);
    finish();
    expect(document.querySelector('h1')!.textContent).toBe(en.lesson_done_title);
    expect(send).not.toHaveBeenCalled();
  });
  it('back-to-warning arrow is aria-hidden and the label stays in the button', () => {
    render(document, { ...base, lesson: { kind: 'lookalike', genuine: 'paypal.com', deny: [], course: false } }, stringsFor('en'), vi.fn());
    click('[data-action=learn]');
    const arrow = document.querySelector('.back-warning > span')!;
    expect(arrow.getAttribute('aria-hidden')).toBe('true');
    expect(document.querySelector('.back-warning')!.textContent).toContain(en.lesson_back_warning);
  });
  it('unknown lesson kinds are not standalone', () => {
    expect(renderStandalone(document, '?lesson=lookalike&d=a.com', 'en', vi.fn(), vi.fn())).toBe(false);
    expect(renderStandalone(document, '', 'en', vi.fn(), vi.fn())).toBe(false);
  });
});
