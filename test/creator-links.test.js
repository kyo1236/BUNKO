'use strict';

// hitomi / nhentai の名乗りと作者の結び (src/lib/creator-links.js、§6-3 の一行の形)。
// 押さえるのは:
//   行は消さない (外す・「違う」は revokedAt の立った行)、同じ組の一番新しい行が今の答え
//   書き込みは控えの番人 (state-file) を通る: 写しでは書かない
//   写しは同期が差し替えた一枚を読み直す
// 口 ('home') の読み取り専用の線引きもここで見る (結びだけ塞ぎ、作者頁と網は通す)。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const stateFile = require('../src/lib/state-file');
const { CreatorLinks, linkKey } = require('../src/lib/creator-links');
const { registerHomeIpc, WRITE_ACTIONS } = require('../src/main/ipc/home-ipc');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunko-creator-links-'));
test.after(() => {
  stateFile.resetForTest();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('結ぶ・外す・退ける: 行は消さず、一番新しい行が今の答え', () => {
  stateFile.resetForTest();
  const file = path.join(dir, 'a.json');
  let clock = Date.parse('2026-09-23T00:00:00Z');
  const links = new CreatorLinks({ file, now: () => clock });
  assert.ok(links.link({ personId: 'F1', source: 'hitomi', name: 'sample artist', by: 'Home の詳細' }));
  assert.equal(links.state('F1', 'hitomi', 'sample artist'), 'linked');
  assert.equal(links.linked('F1').length, 1);
  // 同じ組を二度結んでも行は増えない
  links.link({ personId: 'F1', source: 'hitomi', name: 'sample artist' });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).rows.length, 1);

  clock += 1000;
  links.revoke({ personId: 'F1', source: 'hitomi', name: 'sample artist' });
  assert.equal(links.state('F1', 'hitomi', 'sample artist'), 'rejected');
  assert.equal(links.linked('F1').length, 0);
  assert.ok(links.rejectedKeys().has(linkKey('F1', 'hitomi', 'sample artist')));
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.version, 1);
  assert.equal(saved.rows.length, 1, '外しても行は消さない');
  assert.equal(saved.rows[0].evidence, 'user-confirmed');
  assert.ok(saved.rows[0].revokedAt);

  // 結んでいない候補を「違う」と退けた時も、退けた印の行が残る
  links.revoke({ personId: 'h:lonely', source: 'nhentai', name: 'lonely' });
  assert.equal(links.state('h:lonely', 'nhentai', 'lonely'), 'rejected');

  // 退けた組を結び直すと新しい行を足す (前の判断の行は残る)
  clock += 1000;
  links.link({ personId: 'F1', source: 'hitomi', name: 'sample artist' });
  assert.equal(links.state('F1', 'hitomi', 'sample artist'), 'linked');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).rows.length, 3);

  // 読み直しても同じ答え
  const again = new CreatorLinks({ file });
  assert.equal(again.state('F1', 'hitomi', 'sample artist'), 'linked');
  assert.equal(again.state('h:lonely', 'nhentai', 'lonely'), 'rejected');
});

