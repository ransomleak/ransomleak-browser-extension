import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { crx } from '@crxjs/vite-plugin';
import { build, defineConfig, loadEnv, type Plugin } from 'vite';
import { buildManifest } from './src/manifest.ts';

const OUT_DIR = 'dist';
const CONTENT_FILE = 'content-consent.js';
/** Registered at runtime (chrome.scripting) once the optional host permission is granted; see protect.ts. */
const PASSWORD_FILE = 'content-password.js';
const PASSWORD_ENTRY = 'src/content/password/index.ts';
/** Registered at runtime on AI tool hosts only, when the AI paste detector is on; see protect.ts. */
const AIPASTE_FILE = 'content-aipaste.js';
const AIPASTE_ENTRY = 'src/content/aipaste/index.ts';

/**
 * The consent content script is bundled on its own as a single IIFE with every import inlined.
 * Left to crxjs it would share chunks with the extension pages, and crxjs loads shared chunks from a
 * content script through web_accessible_resources (forbidden by permissions.lock.json).
 */
function contentScriptIife(entry: string, contentScripts: unknown[]): Plugin {
  return {
    name: 'rl-content-script-iife',
    apply: 'build',
    async closeBundle() {
      const iife = (src: string, name: string, file: string) => build({
        configFile: false,
        logLevel: 'warn',
        build: {
          outDir: OUT_DIR,
          emptyOutDir: false,
          copyPublicDir: false,
          sourcemap: false,
          lib: { entry: resolve(src), formats: ['iife'], name, fileName: () => file },
        },
      });
      await iife(entry, 'rlConsent', CONTENT_FILE);
      await iife(PASSWORD_ENTRY, 'rlPassword', PASSWORD_FILE);
      await iife(AIPASTE_ENTRY, 'rlAiPaste', AIPASTE_FILE);
      const path = resolve(OUT_DIR, 'manifest.json');
      const manifest = JSON.parse(readFileSync(path, 'utf8'));
      manifest.content_scripts = contentScripts;
      writeFileSync(path, JSON.stringify(manifest, null, 2));
    },
  };
}

export default defineConfig(({ mode }) => {
  const staging = mode === 'staging' ? loadEnv(mode, process.cwd()) : undefined;
  const { content_scripts, ...built } = buildManifest(mode === 'dev', staging?.VITE_STAGING_BASE);
  // Staging only: a fixed public key pins the unpacked id so staging can allow-list it.
  const manifest = staging?.VITE_STAGING_KEY ? { ...built, key: staging.VITE_STAGING_KEY } : built;
  const [cs] = content_scripts;
  return {
    plugins: [crx({ manifest }), contentScriptIife(cs!.js[0]!, [{ ...cs, js: [CONTENT_FILE] }])],
    build: {
      outDir: OUT_DIR,
      sourcemap: false,
      // Extension pages that are not in the manifest must be listed as inputs.
      rollupOptions: { input: { warning: 'src/warning/warning.html' } },
    },
    test: { include: ['test/**/*.test.ts'] },
  };
});
