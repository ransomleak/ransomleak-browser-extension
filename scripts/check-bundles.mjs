// Post-build chunking checks: the consent content script is one classic script with nothing shared,
// and the popup's module graph never pulls in the warning page entry (whose main() would run there).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
const problems = [];

const js = (manifest.content_scripts ?? []).flatMap((c) => c.js ?? []);
if (js.length !== 1) problems.push(`expected one content-script file, got ${JSON.stringify(js)}`);
for (const f of js) {
  const src = readFileSync(join(dist, f), 'utf8');
  if (/\bimport\s*[({"'`]|\bimport\s+[\w{*]|\bexport\s/.test(src)) problems.push(`${f} has import/export: not self-contained`);
}
// The password-entry and AI paste scripts are registered at runtime (chrome.scripting), so they are not in the manifest.
for (const file of ['content-password.js', 'content-aipaste.js']) {
  if (!existsSync(join(dist, file))) problems.push(`${file} missing`);
  else {
    const src = readFileSync(join(dist, file), 'utf8');
    if (/\bimport\s*[({"'`]|\bimport\s+[\w{*]|\bexport\s/.test(src)) problems.push(`${file} has import/export: not self-contained`);
  }
}
if (manifest.web_accessible_resources) problems.push('web_accessible_resources present');

// Walk the popup's static and dynamic imports.
const html = readFileSync(join(dist, manifest.action.default_popup), 'utf8');
const entry = /<script[^>]+src="\/?([^"]+)"/.exec(html)?.[1];
const seen = new Set();
const walk = (rel) => {
  if (seen.has(rel)) return;
  seen.add(rel);
  const p = join(dist, rel);
  if (!existsSync(p)) return;
  const src = readFileSync(p, 'utf8');
  for (const m of src.matchAll(/(?:from|import\(?)\s*["']\.\/([^"']+)["']/g)) walk(join(dirname(rel), m[1]));
};
if (!entry) problems.push('popup entry script not found');
else walk(entry);
for (const rel of seen) {
  if (readFileSync(join(dist, rel), 'utf8').includes('warning-info')) problems.push(`popup graph includes warning main(): ${rel}`);
}

if (problems.length) {
  console.error('Bundle check FAILED:');
  for (const p of problems) console.error(' - ' + p);
  process.exit(1);
}
console.log(`Bundle check passed (content script ${js[0]}; popup graph ${[...seen].join(', ')}).`);
