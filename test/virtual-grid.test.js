'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const VirtualGrid = require('../src/renderer/virtual-grid');

const items = (count) => Array.from({ length: count }, (_, id) => ({ id }));

test('先頭では表示行と下側overscanだけを返す', () => {
  const result = VirtualGrid.plan({
    items: items(1000), columns: 5, rowHeight: 100,
    scrollTop: 0, viewportHeight: 250, overscanRows: 2,
  });
  assert.deepEqual(
    { startRow: result.startRow, endRow: result.endRow, startIndex: result.startIndex, endIndex: result.endIndex },
    { startRow: 0, endRow: 5, startIndex: 0, endIndex: 25 },
  );
  assert.equal(result.topSpacer, 0);
  assert.equal(result.bottomSpacer, 19500);
  assert.deepEqual(result.items.map((item) => item.id), Array.from({ length: 25 }, (_, id) => id));
});

test('中間では上下overscanを含むbounded row windowとspacerを返す', () => {
  const result = VirtualGrid.plan({
    items: items(1000), columns: 5, rowHeight: 100,
    scrollTop: 1000, viewportHeight: 250, overscanRows: 2,
  });
  assert.equal(result.startRow, 8);
  assert.equal(result.endRow, 15);
  assert.equal(result.startIndex, 40);
  assert.equal(result.endIndex, 75);
  assert.equal(result.items.length, 35);
  assert.equal(result.topSpacer, 800);
  assert.equal(result.bottomSpacer, 18500);
  assert.equal(result.topSpacer + (result.endRow - result.startRow) * 100 + result.bottomSpacer, result.totalHeight);
});

test('行途中からのviewportは下端にかかる行も含める', () => {
  const result = VirtualGrid.plan({
    items: items(30), columns: 3, rowHeight: 100,
    scrollTop: 50, viewportHeight: 100, overscanRows: 0,
  });
  assert.equal(result.startRow, 0);
  assert.equal(result.endRow, 2);
  assert.equal(result.startIndex, 0);
  assert.equal(result.endIndex, 6);
});

test('末尾より先のscrollTopは実在範囲へ丸め、端数行を欠落させない', () => {
  const result = VirtualGrid.plan({
    items: items(23), columns: 5, rowHeight: 80,
    scrollTop: 99999, viewportHeight: 160, overscanRows: 1,
  });
  assert.equal(result.scrollTop, 240);
  assert.equal(result.startRow, 2);
  assert.equal(result.endRow, 5);
  assert.equal(result.startIndex, 10);
  assert.equal(result.endIndex, 23);
  assert.equal(result.bottomSpacer, 0);
});

test('空一覧と不正な寸法でも有限の安全な計画を返す', () => {
  const result = VirtualGrid.plan({ items: [], columns: 0, rowHeight: 0, scrollTop: -10, viewportHeight: NaN });
  assert.equal(result.columns, 1);
  assert.equal(result.rowHeight, 1);
  assert.equal(result.totalHeight, 0);
  assert.deepEqual(result.items, []);
});
