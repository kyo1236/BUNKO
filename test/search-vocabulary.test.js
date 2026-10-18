'use strict';

// サイトをまたぐ語の言い換えの規則。語は合成 (「眼鏡/メガネ/glasses」だけは
// 設計書に出ている公開の例)。
//
// 押さえるのは「勝手に決めない」こと: 完全一致と確かめた対応だけ自動で移し、
// 意味がずれうる物は候補に留め、行き先に無い物は無いと返す。
// 黙って別の語へ倒すのが一番まずい (0 件の検索が成功に見える)。

const test = require('node:test');
const assert = require('node:assert/strict');
const { aliasKey } = require('../src/lib/search-text');
const searchVocabulary = require('../src/lib/search-vocabulary.js');

const { createVocabulary } = searchVocabulary;

// 既存の別名表の代わり。describeTerm と同じ約束 (一つに定まる時だけ行を返す)
function dictionary(rows) {
  const keysOf = (row) => [row.name, ...(row.keys || [])].filter(Boolean);
  const hits = (name) => rows.filter((row) => keysOf(row).some((key) => aliasKey(key) === aliasKey(name)));
  const describe = (raw) => {
    const typed = /^(-)?([a-z]+):(.+)$/.exec(String(raw || ''));
    const type = typed ? typed[2] : '';
    const name = (typed ? typed[3] : String(raw || '')).replace(/_/g, ' ');
    const found = hits(name).filter((row) => !type || row.type === type
      || (type === 'tag' && ['male', 'female', 'tag', 'either'].includes(row.type)));
    if (found.length !== 1) return null;
    return { type: found[0].type, name: found[0].name, label: found[0].label || '', aliases: found[0].keys || [] };
  };
  return { describe, lookup: (name) => hits(name).map((row) => ({ ...row })) };
}

const tag = (extra) => ({ kind: 'tag', type: 'tag', name: '', source: 'pixiv', negative: false, native: {}, ...extra });
const entry = (id, inputs, outputs, evidence) => ({ id, inputs, outputs, evidence });

const GLASSES = entry(
  'v-glasses',
  [{ site: 'pixiv', type: 'tag', name: '眼鏡', relation: 'exact' }],
  { hitomi: { type: 'either', name: 'glasses', label: 'メガネ' }, nhentai: { type: 'tag', name: 'glasses' } },
  [{ url: 'https://example.test/glasses', checkedAt: '2026-09-21', method: 'manual' }],
);

test('compound aliases must not become either just because both namespaces exist',()=>{
  const vocab=createVocabulary({entries:[],...dictionary([
    {type:'male',name:'glasses',label:'眼鏡',keys:['黒髪眼鏡']},
    {type:'female',name:'glasses',label:'眼鏡',keys:['黒髪眼鏡']},
  ])});
  assert.equal(vocab.resolve(tag({name:'黒髪眼鏡'}),'hitomi').status,'ambiguous');
  const male=vocab.resolve(tag({type:'male',name:'黒髪眼鏡'}),'hitomi');
  assert.equal(male.status,'ambiguous');
  assert.ok(male.candidates.every(row=>row.type==='male'));
});

test('自由語とサイト固有の書き方は触らない (辞書に当たっても語彙へ昇格させない)', () => {
  const vocab = createVocabulary({ entries: [GLASSES], ...dictionary([]) });

  const free = vocab.resolve({ kind: 'text', name: '眼鏡', raw: '眼鏡', source: 'pixiv', native: {} }, 'hitomi');
  assert.equal(free.status, 'passthrough');
  assert.equal(free.value, undefined, '自由語に値を付けない');

  const native = vocab.resolve({ kind: 'native', raw: 'user:123', source: 'pixiv', native: { pixiv: 'user:123' } }, 'hitomi');
  assert.equal(native.status, 'passthrough');
});

test('行き先の原文を持っていればそのまま返す (往復で元の条件が戻る)', () => {
  const vocab = createVocabulary({ entries: [GLASSES], ...dictionary([]) });

  const roundTrip = vocab.resolve(tag({ name: '眼鏡', native: { hitomi: 'female:glasses' } }), 'hitomi');
  assert.equal(roundTrip.status, 'passthrough', '訳し直さずに原文を使わせる');

  const sameSite = vocab.resolve(tag({ source: 'hitomi', type: 'female', name: 'glasses' }), 'hitomi');
  assert.equal(sameSite.status, 'passthrough');
});

