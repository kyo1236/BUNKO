'use strict';

// 二重起動の錠の固定。main.js は electron 無しでは require できないため、
// tray-close.test.js と同じくソースの形で押さえる。トレイに畳んだ BUNKO が
// 居るのにもう一度起動すると、錠が無ければ 2 本目が同じ置き場を取り合って
// どちらの窓も出ない (実機で起きた)。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const MAIN_PATH = path.join(__dirname, '..', 'src', 'main.js');
const source = fs.readFileSync(MAIN_PATH, 'utf8');

test('錠は置き場を決めた後・whenReady より前で取り、取れなければ退く', () => {
  const lock = source.indexOf('app.requestSingleInstanceLock()');
  assert.ok(lock >= 0, '錠を取っていない');
  const ready = source.indexOf('app.whenReady()');
  assert.ok(ready >= 0, 'whenReady が見つからない');
  assert.ok(lock < ready, '錠は whenReady より前で取る');
  // 錠は置き場 (userData) ごと。--data-dir / --user-data-dir を決める前に取ると
  // 写しの機体や使い捨ての検証用起動が素の BUNKO と食い合う
  const setPath = source.lastIndexOf("app.setPath('userData'");
  assert.ok(setPath >= 0 && setPath < lock, '錠は userData を決めた後で取る');
  const guard = source.match(/if \(!app\.requestSingleInstanceLock\(\)\) \{[\s\S]*?\r?\n\}/);
  assert.ok(guard, '錠が取れなかったときの受けが見つからない');
  assert.ok(guard[0].includes('app.quit();'));
  // quit は非同期。即抜けないと二人目が IPC や台帳まで走ってしまう
  assert.ok(guard[0].includes('process.exit(0);'));
});

test('二人目が来たら先客の窓を出す', () => {
  const handler = source.match(/app\.on\('second-instance', \(\) => \{[\s\S]*?\r?\n\}\);/);
  assert.ok(handler, 'second-instance の受けが見つからない');
  // 畳んでいれば窓を出し、捨てた後なら建て直すのは showFromTray の仕事
  assert.ok(handler[0].includes('showFromTray();'));
  assert.ok(handler[0].includes('mainWindow.restore();'));
});
