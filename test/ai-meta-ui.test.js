'use strict';

// 読む画面の右の板 (src/renderer/ai-meta-ui.js) と reader.js の差し込み (issue #3)。
//   重みの色分け・タグ割り・貼る字 (ベース / キャラ / ネガ / 設定の順)・板の状態 (骨組み・あり・なし・失敗)・
//   札の印 (want → ai-marks → has-prompt)・reader.js の開閉 (has-side・Esc は板から・pixiv の AI だけプロンプトの釦)

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadInVm, element } = require('./helpers/vm-dom');
// vm の中で作られた配列は別の realm の物: 値だけ比べる
const plain = (v) => JSON.parse(JSON.stringify(v));

const META = {
  format: 'NovelAI', foundIn: 'stealth_pngcomp', positive: '1girl, {{smile}}, 1.3::long hair::, [blurry], (eyes:1.2), -1::text::',
  negative: 'lowres, {{bad}}', characters: ['girl, red hair', 'boy'], characterNegatives: ['', 'extra arms'],
  settings: { model: 'Model X', seed: 123, steps: 28, scale: 5, cfgRescale: 0.1, sampler: 'k_euler', noiseSchedule: 'karras', width: 64, height: 64, smea: true, smeaDyn: false, requestType: 'PromptGenerateRequest' },
  extra: {}, workflowTexts: [], note: '',
};

function ui({ hitomi = {} } = {}) {
  const calls = [];
  const api = { pixiv: async (payload) => { calls.push(payload); return hitomi.pixiv ? hitomi.pixiv(payload) : {}; }, openExternal: async () => {} };
  const ctx = loadInVm('src/renderer/ai-meta-ui.js', { globals: { hitomi: api }, autoQuery: true });
  return { AM: ctx.window.BunkoAiMeta, ctx, calls };
}

test('重みの記法を色分けする: 上げる (w-up) と下げる (w-down)。壊れていても落ちない', () => {
  const { AM } = ui();
  const html = AM.colorize(META.positive);
  assert.match(html, /<span class="w-up"><span class="w-n">\{\{<\/span>smile<span class="w-n">\}\}<\/span><\/span>/);
  assert.match(html, /<span class="w-up"><span class="w-n">1\.3::<\/span>long hair<span class="w-n">::<\/span><\/span>/);
  assert.match(html, /<span class="w-down"><span class="w-n">\[<\/span>blurry<span class="w-n">\]<\/span><\/span>/);
  assert.match(html, /<span class="w-up"><span class="w-n">\(<\/span>eyes<span class="w-n">:1\.2\)<\/span><\/span>/);
  assert.match(html, /<span class="w-down"><span class="w-n">-1::<\/span>text/);
  assert.equal(AM.colorize('a <b> & "c"'), 'a &lt;b&gt; &amp; &quot;c&quot;', '字は逃がす');
  assert.equal(AM.colorize('{{unclosed, (x:1.'), '{{unclosed, (x:1.');
  assert.equal(AM.colorize(''), '');
});

test('タグに割る: , で切り、{} [] () と n::x:: の中の , は切らない。重みの向きの class', () => {
  const { AM } = ui();
  assert.deepEqual(plain(AM.splitTags('1girl, {{a, b}}, 1.3::long hair::, (x:1.2), -1::text::, [y]')), ['1girl', '{{a, b}}', '1.3::long hair::', '(x:1.2)', '-1::text::', '[y]']);
  assert.equal(AM.weightClass('{{a}}'), 'w-up');
  assert.equal(AM.weightClass('1.3::x::'), 'w-up');
  assert.equal(AM.weightClass('(x:0.8)'), 'w-down');
  assert.equal(AM.weightClass('-1::x::'), 'w-down');
  assert.equal(AM.weightClass('plain'), '');
});

test('貼る字: 全部コピーは ベース → キャラ → ネガ → キャラのネガ → 設定 の順に見出しつき。設定は表と同じ行', () => {
  const { AM } = ui();
  const all = AM.allText(META);
  const order = ['# ベース', '# キャラ 1', '# キャラ 2', '# ネガティブ', '# キャラ 2 ネガティブ', '# 設定'].map((h) => all.indexOf(h));
  assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])), all);
  assert.ok(!all.includes('# キャラ 1 ネガティブ'), '空のキャラのネガは出さない');
  const settings = AM.settingsText(META);
  assert.match(settings, /^モデル: Model X\n/);
  assert.match(settings, /seed: 123/);
  assert.match(settings, /サイズ: 64 × 64/);
  assert.match(settings, /SMEA: SMEA\n/);
  assert.deepEqual(plain(AM.settingRows({ settings: {}, extra: { 'Denoising strength': '0.4' } }).map((r) => r[1])), ['Denoising strength']);
});

