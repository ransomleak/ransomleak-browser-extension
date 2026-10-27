// AI tool directory: FALLBACK COPY of backend global-lists.ts AI_TOOLS (the source of truth, served as
// policy `aiTools`). Keep in sync when the backend list changes (it bumps GLOBAL_LISTS_VERSION).
import { parse } from 'tldts';

export interface AiTool { id: string; name: string; domains: string[] }

export const DEFAULT_AI_TOOLS: readonly AiTool[] = [
  { id: 'chatgpt', name: 'ChatGPT', domains: ['chatgpt.com', 'chat.openai.com'] },
  { id: 'claude', name: 'Claude', domains: ['claude.ai'] },
  { id: 'gemini', name: 'Gemini', domains: ['gemini.google.com'] },
  { id: 'copilot', name: 'Microsoft Copilot', domains: ['copilot.microsoft.com'] },
  { id: 'perplexity', name: 'Perplexity', domains: ['perplexity.ai'] },
  { id: 'deepseek', name: 'DeepSeek', domains: ['chat.deepseek.com', 'deepseek.com'] },
  { id: 'mistral', name: 'Mistral Le Chat', domains: ['chat.mistral.ai'] },
  { id: 'grok', name: 'Grok', domains: ['grok.com'] },
  { id: 'meta-ai', name: 'Meta AI', domains: ['meta.ai'] },
  { id: 'poe', name: 'Poe', domains: ['poe.com'] },
  { id: 'character-ai', name: 'Character.AI', domains: ['character.ai'] },
  { id: 'you', name: 'You.com', domains: ['you.com'] },
  { id: 'jasper', name: 'Jasper', domains: ['jasper.ai'] },
  { id: 'writesonic', name: 'Writesonic', domains: ['writesonic.com'] },
  { id: 'quillbot', name: 'QuillBot', domains: ['quillbot.com'] },
  { id: 'phind', name: 'Phind', domains: ['phind.com'] },
  { id: 'cursor', name: 'Cursor', domains: ['cursor.com'] },
  { id: 'v0', name: 'v0', domains: ['v0.dev', 'v0.app'] },
  { id: 'bolt', name: 'Bolt', domains: ['bolt.new'] },
  { id: 'lovable', name: 'Lovable', domains: ['lovable.dev'] },
  { id: 'replit', name: 'Replit', domains: ['replit.com'] },
  { id: 'kimi', name: 'Kimi', domains: ['kimi.com', 'kimi.moonshot.cn'] },
  { id: 'qwen', name: 'Qwen Chat', domains: ['chat.qwen.ai'] },
  { id: 'manus', name: 'Manus', domains: ['manus.im'] },
  { id: 'm365-copilot', name: 'Microsoft 365 Copilot', domains: ['copilot.cloud.microsoft', 'm365copilot.com'] },
  { id: 'notebooklm', name: 'NotebookLM', domains: ['notebooklm.google.com'] },
  { id: 'ai-studio', name: 'Google AI Studio', domains: ['aistudio.google.com'] },
  { id: 'colab', name: 'Google Colab', domains: ['colab.research.google.com'] },
  { id: 'huggingface', name: 'Hugging Face', domains: ['huggingface.co'] },
  { id: 'pi', name: 'Pi', domains: ['pi.ai'] },
  { id: 'zai', name: 'Z.ai (GLM)', domains: ['chat.z.ai'] },
  { id: 'doubao', name: 'Doubao', domains: ['doubao.com'] },
  { id: 'genspark', name: 'Genspark', domains: ['genspark.ai'] },
  { id: 'lmarena', name: 'LMArena', domains: ['lmarena.ai'] },
  { id: 'openrouter', name: 'OpenRouter', domains: ['openrouter.ai'] },
  { id: 'chatpdf', name: 'ChatPDF', domains: ['chatpdf.com'] },
  { id: 'consensus', name: 'Consensus', domains: ['consensus.app'] },
  { id: 'elicit', name: 'Elicit', domains: ['elicit.com'] },
  { id: 'copy-ai', name: 'Copy.ai', domains: ['copy.ai'] },
  { id: 'grammarly', name: 'Grammarly', domains: ['grammarly.com'] },
  { id: 'deepl', name: 'DeepL', domains: ['deepl.com'] },
  { id: 'gamma', name: 'Gamma', domains: ['gamma.app'] },
  { id: 'otter', name: 'Otter.ai', domains: ['otter.ai'] },
  { id: 'fireflies', name: 'Fireflies.ai', domains: ['fireflies.ai'] },
  { id: 'midjourney', name: 'Midjourney', domains: ['midjourney.com'] },
  { id: 'leonardo', name: 'Leonardo.Ai', domains: ['leonardo.ai'] },
  { id: 'ideogram', name: 'Ideogram', domains: ['ideogram.ai'] },
  { id: 'krea', name: 'Krea', domains: ['krea.ai'] },
  { id: 'runway', name: 'Runway', domains: ['runwayml.com'] },
  { id: 'pika', name: 'Pika', domains: ['pika.art'] },
  { id: 'heygen', name: 'HeyGen', domains: ['heygen.com'] },
  { id: 'synthesia', name: 'Synthesia', domains: ['synthesia.io'] },
  { id: 'elevenlabs', name: 'ElevenLabs', domains: ['elevenlabs.io'] },
  { id: 'suno', name: 'Suno', domains: ['suno.com'] },
  { id: 'udio', name: 'Udio', domains: ['udio.com'] },
  { id: 'windsurf', name: 'Windsurf', domains: ['windsurf.com', 'codeium.com'] },
  { id: 'blackbox', name: 'Blackbox AI', domains: ['blackbox.ai'] },
];

