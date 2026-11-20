/// <reference lib="dom.iterable" />
// DOM wiring for the website converters (docs/convert-to-http-file.html, docs/http-file-to-curl.html).
// Everything runs in the page: no network requests, nothing is uploaded or stored.
import { CODE_TARGETS, convertToHttp, httpToCode, parseEnvironment, type CodeTarget } from './convert.ts';
import { zipFiles } from './zip.ts';

const EXAMPLES: Record<string, { name: string; text: string }> = {
  postman: {
    name: 'Shop API.postman_collection.json',
    text: JSON.stringify(
      {
        info: { name: 'Shop API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
        auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}', type: 'string' }] },
        variable: [{ key: 'baseUrl', value: 'https://api.example.com' }],
        item: [
          {
            name: 'Orders',
            item: [
              {
                name: 'List orders',
                request: { method: 'GET', header: [{ key: 'Accept', value: 'application/json' }], url: '{{baseUrl}}/orders?status=open' },
                event: [{ listen: 'test', script: { exec: ['pm.test("ok", () => pm.response.to.have.status(200));'] } }],
              },
              {
                name: 'Create order',
                request: {
                  method: 'POST',
                  header: [],
                  body: { mode: 'raw', raw: '{\n  "sku": "TSHIRT-M",\n  "quantity": 2\n}', options: { raw: { language: 'json' } } },
                  url: '{{baseUrl}}/orders',
                },
              },
            ],
          },
          { name: 'Health', request: { method: 'GET', url: '{{baseUrl}}/health', auth: { type: 'noauth' } } },
        ],
      },
      null,
      2,
    ),
  },
  thunder: {
    name: 'thunder-collection_Users.json',
    text: JSON.stringify(
      {
        clientName: 'Thunder Client',
        collectionName: 'Users',
        dateExported: '2026-11-01T10:00:00.000Z',
        version: '1.2',
        folders: [],
        requests: [
          {
            _id: 'r1',
            colId: 'c1',
            containerId: '',
            name: 'Get user',
            url: '{{url}}/users/42',
            method: 'GET',
            sortNum: 10000,
            headers: [{ name: 'Accept', value: 'application/json' }],
            params: [],
            tests: [{ type: 'res-code', custom: '', action: 'equal', value: '200' }],
          },
          {
            _id: 'r2',
            colId: 'c1',
            containerId: '',
            name: 'Create user',
            url: '{{url}}/users',
            method: 'POST',
            sortNum: 20000,
            headers: [],
            params: [],
            body: { type: 'json', raw: '{\n  "name": "Ada"\n}', form: [] },
            tests: [],
          },
        ],
      },
      null,
      2,
    ),
  },
  curl: {
    name: '',
    text: `curl -X POST 'https://api.example.com/v1/orders' \\\n  -H 'Authorization: Bearer abc123' \\\n  -H 'Content-Type: application/json' \\\n  --data-raw '{"sku":"TSHIRT-M","quantity":2}'`,
  },
  http: {
    name: '',
    text: `@baseUrl = https://api.example.com

### Create an order
POST {{baseUrl}}/orders
Authorization: Bearer {{token}}
Content-Type: application/json

{
  "sku": "TSHIRT-M",
  "quantity": 2
}

### List open orders
GET {{baseUrl}}/orders?status=open
Accept: application/json
`,
  },
};

function $<T extends HTMLElement>(sel: string): T {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
}

function download(name: string, data: BlobPart, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copy(text: string, button: HTMLButtonElement): Promise<void> {
  const label = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'Copied';
  } catch {
    button.textContent = 'Copy failed';
  }
  setTimeout(() => (button.textContent = label), 1200);
}

function debounce(fn: () => void, ms = 200): () => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return () => {
    clearTimeout(t);
    t = setTimeout(fn, ms);
  };
}

