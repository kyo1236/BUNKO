'use strict';

// Eagle 走査の索引 (eagle-index): mtime.json の差分読みと、全件読みへ戻る条件を固定する。
// 走査は台帳 (catalog) と pawchive (paw-library) の両方がここを通る

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  EagleIndex, CACHE_VERSION, FULL_SCAN_INTERVAL, shapeMeta,
} = require('../src/lib/eagle-index.js');

function makeLibrary(items) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bunko-eagle-index-'));
  fs.mkdirSync(path.join(root, 'images'));
  const mtimes = {};
  for (const [id, meta] of Object.entries(items)) {
    const dir = path.join(root, 'images', `${id}.info`);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(meta));
    mtimes[id] = meta.modificationTime || 1;
  }
  fs.writeFileSync(path.join(root, 'mtime.json'), JSON.stringify(mtimes));
  return root;
}

function countStats(fn) {
  const original = fs.promises.stat;
  let calls = 0;
  fs.promises.stat = async (...args) => {
    calls += 1;
    return original.apply(fs.promises, args);
  };
  return fn().finally(() => {
    fs.promises.stat = original;
  }).then((result) => ({ result, calls }));
}

test('初回は全件を読み、二度目は mtime.json が同じなら一件も stat しない', async () => {
  const root = makeLibrary({
    AAA: { name: 'one', modificationTime: 100, folders: ['F1'], star: 3 },
    BBB: { name: 'two', modificationTime: 200, folders: [] },
  });
  const cachePath = path.join(root, 'scan-cache.json');
  const index = new EagleIndex({ libraryRoot: root, cachePath });
  const first = await countStats(() => index.refresh());
  assert.strictEqual(first.result.mode, 'full');
  assert.strictEqual(first.result.reread, 2);
  assert.strictEqual(first.result.entries.get('AAA.info').meta.name, 'one');
  assert.strictEqual(first.result.entries.get('AAA.info').mj, 100);

  // 控えは書かれ、版 3 で読み直せる
  await new Promise((resolve) => setTimeout(resolve, 50));
  const saved = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  assert.strictEqual(saved.version, CACHE_VERSION);
  assert.ok(saved.items['BBB.info']);

  const again = new EagleIndex({ libraryRoot: root, cachePath });
  const second = await countStats(() => again.refresh());
  assert.strictEqual(second.result.mode, 'diff');
  assert.strictEqual(second.calls, 0, `stat が ${second.calls} 回呼ばれた`);
  assert.strictEqual(second.result.reread, 0);
  assert.strictEqual(second.result.changed, false);
  assert.strictEqual(second.result.entries.size, 2);
});

test('mtime.json の値が動いたアイテムだけ metadata.json を読み直し、消えたアイテムは落ちる', async () => {
  const root = makeLibrary({
    AAA: { name: 'one', modificationTime: 100 },
    BBB: { name: 'two', modificationTime: 200 },
  });
  const cachePath = path.join(root, 'scan-cache.json');
  const index = new EagleIndex({ libraryRoot: root, cachePath });
  await index.refresh();

  // AAA を書き換え (mtime.json も進む)、BBB は消える、CCC が増える
  fs.writeFileSync(path.join(root, 'images', 'AAA.info', 'metadata.json'), JSON.stringify({ name: 'one!', modificationTime: 150 }));
  fs.mkdirSync(path.join(root, 'images', 'CCC.info'));
  fs.writeFileSync(path.join(root, 'images', 'CCC.info', 'metadata.json'), JSON.stringify({ name: 'three', modificationTime: 300 }));
  fs.rmSync(path.join(root, 'images', 'BBB.info'), { recursive: true, force: true });
  fs.writeFileSync(path.join(root, 'mtime.json'), JSON.stringify({ AAA: 150, CCC: 300 }));

  const result = await countStats(() => index.refresh());
  assert.strictEqual(result.result.mode, 'diff');
  // AAA と CCC (変わった/増えた) に加え、mtime.json から消えた BBB の実在も一度だけ訊く
  assert.strictEqual(result.calls, 3);
  assert.strictEqual(result.result.reread, 2);
  assert.strictEqual(result.result.changed, true);
  assert.deepStrictEqual([...result.result.entries.keys()].sort(), ['AAA.info', 'CCC.info']);
  assert.strictEqual(result.result.entries.get('AAA.info').meta.name, 'one!');
});

