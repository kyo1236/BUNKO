'use strict';
// 日本語で引けなかった hitomi の series に、公式の日本語題と略称を足す。
//
// なぜ辞書に無かったか: aliases.json は danbooru の正準名から hitomi を探す。
// danbooru は `meitantei_conan`、hitomi は `detective conan`。英語の綴りが違う
// だけで丸ごと落ちていた (名探偵コナン・ハイキュー・けいおん が引けない正体)。
//
// 橋の架け方 (機械で、出典のある名指しだけで):
//   1. danbooru の wiki other_names には英語の綴りも並んでいる
//      (meitantei_conan の other_names に detective_conan が在る)。
//      hitomi の語を正規化して逆引きすれば danbooru 側の語が決まる
//   2. その語の other_names のうち、日本語と言い切れる物だけを採る。
//      先頭に来る物が正式題 (danbooru は正式名を先に並べる)、
//      短い物が略称 (ヒロアカ・けいおん)
//   3. AniList の公式題 (scripts/enrich-series-vocabulary.js の提案) が
//      在れば突き合わせ、一致を出典に併記する。無くても danbooru だけで足りる
//   4. hitomi の実在は全語一覧で確かめる
//
// 既に日本語の札を持っている語にも、略称だけを足す二巡目がある
// (僕のヒーローアカデミア は出るのに ヒロアカ で引けなかった)。
//
//   node scripts/apply-vocabulary-gaps.js --dry
//   node scripts/apply-vocabulary-gaps.js
const fs = require('fs');
const path = require('path');
const { aliasKey, hasCjk } = require('../src/lib/search-text');
const { tagNameKey } = require('../src/lib/title-keys');
const { knownKanji, isJapanese } = require('./japanese-script');

const ROOT = path.join(__dirname, '..');
const WORK = path.join(ROOT, 'work', 'vocabulary-audit-2026-09-21');
const TARGET = path.join(ROOT, 'src', 'lib', 'data', 'search-vocabulary.json');
const REVISION = '2026-09-21-vocabulary-4';
const DRY = process.argv.includes('--dry');
const LIMIT = Number(process.env.SERIES_LIMIT || 400);

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};
const norm = (s) => aliasKey(String(s || '').replace(/[^\p{L}\p{N}\s]/gu, ' '));
const hasKana = (s) => /[ぁ-んァ-ヶー]/.test(s);
// 同人の符丁 (腐・夢・部・パロ) と注記は語彙ではない
const FANDOM = /[腐夢]|【|】|部$|パロ$|イラスト|ファンアート|＠|@|_/;

