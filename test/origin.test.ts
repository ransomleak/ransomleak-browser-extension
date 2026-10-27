import { describe, expect, it } from 'vitest';
import { appLinks, DEFAULT_APP_LINKS, isSafeAppPath, safeTenantOrigin, trainingUrl } from '../src/lib/origin.ts';

describe('safeTenantOrigin', () => {
  it('accepts https origins, including dev https://*.localhost', () => {
    expect(safeTenantOrigin('https://acme.ransomleak.com')).toBe('https://acme.ransomleak.com');
    expect(safeTenantOrigin('https://app.localhost:5172/x')).toBe('https://app.localhost:5172');
  });
  it.each(['http://acme.ransomleak.com', 'javascript:alert(1)', 'chrome-extension://abc', 'https://u:p@acme.com', 'not a url', '', undefined, 5])(
    'rejects %j',
    (v) => expect(safeTenantOrigin(v)).toBeNull(),
  );
});

describe('trainingUrl', () => {
  const O = 'https://acme.ransomleak.com';
  const ID = '11111111-2222-4333-8444-555555555555';
  const ML = `${O}/app/microlearning?highlight=${ID}`;

  it('uses a valid server path on the tenant origin', () => {
    expect(trainingUrl(O, `/app/courses/${ID}`, ID)).toBe(`${O}/app/courses/${ID}`);
    expect(trainingUrl(O, `/app/microlearning?highlight=${ID}`, ID)).toBe(ML);
  });
  it('falls back to Microlearning when the path is absent (older backend)', () => {
    expect(trainingUrl(O, undefined, ID)).toBe(ML);
  });
  it.each([
    'https://evil.com/app/x',
    '//evil.com/app/x',
    '/app//evil.com',
    '/\\evil.com',
    '/app/../admin',
    '/admin/users',
    'app/courses/x',
    'javascript:alert(1)',
    '/app/x#frag',
    `/app/${'a'.repeat(600)}`,
    42,
  ])('rejects path %j and falls back', (p) => {
    expect(isSafeAppPath(p)).toBe(false);
    expect(trainingUrl(O, p, ID)).toBe(ML);
  });
  it('returns null on an unsafe origin or with nothing usable', () => {
    expect(trainingUrl('http://acme.ransomleak.com', `/app/courses/${ID}`, ID)).toBeNull();
    expect(trainingUrl(O, 'bad', undefined)).toBeNull();
  });
});

describe('appLinks', () => {
  it('uses safe server links', () => {
    expect(appLinks({ todo: '/app/todo', training: '/app/learn', home: '/app' })).toEqual({ todo: '/app/todo', training: '/app/learn' });
  });
  it.each([undefined, null, 'x', {}, { todo: 'https://evil.com/app/x', training: '/app/../admin' }, { todo: '/app/x?y=1', training: 42 }])(
    'falls back to the built-in pages for %j',
    (raw) => expect(appLinks(raw)).toEqual(DEFAULT_APP_LINKS),
  );
  it('trainingUrl falls back to the given Microlearning page', () => {
    const O = 'https://acme.ransomleak.com';
    expect(trainingUrl(O, undefined, 'abc', '/app/learn')).toBe(`${O}/app/learn?highlight=abc`);
    expect(trainingUrl(O, undefined, 'abc', '//evil.com/app')).toBe(`${O}/app/microlearning?highlight=abc`);
  });
});
