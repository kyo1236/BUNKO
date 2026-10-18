'use strict';
// どのサイトでも候補は同じ形で出す、という線を守る試験。
//
//   主表示 = 日本語名 / 補助表示 = 種類 + 所属作品 / 件数 = そのサイト自身の数だけ
//
// 守る線:
//   1. ローマ字 (asuna / kaho) でも日本語名と所属作品で別人を見分けられる
//   2. 日本語で打っても同じ人物へ着く
//   3. 検索に送る値はサイトごと。hitomi の character: を pixiv へ素で送らない
//   4. pixiv の汎用タグを、名前が似ているだけで人物へ分類しない
//   5. 対応先を確かめられない語は「確定候補」にしない
//   6. 件数は他サイトから流用しない
//   7. VTuber は「作品」ではなく「所属事務所」を出す (VTuber (ホロライブ) / VTuber (個人))
//   8. hitomi に無く pixiv でだけ引ける語は、pixiv にだけ出す。検索語の書き換えには使わない
const test = require('node:test');
const assert = require('node:assert/strict');
const aliases = require('../src/lib/search-aliases');
const engine = require('../src/lib/search-intent');
const { decorate, fromDictionary } = require('../src/lib/search-decorate');

const SITES = ['hitomi', 'pixiv', 'nhentai'];
const compileOne = (term, site) => engine.compile(
  { version: 1, source: 'hitomi', query: '', terms: [{ ...term, kind: term.type === 'artist' ? 'author' : 'tag', raw: '', negative: false, native: {} }] },
  site,
).query;

// ---- 1. ローマ字でも見分けが付く -------------------------------------------

test('ローマ字の asuna は複数の人物を、日本語名と所属作品で見分けられる形で返す', () => {
  const { fromDictionary } = require('../src/lib/search-decorate');
  const rows = fromDictionary('asuna', 'hitomi', 12).filter((row) => row.type === 'character');
  assert.ok(rows.length >= 2, `asuna が一人に潰れている: ${JSON.stringify(rows.map((r) => r.value))}`);
  for (const row of rows) {
    assert.ok(/[぀-ヿ一-鿿]/.test(row.label), `${row.value} の主表示が日本語でない: ${row.label}`);
  }
  // 所属作品は、札そのものが名乗っている (アスナ(ブルアカ)) か、
  // 補助表示に出ている (ソードアート・オンライン) かのどちらか。
  // 同じ字を二度出さないので、両方に出ることはない
  const worksOf = (row) => row.seriesLabel || (String(row.label).match(/[(（]([^)）]+)[)）]/) || [])[1] || '';
  const named = rows.filter((row) => worksOf(row));
  assert.ok(named.length >= 2, `所属作品が分かる候補が足りない: ${JSON.stringify(rows.map((r) => [r.label, r.seriesLabel || '']))}`);
  for (const row of named) {
    assert.ok(!row.seriesLabel || !String(row.label).includes(row.seriesLabel),
      `札と補助表示に同じ作品名が並んでいる: ${row.label} / ${row.seriesLabel}`);
  }
  // 別人どうしは、札か所属か値のどれかで必ず分かれる
  const fingerprints = rows.map((row) => `${row.label}|${worksOf(row)}|${row.value}`);
  assert.equal(new Set(fingerprints).size, fingerprints.length, '見分けの付かない候補が並んでいる');
});

test('kaho もローマ字で引ける', () => {
  const rows = aliases.suggestAliases('kaho', 12).filter((row) => row.type === 'character');
  assert.ok(rows.length >= 1, 'kaho で候補が出ない');
  assert.ok(rows.every((row) => /[぀-ヿ一-鿿]/.test(row.label)), '主表示が日本語でない');
});

