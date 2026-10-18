const fs = require('fs');
const path = require('path');
const { get } = require('../src/lib/http');
const { aliasKey, hasCjk } = require('../src/lib/search-text');

const ROOT = path.join(__dirname, '..');
const CACHE_DIR = path.join(ROOT, '_tmp', 'alias-build');
const OUT_PATH = path.join(ROOT, 'src', 'lib', 'data', 'aliases.json');
const MANUAL_PATH = path.join(ROOT, 'src', 'lib', 'data', 'manual-aliases.json');
const DANBOORU_UA = 'hitomi-box/1.0 (alias dictionary build; local desktop app)';

const NAME_REMAP = {
  large_breasts: 'big breasts',
  big_breasts: 'big breasts',
  huge_breasts: 'huge breasts',
  gigantic_breasts: 'gigantic breasts',
  small_breasts: 'small breasts',
  flat_chest: 'flat chest',
  wide_hips: 'wide hips',
  thick_thighs: 'thick thighs',
  mind_control: 'mind control',
  sole_female: 'sole female',
  sole_male: 'sole male',
  full_color: 'full color',
  mosaic_censoring: 'mosaic censorship',
  bar_censor: 'bar censor',
  pubic_hair: 'pubic hair',
  dark_skin: 'dark skin',
  dark_skinned_female: 'dark skin',
  dark_skinned_male: 'dark skin',
  big_ass: 'big ass',
  huge_ass: 'huge ass',
  large_areolae: 'big areolae',
  big_areolae: 'big areolae',
  large_penis: 'big penis',
  big_penis: 'big penis',
  small_penis: 'small penis',
  titfuck: 'paizuri',
  ntr: 'netorare',
  ugly_bastard: 'ugly bastard',
  mind_break: 'mind break',
  raped: 'rape',
  gangbang: 'group',
  group_sex: 'group',
  ffm_threesome: 'ffm threesome',
  mmf_threesome: 'mmf threesome',
  genderswap: 'gender morph',
  monster_girl: 'monster girl',
  demon_girl: 'demon girl',
  cat_girl: 'catgirl',
  fox_girl: 'fox girl',
  school_uniform: 'schoolgirl uniform',
  schoolgirl_uniform: 'schoolgirl uniform',
  shota: 'shotacon',
  hypnosis: 'mind control', // hitomi に hypnosis タグはない。催眠/催眠術 → female:mind_control
  trap: 'tomgirl', // 男の娘。female:tomgirl は無いので candidateTypes の順で male:tomgirl に落ちる
  otokonoko: 'tomgirl',
};

const LABEL_STOP = new Set([
  'たま', '原画', '原創', 'パロ', '学パロ', 'おね', 'ペド', 'オバケ', '部',
  'イラスト', 'ファンアート', '同人', '漫画',
]);

const EXTRA_ALIASES = [
  ['日本語', 'language:japanese', 'language', 'japanese'],
  ['英語', 'language:english', 'language', 'english'],
  ['中国語', 'language:chinese', 'language', 'chinese'],
  ['韓国語', 'language:korean', 'language', 'korean'],
  ['同人誌', 'type:doujinshi', 'type', 'doujinshi'],
  ['漫画', 'type:manga', 'type', 'manga'],
  ['アニメ', 'type:anime', 'type', 'anime'],
];

