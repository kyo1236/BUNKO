'use strict';

// 起動用の一枚 (既定 userData の config.json) の生読み。
// ここは config.load() より前・app が場所を決める前に走るので、
// electron にも config.js にも依らない。壊れていても起動を止めないことを固定する。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readBootConfig } = require('../src/lib/boot-config.js');

// 中身を書いた使い捨ての置き場を返す (null なら config.json を作らない)
function makeDir(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunko-boot-'));
  if (text != null) fs.writeFileSync(path.join(dir, 'config.json'), text);
  return dir;
}

test('dataDir と readOnly の両方があれば両方拾う', () => {
  const dir = makeDir(JSON.stringify({
    dataDir: 'E:\\mirror\\BUNKO-mirror', readOnly: true, zoom: 3,
  }));
  assert.deepStrictEqual(readBootConfig(dir), {
    dataDir: 'E:\\mirror\\BUNKO-mirror',
    readOnly: true,
  });
});

test('BOM 付きで書かれた config.json も読める', () => {
  const dir = makeDir('\uFEFF' + JSON.stringify({ dataDir: 'X:\\bunko-mirror' }));
  assert.deepStrictEqual(readBootConfig(dir), { dataDir: 'X:\\bunko-mirror' });
});

test('dataDir が無い・空・readOnly が false なら指さない (従来の起動)', () => {
  assert.deepStrictEqual(readBootConfig(makeDir(JSON.stringify({ zoom: 3 }))), {});
  assert.deepStrictEqual(readBootConfig(makeDir(JSON.stringify({ dataDir: '   ' }))), {});
  assert.deepStrictEqual(readBootConfig(makeDir(JSON.stringify({ readOnly: false }))), {});
  // 型違い (数値・配列) も指していない扱い
  assert.deepStrictEqual(readBootConfig(makeDir(JSON.stringify({ dataDir: 5, readOnly: 1 }))), {});
});

test('壊れた JSON・ファイル無し・置き場無しは {} (起動を止めない)', () => {
  assert.deepStrictEqual(readBootConfig(makeDir('{ dataDir: ')), {});
  assert.deepStrictEqual(readBootConfig(makeDir(JSON.stringify(['a']))), {});
  assert.deepStrictEqual(readBootConfig(makeDir(null)), {});
  assert.deepStrictEqual(readBootConfig(''), {});
});
