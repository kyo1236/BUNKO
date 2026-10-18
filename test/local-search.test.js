'use strict';

// ローカル検索 (catalog.searchLibrary) の絞り込みと並び順の固定。
// electron は偽物に差し替え (userData は一時ディレクトリ)、sql.js の
// 空の台帳に合成データを流し込んでから引く。実データ・実設定には触れない。

const test = require('node:test');
const assert = require('node:assert');

const { installStub } = require('./helpers/stub-electron-2.js');
installStub();

const { Catalog, tagNameKey, numericGalleryId } = require('../src/lib/catalog.js');

let catalog = null;

test.before(async () => {
  catalog = new Catalog();
  await catalog.init();
  const db = catalog.db;
  const gallery = (id, title, type, pub, added) => db.run(
    'INSERT INTO galleries (id,title,type,language,language_local,page_count,added_date,published_date,url,fetched_at)'
    + ' VALUES (?,?,?,?,?,?,?,?,?,?)',
    [id, title, type, 'japanese', '日本語', 10, added, pub, '', Date.now()],
  );
  const item = (file, galleryId, title, star, addedAt) => db.run(
    'INSERT INTO items (source,path,gallery_id,title,title_key,updated_at,star,added_at) VALUES (?,?,?,?,?,?,?,?)',
    ['eagle', file, galleryId, title, title.toLowerCase(), Date.now(), star, addedAt],
  );
  const tag = (galleryId, type, name) => db.run(
    'INSERT INTO gallery_tags (gallery_id,type,name) VALUES (?,?,?)', [galleryId, type, name],
  );
  // 三冊: 追加時刻 (items.added_at) と公開日・星・題名をばらす
  gallery(1, 'Alpha Adventure', 'doujinshi', '2024-01-10', '2024-02-01');
  gallery(2, 'beta world', 'manga', '2024-03-05', '2024-03-06');
  gallery(3, 'Gamma Alpha', 'doujinshi', '2023-12-01', '2023-12-02');
  item('p1', 1, 'Alpha Adventure', 5, 1000000);
  item('p2', 2, 'beta world', 3, 3000000);
  item('p3', 3, 'Gamma Alpha', 0, 2000000);
  tag(1, 'artist', 'alice');
  tag(3, 'artist', 'alice');
  tag(2, 'artist', 'bob');
  tag(1, 'tag', 'foo');
  catalog.rebuildMemory();
});

test.after(() => {
  // init (辞書ラベルの取り込み) が仕込む書き出しの予約を止める
  if (catalog && catalog.persistTimer) clearTimeout(catalog.persistTimer);
});

const ids = (result) => result.galleries.map((g) => g.id);

test('台帳が無ければ空の結果 (形だけ返す)', () => {
  const fresh = new Catalog();
  assert.deepStrictEqual(fresh.searchLibrary({ query: 'x' }), {
    total: 0, page: 0, pageSize: 24, query: 'x', interpreted: [], source: 'library', galleries: [],
  });
});

test('既定の並びは追加時刻 (Eagle に保存した日時) の降順', () => {
  assert.deepStrictEqual(ids(catalog.searchLibrary({})), [2, 3, 1]);
});

test('sortDir=asc は ORDER BY を同点解決の列ごと裏返す', () => {
  assert.deepStrictEqual(ids(catalog.searchLibrary({ sortDir: 'asc' })), [1, 3, 2]);
});

test('sort=title は題名の昇順 (大小無視)', () => {
  assert.deepStrictEqual(ids(catalog.searchLibrary({ sort: 'title' })), [1, 2, 3]);
});

test('sort=star は紐付くアイテムの最高評価の降順', () => {
  assert.deepStrictEqual(ids(catalog.searchLibrary({ sort: 'star' })), [1, 2, 3]);
});

test('sort=published は公開日の降順', () => {
  assert.deepStrictEqual(ids(catalog.searchLibrary({ sort: 'published' })), [2, 1, 3]);
});

