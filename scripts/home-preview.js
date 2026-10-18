'use strict';
// Home (源泉横断の作者一覧 = 作者頁の入口) の試写台。node scripts/home-preview.js → http://127.0.0.1:18793/
//
// src/renderer の画面 (index.html / styles.css / bunko-ui / app.js) をそのまま配り、
// 源泉の並びから E-Hentai を外して先頭に Home を置く。Home の一覧は利用者の実データ
// (台帳 catalog.sqlite と控え paw-library-cache.json / pixiv-library.json / paw-links.json /
// reading.json / discovery-cache.json、Eagle の根の目録のフォルダ木) から起動時に組む。
//
//   左クリック   その作者の頁へ (本を発表の年か月ごとに、縦の年表の軸に沿って並べる。
//                hitomi の日本語の作品は未所持も網から引いて混ぜる)
//   右クリック   詳細の板 (各サイトの URL を結ぶ・最近の本)
//
// **手元の物は読むだけで何も書かない。** Eagle の項目のファイル (metadata.json・サムネイル・原本) は開かない。
// 表紙は動いている BUNKO の画像の口 (既定 http://127.0.0.1:18765 の /pwlibf/ /pweagle/ /img) から借りる。
// hitomi の作者の作品一覧は、本体と同じ hitomi-service で網から引く (作者の頁を開いた時だけ)。
// URL の結びは試写だけの物で、このページの localStorage にしか残らない (BUNKO の台帳には書かない)。
// サイトのアイコンは起動時に各サイトから一度だけ取る (取れなければ頭文字の丸)。
// 標準出力には件数だけを出す (作者名・題は出さない)。
//
// 使い方:
//   ?veil=1        絵を隠し、作者名・題・URL を伏せる (写真を撮る時・人に見せる時)
//   ?min=<n>       作者フォルダに居ない hitomi の作者を並べる下限の冊数 (既定 3)
// 環境変数:
//   PORT (既定 18793) / BUNKO_IMAGE_BASE (既定 http://127.0.0.1:18765)
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const PORT = Number(process.env.PORT) || 18793;
const LIVE = String(process.env.BUNKO_IMAGE_BASE || 'http://127.0.0.1:18765').replace(/\/+$/, '');

const aliases = require(path.join(ROOT, 'src', 'lib', 'search-aliases'));
const vocabulary = require(path.join(ROOT, 'src', 'lib', 'search-vocabulary'));
const { searchAuthorContext } = require(path.join(ROOT, 'src', 'lib', 'search-author-context'));
const { portQuery } = require(path.join(ROOT, 'src', 'lib', 'sources', 'query-port'));
const { nfkc, hiraToKata } = require(path.join(ROOT, 'src', 'lib', 'search-text'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
};

function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function file(res, p) {
  fs.readFile(p, (err, bytes) => {
    if (err) { send(res, 404, 'text/plain', 'not found'); return; }
    send(res, 200, MIME[path.extname(p)] || 'application/octet-stream', bytes);
  });
}

// ---------------------------------------------------------------------------
// サイトのアイコン (起動時に一度だけ取る)
// ---------------------------------------------------------------------------

const ICON_URLS = {
  pixiv: 'https://www.pixiv.net/favicon.ico',
  pawchive: 'https://pawchive.pw/static/favicon.png',
  hitomi: 'https://ltn.gold-usergeneratedcontent.net/favicon-192x192.png',
  nhentai: 'https://nhentai.net/favicon.png',
  dlsite: 'https://www.dlsite.com/modpub/images/web/common/apple_touch_icon_72x72.png',
  fanza: 'https://www.dmm.co.jp/favicon.ico',
  x: 'https://abs.twimg.com/favicons/twitter.3.ico',
};
const ICON_LETTERS = { pixiv: 'P', pawchive: 'Pw', hitomi: 'h', nhentai: 'n', dlsite: 'DL', fanza: 'F', x: 'X' };
const icons = new Map();

function fetchBytes(url, hops = 3) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, timeout: 8000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops > 0) {
        res.resume();
        resolve(fetchBytes(new URL(res.headers.location, url).href, hops - 1));
        return;
      }
      if (res.statusCode !== 200 || !/^image\//.test(String(res.headers['content-type'] || ''))) {
        res.resume();
        resolve(null);
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ type: String(res.headers['content-type']), bytes: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function letterIcon(ch) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="15" fill="#2c3648"/><text x="16" y="21" text-anchor="middle" font-family="sans-serif" font-size="13" font-weight="700" fill="#efe8d8">${ch}</text></svg>`;
}

async function loadIcons() {
  const got = await Promise.all(Object.entries(ICON_URLS).map(async ([site, url]) => [site, await fetchBytes(url)]));
  for (const [site, icon] of got) if (icon) icons.set(site, icon);
  console.log('icons:', [...icons.keys()].join(' ') || 'none', `(${icons.size}/${Object.keys(ICON_URLS).length})`);
}

// ---------------------------------------------------------------------------
// 実データから作者の一覧を組む (読むだけ)
// ---------------------------------------------------------------------------

function userDataDir() {
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(roaming, 'hitomi-box');
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// paw-library.js と同じ名前の規約: [YYYYMMDD] [postId] 題【17P】
const DATE_RE = /^\s*\[(\d{8})\]/;
const POST_RE = /\[(\d{5,9})\]/;
const PAGE_RE = /【\s*(\d+)\s*[PpＰｐ]\s*】/;
const PIXIV_URL = /pixiv\.net\/(?:en\/)?artworks\/(\d+)/i;
// PPD の名前 (<pid>_p0-題)
const PPD_NAME = /^(\d{5,})_p\d+-?/;
// 即売会 (コミケ) の記号。前後が英数字でない C84〜C109 だけ
const EVENT_RE = /(?:^|[^A-Za-z0-9])C(8[4-9]|9\d|10\d)(?!\d)/;

function parseName(raw) {
  let text = String(raw || '').trim();
  let date = null;
  let postId = null;
  let pages = 0;
  const d = text.match(DATE_RE);
  if (d) { date = `${d[1].slice(0, 4)}-${d[1].slice(4, 6)}-${d[1].slice(6, 8)}`; text = text.slice(d[0].length); }
  const p = text.match(POST_RE);
  if (p && !/^20\d{6}$/.test(p[1])) { postId = p[1]; text = `${text.slice(0, p.index)} ${text.slice(p.index + p[0].length)}`; }
  const pg = text.match(PAGE_RE);
  if (pg) { pages = Number(pg[1]) || 0; text = `${text.slice(0, pg.index)} ${text.slice(pg.index + pg[0].length)}`; }
  return { date, postId, pages, title: text.replace(/\s+/g, ' ').trim() };
}

// コミケの回 → 年と季節と月。偶数回が夏 (8 月)、奇数回が冬 (12 月)。C98 は中止、C99 は 2021 冬
function comiket(n) {
  if (n === 98) return { year: 2020, season: '中止', month: 5 };
  if (n === 99) return { year: 2021, season: '冬', month: 12 };
  const summer = n % 2 === 0;
  const year = n >= 100 ? 2022 + Math.floor((n - 100) / 2) : (summer ? 2019 - (96 - n) / 2 : 2019 - (97 - n) / 2);
  return { year, season: summer ? '夏' : '冬', month: summer ? 8 : 12 };
}

function eventOf(text) {
  const hit = String(text || '').match(EVENT_RE);
  return hit ? Number(hit[1]) : null;
}

// 名前の突き合わせの鍵 (候補を出すためだけ。確定には使わない)
function nameKey(value) {
  return hiraToKata(nfkc(String(value || ''))).toLowerCase().replace(/[\s_・･.\u3000]+/g, '');
}

// 数 (ms) と日付の字のどちらでも受ける。0 や空は「分からない」 (Date.parse('0') は 2000 年を返すので通さない)
function toMs(value) {
  if (!value) return 0;
  const n = Number(value);
  if (Number.isFinite(n)) return n > 1e11 ? n : 0;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? t : 0;
}

function isoDate(value) {
  const t = toMs(value);
  return t ? new Date(t).toISOString().slice(0, 10) : null;
}

function hitomiArtistUrl(artist) {
  return `https://hitomi.la/artist/${encodeURIComponent(String(artist))}-all.html`;
}

// nhentai の作者の名は、hitomi の artist の空白を - にした物であることが多い (推測)。候補にだけ使う
function nhentaiArtistUrl(artist) {
  return `https://nhentai.net/artist/${encodeURIComponent(String(artist).trim().replace(/\s+/g, '-'))}/`;
}

function newPerson(kind, key, name) {
  return {
    kind, key, name, books: [], newCount: 0,
    links: { pixiv: null, pawchive: null, hitomi: null, nhentai: null, dlsite: null, fanza: null, x: null },
  };
}

