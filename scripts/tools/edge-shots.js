'use strict';
// 試写の頁を Edge の headless で撮る (playwright が他の会に握られていても撮れる)。
// node scripts/tools/edge-shots.js <出す所> <頭の URL> <名>=<道?問い> [<名>=<道?問い> …] [--size=1440,900] [--budget=6000]
//   例: node scripts/tools/edge-shots.js _tmp/shots http://127.0.0.1:28792/ p1-list=p1-stack.html p1-page="p1-stack.html?open=0&still=1"
// 頁は偽の棚だけにすること (実データの画面を撮って残さない)。撮れなかった物は名と理由を出して、終わりの値を 1 にする。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
const [outDir, base, ...pairs] = args.filter((a) => !a.startsWith('--'));
if (!outDir || !base || !pairs.length) {
  console.error('[NG] usage: edge-shots.js <出す所> <頭の URL> <名>=<道?問い> … [--size=1440,900] [--budget=6000]');
  process.exit(2);
}
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
if (!EDGE) { console.error('[NG] Edge が見つからない'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });
const size = flags.size || '1440,900';
const budget = flags.budget || '6000';

let failed = 0;
for (const pair of pairs) {
  const eq = pair.indexOf('=');
  const name = pair.slice(0, eq);
  const url = new URL(pair.slice(eq + 1), base).href;
  const target = path.resolve(outDir, name.endsWith('.png') ? name : name + '.png');
  let err = null;
  // headless の Edge は時々黙り込むので、二度まで試す
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      execFileSync(EDGE, [
        '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
        `--user-data-dir=${path.join(os.tmpdir(), 'bunko-shot-profile-' + attempt)}`,
        `--window-size=${size}`, `--virtual-time-budget=${budget}`, `--screenshot=${target}`, url,
      ], { stdio: 'ignore', timeout: 45000 });
      err = fs.existsSync(target) ? null : new Error('no file');
      if (!err) break;
    } catch (e) { err = e; }
  }
  if (err) { failed += 1; console.log(`[NG] ${name}: ${err.message.split('\n')[0]}`); }
  else console.log(`[OK] ${name} ${fs.statSync(target).size} bytes`);
}
process.exit(failed ? 1 : 0);
