'use strict';
// 母艦の BUNKO (<母艦の配布先>\BUNKO.exe) を起こし直す。画面を CDP で試す前後に使う。
//
//   node scripts/tools/mothership.js probe <会の名>   読み取り専用 + 9222 で起こし直す (錠を持っている会だけ)
//   node scripts/tools/mothership.js plain [<会の名>]  素 (いつもの書き手) で起こし直す。試験の後は必ずこれ
//   node scripts/tools/mothership.js status           走っているか・引数に 9222 / --read-only が付いているか
//   node scripts/tools/mothership.js stop <会の名>     止めるだけ (reading.json など、走っている間は上書きされる控えを直す時。錠が要る)
//   node scripts/tools/mothership.js dev <会の名>     母艦を止め、**この作業木の源** (electron .) を読み取り専用 + 9222 で起こす
//                                                     (配らずに直しを実画面で測る。PID を _tmp/mothership-dev.pid に控え、plain がその PID だけを止める)
//
// 母艦は自分で止めてよい (bunko-release)。写し (Homecore) はこれで触らない。
// 止める前に台帳の書き出しが 10 秒静かになるのを待つ (強制終了は before-quit を通らない。報告に一行添える)。
// 起こす時は --read-only を付ける: 釦を押す試験で取り込み・Eagle・台帳・同期の口を主プロセスが断るように。
const { execFileSync, spawn } = require('child_process');
const path = require('path');

// 母艦の配布先。環境変数 BUNKO_MOTHERSHIP か母屋の bunko.local.json (scripts/tools/local-config.js)
const DEST = require('./local-config').get('mothership');
const EXE = path.join(DEST, 'BUNKO.exe');
// 窓の隠れ具合を計算させない・隠れても時計と描画を絞らせない: 利用者が他の窓や仮想デスクトップで作業していても測れるように
// (台本は窓を前へ出さない。作業中の利用者から前面を奪わない)
const PROBE_ARGS = ['--read-only', '--remote-debugging-port=9222', '--disable-features=CalculateNativeWinOcclusion',
  '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'];

function ps(command) {
  return execFileSync('powershell', ['-NoProfile', '-Command', command], { encoding: 'utf8' }).trim();
}
function mainProcesses() {
  const out = ps(`Get-CimInstance Win32_Process -Filter "Name='BUNKO.exe'" | Where-Object { $_.ExecutablePath -eq '${EXE}' -and $_.CommandLine -notmatch '--type=' } | ForEach-Object { "$($_.ProcessId)\`t$($_.CommandLine)" }`);
  return out ? out.split(/\r?\n/).map((l) => { const [pid, cmd] = l.split('\t'); return { pid: Number(pid), cmd }; }) : [];
}
function status() {
  const procs = mainProcesses();
  const dev = devPid();
  if (dev && devAlive(dev)) console.log(`[OK] 作業木の源の electron が走っている: pid ${dev} (9222 / read-only)`);
  if (!procs.length) return console.log('[--] 母艦の BUNKO は止まっている');
  for (const p of procs) {
    console.log(`[OK] pid ${p.pid}  9222=${/remote-debugging-port=9222/.test(p.cmd) ? 'あり' : 'なし'}  read-only=${/--read-only/.test(p.cmd) ? 'あり' : 'なし'}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function stop() {
  // 止まっているなら何もしない (Get-Process が空だと PowerShell が失敗の終了番号を返す)
  if (!mainProcesses().length) { console.log('[--] もう止まっている'); return; }
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'wait-catalog-idle.js'), '--quiet-ms', '10000', '--max-ms', '90000'], { stdio: 'inherit' });
  } catch { console.log('[--] 台帳の書き出しが続いている。構わず止める'); }
  ps(`Get-Process BUNKO -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${EXE}' } | Stop-Process -Force`);
  for (let i = 0; i < 20 && mainProcesses().length; i++) await sleep(250);
  if (mainProcesses().length) throw new Error('止まらない');
  console.log('[OK] 止めた (強制終了: before-quit は通っていない)');
}

// 作業木の源で起こした electron の PID の控え (plain がこれだけを止める。名前で electron を止めない: Claude の机も electron)
const REPO = path.resolve(__dirname, '..', '..');
const DEV_PID_FILE = path.join(REPO, '_tmp', 'mothership-dev.pid');
function devPid() {
  try { return Number(require('fs').readFileSync(DEV_PID_FILE, 'utf8').trim()) || 0; } catch { return 0; }
}
function devAlive(pid) {
  if (!pid) return false;
  const out = ps(`Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | ForEach-Object { $_.CommandLine }`);
  return /electron/i.test(out);
}
async function stopDev() {
  const pid = devPid();
  if (!pid) return;
  if (devAlive(pid)) {
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* もう居ない */ }
    for (let i = 0; i < 20 && devAlive(pid); i++) await sleep(250);
    console.log(devAlive(pid) ? `[NG] 作業木の electron (pid ${pid}) が止まらない` : `[OK] 作業木の electron (pid ${pid}) を止めた`);
  }
  try { require('fs').unlinkSync(DEV_PID_FILE); } catch { /* 無ければよい */ }
}

async function waitForPage() {
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      const list = await (await fetch('http://127.0.0.1:9222/json')).json();
      if (list.some((p) => p.type === 'page' && p.title === '文匣')) { console.log('[OK] 9222 に本窓が出た'); return; }
    } catch { /* まだ */ }
  }
  throw new Error('9222 に本窓が出ない');
}

async function startDev() {
  const electron = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (!require('fs').existsSync(electron)) throw new Error('node_modules/electron が無い: ' + electron);
  require('fs').mkdirSync(path.dirname(DEV_PID_FILE), { recursive: true });
  const child = spawn(electron, ['.', ...PROBE_ARGS], { cwd: REPO, detached: true, stdio: 'ignore' });
  child.unref();
  require('fs').writeFileSync(DEV_PID_FILE, String(child.pid));
  console.log(`[OK] 作業木の源で起こした: pid ${child.pid}  (${REPO})`);
  await waitForPage();
}

async function startWith(args) {
  const child = spawn(EXE, args, { cwd: DEST, detached: true, stdio: 'ignore' });
  child.unref();
  if (args.some((a) => a.startsWith('--remote-debugging-port'))) {
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      try {
        const list = await (await fetch('http://127.0.0.1:9222/json')).json();
        if (list.some((p) => p.type === 'page' && p.title === '文匣')) { console.log('[OK] 9222 に本窓が出た'); return; }
      } catch { /* まだ */ }
    }
    throw new Error('9222 に本窓が出ない');
  }
  await sleep(3000);
}

async function main() {
  const [cmd, owner] = process.argv.slice(2);
  if (cmd === 'status') return status();
  if (cmd === 'probe') {
    const why = require('./deploy-lock').blocker(owner || '');
    if (why) throw new Error(why);
    await stop();
    await startWith(PROBE_ARGS);
    return status();
  }
  if (cmd === 'stop') {
    const why = require('./deploy-lock').blocker(owner || '');
    if (why) throw new Error(why);
    await stopDev();
    await stop();
    return status();
  }
  if (cmd === 'dev') {
    const why = require('./deploy-lock').blocker(owner || '');
    if (why) throw new Error(why);
    await stopDev();
    await stop();
    await startDev();
    return status();
  }
  if (cmd === 'plain') {
    await stopDev();
    await stop();
    await startWith([]);
    return status();
  }
  console.log(require('fs').readFileSync(__filename, 'utf8').split('\n').slice(1, 11).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
}

main().catch((error) => { console.error('[NG] ' + error.message); process.exit(1); });
