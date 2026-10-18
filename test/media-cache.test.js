'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cache = require('../src/lib/media-cache');

const roots = [];
function setup(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `bunko-media-${tag}-`));
  roots.push(root);
  cache.init(root);
  return root;
}
function imagePath(root, key) {
  const hash = crypto.createHash('sha1').update(String(key)).digest('hex');
  return path.join(root, 'img', hash.slice(0, 2), hash);
}
function seedImage(root, key, body, meta = {}) {
  const file = imagePath(root, key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  fs.writeFileSync(`${file}.json`, JSON.stringify(meta));
  return file;
}

test.after(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ }
  }
});

test('画像singleflightは一購読者のcancelで残る読者の取得を止めない', async () => {
  setup('cancel-subscriber');
  let finish;
  let underlyingAborted = 0;
  const gate = new Promise((resolve) => { finish = resolve; });
  const loader = async ({ signal }) => {
    signal.addEventListener('abort', () => { underlyingAborted += 1; }, { once: true });
    await gate;
    return { bytes: Buffer.from('shared'), name: 'shared.jpg' };
  };
  const one = new AbortController();
  const two = new AbortController();
  const first = cache.getImage('shared-cancel', loader, { signal: one.signal });
  const second = cache.getImage('shared-cancel', loader, { signal: two.signal });
  one.abort(new Error('leave one reader'));
  await assert.rejects(first, /leave one reader/);
  assert.strictEqual(underlyingAborted, 0);
  finish();
  assert.strictEqual((await second).bytes.toString(), 'shared');
  assert.strictEqual(underlyingAborted, 0);
});

test('全購読者がcancelしたflightへ新しい読者を参加させず、古いfinallyも新flightを消さない', async () => {
  setup('replace-aborted-flight');
  const gates = [];
  const started = [];
  let calls = 0;
  const loader = ({ signal }) => new Promise((resolve) => {
    calls += 1;
    const current = { signal, resolve };
    gates.push(current);
    started.shift()?.();
  });
  const waitStart = () => new Promise((resolve) => started.push(resolve));

  const firstStarted = waitStart();
  const oldController = new AbortController();
  const old = cache.getImage('replace-aborted', loader, { memoryOk: false, signal: oldController.signal });
  await firstStarted;
  oldController.abort(new Error('old cancelled'));
  await assert.rejects(old, /old cancelled/);

  const secondStarted = waitStart();
  const fresh = cache.getImage('replace-aborted', loader, { memoryOk: false });
  await secondStarted;
  assert.strictEqual(calls, 2);
  gates[0].resolve({ bytes: Buffer.from('old'), name: 'old.jpg' });
  await new Promise((resolve) => setImmediate(resolve));

  const joined = cache.getImage('replace-aborted', () => {
    throw new Error('古いfinallyが新flightを消した');
  }, { memoryOk: false });
  gates[1].resolve({ bytes: Buffer.from('fresh'), name: 'fresh.jpg' });
  assert.strictEqual((await fresh).bytes.toString(), 'fresh');
  assert.strictEqual((await joined).bytes.toString(), 'fresh');
  assert.strictEqual(calls, 2);
});

test('disk hit は loader を呼ばず、memoryOk=true のときだけメモリへ置く', async () => {
  const root = setup('memory-ok');
  const yesKey = 'memory-yes';
  const noKey = 'memory-no';
  const yesFile = seedImage(root, yesKey, 'disk-yes', { type: 'image/jpeg', name: 'yes.jpg' });
  const noFile = seedImage(root, noKey, 'disk-no', { type: 'image/png', name: 'no.png' });
  let loads = 0;
  const loader = async () => { loads += 1; return { bytes: Buffer.from('loaded') }; };

  assert.strictEqual((await cache.getImage(yesKey, loader)).bytes.toString(), 'disk-yes');
  fs.unlinkSync(yesFile); fs.unlinkSync(`${yesFile}.json`);
  assert.strictEqual((await cache.getImage(yesKey, loader)).bytes.toString(), 'disk-yes');

  assert.strictEqual((await cache.getImage(noKey, loader, { memoryOk: false })).bytes.toString(), 'disk-no');
  fs.unlinkSync(noFile); fs.unlinkSync(`${noFile}.json`);
  assert.strictEqual((await cache.getImage(noKey, loader, { memoryOk: false })).bytes.toString(), 'loaded');
  assert.strictEqual(loads, 1);
});

