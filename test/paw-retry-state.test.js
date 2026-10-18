'use strict';

const test = require('node:test');
const assert = require('node:assert');
const initSqlJs = require('sql.js');
const { PawState } = require('../src/lib/paw-state');
const { PawBulk } = require('../src/lib/paw-bulk');

function mockCatalog(SQL, bytes) {
  const catalog = {
    SQL,
    db: bytes ? new SQL.Database(bytes) : new SQL.Database(),
    runWhenWritable(fn) { fn(); },
    persistSoon() {},
    queryRows(sql, params = []) {
      const statement = this.db.prepare(sql);
      try {
        statement.bind(params);
        const rows = [];
        while (statement.step()) rows.push(statement.getAsObject());
        return rows;
      } finally { statement.free(); }
    },
  };
  return catalog;
}

test('pending/failed 投稿は catalog DB の再読込後にも残り、完了時に消える', async () => {
  const SQL = await initSqlJs();
  const firstCatalog = mockCatalog(SQL);
  const first = new PawState(firstCatalog).init();
  const item = { key: 'fanbox:u:75', service: 'fanbox', user: 'u', id: '75', date: '20260102' };
  first.markPending(item);
  first.markFailed(item, new Error('synthetic failure'));

  const restartedCatalog = mockCatalog(SQL, firstCatalog.db.export());
  const restarted = new PawState(restartedCatalog).init();
  assert.deepStrictEqual(restarted.listPending('fanbox', 'u'), [{
    ...item, attempts: 1, error: 'synthetic failure',
  }]);
  assert.strictEqual(restarted.hasCompleted(item.key), false);

  restarted.markCompleted(item.key);
  const final = new PawState(mockCatalog(SQL, restartedCatalog.db.export())).init();
  assert.deepStrictEqual(final.listPending('fanbox', 'u'), []);
  assert.strictEqual(final.hasCompleted(item.key), true);
});

test('先頭50件が全て完了済みでも、page 2 の永続 pending を再試行へ返す', async () => {
  const completed = new Set(Array.from({ length: 50 }, (_, i) => `fanbox:u:${1000 - i}`));
  const pending = {
    key: 'fanbox:u:75', service: 'fanbox', user: 'u', id: '75', date: '20260102', attempts: 2, error: 'failed',
  };
  const pages = [];
  const state = {
    hasCompleted: (key) => completed.has(key),
    listPending: () => [pending],
    markPending() {},
  };
  const bulk = new PawBulk({
    state,
    delay: 0,
    adapter: {
      API_PAGE: 50,
      async listPosts(service, user, page) {
        pages.push(page);
        return page === 0 ? Array.from({ length: 50 }, (_, i) => ({ id: 1000 - i })) : [];
      },
    },
  });

  const fresh = await bulk.collectFresh('fanbox', 'u');
  assert.deepStrictEqual(fresh, [pending]);
  assert.deepStrictEqual(pages, [0], '新着探索は従来どおり完了済みページで止まる');
});

test('新着一覧が失敗しても永続 pending の再試行は返す', async () => {
  const pending = {
    key: 'fanbox:u:75', service: 'fanbox', user: 'u', id: '75', date: '20260102', attempts: 1, error: 'failed',
  };
  const bulk = new PawBulk({
    state: { listPending: () => [pending], hasCompleted: () => false },
    delay: 0,
    adapter: {
      API_PAGE: 50,
      async listPosts() {
        const error = new Error('synthetic list failure');
        error.status = 400;
        throw error;
      },
    },
  });
  assert.deepStrictEqual(await bulk.collectFresh('fanbox', 'u'), [pending]);
});
