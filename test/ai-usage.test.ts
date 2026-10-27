import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installChrome, type ChromeStub } from './chrome-stub.ts';
import { buildAiToolIndex, DEFAULT_AI_TOOLS, matchAiTool, sanitizeAiTools } from '../src/detect/ai-tools.ts';

const API = 'https://app.ransomleak.com';
const AUTH = {
  token: 'tok', refreshToken: 'rt', expiresAt: '2099-01-01T00:00:00Z', tenant: 'acme', tenantName: 'Acme',
  tenantOrigin: 'https://acme.ransomleak.com', apiBaseUrl: API, locale: 'en', generation: 1, userId: 'u-a',
};

describe('matchAiTool', () => {
  const idx = buildAiToolIndex(DEFAULT_AI_TOOLS);
  it('matches exact hosts and subdomains of registrable entries only', () => {
    expect(matchAiTool('chatgpt.com', idx)).toBe('chatgpt');
    expect(matchAiTool('www.chatgpt.com', idx)).toBe('chatgpt');
    expect(matchAiTool('chat.openai.com', idx)).toBe('chatgpt');
    expect(matchAiTool('platform.openai.com', idx)).toBeNull();
    expect(matchAiTool('gemini.google.com', idx)).toBe('gemini');
    expect(matchAiTool('mail.google.com', idx)).toBeNull();
    expect(matchAiTool('x.gemini.google.com', idx)).toBeNull();
    expect(matchAiTool('claude.ai.evil.com', idx)).toBeNull();
    expect(matchAiTool('CLAUDE.AI.', idx)).toBe('claude');
  });
  it('sanitizes policy entries', () => {
    expect(sanitizeAiTools([{ id: 'ok', name: 'Ok', domains: ['OK.dev', 3] }, { id: 'Bad Id', name: 'x', domains: ['x.com'] }, null]))
      .toEqual([{ id: 'ok', name: 'Ok', domains: ['ok.dev'] }]);
    expect(sanitizeAiTools('nope')).toBeNull();
  });
});

describe('AI usage counting and reporting', () => {
  let chrome: ChromeStub;
  let mod: typeof import('../src/background/ai-usage.ts');
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    chrome = installChrome();
    chrome.storage.local.reset({ auth: AUTH });
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ accepted: 1 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    mod = await import('../src/background/ai-usage.ts');
  });

  const day = (s: string): Date => new Date(`${s}T10:00:00Z`);

  it('counts once per tab per tool per 30 minutes, per local day', async () => {
    const now = day('2026-10-20');
    expect(await mod.countAiVisit(1, 'chatgpt.com', {}, now)).toBe('chatgpt');
    expect(await mod.countAiVisit(1, 'www.chatgpt.com', {}, now)).toBeNull(); // reload / same tool
    expect(await mod.countAiVisit(2, 'chatgpt.com', {}, now)).toBe('chatgpt'); // another tab
    expect(await mod.countAiVisit(1, 'example.com', {}, now)).toBeNull();
    expect(chrome.storage.local.dump['aiUsageUtc']).toEqual({ '2026-10-20': { chatgpt: 2 } });
  });

  it('counts nothing when the aiUsage detector is off', async () => {
    expect(await mod.countAiVisit(1, 'claude.ai', { detectors: { aiUsage: 'off' } })).toBeNull();
    expect(chrome.storage.local.dump['aiUsageUtc']).toBeUndefined();
  });

  it('uses the policy directory when present', async () => {
    const policy = { version: 'v', aiTools: [{ id: 'acme-ai', name: 'Acme AI', domains: ['ai.acme.test'] }] };
    expect(await mod.countAiVisit(1, 'ai.acme.test', policy)).toBe('acme-ai');
    expect(await mod.countAiVisit(1, 'claude.ai', policy)).toBeNull();
  });

  it('keeps at most 14 days', async () => {
    const usage: Record<string, Record<string, number>> = {};
    for (let i = 1; i <= 20; i++) usage[`2026-09-${String(i).padStart(2, '0')}`] = { claude: 1 };
    chrome.storage.local.dump['aiUsageUtc'] = usage;
    await mod.countAiVisit(1, 'claude.ai', {}, day('2026-09-21'));
    const days = Object.keys(chrome.storage.local.dump['aiUsageUtc'] as object).sort();
    expect(days).toHaveLength(14);
    expect(days.at(-1)).toBe('2026-09-21');
  });

  it('sends completed days and today; deletes only completed days after a 2xx', async () => {
    chrome.storage.local.dump['aiUsageUtc'] = { '2026-10-19': { claude: 3 }, '2026-10-20': { chatgpt: 1 } };
    await mod.sendAiUsage(day('2026-10-20'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(`${API}/api/browser-ext/ai-usage`);
    expect(JSON.parse(String(init.body))).toEqual({
      days: [
        { date: '2026-10-19', counts: { claude: 3 } },
        { date: '2026-10-20', counts: { chatgpt: 1 } },
      ],
    });
    expect(chrome.storage.local.dump['aiUsageUtc']).toEqual({ '2026-10-20': { chatgpt: 1 } });
  });

  it('resends today only after it changed', async () => {
    chrome.storage.local.dump['aiUsageUtc'] = { '2026-10-20': { chatgpt: 1 } };
    await mod.sendAiUsage(day('2026-10-20'));
    await mod.sendAiUsage(day('2026-10-20'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    chrome.storage.local.dump['aiUsageUtc'] = { '2026-10-20': { chatgpt: 2 } };
    await mod.sendAiUsage(day('2026-10-20'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps days on failure', async () => {
    chrome.storage.local.dump['aiUsageUtc'] = { '2026-10-19': { claude: 3 } };
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 503 }));
    await mod.sendAiUsage(day('2026-10-20'));
    expect(chrome.storage.local.dump['aiUsageUtc']).toEqual({ '2026-10-19': { claude: 3 } });
  });

  it('does not delete days when the binding changed mid-request', async () => {
    chrome.storage.local.dump['aiUsageUtc'] = { '2026-10-19': { claude: 3 } };
    fetchMock.mockImplementationOnce(async () => {
      chrome.storage.local.dump['auth'] = { ...AUTH, generation: 2 };
      return new Response('{}', { status: 200 });
    });
    await mod.sendAiUsage(day('2026-10-20'));
    expect(chrome.storage.local.dump['aiUsageUtc']).toEqual({ '2026-10-19': { claude: 3 } });
  });

  it('keys days by UTC date', async () => {
    await mod.countAiVisit(1, 'claude.ai', {}, new Date('2026-10-20T23:30:00-05:00')); // 04:30Z on the 21st
    expect(Object.keys(chrome.storage.local.dump['aiUsageUtc'] as object)).toEqual(['2026-10-21']);
  });
  it('never sends without a bound user id', async () => {
    chrome.storage.local.reset({ auth: { ...AUTH, userId: undefined }, aiUsageUtc: { '2026-10-19': { claude: 3 } } });
    await mod.sendAiUsage(day('2026-10-20'));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
