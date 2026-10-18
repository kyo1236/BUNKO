'use strict';

// 表紙の寸法を一覧の項目に載せる (分かる源泉だけ)。流しの並べ方 (bunko-ui-model.waterfall) は
// item.width / item.height があれば絵を待たずに札の高さを決める。無いと表紙が届くたびに
// 縦横比を知って並べ直し、初めて見る一覧と送りで札が跳んでいた (ui-probe で CLS 0.09 前後)。

const test = require('node:test');
const assert = require('node:assert/strict');
const { record, coverSize } = require('../src/lib/sources/normalize');
const nhentai = require('../src/lib/sources/nhentai');
const hitomi = require('../src/lib/hitomi-service');

test('寸法は両方が正の数の時だけ載せる', () => {
  assert.deepEqual(coverSize(250, 334), { width: 250, height: 334 });
  assert.deepEqual(coverSize(0, 334), {});
  assert.deepEqual(coverSize(undefined, undefined), {});
  assert.deepEqual(coverSize('250', '334'), { width: 250, height: 334 });
  assert.equal('width' in record({ id: 1, source: 'x' }), false, '分からない源泉は今までどおり');
  assert.deepEqual([record({ id: 1, source: 'x', width: 10, height: 20 })].map((r) => [r.width, r.height]), [[10, 20]]);
});

test('nhentai: 一覧の行の thumbnail の寸法 (札の表紙はこの絵)', () => {
  const row = nhentai.serializeListItem({ id: 9, english_title: 'Synthetic', num_pages: 3, thumbnail_width: 250, thumbnail_height: 334 });
  assert.equal(row.width, 250);
  assert.equal(row.height, 334);
  const bare = nhentai.serializeListItem({ id: 10, english_title: 'Synthetic', num_pages: 3 });
  assert.equal('width' in bare, false);
});

test('hitomi: 1 頁目の寸法 (札の表紙は index 0)', () => {
  const gallery = {
    id: 1, title: { display: 'Synthetic' }, type: 'doujinshi', language: null,
    artists: [], groups: [], series: [], characters: [], tags: [],
    files: [{ width: 1280, height: 1810 }, { width: 900, height: 600 }],
    addedDate: null, publishedDate: null, isBlocked: false, video: null, url: '', translations: [],
  };
  const out = hitomi.serializeGallery(gallery);
  assert.equal(out.width, 1280);
  assert.equal(out.height, 1810);
  assert.equal('width' in hitomi.serializeGallery({ ...gallery, files: [] }), false, '頁が無ければ載せない');
});

test('流しは寸法があれば、覚えた縦横比が無くても表紙の高さをそれで決める', () => {
  const model = require('../src/renderer/bunko-ui-model.js');
  assert.ok(model && model.waterfall, 'waterfall が読める');
  const plan = model.waterfall([{ id: 'a', width: 200, height: 400 }, { id: 'b' }], { width: 400, min: 180, gap: 20, caption: 0 });
  const a = plan.positions.find((p) => p.item.id === 'a');
  const b = plan.positions.find((p) => p.item.id === 'b');
  assert.ok(Math.abs(a.coverHeight / a.width - 2) < 0.01, '縦 2 倍の表紙は高さ 2 倍で置く');
  assert.ok(Math.abs(b.coverHeight / b.width - 1.414) < 0.01, '寸法が無ければ今までどおり A 判の比');
});