test('日本語の読みのローマ字でも引ける (meitantei / hiroaka)', () => {
  // hitomi の英語名は detective conan。日本語の読み (meitantei conan) は
  // danbooru の語名が持っているので、そちらも候補の索引に入れてある
  const { fromDictionary } = require('../src/lib/search-decorate');
  const cases = [
    ['meitantei', 'series:detective_conan'],
    ['meitanteiconan', 'series:detective_conan'],
    ['hiroaka', 'series:my_hero_academia'],
    ['bokunohero', 'series:my_hero_academia'],
    ['asadashino', 'character:shino_asada'],
    ['buruaka', 'series:blue_archive'],
  ];
  for (const [term, value] of cases) {
    const hits = aliases.suggestAliases(term, 12).map((row) => row.value);
    assert.ok(hits.includes(value), `${term} が ${value} に着かない: ${hits.join(', ')}`);
  }
  // どのサイトでも同じように引ける (送る値だけサイトごと)
  for (const site of SITES) {
    const rows = fromDictionary('meitantei', site, 8);
    assert.ok(rows.some((row) => /コナン/.test(row.label)), `${site} で meitantei が名探偵コナンに着かない`);
  }
});

test('ヘボン式でも訓令式でも同じ人物に着く', () => {
  for (const term of ['shirasu', 'sirasu']) {
    const hits = aliases.suggestAliases(term, 12).map((row) => row.value);
    assert.ok(hits.includes('character:azusa_shirasu'), `${term} が白洲アズサに着かない`);
  }
});

test('ローマ字は候補にだけ効き、自由語を勝手に書き換えない', () => {
  // byKey に混ぜると "sakura" のような普通の語が character: に化ける
  assert.equal(aliases.rewriteQuery('asuna').query, 'asuna');
  assert.equal(aliases.rewriteQuery('sakura winter').query, 'sakura winter');
});

// ---- 2. 日本語でも同じ人物へ着く -------------------------------------------

test('日本語で打っても同じ人物へ着く', () => {
  const romaji = aliases.suggestAliases('asuna', 12).map((row) => row.value);
  for (const [term, value] of [['結城明日奈', 'character:asuna_yuuki'], ['一之瀬アスナ', 'character:asuna_ichinose']]) {
    const hits = aliases.suggestAliases(term, 8).map((row) => row.value);
    assert.ok(hits.includes(value), `${term} が ${value} に着かない`);
    assert.ok(romaji.includes(value), `asuna の候補に ${value} が居ない`);
  }
});

// ---- 3. 検索に送る値はサイトごと ---------------------------------------------

test('同じ人物でも、送る値はサイトごとに変わる', () => {
  const term = { type: 'character', name: 'asuna yuuki', label: '結城明日奈' };
  const values = Object.fromEntries(SITES.map((site) => [site, compileOne(term, site)]));
  assert.equal(values.hitomi, 'character:asuna_yuuki');
  // pixiv は日本語の素の語で引く。型付きの英語を送ると黙って 0 件になる
  assert.equal(values.pixiv, '結城明日奈');
  assert.doesNotMatch(values.pixiv, /character:/, 'pixiv に hitomi の型付き語を送っている');
  assert.match(values.nhentai, /^character:/);
});

test('作品名も同じ (pixiv は日本語、nhentai は parody)', () => {
  const term = { type: 'series', name: 'detective conan', label: '名探偵コナン' };
  assert.equal(compileOne(term, 'hitomi'), 'series:detective_conan');
  assert.equal(compileOne(term, 'pixiv'), '名探偵コナン');
  assert.equal(compileOne(term, 'nhentai'), 'parody:detective_conan');
});

// ---- 4. 汎用タグを人物へ分類しない -------------------------------------------

test('pixiv の汎用タグは、名前が似ているだけで人物にしない', () => {
  // 「アスナ」は四人以上を指す。どれか一人へ寄せず、人物の札も所属作品も付けない
  const row = decorate({ type: 'tag', name: 'アスナ', label: 'アスナ' }, 'pixiv');
  assert.equal(row.seriesLabel || '', '', 'pixiv の曖昧なタグに所属作品を付けている');
  assert.equal(row.type, 'tag', '曖昧なタグを character に化かしている');
  // 内容タグは内容タグのまま。人物に化かさない
  const plain = decorate({ type: 'tag', name: 'ふたなり', label: 'ふたなり' }, 'pixiv');
  assert.notEqual(plain.type, 'character', '内容タグを人物にしている');
});

