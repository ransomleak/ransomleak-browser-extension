import { cleanName, finish, headingEmphasis, headings } from './dom.ts';
import type { Parser } from './types.ts';

/*
 * Slack (slack.com/oauth/...), signals in priority order:
 *  1. URL: `client_id` -> appId, `scope` (comma separated) -> bot scopes,
 *     `user_scope` -> user scopes, stored with a `user:` prefix.
 *  2. Headings: "<App> is requesting permission to access ..." (or "wants to access") -> appName.
 *     Verified = POSITIVE badge only (exact "Verified by Slack Marketplace" element).
 *  3. Fallback only when the URL has no scopes: <li> descriptions.
 * Name missing or no scopes -> null (fail closed).
 */
export const parseSlack: Parser = (doc, url, stored) => {
  let appName: string | null = null;
  for (const h of headings(doc)) {
    const m = /^(.+?) (?:is requesting permission|wants to access|would like to)/i.exec(h);
    if (m) { appName = m[1]!; break; }
  }
  appName = cleanName(appName ?? headingEmphasis(doc) ?? '');
  return finish(doc, url, { provider: 'slack', appName, badges: ['verified by slack marketplace', 'slack marketplace verified', 'verified app'], stored });
};