test('sort=random は同じ seed なら同じ並びで揺れない', () => {
  const first = ids(catalog.searchLibrary({ sort: 'random', seed: 42 }));
  const second = ids(catalog.searchLibrary({ sort: 'random', seed: 42 }));
  assert.deepStrictEqual(first, second);
  assert.deepStrictEqual([...first].sort(), [1, 2, 3]);
});

// 栞 (reading.json) は台帳に無い。並びに使う要約は呼び手が注ぐ約束なので、
// ここでは偽の要約 (id → { finishedCount, finishedAt, updatedAt }) を渡して固定する
test('sort=reread は読了回数の降順、同着は最終読了日の降順', () => {
  const reading = {
    1: { finishedCount: 0, finishedAt: 0, updatedAt: 100 },
    2: { finishedCount: 2, finishedAt: 500, updatedAt: 500 },
    3: { finishedCount: 2, finishedAt: 900, updatedAt: 900 },
  };
  assert.deepStrictEqual(ids(catalog.searchLibrary({ sort: 'reread', reading })), [3, 2, 1]);
  // 読了回数が全部 0 のうち (積み始めた当日) でも壊れない。同着は題名順に落ちる
  assert.deepStrictEqual(ids(catalog.searchLibrary({ sort: 'reread' })), [1, 2, 3]);
});

test('sort=finished は最終読了日の降順、未読了は末尾', () => {
  const reading = {
    1: { finishedCount: 1, finishedAt: 900, updatedAt: 900 },
    3: { finishedCount: 5, finishedAt: 400, updatedAt: 400 },
  };
  const result = catalog.searchLibrary({ sort: 'finished', reading });
  assert.deepStrictEqual(ids(result), [1, 3, 2]);
  assert.strictEqual(result.total, 3);
});

test('minStar は星の下限。結果の星は絞りに使った値のまま札に載る', () => {
  const result = catalog.searchLibrary({ minStar: 3 });
  assert.deepStrictEqual(ids(result), [2, 1]);
  assert.strictEqual(result.total, 2);
  assert.deepStrictEqual(result.galleries.map((g) => g.star), [3, 5]);
});

test('フリーワードは題名への部分一致 (並びは既定のまま)', () => {
  const result = catalog.searchLibrary({ query: 'alpha' });
  assert.deepStrictEqual(ids(result), [3, 1]);
  assert.strictEqual(result.total, 2);
});

test('先頭 - のフリーワードは題名からの除外', () => {
  assert.deepStrictEqual(ids(catalog.searchLibrary({ query: '-alpha' })), [2]);
});

test('型付き語 (artist:...) はタグ表への一致、負は除外', () => {
  assert.deepStrictEqual(ids(catalog.searchLibrary({ query: 'artist:alice' })), [3, 1]);
  assert.deepStrictEqual(ids(catalog.searchLibrary({ query: '-artist:alice' })), [2]);
});

test('type は種別の一致で絞る', () => {
  assert.deepStrictEqual(ids(catalog.searchLibrary({ type: 'doujinshi' })), [3, 1]);
});

test('頁切りは pageSize/page、total は絞り込み後の全件数', () => {
  const result = catalog.searchLibrary({ pageSize: 2, page: 1 });
  assert.deepStrictEqual(ids(result), [1]);
  assert.strictEqual(result.total, 3);
  assert.strictEqual(result.pageSize, 2);
  assert.strictEqual(result.page, 1);
});

// --- 検索の下ごしらえに使う純関数 ---------------------------------------

test('tagNameKey はタグ名を突き合わせ用の字面に畳む', () => {
  assert.strictEqual(tagNameKey(' Alice_Bob '), 'alice bob');
  assert.strictEqual(tagNameKey('ＡＬＩＣＥ'), 'alice'); // NFKC で全角も畳む
  assert.strictEqual(tagNameKey(''), '');
});

test('numericGalleryId は数字の ID だけ受け付ける', () => {
  assert.strictEqual(numericGalleryId('123'), 123);
  assert.strictEqual(numericGalleryId(456), 456);
  assert.strictEqual(numericGalleryId('abc'), null);
  assert.strictEqual(numericGalleryId(''), null);
});
