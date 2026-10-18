'use strict';

// 台帳パスの自機ライブラリへの読み替え (rebaseLibraryPath / rebuildMemory)。
// 二台構成の読み手 (Homecore) では母艦のドライブ表記 (D:\share\...) が
// 実在しないため、ライブラリのフォルダ名を目印に config の eagleLibrary の
// 根へ読み替えて索引に載せる — その挙動を固定する。
// 他のテストと userData を分ける (config.json を書くため、共有すると汚す)

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// このテスト専用の userData と偽ライブラリを一時領域に組む
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bookshelf-rebase-'));
const libRoot = path.join(userData, 'mybooks.library');
const itemDir = path.join(libRoot, 'images', 'TESTID1.info');
fs.mkdirSync(itemDir, { recursive: true });
fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ eagleLibrary: libRoot }));

// electron スタブ (userData をこのテスト専用の場所へ向ける)
let resolved = null;
try {
  resolved = require.resolve('electron');
} catch {
  resolved = 'electron';
}
require.cache[resolved] = {
  id: resolved,
  filename: resolved,
  loaded: true,
  exports: {
    app: {
      getPath: () => userData,
      getName: () => 'bookshelf-rebase-test',
    },
  },
};

const { Catalog, rebaseLibraryPath } = require('../src/lib/catalog.js');

test('rebaseLibraryPath: ライブラリ名を目印に根を差し替える', () => {
  assert.strictEqual(
    rebaseLibraryPath('D:\\share\\mybooks.library\\images\\ABC.info', 'C:\\mirror\\storage\\mybooks.library'),
    'C:\\mirror\\storage\\mybooks.library\\images\\ABC.info',
  );
});

test('rebaseLibraryPath: 大文字小文字は無視して照合する (Windows のパス)', () => {
  assert.strictEqual(
    rebaseLibraryPath('d:\\share\\MYBOOKS.LIBRARY\\images\\ABC.info', 'C:\\lib\\mybooks.library'),
    'C:\\lib\\mybooks.library\\images\\ABC.info',
  );
});

test('rebaseLibraryPath: 目印が無い・入力が空なら null', () => {
  assert.strictEqual(rebaseLibraryPath('D:\\somewhere\\else\\ABC.info', 'C:\\lib\\mybooks.library'), null);
  assert.strictEqual(rebaseLibraryPath('', 'C:\\lib\\mybooks.library'), null);
  assert.strictEqual(rebaseLibraryPath('D:\\a\\mybooks.library\\x', ''), null);
});

test('rebuildMemory: 実在しない母艦表記のパスを自機ライブラリへ読み替えて索引に載せる', async () => {
  const catalog = new Catalog();
  await catalog.init();
  // 母艦のドライブ表記 (この機体には Q: は無い) + #galleryId の付録
  const foreign = 'Q:\\share\\mybooks.library\\images\\TESTID1.info#4321';
  catalog.db.run(
    'INSERT INTO items (source,path,gallery_id,title,title_key,updated_at,star,added_at)'
    + " VALUES ('eagle', ?, '4321', 'Rebase Test Volume', 'rebase test volume', 1, 0, 1)",
    [foreign],
  );
  catalog.rebuildMemory();
  // ローカル索引 (findLocal の元) と Eagle 画像配りの元、どちらも読み替え後の実在パス
  assert.strictEqual(catalog.localById.get('4321'), itemDir);
  assert.strictEqual(catalog.eagleBasePath.get('TESTID1'), itemDir);
  if (catalog.persistTimer) clearTimeout(catalog.persistTimer);
});

test('rebuildMemory: 読み替え先にも実体が無ければ従来どおり索引に載せない', async () => {
  const catalog = new Catalog();
  await catalog.init();
  catalog.db.run(
    'INSERT INTO items (source,path,gallery_id,title,title_key,updated_at,star,added_at)'
    + " VALUES ('eagle', 'Q:\\\\share\\\\mybooks.library\\\\images\\\\NOPE99.info#5555', '5555', 'Missing Everywhere', 'missing everywhere', 1, 0, 1)",
  );
  catalog.rebuildMemory();
  assert.strictEqual(catalog.localById.get('5555'), undefined);
  if (catalog.persistTimer) clearTimeout(catalog.persistTimer);
});

test('rebuildMemory: 自機ライブラリ配下の実在は走査の控えから引き、行ごとに existsSync しない', async () => {
  const catalog = new Catalog();
  await catalog.init();
  const insert = 'INSERT INTO items (source,path,gallery_id,title,title_key,updated_at,star,added_at)'
    + " VALUES ('eagle', ?, ?, ?, ?, 1, 0, 1)";
  catalog.db.run(insert, ['Q:\\share\\mybooks.library\\images\\TESTID1.info#4321', '4321', 'Cached Volume', 'cached volume']);
  // GONE01 は実体があっても前回の走査に居なかった (控えに無い) → 実在しない扱い
  fs.mkdirSync(path.join(libRoot, 'images', 'GONE01.info'), { recursive: true });
  catalog.db.run(insert, ['Q:\\share\\mybooks.library\\images\\GONE01.info#4322', '4322', 'Gone Volume', 'gone volume']);
  catalog.eagleScanCache = new Map([['TESTID1.info', { mtimeMs: 1, size: 1, meta: {} }]]);
  const originalExists = fs.existsSync;
  let itemChecks = 0;
  fs.existsSync = (value) => {
    if (/\.info$/i.test(String(value))) itemChecks += 1;
    return originalExists(value);
  };
  try {
    catalog.rebuildMemory();
  } finally {
    fs.existsSync = originalExists;
  }
  assert.strictEqual(itemChecks, 0, 'アイテムごとの existsSync は呼ばない');
  assert.strictEqual(catalog.localById.get('4321'), itemDir);
  assert.strictEqual(catalog.eagleBasePath.get('TESTID1'), itemDir);
  assert.strictEqual(catalog.localById.get('4322'), undefined);
  if (catalog.persistTimer) clearTimeout(catalog.persistTimer);
});

test('rebuildMemory: 自機の根 (images) が見えなければ控えは使わず従来の順で実体に訊く', async () => {
  const catalog = new Catalog();
  await catalog.init();
  catalog.db.run(
    'INSERT INTO items (source,path,gallery_id,title,title_key,updated_at,star,added_at)'
    + " VALUES ('eagle', 'Q:\\\\share\\\\mybooks.library\\\\images\\\\TESTID1.info#4323', '4323', 'Offline Root', 'offline root', 1, 0, 1)",
  );
  catalog.eagleScanCache = new Map([['TESTID1.info', { mtimeMs: 1, size: 1, meta: {} }]]);
  const originalExists = fs.existsSync;
  const imagesDir = path.join(libRoot, 'images');
  fs.existsSync = (value) => (String(value) === imagesDir ? false : originalExists(value));
  try {
    catalog.rebuildMemory();
  } finally {
    fs.existsSync = originalExists;
  }
  // 読み替え先の実体は (行ごとの確認で) 見つかるので索引には載る
  assert.strictEqual(catalog.localById.get('4323'), itemDir);
  if (catalog.persistTimer) clearTimeout(catalog.persistTimer);
});