async function buildHome(options) {
  const dir = userDataDir();
  const counts = { folders: 0, folderBooks: 0, hitomiArtists: 0, hitomiShown: 0, candidates: 0, pixivLinks: 0, pawLinks: 0 };
  const cfg = readJson(path.join(dir, 'config.json')) || {};
  const lib = String(cfg.eagleLibrary || '').trim();
  const rootId = String(cfg.pawEagleFolder || '').trim();

  // Eagle の根の目録にあるフォルダ木。作者 = 「作者」フォルダの直下の子 (paw-library と同じ決まり)
  const persons = new Map();
  const owner = new Map();
  const tree = lib ? readJson(path.join(lib, 'metadata.json')) : null;
  let root = null;
  const find = (folder) => {
    if (!folder || root) return;
    if (String(folder.id || '') === rootId) { root = folder; return; }
    for (const child of folder.children || []) find(child);
  };
  for (const folder of (tree && tree.folders) || []) find(folder);
  const walk = (folder, top) => {
    owner.set(String(folder.id || ''), top);
    for (const child of folder.children || []) walk(child, top);
  };
  for (const child of (root && root.children) || []) {
    const id = String(child.id || '');
    if (!id) continue;
    persons.set(id, newPerson('folder', id, String(child.name || '')));
    walk(child, id);
  }
  counts.folders = persons.size;

  const reading = readJson(path.join(dir, 'reading.json')) || {};
  const readAt = (key) => Number(reading[key] && reading[key].updatedAt) || 0;

  // pixiv の台帳 (取り込んだ本と、作者の結び)
  const pixivLib = readJson(path.join(dir, 'pixiv-library.json')) || {};
  const pixivByEagle = new Map();
  for (const [pid, work] of Object.entries(pixivLib.works || {})) {
    if (work && work.eagleId) pixivByEagle.set(String(work.eagleId), { pid, ...work });
  }
  for (const [userId, creator] of Object.entries(pixivLib.creators || {})) {
    const p = persons.get(String(creator && creator.folderId));
    if (p) { p.links.pixiv = { url: `https://www.pixiv.net/users/${userId}`, candidate: false }; counts.pixivLinks += 1; }
  }

  // pawchive の手の結び (service:user → 作者フォルダ)
  const pawLinks = readJson(path.join(dir, 'paw-links.json')) || {};
  for (const [key, folderId] of Object.entries(pawLinks.creators || {})) {
    const p = persons.get(String(folderId));
    const cut = String(key).indexOf(':');
    if (p && cut > 0) {
      p.links.pawchive = { url: `https://pawchive.pw/${key.slice(0, cut)}/user/${key.slice(cut + 1)}`, candidate: false };
      counts.pawLinks += 1;
    }
  }

  // 作者フォルダの本 (pawchive の所持の控え。Eagle の項目のファイルは開かない)
  const paw = readJson(path.join(dir, 'paw-library-cache.json')) || {};
  for (const [eagleId, entry] of Object.entries(paw.entries || {})) {
    const r = entry && entry.r;
    if (!r) continue;
    const folderId = (r.folders || []).map((f) => owner.get(String(f))).find(Boolean);
    if (!folderId) continue;
    const person = persons.get(folderId);
    const name = String(r.name || '');
    const work = pixivByEagle.get(eagleId);
    let origin;
    let date = null;
    let title;
    let pages = 0;
    if (work || PIXIV_URL.test(String(r.url || '')) || PPD_NAME.test(name)) {
      origin = 'pixiv';
      date = work && work.date ? isoDate(work.date) : null;
      title = (work && work.title) || name.replace(PPD_NAME, '');
      pages = Number(work && work.pages) || 0;
    } else {
      const parsed = parseName(name);
      origin = parsed.date || parsed.postId ? 'pawchive' : 'local';
      date = parsed.date;
      title = parsed.title || name;
      pages = parsed.pages;
    }
    person.books.push({
      origin, title, date, pages,
      event: eventOf(name),
      star: Number(r.star) || 0,
      mtime: toMs(r.mtime),
      cover: `${LIVE}/pweagle/${encodeURIComponent(eagleId)}`,
      read: readAt(`pweagle:${eagleId}`),
    });
    counts.folderBooks += 1;
  }

  // hitomi の所持の本を作者 (artist タグ) ごとに (台帳)
  const hitomi = new Map();
  const ownedGids = new Set();
  try {
    const initSqlJs = require(path.join(ROOT, 'node_modules', 'sql.js'));
    const SQL = await initSqlJs();
    const db = new SQL.Database(fs.readFileSync(path.join(dir, 'catalog.sqlite')));
    const labels = new Map();
    const lab = db.exec("SELECT name, label FROM tag_labels WHERE type = 'artist' AND label IS NOT NULL AND label <> ''");
    for (const [name, label] of (lab[0] && lab[0].values) || []) if (!labels.has(name)) labels.set(name, label);
    const owned = db.exec("SELECT gallery_id FROM items WHERE gallery_id IS NOT NULL AND gallery_id <> ''");
    for (const [gid] of (owned[0] && owned[0].values) || []) ownedGids.add(String(gid));
    const rows = db.exec(`
      SELECT t.name, i.gallery_id, i.star, i.added_at, g.published_date, g.added_date, g.title, g.page_count, g.language
      FROM items i
      JOIN gallery_tags t ON t.gallery_id = i.gallery_id AND t.type = 'artist'
      LEFT JOIN galleries g ON g.id = i.gallery_id
      WHERE i.gallery_id IS NOT NULL AND i.gallery_id <> ''`);
    for (const [artist, gid, star, addedAt, published, added, title, pageCount, language] of (rows[0] && rows[0].values) || []) {
      const key = String(artist);
      if (!hitomi.has(key)) hitomi.set(key, { artist: key, label: labels.get(key) || '', books: [] });
      hitomi.get(key).books.push({
        origin: 'hitomi',
        gid: String(gid),
        lang: String(language || ''),
        title: String(title || ''),
        date: isoDate(published) || isoDate(added) || isoDate(addedAt),
        pages: Number(pageCount) || 0,
        event: eventOf(title),
        star: Number(star) || 0,
        mtime: toMs(addedAt),
        cover: `${LIVE}/img?id=${encodeURIComponent(String(gid))}&i=0&size=small`,
        read: readAt(String(gid)),
      });
    }
    db.close();
  } catch (error) {
    console.log('catalog read failed:', error.code || error.message);
  }
  counts.hitomiArtists = hitomi.size;

  // 発見の控え: よく集めている hitomi の作者と、その新作
  const discovery = readJson(path.join(dir, 'discovery-cache.json')) || {};
  const followed = new Set((discovery.followed || []).map((f) => String(f.artist)));
  const newByArtist = new Map();
  for (const release of discovery.newReleases || []) {
    for (const a of release.artists || []) {
      const key = String(a.name || '');
      newByArtist.set(key, (newByArtist.get(key) || 0) + 1);
    }
  }

  // 名前の一致は「候補」: 作者フォルダの見出しに添えるが、確定はしない (ADR 0002 の線)
  const folderByKey = new Map();
  for (const person of persons.values()) {
    const k = nameKey(person.name);
    if (k && !folderByKey.has(k)) folderByKey.set(k, person);
  }
  const min = Math.max(1, Number(options.min) || 3);
  for (const entry of hitomi.values()) {
    const match = folderByKey.get(nameKey(entry.label)) || folderByKey.get(nameKey(entry.artist));
    if (match && !match.links.hitomi) {
      match.links.hitomi = { url: hitomiArtistUrl(entry.artist), candidate: true };
      match.links.nhentai = { url: nhentaiArtistUrl(entry.artist), candidate: true };
      match.books.push(...entry.books.map((b) => ({ ...b, origin: 'hitomi?' })));
      match.newCount += newByArtist.get(entry.artist) || 0;
      counts.candidates += 1;
      continue;
    }
    if (entry.books.length < min && !followed.has(entry.artist)) continue;
    const person = newPerson('hitomi', entry.artist, entry.label || entry.artist.replace(/_/g, ' '));
    // 台帳の artist タグは hitomi の名乗りそのもの (確定)。nhentai は同じ名で引ける見込みの候補
    person.links.hitomi = { url: hitomiArtistUrl(entry.artist), candidate: false };
    person.links.nhentai = { url: nhentaiArtistUrl(entry.artist), candidate: true };
    person.books = entry.books;
    person.newCount = newByArtist.get(entry.artist) || 0;
    persons.set(`h:${entry.artist}`, person);
    counts.hitomiShown += 1;
  }

  const authors = [];
  const booksById = new Map();
  let serial = 0;
  for (const person of persons.values()) {
    serial += 1;
    const books = person.books.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || b.mtime - a.mtime);
    const bySource = { pawchive: 0, pixiv: 0, hitomi: 0, local: 0 };
    for (const b of books) bySource[b.origin === 'hitomi?' ? 'hitomi' : b.origin] += 1;
    const confirmed = books.filter((b) => b.origin !== 'hitomi?');
    const dated = books.filter((b) => b.date);
    const eventCount = new Map();
    for (const b of books) if (b.event) eventCount.set(b.event, (eventCount.get(b.event) || 0) + 1);
    const events = [...eventCount.entries()].sort((a, b) => b[0] - a[0]).map(([n, count]) => ({ code: `C${n}`, ...comiket(n), count }));
    const lastRead = books.reduce((m, b) => Math.max(m, b.read || 0), 0);
    const lastDate = dated.length ? dated.reduce((m, b) => (b.date > m ? b.date : m), '') : isoDate(books[0] && books[0].mtime);
    const id = `home:${person.kind === 'folder' ? 'f' : 'h'}:${person.key}`;
    const face = person.kind === 'folder' ? `${LIVE}/pwlibf/${encodeURIComponent(person.key)}` : (books[0] ? books[0].cover : '');
    const shaped = books.map((b) => ({ title: b.title, date: b.date, origin: b.origin, pages: b.pages, star: b.star, cover: b.cover,
      event: b.event ? `C${b.event}` : null, gid: b.gid || null, lang: b.lang || null }));
    booksById.set(id, shaped);
    authors.push({
      id,
      short: `a${serial}`,
      kind: person.kind,
      name: person.name,
      face,
      owned: confirmed.length,
      bySource,
      links: person.links,
      lastDate,
      lastRead: lastRead || null,
      newCount: person.newCount,
      events,
      recent: shaped.filter((b) => !b.lang || b.lang === 'japanese').slice(0, 8),
    });
  }
  return { generatedAt: Date.now(), live: LIVE, counts, authors, booksById, ownedGids };
}

