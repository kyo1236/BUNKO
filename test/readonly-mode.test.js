'use strict';

// 読み取り専用モード (--read-only) の IPC 許可/拒否の固定。
// main.js は electron 無しでは require できないため、ソースから
// 「一括で塞ぐ口の一覧」と「読み書き混在の口の個別ガード」を抽出して固定する。
// リファクタリングで一覧の中身や塞ぎ方が変わったらここで気づく。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 台帳の挙動 (persist が書かないこと) だけは実物を回して確かめるので、
// このテスト専用の userData へ向けた electron スタブを先に差しておく
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bookshelf-readonly-'));
let electronKey = null;
try {
  electronKey = require.resolve('electron');
} catch {
  electronKey = 'electron';
}
require.cache[electronKey] = {
  id: electronKey,
  filename: electronKey,
  loaded: true,
  exports: {
    app: { getPath: () => userData, getName: () => 'bookshelf-readonly-test' },
  },
};

// IPC の口は src/main/ipc/ に機能別で分かれている。一括差し替えと readOnly の
// 入り口は main.js に残り、個別ガードは各 ipc ファイルに居るので、連結して抽出する
const MAIN_PATH = path.join(__dirname, '..', 'src', 'main.js');
const IPC_DIR = path.join(__dirname, '..', 'src', 'main', 'ipc');
const source = [
  MAIN_PATH,
  ...fs.readdirSync(IPC_DIR).sort().map((name) => path.join(IPC_DIR, name)),
].map((file) => fs.readFileSync(file, 'utf8')).join('\n');

// ipcMain.handle('チャンネル名' の登録一覧 (現状の全チャンネル)
function registeredChannels() {
  return [...source.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)].map((m) => m[1]);
}

test('readOnly の入り口は --read-only 引数か起動用の一枚か設定 readOnly=true', () => {
  assert.ok(source.includes(
    "const readOnly = process.argv.includes('--read-only') || boot.readOnly === true"
    + ' || config.load().readOnly === true;',
  ));
});

test('拒否時の断り文言は一種類だけ', () => {
  assert.ok(source.includes("const READ_ONLY_ERROR = '読み取り専用モードのため実行できません';"));
});

test('一括で塞ぐ書き込みチャンネルの一覧', () => {
  const block = source.match(new RegExp('const WRITE_CHANNELS = \\[([\\s\\S]*?)\\n\\];'));
  assert.ok(block, 'WRITE_CHANNELS の配列が main.js に見つからない');
  const channels = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepStrictEqual(channels, [
    'download', 'cancel', 'retry-download', 'clear-finished',
    'library-match', 'library-link', 'library-unlink',
    'eagle-trash', 'eagle-star',
    'sync-homecore',
  ]);
});

test('塞ぎ方は「登録済みハンドラを断りの応答へ差し替え」', () => {
  // readOnly ブロックの中で removeHandler → READ_ONLY_ERROR を投げる handle に差し替える
  const closing = source.match(/if \(readOnly\) \{\s*\n\s*for \(const channel of WRITE_CHANNELS\)[\s\S]*?\n  \}/);
  assert.ok(closing, '一括差し替えのブロックが見つからない');
  assert.ok(closing[0].includes('sharedIpc.removeHandler(channel)'));
  assert.ok(closing[0].includes('throw new Error(READ_ONLY_ERROR)'));
});

test('一括で塞ぐチャンネルは全て実在する登録名', () => {
  const registered = new Set(registeredChannels());
  const block = source.match(new RegExp('const WRITE_CHANNELS = \\[([\\s\\S]*?)\\n\\];'));
  for (const [, channel] of block[1].matchAll(/'([^']+)'/g)) {
    assert.ok(registered.has(channel), `${channel} が ipcMain.handle に登録されていない`);
  }
});

