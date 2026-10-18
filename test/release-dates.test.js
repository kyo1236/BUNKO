'use strict';

// 名前に日付の無い所持の本の公開日の控え (src/lib/release-dates.js)。
// 押さえるのは: 形の悪い行を捨てる・確かさの低い行で高い行を上書きしない・外す・写しは書かない・
// 外 (同期・道具) が差し替えたら読み直す・題や URL を持たない。
// 題はすべて見本 (実在の物は使わない)。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ReleaseDates } = require('../src/lib/release-dates');
const stateFile = require('../src/lib/state-file');

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-dates-'));
  return path.join(dir, 'release-dates.json');
}

test('書いて読む: 形の悪い行は捨て、推定 (medium / low) には guess の印', () => {
  const file = tempFile();
  const store = new ReleaseDates({ file, now: () => Date.parse('2026-09-24T00:00:00Z') });
  const result = store.set([
    { eagleId: 'AAAA1', date: '2023-01-02', confidence: 'high', basis: 'pixiv-post', method: 'title-unique', hits: [{ site: 'pixiv', id: 'px:123', date: '2023-01-02' }] },
    { eagleId: 'AAAA2', date: '2022-05-06', confidence: 'low', basis: 'hitomi-uploaded' },
    { eagleId: 'AAAA3', date: '2022-13-01', confidence: 'high' },
    { eagleId: 'AAAA4', date: '2022-01-01', confidence: 'sure' },
    { eagleId: '../x', date: '2022-01-01', confidence: 'high' },
  ], { by: '試験' });
  assert.deepEqual(result, { ok: true, added: 2, updated: 0, removed: 0, skipped: 3 });
  const again = new ReleaseDates({ file });
  assert.equal(again.size(), 2);
  assert.equal(again.get('AAAA1').date, '2023-01-02');
  assert.equal(again.get('AAAA1').guess, false);
  assert.equal(again.get('AAAA1').by, '試験');
  assert.deepEqual(again.get('AAAA1').hits, [{ site: 'pixiv', id: 'px:123', date: '2023-01-02' }]);
  assert.equal(again.get('AAAA2').guess, true);
  assert.equal(again.get('nope'), null);
});

test('確かさの低い行で高い行を上書きしない。同じ確かさなら新しい方、remove で外す', () => {
  const store = new ReleaseDates();
  store.set([{ eagleId: 'BBBB1', date: '2020-01-01', confidence: 'high' }]);
  assert.equal(store.set([{ eagleId: 'BBBB1', date: '2019-01-01', confidence: 'low' }]).skipped, 1);
  assert.equal(store.get('BBBB1').date, '2020-01-01');
  assert.equal(store.set([{ eagleId: 'BBBB1', date: '2020-02-02', confidence: 'high' }]).updated, 1);
  assert.equal(store.get('BBBB1').date, '2020-02-02');
  assert.equal(store.set([{ eagleId: 'BBBB1', date: '2020-03-03', confidence: 'exact' }]).updated, 1);
  const version = store.version();
  assert.equal(store.set([{ eagleId: 'BBBB1', remove: true }]).removed, 1);
  assert.equal(store.get('BBBB1'), null);
  assert.ok(store.version() > version, '変わるたびに版が進む (Home が組み直しを知る)');
});

test('題と URL は持たない (根拠は作品の id だけ)', () => {
  const file = tempFile();
  const store = new ReleaseDates({ file });
  store.set([{
    eagleId: 'CCCC1', date: '2024-04-04', confidence: 'high', basis: 'pixiv-post', title: '見本の題',
    hits: [{ site: 'hitomi', id: '12345', url: 'https://hitomi.la/doujinshi/mihon-12345.html', title: '見本の題' }],
  }]);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes('見本の題'));
  assert.ok(!text.includes('hitomi.la'));
});

test('外が差し替えたら読み直す (写しの同期・母艦の道具)。写しは書かない', () => {
  const file = tempFile();
  let now = 1000;
  const reader = new ReleaseDates({ file, now: () => now });
  assert.equal(reader.size(), 0);
  const writer = new ReleaseDates({ file });
  writer.set([{ eagleId: 'DDDD1', date: '2021-06-06', confidence: 'high' }]);
  assert.equal(reader.get('DDDD1'), null, 'すぐには stat を見ない');
  now += 6000;
  assert.equal(reader.get('DDDD1').date, '2021-06-06', '間合いの後に読み直す');
  try {
    stateFile.setRole({ readOnly: true });
    const mirror = new ReleaseDates({ file });
    const result = mirror.set([{ eagleId: 'DDDD2', date: '2021-07-07', confidence: 'high' }]);
    assert.equal(result.ok, false, '写しは書かない');
    assert.equal(new ReleaseDates({ file }).get('DDDD2'), null);
  } finally {
    stateFile.resetForTest();
  }
});
