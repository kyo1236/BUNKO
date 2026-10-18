'use strict';
// 日本語で引いた時に「別人が出ない」「有名作が出る」「出た名前がそのまま画面に出る」
// を守る試験。配布する辞書そのもの (aliases.json / label-overrides.json /
// search-vocabulary.json) を読む。合成データではない。
//
// 守る線:
//   1. フルネーム (白洲アズサ) で無関係な同名 (azusa_nakano 等) を出さない
//   2. 短い名 (アズサ) は曖昧なまま出す。ただし別人を見分けられる札を付ける
//   3. 下の名前だけの前方一致を exact へ昇格させない (朝田詩乃 → sinon_kouzuki)
//   4. 有名作 (名探偵コナン・僕のヒーローアカデミア) が日本語で引けて日本語で出る
//   5. 表示専用の上書き (label-overrides) が検索辞書からも引ける
//   6. 辞書を組み直しても 1〜3 が復活しない (build-aliases の単体試験)
const test = require('node:test');
const assert = require('node:assert/strict');
const aliases = require('../src/lib/search-aliases');
const vocab = require('../src/lib/search-vocabulary');
const engine = require('../src/lib/search-intent');
const raw = require('../src/lib/data/aliases.json');
const overrides = require('../src/lib/data/label-overrides.json');
const { tagNameKey } = require('../src/lib/title-keys');

const values = (list) => list.map((item) => item.value);
const suggest = (term, limit = 12) => values(aliases.suggestAliases(term, limit));
const pixivTag = (name) => ({ kind: 'tag', type: '', source: 'pixiv', name, native: {} });

// ---- 1. フルネームで別人を出さない -----------------------------------------

test('フルネームの白洲アズサは白洲アズサだけを指す', () => {
  const hits = suggest('白洲アズサ');
  assert.ok(hits.includes('character:azusa_shirasu'), `正しい候補が消えた: ${hits.join(', ')}`);
  for (const other of ['character:azusa_nakano', 'character:azusa_miura', 'character:azusa_azuki',
    'character:azusa_kashiwagi', 'character:azusa_hanai']) {
    assert.ok(!hits.includes(other), `別人 ${other} が候補に出る`);
  }
  // hitomi は同じ人物を `azusa` と `azusa shirasu` の二つの語で持っている。
  // 二つ出るのは構わないが、姓が二つ以上あれば別人が混ざっている
  const surnames = new Set(hits.map((value) => value.split(':')[1].split('_').slice(1).join('_')).filter(Boolean));
  assert.deepEqual([...surnames], ['shirasu'], `別人の姓が混ざっている: ${hits.join(', ')}`);
});

test('綾野珪子と朝田詩乃は別人へ紐付かない', () => {
  for (const wrong of ['character:silica_lunea', 'character:silica_the_s-rank_mage']) {
    assert.ok(!values(aliases.lookup('綾野珪子')).includes(wrong), `綾野珪子 が ${wrong} を指す`);
    assert.ok(!suggest('綾野珪子').includes(wrong), `綾野珪子 の候補に ${wrong} が出る`);
  }
  const shino = aliases.uniqueLookup('朝田詩乃');
  assert.notEqual(shino && shino.value, 'character:sinon_kouzuki');
  assert.ok(!suggest('朝田詩乃').includes('character:sinon_kouzuki'), '朝田詩乃 の候補に sinon_kouzuki が出る');
});

// ---- 2. 曖昧な短名は曖昧なまま。ただし見分けが付く ---------------------------

