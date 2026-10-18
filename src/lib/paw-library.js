const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('./config');
const pawLinks = require('./paw-links');
const { nfkc, hiraToKata } = require('./search-text');
// 全 .info の metadata 要約は台帳 (catalog) と共用の索引から引く (mtime.json の差分読み)
const eagleIndex = require('./eagle-index');
const stateFile = require('./state-file');
const localArchive = require('./local-archive');
// ID の判定・組み立てと星の丸めは sources/normalize (実体は sources/ids) に集約。
// isPawEagleId / eagleIdOf / safeEagleId / pawTriple は従来どおりここからも
// 再エクスポートする (使う側と特性テストの後方互換)
const {
  normalizeStar, isPawEagleId, eagleIdOf, safeEagleId, pawTriple,
  pawEagleGalleryId, pawFolderGalleryId,
} = require('./sources/normalize');

// pawchive の所持作品は Eagle ライブラリの「作者」フォルダ配下に居る。
// Eagle の HTTP API は使わない: catalog.scanEagle と同じくファイルを直に読む。
//
// アイテム名の規約: [YYYYMMDD] [postId] タイトル【17P】
// 日付・postId・頁数はどれも欠けることがある (実データで約 2 割は日付も ID も無い)。

const TTL = 5 * 60 * 1000;

// 【43P】は頁数だが【WIP】は違う。数字+P のときだけ頁数として取る
const PAGE_RE = /【\s*(\d+)\s*[PpＰｐ]\s*】/;
const DATE_RE = /^\s*\[(\d{8})\]/;
const POST_RE = /\[(\d{5,9})\]/;

// 画像かどうかの表は local-archive が原本。ここで書き写すと、同じ <id>.info を
// 見ているのに「頁としては絵、表紙としては絵でない」という食い違いが出る (項目 8-6)

// アイテムごとの前回結果。<eagleId>.info の mtime が同じなら metadata.json を読み直さない。
// 6700 件を毎回全部読むと USB SSD では数秒かかり、その間 main の IPC が止まる。
// 版 2: 項目に url を持つ (pixiv の本を見分ける)。版が違えば控えを捨てて読み直す
const CACHE_VERSION = 2;

// pixiv の本 (docs/pixiv-design-2026-09-19.md §8): 同一性は Eagle の url。
// 名前は題だけなので parseName ([日付] [投稿 ID]) は通さない
const PIXIV_URL = /pixiv\.net\/(?:en\/)?artworks\/(\d+)/i;

function pixivIdOf(url) {
  const hit = String(url || '').match(PIXIV_URL);
  return hit ? hit[1] : '';
}

let cache = null;
let entries = new Map();
let entriesRoot = null;
let entriesFolderId = null;
let entriesFolderStamp = 0;
let entriesLoaded = false;

function libraryRoot() {
  try {
    return String(config.load().eagleLibrary || '').trim();
  } catch {
    // Electron の外 (単体テスト・調査スクリプト) では設定を読めない
    return '';
  }
}

function rootFolderId() {
  try {
    return String(config.load().pawEagleFolder || '').trim();
  } catch {
    return '';
  }
}

// 「作者」フォルダとその子孫の id を集め、同時に「どの作者の配下か」を覚える。
// 作者 = 「作者」フォルダの直下の子。孫以下 (作品ごとの小分け) はその子に寄せる
function rootNode(root, folderId) {
  if (!root || !folderId) return null;
  let tree = null;
  try {
    tree = JSON.parse(fs.readFileSync(path.join(root, 'metadata.json'), 'utf8'));
  } catch {
    return null;
  }
  let node = null;
  const find = (folder) => {
    if (!folder || node) return;
    if (String(folder.id || '') === folderId) {
      node = folder;
      return;
    }
    for (const child of folder.children || []) find(child);
  };
  for (const folder of tree.folders || []) find(folder);
  return node;
}

function collectFolders(root, folderId) {
  const ids = new Set();
  const creators = new Map();
  // 孫フォルダも「どの作者フォルダの配下か」を覚える: 手動紐付けの候補は作者単位
  const owners = new Map();
  // フォルダの名前 (作者フォルダの中の小分けのフォルダの名前から、Home が公開の年月を読む)
  const names = new Map();
  const node = rootNode(root, folderId);
  if (!node) return { ids, creators, owners, names };

  ids.add(folderId);
  creators.set(folderId, '');
  owners.set(folderId, '');
  const walk = (folder, creator, owner) => {
    const id = String(folder?.id || '');
    if (!id) return;
    ids.add(id);
    creators.set(id, creator);
    owners.set(id, owner);
    names.set(id, String(folder?.name || ''));
    for (const child of folder.children || []) walk(child, creator, owner);
  };
  for (const child of node.children || []) {
    walk(child, String(child?.name || ''), String(child?.id || ''));
  }
  return { ids, creators, owners, names };
}

// 名前 → { date, postId, title, pageCount }
function parseName(raw) {
  let text = String(raw || '').trim();
  let date = null;
  let postId = null;
  let pageCount = null;

  const dateHit = text.match(DATE_RE);
  if (dateHit) {
    date = dateHit[1];
    text = text.slice(dateHit[0].length);
  }
  const postHit = text.match(POST_RE);
  // 日付が先頭に無いときの [20240430] を postId と取り違えない
  if (postHit && !/^20\d{6}$/.test(postHit[1])) {
    postId = postHit[1];
    text = `${text.slice(0, postHit.index)} ${text.slice(postHit.index + postHit[0].length)}`;
  }
  const pageHit = text.match(PAGE_RE);
  if (pageHit) {
    pageCount = Number(pageHit[1]);
    text = `${text.slice(0, pageHit.index)} ${text.slice(pageHit.index + pageHit[0].length)}`;
  }
  return {
    date,
    postId,
    pageCount,
    title: text.replace(/\s+/g, ' ').trim(),
  };
}

