'use strict';

// よそのサイト (nhentai / E-Hentai) の作品を、手持ちの hitomi 版と突き合わせる。
// 題はすべて合成。
//
// 所持は「ソースごとの ID」で持っているので、hitomi の 4187309 を持っていても
// nh:12345 とは結びつかず、**nhentai を見ている間は何を持っているか分からない**。
// 蔵書は hitomi 中心 (実測: 題が一致した 28 件すべてに hitomi の ID が有った) なので、
// 当て先を hitomi のメタにして、題の鍵 + 頁数 ±2 で決める。
//
// 頁数を外すと短い題を共用する連作を取り違える (実測: 63 頁の作品に 51/41/35 頁の
// 別作品がぶら下がった) ので、頁数は必須。
const test = require('node:test');
const assert = require('node:assert/strict');
const { installStub } = require('./helpers/stub-electron-2.js');

installStub();
const { Catalog } = require('../src/lib/catalog.js');
const { stripCircleDecorations } = require('../src/lib/sources/normalize.js');

const IMAGES = 'C:\\synthetic-library\\images';

async function freshCatalog() {
  const catalog = new Catalog();
  await catalog.init();
  if (catalog.persistTimer) clearTimeout(catalog.persistTimer);
  return catalog;
}

// hitomi の作品を「所持している」状態にする (galleries のメタ + Eagle の行)
function ownHitomi(catalog, id, title, pages, eagleId) {
  catalog.db.run(
    'INSERT OR REPLACE INTO galleries (id, title, page_count, fetched_at) VALUES (?, ?, ?, ?)',
    [id, title, pages, Date.now()],
  );
  catalog.upsert({
    source: 'eagle',
    filePath: `${IMAGES}\\${eagleId}.info#${id}`,
    galleryId: id,
    title,
  });
}

const foreign = (id, title, pages, source = 'nhentai') => ({
  id, source, title, pageCount: pages, error: false,
  artists: [], groups: [], series: [], characters: [], tags: [],
});

test('題の鍵と頁数が合えば、よその札も所持として出す', async () => {
  const catalog = await freshCatalog();
  ownHitomi(catalog, 101, 'Synthetic Work One', 34, 'SYNTH0001');

  const [out] = catalog.annotate([foreign('nh:9001', 'Synthetic Work One', 34)]);
  assert.equal(out.owned, true, '所持として出る');
  assert.equal(out.ownedGalleryId, 101, '手持ちの hitomi 版を指す');
  assert.equal(out.eagleId, 'SYNTH0001', '実体 (Eagle のアイテム) も引ける');
  // ID は確定していない: 札は枠だけの 済 になり、伏せられず、鎖で確かめられる
  assert.equal(out.idOwned, false);
});

test('頁数がずれていれば所持と言わない (連作の取り違えを防ぐ)', async () => {
  const catalog = await freshCatalog();
  ownHitomi(catalog, 101, 'Synthetic Series', 63, 'SYNTH0001');

  for (const pages of [51, 41, 35]) {
    const [out] = catalog.annotate([foreign('nh:9002', 'Synthetic Series', pages)]);
    assert.equal(out.owned, false, `${pages} 頁は 63 頁の作品と別物`);
    assert.equal(out.ownedGalleryId, undefined);
  }
  // ±2 までは同じ物とみなす (綴じ方で表紙の数え方が変わる)
  for (const pages of [61, 63, 65]) {
    const [out] = catalog.annotate([foreign('nh:9002', 'Synthetic Series', pages)]);
    assert.equal(out.owned, true, `${pages} 頁は誤差のうち`);
  }
});

test('頁数が分からない札は決めない', async () => {
  const catalog = await freshCatalog();
  ownHitomi(catalog, 101, 'Synthetic Work One', 34, 'SYNTH0001');
  const [out] = catalog.annotate([foreign('nh:9003', 'Synthetic Work One', 0)]);
  assert.equal(out.owned, false, '頁数が無ければ当てにいかない');
});

test('持っていない作品は当たらない', async () => {
  const catalog = await freshCatalog();
  ownHitomi(catalog, 101, 'Synthetic Work One', 34, 'SYNTH0001');
  const [out] = catalog.annotate([foreign('nh:9004', 'Synthetic Work Two', 34)]);
  assert.equal(out.owned, false);
});

test('E-Hentai にも効き、pawchive と hitomi 自身には効かない', async () => {
  const catalog = await freshCatalog();
  ownHitomi(catalog, 101, 'Synthetic Work One', 34, 'SYNTH0001');

  const [eh] = catalog.annotate([foreign('eh:5:abc', 'Synthetic Work One', 34, 'ehentai')]);
  assert.equal(eh.owned, true, 'E-Hentai も同じ扱い');

  // pawchive は別の台帳 (作者フォルダ) が持ち場
  const [paw] = catalog.annotate([foreign('pw:s:u:1', 'Synthetic Work One', 34, 'pawchive')]);
  assert.equal(paw.ownedGalleryId, undefined, 'pawchive には当てにいかない');

  // pixiv も作者根の住人: 所持は pixiv の台帳が答える (題では当てにいかない)
  const [px] = catalog.annotate([foreign('px:123456', 'Synthetic Work One', 34, 'pixiv')]);
  assert.equal(px.ownedGalleryId, undefined, 'pixiv には当てにいかない');
  assert.equal(px.owned, false);

  // hitomi 自身は ID で分かる: 題での当てずっぽうはしない
  const [hit] = catalog.annotate([foreign('999', 'Synthetic Work One', 34, 'hitomi')]);
  assert.equal(hit.ownedGalleryId, undefined);
});

test('所持が動いたら索引を組み直す', async () => {
  const catalog = await freshCatalog();
  const card = () => catalog.annotate([foreign('nh:9005', 'Synthetic Work One', 34)])[0];
  assert.equal(card().owned, false);

  ownHitomi(catalog, 101, 'Synthetic Work One', 34, 'SYNTH0001');
  assert.equal(card().owned, true, '持った後は所持として出る');
});

// nhentai の題は E-Hentai 式 ((イベント)[サークル (作者)]題(原作))。
// 剥がさないと題の鍵が噛み合わない (実測で照合率 61.6% -> 82.9%)
test('E-Hentai 式の飾りを剥がすと噛み合う', () => {
  assert.equal(
    stripCircleDecorations('(C81) [Synthetic Circle (Synthetic Artist)] Synthetic Work One (Synthetic Parody)'),
    'Synthetic Work One',
    '入れ子の括弧でも最後まで剥がす',
  );
  assert.equal(stripCircleDecorations('[Synthetic (X)] Synthetic Work [DL版]'), 'Synthetic Work');
  // 真ん中の括弧は題の一部
  assert.equal(stripCircleDecorations('Synthetic (中身) Work'), 'Synthetic (中身) Work');
  // 剥がし切ると何も残らない題は元のまま
  assert.equal(stripCircleDecorations('[Synthetic Only]'), '[Synthetic Only]');
  assert.equal(stripCircleDecorations(''), '');
  assert.equal(stripCircleDecorations(null), '');
});

test('剥がした題で実際に噛み合う (通しで)', async () => {
  const catalog = await freshCatalog();
  ownHitomi(catalog, 101, 'Synthetic Work One', 34, 'SYNTH0001');
  // アダプタが剥がした後の題で来る
  const title = stripCircleDecorations('(C81) [Synthetic Circle (Artist)] Synthetic Work One (Parody)');
  const [out] = catalog.annotate([foreign('nh:9006', title, 34)]);
  assert.equal(out.owned, true);
  assert.equal(out.ownedGalleryId, 101);
});
