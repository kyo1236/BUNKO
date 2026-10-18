'use strict';

// pixiv の IPC の読み取り action 'ai-meta' / 'ai-marks' / 'ai-meta-status' と書く 'ai-meta-backfill' (issue #3)。api も aitag も偽物 (網に出ない)。
//   ai-meta は一本の列 (表 → aitag → 先頭 64KB → 原寸) に押し込む。source: 'original' で原寸から読み直す。
//   結果は表 (ai-meta.sqlite のメモリ版) に残り、二度目は網に出ない。429 は列ごと止まり、冷めたら続く。
//   読み取り専用でも ai-meta / ai-marks は動く。原寸の口が無い投稿は no-original。

const test = require('node:test');
const assert = require('node:assert/strict');
require('./helpers/stub-electron');
const pixivBundle = require('../src/lib/pixiv');
const adapter = require('../src/lib/sources/pixiv');
const { registerPixivIpc, WRITE_ACTIONS } = require('../src/main/ipc/pixiv-ipc');
const { AitagClient } = require('../src/lib/aitag');
const { AiMetaStore } = require('../src/lib/ai-meta-store');
const F = require('./helpers/ai-meta-fixtures');

function illust(id, { pages = 2, original = true } = {}) {
  const page = (i) => ({
    image_urls: {
      medium: `https://i.pximg.net/c/540x540_70/img-master/${id}_p${i}_master1200.jpg`,
      large: `https://i.pximg.net/c/600x1200_90/img-master/${id}_p${i}_master1200.jpg`,
      original: original ? `https://i.pximg.net/img-original/img/${id}_p${i}.png` : '',
    },
  });
  return {
    id, title: `題 ${id}`, type: 'illust', page_count: pages, user: { id: 77, name: '作者' }, tags: [],
    create_date: '2026-10-18T00:00:00+09:00', image_urls: page(0).image_urls, meta_single_page: {}, meta_pages: Array.from({ length: pages }, (_, i) => page(i)),
    illust_ai_type: 2, x_restrict: 0,
  };
}

// 偽の aitag: routes(url) → JSON | null (404) | Error
function fakeAitag(routes, { enabled = true, store } = {}) {
  const calls = [];
  const transport = {
    async get(url) {
      calls.push(url);
      const hit = routes(url);
      if (hit instanceof Error) throw hit;
      if (hit == null) { const e = new Error('HTTP 404'); e.status = 404; throw e; }
      return { status: 200, headers: {}, buffer: Buffer.from(JSON.stringify(hit)) };
    },
  };
  const client = new AitagClient({ store: store || new AiMetaStore({ file: ':memory:' }), transport, enabled: () => enabled });
  client.calls = calls;
  return client;
}
const naiJson = (() => { const d = F.naiDict({ seed: 42 }); return { ...d, Comment: JSON.parse(d.Comment) }; })();
const aitagWork = (id, pages) => ({ work: { id: Number(id) }, images: pages.map((p) => ({ file_name: `${id}_p${p}.png`, image_type: 'NAI', model: null, prompt_text: null, ai_json: JSON.stringify(naiJson) })) });

// images(url, opts): 返す物。opts.range が付いていれば先頭だけの頼み
function setup({ images, originals = true, aitag, readOnly = true } = {}) {
  adapter._resetForTest();
  const calls = [];
  const api = {
    async illustDetail(id) { calls.push(['detail', id]); return illust(id, { original: originals }); },
    async image(url, opts) {
      calls.push(['image', url, opts && opts.lane, opts && opts.range ? 'head' : 'full']);
      const reply = images(url, opts);
      if (reply instanceof Error) throw reply;
      const buf = opts && opts.range ? reply.subarray(0, 65536) : reply;
      return { buffer: buf, headers: { 'content-type': 'image/png' } };
    },
  };
  const restore = pixivBundle._setForTest({
    api,
    auth: { loggedIn: () => true, user: { id: '42', name: '自分' } },
    manners: { state: () => ({ api: { waiting: 0 }, pausedForMs: 0 }) },
    settings: { hideAi: false, readOriginal: false },
  });
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
  const client = aitag || fakeAitag(() => null);
  const sent = [];
  const handles = registerPixivIpc({
    ipcMain, config: { load: () => ({}) }, downloader: {}, pawLibrary: {}, reading: null,
    readOnly, READ_ONLY_ERROR: 'ro', send: (ch, p) => sent.push([ch, p]),
    getPixivLibrary: () => ({ pids: () => ['900', '901'] }), getPixivImporter: () => null, getMainWindow: () => null, openPixivLogin: async () => '',
    aitag: client,
  });
  const call = (payload) => handlers.get('pixiv')(null, payload);
  const stop = () => { handles.aiMetaQueue.stop(); restore(); };
  return { call, calls, restore: stop, aitag: client, store: handles.aiMetaStore, queue: handles.aiMetaQueue, sent };
}

