import { describe, expect, it } from 'vitest';
import { DEFAULT_BRAND_OWNERS, SINGLE_TENANT_OWNERS, STRICT_BRANDS } from '../src/detect/brands.ts';
import { checkLookalike, type Protected } from '../src/detect/lookalike.ts';

const P: Protected = { domains: ['acme.com', 'acme.okta.com'], brands: ['microsoft', 'docusign'] };
const chk = (u: string, allow: string[] = []) => checkLookalike(u, P, allow);

describe('checkLookalike', () => {
  it('flags brand skeleton lookalike', () => {
    expect(chk('https://rnicrosoft.com/')).toMatchObject({ kind: 'brand', matched: 'microsoft', registrable: 'rnicrosoft.com' });
  });
  it('flags tenant typos and suffix variants', () => {
    expect(chk('https://acrne.com/')).toMatchObject({ kind: 'tenant' });
    expect(chk('https://acme-corp.co/')).toMatchObject({ kind: 'tenant' });
  });
  it('flags brand embedding', () => {
    expect(chk('https://microsoft-login-secure.com/')).toMatchObject({ kind: 'brand', matched: 'microsoft' });
    expect(chk('https://microsoftsupport.com/')).toMatchObject({ kind: 'brand', matched: 'microsoft' });
    expect(chk('https://login.microsoft.com.evil.net/')).toMatchObject({ kind: 'brand' });
  });
  it('flags TLD swap', () => {
    expect(chk('https://acme.co/')).toMatchObject({ kind: 'tenant' });
  });
  it('flags Cyrillic homoglyph', () => {
    expect(chk('https://аcme.com/')).toMatchObject({ kind: 'tenant' });
  });
  it('flags edit-distance typos by length tier', () => {
    expect(chk('https://docusgin.com/')).toMatchObject({ kind: 'brand', matched: 'docusign' });
    expect(chk('https://micrsoft.com/')).toMatchObject({ kind: 'brand', matched: 'microsoft' });
  });
  it('never flags protected domain or its subdomains', () => {
    for (const u of ['https://acme.com/', 'https://sso.acme.com/', 'https://microsoft.com/', 'https://login.microsoftonline.com/', 'https://acme.okta.com/']) {
      expect(chk(u)).toBeNull();
    }
  });
  it('respects allowlist', () => {
    expect(chk('https://acme-partners.com/')).toMatchObject({ kind: 'tenant' });
    expect(chk('https://acme-partners.com/', ['acme-partners.com'])).toBeNull();
  });
  it('ignores non-web and IP hosts', () => {
    expect(chk('chrome://settings')).toBeNull();
    expect(chk('https://127.0.0.1/')).toBeNull();
    expect(chk('http://localhost:3000/')).toBeNull();
    expect(chk('not a url')).toBeNull();
  });
  it('shared hosting evaluates the subdomain label', () => {
    expect(chk('https://foo-microsoft.pages.dev/')).toMatchObject({ kind: 'brand', registrable: 'foo-microsoft.pages.dev' });
    expect(chk('https://my-blog.pages.dev/')).toBeNull();
  });
  it('does not flag common benign domains', () => {
    for (const d of ['google.com', 'github.com', 'amazon.com', 'wikipedia.org', 'stackoverflow.com', 'linkedin.com', 'apple.com', 'zoom.us', 'notion.so', 'slack.com', 'mail.google.com', 'cloudflare.com']) {
      expect(chk(`https://${d}/`), d).toBeNull();
    }
  });
  it('accepts custom brandOwners', () => {
    expect(checkLookalike('https://microsoft-partners.example/', P, [], { microsoft: ['microsoft-partners.example'] })).toBeNull();
  });

  it('does not flag exact brand label on another TLD', () => {
    const p2: Protected = { ...P, brands: [...P.brands, 'google', 'okta', 'zoom'] };
    for (const u of ['https://google.de/', 'https://google.co.uk/', 'https://microsoft.de/', 'https://okta.de/', 'https://docs.google.de/', 'https://zoom.us/']) {
      expect(checkLookalike(u, p2, []), u).toBeNull();
    }
    expect(checkLookalike('https://g\u043e\u043egle.de/', p2, [])).toMatchObject({ kind: 'brand', matched: 'google' });
    expect(checkLookalike('https://xn--ggle-55da.de/', p2, [])).toMatchObject({ kind: 'brand', matched: 'google' });
    expect(checkLookalike('https://microsoft.pages.dev/', p2, [])).toMatchObject({ kind: 'brand' });
    for (const u of ['https://microsoft.xyz/', 'https://google.top/', 'https://okta.app/']) {
      expect(checkLookalike(u, p2, []), u).toMatchObject({ kind: 'brand' });
    }
  });
  it('exempts expanded brand owners', () => {
    const p2: Protected = { domains: [], brands: ['google', 'okta', 'microsoft'] };
    for (const u of ['https://fonts.googleapis.com/', 'https://www.gstatic.com/', 'https://youtube.com/', 'https://x.oktapreview.com/'.replace('x.', ''), 'https://okta-emea.com/', 'https://login.live.net/', 'https://www.bing.com/', 'https://portal.azure.com/', 'https://login.microsoftonline-p.com/']) {
      expect(checkLookalike(u, p2, []), u).toBeNull();
    }
  });
  it('judges multi-tenant owner subtrees on their own label', () => {
    expect(chk('https://microsoft-login.sharepoint.com/')).toMatchObject({ kind: 'brand' });
    expect(chk('https://contoso.sharepoint.com/')).toBeNull();
    expect(chk('https://www.sharepoint.com/')).toBeNull();
    expect(chk('https://microsoft-login.blob.core.windows.net/')).toMatchObject({ kind: 'brand' });
  });
  it('protected subdomain tenant on a shared platform (with brand okta)', () => {
    const p2: Protected = { domains: ['acme.okta.com'], brands: ['okta'] };
    const c = (u: string) => checkLookalike(u, p2, []);
    expect(c('https://acrne.okta.com/')).toMatchObject({ kind: 'tenant', matched: 'acme.okta.com' });
    expect(c('https://acme.okta.com/')).toBeNull();
    expect(c('https://okta.com/')).toBeNull();
    expect(c('https://www.okta.com/')).toBeNull();
    expect(c('https://login.okta.com/')).toBeNull();
    expect(c('https://okta-login.com/')).toMatchObject({ kind: 'brand', matched: 'okta' });
  });
  it('embedding survives punycode labels', () => {
    expect(chk('https://\u0430cme-login.com/')).toMatchObject({ kind: 'tenant' });
  });

  it('judges customer-hostable subtrees under owner domains', () => {
    expect(chk('https://microsoft-login.eastus.cloudapp.azure.com/')).toMatchObject({ kind: 'brand' });
    expect(checkLookalike('https://google-login.run.app/', { domains: [], brands: ['google'] }, [])).toMatchObject({ kind: 'brand' });
  });
  it('flags brand under windows.net / azure.com customer subtrees', () => {
    for (const u of ['https://microsoft-login.blob.core.windows.net/', 'https://microsoft-login.azureedge.net/', 'https://microsoft-login.azurewebsites.net/', 'https://microsoft-login.azure.com/', 'https://microsoft-login.windows.net/']) {
      expect(chk(u), u).toMatchObject({ kind: 'brand' });
    }
    expect(checkLookalike('https://google-login.firebasestorage.googleapis.com/', { domains: [], brands: ['google'] }, [])).toMatchObject({ kind: 'brand' });
  });
  it('first-party brand domains are not lookalikes; real lookalikes still hit', () => {
    const P2 = { domains: [], brands: ['microsoft', 'google'] };
    for (const u of ['https://www.microsoft365.com/', 'https://microsoftstream.com/', 'https://security.googleblog.com/', 'https://chromium.googlesource.com/chromium/src']) {
      expect(checkLookalike(u, P2, []), u).toBeNull();
    }
    expect(checkLookalike('https://microsoft-login.com/', P2, [])).toMatchObject({ kind: 'brand', matched: 'microsoft' });
    expect(checkLookalike('https://googIe.com/', P2, [])).toMatchObject({ kind: 'brand', matched: 'google' });
  });
  it('owner guard: only documented single-tenant owners may exempt brand-login.<owner>', () => {
    for (const [brand, owners] of Object.entries(DEFAULT_BRAND_OWNERS)) {
      for (const o of owners) {
        // brand.<ccTLD> (amazon.de, hsbc.co.uk) is exempt by the exact-label ccTLD rule, not by ownership.
        const [label, ...tld] = o.split('.');
        if (label === brand && tld.at(-1)!.length === 2) continue;
        const r = checkLookalike(`https://${brand}-login.${o}/`, { domains: [], brands: [brand] }, []);
        if (!SINGLE_TENANT_OWNERS.includes(o)) expect(r, o).not.toBeNull();
      }
    }
    const all = Object.values(DEFAULT_BRAND_OWNERS).flat();
    for (const o of SINGLE_TENANT_OWNERS) expect(all, o).toContain(o);
  });

  it('evaluates every label left of a shared suffix', () => {
    expect(chk('https://acrne.eastus.cloudapp.azure.com/')).toMatchObject({ kind: 'tenant', matched: 'acme.com' });
    expect(chk('https://microsoft-login.eastus.cloudapp.azure.com/')).toMatchObject({ kind: 'brand' });
    expect(chk('https://microsoft-login.z13.web.core.windows.net/')).toMatchObject({ kind: 'brand' });
    expect(chk('https://foo.westeurope.cloudapp.azure.com/')).toBeNull();
    expect(chk('https://myapp.eastus.cloudapp.azure.com/')).toBeNull();
    expect(checkLookalike('https://acme.okta.com/', { domains: ['acme.okta.com'], brands: [] }, [])).toBeNull();
  });
});

