// @ts-check
/* Plainwire request editor webview. Plain DOM, no framework. */
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
  const BODY_TYPES = [
    ['none', 'None', ''],
    ['json', 'JSON', 'application/json'],
    ['text', 'Text', 'text/plain'],
    ['xml', 'XML', 'application/xml'],
    ['form', 'Form URL-encoded', 'application/x-www-form-urlencoded'],
  ];
  const MAX_TREE = 2 * 1024 * 1024;

  /** @type {any} */
  let S = vscode.getState() || {
    request: { method: 'GET', url: '', headers: [] },
    response: null,
    resolved: null,
    error: null,
    sending: false,
    meta: { sourceLabel: '', canSave: false, env: null, envNames: [] },
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
  function bodyType() {
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
          ? h('button', { class: 'primary', onclick: () => vscode.postMessage({ type: 'cancel' }) }, 'Cancel')
          : h('button', { class: 'primary', id: 'send', title: 'Send (Ctrl/Cmd+Enter)', onclick: send }, 'Send'),
        h('button', { title: S.meta.canSave ? 'Save to ' + S.meta.sourceLabel + ' (Ctrl/Cmd+S)' : 'Save to a .http file (Ctrl/Cmd+S)', onclick: save }, 'Save'),
        h('div', { class: 'menu' },
          h('button', { class: 'icon', title: 'More', onclick: (e) => { e.stopPropagation(); $('.menu-items').classList.toggle('open'); } }, '⋯'),
          h('div', { class: 'menu-items' },
            h('button', { onclick: () => vscode.postMessage({ type: 'saveAs', request: S.request }) }, 'Save as… (add to another .http file)'),
            h('button', { onclick: () => vscode.postMessage({ type: 'copyCurl', request: S.request }) }, 'Copy as cURL'),
            S.meta.canSave ? h('button', { onclick: () => vscode.postMessage({ type: 'openText' }) }, 'Show in .http file') : null))),
      h('div', { class: 'sub' },
        h('span', { class: 'source', title: 'Where this request is stored' }, S.meta.sourceLabel, h('span', { id: 'dirty', class: 'dirty', hidden: !(S.dirty && S.meta.canSave) }, ' ● unsaved')),
        h('button', { class: 'link env', title: 'Environment used for {{variables}}', onclick: () => vscode.postMessage({ type: 'selectEnv' }) },
          'Env: ', h('b', {}, S.meta.env || 'none'))),
      h('div', { class: 'split' },
        h('section', { class: 'req' },
          tabs(['params', 'Params', countParams()], ['headers', 'Headers', S.request.headers.filter((x) => !x.disabled).length], ['body', 'Body', bodyType() === 'none' ? '' : '●'], ['auth', 'Auth', authInfo().type === 'none' ? '' : '●'], ['tests', 'Tests', (S.request.asserts || []).length || ''], ['info', 'Info', '']),
          h('div', { id: 'reqBody', class: 'pane' })),
        h('section', { class: 'res', id: 'res' })),
    );
    renderReqBody();
    renderResponse();
  }

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
      );
    } else if (S.reqTab === 'body') {
      const type = bodyType();
      const typeSel = h('div', { class: 'radio' }, ...BODY_TYPES.map(([id, label, ct]) =>
        h('label', {}, h('input', { type: 'radio', name: 'bt', checked: id === type, onchange: () => {
          if (id === 'none') { S.request.body = undefined; setHeader('Content-Type', null); }
          else setHeader('Content-Type', ct);
          changed(); render();
        } }), label)));
      pane.append(typeSel);
      if (type === 'form') {
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
      pane.append(h('div', { class: 'radio' }, ...[['none', 'None'], ['bearer', 'Bearer token'], ['basic', 'Basic'], ...(a.type === 'other' ? [['other', 'Other']] : [])].map(([id, label]) =>
        h('label', {}, h('input', { type: 'radio', name: 'auth', checked: a.type === id, onchange: () => {
          if (id === 'none') set(null); else if (id === 'bearer') set('Bearer '); else if (id === 'basic') set('Basic user:password');
        } }), label))));
      if (a.type === 'bearer') {
        pane.append(h('label', { class: 'field' }, 'Token', h('input', { value: a.token, spellcheck: 'false', placeholder: '{{token}}', oninput: (e) => { setHeader('Authorization', 'Bearer ' + e.target.value); changed(); } })));
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
    } else if (S.reqTab === 'info') {
      pane.append(
        h('label', { class: 'field' }, 'Title', h('input', { value: S.request.title || '', placeholder: 'Shown in the sidebar (### Title)', oninput: (e) => { S.request.title = e.target.value || undefined; changed(); } })),
        h('label', { class: 'field' }, 'Name', h('input', { value: S.request.name || '', spellcheck: 'false', placeholder: 'For chaining: {{name.response.body.$.id}}', oninput: (e) => { S.request.name = e.target.value.replace(/[^\w-]/g, '') || undefined; changed(); } })),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!(S.request.meta && 'no-redirect' in S.request.meta), onchange: (e) => {
          S.request.meta = { ...(S.request.meta || {}) };
          if (e.target.checked) S.request.meta['no-redirect'] = ''; else delete S.request.meta['no-redirect'];
          changed(); } }), 'Do not follow redirects (# @no-redirect)'),
      );
    }
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

  function renderResponse() {
    const res = $('#res');
    if (!res) return;
    res.replaceChildren();
    if (S.sending) {
      res.append(h('div', { class: 'empty' }, h('div', { class: 'spinner' }), 'Sending…'));
      return;
    }
    if (S.error) {
      res.append(h('div', { class: 'error-box' }, h('b', {}, 'Could not send the request'), h('pre', {}, S.error)));
      return;
    }
    const r = S.response;
    if (!r) {
      res.append(h('div', { class: 'empty' }, 'Press ', h('kbd', {}, 'Ctrl/Cmd+Enter'), ' or Send to see the response here.'));
      return;
    }
    const ct = (r.headers.find(([k]) => k.toLowerCase() === 'content-type') || [, ''])[1];
    const tests = S.assertions || [];
    const failed = tests.filter((t) => !t.passed).length;
    const cls = r.status >= 500 ? 's5' : r.status >= 400 ? 's4' : r.status >= 300 ? 's3' : 's2';
    res.append(
      h('div', { class: 'status' },
        h('span', { class: 'code ' + cls }, r.status + ' ' + (r.statusText || '')),
        h('span', {}, r.timeMs + ' ms'), h('span', {}, fmtSize(r.size)),
        tests.length ? h('button', { class: 'link tests ' + (failed ? 'fail' : 'pass'), title: 'Show test results', onclick: () => { S.resTab = 'tests'; persist(); renderResponse(); } },
          failed ? '✗ ' + failed + ' of ' + tests.length + ' checks failed' : '✓ ' + tests.length + ' checks passed') : null,
        h('span', { class: 'spacer' }),
        h('button', { class: 'link', onclick: () => vscode.postMessage({ type: 'openBody', body: r.bodyEncoding === 'utf8' ? prettyText(r.body, ct) : r.body, contentType: ct }) }, 'Open in editor'),
        h('button', { class: 'link', onclick: () => navigator.clipboard.writeText(r.body) }, 'Copy')),
      h('div', { class: 'tabs' }, ...[['body', 'Body'], ['headers', 'Headers (' + r.headers.length + ')'], ...(tests.length ? [['tests', 'Tests (' + (tests.length - failed) + '/' + tests.length + ')']] : []), ['request', 'Sent request']].map(([id, label]) =>
        h('button', { class: 'tab' + (S.resTab === id ? ' active' : ''), onclick: () => { S.resTab = id; persist(); renderResponse(); } }, label))),
    );
    const pane = h('div', { class: 'pane resp' });
    res.append(pane);
    if (S.resTab === 'tests' && tests.length) {
      pane.append(h('table', { class: 'tests' }, ...tests.map((t) => h('tr', { class: t.passed ? 'pass' : 'fail' },
        h('td', { class: 'mark' }, t.passed ? '✓' : '✗'), h('td', { class: 'code' }, t.source),
        h('td', {}, t.passed ? (t.actual !== undefined ? 'actual: ' + t.actual : 'passed') : t.message)))));
    } else if (S.resTab === 'headers') {
      pane.append(h('table', { class: 'hdrs' }, ...r.headers.map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', {}, v)))));
    } else if (S.resTab === 'request') {
      const q = S.resolved;
      if (q) pane.append(h('pre', { class: 'code' }, q.method + ' ' + q.url + '\n' + q.headers.map((x) => x.name + ': ' + x.value).join('\n') + (q.body ? '\n\n' + q.body : '')));
    } else {
      if (r.bodyEncoding === 'base64') {
        if (/^image\//.test(ct)) pane.append(h('img', { class: 'preview', src: 'data:' + ct + ';base64,' + r.body }));
        else pane.append(h('p', { class: 'hint' }, 'Binary response (' + (ct || 'unknown type') + ', ' + fmtSize(r.size) + '). Use "Open in editor" to see the Base64.'));
        return;
      }
      let json;
      if (/json/i.test(ct) || /^\s*[[{]/.test(r.body)) { try { json = JSON.parse(r.body); } catch {} }
      if (json !== undefined) {
        pane.append(h('div', { class: 'tools' }, h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: S.raw, onchange: (e) => { S.raw = e.target.checked; persist(); renderResponse(); } }), 'Raw')));
        if (S.raw || r.body.length > MAX_TREE) pane.append(h('pre', { class: 'code' }, S.raw ? r.body : JSON.stringify(json, null, 2)));
        else pane.append(h('div', { class: 'json code' }, jsonNode(json, 0)));
      } else {
        pane.append(h('pre', { class: 'code' }, r.body || h('span', { class: 'hint' }, '(empty body)')));
      }
    }
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
      S.meta = { sourceLabel: m.sourceLabel, canSave: m.canSave, env: m.env, envNames: m.envNames };
      if (m.response) { S.response = m.response; S.error = null; S.assertions = []; S.lastAssertions = []; }
      S.dirty = false;
      S.sending = false;
      persist();
      render();
    } else if (m.type === 'env' || m.type === 'saved') {
      S.meta = { sourceLabel: m.sourceLabel, canSave: m.canSave, env: m.env, envNames: m.envNames };
      if (m.type === 'saved') S.dirty = false;
      persist();
      render();
    } else if (m.type === 'sending') {
      S.sending = true; S.error = null; render();
    } else if (m.type === 'response') {
      S.sending = false; S.response = m.response; S.resolved = m.resolved; S.error = null;
      S.assertions = m.assertions || []; S.lastAssertions = S.assertions;
      if (S.resTab === 'tests' && !S.assertions.length) S.resTab = 'body';
      persist(); render();
    } else if (m.type === 'error') {
      S.sending = false; S.error = m.message; persist(); render();
    } else if (m.type === 'setRequest') {
      S.request = m.request; changed(); render();
    }
  });

  render();
  vscode.postMessage({ type: 'ready' });
})();