const a1111 = F.png({ width: 16, height: 16, text: { parameters: F.A1111_TEXT } });
const plain = F.png({ width: 16, height: 16 });
const heads = (calls) => calls.filter((c) => c[0] === 'image' && c[3] === 'head');
const fulls = (calls) => calls.filter((c) => c[0] === 'image' && c[3] === 'full');

test('ai-meta / ai-marks / ai-meta-status は読み取りの action、ai-meta-backfill は書く action', () => {
  assert.equal(WRITE_ACTIONS.has('ai-meta'), false);
  assert.equal(WRITE_ACTIONS.has('ai-marks'), false);
  assert.equal(WRITE_ACTIONS.has('ai-meta-status'), false);
  assert.equal(WRITE_ACTIONS.has('ai-meta-backfill'), true);
});

test('aitag が主: 載っていれば原寸を取らずに返す (頁は _p<n>)。source: original で原寸から読み直す', async () => {
  const aitag = fakeAitag((url) => (/work\/500$/.test(url) ? aitagWork(500, [0, 1]) : null));
  const { call, calls, restore, store } = setup({ images: () => a1111, aitag, readOnly: false });
  try {
    const first = await call({ action: 'ai-meta', id: 'px:500', index: 1 });
    assert.equal(first.status, 'ok');
    assert.equal(first.source, 'aitag');
    assert.equal(first.meta.format, 'NovelAI');
    assert.equal(first.meta.settings.seed, 42);
    assert.equal(calls.filter((c) => c[0] === 'image').length, 0, '原寸は取らない');
    await call({ action: 'ai-meta', id: 'px:500', index: 0 });
    assert.equal(aitag.calls.length, 1, '一作品ぶんを一度で (頁を送っても訊き直さない)');
    const again = await call({ action: 'ai-meta', id: 'px:500', index: 0, source: 'original' });
    assert.equal(again.source, 'original');
    assert.equal(again.meta.format, 'A1111');
    assert.equal(fulls(calls).length, 1, '読み直しは原寸を取る');
    assert.equal(heads(calls).length, 0, '読み直しは先頭を飛ばす');
    assert.equal(store.get('500', 0).source, 'original', '強い出どころで上書き');
  } finally { restore(); }
});

test('aitag に無ければ先頭 64KB (眺める車線) → 原寸。表に残り、同じ頁は網に出ない。情報なしも残る', async () => {
  const aitag = fakeAitag(() => null);
  const { call, calls, restore, store } = setup({ images: (url) => (/_p0\.png$/.test(url) ? a1111 : plain), aitag, readOnly: false });
  try {
    const first = await call({ action: 'ai-meta', id: 'px:500', index: 0 });
    assert.equal(first.status, 'ok');
    assert.equal(first.source, 'head64k', '文字チャンクは先頭で分かる');
    assert.equal(first.meta.settings.steps, 20);
    assert.equal(heads(calls).length, 1);
    assert.equal(fulls(calls).length, 0, '先頭で分かれば原寸は取らない');
    assert.match(heads(calls)[0][1], /img-original/);
    assert.equal(heads(calls)[0][2], 'view', '眺める車線 (作法を通す)');
    assert.equal(store.markOf('500'), 'yes');

    await call({ action: 'ai-meta', id: 'px:500', index: 0 });
    assert.equal(calls.filter((c) => c[0] === 'image').length, 1, '二度目は表から');
    const second = await call({ action: 'ai-meta', id: 'px:500', index: 1 });
    assert.equal(second.status, 'none');
    assert.equal(second.source, 'original', '先頭に無ければ原寸まで見て無し');
    assert.equal(heads(calls).length, 2);
    assert.equal(fulls(calls).length, 1);
    await call({ action: 'ai-meta', id: 'px:500', index: 1 });
    assert.equal(fulls(calls).length, 1, '情報なしも表に残る');
    assert.equal(aitag.calls.length, 1, 'aitag の 404 も表に残る (頁ごとに訊き直さない)');
  } finally { restore(); }
});

