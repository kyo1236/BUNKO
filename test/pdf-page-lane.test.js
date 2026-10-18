'use strict';

// 小さな一枚 (棚の表紙・頁一覧の小札) をどの行列へ入れるか。
//
// 行列を間違えると出方が壊れる:
//   - 表紙を 'idle' に入れると、本の裏の用意 (何百頁) の後ろに並んで札が何秒も空になる
//   - 表紙を 'read' に入れると、一覧 30 枚が頁の送りより先に出て送りが待たされる (実測 460ms)
// どちらも画面を見ないと気付けないので、ここで釘を打っておく。

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const UNPACK = require.resolve('../src/lib/pdf-unpack');
const BAKER = require.resolve('../src/lib/page-baker');

const DROPPED = Symbol('dropped');
const asked = [];
const baked = [];
let unpackResult = { bytes: Buffer.from('x'), type: 'image/jpeg' };

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

stub(UNPACK, {
  DROPPED,
  unpackPage: async (file, index, options) => {
    asked.push({ file, index, ...options });
    return unpackResult;
  },
});
stub(BAKER, {
  bakePdfPage: async (file, index, width, format, options) => {
    baked.push({ file, index, width, format, ...options });
    return { bytes: Buffer.from('b'), type: 'image/jpeg' };
  },
});

const { renderPdfThumb } = require('../src/lib/pdf-page');

test.beforeEach(() => {
  asked.length = 0;
  baked.length = 0;
  unpackResult = { bytes: Buffer.from('x'), type: 'image/jpeg' };
});

const WANT = { width: 720, quality: 0.8 };

test('頁一覧の小札は既定で裏の行列 (idle) に入る', async () => {
  await renderPdfThumb('a.pdf', 3, WANT, 'thumbs:a');
  assert.strictEqual(asked[0].lane, 'idle');
  assert.strictEqual(asked[0].tag, 'thumbs:a');
});

test('棚の表紙は soon の行列に入る (裏でも読みでもない)', async () => {
  await renderPdfThumb('a.pdf', 0, WANT, 'cover:1', { lane: 'soon' });
  assert.strictEqual(asked[0].lane, 'soon');
});

test('焼き場へ落ちた時も行列の意図が伝わる (譲るのは idle だけ)', async () => {
  unpackResult = null;
  await renderPdfThumb('a.pdf', 0, WANT, 'cover:1', { lane: 'soon' });
  assert.strictEqual(baked[0].background, false);

  baked.length = 0;
  unpackResult = null;
  await renderPdfThumb('a.pdf', 3, WANT, 'thumbs:a');
  assert.strictEqual(baked[0].background, true);
});

test('取り下げられた小札は諦める (焼き場へ回さない)', async () => {
  unpackResult = DROPPED;
  const out = await renderPdfThumb('a.pdf', 3, WANT, 'thumbs:a');
  assert.strictEqual(out, null);
  assert.strictEqual(baked.length, 0, '取り下げた仕事を焼き場が拾い直すと、閉じた本を追い続ける');
});

test('抜けた頁には名前が付く (呼び手が名で並べる)', async () => {
  const out = await renderPdfThumb('a.pdf', 7, WANT, 'thumbs:a');
  assert.strictEqual(out.name, '7');
});

// 行列の名指しが無い古い呼び手 (手のひら版の頁・裏の用意) が今までどおりか
test('lane を名指さない呼び手は background から行列が決まる', () => {
  delete require.cache[UNPACK];
  const real = require(path.join('..', 'src', 'lib', 'pdf-unpack'));
  assert.strictEqual(real.laneOf(true, ''), 'idle', '裏の用意は idle');
  assert.strictEqual(real.laneOf(false, ''), 'read', '表の頁は read');
  assert.strictEqual(real.laneOf(true, 'soon'), 'soon', '名指しが勝つ');
  assert.strictEqual(real.laneOf(false, 'nope'), 'read', '知らない名は表に倒す');
});
