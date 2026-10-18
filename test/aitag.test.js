'use strict';

// aitag.win の口 (src/lib/aitag.js)。網には出ない (transport は偽物)。控えは ai-meta-store (メモリの SQLite)。
//   返事の形 (NAI の dict / SD の parameters / ComfyUI の workflow だけ) を共通の形に・頁は file_name の _p<n> で結ぶ・
//   控え (載っている物は頁ごとの行、404 は期限つき、新しい投稿は短い)・失敗が続いたら黙る・作者の一括・印

const test = require('node:test');
const assert = require('node:assert/strict');
require('./helpers/stub-electron');
const { AitagClient, imagesOf, pageIndexOf } = require('../src/lib/aitag');
const { AiMetaStore } = require('../src/lib/ai-meta-store');
const F = require('./helpers/ai-meta-fixtures');

const nai = F.naiDict({ seed: 42 });
const naiJson = { ...nai, Comment: JSON.parse(nai.Comment) };   // aitag は Comment を object で返す
function workJson(id, images) {
  return { work: { id: Number(id), ai_png: 1 }, images };
}
const img = (file, aiJson, extra = {}) => ({ file_name: file, image_type: 'NAI', model: null, prompt_text: null, ai_json: JSON.stringify(aiJson), ...extra });

function fake(routes) {
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
  return { transport, calls };
}

test('imagesOf: NAI の dict (Comment が object)・SD の parameters・ComfyUI の workflow だけ、を頁ごとの共通の形に。頁は file_name の _p<n>', () => {
  const rows = imagesOf(workJson(1, [
    img('1_p1.png', naiJson),
    img('1_p0.png', { parameters: F.A1111_TEXT }, { image_type: 'SD' }),
    img('1_p2.png', F.COMFY_WORKFLOW, { image_type: 'ComfyUI', model: 'm.safetensors' }),
    img('1_p3.png', { nothing: true }),
  ]));
  assert.deepEqual(rows.map((r) => [r.index, r.meta.format]), [[1, 'NovelAI'], [0, 'A1111'], [2, 'ComfyUI']]);
  assert.equal(rows[0].meta.settings.seed, 42);
  assert.equal(rows[2].meta.settings.model, 'm.safetensors', 'model は aitag の列から補う');
  assert.equal(rows[2].meta.note, 'workflow-only');
  assert.equal(pageIndexOf('150808766_p12.jpg'), 12);
  assert.equal(pageIndexOf('x.png'), -1);
});

test('work: 200 は ok (頁ごとに表へ、二度目は網に出ない)、404 は none (期限つき)、新しい投稿の 404 は短い期限', async () => {
  let now = 1_000_000;
  const { transport, calls } = fake((url) => (/work\/500$/.test(url) ? workJson(500, [img('500_p0.png', naiJson), img('500_p2.png', naiJson)]) : null));
  const store = new AiMetaStore({ file: ':memory:', now: () => now });
  const client = new AitagClient({ store, transport, now: () => now });
  const ok = await client.work('px:500');
  assert.equal(ok.status, 'ok');
  assert.equal(ok.images[0].meta.settings.seed, 42);
  assert.deepEqual(store.pages('500').filter((r) => r.page >= 0).map((r) => [r.page, r.status, r.source]), [[0, 'ok', 'aitag'], [2, 'ok', 'aitag']]);
  assert.equal((await client.work('500')).status, 'ok');
  assert.equal(calls.length, 1, '二度目は表から');
  assert.equal((await client.work('501')).status, 'none');
  assert.equal((await client.work('501')).status, 'none');
  assert.equal(calls.length, 2, '404 も控える');
  now += 4 * 24 * 60 * 60 * 1000;
  await client.work('501');
  assert.equal(calls.length, 3, '3 日を過ぎたら訊き直す');
  assert.equal((await client.work('502', { fresh: true })).status, 'none');
  now += 25 * 60 * 1000;
  await client.work('502', { fresh: true });
  assert.equal(calls.length, 5, '新しい投稿は 20 分で訊き直す');
});

