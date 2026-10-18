'use strict';

// media-cache の置き場の名前を固定する。userData 直下の 'cache' は Electron (Chromium) の
// HTTP キャッシュ 'Cache' と Windows では同じフォルダになり、Chromium が起動時に
// Cache_Data 以外を掃除するので、表紙・頁・焼いた頁が起動のたびに全部消えていた
// (2026-09-05 実測)。名前を戻す変更をここで止める

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test("main.js は media-cache を userData の 'cache' 以外に置く", () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const line = source.split('\n').find((text) => /mediaCache\.init\(/.test(text));
  assert.ok(line, 'mediaCache.init の呼び出しが見つからない');
  assert.ok(!/['"]cache['"]/i.test(line), `Chromium の Cache と衝突する名前: ${line.trim()}`);
  assert.ok(/'media-cache'/.test(line), `期待した置き場ではない: ${line.trim()}`);
});

test('同期スクリプトも同じ置き場を指す', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'sync-to-homecore.ps1'), 'utf8');
  assert.ok(!/'cache\\img'/.test(script), "sync-to-homecore.ps1 が古い 'cache\\img' を指している");
  assert.ok(/media-cache\\img/.test(script));
});
