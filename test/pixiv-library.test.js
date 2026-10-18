'use strict';

// pixiv の所持の台帳 (src/lib/pixiv/library.js)。
// 釘: 投稿 ID ↔ Eagle 項目の往復、索引 (url) との突き合わせ、作者フォルダの結び、
// 網の札への済の印、所持棚の検索と並び、付け直しの候補。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

require('./helpers/stub-electron');

const { PixivLibrary, pidFromUrl, foldName } = require('../src/lib/pixiv/library');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixiv-library-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

let seq = 0;
function fresh(options = {}) {
  seq += 1;
  return new PixivLibrary({ file: path.join(dir, `lib-${seq}.json`), now: () => 1000 + seq, ...options });
}

function entriesOf(rows) {
  // eagle-index の entries の形: '<id>.info' → { meta }
  return new Map(rows.map((row) => [`${row.id}.info`, { meta: { name: '', url: '', folders: [], isDeleted: false, star: 0, tags: [], ...row.meta } }]));
}

test('url から投稿 ID を読む (新旧の形)', () => {
  assert.equal(pidFromUrl('https://www.pixiv.net/artworks/123456789'), '123456789');
  assert.equal(pidFromUrl('https://www.pixiv.net/en/artworks/55'), '55');
  assert.equal(pidFromUrl('https://www.pixiv.net/member_illust.php?mode=medium&illust_id=77'), '77');
  assert.equal(pidFromUrl('https://pixiv.net/i/88'), '88');
  assert.equal(pidFromUrl('https://example.com/x'), '');
  assert.equal(pidFromUrl(''), '');
  assert.equal(foldName(' Ｓｏｍｅ　Name '), 'somename');
});

test('記帳: 投稿 ID ↔ Eagle 項目を両向きに引け、消すと落ちる。書いた物は読み直せる', () => {
  const lib = fresh();
  assert.equal(lib.has('1'), false);
  const row = lib.record({ pid: '1', eagleId: 'E1', userId: '9', userName: '作者', title: '題', tags: ['a', 'b'], ai: false, r18: true, date: '2026-09-18', pages: 3, series: { id: '5', title: 'S', order: 2 } });
  assert.equal(row.addedAt, 1000 + seq);
  assert.equal(lib.has('1'), true);
  assert.equal(lib.eagleIdOf('1'), 'E1');
  assert.equal(lib.pidOfEagle('E1'), '1');
  const again = new PixivLibrary({ file: lib.file });
  assert.deepEqual(again.get('1').tags, ['a', 'b']);
  assert.equal(again.get('1').series.order, 2);
  assert.equal(again.forget('E1'), true);
  assert.equal(again.has('1'), false);
  assert.equal(again.forget('E1'), false);
});

test('索引との突き合わせ: 消えた項目は落ち、url が pixiv の項目は台帳に無くても所持', () => {
  const lib = fresh();
  lib.record({ pid: '1', eagleId: 'E1', title: '一' });
  lib.record({ pid: '2', eagleId: 'E2', title: '二' });
  const entries = entriesOf([
    { id: 'E1', meta: { name: '一', url: 'https://www.pixiv.net/artworks/1' } },
    // E2 は Eagle から消えた
    { id: 'E3', meta: { name: '手で入れた', url: 'https://www.pixiv.net/artworks/3', folders: ['F1'], star: 4 } },
    { id: 'E4', meta: { name: '12345678_p0-古い名前', url: '' } },
    { id: 'E5', meta: { name: '消した', url: 'https://www.pixiv.net/artworks/5', isDeleted: true } },
    { id: 'E6', meta: { name: '別物.pdf', url: 'https://example.com/' } },
  ]);
  const out = lib.reconcile(entries);
  assert.equal(out.dropped, 1, 'E2 が落ちる');
  assert.equal(lib.has('2'), false);
  assert.equal(lib.has('3'), true, '索引の url で所持');
  assert.equal(lib.eagleIdOf('3'), 'E3');
  assert.equal(lib.pidOfEagle('E3'), '3');
  assert.equal(lib.has('5'), false, 'ゴミ箱の物は所持ではない');
  assert.deepEqual(out.legacy.map((l) => [l.eagleId, l.pid]), [['E4', '12345678']], '付け直しの候補');
  // 索引だけの札は名前を題に、作者はフォルダ名から
  const lib2 = fresh({ creatorNameOf: (id) => (id === 'F1' ? '作者F' : '') });
  lib2.reconcile(entries);
  const card = lib2.toGallery('3');
  assert.equal(card.title, '手で入れた');
  assert.equal(card.artists[0].name, '作者F');
  assert.equal(card.star, 4);
  assert.equal(card.owned, true);
  assert.equal(card.kind, 'eagleItem');
});

test('作者フォルダの結び: 台帳が持ち、名前の一致は一つの時だけ', () => {
  const lib = fresh();
  assert.equal(lib.creatorFolder('9'), null);
  lib.bindCreator('9', 'F9', '作者');
  assert.deepEqual(lib.creatorFolder('9'), { folderId: 'F9', name: '作者' });
  const folders = [{ folderId: 'A', name: 'さくしゃ' }, { folderId: 'B', name: 'Some Name' }, { folderId: 'C', name: 'some name' }];
  assert.equal(PixivLibrary.matchCreatorFolder('さくしゃ', folders).folderId, 'A');
  assert.equal(PixivLibrary.matchCreatorFolder('SomeName', folders), null, '二つに当たるなら決めない');
  assert.equal(PixivLibrary.matchCreatorFolder('居ない', folders), null);
  assert.deepEqual(lib.creatorsMatching('さく'), [], '台帳の名乗りだけ');
  assert.deepEqual(lib.creatorsMatching('作'), [{ userId: '9', name: '作者' }]);
});

