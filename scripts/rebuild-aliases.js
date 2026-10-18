'use strict';
// aliases.json を、直した照合規則 (scripts/build-aliases.js の pickExact /
// candidateNames) で組み直す。hitomi 側は全語一覧を使うので tagindex を一万回
// 叩かない。danbooru 側だけ網に触り、控えに残す。
//
// これは build-aliases.js の代わりではなく、**同じ規則を offline で流し直す物**。
// 規則は build-aliases.js から import しているので、単体試験 (test/search-identity)
// が通る限り、組み直しても前方一致の誤対応は復活しない。
//
//   node scripts/rebuild-aliases.js --dry   集計と差分だけ
//   node scripts/rebuild-aliases.js         src/lib/data/aliases.json を書き換える
const fs = require('fs');
const path = require('path');
const { get } = require('../src/lib/http');
const { pickExact, candidateNames, candidateTypes, collectLabels, spaced, copiedLabelFamilies } = require('./build-aliases');
const { knownKanji, isJapanese } = require('./japanese-script');

const ROOT = path.join(__dirname, '..');
const WORK = path.join(ROOT, 'work', 'vocabulary-audit-2026-09-21');
const TARGET = path.join(ROOT, 'src', 'lib', 'data', 'aliases.json');
const HITOMI = path.join(ROOT, 'work', 'vocabulary-research', 'data', 'hitomi-vocabulary.json');
const NHENTAI = path.join(ROOT, 'work', 'vocabulary-research', 'data', 'nhentai-vocabulary.json');
const TAGS_CACHE = path.join(WORK, 'danbooru-tags.json');
const WIKI_CACHE = path.join(WORK, 'danbooru-wikis.json');
const REPORT = path.join(WORK, 'rebuild-report.json');
const UA = 'bunko/1.0 (alias dictionary rebuild; local desktop app; one user)';
const DRY = process.argv.includes('--dry');
const PAGES = Number(process.env.DANBOORU_PAGES || 15);

const EXTRA_ALIASES = [
  ['日本語', 'language:japanese', 'language', 'japanese'],
  ['英語', 'language:english', 'language', 'english'],
  ['中国語', 'language:chinese', 'language', 'chinese'],
  ['韓国語', 'language:korean', 'language', 'korean'],
  ['同人誌', 'type:doujinshi', 'type', 'doujinshi'],
  ['漫画', 'type:manga', 'type', 'manga'],
  ['アニメ', 'type:anime', 'type', 'anime'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};
const writeJson = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
};

async function getJson(url) {
  for (let i = 0; i < 4; i += 1) {
    try {
      const res = await get(url, { 'User-Agent': UA, Accept: 'application/json' });
      return res.json();
    } catch (error) {
      if (error && error.status === 404) return null;
      await sleep(700 * (i + 1));
    }
  }
  return null;
}

async function fetchTags() {
  const cached = readJson(TAGS_CACHE, null);
  if (cached && Array.isArray(cached.tags) && cached.tags.length > 5000) {
    console.log(`danbooru tags (控え): ${cached.tags.length}`);
    return cached.tags;
  }
  const tags = [];
  for (let page = 1; page <= PAGES; page += 1) {
    const url = `https://danbooru.donmai.us/tags.json?search[order]=count&search[hide_empty]=yes&limit=1000&page=${page}`;
    const rows = await getJson(url);
    if (!Array.isArray(rows) || !rows.length) break;
    for (const row of rows) {
      if (row.category === 5) continue;
      tags.push({ name: row.name, category: row.category, postCount: row.post_count });
    }
    console.log(`  danbooru tags page ${page}: ${rows.length} (計 ${tags.length})`);
    await sleep(700);
  }
  writeJson(TAGS_CACHE, { tags, at: new Date().toISOString() });
  return tags;
}

// 既にある控えを種にする。研究時の danbooru-names.json と、
// 人物の照合で引いた danbooru-cache.json を先に取り込む
function seedWikis() {
  const byName = {};
  const research = readJson(path.join(ROOT, 'work', 'vocabulary-research', 'data', 'danbooru-names.json'), null);
  for (const [name, row] of Object.entries((research && research.rows) || {})) {
    if (row && Array.isArray(row.otherNames)) byName[name] = row.otherNames.length ? row.otherNames : null;
  }
  const identity = readJson(path.join(WORK, 'danbooru-cache.json'), null);
  for (const [name, row] of Object.entries((identity && identity.tags) || {})) {
    if (row && Array.isArray(row.otherNames)) byName[name] = row.otherNames.length ? row.otherNames : null;
  }
  return byName;
}

