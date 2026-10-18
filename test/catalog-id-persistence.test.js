'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installStub } = require('./helpers/stub-electron-2.js');

installStub();
const { Catalog } = require('../src/lib/catalog.js');

const roots = [];
test.after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

async function freshCatalog() {
  const catalog = new Catalog();
  await catalog.init();
  if (catalog.persistTimer) clearTimeout(catalog.persistTimer);
  return catalog;
}

test('markApp は接頭辞付き作品IDを永続化し、再構築後も所有判定できる', async () => {
  const catalog = await freshCatalog();
  const file = path.join(os.tmpdir(), 'synthetic-owned.cbz');
  const cases = [['nh:123', 'NH title'], ['eh:456:token', 'EH title'], ['789', 'Hitomi title']];
  for (const [id, title] of cases) catalog.markApp(id, title, `${file}-${id.replace(/:/g, '_')}`);

  const bytes = catalog.db.export();
  const restarted = new Catalog();
  restarted.SQL = catalog.SQL;
  restarted.db = new catalog.SQL.Database(bytes);
  restarted.rebuildMemory();

  for (const [id, title] of cases) {
    assert.strictEqual(restarted.isIdOwned(id, title), true, `${id} が再起動後も所有扱い`);
  }
});

test('ZIP/CBZ 再走査はファイル名から読めない接頭辞付きIDを消さない', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bunko-catalog-id-'));
  roots.push(root);
  const archive = path.join(root, 'plain-name.cbz');
  fs.writeFileSync(archive, 'synthetic');
  const catalog = await freshCatalog();
  catalog.markApp('nh:321', 'Plain title', archive);

  catalog.scanDownloadDir(root);
  const row = catalog.queryRows(
    "SELECT gallery_id FROM items WHERE source = 'app' AND path = ?", [archive],
  )[0];
  assert.strictEqual(String(row.gallery_id), 'nh:321');
  catalog.rebuildMemory();
  assert.strictEqual(catalog.isIdOwned('nh:321', 'Plain title'), true);
});

test('ZIP/CBZ の既存リンクはファイル名に偶然ある数値より優先する', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bunko-catalog-numbered-'));
  roots.push(root);
  const archive = path.join(root, 'title 123456.cbz');
  fs.writeFileSync(archive, 'synthetic');
  const catalog = await freshCatalog();
  catalog.markApp('eh:456:token', 'Numbered title', archive);
  catalog.scanDownloadDir(root);
  const row = catalog.queryRows(
    "SELECT gallery_id FROM items WHERE source = 'app' AND path = ?", [archive],
  )[0];
  assert.strictEqual(String(row.gallery_id), 'eh:456:token');
});

test('info.json の接頭辞付きIDと従来の数値IDを同じ規則で保存する', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bunko-catalog-info-'));
  roots.push(root);
  for (const [name, id] of [['nh-work', 'nh:77'], ['eh-work', 'eh:88:abc'], ['hitomi-work', 99]]) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'info.json'), JSON.stringify({ id, title: name }));
  }
  const catalog = await freshCatalog();
  catalog.scanDownloadDir(root);
  const rows = catalog.queryRows(
    "SELECT path, gallery_id FROM items WHERE source = 'app' ORDER BY path",
  );
  assert.deepStrictEqual(rows.map((row) => String(row.gallery_id)).sort(), ['99', 'eh:88:abc', 'nh:77']);
});
