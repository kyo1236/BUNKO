'use strict';

// 所持の Eagle の本の頁数の控え (src/lib/page-counts.js) と、Pawchive の所持の一覧への当て方 (search-ipc)。
// 名前に【17P】の無い本 (Discord から持ち込んだ PDF など) も、一覧の札の右上に頁数の印を出すため。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PageCounts } = require('../src/lib/page-counts');

test('頁数の控え: 数えた物は mtime ごとに覚え、二度は数えない。読み直しても残る', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunko-pages-'));
  const file = path.join(dir, 'page-counts.json');
  const calls = [];
  const counts = new PageCounts({ file, count: async (id) => { calls.push(id); return id === 'pweagle:E1' ? 12 : 0; } });
  const first = await counts.fill([
    { id: 'pweagle:E1', eagleId: 'E1', mtime: 5 },
    { id: 'pweagle:E2', eagleId: 'E2', mtime: 5 },
  ]);
  assert.deepEqual(Object.fromEntries(first), { 'pweagle:E1': 12 }, '数えられない本 (0) は控えない');
  await counts.fill([{ id: 'pweagle:E1', eagleId: 'E1', mtime: 5 }]);
  assert.equal(calls.filter((id) => id === 'pweagle:E1').length, 1, '二度目は控えから');
  assert.equal(counts.get('E1', 5), 12);
  assert.equal(counts.get('E1', 6), 0, '本が差し替わった (mtime が違う) 控えは使わない');
  assert.equal(counts.flush(), true);
  assert.equal(new PageCounts({ file }).get('E1', 5), 12, '書いて読み直しても残る');
});

test('Pawchive の所持の一覧: 名前に頁数の無い本に控えの頁数を当て、無い物は裏で数える', async () => {
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: (channel) => handlers.delete(channel) };
  const filled = [];
  const counts = {
    get: (eagleId) => (eagleId === 'E1' ? 20 : 0),
    fill: async (items) => { filled.push(...items); return new Map(); },
  };
  const galleries = [
    { id: 'pweagle:E1', source: 'pawchive', kind: 'eagleItem', eagleId: 'E1', pageCount: 0 },
    { id: 'pweagle:E2', source: 'pawchive', kind: 'eagleItem', eagleId: 'E2', pageCount: 0 },
    { id: 'pweagle:E3', source: 'pawchive', kind: 'eagleItem', eagleId: 'E3', pageCount: 17 },
  ];
  const { registerSearchIpc } = require('../src/main/ipc/search-ipc');
  registerSearchIpc({
    ipcMain,
    whenCatalog: async () => {},
    catalog: { annotate: (list) => list },
    config: { load: () => ({}) },
    reading: { summary: () => ({}) },
    pawLibrary: { ready: async () => true, search: () => ({ galleries, total: 3, hasNext: false }) },
    pawCreatorHints: async () => ({}),
    getPageCounts: () => counts,
  });
  const reply = await handlers.get('search')({ sender: { id: 1 } }, { source: 'pawchive', scope: 'library', query: '', page: 0, pageSize: 24 });
  const pages = Object.fromEntries(reply.galleries.map((g) => [g.id, g.pageCount]));
  assert.deepEqual(pages, { 'pweagle:E1': 20, 'pweagle:E2': 0, 'pweagle:E3': 17 });
  assert.deepEqual(filled.map((item) => item.eagleId), ['E2'], '控えに無い本だけ裏で数える');
});