import { parseHost as parseHostX } from '../src/lib/domain.ts';
import { checkLookalike as checkX } from '../src/detect/lookalike.ts';
describe('policy-extended lists', () => {
  it('a policy-added shared suffix changes the registrable', () => {
    expect(parseHostX('https://foo.bar.acmehost.io/')!.registrable).toBe('acmehost.io');
    expect(parseHostX('https://foo.bar.acmehost.io/', ['acmehost.io'])).toMatchObject({ registrable: 'bar.acmehost.io', sharedHost: true });
  });
  it('a policy single-tenant owner exempts its subtree', () => {
    const p = { domains: [], brands: ['microsoft'] };
    const owners = { microsoft: ['microsoft.com', 'microsoftx.net'] };
    expect(checkX('https://login.microsoftx.net/', p, [], owners)).not.toBeNull();
    expect(checkX('https://login.microsoftx.net/', p, [], owners, { singleTenantOwners: ['microsoftx.net'] })).toBeNull();
  });
});

describe('lookalike via', () => {
  const v = (u: string) => checkLookalike(u, { domains: [], brands: ['microsoft'] }, [])?.via;
  it('labels each match site', () => {
    expect(v('https://rnicrosoft.com/')).toBe('skeleton');
    expect(v('https://m\u0456crosoft.com/')).toBe('skeleton'); // Cyrillic homoglyph
    expect(v('https://micrsoft.com/')).toBe('distance');
    expect(v('https://microsoftsupport.com/')).toBe('embedding');
    expect(v('https://microsoft-login.com/')).toBe('embedding');
    expect(v('https://microsoft.xyz/')).toBe('tld');
  });
});


