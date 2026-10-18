'use strict';

// 生成情報の控えの表 (src/lib/ai-meta-store.js、better-sqlite3 の ai-meta.sqlite)。
//   出どころの強さで上書きを決める・aitag の 404 だけ期限・印 (markOf) と aitag に訊き直す判断 (aitagKnown)・
//   写し (readOnly) は問い合わせごとに開いて閉じ、書かない・better-sqlite3 が無ければメモリに落ちる。
// 素の node で走る (node_modules の node 向けの .node)。読めない環境では SQLite の件だけ飛ばす。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
require('./helpers/stub-electron');
const { AiMetaStore, loadDriver } = require('../src/lib/ai-meta-store');

const META = { format: 'NovelAI', positive: 'a, b', negative: 'c', characters: [], characterNegatives: [], settings: { model: 'M', seed: 1 }, extra: {}, workflowTexts: [], note: '' };
const sqlite = Boolean(loadDriver());

test('put: 出どころの強さ (import = original = pdf-smask > head64k > aitag)。ok は弱い無しに潰されず、弱い無しは強い無しを潰さない', () => {
  let now = 1000;
  const store = new AiMetaStore({ file: ':memory:', now: () => now });
  assert.equal(store.put({ pid: 'px:1', page: 0, status: 'none', source: 'head64k' }), true);
  assert.equal(store.put({ pid: '1', page: 0, status: 'none', source: 'aitag', ttl: 100 }), false, 'aitag の無しは head64k の無しを潰さない');
  assert.equal(store.put({ pid: '1', page: 0, status: 'none', source: 'original' }), true, '原寸の無しは上書き');
  assert.equal(store.get('1', 0).source, 'original');
  assert.equal(store.put({ pid: '1', page: 0, status: 'ok', source: 'aitag', meta: META }), true, 'ok はどこからでも書ける');
  assert.equal(store.put({ pid: '1', page: 0, status: 'none', source: 'original' }), false, 'ok は無しに戻らない');
  assert.equal(store.put({ pid: '1', page: 0, status: 'ok', source: 'original', meta: { ...META, settings: { model: 'N' } } }), true, '強い ok は上書き');
  assert.equal(store.get('1', 0).model, 'N');
  assert.equal(store.put({ pid: '1', page: 0, status: 'ok', source: 'aitag', meta: META }), false, '弱い ok は上書きしない');
  assert.equal(store.put({ pid: 'user:5', status: 'ok', source: 'aitag', meta: META }), false, '番号でない物は書かない');
  assert.equal(store.get('1', 0).meta.format, 'NovelAI');
  assert.equal(store.count(), 1);
});

test('aitag の 404 だけ期限: 新しい投稿は 20 分、そうでなければ 3 日。ok は切れない。印と訊き直しの判断', () => {
  let now = 1_000_000;
  const store = new AiMetaStore({ file: ':memory:', now: () => now });
  store.aitagMiss('10');
  store.aitagMiss('11', { fresh: true });
  assert.equal(store.markOf('10'), 'no');
  assert.equal(store.aitagKnown('10'), 'no');
  now += 25 * 60 * 1000;
  assert.equal(store.markOf('11'), '', '新しい投稿の 404 は 20 分で忘れる');
  assert.equal(store.aitagKnown('11'), '');
  assert.equal(store.markOf('10'), 'no');
  now += 4 * 24 * 60 * 60 * 1000;
  assert.equal(store.aitagKnown('10'), '', '3 日で訊き直す');
  store.put({ pid: '12', page: 2, status: 'ok', source: 'aitag', meta: META });
  assert.equal(store.markOf('12'), 'yes', 'どこかの頁に ok なら yes');
  assert.equal(store.aitagKnown('12'), 'yes');
  store.put({ pid: '13', page: 0, status: 'none', source: 'head64k' });
  assert.equal(store.markOf('13'), '', 'head64k の無しは印にしない (ステルスは未確定)');
  assert.equal(store.aitagKnown('13'), '', 'aitag にも訊く');
  store.put({ pid: '14', page: 0, status: 'none', source: 'original' });
  assert.equal(store.markOf('14'), 'no');
  assert.equal(store.aitagKnown('14'), 'no', '原寸で無しなら aitag には訊かない');
  store.aitagListed('15');
  assert.equal(store.markOf('15'), 'yes');
  assert.equal(store.metaOf('15', 0), null, '一括で載っていると分かっただけ: 中身は無い');
  assert.equal(store.aitagKnown('15'), 'yes');
});

test('ファイルに残り、読み直せる。写し (readOnly) は読めるが書かず、開いたままにしない', { skip: !sqlite && 'better-sqlite3 を読めない' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-meta-'));
  const file = path.join(dir, 'ai-meta.sqlite');
  const store = new AiMetaStore({ file });
  store.batch((put) => { put({ pid: '1', page: 0, status: 'ok', source: 'import', meta: META }); put({ pid: '1', page: 1, status: 'none', source: 'import' }); });
  store.close();
  assert.ok(fs.existsSync(file));
  assert.ok(!fs.existsSync(file + '-wal'), 'WAL は使わない (同期は本体だけ写す)');
  const mirror = new AiMetaStore({ file, readOnly: true });
  assert.equal(mirror.markOf('1'), 'yes');
  assert.equal(mirror.pages('1').length, 2);
  assert.equal(mirror.put({ pid: '2', status: 'ok', source: 'aitag', meta: META }), false);
  assert.equal(mirror.db, null, '開いたままにしない');
  // 差し替えられる (開いている手が無い): 書き手が書き直した物を読む
  const writer = new AiMetaStore({ file });
  writer.put({ pid: '3', status: 'ok', source: 'original', meta: META });
  writer.close();
  assert.equal(mirror.markOf('3'), 'yes');
  // 中身 (プロンプト) はファイルの中にだけ。この試験の出力には出さない
  const missing = new AiMetaStore({ file: path.join(dir, 'none.sqlite'), readOnly: true });
  assert.equal(missing.markOf('1'), '');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('better-sqlite3 を読めない時 (BUNKO_NO_SQLITE) はメモリに落ちて止まらない', () => {
  const { spawnSync } = require('node:child_process');
  const script = `
    require('./test/helpers/stub-electron');
    const { AiMetaStore, loadDriver } = require('./src/lib/ai-meta-store');
    const s = new AiMetaStore({ file: require('path').join(require('os').tmpdir(), 'ai-meta-none-' + process.pid + '.sqlite') });
    s.put({ pid: '1', status: 'ok', source: 'aitag', meta: { format: 'A1111', settings: {} } });
    console.log(JSON.stringify([loadDriver() == null, s.markOf('1'), s.count()]));
  `;
  const out = spawnSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), env: { ...process.env, BUNKO_NO_SQLITE: '1' }, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout.trim()), [true, 'yes', 1]);
});
