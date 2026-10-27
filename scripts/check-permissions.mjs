// Fails if dist/manifest.json drifts from permissions.lock.json (spec section 12).
import { readFileSync } from 'node:fs';

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const lock = read('../permissions.lock.json');
const built = read('../dist/manifest.json');

const actual = {
  manifest_version: built.manifest_version,
  permissions: built.permissions ?? [],
  host_permissions: built.host_permissions ?? [],
  optional_permissions: built.optional_permissions ?? [],
  optional_host_permissions: built.optional_host_permissions ?? [],
  content_scripts_matches: (built.content_scripts ?? []).flatMap((c) => c.matches ?? []),
  externally_connectable: built.externally_connectable ?? null,
  content_security_policy: built.content_security_policy ?? null,
  web_accessible_resources: built.web_accessible_resources ?? null,
};

const problems = [];
for (const key of Object.keys(lock)) {
  if (JSON.stringify(actual[key]) !== JSON.stringify(lock[key])) {
    problems.push(`${key}: expected ${JSON.stringify(lock[key])}, got ${JSON.stringify(actual[key])}`);
  }
}
for (const key of ['optional_permissions', 'optional_host_permissions']) {
  if (!(key in lock)) problems.push(`${key} missing from permissions.lock.json`);
}

if (problems.length) {
  console.error('Permission check FAILED (update permissions.lock.json only as a product decision):');
  for (const p of problems) console.error(' - ' + p);
  process.exit(1);
}
console.log('Permission check passed.');
