// The response filter's JSONPath (media/panel.js jsonQuery) runs in the webview; test it by extracting the function.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../media/panel.js', import.meta.url), 'utf8');
const start = src.indexOf('  function jsonQuery(');
const end = src.indexOf('\n  }\n', start) + 4;
const jsonQuery = new Function(src.slice(start, end) + '; return jsonQuery;')() as (d: unknown, p: string) => unknown[];

const d = { store: { book: [{ title: 'A', price: 8, active: true }, { title: 'B', price: 22, active: false }, { title: 'C', price: 9, isbn: '1' }], bike: { color: 'red', price: 19 } }, n: null };

test('filter JSONPath: keys, indexes, wildcards, slices, recursive descent', () => {
  assert.deepEqual(jsonQuery(d, '$.store.book[0].title'), ['A']);
  assert.deepEqual(jsonQuery(d, '$.store.book[-1].title'), ['C']);
  assert.deepEqual(jsonQuery(d, '$.store.book[*].title'), ['A', 'B', 'C']);
  assert.deepEqual(jsonQuery(d, '$.store.book[0:2].title'), ['A', 'B']);
  assert.deepEqual(jsonQuery(d, '$..price'), [8, 22, 9, 19]);
  assert.deepEqual(jsonQuery(d, "$.store.bike['color','price']"), ['red', 19]);
  assert.deepEqual(jsonQuery(d, '$.store.book.length'), [3]);
  assert.deepEqual(jsonQuery(d, '$.n'), [null]);
  assert.deepEqual(jsonQuery(d, '$.nope'), []);
});

test('filter JSONPath: [?()] filters', () => {
  assert.deepEqual(jsonQuery(d, '$..book[?(@.price < 10)].title'), ['A', 'C']);
  assert.deepEqual(jsonQuery(d, '$..book[?(@.isbn)].title'), ['C']);
  assert.deepEqual(jsonQuery(d, '$.store.book[?(@.active)].title'), ['A']);
  assert.deepEqual(jsonQuery(d, '$.store.book[?(@.title == "B")].price'), [22]);
  assert.deepEqual(jsonQuery(d, '$.store.book[?(@.title =~ /^a/)].price'), [8]);
});

test('filter JSONPath: bad paths throw a readable error', () => {
  assert.throws(() => jsonQuery(d, '$x'), /Cannot read "x"/);
  assert.throws(() => jsonQuery(d, '$.store.book[?(price)]'), /Filters look like/);
});
