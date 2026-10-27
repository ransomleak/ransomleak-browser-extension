// Policy access for the consent content script. Importing store.ts is safe: the content script is
// built as one self-contained IIFE (vite.config.ts), so nothing becomes a shared, web-accessible chunk.
import { getAuth, getPolicy, type Policy } from '../../background/store.ts';
import { modeOf, type Mode } from '../../lib/mode.ts';

export type ConsentPolicy = Pick<Policy, 'detectors' | 'riskyScopes' | 'approvedOAuthAppIds'>;

export async function readPolicy(): Promise<ConsentPolicy> {
  try {
    if (!chrome.runtime?.id) return {};
    return await getPolicy();
  } catch {
    return {};
  }
}

/** Same rule as the background's modeOf: unknown or missing modes behave as 'warn'. */
export const consentMode = (policy: ConsentPolicy): Mode => modeOf(policy.detectors?.oauth);

/** Tenant locale when enrolled (same source as the password warning), else undefined. */
export async function readLocale(): Promise<string | undefined> {
  try {
    if (!chrome.runtime?.id) return undefined;
    return (await getAuth())?.locale;
  } catch {
    return undefined;
  }
}
