// Home の全作者 (作者フォルダ・サークル・作者) を pixiv / Pawchive / hitomi と突き合わせる。
// 画面へ出すのは数だけ (作者名・作品名は出さない)。名前の入った控えは scratchpad の results.json にだけ置く。
//
// 走らせ方 (BUNKO を --remote-debugging-port=9222 で起こしてから。終わったら普通に起こし直す):
//   node scripts/home-link-survey.cjs collect   動いている BUNKO (CDP 9222) から作者の一覧を引き、公開の辞書と突き合わせて results.json
//   node scripts/home-link-survey.cjs apply     results.json の「確か」を BUNKO の口 (home の link) で結ぶ
//   node scripts/home-link-survey.cjs report    results.json の「怪しい」を HTML の一覧に (名前入り。こちらでは開かない)
//
// 根拠の強さ:
//   own    利用者の持ち物で確かめた (所持の Pawchive の投稿 ID が相手の投稿に居る)          → 結ぶ
//   chain  ID の鎖 (FANBOX の id = pixiv の id、決まった pixiv の id を持つ辞書の行)      → 結ぶ
//   dict   タグそのもので引いた辞書の行 (EhTag の raw・Danbooru の名・pawchive の橋)        → 二つ目の裏付けで結ぶ
//   name   名前の一致 (日本語の名・ローマ字の揺れを畳んだ名)                               → 別の辞書が同じ答えなら結ぶ
// 同じサイトで答えが割れたら結ばない (怪しいへ)。
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { nfkc, hiraToKata, kataToRomaji, foldRomajiName } = require(path.join(ROOT, 'src/lib/search-text.js'));
const DATA = path.join(ROOT, 'work/vocabulary-research/data');
const CREATORS = path.join(ROOT, 'work/vocabulary-research/cache/bodies/304daada59b542ec6b7ce8f4bc398ae0927ee80b.json');
// 名前の入った控えと怪しい物の一覧は、リポジトリの外 (環境変数 HOME_SURVEY_DIR、無ければ OS の一時フォルダ) に置く
const OUT_DIR = process.env.HOME_SURVEY_DIR || path.join(require('os').tmpdir(), 'bunko-home-survey');
fs.mkdirSync(OUT_DIR, { recursive: true });
const OUT = path.join(OUT_DIR, 'results.json');
const BY = '突き合わせ 2026-09-24';

// ---- CDP ------------------------------------------------------------------
async function connect() {
  const list = await (await fetch('http://127.0.0.1:9222/json')).json();
  const page = list.find((item) => item.type === 'page' && /文匣/.test(item.title || ''));
  if (!page) throw new Error('文匣 の頁が見つからない');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) pending.get(message.id)(message);
  });
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, (message) => (message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 600000 });
    if (r.exceptionDetails) throw new Error(String((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text).split('\n')[0].slice(0, 200));
    return r.result.value;
  };
  return { evaluate, close: () => ws.close() };
}

// ---- 名前の鍵 ---------------------------------------------------------------
function nameKey(value) {
  return hiraToKata(nfkc(String(value == null ? '' : value))).toLowerCase().replace(/[\s_・･.\-]+/g, '');
}
// 日本語の名の読み (かなだけの名) をローマ字にして畳む。英字の名はそのまま畳む
function romaKey(value) {
  const text = nfkc(String(value || '')).trim();
  if (!text) return '';
  if (/^[\x20-\x7e]+$/.test(text)) return foldRomajiName(text);
  const roma = kataToRomaji(text);
  return roma ? foldRomajiName(roma) : '';
}
// 名前の鍵の長さ (漢字かなは 2)。短い名は取り違えやすいので名前だけでは結ばない
function units(key) {
  let n = 0;
  for (const ch of key) n += /[\u3040-\u30ff\u3400-\u9fff]/.test(ch) ? 2 : 1;
  return n;
}
const tagFold = (tag) => foldRomajiName(String(tag || '').replace(/_/g, ' '));

