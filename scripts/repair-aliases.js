'use strict';
// aliases.json の人物の別名を、hitomi の語を主語にして danbooru の同名タグから
// 引き直す。推測はしない。結ぶのは「フルネームがそっくり同じ」時だけ。
//
// なぜ向きを変えるか:
//   これまでは danbooru の tag から hitomi を探し、当たらない時に下の名前で
//   前方一致していた。`azusa_(blue_archive)` が `azusa *` の六人に当たり、
//   「アズサ/白洲アズサ」一式が六人ぶん複写された (白洲アズサ で中野梓が出た正体)。
//   hitomi を主語にすれば行き先は一つに定まる。
//
// 同一性の鎖 (どれも公開の名指しであって、当てずっぽうではない):
//   hitomi `azusa shirasu`
//     → danbooru `shirasu_azusa`      (姓名の並びが違うだけの同じフルネーム)
//     → danbooru の別名解決 `azusa_(blue_archive)`  (danbooru 自身が同一と宣言)
//     → その wiki の other_names       (白洲アズサ / 白洲梓 / アズサ)
//
// 使い方:
//   node scripts/repair-aliases.js --dry    集計だけ
//   node scripts/repair-aliases.js          aliases.json を書き換える
//   控えは work/vocabulary-audit-2026-09-21/danbooru-cache.json に残す
//   (二度目からは網に触らない。監査をやり直せる)
const fs = require('fs');
const path = require('path');
const { get } = require('../src/lib/http');
const { hasCjk } = require('../src/lib/search-text');
const { jpKeys, spaced, swapped } = require('./build-aliases');

const ROOT = path.join(__dirname, '..');
const WORK = path.join(ROOT, 'work', 'vocabulary-audit-2026-09-21');
const TARGET = path.join(ROOT, 'src', 'lib', 'data', 'aliases.json');
const HITOMI = path.join(ROOT, 'work', 'vocabulary-research', 'data', 'hitomi-vocabulary.json');
const CACHE = path.join(WORK, 'danbooru-cache.json');
const REPORT = path.join(WORK, 'repair-report.json');
const UA = 'bunko/1.0 (character alias audit; local desktop app; one user)';
const DRY = process.argv.includes('--dry');
// hitomi にしか居ない人物も拾う。既存の項目だけ直すと「正しい方を足す」が起きない
const EXTRA_CHARACTERS = Number(process.env.EXTRA_CHARACTERS || 1500);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};

// 簡体字だけの表記は札に選ばない (検索の鍵には残す)。日本語の正式名を優先する
const SIMPLIFIED = /[贼灭档兽绘将级战术记录乐动画恋书爱读会园头发师龙风开关铁门问间际队马鸟鱼黄单双变现实处涩纱织丽艳]/;
const hasKana = (s) => /[ぁ-んァ-ヶー]/.test(s);
const looksChinese = (s) => SIMPLIFIED.test(String(s || '')) && !hasKana(String(s || ''));

const cache = readJson(CACHE, { tags: {}, aliases: {}, at: '' });
let fetched = 0;

async function getJson(url) {
  for (let i = 0; i < 4; i += 1) {
    try {
      const res = await get(url, { 'User-Agent': UA, Accept: 'application/json' });
      return res.json();
    } catch (error) {
      if (error && error.status === 404) return null;
      await sleep(600 * (i + 1));
    }
  }
  return null;
}

