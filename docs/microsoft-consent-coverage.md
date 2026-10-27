# Microsoft consent coverage: findings (1.1.0)

**Status: implemented (1.1.0, 2026-10-23)** for the `/reprocess` consent step captured below. Content script now also
matches `https://login.microsoftonline.com/*/reprocess*` (same host, no new install warning; `permissions.lock.json` updated).
`parseMicrosoftReprocess` in `src/content/consent/microsoft.ts` acts only when `form[action*="/Consent/Set"]` and
`input[name=acceptConsent]` exist and there is no `input[type=password]`; otherwise it returns null (inert). Scopes come from
the stored authorize request (URL source) and/or `div.scope .label` text, with known English phrases mapped to scope ids
(unknown text kept verbatim, DOM source = fail closed; labels outside the stored scopes = `unverifiedScopes`). App name =
element before `#appDomainLinkToAppInfo` (fallback stored client id); verified = an `img` inside the publisher link or its
container (alt never read). Tests: `test/consent-microsoft-reprocess.test.ts` with fixtures `microsoft-reprocess-{consent,password,mfa}.html`.
Still NOT covered: consent rendered as the POST response of `/login`, `/kmsi`, `/SAS/ProcessAuth` (see below).

Original decision (before the capture): matching was NOT widened. The rest of this note records why.

## What is covered today

- Content script match: `https://login.microsoftonline.com/*/oauth2/*`.
- Consent detection (`CONSENT_PATHS.microsoft` in `src/lib/oauth-request.ts`): only
  `/<tenant>/oauth2/(v2.0/)authorize` with a `scope` (or `resource`) query, and only when the page DOM
  parses as a permissions screen (`src/content/consent/microsoft.ts`).
- This catches the case where the user already has a session and Microsoft renders the consent
  screen directly in the authorize document (GET, URL still carries `client_id` and `scope`).

## Why most approvals are missed

When the user signs in during the flow, the password form posts to a sign-in endpoint and the
consent screen comes back as the response of that POST. The tab URL is then a sign-in URL such as
`login.microsoftonline.com/common/login` or `/<tenant>/login` (also `/kmsi`, `/appverify`,
`/common/SAS/ProcessAuth` after MFA). The same paths render the password, MFA, "Stay signed in?" and
error steps, and the URL no longer carries `client_id` or `scope`.

Matching those paths would run the consent script on password-entry pages, which the extension
deliberately avoids (and which would widen the Web Store permission justification). The consent
form's own submit target (`/common/Consent/Set`) is a POST destination, not a page the user sees, so
matching it does not help.

## What a safe improvement would need

1. Real captures (sanitized HTML plus the exact tab URL and HTTP method) of:
   - consent rendered after password sign-in (`/common/login` response), personal and work accounts;
   - consent after MFA (`/common/SAS/ProcessAuth`);
   - admin consent (`/<tenant>/adminconsent`, `/<tenant>/v2.0/adminconsent`), "Need admin approval"
     and the "Approval required" request form;
   - a non-consent step on each of those paths (password, MFA, KMSI) as negative fixtures.
2. A detector that keys on a structural marker unique to the consent step (for example the
   permissions list form posting to `Consent/Set`) and stays inert, without reading any field, on
   pages containing an `input[type=password]`.
3. The request context carried over from the authorize URL (the background already captures it as
   the stored `OAuthRequest`), since the post-login URL has no `scope`.
4. Admin consent paths (`/*/adminconsent*`) are dedicated consent URLs and are the lowest-risk
   addition once fixtures exist; they would still need a `permissions.lock.json` update and new
   Web Store justification text.

Fixtures go in `test/fixtures/consent/` next to the existing ones, with tests in
`test/consent.test.ts` asserting both detection and non-detection on the negative pages.

## Captured 2026-10-23 (real consent screen, signed-in session, nothing accepted)

Flow: `login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=…&scope=Mail.ReadWrite offline_access&prompt=consent`
with an existing session redirected to **`/common/reprocess?ctx=…&sessionid=…`**, which rendered the consent screen.
The URL carries no `client_id` or `scope`, so the stored authorize request (already captured by the background) is the only
source of scopes/app id; the page shows them as text.

Markers seen on the consent step (and not on password/MFA steps):
- Form `action` path **`/common/Consent/Set`**; hidden inputs **`acceptConsent`** (value `false`), `upgradeToAdminConsent`, `flowToken`, `ctx`, `canary`.
- Element ids **`appDomainLinkToAppInfo`** (publisher link, text "Microsoft Corporation"), **`reportSuspiciousApp`**, `applicationTerms`, `appTermsLink`, `appPrivacyLink`, `upgradeConsentCheckbox` (admin "consent on behalf of your organization").
- No `input[type=password]` on the page.
- Scopes: each in `div.scope[data-bind] > div.toggle.table > div > div.table-cell > div.label.text-13`, English text even in a Ukrainian UI
  ("Read and write access to your mail", "Maintain access to data you have given it access to", "View your basic profile").
- App name: text of the element preceding the publisher link ("Microsoft Graph Command Line Tools"); verified badge = `img.consent-badge` right after the publisher link; the link's aria-label also says "verified" (localized).
- Heading localized ("Запитані дозволи" = "Permissions requested"); title "Вхід в обліковий запис".

Safe detector design from this capture: match `https://login.microsoftonline.com/*/reprocess*` (same host as today's matches, so
no new install warning), and act only when `form[action*="/Consent/Set"]` and `input[name=acceptConsent]` exist and no
password field is present; read scopes from `div.scope .label` (DOM source) or the stored authorize request (URL source).

## Captured 2026-10-24: consent after a fresh sign-in

With `prompt=login` (password + MFA), Microsoft rendered the same consent screen at **`/common/SAS/ProcessAuth`**
(after the Authenticator step) with identical markers (`/Consent/Set` form, `acceptConsent`, no password field,
`div.scope .label`, `img.consent-badge`). Matches now also cover `/*/SAS/ProcessAuth*`, `/*/login*` and `/*/kmsi*`
(same host, no new install warning); the parser stays inert on their password/MFA/KMSI pages.
