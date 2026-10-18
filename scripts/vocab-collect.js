'use strict';
// hitomi の語を主語にして danbooru へ訊き、人物・作品の日本語名と所属作品を集める。
// 設計と数字は docs/character-vocabulary-2026-09-21.md。
//
// 既存の build-aliases.js は danbooru の人気上位 15,000 語から hitomi へ落としていた。
// その切り方だと postCount 1038 未満が丸ごと落ちる (沖田総悟 = okita_sougo は 951)。
// ここは向きを逆にして、hitomi にある語を一つずつ danbooru へ訊く。
//
// 出す物は「厚くした danbooru-cache.json」だけ。aliases.json は触らない
// (触っても次の rebuild-aliases.js で消える)。生成は既存の関門に通す。
//
//   node scripts/vocab-collect.js --phase=ask     hitomi の名をそのまま訊く
//   node scripts/vocab-collect.js --phase=alias   綴り違いを正準へ渡す

//   node scripts/vocab-collect.js --phase=series  括弧なし人物の所属作品を引く
//   node scripts/vocab-collect.js --phase=merge   監査用の控えへ畳む
//
// どの段も途中で止めてよい。答えは URL ごとに控えるので、もう一度動かすと続きから。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const WORK = path.join(ROOT, 'work', 'character-vocab-2026-09-21');
const BODIES = path.join(WORK, 'bodies');
const STATE = path.join(WORK, 'state.json');
const AUDIT = path.join(ROOT, 'work', 'vocabulary-audit-2026-09-21');
const RESEARCH = path.join(ROOT, 'work', 'vocabulary-research', 'data');