test('失敗が続くと数分は黙る (panel は予備へ落ちる)。切ってあれば off。同時の頼みは一つに', async () => {
  let now = 0;
  let fail = true;
  const { transport, calls } = fake(() => (fail ? Object.assign(new Error('boom'), { status: 500 }) : workJson(7, [img('7_p0.png', naiJson)])));
  const client = new AitagClient({ transport, now: () => now });
  await assert.rejects(client.work('7'));
  await assert.rejects(client.work('7'));
  await assert.rejects(client.work('7'), /休止中/);
  assert.equal(calls.length, 2, '二度失敗したら黙る');
  fail = false;
  now += 4 * 60 * 1000;
  const [a, b] = await Promise.all([client.work('7'), client.work('7')]);
  assert.equal(a.status, 'ok');
  assert.equal(b, a);
  assert.equal(calls.length, 3);
  const off = new AitagClient({ transport, enabled: () => false });
  assert.equal((await off.work('7')).status, 'off');
});

test('byUser: 作者の索引済みの投稿を一括で表へ (中身は無い ok)。marks: 表を優先して yes / no / unknown。原寸で決まった物には訊かない', async () => {
  const { transport, calls } = fake((url) => {
    if (/ai_works_search/.test(url)) return { page: 1, page_size: 60, total: 2, items: [{ id: 11, userId: 77 }, { id: 12, userId: 77 }, { id: 99, userId: 5 }] };
    if (/work\/13$/.test(url)) return workJson(13, [img('13_p0.png', naiJson)]);
    if (/work\/11$/.test(url)) return workJson(11, [img('11_p0.png', naiJson)]);
    return null;
  });
  const store = new AiMetaStore({ file: ':memory:' });
  const client = new AitagClient({ store, transport });
  assert.deepEqual(await client.byUser('user:77'), ['11', '12']);
  store.put({ pid: '16', page: 0, status: 'none', source: 'original' });
  const marks = await client.marks(['px:11', 'px:12', 'px:13', { id: 'px:14', fresh: true }, 'px:16', 'px:bad']);
  assert.deepEqual(marks, { 'px:11': 'yes', 'px:12': 'yes', 'px:13': 'yes', 'px:14': 'no', 'px:16': 'no' });
  assert.equal(calls.filter((u) => /work\//.test(u)).length, 2, '表にある 11・12・16 は訊かない');
  // 一括で載っていると分かっただけの 11 は、板を開く時に中身を取りに行く
  const w = await client.work('11');
  assert.equal(w.status, 'ok');
  assert.equal(w.images[0].meta.settings.seed, 42);
  assert.equal(store.metaOf('11', 0).meta.format, 'NovelAI');
  const off = new AitagClient({ transport, enabled: () => false });
  assert.deepEqual(await off.marks(['px:11']), { 'px:11': 'unknown' });
});

test('marks: 同時に訊くのは 2 本まで (http の順番待ちの期限に当てない)。黙っている間は残りを unknown に', async () => {
  let inflight = 0; let peak = 0;
  const transport = {
    async get(url) {
      inflight += 1; peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 15));
      inflight -= 1;
      const id = (url.match(/work\/(\d+)/) || [])[1];
      return { status: 200, headers: {}, buffer: Buffer.from(JSON.stringify(workJson(id, [img(id + '_p0.png', naiJson)]))) };
    },
  };
  const client = new AitagClient({ store: new AiMetaStore({ file: ':memory:' }), transport });
  const ids = Array.from({ length: 12 }, (_, i) => 'px:' + (700 + i));
  const marks = await client.marks(ids);
  assert.equal(Object.values(marks).filter((v) => v === 'yes').length, 12);
  assert.equal(peak, 2, '同時 2 本');
  const paused = new AitagClient({ store: new AiMetaStore({ file: ':memory:' }), transport, now: () => 0 });
  paused.blockedUntil = 10_000;
  assert.deepEqual(await paused.marks(['px:1']), { 'px:1': 'unknown' });
});