test('mtime.json が無ければ全件読み、控えが古すぎても全件読みに戻る', async () => {
  const root = makeLibrary({ AAA: { name: 'one', modificationTime: 100 } });
  const cachePath = path.join(root, 'scan-cache.json');
  fs.rmSync(path.join(root, 'mtime.json'));
  const index = new EagleIndex({ libraryRoot: root, cachePath });
  const first = await index.refresh();
  assert.strictEqual(first.mode, 'full');
  const second = await index.refresh();
  assert.strictEqual(second.mode, 'full', 'mtime.json が無い間は差分読みにならない');

  fs.writeFileSync(path.join(root, 'mtime.json'), JSON.stringify({ AAA: 100 }));
  const third = await index.refresh();
  assert.strictEqual(third.mode, 'diff');
  // 前回の全走査が古くても自動では全件に戻らない (起動直後の stat の嵐を避ける)。
  // 古さは fullScanStale で呼び手に知らせ、呼び手が時間を置いて full: true で頼む
  index.fullScanAt = Date.now() - FULL_SCAN_INTERVAL - 1;
  assert.strictEqual(index.fullScanStale(), true);
  const fourth = await index.refresh();
  assert.strictEqual(fourth.mode, 'diff');
  assert.strictEqual((await index.refresh({ full: true })).mode, 'full', '明示の全件読み');
  assert.strictEqual(index.fullScanStale(), false);
  assert.strictEqual(await index.refresh().then((r) => r.mode), 'diff');
});

test('版 2 の控え (mj 無し) は項目を引き継ぎつつ次を全件読みにする', async () => {
  const root = makeLibrary({ AAA: { name: 'one', modificationTime: 100 } });
  const cachePath = path.join(root, 'scan-cache.json');
  const stat = fs.statSync(path.join(root, 'images', 'AAA.info', 'metadata.json'));
  fs.writeFileSync(cachePath, JSON.stringify({
    version: 2,
    items: { 'AAA.info': { mtimeMs: stat.mtimeMs, size: stat.size, meta: { name: 'cached', folders: [], tags: [], addedAt: 100 } } },
  }));
  const index = new EagleIndex({ libraryRoot: root, cachePath });
  index.load();
  assert.strictEqual(index.entries.get('AAA.info').meta.name, 'cached');
  const result = await index.refresh();
  assert.strictEqual(result.mode, 'full');
  // 実体の mtime+size が同じなら読み直さず、mj だけ覚える
  assert.strictEqual(result.reread, 0);
  assert.strictEqual(result.entries.get('AAA.info').mj, 100);
});

test('読めないライブラリは 0 件にせず失敗として返す', async () => {
  const index = new EagleIndex({ libraryRoot: path.join(os.tmpdir(), 'bunko-no-such-library'), cachePath: '' });
  await assert.rejects(() => index.refresh());
});


// ── 控えの往復 (項目 2-1) ──────────────────────────────────────
//
// save() は整形済みの meta をそのまま書き、load() がそれをもう一度 shapeMeta に通す。
// だから shapeMeta は「自分の出力を食わせても同じ物を返す」必要がある。
// 今は addedAt が入力を見ていないので二度目で必ず null になり、
// 既定の並び「保存日」が蔵書の一冊も効いていない。
// 波3 でここを直したら todo を外す。

test('shapeMeta は冪等 (控えを読み直しても addedAt が消えない)', () => {
  const raw = {
    name: 'x', tags: ['a'], star: 3, folders: ['F1'], ext: 'pdf',
    modificationTime: 1700000000000, btime: 1690000000000,
  };
  const once = shapeMeta(raw);
  const twice = shapeMeta(once);
  assert.deepStrictEqual(twice, once, '二度整形すると addedAt が落ちる');
});

test('shapeMeta の一度目は Eagle の時刻を拾う (今も効いている所)', () => {
  const once = shapeMeta({ name: 'x', modificationTime: 1700000000000 });
  assert.strictEqual(once.addedAt, 1700000000000);
  assert.strictEqual(shapeMeta({ name: 'x', btime: 5 }).addedAt, 5);
  assert.strictEqual(shapeMeta({ name: 'x' }).addedAt, null);
});

test('控えを書いて読み直しても保存日が残る (往復して消えない)', async () => {
  const root = makeLibrary({
    a1: { name: 'x', star: 3, modificationTime: 1700000000000 },
  });
  const cache = path.join(root, 'cache.json');

  const first = new EagleIndex({ libraryRoot: root, cachePath: cache });
  await first.refresh({ full: true });
  const before = first.entries.get('a1.info').meta.addedAt;
  assert.strictEqual(before, 1700000000000, '一度目は Eagle の時刻を拾う');
  first.save();

  const second = new EagleIndex({ libraryRoot: root, cachePath: cache });
  second.load();
  assert.strictEqual(
    second.entries.get('a1.info').meta.addedAt, before,
    '読み直しで保存日が落ちない (これが落ちていたので並びが効かなかった)',
  );
});