test('読み書き混在の口は一括対象に入れず、中の書き込み枝だけ塞ぐ', () => {
  const block = source.match(new RegExp('const WRITE_CHANNELS = \\[([\\s\\S]*?)\\n\\];'));
  const bulk = new Set([...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
  // 読みを残すため一括では塞がない口
  for (const channel of ['paw-favorites', 'paw-links', 'paw-bulk', 'rescan', 'get-settings']) {
    assert.ok(!bulk.has(channel), `${channel} は一括対象ではないはず`);
  }
  // paw-links: 紐付けの書き込み三口 (map-creator / link / unlink) だけ拒否
  assert.ok(source.includes(
    "if (readOnly && (action === 'map-creator' || action === 'link' || action === 'unlink')) {",
  ));
  // paw-bulk: status 以外 (start / stop) を拒否
  assert.ok(source.includes(
    "if (readOnly && action !== 'status') throw new Error(READ_ONLY_ERROR);",
  ));
  // paw-favorites: toggle の枝でだけ拒否 (一覧は読みとして残す)
  const favorites = source.slice(
    source.indexOf("ipcMain.handle('paw-favorites'"),
    source.indexOf("ipcMain.handle('paw-links'"),
  );
  assert.ok(favorites.includes("if (request.action === 'toggle') {"));
  assert.ok(favorites.includes('if (readOnly) throw new Error(READ_ONLY_ERROR);'));
});

test('台帳には開く前に readOnly を伝える (init の中で書き出しが走るため)', () => {
  const mainSource = fs.readFileSync(MAIN_PATH, 'utf8');
  assert.match(
    mainSource,
    /catalog\.readOnly = readOnly;\s*\r?\n\s*await catalog\.init\(\);/,
  );
});

test('readOnly の台帳は catalog.sqlite も .bak も書かない', async () => {
  const { Catalog } = require('../src/lib/catalog.js');
  const catalog = new Catalog();
  catalog.readOnly = true;
  await catalog.init();
  // 変更を入れてから、遅延・同期・退避のどの経路でも書き出させてみる
  catalog.db.run(
    'INSERT INTO items (source,path,gallery_id,title,title_key,updated_at,star,added_at)'
    + " VALUES ('app', 'C:\\\\x\\\\y', '9001', 'ReadOnly Probe', 'readonly probe', 1, 0, 1)",
  );
  await catalog.persist();
  catalog.persistSync();
  await catalog.maybeBackup(Buffer.from('dummy'));
  if (catalog.persistTimer) clearTimeout(catalog.persistTimer);
  assert.strictEqual(fs.existsSync(catalog.dbPath), false, 'catalog.sqlite を書いてはいけない');
  for (const bak of catalog.backupPaths()) {
    assert.strictEqual(fs.existsSync(bak), false, `${bak} を書いてはいけない`);
  }
  // 記憶の中の更新は素通しのまま (取り込みや索引は写しの上でも働く)
  assert.ok(catalog.db.exec("SELECT 1 FROM items WHERE gallery_id = '9001'").length);
});

test('rescan は写しの上では走査せずミラーの読み直しに替わる', () => {
  const rescan = source.slice(
    source.indexOf("ipcMain.handle('rescan'"),
    source.indexOf("ipcMain.handle('rescan'") + 600,
  );
  assert.ok(rescan.includes('if (readOnly) {'));
  assert.ok(rescan.includes('catalog.reloadFromDisk()'));
  assert.ok(rescan.includes('mirrorReloaded: true'));
});

// 口を足したら分類を迫る (項目 7-13)。
// 名簿は守りの二枚目 (実際に控えを止めるのは state-file の番人) だが、
// 「断りを利用者に見せる」ためと「線引きを忘れない」ために全部を分類する
test('登録されている口はすべて、書く側か読む側に分類されている', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  const readFile = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

  const main = readFile('src/main.js');
  const pick = (name) => {
    const hit = main.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\n\\];`));
    assert.ok(hit, `${name} が読めない`);
    return [...hit[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  };
  const write = new Set(pick('WRITE_CHANNELS'));
  const ok = new Set(pick('READ_ONLY_OK'));

  const handled = new Set();
  for (const m of main.matchAll(/ipcMain\.handle\('([^']+)'/g)) handled.add(m[1]);
  for (const name of fs.readdirSync(path.join(root, 'src', 'main', 'ipc'))) {
    for (const m of readFile(`src/main/ipc/${name}`).matchAll(/ipcMain\.handle\('([^']+)'/g)) {
      handled.add(m[1]);
    }
  }
  assert.ok(handled.size >= 30, `口が ${handled.size} 本しか読めない`);

  const unclassified = [...handled].filter((name) => !write.has(name) && !ok.has(name));
  assert.deepEqual(
    unclassified, [],
    `分類されていない口がある (WRITE_CHANNELS か READ_ONLY_OK へ足すこと): ${unclassified.join(', ')}`,
  );
  // 名簿に居るのに実在しない口 (消し忘れ) も落とす
  const ghosts = [...write].filter((name) => !handled.has(name));
  assert.deepEqual(ghosts, [], `名簿に実在しない口がある: ${ghosts.join(', ')}`);
});
