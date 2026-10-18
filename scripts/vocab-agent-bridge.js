'use strict';
// 手勢 (subagent) と機械の間の口。二つの段だけを持つ。
//
//   --phase=worklist   まだ日本語名に届いていない hitomi の語を、作品数の多い順に束ねて出す
//   --phase=verify     手勢が出した「hitomi の語 ↔ danbooru の語」の結び付けを機械で検める
//
// **手勢に日本語を書かせない。** 手勢が出してよいのは識別子どうしの結び付けだけで、
// 漢字は必ず danbooru から取ってきた文字列を使う。だから検証は多数決ではなく照合になる:
//
//   1 綴りの関門  括弧と記号を落として、hitomi 名と提案名で語が一つ以上重なること
//   2 実在の関門  提案された danbooru の語が実在し、種別が合っていること
//   3 日本語の関門 その行の other_names に、既存の番人 (isJapanese) が通す語があること
//
// 三つ全部を通った結び付けだけを danbooru-cache.json の aliases として残す。
// 通らなかった物は理由を付けて残す (黙って消すと「調べたのに無い」が見えなくなる)。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const WORK = path.join(ROOT, 'work', 'character-vocab-2026-09-21');
const BODIES = path.join(WORK, 'bodies');
const STATE = path.join(WORK, 'state.json');
const RESEARCH = path.join(ROOT, 'work', 'vocabulary-research', 'data');
const { knownKanji, isJapanese } = require('./japanese-script');