let homeCache = null;
function home(options) {
  const key = String(options.min || 3);
  if (!homeCache || homeCache.key !== key) {
    homeCache = { key, promise: buildHome(options).then((data) => {
      // 件数だけを出す (作者名・題は出さない)
      console.log('home built:', JSON.stringify(data.counts), 'authors:', data.authors.length);
      return data;
    }) };
  }
  return homeCache.promise;
}

// hitomi の作者の日本語の作品 (網)。本体の hitomi-service で引く。作者の頁を開いた時だけ、作者ごとに一度
const HITOMI_MAX_PAGES = 4;
const hitomiWebCache = new Map();
function hitomiWeb(artist) {
  const key = String(artist || '').trim();
  if (!key) return Promise.resolve({ works: [], more: false });
  if (!hitomiWebCache.has(key)) {
    hitomiWebCache.set(key, (async () => {
      const service = require(path.join(ROOT, 'src', 'lib', 'hitomi-service'));
      const data = await home({ min: 3 });
      const query = `artist:${key.replace(/\s+/g, '_')}`;
      const works = [];
      let more = false;
      for (let page = 0; page < HITOMI_MAX_PAGES; page += 1) {
        const res = await service.search({ query, language: 'japanese', sort: 'added', page, pageSize: 60 });
        for (const g of res.galleries || []) {
          works.push({
            gid: String(g.id), title: String(g.title || ''), pages: Number(g.pageCount) || 0,
            date: isoDate(g.publishedDate) || isoDate(g.addedDate),
            lang: String((g.language && g.language.name) || 'japanese'),
            cover: `${LIVE}/img?id=${encodeURIComponent(String(g.id))}&i=0&size=small`,
            owned: data.ownedGids.has(String(g.id)),
          });
        }
        if (!res.hasNext) break;
        if (page === HITOMI_MAX_PAGES - 1) more = true;
      }
      // 件数だけを出す
      console.log('hitomi works:', works.length, 'owned:', works.filter((w) => w.owned).length, more ? '(more)' : '');
      return { works, more };
    })().catch((error) => {
      hitomiWebCache.delete(key);
      console.log('hitomi works failed:', error.code || String(error.message || error).slice(0, 80));
      return { works: [], more: false, error: true };
    }));
  }
  return hitomiWebCache.get(key);
}

// ---------------------------------------------------------------------------
// 画面の側: 偽の母屋の口 (window.hitomi) と、app.js の後ろに差す Home の差し込み
// ---------------------------------------------------------------------------

