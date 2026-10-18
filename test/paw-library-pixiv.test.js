'use strict';

// 作者根に同居する pixiv の本 (url が原本) を paw-library がどう見るか。
// 釘: url で見分け、parseName を通さない (題の [12345678] を投稿 ID と取り違えない)、
// 札は網と同じ px:<投稿 ID> の顔、控えは url を持つ (版 2)。

const test = require('node:test');
const assert = require('node:assert/strict');

require('./helpers/stub-electron');

const pawLibrary = require('../src/lib/paw-library');

const ids = new Set(['ROOT', 'F1']);
const creators = new Map([['F1', '作者A']]);
const owners = new Map([['F1', 'F1']]);

test('url が pixiv の項目は pixiv の本になり、名前はそのまま題', () => {
  const raw = pawLibrary.shapeRaw({
    folders: ['F1'], name: '題 [12345678] の本', star: 3, ext: 'pdf', modificationTime: 1700000000000,
    url: 'https://www.pixiv.net/artworks/98765432',
  });
  assert.equal(raw.url, 'https://www.pixiv.net/artworks/98765432', '控えは url を持つ');
  const item = pawLibrary.buildItem('E1', raw, ids, creators, owners);
  assert.equal(item.source, 'pixiv');
  assert.equal(item.pixivId, '98765432');
  assert.equal(item.title, '題 [12345678] の本', '名前の [数字] を投稿 ID と読まない');
  assert.equal(item.postId, null);
  assert.equal(item.creator, '作者A');
  const card = pawLibrary.toGallery(item);
  assert.equal(card.id, 'px:98765432', '網と同じ顔');
  assert.equal(card.source, 'pixiv');
  assert.equal(card.owned, true);
  assert.equal(card.kind, 'eagleItem');
  assert.equal(card.eagleId, 'E1');
  assert.equal(card.url, 'https://www.pixiv.net/artworks/98765432');
  assert.deepEqual(card.artists, [{ type: 'artist', name: '作者A' }]);
});

test('url が無ければ今までどおり pawchive の本 (名前から日付と投稿 ID)', () => {
  const raw = pawLibrary.shapeRaw({ folders: ['F1'], name: '[20260918] [1234567] 題【3P】', ext: 'pdf', modificationTime: 1 });
  assert.equal(raw.url, '');
  const item = pawLibrary.buildItem('E2', raw, ids, creators, owners);
  assert.equal(item.source, undefined);
  assert.equal(item.postId, '1234567');
  assert.equal(item.title, '題');
  const card = pawLibrary.toGallery(item);
  assert.equal(card.id, 'pweagle:E2');
  assert.equal(card.source, 'pawchive');
});

test('pixivIdOf は artworks の URL だけを読む', () => {
  assert.equal(pawLibrary.pixivIdOf('https://www.pixiv.net/en/artworks/5'), '5');
  assert.equal(pawLibrary.pixivIdOf('https://example.com/artworks/5'), '');
  assert.equal(pawLibrary.pixivIdOf(''), '');
});