// ---- 公開の辞書を読む -------------------------------------------------------
function loadDictionaries() {
  const read = (file) => JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8'));
  const hitomi = read('hitomi-vocabulary.json').namespaces;
  const hitomiTags = { artist: new Set(Object.keys(hitomi.artist || {})), group: new Set(Object.keys(hitomi.group || {})) };
  const hitomiByFold = new Map();
  for (const ns of ['artist', 'group']) {
    for (const tag of hitomiTags[ns]) {
      const key = tagFold(tag);
      if (!key) continue;
      if (!hitomiByFold.has(key)) hitomiByFold.set(key, []);
      hitomiByFold.get(key).push(`${ns}:${tag}`);
    }
  }
  const ehtag = read('ehtag.json').namespaces;
  const ehByRaw = new Map();
  const ehByName = new Map();
  const ehByPixiv = new Map();
  for (const ns of ['artist', 'group']) {
    for (const row of ehtag[ns] || []) {
      const tag = `${ns}:${row.raw}`;
      const entry = { tag, name: row.name || '', pixivIds: (row.pixivIds || []).map(String) };
      ehByRaw.set(tag, entry);
      const key = nameKey(row.name);
      if (key) {
        if (!ehByName.has(key)) ehByName.set(key, []);
        ehByName.get(key).push(entry);
      }
      for (const id of entry.pixivIds) {
        if (!ehByPixiv.has(id)) ehByPixiv.set(id, []);
        ehByPixiv.get(id).push(entry);
      }
    }
  }
  const danbooru = Object.values(read('danbooru-artists.json').rows || {});
  const dbByFold = new Map();
  const dbByOther = new Map();
  const dbByPixiv = new Map();
  for (const row of danbooru) {
    if (!row || row.banned) continue;
    const pixivIds = [];
    const fanbox = [];
    for (const url of row.urls || []) {
      const p = String(url).match(/pixiv\.net\/(?:en\/)?users\/(\d+)|pixiv\.net\/member\.php\?id=(\d+)/i);
      if (p) pixivIds.push(p[1] || p[2]);
      const f = String(url).match(/([a-z0-9-]+)\.fanbox\.cc|fanbox\.cc\/@([a-z0-9-]+)/i);
      if (f) fanbox.push((f[1] || f[2]).toLowerCase());
    }
    const entry = { name: row.name, others: row.otherNames || [], pixivIds: [...new Set(pixivIds)], fanbox: [...new Set(fanbox)] };
    const fold = tagFold(row.name);
    if (fold) {
      if (!dbByFold.has(fold)) dbByFold.set(fold, []);
      dbByFold.get(fold).push(entry);
    }
    for (const other of entry.others) {
      const key = nameKey(other);
      if (!key) continue;
      if (!dbByOther.has(key)) dbByOther.set(key, []);
      dbByOther.get(key).push(entry);
    }
    for (const id of entry.pixivIds) {
      if (!dbByPixiv.has(id)) dbByPixiv.set(id, []);
      dbByPixiv.get(id).push(entry);
    }
  }
  const bridges = read('pawchive-authors.json').bridges || [];
  const brByTag = new Map();
  const brByPixiv = new Map();
  for (const row of bridges) {
    const tag = row.hitomi ? `${row.hitomi.namespace}:${row.hitomi.canonical}` : '';
    const entry = {
      tag, pixivId: row.pixivUserId ? String(row.pixivUserId) : '',
      paw: row.pawchive ? `${row.pawchive.service}:${row.pawchive.id}` : '', sources: row.identitySources || [],
    };
    if (tag) {
      if (!brByTag.has(tag)) brByTag.set(tag, []);
      brByTag.get(tag).push(entry);
    }
    if (entry.pixivId) {
      if (!brByPixiv.has(entry.pixivId)) brByPixiv.set(entry.pixivId, []);
      brByPixiv.get(entry.pixivId).push(entry);
    }
  }
  const creators = JSON.parse(fs.readFileSync(CREATORS, 'utf8'));
  const pawByKey = new Map();
  const pawByName = new Map();
  const pawByRoma = new Map();
  const pawByPublic = new Map();
  for (const row of creators) {
    const key = `${row.service}:${row.id}`;
    pawByKey.set(key, row);
    const nk = nameKey(row.name);
    if (nk) {
      if (!pawByName.has(nk)) pawByName.set(nk, []);
      pawByName.get(nk).push(key);
    }
    const rk = romaKey(row.name);
    if (rk) {
      if (!pawByRoma.has(rk)) pawByRoma.set(rk, []);
      pawByRoma.get(rk).push(key);
    }
    if (row.public_id) pawByPublic.set(String(row.public_id).toLowerCase(), key);
  }
  return {
    hitomiTags, hitomiByFold, ehByRaw, ehByName, ehByPixiv, dbByFold, dbByOther, dbByPixiv, brByTag, brByPixiv,
    pawByKey, pawByName, pawByRoma, pawByPublic,
  };
}