function setupImport(): void {
  const src = $<HTMLTextAreaElement>('#pw-src');
  const fileInput = $<HTMLInputElement>('#pw-files');
  const summary = $('#pw-summary');
  const tabs = $('#pw-tabs');
  const code = $('#pw-code');
  const warnings = $('#pw-warnings');
  const actions = $('#pw-actions');
  let loaded: { name: string; text: string }[] = []; // files chosen with the picker or dropped
  let files: { path: string; content: string }[] = [];
  let current = 0;

  const show = (i: number) => {
    current = i;
    for (const [n, b] of [...tabs.children].entries()) b.setAttribute('aria-selected', String(n === i));
    code.textContent = files[i]?.content ?? '';
  };

  const run = () => {
    const inputs = loaded.length ? loaded : [{ name: src.dataset.name || undefined, text: src.value }];
    const r = convertToHttp(inputs as { name?: string; text: string }[]);
    files = r.files;
    tabs.replaceChildren(
      ...files.map((f, i) => {
        const b = el('button', { type: 'button', className: 'pw-tab', textContent: f.path });
        b.setAttribute('role', 'tab');
        b.addEventListener('click', () => show(i));
        return b;
      }),
    );
    const parts: string[] = [];
    if (files.length) parts.push(`${r.requests} request${r.requests === 1 ? '' : 's'} → ${files.length} file${files.length === 1 ? '' : 's'}`);
    if (r.errors.length) parts.push(r.errors.join(' · '));
    if (!inputs.some((x) => x.text.trim())) parts.push('Paste an export or a curl command, or choose files.');
    summary.textContent = parts.join(' · ');
    summary.classList.toggle('pw-error', r.errors.length > 0 && !files.length);
    warnings.replaceChildren(...r.warnings.map((w) => el('li', { textContent: w })));
    $('#pw-warnings-box').hidden = r.warnings.length === 0;
    actions.hidden = files.length === 0;
    show(Math.min(current, Math.max(files.length - 1, 0)));
  };

  src.addEventListener('input', debounce(() => {
    loaded = [];
    src.dataset.name = '';
    run();
  }));
  const readFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    loaded = await Promise.all([...list].map(async (f) => ({ name: f.name, text: await f.text() })));
    src.value = loaded.length === 1 ? loaded[0].text : loaded.map((f) => `// ${f.name}\n${f.text.slice(0, 2000)}${f.text.length > 2000 ? '\n…' : ''}`).join('\n\n');
    current = 0;
    run();
  };
  fileInput.addEventListener('change', () => void readFiles(fileInput.files));
  src.addEventListener('dragover', (e) => e.preventDefault());
  src.addEventListener('drop', (e) => {
    e.preventDefault();
    void readFiles(e.dataTransfer?.files ?? null);
  });
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-example]')) {
    b.addEventListener('click', () => {
      const ex = EXAMPLES[b.dataset.example ?? ''];
      loaded = [];
      src.value = ex.text;
      src.dataset.name = ex.name;
      current = 0;
      run();
    });
  }
  $<HTMLButtonElement>('#pw-copy').addEventListener('click', (e) => void copy(files[current]?.content ?? '', e.currentTarget as HTMLButtonElement));
  $<HTMLButtonElement>('#pw-download').addEventListener('click', () => {
    const f = files[current];
    if (f) download(f.path.split('/').pop() ?? 'requests.http', f.content, 'text/plain');
  });
  $<HTMLButtonElement>('#pw-zip').addEventListener('click', () => {
    const z = zipFiles(files);
    download(`${files[0]?.path.split('/')[0] || 'plainwire'}.zip`, z.buffer as ArrayBuffer, 'application/zip');
  });
  run();
}

function setupCode(): void {
  const src = $<HTMLTextAreaElement>('#pw-src');
  const target = $<HTMLSelectElement>('#pw-target');
  const envText = $<HTMLTextAreaElement>('#pw-env');
  const envName = $<HTMLSelectElement>('#pw-envname');
  const out = $('#pw-out');
  const summary = $('#pw-summary');
  target.replaceChildren(...CODE_TARGETS.map((t) => el('option', { value: t.id, textContent: `${t.label} (${t.detail})` })));
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('to');
  if (fromHash && CODE_TARGETS.some((t) => t.id === fromHash)) target.value = fromHash;

  const run = () => {
    let env: Record<string, string> = {};
    let envError = '';
    try {
      const parsed = parseEnvironment(envText.value, envName.value || undefined);
      env = parsed.vars;
      const keep = envName.value;
      envName.replaceChildren(...parsed.names.map((n) => el('option', { value: n, textContent: n })));
      (envName.parentElement as HTMLElement).hidden = parsed.names.length === 0;
      if (parsed.names.includes(keep)) envName.value = keep;
    } catch (e) {
      envError = `Environment: ${(e as Error).message}`;
    }
    let snippets: ReturnType<typeof httpToCode> = [];
    try {
      snippets = httpToCode(src.value, target.value as CodeTarget, env);
    } catch (e) {
      envError = (e as Error).message;
    }
    const unresolved = [...new Set(snippets.flatMap((s) => s.unresolved))];
    const parts = [`${snippets.length} request${snippets.length === 1 ? '' : 's'}`];
    if (unresolved.length) parts.push(`left as written (add them under Variables): ${unresolved.map((u) => `{{${u}}}`).join(', ')}`);
    if (envError) parts.push(envError);
    if (!src.value.trim()) parts.splice(0, parts.length, 'Paste the contents of an .http or .rest file.');
    summary.textContent = parts.join(' · ');
    out.replaceChildren(
      ...snippets.map((s) => {
        const pre = el('pre', { className: 'pw-code' }, el('code', { textContent: s.code }));
        const btn = el('button', { type: 'button', className: 'btn secondary pw-small', textContent: 'Copy' });
        btn.addEventListener('click', () => void copy(s.code, btn));
        return el('div', { className: 'pw-snippet' }, el('div', { className: 'pw-snippet-head' }, el('strong', { textContent: s.title }), btn), pre);
      }),
    );
  };
  const later = debounce(run);
  src.addEventListener('input', later);
  envText.addEventListener('input', later);
  target.addEventListener('change', run);
  envName.addEventListener('change', run);
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-example]')) {
    b.addEventListener('click', () => {
      src.value = EXAMPLES[b.dataset.example ?? '']?.text ?? '';
      if (!envText.value.trim()) envText.value = 'token=abc123';
      run();
    });
  }
  run();
}

const tool = document.body.dataset.tool;
if (tool === 'import') setupImport();
else if (tool === 'code') setupCode();
