'use strict';
// 組み直した辞書の受け入れ検査。利用者の報せ (沖田総悟) をそのまま再現する。
//   node scripts/vocab-check.js
// 画面や網には触らない。辞書と解決器だけを直に叩く。

const path = require('path');
const ROOT = path.join(__dirname, '..');
const aliases = require(path.join(ROOT, 'src/lib/search-aliases'));
const vocabulary = require(path.join(ROOT, 'src/lib/search-vocabulary'));
const { forNhentai } = require(path.join(ROOT, 'src/lib/sources/tag-query'));

const hv = require(path.join(ROOT, 'work/vocabulary-research/data/hitomi-vocabulary.json'));
const nv = require(path.join(ROOT, 'work/vocabulary-research/data/nhentai-vocabulary.json'));

let failed = 0;
const ok = (cond, text) => { console.log(`${cond ? '  ok  ' : '  NG  '} ${text}`); if (!cond) failed += 1; };

console.log('=== 1. 利用者の報せ: 沖田総悟 (銀魂) ===');
const sug = aliases.suggestAliases('沖田総悟', 6);
console.log('  候補:', JSON.stringify(sug.map((s) => ({ v: s.value, l: s.label, series: s.series, sites: s.sites }))));
ok(sug.some((s) => s.value === 'character:sougo_okita'), '「沖田総悟」で character:sougo_okita が候補に出る');
const okita = sug.find((s) => s.value === 'character:sougo_okita');
ok(Boolean(okita && okita.series === 'gintama'), '所属作品が gintama として付いている');

const rw = aliases.rewriteQuery('沖田総悟');
console.log('  書き換え:', JSON.stringify(rw));
ok(rw.query === 'character:sougo_okita', '「沖田総悟」が character:sougo_okita へ書き換わる');

for (const target of ['hitomi', 'nhentai']) {
  const r = vocabulary.resolve({ type: 'tag', name: '沖田総悟', source: 'pixiv' }, target);
  console.log(`  pixiv -> ${target}:`, JSON.stringify(r));
  ok(r.status === 'resolved' || r.status === 'ambiguous', `pixiv の「沖田総悟」が ${target} へ渡る (unmapped でない)`);
}
console.log('  nhentai の構文:', forNhentai('character:sougo_okita'));

console.log('\n=== 2. 出した語が本当にそのサイトで引けるか ===');
// 「候補に出るのに検索できない」を構造で潰す。辞書の全行を各サイトの
// 全語一覧に突き合わせる。控えが根拠なので網には触らない
const data = aliases.loadData();
const spaced = (s) => String(s).replace(/_/g, ' ').toLowerCase();
let charRows = 0; let charOnHitomi = 0; let seriesRows = 0; let seriesOnHitomi = 0;
const ghosts = [];
let pixivOnly = 0; const orphans = [];
for (const e of data.entries) {
  // hitomi に無いと名指しした語 (pixiv 専用) は、hitomi の実在を問わない。
  // かわりに「pixiv では出せる」ことを問う — どのサイトにも出せない行は孤児
  if (e.sites && e.sites.hitomi === false) {
    pixivOnly += 1;
    const sendable = e.sites.pixiv === true && /[぀-ヿ一-鿿]/.test(String(e.label || ''));
    if (!sendable) orphans.push(e.value);
    continue;
  }
  if (e.type === 'character') {
    charRows += 1;
    if (Object.prototype.hasOwnProperty.call(hv.namespaces.character, spaced(e.name))) charOnHitomi += 1;
    else ghosts.push(`character:${e.name}`);
  } else if (e.type === 'series') {
    seriesRows += 1;
    if (Object.prototype.hasOwnProperty.call(hv.namespaces.series, spaced(e.name))) seriesOnHitomi += 1;
    else ghosts.push(`series:${e.name}`);
  }
}
console.log(`  人物 ${charRows} 行のうち hitomi に実在: ${charOnHitomi}`);
console.log(`  作品 ${seriesRows} 行のうち hitomi に実在: ${seriesOnHitomi}`);
if (ghosts.length) console.log(`  hitomi に無い語 (${ghosts.length}):`, ghosts.slice(0, 10).join(', '));