test('一意に決まる日本語名なら、pixiv の候補にも人物と所属作品が付く', () => {
  const row = decorate({ type: 'tag', name: '結城明日奈', label: '結城明日奈' }, 'pixiv');
  assert.equal(row.type, 'character');
  assert.ok(row.seriesLabel, '所属作品が付かない');
});

// ---- 5. 確かめられない語は確定候補にしない ------------------------------------

test('対応を確かめられない語は、そのサイトの確定候補にしない', () => {
  const rows = aliases.suggestAliases('まったく知らない語の見本', 8);
  assert.deepEqual(rows, []);
});

test('nhentai に無い語は nhentai の候補に出さない', () => {
  const { forSite } = require('../src/lib/search-decorate');
  // hitomi にしか無い人物 (nhentai の一覧に同名が無い) は落とす
  const hitomiOnly = aliases.loadData().entries.find((e) => e.type === 'character' && e.sites && e.sites.nhentai === false);
  assert.ok(hitomiOnly, '判定用の項目が無い (sites の印が付いていない)');
  assert.equal(forSite(hitomiOnly, 'nhentai'), false);
  assert.equal(forSite(hitomiOnly, 'hitomi'), true);
});

// ---- 6. 件数は流用しない -----------------------------------------------------

test('件数はそのサイト自身の物だけ', () => {
  for (const row of aliases.suggestAliases('asuna', 12)) {
    if (!row.metric) continue;
    assert.equal(row.metric.site, 'hitomi', '別サイトの件数を持ち込んでいる');
  }
  // pixiv 向けに飾った候補は hitomi の件数を持ち出さない
  const row = decorate({ type: 'tag', name: '結城明日奈', label: '結城明日奈' }, 'pixiv');
  assert.equal(row.metric || null, null, 'pixiv の候補に他サイトの件数が付いている');
});

test('日本語名と元の語が同じなら二段に出さない', () => {
  const row = decorate({ type: 'tag', name: '結城明日奈', label: '結城明日奈' }, 'pixiv');
  assert.notEqual(row.label, row.secondary || '', '同じ文字が主表示と補助表示に並んでいる');
});

// ---- 7. VTuber は所属事務所を出す -------------------------------------------

test('VTuber の補助表示は「VTuber (事務所名)」になる', () => {
  const cases = [
    ['character:usada_pekora', 'ホロライブ'],
    ['character:kuzuha', 'にじさんじ'],
  ];
  for (const [value, agency] of cases) {
    const entry = aliases.loadData().byValue.get(value);
    assert.ok(entry, `${value} が辞書に無い`);
    assert.ok(entry.vtuber && entry.vtuber.label, `${value} に所属事務所が付いていない`);
    const row = decorate({ type: entry.type, name: entry.name }, 'hitomi');
    assert.equal(row.secondary, `VTuber (${agency})`, `${value} の補助表示が ${row.secondary}`);
  }
});

test('事務所に属さない VTuber は「VTuber (個人)」と出す', () => {
  const indie = aliases.loadData().entries
    .filter((e) => e.vtuber && e.vtuber.label === '個人');
  assert.ok(indie.length > 0, '個人勢が一人も居ない');
  const row = decorate({ type: indie[0].type, name: indie[0].name }, 'hitomi');
  assert.equal(row.secondary, 'VTuber (個人)');
});

test('事務所は画面だけ。押して飛ぶ値は人物の語のまま', () => {
  // hitomi は series として hololive と nijisanji しか持たない。
  // 事務所を検索値にすると「押しても 0 件の札」になるので、値は人物のまま
  for (const site of ['hitomi', 'nhentai']) {
    for (const row of fromDictionary('ぺこら', site, 6)) {
      if (!row.secondary || !row.secondary.startsWith('VTuber')) continue;
      assert.match(row.value, /^character:/, `${site} で事務所が検索値に混ざっている: ${row.value}`);
    }
  }
});