test('取り込み済みの完全一致はサイトと型を落とさない', () => {
  const vocab = createVocabulary({ entries: [GLASSES], ...dictionary([]) });

  const hit = vocab.resolve(tag({ source: 'pixiv', name: '眼鏡' }), 'hitomi');
  assert.equal(hit.status, 'resolved');
  assert.deepEqual(hit.value, { type: 'either', name: 'glasses', label: 'メガネ' });
  assert.equal(hit.evidence[0].url, 'https://example.test/glasses', '根拠を持ち回る');

  // 同じ字でも出どころが違えば当たらない (pixiv の語として取り込んであるため)
  const otherSite = vocab.resolve(tag({ source: 'nhentai', name: '眼鏡' }), 'hitomi');
  assert.equal(otherSite.status, 'passthrough');

  // 型が違えば当たらない。character:眼鏡 を female:glasses にしない
  const otherType = vocab.resolve(tag({ source: 'pixiv', type: 'character', name: '眼鏡' }), 'hitomi');
  assert.notEqual(otherType.status, 'resolved');

  // 表記ゆれ (全角・かな) は吸収する
  const wide = vocab.resolve(tag({ source: 'pixiv', name: ' 眼鏡 ' }), 'hitomi');
  assert.equal(wide.status, 'resolved');
});

test('完全一致でも行き先の語が複数なら候補どまり (先頭を勝手に選ばない)', () => {
  const entries = [
    entry('v-a', [{ site: 'pixiv', type: 'tag', name: '合成語', relation: 'exact' }], { hitomi: { type: 'female', name: 'synthetic_a' } }),
    entry('v-b', [{ site: 'pixiv', type: 'tag', name: '合成語', relation: 'exact' }], { hitomi: { type: 'female', name: 'synthetic_b' } }),
  ];
  const vocab = createVocabulary({ entries, ...dictionary([]) });

  const result = vocab.resolve(tag({ name: '合成語' }), 'hitomi');
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.value, undefined);
  assert.deepEqual(result.candidates.map((item) => item.name), ['synthetic_a', 'synthetic_b']);
});

test('行き先に語が無いのは「対応なし」であって 0 件ではない', () => {
  const entries = [entry('v-only-nh', [{ site: 'pixiv', type: 'tag', name: '合成無', relation: 'exact' }], { nhentai: { type: 'tag', name: 'synthetic_none' } })];
  const vocab = createVocabulary({ entries, ...dictionary([]) });

  assert.equal(vocab.resolve(tag({ name: '合成無' }), 'hitomi').status, 'unmapped');
  assert.equal(vocab.resolve(tag({ name: '合成無' }), 'nhentai').status, 'resolved');
});

test('広い意味・関連の対応は自動で移さず候補にする', () => {
  const broader = entry('v-broad', [{ site: 'pixiv', type: 'tag', name: '合成広', relation: 'broader' }], { hitomi: { type: 'female', name: 'synthetic_broad' } });
  const related = entry('v-rel', [{ site: 'pixiv', type: 'tag', name: '合成関', relation: 'related' }], { hitomi: { type: 'female', name: 'synthetic_rel' } });
  const vocab = createVocabulary({ entries: [broader, related], ...dictionary([]) });

  const wide = vocab.resolve(tag({ name: '合成広' }), 'hitomi');
  assert.equal(wide.status, 'ambiguous');
  assert.deepEqual(wide.candidates.map((item) => item.name), ['synthetic_broad']);
  assert.equal(vocab.resolve(tag({ name: '合成関' }), 'hitomi').status, 'ambiguous');

  // 同じ形でも relation:'exact' なら自動で移る
  const exact = createVocabulary({
    entries: [entry('v-exact', [{ site: 'pixiv', type: 'tag', name: '合成広', relation: 'exact' }], { hitomi: { type: 'female', name: 'synthetic_broad' } })],
    ...dictionary([]),
  });
  assert.equal(exact.resolve(tag({ name: '合成広' }), 'hitomi').status, 'resolved');
});

