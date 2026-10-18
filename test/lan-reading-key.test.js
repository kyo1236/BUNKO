'use strict';

// 栞 (reading.json) の鍵が机上と端末で揃っていることの固定。
// 机上は paw 本を 'pweagle:<eagleId>' で書き、LAN の口は 'pw_<eagleId>' の
// id で来る。同じ本の続きが両方から見えるよう、LAN 側は書く前に鍵を戻す。
// electron は偽物に差し替え、LanServer.handle() を偽 req/res で叩く。

const test = require('node:test');
const assert = require('node:assert');
const { Readable } = require('stream');

const { installStub } = require('./helpers/stub-electron-2.js');
installStub();

const { LanServer } = require('../src/lib/lan-server.js');

// reading.json の代わりの覚え書き。鍵の顔をそのまま検められるよう素の object で持つ
function makeReading(initial = {}) {
  const store = { ...initial };
  return {
    store,
    get: (id) => store[String(id)] || null,
    set(id, entry) {
      store[String(id)] = {
        page: Math.max(0, Math.round(Number(entry?.page) || 0)),
        pageCount: Math.max(0, Math.round(Number(entry?.pageCount) || 0)),
        updatedAt: Date.now(),
        finished: Boolean(entry?.finished),
      };
      return store[String(id)];
    },
    all: () => ({ ...store }),
  };
}

function makeServer(reading) {
  const server = new LanServer({
    catalog: {},
    reading,
    settings: () => ({}),
    saveSettings() {},
  });
  server.address = '192.168.0.2';
  server.port = 8321;
  server.token = 'a'.repeat(32);
  return server;
}

// 偽の req/res で handle() を通す。合言葉は札 (cookie) で渡す
async function call(server, method, pathname, body) {
  const req = Readable.from(body == null ? [] : [Buffer.from(body, 'utf8')]);
  req.method = method;
  req.url = pathname;
  req.headers = {
    host: `${server.address}:${server.port}`,
    cookie: `bunko_lan=${server.token}`,
  };
  req.socket = { remoteAddress: '192.168.0.9' };
  let status = 0;
  let payload = '';
  const res = {
    setHeader() {},
    writeHead(code) { status = code; },
    end(chunk) { payload = chunk == null ? '' : String(chunk); },
  };
  await server.handle(req, res);
  let json = null;
  try {
    json = JSON.parse(payload);
  } catch {
    json = null;
  }
  return { status, json };
}

test('栞: 端末が置いた paw 本の栞は机上の鍵 (pweagle:) で入る', async () => {
  const reading = makeReading();
  const server = makeServer(reading);
  const put = await call(
    server, 'PUT', '/api/reading/pw_e9',
    JSON.stringify({ page: 4, pageCount: 20, finished: false }),
  );
  assert.strictEqual(put.status, 200);
  assert.deepStrictEqual(Object.keys(reading.store), ['pweagle:e9']);
  assert.strictEqual(reading.store['pweagle:e9'].page, 4);

  // 一覧は端末の顔 (pw_) に戻して配る
  const list = await call(server, 'GET', '/api/reading');
  assert.strictEqual(list.status, 200);
  assert.deepStrictEqual(Object.keys(list.json), ['pw_e9']);
  assert.strictEqual(list.json.pw_e9.page, 4);
});

test('栞: 机上が置いた栞を端末が読み、hitomi の数字鍵はそのまま', async () => {
  const reading = makeReading({
    'pweagle:e1': { page: 7, pageCount: 30, updatedAt: 1, finished: false },
    123: { page: 2, pageCount: 10, updatedAt: 2, finished: false },
  });
  const server = makeServer(reading);
  assert.strictEqual(server.readingMark('pw_e1').page, 7);
  assert.strictEqual(server.readingMark('123').page, 2);

  await call(server, 'PUT', '/api/reading/123', JSON.stringify({ page: 5, pageCount: 10 }));
  assert.strictEqual(reading.store['123'].page, 5);
  assert.deepStrictEqual(
    Object.keys(reading.store).sort(),
    ['123', 'pweagle:e1'],
  );
});

test('栞: 旧鍵 (pw_) の栞は読む側だけが拾い、書き直しは新鍵へ移る', async () => {
  const reading = makeReading({
    pw_e2: { page: 9, pageCount: 40, updatedAt: 3, finished: false },
  });
  const server = makeServer(reading);
  // 新鍵に無ければ旧鍵を見る
  assert.strictEqual(server.readingMark('pw_e2').page, 9);
  const list = await call(server, 'GET', '/api/reading');
  assert.strictEqual(list.json.pw_e2.page, 9);

  // 書くのは常に新鍵。以後は新鍵が優先される
  await call(server, 'PUT', '/api/reading/pw_e2', JSON.stringify({ page: 11, pageCount: 40 }));
  assert.strictEqual(reading.store['pweagle:e2'].page, 11);
  assert.strictEqual(reading.store.pw_e2.page, 9); // 旧い方は触らない
  assert.strictEqual(server.readingMark('pw_e2').page, 11);
  const after = await call(server, 'GET', '/api/reading');
  assert.deepStrictEqual(Object.keys(after.json), ['pw_e2']);
  assert.strictEqual(after.json.pw_e2.page, 11);
});
