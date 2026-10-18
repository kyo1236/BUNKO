'use strict';

// pixiv の作法 (src/lib/pixiv/manners.js)。数字は PPD の既定に合わせる約束なので、
// ここでは**仕組み**を釘で留める: 車線の同時数・件数を超えてからの間隔・429 の冷却・一括の休み。
// 時間は本物の時計で短く回す (数十 ms)。

const test = require('node:test');
const assert = require('node:assert/strict');

const { createManners, isRateLimited, DEFAULTS } = require('../src/lib/pixiv/manners');

const quietTrace = { flag() {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('既定の数字は PPD の既定 (利用者指定)', () => {
  assert.equal(DEFAULTS.apiConcurrency, 1);
  assert.equal(DEFAULTS.apiSlowAfter, 100);
  assert.equal(DEFAULTS.apiGapMs, 1600);
  assert.equal(DEFAULTS.imageConcurrency, 6);
  assert.equal(DEFAULTS.imageSlowAfter, 150);
  assert.equal(DEFAULTS.imageGapMs, 1000);
  assert.equal(DEFAULTS.cooldownMs, 200 * 1000);
  assert.equal(DEFAULTS.bulkBatch, 300);
  assert.equal(DEFAULTS.bulkRestMs, 600 * 1000);
});

test('API 車線は同時 1: 二つ頼んでも重ならない', async () => {
  const manners = createManners({ trace: quietTrace, config: { apiSlowAfter: 1000 } });
  let running = 0;
  let peak = 0;
  const job = async () => {
    running += 1;
    peak = Math.max(peak, running);
    await sleep(15);
    running -= 1;
    return 'ok';
  };
  const out = await Promise.all([manners.api(job), manners.api(job), manners.api(job)]);
  assert.deepEqual(out, ['ok', 'ok', 'ok']);
  assert.equal(peak, 1);
});

test('画像車線は同時 6 まで重なる', async () => {
  const manners = createManners({ trace: quietTrace, config: { imageSlowAfter: 1000 } });
  let running = 0;
  let peak = 0;
  const job = async () => {
    running += 1;
    peak = Math.max(peak, running);
    await sleep(20);
    running -= 1;
  };
  await Promise.all(Array.from({ length: 8 }, () => manners.image(job)));
  assert.equal(peak, 6);
});

test('件数を超えてからは間隔を空ける (超えるまでは詰めて出す)', async () => {
  const manners = createManners({ trace: quietTrace, config: { apiSlowAfter: 2, apiGapMs: 40 } });
  const starts = [];
  const job = async () => { starts.push(Date.now()); };
  for (let i = 0; i < 4; i += 1) await manners.api(job);
  // 1 件目と 2 件目は詰めて出る。3 件目からは 40ms 空く (直近が 2 件に達した後)
  assert.ok(starts[1] - starts[0] < 30, `最初の二つは詰める (${starts[1] - starts[0]}ms)`);
  assert.ok(starts[2] - starts[1] >= 35, `三つ目は空ける (${starts[2] - starts[1]}ms)`);
  assert.ok(starts[3] - starts[2] >= 35, `四つ目も空ける (${starts[3] - starts[2]}ms)`);
  assert.equal(manners.state().api.slowed, true);
});

test('429 を受けたら両車線を止め、止まっている間は待たせず 429 で返す (枠を抱えない)', async () => {
  const flags = [];
  const manners = createManners({
    trace: { flag: (name, on, ttl) => flags.push([name, on, ttl]) },
    config: { cooldownMs: 60, cooldownRepeatMs: 120, cooldownRepeatWindowMs: 10000 },
  });
  const limited = Object.assign(new Error('HTTP 429'), { status: 429 });
  await assert.rejects(manners.api(async () => { throw limited; }), /429/);
  assert.ok(manners.state().pausedForMs > 0, '止まっている');
  assert.deepEqual(flags[0], ['pixiv-cooldown', true, 60]);
  // 止まっている間の新しい頼みは、画像の車線でも待たずに 429 の顔で返る
  let ran = false;
  await assert.rejects(
    manners.image(async () => { ran = true; }),
    (e) => e.status === 429 && e.rateLimited === true && e.retryAfterMs > 0 && e.retryAfterMs <= 60,
  );
  assert.equal(ran, false);
  // 明けたら通る
  await sleep(70);
  await manners.image(async () => { ran = true; });
  assert.equal(ran, true);
  // 近い時期の二度目は長く止める
  await assert.rejects(manners.api(async () => { throw limited; }), /429/);
  assert.ok(manners.state().pausedForMs > 60, `二度目は長い (${manners.state().pausedForMs}ms)`);
  assert.equal(manners.state().pauses, 2);
});

test('冷却に入った瞬間、並んでいた待ち手も 429 で返す', async () => {
  const manners = createManners({ trace: quietTrace, config: { cooldownMs: 60, apiSlowAfter: 1000 } });
  const limited = Object.assign(new Error('HTTP 429'), { status: 429 });
  const first = manners.api(async () => { await sleep(20); throw limited; });
  const second = manners.api(async () => 'never');
  await assert.rejects(first, /429/);
  await assert.rejects(second, (e) => e.status === 429 && e.retryAfterMs > 0);
  assert.equal(manners.state().api.waiting, 0);
});

test('403 の body に Rate Limit と書いてあれば 429 と同じ', () => {
  assert.equal(isRateLimited(Object.assign(new Error('HTTP 403'), { status: 403, body: '{"error":{"message":"Rate Limit"}}' })), true);
  assert.equal(isRateLimited(Object.assign(new Error('HTTP 403'), { status: 403, body: '{"error":{"message":"Nope"}}' })), false);
  assert.equal(isRateLimited(Object.assign(new Error('deadline host (429 冷却中)'), { status: 429 })), true);
  assert.equal(isRateLimited(new Error('boom')), false);
  assert.equal(isRateLimited(null), false);
});

test('一括の走りは batch 件ごとに休み、止めれば次の tick で投げる', async () => {
  const manners = createManners({ trace: quietTrace, config: { bulkBatch: 2, bulkRestMs: 40 } });
  const run = manners.createRun('test');
  const t0 = Date.now();
  await run.tick();
  await run.tick();               // 2 件目で休む
  assert.ok(Date.now() - t0 >= 35, `batch で休む (${Date.now() - t0}ms)`);
  assert.equal(run.count, 2);
  run.stop();
  await assert.rejects(run.tick(), /stopped/);
  assert.equal(run.stopped, true);
});

test('待っている最中に取り下げられたら、車線から外れて投げる', async () => {
  const manners = createManners({ trace: quietTrace, config: { apiSlowAfter: 1000 } });
  const controller = new AbortController();
  const first = manners.api(() => sleep(40));
  const second = manners.api(async () => 'late', { signal: controller.signal });
  controller.abort(new Error('user-cancel'));
  await assert.rejects(second, /user-cancel/);
  await first;
  assert.equal(manners.state().api.waiting, 0);
});

test('眺める車線 (表紙・読み手の頁) は件数を数えず間隔を空けない。冷却だけ共にする', async () => {
  assert.equal(DEFAULTS.viewConcurrency, 6);
  assert.equal(DEFAULTS.viewGapMs, 0);
  const manners = createManners({ trace: quietTrace, config: { imageSlowAfter: 2, imageGapMs: 40, cooldownMs: 50 } });
  const starts = [];
  const job = async () => { starts.push(Date.now()); };
  for (let i = 0; i < 6; i += 1) await manners.view(job);
  assert.ok(starts[5] - starts[0] < 60, `六つとも詰めて出る (${starts[5] - starts[0]}ms)`);
  assert.equal(manners.state().view.slowed, false);
  assert.equal(manners.state().image.recent, 0, '画像車線 (落とす) の数には入らない');
  await assert.rejects(manners.image(async () => { throw Object.assign(new Error('HTTP 429'), { status: 429 }); }));
  await assert.rejects(manners.view(async () => 'x'), (e) => e.status === 429, '429 は眺める車線も止める');
});

test('順番待ちは priority の小さい方から (読み手の頁 0 は表紙 10 より先に出る)', async () => {
  const manners = createManners({ trace: quietTrace, config: { viewConcurrency: 1, viewSlowAfter: 1000 } });
  const order = [];
  const first = manners.view(() => sleep(30), { priority: 10 });
  const covers = [1, 2, 3].map((n) => manners.view(async () => { order.push(`cover${n}`); }, { priority: 10 }));
  const page = manners.view(async () => { order.push('page'); }, { priority: 0 });
  await Promise.all([first, ...covers, page]);
  assert.deepEqual(order, ['page', 'cover1', 'cover2', 'cover3'], '急ぎが先、同点は並んだ順');
});
