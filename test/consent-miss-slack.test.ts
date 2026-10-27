// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://acme.slack.com/oauth?client_id=1.2&user_scope=chat:write"}
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installChrome } from './chrome-stub.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  history.replaceState(null, '', '/oauth?client_id=1.2&user_scope=chat:write');
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

describe('slack workspace host consent-miss', () => {
  it('/oauth with user_scope on a workspace host is a consent step', async () => {
    const c = await load();
    vi.advanceTimersByTime(10_001);
    expect(sent(c)).toContainEqual({ type: 'consent-miss', provider: 'slack' });
  });
  it('/oauth with scope on a workspace host is a consent step', async () => {
    history.replaceState(null, '', '/oauth?client_id=1.2&scope=chat:write');
    const c = await load();
    vi.advanceTimersByTime(10_001);
    expect(sent(c)).toContainEqual({ type: 'consent-miss', provider: 'slack' });
  });
  it('a non-oauth path on a workspace host is not consent', async () => {
    history.replaceState(null, '', '/messages/C123?scope=chat:write');
    const c = await load();
    vi.advanceTimersByTime(30_000);
    expect(sent(c)).toEqual([]);
  });
});
