'use strict';

// 生成情報を確かめる一本の列 (src/lib/ai-meta-queue.js)。網にも PDF にも出ない (全部偽物)。
//   順: 表 → aitag → 先頭 64KB → 原寸。押した物は先頭、確定と埋め戻しは後ろ。429 で列ごと止まり、冷めたら続く。
//   埋め戻し: aitag → PDF の頁 (JPEG の EXIF / Flate のステルス) → 原寸 → 確認できず

const test = require('node:test');
const assert = require('node:assert/strict');
require('./helpers/stub-electron');
const { AiMetaQueue } = require('../src/lib/ai-meta-queue');
const { AiMetaStore } = require('../src/lib/ai-meta-store');
const F = require('./helpers/ai-meta-fixtures');

const META = { format: 'NovelAI', foundIn: 'stealth_pngcomp', positive: 'a', negative: 'b', characters: [], characterNegatives: [], settings: { model: 'M', seed: 9 }, extra: {}, workflowTexts: [], note: '' };
const a1111Png = F.png({ width: 16, height: 16, text: { parameters: F.A1111_TEXT } });
const plainPng = F.png({ width: 16, height: 16 });
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function rig({ aitagWork = async () => ({ status: 'none' }), head = async () => ({ bytes: plainPng, url: 'https://i.pximg.net/img-original/x_p0.png' }), full = async () => ({ bytes: plainPng, url: 'https://i.pximg.net/img-original/x_p0.png' }), analyze = async () => null, pdfPages = null } = {}) {
  const calls = [];
  const store = new AiMetaStore({ file: ':memory:' });
  const queue = new AiMetaQueue({
    store,
    aitag: { work: async (pid, o) => { calls.push(['aitag', pid]); return aitagWork(pid, o); } },
    pixivSource: {
      fetchImageHead: async (pid, page) => { calls.push(['head', pid, page]); return head(pid, page); },
      fetchImage: async (pid, page) => { calls.push(['full', pid, page]); return full(pid, page); },
    },
    analyze: async (bytes) => { calls.push(['analyze']); return analyze(bytes); },
    pdfPages: pdfPages ? async (pid) => { calls.push(['pdf', pid]); return pdfPages(pid); } : null,
    send() {},
  });
  return { queue, store, calls };
}

test('press: 表に無ければ aitag → 先頭 64KB → 原寸 の順。先頭で見つかれば原寸は取らず、表に head64k で残る', async () => {
  const { queue, store, calls } = rig({ head: async () => ({ bytes: a1111Png, url: 'https://i.pximg.net/img-original/1_p0.png' }) });
  const out = await queue.press('px:1', 0);
  assert.equal(out.status, 'ok');
  assert.equal(out.source, 'head64k');
  assert.equal(out.meta.format, 'A1111');
  assert.deepEqual(calls.map((c) => c[0]), ['aitag', 'head']);
  assert.equal(store.get('1', 0).source, 'head64k');
  // 二度目は表から (網に出ない)
  const again = await queue.press('px:1', 0);
  assert.equal(again.source, 'head64k');
  assert.equal(calls.length, 2);
  queue.stop();
});

test('先頭に無ければ原寸ぜんぶ (ステルス)。無ければ none を original で残し、次からは原寸も取らない。force: original は読み直す', async () => {
  let found = null;
  const { queue, store, calls } = rig({ analyze: async () => found });
  const out = await queue.press('2', 0);
  assert.equal(out.status, 'none');
  assert.deepEqual(calls.map((c) => c[0]), ['aitag', 'head', 'full', 'analyze']);
  assert.equal(store.get('2', 0).source, 'original');
  assert.equal(store.markOf('2'), 'no');
  const again = await queue.press('2', 0);
  assert.equal(again.status, 'none');
  assert.equal(calls.length, 4, '原寸で無しと決まった頁は訊き直さない');
  found = META;
  const forced = await queue.press('2', 0, { force: 'original' });
  assert.equal(forced.status, 'ok');
  assert.equal(store.get('2', 0).source, 'original');
  assert.equal(calls.filter((c) => c[0] === 'full').length, 2);
  queue.stop();
});

