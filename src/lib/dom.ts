/** Creates an element with optional text and class. Text goes through textContent, never innerHTML. */
export function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  if (text !== undefined) e.textContent = text; // page-derived names stay inert
  if (cls) e.className = cls;
  return e;
}
