'use strict';

// 起動用の一枚。既定 userData (%APPDATA%\hitomi-box) の config.json から
// 「どこを読むか (dataDir)」と「読み取り専用か (readOnly)」だけを先に拾う。
//
// config.js の load() を通さないのは鶏と卵になるため: あちらは
// app.getPath('userData') に依って読み、しかも一度読んだ内容を cached に
// 固定するので、置き場を切り替える前に呼ぶと切替前の場所を掴んだままになる。
// ここは fs で生読みし、置き場を決めるためだけに使う。
//
// BOM 付きで書かれていても読めるようにする: 過去に PS5.1 の -Encoding utf8
// (BOM 付き) で config.json を書いて設定を失った経緯があるので、
// 読む側では黙って剥がす (書く側は今も BOM なし)

const fs = require('fs');
const path = require('path');

// 返り値は「指定があった鍵だけ」を持つ小さな object。
// 読めない・壊れている・指定が無い、はどれも {} (従来どおりの起動)
function readBootConfig(appDataDir) {
  const dir = String(appDataDir || '');
  if (!dir) return {};
  let parsed = null;
  try {
    const text = fs.readFileSync(path.join(dir, 'config.json'), 'utf8').replace(/^\uFEFF/, '');
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const boot = {};
  const dataDir = typeof parsed.dataDir === 'string' ? parsed.dataDir.trim() : '';
  if (dataDir) boot.dataDir = dataDir;
  if (parsed.readOnly === true) boot.readOnly = true;
  return boot;
}

module.exports = { readBootConfig };