// 他の源泉のタブは renderer-preview と同じ偽の棚 (番号入りの見本) で埋める
function coverSvg(n) {
  const hue = (n * 47) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="566" viewBox="0 0 400 566">
<rect width="400" height="566" fill="hsl(${hue} 22% 74%)"/>
<rect x="80" y="100" width="240" height="280" rx="16" fill="hsl(${hue} 30% 58%)"/>
<rect x="0" y="441" width="400" height="125" fill="hsl(${hue} 35% 30%)" opacity=".85"/>
<text x="386" y="552" text-anchor="end" font-family="sans-serif" font-size="24" fill="#fff" opacity=".8">${n}</text>
</svg>`;
}

const SHIM = `'use strict';
(() => {
  const params = new URLSearchParams(location.search);
  const VEIL = params.get('veil') === '1';
  if (VEIL) document.documentElement.dataset.veil = '1';
  const later = (value) => new Promise((resolve) => setTimeout(() => resolve(value), 30));
  const minQuery = params.get('min') ? '&min=' + encodeURIComponent(params.get('min')) : '';

  // Home の元データ (起動時に一度だけ)
  const homeReady = fetch('/__home.json?x=1' + minQuery).then((r) => r.json()).catch(() => ({ authors: [] }));
  const homeIndex = new Map();
  const booksCache = new Map();
  const booksOf = (id) => {
    if (!booksCache.has(id)) {
      booksCache.set(id, fetch('/__home-books?id=' + encodeURIComponent(id) + minQuery).then((r) => r.json()).catch(() => []));
    }
    return booksCache.get(id);
  };
  const webCache = new Map();
  const hitomiOf = (artist) => {
    if (!webCache.has(artist)) {
      webCache.set(artist, fetch('/__home-hitomi?artist=' + encodeURIComponent(artist)).then((r) => r.json()).catch(() => ({ works: [], error: true })));
    }
    return webCache.get(artist);
  };
  window.__bunkoHome = { ready: homeReady, index: homeIndex, veil: VEIL, booksOf, hitomiOf, books: new Map() };
  homeReady.then((data) => { for (const a of data.authors || []) homeIndex.set(a.id, a); });

  const nameKey = (v) => String(v || '').normalize('NFKC').toLowerCase().replace(/[\\s_]+/g, '');
  function findAuthor(key) {
    for (const a of homeIndex.values()) if (a.short === key || a.name === key) return a;
    return null;
  }
  function authorGallery(a) {
    return { id: a.id, source: 'home', kind: 'creator', title: a.name, home: a,
      artists: [], groups: [], series: [], characters: [], tags: [], pageCount: 0,
      badge: '', owned: false, url: '' };
  }
  function homeSearch(payload, data) {
    const q = nameKey(payload.query);
    const type = String(payload.type || '');
    let list = (data.authors || []).slice();
    if (q) list = list.filter((a) => nameKey(a.name).includes(q));
    if (type === 'pixiv') list = list.filter((a) => a.links.pixiv || a.bySource.pixiv);
    if (type === 'pawchive') list = list.filter((a) => a.links.pawchive || a.bySource.pawchive);
    if (type === 'hitomi') list = list.filter((a) => a.bySource.hitomi || a.links.hitomi);
    if (type === 'candidate') list = list.filter((a) => Object.entries(a.links).some(([k, l]) => l && l.candidate && k !== 'nhentai'));
    const sort = String(payload.sort || 'activity');
    const byName = (x, y) => String(x.name).localeCompare(String(y.name), 'ja');
    if (sort === 'owned') list.sort((x, y) => y.owned - x.owned || byName(x, y));
    else if (sort === 'read') list.sort((x, y) => (y.lastRead || 0) - (x.lastRead || 0) || byName(x, y));
    else if (sort === 'title') list.sort(byName);
    else list.sort((x, y) => String(y.lastDate || '').localeCompare(String(x.lastDate || '')) || y.owned - x.owned);
    const page = Number(payload.page) || 0;
    const size = Number(payload.pageSize) || 48;
    const span = Math.max(1, Number(payload.spanPages) || 1);
    const slice = list.slice(page * size, (page + span) * size).map(authorGallery);
    return { requestId: payload.requestId, galleries: slice, total: list.length,
      hasNext: (page + span) * size < list.length, spanPages: span, query: payload.query };
  }
  // 作者の頁 (@名前)。一覧は差し込みの側が縦の年表で描く。ここは件数と「隠れた一覧」のためだけに返す
  async function authorPage(payload) {
    const a = findAuthor(String(payload.query || '').trim().slice(1).trim());
    const books = a ? await booksOf(a.id) : [];
    return { requestId: payload.requestId, total: books.length, hasNext: false, spanPages: 1, query: payload.query,
      galleries: books.map((b, i) => ({ id: 'homebook-hidden:' + i, source: 'home', homeHidden: true, title: '',
        artists: [], groups: [], series: [], characters: [], tags: [], pageCount: 0, owned: false, url: '' })) };
  }

  // 他の源泉のタブ: 番号入りの見本 (実在の作品は映らない)
  const items = [];
  for (let i = 0; i < 48; i += 1) {
    items.push({ id: String(2000000 + i), source: 'hitomi', title: '見本の本 ' + (i + 1),
      artists: [{ name: 'sample', label: '見本作家', type: 'artist' }], groups: [], series: [], characters: [], tags: [],
      type: 'doujinshi', language: { name: 'japanese', localName: '日本語' }, pageCount: 8 + ((i * 7) % 52),
      publishedDate: '2026-09-01', addedDate: '2026-09-10', owned: false, idOwned: false, similarOwned: false, star: 0,
      eagleId: '', linkedEagleId: '', url: 'https://example.invalid/' + (2000000 + i) });
  }
  const byId = new Map(items.map((g) => [g.id, g]));

  // 差し込み (/__home-patch.js) が入るまで設定を返さない。サーバが実データを組んでいる間は
  // 差し込みの配信が遅れ、その間に本体が最初の描画まで進んでしまうため (5 秒で諦めて進める)
  let patchDone = null;
  const patchReady = new Promise((resolve) => { patchDone = resolve; setTimeout(resolve, 5000); });
  window.__bunkoHomePatched = () => patchDone();

  let settings = {
    downloadDir: 'C:/見本/取り込み', eagleLibrary: 'D:/見本/eagle.library', pawBulkDir: 'C:/見本/pawchive',
    concurrency: 4, maxGalleries: 8, zoom: Number(params.get('zoom')) || 3, source: 'home', language: '',
    readerRtl: true, readerFit: 'contain', readerSpread: false, readerResume: true, loupe: false,
    autoSync: true, favoriteMinStars: 4, saveFormat: 'pdf', searchHistory: [], searchPins: [],
    sortBySource: { 'all:home': 'activity' }, session: null,
  };

  const base = {
    // 源泉の並び: E-Hentai を外し、先頭に Home
    searchProviders: [
      { id: 'home', label: 'Home' },
      { id: 'hitomi', label: 'hitomi' },
      { id: 'nhentai', label: 'nhentai' },
      { id: 'pawchive', label: 'pawchive' },
      { id: 'pixiv', label: 'pixiv' },
    ],
    completionRanges: (input) => window.BunkoSearchIntent.completionRanges(input),
    portQuery: (query, from, to, context) => {
      if (from === 'home' || to === 'home') return { query: '', dropped: [] };
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/__port', false);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(JSON.stringify({ query, from, to, context: context || {} }));
      try { return JSON.parse(xhr.responseText); } catch { return { query, dropped: [] }; }
    },
    searchAuthorContext: (payload) => (payload && (payload.from === 'home' || payload.to === 'home'))
      ? later({})
      : fetch('/__context', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then((r) => r.json()),
    imageBase: () => later(location.origin),
    settings: () => patchReady.then(() => later(settings)),
    saveSettings: (partial) => { settings = Object.assign({}, settings, partial || {}); return later(settings); },
    search: (payload) => {
      if (payload.source === 'home') {
        if (String(payload.query || '').trim().startsWith('@')) return homeReady.then(() => authorPage(payload));
        return homeReady.then((data) => homeSearch(payload, data));
      }
      const page = Number(payload.page) || 0;
      const size = Number(payload.pageSize) || 24;
      const span = Math.max(1, Number(payload.spanPages) || 1);
      const slice = items.slice(page * size, (page + span) * size);
      return later({ requestId: payload.requestId, galleries: slice, total: items.length,
        hasNext: (page + span) * size < items.length, spanPages: span, query: payload.query });
    },
    cancelSearch: () => later(null),
    gallery: (id) => {
      const key = String(id);
      if (key.startsWith('home:')) return homeReady.then(() => (homeIndex.has(key) ? authorGallery(homeIndex.get(key)) : null));
      return later(byId.get(key) || null);
    },
    suggest: () => later([]),
    annotate: (list) => later(list),
    downloads: () => later([]),
    catalog: () => later({ scanning: false }),
    libraryStatus: () => later({ owned: 0, withMeta: 0, backfill: null, flags: {}, fallbacks: 0 }),
    pawBulk: () => later({ running: false }),
    pawFavorites: () => later({ items: [] }),
    lanShare: () => later({ running: false }),
    pixiv: () => later({ loggedIn: false }),
    discovery: () => later({ sections: [] }),
    seriesGaps: () => later([]),
    readingGet: () => later(null),
    readingSet: () => later(null),
    readerActive: () => later(null),
    toggleFullscreen: () => later(null),
    noteFallback: () => {},
    openExternal: () => later(null),
    openEagle: () => later(null),
    setEagleStar: (id, star) => later({ ok: true, star }),
  };
  window.hitomi = new Proxy(base, {
    get(target, key) {
      if (key in target) return target[key];
      if (typeof key === 'string' && key.startsWith('on')) return () => () => {};
      return () => later(null);
    },
  });
})();
`;

// app.js の後ろに差す。頂上の function 宣言は window の束縛なので後勝ちで差し替えられる。
// const (SORTS / DEFAULT_SORT / state / els) は同じ大域の字句環境にあるので名前で届く
const PATCH = `'use strict';
(() => {
  const HOME = 'home';
  const H = window.__bunkoHome;
  const VEIL = Boolean(H && H.veil);
  const esc = (v) => escapeHtml(v == null ? '' : v);
  // 伏せ: 名前・題・URL を同じくらいの長さの黒四角に (写真を撮る時)
  const mask = (v) => '■'.repeat(Math.min(12, Math.max(2, String(v || '').length)));
  const txt = (v) => (VEIL ? mask(v) : esc(v));
  const urlText = (u) => {
    if (!VEIL) return esc(u);
    try { const x = new URL(u); return esc(x.origin) + '/' + mask(x.pathname); } catch { return mask(u); }
  };
  const author = (id) => H && H.index.get(String(id));
  const store = {
    get(key, fallback) { try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 残せなくても画面は動く */ } },
  };

  SORTS.home = [
    { id: 'activity', label: '最近の動き' },
    { id: 'owned', label: '所持の多い順' },
    { id: 'read', label: '最近読んだ順' },
    { id: 'title', label: '名前' },
  ];
  DEFAULT_SORT.home = 'activity';
  const HOME_TYPES = [
    { id: '', label: 'すべて' },
    { id: 'pixiv', label: 'pixiv' },
    { id: 'pawchive', label: 'Pawchive' },
    { id: 'hitomi', label: 'hitomi' },
    { id: 'candidate', label: '候補あり' },
  ];
  const priorTypesFor = window.typesFor;
  window.typesFor = function homeTypesFor(source = state.source) {
    return source === HOME ? HOME_TYPES : priorTypesFor(source);
  };

  // ---- サイトの結び (試写だけ: このページの localStorage にしか残らない) ----
  const SITES = [
    { key: 'pixiv', label: 'pixiv', hint: 'https://www.pixiv.net/users/…',
      parse: (u) => { const m = u.match(/pixiv\\.net\\/(?:en\\/)?users\\/(\\d+)/i); return m ? 'https://www.pixiv.net/users/' + m[1] : ''; } },
    { key: 'pawchive', label: 'Pawchive', hint: 'https://pawchive.pw/fanbox/user/…',
      parse: (u) => { const m = u.match(/pawchive\\.(?:pw|st)\\/([a-z]+)\\/user\\/([\\w.-]+)/i); return m ? 'https://pawchive.pw/' + m[1].toLowerCase() + '/user/' + m[2] : ''; } },
    { key: 'hitomi', label: 'hitomi', hint: 'https://hitomi.la/artist/…-all.html',
      parse: (u) => { const m = u.match(/hitomi\\.la\\/artist\\/(.+?)-(?:all|japanese|english|chinese|korean)\\.html/i); return m ? 'https://hitomi.la/artist/' + m[1] + '-all.html' : ''; } },
    { key: 'nhentai', label: 'nhentai', hint: 'https://nhentai.net/artist/…/',
      parse: (u) => { const m = u.match(/nhentai\\.net\\/artist\\/([^\\/?#]+)/i); return m ? 'https://nhentai.net/artist/' + m[1] + '/' : ''; } },
    { key: 'dlsite', label: 'DLsite', hint: 'https://www.dlsite.com/maniax/circle/profile/=/maker_id/RG….html',
      parse: (u) => {
        const m = u.match(/dlsite\\.com\\/([a-z]+)\\/circle\\/profile\\/=\\/maker_id\\/(RG\\d+)/i) || u.match(/dlsite\\.com\\/()[^\\s]*?maker_id\\/(RG\\d+)/i);
        return m ? 'https://www.dlsite.com/' + ((m[1] || 'maniax').toLowerCase()) + '/circle/profile/=/maker_id/' + m[2].toUpperCase() + '.html' : '';
      } },
    { key: 'fanza', label: 'FANZA', hint: 'https://www.dmm.co.jp/dc/doujin/-/list/=/article=maker/id=…/',
      parse: (u) => { const m = u.match(/dmm\\.co\\.jp\\/dc\\/doujin\\/-\\/list\\/=\\/article=(maker|author)\\/id=(\\d+)/i); return m ? 'https://www.dmm.co.jp/dc/doujin/-/list/=/article=' + m[1].toLowerCase() + '/id=' + m[2] + '/' : ''; } },
    { key: 'x', label: 'X', hint: 'https://x.com/…',
      parse: (u) => {
        const m = u.match(/(?:^|\\/\\/)(?:www\\.|mobile\\.)?(?:x|twitter)\\.com\\/@?([A-Za-z0-9_]{1,15})(?:[\\/?#]|$)/i);
        const reserved = /^(home|i|intent|share|search|explore|settings|messages|notifications|hashtag)$/i;
        return m && !reserved.test(m[1]) ? 'https://x.com/' + m[1] : '';
      } },
  ];
  const STORE = 'home-preview-links';
  let saved = store.get(STORE, {}) || {};
  function linkOf(a, key) {
    const own = saved[a.id] && saved[a.id][key];
    if (own) return own;
    const l = a.links[key];
    return l ? { url: l.url, state: l.candidate ? 'candidate' : 'linked' } : { url: '', state: 'none' };
  }
  function setLink(a, key, value) {
    saved[a.id] = saved[a.id] || {};
    saved[a.id][key] = value;
    store.set(STORE, saved);
  }

  // 「?」の印: 白い丸に黒の ?。小さくても読める形にする
  const QUESTION = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7.5" fill="#fff"/>'
    + '<path d="M5.9 6.1a2.15 2.15 0 1 1 3 2c-.62.3-.95.7-.95 1.35v.3" fill="none" stroke="#111" stroke-width="1.7" stroke-linecap="round"/>'
    + '<circle cx="7.95" cy="11.9" r="1.05" fill="#111"/></svg>';

  // 見出しの左下: つながっているサイトのアイコンだけを、右上の頁数の印と同じ帯に並べる。
  // 未確定の候補 (名前が一致しただけ) や出どころの分からない本があれば ? を一つ。
  // nhentai の候補は名前からの推測なので見出しには出さない (詳細の板でだけ見せる)
  function siteIcons(a) {
    const out = [];
    let unsure = a.bySource.local > 0;
    for (const s of SITES) {
      const l = linkOf(a, s.key);
      if (l.state === 'candidate') { if (s.key !== 'nhentai') unsure = true; continue; }
      const present = l.state === 'linked'
        || (l.state !== 'rejected' && ((s.key === 'pixiv' && a.bySource.pixiv > 0) || (s.key === 'pawchive' && a.bySource.pawchive > 0)));
      if (!present) continue;
      out.push('<span class="home-site" title="' + s.label + '"><img src="/__icon/' + s.key + '" alt="' + s.label + '"></span>');
    }
    if (unsure || !out.length) {
      out.push('<span class="home-site is-unknown" title="' + (unsure ? '未確定の候補か、出どころの分からない本がある' : 'つながっているサイトが分からない') + '">' + QUESTION + '</span>');
    }
    return out.join('');
  }

  // pixiv の札と同じ頁数の印 (本体の pageCountBadge と同じ絵)
  const COUNT_ICON = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 17h8a2 2 0 0 0 2-2V7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><rect x="2" y="2" width="12" height="12" rx="2" fill="currentColor"/></svg>';
  const countBadge = (n, label) => '<span class="page-count-badge" aria-label="' + label + '">' + COUNT_ICON + '<span>' + n + '</span></span>';

  const priorImgUrl = window.imgUrl;
  window.imgUrl = function homeImgUrl(id, index, size) {
    const key = String(id);
    if (key.startsWith('home:')) { const a = author(key); return a ? a.face : ''; }
    if (key.startsWith('homebook:')) { const b = H.books.get(key); return b ? b.cover : ''; }
    return priorImgUrl(id, index, size);
  };

  const priorCardMarkup = window.cardMarkup;
  window.cardMarkup = function homeCardMarkup(gallery) {
    if (gallery && gallery.homeHidden) return '<article class="card home-hidden" data-id="' + esc(gallery.id) + '"></article>';
    if (!gallery || !gallery.home) return priorCardMarkup(gallery);
    const a = gallery.home;
    return '<article class="card is-creator home-author" tabindex="0" role="button" data-id="' + esc(gallery.id) + '">'
      + '<div class="cover">' + coverMedia(gallery)
      + countBadge(a.owned, '所持 ' + a.owned + ' 冊')
      + (a.newCount ? '<span class="home-new">新 ' + a.newCount + '</span>' : '')
      + '<span class="home-sites">' + siteIcons(a) + '</span>'
      + '</div>'
      + '<div class="card-body"><div class="card-heading"><h3 class="card-title">' + txt(a.name) + '</h3></div></div>'
      + '</article>';
  };

  // ---- 作者の頁 (@名前): 本を発表の年か月ごとに、縦の年表の軸に沿って並べる ----
  function openAuthorPage(a) {
    state.query = '@' + (VEIL ? a.short : a.name);
    els.query.value = state.query;
    renderSources();
    runSearch({ reset: true });
  }
  function leaveAuthorPage() {
    state.query = '';
    els.query.value = '';
    renderSources();
    runSearch({ reset: true });
  }
  const view = document.createElement('section');
  view.id = 'home-author-view';
  view.hidden = true;
  els.grid.parentNode.insertBefore(view, els.grid);
  const pending = document.createElement('button');
  pending.type = 'button';
  pending.className = 'home-av-pending';
  pending.hidden = true;
  document.body.appendChild(pending);

  function currentAuthor() {
    if (state.source !== HOME) return null;
    const q = String(state.query || '').trim();
    if (!q.startsWith('@')) return null;
    const key = q.slice(1).trim();
    for (const a of H.index.values()) if (a.short === key || a.name === key) return a;
    return null;
  }

  const ORIGIN_SOURCE = { pixiv: 'pixiv', pawchive: 'pawchive', local: 'pawchive', hitomi: 'hitomi', 'hitomi?': 'hitomi', web: 'hitomi' };
  const ORIGIN_LABEL = { pixiv: 'pixiv', pawchive: 'Pawchive', local: '持ち込み', hitomi: 'hitomi', 'hitomi?': 'hitomi (候補)', web: 'hitomi (未所持)' };
  function bookCard(id, b) {
    const owned = b.origin !== 'web';
    const g = { id, source: ORIGIN_SOURCE[b.origin] || 'hitomi', title: VEIL ? mask(b.title) : b.title, kind: '',
      artists: [], groups: [], series: [], characters: [], tags: [],
      // 頁数の分からない pawchive の本を、本体の coverIsEmpty は「表紙の無い投稿」と見て空の印にする。
      // ここに並ぶのは表紙のある本なので 1 として渡す (頁数の印は 2 以上でしか出ない)
      pageCount: b.pages > 0 ? b.pages : 1,
      owned, idOwned: owned, star: b.star || 0, url: '' };
    let html = priorCardMarkup(g);
    if (b.candidate) {
      html = html.replace('<div class="card-acts">', '<span class="home-book-q" title="名前が一致しただけの候補">' + QUESTION + '</span><div class="card-acts">');
    }
    return html;
  }

  // 年か月か (切り替えは覚える)
  let groupBy = store.get('home-preview-group', 'year') === 'month' ? 'month' : 'year';
  const groupKey = (date) => (date ? (groupBy === 'month' ? date.slice(0, 7) : date.slice(0, 4)) : '?');
  const groupLabel = (key) => {
    if (key === '?') return '日付不明';
    if (groupBy === 'year') return key;
    return key.slice(0, 4) + '年' + Number(key.slice(5, 7)) + '月';
  };

  const BACK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  let viewState = null;

  function mergedBooks(a, own, web) {
    // hitomi は日本語だけ。所持の本 (hitomi 以外) はそのまま
    const books = own.filter((b) => !b.gid || !b.lang || b.lang === 'japanese').map((b) => ({ ...b, candidate: b.origin === 'hitomi?' }));
    const have = new Set(books.filter((b) => b.gid).map((b) => b.gid));
    const hitomiLink = linkOf(a, 'hitomi');
    for (const w of (web && web.works) || []) {
      if (have.has(w.gid)) continue;
      // 持っている本でも、結びを後から足した作者だと手元の一覧に居ないことがある: 所持として並べる
      books.push({ origin: w.owned ? 'hitomi' : 'web', title: w.title, date: w.date, pages: w.pages, cover: w.cover, gid: w.gid,
        candidate: hitomiLink.state === 'candidate' });
    }
    return books.sort((x, y) => String(y.date || '').localeCompare(String(x.date || '')));
  }

  function renderAuthorView() {
    const { a, own, web, loading } = viewState;
    const books = mergedBooks(a, own, web);
    H.books.clear();
    const groups = new Map();
    books.forEach((b, i) => {
      const id = 'homebook:' + i;
      H.books.set(id, b);
      const k = groupKey(b.date);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push({ id, b });
    });
    const keys = [...groups.keys()].filter((k) => k !== '?').sort((x, y) => y.localeCompare(x));
    if (groups.has('?')) keys.push('?');
    const eventsFor = (k) => (a.events || []).filter((e) => (groupBy === 'year'
      ? String(e.year) === k
      : k === e.year + '-' + String(e.month).padStart(2, '0')));
    const sections = keys.map((k) => {
      const list = groups.get(k);
      const ev = k === '?' ? [] : eventsFor(k);
      const webCount = list.filter(({ b }) => b.origin === 'web').length;
      return '<section class="home-av-group' + (k === '?' ? ' is-unknown' : '') + '" data-key="' + k + '">'
        + '<i class="home-av-node" aria-hidden="true"></i>'
        + '<h3 class="home-av-label"><span class="home-av-y">' + groupLabel(k) + '</span>'
        + ev.map((e) => '<span class="home-av-ev" title="' + esc(e.code + ' ' + e.year + ' ' + e.season + ' ' + e.count + ' 冊') + '"><b>' + esc(e.code) + '</b>' + esc(e.season) + '</span>').join('')
        + '<small>' + list.length + ' 冊' + (webCount ? ' (未所持 ' + webCount + ')' : '') + '</small></h3>'
        + '<div class="grid home-av-cards">' + list.map(({ id, b }) => bookCard(id, b)).join('') + '</div>'
        + '</section>';
    }).join('');
    const dated = keys.filter((k) => k !== '?');
    const span = dated.length ? (dated[dated.length - 1].slice(0, 4) === dated[0].slice(0, 4) ? dated[0].slice(0, 4) : dated[dated.length - 1].slice(0, 4) + '–' + dated[0].slice(0, 4)) : '';
    const webTotal = books.filter((b) => b.origin === 'web').length;
    const status = loading ? 'hitomi を読み込み中…' : (web && web.error ? 'hitomi を読めませんでした' : (web && web.more ? 'hitomi は新しい 240 冊まで' : ''));
    view.innerHTML = '<header class="home-av-head">'
      + '<button type="button" class="ghost iconbtn home-av-back" data-home-back title="Home へ戻る" aria-label="Home へ戻る">' + BACK_ICON + '</button>'
      + '<span class="home-av-face"><img src="' + esc(a.face) + '" alt=""></span>'
      + '<div class="home-av-title"><h2>' + txt(a.name) + '</h2>'
      + '<p><span class="home-sites is-inline">' + siteIcons(a) + '</span><span>' + books.length + ' 冊' + (webTotal ? ' (未所持 ' + webTotal + ')' : '') + '</span>'
      + (span ? '<span>' + span + '</span>' : '') + '<span class="home-av-status">' + esc(status) + '</span></p></div>'
      + '<div class="ui-segments home-av-mode" role="group" aria-label="まとめ方">'
      + '<button type="button" data-home-group="year" aria-pressed="' + (groupBy === 'year') + '">年</button>'
      + '<button type="button" data-home-group="month" aria-pressed="' + (groupBy === 'month') + '">月</button></div>'
      + '</header>'
      + '<div class="home-av-timeline"><i class="home-av-progress" aria-hidden="true"></i>' + sections + '</div>';
    trackPosition();
  }

  // 軸: 今読んでいる位置まで線が水色に伸び、その位置にある年 (月) の丸だけが水色になる (発光はしない)
  let onScroll = null;
  function trackPosition() {
    const timeline = view.querySelector('.home-av-timeline');
    const progress = view.querySelector('.home-av-progress');
    const groupsEls = [...view.querySelectorAll('.home-av-group')];
    const update = () => {
      if (!timeline || view.hidden) return;
      const line = (document.querySelector('.ui-topbar')?.getBoundingClientRect().bottom || 120) + 14;
      let current = groupsEls[0];
      for (const g of groupsEls) { if (g.getBoundingClientRect().top <= line) current = g; else break; }
      groupsEls.forEach((g) => g.classList.toggle('is-current', g === current));
      const top = timeline.getBoundingClientRect().top;
      const max = timeline.getBoundingClientRect().height;
      progress.style.height = Math.max(0, Math.min(max, line - top)) + 'px';
    };
    // 送りのたびに直に測る (requestAnimationFrame は窓が裏に回ると止まり、丸が動かなくなる)。
    // 測るのは段の数 (多くて百余り) の上端だけなので軽い。16ms に一度へ間引く
    let last = 0;
    let timer = 0;
    if (onScroll) window.removeEventListener('scroll', onScroll);
    onScroll = () => {
      const now = Date.now();
      clearTimeout(timer);
      if (now - last >= 16) { last = now; update(); }
      timer = setTimeout(update, 40);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    update();
  }

  function hitomiArtistOf(a) {
    const l = linkOf(a, 'hitomi');
    if (l.state !== 'linked' && l.state !== 'candidate') return '';
    const m = String(l.url || '').match(/hitomi\\.la\\/artist\\/(.+?)-all\\.html/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  async function syncAuthorView() {
    await H.ready;
    const a = currentAuthor();
    document.body.toggleAttribute('data-home-author', Boolean(a));
    if (!a) {
      if (!view.hidden) { view.hidden = true; view.innerHTML = ''; view.dataset.id = ''; viewState = null; pending.hidden = true; }
      return;
    }
    if (view.dataset.id === a.id && !view.hidden) return;
    view.dataset.id = a.id;
    view.hidden = false;
    pending.hidden = true;
    const own = await H.booksOf(a.id);
    if (currentAuthor() !== a) return;
    const artist = hitomiArtistOf(a);
    viewState = { a, own, web: null, loading: Boolean(artist) };
    renderAuthorView();
    window.scrollTo(0, 0);
    if (!artist) return;
    const web = await H.hitomiOf(artist);
    if (currentAuthor() !== a || !viewState || viewState.a !== a) return;
    const add = ((web && web.works) || []).filter((w) => !w.owned).length;
    // 読み始めていなければそのまま並べる。送っていたら重ねた札で知らせ、押された時に並べる (並びを押しのけない)
    if (window.scrollY < 40 || !add) {
      viewState.web = web; viewState.loading = false; renderAuthorView();
    } else {
      viewState.loading = false;
      const status = view.querySelector('.home-av-status');
      if (status) status.textContent = '';
      pending.textContent = 'hitomi の未所持 ' + add + ' 冊を並べる';
      pending.hidden = false;
      pending.onclick = () => {
        pending.hidden = true;
        if (!viewState || viewState.a !== a) return;
        viewState.web = web;
        renderAuthorView();
      };
    }
  }

  // ---- 見出しの押し分け: 左 = 作者の頁、右 = 詳細の板 ----
  els.grid.addEventListener('click', (event) => {
    const card = event.target.closest('.card.home-author[data-id]');
    if (!card) return;
    event.stopImmediatePropagation();
    event.preventDefault();
    const a = author(card.dataset.id);
    if (a) openAuthorPage(a);
  }, true);
  els.grid.addEventListener('contextmenu', (event) => {
    const card = event.target.closest('.card.home-author[data-id]');
    if (!card) return;
    event.stopImmediatePropagation();
    event.preventDefault();
    const gallery = findGallery(card.dataset.id);
    if (gallery) renderDetail(gallery);
  }, true);
  const priorPerform = window.performCardAction;
  window.performCardAction = function homePerform(action, id) {
    if (String(id).startsWith('home:')) {
      const a = author(id);
      if (a) openAuthorPage(a);
      return;
    }
    return priorPerform(action, id);
  };

  // ---- 詳細の板 (右クリック) ----
  const BOOK_ICON = (window.BunkoIcons && window.BunkoIcons['open-book']) || ICON.book;
  function siteLabel(s) {
    return s.label;
  }
  function linkCell(a, s) {
    const l = linkOf(a, s.key);
    if (l.state === 'linked') {
      return '<a class="home-url" href="#" data-site="' + esc(l.url) + '">' + urlText(l.url) + '</a>'
        + '<button type="button" class="home-link-act" data-home-unlink="' + s.key + '">外す</button>';
    }
    if (l.state === 'candidate') {
      return '<a class="home-url is-candidate" href="#" data-site="' + esc(l.url) + '">' + urlText(l.url) + '</a>'
        + '<span class="home-state is-candidate">候補</span>'
        + '<button type="button" class="home-link-act" data-home-accept="' + s.key + '">結ぶ</button>'
        + '<button type="button" class="home-link-act" data-home-reject="' + s.key + '">違う</button>';
    }
    return '<span class="home-url-edit"><input type="url" class="home-url-input" data-home-input="' + s.key + '" placeholder="' + esc(s.hint) + '" spellcheck="false" />'
      + '<button type="button" class="home-link-act" data-home-save="' + s.key + '">結ぶ</button></span>';
  }
  function recentList(a) {
    return (a.recent || []).map((b) => '<button type="button" class="pixiv-related-item" data-home-book>'
      + '<div class="pixiv-related-cover"><img src="' + esc(b.cover) + '" loading="lazy" alt="">' + (b.pages > 1 ? countBadge(b.pages, b.pages + ' ページ') : '') + '</div>'
      + '<span><strong>' + txt(b.title) + '</strong><span class="pixiv-related-meta"><span class="pixiv-related-author">'
      + esc(ORIGIN_LABEL[b.origin] || '') + (b.date ? ' · ' + b.date.replace(/-/g, '.') : '') + '</span></span></span></button>').join('');
  }
  function authorDetail(a) {
    const recent = recentList(a);
    return '<div class="detail-cover home-face"><img src="' + esc(a.face) + '" alt="" /></div>'
      + '<h2>' + txt(a.name) + '</h2>'
      + '<p class="kicker">作者 · 所持 ' + a.owned + ' 冊</p>'
      + '<div class="detail-actions"><button class="primary" type="button" data-home-open="' + esc(a.id) + '">' + BOOK_ICON + '作品を見る</button></div>'
      + '<dl class="detail-rows home-links">' + SITES.map((s) => detailRow(siteLabel(s), linkCell(a, s))).join('') + '</dl>'
      + (recent ? '<details class="pixiv-detail-related" open><summary>最近の本</summary><div class="pixiv-related-list">' + recent + '</div></details>' : '');
  }
  let detailAuthor = null;
  const priorRenderDetail = window.renderDetail;
  window.renderDetail = function homeRenderDetail(gallery) {
    if (!gallery || !gallery.home) { detailAuthor = null; return priorRenderDetail(gallery); }
    // 板の開け閉め・段組みの寄せは本体に任せ、中身だけ作者の物に差し替える
    priorRenderDetail({ ...gallery, kind: 'creator', url: '' });
    detailAuthor = gallery.home;
    els.detailBody.innerHTML = authorDetail(gallery.home);
  };
  function refreshAuthor(a) {
    if (detailAuthor === a && !els.detail.hidden) {
      const y = els.detail.scrollTop;
      els.detailBody.innerHTML = authorDetail(a);
      els.detail.scrollTop = y;
    }
    // 本体の refreshCard は作り直した札に Waterfall の位置 (left/top/幅/高さ) を引き継がないので、
    // 前の札の style を写し替える (写さないと、その一枚が一覧の上に全幅で重なる)
    const g = findGallery(a.id);
    const selector = '.card[data-id="' + CSS.escape(a.id) + '"]';
    const old = els.grid.querySelector(selector);
    const style = old && old.getAttribute('style');
    const ratioKey = old && old.dataset.ratioKey;
    if (g) refreshCard(g);
    const fresh = els.grid.querySelector(selector);
    if (fresh && style) {
      fresh.setAttribute('style', style);
      if (ratioKey) fresh.dataset.ratioKey = ratioKey;
    }
    if (view.dataset.id === a.id && !view.hidden) {
      const inline = view.querySelector('.home-sites.is-inline');
      if (inline) inline.innerHTML = siteIcons(a);
    }
  }
  function saveInput(a, key, input) {
    const site = SITES.find((s) => s.key === key);
    const url = site.parse(String(input.value || '').trim());
    const cell = input.closest('.row-value');
    cell.querySelector('.home-url-error')?.remove();
    if (!url) {
      cell.insertAdjacentHTML('beforeend', '<span class="home-url-error">' + site.label + ' の URL の形ではありません</span>');
      return;
    }
    setLink(a, key, { url, state: 'linked' });
    refreshAuthor(a);
  }
  els.detailBody.addEventListener('click', (event) => {
    const a = detailAuthor;
    if (!a) return;
    const t = event.target;
    const siteLink = t.closest('a.home-url');
    if (siteLink) { event.preventDefault(); return; }
    const open = t.closest('[data-home-open]');
    if (open) { openAuthorPage(a); return; }
    const unlink = t.closest('[data-home-unlink]');
    if (unlink) { setLink(a, unlink.dataset.homeUnlink, { url: '', state: 'none' }); refreshAuthor(a); return; }
    const accept = t.closest('[data-home-accept]');
    if (accept) { const l = linkOf(a, accept.dataset.homeAccept); setLink(a, accept.dataset.homeAccept, { url: l.url, state: 'linked' }); refreshAuthor(a); return; }
    const reject = t.closest('[data-home-reject]');
    if (reject) { setLink(a, reject.dataset.homeReject, { url: '', state: 'rejected' }); refreshAuthor(a); return; }
    const save = t.closest('[data-home-save]');
    if (save) { saveInput(a, save.dataset.homeSave, save.closest('.home-url-edit').querySelector('input')); }
  }, true);
  els.detailBody.addEventListener('keydown', (event) => {
    const input = event.target.closest && event.target.closest('[data-home-input]');
    if (!input || event.key !== 'Enter' || !detailAuthor) return;
    event.preventDefault();
    saveInput(detailAuthor, input.dataset.homeInput, input);
  });

  view.addEventListener('click', (event) => {
    if (event.target.closest('[data-home-back]')) { leaveAuthorPage(); return; }
    const mode = event.target.closest('[data-home-group]');
    if (mode && viewState && mode.dataset.homeGroup !== groupBy) {
      groupBy = mode.dataset.homeGroup === 'month' ? 'month' : 'year';
      store.set('home-preview-group', groupBy);
      renderAuthorView();
    }
  });

  // ---- 源泉・検索語が変わるたびに Home の顔を合わせる ----
  const priorRenderSources = window.renderSources;
  window.renderSources = function homeRenderSources() {
    priorRenderSources();
    const onHome = state.source === HOME;
    document.body.toggleAttribute('data-home', onHome);
    if (onHome && !libraryScope()) els.query.placeholder = '作者名で探す';
    syncAuthorView();
  };
  const priorRunSearch = window.runSearch;
  window.runSearch = function homeRunSearch(...args) {
    const result = priorRunSearch.apply(this, args);
    syncAuthorView();
    return result;
  };

  // 本体の restoreScroll は、見ていた位置が無いとき先頭の札の上端 (= 上部の下に潜る位置) へ送る。
  // Home の作者一覧 (語なし) では一番上に留める (試写の都合。本体の作法の直しは別に考える)
  const priorRestoreScroll = window.restoreScroll;
  window.restoreScroll = function homeRestoreScroll(anchor, fallback) {
    if (state.source === HOME && !String(state.query || '').trim()) { window.scrollTo(0, 0); return; }
    return priorRestoreScroll(anchor, fallback);
  };

  // 差し替えが済んだ: 本体の起動 (設定待ち) を先へ進めてよい
  if (typeof window.__bunkoHomePatched === 'function') window.__bunkoHomePatched();
})();
`;

// Home の見た目の足し分 (本体の変数と部品に乗せる。ここに無い物は本体の styles.css / bunko-ui.css のまま)
const HOME_CSS = `
body[data-home] #scope, body[data-home] #language, body[data-home] .tail-tools, body[data-home] #recents { visibility: hidden; }
body[data-home-author] #grid, body[data-home-author] #empty, body[data-home-author] #status { display: none !important; }
body[data-home-author] .filters .chips, body[data-home-author] #result-info { visibility: hidden; }
body[data-home] .chip-discover { display: none; }
.home-author .cover { position: relative; }
.home-new {
  position: absolute; left: 4px; top: 4px; z-index: 3;
  padding: 2px 7px; border-radius: 999px; font: 700 11px/1.15 var(--font); letter-spacing: .04em;
  background: var(--stamp); color: #fff;
}
/* 見出しの左下: 右上の頁数の印 (page-count-badge) と同じ帯に、サイトのアイコンを透かさずに並べる */
.home-sites {
  position: absolute; left: 4px; bottom: 4px; z-index: 3;
  display: inline-flex; align-items: center; gap: 4px; padding: 3px 5px; border-radius: 999px;
  background: rgba(0, 0, 0, .36); pointer-events: none;
}
.home-sites.is-inline { position: static; pointer-events: auto; }
.home-site { display: inline-grid; place-items: center; width: 12px; height: 12px; }
.home-site img { width: 12px; height: 12px; object-fit: contain; border-radius: 2px; display: block; }
.home-site svg { width: 12px; height: 12px; display: block; }
/* 作者の頁 */
#home-author-view { padding: 6px 0 48px; }
.home-av-head { display: flex; align-items: center; gap: 14px; margin: 2px 0 22px; }
.home-av-back { flex: none; }
.home-av-back svg { width: 20px; height: 20px; }
.home-av-face { width: 52px; height: 52px; border-radius: 50%; overflow: hidden; background: var(--shelf); flex: none; }
.home-av-face img { width: 100%; height: 100%; object-fit: cover; object-position: top center; display: block; }
.home-av-title { min-width: 0; }
.home-av-title h2 { margin: 0; font-size: 19px; font-weight: 600; color: var(--paper); }
.home-av-title p { margin: 5px 0 0; display: flex; align-items: center; gap: 12px; font-size: 12px; color: var(--dust); }
.home-av-status { min-width: 12em; color: var(--dust); }
.home-av-mode { margin-left: auto; flex: none; }
.home-av-mode button { min-width: 34px; cursor: pointer; }
/* 縦の年表の軸: 細い線と丸。今読んでいる位置まで線が水色に伸び、その位置の丸だけが水色 (発光はしない) */
.home-av-timeline { position: relative; padding-left: 46px; }
.home-av-timeline::before {
  content: ''; position: absolute; left: 21px; top: 12px; bottom: 0; width: 2px; border-radius: 1px; background: #2a2f36;
}
.home-av-progress {
  position: absolute; left: 21px; top: 12px; width: 2px; height: 0; border-radius: 1px; background: #7fd8dc; z-index: 1;
}
.home-av-group { position: relative; padding-bottom: 30px; }
.home-av-node {
  position: absolute; left: -31px; top: 5px; width: 14px; height: 14px; border-radius: 50%; z-index: 2;
  background: #3a4048; box-shadow: 0 0 0 4px var(--night);
  transition: background var(--t-base), transform var(--t-base);
}
.home-av-group.is-current .home-av-node { background: #7fd8dc; transform: scale(1.15); }
.home-av-group.is-unknown .home-av-node { background: var(--night); box-shadow: 0 0 0 2px #3a4048, 0 0 0 4px var(--night); }
.home-av-label { display: flex; align-items: baseline; gap: 10px; margin: 0 0 14px; font-size: 12px; font-weight: 500; color: var(--dust); }
.home-av-y { font: 600 16px/1.2 var(--mono); color: var(--paper); letter-spacing: .04em; transition: color var(--t-base); }
.home-av-group.is-current .home-av-y { color: #7fd8dc; }
.home-av-ev {
  display: inline-flex; gap: 4px; align-items: baseline; padding: 1px 8px; border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--stamp) 55%, transparent); font-size: 11px; color: var(--dust);
}
.home-av-ev b { font-family: var(--mono); color: var(--paper); font-weight: 600; }
.home-av-cards .card { position: relative; }
.home-book-q { position: absolute; left: 6px; top: 6px; z-index: 3; width: 16px; height: 16px; display: grid; place-items: center; }
.home-book-q svg { width: 16px; height: 16px; display: block; }
/* hitomi の未所持を後から並べる時の札 (並びを押しのけないよう、画面に重ねる) */
.home-av-pending {
  position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 40;
  padding: 8px 16px; border-radius: 999px; border: 1px solid var(--rule); cursor: pointer;
  background: var(--cabinet); color: var(--paper); font: 500 12px/1.2 var(--font); box-shadow: var(--shadow);
}
.home-av-pending:hover { border-color: #7fd8dc; }
/* 詳細の板: サイトの URL */
.home-links .row-value { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }
.home-url { color: var(--ink); text-decoration: none; font-size: 12px; word-break: break-all; }
.home-url:hover { text-decoration: underline; }
.home-url.is-candidate { color: var(--nail); }
.home-state { display: inline-block; padding: 0 7px; border-radius: 999px; font-size: 11px; color: var(--dust); border: 1px solid var(--rule); }
.home-state.is-candidate { color: var(--nail); border: 1px dashed color-mix(in srgb, var(--nail) 60%, transparent); }
.home-url-edit { display: flex; gap: 6px; width: 100%; }
.home-url-input {
  flex: 1; min-width: 0; padding: 4px 8px; border-radius: 6px; font-size: 12px;
  background: var(--shelf); border: 1px solid var(--rule); color: var(--paper);
}
.home-url-input:focus { outline: none; border-color: var(--ink); }
.home-link-act {
  padding: 2px 10px; border-radius: 999px; font-size: 11px; cursor: pointer;
  border: 1px solid var(--rule); background: none; color: var(--dust);
}
.home-link-act:hover { color: var(--paper); border-color: var(--dust); }
.home-url-error { width: 100%; font-size: 11px; color: var(--stamp); }
.home-face img { object-fit: cover; }
/* 伏せ (?veil=1): 絵は出さない。枠と段組みだけを見る (サイトのアイコンは中身ではないので出す) */
[data-veil] .card .cover > img, [data-veil] .detail-cover img, [data-veil] .pixiv-related-cover img, [data-veil] .home-av-face img { visibility: hidden; }
[data-veil] .card .cover, [data-veil] .detail-cover, [data-veil] .pixiv-related-cover, [data-veil] .home-av-face {
  background: repeating-linear-gradient(135deg, var(--shelf) 0 10px, var(--card) 10px 20px);
}
[data-veil] .pixiv-related-cover { min-height: 220px; }
`;

function indexHtml() {
  let html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
  html = html.replace('<script src="reader.js"></script>', [
    '<script src="/__lib/search-type.js"></script>',
    '<script src="/__lib/search-providers.js"></script>',
    '<script src="/__lib/search-intent.js"></script>',
    '<script src="/__home-shim.js"></script>',
    '<script src="reader.js"></script>',
  ].join('\n  '));
  html = html.replace('<script src="app.js"></script>', '<script src="app.js"></script>\n  <script src="/__home-patch.js"></script>');
  html = html.replace('</head>', '  <link rel="stylesheet" href="/__home.css" />\n</head>');
  return html;
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const json = (value) => send(res, 200, MIME['.json'], JSON.stringify(value));
  const body = () => new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
  if (p === '/' || p === '/index.html') { send(res, 200, MIME['.html'], indexHtml()); return; }
  if (p === '/__home-shim.js') { send(res, 200, MIME['.js'], SHIM); return; }
  if (p === '/__home-patch.js') { send(res, 200, MIME['.js'], PATCH); return; }
  if (p === '/__home.css') { send(res, 200, MIME['.css'], HOME_CSS); return; }
  if (p === '/__home.json') {
    home({ min: url.searchParams.get('min') })
      .then((data) => json({ generatedAt: data.generatedAt, live: data.live, counts: data.counts, authors: data.authors }))
      .catch((error) => { console.log('home build failed:', error.code || error.message); json({ authors: [] }); });
    return;
  }
  if (p === '/__home-books') {
    home({ min: url.searchParams.get('min') })
      .then((data) => json(data.booksById.get(String(url.searchParams.get('id') || '')) || []))
      .catch(() => json([]));
    return;
  }
  if (p === '/__home-hitomi') {
    hitomiWeb(url.searchParams.get('artist')).then(json).catch(() => json({ works: [], error: true }));
    return;
  }
  let m = p.match(/^\/__icon\/(pixiv|pawchive|hitomi|nhentai|dlsite|fanza|x)$/);
  if (m) {
    const icon = icons.get(m[1]);
    if (icon) {
      res.writeHead(200, { 'Content-Type': icon.type, 'Cache-Control': 'max-age=86400' });
      res.end(icon.bytes);
    } else {
      send(res, 200, MIME['.svg'], letterIcon(ICON_LETTERS[m[1]]));
    }
    return;
  }
  if (p === '/__port') {
    body().then((payload) => {
      try { json(portQuery(payload.query, payload.from, payload.to, payload.context || {})); } catch { json({ query: payload.query, dropped: [] }); }
    });
    return;
  }
  if (p === '/__context') {
    body().then((payload) => {
      try {
        json(searchAuthorContext(String(payload.query || ''), payload.from, {
          pixiv: {}, pawchive: {}, label: () => '', describe: aliases.describeTerm, creatorName: () => '',
          intent: payload.intent, selections: payload.selections, target: payload.to, resolve: vocabulary.resolve,
        }));
      } catch { json({}); }
    });
    return;
  }
  m = p.match(/^\/__lib\/([\w-]+)\.js$/);
  if (m) { file(res, path.join(ROOT, 'src', 'lib', m[1] + '.js')); return; }
  if (p === '/img') {
    const n = Number(String(url.searchParams.get('id') || '').replace(/\D/g, '')) || 0;
    send(res, 200, MIME['.svg'], coverSvg(n));
    return;
  }
  if (p === '/node_modules/pdfjs-dist/build/pdf.min.js') {
    file(res, path.join(ROOT, 'node_modules', 'pdfjs-dist', 'build', 'pdf.min.js'));
    return;
  }
  m = p.match(/^\/fonts\/([\w-]+\.woff2)$/);
  if (m) { file(res, path.join(RENDERER, 'fonts', m[1])); return; }
  m = p.match(/^\/([\w-]+\.(?:css|js))$/);
  if (m) { file(res, path.join(RENDERER, m[1])); return; }
  send(res, 404, 'text/plain', 'not found');
}).listen(PORT, '127.0.0.1', () => {
  console.log('home preview at http://127.0.0.1:' + PORT + '/  (images from ' + LIVE + ')');
  // 先に組んでおく (最初の表示で待たせない)
  home({ min: 3 }).catch(() => {});
  loadIcons().catch(() => {});
});
