import type { OAuthRequest } from '../../lib/oauth-request.ts';
import type { Provider } from '../../lib/providers.ts';

export type { Provider };
export type ConsentInfo = {
  provider: Provider;
  appName: string;
  /** The page URL's own client_id: the only id the approved-app exemption trusts. */
  appId: string | null;
  /** Client id for display/block requests only (may come from the stored request); never used for approval. */
  displayAppId?: string | null;
  /** Scopes came from the stored request and the page panel listed items too: fail closed. */
  unverifiedScopes?: boolean;
  verified: boolean;
  /** Publisher text shown on the page (Microsoft reprocess consent), display only. */
  publisher?: string;
  /** Raw scope strings. Slack user scopes are prefixed with `user:`. */
  scopes: string[];
  /** 'dom' = human-readable list text (never matches the risky list). */
  scopeSource: 'url' | 'dom';
};

export type Parser = (doc: Document, url: URL, stored?: OAuthRequest | null) => ConsentInfo | null;
