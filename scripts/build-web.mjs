// Bundle the website converters (src/web/ui.ts + the shared core) into one file served by GitHub Pages.
//   node scripts/build-web.mjs           → docs/convert.js
//   node scripts/build-web.mjs --check   → exit 1 if docs/convert.js is out of date (used in CI)
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const out = 'docs/convert.js';
const result = await build({
  entryPoints: ['src/web/ui.ts'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  minify: true,
  legalComments: 'none',
  alias: { 'node:crypto': fileURLToPath(new URL('../src/web/shims/crypto.ts', import.meta.url)) },
  define: { 'process.env': '{}' },
  banner: { js: '/* Plainwire website converter, MIT. Source: https://github.com/janwan2003/vscode-api-client/tree/main/src/web */' },
  write: false,
  logLevel: 'error',
});
const code = result.outputFiles[0].text;
if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(out, 'utf8');
  } catch {}
  if (current !== code) {
    console.error(`${out} is out of date: run node scripts/build-web.mjs`);
    process.exit(1);
  }
  console.log(`${out} is up to date (${code.length} bytes)`);
} else {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(out, code);
  console.log(`${out}: ${code.length} bytes`);
}