test('429 が出ると列ごと止まり、冷めたら続きから (頼みは捨てない)。頁の番号が無い頼みは断る', async () => {
  let fail = true;
  const { call, calls, restore, queue } = setup({ images: () => { if (fail) { const e = new Error('429'); e.status = 429; e.rateLimited = true; e.retryAfterMs = 60000; return e; } return a1111; }, readOnly: false });
  try {
    const pending = call({ action: 'ai-meta', id: 'px:7', index: 0 });
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(queue.status().pausedForMs > 0, '列が止まった');
    assert.equal(queue.status().pressing, 1, '頼みは先頭に戻してある');
    fail = false;
    queue.pausedUntil = 0;
    queue.kick();
    const ok = await pending;
    assert.equal(ok.status, 'ok');
    assert.equal(heads(calls).length, 2);
    await assert.rejects(call({ action: 'ai-meta', id: 'px:' }), /番号/);
    await assert.rejects(call({ action: 'ai-meta', id: 'user:77' }), /番号/);
  } finally { restore(); }
});

test('原寸の口が無い投稿は no-original (情報なしと見分ける)。読み取り専用でも ai-meta は動く (表には書かない)', async () => {
  const { call, restore, store } = setup({ images: () => plain, originals: false, readOnly: true });
  try {
    const out = await call({ action: 'ai-meta', id: 'px:9', index: 0 });
    assert.equal(out.status, 'no-original');
    assert.ok(store.pages('9').every((r) => r.source === 'aitag'), '写しの列は表に書かない (aitag の印だけ)');
    await assert.rejects(call({ action: 'ai-meta-backfill', op: 'start' }), /ro/, '埋め戻しは書く action');
  } finally { restore(); }
});

test('ai-marks: ids は yes / no / unknown、userId は作者の一括。aitag に無かった物は後ろの列で確定させる。aitag を切ると unknown', async () => {
  const aitag = fakeAitag((url) => {
    if (/ai_works_search/.test(url)) return { page: 1, page_size: 60, total: 1, items: [{ id: 31, userId: 77 }] };
    return /work\/21$/.test(url) ? aitagWork(21, [0]) : null;
  });
  const { call, restore, queue, store, calls } = setup({ images: () => plain, aitag, readOnly: false });
  try {
    const out = await call({ action: 'ai-marks', ids: ['px:21', { id: 'px:22', fresh: true }, 'nh:5'] });
    assert.deepEqual(out.marks, { 'px:21': 'yes', 'px:22': 'no' });
    const user = await call({ action: 'ai-marks', userId: 'user:77' });
    assert.deepEqual(user.marks, { 'px:31': 'yes' });
    // 確定の列が流れる: 先頭 64KB → 原寸 で無し → 表に original の無し
    for (let i = 0; i < 40 && !(store.get('22', 0) && store.get('22', 0).source === 'original'); i += 1) await new Promise((r) => setTimeout(r, 20));
    assert.equal(store.markOf('22'), 'no');
    assert.equal(store.get('22', 0).source, 'original', '確定の列が原寸まで見た');
    assert.equal(fulls(calls).length, 1);
    const status = await call({ action: 'ai-meta-status' });
    assert.ok(status.rows >= 3);
  } finally { restore(); }
  const off = setup({ images: () => plain, aitag: fakeAitag(() => null, { enabled: false }), readOnly: false });
  try {
    assert.deepEqual((await off.call({ action: 'ai-marks', ids: ['px:1'] })).marks, { 'px:1': 'unknown' });
    const meta = await off.call({ action: 'ai-meta', id: 'px:1', index: 0 });
    assert.equal(meta.source, 'original', '切ってあれば原寸へ');
  } finally { off.restore(); }
});

test('ai-meta-backfill: 台帳の投稿 ID を後ろの列に積み、進みを送る', async () => {
  const aitag = fakeAitag((url) => (/work\/900$/.test(url) ? aitagWork(900, [0]) : null));
  const { call, restore, sent, store } = setup({ images: () => plain, aitag, readOnly: false });
  try {
    const st = await call({ action: 'ai-meta-backfill', op: 'start' });
    assert.equal(st.backfill.total, 2);
    for (let i = 0; i < 30 && (await call({ action: 'ai-meta-backfill' })).backfill.running; i += 1) await new Promise((r) => setTimeout(r, 20));
    const done = await call({ action: 'ai-meta-backfill' });
    assert.equal(done.backfill.done, 2);
    assert.equal(done.backfill.found, 1);
    assert.equal(store.markOf('900'), 'yes');
    assert.equal(store.markOf('901'), 'no', 'PDF の道が無ければ原寸まで見て無し');
    assert.ok(sent.some(([ch]) => ch === 'ai-meta-backfill'));
  } finally { restore(); }
});
