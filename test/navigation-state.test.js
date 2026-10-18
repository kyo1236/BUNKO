'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const NavigationState = require('../src/renderer/navigation-state');
const fs = require('node:fs');
const path = require('node:path');

test('履歴 snapshot は複製され、件数と履歴数が上限内に収まる', () => {
  const cache = NavigationState.createCache({ maxEntries: 2, maxItems: 3 });
  const galleries = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, nested: { owned: false } }));
  cache.put('a', { galleries, page: 8, pageSize: 2 });
  galleries[0].nested.owned = true;
  assert.equal(cache.get('a'), null, 'ページ途中を切り捨てる snapshot は保存しない');
  cache.put('a', { galleries: galleries.slice(0, 3), page: 2, pageSize: 2 });
  galleries[0].nested.owned = false;
  assert.equal(cache.get('a').galleries[0].nested.owned, true);
  assert.equal(cache.get('a').galleries.length, 3);
  assert.equal(cache.get('a').page, 2);
  cache.put('b', { galleries: [] });
  cache.put('c', { galleries: [] });
  assert.equal(cache.get('a'), null);
  assert.equal(cache.size, 2);
});

test('表示位置は作品 id とカード内 offset で復元する', () => {
  const cards = [
    { id: 'a', top: 100, height: 80 },
    { id: 'b', top: 180, height: 80 },
  ];
  const anchor = NavigationState.scrollAnchor(cards, 205);
  assert.deepEqual(anchor, { id: 'b', offset: 25 });
  assert.equal(NavigationState.anchorScrollTop(anchor, [{ id: 'b', top: 320, height: 80 }], 9), 345);
  assert.equal(
    NavigationState.anchorScrollTop({ id: 'b', offset: 292 }, [{ id: 'b', top: 320, height: 82 }], 9),
    401,
    'gridからlistへ縮小してもoffsetをカード外へ持ち越さない',
  );
  assert.equal(NavigationState.anchorScrollTop({ id: 'gone', offset: 1 }, cards, 77), 77);
});

test('詳細のpending応答はcached詳細を開いた世代より古ければ採用しない', async () => {
  const generation = NavigationState.createGeneration();
  const pendingA = generation.next();
  const cachedB = generation.next();
  assert.equal(generation.isCurrent(pendingA), false);
  assert.equal(generation.isCurrent(cachedB), true);
  generation.next(); // close
  assert.equal(generation.isCurrent(cachedB), false);
});

test('履歴復元は別操作が世代を進めた後にページ追加とscrollを行わない', async () => {
  const generation = NavigationState.createGeneration();
  const restore = generation.next();
  generation.next(); // user search/cancel
  assert.equal(generation.isCurrent(restore), false);
});

test('app配線は通常resetだけ復元世代を失効し、履歴とbootはtokenを引き回す', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  assert.match(
    source,
    /async function runSearch\(\{\s*reset = true, restoreToken = null, spanPages = 1, live = false,\s*\}/,
  );
  // live (打鍵ごとの引き直し) は履歴に残さない。残すと戻る先が一字ずつの残骸で埋まる
  assert.match(source, /if \(!navigating && !live\) pushHistory\(\)/);
  assert.match(source, /if \(reset && !live\) rememberHistory\(\)/);
  assert.match(source, /if \(reset && restoreToken == null\) historyRestoreToken \+= 1/);
  assert.match(source, /runSearch\(\{ reset: true, restoreToken \}\)/);
  // 起動時の復元: token を引き回しつつ、所持作品の棚は前回の頁数ぶん (spanPages) を一度に取る
  assert.match(source, /const restoreToken = \(historyRestoreToken \+= 1\);[\s\S]{0,600}?const searchPromise = runSearch\(\{\s*reset: true, restoreToken, spanPages: libraryScope\(\) \? Math\.min\(60, restorePages\) : 1,\s*\}\)/);
});
