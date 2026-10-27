import { describe, expect, it } from 'vitest';
import lock from '../permissions.lock.json';
import { buildManifest } from '../src/manifest.ts';

describe('manifest', () => {
  const manifest = buildManifest(false);
  const dev = buildManifest(true);

  it('is MV3 with a service worker', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.background?.service_worker).toBe('src/background/index.ts');
  });

  it('requests exactly the pinned permissions and no host permissions', () => {
    expect(manifest.permissions).toEqual(['webNavigation', 'storage', 'alarms', 'scripting', 'activeTab']);
    expect(manifest.permissions).toEqual(lock.permissions);
    expect(manifest.optional_permissions).toEqual(['downloads', 'notifications']);
    expect(manifest.optional_host_permissions).toEqual(lock.optional_host_permissions);
    // Optional site access is the AI tool list only: never all sites (that forces an in-depth store review).
    expect(manifest.optional_host_permissions).toContain('https://chatgpt.com/*');
    for (const o of manifest.optional_host_permissions) expect(o).toMatch(/^https:\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+\/\*$/);
    expect(manifest.host_permissions ?? []).toEqual([]);
  });

  it('content-script matches equal the consent list in permissions.lock.json', () => {
    const matches = (manifest.content_scripts ?? []).flatMap((c) => c.matches ?? []);
    expect(matches).toEqual(lock.content_scripts_matches);
    expect(matches).toHaveLength(9);
    expect(matches).not.toContain('https://login.microsoftonline.com/common/*');
  });

  it('externally_connectable allows only the two prod hosts', () => {
    expect(manifest.externally_connectable?.matches).toEqual([
      'https://app.ransomleak.com/*',
      'https://app.eu.ransomleak.com/*',
    ]);
  });

  it('dev build additionally allows app.localhost', () => {
    expect(dev.externally_connectable?.matches).toEqual([
      'https://app.ransomleak.com/*',
      'https://app.eu.ransomleak.com/*',
      'https://app.localhost:*/*',
    ]);
  });

  it('declares the managed storage schema', () => {
    expect(manifest.storage?.managed_schema).toBe('managed-schema.json');
  });
});