test('hitomi に series が無い事務所でも表示できる', () => {
  // ぶいすぽ・あおぎり・ななしいんく は hitomi に series タグが無い。
  // series の枠でやると引けない札になるので、別の枠で持っていることを確かめる
  // 調べの材料 (work/) は版に入れない。無い環境 (clone 直後) では黙って通す
  const hvFile = require('path').join(__dirname, '..', 'work', 'vocabulary-research', 'data', 'hitomi-vocabulary.json');
  if (!require('fs').existsSync(hvFile)) return;
  const hv = require(hvFile);
  const small = aliases.loadData().entries.filter((e) => e.vtuber
    && !['ホロライブ', 'にじさんじ', '個人'].includes(e.vtuber.label));
  if (!small.length) return;                       // まだ引けていなければ黙って通す
  const e = small[0];
  assert.equal(decorate({ type: e.type, name: e.name }, 'hitomi').secondary, `VTuber (${e.vtuber.label})`);
  // その事務所名が hitomi の series に無いことこそが、別枠で持つ理由
  assert.ok(!Object.prototype.hasOwnProperty.call(hv.namespaces.series, String(e.vtuber.agency).replace(/_/g, ' ')),
    '事務所が hitomi の series にあるなら series の枠で足りる');
});

// ---- 8. hitomi に無く pixiv でだけ引ける語 -----------------------------------

const pixivOnlyEntries = () => aliases.loadData().entries
  .filter((e) => e.sites && e.sites.hitomi === false);

test('pixiv 専用の語は pixiv にだけ候補として出る', () => {
  const rows = pixivOnlyEntries();
  if (!rows.length) return;                     // まだ集めていなければ黙って通す
  const { forSite } = require('../src/lib/search-decorate');
  for (const e of rows.slice(0, 50)) {
    assert.equal(forSite(e, 'pixiv'), true, `${e.value} が pixiv に出ない`);
    assert.equal(forSite(e, 'hitomi'), false, `${e.value} が hitomi に出てしまう`);
    assert.equal(forSite(e, 'nhentai'), e.sites.nhentai === true, `${e.value} の nhentai の印がおかしい`);
  }
});

test('pixiv 専用の語は検索語の書き換えに使わない', () => {
  const rows = pixivOnlyEntries();
  if (!rows.length) return;
  // byKey に混ぜると rewriteQuery が拾い、hitomi で打った日本語が
  // hitomi に無いタグへ化けて 0 件になる (ローマ字索引を候補専用にしたのと同じ理由)
  for (const e of rows.slice(0, 50)) {
    const label = String(e.label || '');
    if (!label) continue;
    assert.equal(aliases.rewriteQuery(label).query, label, `「${label}」が ${e.value} へ書き換わる`);
    assert.equal(aliases.uniqueLookup(label), null, `「${label}」が一意の語として引ける`);
  }
});

test('pixiv 専用の語も日本語名と所属事務所を持つ', () => {
  for (const e of pixivOnlyEntries()) {
    assert.match(String(e.label || ''), /[぀-ヿ一-鿿]/, `${e.value} に日本語の札が無い`);
    assert.equal(e.sites.pixiv, true, `${e.value} が pixiv へ出せない`);
  }
});

test('サイト自身の補完から来た素の語も、日本語名と所属事務所が付く', () => {
  // pixiv の補完は「型の無い素の語」を返す (`小森めと`)。それを飾る時に
  // byKey だけ見ていると pixiv 専用の人物に届かず、素のタグのまま出てしまう。
  // 実際それで「小森めと が VTuber (ぶいすぽっ!) と出ない」が起きた
  const rows = aliases.loadData().entries.filter((e) => e.sites && e.sites.hitomi === false && e.vtuber);
  if (!rows.length) return;
  for (const e of rows.slice(0, 20)) {
    const bare = decorate({ type: 'tag', name: e.label }, 'pixiv');
    assert.equal(bare.secondary, `VTuber (${e.vtuber.label})`,
      `素の語「${e.label}」に事務所が付かない`);
  }
});
