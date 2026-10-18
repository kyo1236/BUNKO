const crypto = require('crypto');
const hitomi = require('./hitomi');
const nhentai = require('./nhentai');
const ehentai = require('./ehentai');
const pawchive = require('./pawchive');
const pixiv = require('./pixiv');
const { detectInput, parseId } = require('./normalize');
const { isPawEagleId, isPawFolderId } = require('./ids');
const { rewriteQuery, suggestAliases } = require('../search-aliases');
const cache = require('../media-cache');
const localArchive = require('../local-archive');

let catalogRef = null;
// 所持作品の表紙・頁を手元から出す口 (main が差し込む)。無ければ原本の画像だけを見る
let localContentRef = null;
const searchInflight = new Map();
const galleryInflight = new Map();

function setCatalog(catalog) {
  catalogRef = catalog;
}

// main が実装を差し込む: { fetch(localPath, index, size) → {bytes,type,name} | null }。
// Eagle のサムネイル (表紙) と原本 (画像/zip はそのまま、PDF は焼く) を知っているのは
// main 側 (焼き場 = 隠しウィンドウ) なので、sources は口だけ持つ
function setLocalContent(provider) {
  localContentRef = provider;
}

// 並びは URL の判定順と外部ブラウザの許可一覧の順を兼ねる
const adapters = { hitomi, nhentai, ehentai, pawchive, pixiv };

// 外部ブラウザで開いて良い先。main 側の判定をここ一本に寄せるための口
function allowedHosts() {
  const seen = new Set();
  for (const adapter of Object.values(adapters)) {
    for (const host of adapter.hosts || []) seen.add(host);
  }
  return [...seen];
}

function searchKey(payload, source, query) {
  return crypto.createHash('sha1').update(JSON.stringify({
    version: source === 'pixiv' ? 5 : 2,
    source,
    query,
    authorNames: Array.isArray(payload.authorNames) ? payload.authorNames.slice(0,3) : [],
    sort: payload.sort || '',
    pixivPeriod: source === 'pixiv' ? payload.pixivPeriod || '' : '',
    sortDir: payload.sortDir || 'desc',
    language: payload.language || '',
    type: payload.type || '',
    excludeTypes: [...(payload.excludeTypes || [])].sort(),
    page: payload.page || 0,
    pageSize: payload.pageSize || 24,
  })).digest('hex');
}

