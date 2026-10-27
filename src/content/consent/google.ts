import { consentContainer, cleanName, finish, headingEmphasis, headings } from './dom.ts';
import type { Parser } from './types.ts';

/*
 * Google (accounts.google.com/o/oauth2/*, /signin/oauth/*), signals in priority order:
 *  1. URL: `client_id` -> appId, `scope` (space separated) -> scopes; else the request the background
 *     captured from earlier authorize URLs in this tab (the v3 consent URL carries no `scope`).
 *  2. App name: English "<App> wants access ..." heading, else the link/emphasis inside the main heading
 *     (language-independent), else the client id on the consent path.
 *     Verified = POSITIVE badge only (exact "Verified by Google" element); unknown = unverified.
 *  3. Last resort: <li> descriptions inside the consent container.
 */
export const parseGoogle: Parser = (doc, url, stored) => {
  let appName: string | null = null;
  for (const h of headings(doc)) {
    const m = /^(.+?) wants (?:access|to access)/i.exec(h);
    if (m) { appName = m[1]!; break; }
  }
  // Google marks the developer's app name with data-app-name (language-independent); only inside the consent panel.
  const tagged = (consentContainer(doc) ?? doc.body)?.querySelector('[data-app-name]')?.getAttribute('data-app-name') ?? null;
  appName = cleanName(appName ?? tagged ?? headingEmphasis(doc) ?? '');
  return finish(doc, url, { provider: 'google', appName, badges: ['verified by google', 'google verified'], stored });
};
