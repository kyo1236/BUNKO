'use strict';

// LAN サーバー (lan-server.js) の pawchive 棚の並び・絞りの固定。
// electron は偽物に差し替え、pawItems / memoContent / creatorFolders を
// 合成データに向けてから servePawList / servePawFolders を直接呼ぶ。
// 机上版 (paw-library.js) との意図的な差 (★絞り・向き・並びの種類) も固定する。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { installStub } = require('./helpers/stub-electron-2.js');
installStub();

const { LanServer, makeToken, sameToken, readCookie } = require('../src/lib/lan-server.js');
const pawLibrary = require('../src/lib/paw-library.js');

// 合成データ: 作者 f1 (あ作者) と f2 (い作者)、日付・星・題名の散り
const ITEMS = [
  { eagleId: 'e1', name: 'px1', title: 'いちご', creator: 'あ作者', creatorFolderId: 'f1', date: '2024-05-01', star: 5, pageCount: 3 },
  { eagleId: 'e2', name: 'px2', title: 'りんご', creator: 'あ作者', creatorFolderId: 'f1', date: '2024-06-01', star: 0, pageCount: 3 },
  { eagleId: 'e3', name: 'px3', title: 'みかん', creator: 'い作者', creatorFolderId: 'f2', date: '', star: 3, pageCount: 3 },
  { eagleId: 'e4', name: 'px4', title: 'ぶどう', creator: 'い作者', creatorFolderId: 'f2', date: '2024-05-01', star: 1, pageCount: 3 },
];
const FOLDERS = [
  { folderId: 'f1', name: 'あ作者', itemCount: 2 },
  { folderId: 'f2', name: 'い作者', itemCount: 2 },
];

// creatorFolders は folderName の逆引きと作者棚が見る。モジュールごと差し替える
const originalCreatorFolders = pawLibrary.creatorFolders;
pawLibrary.creatorFolders = () => FOLDERS;
test.after(() => { pawLibrary.creatorFolders = originalCreatorFolders; });

// marks を渡さない呼び手 (summary を持たない栞) でも棚は立つ
function makeServer(marks) {
  const server = new LanServer({
    catalog: {},
    reading: marks ? { all: () => ({}), summary: () => marks } : { all: () => ({}) },
    settings: () => ({}),
    saveSettings() {},
  });
  server.pawItems = () => ITEMS;
  server.memoContent = () => 'dummy'; // 実体確認は常に「ある」扱い (fs を触らない)
  return server;
}

// servePawList を URL 語で呼び、書き出された JSON を受け取る
function call(server, qs) {
  let out = null;
  const res = { writeHead() {}, end(body) { out = JSON.parse(String(body)); } };
  server.servePawList(res, new URL('http://x/api/list?src=paw&' + qs));
  return out;
}
const ids = (out) => out.items.map((item) => item.id);

test('作品一覧: 既定は投稿日の新しい順、同日は題名順、日付なしは末尾', () => {
  const server = makeServer();
  // e2 (06-01) → e1/e4 (05-01 同着、いちご<ぶどう) → e3 (日付なし)
  assert.deepStrictEqual(ids(call(server, 'q=px')), ['pw_e2', 'pw_e1', 'pw_e4', 'pw_e3']);
});

test('作品一覧: dir=asc は同点解決も含めて並び全体を裏返す', () => {
  const server = makeServer();
  assert.deepStrictEqual(ids(call(server, 'q=px&dir=asc')), ['pw_e3', 'pw_e4', 'pw_e1', 'pw_e2']);
});

test('作品一覧: sort=star は星降順 → 日付降順 → 題名順', () => {
  const server = makeServer();
  assert.deepStrictEqual(ids(call(server, 'q=px&sort=star')), ['pw_e1', 'pw_e3', 'pw_e4', 'pw_e2']);
});

test('作品一覧: sort=title は日本語の照合順', () => {
  const server = makeServer();
  assert.deepStrictEqual(ids(call(server, 'q=px&sort=title')), ['pw_e1', 'pw_e4', 'pw_e3', 'pw_e2']);
});

test('作品一覧: sort=random は同じ seed なら同じ並び', () => {
  const server = makeServer();
  const first = ids(call(server, 'q=px&sort=random&seed=42'));
  const second = ids(call(server, 'q=px&sort=random&seed=42'));
  assert.deepStrictEqual(first, second);
  assert.deepStrictEqual([...first].sort(), ['pw_e1', 'pw_e2', 'pw_e3', 'pw_e4']);
});