// danbooru の tag を 100 件ずつ。控えに在る名前は訊かない
async function fetchTags(names) {
  const missing = [...new Set(names)].filter((n) => n && !Object.prototype.hasOwnProperty.call(cache.tags, n));
  for (let i = 0; i < missing.length; i += 100) {
    const batch = missing.slice(i, i + 100);
    const url = `https://danbooru.donmai.us/tags.json?search[name_comma]=${batch.map(encodeURIComponent).join(',')}&only=name,category,post_count,wiki_page&limit=100`;
    const rows = await getJson(url);
    fetched += 1;
    const seen = new Set();
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row || !row.name) continue;
      seen.add(row.name);
      const wiki = row.wiki_page;
      cache.tags[row.name] = {
        category: row.category,
        postCount: row.post_count,
        otherNames: (wiki && !wiki.is_deleted && Array.isArray(wiki.other_names)) ? wiki.other_names : [],
      };
    }
    for (const name of batch) if (!seen.has(name)) cache.tags[name] = null;
    if ((i / 100) % 10 === 9) saveCache();
    process.stdout.write(`\r  tags ${Math.min(i + 100, missing.length)}/${missing.length}   `);
    await sleep(650);
  }
  if (missing.length) { saveCache(); console.log(''); }
}

// 名前は在るが wiki を持たない tag は、danbooru 自身が別名として畳んでいる。
// 畳んだ先 (consequent) が正準。これは danbooru の宣言であって推測ではない
async function fetchAliases(names) {
  const missing = [...new Set(names)].filter((n) => n && !Object.prototype.hasOwnProperty.call(cache.aliases, n));
  for (let i = 0; i < missing.length; i += 100) {
    const batch = missing.slice(i, i + 100);
    const url = `https://danbooru.donmai.us/tag_aliases.json?search[antecedent_name_comma]=${batch.map(encodeURIComponent).join(',')}&search[status]=active&only=antecedent_name,consequent_name&limit=200`;
    const rows = await getJson(url);
    fetched += 1;
    const seen = new Set();
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row || !row.antecedent_name) continue;
      seen.add(row.antecedent_name);
      cache.aliases[row.antecedent_name] = row.consequent_name || null;
    }
    for (const name of batch) if (!seen.has(name)) cache.aliases[name] = null;
    process.stdout.write(`\r  aliases ${Math.min(i + 100, missing.length)}/${missing.length}   `);
    await sleep(650);
  }
  if (missing.length) { saveCache(); console.log(''); }
}