// sites.nhentai を立てた行は、nhentai の全語一覧に実在しなければならない
let claimed = 0; let wrong = 0;
for (const e of data.entries) {
  if (!e.sites || e.sites.nhentai !== true) continue;
  claimed += 1;
  const space = e.type === 'series' ? 'parody' : e.type;
  const table = nv.namespaces[space];
  if (!table || !Object.prototype.hasOwnProperty.call(table, spaced(e.name))) { wrong += 1; if (wrong <= 5) console.log(`    NG ${e.value}`); }
}
console.log(`  nhentai で引けると印を付けた行: ${claimed} / そのうち実在しない: ${wrong}`);
ok(wrong === 0, 'nhentai の印を付けた行はすべて nhentai に実在する');
console.log(`  hitomi に無く pixiv 専用の行: ${pixivOnly}`);
if (orphans.length) console.log(`    どのサイトにも出せない行: ${orphans.slice(0, 8).join(', ')}`);
ok(orphans.length === 0, 'pixiv 専用の行はすべて pixiv へ出せる (日本語の札を持つ)');

console.log('\n=== 3. 網羅 ===');
const withLabel = (t) => data.entries.filter((e) => e.type === t && e.labels.length).length;
const withSeries = data.entries.filter((e) => e.type === 'character' && e.series).length;
console.log(`  日本語名を持つ人物: ${withLabel('character')} / hitomi の人物 ${Object.keys(hv.namespaces.character).length}`);
console.log(`  日本語名を持つ作品: ${withLabel('series')} / hitomi の作品 ${Object.keys(hv.namespaces.series).length}`);
console.log(`  所属作品が付いた人物: ${withSeries}`);

console.log('\n=== 4. 前からある語が壊れていないか ===');
// 一つに定まる語は書き換わる
for (const [term, want] of [['銀魂', 'series:gintama'], ['巨乳', 'female:big_breasts'], ['艦これ', 'series:kantai_collection']]) {
  const got = aliases.rewriteQuery(term).query;
  ok(got === want, `${term} -> ${want} (今: ${got})`);
}
// 男女どちらもある語は片方へ狭めない。pixiv から渡す時だけ either にまとまる
for (const term of ['眼鏡', '中出し']) {
  ok(aliases.rewriteQuery(term).query === term, `${term} は片方の性へ狭めない (書き換えない)`);
  const r = vocabulary.resolve({ type: 'tag', name: term, source: 'pixiv' }, 'hitomi');
  ok(r.status === 'resolved' && r.value && r.value.type === 'either', `${term} は pixiv から either: へ渡る`);
}

console.log('\n=== 5. 重くなっていないか ===');
// 一番大事な品質は「サクサク動くこと」(CLAUDE.md)。辞書が三倍になっても
// 読み込みと候補出しが熱い道を止めないことを数字で見る
{
  const fresh = require.resolve(path.join(ROOT, 'src/lib/search-aliases'));
  delete require.cache[fresh];
  const t0 = process.hrtime.bigint();
  const A2 = require(path.join(ROOT, 'src/lib/search-aliases'));
  A2.loadData();
  const loadMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const t1 = process.hrtime.bigint();
  let n = 0;
  for (const term of ['沖田', 'okita', '銀魂', 'あず', 'sakura', '巨乳', 'haruhi', 'アスナ']) n += A2.suggestAliases(term, 8).length;
  const sugMs = Number(process.hrtime.bigint() - t1) / 1e6 / 8;
  console.log(`  辞書の読み込み: ${loadMs.toFixed(0)}ms (一度きり)`);
  console.log(`  候補出し 1 回あたり: ${sugMs.toFixed(1)}ms (${n} 件)`);
  ok(loadMs < 3000, '読み込みが 3 秒未満');
  ok(sugMs < 120, '候補出しが 1 回 120ms 未満');
}

console.log(`\n${failed ? `NG ${failed} 件` : 'すべて通った'}`);
process.exit(failed ? 1 : 0);