// 再読の棚。栞の鍵は机上と同じ顔 (pweagle:<eagleId>) で渡る
test('作品一覧: sort=reread / finished は栞の要約で並ぶ (許容 sort が増えた)', () => {
  const marks = {
    'pweagle:e1': { finishedCount: 2, finishedAt: 500, updatedAt: 500 },
    'pweagle:e3': { finishedCount: 2, finishedAt: 900, updatedAt: 900 },
    'pweagle:e4': { finishedCount: 1, finishedAt: 100, updatedAt: 100 },
  };
  const server = makeServer(marks);
  // 回数 2 の同着は最終読了日の新しい順、読了の無い e2 は末尾
  assert.deepStrictEqual(ids(call(server, 'q=px&sort=reread')), ['pw_e3', 'pw_e1', 'pw_e4', 'pw_e2']);
  assert.deepStrictEqual(ids(call(server, 'q=px&sort=finished')), ['pw_e3', 'pw_e1', 'pw_e4', 'pw_e2']);
  // 栞が空 (summary を持たない呼び手) でも既定に崩れず並ぶ
  assert.strictEqual(ids(call(makeServer(), 'q=px&sort=reread')).length, 4);
});

test('作品一覧: 不正な sort は既定 (投稿日順) に落ちる', () => {
  const server = makeServer();
  assert.deepStrictEqual(ids(call(server, 'q=px&sort=bogus')), ids(call(server, 'q=px')));
});

test('作品一覧: minStar は星の下限で作品を絞る', () => {
  const server = makeServer();
  assert.deepStrictEqual(ids(call(server, 'q=px&minStar=3')), ['pw_e1', 'pw_e3']);
});

test('作品一覧: folder:<id> は作者の棚で、見出し用の作者名が付く', () => {
  const server = makeServer();
  const out = call(server, 'q=' + encodeURIComponent('folder:f1'));
  assert.deepStrictEqual(ids(out), ['pw_e2', 'pw_e1']);
  assert.strictEqual(out.folderName, 'あ作者');
});

test('作品一覧: 語は題名・作者・ファイル名の畳んだ字面に当てる', () => {
  const server = makeServer();
  assert.deepStrictEqual(ids(call(server, 'q=' + encodeURIComponent('りんご'))), ['pw_e2']);
});

test('作品一覧: ひらがなの語がカタカナの題名にも当たる (机上・候補と同じ畳み方)', () => {
  const server = makeServer();
  server.pawItems = () => [
    { eagleId: 'k1', name: 'px9', title: 'リンゴ', creator: 'カタ作者', creatorFolderId: 'f1', date: '2024-07-01', star: 0, pageCount: 3 },
  ];
  assert.deepStrictEqual(ids(call(server, 'q=' + encodeURIComponent('りんご'))), ['pw_k1']);
  assert.deepStrictEqual(ids(call(server, 'q=' + encodeURIComponent('かた'))), ['pw_k1']);
  // カタカナの語はこれまでどおり当たる
  assert.deepStrictEqual(ids(call(server, 'q=' + encodeURIComponent('リンゴ'))), ['pw_k1']);
});

test('作品一覧: 札は paw の顔 (pw_ 接頭辞、作者は folder: 潜り先付き)', () => {
  const server = makeServer();
  const card = call(server, 'q=px').items[0];
  assert.deepStrictEqual(card, {
    id: 'pw_e2',
    title: 'りんご',
    star: 0,
    // 源泉の印 (作者根には pixiv の本も同居する。紙の facts に一行出す)
    source: 'pawchive',
    type: '',
    artists: [{ name: 'あ作者', label: 'あ作者', token: 'folder:f1' }],
    groups: [],
    series: [],
    characters: [],
    tags: [],
    pageCount: 3,
    addedDate: '2024-06-01',
    publishedDate: '2024-06-01',
  });
});

test('作者棚: 既定は「一番新しい作品の日付」の降順', () => {
  const server = makeServer();
  // f1 の最新 06-01 > f2 の最新 05-01
  assert.deepStrictEqual(ids(call(server, 'q=')), ['pwf_f1', 'pwf_f2']);
});