test('版が上がった控えは項目を捨てず、母艦だけが一度だけ全件を払う', () => {
  const root = makeLibrary({ a1: { name: 'x' } });
  const cache = path.join(root, 'old.json');
  fs.writeFileSync(cache, JSON.stringify({
    version: 3, root, fullScanAt: Date.now(),
    items: { 'a1.info': { mtimeMs: 1, size: 2, mj: 3, meta: { name: 'x', addedAt: 111 } } },
  }));

  const stateFile = require('../src/lib/state-file');
  stateFile.resetForTest();
  const host = new EagleIndex({ libraryRoot: root, cachePath: cache });
  host.load();
  assert.strictEqual(host.entries.size, 1, '版違いでも項目は引き継ぐ');
  assert.strictEqual(host.entries.get('a1.info').meta.addedAt, 111, '引き継いだ保存日も残る');
  assert.strictEqual(host.fullScanAt, 0, '母艦は一度だけ全件へ');
  assert.strictEqual(host.needsFullScan(), true);
  assert.strictEqual(host.reshapePending, true);

  // 写しは払わない: 書き出せない機体に 26,468 件を読ませても得が無い
  stateFile.setRole({ readOnly: true });
  const mirror = new EagleIndex({ libraryRoot: root, cachePath: cache });
  mirror.load();
  assert.notStrictEqual(mirror.fullScanAt, 0, '写しは控えの時刻を引き継ぐ');
  assert.strictEqual(mirror.needsFullScan(), false, '写しは全件読みに落ちない');
  assert.strictEqual(mirror.reshapePending, false);
  stateFile.resetForTest();
});

test('整形のやり直しの回は、動いていないアイテムも読み直して保存日を埋める', async () => {
  const root = makeLibrary({ a1: { name: 'x', modificationTime: 1700000000000 } });
  const cache = path.join(root, 'reshape.json');
  const stat = fs.statSync(path.join(root, 'images', 'a1.info', 'metadata.json'));
  // 版 3 の控え: 実体は動いていないが addedAt が欠けている (往復で落ちた状態)
  fs.writeFileSync(cache, JSON.stringify({
    version: 3, root, fullScanAt: Date.now(),
    items: { 'a1.info': { mtimeMs: stat.mtimeMs, size: stat.size, mj: 1, meta: { name: 'x' } } },
  }));

  const stateFile = require('../src/lib/state-file');
  stateFile.resetForTest();
  const index = new EagleIndex({ libraryRoot: root, cachePath: cache });
  index.load();
  assert.strictEqual(index.entries.get('a1.info').meta.addedAt, null, '欠けた状態から始まる');

  await index.refresh({ full: true });
  assert.strictEqual(
    index.entries.get('a1.info').meta.addedAt, 1700000000000,
    '実体が動いていなくても読み直して埋める (ここを近道すると永久に欠けたまま)',
  );
  assert.strictEqual(index.reshapePending, false, 'やり直しが済んだら印は降りる');
});

test('★は一行の追記で憶え、走査で巻き戻らない (控え 6MB は書き直さない)', async () => {
  const root = makeLibrary({ a1: { name: 'x', star: 1, modificationTime: 1700000000000 } });
  const cache = path.join(root, 'star.json');
  const stateFile = require('../src/lib/state-file');
  stateFile.resetForTest();

  const index = new EagleIndex({ libraryRoot: root, cachePath: cache });
  await index.refresh({ full: true });
  assert.strictEqual(index.entries.get('a1.info').meta.star, 1);

  // 利用者が★を 5 にした (Eagle の metadata.json はまだ 1 のまま)
  const sizeBefore = fs.statSync(cache).size;
  assert.strictEqual(index.noteOwnStar('a1', 5), true);
  assert.strictEqual(index.entries.get('a1.info').meta.star, 5, 'すぐ効く');
  assert.strictEqual(fs.statSync(cache).size, sizeBefore, '控え本体は書き直さない');
  assert.ok(fs.existsSync(`${cache}.own.jsonl`), '追記の置き場に一行だけ足す');

  // Eagle が書き出す前にもう一度走査しても巻き戻らない
  await index.refresh({ full: true });
  assert.strictEqual(index.entries.get('a1.info').meta.star, 5, '走査で巻き戻らない');

  // 控えを書き切ったら追記ぶんは畳まれる
  assert.strictEqual(fs.existsSync(`${cache}.own.jsonl`), false, '畳んだら置き場は消える');

  // 読み直しても残る
  const again = new EagleIndex({ libraryRoot: root, cachePath: cache });
  again.load();
  assert.strictEqual(again.entries.get('a1.info').meta.star, 5);
});

test('写しの機体は★を書かない (母艦が配る控えに触らない)', async () => {
  const root = makeLibrary({ a1: { name: 'x', star: 1 } });
  const cache = path.join(root, 'ro.json');
  const stateFile = require('../src/lib/state-file');
  stateFile.resetForTest();
  const index = new EagleIndex({ libraryRoot: root, cachePath: cache });
  await index.refresh({ full: true });

  stateFile.setRole({ readOnly: true });
  assert.strictEqual(index.noteOwnStar('a1', 4), false, '書き出しは断られる');
  assert.strictEqual(fs.existsSync(`${cache}.own.jsonl`), false);
  stateFile.resetForTest();
});
