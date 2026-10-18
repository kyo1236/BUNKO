'use strict';
// 表示名が「アスナ(SAO)」のように括弧で所属を注記している行を、正式名へ直す。
//
// なぜ今直せるか: 所属作品は候補の行に別立てで出るようになった。
// 注記は二重になっただけでなく、正式名 (結城明日奈) を画面から隠している。
//
// 直し方 (推測はしない。辞書に在る名前からしか選ばない):
//   1. その人物の別名に**括弧の無い日本語名**があるなら、それを使う。
//      二つ以上あるなら、漢字を含む長い方 (フルネームに近い)
//   2. 無ければ、今の札から括弧を外した形を使う (HK416(少女前線) → HK416)。
//      別名の中に括弧付きが複数あるなら、外した形が一番長い物
//   3. どちらも 2 文字未満・日本語でないなら触らない
//
//   node scripts/audit-paren-labels.js --dry
//   node scripts/audit-paren-labels.js
const fs = require('fs');
const path = require('path');
const { aliasKey } = require('../src/lib/search-text');
const { tagNameKey } = require('../src/lib/title-keys');
const { knownKanji, isJapanese } = require('./japanese-script');

const ROOT = path.join(__dirname, '..');
const WORK = path.join(ROOT, 'work', 'vocabulary-audit-2026-09-21');
const TARGET = path.join(ROOT, 'src', 'lib', 'data', 'label-overrides.json');
const DRY = process.argv.includes('--dry');

// 括弧を外すだけでは直らない行。一つずつ辞書と突き合わせて確かめた物だけ置く。
// 機械では「別人の名前が札になっている」と「その人の通り名」を見分けられないので、
// 疑わしい物は report に出して、直すのはここに書いた分だけにする
const EXCEPTIONS = {
  // 錠前サオリ は ブルーアーカイブ の別人 (character:saori_joumae)。
  // こちらは ガールズ&パンツァー の 武部沙織 で、danbooru の other_names もそう言っている
  'character:saori_takebe': '武部沙織',
};

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};
const text = (value) => String(value == null ? '' : value).trim();
// test() に /g を使うと lastIndex が残って真偽が交互に化ける。判定用と置換用を分ける
const HAS_PAREN = /[(（][^)）]*[)）]/;
const PAREN_ALL = /[(（][^)）]*[)）]/g;
const strip = (label) => text(String(label).replace(PAREN_ALL, ''));