test('板の中身: 骨組み (取得中) は大きさを先に取る・あり はカードと設定の表とコピーの釦・なし と 失敗 は見分けて出す', () => {
  const { AM } = ui();
  const base = { kind: 'prompt', page: 1, pageCount: 3, view: 'text', gallery: { id: 'px:1' } };
  const skel = AM.promptMarkup({ ...base, status: 'loading' });
  assert.match(skel, /ai-skel/);
  assert.match(skel, /aria-busy="true"/);
  assert.match(skel, /2 \/ 3/);
  const ok = AM.promptMarkup({ ...base, status: 'ok', meta: META, source: 'aitag' });
  assert.equal((ok.match(/class="ai-card/g) || []).length, 5, 'ベース・キャラ 2・ネガ・キャラ 2 のネガ');
  assert.equal((ok.match(/data-ai-copy-text=/g) || []).length, 5, 'カードごとにコピー');
  assert.match(ok, /data-ai-copy="all"/);
  assert.match(ok, /data-ai-copy="settings"/);
  assert.match(ok, /<dt>seed<\/dt><dd class="">123<\/dd>/);
  assert.match(ok, /aitag\.win から/);
  assert.match(ok, /data-ai-reload/, 'aitag の時は原寸から読み直せる');
  const chips = AM.promptMarkup({ ...base, status: 'ok', meta: META, source: 'original', view: 'chips' });
  assert.ok((chips.match(/data-ai-tag=/g) || []).length >= 8, 'チップ');
  assert.doesNotMatch(chips, /data-ai-reload/);
  const none = AM.promptMarkup({ ...base, status: 'none', source: 'aitag' });
  assert.match(none, /この画像には生成情報が残っていません/);
  assert.doesNotMatch(none, /is-fail/);
  const failed = AM.promptMarkup({ ...base, status: 'failed', error: { code: 'pixiv-login' } });
  assert.match(failed, /is-fail/);
  assert.match(failed, /ログインしていません/);
  assert.match(failed, /data-ai-retry/);
  const info = AM.infoMarkup({ id: 'px:1', source: 'pixiv', title: '題', ai: true, r18: false, pageCount: 3, publishedDate: '2026-10-18', artists: [{ type: 'artist', name: '作者' }], tags: [{ type: 'tag', name: 'タグ', label: 'tag' }] });
  assert.match(info, /<h3>情報<\/h3>/);
  assert.match(info, /pixiv · AI/);
  assert.match(info, /class="tag artist"/);
  assert.match(info, /3 頁/);
});

test('render: 同じ頁は画面の側で控え、頁を行き来しても網 (IPC) に二度出ない。ok なら印も yes に', async () => {
  const { AM, ctx, calls } = ui({ hitomi: { pixiv: async (p) => (p.action === 'ai-meta' ? { status: p.index === 1 ? 'none' : 'ok', source: 'aitag', meta: META } : {}) } });
  const host = ctx.document.createElement('aside');
  const gallery = { id: 'px:10', source: 'pixiv', ai: true, pageCount: 2, publishedDate: '2026-01-01' };
  AM.render(host, { kind: 'prompt', gallery, page: 0 });
  assert.match(host.innerHTML, /ai-skel/, '先に骨組み');
  await new Promise((r) => setTimeout(r, 0));
  assert.match(host.innerHTML, /Model X/);
  assert.equal(AM.markOf('px:10'), 'yes');
  AM.render(host, { kind: 'prompt', gallery, page: 1 });
  await new Promise((r) => setTimeout(r, 0));
  assert.match(host.innerHTML, /残っていません/);
  AM.render(host, { kind: 'prompt', gallery, page: 0 });
  assert.match(host.innerHTML, /Model X/, '控えからすぐ');
  assert.equal(calls.filter((c) => c.action === 'ai-meta').length, 2);
  AM.render(host, { kind: 'info', gallery, page: 0 });
  assert.match(host.innerHTML, /<h3>情報<\/h3>/);
  assert.equal(calls.filter((c) => c.action === 'ai-meta').length, 2, '情報は網に出ない');
});

test('札の印: want は pixiv の AI だけを 200ms 溜めて一度に訊き、yes の札に has-prompt を写す。新しい投稿は fresh', async () => {
  const { AM, ctx, calls } = ui({ hitomi: { pixiv: async (p) => (p.action === 'ai-marks' ? { marks: { 'px:1': 'yes', 'px:2': 'no' } } : {}) } });
  const seen = [];
  AM.onMarks((ids) => seen.push(...ids));
  const today = new Date().toISOString();
  const added = AM.want([
    { id: 'px:1', source: 'pixiv', ai: true, publishedDate: '2026-01-01' },
    { id: 'px:2', source: 'pixiv', ai: true, publishedDate: today },
    { id: 'px:3', source: 'pixiv', ai: false },
    { id: '99', source: 'hitomi', ai: true },
  ]);
  assert.equal(added, 2);
  AM.want([{ id: 'px:1', source: 'pixiv', ai: true }]);
  await new Promise((r) => setTimeout(r, 260));
  const req = calls.find((c) => c.action === 'ai-marks');
  assert.deepEqual(plain(req.ids), [{ id: 'px:1', fresh: false }, { id: 'px:2', fresh: true }]);
  assert.equal(calls.filter((c) => c.action === 'ai-marks').length, 1, '一度に');
  assert.equal(AM.markOf('px:1'), 'yes');
  assert.equal(AM.markOf('px:2'), 'no');
  assert.deepEqual(plain(seen), ['px:1']);
  // 写す: 札 (data-id)・関連 (data-related-detail)・詳細の釦 (data-ai-meta)
  const card = ctx.document.createElement('article'); card.dataset.id = 'px:1';
  const no = ctx.document.createElement('article'); no.dataset.id = 'px:2';
  const btn = ctx.document.createElement('button'); btn.dataset.aiMeta = 'px:1';
  const root = { querySelectorAll: () => [card, no, btn] };
  assert.equal(AM.applyMarks(root), 2);
  assert.equal(card.classList.contains('has-prompt'), true);
  assert.equal(no.classList.contains('has-prompt'), false);
  assert.equal(btn.classList.contains('has-prompt'), true);
  AM.resetMarks();
  assert.equal(AM.markOf('px:1'), '');
});

test('reader.js: 板は pixiv の AI だけプロンプト、他は情報。開くと has-side、頁を送ると板に知らせ、Esc は板 → 読む画面の順', () => {
  const rendered = [];
  const stub = {
    canPrompt: (g) => Boolean(g && g.source === 'pixiv' && g.ai === true),
    render: (host, args) => rendered.push({ kind: args.kind, id: args.gallery.id, page: args.page }),
    bind() {}, clear() {},
    markOf: (id) => (String(id) === 'px:5' ? 'yes' : ''),
    pageHasPrompt: (id, page) => String(id) === 'px:5' && page === 0,
    wanted: [], want(list) { this.wanted.push(...list.map((g) => g.id)); }, onMarks() {},
  };
  // reader.js は app.js の共有物 (els / state / toast …) を関数の中から触る: 張りぼてを注ぐ
  const els = new Proxy({}, { get(target, key) { return target[key] ||= element(); } });
  const ctx = loadInVm('src/renderer/reader.js', { globals: {
    BunkoAiMeta: stub, hitomi: { readerActive() {}, saveSettings() {}, readingSet() {} },
    els, state: { reader: null, imageBase: 'http://x', settings: {} }, toast() {}, startDownload() {},
    clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)), sameId: (a, b) => String(a) === String(b),
    imgUrl: (id, page) => `http://x/${id}/${page}`, isEagleItem: () => false, dropRedoUnlessRestoring() {},
    ICON: new Proxy({}, { get: () => '' }),
  } });
  // 頁の枠 (reader-page-slot) は img.closest で引く: 張りぼてに結ぶ
  const slots = [element(), element()];
  slots.forEach((slot) => { const status = element(); slot.querySelector = () => status; });
  els.readerImage.closest = () => slots[0];
  els.readerImage2.closest = () => slots[1];
  const Reader = vm.runInContext('Reader', ctx);
  Reader.bind();
  const ai = { id: 'px:5', source: 'pixiv', ai: true, title: 't', pageCount: 3 };
  Reader.open(ai, 0, { side: 'prompt' });
  assert.equal(Reader.sideOpen(), 'prompt');
  const promptBtn = ctx.document.getElementById('reader-prompt');
  assert.equal(promptBtn.classList.contains('has-prompt'), true, '今の頁にプロンプトがあれば帯の釦が青');
  assert.deepEqual(plain(stub.wanted), ['px:5'], '開いた作品の印を頼む');
  assert.equal(els.reader.classList.contains('has-side'), true);
  assert.deepEqual(rendered.at(-1), { kind: 'prompt', id: 'px:5', page: 0 });
  assert.equal(rendered.length, 1, '開いた時の描きは一度だけ');
  Reader.move(1);
  assert.deepEqual(rendered.at(-1), { kind: 'prompt', id: 'px:5', page: 1 }, '頁を送ると板も');
  assert.equal(promptBtn.classList.contains('has-prompt'), false, '頁 1 は無いと分かっているので釦は素に戻る');
  // 板の上のホイールは頁を送らない (板を巻く)
  const inside = { closest: (sel) => (sel === '#reader-side' ? {} : null) };
  assert.equal(Reader.handleWheel({ target: inside, deltaY: 120, preventDefault() {} }), true);
  assert.deepEqual(rendered.at(-1), { kind: 'prompt', id: 'px:5', page: 1 }, 'ホイールで頁が動いていない');
  assert.equal(Reader.handleKey({ key: 'Escape', preventDefault() {} }), true);
  assert.equal(Reader.sideOpen(), '', 'Esc は先に板を閉じる');
  assert.equal(Reader.isOpen(), true);
  assert.equal(els.reader.classList.contains('has-side'), false);
  Reader.handleKey({ key: 'i', preventDefault() {} });
  assert.equal(Reader.sideOpen(), 'info');
  Reader.close();
  assert.equal(Reader.sideOpen(), '', '閉じれば板も畳む');
  // AI でない作品: p の鍵は効かず、プロンプトの板を頼んでも情報になる
  const other = { id: '77', source: 'hitomi', title: 't', pageCount: 2 };
  Reader.open(other, 0, { side: 'prompt' });
  assert.equal(Reader.sideOpen(), 'info');
  assert.equal(ctx.document.getElementById('reader-prompt').hidden, true);
  Reader.handleKey({ key: 'p', preventDefault() {} });
  assert.equal(Reader.sideOpen(), 'info');
  ctx.__stopTimers?.();
});

test('pageHasPrompt: 板で開いた頁は頁の答え、まだなら作品の印', () => {
  const { AM } = ui();
  AM._metaCache.set('px:9:0', { status: 'ok' });
  AM._metaCache.set('px:9:1', { status: 'none' });
  assert.equal(AM.pageHasPrompt('px:9', 0), true);
  assert.equal(AM.pageHasPrompt('px:9', 1), false);
  assert.equal(AM.pageHasPrompt('px:9', 2), false, '作品の印が無ければ false');
  AM.noteMark('px:9', 'yes');
  assert.equal(AM.pageHasPrompt('px:9', 2), true, '作品の印が yes なら、まだ見ていない頁も true');
});

test('情報は詳細の板と同じ中身 (detailBodyMarkup) を描き、関連も読む。読むの釦は伏せる。無い所では簡易の表', async () => {
  const loaded = [];
  const { AM, ctx } = ui();
  const host = ctx.document.createElement('aside');
  const gallery = { id: 'px:10', source: 'pixiv', ai: true, pageCount: 2, title: '題' };
  AM.render(host, { kind: 'info', gallery, page: 0 });
  assert.match(host.innerHTML, /<h3>情報<\/h3>/);
  assert.doesNotMatch(host.innerHTML, /ai-detail-body/, 'detailBodyMarkup が無ければ簡易の表');
  ctx.detailBodyMarkup = (g) => '<div class="detail-cover"></div><h2>' + g.title + '</h2><div class="detail-actions"><button data-read="1">読む</button></div><div class="pixiv-related-list"></div>';
  ctx.loadDetailRelated = (g, h) => loaded.push([g.id, h === host]);
  AM.render(host, { kind: 'info', gallery, page: 0 });
  assert.match(host.innerHTML, /ai-detail-body/);
  assert.match(host.innerHTML, /<h2>題<\/h2>/);
  assert.deepEqual(plain(loaded), [['px:10', true]], '関連は板の中の器へ');
});
