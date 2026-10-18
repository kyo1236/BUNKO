'use strict';

// 照合し直しで Eagle アイテムが別の作品へ結び直された時、前の作品のために BUNKO が
// 書き足した札を引くことの固定。付け足すだけだった頃は前の作者・サークルの札が残り、
// Home のタグの道がそれを信じて 23 冊を別の作者の頁に出した (2026-09-24)。
// 引くのは BUNKO が書いたと記録にある札だけ。利用者の札と、出どころの分からない
// 古い記録 (added 列より前) には触れない。Eagle への書き込みは API (updateTags) だけ。
// 札の名前はすべて合成

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { installStub } = require('./helpers/stub-electron-2.js');

installStub();
const { Catalog } = require('../src/lib/catalog.js');
const eagleApi = require('../src/lib/eagle-api.js');
const { EagleTagger } = require('../src/lib/eagle-tagger.js');

const IMAGES = ['D:', 'synthetic', 'mybooks.library', 'images'].join(path.sep);
const GID_A = 900001;
const GID_B = 900002;
const GID_BARE = 900003;

// 偽の Eagle: アイテムの札を覚え、書き込みの回数を数える
function fakeEagle(initial) {
  const items = new Map(Object.entries(initial).map(([id, tags]) => [id, [...tags]]));
  const calls = { get: 0, update: 0 };
  eagleApi.isAvailable = async () => true;
  eagleApi.getItem = async (id) => {
    calls.get += 1;
    if (!items.has(id)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return { id, tags: [...items.get(id)] };
  };
  eagleApi.updateTags = async (id, tags) => {
    calls.update += 1;
    items.set(id, [...tags]);
    return true;
  };
  return { items, calls };
}

async function freshCatalog() {
  const catalog = new Catalog();
  await catalog.init();
  if (catalog.persistTimer) clearTimeout(catalog.persistTimer);
  // 作品 A: 作者甲・組甲・共通の作者 / 作品 B: 作者乙・共通の作者 / 作品 BARE: 札の無い作者
  catalog.storeGalleryMeta({
    id: GID_A,
    source: 'hitomi',
    title: 'Synthetic A',
    artists: [{ name: 'synthetic artist a' }, { name: 'synthetic artist shared' }],
    groups: [{ name: 'synthetic circle a' }],
  });
  catalog.storeGalleryMeta({
    id: GID_B,
    source: 'hitomi',
    title: 'Synthetic B',
    artists: [{ name: 'synthetic artist b' }, { name: 'synthetic artist shared' }],
  });
  catalog.storeGalleryMeta({
    id: GID_BARE,
    source: 'hitomi',
    title: 'Synthetic Bare',
    artists: [{ name: 'synthetic artist unlabeled' }],
  });
  catalog.storeCreatorLabel('artist', 'synthetic artist a', '合成作者甲');
  catalog.storeCreatorLabel('group', 'synthetic circle a', '合成組甲');
  catalog.storeCreatorLabel('artist', 'synthetic artist shared', '合成共通');
  catalog.storeCreatorLabel('artist', 'synthetic artist b', '合成作者乙');
  return catalog;
}

// 名前から採れた ID で A に結ばれた Eagle アイテムを置く
function placeItem(catalog, eagleId, galleryId) {
  catalog.upsert({
    source: 'eagle',
    filePath: path.join(IMAGES, `${eagleId}.info`),
    galleryId,
    title: `合成の題 ${eagleId}`,
    star: null,
    addedAt: 1700000000000,
    eagleTags: null,
  });
  catalog.rebuildMemory();
}

// 照合器の通り道で別の作品へ結び直す (items の行が <base>#<gid> へ移る)
function relink(catalog, eagleId, galleryId) {
  assert.equal(
    catalog.addTitleMatch(eagleId, galleryId, `合成の題 ${eagleId}`, 'Synthetic', 'matched'),
    true,
  );
}

async function runTagger(catalog) {
  const tagger = new EagleTagger({ catalog, delay: 0 });
  const status = await tagger.run();
  if (catalog.persistTimer) clearTimeout(catalog.persistTimer);
  catalog.persistTimer = null;
  return status;
}

test('結び直すと、前の作品のために書き足した札だけを引き、利用者の札と共通の札は残す', async () => {
  const catalog = await freshCatalog();
  // 利用者は初めから「利用者の札」と、たまたま作者甲の日本語名を自分で付けていた
  const eagle = fakeEagle({ E1: ['利用者の札', '合成作者甲'] });
  placeItem(catalog, 'E1', GID_A);

  let status = await runTagger(catalog);
  assert.equal(status.pushed, 1);
  assert.deepEqual(eagle.items.get('E1'), ['利用者の札', '合成作者甲', '合成共通', '合成組甲']);
  assert.deepEqual(catalog.eagleTagPushFor('E1'), {
    galleryId: GID_A,
    added: ['合成共通', '合成組甲'],
  }, '書き足した物だけを自分の札として覚える (元から在った作者甲は利用者の物)');
  assert.deepEqual(catalog.eagleTagTargets(), [], '同じ作品のままなら二度は書かない');

  // 間に利用者が Eagle で札を足した
  eagle.items.get('E1').push('後から足した札');

  relink(catalog, 'E1', GID_B);
  assert.deepEqual(catalog.eagleTagTargets(), [{ eagleId: 'E1', galleryId: GID_B }], '結び直しは対象に戻る');

  status = await runTagger(catalog);
  assert.equal(status.pushed, 1);
  assert.equal(status.retracted, 1);
  assert.deepEqual(
    eagle.items.get('E1'),
    ['利用者の札', '合成作者甲', '合成共通', '後から足した札', '合成作者乙'],
    '組甲だけが引かれる。作者甲は利用者の札、共通は新しい作品の札でもある',
  );
  assert.deepEqual(catalog.eagleTagPushFor('E1'), {
    galleryId: GID_B,
    added: ['合成共通', '合成作者乙'],
  }, '引き継いだ共通の札も自分の札のまま (次の結び直しで引ける)');
  assert.deepEqual(catalog.eagleTagTargets(), []);
});

test('札の無い作品へ結び直しても、前の札は引く (空の記録で残し、ラベルが増えれば拾い直せる)', async () => {
  const catalog = await freshCatalog();
  const eagle = fakeEagle({ E2: ['利用者の札'] });
  placeItem(catalog, 'E2', GID_A);
  await runTagger(catalog);
  assert.deepEqual(eagle.items.get('E2'), ['利用者の札', '合成作者甲', '合成共通', '合成組甲']);

  relink(catalog, 'E2', GID_BARE);
  const status = await runTagger(catalog);
  assert.equal(status.retracted, 1);
  assert.deepEqual(eagle.items.get('E2'), ['利用者の札']);
  assert.deepEqual(catalog.eagleTagPushFor('E2'), { galleryId: GID_BARE, added: [] });
  const tags = catalog.queryValue('SELECT tags FROM eagle_tag_pushes WHERE eagle_id = ?', ['E2']);
  assert.equal(tags, '[]', '空の印 (ラベル学習で落とされて拾い直される)');
});

test('added 列より前の記録 (出どころ不明) は結び直しても何も引かない', async () => {
  const catalog = await freshCatalog();
  const eagle = fakeEagle({ E3: ['利用者の札', '合成作者甲', '合成組甲', '合成共通'] });
  placeItem(catalog, 'E3', GID_A);
  // 旧版の tagger が残した記録: 全体の札だけで、どれを書き足したかは分からない
  catalog.recordEagleTagPush('E3', GID_A, ['利用者の札', '合成作者甲', '合成組甲', '合成共通']);
  assert.deepEqual(catalog.eagleTagPushFor('E3'), { galleryId: GID_A, added: null });

  relink(catalog, 'E3', GID_B);
  const status = await runTagger(catalog);
  assert.equal(status.retracted, 0);
  assert.deepEqual(
    eagle.items.get('E3'),
    ['利用者の札', '合成作者甲', '合成組甲', '合成共通', '合成作者乙'],
    '古い札は残し、新しい作品の札を足すだけ',
  );
  assert.deepEqual(catalog.eagleTagPushFor('E3'), { galleryId: GID_B, added: ['合成作者乙'] },
    'ここから先は書き足した物を覚える');
});

test('Eagle から読めない時は台帳を書かず、前の記録のまま次回に回す', async () => {
  const catalog = await freshCatalog();
  const eagle = fakeEagle({ E4: [] });
  placeItem(catalog, 'E4', GID_A);
  await runTagger(catalog);
  relink(catalog, 'E4', GID_B);

  eagle.items.delete('E4');
  const status = await runTagger(catalog);
  assert.equal(status.failed, 1);
  assert.deepEqual(catalog.eagleTagPushFor('E4'), {
    galleryId: GID_A,
    added: ['合成作者甲', '合成共通', '合成組甲'],
  }, '引くべき札の記録が消えない');
  assert.deepEqual(catalog.eagleTagTargets(), [{ eagleId: 'E4', galleryId: GID_B }]);
});