const CATEGORY = { general: 0, artist: 1, copyright: 3, character: 4 };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(data)}\n`);
}

function spaced(name) {
  return String(name || '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

function encodeTermPath(term) {
  return String(term)
    .split('')
    .map((ch) => {
      if (ch === ' ') return '_';
      if (ch === '/') return 'slash';
      if (ch === '.') return 'dot';
      return encodeURIComponent(ch);
    })
    .join('/');
}

function usableLabel(text) {
  if (!text || !hasCjk(text) || text.length > 24) return false;
  if (LABEL_STOP.has(text)) return false;
  if (/イラスト|ファンアート|ヤンデレ部|部$/.test(text) && text.length > 6) return false;
  const hiraOnly = /^[ぁ-ん]+$/.test(text);
  if (hiraOnly && text.length < 3) return false;
  return true;
}

function jpKeys(name) {
  const text = String(name || '').trim();
  if (!usableLabel(text)) return [];
  const keys = [text];
  const person = text.match(/^([\u4E00-\u9FFF]{1,4})([ァ-ヶーぁ-ん]{2,})$/);
  if (person && usableLabel(person[2])) keys.push(person[2]);
  return [...new Set(keys)];
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function getJson(url, headers = {}, retries = 4) {
  let lastError;
  for (let i = 0; i < retries; i += 1) {
    try {
      const res = await get(url, headers);
      return res.json();
    } catch (error) {
      lastError = error;
      if (error.status === 404) return null;
      await sleep(400 * (i + 1));
    }
  }
  throw lastError;
}

async function fetchDanbooruTags() {
  const cachePath = path.join(CACHE_DIR, 'danbooru-tags.json');
  const cached = readJson(cachePath, null);
  if (cached && Array.isArray(cached.tags) && cached.tags.length > 1000) {
    console.log(`danbooru tags cache: ${cached.tags.length}`);
    return cached.tags;
  }
  const tags = [];
  for (let page = 1; page <= 15; page += 1) {
    const url = `https://danbooru.donmai.us/tags.json?search[order]=count&search[hide_empty]=yes&limit=1000&page=${page}`;
    const rows = await getJson(url, { 'User-Agent': DANBOORU_UA, Accept: 'application/json' });
    if (!Array.isArray(rows) || !rows.length) break;
    for (const row of rows) {
      if (row.category === 5) continue;
      tags.push({
        name: row.name,
        category: row.category,
        postCount: row.post_count,
      });
    }
    console.log(`danbooru tags page ${page}: ${rows.length} (kept ${tags.length})`);
    await sleep(700);
  }
  writeJson(cachePath, { tags, at: new Date().toISOString() });
  return tags;
}

async function fetchWikiOtherNames(tags) {
  const cachePath = path.join(CACHE_DIR, 'danbooru-tag-wikis.json');
  const cached = readJson(cachePath, null);
  const byName = (cached && cached.byName && typeof cached.byName === 'object') ? cached.byName : {};
  const wanted = [...new Set(tags.map((tag) => tag.name).filter(Boolean))];
  const missing = wanted.filter((name) => !Object.prototype.hasOwnProperty.call(byName, name));
  console.log(`danbooru tag wikis: ${wanted.length - missing.length} cached, ${missing.length} to fetch`);

  const batches = [];
  for (let i = 0; i < missing.length; i += 100) batches.push(missing.slice(i, i + 100));

  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i];
    const query = batch.map((name) => encodeURIComponent(name)).join(',');
    const url = `https://danbooru.donmai.us/tags.json?search[name_comma]=${query}&only=name,category,post_count,wiki_page&limit=100`;
    let rows = null;
    try {
      rows = await getJson(url, { 'User-Agent': DANBOORU_UA, Accept: 'application/json' });
    } catch {
      rows = null;
    }
    const seen = new Set();
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (!row || !row.name) continue;
        seen.add(row.name);
        const wiki = row.wiki_page;
        const names = (wiki && !wiki.is_deleted && Array.isArray(wiki.other_names))
          ? wiki.other_names.filter(Boolean)
          : [];
        byName[row.name] = names.length ? names : null;
      }
    }
    for (const name of batch) if (!seen.has(name)) byName[name] = null;
    console.log(`danbooru tag wiki batch ${i + 1}/${batches.length} (${batch.length} names)`);
    if ((i + 1) % 20 === 0) writeJson(cachePath, { byName, at: new Date().toISOString() });
    if (i + 1 < batches.length) await sleep(700);
  }
  if (missing.length) writeJson(cachePath, { byName, at: new Date().toISOString() });

  const result = new Map();
  for (const [name, names] of Object.entries(byName)) {
    if (Array.isArray(names) && names.length) result.set(name, names);
  }
  console.log(`danbooru tag wikis with other_names: ${result.size}`);
  return result;
}

const tagLookupCache = new Map();
const TAG_CACHE_PATH = path.join(CACHE_DIR, 'tagindex-cache.json');

function loadTagCache() {
  const cached = readJson(TAG_CACHE_PATH, null);
  if (cached && cached.entries) {
    for (const [key, value] of Object.entries(cached.entries)) tagLookupCache.set(key, value);
    console.log(`tagindex cache: ${tagLookupCache.size}`);
  }
}

function saveTagCache() {
  writeJson(TAG_CACHE_PATH, { entries: Object.fromEntries(tagLookupCache), at: new Date().toISOString() });
}

