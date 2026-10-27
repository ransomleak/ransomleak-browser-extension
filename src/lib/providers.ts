// OAuth consent providers and their consent-page hosts. Single source for background and content script.
export const PROVIDER_HOSTS = {
  microsoft: 'login.microsoftonline.com',
  google: 'accounts.google.com',
  slack: 'slack.com',
} as const;
export type Provider = keyof typeof PROVIDER_HOSTS;
export const PROVIDERS = Object.keys(PROVIDER_HOSTS) as Provider[];
export const isProvider = (p: unknown): p is Provider => PROVIDERS.includes(p as Provider);
export const providerForHost = (host: string): Provider | null =>
  PROVIDERS.find((p) => PROVIDER_HOSTS[p] === host) ?? (host.endsWith('.slack.com') ? 'slack' : null);
