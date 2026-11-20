// The website's in-browser converters, built on the same core as the extension and the CLI.
// Pure functions (no DOM), so they are unit-tested in Node; ui.ts wires them to the pages.
import { CODE_TARGETS, generateCode, type CodeTarget } from '../core/codegen.ts';
import { parseHttpFile } from '../core/httpFile.ts';
import { attachEnvironments, collectionsToFiles, detectAndImport } from '../core/importers/index.ts';
import type { ImportedCollection } from '../core/model.ts';
import { readThunderStore } from '../core/importers/thunderStore.ts';
import { normalizeBasicAuth, toWireForm, bodyFileRef } from '../core/preview.ts';
import { mergeEnvironment, parseDotenv, resolveRequest, type VariableContext } from '../core/variables.ts';
import { ensureScheme } from '../core/wire.ts';

export { CODE_TARGETS, type CodeTarget };

export interface ImportResult {
  files: { path: string; content: string }[];
  warnings: string[];
  requests: number;
  /** Per-input errors ("name: message"); other inputs are still converted. */
  errors: string[];
}

/** Postman / Thunder Client exports or curl commands → `.http` files + `http-client.env.json`. */
/** Thunder Client's own data files, which only make sense together (requests in one, their collection names in another). */
const THUNDER_DATA = /^(thunder(client|Collection|Environment|Activity)\.(json|db)|tc_(col|env)_.+\.json|.+\.db)$/i;

export function convertToHttp(inputs: { name?: string; text: string }[]): ImportResult {
  let collections: ImportedCollection[] = [];
  const errors: string[] = [];
  const thunder = inputs.filter((i) => i.name && THUNDER_DATA.test(i.name.split(/[\\/]/).pop() ?? '') && i.text.trim());
  if (thunder.length > 1) {
    const store = readThunderStore(thunder.map((i) => ({ path: i.name as string, text: i.text })), { history: true });
    collections.push(...store.collections);
    errors.push(...store.skipped);
    inputs = inputs.filter((i) => !thunder.includes(i));
  }
  for (const input of inputs) {
    if (!input.text.trim()) continue;
    try {
      collections.push(...detectAndImport(input.text, input.name));
    } catch (e) {
      errors.push(input.name ? `${input.name}: ${(e as Error).message}` : (e as Error).message);
    }
  }
  collections = attachEnvironments(collections);
  const warnings = collections.flatMap((c) => c.warnings.map((w) => (collections.length > 1 ? `${c.name}: ${w}` : w)));
  const requests = collections.reduce((n, c) => n + c.folders.reduce((m, f) => m + f.requests.length, 0), 0);
  return { files: collectionsToFiles(collections), warnings, requests, errors };
}

export interface Snippet {
  title: string;
  code: string;
  /** `{{variables}}` that could not be resolved and are left in the snippet as written. */
  unresolved: string[];
}

/**
 * Parse `envText` as either `http-client.env.json` (`{ "dev": {...}, "$shared": {...} }`), a flat
 * JSON object, or `KEY=value` lines. Returns the variables of `envName` (or the first environment).
 */
export function parseEnvironment(envText: string, envName?: string): { vars: Record<string, string>; names: string[] } {
  const t = envText.trim();
  if (!t) return { vars: {}, names: [] };
  if (t.startsWith('{')) {
    const json = JSON.parse(t) as Record<string, unknown>;
    const values = Object.values(json);
    if (values.length && values.every((v) => v !== null && typeof v === 'object' && !Array.isArray(v))) {
      const all = json as Record<string, Record<string, string>>;
      const names = Object.keys(all).filter((n) => n !== '$shared');
      const selected = envName && names.includes(envName) ? envName : names[0];
      return { vars: mergeEnvironment(all, selected), names };
    }
    return { vars: Object.fromEntries(Object.entries(json).map(([k, v]) => [k, String(v)])), names: [] };
  }
  return { vars: parseDotenv(t), names: [] };
}

/** Every request in an `.http` file → a snippet for `target`, with file variables and `env` resolved. */
export function httpToCode(httpText: string, target: CodeTarget, env: Record<string, string> = {}): Snippet[] {
  const parsed = parseHttpFile(httpText);
  return parsed.requests.map((req, i) => {
    const unresolved = new Set<string>();
    const ctx: VariableContext = { fileVariables: parsed.variables, environment: env, named: new Map(), processEnv: {}, dotenv: {}, unresolved };
    const resolved = resolveRequest(req, ctx);
    normalizeBasicAuth(resolved);
    resolved.url = ensureScheme(resolved.url.trim());
    // A `<@ file` body cannot be read here: keep it as a plain file reference for the snippet.
    const ref = bodyFileRef(resolved.body);
    if (ref?.resolveVariables) resolved.body = `< ${ref.path}`;
    const title = req.title || req.name || `${req.method} ${req.url}`;
    return { title: `${i + 1}. ${title}`, code: generateCode(target, toWireForm(resolved)), unresolved: [...unresolved] };
  });
}