async function fetchWikis(tags) {
  const cached = readJson(WIKI_CACHE, null);
  const byName = (cached && cached.byName) || seedWikis();
  const wanted = [...new Set(tags.map((t) => t.name).filter(Boolean))];
  const missing = wanted.filter((n) => !Object.prototype.hasOwnProperty.call(byName, n));
  console.log(`danbooru wiki: ${wanted.length - missing.length} 控え済み / ${missing.length} を引く`);
  for (let i = 0; i < missing.length; i += 100) {
    const batch = missing.slice(i, i + 100);
    const url = `https://danbooru.donmai.us/tags.json?search[name_comma]=${batch.map(encodeURIComponent).join(',')}&only=name,category,post_count,wiki_page&limit=100`;
    const rows = await getJson(url);
    const seen = new Set();
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row || !row.name) continue;
      seen.add(row.name);
      const wiki = row.wiki_page;
      const names = (wiki && !wiki.is_deleted && Array.isArray(wiki.other_names)) ? wiki.other_names.filter(Boolean) : [];
      byName[row.name] = names.length ? names : null;
    }
    for (const name of batch) if (!seen.has(name)) byName[name] = null;
    if ((i / 100) % 20 === 19) writeJson(WIKI_CACHE, { byName, at: new Date().toISOString() });
    process.stdout.write(`\r  wiki ${Math.min(i + 100, missing.length)}/${missing.length}   `);
    await sleep(700);
  }
  if (missing.length) { writeJson(WIKI_CACHE, { byName, at: new Date().toISOString() }); console.log(''); }
  const result = new Map();
  for (const [name, names] of Object.entries(byName)) if (Array.isArray(names) && names.length) result.set(name, names);
  console.log(`日本語名を持つ danbooru tag: ${result.size}`);
  return result;
}

