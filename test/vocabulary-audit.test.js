'use strict';
// 横断語彙の候補 3,211 件に監査 (work/vocabulary-research/audit/) を当てて取り込んだ
// 結果の特性試験。配布する search-vocabulary.json そのものを読む。
//
// 守る線:
//   - 中国語表記 (高坂穗乃果・蠟筆小新) は入力にも札にも出ない
//   - pixiv で別の意味が主流な語 (ワームホール) を黙って hitomi のジャンルに倒さない
//   - pixiv の常用タグと同名の作者 (添い寝) を作者に化けさせない
//   - 正式名 (高坂穂乃果・暁美ほむら) は exact で引ける
//   - 逆向き (hitomi → pixiv) の札は一つに決まる。無いと既存の別名表まで塞ぐ
const test = require('node:test');
const assert = require('node:assert/strict');
const vocab = require('../src/lib/search-vocabulary');
const aliases = require('../src/lib/search-aliases');
const data = require('../src/lib/data/search-vocabulary.json');
const { decide, recheckAuto, parseCsv } = require('../scripts/apply-vocabulary-audit');

const pixivTag = (name) => ({ kind: 'tag', type: '', source: 'pixiv', name, native: {} });
const inputNames = () => data.entries.flatMap((entry) => entry.inputs.map((input) => input.name));
const labels = () => data.entries.flatMap((entry) => Object.values(entry.outputs || {}).map((out) => out && out.label).filter(Boolean));

test('監査で落とした中国語表記は入力にも札にも残らない', () => {
  for (const zh of ['高坂穗乃果', '蠟筆小新', '宇智波佐助', '幻兽帕鲁', '多多良小伞', '博麗靈夢']) {
    assert.ok(!inputNames().includes(zh), `${zh} が入力に残っている`);
    assert.ok(!labels().includes(zh), `${zh} が札に残っている`);
  }
  assert.equal(vocab.resolve(pixivTag('高坂穗乃果'), 'hitomi').status, 'unmapped');
});

test('正式名は exact で引け、逆向きの札は日本語の正式表記になる', () => {
  const honoka = vocab.resolve(pixivTag('高坂穂乃果'), 'hitomi');
  assert.equal(honoka.status, 'resolved');
  assert.deepEqual([honoka.value.type, honoka.value.name], ['character', 'honoka kosaka']);
  const back = vocab.resolve({ kind: 'tag', type: 'character', source: 'hitomi', name: 'honoka kosaka', native: {} }, 'pixiv');
  assert.equal(back.status, 'resolved');
  assert.equal(back.value.name, '高坂穂乃果');
  assert.equal(vocab.resolve(pixivTag('暁美ほむら'), 'hitomi').value.name, 'homura akemi');
  // script 判定の誤認で外れていた正しい日本語も戻っている
  assert.equal(vocab.resolve(pixivTag('七瀬遥'), 'hitomi').value.name, 'haruka nanase');
});

test('別の意味が主流な語は候補どまりか未対応で、黙って倒さない', () => {
  // 守るのは「内容タグ (ジャンル) へ黙って倒さない」線。外した語が当たっても
  // 結果はそれらしく見えてしまい、間違いに気付けないため
  for (const name of ['ワームホール', 'キャプション']) {
    assert.notEqual(vocab.resolve(pixivTag(name), 'hitomi').status, 'resolved', name);
  }
  // 「レジェンズ」は 2026-09-21 の人物・作品の網羅で series:legendz が入り、
  // 一意に引けるようになった。ここは倒してよいと判断した:
  //   - 監査時の分類も反証も exact (「同じ作品の英題とカタカナ表記」) と出ている
  //     (work/vocabulary-research/candidates.jsonl の c-54f64751dd72)
  //   - hitomi に 64 冊、nhentai に 2 冊。実在を確かめてある
  //   - 作品名は外しても「レジェンズの 64 冊」と名前が出るので気付ける。
  //     ジャンルを外した時のような「それらしく見える誤り」にならない
  assert.equal(vocab.resolve(pixivTag('レジェンズ'), 'hitomi').status, 'resolved');
  const eat = vocab.resolve(pixivTag('共食い'), 'hitomi');
  assert.equal(eat.status, 'ambiguous');
  assert.ok(eat.candidates.some((row) => row.name === 'cannibalism'));
  assert.equal(vocab.resolve(pixivTag('カニバリズム'), 'hitomi').status, 'resolved');
});