function toHit(row) {
  return { type: row[2], name: row[0], count: row[1], value: `${row[2]}:${String(row[0]).replace(/ /g, '_')}` };
}

// 当たりは「語がそっくり同じ」時だけ。前方一致は使わない。
// 以前はここで `azusa` に前方一致する character を全部拾い、danbooru の
// 「アズサ/白洲アズサ」一式を六人ぶん複写していた (白洲アズサ で中野梓が出た正体)。
// 一件しか前方一致しない時に当たりへ昇格させるのも同じ誤り
// (朝田詩乃 が sinon_kouzuki を一意に指した)。下の名前は人を決めない。
function pickExact(rows, term, type) {
  if (!Array.isArray(rows)) return null;
  const exact = rows.find((row) => row[0] === term && row[2] === type)
    || rows.find((row) => row[0] === term);
  return exact ? toHit(exact) : null;
}

async function lookupHitomi(type, name) {
  const term = spaced(name);
  if (!term) return { hit: null, extras: [] };
  const cacheKey = `${type}:${term}`;
  if (tagLookupCache.has(cacheKey)) return tagLookupCache.get(cacheKey);
  const url = `https://tagindex.hitomi.la/${type}/${encodeTermPath(term)}.json`;
  let rows = null;
  try {
    rows = await getJson(url, { Referer: 'https://hitomi.la/' }, 2);
  } catch {
    rows = null;
  }
  const hit = pickExact(rows, term, type);
  const extras = [];
  const resolved = { hit, extras };
  tagLookupCache.set(cacheKey, resolved);
  return resolved;
}

function candidateTypes(tag) {
  if (tag.category === CATEGORY.artist) return ['artist'];
  if (tag.category === CATEGORY.copyright) return ['series'];
  if (tag.category === CATEGORY.character) return ['character'];
  return ['female', 'male', 'tag'];
}

// danbooru の人名は 姓_名、hitomi は 名 姓。同じ人物の同じフルネームなので
// 並べ替えは名指しの照合であって推測ではない (asada_shino ↔ shino asada)。
// 二語ちょうどの時だけ。三語以上や欧文の名義は並びが姓名とは限らない
function swapped(name) {
  const parts = spaced(name).split(' ');
  return parts.length === 2 ? `${parts[1]} ${parts[0]}` : '';
}

function candidateNames(tag) {
  const names = [spaced(tag.name)];
  const stripped = spaced(tag.name.replace(/_\([^)]+\)$/, '').replace(/\s*\([^)]+\)$/, ''));
  if (stripped && stripped !== names[0]) names.push(stripped);
  if (tag.category === CATEGORY.character) {
    for (const base of [names[0], stripped]) {
      const flipped = swapped(base);
      if (flipped) names.push(flipped);
    }
  }
  const remapped = NAME_REMAP[tag.name] || NAME_REMAP[stripped.replace(/ /g, '_')];
  if (remapped) names.push(spaced(remapped));
  return [...new Set(names.filter(Boolean))];
}

// 当たらなかった tag は捨てずに数える。黙って消えると「有名作が引けない」の
// 原因 (danbooru の正準名と hitomi の正準名が違う) が見えないまま残る
const unresolvedTags = [];

async function resolveTag(tag) {
  for (const type of candidateTypes(tag)) {
    for (const name of candidateNames(tag)) {
      const { hit } = await lookupHitomi(type, name);
      if (hit) return { hits: [hit] };
    }
  }
  unresolvedTags.push({ name: tag.name, category: tag.category, postCount: tag.postCount });
  return null;
}

const MANUAL_TYPES = new Set([
  'artist', 'group', 'type', 'language', 'series', 'character', 'male', 'female', 'tag',
]);