function main() {
  return (async () => {
    const hitomi = readJson(HITOMI, null);
    if (!hitomi || !hitomi.namespaces) throw new Error('hitomi 全語一覧がありません');
    const ns = hitomi.namespaces;
    // tagindex の返す形 [name, count, type] に合わせる。pickExact をそのまま使うため
    const lookup = (type, name) => {
      const table = ns[type];
      const term = spaced(name);
      if (!table || !Object.prototype.hasOwnProperty.call(table, term)) return null;
      return pickExact([[term, table[term], type]], term, type);
    };

    const tags = await fetchTags();
    const wikiByName = await fetchWikis(tags);

    // 中国語・韓国語の表記は鍵にも札にもしない (設計の決まり。監査 2026-09-21 で
    // 「高坂穗乃果・蠟筆小新 は入力にも札にも出さない」と決めてある)。
    // 確かな日本語だけを種にして、そこに無い字を含む漢字語を落とす
    const seed = [];
    for (const names of wikiByName.values()) for (const n of names || []) seed.push(n);
    // 控えに溜めた other_names も種にする。種にできるのは「かなを含む語」だけ
    // (japanese-script.js の決まり) なので、量が増えても中国語は混ざらない。
    // 種が痩せていると、確かに日本語な漢字だけの名前 (申鶴・穂乃果) まで落ちる
    const seedCache = readJson(path.join(WORK, 'danbooru-cache.json'), { tags: {} });
    for (const row of Object.values(seedCache.tags || {})) for (const n of (row && row.otherNames) || []) seed.push(n);
    const chars = knownKanji({ seed, fresh: true });
    const japaneseOnly = (labels) => labels.filter((label) => isJapanese(label, chars));
    console.log(`日本語と分かっている漢字: ${chars.size}`);

    const jobs = tags.filter((tag) => japaneseOnly(collectLabels(wikiByName.get(tag.name) || [])).length);
    console.log(`日本語名を持つ tag: ${jobs.length}`);

    // danbooru の人物名の括弧は所属作品 (`azusa_(blue_archive)`)。
    // 括弧の中が別名なら畳んだ先を見てから copyright か検める。
    // hitomi にも同じ名の series が在る時だけ「検索に使える所属作品」にする
    // 各サイトの語の一覧 (研究時の控え)。そのサイトで引けるかの根拠に使う
    const nhentaiNs = (readJson(NHENTAI, { namespaces: {} }).namespaces) || {};
    const NH_SPACE = { character: 'character', series: 'parody', artist: 'artist', group: 'group' };
    // 一語だけの人物名は「同名の別人」を疑う (前方一致の誤対応はそこで生まれた)。
    // 姓名が揃った名前が同じ名前空間に在る時だけ、引けると言い切る
    const siteFlags = (item) => {
      const space = NH_SPACE[item.type];
      if (!space || !nhentaiNs[space]) return null;
      const name = spaced(item.name);
      const confident = item.type !== 'character' || name.includes(' ');
      const found = Object.prototype.hasOwnProperty.call(nhentaiNs[space], name);
      return { nhentai: Boolean(found && confident) };
    };

    const identityCache = readJson(path.join(WORK, 'danbooru-cache.json'), { tags: {}, aliases: {} });
    const categoryOf = new Map(tags.map((t) => [t.name, t.category]));
    for (const [n, v] of Object.entries(identityCache.tags || {})) {
      if (v && !categoryOf.has(n)) categoryOf.set(n, v.category);
    }
    // 括弧の符丁が danbooru の語でも別名でもない時がある (`asuna_(sao)` の `sao`)。
    // copyright の語は自分の略称を other_names に並べているので、そこから引く
    // (`sword_art_online` の other_names に "SAO" が居る)。出典のある名指し
    const abbrev = new Map();
    for (const [name, names] of wikiByName) {
      if (categoryOf.get(name) !== 3) continue;
      for (const alt of names || []) {
        const key = String(alt).trim().toLowerCase().replace(/[\s-]+/g, '_');
        if (!key || /[぀-ヿ一-鿿가-힯]/.test(key)) continue;   // 訳名ではなく符丁だけ
        if (!abbrev.has(key)) abbrev.set(key, name);
      }
    }
    const seriesOfTag = (danbooruName) => {
      const m = String(danbooruName).match(/^(.+)_\((.+)\)$/);
      if (!m) return null;
      let key = m[2];
      if (categoryOf.get(key) !== 3 && (identityCache.aliases || {})[key]) key = identityCache.aliases[key];
      if (categoryOf.get(key) !== 3 && abbrev.has(key)) key = abbrev.get(key);
      if (categoryOf.get(key) !== 3) return null;
      const name = spaced(key);
      return Object.prototype.hasOwnProperty.call(ns.series, name) ? name : null;
    };

    // 括弧で所属を書いていない人物 (`okita_sougo` = 沖田総悟) の所属作品。
    // 括弧が無い以上 seriesOfTag では取れないので、scripts/vocab-collect.js が
    // danbooru の related_tag から先頭一件だけ引いて控えに置いてある。
    // ここでも hitomi の series 名前空間に在るかを改めて検める (控えを信じ切らない)
    const seriesFromCache = (danbooruName) => {
      const key = (identityCache.series || {})[danbooruName];
      if (!key) return null;
      const name = spaced(key);
      return Object.prototype.hasOwnProperty.call(ns.series, name) ? name : null;
    };

    // VTuber の所属事務所。**画面に出すためだけ**の物で、検索条件には使わない。
    // hitomi は series として hololive と nijisanji しか持たないので、
    // ぶいすぽ・あおぎり・ななしいんく等を series に入れると
    // 「押しても 0 件の札」になってしまう。だから別の枠で持つ
    const vtuberFromCache = (danbooruName) => {
      const row = (identityCache.vtuber || {})[danbooruName];
      return (row && row.label) ? { agency: row.agency || '', label: row.label } : null;
    };

    const byValue = new Map();
    for (const [label, value, type, name] of EXTRA_ALIASES) {
      byValue.set(value, { value, type, name, labels: new Set([label]), count: 0 });
    }
    const unresolved = [];
    let resolved = 0;
    for (const tag of jobs) {
      let hit = null;
      for (const type of candidateTypes(tag)) {
        for (const name of candidateNames(tag)) {
          hit = lookup(type, name);
          if (hit) break;
        }
        if (hit) break;
      }
      if (!hit) { unresolved.push({ name: tag.name, category: tag.category, postCount: tag.postCount }); continue; }
      resolved += 1;
      if (!byValue.has(hit.value)) {
        byValue.set(hit.value, { value: hit.value, type: hit.type, name: hit.name.replace(/ /g, '_'), labels: new Set(), count: hit.count || 0 });
      }
      const entry = byValue.get(hit.value);
      if ((hit.count || 0) > entry.count) entry.count = hit.count || 0;
      for (const label of japaneseOnly(collectLabels(wikiByName.get(tag.name)))) entry.labels.add(label);
      if (!entry.series) { const s = seriesOfTag(tag.name) || seriesFromCache(tag.name); if (s) entry.series = s; }
      if (!entry.vtuber) { const v = vtuberFromCache(tag.name); if (v) entry.vtuber = v; }
      // danbooru の語名は日本語の読みをローマ字にした物 (meitantei_conan / asada_shino)。
      // hitomi の英語名とは別の綴りなので、候補の索引に足すと「meitantei」で引ける
      if (!entry.romaji) entry.romaji = new Set();
      entry.romaji.add(spaced(String(tag.name).replace(/_\([^)]*\)$/, '')));
    }

    // danbooru 側から当たらない人物を、hitomi の名を主語にして拾い直す。
    // danbooru の正準が `azusa_(blue_archive)` のように所属名で決まっている時、
    // 「azusa」は hitomi に無いので上の一巡では落ちる。hitomi の `azusa shirasu`
    // から `shirasu_azusa` を引き、danbooru 自身の別名解決で正準へ渡る鎖なら
    // 行き先は一つに定まる (前方一致ではないので複写にならない)
    const identity = readJson(path.join(WORK, 'danbooru-cache.json'), { tags: {}, aliases: {} });
    let viaIdentity = 0;
    for (const [hname, count] of Object.entries(ns.character)) {
      const value = `character:${hname.replace(/ /g, '_')}`;
      if (byValue.has(value) && byValue.get(value).labels.size) continue;
      const parts = hname.split(' ');
      const candidates = [hname.replace(/ /g, '_')];
      if (parts.length === 2) candidates.push(`${parts[1]}_${parts[0]}`);
      for (const cand of candidates) {
        // 別名の鎖は「種別を検める前」に辿る。hitomi の綴り (`tenshi_hinanai`) は
        // danbooru では語ですらない (category 0) ことがあり、そこで打ち切ると
        // 渡り先の `hinanawi_tenshi` に届かない。綴り違いを拾うために別名を
        // 引いたのに、その全部が捨てられていた
        let row = identity.tags[cand];
        let used = cand;
        if (!row || row.category !== 4 || !(row.otherNames || []).length) {
          const target = identity.aliases[cand];
          const next = target ? identity.tags[target] : null;
          if (next && next.category === 4 && (next.otherNames || []).length) { row = next; used = target; }
        }
        if (!row || row.category !== 4) continue;
        const names = row.otherNames;
        if (!names || !names.length) continue;
        const labels = japaneseOnly(collectLabels(names || []));
        if (!labels.length) continue;
        if (!byValue.has(value)) byValue.set(value, { value, type: 'character', name: hname.replace(/ /g, '_'), labels: new Set(), count });
        const entry = byValue.get(value);
        for (const label of labels) entry.labels.add(label);
        if (!entry.romaji) entry.romaji = new Set();
        // 索引に足すのは「実際に日本語名を持っていた側の綴り」。鎖で渡った先が
        // 正準名なので、そちらで引けるようにする (hinanawi でも hinanai でも)
        entry.romaji.add(spaced(String(cand).replace(/_\([^)]*\)$/, '')));
        if (used !== cand) entry.romaji.add(spaced(String(used).replace(/_\([^)]*\)$/, '')));
        if (!entry.series) {
          const s = seriesOfTag(used) || seriesOfTag(cand)
            || seriesFromCache(used) || seriesFromCache(cand);
          if (s) entry.series = s;
        }
        if (!entry.vtuber) {
          const v = vtuberFromCache(used) || vtuberFromCache(cand);
          if (v) entry.vtuber = v;
        }
        if (count > entry.count) entry.count = count;
        viaIdentity += 1;
        break;
      }
    }
    console.log(`hitomi の名から鎖で拾った人物: ${viaIdentity}`);

    // 作品名も同じやり方で拾い直す。人物と違って姓名の入れ替えも括弧落としも
    // 無い — danbooru と綴りが違う時 (`ah my goddess` ↔ `aa_megami-sama`、
    // `the melancholy of haruhi suzumiya` ↔ `suzumiya_haruhi_no_yuuutsu`) は
    // danbooru 自身の別名 (identity.aliases) が一本の鎖で渡してくれる。
    // 推測ではないので複写にならない。ここが無いと、100 冊超の有名作 115 件に
    // 日本語名が付かず、人物に所属作品を付けても画面には出ないままになる
    let viaSeries = 0;
    for (const [hname, count] of Object.entries(ns.series)) {
      const value = `series:${hname.replace(/ /g, '_')}`;
      if (byValue.has(value) && byValue.get(value).labels.size) continue;
      const cand = hname.replace(/ /g, '_');
      let row = identity.tags[cand];
      let used = cand;
      // 日本語名が無い時だけでなく、**種別が違う時も**渡り先を見る。
      // hitomi の作品名 `sailor moon` は danbooru では人物 (category 4) の語で、
      // 日本語名も持っている。そこで打ち切ると作品の
      // `bishoujo_senshi_sailor_moon` へ永遠に届かない
      if (!row || row.category !== 3 || !(row.otherNames || []).length) {
        const target = identity.aliases[cand];
        const next = target ? identity.tags[target] : null;
        if (next && next.category === 3 && (next.otherNames || []).length) { row = next; used = target; }
      }
      if (!row || row.category !== 3) continue;
      const labels = japaneseOnly(collectLabels(row.otherNames || []));
      if (!labels.length) continue;
      if (!byValue.has(value)) byValue.set(value, { value, type: 'series', name: cand, labels: new Set(), count });
      const entry = byValue.get(value);
      for (const label of labels) entry.labels.add(label);
      // danbooru 側の綴り (suzumiya_haruhi_no_yuuutsu) も候補の索引に足す
      if (used !== cand) {
        if (!entry.romaji) entry.romaji = new Set();
        entry.romaji.add(spaced(used));
      }
      if (count > entry.count) entry.count = count;
      viaSeries += 1;
    }
    console.log(`hitomi の名から鎖で拾った作品: ${viaSeries}`);

    // hitomi に無いが pixiv では引ける人物 (VTuber の大半)。
    // pixiv は日本語のタグで引くサイトなので、名前さえ合っていれば作品はある。
    // **hitomi と nhentai には出さない** (出しても 0 件) — sites の印で分ける。
    // 語は danbooru の名をそのまま使う (danbooru 内で一意。hitomi へは送らないので
    // 記号が入っていても困らない)。確かめたのは scripts/vocab-collect.js の
    // --phase=pixivonly (pixiv 百科事典に記事があるか)
    let pixivOnlyRows = 0;
    for (const [dan, row] of Object.entries(identityCache.pixivOnly || {})) {
      const value = `character:${dan}`;
      if (byValue.has(value)) continue;                       // hitomi 側に同じ語があるなら要らない
      const labels = japaneseOnly(collectLabels(row.labels || []));
      if (!labels.length) continue;
      const entry = {
        value, type: 'character', name: dan, labels: new Set(labels), count: 0,
        sites: { hitomi: false, nhentai: row.nhentai === true, pixiv: true },
      };
      if (row.agencyLabel) entry.vtuber = { agency: row.agency || '', label: row.agencyLabel };
      byValue.set(value, entry);
      pixivOnlyRows += 1;
    }
    console.log(`hitomi に無く pixiv で引ける人物: ${pixivOnlyRows}`);

    // 既にある行の札の並びは動かさない。並びがそのまま「どれが正式か」なので、
    // 順が変わると画面に出る名前が変わる。控えを厚くしたら danbooru の
    // other_names が増え、中国語訳 (芭芭拉・棘冠恩典・磐祭叶守) が先頭へ
    // 割り込んで、バーバラ・ロサリア・神里綾人 を押しのけていた。
    // isJapanese は字種しか見ないので、日本語にもある漢字で書かれた中国語は通る。
    // 新しい語は後ろに足すだけにして、2026-08 に検めた並びを守る
    const priorOrder = new Map(
      (readJson(TARGET, { entries: [] }).entries || []).map((e) => [e.value, e.labels || []]),
    );
    const entries = [];
    for (const item of byValue.values()) {
      // 並べ替えない。danbooru の other_names は正式名が先頭に来る並びで、
      // その順そのものが「どれが正式か」の手がかりになる (札選びが使う)
      const found = [...item.labels];
      const prior = priorOrder.get(item.value);
      const labels = prior
        ? [...prior.filter((l) => found.includes(l)), ...found.filter((l) => !prior.includes(l))]
        : found;
      if (!labels.length) continue;
      const row = { value: item.value, type: item.type, name: item.name, labels, keys: labels, count: item.count || 0 };
      if (item.series) row.series = item.series;
      // 所属事務所は画面専用。検索値には出さない (hitomi に無い語があるため)
      if (item.vtuber) row.vtuber = item.vtuber;
      if (item.romaji && item.romaji.size) {
        const own = spaced(item.name);
        const list = [...item.romaji].filter((r) => r && r !== own);
        if (list.length) row.romaji = list;
      }
      // そのサイトで実際に引ける語か (研究時の一覧が根拠)。名前が同じだけの
      // 一語の人物名は「確かめた」とは言わない — 誤対応はそこで生まれた
      // pixiv 専用の行は自分で印を持っている。siteFlags (hitomi 前提) で潰さない
      const sites = item.sites || siteFlags(item);
      if (sites) row.sites = sites;
      entries.push(row);
    }
    entries.sort((a, b) => (b.count || 0) - (a.count || 0) || a.value.localeCompare(b.value));

    // ---- 差分 ----
    const before = readJson(TARGET, { entries: [] });
    const oldByValue = new Map(before.entries.map((e) => [e.value, e]));
    const newByValue = new Map(entries.map((e) => [e.value, e]));
    const same = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
    const report = { at: new Date().toISOString(), removed: [], added: [], changed: [], kept: 0 };
    for (const [value, old] of oldByValue) {
      const next = newByValue.get(value);
      if (!next) { report.removed.push({ value, labels: old.labels, count: old.count }); continue; }
      if (same(old.labels, next.labels)) report.kept += 1;
      else report.changed.push({ value, from: old.labels, to: next.labels, count: next.count });
    }
    for (const [value, next] of newByValue) {
      if (!oldByValue.has(value)) report.added.push({ value, labels: next.labels, count: next.count });
    }

    // ---- 組み直しても前方一致の複写が復活していないか ----
    // 数え方は build-aliases.copiedLabelFamilies が持つ。試験 (search-identity)
    // と同じ関数を呼ぶので、片方だけ緩めて番人がすり抜けることがない
    const families = copiedLabelFamilies(entries);

    const summary = {
      danbooruTags: tags.length,
      withJapanese: jobs.length,
      resolved,
      unresolved: unresolved.length,
      entriesBefore: before.entries.length,
      entriesAfter: entries.length,
      kept: report.kept,
      changed: report.changed.length,
      added: report.added.length,
      removed: report.removed.length,
      prefixFamiliesAfter: families.length,
    };
    console.log(JSON.stringify(summary, null, 2));
    if (families.length) console.log('前方一致の複写が残っている:', JSON.stringify(families.slice(0, 5)));

    fs.mkdirSync(WORK, { recursive: true });
    fs.writeFileSync(REPORT, JSON.stringify({ summary, ...report, families,
      unresolved: unresolved.sort((a, b) => (b.postCount || 0) - (a.postCount || 0)).slice(0, 600) }, null, 1));
    console.log(`report -> ${REPORT}`);

    if (DRY) { console.log('--dry: aliases.json は書き換えていない'); return; }
    const payload = {
      version: 3,
      builtAt: new Date().toISOString(),
      source: 'danbooru-tag-wikis+hitomi-alltags',
      stats: summary,
      entries,
    };
    fs.writeFileSync(TARGET, `${JSON.stringify(payload)}\n`);
    console.log(`wrote ${TARGET}`);
  })();
}

// 直に叩かれた時だけ走る。require しただけで網へ出て辞書を書き換えないこと
if (require.main === module) main().catch((error) => { console.error(error); process.exit(1); });

module.exports = { main };