// 検索用の鍵: 全角/半角と ひら/カタ の差を吸収する
function matchKey(value) {
  return hiraToKata(nfkc(value)).toLowerCase();
}

function dirStamp(dir) {
  try {
    return fs.statSync(dir).mtimeMs;
  } catch {
    return 0;
  }
}

// フォルダ木 (ライブラリ直下の metadata.json)。作者の割り当てはここが変わると古くなる
function folderStamp(root) {
  return dirStamp(path.join(root, 'metadata.json'));
}

// Electron の外 (単体試験・調査スクリプト) では app が居ない: config.js と同じ組み方で当てる
function userDataDir() {
  try {
    return require('electron').app.getPath('userData');
  } catch {
    const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(roaming, 'hitomi-box');
  }
}

function cacheFile() {
  return path.join(userDataDir(), 'paw-library-cache.json');
}

// 台帳と共用の索引 (eagle-index) の控え。catalog.js と同じファイルを指す
function indexCacheFile() {
  return path.join(userDataDir(), 'eagle-scan-cache.json');
}

// ライブラリの差し替えの目印 (mtime.json の size:mtime)。snapshot が毎回引くので
// 数秒は覚えておく (SMB 越しの stat を検索のたびに繰り返さない)
let stampMemo = { root: '', at: 0, value: '' };

function libraryStamp(root) {
  const now = Date.now();
  if (stampMemo.root === root && now - stampMemo.at < 2000) return stampMemo.value;
  const value = eagleIndex.indexFor(root, indexCacheFile()).stampNow();
  stampMemo = { root, at: now, value };
  return value;
}

// 索引の要約から、この台帳が使う形 (shapeRaw と同じ) を組む
function rawFromIndex(entry) {
  if (!entry || !entry.meta) return null;
  const meta = entry.meta;
  return shapeRaw({ ...meta, modificationTime: meta.addedAt || 0 });
}

// metadata.json の必要なぶんだけ。folders も持つのは、フォルダ木が変わったときに
// ファイルを読み直さず作者の割り当てだけ作り直すため。対象外・削除済みは null (負の印)
function shapeRaw(meta) {
  if (!meta || meta.isDeleted) return null;
  return {
    folders: Array.isArray(meta.folders) ? meta.folders.map(String) : [],
    name: String(meta.name || ''),
    star: normalizeStar(meta.star),
    ext: String(meta.ext || ''),
    mtime: Number(meta.modificationTime || meta.btime || meta.lastModified || 0) || 0,
    url: String(meta.url || ''),
  };
}

