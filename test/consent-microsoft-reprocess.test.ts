// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConsent } from '../src/content/consent/parse.ts';
import { scopeFromLabel } from '../src/content/consent/microsoft.ts';
import { isRisky } from '../src/content/consent/risk.ts';
import { DEFAULT_RISKY_SCOPES } from '../src/content/consent/risky-scopes.ts';
import { CONSENT_MATCHES } from '../src/manifest.ts';

const load = (name: string): Document =>
  new DOMParser().parseFromString(readFileSync(join(process.cwd(), 'test/fixtures/consent', name + '.html'), 'utf8'), 'text/html');
const URL_R = new URL('https://login.microsoftonline.com/common/reprocess?ctx=abc&sessionid=def');
const CLIENT = '14d82eec-204b-4c2f-b7e8-296a70dab67e';
const stored = { provider: 'microsoft' as const, clientId: CLIENT, scopes: ['Mail.ReadWrite', 'offline_access', 'profile'], at: Date.now() };

describe('Microsoft /reprocess consent', () => {
  it('matches the reprocess path on the existing host', () => {
    expect(CONSENT_MATCHES).toContain('https://login.microsoftonline.com/*/reprocess*');
  });

  it('detects the consent step from the DOM (no stored request): risky, fail closed', () => {
    const info = parseConsent(load('microsoft-reprocess-consent'), 'microsoft', URL_R)!;
    expect(info.appName).toBe('Microsoft Graph Command Line Tools');
    expect(info.publisher).toBe('Microsoft Corporation');
    expect(info.scopes).toEqual(['Mail.ReadWrite', 'offline_access', 'profile']);
    expect(info.scopeSource).toBe('dom');
    expect(info.appId).toBeNull();
    expect(isRisky(info, DEFAULT_RISKY_SCOPES, [])).toBe(true);
  });

  it('uses the stored authorize request: URL source, Mail.ReadWrite + offline_access always risky even verified', () => {
    const info = parseConsent(load('microsoft-reprocess-consent'), 'microsoft', URL_R, stored)!;
    expect(info.scopeSource).toBe('url');
    expect(info.unverifiedScopes).toBeUndefined();
    expect(info.displayAppId).toBe(CLIENT);
    expect(info.verified).toBe(true);
    expect(isRisky(info, DEFAULT_RISKY_SCOPES, [])).toBe(true);
  });

  it('a verified publisher with benign stored scopes is not risky; unverified with the same is judged by the list', () => {
    const benign = { ...stored, scopes: ['profile'] };
    const doc = load('microsoft-reprocess-consent');
    doc.querySelectorAll('div.scope').forEach((e, i) => { if (i < 2) e.remove(); });
    const info = parseConsent(doc, 'microsoft', URL_R, benign)!;
    expect(info.verified).toBe(true);
    expect(isRisky(info, DEFAULT_RISKY_SCOPES, [])).toBe(false);
    doc.querySelector('.publisher img')!.remove();
    expect(parseConsent(doc, 'microsoft', URL_R, benign)!.verified).toBe(false);
  });
  it('an unverified layout (label is just the name, no badge) is unverified', () => {
    const doc = load('microsoft-reprocess-consent');
    const a = doc.querySelector('#appDomainLinkToAppInfo')!;
    a.setAttribute('aria-label', a.textContent!.trim());
    expect(parseConsent(doc, 'microsoft', URL_R, stored)!.verified).toBe(false);
    doc.querySelector('.publisher img')!.remove();
    expect(parseConsent(doc, 'microsoft', URL_R, stored)!.verified).toBe(false);
  });
  it('a badge whose link label does not name the publisher is not verified', () => {
    const doc = load('microsoft-reprocess-consent');
    doc.querySelector('#appDomainLinkToAppInfo')!.setAttribute('aria-label', 'Contoso Ltd verified');
    expect(parseConsent(doc, 'microsoft', URL_R, stored)!.verified).toBe(false);
  });
  it('only the consent-badge image counts as the verified badge', () => {
    const doc = load('microsoft-reprocess-consent');
    doc.querySelector('.publisher img')!.className = 'help-icon';
    expect(parseConsent(doc, 'microsoft', URL_R, stored)!.verified).toBe(false);
  });

  it('page labels beyond the stored scopes fail closed (unverifiedScopes)', () => {
    const info = parseConsent(load('microsoft-reprocess-consent'), 'microsoft', URL_R, { ...stored, scopes: ['profile'] })!;
    expect(info.unverifiedScopes).toBe(true);
    expect(isRisky(info, DEFAULT_RISKY_SCOPES, [])).toBe(true);
  });

  it('unknown label text is kept verbatim (DOM, fail closed)', () => {
    const doc = load('microsoft-reprocess-consent');
    doc.querySelector('div.scope .label')!.textContent = 'Do something new';
    const info = parseConsent(doc, 'microsoft', URL_R)!;
    expect(info.scopes).toContain('Do something new');
    expect(isRisky(info, DEFAULT_RISKY_SCOPES, [])).toBe(true);
  });

  it('maps known phrases to scope ids', () => {
    expect(scopeFromLabel('Send mail as you')).toBe('Mail.Send');
    expect(scopeFromLabel('Read your mail')).toBe('Mail.Read');
    expect(scopeFromLabel('Have full access to your mailbox')).toBe('full_access_as_user');
    expect(scopeFromLabel('Read directory data')).toBe('Directory.Read.All');
    expect(scopeFromLabel('Something else')).toBeNull();
  });

  it('is inert on the password and MFA steps of the same path, even with a stored request', () => {
    expect(parseConsent(load('microsoft-reprocess-password'), 'microsoft', URL_R, stored)).toBeNull();
    expect(parseConsent(load('microsoft-reprocess-mfa'), 'microsoft', URL_R, stored)).toBeNull();
  });

  it('detects the consent step after a fresh sign-in (SAS/ProcessAuth, login, kmsi); inert on their password pages', () => {
    for (const path of ['/common/SAS/ProcessAuth', '/organizations/login', '/common/kmsi']) {
      const u = new URL(`https://login.microsoftonline.com${path}`);
      const info = parseConsent(load('microsoft-reprocess-consent'), 'microsoft', u, stored);
      expect(info?.appName).toBe('Microsoft Graph Command Line Tools');
      expect(parseConsent(load('microsoft-reprocess-password'), 'microsoft', u, stored)).toBeNull();
    }
    expect(parseConsent(load('microsoft-reprocess-consent'), 'microsoft', new URL('https://login.microsoftonline.com/common/oauth2/logout'), null)).toBeNull();
  });
  it('is inert when a password field appears on a consent-looking page', () => {
    const doc = load('microsoft-reprocess-consent');
    const pw = doc.createElement('input');
    pw.type = 'password';
    doc.querySelector('form')!.appendChild(pw);
    expect(parseConsent(doc, 'microsoft', URL_R, stored)).toBeNull();
  });

  it('never reads input values', () => {
    const doc = load('microsoft-reprocess-consent');
    for (const el of Array.from(doc.querySelectorAll('input'))) {
      Object.defineProperty(el, 'value', { get() { throw new Error('value read'); } });
    }
    const info = parseConsent(doc, 'microsoft', URL_R, stored)!;
    expect(info).not.toBeNull();
    expect(JSON.stringify(info)).not.toMatch(/SECRET/);
  });
});
