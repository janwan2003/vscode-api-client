// @ts-check
/* Plainwire request editor webview. Plain DOM, no framework. */
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'WEBSOCKET', 'GRAPHQL'];
  const BODY_TYPES = [
    ['none', 'None', ''],
    ['json', 'JSON', 'application/json'],
    ['text', 'Text', 'text/plain'],
    ['xml', 'XML', 'application/xml'],
    ['form', 'Form URL-encoded', 'application/x-www-form-urlencoded'],
    ['graphql', 'GraphQL', 'application/json'],
  ];
  const MAX_TREE = 2 * 1024 * 1024;
  const MAX_LIVE_EVENTS = 500;
  const STREAM_END = { closed: 'closed by the server', stopped: 'stopped', timeout: 'timed out', 'max-events': 'max events reached', done: 'done, all replies arrived' };
  /** Same rule as core/websocket.ts isWebSocketRequest. */
  const isWs = (q) => !!q && (['WEBSOCKET', 'WS'].includes(String(q.method).toUpperCase()) || (String(q.method).toUpperCase() === 'GET' && /^\s*wss?:\/\//i.test(q.url || '')));

  /** @type {any} */
  let S = vscode.getState() || {
    request: { method: 'GET', url: '', headers: [] },
    response: null,
    resolved: null,
    error: null,
    sending: false,
    meta: { sourceLabel: '', canSave: false, env: null, envNames: [], authIds: [] },
    reqTab: 'params',
    resTab: 'body',
    raw: false,
    dirty: false,
  };

  const $ = (/** @type {string} */ sel, root = document) => /** @type {HTMLElement} */ (root.querySelector(sel));
  /** @returns {HTMLElement} */
  function h(/** @type {string} */ tag, /** @type {any} */ attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'value') /** @type {any} */ (el).value = v;
      else if (k === 'checked') /** @type {any} */ (el).checked = v;
      else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
    return el;
  }

  function persist() {
    vscode.setState(S);
  }
  function changed() {
    S.dirty = true;
    persist();
    vscode.postMessage({ type: 'changed', request: S.request });
    const d = $('#dirty');
    if (d) d.hidden = !S.meta.canSave;
  }

  // ---------- request helpers ----------
  function header(name) {
    return S.request.headers.find((x) => !x.disabled && x.name.toLowerCase() === name.toLowerCase());
  }
  function setHeader(name, value) {
    const hd = S.request.headers.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (value === null) S.request.headers = S.request.headers.filter((x) => x !== hd);
    else if (hd) {
      hd.value = value;
      hd.disabled = false;
    } else S.request.headers.push({ name, value });
  }
  function splitQuery(url) {
    const q = url.indexOf('?');
    if (q < 0) return { base: url, params: [] };
    return {
      base: url.slice(0, q),
      params: url
        .slice(q + 1)
        .split('&')
        .filter(Boolean)
        .map((p) => {
          const i = p.indexOf('=');
          return i < 0 ? { name: p, value: '' } : { name: p.slice(0, i), value: p.slice(i + 1) };
        }),
    };
  }
  function joinQuery(base, params) {
    const q = params.filter((p) => p.name).map((p) => (p.value === '' ? p.name : p.name + '=' + p.value));
    return q.length ? base + '?' + q.join('&') : base;
  }
  // GraphQL in REST Client's form: header X-REQUEST-TYPE: GraphQL, body = query, blank line, variables JSON.
  // Same rules as src/core/graphql.ts (isGraphqlRequest / splitGraphqlBody / joinGraphqlBody), which does the sending.
  // Also the JetBrains HTTP Client's `GRAPHQL <url>` keyword (sent as POST).
  const isGqlMethod = () => String(S.request.method).toUpperCase() === 'GRAPHQL';
  function isGraphql() {
    return isGqlMethod() || (header('x-request-type')?.value || '').trim().toLowerCase() === 'graphql';
  }
  function splitGql(body) {
    const lines = body.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() !== '') continue;
      const rest = lines.slice(i + 1).join('\n').trim();
      if (/^\{(\s*["}]|\{)/.test(rest)) return { query: lines.slice(0, i).join('\n').trim(), variables: rest };
    }
    return { query: body.trim(), variables: '' };
  }
  function joinGql(query, variables) {
    const q = query.replace(/\s+$/, '');
    const v = variables.trim();
    return v ? q + '\n\n' + v : q;
  }
  /** GraphQL body → pretty {"query", "variables"} JSON, or null when the variables are not JSON yet. */
  function gqlToJson(body) {
    const { query, variables } = splitGql(body);
    try { return JSON.stringify({ query, variables: variables ? JSON.parse(variables) : {} }, null, 2); } catch { return null; }
  }
  /** {"query": "...", "variables": {...}} JSON → GraphQL body, or null when the body is not such JSON. */
  function jsonToGql(body) {
    try {
      const j = JSON.parse(body);
      if (!j || typeof j.query !== 'string') return null;
      const v = j.variables && typeof j.variables === 'object' && Object.keys(j.variables).length ? JSON.stringify(j.variables, null, 2) : '';
      return joinGql(j.query, v);
    } catch { return null; }
  }
  function bodyType() {
    if (isGraphql()) return 'graphql';
    const ct = (header('content-type')?.value || '').toLowerCase();
    if (ct.includes('json')) return 'json';
    if (ct.includes('xml')) return 'xml';
    if (ct.includes('x-www-form-urlencoded')) return 'form';
    if (S.request.body !== undefined && S.request.body !== '') return 'text';
    return ct ? 'text' : 'none';
  }
  function authInfo() {
    const a = header('authorization');
    if (!a) return { type: 'none' };
    const m = /^(Bearer|Basic)\s+(.*)$/i.exec(a.value);
    if (!m) return { type: 'other', value: a.value };
    const o = /^\{\{\s*\$auth\.(token|idToken)\(\s*["']([^"']+)["']\s*\)\s*\}\}$/.exec(m[2].trim());
    if (m[1].toLowerCase() === 'bearer' && o) return { type: 'oauth2', id: o[2], kind: o[1] };
    if (m[1].toLowerCase() === 'bearer') return { type: 'bearer', token: m[2] };
    const v = m[2];
    if (v.includes(':')) return { type: 'basic', user: v.slice(0, v.indexOf(':')), pass: v.slice(v.indexOf(':') + 1) };
    if (/\s/.test(v)) return { type: 'basic', user: v.split(/\s+/)[0], pass: v.split(/\s+/).slice(1).join(' ') };
    try {
      const d = atob(v);
      if (d.includes(':')) return { type: 'basic', user: d.slice(0, d.indexOf(':')), pass: d.slice(d.indexOf(':') + 1) };
    } catch {}
    return { type: 'other', value: a.value };
  }

  // ---------- rendering ----------
  function render() {
    const app = $('#app');
    app.replaceChildren(
      h('div', { class: 'bar' },
        h('select', { id: 'method', class: 'method m-' + S.request.method, title: 'HTTP method', onchange: (e) => {
          S.request.method = e.target.value; e.target.className = 'method m-' + S.request.method; changed(); } },
          ...[...new Set([...METHODS, S.request.method])].map((m) => h('option', { value: m, selected: m === S.request.method }, m))),
        h('input', { id: 'url', class: 'url', spellcheck: 'false', placeholder: 'https://api.example.com/users  — {{variables}} work here', value: S.request.url,
          oninput: (e) => { S.request.url = e.target.value; changed(); if (S.reqTab === 'params') renderReqBody(); },
          onpaste: onUrlPaste }),
        S.sending
          ? h('button', { class: 'primary', title: S.stream && S.stream.length ? (isWs(S.request) ? 'Close the WebSocket and keep the messages' : 'Stop the event stream and keep the events received') : 'Cancel the request', onclick: () => vscode.postMessage({ type: 'cancel' }) }, S.stream && S.stream.length ? 'Stop' : 'Cancel')
          : h('button', { class: 'primary', id: 'send', title: 'Send (Ctrl/Cmd+Enter)', onclick: send }, 'Send'),
        h('button', { title: S.meta.canSave ? 'Save to ' + S.meta.sourceLabel + ' (Ctrl/Cmd+S)' : 'Save to a .http file (Ctrl/Cmd+S)', onclick: save }, 'Save'),
        h('div', { class: 'menu' },
          h('button', { class: 'icon', title: 'More', onclick: (e) => { e.stopPropagation(); $('.menu-items').classList.toggle('open'); } }, '⋯'),
          h('div', { class: 'menu-items' },
            h('button', { onclick: () => vscode.postMessage({ type: 'saveAs', request: S.request }) }, 'Save as… (add to another .http file)'),
            h('button', { onclick: () => vscode.postMessage({ type: 'copyCurl', request: S.request }) }, 'Copy as cURL'),
            h('button', { title: 'cURL, fetch, Python, Go, HTTPie, PowerShell, wget, C#, PHP, Java', onclick: () => vscode.postMessage({ type: 'copyCode', request: S.request }) }, 'Copy as Code…'),
            S.meta.canSave ? h('button', { onclick: () => vscode.postMessage({ type: 'openText' }) }, 'Show in .http file') : null))),
      h('div', { class: 'sub' },
        h('span', { class: 'source', title: 'Where this request is stored' }, S.meta.sourceLabel, h('span', { id: 'dirty', class: 'dirty', hidden: !(S.dirty && S.meta.canSave) }, ' ● unsaved')),
        h('span', { class: 'sub-right' },
          h('button', { class: 'link layout', id: 'layoutBtn', onclick: toggleLayout }),
          h('button', { class: 'link env', title: 'Environment used for {{variables}}', onclick: () => vscode.postMessage({ type: 'selectEnv' }) },
            'Env: ', h('b', {}, S.meta.env || 'none')))),
      h('div', { class: 'split' },
        h('section', { class: 'req' },
          tabs(['params', 'Params', countParams()], ['headers', 'Headers', S.request.headers.filter((x) => !x.disabled).length], ['body', 'Body', bodyType() === 'none' ? '' : '●'], ['auth', 'Auth', authInfo().type === 'none' ? '' : '●'], ['tests', 'Tests', (S.request.asserts || []).length || ''], ['scripts', 'Scripts', scriptCount() || ''], ['info', 'Info', '']),
          h('div', { id: 'reqBody', class: 'pane' })),
        h('div', { class: 'gutter', title: 'Drag to resize · double-click to reset', onpointerdown: startDrag, ondblclick: () => { const l = layout(); delete l[layoutMode()]; saveLayout(l); } }),
        h('section', { class: 'res', id: 'res' })),
    );
    applyLayout();
    renderReqBody();
    renderResponse();
  }

  // ---------- layout: side by side or stacked, with a draggable divider ----------
  /** Below this width (CSS px) "auto" stacks the response under the request. */
  const SIDE_BY_SIDE_MIN = 820;
  function layout() {
    return { mode: 'auto', ...(S.meta.layout || {}) };
  }
  /** The layout in effect: 'cols' (request left, response right) or 'rows' (response below). */
  function layoutMode() {
    const l = layout();
    return l.mode === 'cols' || l.mode === 'rows' ? l.mode : window.innerWidth >= SIDE_BY_SIDE_MIN ? 'cols' : 'rows';
  }
  function applyLayout() {
    const sp = $('.split');
    if (!sp) return;
    const mode = layoutMode();
    const l = layout();
    const r = Math.min(0.85, Math.max(0.15, Number(l[mode]) || (mode === 'cols' ? 0.5 : 0.45)));
    sp.classList.toggle('cols', mode === 'cols');
    sp.classList.toggle('rows', mode === 'rows');
    const tracks = `minmax(0, ${r}fr) 7px minmax(0, ${1 - r}fr)`;
    sp.style.gridTemplateColumns = mode === 'cols' ? tracks : '';
    sp.style.gridTemplateRows = mode === 'rows' ? tracks : '';
    const b = $('#layoutBtn');
    if (b) {
      b.textContent = mode === 'cols' ? '⇅ Stack' : '⇆ Side by side';
      b.title = (mode === 'cols' ? 'Show the response below the request' : 'Show the response next to the request') + (l.mode === 'auto' ? ' (now automatic: side by side when this tab is at least ' + SIDE_BY_SIDE_MIN + ' px wide)' : '');
    }
  }
  function saveLayout(l) {
    S.meta.layout = l;
    persist();
    applyLayout();
    vscode.postMessage({ type: 'layout', layout: l });
  }
  function toggleLayout() {
    saveLayout({ ...layout(), mode: layoutMode() === 'cols' ? 'rows' : 'cols' });
  }
  function startDrag(/** @type {PointerEvent} */ e) {
    const sp = $('.split');
    const g = /** @type {HTMLElement} */ (e.currentTarget);
    if (!sp) return;
    e.preventDefault();
    try { g.setPointerCapture(e.pointerId); } catch { /* synthetic events have no active pointer */ }
    g.classList.add('dragging');
    const mode = layoutMode();
    const rect = sp.getBoundingClientRect();
    const l = layout();
    const move = (/** @type {PointerEvent} */ ev) => {
      const r = mode === 'cols' ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
      l[mode] = Math.round(Math.min(0.85, Math.max(0.15, r)) * 1000) / 1000;
      S.meta.layout = l;
      applyLayout();
    };
    const up = () => {
      g.removeEventListener('pointermove', move);
      g.removeEventListener('pointerup', up);
      g.classList.remove('dragging');
      saveLayout(l);
    };
    g.addEventListener('pointermove', move);
    g.addEventListener('pointerup', up);
  }
  window.addEventListener('resize', applyLayout);

  function countParams() {
    const n = splitQuery(S.request.url).params.length;
    return n || '';
  }

  function tabs(...defs) {
    return h('div', { class: 'tabs' }, ...defs.map(([id, label, badge]) =>
      h('button', { class: 'tab' + (S.reqTab === id ? ' active' : ''), onclick: () => { S.reqTab = id; persist(); render(); } }, label, badge !== '' && badge !== 0 ? h('span', { class: 'badge' }, String(badge)) : null)));
  }

  /** Editable name/value table. rows: {name,value,disabled?}[]. onChange(rows, structural) */
  function kvTable(rows, onChange, opts = {}) {
    const list = rows.map((r) => ({ ...r }));
    const body = h('div', { class: 'kv' });
    const emit = (structural) => onChange(list.filter((r) => r.name !== '' || r.value !== ''), structural);
    function row(r, isNew) {
      const name = h('input', { class: 'k', placeholder: opts.namePh || 'name', value: r.name, spellcheck: 'false', list: opts.list });
      const value = h('input', { class: 'v', placeholder: 'value', value: r.value, spellcheck: 'false' });
      const on = h('input', { type: 'checkbox', checked: !r.disabled, title: 'Enabled', disabled: !!opts.noToggle || isNew });
      const del = h('button', { class: 'icon del', title: 'Remove', disabled: isNew }, '×');
      const el = h('div', { class: 'kv-row' + (r.disabled ? ' off' : '') }, on, name, value, del);
      const promote = () => {
        if (isNew && (name.value || value.value)) {
          isNew = false;
          list.push(r);
          on.removeAttribute('disabled');
          del.removeAttribute('disabled');
          body.append(row({ name: '', value: '' }, true));
        }
      };
      name.addEventListener('input', () => { r.name = name.value; promote(); emit(false); });
      value.addEventListener('input', () => { r.value = value.value; promote(); emit(false); });
      on.addEventListener('change', () => { r.disabled = !on.checked; el.classList.toggle('off', !!r.disabled); emit(false); });
      del.addEventListener('click', () => { list.splice(list.indexOf(r), 1); el.remove(); emit(true); });
      return el;
    }
    list.forEach((r) => body.append(row(r, false)));
    body.append(row({ name: '', value: '' }, true));
    return body;
  }

  function renderReqBody() {
    const pane = $('#reqBody');
    if (!pane) return;
    const active = document.activeElement;
    if (S.reqTab === 'params' && active && pane.contains(active)) return; // don't fight the user's typing
    pane.replaceChildren();
    if (S.reqTab === 'params') {
      const { base, params } = splitQuery(S.request.url);
      pane.append(
        h('p', { class: 'hint' }, 'Query parameters are kept in the URL. Unchecked rows are removed from the URL.'),
        kvTable(params, (rows) => {
          S.request.url = joinQuery(splitQuery(S.request.url).base || base, rows.filter((r) => !r.disabled));
          /** @type {HTMLInputElement} */ ($('#url')).value = S.request.url;
          changed();
        }, { namePh: 'parameter' }),
      );
    } else if (S.reqTab === 'headers') {
      pane.append(
        h('datalist', { id: 'hdrs' }, ...['Accept', 'Authorization', 'Content-Type', 'Cookie', 'User-Agent', 'Cache-Control', 'If-None-Match', 'Origin', 'X-API-Key', 'X-Request-Id'].map((x) => h('option', { value: x }))),
        kvTable(S.request.headers, (rows) => { S.request.headers = rows; changed(); }, { namePh: 'header', list: 'hdrs' }),
        h('p', { class: 'hint' }, 'Unchecked headers are saved as # comments and not sent.'),
        ...(isGraphql() && !isGqlMethod() ? [h('p', { class: 'hint' }, 'X-REQUEST-TYPE: GraphQL makes this a GraphQL request (see the Body tab); it is not sent.')] : []),
      );
    } else if (S.reqTab === 'body') {
      const type = bodyType();
      const typeSel = h('div', { class: 'radio' }, ...BODY_TYPES.map(([id, label, ct]) =>
        h('label', {}, h('input', { type: 'radio', name: 'bt', checked: id === type, onchange: () => {
          if (type === 'graphql') {
            setHeader('X-REQUEST-TYPE', null);
            if (isGqlMethod()) S.request.method = 'POST';
            const j = id === 'json' ? gqlToJson(S.request.body || '') : null;
            if (j !== null) S.request.body = j;
          }
          if (id === 'none') { S.request.body = undefined; setHeader('Content-Type', null); }
          else setHeader('Content-Type', ct);
          if (id === 'graphql' && !isGqlMethod()) {
            setHeader('X-REQUEST-TYPE', 'GraphQL');
            const g = jsonToGql(S.request.body || '');
            if (g !== null) S.request.body = g;
          }
          changed(); render();
        } }), label)));
      pane.append(typeSel);
      if (isWs(S.request)) pane.append(h('p', { class: 'hint' }, 'WebSocket messages: the first is sent on connect; put === on a line between messages, and === wait-for-server before a message to wait for a reply first. Ending with === wait-for-server closes after that reply. A message can be < ./file.bin (sent as binary).'));
      if (type === 'graphql') {
        const parts = splitGql(S.request.body || '');
        let query = parts.query;
        let vars = parts.variables;
        const err = h('span', { class: 'err' });
        const check = () => {
          err.textContent = '';
          if (!vars.trim() || vars.includes('{{')) return; // {{variables}} are substituted before the JSON is checked
          try {
            const v = JSON.parse(vars);
            if (!v || typeof v !== 'object' || Array.isArray(v)) err.textContent = 'Variables must be a JSON object.';
          } catch (e) { err.textContent = 'Not valid JSON: ' + e.message; }
        };
        const update = () => { S.request.body = joinGql(query, vars); changed(); check(); };
        const q = h('textarea', { class: 'code gql-query', spellcheck: 'false', placeholder: 'query Pet($id: ID!) {\n  pet(id: $id) { id name }\n}', value: query,
          oninput: (e) => { query = e.target.value; update(); }, onkeydown: tabKey });
        const v = h('textarea', { class: 'code gql-vars', spellcheck: 'false', placeholder: '{\n  "id": "{{petId}}"\n}', value: vars,
          oninput: (e) => { vars = e.target.value; update(); }, onkeydown: tabKey });
        pane.append(
          h('div', { class: 'gql-label' }, 'Query'), q,
          h('div', { class: 'tools gql-label' }, h('span', {}, 'Variables (JSON)'),
            h('button', { class: 'link', onclick: () => {
              try { vars = JSON.stringify(JSON.parse(vars || '{}'), null, 2); /** @type {any} */ (v).value = vars; update(); }
              catch (e) { err.textContent = 'Not valid JSON (maybe {{variables}} outside strings): ' + e.message; }
            } }, 'Format'), err),
          v,
          h('p', { class: 'hint' }, isGqlMethod()
            ? 'Sent as POST with JSON {"query", "variables"} and Content-Type: application/json. Saved in the JetBrains HTTP Client\'s format (GRAPHQL keyword): the query, a blank line, then the variables. {{variables}} work in both.'
            : 'Sent as JSON {"query", "variables"} with Content-Type: application/json; the X-REQUEST-TYPE: GraphQL header marks the request and is not sent. ' +
              'Saved in REST Client\'s format: the query, a blank line, then the variables. {{variables}} work in both.'));
        check();
      } else if (type === 'form') {
        const rows = (S.request.body || '').split(/\n?&|\n/).filter(Boolean).map((p) => { const i = p.indexOf('='); return i < 0 ? { name: p, value: '' } : { name: p.slice(0, i), value: p.slice(i + 1) }; });
        pane.append(kvTable(rows, (rs) => { S.request.body = rs.filter((r) => !r.disabled && r.name).map((r) => r.name + '=' + r.value).join('\n&'); changed(); }, { noToggle: true, namePh: 'field' }),
          h('p', { class: 'hint' }, 'Values are sent as written; URL-encode special characters yourself (e.g. %20).'));
      } else if (type !== 'none') {
        const ta = h('textarea', { class: 'code', spellcheck: 'false', placeholder: type === 'json' ? '{\n  "key": "value"\n}' : '', value: S.request.body || '',
          oninput: (e) => { S.request.body = e.target.value; changed(); }, onkeydown: tabKey });
        const tools = h('div', { class: 'tools' });
        if (type === 'json') {
          tools.append(h('button', { class: 'link', onclick: () => {
            try { S.request.body = JSON.stringify(JSON.parse(S.request.body || ''), null, 2); /** @type {any} */ (ta).value = S.request.body; changed(); $('#bodyErr').textContent = ''; }
            catch (err) { $('#bodyErr').textContent = 'Not valid JSON (maybe {{variables}} outside strings): ' + err.message; }
          } }, 'Format JSON'), h('span', { id: 'bodyErr', class: 'err' }));
        }
        tools.append(h('span', { class: 'hint' }, 'Tip: a body of "< ./file.json" sends that file.'));
        pane.append(ta, tools);
      }
    } else if (S.reqTab === 'auth') {
      const a = authInfo();
      const set = (v) => { setHeader('Authorization', v); changed(); renderReqBody(); };
      pane.append(h('div', { class: 'radio' }, ...[['none', 'None'], ['bearer', 'Bearer token'], ['oauth2', 'OAuth 2'], ['basic', 'Basic'], ...(a.type === 'other' ? [['other', 'Other']] : [])].map(([id, label]) =>
        h('label', {}, h('input', { type: 'radio', name: 'auth', checked: a.type === id, onchange: () => {
          if (id === 'none') set(null); else if (id === 'bearer') set('Bearer '); else if (id === 'oauth2') set('Bearer {{$auth.token("' + ((S.meta.authIds || [])[0] || 'my-api') + '")}}'); else if (id === 'basic') set('Basic user:password');
        } }), label))));
      if (a.type === 'bearer') {
        pane.append(h('label', { class: 'field' }, 'Token', h('input', { value: a.token, spellcheck: 'false', placeholder: '{{token}}', oninput: (e) => { setHeader('Authorization', 'Bearer ' + e.target.value); changed(); } })));
      } else if (a.type === 'oauth2') {
        const ids = S.meta.authIds || [];
        const opts = ids.includes(a.id) ? ids : [a.id, ...ids];
        const sel = h('select', { onchange: (e) => set('Bearer {{$auth.' + a.kind + '("' + e.target.value + '")}}') }, ...opts.map((x) => h('option', { value: x, selected: x === a.id }, x)));
        pane.append(h('label', { class: 'field' }, 'Configuration', sel));
        if (!ids.includes(a.id)) {
          pane.append(h('p', { class: 'hint' }, ids.length ? `"${a.id}" is not defined in the current environment.` : 'The current environment has no OAuth 2 configuration. Add one under "Security" → "Auth" in http-client.env.json (Client Credentials, Authorization Code + PKCE, Password or Device flow), then select that environment.'));
        }
        pane.append(
          h('label', {}, h('input', { type: 'checkbox', checked: a.kind === 'idToken', onchange: (e) => set('Bearer {{$auth.' + (e.target.checked ? 'idToken' : 'token') + '("' + a.id + '")}}') }), ' Send the ID token instead of the access token'),
          h('div', { class: 'row' }, h('button', { class: 'secondary', disabled: !ids.includes(a.id), onclick: () => vscode.postMessage({ type: 'acquireToken', id: a.id }) }, 'Acquire token now')),
          h('p', { class: 'hint' }, 'Saved as "Authorization: Bearer {{$auth.token(\"' + a.id + '\")}}". The token is fetched before the request, cached and refreshed when it expires.'),
        );
      } else if (a.type === 'basic') {
        const u = h('input', { value: a.user, spellcheck: 'false' });
        const p = h('input', { value: a.pass, spellcheck: 'false' });
        const upd = () => { setHeader('Authorization', 'Basic ' + /** @type {any} */ (u).value + ':' + /** @type {any} */ (p).value); changed(); };
        u.addEventListener('input', upd); p.addEventListener('input', upd);
        pane.append(h('label', { class: 'field' }, 'Username', u), h('label', { class: 'field' }, 'Password', p),
          h('p', { class: 'hint' }, 'Saved as "Authorization: Basic user:password" and Base64-encoded when sent. Use {{variables}} for secrets, e.g. {{$dotenv API_PASSWORD}}.'));
      } else if (a.type === 'other') {
        pane.append(h('p', { class: 'hint' }, 'Custom Authorization header: edit it in the Headers tab.'));
      }
    } else if (S.reqTab === 'tests') {
      renderTests(pane);
    } else if (S.reqTab === 'scripts') {
      renderScripts(pane);
    } else if (S.reqTab === 'info') {
      pane.append(
        h('label', { class: 'field' }, 'Title', h('input', { value: S.request.title || '', placeholder: 'Shown in the sidebar (### Title)', oninput: (e) => { S.request.title = e.target.value || undefined; changed(); } })),
        h('label', { class: 'field' }, 'Name', h('input', { value: S.request.name || '', spellcheck: 'false', placeholder: 'For chaining: {{name.response.body.$.id}}', oninput: (e) => { S.request.name = e.target.value.replace(/[^\w-]/g, '') || undefined; changed(); } })),
        flag('no-redirect', 'Do not follow redirects (# @no-redirect)'),
        flag('no-cookie-jar', 'Do not send or store cookies (# @no-cookie-jar)'),
      );
    }
  }

  /** A checkbox for a `# @flag` metadata line. */
  function flag(key, label) {
    return h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!(S.request.meta && key in S.request.meta), onchange: (e) => {
      S.request.meta = { ...(S.request.meta || {}) };
      if (e.target.checked) S.request.meta[key] = ''; else delete S.request.meta[key];
      changed(); } }), label);
  }

  // Scripts, JetBrains HTTP Client format: `< {% %}` above the request line (rawBefore), `> {% %}` after the body (rawAfter).
  const SIDES = { pre: { key: 'rawBefore', mark: '<' }, response: { key: 'rawAfter', mark: '>' } };
  /** The first inline `{% %}` block of a side in `lines`: its line range and code; plus script-file lines (`> ./x.js`). */
  function findScript(lines, mark) {
    const files = [];
    let found = null;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const lead = l.trimStart();
      if (lead[0] !== mark || !/\s/.test(lead[1] || '')) continue;
      const rest = lead.slice(1).trim();
      if (rest.startsWith('{%')) {
        let j = i;
        let code;
        if (/%\}\s*$/.test(rest) && rest.length > 3) code = rest.slice(2, rest.lastIndexOf('%}')).trim();
        else {
          const body = rest.slice(2).trim() ? [rest.slice(2)] : [];
          for (j = i + 1; j < lines.length && !/%\}\s*$/.test(lines[j]); j++) body.push(lines[j]);
          if (j < lines.length) { const tail = lines[j].replace(/%\}\s*$/, ''); if (tail.trim()) body.push(tail); }
          code = body.join('\n');
        }
        if (!found) found = { start: i, end: j + 1, code };
        i = j;
      } else if (/^\S+$/.test(rest)) files.push(rest);
    }
    return { block: found, files };
  }
  function scriptCount() {
    let n = 0;
    for (const side of Object.values(SIDES)) { const f = findScript(S.request[side.key] || [], side.mark); n += (f.block && f.block.code.trim() ? 1 : 0) + f.files.length; }
    return n;
  }
  function setScript(side, code) {
    const { key, mark } = SIDES[side];
    const lines = (S.request[key] || []).slice();
    const { block } = findScript(lines, mark);
    const repl = code.trim() ? [mark + ' {%', ...code.replace(/\r\n/g, '\n').split('\n'), '%}'] : [];
    if (block) lines.splice(block.start, block.end - block.start, ...repl);
    else lines.push(...repl);
    S.request[key] = lines.length ? lines : undefined;
    changed();
  }
  const SCRIPT_PH = {
    pre: "// Runs before the request is sent. Examples:\nrequest.variables.set('ts', Date.now().toString());\nrequest.variables.set('sig', crypto.hmac.sha256()\n  .withTextSecret(request.environment.get('secret'))\n  .updateWithText(request.body.tryGetSubstituted()).digest().toHex());",
    response: "// Runs on the response. Examples:\nclient.test('status is 200', () => {\n  client.assert(response.status === 200, 'got ' + response.status);\n});\nclient.global.set('token', response.body.token); // use as {{token}}",
  };
  function renderScripts(pane) {
    for (const [side, title] of [['pre', 'Pre-request script'], ['response', 'Response handler']]) {
      const { block, files } = findScript(S.request[SIDES[side].key] || [], SIDES[side].mark);
      pane.append(h('div', { class: 'gql-label' }, title, files.length ? h('span', { class: 'hint' }, '  · also runs ' + files.join(', ')) : null),
        h('textarea', { class: 'code script', spellcheck: 'false', placeholder: SCRIPT_PH[side], value: block ? block.code : '',
          oninput: (e) => setScript(side, e.target.value), onkeydown: tabKey }));
    }
    pane.append(h('p', { class: 'hint' }, 'JavaScript in the JetBrains HTTP Client format, saved in the .http file as "< {% … %}" above the request and "> {% … %}" after it. ',
      'Available: client.test / assert / log / global.set / global.get, response.status / body / headers.valueOf(name), request.variables.set, request.environment.get, crypto, $random, jsonPath. ',
      'client.global values work as {{name}} in later requests (Plainwire: Show / Clear Script Variables). Scripts run with a 5 second limit, only in trusted workspaces; turn them off with the plainwire.runScripts setting.'));
  }

  const ASSERT_EXAMPLES = ['status == 200', 'time < 1000', 'header content-type contains json', '$.id exists', '$.items.length > 0', 'body contains "ok"'];
  function renderTests(pane) {
    const list = (S.request.asserts || []).slice();
    const commit = (structural) => {
      const clean = list.map((x) => x.trim()).filter(Boolean);
      S.request.asserts = clean.length ? clean : undefined;
      changed();
      if (structural) renderReqBody();
    };
    const rows = h('div', { class: 'asserts' }, ...list.map((a, i) => {
      const last = S.lastAssertions && S.lastAssertions.find((r) => r.source === a);
      return h('div', { class: 'assert-row' },
        h('span', { class: 'mark ' + (last ? (last.passed ? 'pass' : 'fail') : ''), title: last ? (last.passed ? 'Passed on the last send' : last.message) : 'Not run yet' }, last ? (last.passed ? '✓' : '✗') : '•'),
        h('input', { class: 'code', value: a, spellcheck: 'false', placeholder: 'status == 200', oninput: (e) => { list[i] = e.target.value; commit(false); } }),
        h('button', { class: 'icon', title: 'Remove', onclick: () => { list.splice(i, 1); commit(true); } }, '✕'));
    }));
    const add = h('input', { class: 'code', spellcheck: 'false', placeholder: 'Add a check, e.g. status == 200  (Enter)', onkeydown: (e) => {
      if (e.key === 'Enter' && e.target.value.trim()) { list.push(e.target.value.trim()); commit(true); setTimeout(() => /** @type {HTMLInputElement} */ ($('#reqBody .assert-new input'))?.focus()); }
    } });
    pane.append(
      rows,
      h('div', { class: 'assert-row assert-new' }, h('span', { class: 'mark' }, '+'), add),
      h('div', { class: 'chips' }, h('span', { class: 'hint' }, 'Quick add: '), ...ASSERT_EXAMPLES.filter((x) => !list.includes(x)).map((x) =>
        h('button', { class: 'chip', onclick: () => { list.push(x); commit(true); } }, x))),
      h('p', { class: 'hint' }, 'Checks run after every send and in "Run all". Saved in the .http file as "# @assert …" lines (httpYac "?? …" lines are kept as written, after the request). ',
        'Subjects: status, time, size, body, header <name>, or a JSONPath like $.data[0].id. ',
        'Operators: == != < <= > >= contains !contains startsWith endsWith matches exists !exists isEmpty isNumber isString isArray isObject isNull isTrue isFalse md5 sha256 sha512. ',
        'Values can use {{variables}}.'),
    );
  }

  function tabKey(e) {
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      const t = e.target;
      const s = t.selectionStart;
      t.value = t.value.slice(0, s) + '  ' + t.value.slice(t.selectionEnd);
      t.selectionStart = t.selectionEnd = s + 2;
      t.dispatchEvent(new Event('input'));
    }
  }

  function onUrlPaste(e) {
    const text = e.clipboardData?.getData('text') || '';
    if (/^\s*curl\s/i.test(text)) {
      e.preventDefault();
      vscode.postMessage({ type: 'importCurl', text });
    }
  }

  function fmtSize(n) {
    return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB';
  }

  /** Message box for an open WebSocket. Built once and re-attached, so a draft and focus survive live updates. */
  let wsBox = null;
  function wsComposer() {
    if (wsBox) return wsBox;
    const ta = h('textarea', { class: 'ws-msg', rows: 2, spellcheck: false, placeholder: 'Message to send, e.g. {"type": "ping"}   (Enter sends, Shift+Enter adds a line)' });
    const send = () => {
      if (!ta.value) return;
      vscode.postMessage({ type: 'wsSend', text: ta.value });
      ta.value = '';
    };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); e.stopPropagation(); send(); }
    });
    wsBox = h('div', { class: 'ws-compose' }, ta, h('button', { class: 'primary', onclick: send }, 'Send message'));
    return wsBox;
  }

  function renderResponse() {
    const res = $('#res');
    if (!res) return;
    const typing = wsBox && wsBox.contains(document.activeElement);
    res.replaceChildren();
    if (S.sending && ((S.stream && S.stream.length) || S.wsOpen)) {
      const ws = isWs(S.request);
      res.append(h('div', { class: 'status' }, h('div', { class: 'spinner' }), h('span', {}, ws ? 'Connected · ' + streamCount(S.stream || [], true) : 'Receiving events: ' + S.stream.length),
        h('span', { class: 'hint' }, ws ? 'Type a message below to send it now. Stop closes the connection and keeps the messages; end the script with === wait-for-server, or add # @max-events N, to close by itself.' : 'Stop keeps what arrived. Add # @max-events N to stop by itself.')));
      const pane = h('div', { class: 'pane resp' });
      pane.append(eventsTable((S.stream || []).slice(-MAX_LIVE_EVENTS)));
      res.append(pane);
      if (ws && S.wsOpen) {
        res.append(wsComposer());
        if (typing) wsBox.querySelector('textarea').focus();
      }
      pane.scrollTop = pane.scrollHeight;
      return;
    }
    if (S.sending) {
      res.append(h('div', { class: 'empty' }, h('div', { class: 'spinner' }), 'Sending…'));
      return;
    }
    if (S.error) {
      const fixes = (S.useEnvs || []).map((name, i) => h('button', { class: i ? '' : 'primary', onclick: () => { S.useEnvs = null; vscode.postMessage({ type: 'useEnv', name, request: S.request }); } }, 'Use ' + name + ' and send'));
      res.append(h('div', { class: 'error-box' }, h('b', {}, 'Could not send the request'), h('pre', {}, S.error),
        fixes.length ? h('div', { class: 'error-actions' }, ...fixes, h('button', { class: 'link', onclick: () => vscode.postMessage({ type: 'editEnvs' }) }, 'Edit environments…')) : null));
      return;
    }
    const r = S.response;
    if (!r) {
      res.append(h('div', { class: 'empty' }, 'Press ', h('kbd', {}, 'Ctrl/Cmd+Enter'), ' or Send to see the response here.'));
      return;
    }
    const ct = (r.headers.find(([k]) => k.toLowerCase() === 'content-type') || [, ''])[1];
    const tests = S.assertions || [];
    const logs = S.logs || [];
    const setCookies = r.headers.filter(([k]) => k.toLowerCase() === 'set-cookie').map(([, v]) => parseSetCookie(v));
    if (S.resTab === 'cookies' && !setCookies.length && !r.sentCookie) S.resTab = 'body';
    const failed = tests.filter((t) => !t.passed).length;
    const cls = r.status >= 500 ? 's5' : r.status >= 400 ? 's4' : r.status >= 300 ? 's3' : 's2';
    res.append(
      h('div', { class: 'status' },
        h('span', { class: 'code ' + cls }, r.status + ' ' + (r.statusText || '')),
        h('span', {}, r.timeMs + ' ms'), h('span', {}, fmtSize(r.size)),
        r.events ? h('span', { title: r.status === 101 ? 'WebSocket messages' + (r.closeReason ? ' · close: ' + r.closeReason : '') : 'Server-sent events' }, streamCount(r.events, r.status === 101) + ' · ' + STREAM_END[r.streamEnd || 'closed']) : null,
        tests.length ? h('button', { class: 'link tests ' + (failed ? 'fail' : 'pass'), title: 'Show test results', onclick: () => { S.resTab = 'tests'; persist(); renderResponse(); } },
          failed ? '✗ ' + failed + ' of ' + tests.length + (tests.length === 1 ? ' check failed' : ' checks failed') : '✓ ' + tests.length + (tests.length === 1 ? ' check passed' : ' checks passed')) : null,
        h('span', { class: 'spacer' }),
        h('button', { class: 'link', onclick: () => vscode.postMessage({ type: 'openBody', body: r.bodyEncoding === 'utf8' ? prettyText(r.body, ct) : r.body, contentType: ct }) }, 'Open in editor'),
        h('button', { class: 'link', onclick: () => navigator.clipboard.writeText(r.body) }, 'Copy')),
      h('div', { class: 'tabs' }, ...[['body', 'Body'], ['headers', 'Headers (' + r.headers.length + ')'], ...(setCookies.length || r.sentCookie ? [['cookies', 'Cookies (' + setCookies.length + ')']] : []), ...(tests.length ? [['tests', 'Tests (' + (tests.length - failed) + '/' + tests.length + ')']] : logs.length ? [['tests', 'Log']] : []), ['request', 'Sent request']].map(([id, label]) =>
        h('button', { class: 'tab' + (S.resTab === id ? ' active' : ''), onclick: () => { S.resTab = id; persist(); renderResponse(); } }, label))),
    );
    const pane = h('div', { class: 'pane resp' });
    res.append(pane);
    if (S.resTab === 'tests' && (tests.length || logs.length)) {
      if (tests.length) pane.append(h('table', { class: 'tests' }, ...tests.map((t) => h('tr', { class: t.passed ? 'pass' : 'fail' },
        h('td', { class: 'mark' }, t.passed ? '✓' : '✗'), h('td', { class: 'code' }, t.source),
        h('td', {}, t.passed ? (t.actual !== undefined ? 'actual: ' + t.actual : 'passed') : t.message)))));
      if (logs.length) pane.append(h('div', { class: 'gql-label' }, 'Script log'), h('pre', { class: 'code' }, logs.join('\n')));
    } else if (S.resTab === 'cookies') {
      if (setCookies.length) {
        pane.append(h('table', { class: 'hdrs cookies' },
          h('tr', {}, ...['Name', 'Value', 'Domain', 'Path', 'Expires', ''].map((x) => h('th', {}, x))),
          ...setCookies.map((c) => h('tr', { class: c.deleted ? 'deleted' : '' },
            h('td', {}, c.name), h('td', { class: 'code' }, c.value), h('td', {}, c.attrs.domain || '(this host)'), h('td', {}, c.attrs.path || '(default)'),
            h('td', {}, c.deleted ? 'deleted' : c.attrs['max-age'] ? 'in ' + fmtSeconds(Number(c.attrs['max-age'])) : c.attrs.expires || 'session'),
            h('td', {}, [c.attrs.secure !== undefined ? 'Secure' : '', c.attrs.httponly !== undefined ? 'HttpOnly' : '', c.attrs.samesite ? 'SameSite=' + c.attrs.samesite : ''].filter(Boolean).join(' '))))));
      } else pane.append(h('p', { class: 'hint' }, 'This response set no cookies.'));
      if (r.sentCookie) pane.append(h('p', { class: 'hint' }, 'Sent with this request (from the cookie jar and the Cookie header):'), h('pre', { class: 'code' }, r.sentCookie));
      pane.append(h('p', { class: 'hint' }, 'Cookies are remembered per workspace and sent with later requests to the same site. Plainwire: Manage Cookies… lists or deletes them; # @no-cookie-jar above a request skips the jar.'));
    } else if (S.resTab === 'headers') {
      pane.append(h('table', { class: 'hdrs' }, ...r.headers.map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', {}, v)))));
    } else if (S.resTab === 'request') {
      const q = S.resolved;
      if (q) pane.append(h('pre', { class: 'code' }, q.method + ' ' + q.url + '\n' + q.headers.map((x) => x.name + ': ' + x.value).join('\n') + (q.body ? '\n\n' + q.body : '')));
    } else if (r.events) {
      pane.append(h('div', { class: 'tools' }, h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: S.raw, onchange: (e) => { S.raw = e.target.checked; persist(); renderResponse(); } }), r.status === 101 ? 'Transcript' : 'Raw stream')));
      if (S.raw) pane.append(h('pre', { class: 'code' }, r.body || h('span', { class: 'hint' }, '(empty stream)')));
      else if (!r.events.length) pane.append(h('p', { class: 'hint' }, r.status === 101 ? 'No messages.' + (r.closeReason ? ' Closed: ' + r.closeReason : '') : 'No events received.'));
      else pane.append(eventsTable(r.events));
    } else {
      if (r.bodyEncoding === 'base64') {
        if (/^image\//.test(ct)) pane.append(h('img', { class: 'preview', src: 'data:' + ct + ';base64,' + r.body }));
        else pane.append(h('p', { class: 'hint' }, 'Binary response (' + (ct || 'unknown type') + ', ' + fmtSize(r.size) + '). Use "Open in editor" to see the Base64.'));
        return;
      }
      let json;
      if (/json/i.test(ct) || /^\s*[[{]/.test(r.body)) { try { json = JSON.parse(r.body); } catch {} }
      const out = h('div', { class: 'filtered' });
      const draw = () => drawBody(out, r, json);
      pane.append(h('div', { class: 'tools' },
        json !== undefined ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: S.raw, onchange: (e) => { S.raw = e.target.checked; persist(); draw(); } }), 'Raw') : null,
        r.body ? h('input', { class: 'filter', type: 'search', spellcheck: 'false', value: S.filter || '',
          placeholder: json !== undefined ? 'Filter: $.items[*].id, $..name, $.users[?(@.active)] or text' : 'Filter lines containing…',
          title: 'JSONPath ($ …) shows the matching values; any other text shows the lines that contain it',
          oninput: (e) => { S.filter = e.target.value; persist(); draw(); } }) : null,
        h('span', { class: 'filter-info', id: 'filterInfo' })),
        out);
      draw();
    }
  }

  /** The response body view: JSON tree / raw text, narrowed by the filter box (JSONPath or text). */
  function drawBody(out, r, json) {
    const info = $('#filterInfo');
    const q = (S.filter || '').trim();
    out.replaceChildren();
    if (info) info.replaceChildren();
    if (q && json !== undefined && q.startsWith('$')) {
      let hits;
      try { hits = jsonQuery(json, q); } catch (e) { if (info) info.append(h('span', { class: 'err' }, String(e.message || e))); return; }
      if (info) {
        info.append(hits.length === 1 ? '1 match' : hits.length + ' matches');
        // A single plain path can become a check: # @assert $.path == value (the same JSONPath the tests use).
        if (hits.length === 1 && !(S.request.asserts || []).some((a) => a.startsWith(q + ' ')) && /^\$(\.[A-Za-z_$][\w$-]*|\[-?\d+\]|\[['"][^'"]*['"]\])+$/.test(q)) {
          const v = hits[0];
          const expected = v === null || typeof v !== 'object' ? JSON.stringify(v) : null;
          const line = expected !== null ? q + ' == ' + expected : q + ' exists';
          info.append(' ', h('button', { class: 'link', title: 'Add "# @assert ' + line + '" to this request\'s tests', onclick: () => {
            S.request.asserts = [...(S.request.asserts || []), line]; changed(); render(); } }, '+ Add as test'));
        }
      }
      if (!hits.length) { out.append(h('p', { class: 'hint' }, 'No values match ' + q + '.')); return; }
      const shown = hits.length === 1 ? hits[0] : hits;
      if (S.raw || JSON.stringify(shown).length > MAX_TREE) out.append(h('pre', { class: 'code' }, JSON.stringify(shown, null, 2)));
      else out.append(h('div', { class: 'json code' }, jsonNode(shown, 0)));
      return;
    }
    const text = json !== undefined && !S.raw ? JSON.stringify(json, null, 2) : r.body;
    if (q) {
      const needle = q.toLowerCase();
      const lines = text.split(/\r?\n/);
      const rows = [];
      let count = 0;
      for (let i = 0; i < lines.length; i++) {
        const low = lines[i].toLowerCase();
        if (!low.includes(needle)) continue;
        const parts = [];
        let at = 0, j;
        while ((j = low.indexOf(needle, at)) >= 0) { parts.push(lines[i].slice(at, j), h('mark', {}, lines[i].slice(j, j + q.length))); at = j + q.length; count++; }
        parts.push(lines[i].slice(at));
        if (rows.length < 2000) rows.push(h('div', { class: 'grep-row' }, h('span', { class: 'ln' }, String(i + 1)), h('span', {}, ...parts)));
      }
      if (info) info.append(count + (count === 1 ? ' match' : ' matches') + ' in ' + rows.length + (rows.length === 1 ? ' line' : ' lines'));
      out.append(rows.length ? h('div', { class: 'grep code' }, ...rows) : h('p', { class: 'hint' }, 'No lines contain "' + q + '".'));
      return;
    }
    if (json !== undefined && !S.raw && r.body.length <= MAX_TREE) out.append(h('div', { class: 'json code' }, jsonNode(json, 0)));
    else out.append(h('pre', { class: 'code' }, text || h('span', { class: 'hint' }, '(empty body)')));
  }

  /**
   * JSONPath for the filter box: $, .key, ['key'], [n], [-n], [a:b], [*], .*, ..key (any depth), ..*,
   * [?(@.k)], [?(@.k == v)] with == != < <= > >= (v: number, 'string', "string", true, false, null), [a,b].
   * Returns every matching value.
   */
  function jsonQuery(root, path) {
    let p = path.trim().replace(/^\$/, '');
    let cur = [root];
    const kids = (v) => (v && typeof v === 'object' ? (Array.isArray(v) ? v : Object.values(v)) : []);
    const descend = (v, out) => { out.push(v); for (const k of kids(v)) descend(k, out); return out; };
    const pick = (v, key) => {
      if (v === null || typeof v !== 'object') return [];
      if (Array.isArray(v) && /^-?\d+$/.test(key)) { const n = Number(key); const x = v[n < 0 ? v.length + n : n]; return x === undefined ? [] : [x]; }
      return Object.prototype.hasOwnProperty.call(v, key) ? [v[key]] : key === 'length' && Array.isArray(v) ? [v.length] : [];
    };
    const lit = (t) => {
      t = t.trim();
      if (/^(['"]).*\1$/.test(t)) return t.slice(1, -1);
      if (t === 'true' || t === 'false' || t === 'null' || /^-?\d+(\.\d+)?$/.test(t)) return JSON.parse(t);
      throw new Error('Cannot read the value ' + t);
    };
    const field = (v, f) => f.split('.').filter(Boolean).reduce((acc, k) => (acc === null || typeof acc !== 'object' ? undefined : acc[k]), v);
    const filter = (list, expr) => {
      const m = /^@((?:\.[\w$-]+)*)\s*(?:(==|!=|<=|>=|<|>|=~)\s*(.+))?$/.exec(expr.trim());
      if (!m) throw new Error('Filters look like [?(@.price < 10)] or [?(@.active)]');
      const want = m[2] ? (m[2] === '=~' ? new RegExp(m[3].trim().replace(/^\/(.*)\/(\w*)$/, '$1'), 'i') : lit(m[3])) : undefined;
      return list.filter((x) => {
        const a = field(x, m[1]);
        switch (m[2]) {
          case undefined: return a !== undefined && a !== null && a !== false;
          case '==': return a === want; case '!=': return a !== want;
          case '<': return a < want; case '<=': return a <= want; case '>': return a > want; case '>=': return a >= want;
          default: return typeof a === 'string' && want.test(a);
        }
      });
    };
    while (p) {
      let m;
      if ((m = /^\.\.(\*|[\w$-]+)?/.exec(p)) && (m[1] || p[2] === '[')) {
        const all = cur.flatMap((v) => descend(v, []));
        cur = m[1] === '*' ? all.flatMap(kids) : m[1] ? all.flatMap((v) => pick(v, m[1])) : all;
      } else if ((m = /^\.(\*|[\w$-]+)/.exec(p))) {
        cur = m[1] === '*' ? cur.flatMap(kids) : cur.flatMap((v) => pick(v, m[1]));
      } else if ((m = /^\[\s*\?\((.*?)\)\s*\]/.exec(p))) {
        const expr = m[1];
        cur = cur.flatMap((v) => filter(kids(v), expr));
      } else if ((m = /^\[([^\]]*)\]/.exec(p))) {
        const inner = m[1].trim();
        if (inner === '*') cur = cur.flatMap(kids);
        else if (/^-?\d*\s*:\s*-?\d*$/.test(inner)) {
          const [a, b] = inner.split(':').map((x) => x.trim());
          cur = cur.flatMap((v) => (Array.isArray(v) ? v.slice(a === '' ? 0 : Number(a), b === '' ? undefined : Number(b)) : []));
        } else {
          const keys = inner.split(',').map((k) => k.trim().replace(/^(['"])(.*)\1$/, '$2'));
          cur = cur.flatMap((v) => keys.flatMap((k) => pick(v, k)));
        }
      } else throw new Error('Cannot read "' + p.slice(0, 20) + '" in the path');
      p = p.slice(m[0].length);
    }
    return cur;
  }

  /** Server-sent events as a table: time, event type, id and data (JSON shown compact, text as is). */
  function fmtSeconds(n) {
    return n < 120 ? n + ' s' : n < 7200 ? Math.round(n / 60) + ' min' : n < 172800 ? Math.round(n / 3600) + ' h' : Math.round(n / 86400) + ' days';
  }

  /** A Set-Cookie header for display: name, value, lower-case attributes, deleted when Max-Age <= 0 or Expires is past. */
  function parseSetCookie(v) {
    const parts = v.split(';');
    const first = parts.shift() || '';
    const i = first.indexOf('=');
    const attrs = {};
    for (const p of parts) {
      const j = p.indexOf('=');
      attrs[(j < 0 ? p : p.slice(0, j)).trim().toLowerCase()] = j < 0 ? '' : p.slice(j + 1).trim();
    }
    const exp = attrs.expires ? Date.parse(attrs.expires) : NaN;
    const deleted = attrs['max-age'] !== undefined ? Number(attrs['max-age']) <= 0 : !isNaN(exp) && exp < Date.now();
    return { name: (i < 0 ? first : first.slice(0, i)).trim(), value: i < 0 ? '' : first.slice(i + 1).trim(), attrs, deleted };
  }

  /** `3 events`, or for a WebSocket `1 sent, 2 received`. */
  function streamCount(events, ws) {
    if (!ws) return events.length + ' event' + (events.length === 1 ? '' : 's');
    const sent = events.filter((e) => e.event === 'sent').length;
    return sent + ' sent, ' + (events.length - sent) + ' received';
  }

  function eventsTable(events) {
    if (events.some((e) => e.event === 'sent' || e.event === 'binary') || isWs(S.request)) {
      // WebSocket: direction instead of SSE id; binary data stays base64.
      return h('table', { class: 'events' },
        h('tr', {}, h('th', {}, '#'), h('th', {}, 'ms'), h('th', {}, ''), h('th', {}, 'message')),
        ...events.map((e, i) => {
          let data = e.data;
          if (e.event !== 'binary' && /^\s*[[{]/.test(data)) { try { data = JSON.stringify(JSON.parse(data)); } catch {} }
          const sent = e.event === 'sent';
          return h('tr', { class: sent ? 'ws-sent' : 'ws-recv' }, h('td', { class: 'num' }, String(i + 1)), h('td', { class: 'num' }, String(e.timeMs)),
            h('td', { class: 'dir', title: sent ? 'sent' : e.event === 'binary' ? 'received (binary, base64)' : 'received' }, sent ? '↑' : '↓'), h('td', { class: 'code' }, data));
        }));
    }
    return h('table', { class: 'events' },
      h('tr', {}, h('th', {}, '#'), h('th', {}, 'ms'), h('th', {}, 'event'), h('th', {}, 'id'), h('th', {}, 'data')),
      ...events.map((e, i) => {
        let data = e.data;
        if (/^\s*[[{]/.test(data)) { try { data = JSON.stringify(JSON.parse(data)); } catch {} }
        return h('tr', {}, h('td', { class: 'num' }, String(i + 1)), h('td', { class: 'num' }, String(e.timeMs)), h('td', {}, e.event), h('td', {}, e.id || ''), h('td', { class: 'code' }, data));
      }));
  }

  function prettyText(body, ct) {
    if (/json/i.test(ct)) { try { return JSON.stringify(JSON.parse(body), null, 2); } catch {} }
    return body;
  }

  function jsonNode(v, depth) {
    if (v === null) return h('span', { class: 'j-null' }, 'null');
    if (typeof v === 'string') return h('span', { class: 'j-str' }, JSON.stringify(v));
    if (typeof v === 'number') return h('span', { class: 'j-num' }, String(v));
    if (typeof v === 'boolean') return h('span', { class: 'j-bool' }, String(v));
    const isArr = Array.isArray(v);
    const entries = isArr ? v.map((x, i) => [i, x]) : Object.entries(v);
    const [open, close] = isArr ? ['[', ']'] : ['{', '}'];
    if (!entries.length) return h('span', {}, open + close);
    const kids = h('div', { class: 'j-kids' }, ...entries.map(([k, x], i) => h('div', { class: 'j-row' },
      isArr ? null : h('span', { class: 'j-key' }, JSON.stringify(k)), isArr ? null : ': ',
      jsonNode(x, depth + 1), i < entries.length - 1 ? ',' : '')));
    const summary = h('span', { class: 'j-sum', hidden: true }, (isArr ? entries.length + ' items' : entries.length + ' keys') + ' ' + close);
    const toggle = h('button', { class: 'j-tog', title: 'Collapse / expand' }, '▾');
    const collapse = (c) => { kids.hidden = c; summary.hidden = !c; closeEl.hidden = c; toggle.textContent = c ? '▸' : '▾'; };
    const closeEl = h('span', {}, close);
    toggle.addEventListener('click', () => collapse(!kids.hidden));
    const el = h('span', { class: 'j-node' }, toggle, open, summary, kids, closeEl);
    if (depth >= 6) collapse(true);
    return el;
  }

  // ---------- actions ----------
  function send() {
    if (!S.request.url.trim()) { /** @type {HTMLInputElement} */ ($('#url')).focus(); return; }
    vscode.postMessage({ type: 'send', request: S.request });
  }
  function save() {
    vscode.postMessage({ type: S.meta.canSave ? 'save' : 'saveAs', request: S.request });
  }

  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === 'Enter') { e.preventDefault(); send(); }
    if (mod && (e.key === 's' || e.key === 'S')) { e.preventDefault(); save(); }
  });
  document.addEventListener('click', () => $('.menu-items')?.classList.remove('open'));

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.type === 'load') {
      S.request = m.request;
      S.request.headers = S.request.headers || [];
      S.meta = { sourceLabel: m.sourceLabel, canSave: m.canSave, env: m.env, envNames: m.envNames, authIds: m.authIds || [], layout: m.layout || S.meta.layout };
      if (m.response) {
        // Opened from history, or from a run report row with that run's checks and script log.
        S.response = m.response; S.error = null; S.useEnvs = null;
        S.assertions = m.assertions || []; S.lastAssertions = S.assertions; S.logs = m.logs || [];
        if (S.assertions.some((a) => !a.passed)) S.resTab = 'tests';
      } else if (m.error) {
        S.response = null; S.error = m.error; S.useEnvs = null; S.assertions = []; S.logs = [];
      }
      S.dirty = false;
      S.sending = false;
      persist();
      render();
      if (!S.request.url) /** @type {HTMLInputElement} */ ($('#url'))?.focus();
    } else if (m.type === 'env' || m.type === 'saved') {
      S.meta = { sourceLabel: m.sourceLabel, canSave: m.canSave, env: m.env, envNames: m.envNames, authIds: m.authIds || [], layout: m.layout || S.meta.layout };
      if (m.type === 'saved') S.dirty = false;
      persist();
      render();
    } else if (m.type === 'sending') {
      S.sending = true; S.wsOpen = false; S.error = null; S.useEnvs = null; S.stream = []; render();
    } else if (m.type === 'wsOpen') {
      S.wsOpen = true; renderResponse();
    } else if (m.type === 'wsClosed') {
      S.wsOpen = false; renderResponse();
    } else if (m.type === 'events') {
      const first = !S.stream || !S.stream.length;
      S.stream = (S.stream || []).concat(m.events);
      if (first) render(); else renderResponse();
    } else if (m.type === 'response') {
      S.sending = false; S.wsOpen = false; S.stream = []; S.response = m.response; S.resolved = m.resolved; S.error = null;
      S.assertions = m.assertions || []; S.lastAssertions = S.assertions; S.logs = m.logs || [];
      if (S.resTab === 'tests' && !S.assertions.length && !S.logs.length) S.resTab = 'body';
      persist(); render();
    } else if (m.type === 'error') {
      S.sending = false; S.wsOpen = false; S.stream = []; S.error = m.message; S.useEnvs = m.useEnvs || null; persist(); render();
    } else if (m.type === 'layout') {
      S.meta.layout = m.layout; persist(); applyLayout();
    } else if (m.type === 'setRequest') {
      S.request = m.request; changed(); render();
    }
  });

  render();
  vscode.postMessage({ type: 'ready' });
})();
