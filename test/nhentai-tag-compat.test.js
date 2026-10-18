'use strict';

// nhentai のタグを hitomi と噛み合わせる。語はすべて合成 (実在の蔵書に由来しない)。
//
// nhentai は内容タグを型分けせず全部 'tag' で寄越す。hitomi は female:/male:/tag:
// に分かれていて、日本語の札 (tag_labels) も hitomi の型の下に溜まる。
// そのままだと (1) nhentai のタグだけ英語のまま出る (2) 押しても hitomi では
// 引けない、の二つが起きる。
const test = require('node:test');
const assert = require('node:assert/strict');
const { installStub } = require('./helpers/stub-electron-2.js');

installStub();
const { Catalog } = require('../src/lib/catalog.js');
const nhentai = require('../src/lib/sources/nhentai.js');

async function freshCatalog() {
  const catalog = new Catalog();
  await catalog.init();
  if (catalog.persistTimer) clearTimeout(catalog.persistTimer);
  return catalog;
}

// hitomi の作品を台帳へ置く (gallery_tags と tag_labels がこれで埋まる)
function seedHitomiTags(catalog, galleryId, tags) {
  catalog.db.run('INSERT OR REPLACE INTO galleries (id, title, fetched_at) VALUES (?, ?, ?)',
    [galleryId, 'Synthetic Gallery', Date.now()]);
  for (const [type, name] of tags) {
    catalog.db.run('INSERT OR IGNORE INTO gallery_tags (gallery_id, type, name) VALUES (?, ?, ?)',
      [galleryId, type, name]);
  }
  catalog.tagTypeIndex = null;
}

// 札は表へ入れて、本体の読み直しに任せる (鍵の組み方を試験側で真似しない)
function seedLabel(catalog, type, name, label) {
  catalog.db.run(
    'INSERT OR REPLACE INTO tag_labels (type, name, label, source, votes) VALUES (?, ?, ?, ?, ?)',
    [type, name, label, 'test', 1],
  );
  catalog.loadTagLabels();
}

const nhGallery = (tags) => ({
  id: 'nh:1', source: 'nhentai', title: 'Synthetic Work', error: false,
  artists: [], groups: [], series: [], characters: [],
  tags: tags.map((name) => ({ type: 'tag', name, negative: false })),
});

test('名前だけのタグは、hitomi で型が一つに定まるときだけ型が付く', async () => {
  const catalog = await freshCatalog();
  seedHitomiTags(catalog, 101, [
    ['female', 'synthetic alpha'],   // female にしか無い
    ['male', 'synthetic beta'],      // male にしか無い
    ['female', 'synthetic gamma'],   // 両方に在る = 定まらない
    ['male', 'synthetic gamma'],
    ['tag', 'synthetic delta'],      // tag のまま
  ]);

  assert.equal(catalog.hitomiTagType('synthetic alpha'), 'female');
  assert.equal(catalog.hitomiTagType('synthetic beta'), 'male');
  assert.equal(catalog.hitomiTagType('synthetic gamma'), null, '両方に在る語は決めない');
  assert.equal(catalog.hitomiTagType('synthetic delta'), 'tag');
  assert.equal(catalog.hitomiTagType('synthetic unknown'), null, '台帳に無い語も決めない');
});

test('annotate は nhentai のタグにだけ hitomi の型を添える (型そのものは書き換えない)', async () => {
  const catalog = await freshCatalog();
  seedHitomiTags(catalog, 101, [['female', 'synthetic alpha'], ['female', 'synthetic gamma'], ['male', 'synthetic gamma']]);

  const [out] = catalog.annotate([nhGallery(['synthetic alpha', 'synthetic gamma'])]);
  const [alpha, gamma] = out.tags;
  assert.equal(alpha.type, 'tag', '出所は nhentai のまま');
  assert.equal(alpha.hitomiType, 'female', 'hitomi での型を添える');
  assert.equal(gamma.hitomiType, undefined, '定まらない語には添えない');

  // hitomi の作品には添えない (もともと型が付いている)
  const [hit] = catalog.annotate([{
    id: '101', source: 'hitomi', title: 'Synthetic Gallery', error: false,
    artists: [], groups: [], series: [], characters: [],
    tags: [{ type: 'female', name: 'synthetic alpha', negative: false }],
  }]);
  assert.equal(hit.tags[0].hitomiType, undefined);
});

test('日本語の札は hitomi の型の下から引く (nhentai のタグが英語のまま出ない)', async () => {
  const catalog = await freshCatalog();
  seedLabel(catalog, 'female', 'synthetic alpha', '合成アルファ');
  seedLabel(catalog, 'male', 'synthetic beta', '合成ベータ');

  // 'tag' で引いても hitomi 側の札へ回る
  assert.equal(catalog.lookupTagLabel('tag', 'synthetic alpha'), '合成アルファ');
  assert.equal(catalog.lookupTagLabel('tag', 'synthetic beta'), '合成ベータ');
  // 逆向きには回さない (hitomi の型で引けなければ、それは本当に無い)
  assert.equal(catalog.lookupTagLabel('female', 'synthetic beta'), null);

  const [out] = catalog.annotate([nhGallery(['synthetic alpha'])]);
  assert.equal(out.tags[0].label, '合成アルファ', '札まで届く');
});

test('gallery_tags を書き換えたら索引を組み直す', async () => {
  const catalog = await freshCatalog();
  seedHitomiTags(catalog, 101, [['female', 'synthetic alpha']]);
  assert.equal(catalog.hitomiTagType('synthetic alpha'), 'female');

  // storeGalleryMeta の道 (tagTypeIndex を落とす) を通す
  catalog.storeGalleryMeta({
    id: 102,
    source: 'hitomi',
    title: 'Synthetic Gallery Two',
    tags: [{ type: 'male', name: 'synthetic alpha' }],
  });
  assert.equal(catalog.hitomiTagType('synthetic alpha'), null, '両方に在るので決めなくなる');
});

test('一覧の行はタグが載っていれば通す (無ければ空のまま)', () => {
  // 網の返事にタグが無いとき: 今までどおり
  const bare = nhentai.serializeListItem({ id: 7, english_title: 'Synthetic', num_pages: 20 });
  assert.equal(bare.id, 'nh:7');
  assert.deepEqual(bare.tags, [], 'タグは空');
  assert.deepEqual(bare.artists, []);
  assert.equal(bare.type, 'doujinshi', '分からないときの既定');

  // 載っているとき: 詳細を引かずに札へ通す
  const rich = nhentai.serializeListItem({
    id: 8,
    english_title: 'Synthetic Two',
    num_pages: 30,
    tags: [
      { type: 'tag', name: 'synthetic alpha' },
      { type: 'artist', name: 'synthetic artist' },
      { type: 'parody', name: 'synthetic series' },
      { type: 'category', name: 'manga' },
      { type: 'language', name: 'japanese' },
    ],
  });
  assert.deepEqual(rich.tags.map((t) => t.name), ['synthetic alpha'], '内容タグ');
  assert.deepEqual(rich.artists.map((t) => t.name), ['synthetic artist']);
  assert.deepEqual(rich.series.map((t) => t.name), ['synthetic series'], 'parody は series へ');
  assert.equal(rich.type, 'manga', '種別も行から読む');
  assert.equal(rich.language && rich.language.name, 'japanese');
});
