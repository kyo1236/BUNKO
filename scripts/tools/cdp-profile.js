'use strict';
// 走っている BUNKO の本窓で、一つの操作のあいだ CPU を測り、時間を食った関数を出す (関数名と src の行だけ)。
//
//   BUNKO_SESSION=<会の名> node scripts/tools/cdp-profile.js "<押す要素の CSS>" [--ms 2500] [--index 0] [--top 25]
//   BUNKO_SESSION=<会の名> node scripts/tools/cdp-profile.js --eval "<式>" [--ms 2500]
//   BUNKO_SESSION=<会の名> node scripts/tools/cdp-profile.js --wheel 6 [--at 640,800] [--ms 2500]   本物のホイールで棚を送る (ui-probe の scrollShelf と同じ 600px × n、120ms 間隔)
//
// 錠を持つ会だけ (9222 は一つ)。押すのは CDP の本物のマウス。ui-probe で long-task の旗が立った操作に使う。
const { connect } = require('./cdp-page');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!process.env.BUNKO_LOCK_IGNORE) {
    const why = require('./deploy-lock').blocker(process.env.BUNKO_SESSION || '');
    if (why) throw new Error(why);
  }
  const selector = args[0] && !args[0].startsWith('--') ? args[0] : null;
  const expr = opt('--eval', null);
  const wheel = Number(opt('--wheel', 0));
  const [wheelX, wheelY] = String(opt('--at', '640,800')).split(',').map(Number);
  const ms = Number(opt('--ms', 2500));
  const index = Number(opt('--index', 0));
  const top = Number(opt('--top', 25));
  if (!selector && !expr && !wheel) throw new Error('usage: cdp-profile.js "<CSS>" | --eval "<式>" | --wheel <n>');

  const cdp = await connect();
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  let at = null;
  if (selector) {
    at = await cdp.eval(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})][${index}]; if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    if (!at) throw new Error('要素が無い: ' + selector);
  }
  await cdp.send('Profiler.start');
  if (at) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 });
  } else if (wheel) {
    for (let i = 0; i < wheel; i++) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: wheelX, y: wheelY, deltaX: 0, deltaY: 600 });
      await sleep(120);
    }
  } else {
    await cdp.eval(expr);
  }
  await sleep(ms);
  const { profile } = await cdp.send('Profiler.stop');
  cdp.close();

  // 自分の時間 (self) を関数ごとに足す。親を辿って「src の関数の中で」使った時間 (total) も出す
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const dt = new Map();
  const { samples, timeDeltas } = profile;
  for (let i = 0; i < samples.length; i++) dt.set(samples[i], (dt.get(samples[i]) || 0) + (timeDeltas[i + 1] || timeDeltas[i] || 0) / 1000);
  const label = (n) => {
    const f = n.callFrame;
    const file = (f.url || '').replace(/^.*\/(src\/[^?#]+).*$/, '$1').replace(/^.*\/(node_modules\/[^/]+).*$/, '$1');
    return `${f.functionName || '(anon)'} ${file ? file + ':' + (f.lineNumber + 1) : ''}`.trim();
  };
  const self = new Map();
  const total = new Map();
  let all = 0;
  for (const [id, ms2] of dt) {
    const n = byId.get(id);
    if (!n) continue;
    all += ms2;
    const name = label(n);
    self.set(name, (self.get(name) || 0) + ms2);
    const seen = new Set();
    for (let cur = id; cur != null; cur = parent.get(cur)) {
      const lbl = label(byId.get(cur));
      if (seen.has(lbl)) continue;
      seen.add(lbl);
      if (/src\//.test(lbl)) total.set(lbl, (total.get(lbl) || 0) + ms2);
    }
  }
  const fmt = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([k, v]) => `${v.toFixed(1).padStart(8)} ms  ${k}`).join('\n');
  const idle = self.get('(idle)') || 0;
  console.log(`測った ${all.toFixed(0)} ms (うち idle ${idle.toFixed(0)} ms)`);
  console.log('\n-- 自分の時間 (self) --\n' + fmt(new Map([...self].filter(([k]) => !/^\((idle|program)\)/.test(k)))));
  console.log('\n-- src の関数の中で使った時間 (total) --\n' + fmt(total));
}

main().catch((error) => { console.error('[NG] ' + error.message); process.exit(1); });
