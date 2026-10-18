'use strict';

// 未照合の Eagle アイテムの疑似ギャラリー (eagleItemGallery) が、写し (母艦と別の根で
// 同じライブラリを開く機体) でも引けることの固定。台帳の items.path は母艦の表記のまま
// 写るので、読み替え後の道で path を引くと一件も当たらない (2026-09-19 に踏んだ)。
// 机上版の詳細 ('gallery' IPC) と手のひら版の一冊の札 (lan-server) が同じ口を使う。題は合成

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installStub } = require('./helpers/stub-electron-2.js');

installStub();
const { Catalog } = require('../src/lib/catalog.js');

// 母艦の表記 (別のドライブの同名ライブラリ) で台帳に入っている行を、写しの根 (一時ディレクトリ) から引く
const MASTER_IMAGES = ['D:', 'synthetic', 'mybooks.library', 'images'].join(path.sep);

async function freshCatalog() {
  const catalog = new Catalog();
  await catalog.init();
  if (catalog.persistTimer) clearTimeout(catalog.persistTimer);
  return catalog;
}

test('写しの根で開いても、未照合アイテムの疑似ギャラリーが台帳の題で引ける', async () => {
  const mirrorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bunko-mirror-'));
  const root = path.join(mirrorRoot, 'mybooks.library');
  fs.mkdirSync(path.join(root, 'images'), { recursive: true });
  try {
    const catalog = await freshCatalog();
    catalog.localLibraryRoot = () => root; // 写しの機体の eagleLibrary
    catalog.upsert({
      source: 'eagle',
      filePath: path.join(MASTER_IMAGES, 'e7.info'),
      galleryId: null,
      title: '合成の題 e7',
      star: 3,
      addedAt: 1700000000000,
      eagleTags: ['synthetic'],
    });
    catalog.rebuildMemory();
    // 読み替えは効いている (実在の確認はこの道で行う)
    assert.equal(catalog.eagleBasePath.get('e7'), path.join(root, 'images', 'e7.info'));
    const gallery = catalog.eagleItemGallery('e7');
    assert.ok(gallery, '疑似ギャラリーが引けない');
    assert.equal(gallery.id, 'pweagle:e7');
    assert.equal(gallery.title, '合成の題 e7');
    assert.equal(gallery.star, 3);
    assert.deepEqual(gallery.tags.map((tag) => tag.name), ['synthetic']);
    assert.equal(gallery.unmatched, true);
    // 一覧 (unmatchedEagleEntries) と同じ行から起こすので、台帳に無い id は null
    assert.equal(catalog.eagleItemGallery('nobody'), null);
  } finally {
    fs.rmSync(mirrorRoot, { recursive: true, force: true });
  }
});

// nhentai・E-Hentai に手で結んだ項目 (gallery_id が 'nh:123' 型) は hitomi の素性の表に居ない。
// 未照合と同じ疑似ギャラリーで出さないと、所持作品の一覧からも作者頁からも消える (2026-09-24)
test('nhentai に手で結んだ Eagle の項目は、未照合を混ぜない設定でも疑似ギャラリーで所持作品に並ぶ', async () => {
  const mirrorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bunko-mirror-'));
  const root = path.join(mirrorRoot, 'mybooks.library');
  fs.mkdirSync(path.join(root, 'images'), { recursive: true });
  try {
    const catalog = await freshCatalog();
    catalog.localLibraryRoot = () => root;
    catalog.upsert({
      source: 'eagle',
      filePath: `${path.join(MASTER_IMAGES, 'n1.info')}#nh:555`,
      galleryId: 'nh:555',
      title: '合成の題 n1',
      star: 2,
      addedAt: 1700000000000,
      eagleTags: ['synthetic'],
    });
    catalog.upsert({
      source: 'eagle',
      filePath: path.join(MASTER_IMAGES, 'u1.info'),
      galleryId: null,
      title: '合成の題 u1',
      star: 0,
      addedAt: 1700000000001,
      eagleTags: [],
    });
    catalog.rebuildMemory();
    const linked = catalog.eagleItemGallery('n1');
    assert.ok(linked, 'nhentai に結んだ項目の疑似ギャラリーが引けない');
    assert.equal(linked.id, 'pweagle:n1');
    assert.equal(linked.badge, 'nhentai');
    assert.equal(linked.unmatched, false);
    assert.equal(linked.linkedKey, 'nh:555');
    assert.equal(linked.url, 'https://nhentai.net/g/555/');
    const plain = catalog.eagleItemGallery('u1');
    assert.equal(plain.badge, '未照合');
    assert.equal(plain.unmatched, true);
    const without = catalog.searchLibrary({ pageSize: 24, includeUnmatched: false }).galleries.map((g) => g.id);
    assert.ok(without.includes('pweagle:n1'), '未照合を混ぜない設定でも nhentai に結んだ項目は並ぶ');
    assert.ok(!without.includes('pweagle:u1'), '未照合は設定どおり混ぜない');
    const withAll = catalog.searchLibrary({ pageSize: 24, includeUnmatched: true }).galleries.map((g) => g.id);
    assert.ok(withAll.includes('pweagle:n1') && withAll.includes('pweagle:u1'));
    assert.equal(catalog.libraryStatus().unmatchedEagle, 1, 'nhentai に結んだ項目は未照合に数えない');
  } finally {
    fs.rmSync(mirrorRoot, { recursive: true, force: true });
  }
});
