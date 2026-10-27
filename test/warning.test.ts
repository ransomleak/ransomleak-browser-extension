// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render } from '../src/warning/warning.ts';
import { stringsFor } from '../src/lib/i18n.ts';
import en from '../src/lib/i18n/en.json';

const LOCALES = ['en', 'de', 'fr', 'it', 'nl', 'uk'];

const base = { domain: 'acrne.com', kind: 'tenant' as const, mode: 'warn' as const, highlight: [0, 5] as [number, number], learn: true, locale: 'en' };

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
  it('block mode replaces Continue with Request access; no learn link without a mapping', () => {
    const act = vi.fn();
    render(document, { ...base, mode: 'block', learn: false }, stringsFor('en'), act);
    const actions = [...document.querySelectorAll('button')].map((b) => b.dataset['action']);
    expect(actions).toEqual(['back', 'request']);
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
    expect(actions).toEqual(['back', 'keep']);
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