async function verifyManualAliases() {
  const manual = readJson(MANUAL_PATH, null);
  const entries = (manual && Array.isArray(manual.entries)) ? manual.entries : [];
  if (!entries.length) {
    console.log('no manual aliases');
    return { failures: [] };
  }

  const failures = [];
  let verified = 0;
  const seenValues = new Set();
  const preferredKeys = new Map();

  for (const entry of entries) {
    const value = String(entry.value || '').trim();
    const labels = (Array.isArray(entry.labels) ? entry.labels.map(String) : []).filter(Boolean);
    if (seenValues.has(value)) console.log(`  warn: duplicate value ${value}`);
    seenValues.add(value);
    if (entry.preferred) {
      for (const label of labels) {
        const key = aliasKey(label);
        if (!key) continue;
        const owner = preferredKeys.get(key);
        if (owner && owner !== value) console.log(`  warn: preferred key collision "${label}" (${owner} vs ${value})`);
        preferredKeys.set(key, value);
      }
    }

    const match = value.match(/^([a-z]+):(.+)$/);
    if (!match || !MANUAL_TYPES.has(match[1])) {
      failures.push({ value, reason: 'malformed value or unknown type' });
      continue;
    }
    if (!labels.length) {
      failures.push({ value, reason: 'no labels' });
      continue;
    }
    const [, type, name] = match;
    if (type === 'type' || type === 'language') {
      verified += 1;
      continue;
    }
    const { hit } = await lookupHitomi(type, spaced(name));
    if (!hit) {
      failures.push({ value, reason: 'not found in tagindex' });
      continue;
    }
    if (hit.value !== value) {
      failures.push({ value, reason: `tagindex resolved to ${hit.value}` });
      continue;
    }
    entry.count = hit.count;
    verified += 1;
  }

  const payload = {};
  if (manual.$comment) payload.$comment = manual.$comment;
  payload.entries = entries;
  fs.writeFileSync(MANUAL_PATH, `${JSON.stringify(payload, null, 2)}\n`);

  console.log(`manual aliases: ${verified} verified, ${failures.length} failed`);
  for (const failure of failures) console.log(`  fail: ${failure.value || '(empty)'} - ${failure.reason}`);
  return { failures };
}

function collectLabels(otherNames) {
  const labels = [];
  for (const name of otherNames || []) labels.push(...jpKeys(name));
  return [...new Set(labels)];
}

async function main() {
  ensureDir(CACHE_DIR);
  loadTagCache();
  console.log('fetching danbooru tags...');
  const tags = await fetchDanbooruTags();
  console.log('fetching danbooru wiki other_names...');
  const wikiByTitle = await fetchWikiOtherNames(tags);

  const jobs = tags.filter((tag) => collectLabels(wikiByTitle.get(tag.name) || []).length);
  console.log(`tags with japanese names: ${jobs.length}`);

  let resolved = 0;
  const byValue = new Map();
  for (const [label, value, type, name] of EXTRA_ALIASES) {
    byValue.set(value, { value, type, name, labels: new Set([label]), count: 0 });
  }

  await mapLimit(jobs, 8, async (tag, index) => {
    const found = await resolveTag(tag);
    if (found) {
      const labels = collectLabels(wikiByTitle.get(tag.name));
      for (const hit of found.hits) {
        if (!byValue.has(hit.value)) {
          byValue.set(hit.value, {
            value: hit.value,
            type: hit.type,
            name: hit.name.replace(/ /g, '_'),
            labels: new Set(),
            count: hit.count || 0,
          });
        }
        const entry = byValue.get(hit.value);
        if (hit.count > entry.count) entry.count = hit.count;
        for (const label of labels) entry.labels.add(label);
      }
      resolved += 1;
    }
    if ((index + 1) % 200 === 0) {
      console.log(`resolved ${index + 1}/${jobs.length} (hits ${resolved})`);
    }
  });

  const entries = [];
  for (const item of byValue.values()) {
    const labels = [...item.labels];
    if (!labels.length) continue;
    labels.sort((a, b) => a.length - b.length || a.localeCompare(b, 'ja'));
    entries.push({
      value: item.value,
      type: item.type,
      name: item.name,
      labels,
      keys: labels,
      count: item.count || 0,
    });
  }
  entries.sort((a, b) => (b.count || 0) - (a.count || 0) || a.value.localeCompare(b.value));

  const payload = {
    version: 2,
    builtAt: new Date().toISOString(),
    source: 'danbooru-tag-wikis+tagindex',
    stats: {
      danbooruTags: tags.length,
      wikiPages: wikiByTitle.size,
      candidates: jobs.length,
      resolved,
      unresolved: unresolvedTags.length,
      entries: entries.length,
    },
    entries,
  };
  saveTagCache();
  // 当たらなかった tag の控え。hitomi 側の正準名が danbooru と違うだけの物
  // (boku no hero academia / meitantei conan) はここに並ぶ。拾い上げは
  // search-vocabulary.json 側の仕事 (出典付きで人が採る)
  writeJson(path.join(CACHE_DIR, 'unresolved.json'), {
    at: new Date().toISOString(),
    tags: unresolvedTags.sort((a, b) => (b.postCount || 0) - (a.postCount || 0)),
  });
  await verifyManualAliases();
  ensureDir(path.dirname(OUT_PATH));
  fs.writeFileSync(OUT_PATH, `${JSON.stringify(payload)}\n`);
  console.log(JSON.stringify(payload.stats, null, 2));
  console.log(`wrote ${OUT_PATH}`);

  delete require.cache[require.resolve('../src/lib/data/aliases.json')];
  try {
    delete require.cache[require.resolve('../src/lib/data/manual-aliases.json')];
  } catch {
    // manual dictionary is optional
  }
  delete require.cache[require.resolve('../src/lib/search-aliases')];
  const aliases = require('../src/lib/search-aliases');
  const samples = [
    'ヤンデレ', 'ブルアカ', 'ブルーアーカイブ', '巨乳', '爆乳', 'セリナ', '鷲見セリナ',
    '催眠', '男の娘', 'ショタ', '寝取られ', '触手', 'ふたなり',
  ];
  for (const sample of samples) {
    const hits = aliases.lookup(sample).map((item) => item.value);
    const unique = aliases.uniqueLookup(sample);
    console.log(`  ${sample} -> ${unique ? unique.value : `(${hits.join(', ') || 'none'})`}`);
  }
}

