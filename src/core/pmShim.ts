/**
 * Postman's script API (`pm.*`, plus the legacy `tests[...]` / `postman.*` / `responseBody`), written on
 * top of the JetBrains-style `client` / `request` / `response` objects of core/scripts.ts, so that
 * scripts imported from Postman collections keep working. Evaluated inside the script's own context
 * before the script, only when the script mentions it. Our own implementation of the documented API;
 * `pm.expect` covers the common assertion chain, not all of Chai.
 *
 * Variables: every `set` goes to `client.global` (used as `{{name}}` by later requests), except
 * `pm.variables.set` in a pre-request script, which only applies to the request about to be sent.
 * Every `get` reads request variables, then `client.global`, then the environment.
 */
export const PM_PRELUDE = String.raw`(function () {
  var pre = typeof response === 'undefined';
  var info = globalThis.__pm || {};
  delete globalThis.__pm;
  function show(v) {
    try { return typeof v === 'string' ? JSON.stringify(v) : v === undefined ? 'undefined' : typeof v === 'function' ? 'function' : JSON.stringify(v); } catch (e) { return String(v); }
  }
  function same(a, b) {
    if (a === b) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return a !== a && b !== b;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    var ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (var i = 0; i < ka.length; i++) if (!same(a[ka[i]], b[ka[i]])) return false;
    return true;
  }
  function typeOf(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    if (v instanceof RegExp) return 'regexp';
    if (v instanceof Date) return 'date';
    return typeof v;
  }
  function get(name) {
    var rv = request.variables.get(name);
    if (rv !== null) return rv;
    var g = client.global.get(name);
    if (g !== null) return g;
    var e = request.environment.get(name);
    return e === null ? undefined : e;
  }
  function scope(local) {
    var s = {
      get: get,
      set: function (k, v) { if (local && pre) request.variables.set(k, v); else client.global.set(k, v); },
      unset: function (k) { client.global.clear(k); },
      clear: function () { client.global.clearAll(); },
      has: function (k) { return get(k) !== undefined; },
      replaceIn: function (t) { return String(t).replace(/\{\{\s*([^{}]+?)\s*\}\}/g, function (m, n) { var v = get(n); return v === undefined ? m : String(v); }); },
      toObject: function () { return {}; },
    };
    return s;
  }
  var RESP = {};
  function chain(a, neg, msg, deep) {
    var c = {};
    function check(ok, text) {
      if (neg ? ok : !ok) throw new Error((msg ? msg + ': ' : '') + 'expected ' + (a === RESP ? 'response' : show(a)) + (neg ? ' not ' : ' ') + text);
      return c;
    }
    ['to', 'be', 'been', 'is', 'that', 'which', 'and', 'has', 'have', 'with', 'at', 'of', 'same', 'but', 'does', 'still', 'also', 'any', 'all', 'own', 'nested', 'ordered'].forEach(function (w) {
      Object.defineProperty(c, w, { get: function () { return c; } });
    });
    Object.defineProperty(c, 'not', { get: function () { return chain(a, !neg, msg, deep); } });
    Object.defineProperty(c, 'deep', { get: function () { return chain(a, neg, msg, true); } });
    var flags = {
      ok: function () { return a === RESP ? check(info.status >= 200 && info.status < 300, 'to be ok (2xx), got ' + info.status) : check(!!a, 'to be truthy'); },
      success: function () { return check(info.status >= 200 && info.status < 300, 'to be successful (2xx), got ' + info.status); },
      error: function () { return check(info.status >= 400, 'to be an error (4xx/5xx), got ' + info.status); },
      clientError: function () { return check(info.status >= 400 && info.status < 500, 'to be a client error (4xx), got ' + info.status); },
      serverError: function () { return check(info.status >= 500, 'to be a server error (5xx), got ' + info.status); },
      json: function () { return check(/json/i.test(response.contentType.mimeType), 'to be JSON, got ' + response.contentType.mimeType); },
      true: function () { return check(a === true, 'to be true'); },
      false: function () { return check(a === false, 'to be false'); },
      null: function () { return check(a === null, 'to be null'); },
      undefined: function () { return check(a === undefined, 'to be undefined'); },
      NaN: function () { return check(a !== a, 'to be NaN'); },
      exist: function () { return check(a !== null && a !== undefined, 'to exist'); },
      empty: function () {
        var n = a == null ? 0 : typeof a === 'string' || Array.isArray(a) ? a.length : typeof a === 'object' ? Object.keys(a).length : 1;
        return check(n === 0, 'to be empty');
      },
    };
    Object.keys(flags).forEach(function (k) { Object.defineProperty(c, k, { get: flags[k] }); });
    c.equal = c.equals = c.eq = function (b) { return check(deep ? same(a, b) : a === b, 'to equal ' + show(b)); };
    c.eql = c.eqls = function (b) { return check(same(a, b), 'to deeply equal ' + show(b)); };
    c.include = c.includes = c.contain = c.contains = function (b) {
      var ok = typeof a === 'string' ? a.indexOf(b) >= 0
        : Array.isArray(a) ? a.some(function (x) { return deep || typeof b === 'object' ? same(x, b) : x === b; })
        : a && typeof a === 'object' && b && typeof b === 'object' ? Object.keys(b).every(function (k) { return same(a[k], b[k]); }) : false;
      return check(ok, 'to include ' + show(b));
    };
    c.a = c.an = function (t) { return check(typeOf(a) === String(t).toLowerCase(), 'to be a ' + t + ' (is ' + typeOf(a) + ')'); };
    c.instanceOf = c.instanceof = function (k) { return check(a instanceof k, 'to be an instance of ' + (k && k.name)); };
    c.above = c.gt = c.greaterThan = function (n) { return check(a > n, 'to be above ' + n); };
    c.below = c.lt = c.lessThan = function (n) { return check(a < n, 'to be below ' + n); };
    c.least = c.gte = c.greaterThanOrEqual = function (n) { return check(a >= n, 'to be at least ' + n); };
    c.most = c.lte = c.lessThanOrEqual = function (n) { return check(a <= n, 'to be at most ' + n); };
    c.within = function (lo, hi) { return check(a >= lo && a <= hi, 'to be within ' + lo + '..' + hi); };
    c.lengthOf = function (n) { return check(a != null && a.length === n, 'to have length ' + n + ' (has ' + (a == null ? a : a.length) + ')'); };
    Object.defineProperty(c, 'length', { value: c.lengthOf });
    c.match = c.matches = function (re) { return check(re instanceof RegExp ? re.test(String(a)) : new RegExp(re).test(String(a)), 'to match ' + re); };
    c.string = function (s) { return check(String(a).indexOf(s) >= 0, 'to contain ' + show(s)); };
    c.oneOf = function (list) { return check(list.some(function (x) { return deep ? same(x, a) : x === a; }), 'to be one of ' + show(list)); };
    c.keys = c.key = function () {
      var ks = Array.prototype.concat.apply([], arguments);
      return check(a && typeof a === 'object' && ks.every(function (k) { return Object.prototype.hasOwnProperty.call(a, k); }), 'to have keys ' + show(ks));
    };
    c.members = function (list) { return check(Array.isArray(a) && list.every(function (x) { return a.some(function (y) { return same(x, y); }); }), 'to have members ' + show(list)); };
    c.property = function (k, v) {
      var path = String(k).split('.'), cur = a, has = true;
      for (var i = 0; i < path.length; i++) { if (cur == null || !(path[i] in Object(cur))) { has = false; break; } cur = cur[path[i]]; }
      if (arguments.length < 2) { check(has, 'to have property ' + show(k)); return chain(cur, false, msg, deep); }
      return check(has && (deep ? same(cur, v) : cur === v), 'to have property ' + show(k) + ' of ' + show(v) + (has ? ' (is ' + show(cur) + ')' : ''));
    };
    c.status = function (s) {
      if (typeof s === 'string') return check(info.statusText === s, 'to have status ' + show(s) + ' (is ' + info.status + ' ' + info.statusText + ')');
      return check(info.status === s, 'to have status ' + s + ' (is ' + info.status + ')');
    };
    c.header = function (name, value) {
      var v = response.headers.valueOf(name);
      if (arguments.length < 2) return check(v !== null, 'to have header ' + show(name));
      return check(v === value, 'to have header ' + name + ': ' + value + ' (is ' + show(v) + ')');
    };
    c.body = function (t) {
      if (!arguments.length) return check(info.text.length > 0, 'to have a body');
      return check(typeof t === 'string' ? info.text === t : same(pmResponse.json(), t), 'to have body ' + show(t));
    };
    c.jsonBody = function (p, v) {
      var body; try { body = pmResponse.json(); } catch (e) { return check(false, 'to have a JSON body'); }
      if (!arguments.length) return check(true, 'to have a JSON body');
      var r = jsonPath(body, String(p).charAt(0) === '$' ? String(p) : '$.' + p);
      return arguments.length < 2 ? check(r !== null, 'to have JSON ' + p) : check(same(r, v), 'to have JSON ' + p + ' = ' + show(v) + ' (is ' + show(r) + ')');
    };
    c.responseTime = { below: function (n) { return check(info.timeMs < n, 'to respond in under ' + n + ' ms (took ' + info.timeMs + ')'); } };
    return c;
  }
  var pmResponse = pre ? undefined : {
    code: info.status,
    status: info.statusText,
    responseTime: info.timeMs,
    responseSize: info.text.length,
    text: function () { return info.text; },
    json: function () { return JSON.parse(info.text); },
    headers: {
      get: function (n) { var v = response.headers.valueOf(n); return v === null ? undefined : v; },
      has: function (n) { return response.headers.valueOf(n) !== null; },
      toObject: function () { return info.headers; },
    },
  };
  if (pmResponse) Object.defineProperty(pmResponse, 'to', { get: function () { return chain(RESP, false); } });
  globalThis.pm = {
    environment: scope(false),
    collectionVariables: scope(false),
    globals: scope(false),
    variables: scope(true),
    iterationData: { get: function () { return undefined; }, has: function () { return false; } },
    response: pmResponse,
    request: { method: request.method, url: { toString: function () { return request.url.tryGetSubstituted(); } }, headers: { get: function (n) { var h = request.headers.findByName(n); return h ? h.tryGetSubstitutedValue() : undefined; } }, body: { raw: request.body.getRaw() } },
    info: { requestName: info.name || '', eventName: pre ? 'prerequest' : 'test', iteration: 0 },
    test: function (name, fn) {
      client.test(name, function () {
        var r = fn && fn();
        if (r && typeof r.then === 'function') throw new Error('async tests are not supported');
      });
    },
    expect: function (v, m) { return chain(v, false, m); },
    sendRequest: function () { throw new Error('pm.sendRequest is not supported; put the request in the .http file and chain it with # @name'); },
  };
  globalThis.pm.test.skip = function (name) { client.log('skipped test: ' + name); };
  globalThis.postman = {
    setEnvironmentVariable: function (k, v) { client.global.set(k, v); },
    setGlobalVariable: function (k, v) { client.global.set(k, v); },
    getEnvironmentVariable: get,
    getGlobalVariable: get,
    clearEnvironmentVariable: function (k) { client.global.clear(k); },
    clearGlobalVariable: function (k) { client.global.clear(k); },
  };
  globalThis.environment = new Proxy({}, { get: function (_t, k) { return typeof k === 'string' ? get(k) : undefined; } });
  globalThis.globals = globalThis.environment;
  globalThis.tests = {};
  if (!pre) {
    globalThis.responseBody = info.text;
    globalThis.responseCode = { code: info.status, name: info.statusText };
    globalThis.responseTime = info.timeMs;
    globalThis.responseHeaders = info.headers;
  }
})();`;

/** Does this script use the Postman API (so the prelude is needed)? */
export function usesPostmanApi(code: string): boolean {
  return /\b(?:pm|postman)\.|\btests\s*\[|\bresponseBody\b|\bresponseCode\b/.test(code);
}
