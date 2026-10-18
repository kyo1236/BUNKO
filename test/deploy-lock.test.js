'use strict';
// 配布の錠 (scripts/tools/deploy-lock.js): 取る・断る・古い錠の上書き・空ける・check の出口。錠の置き場は一時フォルダ
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TOOL = path.join(__dirname, '..', 'scripts', 'tools', 'deploy-lock.js');

function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunko-lock-'));
  const file = path.join(dir, 'lock.json');
  const run = (...args) => {
    const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: { ...process.env, BUNKO_DEPLOY_LOCK: file } });
    return { code: r.status, out: (r.stdout + r.stderr).trim() };
  };
  return { dir, file, run, read: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}

test('取る → 別の会は断られ、持ち主の check は通り、free で空く', () => {
  const r = rig();
  assert.equal(r.run('take', '会A', '配布').code, 0);
  assert.equal(r.read().owner, '会A');
  const b = r.run('take', '会B', '9222');
  assert.equal(b.code, 1);
  assert.match(b.out, /会A/, '断る時は持ち主の名を言う (その会にだけ声をかけるため)');
  assert.equal(r.run('check', '--owner', '会A').code, 0);
  assert.equal(r.run('check', '--owner', '会B').code, 1);
  assert.equal(r.run('free', '会B').code, 1, '他人の錠は空けない');
  assert.equal(r.run('free', '会A', '--note', '配った').code, 0);
  assert.ok(!fs.existsSync(r.file));
  const last = JSON.parse(fs.readFileSync(r.file.replace(/\.json$/, '.last.json'), 'utf8'));
  assert.equal(last.note, '配った');
});

test('錠が無ければ check は 1 (先に取れと言う)。同じ会の take は取り直し', () => {
  const r = rig();
  const c = r.run('check', '--owner', '会A');
  assert.equal(c.code, 1);
  assert.match(c.out, /先に取る/);
  assert.equal(r.run('take', '会A', '組む').code, 0);
  assert.equal(r.run('take', '会A', '配る').code, 0);
  assert.equal(r.read().purpose, '配る');
});

test('30 分より古い錠は別の会が上書きしてよい', () => {
  const r = rig();
  assert.equal(r.run('take', '会A', '配布').code, 0);
  const lock = r.read();
  lock.at = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  fs.writeFileSync(r.file, JSON.stringify(lock));
  const b = r.run('take', '会B', '配布');
  assert.equal(b.code, 0);
  assert.match(b.out, /古い錠を上書き/);
  assert.equal(r.read().owner, '会B');
});

test('module の blocker は理由を返し、持ち主には null', () => {
  const r = rig();
  const tool = require(TOOL);
  process.env.BUNKO_DEPLOY_LOCK = r.file;
  try {
    assert.match(tool.blocker('会A'), /錠が無い/);
    assert.equal(r.run('take', '会A', '配布').code, 0);
    assert.equal(tool.blocker('会A'), null);
    assert.match(tool.blocker('会B'), /会A/);
  } finally { delete process.env.BUNKO_DEPLOY_LOCK; }
});