const UA = 'bunko/1.0 (personal doujinshi library; one user; dictionary build)';
const PACE_MS = Number(process.env.VOCAB_PACE || 1100);
// 作品数の下限。裾 (1〜4 冊) まで網に触るのは割に合わないので既定で切る
const MIN_CHAR = Number(process.env.VOCAB_MIN_CHAR || 2);
const MIN_SERIES = Number(process.env.VOCAB_MIN_SERIES || 2);
const LIMIT = Number(process.env.VOCAB_LIMIT || 0);   // 0 = 無制限

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};
const writeJson = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const spaced = (name) => String(name || '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
const under = (name) => spaced(name).replace(/ /g, '_');

// ---- 一本の口 --------------------------------------------------------------
// 直列。答えは URL の指紋で控えるので、止めて動かし直すと続きから進む

const agent = new https.Agent({ keepAlive: true, maxSockets: 2, timeout: 30000 });
let lastAt = 0;

function request(url) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = https.request({
      method: 'GET',
      host: target.host,
      path: `${target.pathname}${target.search}`,
      family: 4,
      agent,
      headers: { 'User-Agent': UA, Accept: 'application/json', 'Accept-Encoding': 'gzip, deflate' },
      timeout: 45000,
    }, (res) => {
      const chunks = [];
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      const stream = enc === 'gzip' ? res.pipe(zlib.createGunzip())
        : enc === 'deflate' ? res.pipe(zlib.createInflate()) : res;
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      stream.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function getJson(url) {
  const key = crypto.createHash('sha256').update(url).digest('hex').slice(0, 32);
  const file = path.join(BODIES, `${key}.json`);
  const cached = readJson(file, null);
  if (cached) return cached.json;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const wait = Math.max(0, PACE_MS - (Date.now() - lastAt));
    if (wait) await sleep(wait);
    lastAt = Date.now();
    let res = null;
    try { res = await request(url); } catch (error) { res = { status: 0, text: String(error && error.message) }; }
    if (res.status === 200) {
      let json = null;
      try { json = JSON.parse(res.text); } catch { json = null; }
      if (json !== null) {
        fs.mkdirSync(BODIES, { recursive: true });
        writeJson(file, { url, json, at: new Date().toISOString() });
        return json;
      }
    }
    // 429 / 5xx は待って引き直す。404 と取り違えない
    if (res.status === 404) return null;
    await sleep(2000 * (attempt + 1));
  }
  console.log(`  ! あきらめた (取れなかった = 「無い」ではない): ${url.slice(0, 120)}`);
  return undefined;   // undefined = 未取得、null = 無い
}

// ---- 素材 ------------------------------------------------------------------

function load() {
  const hv = readJson(path.join(RESEARCH, 'hitomi-vocabulary.json'), null);
  const nv = readJson(path.join(RESEARCH, 'nhentai-vocabulary.json'), null);
  const research = readJson(path.join(RESEARCH, 'danbooru-names.json'), { rows: {} }).rows;
  if (!hv || !nv) throw new Error('研究時の控えが要る (work/vocabulary-research/data)');
  const state = readJson(STATE, { tags: {}, aliases: {}, series: {}, phases: {} });
  // 研究時の行を種にする。同じ物を二度訊かない
  let seeded = 0;
  for (const [name, row] of Object.entries(research)) {
    if (state.tags[name]) continue;
    state.tags[name] = {
      category: row.category, postCount: row.postCount || 0, otherNames: row.otherNames || [], from: 'research',
    };
    seeded += 1;
  }
  if (seeded) console.log(`研究時の控えから取り込んだ: ${seeded} 行`);
  return { hv, nv, state };
}

const save = (state) => writeJson(STATE, state);

// hitomi の名 -> danbooru で訊く綴りの候補 (姓名の入れ替えは二語ちょうどの時だけ)
function variants(name) {
  const base = spaced(name);
  const out = new Set([base.replace(/ /g, '_')]);
  const parts = base.split(' ');
  if (parts.length === 2) out.add(`${parts[1]}_${parts[0]}`);
  return [...out].filter((v) => v && v.length <= 100 && !/[,*%&?#]/.test(v));
}

const hasJp = (row) => Boolean(row && Array.isArray(row.otherNames)
  && row.otherNames.some((s) => /[぀-ヿ一-鿿]/.test(String(s))));

// その hitomi 名が既に日本語名へ届いているか
function settled(state, name) {
  return variants(name).some((v) => hasJp(state.tags[v]));
}

function wanted(hv, state, kind) {
  const ns = kind === 'character' ? hv.namespaces.character : hv.namespaces.series;
  const min = kind === 'character' ? MIN_CHAR : MIN_SERIES;
  const rows = Object.entries(ns)
    .filter(([, count]) => count >= min)
    .map(([name, count]) => ({ name, count }))
    .filter((row) => !settled(state, row.name))
    .sort((a, b) => b.count - a.count);
  return LIMIT ? rows.slice(0, LIMIT) : rows;
}

// ---- 段: 名前をそのまま訊く -------------------------------------------------

async function phaseAsk(hv, state) {
  const todo = [];
  for (const kind of ['character', 'series']) {
    for (const row of wanted(hv, state, kind)) {
      for (const v of variants(row.name)) if (!(v in state.tags)) todo.push(v);
    }
  }
  const names = [...new Set(todo)];
  console.log(`[ask] 訊く綴り: ${names.length} (${Math.ceil(names.length / 100)} 回)`);
  for (let i = 0; i < names.length; i += 100) {
    const batch = names.slice(i, i + 100);
    const q = batch.map(encodeURIComponent).join(',');
    const url = `https://danbooru.donmai.us/tags.json?search%5Bname_comma%5D=${q}&only=name,category,post_count,wiki_page&limit=100`;
    const rows = await getJson(url);
    if (rows === undefined) continue;          // 取れなかった。次で引き直す
    const seen = new Set();
    for (const row of rows || []) {
      if (!row || !row.name) continue;
      seen.add(row.name);
      state.tags[row.name] = {
        category: row.category,
        postCount: row.post_count || 0,
        otherNames: (row.wiki_page && row.wiki_page.other_names) || [],
        from: 'ask',
      };
    }
    // 返らなかった綴りは「danbooru に無い」。空行として控え、二度と訊かない
    for (const name of batch) if (!seen.has(name)) state.tags[name] = { category: null, postCount: 0, otherNames: [], from: 'absent' };
    if ((i / 100) % 10 === 0) { save(state); console.log(`  [ask] ${i + batch.length}/${names.length}`); }
  }
  save(state);
}

// ---- 段: 綴り違いを正準へ ---------------------------------------------------

async function phaseAlias(hv, state) {
  const todo = [];
  for (const kind of ['character', 'series']) {
    for (const row of wanted(hv, state, kind)) {
      for (const v of variants(row.name)) {
        if (v in state.aliases) continue;
        if (hasJp(state.tags[v])) continue;
        todo.push(v);
      }
    }
  }
  const names = [...new Set(todo)];
  console.log(`[alias] 別名を訊く綴り: ${names.length} (${Math.ceil(names.length / 100)} 回)`);
  const found = [];
  for (let i = 0; i < names.length; i += 100) {
    const batch = names.slice(i, i + 100);
    const q = batch.map(encodeURIComponent).join(',');
    const url = `https://danbooru.donmai.us/tag_aliases.json?search%5Bantecedent_name_comma%5D=${q}&only=antecedent_name,consequent_name,status&limit=200`;
    const rows = await getJson(url);
    if (rows === undefined) continue;
    for (const row of rows || []) {
      if (!row || !row.antecedent_name || !row.consequent_name) continue;
      // status は active / deleted / pending。deleted でも「同じ物を指していた」
      // 事実は残るので鎖として使う。使う前に日本語名の有無で必ず検める
      state.aliases[row.antecedent_name] = row.consequent_name;
      found.push(row.consequent_name);
    }
    for (const name of batch) if (!(name in state.aliases)) state.aliases[name] = null;
    if ((i / 100) % 10 === 0) { save(state); console.log(`  [alias] ${i + batch.length}/${names.length}`); }
  }
  save(state);
  // 渡った先をまだ訊いていなければ訊く
  const targets = [...new Set(found)].filter((n) => !(n in state.tags));
  console.log(`[alias] 渡り先で未照会: ${targets.length}`);
  for (let i = 0; i < targets.length; i += 100) {
    const batch = targets.slice(i, i + 100);
    const q = batch.map(encodeURIComponent).join(',');
    const url = `https://danbooru.donmai.us/tags.json?search%5Bname_comma%5D=${q}&only=name,category,post_count,wiki_page&limit=100`;
    const rows = await getJson(url);
    if (rows === undefined) continue;
    for (const row of rows || []) {
      if (!row || !row.name) continue;
      state.tags[row.name] = {
        category: row.category,
        postCount: row.post_count || 0,
        otherNames: (row.wiki_page && row.wiki_page.other_names) || [],
        from: 'alias-target',
      };
    }
    save(state);
  }
  save(state);
}

// ---- 段: 所属作品 -----------------------------------------------------------
// 括弧で所属を書いていない人物 (okita_sougo) の作品名は related_tag でしか取れない。
// 一件ずつなので作品数の多い順に、上限を切って回す。切った分は必ず数えて出す

// 所属作品だけは別の控え (series.json) に書く。state.json を書かないので、
// ask / alias と同時に走らせても取り合いにならない (読み書きが重なると片方が消える)
const SERIES_FILE = path.join(WORK, 'series.json');

// 全部の控えを一つに畳む。--shard で分けて走らせた分もここで拾う
function loadSeriesAll() {
  const all = { ...readJson(SERIES_FILE, {}) };
  for (const file of fs.existsSync(WORK) ? fs.readdirSync(WORK) : []) {
    if (!/^series-\d+\.json$/.test(file)) continue;
    Object.assign(all, readJson(path.join(WORK, file), {}));
  }
  return all;
}

async function phaseSeries(hv, state) {
  const seriesNs = hv.namespaces.series;
  const cap = Number(process.env.VOCAB_SERIES_CAP || 20000);
  // `--shard=2/4` で 4 分割の 3 本目を担う。控えは別ファイルなので取り合わない。
  // 一本だと 11,046 件に何時間もかかる (1 件 1 往復で、まとめて訊く口が無い)
  const shard = arg('shard', '');
  const [sIdx, sTotal] = shard ? shard.split('/').map(Number) : [0, 1];
  const file = shard ? path.join(WORK, `series-${sIdx}.json`) : SERIES_FILE;
  const store = readJson(file, {});
  const saveSeries = () => writeJson(file, store);
  // 既に他の担当が引いた分は飛ばす
  const already = loadSeriesAll();
  state.series = already;
  // wanted() は「日本語名がまだ無い物」。ここが欲しいのは逆で
  // 「日本語名が有って所属作品がまだ無い物」なので、名前空間から直に組む
  const todo = [];
  for (const [name, count] of Object.entries(hv.namespaces.character)) {
    if (count < MIN_CHAR) continue;
    // 綴りが違って別名の鎖で渡った物 (hinanai → hinanawi) も所属作品を引く
    const hit = variants(name).find((v) => hasJp(state.tags[v]))
      || variants(name).map((v) => state.aliases[v]).find((t) => t && hasJp(state.tags[t]));
    if (!hit) continue;
    if (/_\([^)]+\)$/.test(hit)) continue;          // 括弧付きは seriesOfTag が取れる
    if (hit in state.series) continue;
    todo.push({ name, count, dan: hit });
  }
  todo.sort((a, b) => b.count - a.count);
  // 分担は「一つ飛ばし」で取る。先頭から切ると、担当ごとに作品数の重みが
  // 偏って「多い方だけ先に終わる」が起きない
  const mine = sTotal > 1 ? todo.filter((_, i) => i % sTotal === sIdx) : todo;
  const run = mine.slice(0, cap);
  console.log(`[series] 所属作品を引く人物: ${run.length}${shard ? ` (分担 ${sIdx + 1}/${sTotal}、全体 ${todo.length})` : ''}${mine.length > cap ? ` (上限で ${mine.length - cap} 件を残した)` : ''}`);
  let n = 0; let ok = 0;
  for (const row of run) {
    // related_tag は似ている度をその場で計算するので遅い (実測 1.1〜2.7 秒)。
    // 実物の絵を 20 枚だけ見て copyright を数える方が 5 倍速く (実測 228ms)、
    // 答えも素直。20 枚中何枚か、がそのまま「その作品の人物か」の重みになる
    const url = `https://danbooru.donmai.us/posts.json?tags=${encodeURIComponent(row.dan)}&limit=20&only=tag_string_copyright`;
    const res = await getJson(url);
    if (res === undefined) continue;
    const posts = Array.isArray(res) ? res : [];
    const tally = new Map();
    for (const p of posts) {
      for (const c of String((p && p.tag_string_copyright) || '').split(' ').filter(Boolean)) {
        tally.set(c, (tally.get(c) || 0) + 1);
      }
    }
    const list = posts.length
      ? [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([name, hits]) => ({ tag: { name }, frequency: hits / posts.length }))
      : [];
    // **生のまま控える。** hitomi の言い方へ寄せるのは merge の仕事にする。
    // 寄せ方を直すたびに網へ引き直すのは無駄だし、danbooru と hitomi で
    // 作品名の綴りが違う (touhou ↔ touhou project) のが分かったのは後からだった。
    //
    // frequency は「この人物の絵のうち何割がその作品か」。
    // 博麗霊夢 → touhou は 1.0、雑音の cookie_(touhou) は 0.097。
    // 所属作品そのものの意味なので、これで選ぶ
    store[row.dan] = list
      .filter((r) => r && r.tag && r.tag.name)
      .map((r) => ({ name: r.tag.name, freq: Number(r.frequency) || 0, postCount: (r.tag.post_count) || 0 }));
    if (store[row.dan].some((c) => c.freq >= 0.5)) ok += 1;
    n += 1;
    if (n % 25 === 0) { saveSeries(); console.log(`  [series] ${n}/${run.length} (付いた ${ok})`); }
  }
  saveSeries();
  console.log(`[series] 付いた: ${ok} / 引いた ${n}`);
  if (todo.length > cap) console.log(`[series] **残した: ${todo.length - cap} 件** (上限 ${cap})`);
}

// ---- 段: VTuber の所属事務所 ------------------------------------------------
// VTuber は「作品」ではなく「事務所」に属する。hitomi は series として
// hololive と nijisanji しか持たないので、ぶいすぽ・あおぎり・あにまーれ等は
// 既存の series の枠では表せない (表しても hitomi で引けない語になる)。
// そこで **画面に出すためだけの** 所属を別に持つ。
//
// 事務所名は danbooru の copyright タグの other_names から採る (でっち上げない)。
// 欧文の商号 (VShojo, Crazy Raccoon) はそのまま欧文で書くのが日本語でも普通なので、
// 日本語名が無い事務所は商号をそのまま使う。
const VTUBER_FILE = path.join(WORK, 'vtuber.json');
let bulkCache = null;
const bulkFor = (kind) => {
  if (!bulkCache) bulkCache = readJson(path.join(WORK, 'danbooru-bulk.json'), { character: {}, series: {} });
  return bulkCache[kind] || {};
};

// [danbooru の copyright, 画面に出す名前, 一覧を引けるか]
// hololive / nijisanji / indie は語が大きすぎて related_tag が 500 を返すので、
// 一覧は引かず「人物→copyright」の向き (posts.json) だけで拾う
const AGENCIES = [
  ['hololive', 'ホロライブ', false],
  ['hololive_english', 'ホロライブEN', true],
  ['hololive_indonesia', 'ホロライブID', true],
  ['hololive_dev_is', 'ホロライブDEV_IS', true],
  ['hololive_china', 'ホロライブCN', true],
  ['holostars', 'ホロスターズ', true],
  ['holostars_english', 'ホロスターズEN', true],
  ['nijisanji', 'にじさんじ', false],
  ['nijisanji_en', 'にじさんじEN', true],
  ['nijisanji_id', 'にじさんじID', true],
  ['nijisanji_kr', 'にじさんじKR', true],
  ['vspo!', 'ぶいすぽっ!', true],
  ['aogiri_koukou', 'あおぎり高校', true],
  ['nanashi_inc.', 'ななしいんく', true],
  ['noripro', 'のりプロ', true],
  ['phase_connect', 'フェーズコネクト', true],
  ['vshojo', 'VShojo', true],
  ['kamitsubaki_studio', '神椿スタジオ', true],
  ['re:act', 'リアクト', true],
  ['wactor_production', 'WACTOR', true],
  ['crazy_raccoon', 'Crazy Raccoon', true],
  ['riot_music', 'RIOT MUSIC', true],
  ['specialite_(company)', 'すぺしゃりて', true],
  ['hoshimeguri_gakuen', '星めぐり学園', true],
  ['marble_creators', 'Vまぁぶる', true],
  ['pixela_project', 'ピクセラ', true],
  ['palette_project', 'パレットプロジェクト', true],
  ['kemomimi_oukoku_kokuei_housou', 'けもみみおーこく', true],
  ['vee_(vtuber)', 'VEE', true],
  ['univirtual', 'univirtual', true],
  ['tsunderia', 'Tsunderia', true],
  ['prism_project', 'PRISM Project', true],
];
// 事務所に属さない VTuber。これが一番強ければ「個人」と出す
const INDIE = 'indie_virtual_youtuber';
const AGENCY_LABEL = new Map([...AGENCIES.map(([k, v]) => [k, v]), [INDIE, '個人']]);

async function phaseVtuber(hv, state) {
  const store = readJson(VTUBER_FILE, {});
  const save2 = () => writeJson(VTUBER_FILE, store);

  // 1 事務所ごとの所属者一覧 (引ける事務所だけ)。ここで出るのは「候補」で、
  //   共演しただけの人も混ざる。次の段で本人の絵を見て確かめる
  const candidates = new Set();
  for (const [slug, , listable] of AGENCIES) {
    if (!listable) continue;
    const url = `https://danbooru.donmai.us/related_tag.json?search%5Bquery%5D=${encodeURIComponent(slug)}&search%5Bcategory%5D=character&limit=200`;
    const res = await getJson(url);
    if (!res || res === undefined) { console.log(`  [vtuber] ${slug}: 一覧を引けなかった`); continue; }
    const rel = (res && res.related_tags) || [];
    for (const r of rel) if (r && r.tag && r.tag.name) candidates.add(r.tag.name);
    console.log(`  [vtuber] ${slug}: 候補 ${rel.length}`);
  }
  // 既に所属作品を引いてある人物も、同じ控えから事務所を読める (網に触らない)
  const already = loadSeriesAll();
  console.log(`[vtuber] 一覧から ${candidates.size} 人 / 既に引いてある ${Object.keys(already).length} 人`);

  // 2 一人ずつ「その人の絵はどの事務所か」を確かめる。
  //   posts.json の URL は所属作品の段と同じなので、引いた事もある人はただで済む
  // 一般語を事務所に入れない。`demon_girl` は category 0 の普通のタグだが、
  // 直近 20 枚がたまたま VShojo の絵ばかりで「VShojo 所属」に見えてしまった。
  // 人物 (category 4) の語だけを事務所の対象にする
  const isCharacterTag = (dan) => {
    if ((bulkFor('character') || {})[dan]) return true;        // 丸ごと引いた人物表に居る
    const row = state.tags[dan];
    return Boolean(row && row.category === 4);
  };
  const decide = (cands) => {
    const usable = (cands || []).filter((c) => c && AGENCY_LABEL.has(c.name) && c.freq >= 0.5);
    if (!usable.length) return null;
    // 事務所が本人より強いことがある (個人勢は弱く付く) ので、強い順・個人は最後
    usable.sort((a, b) => (a.name === INDIE ? 1 : 0) - (b.name === INDIE ? 1 : 0) || b.freq - a.freq);
    return { agency: usable[0].name, label: AGENCY_LABEL.get(usable[0].name) };
  };
  for (const [dan, cands] of Object.entries(already)) {
    if (store[dan] || !isCharacterTag(dan)) continue;
    const hit = decide(cands);
    if (hit) store[dan] = hit;
  }
  save2();
  console.log(`[vtuber] 控えから決まった: ${Object.keys(store).length}`);

  const todo = [...candidates].filter((n) => !store[n] && !already[n]);
  console.log(`[vtuber] 網へ訊く候補: ${todo.length}`);
  let n = 0; let ok = 0;
  for (const dan of todo) {
    const url = `https://danbooru.donmai.us/posts.json?tags=${encodeURIComponent(dan)}&limit=20&only=tag_string_copyright`;
    const res = await getJson(url);
    if (res === undefined) continue;
    const posts = Array.isArray(res) ? res : [];
    const tally = new Map();
    for (const p of posts) {
      for (const c of String((p && p.tag_string_copyright) || '').split(' ').filter(Boolean)) {
        tally.set(c, (tally.get(c) || 0) + 1);
      }
    }
    const cands = posts.length
      ? [...tally.entries()].map(([name, hits]) => ({ name, freq: hits / posts.length }))
      : [];
    const hit = isCharacterTag(dan) ? decide(cands) : null;
    if (hit) { store[dan] = hit; ok += 1; }
    n += 1;
    if (n % 25 === 0) { save2(); console.log(`  [vtuber] ${n}/${todo.length} (付いた ${ok})`); }
  }
  save2();
  const byAgency = {};
  for (const v of Object.values(store)) byAgency[v.label] = (byAgency[v.label] || 0) + 1;
  console.log(`[vtuber] 事務所が付いた人物: ${Object.keys(store).length}`);
  console.log('[vtuber] 内訳:', JSON.stringify(byAgency));
  console.log(`[vtuber] 書いた: ${VTUBER_FILE}`);
}

// ---- 段: hitomi に無いが pixiv では引ける人物 --------------------------------
// VTuber の大半は hitomi にタグが無い。しかし pixiv は日本語のタグで引くサイトで、
// 名前さえ合っていれば作品は山ほどある。**pixiv 専用の候補**として出せるようにする。
//
// 出す前に確かめる二つ:
//   1 その日本語名が pixiv で通じる語か — dic.pixiv.net に記事があるか (200/404)。
//     danbooru の日本語名が pixiv の綴りと違うことがある
//     (`一伊イナニス` は 404、pixiv は `一伊那尓栖`)。項目が持つ別の日本語名も順に試す
//   2 その名前が既に辞書で引けないか — 引けるなら二重に出すだけの雑音
//
// 記事が無い = タグが無い、ではない (弱い裏付け)。それでも、出す物を絞る方を採る。
// 出せなかった物も理由付きで控えに残す (「調べて無かった」と「調べていない」を混ぜない)
const PIXIV_ONLY_FILE = path.join(WORK, 'pixiv-only.json');

// 記事の有無だけを見る軽い口。接続を使い回さず、本文も読まずに切る
function headOnly(url) {
  return new Promise((resolve, reject) => {
    const t = new URL(url);
    const req = https.request({
      method: 'GET', host: t.host, path: `${t.pathname}${t.search}`, family: 4,
      agent: false, timeout: 15000,
      headers: { 'User-Agent': UA, Accept: 'text/html' },
    }, (res) => {
      const status = res.statusCode;
      res.destroy();                       // 本文は要らない
      resolve({ status });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}
const COSTUME = /_\(([0-9]+(st|nd|rd|th)_costume|.*costume.*|new_outfit|casual|swimsuit)\)$/;

async function phasePixivOnly(hv, state) {
  const { knownKanji, isJapanese } = require('./japanese-script');
  const { foldRomajiName } = require('../src/lib/search-text');
  const aliases = require('../src/lib/search-aliases');

  const store = readJson(PIXIV_ONLY_FILE, {});
  const save2 = () => writeJson(PIXIV_ONLY_FILE, store);
  const vtuber = readJson(VTUBER_FILE, {});
  const chars = knownKanji({
    seed: Object.values(state.tags).flatMap((r) => (r && r.otherNames) || []), fresh: true,
  });
  const hFold = new Set(Object.keys(hv.namespaces.character).map(foldRomajiName));
  const nNs = (readJson(path.join(RESEARCH, 'nhentai-vocabulary.json'), { namespaces: {} })
    .namespaces || {}).character || {};

  // 既に辞書で引ける日本語名は出さない (同じ名前が二つ並ぶだけ)
  const alreadySearchable = (label) => {
    try { return aliases.lookup(label).length > 0; } catch { return false; }
  };

  const todo = [];
  const skipped = { onHitomi: 0, costume: 0, notCharacter: 0, noJapanese: 0, duplicate: 0 };
  for (const [dan, info] of Object.entries(vtuber)) {
    if (hFold.has(foldRomajiName(dan))) { skipped.onHitomi += 1; continue; }
    if (COSTUME.test(dan)) { skipped.costume += 1; continue; }
    const row = bulkFor('character')[dan] || state.tags[dan];
    if (!row) { skipped.notCharacter += 1; continue; }
    if (state.tags[dan] && state.tags[dan].category != null && state.tags[dan].category !== 4) {
      skipped.notCharacter += 1; continue;
    }
    const jp = ((row.otherNames) || []).filter((s) => isJapanese(s, chars));
    if (!jp.length) { skipped.noJapanese += 1; continue; }
    if (jp.every(alreadySearchable)) { skipped.duplicate += 1; continue; }
    todo.push({ dan, jp, agency: info.agency, label: info.label, posts: row.postCount || 0 });
  }
  todo.sort((a, b) => b.posts - a.posts);
  console.log(`[pixivonly] 候補 ${todo.length} 人 / 外した内訳 ${JSON.stringify(skipped)}`);

  // dic.pixiv.net に記事があるか。日本語名を順に試し、最初に当たった物を採る
  const article = async (word) => {
    const url = `https://dic.pixiv.net/a/${encodeURIComponent(word)}`;
    const key = crypto.createHash('sha256').update(url).digest('hex').slice(0, 32);
    const file = path.join(BODIES, `${key}.status`);
    const cached = readJson(file, null);
    if (cached) return cached.status;
    const wait = Math.max(0, PACE_MS - (Date.now() - lastAt));
    if (wait) await sleep(wait);
    lastAt = Date.now();
    // 使い捨ての接続で引く。dic.pixiv は繋ぎっぱなしの口 (keepAlive) だと
    // 空き待ちで固まることがあり、実際に途中で進まなくなった。
    // 本文は要らない (記事があるかだけ) ので、頭が来たら切る
    let res = null;
    try { res = await headOnly(url); } catch { res = { status: 0 }; }
    if (res.status === 200 || res.status === 404) {
      fs.mkdirSync(BODIES, { recursive: true });
      writeJson(file, { url, status: res.status, at: new Date().toISOString() });
    }
    return res.status;
  };

  let n = 0; let ok = 0;
  for (const row of todo) {
    if (store[row.dan]) { if (store[row.dan].label) ok += 1; continue; }
    let picked = '';
    for (const word of row.jp.slice(0, 4)) {
      if (alreadySearchable(word)) continue;
      const status = await article(word);
      if (status === 200) { picked = word; break; }
    }
    store[row.dan] = picked
      ? { name: row.dan, label: picked, labels: row.jp, agency: row.agency, agencyLabel: row.label,
        evidence: `https://dic.pixiv.net/a/${encodeURIComponent(picked)}`,
        nhentai: Object.prototype.hasOwnProperty.call(nNs, spaced(row.dan)) }
      : { name: row.dan, label: '', why: 'pixiv 百科事典に記事が無い' };
    if (picked) ok += 1;
    n += 1;
    if (n % 25 === 0) { save2(); console.log(`  [pixivonly] ${n}/${todo.length} (出せる ${ok})`); }
  }
  save2();
  console.log(`[pixivonly] pixiv 用に出せる: ${ok} / 調べた ${Object.keys(store).length}`);
  console.log(`[pixivonly] 書いた: ${PIXIV_ONLY_FILE}`);
}

// ---- 段: danbooru の名前空間を丸ごと引く -----------------------------------
// 綴りの違い (asuka langley soryu ↔ souryuu_asuka_langley、haikyuu ↔ haikyuu!!)
// を当てずっぽうで埋めるのをやめる。danbooru の人物・作品を全部手元に置いて、
// 突き合わせは手元でやる。1000 行/回で other_names も一緒に来る (実測 98.6%)。
const BULK_FILE = path.join(WORK, 'danbooru-bulk.json');

async function phaseBulk(hv, state) {
  const store = readJson(BULK_FILE, { character: {}, series: {}, pages: {} });
  const saveBulk = () => writeJson(BULK_FILE, store);
  const MIN_POSTS = Number(process.env.VOCAB_BULK_MIN || 2);
  for (const [cat, key] of [[4, 'character'], [3, 'series']]) {
    let page = (store.pages[key] || 0) + 1;
    for (; page <= 400; page += 1) {
      const url = `https://danbooru.donmai.us/tags.json?search%5Bcategory%5D=${cat}&search%5Bhide_empty%5D=yes&search%5Border%5D=count&only=name,post_count,wiki_page&limit=1000&page=${page}`;
      const rows = await getJson(url);
      if (rows === undefined) { console.log(`  [bulk] ${key} page ${page} は取れなかった。ここで止める`); break; }
      if (!Array.isArray(rows) || !rows.length) { console.log(`  [bulk] ${key} page ${page} で終わり`); break; }
      let last = 0;
      for (const row of rows) {
        if (!row || !row.name) continue;
        last = row.post_count || 0;
        // 日本語の札にしか使わないので、CJK を含む別名だけ残す (控えが 10 分の 1 になる)
        const names = ((row.wiki_page && row.wiki_page.other_names) || [])
          .filter((s) => /[぀-ヿ一-鿿]/.test(String(s))).slice(0, 12);
        store[key][row.name] = { postCount: row.post_count || 0, otherNames: names };
      }
      store.pages[key] = page;
      if (page % 10 === 0) { saveBulk(); console.log(`  [bulk] ${key} page ${page} (計 ${Object.keys(store[key]).length}, 最小 ${last})`); }
      if (last <= MIN_POSTS) { console.log(`  [bulk] ${key} は post_count ${last} まで来たので止める`); break; }
    }
    saveBulk();
    console.log(`[bulk] ${key}: ${Object.keys(store[key]).length} 語`);
  }
  saveBulk();
}

// ---- 段: 手元で突き合わせる -------------------------------------------------
// 長音と記号の揺れを畳んだ鍵で引く。語順も畳む (danbooru は 姓_名、hitomi は 名 姓)。
// **一つに定まる時だけ**結び付ける。二つ以上当たったら別人の見分けが付かないので捨てる
// 畳み方は src/lib/search-text.js の foldRomajiName が原本。番人と試験も同じ物を
// 使う。二度書くと、片方だけ直した時に「照合は当たるのに番人は見逃す」がおきる
const { foldRomajiName } = require('../src/lib/search-text');
const canonKey = (name) => foldRomajiName(name);

// 括弧で所属作品を書いている danbooru の語 (`2b_(nier:automata)`) から、
// hitomi の作品名を割り出す。網に触らずに所属作品が付くので posts.json を節約できる。
// 書き出しは別の控えへ (series.json は posts.json の段が握っている)
const QUAL_FILE = path.join(WORK, 'series-from-qualifier.json');

function phaseMatch(hv, state) {
  const bulk = readJson(BULK_FILE, null);
  if (!bulk) throw new Error('先に --phase=bulk を走らせる');
  const hasJpList = (list) => (list || []).some((s) => /[぀-ヿ一-鿿]/.test(String(s)));
  let linked = 0; let ambiguous = 0; const examples = [];

  // hitomi の作品名を、そのままの綴りと畳んだ鍵の両方で引けるようにする
  const seriesNs = hv.namespaces.series;
  const exactSeries = new Map();
  const canonSeries = new Map();
  for (const h of Object.keys(seriesNs)) {
    exactSeries.set(spaced(h), h);
    const k = canonKey(h);
    if (!k) continue;
    if (!canonSeries.has(k)) canonSeries.set(k, []);
    canonSeries.get(k).push(h);
  }
  const seriesOfQualifier = (danName) => {
    const m = String(danName).match(/_\(([^)]+)\)$/);
    if (!m) return null;
    const raw = spaced(m[1]);
    if (exactSeries.has(raw)) return exactSeries.get(raw);
    const hits = canonSeries.get(canonKey(m[1])) || [];
    return hits.length === 1 ? hits[0] : null;
  };
  const qual = readJson(QUAL_FILE, {});
  let qualHits = 0;
  for (const [kind, cat] of [['character', 4], ['series', 3]]) {
    const table = bulk[kind] || {};
    // 索引は二段。**括弧を含めたそのままの鍵**を先に見て、だめな時だけ
    // 括弧を落とした鍵を見る。
    //
    // 一段にすると衣装違いに負ける。danbooru は `todoroki_kyouko` の他に
    // `todoroki_kyouko_(1st_costume)` … を持っていて、括弧を落とすと六つとも
    // 同じ鍵になる。「二つ以上当たったら捨てる」ので、本体まで捨てていた。
    // そのままの鍵なら本体だけが当たる (衣装違いは「1st costume …」になる)
    const byExact = new Map();
    const byBare = new Map();
    const add = (map, k, item) => {
      if (!k) return;
      if (!map.has(k)) map.set(k, []);
      const list = map.get(k);
      if (!list.some((x) => x.name === item.name)) list.push(item);
    };
    for (const [name, row] of Object.entries(table)) {
      if (!hasJpList(row.otherNames)) continue;
      const item = { name, ...row };
      add(byExact, canonKey(name), item);
      // danbooru は所属作品を括弧で書く (`mordred_(fate)`、`alena_(dq4)`)。
      // hitomi 側は括弧を持たないので、括弧を落とした鍵でも引けるようにする。
      // 当たれば所属作品が seriesOfTag でただで付く (posts.json を引かずに済む)。
      // `cleric` のように括弧違いが何件もある語は、鍵が重なって捨てられる — それでよい
      const bare = String(name).replace(/_\([^)]+\)$/, '');
      if (bare !== name) add(byBare, canonKey(bare), item);
    }
    const byCanon = { get: (k) => { const e = byExact.get(k); return (e && e.length === 1) ? e : (byBare.get(k) || e || []); } };
    const ns = kind === 'character' ? hv.namespaces.character : hv.namespaces.series;
    for (const [hname, count] of Object.entries(ns)) {
      if (count < (kind === 'character' ? MIN_CHAR : MIN_SERIES)) continue;
      if (settled(state, hname)) continue;
      const under2 = hname.replace(/ /g, '_');
      if (state.aliases[under2] && hasJp(state.tags[state.aliases[under2]])) continue;
      const hits = byCanon.get(canonKey(hname)) || [];
      if (hits.length !== 1) { if (hits.length > 1) ambiguous += 1; continue; }
      const hit = hits[0];
      state.tags[hit.name] = { category: cat, postCount: hit.postCount, otherNames: hit.otherNames, from: 'bulk-match' };
      if (hit.name !== under2) state.aliases[under2] = hit.name;
      linked += 1;
      if (kind === 'character') {
        const s = seriesOfQualifier(hit.name);
        if (s && !qual[hit.name]) { qual[hit.name] = s; qualHits += 1; }
      }
      if (examples.length < 12) examples.push(`${hname} (${count}) -> ${hit.name}`);
    }
  }
  // 既に日本語名を持っている人物も、括弧付きの語なら所属作品が取れる
  for (const [name, row] of Object.entries(state.tags)) {
    if (!row || row.category !== 4 || qual[name]) continue;
    const s = seriesOfQualifier(name);
    if (s) { qual[name] = s; qualHits += 1; }
  }
  writeJson(QUAL_FILE, qual);
  save(state);
  console.log(`[match] 結び付いた: ${linked} / 二つ以上当たって捨てた: ${ambiguous}`);
  console.log(`[match] 括弧から所属作品が取れた: ${qualHits} (計 ${Object.keys(qual).length}) -> ${QUAL_FILE}`);
  console.log(`[match] 例:\n  ${examples.join('\n  ')}`);
}

// ---- 段: 監査用の控えへ畳む -------------------------------------------------

function phaseMerge(state) {
  const file = path.join(AUDIT, 'danbooru-cache.json');
  const before = readJson(file, { tags: {}, aliases: {} });
  const backup = path.join(WORK, 'danbooru-cache.before.json');
  if (!fs.existsSync(backup)) writeJson(backup, before);
  const tags = { ...before.tags };
  const aliases = { ...before.aliases };
  let addedTags = 0; let grownTags = 0; let addedAliases = 0;
  for (const [name, row] of Object.entries(state.tags)) {
    if (!row || row.category == null) continue;      // absent の印は畳まない
    const old = tags[name];
    if (!old) { tags[name] = { category: row.category, postCount: row.postCount || 0, otherNames: row.otherNames || [] }; addedTags += 1; continue; }
    const merged = [...new Set([...(old.otherNames || []), ...(row.otherNames || [])])];
    if (merged.length > (old.otherNames || []).length) grownTags += 1;
    tags[name] = { category: old.category != null ? old.category : row.category, postCount: Math.max(old.postCount || 0, row.postCount || 0), otherNames: merged };
  }
  for (const [from, to] of Object.entries(state.aliases)) {
    if (!to || aliases[from]) continue;
    aliases[from] = to; addedAliases += 1;
  }
  // 検めで外した鎖は名指しで消す。ここが無いと、一度通してしまった誤り
  // (tanya akulova → tanya_degurechaff) が控えに residue として残る
  let dropped = 0;
  for (const row of readJson(path.join(WORK, 'rejected-aliases.json'), [])) {
    if (row && row.from && aliases[row.from] === row.to) { delete aliases[row.from]; dropped += 1; }
  }
  if (dropped) console.log(`[merge] 検めで外した鎖を控えから消した: ${dropped}`);
  // danbooru の作品名を hitomi の言い方へ寄せる。綴りが違うことがある
  // (danbooru `touhou` / hitomi `touhou project`、danbooru `naruto_(series)` / hitomi `naruto`)。
  // 寄せる根拠は「hitomi の作品名を danbooru へ訊いた時の渡り先」しか使わない。
  // 似た字面で寄せると、そこから先の全部が誤対応になる
  const hv2 = readJson(path.join(RESEARCH, 'hitomi-vocabulary.json'), { namespaces: {} });
  const seriesNs = hv2.namespaces.series || {};
  const toHitomi = new Map();
  const put = (dan, hit) => { const k = spaced(dan); if (k && !toHitomi.has(k)) toHitomi.set(k, hit); };
  // 長音と記号の揺れだけの違い (go-toubun_no_hanayome ↔ gotoubun no hanayome、
  // sono_bisque_doll_wa_koi_wo_suru ↔ ... koi o suru) は畳んだ鍵で寄せる。
  // 二つ以上当たる鍵は見分けが付かないので捨てる
  const byCanon = new Map();
  for (const hname of Object.keys(seriesNs)) {
    put(hname, hname);                                   // 綴りが同じ
    const target = state.aliases[hname.replace(/ /g, '_')];
    if (target) put(target, hname);                      // danbooru 自身の別名で渡った物
    const k = canonKey(hname);
    if (!k) continue;
    if (!byCanon.has(k)) byCanon.set(k, []);
    byCanon.get(k).push(hname);
  }
  const resolveSeries = (raw) => {
    const k = spaced(raw);
    if (toHitomi.has(k)) return toHitomi.get(k);
    // danbooru は同じ作品を `naruto_(series)` のように注記付きで持つことがある
    const stripped = k.replace(/\s*\((series|classic|anime|game|manga|franchise)\)$/, '');
    if (toHitomi.has(stripped)) return toHitomi.get(stripped);
    const hits = byCanon.get(canonKey(raw)) || [];
    return hits.length === 1 ? hits[0] : null;
  };

  // 20 枚中 14 枚以上。本物は軒並み 1.00 なので余裕がある。
  // 0.5 だと `producer` (ブルアカ 0.50 / まどマギ 0.40) のような
  // どの作品にも居る役職名が片方へ倒れてしまう
  const MIN_FREQ = 0.7;
  // VTuber の所属事務所。hitomi に series が無い事務所 (ぶいすぽ・あおぎり等) も
  // 画面には出したいので、series とは別の枠でそのまま持ち越す
  const vtuber = {};
  for (const [dan, row] of Object.entries(readJson(VTUBER_FILE, {}))) {
    if (row && row.label) vtuber[dan] = { agency: row.agency, label: row.label };
  }

  // hitomi に無いが pixiv では引ける人物。pixiv 百科事典に記事があると確かめた物だけ
  const pixivOnly = {};
  for (const [dan, row] of Object.entries(readJson(PIXIV_ONLY_FILE, {}))) {
    if (!row || !row.label) continue;
    // 確かめた綴りを先頭に。札を選ぶ規則 (properName) が先頭から見るため
    const labels = [row.label, ...(row.labels || []).filter((l) => l !== row.label)];
    pixivOnly[dan] = {
      name: dan, labels, agency: row.agency || '', agencyLabel: row.agencyLabel || '',
      nhentai: row.nhentai === true, evidence: row.evidence || '',
    };
  }

  const series = {};
  let noMap = 0; let tooLoose = 0;
  // 括弧から割り出した分は既に hitomi の言い方になっている。そのまま採る
  let fromQual = 0;
  for (const [dan, hname] of Object.entries(readJson(QUAL_FILE, {}))) {
    if (hname && Object.prototype.hasOwnProperty.call(seriesNs, hname)) { series[dan] = hname; fromQual += 1; }
  }
  for (const [dan, raw] of Object.entries(loadSeriesAll())) {
    if (!raw) continue;
    // 古い形 (文字列一つ) の控えもそのまま読めるようにしておく
    const cands = typeof raw === 'string' ? [{ name: raw, freq: 1, postCount: 0 }] : raw;
    const usable = cands.filter((c) => c && c.freq >= MIN_FREQ);
    if (!usable.length) { tooLoose += 1; continue; }
    // 強い順。同じ強さなら danbooru で小さい方 (fate_(series) より fate/grand_order)
    usable.sort((a, b) => b.freq - a.freq || a.postCount - b.postCount);
    const hit = usable.map((c) => resolveSeries(c.name)).find(Boolean);
    if (hit) series[dan] = hit; else noMap += 1;
  }
  console.log(`[merge] 所属作品: 付いた ${Object.keys(series).length} (うち括弧から ${fromQual}) / hitomi に無い ${noMap} / 結び付きが弱い ${tooLoose}`);
  writeJson(file, { tags, aliases, series, vtuber, pixivOnly, at: new Date().toISOString() });
  console.log(`[merge] tags +${addedTags} (別名が増えた行 ${grownTags}) / aliases +${addedAliases} / series ${Object.keys(series).length}`);
  console.log(`[merge] VTuber の所属事務所: ${Object.keys(vtuber).length}`);
  console.log(`[merge] hitomi に無く pixiv で引ける人物: ${Object.keys(pixivOnly).length}`);
  console.log(`[merge] 書いた: ${file}`);
  console.log(`[merge] 元の控え: ${backup}`);
}

// ---- 走らせる ---------------------------------------------------------------

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const { hv, state } = load();
  const phase = arg('phase', 'ask');
  console.log(`段: ${phase} / 間合い ${PACE_MS}ms / 下限 人物${MIN_CHAR}冊 作品${MIN_SERIES}冊`);
  if (phase === 'ask') await phaseAsk(hv, state);
  else if (phase === 'alias') await phaseAlias(hv, state);
  else if (phase === 'series') await phaseSeries(hv, state);
  else if (phase === 'bulk') await phaseBulk(hv, state);
  else if (phase === 'vtuber') await phaseVtuber(hv, state);
  else if (phase === 'pixivonly') await phasePixivOnly(hv, state);
  else if (phase === 'match') phaseMatch(hv, state);
  else if (phase === 'merge') phaseMerge(state);
  else throw new Error(`知らない段: ${phase}`);
  // series は state.json を持たない (別の控えに書く)。ここで書き戻すと、
  // 同時に走っている ask / alias の書き込みを古い写しで潰してしまう
  if (!['series', 'merge', 'bulk', 'vtuber', 'pixivonly'].includes(phase)) save(state);
  console.log('done');
})().catch((error) => { console.error(error); process.exit(1); });
