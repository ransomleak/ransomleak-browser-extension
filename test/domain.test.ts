import { describe, expect, it } from 'vitest';
import { parseHost, skeleton, SHARED_HOSTING } from '../src/lib/domain.ts';

describe('parseHost', () => {
  it('finds the registrable domain under a multi-label suffix', () => {
    const p = parseHost('https://login.acme.co.uk/x?y');
    expect(p?.registrable).toBe('acme.co.uk');
    expect(p?.label).toBe('acme');
    expect(p?.tld).toBe('co.uk');
    expect(p?.host).toBe('login.acme.co.uk');
    expect(p?.sharedHost).toBe(false);
  });
  it('treats private suffixes as shared hosting', () => {
    const p = parseHost('https://foo.pages.dev');
    expect(p?.sharedHost).toBe(true);
    expect(p?.registrable).toBe('foo.pages.dev');
    expect(p?.label).toBe('foo');
  });
  it('returns null for non-web or unparseable hosts', () => {
    for (const u of ['http://192.168.0.1', 'chrome://settings', 'about:blank', 'file:///a',
      'http://localhost:3000', 'http://[::1]/', 'not a url', 'https://foo.invalidtld']) {
      expect(parseHost(u)).toBeNull();
    }
  });
  it('matches manual shared-hosting entries that are not PSL suffixes', () => {
    const p = parseHost('https://x.sites.google.com/page');
    expect(p?.sharedHost).toBe(true);
    expect(p?.registrable).toBe('x.sites.google.com');
    expect(p?.label).toBe('x');
    const q = parseHost('https://a.b.blob.core.windows.net');
    expect(q?.registrable).toBe('b.blob.core.windows.net');
  });
  it('parses punycode hosts and rejects data: URLs', () => {
    expect(parseHost('https://xn--pple-43d.com')?.registrable).toBe('xn--pple-43d.com');
    expect(parseHost('data:text/html,x')).toBeNull();
  });
  it('never throws on malformed punycode', () => {
    for (const u of ['https://xn--é.com', 'https://xn--zzzzzzzzzzzzzzzzzzzzzzzzzzzz.com', 'https://xn--.com']) {
      expect(() => parseHost(u)).not.toThrow();
    }
  });
  it('exposes the shared hosting list; PSL-private platforms are shared without being listed', () => {
    expect(SHARED_HOSTING).toContain('sites.google.com');
    expect(SHARED_HOSTING).not.toContain('pages.dev');
    expect(parseHost('https://a.b.pages.dev/')).toMatchObject({ registrable: 'b.pages.dev', label: 'b', sharedHost: true });
    expect(parseHost('https://a.google-login.run.app/')).toMatchObject({ registrable: 'google-login.run.app', label: 'google-login', sharedHost: true });
  });
});

describe('skeleton', () => {
  it('maps punycode homoglyphs to the ASCII skeleton', () => {
    expect(skeleton('xn--pple-43d.com')).toBe(skeleton('apple.com'));
  });
  it('never throws on malformed punycode', () => {
    for (const x of ['xn--é', 'xn--zzzzzzzzzzzzzzzzzzzzzzzzzzzz.com', 'xn--', 'xn--a-.com']) {
      expect(() => skeleton(x)).not.toThrow();
    }
  });
  it('reaches a fixpoint so mapped capitals cannot bypass detection', () => {
    expect(skeleton('\uA4DFicrosoft')).toBe(skeleton('microsoft'));
    expect(skeleton('\u0410pple.com')).toBe(skeleton('apple.com')); // Cyrillic capital A
    expect(skeleton('\u0421\u043Eogle.com')).toBe(skeleton('coogle.com')); // mixed-case Cyrillic
    expect(skeleton('\u041CICROSOFT')).toBe(skeleton('microsoft'));
    expect(skeleton('g\u041E\u041Egle.com')).toBe(skeleton('google.com'));
  });
  it('lowercases', () => {
    expect(skeleton('APPLE.com')).toBe(skeleton('apple.com'));
  });
  it('follows the Unicode confusables table (m maps to rn)', () => {
    expect(skeleton('m')).toBe(skeleton('rn'));
  });
});