test('逆向きは出力の完全一致だけ。男女を either へ丸めた物は候補どまり', () => {
  const entries = [
    entry('v-rev', [{ site: 'pixiv', type: 'tag', name: '合成逆', relation: 'exact' }], {
      hitomi: { type: 'female', name: 'synthetic_rev' },
      pixiv: { type: 'tag', name: '合成逆' },
    }),
    entry('v-either', [{ site: 'pixiv', type: 'tag', name: '合成両', relation: 'exact' }], {
      hitomi: { type: 'either', name: 'synthetic_either' },
      pixiv: { type: 'tag', name: '合成両' },
    }),
  ];
  const vocab = createVocabulary({ entries, ...dictionary([]) });

  const back = vocab.resolve(tag({ source: 'hitomi', type: 'female', name: 'synthetic_rev' }), 'pixiv');
  assert.equal(back.status, 'resolved');
  assert.equal(back.value.name, '合成逆');

  // male:… を either:… の行と同じ物とは決めない (性別の指定を消さない)
  const loose = vocab.resolve(tag({ source: 'hitomi', type: 'male', name: 'synthetic_either' }), 'pixiv');
  assert.equal(loose.status, 'ambiguous');
  assert.deepEqual(loose.candidates.map((item) => item.name), ['合成両']);
});

test('既存の別名表は「正準の値か、選ばれた札と同じ字」の時だけ移す', () => {
  const rows = [{ type: 'female', name: 'glasses', label: 'メガネ', keys: ['メガネ', '眼鏡', '眼鏡男子', '黒髪眼鏡'], count: 40999 }];
  const vocab = createVocabulary({ entries: [], ...dictionary(rows) });

  const label = vocab.resolve(tag({ source: 'pixiv', name: 'メガネ' }), 'hitomi');
  assert.equal(label.status, 'resolved');
  assert.deepEqual(label.value, { type: 'female', name: 'glasses', label: 'メガネ' });

  const canonical = vocab.resolve(tag({ source: 'hitomi', type: 'female', name: 'glasses' }), 'nhentai');
  assert.equal(canonical.status, 'resolved', '正準の値をそのまま入力した時は迷わない');

  // 「眼鏡男子」は「メガネ」と同じ意味ではない。別名表に載っていても自動では倒さない
  const narrowed = vocab.resolve(tag({ source: 'pixiv', name: '眼鏡男子' }), 'hitomi');
  assert.equal(narrowed.status, 'ambiguous');
  assert.equal(narrowed.value, undefined);
  assert.deepEqual(narrowed.candidates, [{ type: 'female', name: 'glasses', label: 'メガネ' }]);
  assert.equal(vocab.resolve(tag({ source: 'pixiv', name: '黒髪眼鏡' }), 'hitomi').status, 'ambiguous');
});

test('手で選んだ別名 (preferred) だけは完全一致として扱う', () => {
  const row = { type: 'female', name: 'synthetic_pick', label: '合成札', keys: ['合成め', '合成札'] };
  const loose = createVocabulary({ entries: [], ...dictionary([{ ...row }]) });
  assert.equal(loose.resolve(tag({ name: '合成め' }), 'hitomi').status, 'ambiguous', '札と違う字は候補どまり');

  const picked = createVocabulary({ entries: [], ...dictionary([{ ...row, preferred: true }]) });
  const result = picked.resolve(tag({ name: '合成め' }), 'hitomi');
  assert.equal(result.status, 'resolved');
  assert.equal(result.value.name, 'synthetic_pick');
});

test('男女で同じ語は片方へ狭めない。明示された性別は消さない', () => {
  const pair = [
    { type: 'female', name: 'synthetic_pair', label: '合成対', keys: ['合成対'], count: 20 },
    { type: 'male', name: 'synthetic_pair', label: '合成対', keys: ['合成対'], count: 10 },
  ];
  const vocab = createVocabulary({ entries: [], ...dictionary(pair) });

  const either = vocab.resolve(tag({ source: 'pixiv', name: '合成対' }), 'hitomi');
  assert.equal(either.status, 'resolved');
  assert.deepEqual(either.value, { type: 'either', name: 'synthetic_pair', label: '合成対' });

  // either を書けない行き先では丸めず候補のまま出す
  const elsewhere = vocab.resolve(tag({ source: 'pixiv', name: '合成対' }), 'nhentai');
  assert.equal(elsewhere.status, 'ambiguous');
  assert.deepEqual(elsewhere.candidates.map((item) => item.type), ['female', 'male']);

  // 女と明示した語は女のまま。either へ広げない
  const explicit = vocab.resolve(tag({ source: 'hitomi', type: 'female', name: 'synthetic_pair' }), 'nhentai');
  assert.equal(explicit.status, 'resolved');
  assert.equal(explicit.value.type, 'female');

  // 男女で別の語なら「どちらでもよい」ではない。候補のまま
  const distinct = createVocabulary({
    entries: [],
    ...dictionary([
      { type: 'female', name: 'synthetic_f', label: '合成別', keys: ['合成別'] },
      { type: 'male', name: 'synthetic_m', label: '合成別', keys: ['合成別'] },
    ]),
  });
  assert.equal(distinct.resolve(tag({ source: 'pixiv', name: '合成別' }), 'hitomi').status, 'ambiguous');
});

