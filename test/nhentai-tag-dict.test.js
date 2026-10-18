'use strict';

// nhentai の一覧はタグを番号 (tag_ids) でしか寄越さない。その番号を名前に
// 戻す控え。語はすべて合成。
//
// 押さえるのは「棚を待たせない」こと: 控えで足りるぶんは只で付き、足りない
// ぶんだけまとめて訊き、時間切れなら諦めて次に回す。
const test = require('node:test');
const assert = require('node:assert/strict');
const { installStub } = require('./helpers/stub-electron-2.js');

installStub();
const dict = require('../src/lib/sources/nhentai-tag-dict.js');

const entry = (id, type, name) => ({ id, type, name });

// 網の代わり。呼ばれた URL を控え、ids に応じた返事を組む
function net(known, { delayMs = 0, fail = false } = {}) {
  const calls = [];
  const get = (url) => {
    calls.push(url);
    const ids = new URL(url).searchParams.get('ids').split(',').map(Number);
    const body = ids.map((id) => known.get(id)).filter(Boolean);
    const answer = { json: () => body };
    if (fail) return Promise.reject(new Error('synthetic network failure'));
    if (!delayMs) return Promise.resolve(answer);
    return new Promise((done) => setTimeout(() => done(answer), delayMs));
  };
  return { get, calls };
}

test('詳細の返事から只で覚え、番号を名前に戻せる', () => {
  dict.resetForTest([]);
  dict.learn([
    entry(11, 'tag', 'synthetic alpha'),
    entry(12, 'artist', 'synthetic artist'),
    entry(13, 'language', 'japanese'),
  ]);
  assert.deepEqual(dict.known(11), { type: 'tag', name: 'synthetic alpha' });
  assert.deepEqual(
    dict.expand([11, 12]).map((t) => `${t.type}:${t.name}`),
    ['tag:synthetic alpha', 'artist:synthetic artist'],
  );
  // 覚えていない番号は落とす (空の札を出さない)
  assert.deepEqual(dict.expand([11, 999]).map((t) => t.id), [11]);
  assert.deepEqual(dict.expand([]), []);
  assert.equal(dict.known(999), null);
});

test('控えに無い番号だけ訊く。100 ずつに割る (相手の上限)', async () => {
  dict.resetForTest([[11, { type: 'tag', name: 'synthetic alpha' }]]);
  const known = new Map();
  for (let id = 1; id <= 250; id += 1) known.set(id, entry(id, 'tag', `synthetic ${id}`));
  const { get, calls } = net(known);

  await dict.resolve([11, ...Array.from({ length: 250 }, (_, i) => i + 1)], { get });

  assert.equal(calls.length, 3, '250 件は 100+100+50 の三度');
  for (const url of calls) {
    const ids = new URL(url).searchParams.get('ids').split(',');
    assert.ok(ids.length <= dict.CHUNK, `一度に ${dict.CHUNK} を超えない`);
    assert.ok(!ids.includes('11'), '既に覚えている番号は訊かない');
  }
  assert.deepEqual(dict.known(250), { type: 'tag', name: 'synthetic 250' });

  // 二度目は控えが効いて網に触らない
  calls.length = 0;
  await dict.resolve([1, 2, 3, 250], { get });
  assert.equal(calls.length, 0, '覚えた番号は二度訊かない');
});

test('引けなくても落ちない (タグが付かないだけ)', async () => {
  dict.resetForTest([]);
  const { get } = net(new Map(), { fail: true });
  await dict.resolve([1, 2, 3], { get });
  assert.deepEqual(dict.expand([1, 2, 3]), [], '付かないだけで例外は出さない');
});

test('時間切れなら諦めて返す — 棚を待たせない', async () => {
  dict.resetForTest([]);
  const known = new Map([[1, entry(1, 'tag', 'synthetic slow')]]);
  const { get } = net(known, { delayMs: 400 });

  const started = Date.now();
  await dict.resolve([1], { get, budgetMs: 40 });
  const waited = Date.now() - started;

  assert.ok(waited < 300, `持ち時間で切り上げる (待った ${waited}ms)`);
  // 遅れて届いたぶんは次の一覧で効く
  await new Promise((done) => setTimeout(done, 500));
  assert.deepEqual(dict.known(1), { type: 'tag', name: 'synthetic slow' });
});

// 控えは state-file 越しに書く。KINDS に登録し忘れると kindOf が投げ、
// その場では握り潰されて **黙って一度も残らない** (次の起動でまた網に訊く)
test('控えが本当にディスクへ残る (kind の登録漏れを捕まえる)', async () => {
  const fs = require('node:fs');
  const nodePath = require('node:path');
  const { app } = require('electron');
  const store = nodePath.join(app.getPath('userData'), 'nhentai-tags.json');
  fs.rmSync(store, { force: true });

  dict.resetForTest([]);
  dict.learn([entry(21, 'tag', 'synthetic persisted')]);
  // 書き出しは遅延。溜まるのを待つ
  await new Promise((done) => setTimeout(done, 1400));

  assert.ok(fs.existsSync(store), `控えが書かれていない: ${store}`);
  const saved = JSON.parse(fs.readFileSync(store, 'utf8'));
  assert.equal(saved.tags['21'].n, 'synthetic persisted');
  assert.equal(saved.tags['21'].t, 'tag');
  assert.ok(!fs.readFileSync(store).slice(0, 3).equals(Buffer.from([0xEF, 0xBB, 0xBF])), 'BOM は付けない');
  fs.rmSync(store, { force: true });
});

test('同じ束を同時に二度は飛ばさない', async () => {
  dict.resetForTest([]);
  const known = new Map([[1, entry(1, 'tag', 'synthetic alpha')]]);
  const { get, calls } = net(known, { delayMs: 30 });
  await Promise.all([
    dict.resolve([1], { get }),
    dict.resolve([1], { get }),
    dict.resolve([1], { get }),
  ]);
  assert.equal(calls.length, 1, '走っている問い合わせに相乗りする');
});
