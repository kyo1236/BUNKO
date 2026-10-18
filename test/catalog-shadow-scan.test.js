'use strict';

// 走査 (refresh) の最中に所持作品の検索が「途中の台帳」を見ないことを固定する。
// 以前は BEGIN → eagle 行の全削除 → 32 件ずつ戻す、だったので、起動直後の棚が
// 0 件〜途中まで (実機で 27 → 693 件、本来 2,178 件) で固定されていた

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installStub } = require('./helpers/stub-electron-2.js');

installStub();
const { Catalog } = require('../src/lib/catalog.js');
const eagleIndex = require('../src/lib/eagle-index.js');

// hitomi の ID は 6 桁以上でないと名前から拾わない (4 桁は連番と区別が付かない)
const BASE_ID = 700000;

function makeLibrary(count) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bunko-shadow-'));
  fs.mkdirSync(path.join(root, 'images'));
  const mtimes = {};
  for (let i = 1; i <= count; i += 1) {
    const id = `ITEM${String(i).padStart(4, '0')}`;
    fs.mkdirSync(path.join(root, 'images', `${id}.info`));
    fs.writeFileSync(
      path.join(root, 'images', `${id}.info`, 'metadata.json'),
      JSON.stringify({ name: `[${BASE_ID + i}] book ${i}`, modificationTime: i, folders: [] }),
    );
    mtimes[id] = i;
  }
  fs.writeFileSync(path.join(root, 'mtime.json'), JSON.stringify(mtimes));
  fs.writeFileSync(path.join(root, 'metadata.json'), JSON.stringify({ folders: [] }));
  return root;
}

function insertGallery(catalog, id, title) {
  catalog.db.run(
    'INSERT OR REPLACE INTO galleries (id,title,type,language,language_local,page_count,added_date,published_date,url,fetched_at)'
      + ' VALUES (?,?,?,?,?,?,?,?,?,?)',
    [id, title, 'doujinshi', 'japanese', '日本語', 10, '2026-01-01', '2025-01-01', '', 1],
  );
}

// 試験ごとに台帳を空から (stub の userData は試験の間で共有され、persist が残る)
async function catalogWith(root, count) {
  const catalog = new Catalog();
  await catalog.init();
  if (catalog.persistTimer) clearTimeout(catalog.persistTimer);
  catalog.db.run('BEGIN');
  catalog.db.run('DELETE FROM items');
  catalog.db.run('DELETE FROM galleries');
  catalog.db.run('DELETE FROM title_matches');
  for (let i = 1; i <= count; i += 1) insertGallery(catalog, BASE_ID + i, `book ${i}`);
  catalog.db.run('COMMIT');
  catalog.rebuildMemory();
  await catalog.refresh({ eagleLibrary: root, full: true });
  if (catalog.persistTimer) clearTimeout(catalog.persistTimer);
  return catalog;
}

test('走査の最中も所持作品の検索は完全な台帳を返し、終わったら新しい台帳になる', async () => {
  eagleIndex.resetForTest();
  const count = 300;
  const root = makeLibrary(count);
  const catalog = await catalogWith(root, count);
  const before = catalog.searchLibrary({ pageSize: 24, includeUnmatched: false });
  assert.strictEqual(before.total, count);
  assert.strictEqual(catalog.libraryStatus().owned, count);

  // 一件増やして走査を掛け、走っている最中に検索する
  const newId = BASE_ID + count + 1;
  fs.mkdirSync(path.join(root, 'images', 'ITEMNEW.info'));
  fs.writeFileSync(
    path.join(root, 'images', 'ITEMNEW.info', 'metadata.json'),
    JSON.stringify({ name: `[${newId}] book new`, modificationTime: 999, folders: [] }),
  );
  insertGallery(catalog, newId, 'book new');
  const mtimes = JSON.parse(fs.readFileSync(path.join(root, 'mtime.json'), 'utf8'));
  mtimes.ITEMNEW = 999;
  fs.writeFileSync(path.join(root, 'mtime.json'), JSON.stringify(mtimes));

  // 索引の読みを遅らせて、走査中の窓を確実に作る
  const index = catalog.eagleIndex(root);
  const originalWalk = index.walk.bind(index);
  let release = null;
  index.walk = async (options) => {
    await new Promise((resolve) => { release = resolve; });
    return originalWalk(options);
  };
  const refreshing = catalog.refresh({ eagleLibrary: root });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.strictEqual(catalog.scanning, true);
  const during = catalog.searchLibrary({ pageSize: 24, includeUnmatched: false });
  assert.strictEqual(during.total, count, '走査中も台帳は欠けない');
  assert.strictEqual(catalog.libraryStatus().owned, count, '所持数も 0 にならない');
  assert.strictEqual(catalog.isOwned(String(BASE_ID + 1), 'book 1'), true, '済 の判定も欠けない');
  release();
  await refreshing;
  if (catalog.persistTimer) clearTimeout(catalog.persistTimer);
  const after = catalog.searchLibrary({ pageSize: 24, includeUnmatched: false });
  assert.strictEqual(after.total, count + 1, '走査後は増えたぶんが載る');
  assert.strictEqual(catalog.isOwned(String(newId), 'book new'), true);
  assert.strictEqual(catalog.eagleScanCache.size, count + 1, '控えも差し替わる');
});