test('作者棚: dir=asc / sort=title / sort=random も効く', () => {
  const server = makeServer();
  assert.deepStrictEqual(ids(call(server, 'q=&dir=asc')), ['pwf_f2', 'pwf_f1']);
  assert.deepStrictEqual(ids(call(server, 'q=&sort=title')), ['pwf_f1', 'pwf_f2']);
  assert.deepStrictEqual(ids(call(server, 'q=&sort=random&seed=42')), ['pwf_f2', 'pwf_f1']);
});

test('作者棚: minStar は「その星以上の作品を持つ作者」だけ残す (LAN 側だけの絞り)', () => {
  const server = makeServer();
  assert.deepStrictEqual(ids(call(server, 'q=&minStar=3')), ['pwf_f1', 'pwf_f2']);
  assert.deepStrictEqual(ids(call(server, 'q=&minStar=4')), ['pwf_f1']);
});

// --- 机上版 (paw-library.js) との意図的な差の固定 -------------------------
// 挙動を丸ごと動かすには実ライブラリの走査が要るので、ここはソースの形で固定する

const pawLibrarySource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'lib', 'paw-library.js'), 'utf8',
);
const lanServerSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'lib', 'lan-server.js'), 'utf8',
);

test('差: 机上版の作者棚は minStar を札に効かせない、LAN 側は効かせる', () => {
  // 机上版 creatorResult は minStar に触れない (「星の下限はアイテムの印」の方針)
  const creatorResult = pawLibrarySource.match(/function creatorResult\([\s\S]*?\n\}/);
  assert.ok(creatorResult, 'creatorResult が見つからない');
  assert.ok(!creatorResult[0].includes('minStar'));
  // LAN 側 servePawFolders は starred 集合で作者を絞る
  const servePawFolders = lanServerSource.match(/\n  servePawFolders\(res, page[\s\S]*?\n  \}/);
  assert.ok(servePawFolders, 'servePawFolders が見つからない');
  assert.ok(servePawFolders[0].includes('starred.has(f.folderId)'));
});

test('差: 並びの向き (dir) と star/random 並びは LAN 側だけが持つ', () => {
  // 机上版の search / creatorResult に向きの概念は無い
  assert.ok(!pawLibrarySource.includes('sortDir'));
  assert.ok(!pawLibrarySource.includes("dir === 'asc'"));
  // 机上版の SORTS (栞を見ない並び) は added / title の二種のみ。
  // reread / finished は両側とも別関数 (readingComparator) が持つ
  const sorts = pawLibrarySource.match(/const SORTS = \{[\s\S]*?\n\};/);
  assert.ok(sorts, 'SORTS が見つからない');
  assert.deepStrictEqual([...sorts[0].matchAll(/^  (\w+)\(/gm)].map((m) => m[1]), ['added', 'title']);
  // LAN 側は added / published / title / star / random に再読の棚の二つを足して受ける
  const lanSorts = lanServerSource.match(/const LIST_SORTS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(lanSorts, 'LIST_SORTS が見つからない');
  assert.deepStrictEqual(
    [...lanSorts[1].matchAll(/'([^']+)'/g)].map((m) => m[1]),
    ['added', 'published', 'title', 'star', 'random', 'reread', 'finished'],
  );
});

test('差: 同着の解決が違う (机上版は Eagle 更新時刻、LAN 側は題名順)', () => {
  const sorts = pawLibrarySource.match(/const SORTS = \{[\s\S]*?\n\};/);
  assert.ok(sorts[0].includes('return b.mtime - a.mtime;'));
  // LAN 側の added の同着は localeCompare (上の servePawList のテストが挙動側を固定)
  const servePawList = lanServerSource.match(/\n  servePawList\(res, url\) \{[\s\S]*?\n  \}/);
  assert.ok(servePawList, 'servePawList が見つからない');
  assert.ok(servePawList[0].includes("String(a.title).localeCompare(String(b.title), 'ja')"));
});

// --- ついで: 純関数の入出力 (合言葉・クッキー) ---------------------------

test('makeToken は 32 桁の16進、sameToken は同値だけ通す', () => {
  const token = makeToken();
  assert.match(token, /^[0-9a-f]{32}$/);
  assert.strictEqual(sameToken(token, token), true);
  assert.strictEqual(sameToken(token, makeToken()), false);
  assert.strictEqual(sameToken('', ''), false); // 空どうしは不一致扱い
});

test('readCookie は名前一致の値だけ返す', () => {
  assert.strictEqual(readCookie('a=1; bunko_lan=abc; b=2', 'bunko_lan'), 'abc');
  assert.strictEqual(readCookie('a=1', 'bunko_lan'), '');
});
