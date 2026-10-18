'use strict';
// 走っている BUNKO (本物の母艦) の釦を CDP で本当に押し、反応・動き・ガタつき・主スレッドの詰まりを測る。
// 測りは決まりで行い (ui-probe-kit.js)、「その反応はその釦らしいか」の見立てだけを Jev に聞く (--jev)。
//
//   node scripts/tools/deploy-lock.js take <会の名> "9222 で画面を試す"
//   (母艦を --read-only --remote-debugging-port=9222 で起こし直す。書き込みは主プロセスが断る)
//   BUNKO_SESSION=<会の名> node scripts/tools/ui-probe.js [--jev] [--only <場面,…>] [--list] [--shots]
//   (終わったら母艦を素で起こし直し、錠を空ける)
//
// 押すのは ui-probe-plan.js の名簿に載った釦だけ (書き込み・外部・OS・長い仕事は名簿に載せない)。
// 出力は _tmp/ui-probe/<時刻>/ に report.json と report.md。**数・id・class と、ソースに書かれた UI の語だけ**
// (所持の本の題・タグ・作者名・打った語は伏せる。線 1)。--shots は目立つ物だけ写真を撮る (利用者に見せる用。会は開かない)。
const fs = require('fs');
const path = require('path');
const { connect } = require('./cdp-page');
const kit = require('./ui-probe-kit');
const plan = require('./ui-probe-plan');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };

// ── 伏せ字: ソースに書かれた UI の語だけを通す ──────────────────────
const ROOT = path.resolve(__dirname, '..', '..');
const UI_SOURCE = (() => {
  const dir = path.join(ROOT, 'src', 'renderer');
  return fs.readdirSync(dir).filter((f) => /\.(js|html)$/.test(f))
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
})();
// 題・タグ・作者名・打った語が入る所 (字を出さない)
const DYNAMIC_TEXT = /(^|\s|>)(\.card\b|\.tag\b|#recents|#suggest|#result-info|#status|#query|\[data-query\]|\[data-home-query\]|\[data-home-person\]|\[data-value\]|\[data-apply\]|\.home-(strip|fan|book|bento|person|url|name|author|av-title|av-sub|av-pill|cover-tile|fchip)|\.reader-(thumb|related|next|creator|title)|\.pixiv-related-item|\.variant-row|\.link-hit|\.paw-hit|\.disc-|\.toast|\.confirm-text|#reader-title|\.card-(title|artist|meta))/;
function sanitizeLabel(text, selector) {
  const t = String(text || '').trim().replace(/\s+/g, ' ');
  if (!t) return '';
  if (selector && DYNAMIC_TEXT.test(selector)) return `<字 ${[...t].length}>`;
  if (/^\d+$/.test(t)) return t;                       // 数だけ
  if ([...t].length <= 24 && UI_SOURCE.includes(t)) return t;
  return `<字 ${[...t].length}>`;
}
function sanitizeText(text) {           // 例外・console の文。ASCII 以外の並びは伏せる
  return String(text || '').replace(/[^\x20-\x7e]+/g, '…').slice(0, 200);
}
function describeControl(c) {
  return {
    sel: c.sel, id: c.id, cls: c.cls, role: c.role, disabled: c.disabled, pressed: c.pressed,
    label: sanitizeLabel(c.text, c.sel), title: sanitizeLabel(c.title, c.sel), aria: sanitizeLabel(c.aria, c.sel),
    rect: c.rect, covered: c.covered, coveredBy: c.coveredBy,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 試験が書いてしまう設定の鍵。終わりに控えの値へ戻す (これ以外が変わったら記に残すだけで触らない)
const RESTORE_KEYS = [
  'source', 'session', 'searchHistory', 'searchPins', 'sortBySource', 'sortDir', 'hideOwnedMode', 'favoritesOnly',
  'homeOwnedOnly', 'zoom', 'uiCoverSizes', 'uiCoverSize', 'uiLayout', 'uiCaptions', 'uiFit', 'loupeEnabled',
  'readerFit', 'readerRtl', 'readerSpread',
];

async function main() {
  if (!process.env.BUNKO_LOCK_IGNORE) {
    const why = require('./deploy-lock').blocker(process.env.BUNKO_SESSION || '');
    if (why) { console.error('[NG] ' + why); process.exit(1); }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = path.join(ROOT, '_tmp', 'ui-probe', stamp);
  fs.mkdirSync(outDir, { recursive: true });

  const cdp = await connect();
  const consoleErrors = [];
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  cdp.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails || {};
    consoleErrors.push({ kind: 'exception', msg: sanitizeText((d.exception && d.exception.description || d.text || '').split('\n')[0]), at: Date.now() });
  });
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type !== 'error' && p.type !== 'warning') return;
    const msg = (p.args || []).map((a) => a.value != null ? String(a.value) : (a.description || '')).join(' ');
    consoleErrors.push({ kind: 'console-' + p.type, msg: sanitizeText(msg), at: Date.now() });
  });

  // 窓が隠れている (最小化・他の窓に覆われた・別の仮想デスクトップ) と描画のコマも時計も絞られ、測りが嘘になる。
  // 押す前に毎回見て、隠れていれば待つ。戻らなければその場面を止める。**窓を前へ出さない** (利用者が PC で
  // 作業中のことがある)。mothership.js probe は隠れ具合の計算を切って起こすので、最小化さえしなければ隠れない
  const ensureVisible = async () => {
    for (let i = 0; i < 20; i++) {
      const vis = await cdp.eval('document.visibilityState', { timeoutMs: 5000 }).catch(() => 'unknown');
      if (vis === 'visible') return;
      await sleep(500);
    }
    throw new Error('window hidden (minimized or occluded)');
  };
  const ensureKit = async () => { await ensureVisible(); return cdp.eval(kit.source()); };
  await ensureKit();

  // ── 操作の口 ───────────────────────────────────────────────
  const mouse = async (x, y, { button = 'left', count = 1 } = {}) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await sleep(30);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: count });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: count });
  };
  const KEYS = {
    Escape: { code: 'Escape', keyCode: 27 }, ArrowRight: { code: 'ArrowRight', keyCode: 39 }, ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
    ArrowDown: { code: 'ArrowDown', keyCode: 40 }, ArrowUp: { code: 'ArrowUp', keyCode: 38 }, Enter: { code: 'Enter', keyCode: 13, text: '\r' },
    '?': { code: 'Slash', keyCode: 191, text: '?', shift: true }, '/': { code: 'Slash', keyCode: 191, text: '/' },
    Home: { code: 'Home', keyCode: 36 }, End: { code: 'End', keyCode: 35 }, ' ': { code: 'Space', keyCode: 32, text: ' ' },
  };
  const key = async (name) => {
    const k = KEYS[name] || { code: 'Key' + name.toUpperCase(), keyCode: name.toUpperCase().charCodeAt(0), text: name };
    const base = { key: name, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers: k.shift ? 8 : 0 };
    await cdp.send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, text: k.text });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  };
  const snap = () => cdp.eval('window.__probe.snap()');

  const records = [];
  const ctx = {
    cdp, sleep, key, mouse, snap, ensureKit, sanitizeLabel, describeControl,
    eval: (expr) => cdp.eval(expr),
    controls: async (root) => (await cdp.eval(`window.__probe.controls(${JSON.stringify(root || '')})`)) || [],
    // 釦を一つ押して測る。undo で元へ戻し、戻ったかを確かめる
    async click(step, selector, { index = 0, collect = {}, undo = null, expect = null, purpose = '', button = 'left', count = 1, shot = false } = {}) {
      await ensureKit();
      const errStart = consoleErrors.length;
      const armed = await cdp.eval(`window.__probe.arm(${JSON.stringify(selector)}, ${index})`);
      if (!armed || !armed.ok) {
        const rec = { step, selector, index, skipped: 'not-found', count: armed && armed.count };
        records.push(rec); log(rec); return rec;
      }
      const ctl = (await cdp.eval(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((e) => window.__probe.visible(e))[${index}]; if (!el) return null; const all = window.__probe.controls(); return all.find((c) => c.sel === window.__probe.sel(el)) || { sel: window.__probe.sel(el), id: el.id, cls: [...el.classList], text: (el.innerText||'').trim().slice(0,40), title: el.title, aria: el.getAttribute('aria-label') || '' }; })()`));
      await mouse(armed.x, armed.y, { button, count });
      const result = await cdp.eval(`window.__probe.collect(${JSON.stringify(collect)})`, { timeoutMs: (collect.maxMs || 3000) + 10000 });
      const rec = { step, selector, index, purpose, expect, control: ctl ? describeControl(ctl) : null, click: armed, result, consoleErrors: consoleErrors.slice(errStart).map(({ kind, msg }) => ({ kind, msg })) };
      if (shot) rec.shot = await screenshot(`${records.length}-${step}`);
      if (undo) rec.restore = await restore(undo, rec.result.before);
      rec.flags = flagsOf(rec);
      records.push(rec); log(rec);
      return rec;
    },
    // 釦でない出来事 (キー・select の change・式) を測る
    async act(step, fn, { collect = {}, undo = null, expect = null, purpose = '', shot = false } = {}) {
      await ensureKit();
      const errStart = consoleErrors.length;
      await cdp.eval('window.__probe.armBare()');
      await fn();
      const result = await cdp.eval(`window.__probe.collect(${JSON.stringify(collect)})`, { timeoutMs: (collect.maxMs || 3000) + 10000 });
      const rec = { step, selector: null, purpose, expect, control: null, result, consoleErrors: consoleErrors.slice(errStart).map(({ kind, msg }) => ({ kind, msg })) };
      if (shot) rec.shot = await screenshot(`${records.length}-${step}`);
      if (undo) rec.restore = await restore(undo, rec.result.before);
      rec.flags = flagsOf(rec);
      records.push(rec); log(rec);
      return rec;
    },
    note(step, data) { const rec = { step, note: data }; records.push(rec); log(rec); },
  };

  async function screenshot(name) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(outDir, name.replace(/[^\w.-]+/g, '_') + '.png');
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    return path.relative(outDir, file);
  }

  // 元へ戻す。undo は { keys:[…] } / { click: sel } / { fn: async () => … } / 'escape'
  async function restore(undo, before) {
    const steps = typeof undo === 'string' ? [{ keys: ['Escape'] }] : Array.isArray(undo) ? undo : [undo];
    for (const u of steps) {
      if (u.keys) for (const k of u.keys) { await key(k); await sleep(120); }
      if (u.click) {
        const a = await cdp.eval(`window.__probe.arm(${JSON.stringify(u.click)}, ${u.index || 0})`);
        if (a && a.ok) await mouse(a.x, a.y);
      }
      if (u.fn) await u.fn(ctx);
      await sleep(u.wait || 450);
    }
    await sleep(200);
    const now = await snap();
    const diff = [];
    for (const k of Object.keys(before.overlays)) if (k !== 'notice' && k !== 'suggest' && before.overlays[k] !== now.overlays[k]) diff.push(`overlay:${k}`);
    if (before.source !== now.source) diff.push('source');
    if (before.scope !== now.scope) diff.push('scope');
    if (before.homeShown !== now.homeShown) diff.push('home');
    for (const r of ['rail', 'filters', 'grid']) {
      const a = before.regions[r]; const b = now.regions[r];
      if (!!a !== !!b || (a && b && (Math.abs(a.y - b.y) > 1 || Math.abs(a.h - b.h) > 1))) diff.push(`region:${r}`);
    }
    return { ok: diff.length === 0, diff };
  }

  const verbose = flag('--verbose');
  function log(rec) {
    if (rec.note) { console.log(`[--] ${rec.step}: ${JSON.stringify(rec.note)}`); return; }
    if (rec.skipped) { console.log(`[--] ${rec.step}: 見つからない ${rec.selector}`); return; }
    const r = rec.result;
    const mark = rec.flags.length ? '[!!]' : '[OK]';
    console.log(`${mark} ${rec.step}  反応 ${r.firstMutationMs == null ? '-' : r.firstMutationMs + 'ms'}  落ち着き ${r.settleMs}ms  長い仕事 ${r.longtasks.length ? Math.max(...r.longtasks.map((x) => x.ms)) + 'ms' : '-'}  ずれ ${r.shifts.length}  動き ${r.anims.length}  コマ落ち ${r.frames.over33}/${r.frames.count}${rec.restore ? '  戻り ' + (rec.restore.ok ? 'ok' : rec.restore.diff.join(',')) : ''}${rec.flags.length ? '  ' + rec.flags.join(' ') : ''}`);
    if (verbose) console.log(JSON.stringify({ control: rec.control, anims: r.anims, shifts: r.shifts }, null, 0));
  }

  // ── 決まりの旗 ─────────────────────────────────────────────
  function flagsOf(rec) {
    const r = rec.result; const f = [];
    const b = r.before; const a = r.after;
    const overlayChanged = Object.keys(b.overlays).some((k) => b.overlays[k] !== a.overlays[k]);
    const changed = overlayChanged || b.source !== a.source || b.scope !== a.scope || b.cards !== a.cards || b.homeShown !== a.homeShown || b.active !== a.active || b.winScroll !== a.winScroll;
    // 棚の中身が入れ替わった (空にしてから詰め直した・写しから戻した)。この時の枠の上下は、見えている札が動いたのではない
    const replaced = b.sig !== a.sig || r.samples.some((x) => x.cards === 0 && b.cardsInView > 0);
    if (r.firstMutationMs == null && !changed) f.push('no-reaction');
    if (r.firstMutationMs != null && r.firstMutationMs > 100) f.push(`slow-feedback:${r.firstMutationMs}`);
    if (rec.click && rec.click.covered) f.push(`covered:${rec.click.coveredBy}`);
    if (r.blank.ms >= 200) f.push(`blank:${r.blank.ms}`);
    if ((r.readerWaitMs || 0) >= 300) f.push(`reader-wait:${r.readerWaitMs}`);
    // ずれ: 押した直後 (500ms 内) の棚の組み直しは釦の役目 (並べ方・大きさ) なので旗にしない。
    // 旗にするのは (a) 押して 500ms より後に来たずれ (遅れて届いた物が押しのけた)、
    // (b) 上の帯・絞りの帯・棚の枠そのものが動いた (押しのけ・スクロールバーの出入り)
    const FRAME = /^(#search-form|header\.rail|#app > div\.ui-topbar|#app > main\.workspace|section\.filters|div\.rail-|#app > div\.ui-topbar > )/;
    // 枠の中でも数えない物: 右寄せの道具を包む枠の左端 (並びの札の字の長さで動くだけ)・件数の字・札の下に滑る印
    const NOT_FRAME = /filter-tail|result-info|ui-fluid/;
    const WORKSPACE = /main\.workspace|section\.filters/;
    const moved = (s) => Math.abs(s.dy) >= 2 || Math.abs(s.dh) >= 2 || Math.abs(s.dx || 0) >= 2;
    const late = r.shifts.filter((s) => !s.input).flatMap((s) => s.sources).filter(moved);
    const frame = r.shifts.flatMap((s) => s.sources).filter((s) => moved(s) && FRAME.test(s.node || '') && !NOT_FRAME.test(s.node || '')
      && !(replaced && WORKSPACE.test(s.node || '')));
    // (c) 棚の幅が変わった (詳細の窓などが場所を取って札を全部組み直させた)。役目が大きさ・並べ方なら予定どおり
    const gw = (s) => (s.regions && s.regions.grid ? s.regions.grid.w : 0);
    if (gw(b) && gw(a) && Math.abs(gw(a) - gw(b)) > 1 && !(rec.expect && rec.expect.reflow) && !/size|layout|zoom|width/i.test(rec.purpose || '')) {
      f.push(`pushed-reflow:grid ${gw(b)}->${gw(a)}px`);
    }
    if (late.length) f.push(`late-shift:${[...new Set(late.map((s) => s.node))].slice(0, 3).join('|')}`);
    if (frame.length) f.push(`frame-shift:${[...new Set(frame.map((s) => `${s.node}(${s.dx || 0},${s.dy})`))].slice(0, 3).join('|')}`);
    // 絞りの帯は見方に合わせて段が増減する (ランキングの二段目など)。棚ごと入れ替わる時は数えない
    for (const reg of replaced ? ['rail'] : ['rail', 'filters']) {
      const x = b.regions[reg]; const y = a.regions[reg];
      if (x && y && (Math.abs(x.h - y.h) > 1 || Math.abs(x.y - y.y) > 1)) f.push(`region-moved:${reg}:${y.h - x.h}`);
    }
    const layoutAnims = r.anims.filter((x) => x.layoutProps && x.layoutProps.length);
    if (layoutAnims.length) f.push(`layout-anim:${layoutAnims.map((x) => x.layoutProps.join('+')).slice(0, 2).join('|')}`);
    const lt = r.longtasks.length ? Math.max(...r.longtasks.map((x) => x.ms)) : 0;
    if (lt >= 200) f.push(`stall:${lt}`); else if (lt >= 80) f.push(`long-task:${lt}`);
    if (r.anims.length && r.frames.over33 >= 3) f.push(`dropped-frames:${r.frames.over33}`);
    if (r.errors.length || rec.consoleErrors.some((e) => e.kind !== 'console-warning')) f.push('error');
    if (rec.restore && !rec.restore.ok) f.push(`not-restored:${rec.restore.diff.join(',')}`);
    if (rec.expect) {
      const e = rec.expect;
      if (e.opens && !a.overlays[e.opens]) f.push(`expected-open:${e.opens}`);
      if (e.closes && a.overlays[e.closes]) f.push(`expected-close:${e.closes}`);
      if (e.source && a.source !== e.source) f.push(`expected-source:${e.source}`);
    }
    return f;
  }

  // 棚が読み込み中のまま測り始めると、後から入る札の揺れを最初の釦のせいにしてしまう
  ctx.settle = async (maxMs = 12000) => {
    const t0 = Date.now();
    let calm = 0;
    while (Date.now() - t0 < maxMs) {
      const s = await snap();
      const busy = s.statusShown || s.running > 0 || (s.imgsInView - s.imgsLoaded - s.imgsBroken) > 0 || (!s.homeShown && s.cards === 0 && !s.emptyShown);
      calm = busy ? 0 : calm + 1;
      if (calm >= 3) return Date.now() - t0;
      await sleep(200);
    }
    return -1;
  };

  // ── 走らせる ───────────────────────────────────────────────
  await ctx.settle();
  const start = await snap();
  const visibility = await cdp.eval('({ vis: document.visibilityState, focus: document.hasFocus(), w: innerWidth, h: innerHeight, dpr: devicePixelRatio })');
  const readOnly = await cdp.eval('window.hitomi.settings().then((s) => s.readOnly === true)');
  ctx.note('start', { source: start.source, scope: start.scope, cards: start.cards, home: start.homeShown, ...visibility, readOnly });
  if (!readOnly && !flag('--allow-writer')) {
    console.error('[NG] 母艦が書き手のまま。--read-only で起こし直してから (承知の上なら --allow-writer)');
    process.exit(1);
  }
  const settingsBefore = await cdp.eval('window.hitomi.settings()');

  const only = opt('--only', '');
  // 読む画面のように利用者の持ち物 (栞) を書く場面は --with-reader か --only で名指しした時だけ
  const named = only ? only.split(',') : [];
  const scenes = plan.scenes.filter((s) => (!only || named.includes(s.name)) && (!s.optIn || named.includes(s.name) || flag('--with-reader')));
  if (flag('--list')) { console.log(plan.scenes.map((s) => `${s.name} — ${s.about}`).join('\n')); cdp.close(); return; }
  // 錠は 30 分で「古い」扱い (他の会が上書きしてよい) になる。長い試験のあいだ場面ごとに取り直す
  const refreshLock = () => {
    const owner = process.env.BUNKO_SESSION;
    const lockMod = require('./deploy-lock');
    const lock = lockMod.readLock();
    if (!owner || !lock || lock.owner !== owner) return;
    try {
      require('child_process').execFileSync(process.execPath, [path.join(__dirname, 'deploy-lock.js'), 'take', owner, lock.purpose || 'ui-probe'], { stdio: 'ignore' });
    } catch { /* 取り直せなくても試験は続ける */ }
  };
  for (const scene of scenes) {
    refreshLock();
    console.log(`\n== ${scene.name} — ${scene.about}`);
    try {
      await scene.run(ctx);
    } catch (error) {
      ctx.note(scene.name, { failed: sanitizeText(error && error.message) });
      await key('Escape').catch(() => {}); await sleep(300); await key('Escape').catch(() => {});
    }
  }

  // 設定を控えどおりに戻す (値は出さず、変わった鍵の名だけ)。検索が走ると履歴・session・並びの覚えが書かれるため。
  // 画面の中の state.settings は古いままなので、戻した後は母艦を起こし直す (mothership.js plain)
  const diffKeys = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  const settingsAfter = await cdp.eval('window.hitomi.settings()');
  const changedKeys = diffKeys(settingsBefore, settingsAfter);
  const restorable = changedKeys.filter((k) => RESTORE_KEYS.includes(k));
  if (restorable.length && !flag('--keep-settings')) {
    // 前に無かった鍵は undefined で送る (IPC は undefined を運び、config.json の書き出しで鍵ごと落ちる)。
    // JSON を通すと undefined が消えるので、頁の中で足す
    const patch = Object.fromEntries(restorable.filter((k) => settingsBefore[k] !== undefined).map((k) => [k, settingsBefore[k]]));
    const absent = restorable.filter((k) => settingsBefore[k] === undefined);
    await cdp.eval(`(() => { const p = ${JSON.stringify(patch)}; for (const k of ${JSON.stringify(absent)}) p[k] = undefined; return window.hitomi.saveSettings(p); })()`);
  }
  const left = diffKeys(settingsBefore, await cdp.eval('window.hitomi.settings()'));
  ctx.note('settings-diff', { changedKeys, restored: restorable, stillDifferent: left });
  const end = await snap();
  ctx.note('end', { source: end.source, scope: end.scope, cards: end.cards, home: end.homeShown });

  if (flag('--jev')) {
    const jevJudge = require('./ui-probe-jev');
    await jevJudge.judgeAll(records.filter((r) => r.result), { log: (s) => console.log(s) });
  }

  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ stamp, records }, null, 2));
  fs.writeFileSync(path.join(outDir, 'report.md'), require('./ui-probe-report').markdown(records, { stamp }));
  console.log(`\n[OK] ${records.filter((r) => r.result).length} 件を測った → ${path.relative(ROOT, outDir)}`);
  cdp.close();
}

main().catch((error) => { console.error('[NG] ' + sanitizeText(error && error.stack)); process.exit(1); });