test('短い名アズサは複数出したうえで別人を見分けられる', () => {
  const hits = aliases.suggestAliases('アズサ', 12).filter((item) => item.type === 'character');
  assert.ok(hits.length >= 3, `曖昧な名が潰れている: ${JSON.stringify(values(hits))}`);
  assert.equal(aliases.uniqueLookup('アズサ'), null, '曖昧な名を勝手に一人へ倒している');
  // 別人が同じ札で並ばないこと。姓が違えば札も違っていなければ見分けが付かない
  const byLabel = new Map();
  for (const item of hits) {
    const surname = item.name.split('_').slice(1).join('_');
    if (!byLabel.has(item.label)) byLabel.set(item.label, new Set());
    byLabel.get(item.label).add(surname);
  }
  for (const [label, surnames] of byLabel) {
    const named = [...surnames].filter(Boolean);
    assert.ok(named.length <= 1, `札「${label}」に別人が並んでいる: ${[...surnames].join(', ')}`);
  }
  // 正式名で見分けが付くこと (下の名前だけの札が並ぶ状態に戻っていない)
  for (const expected of ['三浦あずさ', '柏木梓', '白洲アズサ']) {
    assert.ok(hits.some((item) => item.label === expected), `${expected} が候補の札に出ない`);
  }
});

// ---- 3. 前方一致を exact へ昇格させない (辞書の構造不変条件) -----------------

test('同じ別名一式が複数の人物へ複写されていない', () => {
  // 数え方は番人 (scripts/rebuild-aliases.js) と同じ関数を呼ぶ。二度書くと
  // 片方だけ緩めた時に、番人は黙っているのに辞書は壊れている状態になる
  const { copiedLabelFamilies } = require('../scripts/build-aliases');
  const families = copiedLabelFamilies(raw.entries);
  assert.deepEqual(families, [], `下の名前だけで同一視した組が残っている: ${JSON.stringify(families.slice(0, 5))}`);
});

// ---- 4. 有名作が日本語で引けて日本語で出る -----------------------------------

const FAMOUS = [
  ['名探偵コナン', 'series:detective_conan'],
  ['ヒロアカ', 'series:my_hero_academia'],
  ['ハイキュー!!', 'series:haikyuu'],
  ['けいおん', 'series:k-on'],
  ['僕のヒーローアカデミア', 'series:my_hero_academia'],
  ['ワンピース', 'series:one_piece'],
  ['鬼滅の刃', 'series:kimetsu_no_yaiba'],
  ['東方Project', 'series:touhou_project'],
  ['遊☆戯☆王', 'series:yu-gi-oh'],
];

test('有名作は日本語の正式名で補完に出る', () => {
  for (const [term, value] of FAMOUS) {
    assert.ok(suggest(term).includes(value), `${term} が候補に出ない`);
  }
});

test('有名作は日本語の正式名で検索条件へ解ける', () => {
  for (const [term, value] of FAMOUS) {
    assert.equal(aliases.rewriteQuery(term).query, value, `${term} が ${value} に解けない`);
  }
});

test('詳細画面へ出る表示名は日本語の正式名になる', () => {
  const expected = [
    ['series:my_hero_academia', '僕のヒーローアカデミア'],
    ['series:detective_conan', '名探偵コナン'],
    ['series:one_piece', 'ワンピース'],
  ];
  for (const [value, label] of expected) {
    const described = aliases.describeTerm(value);
    assert.ok(described, `${value} を説明できない`);
    assert.equal(described.label, label, `${value} の表示名が ${described.label}`);
  }
});

// ---- 5. 三つの辞書が同じ語彙を指す -------------------------------------------

test('表示専用の上書きは検索辞書からも引ける', () => {
  const missing = [];
  for (const [key, label] of Object.entries(overrides)) {
    const space = key.indexOf(' ');
    if (space < 1) continue;
    const type = key.slice(0, space).toLowerCase();
    const value = `${type}:${tagNameKey(key.slice(space + 1)).replace(/ /g, '_')}`;
    if (!values(aliases.lookup(label)).includes(value)) missing.push(`${label} -> ${value}`);
  }
  assert.deepEqual(missing.slice(0, 10), [], `上書きした表示名 ${missing.length} 件が入力で引けない`);
});

test('pixiv で選んだ有名作は hitomi の series へ移る', () => {
  for (const [term, value] of FAMOUS) {
    const resolved = vocab.resolve(pixivTag(term), 'hitomi');
    assert.equal(resolved.status, 'resolved', `${term} が ${resolved.status} (${resolved.reason})`);
    assert.equal(resolved.value.type, 'series');
    assert.equal(resolved.value.name.replace(/ /g, '_'), value.split(':')[1]);
  }
});

