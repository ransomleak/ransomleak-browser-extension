// The RansomLeak Sentinel owl: the one source of the brand mark for the warning page, the popup and the
// in-page overlays. Built with DOM calls only (no innerHTML / templates): content scripts run on pages
// that enforce Trusted Types, and the bundler inlines this module into each self-contained content script.

const SVG_NS = 'http://www.w3.org/2000/svg';

type Attrs = Record<string, string>;
/** A shape: tag, attributes, optional children. */
type Shape = [tag: string, attrs: Attrs, children?: Shape[]];

/** `full`: the detailed mark (warning page, popup). `compact`: simplified for ~30px in-page overlays. */
export type OwlVariant = 'full' | 'compact';

let seq = 0;

function build(doc: Document, [tag, attrs, children]: Shape): SVGElement {
  const n = doc.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  for (const c of children ?? []) n.append(build(doc, c));
  return n;
}

const stops = (from: string, to: string): Shape[] => [
  ['stop', { offset: '0%', 'stop-color': from }],
  ['stop', { offset: '100%', 'stop-color': to }],
];

function fullShapes(id: (name: string) => string): Shape[] {
  const url = (name: string): string => `url(#${id(name)})`;
  const eye = (cx: number): Shape => ['g', { class: 'eye' }, [
    ['circle', { cx: String(cx), cy: '48', r: '12', fill: url('eyeGlow') }],
    ['circle', { cx: String(cx), cy: '48', r: '6', fill: '#0F1117' }],
    ['circle', { cx: String(cx - 2), cy: '45', r: '2.5', fill: '#E7FFF3' }],
  ]];
  return [
    ['defs', {}, [
      ['radialGradient', { id: id('eyeGlow'), cx: '50%', cy: '50%', r: '50%' }, stops('#A7F3D0', '#34D399')],
      ['linearGradient', { id: id('bodyGrad'), x1: '0%', y1: '0%', x2: '100%', y2: '100%' }, stops('#2A2F38', '#161920')],
      ['linearGradient', { id: id('bodyHi'), x1: '0%', y1: '0%', x2: '0%', y2: '100%' }, stops('#3D4450', '#252A33')],
      ['linearGradient', { id: id('sageEdge'), x1: '0%', y1: '0%', x2: '100%', y2: '100%' }, stops('#34D399', '#10B981')],
    ]],
    ['path', { d: 'M60 5 L110 25 L110 85 L60 115 L10 85 L10 25 Z', fill: url('bodyGrad'), stroke: url('sageEdge'), 'stroke-width': '2' }],
    ['path', { d: 'M60 15 L100 32 L100 75 L60 105 L20 75 L20 32 Z', fill: url('bodyHi'), stroke: '#3D4450', 'stroke-width': '1' }],
    ['path', { d: 'M35 32 L60 20 L85 32', stroke: url('sageEdge'), 'stroke-width': '3', 'stroke-linecap': 'round' }],
    eye(42),
    eye(78),
    ['path', { d: 'M60 58 L52 72 L60 88 L68 72 Z', fill: '#1a1a1a', stroke: '#3D4450', 'stroke-width': '1.5' }],
    ['path', { d: 'M15 25 L30 8 L38 38 Z', fill: url('bodyHi'), stroke: url('sageEdge'), 'stroke-width': '1' }],
    ['path', { d: 'M105 25 L90 8 L82 38 Z', fill: url('bodyHi'), stroke: url('sageEdge'), 'stroke-width': '1' }],
  ];
}

// Same marks as the full owl, flat colours and heavier strokes so it reads at 30px.
const COMPACT: Shape[] = [
  ['path', { d: 'M60 5 L110 25 L110 85 L60 115 L10 85 L10 25 Z', fill: '#1c2027', stroke: '#34D399', 'stroke-width': '5' }],
  ['circle', { cx: '42', cy: '50', r: '13', fill: '#6EE7B7' }], ['circle', { cx: '42', cy: '50', r: '6', fill: '#0F1117' }],
  ['circle', { cx: '78', cy: '50', r: '13', fill: '#6EE7B7' }], ['circle', { cx: '78', cy: '50', r: '6', fill: '#0F1117' }],
  ['path', { d: 'M60 64 L52 76 L60 90 L68 76 Z', fill: '#3D4450' }],
];

/** The owl as an `<svg viewBox="0 0 120 120">`; gradient ids are unique per call (several marks per document are safe). */
export function owlSvg(doc: Document, variant: OwlVariant = 'full'): SVGSVGElement {
  const root = doc.createElementNS(SVG_NS, 'svg');
  root.setAttribute('viewBox', '0 0 120 120');
  let shapes = COMPACT;
  if (variant === 'full') {
    root.setAttribute('fill', 'none');
    const prefix = `rl-owl-${++seq}-`;
    shapes = fullShapes((name) => prefix + name);
  }
  root.setAttribute('aria-hidden', 'true');
  for (const s of shapes) root.append(build(doc, s));
  return root;
}

/** `<div class="brand">` with the owl and the "RansomLeak" word mark (styled by each surface's `.brand` CSS). */
export function brandMark(doc: Document, variant: OwlVariant = 'full'): HTMLDivElement {
  const div = doc.createElement('div');
  div.className = 'brand';
  const name = doc.createElement('span');
  name.textContent = 'RansomLeak';
  div.append(owlSvg(doc, variant), name);
  return div;
}
