'use strict';
// ui-probe.js が本窓へ差し込む測り道具 (window.__probe)。関数の中身だけが頁で走る。
// 返す物は数・id・class・data の名前だけ。**要素の字 (題・タグ・作者名・打った語) は label として素のまま返すが、
// 外へ出す前に ui-probe.js の sanitizeLabel が「ソースに書かれた UI の語」以外を伏せる。**
/* eslint-disable no-undef */
function probeKit() {
  if (window.__probe && window.__probe.version === 9) return 'kept';

  const OVERLAYS = ['detail', 'queue', 'reader', 'settings', 'help', 'paw-link', 'loupe', 'suggest', 'notice'];
  const POPOVERS = { 'sort-menu': '.ui-sort-menu', 'display-menu': '.ui-display-menu', 'link-picker': '#detail .link-picker', 'home-author-page': '#home-author-view' };
  const REGIONS = {
    rail: 'header.rail', filters: 'section.filters', workspace: 'main.workspace', grid: '#grid',
    detail: '#detail', queue: '#queue', reader: '#reader', settings: '#settings .settings-panel',
    notice: '#notice', recents: '#recents', types: '#types',
  };
  // 値を外へ出してよい data-* (コードが決める語だけ。題やタグの入る data-query などは名前だけ)
  const DATA_VALUE_OK = /^data-(act|view|type|tab|kind|home-rate|home-link|home-origin|home-origin-set|home-site|site|pref|mode|zoom|sort|op|action|nav|step|dir|page-mode)$/;
  const LAYOUT_PROPS = /^(width|height|top|left|right|bottom|margin|padding|inset|grid|flex|min-|max-|border-width|font-size|line-height)/;

  const buf = { longtasks: [], shifts: [], errors: [], frames: [], mutations: 0, firstMutation: null, clickAt: null };

  function sel(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.id) return '#' + el.id;
    const parts = [];
    let n = el;
    for (let i = 0; n && n.nodeType === 1 && i < 4; i++, n = n.parentElement) {
      if (n.id) { parts.unshift('#' + n.id); break; }
      let s = n.tagName.toLowerCase();
      const cls = [...n.classList].filter((c) => !/^(is-|active$|on$|selected$|current$)/.test(c)).slice(0, 2);
      if (cls.length) s += '.' + cls.join('.');
      if (i === 0) {
        for (const a of n.getAttributeNames()) {
          if (!a.startsWith('data-')) continue;
          s += DATA_VALUE_OK.test(a) ? `[${a}="${String(n.getAttribute(a)).slice(0, 24)}"]` : `[${a}]`;
        }
      }
      parts.unshift(s);
    }
    return parts.join(' > ');
  }

  function visible(el) {
    if (!el || !el.isConnected) return false;
    if (el.closest('[hidden]')) return false;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  }
  function inViewport(el) {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }
  const rectOf = (el) => {
    if (!el || !visible(el)) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };

  function snap() {
    const overlays = {};
    for (const id of OVERLAYS) {
      const el = document.getElementById(id);
      overlays[id] = !!(el && visible(el));
    }
    // 小窓 (並び・表示の設定) と Home の作者頁も開閉の印に
    for (const [k, s] of Object.entries(POPOVERS)) overlays[k] = [...document.querySelectorAll(s)].some((e) => visible(e));
    const regions = {};
    for (const [k, s] of Object.entries(REGIONS)) regions[k] = rectOf(document.querySelector(s));
    const cards = [...document.querySelectorAll('#grid .card, #home-author-view .card')];
    const shown = cards.filter((c) => visible(c) && inViewport(c));
    const imgs = shown.map((c) => c.querySelector('img')).filter(Boolean);
    const status = document.getElementById('status');
    const empty = document.getElementById('empty');
    const src = document.getElementById('source');
    const scope = document.getElementById('scope');
    const ws = document.querySelector('main.workspace');
    return {
      source: src ? src.value : null,
      scope: scope ? scope.getAttribute('aria-pressed') : null,
      overlays,
      regions,
      cards: cards.length,
      cardsInView: shown.length,
      imgsInView: imgs.length,
      imgsLoaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
      imgsBroken: imgs.filter((i) => i.complete && i.naturalWidth === 0 && i.getAttribute('src')).length,
      statusShown: !!(status && visible(status)),
      emptyShown: !!(empty && visible(empty)),
      gridChildren: (document.getElementById('grid') || { childElementCount: 0 }).childElementCount,
      homeShown: document.body.hasAttribute('data-home'),
      homeAuthor: document.body.hasAttribute('data-home-author'),
      gridOpen: (() => { const g = document.getElementById('grid'); return !!g && !g.closest('[hidden]') && getComputedStyle(g).display !== 'none'; })(),
      scrollTop: ws ? Math.round(ws.scrollTop) : null,
      winScroll: Math.round(scrollY),
      active: sel(document.activeElement),
      running: document.getAnimations().filter((a) => a.playState === 'running').length,
      bodyClass: [...document.body.classList].slice(0, 8),
      // 棚の中身の指紋 (先頭の札の id から作る短い数)。操作の前後で違えば中身が入れ替わった
      sig: (() => { let h = 0; for (const c of cards.slice(0, 8)) for (const ch of String(c.dataset.id || '')) h = (h * 31 + ch.charCodeAt(0)) | 0; return (h >>> 0).toString(36); })(),
    };
  }

  const CONTROL_SEL = [
    'button', '[role=button]', '[role=tab]', '[role=option]', 'a[href]', 'select', 'summary',
    'input:not([type=hidden])', '.card', '[data-query]', '[data-home-query]', '[data-home-person]',
  ].join(',');

  function controls(rootSel) {
    const root = rootSel ? document.querySelector(rootSel) : document;
    if (!root) return [];
    const seen = new Set();
    const out = [];
    for (const el of root.querySelectorAll(CONTROL_SEL)) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (!visible(el) || !inViewport(el)) continue;
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      const covered = !!hit && hit !== el && !el.contains(hit) && !hit.contains(el);
      out.push({
        sel: sel(el),
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        cls: [...el.classList].slice(0, 4),
        role: el.getAttribute('role'),
        type: el.getAttribute('type'),
        disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true'),
        pressed: el.getAttribute('aria-pressed'),
        selected: el.getAttribute('aria-selected'),
        text: (el.innerText || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 40),
        title: el.getAttribute('title') || '',
        aria: el.getAttribute('aria-label') || '',
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        center: { x: Math.round(cx), y: Math.round(cy) },
        covered,
        coveredBy: covered ? sel(hit) : null,
      });
    }
    return out;
  }

  // 押す直前に呼ぶ。印の要素の中心の座標を返し、測りを始める
  function arm(selector, index = 0) {
    const els = [...document.querySelectorAll(selector)].filter((e) => visible(e));
    const el = els[index];
    if (!el) return { ok: false, why: 'not-found', count: els.length };
    if (!inViewport(el)) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    const covered = !!hit && hit !== el && !el.contains(hit) && !hit.contains(el);
    reset();
    buf.target = el;
    buf.targetBefore = controlState(el);
    buf.before = snap();
    buf.animsBefore = new Set(document.getAnimations());
    startFrames();
    return { ok: true, x: Math.round(cx), y: Math.round(cy), covered, coveredBy: covered ? sel(hit) : null, sel: sel(el) };
  }

  // 釦を使わない出来事 (キー・select の change) の前に
  function armBare() {
    reset();
    buf.before = snap();
    buf.animsBefore = new Set(document.getAnimations());
    startFrames();
    buf.clickAt = performance.now();
    return { ok: true };
  }

  function reset() {
    buf.longtasks = []; buf.shifts = []; buf.errors = []; buf.frames = [];
    buf.mutations = 0; buf.firstMutation = null; buf.clickAt = null; buf.samples = []; buf.areas = new Map(); buf.target = null; buf.targetBefore = null;
  }

  // 押した物の押した後の姿 (トグルの印)
  function controlState(el) {
    if (!el || !el.isConnected) return { gone: true };
    return {
      pressed: el.getAttribute('aria-pressed'), checked: typeof el.checked === 'boolean' ? el.checked : null,
      selected: el.getAttribute('aria-selected'), expanded: el.getAttribute('aria-expanded'), current: el.getAttribute('aria-current'),
      on: el.classList.contains('is-on') || el.classList.contains('active'),
    };
  }

  let rafOn = false;
  let rafGen = 0;
  function startFrames() {
    rafOn = true;
    const gen = ++rafGen;
    let last = performance.now();
    const tick = (t) => {
      if (!rafOn || gen !== rafGen) return;
      buf.frames.push(t - last);
      last = t;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function blankNow() {
    const s = snap();
    // 棚は空だと高さ 0 になる (見えない) ので、大きさでなく「隠されていないか」で見る
    const gridOn = s.gridOpen || s.homeAuthor;
    // 棚が見えているのに札も「読み込み中」の字も無い = 空白
    return {
      s,
      blank: gridOn && s.cardsInView === 0 && !s.statusShown && !s.emptyShown && !s.overlays.notice,
      imgsPending: s.imgsInView - s.imgsLoaded - s.imgsBroken,
    };
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 押した後に呼ぶ。動きが終わる (または maxMs) まで 50ms ごとに見本を取り、まとめて返す
  async function collect({ minMs = 450, maxMs = 3000, untilCards = false, untilImages = false } = {}) {
    const t0 = buf.clickAt || performance.now();
    const samples = [];
    let settledAt = null;
    for (;;) {
      await sleep(50);
      const now = performance.now();
      const b = blankNow();
      const running = document.getAnimations().filter((a) => a.playState === 'running' && !(a.effect && a.effect.getTiming && a.effect.getTiming().iterations === Infinity));
      const rl = document.getElementById('reader-loading');
      const readerWait = !!(rl && b.s.overlays.reader && !rl.classList.contains('is-hidden') && visible(rl));
      samples.push({ t: Math.round(now - t0), blank: b.blank, cards: b.s.cardsInView, pend: b.imgsPending, anim: running.length, status: b.s.statusShown, rw: readerWait });
      const quiet = running.length === 0
        && (!untilCards || b.s.cardsInView > 0 || b.s.emptyShown || b.s.homeShown)
        && (!untilImages || b.imgsPending <= 0);
      if (quiet && now - t0 >= minMs) { if (settledAt == null) settledAt = now; if (now - settledAt >= 150) break; } else settledAt = null;
      if (now - t0 >= maxMs) break;
    }
    rafOn = false;
    const after = snap();
    const newAnims = document.getAnimations().filter((a) => !buf.animsBefore.has(a)).concat(buf.lateAnims || []);
    const anims = [];
    const seenA = new Set();
    for (const a of newAnims) {
      if (seenA.has(a)) continue; seenA.add(a);
      const eff = a.effect;
      const timing = eff && eff.getTiming ? eff.getTiming() : {};
      let props = [];
      try { props = [...new Set(eff.getKeyframes().flatMap((k) => Object.keys(k).filter((p) => !['offset', 'easing', 'composite', 'computedOffset'].includes(p))))]; } catch { props = []; }
      if (a.transitionProperty) props = [a.transitionProperty];
      anims.push({
        target: sel(eff && eff.target),
        kind: a.constructor.name,
        name: a.animationName || a.transitionProperty || a.id || '',
        props,
        layoutProps: props.filter((p) => LAYOUT_PROPS.test(p.replace(/([A-Z])/g, '-$1').toLowerCase())),
        duration: typeof timing.duration === 'number' ? Math.round(timing.duration) : String(timing.duration),
        delay: Math.round(timing.delay || 0),
        iterations: timing.iterations === Infinity ? 'inf' : timing.iterations,
        easing: timing.easing,
        state: a.playState,
      });
    }
    const frames = buf.frames.slice(1);
    const blankMs = samples.filter((x) => x.blank).length * 50;
    let firstBlank = null; let lastBlank = null;
    samples.forEach((x) => { if (x.blank) { if (firstBlank == null) firstBlank = x.t; lastBlank = x.t; } });
    const firstCards = samples.find((x) => x.cards > 0);
    return {
      before: buf.before,
      after,
      firstMutationMs: buf.firstMutation == null ? null : Math.round(buf.firstMutation - t0),
      changedAreas: Object.fromEntries([...(buf.areas || new Map())].sort((x, y) => y[1] - x[1]).slice(0, 6)),
      controlBefore: buf.targetBefore || null,
      controlAfter: buf.target ? controlState(buf.target) : null,
      mutations: buf.mutations,
      longtasks: buf.longtasks.filter((x) => x.start >= t0 - 5).map((x) => ({ at: Math.round(x.start - t0), ms: Math.round(x.duration) })),
      shifts: buf.shifts.filter((x) => x.at >= t0 - 5).map((x) => ({ ...x, at: Math.round(x.at - t0) })),
      errors: buf.errors.slice(0, 10),
      frames: {
        count: frames.length,
        maxGap: frames.length ? Math.round(Math.max(...frames)) : 0,
        over50: frames.filter((f) => f > 50).length,
        over33: frames.filter((f) => f > 33.4).length,
      },
      anims,
      blank: { ms: blankMs, from: firstBlank, to: lastBlank },
      // 読む画面の「読み込み中」が見えていた時間 (頁を送ってから絵が出るまで)
      readerWaitMs: samples.filter((x) => x.rw).length * 50,
      firstCardsMs: firstCards ? firstCards.t : null,
      settleMs: samples.length ? samples[samples.length - 1].t : 0,
      samples: samples.length > 80 ? samples.filter((_, i) => i % Math.ceil(samples.length / 80) === 0) : samples,
    };
  }

  // 常駐の観測 (頁の寿命のあいだ一度だけ)
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) buf.longtasks.push({ start: e.startTime, duration: e.duration });
    }).observe({ type: 'longtask', buffered: false });
  } catch { /* 無い */ }
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        buf.shifts.push({
          at: e.startTime,
          value: Math.round(e.value * 10000) / 10000,
          input: e.hadRecentInput,
          sources: (e.sources || []).slice(0, 5).map((s) => ({
            node: sel(s.node),
            dy: Math.round(s.currentRect.y - s.previousRect.y),
            dx: Math.round(s.currentRect.x - s.previousRect.x),
            dh: Math.round(s.currentRect.height - s.previousRect.height),
          })),
        });
      }
    }).observe({ type: 'layout-shift', buffered: false });
  } catch { /* 無い */ }
  window.addEventListener('pointerdown', () => { buf.clickAt = performance.now(); }, true);
  window.addEventListener('keydown', () => { if (buf.clickAt == null) buf.clickAt = performance.now(); }, true);
  window.addEventListener('error', (e) => { buf.errors.push({ kind: 'error', msg: String(e.message || '').slice(0, 200), at: sel(e.target) }); }, true);
  window.addEventListener('unhandledrejection', (e) => { buf.errors.push({ kind: 'rejection', msg: String((e.reason && (e.reason.message || e.reason)) || '').slice(0, 200) }); });
  new MutationObserver((recs) => {
    buf.mutations += recs.length;
    // どこが書き換わったか: 変わった所に一番近い id を持つ祖先で数える (字は見ない)
    // 構えた時から数える (Home の詳細のようにホバーで先に描く物がある)
    if (buf.areas && buf.areas.size < 64) {
      for (const m of recs) {
        let n = m.target && m.target.nodeType === 1 ? m.target : m.target && m.target.parentElement;
        while (n && !n.id) n = n.parentElement;
        const key = n ? '#' + n.id : '(root)';
        buf.areas.set(key, (buf.areas.get(key) || 0) + 1);
      }
    }
    if (buf.firstMutation == null && buf.clickAt != null) buf.firstMutation = performance.now();
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  // 押した直後に生まれて collect 前に終わった動きも拾う
  buf.lateAnims = [];
  document.addEventListener('animationstart', (e) => { try { buf.lateAnims.push(...e.target.getAnimations().filter((a) => !buf.animsBefore || !buf.animsBefore.has(a))); } catch { /* */ } }, true);
  document.addEventListener('transitionrun', (e) => { try { buf.lateAnims.push(...e.target.getAnimations().filter((a) => !buf.animsBefore || !buf.animsBefore.has(a))); } catch { /* */ } }, true);

  const origReset = reset;
  window.__probe = {
    version: 9,
    snap, controls, arm, armBare, collect, sel, visible,
    reset: () => { origReset(); buf.lateAnims = []; },
  };
  // arm/armBare の reset も lateAnims を空ける
  const armOrig = arm;
  window.__probe.arm = (s, i) => { buf.lateAnims = []; return armOrig(s, i); };
  const bareOrig = armBare;
  window.__probe.armBare = () => { buf.lateAnims = []; return bareOrig(); };
  return 'installed';
}

module.exports = { probeKit, source: () => `(${probeKit.toString()})()` };
