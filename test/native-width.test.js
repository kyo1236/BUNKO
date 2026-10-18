'use strict';

// 焼き場が「原寸」で描くために、頁に貼られた絵の幅を pdf.js の描画命令から拾う所。
// 頁の寸法 (72dpi のポイント) では絵が潰れるので、絵そのものの幅が要る

const test = require('node:test');
const assert = require('node:assert');

const { pick } = require('../src/lan/native-width');

const OPS = { paintImageXObject: 85, paintImageXObjectRepeat: 88, paintInlineImageXObject: 86, save: 10 };

test('一番大きな絵の幅を返す', () => {
  const objs = { img_a: { width: 2150, height: 3035 }, img_b: { width: 640, height: 480 } };
  const fnArray = [OPS.save, OPS.paintImageXObject, OPS.paintImageXObject];
  const argsArray = [[], ['img_b'], ['img_a']];
  assert.strictEqual(pick(OPS, fnArray, argsArray, (name) => objs[name] || null), 2150);
});

test('絵が無い頁 (文字だけ) は 0', () => {
  assert.strictEqual(pick(OPS, [OPS.save], [[]], () => null), 0);
});

test('まだ届いていない絵 (lookup が null) は数えない', () => {
  const fnArray = [OPS.paintImageXObject];
  assert.strictEqual(pick(OPS, fnArray, [['missing']], () => null), 0);
});

test('繰り返し貼りと埋め込み (inline) の絵も見る', () => {
  const fnArray = [OPS.paintImageXObjectRepeat, OPS.paintInlineImageXObject];
  const argsArray = [['img_r'], [{ width: 900, height: 100 }]];
  const lookup = (name) => (name === 'img_r' ? { width: 1200, height: 1600 } : null);
  assert.strictEqual(pick(OPS, fnArray, argsArray, lookup), 1200);
});
