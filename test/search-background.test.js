'use strict';

// 裏の道具 (突き合わせの調べ) の検索は background で来る。画面の検索を打ち切らず、互いにも打ち切られない
// (2026-09-25: 四本の調べを並列に回したら、送り手が同じなので互いに「superseded」で失敗した)
const test = require('node:test');
const assert = require('node:assert/strict');
require('./helpers/stub-electron');

function setup() {
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: (channel) => handlers.delete(channel) };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const home = {
    search: async (request) => {
      await gate;
      return { total: 1, page: 0, pageSize: 24, hasNext: false, galleries: [{ id: `home:h:${request.query}` }] };
    },
  };
  const { registerSearchIpc } = require('../src/main/ipc/search-ipc');
  registerSearchIpc({
    ipcMain,
    whenCatalog: async () => {},
    catalog: { annotate: (list) => list },
    config: { load: () => ({}) },
    reading: { summary: () => ({}) },
    pawLibrary: { ready: async () => true },
    pawCreatorHints: async () => ({}),
    getHomeAuthors: () => home,
  });
  const search = (payload) => handlers.get('search')({ sender: { id: 7 } }, { source: 'home', ...payload });
  return { search, release };
}

test('background の検索は画面の検索に打ち切られず、画面の検索も打ち切らない', async () => {
  const { search, release } = setup();
  const ui = search({ requestId: 'ui-1', query: 'a' });
  const back1 = search({ background: true, requestId: 'b-1', query: 'b' });
  const back2 = search({ background: true, requestId: 'b-2', query: 'c' });
  release();
  const [a, b, c] = await Promise.all([ui, back1, back2]);
  assert.equal(a.galleries[0].id, 'home:h:a', '画面の検索は裏の検索に打ち切られない');
  assert.equal(b.galleries[0].id, 'home:h:b');
  assert.equal(c.galleries[0].id, 'home:h:c', '裏の検索どうしも打ち切らない');
});

test('画面の検索は今までどおり次の画面の検索に打ち切られる (background は関わらない)', async () => {
  const { search, release } = setup();
  const first = search({ requestId: 'ui-1', query: 'a' });
  const back = search({ background: true, requestId: 'b-1', query: 'b' });
  const second = search({ requestId: 'ui-2', query: 'c' });
  release();
  await assert.rejects(first, /superseded/);
  assert.equal((await back).galleries[0].id, 'home:h:b');
  assert.equal((await second).galleries[0].id, 'home:h:c');
});