// ---- 作者の一覧 (動いている BUNKO から) -------------------------------------
async function listPersons(cdp) {
  return cdp.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = [];
    let page = 0;
    for (let tries = 0; page < 80 && tries < 200; tries += 1) {
      let r;
      try {
        r = await window.hitomi.search({ background: true, requestId: 'survey-' + page + '-' + tries, query: '', source: 'home', scope: 'all', sort: 'title', sortDir: 'asc', type: '', page, pageSize: 60, spanPages: 1 });
      } catch (error) { await sleep(300); continue; }
      for (const g of r.galleries || []) out.push({ id: g.id, title: g.title, home: g.home });
      if (!r.hasNext) break;
      page += 1;
    }
    return out;
  })()`);
}

// 作者フォルダの人の所持の本から、Pawchive の投稿 ID と pixiv の利用者 ID を拾う (確かめに使う)
async function ownedIds(cdp, id) {
  return cdp.evaluate(`(async () => {
    const p = await window.hitomi.home({ action: 'author', id: ${JSON.stringify(id)} });
    const posts = [];
    const pixivUsers = [];
    for (const b of (p && p.books) || []) {
      const g = b.gallery || {};
      if (g.postId) posts.push(String(g.postId));
      if (g.userId) pixivUsers.push(String(g.userId));
      for (const a of g.artists || []) if (a && a.userId) pixivUsers.push(String(a.userId));
    }
    return { posts, pixivUsers };
  })()`);
}

// Pawchive の作者の投稿 ID (新しい 100 件まで)。BUNKO の検索の口で (素性のクッキーは BUNKO が添える)
async function pawPosts(cdp, key) {
  const [service, user] = key.split(':');
  return cdp.evaluate(`(async () => {
    const ids = [];
    for (let page = 0; page < 2; page += 1) {
      let r;
      try {
        r = await window.hitomi.search({ background: true, requestId: 'survey-paw-' + page + '-' + Date.now(), query: ${JSON.stringify(`${service}/${user}`)}, source: 'pawchive', scope: 'all', sort: 'added', page, pageSize: 50 });
      } catch (error) { return { ids, error: String(error && error.message || error).slice(0, 80) }; }
      for (const g of r.galleries || []) { const m = String(g.id).split(':'); if (m[3]) ids.push(m[3]); }
      if (!r.hasNext) break;
    }
    return { ids };
  })()`);
}

// ---- 突き合わせ ---------------------------------------------------------------
function parseLinkUrl(site, url) {
  const text = String(url || '');
  if (site === 'pixiv') { const m = text.match(/users\/(\d+)/); return m ? m[1] : ''; }
  if (site === 'pawchive') { const m = text.match(/pawchive\.(?:pw|st)\/([a-z]+)\/user\/([^/?#]+)/i); return m ? `${m[1].toLowerCase()}:${decodeURIComponent(m[2])}` : ''; }
  if (site === 'hitomi') { const m = text.match(/hitomi\.la\/(artist|group)\/([^/?#]+)-[a-z]+\.html/i); return m ? `${m[1]}:${decodeURIComponent(m[2])}` : ''; }
  return '';
}

function siteUrl(site, value) {
  if (site === 'pixiv') return `https://www.pixiv.net/users/${value}`;
  if (site === 'pawchive') { const cut = value.indexOf(':'); return `https://pawchive.pw/${value.slice(0, cut)}/user/${encodeURIComponent(value.slice(cut + 1))}`; }
  if (site === 'hitomi') { const cut = value.indexOf(':'); return `https://hitomi.la/${value.slice(0, cut)}/${encodeURIComponent(value.slice(cut + 1))}-all.html`; }
  return '';
}

class Board {
  constructor() { this.map = new Map(); }
  add(site, value, strength, source, detail = '') {
    if (!value) return;
    const key = `${site}|${value}`;
    if (!this.map.has(key)) this.map.set(key, { site, value, evidence: [] });
    const row = this.map.get(key);
    if (!row.evidence.some((e) => e.source === source && e.strength === strength)) row.evidence.push({ strength, source, detail });
  }
  bySite(site) { return [...this.map.values()].filter((row) => row.site === site); }
}

// 一つの答えの確かさ。own / chain は一つで足りる。dict は二つ目 (別の辞書か名前) で、name は別の辞書二つで
// 根拠の出どころの家 (同じ辞書の二つの鍵は一つと数える)。EhTag の日本語名の一致は、利用者側の名前との照合なので別の家
function family(source) {
  return source === 'ehtag-name' ? 'namecheck' : source.split(/[-:]/)[0];
}

function verdict(row, { shortName }) {
  const kinds = new Set(row.evidence.map((e) => e.strength));
  const families = new Set(row.evidence.map((e) => family(e.source)));
  if (kinds.has('own') || kinds.has('chain')) return 'link';
  const dict = row.evidence.filter((e) => e.strength === 'dict');
  if (dict.length && families.size >= 2) return 'link';
  // 名前だけの一致は、短い名 (漢字かな 3 字未満) では結ばない。別の辞書二つが同じ答えなら結ぶ
  if (!shortName && families.size >= 2) return 'link';
  return 'suspicious';
}


