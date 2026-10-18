'use strict';

// 手のひら版の棚に、hitomi 等へ紐付かない手持ちの Eagle アイテム (未照合) が並ぶことの固定。
// 台帳は pweagle:<eagleId> の疑似ギャラリーで返す。口 (URL) は ':' を受けないので
// 札は pw_<eagleId> で出し、実体の確認と一冊の札は paw の本と同じ道 (.info の中の原本) を通す。
// 混ぜるかの条件は机上版 (search-ipc) と同じ設定 (showUnmatchedEagle)。
// electron は偽物に差し替え、台帳も合成の物。題はすべて合成

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

const { installStub } = require('./helpers/stub-electron-2.js');
installStub();

const { LanServer } = require('../src/lib/lan-server.js');
const pawLibrary = require('../src/lib/paw-library.js');

// 合成の Eagle ライブラリ: e7 だけ原本 (PDF) を持つ。e8 は台帳にはあるが実体が無い
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bunko-lan-unmatched-'));
const infoDir = path.join(root, 'images', 'e7.info');
fs.mkdirSync(infoDir, { recursive: true });
fs.writeFileSync(path.join(infoDir, 'book.pdf'), '');
const originalPath = pawLibrary.originalPath;
pawLibrary.originalPath = (eagleId) => (eagleId === 'e7' ? path.join(infoDir, 'book.pdf') : null);
test.after(() => {
  pawLibrary.originalPath = originalPath;
  fs.rmSync(root, { recursive: true, force: true });
});

// 台帳が返す未照合の疑似ギャラリー (catalog.eagleItemGalleryFromEntry と同じ顔)
function pseudo(eagleId) {
  return {
    id: 'pweagle:' + eagleId,
    source: 'pawchive',
    sourceId: eagleId,
    title: '合成 ' + eagleId,
    type: '',
    language: null,
    artists: [],
    groups: [],
    series: [],
    characters: [],
    tags: [{ type: 'tag', name: 'synthetic', negative: false }],
    pageCount: 0,
    badge: '未照合',
    addedDate: '2024-06-01T00:00:00.000Z',
    publishedDate: null,
    isBlocked: false,
    hasVideo: false,
    url: '',
    offline: true,
    owned: true,
    kind: 'eagleItem',
    eagleId,
    star: 4,
    unmatched: true,
  };
}
const HITOMI = {
  id: 123, title: 'ひとみの本', star: 0, type: 'doujinshi',
  artists: [{ name: 'someone' }], tags: [], pageCount: 10,
  addedDate: '2024-05-01T00:00:00.000Z', publishedDate: null,
};

function makeServer({ settings = {}, reading = null } = {}) {
  const calls = [];
  const catalog = {
    searchLibrary(payload) {
      calls.push(payload);
      return { galleries: [pseudo('e7'), pseudo('e8'), HITOMI], total: 3 };
    },
    // 紐付いた本だけ台帳の道で見つかる。疑似 id で訊かれたら null (題での救済に頼らない)
    findLocal(id) { return String(id) === '123' ? 'C:/synthetic/123.info' : null; },
    eagleItemGallery(eagleId) { return eagleId === 'e7' ? pseudo('e7') : null; },
    findStar() { return 0; },
  };
  const server = new LanServer({
    catalog,
    reading: reading || { all: () => ({}), get: () => null },
    settings: () => settings,
    saveSettings() {},
  });
  server.address = '192.168.0.2';
  server.port = 8321;
  server.token = 'a'.repeat(32);
  server.pawItems = () => []; // 作者フォルダには誰も居ない
  // 紐付いた本の実体確認は fs を触らず「ある」扱い。paw の道 (paw:) だけ本物の判定を通す
  server.memoContent = (key, probe) => (String(key).startsWith('paw:') ? probe() : 'dummy');
  server.bookShape = async () => ({ pageCount: 3, ratios: [] }); // 綴じ目は読まない
  server.calls = calls;
  return server;
}

// 偽の req/res で handle() を通す。合言葉は札 (cookie) で渡す
async function call(server, pathname) {
  const req = Readable.from([]);
  req.method = 'GET';
  req.url = pathname;
  req.headers = {
    host: server.address + ':' + server.port,
    cookie: 'bunko_lan=' + server.token,
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

test('棚: 未照合の Eagle アイテムが pw_ の札で並び、台帳には includeUnmatched を渡す', async () => {
  const server = makeServer();
  const out = await call(server, '/api/books');
  assert.strictEqual(out.status, 200);
  // e8 は実体が無いので落ちる。hitomi の本は数字のまま
  assert.deepStrictEqual(out.json.items.map((item) => item.id), ['pw_e7', '123']);
  assert.strictEqual(out.json.total, 3);
  assert.strictEqual(server.calls[0].includeUnmatched, true);
  const card = out.json.items[0];
  assert.strictEqual(card.title, '合成 e7');
  assert.strictEqual(card.star, 4);
  assert.deepStrictEqual(card.tags, [{ name: 'synthetic', type: 'tag', label: '' }]);
  assert.strictEqual(card.addedDate, '2024-06-01T00:00:00.000Z');
});

test('棚: 設定 showUnmatchedEagle=false なら混ぜない (机上版と同じ条件)', async () => {
  const server = makeServer({ settings: { showUnmatchedEagle: false } });
  await call(server, '/api/books');
  assert.strictEqual(server.calls[0].includeUnmatched, false);
});

test('一冊: 作者フォルダに居ない未照合の本も、台帳の題で開く (id を題にしない)', async () => {
  const server = makeServer();
  const out = await call(server, '/api/book/pw_e7');
  assert.strictEqual(out.status, 200);
  assert.strictEqual(out.json.id, 'pw_e7');
  assert.strictEqual(out.json.title, '合成 e7');
  assert.strictEqual(out.json.pageCount, 3);
  // 実体の無い未照合は開けない
  const missing = await call(server, '/api/book/pw_e8');
  assert.strictEqual(missing.status, 404);
});

test('最近読んだ: 未照合の本の栞 (pweagle:) は pw_ の札で帯に出る', async () => {
  const mark = { page: 1, pageCount: 3, updatedAt: Date.now(), finished: false };
  const reading = {
    all: () => ({ 'pweagle:e7': mark }),
    get: (key) => (key === 'pweagle:e7' ? mark : null),
  };
  const server = makeServer({ reading });
  const out = await call(server, '/api/recent');
  assert.strictEqual(out.status, 200);
  assert.strictEqual(out.json.items.length, 1);
  assert.strictEqual(out.json.items[0].id, 'pw_e7');
  assert.strictEqual(out.json.items[0].title, '合成 e7');
  assert.strictEqual(out.json.items[0].star, 4);
  assert.strictEqual(out.json.items[0].mark.page, 1);
});