test('hitomi から pixiv へ戻すと日本語の語で引きに行く', () => {
  for (const [term, value] of FAMOUS) {
    const [type, name] = [value.split(':')[0], value.split(':')[1].replace(/_/g, ' ')];
    const hitomiTerm = { kind: 'tag', type, source: 'hitomi', name, native: {} };
    const back = vocab.resolve(hitomiTerm, 'pixiv');
    assert.equal(back.status, 'resolved', `${term} の逆向きが ${back.status} (${back.reason})`);
    // pixiv は日本語で引くサイト。下線付きの英語を送ると黙って 0 件になる
    const intent = { version: 1, source: 'hitomi', query: value, terms: [{ ...hitomiTerm, raw: value, negative: false, resolutions: { pixiv: back } }] };
    const plan = engine.compile(intent, 'pixiv');
    assert.ok(/[぀-ヿ一-鿿]/.test(plan.query), `pixiv へ英語のまま出ている: ${plan.query}`);
  }
});

test('元のサイトへ戻ると条件はそのまま', () => {
  const [item] = engine.normalizeSuggestions([{ type: 'tag', name: '名探偵コナン' }], 'pixiv');
  const intent = engine.parse('名探偵コナン', 'pixiv', { selections: { 'pixiv:名探偵コナン': item.term } });
  const toHitomi = engine.compile(intent, 'hitomi', {
    target: 'hitomi',
    resolutions: { 'pixiv:名探偵コナン': vocab.resolve(pixivTag('名探偵コナン'), 'hitomi') },
  });
  assert.equal(toHitomi.blocked, false, `hitomi へ移れない: ${JSON.stringify(toHitomi.unresolved)}`);
  assert.equal(toHitomi.query, 'series:detective_conan');
  assert.equal(engine.compile(intent, 'pixiv').query, '名探偵コナン');
});

// ---- 6. 既存の検索を壊していない ---------------------------------------------

test('引用符付きの除外も印を落とさない', () => {
  assert.equal(aliases.rewriteQuery('-"ふたなり"').query, '-female:futanari');
  assert.equal(aliases.rewriteQuery('winter -ふたなり').query, 'winter -female:futanari');
});

test('自由語・除外条件・作者検索は今まで通り', () => {
  assert.equal(aliases.rewriteQuery('winter コミケ').query.includes('winter'), true);
  const negated = aliases.rewriteQuery('-ふたなり');
  assert.match(negated.query, /^-/, `除外の印が消えた: ${negated.query}`);
  assert.equal(aliases.rewriteQuery('artist:shindol').query, 'artist:shindol');
  assert.equal(aliases.uniqueLookup('日本語').value, 'language:japanese');
});

// ---- 7. 組み直しても復活しない (生成側の単体試験) ----------------------------

test('辞書の生成は前方一致を当たりに昇格させない', () => {
  const build = require('../scripts/build-aliases');
  const rows = [
    ['azusa azuki', 79, 'character'],
    ['azusa miura', 510, 'character'],
    ['azusa nakano', 1040, 'character'],
    ['azusa shirasu', 195, 'character'],
  ];
  assert.equal(build.pickExact(rows, 'azusa', 'character'), null, '前方一致の複数を当たりにしている');
  assert.equal(build.pickExact([['sinon kouzuki', 1, 'character']], 'sinon', 'character'), null,
    '前方一致が一件だけの時に当たりへ昇格している');
  const exact = build.pickExact(rows, 'azusa shirasu', 'character');
  assert.equal(exact && exact.value, 'character:azusa_shirasu');
});

test('姓名の並び替えは完全一致だけを当たりにする', () => {
  const build = require('../scripts/build-aliases');
  assert.deepEqual(build.candidateNames({ name: 'shirasu_azusa', category: 4 }), ['shirasu azusa', 'azusa shirasu']);
  assert.deepEqual(build.candidateNames({ name: 'azusa_(blue_archive)', category: 4 }), ['azusa (blue archive)', 'azusa']);
});