// pixiv の利用者名 (一件 userDetail 一回。BUNKO の pixiv の車線と作法で)。告知付きの表示名は飾りを落とした形も鍵にする
async function pixivName(cdp, id) {
  const key = JSON.stringify(`pxu:${id}`);
  return cdp.evaluate(`(async () => {
    try {
      const g = await window.hitomi.gallery(${key});
      return { name: g && !g.error ? String(g.title || '') : '', error: g && g.error ? String(g.error).slice(0, 60) : '' };
    } catch (error) { return { name: '', error: String(error && error.message || error).slice(0, 60) }; }
  })()`);
}

function pixivNameKeys(name) {
  const base = nfkc(String(name || ''));
  const variants = new Set([
    base,
    base.replace(/[@＠].*$/, ''),
    base.replace(/[【[(（][^】\])）]*[】\])）]/g, ''),
    base.split(/[/|｜]/)[0],
  ]);
  return {
    names: [...variants].map(nameKey).filter((key) => key && units(key) >= 4),
    romas: [...variants].map(romaKey).filter((key) => key && key.length >= 5),
  };
}

// 辞書一つだけの pixiv の答えを、pixiv 自身の利用者名で確かめる (名前が合えば別の家の裏付け)
async function verifyPixivNames(cdp, boards) {
  const cache = new Map();
  let asked = 0;
  let agreed = 0;
  let failed = 0;
  for (const entry of boards.values()) {
    if (entry.linked.pixiv.size) continue;
    const rows = entry.board.bySite('pixiv').filter((row) => verdict(row, entry) !== 'link');
    if (!rows.length || rows.length > 3) continue;
    const mine = new Set(entry.names.map(nameKey).filter((key) => key && units(key) >= 4));
    const mineRoma = new Set(entry.names.map(romaKey).filter((key) => key && key.length >= 5));
    for (const row of rows) {
      if (!cache.has(row.value)) {
        cache.set(row.value, await pixivName(cdp, row.value));
        asked += 1;
      }
      const got = cache.get(row.value);
      if (!got.name) {
        if (got.error) failed += 1;
        continue;
      }
      const keys = pixivNameKeys(got.name);
      if (keys.names.some((key) => mine.has(key)) || keys.romas.some((key) => mineRoma.has(key))) {
        entry.board.add('pixiv', row.value, 'name', 'pixivname', 'pixiv の利用者名が一致');
        agreed += 1;
      }
    }
  }
  return { asked, agreed, failed };
}