describe('built-in brand list (all default brands protected)', () => {
  const ALL: Protected = { domains: [], brands: Object.keys(DEFAULT_BRAND_OWNERS) };
  const c = (u: string) => checkLookalike(u, ALL, []);
  it('flags classic brand lookalikes', () => {
    const cases: Array<[string, string]> = [
      ['https://paypa1.com/', 'paypal'], ['https://arnazon.com/', 'amazon'], ['https://micros0ft-login.com/', 'microsoft'],
      ['https://dhl-delivery-track.com/', 'dhl'], ['https://netfl1x.com/', 'netflix'], ['https://app1e.com/', 'apple'],
      ['https://apple-id-verify.com/', 'apple'], ['https://slack-login.com/', 'slack'], ['https://binance-support.com/', 'binance'],
      ['https://steamcommunnity.com/', 'steamcommunity'], ['https://chase-alert.com/', 'chase'], ['https://usps-redelivery.com/', 'usps'],
      ['https://wellsfargo-secure.net/', 'wellsfargo'], ['https://olx-pay.com/', 'olx'], ['https://novaposhta-delivery.com/', 'novaposhta'],
      ['https://facebok.com/', 'facebook'], ['https://instagram-help.com/', 'instagram'], ['https://hsbc-secure.co/', 'hsbc'],
      ['https://zoom-video-install.com/', 'zoom'], ['https://icloud-verify.com/', 'icloud'], ['https://amazon.xyz/', 'amazon'],
      ['https://coinbase-wallet.app/', 'coinbase'], ['https://metamask-restore.io/', 'metamask'], ['https://login.paypal.com.evil.net/', 'paypal'],
    ];
    for (const [u, brand] of cases) expect(c(u), u).toMatchObject({ kind: 'brand', matched: brand });
  });
  it('strict brands skip edit distance and substring embedding (common-word neighbours)', () => {
    for (const d of [
      'apply.com', 'ample.com', 'stack.com', 'black.com', 'finance.gov.au', 'revolt.tv', 'digitalrevolution.nl', 'intuitive.com',
      'intuitivesurgical.com', 'pinstripe.com', 'stripes.com', 'lacoste.com', 'cloudshare.com', 'cloudware.de', 'deutschebahn.com',
      'commercebank.com', 'citicbank.com', 'room.sh', 'boom.nl', 'cloud.ru', 'canvas.net', 'lexpress.fr', 'sedex.com', 'mastercam.com',
      'command.com', 'plantation.org', 'capitaland.com', 'pestpac.com', 'americanpress.com', 'lithub.com', 'adore.com.pk', 'elle.fr',
      'telegraph.co.uk', 'netmask.hu', 'postal.pt', 'gettransfer.com', 'webfx.com', 'swissport.com', 'santoandre.sp.gov.br',
    ]) expect(c(`https://${d}/`), d).toBeNull();
  });
  it('generic words that are not brand keys never match', () => {
    for (const d of ['groups.io', 'booking.com', 'outbox.com', 'upstart.com', 'pull-ups.com', 'visa-to-travel.com', 'orange-juice.com',
      'paper-chase.example', 'wise-owl.com', 'kraken-beer.com', 'box.example.org', 'my-post.com', 'ingredients.com', 'citizens.com']) {
      expect(c(`https://${d}/`), d).toBeNull();
    }
  });
  it('first-party and multi-tenant owner hosts are not lookalikes', () => {
    for (const u of [
      'https://www.amazon.de/', 'https://amazon.co.uk/', 'https://signin.aws.amazon.com/', 'https://sqs.us-east-1.amazonaws.com/',
      'https://us02web.zoom.us/', 'https://app.slack.com/', 'https://a.slack-edge.com/', 'https://login.salesforce.com/',
      'https://acme.atlassian.net/', 'https://acme.webex.com/', 'https://contoso.onmicrosoft.com/', 'https://dl.dropboxusercontent.com/',
      'https://www.paypalobjects.com/', 'https://paypal.me/', 'https://store.steampowered.com/', 'https://steamcommunity.com/',
      'https://telegra.ph/', 'https://t.me/', 'https://x.com/', 'https://laposte.net/', 'https://usps.gov/', 'https://acme.my.canva.site/',
      'https://www.icloud.com/', 'https://appleid.apple.com/', 'https://github.com/', 'https://github.dev/', 'https://foo-3000.app.github.dev/', 'https://www.credit-agricole.it/',
      'https://novapost.com/', 'https://privat24.ua/', 'https://www.mercadolivre.com.br/', 'https://discordapp.com/', 'https://www.chatgpt.com/',
    ]) expect(c(u), u).toBeNull();
    // Customer subdomains on multi-tenant owners are judged on their own label.
    expect(c('https://slack-login.slack.com/')).toMatchObject({ kind: 'brand', matched: 'slack' });
    expect(c('https://paypal-verify.zoom.us/')).toMatchObject({ kind: 'brand', matched: 'paypal' });
  });
  it('every strict brand is a brand key', () => {
    for (const b of STRICT_BRANDS) expect(DEFAULT_BRAND_OWNERS, b).toHaveProperty(b);
  });
  it('a policy strictBrands entry disables fuzzy matching for that brand', () => {
    const p = { domains: [], brands: ['docusign'] };
    expect(checkLookalike('https://docusgin.com/', p, [])).toMatchObject({ via: 'distance' });
    expect(checkLookalike('https://docusgin.com/', p, [], undefined, { strictBrands: ['docusign'] })).toBeNull();
  });
});