test('作者フォルダの無い人の pixiv と Pawchive はここに置く。作者の★も (0 で外す・読み直しても残る)', () => {
  const file = path.join(dir, 'ratings.json');
  const links = new CreatorLinks({ file, now: () => 1700000000000 });
  assert.ok(links.link({ personId: 'h:lonely', source: 'pixiv', name: '123' }));
  assert.ok(links.link({ personId: 'c:circle', source: 'pawchive', name: 'fanbox:1' }));
  assert.equal(links.link({ personId: 'h:lonely', source: 'x', name: '1' }), null, '知らない源泉は書かない');
  assert.equal(links.linked().length, 2);
  assert.equal(links.rate('c:circle', 4), true);
  assert.equal(links.rate('h:lonely', 6), false, '★は 0〜5');
  assert.deepEqual({ ...links.ratingsMap() }, { 'c:circle': 4 });
  const again = new CreatorLinks({ file });
  assert.equal(again.rating('c:circle'), 4);
  assert.equal(again.state('h:lonely', 'pixiv', '123'), 'linked');
  assert.equal(again.rate('c:circle', 0), true);
  assert.equal(new CreatorLinks({ file }).rating('c:circle'), 0, '0 で外す');
  // 突き合わせの候補: 足しても結ばない。答えた組 (結んだ・退けた) は候補から外れ、同じ組は二度足さない
  const fresh = new CreatorLinks({ file });
  assert.equal(fresh.suggest([
    { personId: 'h:lonely', source: 'pixiv', name: '123', note: 'n' },
    { personId: 'F1', source: 'pixiv', name: '9' },
    { personId: 'F1', source: 'pixiv', name: '9' },
    { personId: 'F1', source: 'x', name: '1' },
  ]), 1, '結び済みの組と重なり・知らない源泉は足さない');
  assert.equal(fresh.state('F1', 'pixiv', '9'), null, '候補は結びではない');
  assert.equal(new CreatorLinks({ file }).suggestions().length, 1, '書いて読み直しても残る');
  fresh.revoke({ personId: 'F1', source: 'pixiv', name: '9' });
  assert.equal(fresh.suggestions().length, 0);
});

test('見出しの表紙: 人の鍵 → 本の id。読み直しても残り、空で外す。名前や★と同じ一枚に書く', () => {
  const file = path.join(dir, 'covers.json');
  const links = new CreatorLinks({ file, now: () => 1700000000000 });
  assert.equal(links.cover('F1'), '', '決めていなければ空 (自動の顔)');
  assert.equal(links.setCover('F1', 'pweagle:ABC'), true);
  assert.equal(links.setCover('c:circle', '123456'), true);
  assert.equal(links.setCover('', 'pweagle:X'), false, '人の鍵が無ければ書かない');
  assert.equal(links.setCover('F1', 'x'.repeat(201)), false, '長すぎる id は書かない');
  assert.deepEqual({ ...links.coversMap() }, { F1: 'pweagle:ABC', 'c:circle': '123456' });
  const again = new CreatorLinks({ file });
  assert.equal(again.cover('F1'), 'pweagle:ABC', '読み直しても残る');
  const version = again.version();
  assert.equal(again.setCover('F1', ''), true);
  assert.ok(again.version() > version, '書いたら版が進む (Home が組み直しを知る)');
  assert.equal(new CreatorLinks({ file }).cover('F1'), '', '空で外す');
  assert.equal(new CreatorLinks({ file }).cover('c:circle'), '123456', 'ほかの人の表紙はそのまま');
  again.setDisplayName('F1', '決めた名前');
  again.rate('F1', 3);
  again.setCover('F1', 'px:1');
  const reread = new CreatorLinks({ file });
  assert.equal(reread.displayName('F1'), '決めた名前', '表紙を書いても名前は消えない');
  assert.equal(reread.rating('F1'), 3);
  assert.equal(reread.cover('F1'), 'px:1');
});