async function collect() {
  const dict = loadDictionaries();
  const cdp = await connect();
  const persons = await listPersons(cdp);
  const counts = { persons: persons.length, folder: 0, circle: 0, hitomi: 0 };
  const results = [];
  // 1 周目: 名前とタグから答えの候補を集める
  const boards = new Map();
  for (const person of persons) {
    const home = person.home || {};
    counts[home.kind] = (counts[home.kind] || 0) + 1;
    const names = [...new Set([person.title, home.name, home.folderName, ...(home.circles || []).filter((c) => !c.minor).map((c) => c.label), ...(home.authors || []).map((a) => a.label)]
      .map((n) => String(n || '').replace(/\s*\((?:作者|\d+)\)$/, '').trim()).filter(Boolean))];
    const linked = { pixiv: new Set(), pawchive: new Set(), hitomi: new Set() };
    const candidateHitomi = new Set();
    for (const site of ['pixiv', 'pawchive', 'hitomi']) {
      for (const link of (home.links && home.links[site]) || []) {
        const value = parseLinkUrl(site, link.url);
        if (!value) continue;
        if (link.state === 'linked') linked[site].add(value);
        else if (site === 'hitomi') candidateHitomi.add(value);
      }
    }
    const tags = new Set([...linked.hitomi]);
    for (const c of home.circles || []) if (!c.minor && !c.candidate && c.group) tags.add(`group:${c.group}`);
    for (const a of home.authors || []) if (!a.candidate && a.artist) tags.add(`artist:${a.artist}`);
    const board = new Board();
    const nameKeys = names.map(nameKey).filter(Boolean);
    const shortName = !nameKeys.some((key) => units(key) >= 6);
    // pixiv: タグそのもので引く辞書
    for (const tag of tags) {
      const eh = dict.ehByRaw.get(tag);
      if (eh && eh.pixivIds.length === 1) board.add('pixiv', eh.pixivIds[0], 'dict', 'ehtag', 'EhTag のタグの行に pixiv の id');
      if (eh && eh.name && nameKeys.includes(nameKey(eh.name)) && eh.pixivIds.length === 1) board.add('pixiv', eh.pixivIds[0], 'dict', 'ehtag-name', 'EhTag の日本語名も一致');
      for (const br of dict.brByTag.get(tag) || []) {
        // 橋の pixiv の id は EhTag / Danbooru から来ている: 出どころの家で数える (二重に数えない)
        if (br.pixivId) for (const src of br.sources.length ? br.sources : ['bridge']) board.add('pixiv', br.pixivId, 'dict', src, `pawchive の橋 (${src} 由来)`);
        if (br.paw && br.sources.length >= 2) board.add('pawchive', br.paw, 'dict', 'bridge', 'pawchive の橋 (出どころ二つ)');
        else if (br.paw) board.add('pawchive', br.paw, 'name', 'bridge', 'pawchive の橋');
      }
      if (tag.startsWith('artist:')) {
        for (const db of dict.dbByFold.get(tagFold(tag.slice(7))) || []) {
          if (db.pixivIds.length === 1) board.add('pixiv', db.pixivIds[0], 'dict', 'danbooru', 'Danbooru の同じ名の作者の URL');
        }
      }
    }
    // pixiv / hitomi: 名前で引く辞書
    for (const key of nameKeys) {
      for (const eh of dict.ehByName.get(key) || []) {
        if (eh.pixivIds.length === 1) board.add('pixiv', eh.pixivIds[0], 'name', 'ehtag', 'EhTag の日本語名が一致');
        if (home.kind === 'folder' && !linked.hitomi.size && (dict.hitomiTags[eh.tag.split(':')[0]] || new Set()).has(eh.tag.slice(eh.tag.indexOf(':') + 1))) {
          board.add('hitomi', eh.tag, 'name', 'ehtag', 'EhTag の日本語名が一致');
        }
      }
      for (const db of dict.dbByOther.get(key) || []) {
        if (db.pixivIds.length === 1) board.add('pixiv', db.pixivIds[0], 'name', 'danbooru', 'Danbooru の別名が一致');
        if (home.kind === 'folder' && !linked.hitomi.size) {
          for (const tag of dict.hitomiByFold.get(tagFold(db.name)) || []) if (tag.startsWith('artist:')) board.add('hitomi', tag, 'name', 'danbooru', 'Danbooru の別名 → 名');
        }
      }
      for (const pk of dict.pawByName.get(key) || []) board.add('pawchive', pk, 'name', 'pawchive-name', 'Pawchive の作者名が一致');
    }
    for (const name of names) {
      const rk = romaKey(name);
      if (!rk || rk.length < 5) continue;
      if (home.kind === 'folder' && !linked.hitomi.size) {
        for (const tag of dict.hitomiByFold.get(rk) || []) board.add('hitomi', tag, 'name', 'roma', 'ローマ字の揺れを畳んで一致');
      }
      for (const pk of dict.pawByRoma.get(rk) || []) board.add('pawchive', pk, 'name', 'pawchive-roma', 'Pawchive の作者名 (ローマ字) が一致');
    }
    for (const tag of candidateHitomi) board.add('hitomi', tag, 'name', 'bunko', 'BUNKO の名前の一致 (候補)');
    boards.set(person.id, { person, names, linked, tags, board, shortName });
  }

  // 2 周目: 作者フォルダの人の持ち物で確かめる (所持の Pawchive の投稿 ID・pixiv の利用者 ID)
  let verifiedPosts = 0;
  for (const entry of boards.values()) {
    if (entry.person.home.kind !== 'folder') continue;
    const owned = await ownedIds(cdp, entry.person.id);
    for (const id of new Set(owned.pixivUsers)) entry.board.add('pixiv', id, 'own', 'owned-pixiv', '所持の pixiv の本の作者');
    if (entry.linked.pawchive.size || !owned.posts.length) continue;
    const mine = new Set(owned.posts);
    const candidates = entry.board.bySite('pawchive').map((row) => row.value).slice(0, 4);
    for (const key of candidates) {
      const got = await pawPosts(cdp, key);
      const hits = (got.ids || []).filter((id) => mine.has(id)).length;
      if (hits) {
        entry.board.add('pawchive', key, 'own', 'owned-posts', `所持の投稿 ${hits} 件が相手の投稿に居る`);
        verifiedPosts += 1;
      }
    }
  }

  // 2.5 周目: 辞書一つだけの pixiv の答えを pixiv 自身の利用者名で確かめる
  const pixivCheck = await verifyPixivNames(cdp, boards);

  // 3 周目: 決まった pixiv の id から鎖をたどる (FANBOX の id = pixiv の id、辞書の pixiv の id → hitomi のタグ)
  const decidedPixiv = new Map();
  for (const entry of boards.values()) {
    const decided = new Set(entry.linked.pixiv);
    const rows = entry.board.bySite('pixiv').filter((row) => !entry.linked.pixiv.has(row.value));
    const good = rows.filter((row) => verdict(row, entry) === 'link');
    if (good.length === 1 && !entry.linked.pixiv.size) decided.add(good[0].value);
    entry.decidedPixiv = decided;
    // 確かな pixiv の id (結び済みか、持ち物・鎖で決まった物)。hitomi のタグを鎖で寄せるのはこれだけ
    const strong = new Set(entry.linked.pixiv);
    for (const row of good) if (row.evidence.some((e) => e.strength === 'own' || e.strength === 'chain')) strong.add(row.value);
    for (const id of decided) {
      if (!decidedPixiv.has(id)) decidedPixiv.set(id, []);
      decidedPixiv.get(id).push(entry);
      if (dict.pawByKey.has(`fanbox:${id}`)) entry.board.add('pawchive', `fanbox:${id}`, 'chain', 'fanbox-id', 'FANBOX の id = pixiv の id');
      if (entry.person.home.kind === 'folder' && !entry.linked.hitomi.size) {
        for (const eh of dict.ehByPixiv.get(id) || []) {
          const [ns, ...rest] = eh.tag.split(':');
          if ((dict.hitomiTags[ns] || new Set()).has(rest.join(':'))) entry.board.add('hitomi', eh.tag, strong.has(id) ? 'chain' : 'dict', 'ehtag-pixiv', 'EhTag で同じ pixiv の id を持つタグ');
        }
        for (const br of dict.brByPixiv.get(id) || []) if (br.tag) entry.board.add('hitomi', br.tag, strong.has(id) ? 'chain' : 'dict', 'bridge-pixiv', 'pawchive の橋で同じ pixiv の id');
      }
    }
    for (const key of entry.linked.pawchive) {
      if (key.startsWith('fanbox:') && !entry.linked.pixiv.size) entry.board.add('pixiv', key.slice(7), 'chain', 'fanbox-id', '結んだ FANBOX の id = pixiv の id');
    }
  }
  // 同じ pixiv の id が作者フォルダと hitomi だけの見出しに付いた: 同じ人。hitomi のタグを作者フォルダに寄せる
  for (const [id, list] of decidedPixiv) {
    const folders = list.filter((entry) => entry.person.home.kind === 'folder');
    const others = list.filter((entry) => entry.person.home.kind !== 'folder');
    if (folders.length !== 1 || !others.length) continue;
    const folder = folders[0];
    if (folder.linked.hitomi.size) continue;
    for (const other of others) {
      const tag = [...other.tags].find((t) => t.startsWith(other.person.home.kind === 'circle' ? 'group:' : 'artist:'));
      if (tag) folder.board.add('hitomi', tag, folder.linked.pixiv.has(id) ? 'chain' : 'dict', 'same-pixiv', '同じ pixiv の id の hitomi の見出し');
    }
  }

  // 決める
  const absorbedTags = new Set();
  for (const entry of boards.values()) {
    for (const site of ['hitomi', 'pixiv', 'pawchive']) {
      if (entry.linked[site].size) continue;
      if (site === 'hitomi' && entry.person.home.kind !== 'folder') continue;
      const rows = entry.board.bySite(site);
      if (!rows.length) continue;
      const judged = rows.map((row) => ({ ...row, verdict: verdict(row, entry) }));
      const good = judged.filter((row) => row.verdict === 'link');
      // サークルは作者ごとに pixiv / Pawchive を持つことがある (利用者の指摘): 確かな答えが二つ以上でも割れとしない
      const home = entry.person.home || {};
      const many = site !== 'hitomi' && (home.kind === 'circle' || (home.circles || []).some((circle) => !circle.minor && !circle.candidate));
      const conflict = good.length > 1 && !many;
      for (const row of judged) {
        const decision = row.verdict === 'link' && !conflict ? 'link' : 'suspicious';
        if (decision === 'link' && site === 'hitomi') absorbedTags.add(row.value);
        results.push({
          id: entry.person.id, kind: entry.person.home.kind, display: entry.person.title, names: entry.names,
          site, value: row.value, url: siteUrl(site, row.value), decision,
          reason: conflict && row.verdict === 'link' ? '同じサイトで答えが割れた' : (row.verdict === 'link' ? '' : '裏付けが一つだけ'),
          evidence: row.evidence, alternatives: judged.filter((other) => other.value !== row.value).map((other) => other.value),
          candidateAccept: site === 'hitomi' && row.evidence.some((e) => e.source === 'bunko'),
        });
      }
    }
  }
  // 作者フォルダに寄る hitomi の見出しは、自分の pixiv / Pawchive を持たせない (寄った先の作者フォルダが持つ)
  for (const row of results) {
    if (row.kind === 'folder' || row.decision !== 'link' || row.site === 'hitomi') continue;
    const entry = boards.get(row.id);
    const own = [...entry.tags].find((t) => absorbedTags.has(t));
    if (own) {
      row.decision = 'suspicious';
      row.reason = '作者フォルダに寄る見出し (結ぶなら作者フォルダの方へ)';
    }
  }
  cdp.close();
  fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), counts, results }, null, 1));
  const tally = {};
  for (const row of results) {
    const key = `${row.site}:${row.decision}`;
    tally[key] = (tally[key] || 0) + 1;
  }
  const people = { link: new Set(results.filter((r) => r.decision === 'link').map((r) => r.id)).size, suspicious: new Set(results.filter((r) => r.decision !== 'link').map((r) => r.id)).size };
  console.log(JSON.stringify({ counts, verifiedPosts, pixivCheck, tally, people }, null, 1));
}

