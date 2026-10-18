'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getEventListeners } = require('events');
const {
  get, download, SiteScheduler, _siteScheduler,
} = require('../src/lib/http');

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('http: 応答途中の切断を pending にせず拒否する', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-length': '20' });
    res.flushHeaders();
    res.write('short');
    setTimeout(() => res.destroy(), 20);
  }, async (base) => {
    await assert.rejects(get(base), /aborted|premature close|socket hang up/);
  });
});

test('http: timeout と AbortSignal が要求を終了させる', async () => {
  await withServer(() => {}, async (base) => {
    await assert.rejects(get(base, {}, { timeout: 20 }), /timeout|deadline/);
    const controller = new AbortController();
    const pending = get(base, {}, { signal: controller.signal, timeout: 1000 });
    controller.abort(new Error('利用者が中断'));
    await assert.rejects(pending, /利用者が中断/);
  });
});

test('http: データが届き続けても総期限で終了し、listener を残さない', async () => {
  await withServer((req, res) => {
    res.writeHead(200);
    const timer = setInterval(() => res.write('.'), 5);
    res.on('close', () => clearInterval(timer));
  }, async (base) => {
    const controller = new AbortController();
    const started = Date.now();
    await assert.rejects(
      get(base, {}, { timeout: 35, signal: controller.signal }),
      /deadline|timeout/,
    );
    assert.ok(Date.now() - started < 250);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });
});

test('http: redirect は総期限の残りだけを引き継ぐ', async () => {
  await withServer((req, res) => {
    if (req.url === '/start') {
      setTimeout(() => {
        res.writeHead(302, { location: '/drip' });
        res.end();
      }, 25);
      return;
    }
    res.writeHead(200);
    const timer = setInterval(() => res.write('.'), 5);
    res.on('close', () => clearInterval(timer));
  }, async (base) => {
    const started = Date.now();
    await assert.rejects(get(`${base}/start`, {}, { timeout: 55 }), /deadline|timeout/);
    assert.ok(Date.now() - started < 150);
  });
});

test('http: redirect 後も options を保ち、status と retry-after を返す', async () => {
  await withServer((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, { location: '/limited' });
      res.end();
      return;
    }
    res.writeHead(429, { 'retry-after': '2' });
    res.end('later');
  }, async (base) => {
    await assert.rejects(get(`${base}/start`, {}, { timeout: 200 }), (error) => {
      assert.equal(error.status, 429);
      assert.equal(error.retryAfter, '2');
      assert.equal(error.retryAfterMs, 2000);
      assert.equal(error.body.toString(), 'later');
      return true;
    });
  });
});

test('download: 応答途中の切断で成功扱いしない', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bookshelf-http-'));
  const dest = path.join(dir, 'partial.bin');
  try {
    await withServer((req, res) => {
      res.writeHead(200, { 'content-length': '20' });
      res.flushHeaders();
      res.write('short');
      setTimeout(() => res.destroy(), 20);
    }, async (base) => {
      await assert.rejects(download(base, dest, { timeout: 200 }), /aborted|premature close|socket hang up/);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scheduler: host ごとに上限を分け、cooldown 中は枠を占有しない', async () => {
  const scheduler = new SiteScheduler(1);
  await scheduler.acquire('a.test');
  scheduler.cooldown('a.test', 25);
  scheduler.release('a.test');

  let enteredA = false;
  const waitingA = scheduler.acquire('a.test').then(() => { enteredA = true; });
  await scheduler.acquire('b.test');
  assert.equal(enteredA, false);
  assert.equal(scheduler.state('a.test').active, 0);
  scheduler.release('b.test');
  await waitingA;
  assert.equal(enteredA, true);
  scheduler.release('a.test');
});

test('scheduler: 待機中の AbortSignal と総期限でキューから除去する', async () => {
  const scheduler = new SiteScheduler(1);
  await scheduler.acquire('busy.test');
  const controller = new AbortController();
  const aborted = scheduler.acquire('busy.test', { signal: controller.signal });
  controller.abort(new Error('待機を中断'));
  await assert.rejects(aborted, /待機を中断/);
  assert.equal(scheduler.state('busy.test').waiters.length, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);

  const expired = scheduler.acquire('busy.test', { deadline: Date.now() + 15 });
  await assert.rejects(expired, /deadline busy\.test/);
  assert.equal(scheduler.state('busy.test').waiters.length, 0);
  scheduler.release('busy.test');
});

test('http: 同じ host の redirect でも枠を返してから入り直す', async () => {
  const oldLimit = _siteScheduler.limit;
  _siteScheduler.limit = 1;
  try {
    await withServer((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: '/done' });
        res.end();
      } else {
        res.end('ok');
      }
    }, async (base) => {
      const response = await get(`${base}/start`, {}, { timeout: 200 });
      assert.equal(response.text(), 'ok');
    });
  } finally {
    _siteScheduler.limit = oldLimit;
  }
});