const UA = 'bunko/1.0 (personal doujinshi library; one user; dictionary build)';
const PACE_MS = Number(process.env.VOCAB_PACE || 1100);

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};
const writeJson = (file, data, pretty) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, pretty ? JSON.stringify(data, null, 1) : JSON.stringify(data));
  fs.renameSync(tmp, file);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const spaced = (s) => String(s || '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

// ---- 綴りの関門 -------------------------------------------------------------
// 「語が一つも重ならない」結び付けは、手勢の思い違いか別人。
// よく出る助詞・敬称は重なっても意味が無いので数えない
const STOP = new Set(['the', 'of', 'no', 'a', 'an', 'to', 'wa', 'ga', 'wo', 'ni', 'de', 'and',
  'chan', 'san', 'kun', 'sama', 'senpai', 'sensei', 'series', 'project', 'x', 'and']);

function tokensOf(name) {
  return new Set(spaced(name)
    .replace(/[()\[\]{}!?.,:;'"\/\\+*&#@~|^%$-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOP.has(t)));
}

function shareToken(a, b) {
  const A = tokensOf(a); const B = tokensOf(b);
  for (const t of A) if (B.has(t)) return t;
  return '';
}

// ---- 網 --------------------------------------------------------------------

const agent = new https.Agent({ keepAlive: true, maxSockets: 2, timeout: 30000 });
let lastAt = 0;
function request(url) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = https.request({
      method: 'GET', host: target.host, path: `${target.pathname}${target.search}`,
      family: 4, agent,
      headers: { 'User-Agent': UA, Accept: 'application/json', 'Accept-Encoding': 'gzip, deflate' },
      timeout: 45000,
    }, (res) => {
      const chunks = [];
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      const stream = enc === 'gzip' ? res.pipe(zlib.createGunzip()) : enc === 'deflate' ? res.pipe(zlib.createInflate()) : res;
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
  for (let i = 0; i < 4; i += 1) {
    const wait = Math.max(0, PACE_MS - (Date.now() - lastAt));
    if (wait) await sleep(wait);
    lastAt = Date.now();
    let res = null;
    try { res = await request(url); } catch (e) { res = { status: 0, text: String(e && e.message) }; }
    if (res.status === 200) {
      let json = null;
      try { json = JSON.parse(res.text); } catch { json = null; }
      if (json !== null) { fs.mkdirSync(BODIES, { recursive: true }); writeJson(file, { url, json, at: new Date().toISOString() }); return json; }
    }
    if (res.status === 404) return null;
    await sleep(2000 * (i + 1));
  }
  return undefined;
}

// ---- 素材 ------------------------------------------------------------------

function load() {
  const hv = readJson(path.join(RESEARCH, 'hitomi-vocabulary.json'), null);
  const state = readJson(STATE, { tags: {}, aliases: {}, series: {} });
  if (!hv) throw new Error('hitomi 全語一覧が要る');
  return { hv, state };
}
const hasJp = (row) => Boolean(row && Array.isArray(row.otherNames) && row.otherNames.some((s) => /[぀-ヿ一-鿿]/.test(String(s))));

function variants(name) {
  const base = spaced(name);
  const out = new Set([base.replace(/ /g, '_')]);
  const p = base.split(' ');
  if (p.length === 2) out.add(`${p[1]}_${p[0]}`);
  return [...out].filter(Boolean);
}
// その hitomi 名が既にどこかで日本語名へ届いているか (別名の鎖も見る)
function settled(state, name) {
  for (const v of variants(name)) {
    if (hasJp(state.tags[v])) return true;
    const t = state.aliases[v];
    if (t && hasJp(state.tags[t])) return true;
  }
  return false;
}

// ---- 段: 手勢への割り当てを出す ---------------------------------------------

function phaseWorklist(hv, state) {
  const min = Number(process.env.VOCAB_AGENT_MIN || 5);
  const size = Number(process.env.VOCAB_BATCH || 25);
  const out = { builtAt: new Date().toISOString(), min, batches: [], counts: {} };
  // 既に辞書にある語は手勢に回さない。控え (state) だけを見ていると、
  // 前の代の辞書が持っている語まで「未解決」に見えて手勢を無駄に使う
  let dict = null;
  try { dict = require(path.join(ROOT, 'src/lib/search-aliases')).loadData(); } catch { dict = null; }
  const known = (kind, name) => {
    if (!dict) return false;
    const row = dict.byValue.get(`${kind}:${name.replace(/ /g, '_')}`);
    return Boolean(row && row.labels && row.labels.length);
  };
  for (const kind of ['character', 'series']) {
    const ns = kind === 'character' ? hv.namespaces.character : hv.namespaces.series;
    const rows = Object.entries(ns)
      .filter(([, c]) => c >= min)
      .map(([name, count]) => ({ name, count }))
      .filter((r) => !settled(state, r.name) && !known(kind, r.name))
      .sort((a, b) => b.count - a.count);
    out.counts[kind] = rows.length;
    for (let i = 0; i < rows.length; i += size) {
      out.batches.push({ kind, index: out.batches.length, items: rows.slice(i, i + size) });
    }
  }
  // 束ごとに小さな札を書き出す。手勢には「この札を読め」とだけ言えばよく、
  // 長い一覧を指図に貼らずに済む
  const dir = path.join(WORK, 'batches');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const batch of out.batches) {
    const id = String(batch.index).padStart(3, '0');
    batch.file = path.join(dir, `${id}.json`).replace(/\\/g, '/');
    writeJson(batch.file, { kind: batch.kind, index: batch.index, items: batch.items }, true);
  }
  writeJson(path.join(WORK, 'worklist.json'), out, true);
  console.log(`[worklist] 束の札: ${dir}`);
  console.log(`[worklist] 人物 ${out.counts.character} / 作品 ${out.counts.series} (${min} 冊以上・未解決)`);
  console.log(`[worklist] 束: ${out.batches.length} (1 束 ${size} 件)`);
  console.log(`[worklist] 書いた: ${path.join(WORK, 'worklist.json')}`);
}

// ---- 段: 結び付けを検める ---------------------------------------------------

async function phaseVerify(hv, state) {
  const proposals = readJson(path.join(WORK, 'proposals.json'), null);
  if (!proposals) throw new Error('proposals.json が無い (手勢の答えを先に置く)');
  const list = Array.isArray(proposals) ? proposals : (proposals.items || []);
  console.log(`[verify] 受け取った結び付け: ${list.length}`);

  // 1 綴りの関門を先に通す。ここで落ちる物は網に触らない
  const gated = []; const rejected = [];
  for (const p of list) {
    const hitomiName = spaced(p.hitomi_name || p.hitomi || '');
    const dan = String(p.danbooru_tag || p.danbooru || '').trim().toLowerCase().replace(/\s+/g, '_');
    const kind = p.kind === 'series' ? 'series' : 'character';
    const ns = kind === 'character' ? hv.namespaces.character : hv.namespaces.series;
    if (!hitomiName || !dan) { rejected.push({ ...p, why: '名前が空' }); continue; }
    if (!Object.prototype.hasOwnProperty.call(ns, hitomiName)) { rejected.push({ ...p, why: 'hitomi にその語が無い' }); continue; }
    const shared = shareToken(hitomiName, dan);
    if (!shared) { rejected.push({ ...p, why: '綴りの語が一つも重ならない' }); continue; }
    gated.push({ hitomiName, dan, kind, shared, count: ns[hitomiName] });
  }
  console.log(`[verify] 綴りの関門を通った: ${gated.length} / 落ちた: ${rejected.length}`);

  // 2 実在と 3 日本語の関門。まだ引いていない語だけを一括で引く
  const need = [...new Set(gated.map((g) => g.dan))].filter((n) => !(n in state.tags));
  console.log(`[verify] danbooru へ訊く: ${need.length} 語 (${Math.ceil(need.length / 100)} 回)`);
  for (let i = 0; i < need.length; i += 100) {
    const batch = need.slice(i, i + 100);
    const q = batch.map(encodeURIComponent).join(',');
    const url = `https://danbooru.donmai.us/tags.json?search%5Bname_comma%5D=${q}&only=name,category,post_count,wiki_page&limit=100`;
    const rows = await getJson(url);
    if (rows === undefined) continue;
    const seen = new Set();
    for (const row of rows || []) {
      if (!row || !row.name) continue;
      seen.add(row.name);
      state.tags[row.name] = {
        category: row.category, postCount: row.post_count || 0,
        otherNames: (row.wiki_page && row.wiki_page.other_names) || [], from: 'verify',
      };
    }
    for (const n of batch) if (!seen.has(n)) state.tags[n] = { category: null, postCount: 0, otherNames: [], from: 'absent' };
    writeJson(STATE, state);
    console.log(`  [verify] ${Math.min(i + 100, need.length)}/${need.length}`);
  }

  // 3 手勢の出した綴りが danbooru では「語ですらない」(category 0) ことがある。
  // その多くは danbooru 自身が別名として正準へ繋いでいるので、諦める前に辿る。
  // ここで拾えないと「調べたのに無い」と「綴りが古いだけ」が混ざる
  const needAlias = [...new Set(gated
    .map((g) => g.dan)
    .filter((n) => {
      const row = state.tags[n];
      if (!row || row.category == null) return true;                 // 無い
      if (!(row.otherNames || []).some((s) => /[぀-ヿ一-鿿]/.test(String(s)))) return true;  // 日本語が無い
      return false;
    })
    .filter((n) => !(n in state.aliases)))];
  if (needAlias.length) {
    console.log(`[verify] 別名の鎖を辿る: ${needAlias.length} 語 (${Math.ceil(needAlias.length / 100)} 回)`);
    const targets = [];
    for (let i = 0; i < needAlias.length; i += 100) {
      const batch = needAlias.slice(i, i + 100);
      const q = batch.map(encodeURIComponent).join(',');
      const rows = await getJson(`https://danbooru.donmai.us/tag_aliases.json?search%5Bantecedent_name_comma%5D=${q}&only=antecedent_name,consequent_name,status&limit=200`);
      if (rows === undefined) continue;
      for (const row of rows || []) {
        if (!row || !row.antecedent_name || !row.consequent_name) continue;
        state.aliases[row.antecedent_name] = row.consequent_name;
        targets.push(row.consequent_name);
      }
      for (const n of batch) if (!(n in state.aliases)) state.aliases[n] = null;
    }
    const fetchNow = [...new Set(targets)].filter((n) => !(n in state.tags));
    for (let i = 0; i < fetchNow.length; i += 100) {
      const batch = fetchNow.slice(i, i + 100);
      const q = batch.map(encodeURIComponent).join(',');
      const rows = await getJson(`https://danbooru.donmai.us/tags.json?search%5Bname_comma%5D=${q}&only=name,category,post_count,wiki_page&limit=100`);
      if (rows === undefined) continue;
      for (const row of rows || []) {
        if (!row || !row.name) continue;
        state.tags[row.name] = {
          category: row.category, postCount: row.post_count || 0,
          otherNames: (row.wiki_page && row.wiki_page.other_names) || [], from: 'verify-alias',
        };
      }
    }
    writeJson(STATE, state);
    console.log(`[verify] 鎖で渡った先: ${[...new Set(targets)].length} 語`);
  }

  const seed = [];
  for (const row of Object.values(state.tags)) for (const n of row.otherNames || []) seed.push(n);
  const chars = knownKanji({ seed, fresh: true });

  const accepted = []; let added = 0;
  const wantCatOf = (kind) => (kind === 'character' ? 4 : 3);
  for (const g of gated) {
    const wantCat = wantCatOf(g.kind);
    // 手勢の綴り、だめなら別名の渡り先。どちらでも「種別が合って日本語名がある」
    // ことを求める。ここを緩めると、名前が似ているだけの別物が入る
    let dan = g.dan;
    let row = state.tags[dan];
    const usable = (r) => r && r.category === wantCat
      && (r.otherNames || []).some((s) => isJapanese(s, chars));
    if (!usable(row)) {
      const target = state.aliases[g.dan];
      const next = target ? state.tags[target] : null;
      if (usable(next)) { dan = target; row = next; }
    }
    if (!row || row.category == null) { rejected.push({ ...g, why: 'danbooru にその語が無い' }); continue; }
    if (row.category !== wantCat) { rejected.push({ ...g, why: `種別が違う (danbooru category ${row.category})` }); continue; }
    const jp = (row.otherNames || []).filter((s) => isJapanese(s, chars));
    if (!jp.length) { rejected.push({ ...g, why: '日本語名が無い' }); continue; }
    // 鎖として残す。漢字は danbooru から取った文字列そのもの
    const from = g.hitomiName.replace(/ /g, '_');
    if (from !== dan && !state.aliases[from]) { state.aliases[from] = dan; added += 1; }
    accepted.push({ ...g, dan, labels: jp });
  }
  // 4 一つの danbooru の語を、二つ以上の hitomi の語が名乗ってはいけない。
  // 手勢は下の名前が同じだと引きずられる (tanya akulova と tanya を
  // tanya_degurechaff に、reisen two を reisen_udongein_inaba に繋いだ)。
  // 綴りの重なりだけでは別人と見分けられないが、**取り合いが起きたこと自体**が
  // 見分けになる。既に他の名前が持っている語も取り合いとして数える
  const claimants = new Map();
  const claim = (dan, who) => {
    if (!claimants.has(dan)) claimants.set(dan, new Set());
    claimants.get(dan).add(who);
  };
  for (const kind of ['character', 'series']) {
    const ns = kind === 'character' ? hv.namespaces.character : hv.namespaces.series;
    for (const hname of Object.keys(ns)) {
      const u = hname.replace(/ /g, '_');
      if (state.tags[u] && state.tags[u].category != null) claim(u, hname);   // 綴りがそのまま danbooru の語
      const t = state.aliases[u];
      if (t) claim(t, hname);                                                 // 既に鎖で持っている
    }
  }
  for (const a of accepted) claim(a.dan, a.hitomiName);
  const kept = [];
  for (const a of accepted) {
    const others = [...(claimants.get(a.dan) || [])].filter((n) => n !== a.hitomiName);
    if (!others.length) { kept.push(a); continue; }
    // 取り合いになったら、作品数の一番多い名前だけが名乗れる
    const counts = (n) => (a.kind === 'character' ? hv.namespaces.character : hv.namespaces.series)[n] || 0;
    const best = [a.hitomiName, ...others].sort((x, y) => counts(y) - counts(x))[0];
    if (best === a.hitomiName && !others.some((n) => counts(n) >= a.count)) { kept.push(a); continue; }
    const from = a.hitomiName.replace(/ /g, '_');
    if (state.aliases[from] === a.dan) { delete state.aliases[from]; added -= 1; }
    rejected.push({ ...a, why: `同じ danbooru の語を他も名乗っている (${others.slice(0, 3).join(', ')})` });
  }
  accepted.length = 0;
  accepted.push(...kept);

  // 一度通してから外した鎖は、名指しで控えへ伝える。merge は足すだけなので、
  // ここを書かないと前の回に混ざった誤りが控えに残り続ける
  const banned = rejected
    .filter((r) => r.dan && r.hitomiName)
    .map((r) => ({ from: r.hitomiName.replace(/ /g, '_'), to: r.dan }));
  writeJson(path.join(WORK, 'rejected-aliases.json'), banned, true);
  console.log(`[verify] 控えから外すよう伝える鎖: ${banned.length}`);

  writeJson(STATE, state);
  writeJson(path.join(WORK, 'verify-report.json'), {
    at: new Date().toISOString(),
    received: list.length, accepted: accepted.length, rejected: rejected.length, aliasesAdded: added,
    byReason: rejected.reduce((acc, r) => { acc[r.why] = (acc[r.why] || 0) + 1; return acc; }, {}),
    accepted, rejected,
  }, true);
  console.log(`[verify] 通った: ${accepted.length} / 落ちた: ${rejected.length} / 鎖を足した: ${added}`);
  console.log('[verify] 落ちた理由:', rejected.reduce((a, r) => { a[r.why] = (a[r.why] || 0) + 1; return a; }, {}));
  console.log(`[verify] 書いた: ${path.join(WORK, 'verify-report.json')}`);
}

(async () => {
  const { hv, state } = load();
  const phase = arg('phase', 'worklist');
  if (phase === 'worklist') phaseWorklist(hv, state);
  else if (phase === 'verify') await phaseVerify(hv, state);
  else throw new Error(`知らない段: ${phase}`);
})().catch((e) => { console.error(e); process.exit(1); });
