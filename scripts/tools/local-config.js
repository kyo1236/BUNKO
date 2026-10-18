'use strict';
// 機体固有の値 (配布先・写しの道・母屋) を一か所から引く。版には入れない。
//
//   置き場: 母屋の直下 bunko.local.json (雛形は bunko.local.example.json)。作業木からも母屋の物を読む。
//   優先:   環境変数 (BUNKO_MOTHERSHIP など) → bunko.local.json → 無ければ分かる文言で落ちる
//
//   const local = require('./local-config');
//   local.get('mothership')            // 母艦の配布先 (例: BUNKO.exe のある所)
//   local.get('mirror')                // 写しの配布先
//   local.get('mirrorData')            // 写しの置き場 (同期先 = アプリの設定 syncDest と同じ物)
//   local.get('repo')                  // 母屋 (git の共通の .git がある所)。無ければ git から引く
//   local.get('mothership', { optional: true })   // 無ければ ''
//
//   node scripts/tools/local-config.js <key>       値を一行で出す (PowerShell や SKILL.md から)
//   node scripts/tools/local-config.js --list      入っている鍵の一覧 (値は出さない)
//
// この JSON は道だけを持つ (作品名・タグ・資格情報は入れない)。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const FILE_NAME = 'bunko.local.json';
const ENV = {
  repo: 'BUNKO_REPO',
  mothership: 'BUNKO_MOTHERSHIP',
  mirror: 'BUNKO_MIRROR',
  mirrorData: 'BUNKO_MIRROR_DATA',
};

// 母屋 (git の共通 .git の親)。作業木の中から呼ばれても母屋を指す
function mainRoot() {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (common) return path.dirname(common);
  } catch { /* git が無い所から呼ばれた */ }
  return path.join(__dirname, '..', '..');
}

let cached = null;
function readFile() {
  if (cached) return cached;
  const file = path.join(mainRoot(), FILE_NAME);
  try {
    cached = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    cached = {};
  }
  return cached;
}

function get(key, { optional = false } = {}) {
  const envName = ENV[key];
  const fromEnv = envName && process.env[envName];
  if (fromEnv) return String(fromEnv).trim();
  const fromFile = readFile()[key];
  if (fromFile) return String(fromFile).trim();
  if (key === 'repo') return mainRoot();
  if (optional) return '';
  const hint = envName ? ` (環境変数 ${envName} でも可)` : '';
  throw new Error(`機体固有の値 "${key}" が未設定: 母屋の ${FILE_NAME} に書く${hint}。雛形は bunko.local.example.json`);
}

module.exports = { get, mainRoot, FILE_NAME };

if (require.main === module) {
  const arg = process.argv[2];
  if (!arg || arg === '--help') {
    console.log('usage: node scripts/tools/local-config.js <key> | --list');
    process.exitCode = 2;
  } else if (arg === '--list') {
    console.log(Object.keys(readFile()).join('\n'));
  } else {
    try {
      process.stdout.write(get(arg) + '\n');
    } catch (err) {
      console.error(err.message);
      process.exitCode = 1;
    }
  }
}
