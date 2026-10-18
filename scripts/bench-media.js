'use strict';

// 変更前の同期 disk 読込を baseline として保存し、同じ合成キャッシュで比較する。
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');
const cache = require('../src/lib/media-cache');

function fileFor(root, key) {
  const hash = crypto.createHash('sha1').update(String(key)).digest('hex');
  return path.join(root, 'img', hash.slice(0, 2), hash);
}
function seed(root, key, bytes) {
  const file = fileFor(root, key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  fs.writeFileSync(`${file}.json`, JSON.stringify({ type: 'image/jpeg', name: 'page.jpg' }));
  return file;
}
function baselineRead(file) {
  try {
    const meta = JSON.parse(fs.readFileSync(`${file}.json`, 'utf8'));
    const bytes = fs.readFileSync(file);
    const now = new Date();
    fs.promises.utimes(file, now, now).catch(() => {});
    return { bytes, type: meta.type, name: meta.name };
  } catch { return null; }
}
async function timed(fn) {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}
async function timerDelay(fn) {
  const start = performance.now();
  let fired;
  const timer = new Promise((resolve) => setTimeout(() => { fired = performance.now(); resolve(); }, 0));
  await fn();
  await timer;
  return fired - start;
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bunko-bench-media-'));
  cache.init(root);
  try {
    const bytes = Buffer.alloc(2 * 1024 * 1024, 3);
    const coldKey = 'cold';
    seed(root, coldKey, bytes);
    const cold = await timed(() => cache.getImage(coldKey, null, { memoryOk: false }));

    const runs = 30;
    const baseKey = 'baseline-warm';
    const baseFile = seed(root, baseKey, bytes);
    const before = await timed(async () => {
      for (let i = 0; i < runs; i += 1) baselineRead(baseFile);
    });
    const afterKey = 'after-warm';
    seed(root, afterKey, bytes);
    const after = await timed(async () => {
      for (let i = 0; i < runs; i += 1) await cache.getImage(afterKey, null, { memoryOk: false });
    });

    const burstKey = 'burst';
    const burstFile = seed(root, burstKey, bytes);
    const burstBefore = await timed(() => Promise.all(Array.from({ length: 50 }, async () => baselineRead(burstFile))));
    const burstAfterKey = 'burst-after';
    seed(root, burstAfterKey, bytes);
    const burstAfter = await timed(() => Promise.all(Array.from({ length: 50 }, () => cache.getImage(
      burstAfterKey, null, { memoryOk: false },
    ))));

    const timerBefore = await timerDelay(async () => {
      for (let i = 0; i < 20; i += 1) baselineRead(baseFile);
    });
    const timerAfter = await timerDelay(async () => {
      for (let i = 0; i < 20; i += 1) await cache.getImage(afterKey, null, { memoryOk: false });
    });
    console.log(`first disk read (OS cache uncontrolled): ${cold.toFixed(1)} ms`);
    console.log(`disk warm ${runs} sequential: before ${before.toFixed(1)} ms, after ${after.toFixed(1)} ms`);
    console.log(`same-key burst 50: before ${burstBefore.toFixed(1)} ms, after ${burstAfter.toFixed(1)} ms`);
    console.log(`0ms timer delay during 20 reads: before ${timerBefore.toFixed(1)} ms, after ${timerAfter.toFixed(1)} ms`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