function readRaw(dir) {
  try {
    return shapeRaw(JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8')));
  } catch {
    return null;
  }
}


function buildItem(eagleId, raw, ids, creators, owners, names = null) {
  const hit = raw.folders.find((id) => ids.has(id));
  if (hit === undefined) return null;
  const creator = creators.get(hit) || '';
  // 作者フォルダの中の小分けのフォルダに居る本は、その小分けの名前 (作者フォルダの直下なら '')
  const owner = owners.get(hit) || '';
  const folderName = names && owner && hit !== owner ? String(names.get(hit) || '') : '';
  // pixiv の本: 題は名前そのまま、投稿 ID は url。[12345678] を pawchive の投稿と
  // 取り違えないよう parseName の前で分ける (§15 E7)
  const pixivId = pixivIdOf(raw.url);
  if (pixivId) {
    return {
      eagleId,
      source: 'pixiv',
      pixivId,
      creator,
      creatorFolderId: owners.get(hit) || '',
      folderName,
      name: raw.name,
      title: raw.name,
      date: null,
      postId: null,
      pageCount: null,
      star: raw.star,
      ext: raw.ext,
      mtime: raw.mtime,
      key: matchKey(`${creator} ${raw.name}`),
    };
  }
  const parsed = parseName(raw.name);
  return {
    eagleId,
    creator,
    creatorFolderId: owners.get(hit) || '',
    folderName,
    name: raw.name,
    title: parsed.title || raw.name,
    date: parsed.date,
    postId: parsed.postId,
    pageCount: parsed.pageCount,
    star: raw.star,
    ext: raw.ext,
    mtime: raw.mtime,
    key: matchKey(`${creator} ${parsed.title || raw.name} ${parsed.postId || ''}`),
  };
}

function loadEntries(root) {
  if (entriesLoaded && entriesRoot === root) return;
  entries = new Map();
  entriesRoot = root;
  entriesFolderId = null;
  entriesFolderStamp = 0;
  entriesLoaded = true;
  let saved = null;
  try {
    saved = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
  } catch {
    // 初回起動・壊れたファイル。無ければ全部読み直すだけで困らない
    return;
  }
  if (!saved || saved.v !== CACHE_VERSION || saved.root !== root) return;
  for (const [eagleId, entry] of Object.entries(saved.entries || {})) {
    entries.set(eagleId, { m: Number(entry.m) || 0, r: entry.r || null });
  }
}

function saveEntries(root) {
  const rows = {};
  for (const [eagleId, entry] of entries) rows[eagleId] = { m: entry.m, r: entry.r };
  // 番人を通す: 原子的に書き、写しの機体では書かない (母艦が配る側の控え)
  stateFile.writeJson('paw-library', cacheFile(), { v: CACHE_VERSION, root, entries: rows });
}

// 走査の組み立て本体。mtimeOf / rawOf の差し替えで、同期 (初回) と
// 並列の裏引き直し (scanAsync) が同じ道を通る
function assemble(root, folderId, imagesDir, dirs, mtimeOf, rawOf) {
  const empty = { root, folderId, items: [], byPostId: new Map(), stamp: 0, at: Date.now() };
  const { ids, creators, owners, names } = collectFolders(root, folderId);
  if (!ids.size) return empty;

  loadEntries(root);
  const stamp = folderStamp(root);
  const rebuild = entriesFolderId !== folderId || entriesFolderStamp !== stamp;
  let changed = false;

  const items = [];
  const alive = new Set();
  for (const dir of dirs) {
    const eagleId = dir.name.replace(/\.info$/i, '');
    alive.add(eagleId);
    const mtime = mtimeOf(dir.name);
    let entry = entries.get(eagleId);
    if (!entry || entry.m !== mtime) {
      entry = { m: mtime, r: rawOf(dir.name) };
      entries.set(eagleId, entry);
      changed = true;
    }
    if (!entry.r) continue;
    if (rebuild || entry.item === undefined) entry.item = buildItem(eagleId, entry.r, ids, creators, owners, names);
    if (entry.item) items.push(entry.item);
  }
  for (const eagleId of entries.keys()) {
    if (alive.has(eagleId)) continue;
    entries.delete(eagleId);
    changed = true;
  }
  entriesFolderId = folderId;
  entriesFolderStamp = stamp;
  if (changed) saveEntries(root);

  // postId → アイテム。同じ投稿が複数入っていること (分割保存・別版) はあるので、
  // 星の高いほうを代表にする: 済 の脇に出る ★ を低いほうに引っ張られないため
  const byPostId = new Map();
  for (const item of items) {
    if (!item.postId) continue;
    const current = byPostId.get(item.postId);
    if (!current || item.star > current.star) byPostId.set(item.postId, item);
  }

  return { root, folderId, items, byPostId, stamp: libraryStamp(root), at: Date.now() };
}

function scan() {
  const root = libraryRoot();
  const folderId = rootFolderId();
  const imagesDir = path.join(root, 'images');
  const empty = { root, folderId, items: [], byPostId: new Map(), stamp: 0, at: Date.now() };
  if (!root || !folderId || !fs.existsSync(imagesDir)) return empty;

  let dirs = [];
  try {
    dirs = fs.readdirSync(imagesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.endsWith('.info'));
  } catch {
    return empty;
  }

  return assemble(
    root, folderId, imagesDir, dirs,
    // .info フォルダではなく metadata.json 自体の mtime を見る: NTFS では中身の
    // 上書きで親フォルダの mtime が動かず、Eagle のフォルダ移動や星付けを取り逃がす
    (name) => dirStamp(path.join(imagesDir, name, 'metadata.json')),
    (name) => readRaw(path.join(imagesDir, name)),
  );
}

// 裏の引き直し。全 .info の一覧と要約は台帳と共用の索引 (eagle-index) から引くので、
// ここでは stat をしない (以前は 32 件ずつ並列 stat で、ネットワーク越しに 2 秒かかっていた)
async function scanAsync() {
  const root = libraryRoot();
  const folderId = rootFolderId();
  const imagesDir = path.join(root, 'images');
  const empty = { root, folderId, items: [], byPostId: new Map(), stamp: 0, at: Date.now() };
  if (!root || !folderId) return empty;

  // 設定済みのライブラリがオフライン/権限不足/破損なら「0冊」と確定しない。
  // 作者フォルダが設定から消えただけなら、metadata 自体は読めるので正しい空棚になる。
  await fs.promises.access(imagesDir, fs.constants.R_OK);
  const rootMetadata = await fs.promises.readFile(path.join(root, 'metadata.json'), 'utf8');
  JSON.parse(rootMetadata);

  // アイテムの一覧と metadata の要約は台帳と共用の索引 (eagle-index) から引く。
  // 以前はここでも全 .info を stat していた (母艦の SMB で 2 秒)。索引は mtime.json の
  // 差分で更新するので、変わっていなければファイルを一つも開かない。
  // 台帳の走査と重なったときは同じ一本の読みを待つ (索引が束ねる)
  const index = eagleIndex.indexFor(root, indexCacheFile());
  const { entries: indexed } = await index.refresh();
  const dirs = [...indexed.keys()].map((name) => ({ name }));

  loadEntries(root); // 先に控えを読み、mtime の変わったアイテムだけ組み直す
  return assemble(
    root, folderId, imagesDir, dirs,
    (name) => (indexed.get(name) || {}).mtimeMs || 0,
    (name) => rawFromIndex(indexed.get(name)),
  );
}

// 裏の引き直しは一本だけ。終わったら写しを差し替える (失敗時は前の写しのまま)
let revalidating = null;
let revalidationError = null;

function revalidateSoon() {
  if (revalidating) return revalidating;
  revalidating = scanAsync()
    .then((next) => { cache = next; revalidationError = null; })
    .catch((error) => { revalidationError = error; /* 前の写しを使い続ける */ })
    .finally(() => { revalidating = null; });
  return revalidating;
}

function snapshot() {
  const root = libraryRoot();
  const folderId = rootFolderId();
  if (cache && cache.root === root && cache.folderId === folderId) {
    const fresh = Date.now() - cache.at < TTL
      && cache.stamp === libraryStamp(root);
    if (fresh) return cache;
    // 古びた写しでも即返し、引き直しは裏で並列に行う。TTL ぶんの古さは元より
    // 許している設計なので、新着が一巡 (引き直し完了) ぶん遅れて載るだけで、
    // その間 main が止まらないことの方が体感に効く
    revalidateSoon();
    return cache;
  }
  revalidateSoon();
  throw new Error('Paw library is not ready');
}

// 起動時の温め: 初回 (写しが無い状態) でも main を止めずに裏で組む
function warm() {
  if (cache) {
    snapshot(); // 鮮度確認だけ。古ければ裏の引き直しが立つ
    return revalidating || Promise.resolve();
  }
  return revalidateSoon();
}

// 初回だけ共有 Promise を待つ。失敗時は空棚を確定せず呼出元へ失敗を返す。
async function ready() {
  const root = libraryRoot();
  const folderId = rootFolderId();
  if (cache && cache.root === root && cache.folderId === folderId) return cache;
  await revalidateSoon();
  if (cache && cache.root === root && cache.folderId === folderId) return cache;
  if (revalidationError) throw revalidationError;
  throw new Error('Paw library is not ready');
}

// リーダーで付けた★をその場でキャッシュに写す。Eagle は metadata.json を
// 書き換えるが images ディレクトリの mtime は動かないため、TTL が切れるまで
// 走査が古い星を返し続け、付けたはずの★が画面で巻き戻って見える
function noteStar(eagleId, star) {
  const id = String(eagleId || '');
  if (!id) return;
  const value = normalizeStar(star);
  const entry = entries.get(id);
  if (entry) {
    if (entry.r) entry.r.star = value;
    if (entry.item) entry.item.star = value;
    // entry.m (metadata.json の mtime) はそのまま残す。Eagle は★を API で
    // 受けてもディスクへの書き出しを遅らせるので、ここで読み直しを促すと
    // 「まだ古い metadata」を読んで★が巻き戻る。mtime を据え置けば、
    // Eagle が実際に書き出す (mtime が動く) まで写した★が保たれ、
    // 書き出された後は同じ値を読み直すだけになる
    if (entriesRoot) saveEntries(entriesRoot);
  }
  if (cache) {
    let touched = false;
    for (const item of cache.items) {
      if (item.eagleId === id) {
        item.star = value;
        touched = true;
      }
    }
    if (touched) {
      // 「星の高いほうを代表」の索引も作り直す (下げにも対応するため)
      const byPostId = new Map();
      for (const item of cache.items) {
        if (!item.postId) continue;
        const current = byPostId.get(item.postId);
        if (!current || item.star > current.star) byPostId.set(item.postId, item);
      }
      cache.byPostId = byPostId;
    }
  }
}

// ゴミ箱送りに合わせて走査キャッシュから下ろす。次の走査は isDeleted を見て
// 拾わないが、TTL が切れるまで古い 済 が画面に残るのでその場で消す
function dropItem(eagleId) {
  const id = String(eagleId || '');
  if (!id) return;
  if (entries.has(id)) {
    // mtime の控えごと捨てる: 次の走査が metadata.json を読み直して isDeleted に気付く
    entries.delete(id);
    if (entriesRoot) saveEntries(entriesRoot);
  }
  if (cache) {
    const before = cache.items.length;
    cache.items = cache.items.filter((item) => item.eagleId !== id);
    if (cache.items.length !== before) {
      const byPostId = new Map();
      for (const item of cache.items) {
        if (!item.postId) continue;
        const current = byPostId.get(item.postId);
        if (!current || item.star > current.star) byPostId.set(item.postId, item);
      }
      cache.byPostId = byPostId;
    }
  }
}

// 同じ投稿の別アイテム (分割保存・別版)。byPostId が「星の高いほうを代表」に
// するため、下げるときは姉妹にも同じ星を書かないと代表値が巻き戻る
function eagleSiblings(eagleId) {
  const id = String(eagleId || '');
  if (!id) return [];
  const items = snapshot().items;
  const me = items.find((item) => item.eagleId === id);
  if (!me || !me.postId) return [];
  return items
    .filter((item) => item.postId === me.postId && item.eagleId !== id)
    .map((item) => item.eagleId);
}

function refresh() {
  cache = null;
  // アイテムごとの前回結果も捨てる。ただし次の走査で保存ぶんを読み直すので、
  // 変わっていないアイテムまで metadata.json を読み直すことにはならない
  entries = new Map();
  entriesLoaded = false;
  return ready();
}

// YYYYMMDD → YYYY-MM-DD (カードの公開日表示に合わせる)
function isoDate(value) {
  if (!value || value.length !== 8) return null;
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function toGallery(item) {
  // pixiv の本は網と同じ顔 (px:<投稿 ID>) で出す: 詳細・保存・作者が一つの道になる
  if (item.source === 'pixiv' && item.pixivId) {
    return {
      id: `px:${item.pixivId}`,
      source: 'pixiv',
      sourceId: item.eagleId,
      title: item.title,
      type: '',
      language: null,
      artists: item.creator ? [{ type: 'artist', name: item.creator }] : [],
      groups: [],
      series: [],
      characters: [],
      tags: [],
      pageCount: 0,
      badge: '',
      addedDate: item.mtime ? new Date(item.mtime).toISOString() : null,
      publishedDate: null,
      isBlocked: false,
      hasVideo: false,
      url: `https://www.pixiv.net/artworks/${item.pixivId}`,
      offline: true,
      owned: true,
      kind: 'eagleItem',
      eagleId: item.eagleId,
      postId: null,
      star: item.star,
    };
  }
  return {
    id: pawEagleGalleryId(item.eagleId),
    source: 'pawchive',
    sourceId: item.eagleId,
    title: item.title,
    type: '',
    language: null,
    artists: item.creator ? [{ type: 'artist', name: item.creator }] : [],
    groups: [],
    series: [],
    characters: [],
    tags: [],
    // 名前の【17P】から分かるぶん。分からなければ 0 のまま出す
    // (読むときは PDF の頁数が本当の数になる)
    pageCount: item.pageCount || 0,
    badge: item.pageCount ? `${item.pageCount}p` : '',
    addedDate: null,
    publishedDate: isoDate(item.date),
    isBlocked: false,
    hasVideo: false,
    url: '',
    offline: true,
    owned: true,
    kind: 'eagleItem',
    eagleId: item.eagleId,
    postId: item.postId,
    star: item.star,
  };
}

const SORTS = {
  added(a, b) {
    // 日付の無いものは後ろへ。同着は Eagle の更新時刻で新しい順
    if (a.date !== b.date) {
      if (!a.date) return 1;
      if (!b.date) return -1;
      return a.date < b.date ? 1 : -1;
    }
    return b.mtime - a.mtime;
  },
  title(a, b) {
    return String(a.title).localeCompare(String(b.title), 'ja');
  },
};

// 栞 (reading.json) 由来の並び。SORTS と違って本の外の値を見るので、
// 呼び手が渡した要約 (reading-store の summary。鍵は机上の pweagle:<eagleId>) を
// 束ねた比較器を作って返す。知らない並びなら null で、呼び手が SORTS に落とす。
// catalog 側の libraryComparator と同じ考え方 (回数 → 最終読了 → 最終更新)
function readingComparator(sort, marks) {
  if (sort !== 'reread' && sort !== 'finished') return null;
  const table = marks && typeof marks === 'object' ? marks : {};
  const mark = (item) => table[pawEagleGalleryId(item.eagleId)] || null;
  const count = (item) => Number(mark(item) && mark(item).finishedCount) || 0;
  const finishedAt = (item) => Number(mark(item) && mark(item).finishedAt) || 0;
  const updatedAt = (item) => Number(mark(item) && mark(item).updatedAt) || 0;
  // 回数を積み始めたばかりで全部 0 のうちは、実質「最後に開いた順」に落ちる。
  // そこも同着なら従来どおりの新着順で整える
  const rest = (a, b) => updatedAt(b) - updatedAt(a) || SORTS.added(a, b);
  if (sort === 'finished') {
    // 読み終えていない本は 0 なので自然に末尾へ落ちる
    return (a, b) => finishedAt(b) - finishedAt(a) || count(b) - count(a) || rest(a, b);
  }
  return (a, b) => count(b) - count(a) || finishedAt(b) - finishedAt(a) || rest(a, b);
}

// 作者フォルダごとの一番新しいアイテム。作者札の表紙と「新着」の並びが同じものを見る
function newestByFolder() {
  const best = new Map();
  for (const item of snapshot().items) {
    if (!item.creatorFolderId) continue;
    const current = best.get(item.creatorFolderId);
    if (!current || SORTS.added(item, current) < 0) best.set(item.creatorFolderId, item);
  }
  return best;
}

// 作者フォルダごとの新しい順の頭 limit 冊 (並びは newestByFolder と同じ SORTS.added)。
// 作者札の扇が見る: 一冊目が正面 (/pwlibf/ の表紙)、二冊目と三冊目が後ろの二枚
function recentByFolder(limit = 3) {
  const top = new Map();
  for (const item of snapshot().items) {
    if (!item.creatorFolderId) continue;
    let list = top.get(item.creatorFolderId);
    if (!list) top.set(item.creatorFolderId, list = []);
    let at = list.length;
    while (at > 0 && SORTS.added(item, list[at - 1]) < 0) at -= 1;
    if (at >= limit) continue;
    list.splice(at, 0, item);
    if (list.length > limit) list.pop();
  }
  return top;
}

// フォルダ → "service:user"。手動紐付けの逆引きで、作者札を web と同じ語で開けるようにする
function reverseCreatorLinks() {
  const map = new Map();
  try {
    for (const [key, folderId] of Object.entries(pawLinks.all().creators)) {
      if (!map.has(folderId)) map.set(folderId, key);
    }
  } catch {
    // 台帳が読めなくても folder: の語で開ける
  }
  return map;
}

// web の作者札と同じ形。描画側を分けずに済ませるため kind も 'creator' にする
function folderCard(folder, links, recent) {
  const linked = links.get(folder.folderId) || '';
  const cut = linked.indexOf(':');
  return {
    id: pawFolderGalleryId(folder.folderId),
    source: 'pawchive',
    sourceId: folder.folderId,
    title: folder.name,
    type: '',
    language: null,
    artists: folder.name ? [{ type: 'artist', name: folder.name }] : [],
    groups: [],
    series: [],
    characters: [],
    tags: [],
    pageCount: 0,
    badge: `${folder.itemCount}件`,
    addedDate: null,
    publishedDate: null,
    isBlocked: false,
    hasVideo: false,
    url: '',
    offline: true,
    owned: true,
    kind: 'creator',
    // 扇の後ろの二枚 (二冊目と三冊目)。正面はこの札の表紙 (/pwlibf/ = 一冊目)
    fan: (recent.get(folder.folderId) || []).slice(1, 3).map((item) => pawEagleGalleryId(item.eagleId)),
    // 開く先の語。紐付けが決まっていれば service/user にして、web に切り替えても同じ語で通る
    query: cut > 0 ? `${linked.slice(0, cut)}/${linked.slice(cut + 1)}` : `folder:${folder.folderId}`,
  };
}

// 語が無いときの一覧 = 作者フォルダ。星の下限はアイテムの印なので札には効かせない
function creatorResult(payload, size, index) {
  const links = reverseCreatorLinks();
  const recent = recentByFolder(3);
  const byName = (a, b) => String(a.name).localeCompare(String(b.name), 'ja');
  const rows = creatorFolders().slice();
  if (payload.sort === 'title') rows.sort(byName);
  else {
    rows.sort((a, b) => {
      const x = recent.get(a.folderId)?.[0];
      const y = recent.get(b.folderId)?.[0];
      // 中身の無いフォルダは後ろへ。あとはその作者の一番新しい作品どうしで比べる
      if (!x || !y) return x ? -1 : (y ? 1 : byName(a, b));
      return SORTS.added(x, y);
    });
  }
  return {
    total: rows.length,
    page: index,
    pageSize: size,
    query: '',
    interpreted: [],
    source: 'library',
    galleries: rows.slice(index * size, index * size + size).map((folder) => folderCard(folder, links, recent)),
  };
}

// 作者フォルダを開く語。folder: は所持作品側だけの言い方、service/user は web と共通
const FOLDER_RE = /^folder:([A-Za-z0-9_-]+)$/;
const CREATOR_RE = /^(\w+)\/([^/\s]+)/;

// web 側の投稿 ID から作者フォルダを当てる。表示名は Eagle のフォルダ名と食い違うことが
// 多い (API は "rokuichi-61"、手元は「灯工房」) ので、名前推測が外れたときの最後の手。
// 数件が別の作者のフォルダに紛れていることはあるので、多数決で決める
function probeCreatorFolder(service, user, postIds) {
  if (!Array.isArray(postIds) || !postIds.length) return null;
  const snap = snapshot();
  const votes = new Map();
  for (const raw of postIds) {
    const postId = String(raw == null ? '' : raw).trim();
    if (!postId) continue;
    let item = snap.byPostId.get(postId);
    if (!item) {
      // 名前に [postId] を持たない作品は手動の鎖でしか辿れない
      let eagleId = null;
      try {
        eagleId = pawLinks.getPost(service, user, postId);
      } catch {
        // 台帳が読めないだけ: 自動照合ぶんで決める
      }
      if (eagleId) item = findByEagleId(eagleId);
    }
    if (!item || !item.creatorFolderId) continue;
    votes.set(item.creatorFolderId, (votes.get(item.creatorFolderId) || 0) + 1);
  }
  let best = null;
  // 同数なら先に出たほう (Map は入れた順) を採る: 選び直す根拠が無い
  for (const [folderId, count] of votes) {
    if (!best || count > best.count) best = { folderId, count };
  }
  return best ? best.folderId : null;
}

function search(payload = {}) {
  // pageSizeMax: 起動時の復元や走査後の引き直しが「今の頁数ぶん」を一度に取るときの上限
  const cap = Math.max(60, Number(payload.pageSizeMax) || 0);
  const size = Math.max(1, Math.min(cap, Number(payload.pageSize) || 24));
  const index = Math.max(0, Number(payload.page) || 0);
  const query = String(payload.query || '').trim();
  const minStar = normalizeStar(payload.minStar);
  const empty = {
    total: 0, page: index, pageSize: size, query, interpreted: [], source: 'library', galleries: [],
  };

  if (!query) return creatorResult(payload, size, index);

  // 作者を絞り込んでいるとき (web から並べ替えずに移ってきたとき) は、そのフォルダの中身を出す。
  // 語で探すのと混ぜると "fanbox/2043" が題に当たらず 0 件になる
  let folderId = '';
  const folderHit = query.match(FOLDER_RE);
  if (folderHit) folderId = folderHit[1];
  else {
    const creatorHit = query.match(CREATOR_RE);
    if (creatorHit) {
      // 後ろの "tag:..." は所持作品側に当てる先が無い: 作者だけ見て落とす
      const [, service, user] = creatorHit;
      // 手動紐付け → 名前推測 → 投稿 ID の照合、の順に落ちる
      folderId = resolveCreatorFolder(service, user, payload.creatorName || '').folderId
        || probeCreatorFolder(service, user, payload.creatorPostIds)
        || '';
      // フォルダが決まらない作者は、この語では出しようがない (推測を広げると別人が出る)
      if (!folderId) return empty;
    }
  }

  const tokens = folderId
    ? []
    : query.split(/\s+/).map((token) => matchKey(token)).filter(Boolean);

  let rows = snapshot().items;
  if (folderId) rows = rows.filter((item) => item.creatorFolderId === folderId);
  if (minStar > 0) rows = rows.filter((item) => item.star >= minStar);
  if (tokens.length) {
    rows = rows.filter((item) => tokens.every((token) => item.key.includes(token)));
  }

  rows = rows.slice().sort(
    readingComparator(payload.sort, payload.reading) || SORTS[payload.sort] || SORTS.added,
  );

  return {
    total: rows.length,
    page: index,
    pageSize: size,
    query,
    interpreted: [],
    source: 'library',
    galleries: rows.slice(index * size, index * size + size).map(toGallery),
  };
}

// 投稿 ID から所持を引く。web の検索結果に 済 を出すための口で、
// 走査の使い回し・無効化は search と同じ (snapshot がキャッシュを見る)
function findByPostId(postId) {
  const key = String(postId == null ? '' : postId).trim();
  if (!key) return null;
  const item = snapshot().byPostId.get(key);
  return item ? { eagleId: item.eagleId, star: item.star, creator: item.creator } : null;
}

function findByEagleId(eagleId) {
  const id = String(eagleId || '');
  if (!id) return null;
  return snapshot().items.find((item) => item.eagleId === id) || null;
}

// 「作者」フォルダの直下 = 作者ひとり。手動の対応付けはこの単位で決める
function creatorFolders() {
  const root = libraryRoot();
  const node = rootNode(root, rootFolderId());
  if (!node) return [];
  const counts = new Map();
  for (const item of snapshot().items) {
    if (!item.creatorFolderId) continue;
    counts.set(item.creatorFolderId, (counts.get(item.creatorFolderId) || 0) + 1);
  }
  return (node.children || [])
    .map((child) => ({
      folderId: String(child?.id || ''),
      name: String(child?.name || ''),
      itemCount: counts.get(String(child?.id || '')) || 0,
    }))
    .filter((folder) => folder.folderId)
    .sort((a, b) => a.name.localeCompare(b.name, 'ja'));
}

function itemRow(item, linked) {
  return {
    eagleId: item.eagleId,
    name: item.name,
    title: item.title,
    star: item.star,
    date: item.date,
    postId: item.postId || null,
    hasPostId: Boolean(item.postId),
    creator: item.creator,
    folderId: item.creatorFolderId,
    // 済 の札を二重に付けないため: 自動で当たっている / 手で紐付け済み
    linked: Boolean(item.postId) || linked.has(item.eagleId),
  };
}

// 名前の降順 = [YYYYMMDD] 始まりなので実質「新しい順」
function byNameDesc(a, b) {
  return String(b.name).localeCompare(String(a.name), 'ja');
}

// 候補の並べ方。hitomi の鎖と同じく「打った語で探す」のが主で、
// そのうえで縁のある作者フォルダのものを上に寄せる。
// 別の作者のフォルダに紛れ込んだ作品も、当たれば下に出す (取りこぼさない)
function candidateItems(options = {}) {
  const folderId = String(options.folderId || '');
  const limit = Math.max(1, Math.min(200, Number(options.limit) || 60));
  const raw = String(options.query || '').trim();
  const linked = pawLinks.linkedEagleIds();
  const rows = snapshot().items;

  // 語が無いうちは、その作者フォルダの中身 (無ければ全体) を新しい順に。
  // まだ紐付いていないものが上: 選ぶ先はたいていそちら
  if (!raw) {
    const base = folderId ? rows.filter((item) => item.creatorFolderId === folderId) : rows;
    const list = base.map((item) => itemRow(item, linked)).sort(byNameDesc);
    return [...list.filter((row) => !row.linked), ...list.filter((row) => row.linked)].slice(0, limit);
  }

  const key = matchKey(raw);
  const tokens = raw.split(/\s+/).map((token) => matchKey(token)).filter(Boolean);
  const hits = [];
  for (const item of rows) {
    if (!tokens.every((token) => item.key.includes(token))) continue;
    // 語がそのまま題の頭に来るものが一番よく当たっている。
    // 続けて出るもの、語がばらばらに当たるだけのもの、の順に落とす
    const title = matchKey(item.title || item.name);
    let score = 1;
    if (title.startsWith(key)) score = 3;
    else if (title.includes(key)) score = 2;
    hits.push({
      item,
      score,
      same: folderId && item.creatorFolderId === folderId ? 1 : 0,
    });
  }
  hits.sort((a, b) => (b.same - a.same) || (b.score - a.score) || byNameDesc(a.item, b.item));
  return hits.slice(0, limit).map((hit) => itemRow(hit.item, linked));
}

// 作者名からフォルダを当てる。手動の対応付けが無いときの推測でしかない:
// 完全一致 → 片方がもう片方を含む、の順で見て、曖昧なら諦める
function guessCreatorFolder(name) {
  const key = matchKey(String(name || '').trim());
  if (!key) return null;
  const folders = creatorFolders();
  const exact = folders.find((folder) => matchKey(folder.name) === key);
  if (exact) return exact.folderId;
  const partial = folders.filter((folder) => {
    const folderKey = matchKey(folder.name);
    return folderKey && (folderKey.includes(key) || key.includes(folderKey));
  });
  return partial.length === 1 ? partial[0].folderId : null;
}

// 作者 → フォルダ。手動の対応付けが勝ち、無ければ名前で推測する
function resolveCreatorFolder(service, user, name) {
  const manual = pawLinks.getCreator(service, user);
  if (manual) {
    const folder = creatorFolders().find((row) => row.folderId === manual);
    return { folderId: manual, name: folder ? folder.name : '', origin: 'manual' };
  }
  const guess = guessCreatorFolder(name);
  if (!guess) return { folderId: null, name: '', origin: null };
  const folder = creatorFolders().find((row) => row.folderId === guess);
  return { folderId: guess, name: folder ? folder.name : '', origin: 'guess' };
}

// 検索結果 1 件に所持の印を付ける。Map 1 回引くだけ。
// 走査結果は sources のキャッシュより外側で当てる: 古い 済 を焼き付けないため
function annotate(gallery) {
  if (!gallery || gallery.error || gallery.source !== 'pawchive') return gallery;
  if (gallery.kind === 'eagleItem') return gallery;
  const triple = pawTriple(gallery.id);
  if (!triple) return gallery;
  let hit = null;
  let manual = null;
  try {
    // 手で決めた紐付けが先。名前に [postId] が無い作品はこれでしか所持に落ちない
    const eagleId = pawLinks.getPost(triple.service, triple.user, triple.postId);
    if (eagleId) {
      const item = findByEagleId(eagleId);
      manual = eagleId;
      hit = { eagleId, star: item ? item.star : 0, creator: item ? item.creator : '' };
    } else {
      hit = findByPostId(triple.postId);
    }
  } catch {
    // ライブラリが読めないときは web の結果をそのまま出す
  }
  if (!hit) return gallery;
  const marked = { ...gallery, owned: true, eagleId: hit.eagleId, star: hit.star };
  // 手動の紐付けだけ解除できる: hitomi の台帳と同じく linkedEagleId で言う
  if (manual) marked.linkedEagleId = manual;
  return marked;
}

function annotateAll(galleries) {
  return (galleries || []).map((gallery) => annotate(gallery));
}

function getGallery(id) {
  const eagleId = eagleIdOf(id);
  if (!eagleId) return null;
  const item = snapshot().items.find((row) => row.eagleId === eagleId);
  return item ? toGallery(item) : null;
}

// サムネイルの実体。Eagle は <名前>_thumbnail.png を原本の隣に置く。
// 無ければ原本 (画像のときだけ) に落とす。pdf/mp4 はサムネイルしか出せない
function thumbnailPath(eagleId) {
  const id = safeEagleId(eagleId);
  const root = libraryRoot();
  if (!id || !root) return null;
  const dir = path.join(root, 'images', `${id}.info`);
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const thumb = files.find((file) => /_thumbnail\.(png|jpg|jpeg|webp)$/i.test(file));
  if (thumb) return path.join(dir, thumb);
  const original = files.find((file) => localArchive.isImageName(file));
  return original ? path.join(dir, original) : null;
}

// 作者フォルダの表紙 = その中で一番新しいアイテムのサムネイル。
// Eagle のフォルダ id はアイテム id と同じ字種なので、経路の検めも同じもので足りる
function folderCoverPath(folderId) {
  const id = safeEagleId(folderId);
  if (!id) return null;
  const item = newestByFolder().get(id);
  return item ? thumbnailPath(item.eagleId) : null;
}

// アイテムの入れ物 (<root>/images/<id>.info)。中を覗かずに道だけ組む
// (中身の見分けは local-content の resolveContent が一手に引き受ける)
function itemFolder(eagleId) {
  const id = safeEagleId(eagleId);
  const root = libraryRoot();
  if (!id || !root) return null;
  return path.join(root, 'images', `${id}.info`);
}

// 作品 ID から実体の入れ物を引く。二つの形を受ける:
//   pweagle:<eagleId>              棚に出している Eagle アイテムそのもの
//   pw:<service>:<user>:<postId>   網から開いた投稿。所持していれば実体は Eagle の中
// 後者を結ばないと、**持っているのに網へ取りに行って「読めません」になる**
// (以前は renderer の pdf.js が eagleId で別経路へ逃がしていたので露見しなかった)
function folderForGalleryId(id) {
  const raw = String(id || '');
  if (isPawEagleId(raw)) return itemFolder(eagleIdOf(raw));
  const triple = pawTriple(raw);
  if (!triple) return null;
  let hit = null;
  try {
    hit = findByPostId(triple.postId);
  } catch {
    hit = null;                 // 所持庫がまだ読めていない: 呼び手が網へ回す
  }
  return hit && hit.eagleId ? itemFolder(hit.eagleId) : null;
}

// 原本の実体。Eagle は <名前>.<ext> を .info の中に置き、隣に _thumbnail を作る。
// pawchive の所持作品は 1 投稿 = 1 PDF なので、これがそのまま読み物になる
function originalPath(eagleId) {
  const id = safeEagleId(eagleId);
  const root = libraryRoot();
  if (!id || !root) return null;
  const dir = path.join(root, 'images', `${id}.info`);
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const candidates = files.filter((file) => {
    if (/^metadata\.json$/i.test(file)) return false;
    if (/_thumbnail\.[^.]+$/i.test(file)) return false;
    return Boolean(path.extname(file));
  });
  if (!candidates.length) return null;
  // pdf を最優先。混ざり物 (画像・動画) しか無ければ先頭を返す
  const pdf = candidates.find((file) => path.extname(file).toLowerCase() === '.pdf');
  return path.join(dir, pdf || candidates[0]);
}

module.exports = {
  search,
  getGallery,
  findByPostId,
  findByEagleId,
  noteStar,
  dropItem,
  eagleSiblings,
  pawTriple,
  creatorFolders,
  candidateItems,
  guessCreatorFolder,
  resolveCreatorFolder,
  annotate,
  annotateAll,
  refresh,
  snapshot,
  warm,
  ready,
  parseName,
  thumbnailPath,
  folderCoverPath,
  recentByFolder,
  originalPath,
  itemFolder,
  folderForGalleryId,
  safeEagleId,
  isPawEagleId,
  eagleIdOf,
  collectFolders,
  // 試験用 (pixiv の本の見分け)
  buildItem,
  toGallery,
  shapeRaw,
  pixivIdOf,
};
