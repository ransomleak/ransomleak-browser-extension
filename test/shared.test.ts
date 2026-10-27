import { describe, expect, it } from 'vitest';
import { mergeRefresh } from '../src/background/api.ts';
import { modeOf } from '../src/background/store.ts';
import type { Auth } from '../src/background/store.ts';
import { consentMode } from '../src/content/consent/policy.ts';
import { providerForHost as contentProviderForHost } from '../src/content/consent/parse.ts';
import { PROVIDER_HOSTS, PROVIDERS, providerForHost } from '../src/lib/providers.ts';

const AUTH: Auth = {
  token: 'tok', refreshToken: 'rt', expiresAt: '2099-01-01T00:00:00Z', tenant: 'acme', tenantName: 'Acme',
  tenantOrigin: 'https://acme.ransomleak.com', apiBaseUrl: 'https://app.ransomleak.com', locale: 'de', generation: 3,
};

describe('mergeRefresh', () => {
  it('a minimal refresh response keeps tenant fields and locale', () => {
    const next = mergeRefresh(AUTH, { token: 'new', refreshToken: 'newrt', expiresAt: '2100-01-01T00:00:00Z' });
    expect(next).toEqual({ ...AUTH, token: 'new', refreshToken: 'newrt', expiresAt: '2100-01-01T00:00:00Z', needsReauth: undefined });
  });
  it('fields present in the response win; apiBaseUrl and generation never change', () => {
    const next = mergeRefresh(AUTH, { token: 'n', refreshToken: 'r', expiresAt: 'x', tenantName: 'Acme 2', locale: 'fr', apiBaseUrl: 'https://evil' });
    expect(next).toMatchObject({ tenantName: 'Acme 2', locale: 'fr', tenant: 'acme', apiBaseUrl: AUTH.apiBaseUrl, generation: 3 });
  });
  it('token/refreshToken/expiresAt always come from the response', () => {
    expect(mergeRefresh(AUTH, { token: 'n', refreshToken: 'r' })?.expiresAt).toBe('');
    expect(mergeRefresh(AUTH, { refreshToken: 'r' })).toBeNull();
  });
});

describe('oauth mode normalisation', () => {
  it.each([undefined, null, 'WARN', 'nope', 7, {}, 'warn', 'block', 'log', 'off'])('%s behaves the same in content and background', (v) => {
    const policy = { detectors: { oauth: v as never } };
    expect(consentMode(policy)).toBe(modeOf(policy.detectors.oauth));
  });
  it('unknown values fall back to warn', () => {
    expect(consentMode({ detectors: { oauth: 'bogus' as never } })).toBe('warn');
    expect(consentMode({})).toBe('warn');
  });
});

describe('providers', () => {
  it('providerForHost derives from PROVIDERS', () => {
    for (const p of PROVIDERS) expect(providerForHost(PROVIDER_HOSTS[p])).toBe(p);
    expect(providerForHost('evil.com')).toBeNull();
    expect(providerForHost('acme.slack.com')).toBe('slack');
    expect(providerForHost('a.b.slack.com')).toBe('slack');
    expect(providerForHost('evilslack.com')).toBeNull();
    expect(providerForHost('slack.com.evil.com')).toBeNull();
    expect(contentProviderForHost).toBe(providerForHost);
  });
});
