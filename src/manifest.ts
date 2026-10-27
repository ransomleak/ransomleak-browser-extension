import { aiToolMatches, DEFAULT_AI_TOOLS } from './detect/ai-tools.ts';

const PROD_CONNECTABLE = ['https://app.ransomleak.com/*', 'https://app.eu.ransomleak.com/*'];
const DEV_CONNECTABLE = ['https://app.localhost:*/*'];

// Consent-page match patterns (spec section 6.3). Must equal permissions.lock.json.
export const CONSENT_MATCHES = [
  'https://login.microsoftonline.com/*/oauth2/*',
  'https://login.microsoftonline.com/*/reprocess*',
  'https://login.microsoftonline.com/*/SAS/ProcessAuth*',
  'https://login.microsoftonline.com/*/login*',
  'https://login.microsoftonline.com/*/kmsi*',
  'https://accounts.google.com/signin/oauth/*',
  'https://accounts.google.com/o/oauth2/*',
  'https://slack.com/oauth/*',
  'https://*.slack.com/oauth*',
];

/**
 * Optional host permissions: the AI tool sites the sensitive-paste check runs on (built-in tool list).
 * A tool the server adds later is covered only once a release adds it here. Must equal permissions.lock.json.
 */
export const AI_ORIGINS = aiToolMatches(DEFAULT_AI_TOOLS);

export function buildManifest(dev: boolean, stagingBase?: string) {
  const host_permissions: string[] = [];
  return {
    host_permissions,
    manifest_version: 3 as const,
    name: 'RansomLeak Security Awareness',
    version: '1.1.0',
    description: 'Warns you about look-alike, newly registered and reported phishing sites, and risky app permission screens.',
    icons: { '16': 'icons/icon-16.png', '32': 'icons/icon-32.png', '48': 'icons/icon-48.png', '128': 'icons/icon-128.png' },
    // activeTab: the popup's "Report this site" reads the current tab's host (granted per click, no install warning).
    // scripting: registers the AI paste script only after the optional AI-site access is granted.
    permissions: ['webNavigation', 'storage', 'alarms', 'scripting', 'activeTab'],
    // "Extra protection" (downloads, AI-site access) and "Turn on reminders" (notifications), each requested
    // from the popup on a click; never at install.
    optional_permissions: ['downloads', 'notifications'],
    optional_host_permissions: AI_ORIGINS,
    background: { service_worker: 'src/background/index.ts', type: 'module' as const },
    action: {
      default_popup: 'src/popup/popup.html',
      default_title: 'RansomLeak',
      default_icon: { '16': 'icons/icon-16.png', '32': 'icons/icon-32.png' },
    },
    content_scripts: [
      { matches: CONSENT_MATCHES, js: ['src/content/consent/index.ts'], run_at: 'document_idle' as const },
    ],
    externally_connectable: {
      matches: dev ? [...PROD_CONNECTABLE, ...DEV_CONNECTABLE] : stagingBase ? [...PROD_CONNECTABLE, `${stagingBase}/*`] : PROD_CONNECTABLE,
    },
    storage: { managed_schema: 'managed-schema.json' },
  };
}
