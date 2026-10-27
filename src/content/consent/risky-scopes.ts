import type { Provider } from './types.ts';

// Default list; the policy (spec section 7) ships a versioned replacement.
// Slack user scopes are written `user:<scope>` (see slack.ts).
export const DEFAULT_RISKY_SCOPES: Record<Provider, string[]> = {
  microsoft: [
    'Mail.ReadWrite', 'Mail.Send', 'Mail.Read', 'Files.ReadWrite.All', 'Sites.ReadWrite.All',
    'Directory.ReadWrite.All', 'User.ReadWrite.All', 'full_access_as_user', 'EWS.AccessAsUser.All',
  ],
  google: [
    'https://mail.google.com/', 'gmail.modify', 'gmail.send', 'gmail.readonly', 'drive', 'admin.directory.*',
  ],
  slack: ['admin', 'channels:history', 'groups:history', 'im:history', 'files:read', 'user:chat:write'],
};
