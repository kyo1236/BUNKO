'use strict';

// local-archive.js の変更前実装を比較対象としてここに保存する。
// 旧版: 比較ごとに localeCompare の options を渡し、同期 readdir/readFile を使う。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');
const archive = require('../src/lib/local-archive');

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif|jxl|bmp)$/i;
function baselineIsImageName(name) {
  const base = path.basename(name);
  return !(base.startsWith('.') || /thumbnail/i.test(base) || base === 'info.json') && IMAGE_EXT.test(base);
}
function baselineListDirImages(dir) {
  return fs.readdirSync(dir)
    .filter((name) => baselineIsImageName(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
function baselineReadPage(dir, index) {
  const files = baselineListDirImages(dir);
  const name = files[index];
  return name ? fs.readFileSync(path.join(dir, name)) : null;
}

async function measure(label, iterations, fn) {
  const started = performance.now();
  for (let i = 0; i < iterations; i += 1) await fn(i);
  const elapsed = performance.now() - started;
  return { label, elapsed, ops: iterations / (elapsed / 1000) };
}

async function timerDelay(fn) {
  const started = performance.now();
  let firedAt;
  const timer = new Promise((resolve) => setTimeout(() => {
    firedAt = performance.now();
    resolve();
  }, 0));
  await fn();
  await timer;
  return firedAt - started;
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bunko-bench-archive-'));
  try {
    const body = Buffer.alloc(4096, 7);
    for (let i = 0; i < 2000; i += 1) fs.writeFileSync(path.join(root, `page-${i}.jpg`), body);
    const iterations = 30;
    const before = await measure('before', iterations, (i) => baselineReadPage(root, i % 2000));
    const after = await measure('after', iterations, (i) => archive.readPage(root, i % 2000));
    const speedup = before.elapsed / after.elapsed;
    const beforeTimer = await timerDelay(async () => {
      for (let i = 0; i < 10; i += 1) baselineReadPage(root, i);
    });
    const afterTimer = await timerDelay(async () => {
      for (let i = 0; i < 10; i += 1) await archive.readPage(root, i);
    });
    console.log(`directory list+sort+read (${iterations} runs, 2000 files)`);
    console.log(`before ${before.elapsed.toFixed(1)} ms (${before.ops.toFixed(1)} ops/s)`);
    console.log(`after  ${after.elapsed.toFixed(1)} ms (${after.ops.toFixed(1)} ops/s)`);
    console.log(`speedup ${speedup.toFixed(2)}x`);
    console.log(`0ms timer delay while reading 10 pages: before ${beforeTimer.toFixed(1)} ms, after ${afterTimer.toFixed(1)} ms`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