test('激減した走査結果は捨て、台帳をそのまま残す', async () => {
  eagleIndex.resetForTest();
  const count = 240;
  const root = makeLibrary(count);
  const catalog = await catalogWith(root, count);
  // ライブラリが空に見える (遅延マウント等) 状況
  fs.writeFileSync(path.join(root, 'mtime.json'), JSON.stringify({}));
  for (let i = 1; i <= count; i += 1) {
    fs.rmSync(path.join(root, 'images', `ITEM${String(i).padStart(4, '0')}.info`), { recursive: true, force: true });
  }
  await assert.rejects(() => catalog.refresh({ eagleLibrary: root, full: true }), /eagle scan aborted/);
  if (catalog.persistTimer) clearTimeout(catalog.persistTimer);
  assert.strictEqual(catalog.searchLibrary({ pageSize: 24, includeUnmatched: false }).total, count);
  assert.strictEqual(catalog.scanning, false);
});

test('pageSizeMax で頁幅の上限を広げられる (起動時の一括復元用)', async () => {
  eagleIndex.resetForTest();
  const count = 130;
  const root = makeLibrary(count);
  const catalog = await catalogWith(root, count);
  const capped = catalog.searchLibrary({ pageSize: 120, includeUnmatched: false });
  assert.strictEqual(capped.galleries.length, 60, '既定の上限は 60');
  const wide = catalog.searchLibrary({ pageSize: 120, pageSizeMax: 120, includeUnmatched: false });
  assert.strictEqual(wide.galleries.length, 120);
  assert.strictEqual(wide.total, count);
});

// 安全弁が見るのは「走査が実体を何件見たか」であって、棚に入った数ではない。
// 棚に入る数はフォルダを組み替えれば正しく減る (pawchive の作者フォルダへ移した等)。
// そこで止めると、一度組み替えただけで台帳が二度と追いつけなくなる —
// 実際そうなっていた (索引 26,465 件のうち棚に入るのは 2,231 件。
// それを古い 21,718 件と比べて毎回中断していた)
test('棚に入る数がフォルダの組み替えで減っただけなら、取り込みは止めない', async () => {
  eagleIndex.resetForTest();
  const count = 240;
  const root = makeLibrary(count);
  const catalog = await catalogWith(root, count);
  assert.strictEqual(catalog.searchLibrary({ pageSize: 24, includeUnmatched: false }).total, count);

  // 実体はそのまま (走査は 240 件見える) だが、棚に入れるフォルダを絞る。
  // 以前はここで eagle scan aborted になり、台帳が二度と追いつけなかった
  const keep = 'KEEPFOLDER';
  fs.writeFileSync(path.join(root, 'metadata.json'), JSON.stringify({
    folders: [{ id: keep, name: '棚', children: [] }],
  }));
  for (let i = 1; i <= count; i += 1) {
    const dir = path.join(root, 'images', `ITEM${String(i).padStart(4, '0')}.info`);
    const metaPath = path.join(dir, 'metadata.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    // 10 件だけ棚のフォルダに置き、残りは別のフォルダへ移す
    meta.folders = i <= 10 ? [keep] : ['OTHER'];
    fs.writeFileSync(metaPath, JSON.stringify(meta));
  }

  await catalog.refresh({ eagleLibrary: root, eagleFolders: [keep], full: true });
  if (catalog.persistTimer) clearTimeout(catalog.persistTimer);
  assert.strictEqual(catalog.scanning, false);
  const after = catalog.searchLibrary({ pageSize: 24, includeUnmatched: false }).total;
  assert.ok(after < count, `棚は正しく減る (${after} < ${count})`);
});