function main() {
  const aliases = require('../src/lib/search-aliases');
  const data = aliases.loadData();
  const overrides = readJson(TARGET, null);
  if (!overrides) throw new Error('label-overrides.json がありません');

  // 「日本語と言い切れる字」の集合は辞書から組む (中国語表記を正式名に選ばない)
  const wikis = readJson(path.join(WORK, 'danbooru-wikis.json'), { byName: {} }).byName;
  const seed = [];
  for (const names of Object.values(wikis)) for (const n of names || []) seed.push(n);
  const chars = knownKanji({ seed, fresh: true });

  const clean = (label) => {
    const s = text(label);
    return Boolean(s) && !HAS_PAREN.test(s) && isJapanese(s, chars);
  };
  const kanji = (s) => /[一-鿿]/.test(s);

  const proposals = [];
  const untouched = [];
  for (const entry of data.entries) {
    const label = text(entry.label);
    if (!HAS_PAREN.test(label)) continue;

    const base = strip(label);
    const labels = (entry.labels || []).map(text);
    const candidates = labels.filter(clean);
    // hitomi の人物名が 名 姓 の二語なら、画面に出すのはフルネーム。
    // 一語 (神楽・レックス・マーリン) は元から通り名で、長い別名は渾名や称号なので触らない
    const tokens = String(entry.name).split('_').filter(Boolean).length;
    let next = '';
    let how = '';

    // 1. 同じ名前をより詳しく書いた別名 (アスナ → 一之瀬アスナ)。姓を持つ人物だけ。
    //    一語の通り名 (マーリン・アウラ) に長い別名が付く時は渾名や称号なので触らない
    if (tokens >= 2) {
      const longer = candidates.filter((c) => base && c !== base && c.includes(base));
      if (longer.length) { next = longer.sort((a, b) => b.length - a.length)[0]; how = '同じ名の詳しい形'; }
    }

    // 2. 短い通り名しか無い姓持ちは、漢字入りのフルネームを探す (アスナ → 結城明日奈)。
    //    札が既に長いなら通り名ではない (トウカイテイオー を 闇のテイオー にしない)
    // 漢字の名前は既に正式名 (沖田総司)。通り名は かな か 欧字 で短い物だけ
    if (!next && tokens >= 2 && !kanji(base) && base.length <= 6) {
      const full = candidates.filter((c) => kanji(c) && c.length >= 4);
      if (full.length) { next = full.sort((a, b) => b.length - a.length)[0]; how = 'フルネーム'; }
    }

    // 3. それ以外は括弧を外した形 (暁・W のような一字の名前もそのまま名前)。
    //    別の札を外した形が同じ名前のより詳しい形なら、そちらを採る
    //    (416(ドールズフロントライン) より HK416(少女前線) の HK416)
    if (!next && base.length >= 1) {
      const stripped = labels.map(strip).filter((t) => t.length >= 1);
      const richer = stripped.filter((t) => t !== base && t.includes(base));
      next = richer.sort((a, b) => b.length - a.length)[0] || base;
      how = '括弧を外した形';
    }

    // 手で確かめた例外が最優先
    if (EXCEPTIONS[entry.value]) { next = EXCEPTIONS[entry.value]; how = '手で確かめた例外'; }

    if (!next || aliasKey(next) === aliasKey(label)) { untouched.push({ value: entry.value, label }); continue; }
    // 括弧を外した名前が、辞書では別人の名前として通っている場合は疑わしい。
    // ここでは直さず (別の監査の担当) 報告だけする
    const elsewhere = (data.byKey.get(aliasKey(base)) || [])
      .filter((row) => row.type === entry.type && row.value !== entry.value);
    const suspect = elsewhere.length > 0 && !labels.some((l) => aliasKey(l) === aliasKey(base));
    proposals.push({ value: entry.value, type: entry.type, name: entry.name, from: label, to: next, how,
      suspect: suspect ? elsewhere.slice(0, 2).map((row) => row.value) : undefined });
  }

  // label-overrides に同じ行があれば書き換える。無ければ足す
  // (札の出どころは辞書の一般則のこともあるので、上書きで決め直す)
  const next = { ...overrides };
  const keyOf = (type, name) => `${type} ${tagNameKey(name).replace(/ /g, '_')}`;
  const existing = new Map();
  for (const key of Object.keys(overrides)) {
    const space = key.indexOf(' ');
    if (space < 1) continue;
    existing.set(`${key.slice(0, space).toLowerCase()} ${tagNameKey(key.slice(space + 1))}`, key);
  }
  let replaced = 0;
  let added = 0;
  for (const row of proposals) {
    const lookup = `${row.type} ${tagNameKey(row.name)}`;
    const key = existing.get(lookup);
    if (key) { next[key] = row.to; replaced += 1; } else { next[keyOf(row.type, row.name)] = row.to; added += 1; }
  }

  const summary = {
    parenLabels: proposals.length + untouched.length,
    proposed: proposals.length,
    byRule: proposals.reduce((out, r) => { out[r.how] = (out[r.how] || 0) + 1; return out; }, {}),
    untouched: untouched.length,
    overridesReplaced: replaced,
    overridesAdded: added,
    overridesAfter: Object.keys(next).length,
  };
  console.log(JSON.stringify(summary, null, 2));
  console.log(proposals.slice(0, 40).map((r) => `  ${r.from.padEnd(26)} -> ${r.to.padEnd(16)} ${r.value}`).join('\n'));
  if (untouched.length) {
    console.log('\n-- 触らなかった物 (正式名が辞書に無い) --');
    console.log(untouched.slice(0, 20).map((r) => `  ${r.label.padEnd(26)} ${r.value}`).join('\n'));
  }
  fs.mkdirSync(WORK, { recursive: true });
  fs.writeFileSync(path.join(WORK, 'paren-label-audit.json'), JSON.stringify({ summary, proposals, untouched }, null, 1));
  if (DRY) { console.log('\n--dry: label-overrides.json は書き換えていない'); return; }
  fs.writeFileSync(TARGET, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`\nwrote ${TARGET}`);
}

// 直に叩かれた時だけ走る。require しただけで辞書を書き換えないこと
if (require.main === module) main();

module.exports = { main };
