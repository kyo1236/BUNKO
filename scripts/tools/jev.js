'use strict';
// Jev (TypeSafe の System One) を**試験の道具から**呼ぶ口。アプリ (src/) からは呼ばない
// (CLAUDE.md の「AI の API を使わない」は本体の決め。これは画面を試す側の道具)。
//
//   node scripts/tools/jev.js ping               キーが読めて API が答えるか (キーは出さない)
//   node scripts/tools/jev.js ask <request.json> {state, questions} を投げて answers を出す
//   require('./jev').ask({ state, questions })   台本から
//
// キーは利用者が母屋の直下 `Jev-API_key.txt` に「JEV-API: <キー>」の形で置く。
// **会はこのファイルを開かない・表示しない** (Read / cat / grep の出力に出さない)。読むのはこの台本だけで、
// 値は Authorization の頭にだけ載せる。失敗の文にも出さない (出そうな所は伏せる)。
// 探す順: 環境変数 TYPESAFE_API_KEY → 環境変数 JEV_KEY_FILE の道 → 母屋の Jev-API_key.txt
// (作業木の直下には無いので、git の共通の .git から母屋を引く)。ファイルは .git/info/exclude で版から外してある。
//
// **送ってよいのは数・id・ソースに書かれた UI の語だけ** (線 1: 所持の本の題・タグ・作者名は送らない)。
// Jev は文字だけを読む (絵は見られない)。英語が主で、日本語は精度が落ちる。問いは英語で書く。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_MODEL = 'jev-latest';
const KEY_FILE_NAME = 'Jev-API_key.txt';

// 母屋 (git の共通 .git の親)。git が無ければこのファイルから二つ上
function mainRoot() {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (common) return path.dirname(common);
  } catch { /* git が無い所から呼ばれた */ }
  return path.join(__dirname, '..', '..');
}

function keyFilePath() {
  return process.env.JEV_KEY_FILE || path.join(mainRoot(), KEY_FILE_NAME);
}

let cachedKey = null;
function loadKey() {
  if (cachedKey) return cachedKey;
  if (process.env.TYPESAFE_API_KEY) return (cachedKey = process.env.TYPESAFE_API_KEY.trim());
  const file = keyFilePath();
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new Error(`キーのファイルが読めない: ${file} (利用者に「JEV-API: <キー>」の形で置いてもらう)`);
  }
  const hit = text.replace(/^\ufeff/, '').match(/JEV[-_ ]?API\s*[:：=]\s*["']?([^\s"']+)/i);
  // 形が違っても中身は出さない (行の数と長さだけ)
  if (!hit) throw new Error(`キーの形が読めない: ${file} (${text.split(/\r?\n/).length} 行)。「JEV-API: <キー>」の一行を探している`);
  return (cachedKey = hit[1]);
}

function redact(text) {
  const s = String(text == null ? '' : text);
  return cachedKey ? s.split(cachedKey).join('<key>') : s;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 一回の問い合わせ。429 と 5xx は retry-after (無ければ倍々) で 3 回まで待つ
async function ask({ state, questions, model = DEFAULT_MODEL }, { tries = 4 } = {}) {
  const key = loadKey();
  const body = JSON.stringify({ state, model, questions });
  let wait = 1000;
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body,
      });
    } catch (error) {
      if (attempt >= tries) throw new Error('Jev に繋がらない: ' + redact(error && error.message));
      await sleep(wait); wait *= 2; continue;
    }
    if (res.ok) return res.json();
    const detail = redact((await res.text().catch(() => '')).slice(0, 400));
    if ((res.status === 429 || res.status >= 500) && attempt < tries) {
      const after = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : wait); wait *= 2; continue;
    }
    throw new Error(`Jev が ${res.status} を返した: ${detail}`);
  }
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'ping') {
    const out = await ask({
      state: { control: 'close button of a dialog', observed: 'the dialog disappeared 120 ms after the click' },
      questions: { matches: { type: 'noul', instructions: 'Did the control do what its name says?' } },
    });
    console.log(`[OK] ${out.model} noul=${out.answers.matches.noul.toFixed(3)} tokens=${out.usage && out.usage.input_tokens}`);
    return;
  }
  if (cmd === 'ask' && arg) {
    const req = JSON.parse(fs.readFileSync(arg, 'utf8').replace(/^\ufeff/, ''));
    console.log(JSON.stringify(await ask(req), null, 2));
    return;
  }
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 17).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
}

if (require.main === module) {
  main().catch((error) => { console.error('[NG] ' + redact(error && error.message)); process.exit(1); });
}
module.exports = { ask, loadKey, keyFilePath, redact, DEFAULT_MODEL };
