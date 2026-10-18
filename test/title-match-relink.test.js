'use strict';

// 紐付けの付け替え (別の作品へ繋ぎ直す) の釘。
// 題とタグは合成のものだけを使う (実在の蔵書の名は試験にも書かない)。
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { installStub } = require('./helpers/stub-electron-2.js');

installStub();
const { Catalog } = require('../src/lib/catalog.js');

const IMAGES = path.join('C:', 'synthetic-library', 'images');
const ITEM = 'SYNTH0001';
const BASE = path.join(IMAGES, `${ITEM}.info`);

async function freshCatalog() {
  const catalog = new Catalog();
  await catalog.init();
  if (catalog.persistTimer) clearTimeout(catalog.persistTimer);
  return catalog;
}

// Eagle の走査が置く姿の素の行 (ID 無し・星と追加日時とタグ入り)
function seedBareItem(catalog, extra = {}) {
  catalog.upsert({
    source: 'eagle',
    filePath: BASE,
    galleryId: null,
    title: 'Synthetic Item One',
    star: 4,
    addedAt: 1700000000000,
    eagleTags: ['synthetic-tag-a', 'synthetic-tag-b'],
    ...extra,
  });
}

function itemRow(catalog, itemPath) {
  return catalog.queryRows(
    "SELECT path, gallery_id, title, star, added_at, eagle_tags FROM items WHERE source = 'eagle' AND path = ?",
    [itemPath],
  )[0] || null;
}

function eagleRows(catalog) {
  return catalog.queryRows("SELECT path FROM items WHERE source = 'eagle' ORDER BY path")
    .map((row) => String(row.path));
}

test('紐付けは素の行の星・追加日時・Eagle のタグを引き継ぐ', async () => {
  const catalog = await freshCatalog();
  seedBareItem(catalog);

  assert.strictEqual(catalog.addTitleMatch(ITEM, '111', 'Synthetic Item One', 'Gallery 111', 'matched'), true);

  const linked = itemRow(catalog, `${BASE}#111`);
  assert.ok(linked, '紐付け先の行ができる');
  assert.strictEqual(linked.star, 4, '星が落ちない');
  assert.strictEqual(linked.added_at, 1700000000000, '追加日時が落ちない');
  assert.deepStrictEqual(JSON.parse(linked.eagle_tags), ['synthetic-tag-a', 'synthetic-tag-b']);
  assert.strictEqual(itemRow(catalog, BASE), null, '素の行は置き換わる');
});

test('付け替えは行を移し替える: 星は残り、前の紐付け先の行は残らない', async () => {
  const catalog = await freshCatalog();
  seedBareItem(catalog);
  catalog.addTitleMatch(ITEM, '111', 'Synthetic Item One', 'Gallery 111', 'matched');
  catalog.addTitleMatch(ITEM, '222', 'Synthetic Item One', 'Gallery 222', 'matched');

  const moved = itemRow(catalog, `${BASE}#222`);
  assert.ok(moved, '新しい紐付け先の行ができる');
  assert.strictEqual(moved.star, 4, '付け替えても星は Eagle のまま');
  assert.strictEqual(moved.added_at, 1700000000000, '追加日時も持ち越す');
  assert.deepStrictEqual(JSON.parse(moved.eagle_tags), ['synthetic-tag-a', 'synthetic-tag-b']);
  assert.strictEqual(itemRow(catalog, `${BASE}#111`), null, '前の紐付け先の行は残さない');
  assert.deepStrictEqual(eagleRows(catalog), [`${BASE}#222`], 'このアイテムの行は一つだけ');
});

test('付け替えると前の作品は所持から外れ、新しい作品が所持になる', async () => {
  const catalog = await freshCatalog();
  seedBareItem(catalog);
  catalog.addTitleMatch(ITEM, '111', 'Synthetic Item One', 'Gallery 111', 'matched');
  assert.strictEqual(catalog.idSet.has('111'), true);

  catalog.addTitleMatch(ITEM, '222', 'Synthetic Item One', 'Gallery 222', 'matched');
  assert.strictEqual(catalog.idSet.has('222'), true, '新しい作品が所持になる');
  assert.strictEqual(catalog.idSet.has('111'), false, '前の作品は所持から外れる');
  assert.strictEqual(catalog.eagleByGallery.get('111'), undefined, '前の作品の鎖も外れる');
  assert.strictEqual(catalog.eagleByGallery.get('222'), ITEM);
});

test('名前から ID が採れている兄弟行は付け替えで触らない', async () => {
  const catalog = await freshCatalog();
  // 走査が名前の [12345] から起こした行。紐付けの管轄ではない
  catalog.upsert({
    source: 'eagle',
    filePath: `${BASE}#12345`,
    galleryId: 12345,
    title: 'Synthetic Item Two [12345]',
    star: 3,
    addedAt: 1700000000001,
  });
  seedBareItem(catalog, { title: 'Synthetic Item Two [12345]' });

  catalog.addTitleMatch(ITEM, '111', 'Synthetic Item Two [12345]', 'Gallery 111', 'matched');
  catalog.addTitleMatch(ITEM, '222', 'Synthetic Item Two [12345]', 'Gallery 222', 'matched');

  const sibling = itemRow(catalog, `${BASE}#12345`);
  assert.ok(sibling, '抽出 ID の行はそのまま');
  assert.strictEqual(sibling.star, 3);
  assert.deepStrictEqual(eagleRows(catalog), [`${BASE}#12345`, `${BASE}#222`]);
});

