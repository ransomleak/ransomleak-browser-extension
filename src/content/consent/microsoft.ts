import { cleanName, finish, headingEmphasis, headings, safeText } from './dom.ts';
import type { OAuthRequest } from '../../lib/oauth-request.ts';
import type { ConsentInfo, Parser } from './types.ts';

/**
 * Microsoft's post-sign-in steps that can render the consent screen: `/<tenant>/reprocess` (existing session),
 * and after a fresh sign-in `/<tenant>/SAS/ProcessAuth` (after MFA), `/<tenant>/login` and `/<tenant>/kmsi`.
 * The same paths also render password, MFA and "Stay signed in?" pages, so the parser stays inert unless the
 * consent form is present and there is no password field.
 */
export const MS_REPROCESS = /^\/[^/]+\/(reprocess|sas\/processauth|login|kmsi)\/?$/i;

/**
 * Consent labels on the reprocess page are English sentences (even in localized UIs). Known phrases map to
 * scope ids for risk matching; unknown text stays as-is (DOM source: fail closed).
 */
const PHRASES: Array<[RegExp, string]> = [
  [/^have full access to your mailbox$/i, 'full_access_as_user'],
  [/^read and write access to your mail$/i, 'Mail.ReadWrite'],
  [/^read your mail$/i, 'Mail.Read'],
  [/^send mail as you$/i, 'Mail.Send'],
  [/^maintain access to data you have given it access to$/i, 'offline_access'],
  [/^view your basic profile$/i, 'profile'],
  [/^view your email address$/i, 'email'],
  [/^sign you in and read your profile$/i, 'User.Read'],
  [/^have full access to all files you have access to$/i, 'Files.ReadWrite.All'],
  [/^read all files that you have access to$/i, 'Files.Read.All'],
  [/^have full access to your files$/i, 'Files.ReadWrite'],
  [/^read your files$/i, 'Files.Read'],
  [/^edit or delete items in all site collections$/i, 'Sites.ReadWrite.All'],
  [/^read items in all site collections$/i, 'Sites.Read.All'],
  [/^have full control of all site collections$/i, 'Sites.FullControl.All'],
  [/^read directory data$/i, 'Directory.Read.All'],
  [/^read and write directory data$/i, 'Directory.ReadWrite.All'],
  [/^access the directory as you$/i, 'Directory.AccessAsUser.All'],
  [/^read all users' full profiles$/i, 'User.Read.All'],
  [/^read and write access to your calendars?$/i, 'Calendars.ReadWrite'],
  [/^read and write your contacts$/i, 'Contacts.ReadWrite'],
];

export function scopeFromLabel(label: string): string | null {
  const t = label.replace(/[‘’]/g, "'").replace(/\.$/, '').trim();
  return PHRASES.find(([re]) => re.test(t))?.[1] ?? null;
}

/**
 * Consent step on /reprocess. Inert unless the Consent/Set form and its acceptConsent input exist and the page
 * has no password field (password/MFA/KMSI steps share the path). Never reads input values, only presence.
 */
export function parseMicrosoftReprocess(doc: Document, stored: OAuthRequest | null | undefined): ConsentInfo | null {
  if (doc.querySelector('input[type="password" i]')) return null;
  const form = doc.querySelector('form[action*="/Consent/Set" i]');
  if (!form || !doc.querySelector('input[name="acceptConsent"]')) return null;
  const st = stored && stored.provider === 'microsoft' ? stored : null;
  const labels = Array.from(doc.querySelectorAll('div.scope .label')).map(safeText).filter(Boolean);
  const mapped = labels.map((l) => scopeFromLabel(l) ?? l);
  const storedScopes = st?.scopes ?? [];
  const scopes = Array.from(new Set([...storedScopes, ...mapped]));
  if (!scopes.length) return null;
  const pub = doc.getElementById('appDomainLinkToAppInfo');
  let prev = pub?.previousElementSibling ?? null;
  // The link may be wrapped; walk up until a preceding sibling exists (stay inside the form).
  for (let a: Element | null = pub ?? null; !prev && a && a !== form; a = a.parentElement) prev = a.previousElementSibling;
  const displayAppId = st?.clientId ?? null;
  const appName = cleanName((prev ? safeText(prev) : '') || '') ?? (displayAppId ? cleanName(displayAppId) : null);
  if (!appName) return null;
  const publisher = pub ? cleanName(safeText(pub)) : null;
  // Verified badge: Microsoft renders `img.consent-badge` right after the publisher link (captured 2026-10-24).
  // Only that specific badge counts; anything else is unverified, so a layout change can only make the
  // warning stricter, never suppress it.
  // Bound to the publisher: the link's accessible label names the publisher plus a (localized) "verified"
  // phrase, e.g. "Microsoft Corporation ... verified"; an unverified publisher's label is just its name.
  const badge = pub?.parentElement?.querySelector(':scope > img.consent-badge');
  const label = (pub?.getAttribute('aria-label') ?? '').trim();
  const verified = !!publisher && !!badge && label.includes(publisher) && label.length > publisher.length;
  // Stored scopes are trusted only when every label maps to one of them; otherwise fail closed.
  const unverifiedScopes = !!storedScopes.length && mapped.some((m) => !storedScopes.some((s) => s.toLowerCase() === m.toLowerCase()));
  return {
    provider: 'microsoft', appName, appId: null, displayAppId, verified, scopes,
    scopeSource: storedScopes.length ? 'url' : 'dom',
    ...(publisher ? { publisher } : {}),
    ...(unverifiedScopes ? { unverifiedScopes } : {}),
  };
}

/*
 * Microsoft (login.microsoftonline.com/<tenant>/oauth2/...), signals in priority order:
 *  1. URL: `client_id` -> appId, `scope` (space separated) -> scopes.
 *  2. ARIA/headings: app name is the heading after the "Permissions requested" heading, or
 *     "<App> wants to access ..." / "<App> needs permission ..." heading.
 *     Verified = POSITIVE only: a non-heading, non-list element whose whole text/aria-label equals
 *     "Publisher verified" and does not contain the app name. Otherwise unverified.
 *  3. Fallback only when the URL has no `scope`: <li> items under the page (human descriptions).
 * No class names or ids are used. Anything missing -> null (fail closed).
 */
export const parseMicrosoft: Parser = (doc, url, stored) => {
  if (MS_REPROCESS.test(url.pathname)) return parseMicrosoftReprocess(doc, stored);
  const hs = headings(doc);
  let appName: string | null = null;
  const i = hs.findIndex((h) => /^permissions requested$/i.test(h));
  if (i >= 0) appName = hs.slice(i + 1).find((h) => !/would like to|permissions|^accept/i.test(h)) ?? null;
  if (!appName) {
    for (const h of hs) {
      const m = /^(.+?) (?:wants to access|needs permission)/i.exec(h);
      if (m) { appName = m[1]!; break; }
    }
  }
  appName = cleanName(appName ?? headingEmphasis(doc) ?? '');
  return finish(doc, url, { provider: 'microsoft', appName, badges: ['publisher verified', 'verified publisher'], stored });
};