test('写しは書かない (控えの番人)。同期が差し替えた一枚は読み直す', () => {
  const file = path.join(dir, 'mirror.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, rows: [{ personId: 'F1', source: 'hitomi', name: 'old', at: 'x' }] }));
  stateFile.setRole({ readOnly: true });
  let clock = 0;
  const links = new CreatorLinks({ file, now: () => clock });
  assert.equal(links.state('F1', 'hitomi', 'old'), 'linked');
  const before = fs.readFileSync(file, 'utf8');
  links.link({ personId: 'F1', source: 'hitomi', name: 'new' });
  assert.equal(fs.readFileSync(file, 'utf8'), before, '写しは配られた控えを書き返さない');
  // 母艦の同期が新しい一枚を運んできた
  const version = links.version();
  fs.writeFileSync(file, JSON.stringify({ version: 1, rows: [{ personId: 'F2', source: 'nhentai', name: 'fresh', at: 'y' }] }));
  clock += 10 * 1000;
  assert.equal(links.state('F2', 'nhentai', 'fresh'), 'linked');
  assert.ok(links.version() > version, '読み直したら版が進む (Home が組み直しを知る)');
  stateFile.resetForTest();
});

function fakeIpc() {
  const handlers = new Map();
  return {
    handlers,
    handle: (channel, handler) => handlers.set(channel, handler),
    removeHandler: (channel) => handlers.delete(channel),
  };
}

test('home の口: 写しでは結び (link) だけ断り、作者頁と網は通す', async () => {
  const ipc = fakeIpc();
  const called = [];
  const home = {
    author: async (request) => { called.push(['author', request]); return { author: null, books: [] }; },
    hitomiWorks: async (request) => { called.push(['hitomi', request]); return { works: [] }; },
    webWorks: async (request) => { called.push(['web', request]); return { works: [] }; },
    link: async (request) => { called.push(['link', request]); return { ok: true }; },
    cover: async (request) => { called.push(['cover', request]); return { ok: true }; },
  };
  registerHomeIpc({
    ipcMain: ipc, whenCatalog: async () => {}, readOnly: true, READ_ONLY_ERROR: '読み取り専用モードのため実行できません',
    getHomeAuthors: () => home,
  });
  const handler = ipc.handlers.get('home');
  assert.ok(handler);
  assert.deepEqual([...WRITE_ACTIONS], ['link', 'rate', 'suggest', 'origin', 'undo', 'rename', 'cover']);
  await assert.rejects(handler({}, { action: 'rename', id: 'home:f:F1', name: 'x' }), /読み取り専用/, '名前も写しでは決めない');
  await assert.rejects(handler({}, { action: 'cover', id: 'home:f:F1', cover: 'pweagle:A' }), /読み取り専用/, '表紙も写しでは選ばない');
  await assert.rejects(handler({}, { action: 'undo', steps: [{ k: 'rating', personId: 'F1', star: 0 }] }), /読み取り専用/, '元に戻すも写しでは書かない');
  await assert.rejects(handler({}, { action: 'suggest', rows: [] }), /読み取り専用/, '突き合わせの候補も写しでは足さない');
  await assert.rejects(handler({}, { action: 'link', id: 'home:f:F1', site: 'hitomi', op: 'save', url: 'u' }), /読み取り専用/);
  await assert.rejects(handler({}, { action: 'rate', id: 'home:f:F1', star: 3 }), /読み取り専用/, '作者の★も写しでは付けない');
  assert.deepEqual(called, [], '断った口は母屋の結びまで届かない');
  await handler({}, { action: 'author', query: '@見本' });
  await handler({}, { action: 'hitomi', id: 'home:h:x' });
  await handler({}, { action: 'web', id: 'home:f:F1', site: 'pixiv' });
  assert.deepEqual(called.map(([name]) => name), ['author', 'hitomi', 'web']);
  assert.deepEqual(called[2][1], { id: 'home:f:F1', site: 'pixiv' }, '網の作品は写しでも引ける (読むだけ)');
  await assert.rejects(handler({}, { action: 'unknown' }), /知らない action/);

  const writer = fakeIpc();
  registerHomeIpc({ ipcMain: writer, whenCatalog: async () => {}, readOnly: false, READ_ONLY_ERROR: 'x', getHomeAuthors: () => home });
  assert.deepEqual(await writer.handlers.get('home')({}, { action: 'link', id: 'home:f:F1', site: 'hitomi', op: 'save', url: 'u' }), { ok: true });
  called.length = 0;
  await writer.handlers.get('home')({}, { action: 'cover', id: 'home:f:F1', cover: 'pweagle:A' });
  await writer.handlers.get('home')({}, { action: 'cover', id: 'home:f:F1', cover: { bad: true } });
  assert.deepEqual(called, [['cover', { id: 'home:f:F1', cover: 'pweagle:A' }], ['cover', { id: 'home:f:F1', cover: '' }]],
    '表紙は母艦なら通す (字でない値は空 = 自動に戻す)');
});
