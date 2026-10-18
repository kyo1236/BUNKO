'use strict';

// 壊れた config.json の扱い (項目 5-1)。
//
// 今までは JSON として読めないと黙って既定値に戻り、窓に触れた瞬間の save() で
// 原本が上書き確定していた。失うのは lanToken (端末の入り口が全部死ぬ) と
// eagleLibrary (棚の所持が誤りも出さず 0 件になる)。
//
// もう一つの罠: 既定の readOnly は false なので、写しの機体で config が壊れると
// 次の起動で **書き手として立ち上がる** (config.json は同期の対象外なので
// 母艦から直る当ても無い)。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunko-config-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

// config.js は electron の app.getPath に依る。置き場だけ差し替えて読み直す
function loadConfig(userData) {
  const original = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'electron') {
      return { app: { getPath: (name) => (name === 'downloads' ? path.join(userData, 'dl') : userData) } };
    }
    return original.call(this, request, parent, isMain);
  };
  try {
    for (const name of ['config', 'state-file', 'trace']) {
      delete require.cache[require.resolve(`../src/lib/${name}`)];
    }
    return require('../src/lib/config');
  } finally {
    Module._load = original;
  }
}

function room(name, text) {
  const userData = path.join(dir, name);
  fs.mkdirSync(userData, { recursive: true });
  if (text != null) fs.writeFileSync(path.join(userData, 'config.json'), text, 'utf8');
  return userData;
}

test('BOM 付きでも中身が正しければ読める (PS5.1 で書かれた回を落とさない)', () => {
  const userData = room('bom', `\uFEFF${JSON.stringify({ lanToken: 'abc', eagleLibrary: 'D:/lib' })}`);
  const config = loadConfig(userData);
  const value = config.load();
  assert.equal(value.lanToken, 'abc');
  assert.equal(value.eagleLibrary, 'D:/lib');
});

test('壊れていたら原本を横へ退け、中身を残す (上書きで消さない)', () => {
  const userData = room('broken', '{"lanToken":"abc", 壊れ');
  const config = loadConfig(userData);
  config.load();
  const file = path.join(userData, 'config.json');
  assert.equal(fs.existsSync(file), false, '壊れた原本は退けてある');
  assert.match(fs.readFileSync(`${file}.broken`, 'utf8'), /abc/, '中身は残る (後から拾える)');
});

test('壊れていても読み取り専用だけは引き継ぐ (写しが書き手として起き上がらない)', () => {
  const userData = room('mirror', '{"readOnly": true, "lanToken":"abc", 壊れ');
  const config = loadConfig(userData);
  assert.equal(config.load().readOnly, true, 'JSON として読めなくてもこの一語は拾う');
});

test('壊れていて読み取り専用の指定も無ければ、既定 (書き手) のまま', () => {
  const userData = room('plain', '{壊れ');
  const config = loadConfig(userData);
  assert.equal(config.load().readOnly, false);
});

test('印が立ち、記録に残る (設定画面がこれを出す)', () => {
  const userData = room('flagged', '{壊れ');
  const config = loadConfig(userData);
  config.load();
  const trace = require('../src/lib/trace');
  assert.ok(trace.flags()['config-corrupt'], '壊れていた印が立つ');
  assert.ok(trace.recent(10).some((e) => e.scope === 'config' && e.code === 'corrupt'));
});

test('そもそも無いときは静かに既定 (初回起動は壊れていない)', () => {
  const userData = room('absent', null);
  const config = loadConfig(userData);
  const trace = require('../src/lib/trace');
  trace.reset();
  assert.equal(config.load().readOnly, false);
  assert.equal(trace.recent(5).length, 0, '初回起動で記録を汚さない');
});
