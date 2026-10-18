'use strict';
// 走っている BUNKO の棚を本物のホイールで送り、こま落ち (rAF の間隔が 33ms / 50ms を超えた回数) と DOM の変化の数だけを測る。
// ui-probe の scrollShelf と同じ送り (600px × n、120ms 間隔) を何回か繰り返し、最小・中央・最大を出す (一回の数は揺れる)。
//
//   BUNKO_SESSION=<会の名> node scripts/tools/scroll-frames.js [--n 6] [--rounds 3] [--at 640,800] [--root "#grid"]
//
//   --at   ホイールを置く所。札の上 (既定) と札の外 (例 --at 10,800) を比べると、載せた時の動き (hover の遷移) の重さが分かる
//   --root DOM の変化を数える根 (既定 #grid。作者頁は #home-author-view)
//   --trace 主スレッドの仕事の内訳 (Chromium の tracing: JS・style・layout・paint・絵の復号) を種類ごとに ms で出す。
//          JS の profile に出ない重さ (絵の復号・描画) がどれだけかを見る
// 錠を持つ会だけ (9222 は一つ)。出すのは数だけ。
const { connect } = require('./cdp-page');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!process.env.BUNKO_LOCK_IGNORE) {
    const why = require('./deploy-lock').blocker(process.env.BUNKO_SESSION || '');
    if (why) throw new Error(why);
  }
  const n = Number(opt('--n', 6));
  const rounds = Number(opt('--rounds', 3));
  const [x, y] = String(opt('--at', '640,800')).split(',').map(Number);
  const root = opt('--root', '#grid');
  const trace = args.includes('--trace');
  const cdp = await connect();
  const results = [];
  // tracing: 主スレッド (CrRendererMain) と他の糸の仕事を、種類 (name) ごとに ms で足す (入れ子は足さない: 器の名は除く)
  const events = [];
  const threads = new Map(); // `${pid}:${tid}` → 名
  if (trace) {
    cdp.on('Tracing.dataCollected', ({ value }) => { for (const e of value) events.push(e); });
  }
  const startTrace = () => cdp.send('Tracing.start', {
    categories: 'devtools.timeline,disabled-by-default-devtools.timeline,blink,cc,v8,__metadata',
    transferMode: 'ReportEvents',
  });
  const endTrace = () => new Promise((resolve) => { cdp.on('Tracing.tracingComplete', () => resolve()); cdp.send('Tracing.end').catch(() => resolve()); });
  for (let r = 0; r < rounds; r++) {
    await cdp.eval('window.scrollTo(0, 0)');
    await sleep(700);
    if (trace) await startTrace();
    await cdp.eval(`(() => {
      const root = document.querySelector(${JSON.stringify(root)});
      const s = window.__sf = { frames: 0, over33: 0, over50: 0, maxGap: 0, mutations: 0, on: true, last: performance.now() };
      s.mo = new MutationObserver((list) => { s.mutations += list.length; });
      if (root) s.mo.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
      const tick = (t) => { if (!s.on) return; const gap = t - s.last; s.last = t; s.frames++; if (gap > 33) s.over33++; if (gap > 50) s.over50++; if (gap > s.maxGap) s.maxGap = gap; requestAnimationFrame(tick); };
      requestAnimationFrame((t) => { s.last = t; requestAnimationFrame(tick); });
      return true;
    })()`);
    for (let i = 0; i < n; i++) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: 600 });
      await sleep(120);
    }
    await sleep(900);
    const got = await cdp.eval(`(() => { const s = window.__sf; s.on = false; s.mo && s.mo.disconnect(); return JSON.stringify({ frames: s.frames, over33: s.over33, over50: s.over50, maxGap: Math.round(s.maxGap), mutations: s.mutations, scrollY: Math.round(scrollY) }); })()`);
    results.push(JSON.parse(got));
    if (trace) await endTrace();
  }
  await cdp.eval('window.scrollTo(0, 0)');
  cdp.close();
  if (trace) {
    for (const e of events) if (e.ph === 'M' && e.name === 'thread_name') threads.set(`${e.pid}:${e.tid}`, e.args && e.args.name);
    const CONTAINERS = new Set(['RunTask', 'ThreadControllerImpl::RunTask', 'MessageLoop::RunTask', 'TaskQueueManager::ProcessTaskFromWorkQueue', 'ThreadPool_RunTask',
      'EventDispatch', 'RunMicrotasks', 'v8.run', 'V8.Execute', 'ScheduledAction::execute', 'TimerFire', 'FireAnimationFrame', 'Animation', 'ThreadControllerImpl::DoWork',
      'SequenceManagerImpl::RunTask', 'BeginMainThreadFrame', 'ProxyMain::BeginMainFrame', 'ProxyMain::BeginMainFrame::commit', 'ScheduledTasks', 'DoWork']);
    const main = new Map(); const other = new Map(); let mainTotal = 0;
    for (const e of events) {
      if (e.ph !== 'X' || !(e.dur > 0)) continue;
      const tname = threads.get(`${e.pid}:${e.tid}`) || '';
      const bucket = tname === 'CrRendererMain' ? main : other;
      if (bucket === main && !CONTAINERS.has(e.name)) mainTotal += e.dur;
      if (CONTAINERS.has(e.name)) continue;
      const key = bucket === main ? e.name : `${e.name} [${tname || 'thread ' + e.tid}]`;
      const cur = bucket.get(key) || { ms: 0, n: 0, max: 0 };
      cur.ms += e.dur / 1000; cur.n += 1; if (e.dur / 1000 > cur.max) cur.max = e.dur / 1000;
      bucket.set(key, cur);
    }
    const fmt = (m, top) => [...m.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, top)
      .map(([k, v]) => `${v.ms.toFixed(1).padStart(8)} ms  ×${String(v.n).padStart(4)}  最長 ${v.max.toFixed(1).padStart(6)} ms  ${k}`).join('\n');
    console.log(`\n-- 主スレッド (CrRendererMain) の仕事の内訳 (${rounds} 回ぶん、入れ子込み。器の名は除いた) --\n` + fmt(main, 16));
    console.log('\n-- 他の糸 (合成・ラスタ・絵の復号) --\n' + fmt(other, 8));
  }
  const stat = (key) => { const v = results.map((r) => r[key]).sort((a, b) => a - b); return `${v[0]}/${v[Math.floor(v.length / 2)]}/${v[v.length - 1]}`; };
  console.log(`送り ${n}×600px を ${rounds} 回 (ホイールは ${x},${y}、変化の根 ${root})`);
  for (const r of results) console.log('  ' + JSON.stringify(r));
  console.log(`33ms 超のこま 最小/中央/最大: ${stat('over33')}   50ms 超: ${stat('over50')}   最長の間 ms: ${stat('maxGap')}   DOM の変化: ${stat('mutations')}`);
}

main().catch((error) => { console.error('[NG] ' + error.message); process.exit(1); });