test('pixiv 行きは日本語の札が要る (英語の下線語を黙って出さない)', () => {
  const bare = createVocabulary({ entries: [], ...dictionary([{ type: 'female', name: 'synthetic_bare', label: '', keys: ['synthetic_bare'] }]) });
  assert.equal(bare.resolve(tag({ source: 'hitomi', type: 'female', name: 'synthetic_bare' }), 'pixiv').status, 'unmapped');

  const named = createVocabulary({ entries: [], ...dictionary([{ type: 'female', name: 'synthetic_bare', label: '合成名', keys: ['synthetic_bare', '合成名'] }]) });
  const result = named.resolve(tag({ source: 'hitomi', type: 'female', name: 'synthetic_bare' }), 'pixiv');
  assert.equal(result.status, 'resolved');
  assert.equal(result.value.label, '合成名', '日本語の札を持たせて渡す');
});

test('対応の無い語: pixiv 由来は対応なし、型付きのタグは今まで通り写す', () => {
  const vocab = createVocabulary({ entries: [], ...dictionary([]) });

  // `tag:日本語` を当てずっぽうに送ると黙って 0 件になる (設計の「おしっこ」)
  assert.equal(vocab.resolve(tag({ source: 'pixiv', name: '合成未知' }), 'hitomi').status, 'unmapped');

  // 型付きのタグはアダプタが各サイトの構文へ写せる。ここで止めない
  assert.equal(vocab.resolve(tag({ source: 'hitomi', type: 'female', name: 'synthetic_unknown' }), 'nhentai').status, 'passthrough');
});

test('作者は別名表が一人に定まる時だけ。表示名や番号で同一視しない', () => {
  const vocab = createVocabulary({
    entries: [],
    ...dictionary([{ type: 'artist', name: 'synthetic maker', label: '合成作家', keys: ['合成作家'] }]),
  });

  const found = vocab.resolve({ kind: 'author', type: 'artist', name: '合成作家', source: 'pixiv', negative: false, native: {} }, 'hitomi');
  assert.equal(found.status, 'resolved');
  assert.deepEqual(found.value, { type: 'artist', name: 'synthetic maker', label: '合成作家' });

  // 同じ表示名が二人いるなら決めない
  const twins = createVocabulary({
    entries: [],
    ...dictionary([
      { type: 'artist', name: 'synthetic one', label: '合成同名', keys: ['合成同名'] },
      { type: 'artist', name: 'synthetic two', label: '合成同名', keys: ['合成同名'] },
    ]),
  });
  assert.equal(twins.resolve({ kind: 'author', type: 'artist', name: '合成同名', source: 'pixiv', native: {} }, 'hitomi').status, 'passthrough');

  // 番号は名前ではない。作者の同一性はここで決めない
  assert.equal(vocab.resolve({ kind: 'author', type: 'artist', name: '12345678', source: 'pixiv', native: {} }, 'hitomi').status, 'passthrough');
});

test('取り込みファイルがまだ無くても動く。版を名乗れる', () => {
  assert.equal(typeof searchVocabulary.revision, 'string');
  assert.equal(createVocabulary({ revision: '2026-09-21a' }).revision, '2026-09-21a');
  assert.equal(createVocabulary().revision, '');

  // 既定の口 (既存の別名表だけ) でも落ちない
  const free = searchVocabulary.resolve({ kind: 'text', name: '合成自由語', raw: '合成自由語', source: 'pixiv', native: {} }, 'hitomi');
  assert.equal(free.status, 'passthrough');
  const unknown = searchVocabulary.resolve(tag({ source: 'hitomi', type: 'female', name: 'synthetic_absent_term' }), 'nhentai');
  assert.ok(['resolved', 'ambiguous', 'unmapped', 'passthrough'].includes(unknown.status));
});