test('同じ key の大量同時 disk hit は一度の読込を共有する', async () => {
  const root = setup('inflight-disk');
  const key = 'parallel-disk';
  seedImage(root, key, 'parallel', { type: 'image/webp', name: 'p.webp' });
  const original = fs.promises.readFile;
  let reads = 0;
  fs.promises.readFile = async (...args) => {
    if (String(args[0]).startsWith(imagePath(root, key))) reads += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return original.apply(fs.promises, args);
  };
  try {
    const pages = await Promise.all(Array.from({ length: 40 }, () => cache.getImage(
      key,
      () => { throw new Error('loader should not run'); },
      { memoryOk: false },
    )));
    assert.ok(pages.every((page) => page.bytes.toString() === 'parallel'));
    assert.strictEqual(reads, 2, '本体とmetaを一度ずつだけ読む');
  } finally {
    fs.promises.readFile = original;
  }
});

test('inflight を共有しても各呼出の memoryOk を尊重する', async () => {
  const root = setup('mixed-memory-ok');
  const key = 'mixed-memory-option';
  const file = seedImage(root, key, 'shared', { name: 'shared.jpg' });
  const [withoutMemory, withMemory] = await Promise.all([
    cache.getImage(key, null, { memoryOk: false }),
    cache.getImage(key, null, { memoryOk: true }),
  ]);
  assert.strictEqual(withoutMemory.bytes.toString(), 'shared');
  assert.strictEqual(withMemory.bytes.toString(), 'shared');
  fs.unlinkSync(file); fs.unlinkSync(`${file}.json`);
  assert.strictEqual((await cache.getImage(key, () => {
    throw new Error('memoryOk=true の呼出で保存されていない');
  })).bytes.toString(), 'shared');
});

test('disk が壊れていれば loader へ進み、loader 失敗は次回再試行できる', async () => {
  const root = setup('failure');
  const corruptKey = 'corrupt-disk';
  seedImage(root, corruptKey, 'old', { name: 'broken' });
  fs.writeFileSync(`${imagePath(root, corruptKey)}.json`, '{bad json');
  const recovered = await cache.getImage(corruptKey, async () => ({
    bytes: Buffer.from('fresh'), type: 'image/jpeg', name: 'fresh.jpg',
  }), { memoryOk: false });
  assert.strictEqual(recovered.bytes.toString(), 'fresh');

  const retryKey = 'retry-loader';
  let attempts = 0;
  const loader = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('temporary');
    return { bytes: Buffer.from('retry-ok'), type: 'image/png', name: 'retry.png' };
  };
  await assert.rejects(() => cache.getImage(retryKey, loader, { memoryOk: false }), /temporary/);
  assert.strictEqual((await cache.getImage(retryKey, loader, { memoryOk: false })).bytes.toString(), 'retry-ok');
  assert.strictEqual(attempts, 2);
});

test('root 変更後は memoryOk=false なら新しい置き場を読む', async () => {
  const first = setup('root-a');
  const key = 'same-key-new-root';
  seedImage(first, key, 'A', { name: 'a.jpg' });
  assert.strictEqual((await cache.getImage(key, null, { memoryOk: false })).bytes.toString(), 'A');
  const second = setup('root-b');
  seedImage(second, key, 'B', { name: 'b.jpg' });
  assert.strictEqual((await cache.getImage(key, null, { memoryOk: false })).bytes.toString(), 'B');
});

test('メモリ上限を越えると古い小画像から破棄する', async () => {
  setup('memory-limit');
  const originalMkdir = fs.promises.mkdir;
  const originalWarn = console.warn;
  fs.promises.mkdir = async () => { throw new Error('test: disk disabled'); };
  console.warn = () => {};
  try {
    const bytes = Buffer.alloc(700 * 1024, 1);
    for (let i = 0; i < 120; i += 1) {
      await cache.getImage(`limit-${i}`, async () => ({ bytes, name: `${i}.jpg` }));
    }
    let oldestLoads = 0;
    await cache.getImage('limit-0', async () => {
      oldestLoads += 1;
      return { bytes, name: 'again.jpg' };
    });
    let newestLoads = 0;
    await cache.getImage('limit-119', async () => {
      newestLoads += 1;
      return { bytes, name: 'unexpected.jpg' };
    });
    assert.strictEqual(oldestLoads, 1);
    assert.strictEqual(newestLoads, 0);
  } finally {
    fs.promises.mkdir = originalMkdir;
    console.warn = originalWarn;
  }
});
