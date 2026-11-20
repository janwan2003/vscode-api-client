// Ad-hoc check (not part of the suite): import every OpenAPI file in a directory, compare operation counts and re-parse the output.
// Usage: npx esbuild scripts/openapi-real-check.ts --bundle --platform=node --format=esm --outfile=/tmp/x/check.mjs && node /tmp/x/check.mjs <dir>
import { readFileSync, readdirSync } from 'node:fs';
import { detectAndImport, collectionsToFiles } from '../src/core/importers/index.ts';
import { parseHttpFile } from '../src/core/httpFile.ts';
const dir = process.argv[2];
const M = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
for (const f of readdirSync(dir).sort()) {
  const text = readFileSync(`${dir}/${f}`, 'utf8');
  const t0 = performance.now();
  let cs;
  try { cs = detectAndImport(text, f); } catch (e) { console.log(`${f}: ERROR ${(e as Error).message}`); continue; }
  const ms = performance.now() - t0;
  let doc: any; try { doc = JSON.parse(text); } catch { doc = undefined; }
  let ops = 0;
  if (doc) for (const p of Object.values(doc.paths ?? {}) as any[]) for (const m of M) if (p && typeof p[m] === 'object') ops++;
  const files = collectionsToFiles(cs);
  let reparsed = 0, bytes = 0;
  for (const x of files) { bytes += x.content.length; if (x.path.endsWith('.http')) reparsed += parseHttpFile(x.content).requests.length; }
  const reqs = cs.reduce((n, c) => n + c.folders.reduce((m, ff) => m + ff.requests.length, 0), 0);
  const warns = cs.flatMap((c) => c.warnings);
  console.log(`${f}: ops=${doc ? ops : '?'} requests=${reqs} reparsed=${reparsed} files=${files.length} out=${(bytes / 1024).toFixed(0)}KB ${ms.toFixed(0)}ms warnings=${warns.length}`);
  for (const w of warns.slice(0, 6)) console.log(`   - ${w.slice(0, 200)}`);
}
