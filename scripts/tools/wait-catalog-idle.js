'use strict';
// 母艦を起こし直した後、台帳 (catalog.sqlite) の書き出しが落ち着くまで待つ (bunko-release の手順 5 の前に)。
// 走査後の書き出しの最中に同期すると半端な台帳を写す。
//
//   node scripts/tools/wait-catalog-idle.js [--quiet-ms 25000] [--max-ms 150000] [--file <path>]
//
// 既定は %APPDATA%\hitomi-box\catalog.sqlite。mtime が quiet-ms のあいだ動かなければ 0 で終わる。max-ms を超えたら 2。
const fs = require('fs');
const path = require('path');

const arg = (name, def) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : def; };
const file = arg('--file', path.join(process.env.APPDATA || '', 'hitomi-box', 'catalog.sqlite'));
const quiet = Number(arg('--quiet-ms', 25000));
const max = Number(arg('--max-ms', 150000));

if (!fs.existsSync(file)) { console.error('[NG] 台帳が無い: ' + file); process.exit(1); }
let last = fs.statSync(file).mtimeMs;
let stableSince = Date.now();
const start = Date.now();
const hhmm = (ms) => new Date(ms).toLocaleTimeString('ja-JP');
(function tick() {
  const m = fs.statSync(file).mtimeMs;
  if (m !== last) { last = m; stableSince = Date.now(); console.log('[--] 書き出し ' + hhmm(m)); }
  if (Date.now() - stableSince >= quiet) { console.log('[OK] ' + (quiet / 1000) + ' 秒静か。最後の書き出し ' + hhmm(last)); return; }
  if (Date.now() - start > max) { console.log('[NG] ' + (max / 1000) + ' 秒待っても書き続けている'); process.exit(2); }
  setTimeout(tick, 2000);
})();
