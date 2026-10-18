'use strict';

// 「どちらも」の語 (either:) の引き方。語はすべて合成。
//
// hitomi は female:glasses と male:glasses を別のタグとして持つ。nhentai は
// 型分けせず glasses としか言わない。どちらかに賭けると半分を取りこぼし、
// tag:glasses のまま投げると **0 件** になる (hitomi にその型は無い)。
// そこで二つに開いて合わせて引く。
//
// node-hitomi の AND は「先頭のタグの nozomi の並び」をそのまま結果の並びに
// する (後続は削るだけ) ので、女→男の順に足すこの合わせ方でも並びの筋は
// 今までの複数タグ検索と同じ。
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// node-hitomi は網を触るので、読み込む前に差し替える
const calls = [];
let answers = new Map();
const origLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'node-hitomi') {
    return {
      SortType: { DateAdded: 'added', Random: 'random' },
      Extension: {},
      ThumbnailSize: {},
      GalleryManager: { createNozomiPath: () => '/n/stub.nozomi' },
      Hitomi: class {
        constructor() {
          this.tags = {
            parse: (text) => String(text || '').split(/\s+/).filter(Boolean).map((token) => {
              const [type, ...rest] = token.replace(/^-/, '').split(':');
              return { type, name: rest.join(':').replace(/_/g, ' '), isNegative: token.startsWith('-') };
            }),
          };
          this.galleries = {
            list: async (options) => {
              const key = (options.tags || [])
                .map((t) => `${t.type}:${t.name}`).sort().join(' ');
              calls.push(key);
              if (!answers.has(key)) throw new Error('synthetic: no such tag');
              return answers.get(key).map((id) => ({ id }));
            },
            retrieve: async () => { throw new Error('not used'); },
          };
          this.index = {};
        }
      },
    };
  }
  return origLoad(request, parent, isMain);
};
const svc = require('../src/lib/hitomi-service.js');
Module._load = origLoad;

function reset(map) {
  calls.length = 0;
  answers = new Map(Object.entries(map));
}

test('either は女・男の二つに開いて合わせ、女の並びを先に置く', async () => {
  reset({
    'female:synthetic alpha': [10, 9, 8],
    'male:synthetic alpha': [9, 7, 6],
  });
  const ids = await svc.__testListIds('either:synthetic_alpha', 'added');
  assert.deepEqual(ids, [10, 9, 8, 7, 6], '女の並びの後ろに、男にしか無いぶんを足す');
  assert.deepEqual(calls, ['female:synthetic alpha', 'male:synthetic alpha'], '二度だけ引く');
});

test('片方が存在しなくても、もう片方だけで結果を出す', async () => {
  reset({ 'female:synthetic beta': [5, 4] });
  const ids = await svc.__testListIds('either:synthetic_beta', 'added');
  assert.deepEqual(ids, [5, 4]);
});

test('他の絞り込み (言語など) は開いた両方に効く', async () => {
  // 鍵は型名で並べ替えてある (language < male)
  reset({
    'female:synthetic alpha language:japanese': [3, 2],
    'language:japanese male:synthetic alpha': [2, 1],
  });
  const ids = await svc.__testListIds('either:synthetic_alpha language:japanese', 'added');
  assert.deepEqual(ids, [3, 2, 1]);
  assert.equal(calls.length, 2);
  for (const key of calls) assert.ok(key.includes('language:japanese'), '言語の縛りが落ちない');
});

test('either が無いときは今までどおり一度だけ引く', async () => {
  reset({ 'female:synthetic alpha': [1] });
  const ids = await svc.__testListIds('female:synthetic_alpha', 'added');
  assert.deepEqual(ids, [1]);
  assert.equal(calls.length, 1, '開かない語で往復を増やさない');
});

test('either が二つでも 4 通りで打ち切る (往復を増やしすぎない)', async () => {
  reset({
    'female:synthetic alpha female:synthetic beta': [1],
    'female:synthetic alpha male:synthetic beta': [2],
    'female:synthetic beta male:synthetic alpha': [3],
    'male:synthetic alpha male:synthetic beta': [4],
  });
  const ids = await svc.__testListIds('either:synthetic_alpha either:synthetic_beta', 'added');
  assert.equal(calls.length, 4, '2 語なら 2x2');
  assert.deepEqual(ids, [1, 2, 3, 4]);
});

test('否定された either は開かない (取りこぼしを増やさないため落とす)', async () => {
  reset({ 'female:synthetic alpha': [1] });
  const ids = await svc.__testListIds('female:synthetic_alpha -either:synthetic_beta', 'added');
  assert.deepEqual(ids, [1]);
  assert.equal(calls.length, 1);
});
