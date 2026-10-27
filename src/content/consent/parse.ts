import { parseGoogle } from './google.ts';
import { parseMicrosoft } from './microsoft.ts';
import { parseSlack } from './slack.ts';
import type { OAuthRequest } from '../../lib/oauth-request.ts';
import type { ConsentInfo, Parser, Provider } from './types.ts';

const PARSERS: Record<Provider, Parser> = { microsoft: parseMicrosoft, google: parseGoogle, slack: parseSlack };

/** Never throws; unknown markup yields null so the page is left alone. */
export function parseConsent(doc: Document, provider: Provider, url: URL, stored: OAuthRequest | null = null): ConsentInfo | null {
  try {
    return PARSERS[provider](doc, url, stored);
  } catch {
    return null;
  }
}

export { providerForHost } from '../../lib/providers.ts';