test('手で決めた紐付けは自動照合に上書きされない', async () => {
  const catalog = await freshCatalog();
  seedBareItem(catalog);
  catalog.addTitleMatch(ITEM, '111', 'Synthetic Item One', 'Gallery 111', 'matched', { origin: 'manual' });

  // 照合器からの書き込み (origin なし)
  assert.strictEqual(
    catalog.addTitleMatch(ITEM, '999', 'Synthetic Item One', 'Gallery 999', 'matched'),
    false,
    '自動の書き込みは断る',
  );
  assert.strictEqual(catalog.linkedGalleryOf(ITEM), '111', '手の紐付けが残る');
  assert.strictEqual(itemRow(catalog, `${BASE}#999`), null);

  // 手からの付け替えは通る
  assert.strictEqual(
    catalog.addTitleMatch(ITEM, '222', 'Synthetic Item One', 'Gallery 222', 'matched', { origin: 'manual' }),
    true,
  );
  assert.strictEqual(catalog.linkedGalleryOf(ITEM), '222');
});

test('紐付け済みのアイテムも候補に出る (繋ぎ先を添えて)', async () => {
  const catalog = await freshCatalog();
  seedBareItem(catalog);
  catalog.upsert({
    source: 'eagle',
    filePath: path.join(IMAGES, 'SYNTH0002.info'),
    galleryId: null,
    title: 'Synthetic Item Two',
  });
  catalog.addTitleMatch(ITEM, '111', 'Synthetic Item One', 'Gallery 111', 'matched');

  const hits = catalog.searchEagleItems('Synthetic', 20);
  const byId = new Map(hits.map((hit) => [hit.eagleId, hit]));
  assert.ok(byId.has(ITEM), '繋がっているアイテムも候補から消さない');
  assert.strictEqual(byId.get(ITEM).linkedGalleryId, '111', '繋ぎ先を添える');
  assert.strictEqual(byId.get('SYNTH0002').linkedGalleryId, null, '未使用のアイテムには印を付けない');
  // まだ ID の付いていないアイテムが先頭に来る
  assert.strictEqual(hits[0].eagleId, 'SYNTH0002');
});

test('棚の書き込みが落ちたら台帳も戻す (片方だけ進んだ姿を残さない)', async () => {
  const catalog = await freshCatalog();
  seedBareItem(catalog);
  catalog.addTitleMatch(ITEM, '111', 'Synthetic Item One', 'Gallery 111', 'matched');

  const original = catalog.upsert;
  catalog.upsert = () => { throw new Error('synthetic failure'); };
  assert.throws(() => catalog.addTitleMatch(ITEM, '222', 'Synthetic Item One', 'Gallery 222', 'matched'));
  catalog.upsert = original;

  assert.strictEqual(catalog.linkedGalleryOf(ITEM), '111', '台帳は前の紐付けのまま');
  assert.ok(itemRow(catalog, `${BASE}#111`), '棚も前の紐付けのまま');
  assert.strictEqual(itemRow(catalog, `${BASE}#222`), null);
});

test('走査中のゴミ箱送りでも、その場で未所持になる (済 → 未 → 済 と点滅させない)', async () => {
  const catalog = await freshCatalog();
  seedBareItem(catalog);
  catalog.addTitleMatch(ITEM, '111', 'Synthetic Item One', 'Gallery 111', 'matched');
  assert.strictEqual(catalog.ownershipFacts('111', 'Synthetic Item One').owned, true);

  // 走査中は items の掃除が scanQueue で後回しになる
  catalog.scanning = true;
  assert.strictEqual(catalog.removeEagleItem(ITEM), true);
  const during = catalog.ownershipFacts('111', 'Synthetic Item One');
  assert.strictEqual(during.owned, false, '書き出しを待たずに未所持');
  assert.strictEqual(during.eagleId, null);
  assert.strictEqual(during.star, 0);

  catalog.scanning = false;
  catalog.drainScanQueue();
  assert.deepStrictEqual(eagleRows(catalog), [], '掃除は後から追いつく');
  assert.strictEqual(catalog.ownershipFacts('111', 'Synthetic Item One').owned, false);
});

test('解除は星・追加日時・タグを素の行へ戻す', async () => {
  const catalog = await freshCatalog();
  seedBareItem(catalog);
  catalog.addTitleMatch(ITEM, '111', 'Synthetic Item One', 'Gallery 111', 'matched');
  assert.strictEqual(catalog.removeTitleMatch(ITEM), true);

  const restored = itemRow(catalog, BASE);
  assert.ok(restored, '素の行へ戻る');
  assert.strictEqual(restored.star, 4, '解除でも星は落ちない');
  assert.strictEqual(restored.added_at, 1700000000000);
  assert.deepStrictEqual(JSON.parse(restored.eagle_tags), ['synthetic-tag-a', 'synthetic-tag-b']);
});
