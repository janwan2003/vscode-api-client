// @ts-check
/* Plainwire environment editor webview. Plain DOM, no framework. The extension owns the files; this edits a model
   (see src/core/envFile.ts) and sends it back on Save. */
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  const SHARED = '$shared';
  const KIND = { object: 'object', array: 'array', number: 'number', boolean: 'true/false', null: 'null' };

  /** @type {any} */
  let S = {
    model: { envs: [] },
    baseline: '',
    sel: 0,
    files: { public: { label: 'http-client.env.json', exists: false }, private: { label: 'http-client.private.env.json', exists: false } },
    folders: [],
    folder: null,
    gitignore: 'none',
    active: null,
    error: null,
    notice: null,
    conflict: false,
    loaded: false,
  };
  /** Secret rows whose value is shown in clear text. */
  const shown = new WeakSet();
  let focusNext = '';

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

  const snapshot = () => JSON.stringify(S.model);
  const isDirty = () => S.loaded && snapshot() !== S.baseline;
  let lastDirty = false;
  function changed() {
    const d = isDirty();
    const el = document.getElementById('dirty');
    if (el) el.hidden = !d;
    if (d !== lastDirty) vscode.postMessage({ type: 'dirty', dirty: d });
    lastDirty = d;
  }

  /** Display order: $shared first, then the files' order. Returns indexes into S.model.envs. */
  function order() {
    const idx = S.model.envs.map((_, i) => i);
    return [...idx.filter((i) => S.model.envs[i].name === SHARED), ...idx.filter((i) => S.model.envs[i].name !== SHARED)];
  }
  const envLabel = (e) => (e.name === SHARED ? 'Shared (all environments)' : e.name || '(unnamed)');

  function save(force = false) {
    S.error = null;
    S.notice = null;
    vscode.postMessage({ type: 'save', model: S.model, force });
  }

  function uniqueEnvName() {
    const names = new Set(S.model.envs.map((e) => e.name));
    for (let i = 1; ; i++) {
      const n = i === 1 ? 'new-env' : 'new-env-' + i;
      if (!names.has(n)) return n;
    }
  }

  // ---------- rendering ----------
  function render() {
    const app = /** @type {HTMLElement} */ (document.getElementById('app'));
    if (!S.loaded) {
      app.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'spinner' }), 'Loading environments…'));
      return;
    }
    const f = S.files;
    const head = h('div', { class: 'ee-head' },
      h('h1', {}, 'Environments'),
      S.folders.length > 1
        ? h('label', { class: 'ee-folder' }, 'Folder ',
            h('select', { onchange: (e) => {
              if (isDirty()) { e.target.value = S.folder; S.error = 'Save or reload before switching folders: you have unsaved changes.'; render(); return; }
              vscode.postMessage({ type: 'folder', value: e.target.value });
            } }, ...S.folders.map((x) => h('option', { value: x.value, selected: x.value === S.folder }, x.label))))
        : null,
      h('span', { id: 'dirty', class: 'dirty', hidden: !isDirty() }, '● Unsaved changes'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'link', title: 'Reload from disk (discards unsaved changes)', onclick: () => vscode.postMessage({ type: 'reload' }) }, 'Reload'),
      h('button', { class: 'primary', title: 'Save (Ctrl+S / Cmd+S)', disabled: !!S.loadError, onclick: () => save() }, 'Save'));

    const fileLine = h('div', { class: 'hint ee-files' },
      'Non-secret values → ', h('button', { class: 'link', title: 'Open the JSON file', onclick: () => vscode.postMessage({ type: 'openJson', which: 'public' }) }, f.public.label),
      f.public.exists ? null : h('span', { class: 'muted' }, ' (created on save)'),
      h('span', { class: 'ee-sep' }, '·'), 'Secret values → ', h('button', { class: 'link', title: 'Open the JSON file', onclick: () => vscode.postMessage({ type: 'openJson', which: 'private' }) }, f.private.label),
      f.private.exists ? null : h('span', { class: 'muted' }, ' (created on save)'));

    const git =
      S.gitignore === 'covered'
        ? h('div', { class: 'hint ee-git ok' }, '✓ ', h('code', {}, 'http-client.private.env.json'), ' is git-ignored, so secrets stay on this machine.')
        : S.gitignore === 'missing'
          ? h('div', { class: 'ee-banner warn' },
              h('span', {}, h('code', {}, 'http-client.private.env.json'), ' holds your secrets but is not in .gitignore. Keep it out of git.'),
              h('button', { onclick: () => vscode.postMessage({ type: 'addGitignore' }) }, 'Add to .gitignore'))
          : h('div', { class: 'hint ee-git' }, 'Keep ', h('code', {}, 'http-client.private.env.json'), ' out of version control (add it to your .gitignore).');

    const banners = [
      S.conflict
        ? h('div', { class: 'ee-banner warn' }, h('span', {}, 'The environment files changed on disk while you were editing.'),
            h('button', { onclick: () => vscode.postMessage({ type: 'reload' }) }, 'Reload (discard my changes)'),
            h('button', { onclick: () => save(true) }, 'Overwrite with my changes'))
        : null,
      S.error ? h('div', { class: 'error-box' }, h('pre', {}, S.error)) : null,
      S.notice ? h('div', { class: 'hint ee-notice' }, S.notice) : null,
    ];

    if (S.loadError) {
      app.replaceChildren(h('div', { class: 'ee' }, head, fileLine, ...banners));
      return;
    }

    const ord = order();
    if (!ord.includes(S.sel)) S.sel = ord[0] ?? 0;
    const nav = h('nav', { class: 'ee-envs' },
      ...ord.map((i) => {
        const e = S.model.envs[i];
        return h('button', { class: 'ee-env-tab' + (i === S.sel ? ' active' : '') + (e.name === SHARED ? ' shared' : ''), onclick: () => { S.sel = i; render(); } },
          h('span', { class: 'ee-env-name' }, envLabel(e)),
          e.name !== SHARED && e.name === S.active ? h('span', { class: 'badge', title: 'Selected in the status bar' }, 'active') : null,
          h('span', { class: 'ee-count' }, String(e.vars.length)));
      }),
      h('button', { class: 'link ee-add-env', onclick: () => {
        S.model.envs.push({ name: uniqueEnvName(), vars: [] });
        S.sel = S.model.envs.length - 1;
        focusNext = 'env-name';
        changed();
        render();
      } }, '+ Add environment'),
      h('div', { class: 'hint ee-pick' }, 'Choose the active environment in the status bar.'));

    const env = S.model.envs[S.sel];
    app.replaceChildren(h('div', { class: 'ee' }, head, fileLine, git, ...banners, h('div', { class: 'ee-body' }, nav, env ? envPane(env) : h('div', { class: 'empty' }, 'No environments yet. Add one.'))));
    if (focusNext) {
      const el = /** @type {HTMLInputElement|null} */ (app.querySelector('[data-focus="' + focusNext + '"]'));
      if (el) { el.focus(); el.select && el.select(); }
      focusNext = '';
    }
  }

  function envPane(env) {
    const shared = env.name === SHARED;
    const title = shared
      ? h('h2', {}, 'Shared (all environments)')
      : h('input', { class: 'ee-env-input', value: env.name, 'data-focus': 'env-name', spellcheck: 'false', 'aria-label': 'Environment name',
          oninput: (e) => { env.name = e.target.value; changed(); },
          onchange: () => render() });
    const secretNames = new Set(env.vars.filter((v) => v.secret).map((v) => v.name.trim()));
    const rows = env.vars.map((v, i) => varRow(env, v, i, !v.secret && secretNames.has(v.name.trim())));
    return h('section', { class: 'ee-env' },
      h('div', { class: 'ee-env-head' }, title, h('span', { class: 'spacer' }),
        shared ? null : h('button', { class: 'link danger', onclick: () => {
          S.model.envs.splice(S.sel, 1);
          S.sel = order()[0] ?? 0;
          changed();
          render();
        } }, 'Delete environment')),
      h('div', { class: 'hint' }, shared
        ? 'Variables here apply in every environment; an environment\'s own variable with the same name wins.'
        : 'Use them in requests as {{name}}. Secret values are stored in the private file.'),
      h('table', { class: 'ee-vars' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Value'), h('th', { class: 'c' }, 'Secret'), h('th', {}))),
        h('tbody', {}, ...rows)),
      h('button', { class: 'link', onclick: () => {
        env.vars.push({ name: '', value: '', secret: false });
        focusNext = 'var-' + (env.vars.length - 1);
        changed();
        render();
      } }, '+ Add variable'));
  }

  function varRow(env, v, i, overridden) {
    const which = v.secret ? 'private' : 'public';
    if (v.readonly) {
      return h('tr', { class: 'ro' },
        h('td', {}, h('span', { class: 'ee-name-ro' }, v.name)),
        h('td', {}, h('div', { class: 'ee-ro' },
          h('span', { class: 'ee-kind' }, (KIND[v.readonly] || v.readonly) + ' — edit in JSON'),
          h('code', { class: 'ee-preview', title: v.preview }, v.preview),
          h('button', { class: 'link', onclick: () => vscode.postMessage({ type: 'openJson', which, env: env.orig ?? env.name, name: v.orig ? v.orig.name : v.name }) }, 'Open JSON'))),
        h('td', { class: 'c' }, h('input', { type: 'checkbox', checked: v.secret, disabled: true, title: 'Move it between the files in the JSON editor' })),
        h('td', {}));
    }
    const masked = v.secret && !shown.has(v);
    const value = h('input', { class: 'v', type: masked ? 'password' : 'text', value: v.value ?? '', spellcheck: 'false', placeholder: 'value', 'aria-label': 'Value',
      oninput: (e) => { v.value = e.target.value; changed(); } });
    return h('tr', { class: overridden ? 'overridden' : '' },
      h('td', {}, h('input', { class: 'k', value: v.name, spellcheck: 'false', placeholder: 'name', 'aria-label': 'Name', 'data-focus': 'var-' + i,
        oninput: (e) => { v.name = e.target.value; changed(); } })),
      h('td', {}, h('div', { class: 'ee-val' }, value,
        v.secret ? h('button', { class: 'icon', title: masked ? 'Show value' : 'Hide value', onclick: () => { if (masked) shown.add(v); else shown.delete(v); render(); } }, masked ? 'Show' : 'Hide') : null),
        overridden ? h('div', { class: 'hint small' }, 'A secret value with this name overrides this one.') : null),
      h('td', { class: 'c' }, h('input', { type: 'checkbox', checked: v.secret, title: 'Secret: store in http-client.private.env.json', 'aria-label': 'Secret',
        onchange: (e) => { v.secret = e.target.checked; changed(); render(); } })),
      h('td', {}, h('button', { class: 'icon', title: 'Delete variable', 'aria-label': 'Delete variable', onclick: () => { env.vars.splice(i, 1); changed(); render(); } }, '✕')));
  }

  // ---------- messages ----------
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    switch (m.type) {
      case 'load': {
        const prevName = S.model.envs[S.sel] && S.model.envs[S.sel].name;
        const model = m.model;
        // Always offer Shared; it is only written once it has variables.
        if (!m.error && !model.envs.some((e) => e.name === SHARED)) model.envs.unshift({ name: SHARED, vars: [] });
        S = { ...S, model, baseline: JSON.stringify(model), files: m.files, folders: m.folders, folder: m.folder, gitignore: m.gitignore, active: m.active,
          loadError: m.error, error: m.error, notice: m.notice, conflict: false, loaded: true };
        const again = model.envs.findIndex((e) => e.name === prevName);
        S.sel = again >= 0 ? again : order()[0] ?? 0;
        lastDirty = true;
        changed();
        render();
        break;
      }
      case 'active':
        S.active = m.active;
        render();
        break;
      case 'conflict':
        S.conflict = true;
        render();
        break;
      case 'error':
        S.error = m.message;
        render();
        break;
    }
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      save();
    }
  });

  render();
  vscode.postMessage({ type: 'ready' });
})();
