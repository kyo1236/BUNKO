'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { installStub } = require('./helpers/stub-electron-2.js');

installStub();
const { Catalog } = require('../src/lib/catalog.js');

async function syntheticCatalog(count = 80) {
  const catalog = new Catalog();
  await catalog.init();
  if (catalog.persistTimer) clearTimeout(catalog.persistTimer);
  catalog.db.run('BEGIN');
  for (let id = 1; id <= count; id += 1) {
    const title = id % 5 ? `book ${id}` : `magic book ${id}`;
    catalog.db.run(
      'INSERT INTO galleries (id,title,type,language,language_local,page_count,added_date,published_date,url,fetched_at)'
        + ' VALUES (?,?,?,?,?,?,?,?,?,?)',
      [id, title, id % 2 ? 'doujinshi' : 'manga', 'japanese', '日本語', id, '2026-01-01', '2025-01-01', '', 1],
    );
    catalog.db.run(
      'INSERT INTO items (source,path,gallery_id,title,title_key,updated_at,star,added_at) VALUES (?,?,?,?,?,?,?,?)',
      ['eagle', `Z:\\missing\\same-${Math.ceil(id / 2)}.info#${id}`, id, title, title, 1, id % 6, id],
    );
    catalog.db.run('INSERT INTO gallery_tags (gallery_id,type,name) VALUES (?,?,?)', [id, 'artist', `artist-${id % 4}`]);
    catalog.db.run('INSERT INTO gallery_tags (gallery_id,type,name) VALUES (?,?,?)', [id, 'tag', id % 3 ? 'color' : 'mono']);
  }
  catalog.db.run('COMMIT');
  return catalog;
}

test('検索1ページのメタデータ取得はページ件数に比例したSQLを発行しない', async () => {
  const catalog = await syntheticCatalog();
  let queries = 0;
  const original = catalog.queryRows;
  catalog.queryRows = function counted(...args) {
    queries += 1;
    return original.apply(this, args);
  };
  const result = catalog.searchLibrary({ pageSize: 24 });
  assert.strictEqual(result.galleries.length, 24);
  assert.ok(queries <= 6, `SQLが${queries}本発行された`);
  assert.deepStrictEqual(result.galleries[0].artists, [{ type: 'artist', name: 'artist-0', negative: false }]);
  assert.deepStrictEqual(result.galleries[0].tags, [{ type: 'tag', name: 'color', negative: false }]);
});

test('rebuildMemoryは同じ実体パスの存在確認を一度だけ行う', async () => {
  const catalog = await syntheticCatalog(20);
  const originalExists = fs.existsSync;
  let checks = 0;
  fs.existsSync = (value) => {
    if (String(value).includes('Z:\\missing')) checks += 1;
    return false;
  };
  try {
    catalog.rebuildMemory();
  } finally {
    fs.existsSync = originalExists;
  }
  assert.ok(checks <= 10, `同じパスを含め${checks}回確認した`);
});

// 残りの数え上げが、目標を組む側と同じ答えを返すこと (項目 4-4)。
// 数えるだけの SQL に替えたので、条件がずれると「残り 0 なのに終わらない」になる
test('照合の残りは、目標を組んだ数と一致する', async () => {
  const { Catalog } = require('../src/lib/catalog.js');
  const catalog = new Catalog({ dbPath: ':memory:' });
  await catalog.init();
  const now = Date.now();
  catalog.db.run("INSERT INTO galleries (id, title, fetched_at) VALUES (9, 'g', ?)", [now]);
  const rows = [
    ['D:/lib/images/a1.info', 'title a', null],   // 未記録 → 残り
    ['D:/lib/images/a2.info', 'title b', 9],      // ID から引けている → 出番なし
    ['D:/lib/images/a3.info', 'title c', null],   // matched を記録 → 済
    ['D:/lib/images/a4.info', 'title d', null],   // none で古い → 残り
    ['D:/lib/images/a5.info', '', null],          // 題が無い → 対象外
  ];
  for (const [p, title, gid] of rows) {
    catalog.db.run(
      "INSERT INTO items (source, path, gallery_id, title, updated_at) VALUES ('eagle', ?, ?, ?, ?)",
      [p, gid, title, now],
    );
  }
  catalog.db.run(
    "INSERT INTO title_matches (eagle_id, status, last_attempt) VALUES ('a3', 'matched', ?)", [now],
  );
  catalog.db.run(
    "INSERT INTO title_matches (eagle_id, status, last_attempt) VALUES ('a4', 'none', 0)",
  );

  catalog.titleMatchPending = null;
  const built = catalog.pendingTitleMatchTargets().length;
  const counted = catalog.pendingTitleMatchCount();
  assert.strictEqual(counted, built, '数えるだけの道と、組む道が同じ答えを返す');
  assert.strictEqual(counted, 2, 'a1 と a4 の 2 件');
});

test('typed pixiv author names reuse display labels and romaji readings without guessing ambiguous names', async () => {
  const catalog=await syntheticCatalog(0);
  const aliases=require('../src/lib/search-aliases');
  try {
    catalog.db.run("INSERT INTO tag_labels(type,name,label,source,votes) VALUES ('artist','ulula test','見本固有作者','learned',2)");
    catalog.loadTagLabels();

    assert.equal(aliases.rewriteQuery('artist:見本固有作者').query,'artist:ulula_test');
    assert.equal(aliases.rewriteQuery('-artist:見本固有作者').query,'-artist:ulula_test');
    catalog.db.run("INSERT INTO tag_labels(type,name,label,source,votes) VALUES ('artist','other test','見本固有作者','learned',1)");
    catalog.loadTagLabels();
    assert.equal(aliases.rewriteQuery('artist:見本固有作者').query,'artist:見本固有作者');
  } finally { aliases.setDynamicSource(null);if(catalog.persistTimer)clearTimeout(catalog.persistTimer);catalog.db.close(); }
});