function saveCache() {
  fs.mkdirSync(WORK, { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify({ ...cache, at: new Date().toISOString() }));
}

// hitomi の名 (名 姓) から danbooru の候補 (姓_名 / そのまま) を作る
function danbooruCandidates(hitomiName) {
  const plain = spaced(hitomiName);
  const flipped = swapped(plain);
  return [...new Set([plain, flipped].filter(Boolean))].map((n) => n.replace(/ /g, '_'));
}

async function main() {
  const aliases = readJson(TARGET, null);
  if (!aliases || !Array.isArray(aliases.entries)) throw new Error('aliases.json を読めません');
  const hitomi = readJson(HITOMI, null);
  if (!hitomi || !hitomi.namespaces) throw new Error('hitomi 全語一覧がありません');
  const hitomiChars = hitomi.namespaces.character;

  const existing = aliases.entries.filter((e) => e.type === 'character');
  const extra = Object.entries(hitomiChars)
    .sort((a, b) => b[1] - a[1]).slice(0, EXTRA_CHARACTERS).map(([name]) => name);
  const universe = [...new Set([...existing.map((e) => spaced(e.name)), ...extra])];
  console.log(`hitomi の人物 ${universe.length} 件を検める (既存 ${existing.length} / 多い順 ${extra.length})`);

  // 一巡目: フルネームが同じ danbooru tag
  const wanted = new Map();
  for (const name of universe) wanted.set(name, danbooruCandidates(name));
  await fetchTags([...wanted.values()].flat());

  // 二巡目: 名前は在るが wiki が無い物を、danbooru の別名解決に通す
  const needAlias = [];
  for (const [, candidates] of wanted) {
    for (const cand of candidates) {
      const row = cache.tags[cand];
      if (row && !row.otherNames.length) needAlias.push(cand);
    }
  }
  await fetchAliases(needAlias);

  // 三巡目: 畳んだ先の wiki
  const consequents = needAlias.map((n) => cache.aliases[n]).filter(Boolean);
  await fetchTags(consequents);

  // ---- 結び直し ----
  const resolved = new Map(); // hitomi name -> {labels, via}
  for (const [name, candidates] of wanted) {
    for (const cand of candidates) {
      const row = cache.tags[cand];
      if (!row || row.category !== 4) continue;
      let source = cand;
      let names = row.otherNames;
      if (!names.length) {
        const target = cache.aliases[cand];
        const next = target ? cache.tags[target] : null;
        if (!next || next.category !== 4 || !next.otherNames.length) continue;
        source = target;
        names = next.otherNames;
      }
      const labels = [...new Set(names.flatMap((n) => jpKeys(n)))].filter(hasCjk);
      if (!labels.length) continue;
      resolved.set(name, { labels, via: cand === source ? [cand] : [cand, source] });
      break;
    }
  }
  console.log(`danbooru の公式別名で結べた人物: ${resolved.size}`);

  // ---- aliases.json を書き換える ----
  const before = new Map(existing.map((e) => [spaced(e.name), e]));
  const report = { at: new Date().toISOString(), removed: [], rebound: [], added: [], kept: [], requests: fetched };
  const keep = aliases.entries.filter((e) => e.type !== 'character');
  const nextChars = [];

  for (const entry of existing) {
    const name = spaced(entry.name);
    const hit = resolved.get(name);
    if (!hit) {
      report.removed.push({ value: entry.value, hadLabels: entry.labels, reason: 'danbooru に同じフルネームの公式別名が無い' });
      continue;
    }
    const same = hit.labels.length === entry.labels.length && hit.labels.every((l) => entry.labels.includes(l));
    const next = { ...entry, labels: hit.labels.slice(), keys: hit.labels.slice() };
    nextChars.push(next);
    if (same) report.kept.push(entry.value);
    else report.rebound.push({ value: entry.value, from: entry.labels, to: hit.labels, via: hit.via });
  }

  for (const [name, hit] of resolved) {
    if (before.has(name)) continue;
    const count = hitomiChars[name] || 0;
    const value = `character:${name.replace(/ /g, '_')}`;
    nextChars.push({ value, type: 'character', name: name.replace(/ /g, '_'), labels: hit.labels.slice(), keys: hit.labels.slice(), count });
    report.added.push({ value, labels: hit.labels, count, via: hit.via });
  }

  const entries = [...keep, ...nextChars].sort((a, b) => (b.count || 0) - (a.count || 0) || a.value.localeCompare(b.value));
  const payload = {
    ...aliases,
    version: 3,
    repairedAt: new Date().toISOString(),
    source: `${aliases.source}+hitomi-name-identity`,
    stats: { ...(aliases.stats || {}), entries: entries.length, charactersRebound: report.rebound.length, charactersRemoved: report.removed.length, charactersAdded: report.added.length },
    entries,
  };

  const summary = {
    charactersBefore: existing.length,
    charactersAfter: nextChars.length,
    kept: report.kept.length,
    rebound: report.rebound.length,
    removed: report.removed.length,
    added: report.added.length,
    entriesBefore: aliases.entries.length,
    entriesAfter: entries.length,
    danbooruRequests: fetched,
  };
  console.log(JSON.stringify(summary, null, 2));
  fs.writeFileSync(REPORT, JSON.stringify({ summary, ...report }, null, 1));
  console.log(`report -> ${REPORT}`);
  if (DRY) { console.log('--dry: aliases.json は書き換えていない'); return; }
  fs.writeFileSync(TARGET, `${JSON.stringify(payload)}\n`);
  console.log(`wrote ${TARGET}`);
}

// 直に叩かれた時だけ走る。require しただけで網へ出て辞書を書き換えないこと
if (require.main === module) main().catch((error) => { console.error(error); process.exit(1); });

module.exports = { danbooruCandidates, looksChinese };
