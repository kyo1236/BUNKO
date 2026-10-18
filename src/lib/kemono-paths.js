'use strict';

const path = require('path');
const { app } = require('electron');

// pawchive の取り込みを担う外部エンジン (Python 製 CLI の kemono-dl) と、
// それを走らせる埋め込みランタイムの置き場。
//
// 梱包版では asar の中の .py を python に渡せない (実体のパスが無い) ので、
// extraResources で resources/ に外置きした方を使う。main.js の syncScriptPath が
// .ps1 で同じことをしているのと同じ流儀。
//
// electron への依存はこのファイルだけに閉じる: 実際に子プロセスを起こす
// kemono-engine は素の node でも動かせるようにしておきたい (単体テストのため)。
function kemonoPaths() {
  const root = app.isPackaged
    ? process.resourcesPath
    : path.join(__dirname, '..', '..', 'third_party');
  return {
    python: path.join(root, 'python', 'python.exe'),
    script: path.join(root, 'kemono-dl', 'kemono-dl.py'),
  };
}

// kemono-dl は cwd に debug.log や一時ファイルを落とす。アプリの居場所を汚さない
// よう、userData の下に専用の作業場を切ってそこを cwd にする
function kemonoWorkDir() {
  return path.join(app.getPath('userData'), 'kemono-work');
}

module.exports = { kemonoPaths, kemonoWorkDir };