function main() {
  const wikis = readJson(path.join(WORK, 'danbooru-wikis.json'), { byName: {} }).byName;
  // danbooru の tag の種類。series は copyright (3) の語からしか名前を取らない。
  // 種類を見ないと `ben-to` が一般語 `bento` (お弁当) に、`sailor moon` が
  // 人物タグ (セーラームーン) に当たる — 作品名ではない物が作品名の札になる
  const CATEGORY = { copyright: 3 };
  const categories = new Map();
  for (const src of [
    readJson(path.join(WORK, 'danbooru-tags.json'), { tags: [] }).tags || [],
    Object.entries(readJson(path.join(WORK, 'danbooru-cache.json'), { tags: {} }).tags || {})
      .filter(([, v]) => v).map(([name, v]) => ({ name, category: v.category, postCount: v.postCount })),
    Object.values(readJson(path.join(ROOT, 'work/vocabulary-research/data/danbooru-names.json'), { rows: {} }).rows || {}),
  ]) {
    for (const row of src) {
      if (!row || !row.name || row.category == null) continue;
      if (!categories.has(row.name)) categories.set(row.name, { category: row.category, postCount: row.postCount || 0 });
    }
  }
  const hitomi = readJson(path.join(ROOT, 'work/vocabulary-research/data/hitomi-vocabulary.json'), null);
  const nhentai = readJson(path.join(ROOT, 'work/vocabulary-research/data/nhentai-vocabulary.json'), null);
  const proposals = readJson(path.join(WORK, 'series-proposals.json'), { proposals: [] });
  const bridges = readJson(path.join(WORK, 'character-bridges.json'), { entries: [] });
  const base = readJson(TARGET, null);
  if (!base || !hitomi) throw new Error('辞書か hitomi 全語一覧がありません');

  const series = hitomi.namespaces.series;
  const nhParody = (nhentai && nhentai.namespaces && nhentai.namespaces.parody) || {};
  const seed = [];
  for (const names of Object.values(wikis)) for (const n of names || []) seed.push(n);
  const chars = knownKanji({ seed, fresh: true });

  // hitomi の英語名 → danbooru の語 (other_names と語そのものの両方を鍵にする)
  const byEnglish = new Map();
  for (const [name, names] of Object.entries(wikis)) {
    for (const candidate of [name, ...(names || [])]) {
      const key = norm(candidate);
      if (!key) continue;
      if (!byEnglish.has(key)) byEnglish.set(key, new Set());
      byEnglish.get(key).add(name);
    }
  }
  // 前の監査 (2026-09-21 夜) が「exact ではない」と判じた語は蒸し返さない。
  // レジェンズ は Apex/Pokémon LEGENDS の略称でもある、ワームホール は pixiv では
  // SF の一般語 — どれも理由付きで候補どまりに落とした物。ここで exact に
  // 戻すと、その判断を黙って覆すことになる
  const downgraded = new Set();
  try {
    const { parseCsv } = require('./apply-vocabulary-audit');
    const rows = parseCsv(fs.readFileSync(path.join(ROOT, 'work/vocabulary-research/audit/overturns.csv'), 'utf8'));
    const candidates = new Map(fs.readFileSync(path.join(ROOT, 'work/vocabulary-research/candidates.jsonl'), 'utf8')
      .split(String.fromCharCode(10)).filter(Boolean).map((line) => JSON.parse(line)).map((row) => [row.id, row]));
    for (const row of rows) {
      if (row.your_relation === 'exact') continue;
      const candidate = candidates.get(row.id);
      if (candidate && candidate.input && candidate.input.text) downgraded.add(aliasKey(candidate.input.text));
    }
  } catch { /* 研究用の控えが無い環境では素通し */ }
  console.log(`前の監査が候補どまりにした語: ${downgraded.size}`);

  // AniList の公式題 (突き合わせ用)
  const official = new Map();
  for (const row of proposals.proposals || []) official.set(tagNameKey(row.hitomi.name), row);

  // 略称として採れるか。
  //
  // 「日本語らしいか」だけでは足りない。danbooru の other_names には
  //   - 中国語題 (排球少年 / 我的英雄学院) — 常用漢字ばかりで字面では見分かない
  //   - 同人の符丁 (じゅじゅプラス / 今週のワンピ / 819プラス)
  //   - 掛け合わせ (ぼっち・ざ・けいおん! / ブルア廻戦)
  // が並ぶ。どれも「その作品の日本語名」ではない。
  //
  // 略称は正式題を縮めた物、という所だけを機械で確かめる:
  // **正式題の文字を順番通りに拾えば作れる** (部分列) 物だけ採る。
  //   ヒロアカ ⊂ 僕のヒーローアカデミア  ✓   あんスタ ⊂ あんさんぶるスターズ! ✓
  //   排球少年 ⊄ ハイキュー!!            ✗   アニワン ⊄ ワンピース            ✗
  // 縮めた形で作れない通称 (海賊王・リゼロ) も落ちるが、採り損ねる方を選ぶ。
  const shrink = (s) => aliasKey(s).replace(/[!！?？・〜~:：.,、。\s]/g, '');
  const subsequence = (needle, haystack) => {
    let i = 0;
    for (const ch of haystack) if (ch === needle[i]) i += 1;
    return i === needle.length;
  };
  const usable = (text, title) => {
    const s = String(text || '').trim();
    if (!s || s.length > 24 || s.length < 2) return false;
    if (/[()（）]/.test(s)) return false;             // 「セーラームーン(キャラクター)」は注記
    // 正式題に無い欧字が付いた物は同人の符丁 (葬送のフリーレンFA・あんスタNL)
    const foreign = (s.match(/[A-Za-z]/g) || []).filter((ch) => !title.includes(ch));
    if (foreign.length) return false;
    if (!isJapanese(s, chars)) return false;
    if (FANDOM.test(s)) return false;
    if (downgraded.has(aliasKey(s))) return false;
    // 日本語の語はこれらの字では始まらない。other_names に紛れた欠片を弾く
    if (/^[ーん゛゜ンぁぃぅぇぉっゃゅょァィゥェォッャュョヮヵヶ"'`]/.test(s)) return false;
    const [a, b] = [shrink(s), shrink(title)];
    if (!a || !b || a === b) return false;
    if (subsequence(a, b)) return true;
    // 続編の題 (けいおん!! / あんさんぶるスターズ!!) は正式題を丸ごと含む短い伸び
    return b.length && a.includes(b) && s.length <= title.length + 2;
  };

  // danbooru 側の語のうち、日本語の題を持っている物を選ぶ。
  // detective_conan (wiki 無し) ではなく meitantei_conan を採るための段
  function japaneseNames(englishName) {
    const candidates = byEnglish.get(norm(englishName));
    if (!candidates) return null;
    // copyright の語だけ。複数あるなら投稿数の多い方 (本体の作品タグ)
    const ranked = [...candidates]
      .map((tag) => ({ tag, info: categories.get(tag) }))
      .filter((row) => row.info && row.info.category === CATEGORY.copyright)
      .sort((a, b) => (b.info.postCount || 0) - (a.info.postCount || 0));
    for (const { tag } of ranked) {
      const names = (wikis[tag] || []).filter((n) => isJapanese(n, chars) && !FANDOM.test(n));
      if (names.length) return { tag, names, rivals: ranked.length };
    }
    return null;
  }

  const taken = new Map();
  for (const entry of base.entries) {
    const out = entry.outputs && entry.outputs.hitomi;
    if (out) taken.set(`${out.type}|${tagNameKey(out.name)}`, entry);
  }
  const overrides = readJson(path.join(ROOT, 'src/lib/data/label-overrides.json'), {});
  const aliases = readJson(path.join(ROOT, 'src/lib/data/aliases.json'), { entries: [] });
  const labelled = new Map();  // 既に日本語の札を持つ series
  for (const [key, value] of Object.entries(overrides)) {
    if (key.startsWith('series ')) labelled.set(tagNameKey(key.slice(7)), String(value));
  }
  for (const entry of aliases.entries) {
    if (entry.type !== 'series') continue;
    const jp = (entry.labels || []).find((l) => hasCjk(l));
    if (jp && !labelled.has(tagNameKey(entry.name))) labelled.set(tagNameKey(entry.name), jp);
  }

  const added = [];
  const enriched = [];
  const skipped = [];

  const makeEntry = (name, title, aliasList, tag, corroboration) => {
    const inputs = [{ site: 'pixiv', type: 'tag', name: title, relation: 'exact' }];
    for (const alias of aliasList) {
      if (inputs.some((i) => aliasKey(i.name) === aliasKey(alias))) continue;
      inputs.push({ site: 'pixiv', type: 'tag', name: alias, relation: 'exact' });
    }
    const outputs = {
      hitomi: { type: 'series', name, label: title },
      pixiv: { type: 'tag', name: title, label: title },
    };
    if (Object.prototype.hasOwnProperty.call(nhParody, name)) {
      outputs.nhentai = { type: 'series', name, label: title };
    }
    const evidence = [{
      url: `https://danbooru.donmai.us/wiki_pages/${encodeURIComponent(tag)}`,
      checkedAt: new Date().toISOString(),
      method: `danbooru-wiki-other-names; joined to hitomi by the English spelling listed there`,
      license: 'Danbooru wiki (public)',
    }];
    if (corroboration) {
      evidence.push({
        url: corroboration.anilist.url,
        checkedAt: corroboration.evidence[0].checkedAt,
        method: `anilist-official-title (${corroboration.japanese}); agrees with the danbooru wiki`,
        license: 'AniList public API',
      });
      const tagindex = corroboration.evidence.find((e) => e.method === 'tagindex-exact');
      if (tagindex) evidence.push(tagindex);
    }
    // danbooru の語名は日本語の読みのローマ字 (meitantei_conan)。
    // hitomi の英語名 (detective conan) とは綴りが違うので、候補の索引に足す
    const reading = String(tag).replace(/_/g, ' ').trim();
    return { id: `gap-series-${name.replace(/\s+/g, '_')}`, inputs, outputs,
      romaji: reading && reading !== name ? [reading] : undefined,
      evidence: evidence.slice(0, 4),
      review: { source: 'danbooru-other-names' + (corroboration ? ' + anilist-official-title' : ''), parentReviewed: true } };
  };

  // ---- 一巡目: 日本語がどこにも無い series ----
  const gaps = Object.entries(series)
    .filter(([name]) => !labelled.has(tagNameKey(name)) && !taken.has(`series|${tagNameKey(name)}`))
    .sort((a, b) => b[1] - a[1]).slice(0, LIMIT);
  for (const [name, count] of gaps) {
    const found = japaneseNames(name);
    if (!found) { skipped.push({ name, count, reason: 'danbooru に日本語題が無い' }); continue; }
    const title = found.names[0];
    if (downgraded.has(aliasKey(title))) { skipped.push({ name, count, reason: '前の監査が候補どまりにした語' }); continue; }
    const corroboration = official.get(tagNameKey(name)) || null;
    // AniList が別の題を言っているなら、機械では決められない。人が見るまで採らない
    if (corroboration && aliasKey(corroboration.japanese) !== aliasKey(title)
        && !corroboration.japanese.includes(title) && !title.includes(corroboration.japanese)) {
      skipped.push({ name, count, reason: `出どころが食い違う (danbooru=${title} / anilist=${corroboration.japanese})` });
      continue;
    }
    const aliasList = found.names.slice(1).filter((n) => usable(n, title));
    const entry = makeEntry(name, title, aliasList, found.tag, corroboration);
    base.entries.push(entry);
    taken.set(`series|${tagNameKey(name)}`, entry);
    added.push({ value: `series:${name}`, count, label: title, aliases: aliasList, danbooru: found.tag, anilist: Boolean(corroboration) });
  }

  // ---- 二巡目: 札は在るのに略称で引けない series ----
  // 「僕のヒーローアカデミア」は出るのに「ヒロアカ」で引けなかった所
  for (const [name] of Object.entries(series)) {
    const key = tagNameKey(name);
    const title = labelled.get(key);
    if (!title) continue;
    const found = japaneseNames(name);
    if (!found) continue;
    const aliasList = found.names.filter((n) => usable(n, title));
    if (!aliasList.length) continue;
    const existing = taken.get(`series|${key}`);
    if (existing) {
      const before = existing.inputs.length;
      for (const alias of aliasList) {
        if (existing.inputs.some((i) => aliasKey(i.name) === aliasKey(alias))) continue;
        existing.inputs.push({ site: 'pixiv', type: 'tag', name: alias, relation: 'exact' });
      }
      if (existing.inputs.length > before) enriched.push({ value: `series:${name}`, label: title, aliases: aliasList });
      continue;
    }
    const entry = makeEntry(name, title, aliasList, found.tag, official.get(key) || null);
    entry.id = `gap-series-alias-${name.replace(/\s+/g, '_')}`;
    base.entries.push(entry);
    taken.set(`series|${key}`, entry);
    enriched.push({ value: `series:${name}`, label: title, aliases: aliasList, created: true });
  }

  // ---- 手で確かめた橋渡し ----
  for (const row of bridges.entries || []) {
    const key = `${row.outputs.hitomi.type}|${tagNameKey(row.outputs.hitomi.name)}`;
    if (taken.has(key)) { skipped.push({ name: row.outputs.hitomi.name, reason: '既に対応がある' }); continue; }
    base.entries.push(row);
    taken.set(key, row);
    added.push({ value: `${row.outputs.hitomi.type}:${row.outputs.hitomi.name}`, label: row.outputs.hitomi.label, aliases: row.inputs.map((i) => i.name), danbooru: 'bridge' });
  }

  base.revision = REVISION;
  const summary = {
    gapsExamined: gaps.length,
    added: added.length,
    enrichedWithAbbreviations: enriched.length,
    skipped: skipped.length,
    anilistCorroborated: added.filter((a) => a.anilist).length,
    entriesAfter: base.entries.length,
    revision: REVISION,
  };
  console.log(JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(WORK, 'gap-apply-report.json'), JSON.stringify({ summary, added, enriched, skipped }, null, 1));
  if (DRY) { console.log('--dry: search-vocabulary.json は書き換えていない'); return; }
  fs.writeFileSync(TARGET, `${JSON.stringify(base, null, 2)}\n`);
  console.log(`wrote ${TARGET}`);
}

// 直に叩かれた時だけ走る。require しただけで辞書を書き換えないこと
if (require.main === module) main();

module.exports = { main };
