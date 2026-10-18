'use strict';

// 名前・注釈・URL の [数字] から走査が作った結びを手で外すと、次の走査でも戻らないことの固定 (2026-09-24)。
// 以前は墓標を立てても走査が名前の番号から結び直し、hitomi から消えた作品に結ばれたまま
// 所持作品の一覧から消えていた (hitomi の素性が無いので一覧にも未照合にも入らない)。
// 照合器・手の結びを外す時は、名前の番号の結びは残す (正しい方を失わない)。題は合成

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installStub } = require('./helpers/stub-electron-2.js');

installStub();
const { Catalog } = require('../src/lib/catalog.js');
const eagleIndex = require('../src/lib/eagle-index.js');

const BASE_ID = 710000;

function makeLibrary(count) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bunko-unlink-'));
  fs.mkdirSync(path.join(root, 'images'));
  const mtimes = {};
  for (let i = 1; i <= count; i += 1) {
    const id = `ITEM${String(i).padStart(4, '0')}`;
    fs.mkdirSync(path.join(root, 'images', `${id}.info`));
    fs.writeFileSync(
      path.join(root, 'images', `${id}.info`, 'metadata.json'),
      JSON.stringify({ name: `[${BASE_ID + i}] synthetic ${i}`, modificationTime: i, folders: [] }),
    );
    mtimes[id] = i;
  }
  fs.writeFileSync(path.join(root, 'mtime.json'), JSON.stringify(mtimes));
  fs.writeFileSync(path.join(root, 'metadata.json'), JSON.stringify({ folders: [] }));
  return root;
}

async function scanned(root, count) {
  const catalog = new Catalog();
  await catalog.init();
  if (catalog.persistTimer) clearTimeout(catalog.persistTimer);
  catalog.db.run('BEGIN');
  catalog.db.run('DELETE FROM items');
  catalog.db.run('DELETE FROM galleries');
  catalog.db.run('DELETE FROM title_matches');
  for (let i = 1; i <= count; i += 1) {
    catalog.db.run(
      'INSERT OR REPLACE INTO galleries (id,title,type,language,language_local,page_count,added_date,published_date,url,fetched_at)'
        + ' VALUES (?,?,?,?,?,?,?,?,?,?)',
      [BASE_ID + i, `synthetic ${i}`, 'doujinshi', 'japanese', '日本語', 10, '2026-01-01', '2025-01-01', '', 1],
    );
  }
  catalog.db.run('COMMIT');
  catalog.rebuildMemory();
  await catalog.refresh({ eagleLibrary: root, full: true });
  if (catalog.persistTimer) clearTimeout(catalog.persistTimer);
  return catalog;
}

const linksOf = (catalog, eagleId) => catalog.queryRows(
  "SELECT gallery_id FROM items WHERE source = 'eagle' AND path LIKE ?",
  [`%${eagleId}.info%`],
).map((row) => (row.gallery_id == null ? null : String(row.gallery_id))).sort();
const tombOf = (catalog, eagleId) => catalog.queryRows(
  'SELECT status, gallery_id FROM title_matches WHERE eagle_id = ?',
  [eagleId],
)[0];

test('名前の番号の結びを手で外すと、その場で素の行に戻り、次の走査でも結び直さない', async () => {
  eagleIndex.resetForTest();
  const root = makeLibrary(2);
  try {
    const catalog = await scanned(root, 2);
    assert.deepEqual(linksOf(catalog, 'ITEM0001'), [String(BASE_ID + 1)], '名前の番号で結ばれている');
    assert.equal(catalog.removeTitleMatch('ITEM0001'), true, '照合の記録が無くても外せる');
    assert.deepEqual(linksOf(catalog, 'ITEM0001'), [null], 'その場で素の行に戻る');
    const tomb = tombOf(catalog, 'ITEM0001');
    assert.equal(tomb.status, 'unlinked');
    assert.equal(String(tomb.gallery_id), String(BASE_ID + 1), '墓標に外した番号を残す');
    await catalog.refresh({ eagleLibrary: root, full: true });
    if (catalog.persistTimer) clearTimeout(catalog.persistTimer);
    assert.deepEqual(linksOf(catalog, 'ITEM0001'), [null], '走査しても戻らない');
    assert.deepEqual(linksOf(catalog, 'ITEM0002'), [String(BASE_ID + 2)], 'ほかの項目の名前の番号はそのまま');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('照合器・手の結びを外す時は、名前の番号の結びを残す (走査の後も)', async () => {
  eagleIndex.resetForTest();
  const root = makeLibrary(1);
  try {
    const catalog = await scanned(root, 1);
    catalog.addTitleMatch('ITEM0001', String(BASE_ID + 99), 'synthetic 1', 'other', 'matched', { origin: 'manual' });
    assert.deepEqual(linksOf(catalog, 'ITEM0001'), [String(BASE_ID + 1), String(BASE_ID + 99)]);
    assert.equal(catalog.removeTitleMatch('ITEM0001'), true);
    assert.deepEqual(linksOf(catalog, 'ITEM0001'), [String(BASE_ID + 1)], '手の結びだけ外れる');
    const tomb = tombOf(catalog, 'ITEM0001');
    assert.equal(tomb.status, 'unlinked');
    assert.equal(tomb.gallery_id, null, '墓標の番号は空 (名前の番号は使い続ける)');
    await catalog.refresh({ eagleLibrary: root, full: true });
    if (catalog.persistTimer) clearTimeout(catalog.persistTimer);
    assert.deepEqual(linksOf(catalog, 'ITEM0001'), [String(BASE_ID + 1)], '名前の番号は走査でも残る');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
