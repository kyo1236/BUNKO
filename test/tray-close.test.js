'use strict';

// トレイ常駐 (× で終了せず畳む) の固定。main.js は electron 無しでは
// require できないため、readonly-mode.test.js と同じくソースの形で押さえる。
// 「閉じたら終了」に戻ってしまう直しが入ったらここで気づく。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAIN_PATH = path.join(__dirname, '..', 'src', 'main.js');
const source = fs.readFileSync(MAIN_PATH, 'utf8');

test('× で閉じたときは終了を止めてトレイへ畳む', () => {
  const close = source.match(/mainWindow\.on\('close', \(event\) => \{[\s\S]*?\n {2}\}\);/);
  assert.ok(close, "mainWindow の 'close' 受けが見つからない");
  // 0 分なら従来どおり (畳まずそのまま閉じて終了する)
  assert.ok(close[0].includes('const minutes = trayCloseMinutes();'));
  assert.ok(close[0].includes('if (minutes <= 0) return;'));
  assert.ok(close[0].includes('event.preventDefault();'));
  assert.ok(close[0].includes('hideToTray(minutes);'));
});

test('畳んでいる間の窓の破棄ではアプリを終了させない', () => {
  const closed = source.match(/mainWindow\.on\('closed', \(\) => \{[\s\S]*?\n {2}\}\);/);
  assert.ok(closed, "mainWindow の 'closed' 受けが見つからない");
  assert.ok(closed[0].includes('if (trayHidden) return;'));
});

test('window-all-closed は畳むまでの分数を見てから終了する', () => {
  const handler = source.match(/app\.on\('window-all-closed', \(\) => \{[\s\S]*?\n\}\);/);
  assert.ok(handler, 'window-all-closed の受けが見つからない');
  assert.ok(handler[0].includes('if (trayCloseMinutes() > 0) return;'));
});

test('before-quit で終了の印を立てる (畳みが終了経路を塞がないように)', () => {
  const handler = source.match(/app\.on\('before-quit', \(\) => \{[\s\S]*?\n\}\);/);
  assert.ok(handler, 'before-quit の受けが見つからない');
  assert.ok(handler[0].includes('quitting = true;'));
});

test('畳むまでの分数の既定は 30 分', () => {
  // config は electron の app に userData を訊く。空の置き場を宛てて既定を読む
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bookshelf-tray-'));
  let electronKey = null;
  try {
    electronKey = require.resolve('electron');
  } catch {
    electronKey = 'electron';
  }
  require.cache[electronKey] = {
    id: electronKey,
    filename: electronKey,
    loaded: true,
    exports: {
      app: { getPath: () => userData, getName: () => 'bookshelf-tray-test' },
    },
  };
  const config = require('../src/lib/config.js');
  assert.strictEqual(config.load().trayCloseMinutes, 30);
});