async function apply() {
  const data = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  // 2026-09-24 から: 辞書と名前の裏付けだけでは結ばない。「確か」も候補に足し、所持の作品が相手に 2 冊以上居るかを
  // scripts/home-link-verify.cjs で確かめてから結ぶ (.claude/skills/home-author-links)。前の動き (直に結ぶ) は --direct
  if (!process.argv.includes('--direct')) {
    let held = 0;
    for (const row of data.results) {
      if (row.decision !== 'link') continue;
      row.decision = 'suspicious';
      row.reason = '所持の作品 2 冊の確認待ち';
      held += 1;
    }
    fs.writeFileSync(OUT, JSON.stringify(data, null, 1));
    console.log(JSON.stringify({ held, next: 'suggest で候補に足し、home-link-verify.cjs collect → apply で確かめて結ぶ' }));
    return;
  }
  const cdp = await connect();
  const todo = data.results.filter((row) => row.decision === 'link');
  // pixiv と Pawchive を先に (hitomi を結ぶと見出しが作者フォルダに寄って id が変わる)
  todo.sort((a, b) => (a.site === 'hitomi') - (b.site === 'hitomi'));
  const tally = { ok: 0, fail: 0, reasons: {} };
  for (const row of todo) {
    const note = row.evidence.map((e) => e.detail).filter(Boolean).join(' / ').slice(0, 380);
    const op = row.candidateAccept ? 'accept' : 'save';
    const reply = await cdp.evaluate(`(async () => {
      try {
        const r = await window.hitomi.home({ action: 'link', id: ${JSON.stringify(row.id)}, site: ${JSON.stringify(row.site)}, op: ${JSON.stringify(op)}, url: ${JSON.stringify(row.url)}, by: ${JSON.stringify(BY)}, note: ${JSON.stringify(note)} });
        return { ok: Boolean(r && r.ok), reason: r && r.reason || '' };
      } catch (error) { return { ok: false, reason: String(error && error.message || error).slice(0, 60) }; }
    })()`);
    row.applied = reply;
    if (reply.ok) tally.ok += 1;
    else {
      tally.fail += 1;
      tally.reasons[reply.reason] = (tally.reasons[reply.reason] || 0) + 1;
    }
  }
  cdp.close();
  fs.writeFileSync(OUT, JSON.stringify(data, null, 1));
  console.log(JSON.stringify(tally));
}

