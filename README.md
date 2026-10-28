# RansomLeak Browser Extension

Chrome/Edge (Manifest V3) extension for [RansomLeak](https://ransomleak.com): just-in-time phishing protection and
security-awareness training.

It warns employees about look-alike, newly registered and reported phishing sites and risky sign-in consent screens,
shows their assigned training, and lets them report suspicious sites to their security team. It does nothing until it is
connected to an organization's RansomLeak account.

Install: [Chrome Web Store](https://chromewebstore.google.com/detail/ransomleak-security-aware/cmfnbigmhppdmajaicgaimpikoaoaajo)
(also works in Microsoft Edge). Admins can force-install it instead; see
[Deploy the extension](https://docs.ransomleak.com/browser-extension/deploy/).

The source is published so that customers, security teams and works councils can check exactly what the extension does
and what it sends. What it collects is described in plain language in the
[help center](https://docs.ransomleak.com/browser-extension/what-we-collect/).

## What it does

- **Look-alike sites.** Warns when an address imitates a well-known brand or your organization's own domain
  (`micros0ft-login.com`), with the trick highlighted.
- **New and reported sites.** Warns on very recently registered domains and on pages listed by OpenPhish and URLhaus.
  The lists are downloaded and checked in the browser.
- **Risky consent screens.** Flags Microsoft, Google and Slack sign-in screens that ask an unverified app for broad
  access to a work account.
- **60-second lessons.** "Learn why" on a warning opens a short lesson built from the site the person just hit, with
  one quick question. It runs inside the extension, with no sign-in and no new tab.
- **Optional extra protection.** Warnings on risky downloads and on pasting passwords, keys or card numbers into AI
  tools, checked on the device. Off until the organization enables it and the person grants access.
- **Popup.** Assigned training with due dates, recent warnings, and a button to report a suspicious site.
- **Admin control.** Each check can be set to warn, block, log only or off for the whole organization.

It never reads passwords, form input or page content, and never collects browsing history.

## Where to read first

- `src/background/navigation.ts`: the one site classifier (look-alike, newly registered, reported, trusted).
- Network: `src/background/api.ts` (`apiFetch`/`postJson`, used for every authenticated call to the organization's
  RansomLeak workspace), `enroll.ts` (connecting) and `policy.ts` (policy and domain-list downloads) are the only
  modules that call `fetch`. `src/background/events.ts` builds the warning events.
- `src/content/`: the consent and AI-paste content scripts.
- `permissions.lock.json`: the exact permissions of the store build.

## Build and verify

```bash
npm ci
npm test                     # unit tests
npm run build                # production build into dist/
npm run check:permissions    # fails if dist/manifest.json differs from permissions.lock.json
```

`npm run build:dev` adds `https://app.localhost:*/*` to `externally_connectable` for local development.

## Permissions

Required: `webNavigation`, `storage`, `alarms`, `scripting`, `activeTab`, plus content scripts on OAuth consent pages
of Microsoft, Google and Slack only. Optional, asked only when the user turns a feature on: site access and `downloads`
(extra protection) and `notifications` (training reminders). Changing `permissions.lock.json` is a product decision:
it changes the store warnings.

## Contributing and security

This repository is published for transparency; we don't accept pull requests. Please report security issues
privately as described in [SECURITY.md](SECURITY.md).

## License

[Business Source License 1.1](LICENSE). You may read, audit, build and test the code, including inside your
organization, and use it with a RansomLeak account. You may not use it to build a competing product or service.
Each version converts to Apache-2.0 four years after release.