async function manualOnly() {
  ensureDir(CACHE_DIR);
  loadTagCache();
  const { failures } = await verifyManualAliases();
  saveTagCache();
  process.exit(failures.length ? 1 : 0);
}

// 走り出すのは直に叩かれた時だけ。試験が require した途端に danbooru を
// 引きに行ってはいけない (照合の規則そのものを単体で試したい)
if (require.main === module) {
  const run = process.argv.includes('--manual') ? manualOnly : main;
  run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

// 「同じ別名一式が複数の人物へ複写されていないか」を数える。番人と、その試験
// (test/search-identity.test.js) の両方がこれを呼ぶ。二度書くと片方だけ直した時にずれる。
//
// 疑うのは「下の名前が同じで姓が違う人物が、同じ札一式を持っている」形。
// ただし次の二つは複写ではないので除く:
//   1 同じ人物の綴り違い (nami hito / nami hitou、reika ryuuzaki / reika ryuzaki)
//     — 長音と語順を畳んだ鍵が揃う
//   2 danbooru 自身が同じ語だと言っている二つ (miho miho / miho nishizumi)
//     — 組み立て時に辿った鎖の先を romaji に残してあるので、それが重なる
// 作品名には姓名の分け方が当てはまらない (fire_emblem_fates の「姓」は emblem_fates)
// ので人物だけを見る。
function copiedLabelFamilies(entries) {
  const { foldRomajiName } = require('../src/lib/search-text');
  const bySignature = new Map();
  for (const entry of entries || []) {
    const key = `${entry.type}|${(entry.labels || []).slice().sort().join('~')}`;
    if (!bySignature.has(key)) bySignature.set(key, []);
    bySignature.get(key).push(entry);
  }
  const given = (e) => String(e.name).split('_')[0];
  const family = (e) => String(e.name).split('_').slice(1).join('_');
  // その項目が「誰を指しているか」の鍵。自分の名と、鎖で辿り着いた danbooru の名
  const identity = (e) => new Set([
    foldRomajiName(e.name),
    ...(e.romaji || []).map((r) => foldRomajiName(r)),
  ].filter(Boolean));
  const sharesIdentity = (group) => {
    const sets = group.map(identity);
    return [...sets[0]].some((k) => sets.every((s) => s.has(k)));
  };
  return [...bySignature.values()]
    .filter((g) => g.length > 1
      && g.every((e) => e.type === 'character')
      // pixiv 専用の行は hitomi に無い別人なので、姓名の突き合わせの対象にしない
      && g.every((e) => !(e.sites && e.sites.hitomi === false))
      && new Set(g.map(given)).size === 1
      && new Set(g.map(family).filter(Boolean)).size > 1
      && !sharesIdentity(g))
    .map((g) => g.map((e) => e.value));
}

module.exports = {
  pickExact, candidateNames, candidateTypes, swapped, spaced, jpKeys, collectLabels, usableLabel,
  copiedLabelFamilies,
};
