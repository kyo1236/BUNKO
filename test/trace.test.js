'use strict';

// trace: 失敗の落ち先。ここで固めるのは三つ。
//   1. 作品名・タグが **書けない** こと (口の形として受け取らない)
//   2. 表に無い語を渡しても落ちないこと (記録の仕組みでアプリを止めない)
//   3. 記録が書けない置き場でも recent() は動くこと

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const trace = require('../src/lib/trace');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunko-trace-'));
test.after(async () => {
  await trace.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('detail は { id, count, ms, bytes } しか通さない (作品名は口で落ちる)', () => {
  trace.reset();
  const entry = trace.note('eagle', 'scan-failed', {
    id: 'SYNTHITEM0001',
    count: 3,
    ms: 12,
    bytes: 4096,
    name: '作品名が入ってはいけない',
    tags: ['タグ', 'も'],
    message: 'D:\\share\\...\\原本.pdf',
    path: 'C:\\秘密',
  });
  assert.deepEqual(entry.detail, { id: 'SYNTHITEM0001', count: 3, ms: 12, bytes: 4096 });
  const text = JSON.stringify(trace.recent(10));
  assert.ok(!text.includes('作品名'), '記録に作品名が残らない');
  assert.ok(!text.includes('タグ'), '記録にタグが残らない');
  assert.ok(!text.includes('原本'), '記録に原本の道が残らない');
});

test('id は 64 字で切る / 数でない count と ms は落ちる / 空の detail は null', () => {
  trace.reset();
  const long = 'x'.repeat(200);
  assert.equal(trace.note('paw', 'read-failed', { id: long }).detail.id.length, 64);
  assert.equal(trace.note('paw', 'read-failed', { count: 'いくつか' }).detail, null);
  assert.equal(trace.note('paw', 'read-failed', {}).detail, null);
  assert.equal(trace.note('paw', 'read-failed').detail, null);
});

test('表に無い scope / code でも落ちず、既定の語へ倒す', () => {
  trace.reset();
  const entry = trace.note('しらない場所', 'しらないこと');
  assert.equal(entry.scope, 'ipc');
  assert.equal(entry.code, 'unhandled');
});

test('warnOnce は同じ鍵で一度きり。鍵そのものは記録に出ない', () => {
  trace.reset();
  assert.ok(trace.warnOnce('key-a', 'pdf', 'unpack-fallback', { id: 'a' }));
  assert.equal(trace.warnOnce('key-a', 'pdf', 'unpack-fallback', { id: 'a' }), null);
  assert.ok(trace.warnOnce('key-b', 'pdf', 'unpack-fallback', { id: 'b' }));
  assert.equal(trace.recent(10).length, 2);
  assert.ok(!JSON.stringify(trace.recent(10)).includes('key-a'));
});

test('recent は新しい方から limit 件。印は立てて降ろせる', () => {
  trace.reset();
  for (let i = 0; i < 5; i += 1) trace.note('net', 'offline', { count: i });
  assert.deepEqual(trace.recent(2).map((e) => e.detail.count), [3, 4]);
  trace.flag('cacheless');
  assert.ok(trace.flags().cacheless);
  trace.flag('cacheless', false);
  assert.deepEqual(trace.flags(), {});
});

test('置き場を与えると日ごとのファイルに残り、作品名は一字も入らない', async () => {
  trace.reset();
  trace.init(dir);
  trace.note('sync', 'sync-failed', { id: 'ID-ONLY', ms: 5, name: '見えてはいけない' });
  await trace.close();
  const names = fs.readdirSync(dir).filter((n) => /^bunko-\d{8}\.log$/.test(n));
  assert.equal(names.length, 1);
  const text = fs.readFileSync(path.join(dir, names[0]), 'utf8');
  assert.match(text, /sync sync-failed/);
  assert.match(text, /ID-ONLY/);
  assert.ok(!text.includes('見えてはいけない'));
});

test('置き場が作れなくても note は投げず recent は動く', () => {
  trace.reset();
  // ファイルを置き場の名前で作っておく: mkdir が必ず失敗する
  const blocked = path.join(dir, 'blocked');
  fs.writeFileSync(blocked, 'not a directory');
  trace.init(blocked);
  assert.doesNotThrow(() => trace.note('boot', 'write-failed', { id: 'x' }));
  assert.equal(trace.recent(1).length, 1);
  trace.init(dir);
});

test('例外からは name/code だけ取る (message は原本の道を含みうるので使わない)', () => {
  const error = Object.assign(new Error('D:\\share\\eagle\\作品.pdf が無い'), { code: 'ENOENT' });
  assert.equal(trace.codeOf(error), 'ENOENT');
  assert.equal(trace.codeOf(new TypeError('x')), 'TypeError');
  assert.equal(trace.codeOf(null), 'unknown');
});

test('印には時限を付けられる (直ったと誰も教えてくれない物を永久に残さない)', () => {
  trace.reset();
  trace.flag('permanent');
  trace.flag('temporary', true, 1);
  assert.ok(trace.flags().permanent);
  assert.ok(trace.flags().temporary);
  const wait = Date.now() + 5;
  while (Date.now() < wait) { /* 数ミリ待つ */ }
  const after = trace.flags();
  assert.ok(after.permanent, '時限の無い印は残る');
  assert.ok(!after.temporary, '時限の切れた印は消える');
});

test('拾われない例外は「何が・どこで」を残す (作品名も原本の道も入らない)', () => {
  const sep = String.fromCharCode(92);          // 円記号 (道の区切り)
  const error = new Error(['D:', 'storage', 'mybooks.library', 'images', '作品名.pdf'].join(sep));
  const where = trace.whereOf(error);
  assert.ok(!where.includes('作品名'), '作品名が入らない');
  assert.ok(!where.includes('storage'), '原本の道が入らない');
  assert.ok(where.length <= 64, '64 字に収まる');

  // このアプリ自身の source を指していれば file:line が付く
  const inApp = new Error('x');
  const frame = ['C:', 'work', 'app', 'src', 'lib', 'catalog.js'].join(sep);
  inApp.stack = `Error: x
    at foo (${frame}:1234:5)`;
  assert.strictEqual(trace.whereOf(inApp), 'Error@src/lib/catalog.js:1234');

  // 手掛かりが無ければ名前だけ
  const bare = new Error('x');
  bare.stack = 'Error: x';
  assert.strictEqual(trace.whereOf(bare), 'Error');
});
