'use strict';

// 札を押して飛ぶ語は hitomi の言い方で組まれる。それが **そのまま別のサイトへ
// 飛ぶ** ので、受け取る側の言い方へ直す層。語はすべて合成 (実在の蔵書に由来しない)。
//
// 直す前に実測したもの (2026-09-15):
//   nhentai へ "either:mind_control" -> 0 件      (either は BUNKO 内の符丁)
//   nhentai へ "female:big_breasts"  -> 3 件      (型が無く字面の一致になる)
//   nhentai へ "mind_control"        -> 1 件      (下線が語を繋ぐ)
//   直した後: 10,000 件 / 113,290 件
const test = require('node:test');
const assert = require('node:assert/strict');

const { forNhentai, forEhentai } = require('../src/lib/sources/tag-query.js');

test('nhentai: 内容タグは型を落として tag: に寄せ、下線は空白へ戻す', () => {
  assert.equal(forNhentai('either:synthetic_alpha'), 'tag:"synthetic alpha"');
  assert.equal(forNhentai('female:synthetic_alpha'), 'tag:"synthetic alpha"');
  assert.equal(forNhentai('male:synthetic_alpha'), 'tag:"synthetic alpha"');
  // 一語なら括らない (括る必要が無いのに括ると読みにくい)
  assert.equal(forNhentai('female:synthetic'), 'tag:synthetic');
});

test('nhentai: 持っている型はそのまま、呼び名の違う型は言い換える', () => {
  assert.equal(forNhentai('artist:synthetic_artist'), 'artist:"synthetic artist"');
  assert.equal(forNhentai('group:synthetic_group'), 'group:"synthetic group"');
  assert.equal(forNhentai('character:synthetic_chara'), 'character:"synthetic chara"');
  assert.equal(forNhentai('language:japanese'), 'language:japanese');
  // hitomi の series は nhentai では parody
  assert.equal(forNhentai('series:synthetic_series'), 'parody:"synthetic series"');
});

test('nhentai: 持っていない型は語ごと落とす (字面で誤爆させない)', () => {
  assert.equal(forNhentai('type:doujinshi'), '');
  assert.equal(forNhentai('either:synthetic_alpha type:manga'), 'tag:"synthetic alpha"');
});

test('否定は保つ', () => {
  assert.equal(forNhentai('-female:synthetic_alpha'), '-tag:"synthetic alpha"');
  assert.equal(forEhentai('-either:synthetic_alpha'), '-"synthetic alpha"');
});

test('型の付いていない語 (利用者が打った文) は触らない', () => {
  assert.equal(forNhentai('synthetic alpha'), 'synthetic alpha');
  assert.equal(forNhentai('synthetic_alpha'), 'synthetic_alpha', '打った下線は勝手に壊さない');
  assert.equal(forNhentai(''), '');
  assert.equal(forNhentai(null), '');
});

test('複数の語が混ざっても、それぞれ直して並びを保つ', () => {
  assert.equal(
    forNhentai('female:synthetic_alpha series:synthetic_series language:japanese'),
    'tag:"synthetic alpha" parody:"synthetic series" language:japanese',
  );
});

test('E-Hentai は hitomi と同じ語彙: either だけ型を外す', () => {
  // あちらは female:/male: を持っているので触らない
  assert.equal(forEhentai('female:synthetic_alpha'), 'female:synthetic_alpha');
  assert.equal(forEhentai('series:synthetic_series'), 'series:synthetic_series');
  assert.equal(forEhentai('type:doujinshi'), 'type:doujinshi');
  // either は BUNKO 内の符丁。素の語に落とす
  assert.equal(forEhentai('either:synthetic_alpha'), '"synthetic alpha"');
  assert.equal(forEhentai('either:synthetic'), 'synthetic');
});