describe('security review regressions', () => {
  it('a brand on a generic-use ccTLD is flagged; real owner and country domains are not', () => {
    for (const u of ['https://paypal.io/', 'https://coinbase.co/', 'https://binance.ai/', 'https://metamask.me/']) {
      expect(checkLookalike(u, { domains: [], brands: ['paypal', 'coinbase', 'binance', 'metamask'] }, []), u).not.toBeNull();
    }
    for (const u of ['https://paypal.me/x', 'https://metamask.io/', 'https://google.de/', 'https://amazon.co.uk/']) {
      expect(checkLookalike(u, { domains: [], brands: ['paypal', 'metamask', 'google', 'amazon'] }, []), u).toBeNull();
    }
  });
  it('a customer subdomain on wetransfer.com is judged on its own label', () => {
    expect(checkLookalike('https://paypal-billing.wetransfer.com/', { domains: [], brands: ['paypal', 'wetransfer'] }, [])).not.toBeNull();
  });
});

describe('protected subdomains with generic labels', () => {
  const tenant = { domains: ['app.ransomleak-stage.com', 'acme.ransomleak.com'], brands: [] as string[] };
  it('a generic tenant label (app) does not flag other sites; the exact host stays exempt', () => {
    for (const u of ['https://app.slack.com/client', 'https://app.asana.com', 'https://app.hubspot.com']) {
      expect(checkLookalike(u, tenant, [])).toBeNull();
    }
    expect(checkLookalike('https://app.ransomleak-stage.com/app', tenant, [])).toBeNull();
  });
  it('a distinctive tenant label (acme) is still protected', () => {
    expect(checkLookalike('https://acrne.com/login', tenant, [])?.kind).toBe('tenant');
    expect(checkLookalike('https://acme-login.pages.dev', tenant, [])?.via).toBe('embedding');
  });
  it('a generic subdomain falls back to the registrable label; a short one is matched only by homoglyphs', () => {
    expect(checkLookalike('https://acme-hr.co/portal', { domains: ['portal.acme-hr.com'], brands: [] }, [])?.kind).toBe('tenant');
    const short = { domains: ['xyz.ransomleak.com'], brands: [] as string[] };
    expect(checkLookalike('https://xyz-login.pages.dev', short, [])).toBeNull();
    expect(checkLookalike('https://xyz.pages.dev', short, [])?.via).toBe('skeleton');
  });
});