test('aitag に載っていればそこで止まる。原寸の口が無い投稿は no-original', async () => {
  const { queue, calls } = rig({ aitagWork: async () => ({ status: 'ok', images: [{ index: 1, meta: META }] }), head: async () => null });
  const p1 = await queue.press('3', 1);
  assert.equal(p1.source, 'aitag');
  assert.deepEqual(calls.map((c) => c[0]), ['aitag']);
  const p0 = await queue.press('3', 0);
  assert.equal(p0.status, 'no-original', '索引に無い頁で原寸の口も無い');
  queue.stop();
});

test('押した物は先頭、確定は後ろ。429 が出たら列ごと止まり、冷めたら続く (仕事は捨てない)', async () => {
  let now = 0;
  let cold = true;
  const order = [];
  const { queue, calls } = rig({
    aitagWork: async (pid) => { order.push(pid); if (cold && pid === '20') { const e = new Error('429'); e.rateLimited = true; e.retryAfterMs = 1500; throw e; } return { status: 'ok', images: [{ index: 0, meta: META }] }; },
  });
  queue.now = () => now;
  queue.store.now = () => now;
  queue.confirm('20');
  queue.confirm('21');
  queue.confirm('21');
  assert.equal(queue.status().waiting, 2, '同じ物は二度積まない');
  const pressed = queue.press('22', 0);
  await tick(30);
  assert.equal(order[0], '22', '押した物が先');
  assert.ok(queue.status().pausedForMs > 0, '429 で止まった');
  assert.equal(queue.status().waiting, 2, '仕事は戻してある');
  cold = false;
  now += 2000;
  queue.kick();
  await tick(60);
  assert.deepEqual(order, ['22', '20', '20', '21']);
  assert.equal((await pressed).status, 'ok');
  assert.ok(calls.length >= 4);
  queue.stop();
});

test('埋め戻し: aitag → PDF の頁 (JPEG の EXIF / Flate のステルス) → 原寸 → 確認できず。進みを知らせる', async () => {
  const sent = [];
  const jpegExif = F.jpegWithExif(F.A1111_TEXT);
  const { queue, store, calls } = rig({
    pdfPages: async (pid) => {
      if (pid === '31') return { file: 'a.pdf', pages: [{ index: 0, kind: 'dct', bytes: jpegExif }] };
      if (pid === '32') return { file: 'b.pdf', pages: [{ index: 0, kind: 'flate', stealth: async () => JSON.stringify(F.naiDict({ seed: 77 })) }, { index: 1, kind: 'flate', stealth: async () => null }] };
      if (pid === '33') return { file: 'c.pdf', pages: [{ index: 0, kind: 'flate', stealth: async () => null }] };
      return null;
    },
    full: async (pid) => { if (pid === '33') { const e = new Error('404'); e.status = 404; throw e; } return { bytes: plainPng, url: 'https://i.pximg.net/img-original/x.png' }; },
  });
  queue.send = (channel, payload) => sent.push([channel, payload && payload.done, payload && payload.running, payload && payload.mark]);
  store.put({ pid: '30', page: 0, status: 'ok', source: 'aitag', meta: META });
  const st = queue.startBackfill(['px:30', '31', '32', '33', '34', 'user:5']);
  assert.equal(st.backfill.total, 4, '表で yes の物と番号でない物は数えない');
  await tick(80);
  assert.equal(queue.status().backfill.running, false);
  assert.equal(queue.status().backfill.done, 4);
  assert.equal(store.get('31', 0).source, 'pdf-smask');
  assert.equal(store.get('31', 0).meta.format, 'A1111', 'JPEG の EXIF');
  assert.equal(store.get('32', 0).source, 'pdf-smask');
  assert.equal(store.get('32', 0).meta.settings.seed, 77, 'Flate のステルス');
  assert.equal(store.markOf('33'), 'no', 'PDF にも無く pixiv からも取れない → 無し (pdf-smask) のまま');
  assert.equal(store.get('34', 0).source, 'original', 'PDF が無ければ原寸');
  assert.equal(queue.status().backfill.found, 2);
  assert.deepEqual(sent.filter(([ch]) => ch === 'ai-meta-mark').length, 2, 'あり に変わった 2 件を画面へ知らせる');
  assert.ok(calls.some((c) => c[0] === 'pdf' && c[1] === '31'));
  assert.ok(sent.length >= 2 && sent.at(-1)[2] === false);
  queue.stop();
});
