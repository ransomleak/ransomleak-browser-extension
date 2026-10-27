// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { brandMark, owlSvg } from '../src/lib/brand.ts';

// The full owl as it shipped in warning.html's <template id="brand"> before it moved to src/lib/brand.ts.
const ORIGINAL = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" fill="none" aria-hidden="true"><defs>
<radialGradient id="eyeGlow" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#A7F3D0"/><stop offset="100%" stop-color="#34D399"/></radialGradient>
<linearGradient id="bodyGrad" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#2A2F38"/><stop offset="100%" stop-color="#161920"/></linearGradient>
<linearGradient id="bodyHi" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#3D4450"/><stop offset="100%" stop-color="#252A33"/></linearGradient>
<linearGradient id="sageEdge" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#34D399"/><stop offset="100%" stop-color="#10B981"/></linearGradient></defs>
<path d="M60 5 L110 25 L110 85 L60 115 L10 85 L10 25 Z" fill="url(#bodyGrad)" stroke="url(#sageEdge)" stroke-width="2"/>
<path d="M60 15 L100 32 L100 75 L60 105 L20 75 L20 32 Z" fill="url(#bodyHi)" stroke="#3D4450" stroke-width="1"/>
<path d="M35 32 L60 20 L85 32" stroke="url(#sageEdge)" stroke-width="3" stroke-linecap="round"/>
<g class="eye"><circle cx="42" cy="48" r="12" fill="url(#eyeGlow)"/><circle cx="42" cy="48" r="6" fill="#0F1117"/><circle cx="40" cy="45" r="2.5" fill="#E7FFF3"/></g>
<g class="eye"><circle cx="78" cy="48" r="12" fill="url(#eyeGlow)"/><circle cx="78" cy="48" r="6" fill="#0F1117"/><circle cx="76" cy="45" r="2.5" fill="#E7FFF3"/></g>
<path d="M60 58 L52 72 L60 88 L68 72 Z" fill="#1a1a1a" stroke="#3D4450" stroke-width="1.5"/>
<path d="M15 25 L30 8 L38 38 Z" fill="url(#bodyHi)" stroke="url(#sageEdge)" stroke-width="1"/>
<path d="M105 25 L90 8 L82 38 Z" fill="url(#bodyHi)" stroke="url(#sageEdge)" stroke-width="1"/></svg>`;

/** Tag + sorted attributes per element, with gradient ids canonicalised. */
function shape(el: Element, prefix: string): string[] {
  const norm = (v: string): string => v.replace(prefix, '');
  const out: string[] = [];
  const walk = (e: Element): void => {
    const attrs = [...e.attributes].filter((a) => a.name !== 'xmlns').map((a) => `${a.name}=${norm(a.value)}`).sort();
    out.push(`${e.localName}[${attrs.join(' ')}]`);
    for (const c of e.children) walk(c);
  };
  walk(el);
  return out;
}

describe('brand mark', () => {
  it('builds the same full owl the pages used to ship', () => {
    const svg = owlSvg(document);
    const prefix = /^(rl-owl-\d+-)/.exec(svg.querySelector('radialGradient')!.id)![1]!;
    const original = new DOMParser().parseFromString(ORIGINAL, 'image/svg+xml').documentElement;
    expect(shape(svg, prefix).map((s) => s.replaceAll(prefix, ''))).toEqual(shape(original, '\u0000'));
    expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
  });
  it('gives every full owl its own gradient ids', () => {
    const ids = (s: SVGSVGElement): string[] => [...s.querySelectorAll('[id]')].map((e) => e.id);
    const a = ids(owlSvg(document));
    const b = ids(owlSvg(document));
    expect(a).toHaveLength(4);
    expect(a.filter((id) => b.includes(id))).toEqual([]);
  });
  it('compact owl: flat shapes, no gradients or ids', () => {
    const svg = owlSvg(document, 'compact');
    expect(svg.querySelectorAll('[id], defs')).toHaveLength(0);
    expect(svg.children).toHaveLength(6);
    expect(svg.getAttribute('viewBox')).toBe('0 0 120 120');
  });
  it('brandMark wraps the owl and the word mark', () => {
    const b = brandMark(document);
    expect(b.className).toBe('brand');
    expect(b.querySelector('svg')).not.toBeNull();
    expect(b.querySelector('span')!.textContent).toBe('RansomLeak');
  });
});
