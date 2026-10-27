// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x&scope=Mail.Read"}
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installChrome } from './chrome-stub.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  history.replaceState(null, '', '/common/oauth2/v2.0/authorize?client_id=x&scope=Mail.Read');
});

/** Messages other than the consent-request lookup. */
const sent = (c: { runtime: { sendMessage: { mock: { calls: unknown[][] } } } }): unknown[] =>
  c.runtime.sendMessage.mock.calls.map((a) => a[0]).filter((m) => (m as { type?: string }).type !== 'consent-request');

async function load() {
  vi.useFakeTimers();
  vi.resetModules();
  const c = installChrome();
  document.body.innerHTML = '<div>unrecognised markup</div>';
  await import('../src/content/consent/index.ts');
  return c;
}

describe('consent content script budget', () => {
  it('sends consent-miss once when the 10 s budget expires with no parse', async () => {
    const c = await load();
    vi.advanceTimersByTime(9_999);
    expect(sent(c)).toEqual([]);
    vi.advanceTimersByTime(2);
    expect(sent(c)).toHaveLength(1);
    expect(sent(c)).toContainEqual({ type: 'consent-miss', provider: 'microsoft' });
    vi.advanceTimersByTime(20_000);
    expect(sent(c)).toHaveLength(1);
  });
  it('an account chooser / sign-in page without scopes is not a miss', async () => {
    history.replaceState(null, '', '/common/oauth2/v2.0/authorize?client_id=x');
    const c = await load();
    vi.advanceTimersByTime(30_000);
    expect(sent(c)).toEqual([]);
    history.replaceState(null, '', '/common/login?scope=Mail.Read');
    vi.advanceTimersByTime(30_000);
    expect(sent(c)).toEqual([]);
  });
  it('a pushState URL change (seen by the poll) re-arms the 10 s budget', async () => {
    history.replaceState(null, '', '/common/oauth2/v2.0/authorize?client_id=x');
    const c = await load();
    vi.advanceTimersByTime(8_000);
    history.pushState(null, '', '/common/oauth2/v2.0/authorize?client_id=x&scope=Mail.Read');
    vi.advanceTimersByTime(1_000); // poll notices the new URL and re-arms
    vi.advanceTimersByTime(9_000);
    expect(sent(c)).toEqual([]); // old budget would have fired at 10 s
    vi.advanceTimersByTime(1_100);
    expect(sent(c)).toContainEqual({ type: 'consent-miss', provider: 'microsoft' });
  });
});

describe('consent-miss with a stored request', () => {
  it('counts a miss on a scope-less consent URL when the background has scopes for the tab', async () => {
    history.replaceState(null, '', '/common/oauth2/v2.0/authorize?client_id=x');
    vi.useFakeTimers();
    vi.resetModules();
    const c = installChrome();
    c.runtime.sendMessage.mockImplementation((async (m: { type: string }) =>
      m.type === 'consent-request' ? { provider: 'microsoft', clientId: 'x', scopes: ['Mail.Read'], at: Date.now() } : undefined) as any);
    document.body.innerHTML = '<div>unrecognised markup</div>';
    await import('../src/content/consent/index.ts');
    await vi.advanceTimersByTimeAsync(10_001);
    expect(sent(c)).toContainEqual({ type: 'consent-miss', provider: 'microsoft' });
  });
});
