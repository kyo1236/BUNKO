'use strict';

// 控えの番人 (項目 1-1 / 6-1 / 6-2 / 10-4)。
//
// 押さえるのは三つ:
//   1. 途中で落ちても前の本体が残る (tmp + fsync + rename)
//   2. 写しの機体は「母艦が配る控え」を書かない。ただし自前で持つ物は書ける
//      — ここを一律に塞ぐと写しが一頁も焼けなくなる
//   3. 書けなかったことが記録に残る (黙って既定値へ落ちない)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const stateFile = require('../src/lib/state-file');
const trace = require('../src/lib/trace');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunko-state-'));
test.after(() => {
  stateFile.resetForTest();
  fs.rmSync(dir, { recursive: true, force: true });
});

function target(name) {
  return path.join(dir, name);
}

test('母艦では両方書ける', () => {
  stateFile.resetForTest();
  assert.equal(stateFile.writeJson('eagle-index', target('a.json'), { v: 1 }), true);
  assert.equal(stateFile.writeJson('media', target('b.json'), { v: 2 }), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(target('a.json'), 'utf8')), { v: 1 });
});

test('写しは「母艦が配る控え」を書かない。自前で持つ物は書ける', () => {
  stateFile.resetForTest();
  trace.reset();
  fs.writeFileSync(target('keep.json'), '{"元":"のまま"}');
  stateFile.setRole({ readOnly: true });

  assert.equal(stateFile.canWrite('eagle-index'), false, '走査の控えは配られる側');
  assert.equal(stateFile.writeJson('eagle-index', target('keep.json'), { 新しい: 1 }), false);
  assert.equal(fs.readFileSync(target('keep.json'), 'utf8'), '{"元":"のまま"}', '上書きしない');

  // 写しは自分で頁を焼くので、ここまで塞ぐと一頁も出せなくなる
  assert.equal(stateFile.canWrite('media'), true, '自前の焼き頁は書ける');
  assert.equal(stateFile.canWrite('reading'), true, '栞は機体ごと');
  assert.equal(stateFile.canWrite('config'), true, '設定は同期から外してある');
  assert.equal(stateFile.writeJson('media', target('own.json'), { ok: 1 }), true);

  const codes = trace.recent(10).map((e) => e.code);
  assert.ok(codes.includes('write-skipped-readonly'), '書かなかったことが記録に残る');
  stateFile.resetForTest();
});

test('置き場が無ければ作る / 書けない先は false を返して投げない', () => {
  stateFile.resetForTest();
  trace.reset();
  assert.equal(stateFile.writeJson('reading', target('深い/入れ子/c.json'), { v: 3 }), true);

  // ファイルを置き場の名前にして mkdir を必ず失敗させる
  const blocked = target('blocked');
  fs.writeFileSync(blocked, 'not a dir');
  assert.equal(stateFile.writeJson('reading', path.join(blocked, 'x.json'), { v: 1 }), false);
  assert.ok(trace.recent(5).some((e) => e.code === 'write-failed'), '失敗が記録に残る');
});

test('輪にした値でも投げず、記録して false', () => {
  stateFile.resetForTest();
  trace.reset();
  const loop = {};
  loop.self = loop;
  assert.equal(stateFile.writeJson('reading', target('loop.json'), loop), false);
  assert.ok(trace.recent(5).some((e) => e.code === 'write-failed'));
});

test('壊れた控えは横へ退ける (消さない)。写しでは退けない', () => {
  stateFile.resetForTest();
  const file = target('broken.json');
  fs.writeFileSync(file, '{壊れ');
  assert.equal(stateFile.quarantine('config', file), true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(`${file}.broken`, 'utf8'), '{壊れ', '中身は残る');

  fs.writeFileSync(file, '{また壊れ');
  stateFile.setRole({ readOnly: true });
  assert.equal(stateFile.quarantine('eagle-index', file), false, '写しは配られた控えに触らない');
  assert.ok(fs.existsSync(file));
  stateFile.resetForTest();
});

test('知らない控えは足し忘れとして投げる (黙って素通りさせない)', () => {
  assert.throws(() => stateFile.canWrite('しらない'), /KINDS に足すこと/);
});

test('配られる側の一覧が、同期の script が写す一覧と噛み合っている', () => {
  const script = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'sync-to-homecore.ps1'), 'utf8',
  );
  // 番人が「母艦が配る」と言っている控えは、同期が実際に写していること。
  // 写さない物を follow にすると、写しは永久に届かない控えを待つことになる
  const copied = {
    'eagle-index': 'eagle-scan-cache.json',
    catalog: 'catalog.sqlite',
    'paw-favorites': 'paw-favorites.txt',
    'paw-links': 'paw-links.json',
    'pixiv-library': 'pixiv-library.json',
    'creator-links': 'creator-links.json',
    'release-dates': 'release-dates.json',
    'ai-meta': 'ai-meta.sqlite',
  };
  for (const kind of stateFile.follows()) {
    if (kind === 'paw-library') continue; // 波5 で消す控え (同期の対象外)
    assert.ok(copied[kind], `${kind} を follow にしたなら、写す先をこの表に足すこと`);
    assert.ok(script.includes(copied[kind]), `同期が ${copied[kind]} を写していない`);
  }
});
