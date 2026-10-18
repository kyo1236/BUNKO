'use strict';

// 栞 (reading.json) が積む読了の履歴の固定。
// finished は「今の頁が最終頁か」なので開き直すと消えるが、読了回数
// (finishedCount)・最終読了日 (finishedAt)・初回日 (firstOpenedAt) は残る。
// electron は偽物に差し替え、reading.json はこのテスト専用の一時領域に置く。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { installStub } = require('./helpers/stub-electron-2.js');
const { userData } = installStub();

// 旧版が書いた形 (後ろ 3 つを持たない項目) を先に置いてから読ませる
fs.writeFileSync(path.join(userData, 'reading.json'), JSON.stringify({
  r0: { page: 9, pageCount: 10, updatedAt: 1, finished: true },
}));

const reading = require('../src/lib/reading-store.js');

test.after(() => reading.flush());

test('初回の set: 初回日が入り、読了は 0 回・最終読了日は無し', () => {
  const saved = reading.set('r1', { page: 3, pageCount: 20, finished: false });
  assert.strictEqual(saved.page, 3);
  assert.strictEqual(saved.finished, false);
  assert.strictEqual(saved.finishedCount, 0);
  assert.strictEqual(saved.finishedAt, null);
  assert.ok(Number(saved.firstOpenedAt) > 0);
});

test('読了へ転じた時に 1 回数え、最終読了日が入る。初回日は動かない', () => {
  const first = reading.set('r2', { page: 0, pageCount: 10, finished: false });
  const done = reading.set('r2', { page: 9, pageCount: 10, finished: true });
  assert.strictEqual(done.finishedCount, 1);
  assert.ok(Number(done.finishedAt) > 0);
  assert.strictEqual(done.firstOpenedAt, first.firstOpenedAt);
  // 読了のまま置き直しても増えない
  const again = reading.set('r2', { page: 9, pageCount: 10, finished: true });
  assert.strictEqual(again.finishedCount, 1);
  assert.strictEqual(again.finishedAt, done.finishedAt);
});

test('読了後に頭へ戻しても、回数と最終読了日は残る', () => {
  reading.set('r3', { page: 9, pageCount: 10, finished: true });
  const done = reading.get('r3');
  const reopened = reading.set('r3', { page: 0, pageCount: 10, finished: false });
  assert.strictEqual(reopened.finished, false);
  assert.strictEqual(reopened.finishedCount, 1);
  assert.strictEqual(reopened.finishedAt, done.finishedAt);
  assert.strictEqual(reopened.firstOpenedAt, done.firstOpenedAt);
});

test('二周目を読み終えると 2 回になり、最終読了日が新しくなる', () => {
  reading.set('r4', { page: 9, pageCount: 10, finished: true });
  const first = reading.get('r4');
  reading.set('r4', { page: 0, pageCount: 10, finished: false });
  const second = reading.set('r4', { page: 9, pageCount: 10, finished: true });
  assert.strictEqual(second.finishedCount, 2);
  assert.ok(Number(second.finishedAt) >= Number(first.finishedAt));
  assert.strictEqual(second.firstOpenedAt, first.firstOpenedAt);
});

test('後ろ 3 つを持たない古い項目からでも続けて積める', () => {
  // 読み込んだ時点では旧い形のまま (勝手に書き足さない)
  assert.deepStrictEqual(reading.get('r0'), {
    page: 9, pageCount: 10, updatedAt: 1, finished: true,
  });
  // 開き直す: 既に読了だった項目を数え直したりはしない (回数は 0 のまま)
  const reopened = reading.set('r0', { page: 0, pageCount: 10, finished: false });
  assert.strictEqual(reopened.finishedCount, 0);
  assert.strictEqual(reopened.finishedAt, null);
  assert.ok(Number(reopened.firstOpenedAt) > 0);
  // ここから先の読了はきちんと積む
  const done = reading.set('r0', { page: 9, pageCount: 10, finished: true });
  assert.strictEqual(done.finishedCount, 1);
  assert.ok(Number(done.finishedAt) > 0);
});

test('読む画面が添えた作者 (by) を残し、添えない呼び手 (手のひら版) は前の物を消さない。creatorReads は作者ごとの最後の時刻', () => {
  const saved = reading.set('px:1', { page: 1, pageCount: 5, finished: false, by: ['pixiv:42', 'bogus', 'name:見本', 'pixiv:42'] });
  assert.deepStrictEqual(saved.by, ['pixiv:42', 'name:見本'], '形の違う物と重なりは捨てる');
  const phone = reading.set('px:1', { page: 2, pageCount: 5, finished: false });
  assert.deepStrictEqual(phone.by, ['pixiv:42', 'name:見本']);
  const reads = reading.creatorReads();
  assert.strictEqual(reads['pixiv:42'], phone.updatedAt);
  assert.strictEqual(reads['name:見本'], phone.updatedAt);
  assert.strictEqual(reading.summary()['px:1'].by, undefined, '要約の形は変えない (手のひら版と所持作品の並びが使う)');
});