test('download: timeout は無通信期限で、継続転送の総時間を切らない', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bookshelf-http-drip-'));
  const dest = path.join(dir, 'complete.bin');
  try {
    // 一粒 20ms おき × 12 = 総計 240ms。無通信の期限は 120ms。
    // 「総時間の上限」なら落ち、「無通信の期限」なら通る、という形を保ったまま
    // 粒の間隔 (20ms) と期限 (120ms) の差を 6 倍取ってある。
    // 以前は 8ms / 25ms で、走っている機体が一瞬詰まるだけで落ちていた
    await withServer((req, res) => {
      let sent = 0;
      const timer = setInterval(() => {
        res.write('.');
        sent += 1;
        if (sent === 12) {
          clearInterval(timer);
          res.end();
        }
      }, 20);
    }, async (base) => {
      const result = await download(base, dest, { timeout: 120 });
      assert.equal(result.bytes, 12);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scheduler: 現在頁を検索・先読みより先に通し、待機時間で背景処理も昇格する', async () => {
  const scheduler = new SiteScheduler(1);
  await scheduler.acquire('priority.test');
  const order = [];
  const background = scheduler.acquire('priority.test', { priority: 30 }).then(() => {
    order.push('background'); scheduler.release('priority.test');
  });
  const search = scheduler.acquire('priority.test', { priority: 10 }).then(() => {
    order.push('search'); scheduler.release('priority.test');
  });
  const current = scheduler.acquire('priority.test', { priority: 0 }).then(() => {
    order.push('current'); scheduler.release('priority.test');
  });
  scheduler.release('priority.test');
  await Promise.all([background, search, current]);
  assert.deepEqual(order, ['current', 'search', 'background']);

  await scheduler.acquire('aging.test');
  const state = scheduler.state('aging.test');
  const oldBackground = scheduler.acquire('aging.test', { priority: 30 }).then(() => {
    order.push('aged'); scheduler.release('aging.test');
  });
  state.waiters[0].queuedAt -= 31_000;
  const freshCurrent = scheduler.acquire('aging.test', { priority: 0 }).then(() => {
    order.push('fresh'); scheduler.release('aging.test');
  });
  scheduler.release('aging.test');
  await Promise.all([oldBackground, freshCurrent]);
  assert.deepEqual(order.slice(-2), ['aged', 'fresh']);
});

test('scheduler: 宛先ごとの作法 (同時の本数と出す間隔) を守り、ほかの宛先は既定のまま', async () => {
  const scheduler = new SiteScheduler(16);
  scheduler.configure('polite.test', { limit: 2, interval: 40 });
  const starts = [];
  const began = Date.now();
  const jobs = Array.from({ length: 4 }, () => scheduler.acquire('polite.test').then(() => {
    starts.push(Date.now() - began);
    return new Promise((resolve) => setTimeout(() => { scheduler.release('polite.test'); resolve(); }, 5));
  }));
  // 作法を差していない宛先は、間を空けずに既定の本数まで通る
  await Promise.all([scheduler.acquire('free.test'), scheduler.acquire('free.test'), scheduler.acquire('free.test')]);
  assert.equal(scheduler.state('free.test').active, 3);
  await Promise.all(jobs);
  assert.equal(starts.length, 4);
  for (let i = 1; i < starts.length; i += 1) {
    assert.ok(starts[i] - starts[i - 1] >= 35, `出す間隔を空ける (${starts.join(', ')} ms)`);
  }
  assert.ok(scheduler.state('polite.test').active <= 2);

  // 同時の本数: 出したまま返さない要求が 2 本あれば、3 本目は間隔が明けても待つ
  scheduler.configure('busy-polite.test', { limit: 2, interval: 1 });
  await scheduler.acquire('busy-polite.test');
  await new Promise((resolve) => setTimeout(resolve, 3));
  await scheduler.acquire('busy-polite.test');
  let third = false;
  const waiting = scheduler.acquire('busy-polite.test').then(() => { third = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(third, false, '同時 2 本の枠が埋まっている間は通さない');
  scheduler.release('busy-polite.test');
  await waiting;
  assert.equal(third, true);
});