// 怪しい答えを BUNKO の詳細の板の候補 (点線の鎖) として足す。結んだ組 (同じ人・同じサイト) の残りの答えは足さない
function doubtful(data) {
  const linkedSites = new Set(data.results
    .filter((row) => row.decision === 'link' && row.applied && row.applied.ok)
    .map((row) => `${row.id}|${row.site}`));
  return data.results.filter((row) => (row.decision !== 'link' || (row.applied && !row.applied.ok))
    && !linkedSites.has(`${row.id}|${row.site}`));
}

async function suggestDoubtful() {
  const data = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  const rows = doubtful(data).map((row) => ({
    id: row.id, site: row.site, url: row.url,
    note: `${row.reason || '裏付けが一つだけ'}: ${row.evidence.map((e) => e.detail).filter(Boolean).join(' / ')}`.slice(0, 380),
  }));
  const cdp = await connect();
  const reply = await cdp.evaluate(`(async () => {
    try { return await window.hitomi.home({ action: 'suggest', by: ${JSON.stringify(BY)}, rows: ${JSON.stringify(rows)} }); }
    catch (error) { return { ok: false, reason: String(error && error.message || error).slice(0, 80) }; }
  })()`);
  cdp.close();
  data.suggested = { at: new Date().toISOString(), sent: rows.length, reply };
  fs.writeFileSync(OUT, JSON.stringify(data, null, 1));
  console.log(JSON.stringify({ sent: rows.length, reply }));
}

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function report() {
  const data = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  const siteLabel = { pixiv: 'pixiv', pawchive: 'Pawchive', hitomi: 'hitomi' };
  const strengthLabel = { own: '持ち物で確認', chain: 'ID の鎖', dict: '辞書 (タグで引いた)', name: '名前の一致' };
  const doubt = doubtful(data);
  const done = data.results.filter((row) => row.decision === 'link' && row.applied && row.applied.ok);
  const byPerson = new Map();
  for (const row of doubt) {
    if (!byPerson.has(row.id)) byPerson.set(row.id, []);
    byPerson.get(row.id).push(row);
  }
  const personRows = [...byPerson.values()].sort((a, b) => String(a[0].display).localeCompare(String(b[0].display), 'ja'));
  const card = (rows) => {
    const head = rows[0];
    const kind = head.kind === 'folder' ? '作者フォルダ' : (head.kind === 'circle' ? 'サークル' : '作者');
    const items = rows.map((row) => `<li><span class="site">${siteLabel[row.site]}</span> <a href="${esc(row.url)}">${esc(row.url)}</a>`
      + `<div class="why">${row.evidence.map((e) => `<span class="ev ev-${e.strength}">${esc(strengthLabel[e.strength])}: ${esc(e.detail)}</span>`).join('')}</div>`
      + `<div class="doubt">${esc(row.applied && !row.applied.ok ? `結べなかった (${row.applied.reason})` : row.reason)}${row.alternatives.length ? ` · ほかの答え ${row.alternatives.length} 件` : ''}</div></li>`).join('');
    return `<section><h2>${esc(head.display)} <small>${kind}</small></h2><ul>${items}</ul></section>`;
  };
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>突き合わせの怪しい物</title>
<style>
:root{--bg:#15171a;--fg:#e8e6e1;--dim:#9a978f;--line:#2c3036;--own:#7fd8dc;--chain:#7fd8dc;--dict:#e9b36a;--name:#c9a3e6}
@media (prefers-color-scheme: light){:root{--bg:#fafaf7;--fg:#1d1f22;--dim:#6b6860;--line:#ddd9cf}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 system-ui,sans-serif}
main{max-width:980px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:20px;margin:0 0 4px} p.lead{color:var(--dim);margin:0 0 20px}
section{border-top:1px solid var(--line);padding:14px 0}
h2{font-size:16px;margin:0 0 6px} h2 small{font-weight:400;color:var(--dim);margin-left:8px;font-size:12px}
ul{margin:0;padding-left:18px} li{margin:6px 0}
.site{display:inline-block;min-width:68px;font-weight:600}
a{color:#7fb8e8;word-break:break-all}
.why{margin:2px 0 0} .ev{display:inline-block;margin:2px 6px 0 0;padding:1px 8px;border-radius:999px;border:1px solid var(--line);font-size:12px}
.ev-own,.ev-chain{border-color:var(--own)} .ev-dict{border-color:var(--dict)} .ev-name{border-color:var(--name)}
.doubt{color:var(--dim);font-size:12px}
</style></head><body><main>
<h1>突き合わせで怪しかった物 (${personRows.length} 人・${doubt.length} 件)</h1>
<p class="lead">結んだ物 ${done.length} 件は BUNKO の詳細の板に鎖の印 (水色) で出ています。ここに並ぶ物は結んでいません。<br>
同じ物が BUNKO の詳細の板に<b>候補 (点線の琥珀の鎖)</b> として出ています。Home の種別の札「候補あり」で絞ると一人ずつ確かめられます。正しければ鎖の釦 (結ぶ)、違えば切れた鎖の釦 (違う) を押してください。</p>
${personRows.map(card).join('\n')}
</main></body></html>`;
  const file = path.join(OUT_DIR, 'home-survey-doubtful.html');
  fs.writeFileSync(file, html);
  console.log(JSON.stringify({ file: path.basename(file), people: personRows.length, items: doubt.length, linked: done.length }));
}

const command = process.argv[2];
(async () => {
  if (command === 'collect') await collect();
  else if (command === 'apply') await apply();
  else if (command === 'suggest') await suggestDoubtful();
  else if (command === 'report') report();
  else console.log('usage: collect | apply | report');
})().catch((error) => { console.error(String(error && error.message || error).slice(0, 300)); process.exit(1); });