test('網の札に済の印。pixiv 以外と作者の札には触らない', () => {
  const lib = fresh();
  lib.record({ pid: '1', eagleId: 'E1', title: '一' });
  const out = lib.annotate([
    { id: 'px:1', source: 'pixiv', kind: 'gallery', owned: false },
    { id: 'px:2', source: 'pixiv', kind: 'gallery', owned: false },
    { id: 'pxu:9', source: 'pixiv', kind: 'creator' },
    { id: 'nh:1', source: 'nhentai', owned: false },
  ]);
  assert.equal(out[0].owned, true);
  assert.equal(out[0].eagleId, 'E1');
  assert.equal(out[0].idOwned, true);
  assert.equal(out[1].owned, false);
  assert.equal(out[2].owned, undefined);
  assert.equal(out[3].owned, false);
});

test('所持棚: 語は題・タグ・作者に当たり、並びは新着・題・読了', () => {
  const lib = fresh();
  lib.record({ pid: '1', eagleId: 'E1', title: '青い空', userName: '作者A', tags: ['風景'], addedAt: 100, pages: 1 });
  lib.record({ pid: '2', eagleId: 'E2', title: '赤い花', userName: '作者B', tags: ['花'], addedAt: 300, pages: 5 });
  lib.record({ pid: '3', eagleId: 'E3', title: '白い雲', userName: '作者A', tags: ['風景', '空'], addedAt: 200, pages: 2 });
  const all = lib.search({ query: '', sort: 'added', page: 0, pageSize: 24 });
  assert.deepEqual(all.galleries.map((g) => g.id), ['px:2', 'px:3', 'px:1'], '新着順');
  assert.equal(all.galleries[0].badge, '5p');
  // 題の並びは ICU の日本語照合に従う (機体で順が変わりうるので、同じ照合で組んだ期待と比べる)
  const byTitle = ['白い雲', '青い空'].sort((a, b) => a.localeCompare(b, 'ja'));
  assert.deepEqual(lib.search({ query: '風景', sort: 'title' }).galleries.map((g) => g.title), byTitle);
  assert.deepEqual(lib.search({ query: '作者b' }).galleries.map((g) => g.id), ['px:2'], '作者名 (大小・全角は畳む)');
  // 語は全部当たる物だけ。px:1 は題 (青い空) と タグ (風景) で両方に当たる
  assert.deepEqual(lib.search({ query: '空 風景' }).galleries.map((g) => g.id), ['px:3', 'px:1']);
  assert.deepEqual(lib.search({ query: '花 風景' }).galleries.map((g) => g.id), [], '片方しか当たらない物は出ない');
  const reading = { 'pweagle:E1': { finishedCount: 3, finishedAt: 50 }, 'pweagle:E3': { finishedCount: 1, finishedAt: 90 } };
  assert.deepEqual(lib.search({ sort: 'reread', reading }).galleries.map((g) => g.id), ['px:1', 'px:3', 'px:2']);
  assert.deepEqual(lib.search({ sort: 'finished', reading }).galleries.map((g) => g.id), ['px:3', 'px:1', 'px:2']);
  const paged = lib.search({ query: '', sort: 'added', page: 1, pageSize: 2 });
  assert.equal(paged.total, 3);
  assert.equal(paged.hasNext, false);
  assert.deepEqual(paged.galleries.map((g) => g.id), ['px:1']);
});

test('所持棚の種別 AI: AI 生成の印がある物だけ (R-18 を重ねた語でも)', () => {
  const lib = fresh();
  lib.record({ pid: '1', eagleId: 'E1', title: '一', ai: true, addedAt: 100 });
  lib.record({ pid: '2', eagleId: 'E2', title: '二', ai: false, addedAt: 200 });
  lib.record({ pid: '3', eagleId: 'E3', title: '三', addedAt: 300 });
  assert.deepEqual(lib.search({ type: 'ai' }).galleries.map((g) => g.id), ['px:1']);
  assert.deepEqual(lib.search({ type: 'ai-r18' }).galleries.map((g) => g.id), ['px:1']);
  assert.equal(lib.search({ type: '' }).total, 3);
  assert.equal(lib.search({ type: 'manga' }).total, 3, '漫画の札は所持棚では絞らない (今まで通り)');
});

test('壊れた台帳や無い台帳は空から始まり、投げない', () => {
  const file = path.join(dir, 'broken.json');
  fs.writeFileSync(file, '{not json');
  const lib = new PixivLibrary({ file });
  assert.equal(lib.has('1'), false);
  assert.deepEqual(lib.stats(), { works: 0, indexed: 0, creators: 0 });
  const none = new PixivLibrary({ file: path.join(dir, 'missing.json') });
  assert.equal(none.eagleIdOf('1'), null);
});