async function waitFor(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) throw signal.reason || new Error('aborted');
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason || new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([promise, aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

async function search(payload = {}, { signal } = {}) {
  if (signal?.aborted) throw signal.reason || new Error('aborted');
  const detected = detectInput(payload.query);
  const source = detected?.source || payload.source || 'hitomi';
  const incoming = detected ? detected.query : payload.query;
  const rewritten = detected ? { query: incoming, resolved: [] } : rewriteQuery(incoming);
  // 辞書の言い換え (日本語 → hitomi の語彙) を通さない源泉がある: pixiv は語をそのまま
  // タグの部分一致で引くので、`artist:romaji` に化けると当たらなくなる (§15 E6)
  const rawWords = source === 'hitomi' || (adapters[source] && adapters[source].rewritesAliases === false);
  const query = rawWords && !detected ? incoming : rewritten.query;
  // お気に入りは手元のファイルが答え: ★を外した直後に古い一覧を出さないよう素通しする
  const cacheable = !(source === 'pawchive' && payload.sort === 'favorites');
  const key = searchKey(payload, source, query);
  const cached = cacheable ? cache.getSearch(key, cache.searchTtl({ query })) : null;
  if (cached) return rawWords ? { ...cached, query, interpreted: [] } : cached;

  const adapter = adapters[source];
  if (!adapter) throw new Error(`unknown source: ${source}`);
  if (searchInflight.has(key)) {
    const entry = searchInflight.get(key);
    if (entry.controller.signal.aborted) {
      if (searchInflight.get(key) === entry) searchInflight.delete(key);
    } else {
    entry.subscribers += 1;
    try {
      return await waitFor(entry.promise, signal);
    } finally {
      entry.subscribers -= 1;
      if (signal?.aborted && entry.subscribers === 0) entry.controller.abort(signal.reason);
    }
    }
  }
  const controller = new AbortController();
  const entry = { controller, subscribers: 1, promise: null };
  const pending = (async () => {
    const result = { ...(await adapter.search({ ...payload, query, signal: controller.signal })), source };
    result.query = result.query || query;
    if (!result.interpreted || !result.interpreted.length) {
      result.interpreted = rawWords ? [] : (rewritten.resolved || []);
    }
    // 欠けのある一覧を焼かない (項目 7-7)。一件が瞬断で error になっただけの
    // 一覧を 10 分ディスクに残すと、同じ語で引き直しても欠けた札が出続け、
    // 「もう一度引けば直る」が効かなくなる。今回ぶんはそのまま画面へ返す
    const broken = (result.galleries || []).some((g) => g && g.error);
    if (cacheable && !broken && !controller.signal.aborted && searchInflight.get(key) === entry) {
      cache.setSearch(key, result);
    }
    return result;
  })().finally(() => {
    if (searchInflight.get(key) === entry) searchInflight.delete(key);
  });
  entry.promise = pending;
  searchInflight.set(key, entry);
  try {
    return await waitFor(pending, signal);
  } finally {
    entry.subscribers -= 1;
    if (signal?.aborted && entry.subscribers === 0) controller.abort(signal.reason);
  }
}

async function getGallery(id) {
  const { source, key } = parseId(id);
  const canonical = `${source}:${key}`;
  const cached = cache.getMeta(`gallery:${canonical}`);
  if (cached) return cached;
  if (galleryInflight.has(canonical)) return galleryInflight.get(canonical);
  const pending = adapters[source].getGallery(key).then((resolved) => {
    cache.setMeta(`gallery:${canonical}`, resolved);
    return resolved;
  }).finally(() => galleryInflight.delete(canonical));
  galleryInflight.set(canonical, pending);
  return pending;
}

async function fetchLocal(id, index, size = 'full', options = {}) {
  // 台帳に載らない所持作品 (Eagle アイテムの疑似 ID) は差し込み口が道を知っている
  const localPath = (localContentRef && localContentRef.pathOf && localContentRef.pathOf(id))
    || (catalogRef && catalogRef.findLocal(id));
  if (!localPath) return null;
  if (localContentRef) {
    try {
      const hit = await localContentRef.fetch(localPath, index, size, options);
      if (hit) return hit;
    } catch {
      // 手元で出せなければ網から (従来どおり)
    }
    return null;
  }
  try {
    return await localArchive.readPage(localPath, index);
  } catch {
    return null;
  }
}

// 読み手が頼んだ頁は、源泉が「眺める大きさ」を持っていればそれに替える (pixiv: 原寸 → 1200 px)。
// 控えの鍵もその大きさで引く: 原寸の鍵に軽い絵を入れると、落とす側が劣化した頁を掴んで綴じる
function effectiveSize(source, options = {}) {
  const size = options.size || 'full';
  const adapter = adapters[source];
  if (options.reading !== true || !adapter || typeof adapter.readingSize !== 'function') return size;
  return adapter.readingSize(size) || size;
}

async function fetchImage(id, index, options = {}) {
  const requested = options.size || 'full';
  // reading: 読み手が出すために頼んだ頁。所持作品はこれを合図に、残りを裏で用意する
  const local = await fetchLocal(id, index, requested, { reading: options.reading === true });
  if (local) return local;
  // Eagle アイテムの頁は手元にしか無い: 出せなければそこで終わり (網に訊きに行かない)
  if (isPawEagleId(id) || isPawFolderId(id)) return null;
  const parsed = parseId(id);
  const size = effectiveSize(parsed.source, options);
  const key = cache.imageKey(id, index, size);
  return cache.getImage(key, async ({ signal: sharedSignal } = {}) => (
    adapters[parsed.source].fetchImage(parsed.key, index, { ...options, size, signal: sharedSignal })
  ), { memoryOk: size !== 'full', signal: options.signal });
}

// 札の補完は任意の口: 持っているアダプタにだけ訊く。
// 補完を持たないサイトでも、辞書 + 所持庫の作家名 (suggestAliases に台帳が
// 動的に差し込む) だけは出す — 作者を日本語で打つ道はどのサイトでも同じ
// 候補はどのサイトでも同じ形で返す:
//   主表示 = 日本語名 / 補助表示 = 種類と所属作品 / 件数 = そのサイト自身の数だけ。
// 飾り付け (search-decorate) は一箇所。サイトごとに人物辞書を増やさない。
// アダプタが候補を持たない・空を返した時は、確かめ済みの辞書から補う
// (ただし**そのサイトで実際に引ける候補だけ**)
async function suggestTags(term, source = 'hitomi') {
  const adapter = adapters[source];
  const text = String(term || '').trim();
  const decorate = require('../search-decorate');
  let remote = [];
  if (adapter && typeof adapter.suggestTags === 'function') {
    try { remote = await adapter.suggestTags(term); } catch { remote = []; }
  }
  remote = (remote || []).map((item) => decorate.decorate(item, source));

  // 確かめ済みの辞書で引けた「人・作品」を先に置く。
  // サイト自身の補完は字面の一致なので、`kaho` に「家宝」「過保護」を並べてくる。
  // 日本語名と所属作品の付いた候補を先に見せた方が、探している人物に届く
  const named = new Set(['character', 'series', 'artist', 'group']);
  const dictionary = decorate.fromDictionary(text, source, 8);
  const items = [];
  const sent = (item) => String(item.value || item.name || '').trim().toLowerCase();
  const seen = new Set();
  const push = (item) => {
    const key = sent(item);
    if (!key || seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };
  for (const row of dictionary) if (named.has(row.type)) push(row);
  for (const row of remote) push(row);
  for (const row of dictionary) push(row);
  return require('../search-intent').normalizeSuggestions(items.slice(0, 10), source);
}

module.exports = {
  search,
  getGallery,
  fetchImage,
  effectiveSize,
  suggestTags,
  detectInput,
  parseId,
  setCatalog,
  setLocalContent,
  allowedHosts,
  pickTitle: hitomi.pickTitle,
  sanitizeName: hitomi.sanitizeName,
  _setAdapterForTest(source, adapter) {
    const previous = adapters[source];
    adapters[source] = adapter;
    return () => { adapters[source] = previous; };
  },
};