test('常用タグと同名の作者は別名表に載せず、名乗りが揃った作者だけ一意に引ける', () => {
  for (const word of ['添い寝', '十五夜', '左利き', 'お久しぶり']) {
    assert.ok(!aliases.lookup(word).some((row) => row.type === 'artist'), `${word} が作者に化ける`);
  }
  assert.equal(aliases.rewriteQuery('添い寝').query, '添い寝');
  const author = vocab.resolve({ kind: 'author', type: 'artist', source: 'pixiv', name: 'なかじまゆか', native: {} }, 'hitomi');
  assert.equal(author.status, 'resolved');
  assert.equal(author.value.name, 'nakajima yuka');
});

test('略称は exact で引けるが、逆向きの札は正式題名一つに決まる (nhentai は parody)', () => {
  for (const name of ['こち亀', 'こちら葛飾区亀有公園前派出所']) {
    assert.equal(vocab.resolve(pixivTag(name), 'hitomi').value.name, 'kochikame', name);
    assert.equal(vocab.resolve(pixivTag(name), 'nhentai').value.type, 'parody', name);
  }
  const back = vocab.resolve({ kind: 'tag', type: 'series', source: 'hitomi', name: 'kochikame', native: {} }, 'pixiv');
  assert.equal(back.status, 'resolved');
  assert.equal(back.value.name, 'こちら葛飾区亀有公園前派出所');
});

test('取り込んだ entry は必ず pixiv の札を持つ (無いと既存の別名表まで塞ぐ)', () => {
  for (const entry of data.entries) {
    if (!entry.outputs || !entry.outputs.hitomi) continue;
    assert.ok(entry.outputs.pixiv && entry.outputs.pixiv.name, `${entry.id} に pixiv の札が無い`);
    assert.ok(entry.inputs.some((input) => input.relation === 'exact'), `${entry.id} に exact の入力が無い`);
  }
  // 版は catalog.js が「札を取り込み直すか」を決める鍵なので、中身を変えたら必ず上げる。
  // -5-crosssite は、hitomi と nhentai で綴りが違う 23 件に行き先ごとの名前を
  // 持たせた回 (玉藻の前 = hitomi "tamamo no mae" / nhentai "tamamo-no-mae")
  assert.equal(data.revision, '2026-09-21-vocabulary-5-crosssite');
  assert.ok(data.sources.some((source) => source.id === 'ehtag-translation'), 'EhTag の出典が無い');
});

test('監査の判定は機械的に当たる: unmapped と保留は落ち、戻した exact は作った側の規則で検め直す', () => {
  const audit = new Map(parseCsv('id,current_relation,your_relation,severity,reason\nc-1,exact,unmapped,high,x\nc-2,exact,判断保留,,x\nc-3,related,exact,low,x\nc-4,exact,broader,low,x\n')
    .map((row) => [row.id, row]));
  const row = (id, extra) => ({
    id, termKind: 'character', relation: 'exact', autoConvertible: true, script: 'japanese-kana', evidenceTier: 'B',
    input: { site: 'pixiv', type: 'tag', text: 'みほん' }, outputs: [{ site: 'hitomi', namespace: 'character', canonical: 'sample' }],
    verification: { hitomi: { status: 'confirmed' }, pixiv: { status: 'unchecked' } }, review: { classifier: { collisionRisk: 'low' } }, ...extra,
  });
  assert.equal(decide(row('c-1'), audit).drop, 'audit-unmapped');
  assert.equal(decide(row('c-2'), audit).drop, 'audit-held');
  assert.deepEqual(decide(row('c-3', { relation: 'related', autoConvertible: false }), audit), { relation: 'exact', auto: true, promoted: true });
  assert.deepEqual(decide(row('c-4'), audit), { relation: 'broader', auto: false, promoted: false });
  // 戻しても、かなも百科の記事も無い漢字だけの語は自動には回さない
  assert.equal(recheckAuto(row('c-5', { script: 'kanji-only', input: { site: 'pixiv', type: 'tag', text: '見本' } })), false);
  assert.equal(decide(row('c-6', { termKind: 'artist', relation: 'related' }), audit).drop, 'candidate-person');
});