const ID_RE = /^[a-z0-9-]{1,32}$/;

/** Policy entries that are well-formed; anything else is ignored. */
export function sanitizeAiTools(raw: unknown): AiTool[] | null {
  if (!Array.isArray(raw)) return null;
  const out: AiTool[] = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue;
    const o = t as Record<string, unknown>;
    if (typeof o['id'] !== 'string' || !ID_RE.test(o['id']) || typeof o['name'] !== 'string' || !Array.isArray(o['domains'])) continue;
    const domains = o['domains'].filter((d): d is string => typeof d === 'string' && d.length > 0 && d.length <= 253).map((d) => d.toLowerCase());
    if (domains.length) out.push({ id: o['id'], name: o['name'].slice(0, 100), domains });
  }
  return out;
}

/** Exact-host entries and registrable entries (whose subdomains also match), indexed for the hot path. */
export interface AiToolIndex { exact: ReadonlyMap<string, string>; subtree: ReadonlyMap<string, string> }

export function buildAiToolIndex(tools: readonly AiTool[]): AiToolIndex {
  const exact = new Map<string, string>();
  const subtree = new Map<string, string>();
  for (const t of tools) {
    for (const d of t.domains) {
      if (!exact.has(d)) exact.set(d, t.id);
      if (parse(d).domain === d && !subtree.has(d)) subtree.set(d, t.id);
    }
  }
  return { exact, subtree };
}

/**
 * Tool id for a host: an exact listed host, or a subdomain of a listed registrable (chatgpt.com covers
 * www.chatgpt.com; chat.openai.com covers only itself). Host only: paths never matter.
 */
export function matchAiTool(host: string, idx: AiToolIndex): string | null {
  const h = host.toLowerCase().replace(/\.$/, '');
  const hit = idx.exact.get(h);
  if (hit) return hit;
  for (let i = h.indexOf('.'); i >= 0; i = h.indexOf('.', i + 1)) {
    const id = idx.subtree.get(h.slice(i + 1));
    if (id) return id;
  }
  return null;
}

/**
 * Host match patterns for an AI tool list: each listed host, plus its subdomains when the entry is a
 * registrable domain (same rule as matchAiTool). Sorted, unique. HTTPS only.
 */
export function aiToolMatches(tools: readonly AiTool[]): string[] {
  const out = new Set<string>();
  for (const t of tools) {
    for (const d of t.domains) {
      if (!/^[a-z0-9.-]+$/.test(d)) continue;
      out.add(`https://${d}/*`);
      if (parse(d).domain === d) out.add(`https://*.${d}/*`);
    }
  }
  return [...out].sort();
}
