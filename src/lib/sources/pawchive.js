const { splitAuthorQuery, matchesSearchWords, tokenizeQuery, parseTypePrefix } = require('../search-type');
const { get: rawGet, configureHost } = require('../http');
const pawCookies = require('../paw-cookies');
const { tag, record } = require('./normalize');
const { nfkc, hiraToKata, hasCjk } = require('../search-text');
const { parsePopular } = require('./paw-popular');
const popularPages = new Map();

async function popularPosts(period, page, pageSize, signal) {
  const start=page*pageSize, first=Math.floor(start/50), last=Math.floor((start+pageSize-1)/50), chunks=[];
  for(let i=first;i<=last;i++){
    const key=`${period}:${i}`,cached=popularPages.get(key);
    let parsed=cached && Date.now()-cached.at<300000 ? cached.value : null;
    if(!parsed){
      const response=await get(`https://pawchive.pw/posts/popular?period=${period}&o=${i*50}`,{}, {signal});
      parsed=parsePopular(response.text());
      popularPages.set(key,{at:Date.now(),value:parsed});
      if(popularPages.size>60)popularPages.delete(popularPages.keys().next().value);
    }
    chunks.push(parsed);for(const post of parsed.posts)remember(post);
    if(!parsed.hasNext)break;
  }
  const rows=chunks.flatMap(c=>c.posts),within=start-first*50,galleries=rows.slice(within,within+pageSize).map(serialize);
  const hasNext=within+pageSize<rows.length || Boolean(chunks.at(-1)?.hasNext);
  return {galleries,page,pageSize,total:start+galleries.length,approximate:hasNext,hasNext};
}

// この置き場への当たりは必ず素性 (クッキー) を添えて出す。無認証だと数枚で 403 に
// 切り替わる一方、ログイン済みなら同じ速度でも断られない (詳しくは paw-cookies)。
// ここで包んでおけば、この先の呼び出しは今までどおり get を使うだけでよい
//
// UA は素性の分かる名で出す (ブラウザを名乗らない)。2026-09-24 からファイル置き場 (file.pawchive.pw) は
// ブラウザの UA を名乗る取得を一本目から 403 で断る (断りの頁が「素性の分かる UA で、1 秒に 1 本・
// 同時 5 本まで」と求める)。同じ絵が、素性の分かる UA なら間を空けて 200 で返るのを確かめた。
// API と縮小絵の置き場も同じ名で通る。連絡先は添えない (利用者の素性を相手に渡さない)
const PAW_USER_AGENT = (() => {
  let version = '';
  try {
    version = String(require('../../../package.json').version || '');
  } catch {
    version = '';
  }
  return `BUNKO${version ? `/${version}` : ''} (personal library reader)`;
})();
const FILE_HOST = 'file.pawchive.pw';
// 試験は http を get だけの張りぼてに差し替える: 作法を差す口が無ければ何もしない
if (typeof configureHost === 'function') configureHost(FILE_HOST, { limit: 5, interval: 1000 });
// 原寸の絵は作法どおり 1 秒に 1 本しか出ない: 読み手の先読みが並ぶと順番待ちが既定の 20 秒を越えるので、
// 待ちも含めて長めに見る (読み手が頁を離れれば取り下げで列から抜ける)
const FILE_TIMEOUT_MS = 60000;

function get(url, headers, options = {}) {
  return rawGet(url, pawCookies.headers({ 'User-Agent': PAW_USER_AGENT, ...headers }), options);
}

async function joinFlight(entry, signal, discard) {
  entry.subscribers += 1;
  let onAbort;
  try {
    if (!signal) return await entry.promise;
    if (signal.aborted) throw signal.reason || new Error('aborted');
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(signal.reason || new Error('aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    return await Promise.race([entry.promise, aborted]);
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    entry.subscribers -= 1;
    if (signal?.aborted && entry.subscribers === 0) {
      discard?.();
      entry.controller.abort(signal.reason);
    }
  }
}

// お気に入りの台帳はこのファイルの URL 知識を使う側: 先に読むと循環参照になるので、
// 呼ばれた時点で引く (この口を使うのは favoriteCreators だけ)
function pawFavorites() {
  return require('../paw-favorites');
}

const cache = new Map();
const POST_CACHE_TTL = 24 * 60 * 60 * 1000;
const POST_CACHE_MAX = 1000;
const postInflight = new Map();
const globalPages = new Map();
let creatorCache = { at: 0, rows: [] };
const FILE = 'https://file.pawchive.pw/data';
const THUMB = 'https://img.pawchive.pw/thumbnail/data';

// 絵かどうかの表は local-archive が原本 (jxl が抜けていて一字種ずれていた)
const { isImageName } = require('../local-archive');

// この置き場の顔。main 側の「外部ブラウザで開いて良い先」もここを集めて決める
const hosts = ['pawchive.pw', 'pawchive.st'];

// 取り込み元の別。URL の一段目に出るのはこの 6 つだけ
const SERVICES = ['patreon', 'fanbox', 'discord', 'fantia', 'subscribestar', 'gumroad'];
const SERVICE_GROUP = SERVICES.join('|');

const POST_URL = new RegExp(`pawchive\\.(?:pw|st)/(${SERVICE_GROUP})/user/([^/]+)/post/([^/?#]+)`, 'i');
const CREATOR_URL = new RegExp(`pawchive\\.(?:pw|st)/(${SERVICE_GROUP})/user/([^/?#\\s]+)`, 'i');
// お気に入りの urls.txt 用: 行の頭から読める作者 URL だけを見る。
// 手書きの行なので http なし・www 付き・別ドメイン (.st など) の揺れを許す
const CREATOR_LINE = new RegExp('^(?:https?://)?(?:www\\.)?pawchive\\.[a-z]+/([a-z]+)/user/([^/?#\\s"\']+)', 'i');

function buildCreatorUrl(service, user) {
  return `https://pawchive.pw/${service}/user/${user}`;
}

function buildPostUrl(service, user, id) {
  return `${buildCreatorUrl(service, user)}/post/${id}`;
}

// 検索欄に貼られた URL を「この置き場のこの投稿 (または作者)」と読む。
// 他所の URL なら null を返し、次のアダプタに渡す
function detectUrl(text) {
  const value = String(text);
  const post = value.match(POST_URL);
  if (post) return { source: 'pawchive', query: `${post[1]}/${post[2]}/${post[3]}` };
  // 投稿 URL の後ろで見る: 先に置くと投稿が作者として拾われる
  const creator = value.match(CREATOR_URL);
  if (creator) return { source: 'pawchive', query: `${creator[1]}/${creator[2]}` };
  return null;
}

// お気に入りの 1 行 → 作者。知らない取り込み元は作者として扱わない
function parseCreatorUrl(text) {
  const hit = String(text || '').match(CREATOR_LINE);
  if (!hit) return null;
  const service = hit[1].toLowerCase();
  if (!SERVICES.includes(service)) return null;
  const user = hit[2];
  if (!user) return null;
  return { service, user, url: buildCreatorUrl(service, user) };
}

function fileUrl(path, name) {
  const clean = path.startsWith('/') ? path : `/${path}`;
  return name ? `${FILE}${clean}?f=${encodeURIComponent(name)}` : `${FILE}${clean}`;
}

function thumbUrl(path) {
  const clean = path.startsWith('/') ? path : `/${path}`;
  return `${THUMB}${clean}`;
}

// API の型は当てにならない: 配列のはずの場所に文字列や物体が来ることがある。
// 想定外の形は「無かったこと」にして、一覧ごと落とさないのを優先する
function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined || value === '') return [];
  return [value];
}

// PostgreSQL の配列リテラル: {a,b,"c, d"} 。API はこれを生の文字列のまま返す。
// 引用符の中のカンマは区切りではないので、素朴な split では割れない
function parsePgArray(text) {
  const body = text.slice(1, -1);
  const out = [];
  let current = '';
  let quoted = false;
  let escaped = false;
  for (const ch of body) {
    if (escaped) {
      current += ch;
      escaped = false;
    } else if (ch === '\\') {
      escaped = true;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}

// タグは配列・{a,b} の PG リテラル・カンマ区切りの文字列・{name} の物体のいずれでも来うる。
// 波括弧を剥がし損ねると「{にじさんじ」のような札が画面に出る
function tagNames(value) {
  let list;
  if (typeof value === 'string') {
    const text = value.trim();
    list = text.startsWith('{') && text.endsWith('}') ? parsePgArray(text) : text.split(',');
  } else {
    list = asArray(value);
  }
  return list
    .map((item) => {
      if (typeof item === 'string' || typeof item === 'number') return String(item);
      if (item && typeof item === 'object') return String(item.name || item.tag || item.value || '');
      return '';
    })
    .map((name) => name.trim())
    .filter(Boolean);
}

function fileEntry(item, fallbackName) {
  if (!item || typeof item !== 'object') return null;
  const path = typeof item.path === 'string' ? item.path : '';
  if (!path) return null;
  return { name: typeof item.name === 'string' && item.name ? item.name : fallbackName, path };
}

// 一覧の応答に混じった非オブジェクトの行は捨てる: 1 件のゴミで一覧を落とさない
function postRows(rows) {
  return (Array.isArray(rows) ? rows : []).filter((post) => post && typeof post === 'object');
}

function collectFiles(post) {
  const files = [];
  const cover = fileEntry(post && post.file, 'cover');
  if (cover) files.push(cover);
  for (const item of asArray(post && post.attachments)) {
    const entry = fileEntry(item, 'file');
    if (entry) files.push(entry);
  }
  return files;
}

// 画面で見せる/閲覧系が取りに行く並び (表紙が先頭・その後に添付)。
// 名前が無い添付は path の拡張子で見る: 名無しの画像を取りこぼさない。
// 取り込み (一括更新・保存) の仕分けはこれを使わない: あちらは外部エンジンが
// 落とすかどうかで決まるので、判定は kemono-engine の kemonoExt に揃えてある
function imageFiles(post) {
  return collectFiles(post).filter((file) => isImageName(file.name) || isImageName(file.path));
}

// 投稿が持つ作者は post.user (数字の id) だけ: 表示名は作者一覧から引くしかない。
// 引けなかったぶんは id のまま出す (名前のために一覧を落とさない)
const creatorNames = new Map();

async function ensureCreatorNames({ signal } = {}) {
  try {
    for (const row of await loadCreators({ signal })) {
      creatorNames.set(`${row.service}:${row.id}`, String(row.name || row.id));
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    // 圏外・API 不調。名前が無くても投稿の一覧は出せる
  }
}

// serialize は同期なので索引を引くだけ。詰めるのは入口の ensureCreatorNames の仕事
function creatorNameOf(post) {
  return creatorNames.get(`${post.service}:${post.user}`) || String(post.user);
}

function serialize(post) {
  const images = imageFiles(post);
  const files = collectFiles(post);
  return record({
    id: `pw:${post.service}:${post.user}:${post.id}`,
    source: 'pawchive',
    title: typeof post.title === 'string' && post.title.trim()
      ? post.title
      : `${post.service} ${post.id}`,
    type: post.service || 'post',
    artists: post.user ? [tag('artist', creatorNameOf(post))] : [],
    tags: tagNames(post.tags).map((name) => tag('tag', name)),
    pageCount: images.length || (files.length ? 1 : 0),
    addedDate: post.published || post.added || null,
    url: buildPostUrl(post.service, post.user, post.id),
  });
}

function remember(post, { detail = false } = {}) {
  const key = `${post.service}:${post.user}:${post.id}`;
  const previous = cache.get(key);
  // 一覧の省略行で、取得済みの添付つき本体を上書きしない。
  if (!previous?.detail || detail) cache.set(key, { post, detail, at: Date.now() });
  while (cache.size > POST_CACHE_MAX) cache.delete(cache.keys().next().value);
  return post;
}

async function getPost(key, { signal, priority = 10 } = {}) {
  const [service, user, id] = String(key).split(':');
  const cacheKey = `${service}:${user}:${id}`;
  const cached = cache.get(cacheKey);
  if (cached?.detail && Date.now() - cached.at <= POST_CACHE_TTL) return cached.post;
  const current = postInflight.get(cacheKey);
  if (current && !current.controller.signal.aborted) {
    return joinFlight(current, signal, () => {
      if (postInflight.get(cacheKey) === current) postInflight.delete(cacheKey);
    });
  }
  if (postInflight.get(cacheKey) === current) postInflight.delete(cacheKey);
  const controller = new AbortController();
  const entry = { controller, subscribers: 0, promise: null };
  const pending = get(`https://pawchive.pw/api/v1/${service}/user/${user}/post/${id}`, {}, {
    signal: controller.signal, priority,
  })
    .then((res) => {
      const post = res.json();
      if (postInflight.get(cacheKey) === entry) remember(post, { detail: true });
      return post;
    })
    .finally(() => {
      if (postInflight.get(cacheKey) === entry) postInflight.delete(cacheKey);
    });
  entry.promise = pending;
  postInflight.set(cacheKey, entry);
  return joinFlight(entry, signal, () => {
    if (postInflight.get(cacheKey) === entry) postInflight.delete(cacheKey);
  });
}

async function listCreatorPosts(service, user, page, pageSize, { signal } = {}) {
  const start = page * pageSize;
  const firstApiPage = Math.floor(start / API_PAGE);
  const lastApiPage = Math.floor((start + pageSize - 1) / API_PAGE);
  const chunks = [];
  for (let index = firstApiPage; index <= lastApiPage; index += 1) {
    chunks.push(await creatorApiPage(service, user, index, { signal }));
  }
  const list = chunks.flat();
  const within = start - firstApiPage * API_PAGE;
  const galleries = list.slice(within, within + pageSize).map((post) => serialize(post));
  const ended = chunks.some((rows) => rows.length < API_PAGE);
  return {
    total: start + galleries.length,
    approximate: !ended,
    hasNext: !ended || within + pageSize < list.length,
    page,
    pageSize,
    galleries,
  };
}

// タグ検索は API に無い (tag=/tags= はどこでも黙殺され、q= は題と本文だけ)。
// ただし作者の投稿一覧 JSON はタグを載せてくるので、作者の中でだけ手元で絞れる。
// 一覧の頁はここに溜めておく: 頁送りやタグの掛け替えで取り直さないため
const creatorPages = new Map();
const CREATOR_PAGE_TTL = 10 * 60 * 1000;
const API_PAGE = 50;
const MAX_API_PAGES = 20;

async function creatorApiPage(service, user, index, { signal } = {}) {
  const key = `${service}:${user}`;
  let entry = creatorPages.get(key);
  if (!entry || Date.now() - entry.at > CREATOR_PAGE_TTL) {
    entry = { at: Date.now(), pages: new Map() };
    creatorPages.set(key, entry);
    while (creatorPages.size > 100) creatorPages.delete(creatorPages.keys().next().value);
  }
  if (entry.pages.has(index)) {
    const saved = entry.pages.get(index);
    if (saved.value) return saved.value;
    if (!saved.controller.signal.aborted) return joinFlight(saved, signal, () => {
      if (entry.pages.get(index) === saved) entry.pages.delete(index);
    });
    if (entry.pages.get(index) === saved) entry.pages.delete(index);
  }
  const url = `https://pawchive.pw/api/v1/${service}/user/${user}/posts?o=${index * API_PAGE}`;
  const controller = new AbortController();
  const flight = { controller, subscribers: 0, promise: null };
  const pending = get(url, {}, { signal: controller.signal, priority: 10 }).then((res) => {
    const rows = postRows(res.json());
    if (entry.pages.get(index) === flight) {
      rows.forEach((post) => remember(post));
      entry.at = Date.now();
      entry.pages.set(index, { value: rows });
    }
    return rows;
  }).catch((error) => {
    if (entry.pages.get(index) === flight) entry.pages.delete(index);
    throw error;
  });
  flight.promise = pending;
  entry.pages.set(index, flight);
  return joinFlight(flight, signal, () => {
    if (entry.pages.get(index) === flight) entry.pages.delete(index);
  });
}

async function globalApiPage(query, index, { signal } = {}) {
  const key = String(query || '');
  let entry = globalPages.get(key);
  if (!entry || Date.now() - entry.at > CREATOR_PAGE_TTL) {
    entry = { at: Date.now(), pages: new Map() };
    globalPages.set(key, entry);
    while (globalPages.size > 100) globalPages.delete(globalPages.keys().next().value);
  }
  if (entry.pages.has(index)) {
    const saved = entry.pages.get(index);
    if (saved.value) return saved.value;
    if (!saved.controller.signal.aborted) return joinFlight(saved, signal, () => {
      if (entry.pages.get(index) === saved) entry.pages.delete(index);
    });
    if (entry.pages.get(index) === saved) entry.pages.delete(index);
  }
  const url = `https://pawchive.pw/api/v1/posts?q=${encodeURIComponent(key)}&o=${index * API_PAGE}`;
  const controller = new AbortController();
  const flight = { controller, subscribers: 0, promise: null };
  const pending = get(url, {}, { signal: controller.signal, priority: 10 }).then((res) => {
    const rows = postRows(res.json());
    if (entry.pages.get(index) === flight) {
      rows.forEach((post) => remember(post));
      entry.at = Date.now();
      entry.pages.set(index, { value: rows });
    }
    return rows;
  }).catch((error) => {
    if (entry.pages.get(index) === flight) entry.pages.delete(index);
    throw error;
  });
  flight.promise = pending;
  entry.pages.set(index, flight);
  return joinFlight(flight, signal, () => {
    if (entry.pages.get(index) === flight) entry.pages.delete(index);
  });
}

// 全角/半角と大小を均す。タグは人が打つものなので、見た目が同じなら同じ札として扱う
function tagKey(value) {
  return String(value || '').normalize('NFKC').trim().toLowerCase();
}

// 作者名の照合はもう一段ゆるく: ひらがな/カタカナの違いも同じものとして扱う
function nameKey(value) {
  return require('../search-text').aliasKey(value);
}
function creatorKeys(query) {
  const description=require('../search-aliases').describeTerm(`artist:${String(query).replace(/\s+/g,'_')}`);
  return [...new Set([query,description?.name,description?.label,...(description?.aliases || [])].filter(Boolean).map(nameKey).filter(Boolean))];
}
function postMatches(post, words) {
  const text=[];
  for (const token of tokenizeQuery(words)) {
    const typed=parseTypePrefix(token);
    if (typed && typed.type!=='artist') {
      const found=postHasTag(post,tagKey(typed.name));
      if (typed.negative ? found : !found) return false;
    } else text.push(token);
  }
  return matchesSearchWords([post.title,post.content].join(' '),text.join(' '));
}

function postHasTag(post, wanted) {
  return tagNames(post && post.tags).some((name) => tagKey(name) === wanted);
}

async function listCreatorPostsByTag(service, user, rawTag, page, pageSize, { signal, words = '' } = {}) {
  const wanted = tagKey(rawTag);
  const need = page * pageSize + pageSize;
  const hits = [];
  let ended = false;
  // 上限に当たって打ち切ったか。**打ち切ったことを黙らない** (項目 7-10):
  // 1000 投稿を越える作者では「これで全部」に見えてしまい、
  // 続きがあるのに利用者が探すのをやめることになる
  let truncated = false;
  for (let index = 0; index < MAX_API_PAGES; index += 1) {
    if (index === MAX_API_PAGES - 1) truncated = true;
    // 頁は順に見る: API に飛ばし読みの口が無い
    let rows = [];
    try {
      rows = await creatorApiPage(service, user, index, { signal });
    } catch (error) {
      // 途中で断られた (429 など) ときは、そこまでで出す。
      // 1 頁目から駄目なら検索そのものが失敗したと言う
      if (index === 0) throw error;
      break;
    }
    for (const post of rows) {
      if ((wanted ? postHasTag(post, wanted) : true) && postMatches(post,words)) hits.push(post);
    }
    if (rows.length < API_PAGE) {
      ended = true;
      break;
    }
    // 次頁があるかを言うために 1 件だけ多く溜める
    if (hits.length > need) break;
  }
  const slice = hits.slice(page * pageSize, page * pageSize + pageSize);
  const cut = truncated && !ended;
  return {
    total: hits.length,
    approximate: !ended,
    // 打ち切りは画面が言うための印。listCreatorPosts と同じく hasNext も返す
    truncated: cut,
    truncatedAfter: cut ? MAX_API_PAGES * API_PAGE : 0,
    hasNext: hits.length > page * pageSize + pageSize || cut,
    page,
    pageSize,
    galleries: slice.map((post) => serialize(post)),
  };
}

// "<service>/<user>" と、その後ろに続く "tag:<札>" を読む。
// 札には空白が入りうるので、tag: 以降は行末まで丸ごと札とみなす
function parseCreatorQuery(text) {
  const hit = text.match(/^(\w+)\/([^/\s]+)(?:\s+([\s\S]+))?$/);
  if (!hit) return null;
  const rest = (hit[3] || '').trim();
  if (!rest) return { service: hit[1], user: hit[2], tag: '' };
  // Legacy detail links used an unquoted multiword tag through end-of-line.
  // New compound filters use tag:blue_sky or tag:"blue sky" followed by words.
  const legacyTag=/^tag:[^_"\s:]+(?:\s+[^_"\s:-]+)+$/i.test(rest);
  const tagHit = (tokenizeQuery(rest).length===1 || legacyTag) && rest.match(/^tag:([\s\S]+)$/i);
  // 作者指定に続く見知らぬ語は、作者一覧の絞り込みではない: 全文検索に回す
  if (!tagHit) return { service: hit[1], user: hit[2], tag: '', words: rest };
  return { service: hit[1], user: hit[2], tag: parseTypePrefix(rest)?.name || tagHit[1].trim() };
}

async function loadCreators({ signal } = {}) {
  if (!creatorCache.rows.length || Date.now() - creatorCache.at > 60 * 60 * 1000) {
    const response = await get('https://pawchive.pw/api/v1/creators?q=', {}, { signal, priority: 10 });
    const rows = await require('../creator-list-parser')(response);
    creatorCache = {
      at: Date.now(),
      rows,
    };
  }
  return creatorCache.rows;
}

// 札に出す最終更新日。updated は unix 秒。読めなければ空 (札は何も出さない)
function updatedBadge(updated) {
  const stamp = Number(updated) || 0;
  if (!stamp) return '';
  const d = new Date(stamp * 1000);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function creatorCard(creator) {
  return record({
    id: `pw:${creator.service}:${creator.id}:profile`,
    source: 'pawchive',
    title: creator.name || creator.id,
    type: creator.service,
    artists: [tag('artist', creator.name || creator.id)],
    pageCount: 0,
    // ★の数 (favorited) ではなく最終更新日を出す (2026-08-28 利用者指定)
    badge: updatedBadge(creator.updated),
    kind: 'creator',
    url: buildCreatorUrl(creator.service, creator.id),
  });
}

async function popularCreators(page, pageSize) {
  const rows = await loadCreators();
  const slice = rows.slice(page * pageSize, page * pageSize + pageSize);
  return {
    total: rows.length,
    approximate: false,
    page,
    pageSize,
    galleries: slice.map(creatorCard),
  };
}

// お気に入り: 最終更新日 (updated) の新しい順に並べる (2026-08-28 利用者指定。
// sortDir='asc' で古い順)。更新日の分からない作者は末尾。名前は作者一覧から
// 引くが、一覧に無い作者も id のまま札を出す (取りこぼしを黙って消さない)
async function favoriteCreators(page, pageSize, query = '', sortDir = 'desc') {
  const favorites = pawFavorites().list();
  let index = new Map();
  try {
    const rows = await loadCreators();
    index = new Map(rows.map((row) => [`${row.service}:${row.id}`, row]));
  } catch {
    // 名前が引けなくても、お気に入りの一覧そのものは出せる
  }
  const named = favorites.map((fav) => {
    const known = index.get(`${fav.service}:${fav.user}`);
    return known
      ? {
        service: fav.service, id: fav.user, name: known.name || fav.user,
        favorited: known.favorited, updated: known.updated,
      }
      : { service: fav.service, id: fav.user, name: fav.user, favorited: null };
  });
  // 語があるときは名前 (と id) で絞る
  const key = nameKey(query);
  const rows = key
    ? named.filter((row) => nameKey(row.name).includes(key) || nameKey(row.id).includes(key))
    : named.slice();
  // 最終更新日順。更新日不明 (作者一覧に無い) は向きに関わらず末尾へ
  const dir = sortDir === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    const x = Number(a.updated) || 0;
    const y = Number(b.updated) || 0;
    if (!x || !y) return x ? -1 : (y ? 1 : 0);
    return (x - y) * dir;
  });
  return {
    total: rows.length,
    approximate: false,
    page,
    pageSize,
    galleries: rows.slice(page * pageSize, page * pageSize + pageSize).map(creatorCard),
  };
}

// 作者名で作者一覧を引く。API の q= は投稿の題を見るだけなので、
// 「表示されている作者名で探す」はここで手元の一覧を当てるしかない
async function searchCreators(query, page, pageSize) {
  const keys = creatorKeys(query);
  if (!keys.length) return { total: 0, approximate: false, page, pageSize, galleries: [] };
  let rows = [];
  try {
    rows = await loadCreators();
  } catch {
    return { total: 0, approximate: false, page, pageSize, galleries: [] };
  }
  const hits = rows
    .filter((row) => {
      const name=nameKey(row.name), id=nameKey(row.id), primary=nameKey(query);
      return name.includes(primary) || id.includes(primary) || keys.some(key=>name===key || id===key);
    })
    // loadCreators が人気順に並べてあるので、その順を保つ
    .sort((a, b) => (Number(b.favorited) || 0) - (Number(a.favorited) || 0));
  return {
    total: hits.length,
    approximate: false,
    page,
    pageSize,
    galleries: hits.slice(page * pageSize, page * pageSize + pageSize).map(creatorCard),
  };
}

// 検索欄の候補。この置き場に札 (タグ) の横断索引は無いので、出せるのは作者だけ。
// 種は popularCreators と同じ手元の一覧 (loadCreators): 候補のために別の口は叩かない
const SUGGEST_LIMIT = 8;

async function suggestTags(term) {
  const text = String(term || '').trim();
  // 漢字・仮名は 1 文字から効かせる (「藍」だけで絞れる)。
  // 欧文の 1 文字は当たりが多すぎて候補の用をなさないので 2 文字から
  if (!text || (!hasCjk(text) && text.length < 2)) return [];
  const key = nameKey(text);
  if (!key) return [];
  let rows = [];
  try {
    rows = await loadCreators();
  } catch {
    // 圏外・API 不調。候補が出ないだけで、検索そのものは打てる
    return [];
  }
  // 前方一致を先、含み一致を後。どちらの束も loadCreators の人気順のまま積む
  const prefix = [];
  const partial = [];
  for (const row of rows) {
    if (!row || !row.service || !row.id) continue;
    const name = String(row.name || row.id);
    const byName = nameKey(name);
    const byId = nameKey(row.id);
    if (byName.startsWith(key) || byId.startsWith(key)) prefix.push({ row, name });
    else if (byName.includes(key) || byId.includes(key)) partial.push({ row, name });
    // 前方一致だけで埋まったら残りは見ない: 人気順なので先頭 8 件が答えそのもの
    if (prefix.length >= SUGGEST_LIMIT) break;
  }
  return [...prefix, ...partial].slice(0, SUGGEST_LIMIT).map(({ row, name }) => ({
    type: 'artist',
    name,
    // 検索欄にそのまま入る形 ("fanbox/12345")。web も所持作品も同じ語で読める
    value: `${row.service}/${row.id}`,
    label: name,
    count: Number(row.favorited) || 0,
    metric: {site:'pawchive',kind:'favorites',value:Number(row.favorited)||0},
    source: 'creator',
  }));
}

async function search({ query = '', tag = '', sort = 'added', sortDir = 'desc', page = 0, pageSize = 24, signal } = {}) {
  // 作者名の索引はここで一度だけ揃える: この先どの枝も serialize に流れ込む
  await ensureCreatorNames({ signal });
  const text = String(query).trim();
  const authorSearch = splitAuthorQuery(text);
  if (authorSearch.authors.length) {
    if (authorSearch.authors.length !== 1 || authorSearch.authors[0].negative) throw new Error('作者候補検索は作者を1人指定してください。');
    const result = await searchCreators(authorSearch.authors[0].name, page, pageSize);
    return { ...result, galleries: result.galleries.map(g => ({...g, query: `${g.id.split(':').slice(1,3).join('/')}${authorSearch.rest ? ' ' + authorSearch.rest : ''}`})) };
  }
  if(!text && ['popular-day','popular-week','popular-month'].includes(sort))return popularPosts(sort.slice(8),page,pageSize,signal);
  const direct = text.match(/^(\w+)\/([^/\s]+)\/([^/\s]+)$/);
  if (direct) {
    const post = await getPost(`${direct[1]}:${direct[2]}:${direct[3]}`, { signal });
    return { total: 1, page: 0, pageSize, galleries: [serialize(post)] };
  }
  const creator = parseCreatorQuery(text);
  if (creator) {
    const wanted = creator.tag || String(tag || '').trim();
    if (creator.words) return listCreatorPostsByTag(creator.service, creator.user, wanted, page, pageSize, { signal, words: creator.words });
    if (wanted) return listCreatorPostsByTag(creator.service, creator.user, wanted, page, pageSize, { signal });
    return listCreatorPosts(creator.service, creator.user, page, pageSize, { signal });
  }
  const creatorSort = sort === 'today' || sort === 'week' || sort === 'month' || sort === 'year';
  if (!text) {
    if (sort === 'favorites') return favoriteCreators(page, pageSize, '', sortDir);
    if (creatorSort) return popularCreators(page, pageSize);
  } else if (sort === 'favorites' || creatorSort) {
    // 作者を並べている画面で語を打ったら、まず作者を名前で探す。
    // お気に入り → 作者一覧 → 投稿の全文検索 の順に落ちていく (どの口も塞がない)
    if (sort === 'favorites') {
      const mine = await favoriteCreators(page, pageSize, text, sortDir);
      if (mine.total) return mine;
    }
    const hits = await searchCreators(text, page, pageSize);
    if (hits.total) return hits;
  }
  // 作者の分からない tag: は当てる先が無い (API に横断のタグ検索が無い):
  // 黙って落として素の全文検索にする
  if (tokenizeQuery(text).some(token=>parseTypePrefix(token))) throw new Error('Pawchiveのタグ検索は作者の投稿内で利用できます。先に作者を選んでください。');
  const plain = text;
  const start = page * pageSize;
  const firstApiPage = Math.floor(start / API_PAGE);
  const lastApiPage = Math.floor((start + pageSize - 1) / API_PAGE);
  const chunks = [];
  for (let index = firstApiPage; index <= lastApiPage; index += 1) {
    chunks.push(await globalApiPage(plain, index, { signal }));
  }
  const list = chunks.flat();
  const within = start - firstApiPage * API_PAGE;
  const galleries = list.slice(within, within + pageSize).map(serialize);
  const ended = chunks.some((rows) => rows.length < API_PAGE);
  return {
    total: start + galleries.length,
    approximate: !ended,
    hasNext: !ended || within + pageSize < list.length,
    page,
    pageSize,
    galleries,
  };
}

async function getGallery(key) {
  await ensureCreatorNames();
  return serialize(await getPost(key));
}

// service/user → 表示名。主側が所持作品を作者フォルダへ当てるときの手がかりになる
async function creatorDisplayName(service, user) {
  await ensureCreatorNames();
  return creatorNames.get(`${service}:${user}`) || '';
}

// 作者の投稿 ID (1 頁目だけ)。所持作品の作者フォルダを名前ではなく中身で当てるための種。
// web でその作者を見た直後なら頁キャッシュに載っているので、たいてい取りに行かずに済む
async function creatorPostIds(service, user) {
  try {
    return (await creatorApiPage(service, user, 0)).map((post) => String(post.id));
  } catch {
    // 圏外・429。種が無ければ手動紐付けと名前推測だけで当てる
    return [];
  }
}

// 作者の札の扇の絵。index = 投稿一覧の頭から数えて何本目の「絵のある投稿」か (0 が正面、1・2 が後ろの二枚)。
// 一覧は creatorApiPage の控えを使うので、三枚で引く一覧は一本。一覧の行はもう表紙 (file) を持っているので、
// 縮小絵ならその道をそのまま引く (投稿の本体を一本ずつ取りに行かない)
async function fetchProfileImage(service, user, index, { size, signal, priority }) {
  const rows = await creatorApiPage(service, user, 0, { signal });
  const pictured = rows.filter((post) => imageFiles(post).length);
  // 正面だけは絵の無い投稿しか無くても従来どおり一本目を当たる (添付の中に絵があるかもしれない)
  const post = pictured[index] || (index === 0 ? rows[0] : null);
  if (!post) {
    const error = new Error('no posts');
    error.status = 404;
    throw error;
  }
  const key = `${post.service || service}:${post.user || user}:${post.id}`;
  const file = size !== 'full' ? imageFiles(post)[0] : null;
  if (file) {
    try {
      const res = await get(thumbUrl(file.path), { Referer: 'https://pawchive.pw/' }, { signal, priority });
      return { bytes: res.buffer, type: res.headers['content-type'] || 'application/octet-stream', name: file.name || 'file' };
    } catch (error) {
      if (signal?.aborted) throw error;
      // 縮小絵が無い時は投稿の本体から引き直す (下の道)
    }
  }
  return fetchImage(key, 0, { size, signal, priority });
}

async function fetchImage(key, index, { size = 'full', signal, priority = 0 } = {}) {
  const parts = String(key).split(':');
  if (parts[2] === 'profile') return fetchProfileImage(parts[0], parts[1], index, { size, signal, priority });
  const post = await getPost(key, { signal, priority });
  const images = imageFiles(post);
  const files = images.length ? images : collectFiles(post);
  const file = files[index];
  if (!file) {
    const error = new Error('file not found');
    error.status = 404;
    throw error;
  }
  const isImage = isImageName(file.name || file.path);
  const url = size !== 'full' && isImage ? thumbUrl(file.path) : fileUrl(file.path, file.name);
  let res;
  try {
    res = await get(url, { Referer: 'https://pawchive.pw/' }, {
      signal, priority, ...(url.startsWith(FILE) ? { timeout: FILE_TIMEOUT_MS } : {}),
    });
  } catch (error) {
    // kemono 由来の投稿はサムネイルだけ先に載り、実体が未取り込み (has_full: false) のことがある。
    // フルが 404 ならサムネイルで代える: 粗くても白紙よりは読める
    if (error?.status !== 404 || !isImage || url === thumbUrl(file.path)) throw error;
    res = await get(thumbUrl(file.path), { Referer: 'https://pawchive.pw/' }, { signal, priority });
  }
  return { bytes: res.buffer, type: res.headers['content-type'] || 'application/octet-stream', name: file.name || 'file' };
}

// 一括更新 (paw-bulk) 向けの生の口。画面用の serialize を通さず、API がよこした
// 投稿そのものを扱う。添付の実体を取りに行く口はここには無い: 一括更新の取得は
// 外部エンジン (kemono-dl の子プロセス) に移した。
// 頁キャッシュ (creatorPages) は使わない: 取り込みは必ず今の一覧を見る
const bulk = {
  async listPosts(service, user, page) {
    const url = `https://pawchive.pw/api/v1/${service}/user/${user}/posts?o=${page * API_PAGE}`;
    const rows = postRows((await get(url)).json());
    rows.forEach((post) => remember(post));
    return rows;
  },
  // 一覧の行は添付を省くことがある: 取り込む投稿は必ず本体を引き直す
  async fetchPost(service, user, id) {
    const res = await get(`https://pawchive.pw/api/v1/${service}/user/${user}/post/${id}`);
    const post = res.json();
    if (post && typeof post === 'object' && post.id) remember(post, { detail: true });
    return post;
  },
  // 表紙 (post.file) と添付は別物として返す: 表紙は本文の 1 枚目と重なることがあり、
  // PDF に載せるかどうかを呼ぶ側で決めさせる
  postFiles(post) {
    return {
      cover: fileEntry(post && post.file, 'cover'),
      attachments: asArray(post && post.attachments)
        .map((item) => fileEntry(item, 'file'))
        .filter(Boolean),
    };
  },
  // "service:user" → 表示名。作者ディレクトリが引けないときは空の索引を返す
  async creatorIndex() {
    const rows = await loadCreators();
    return new Map(rows.map((row) => [`${row.service}:${row.id}`, String(row.name || row.id)]));
  },
  API_PAGE,
};

module.exports = {
  rewritesAliases: false,
  cachedCreatorName: (service,user) => creatorNames.get(`${service}:${user}`) || creatorCache.rows.find(row=>row.service===service && String(row.id)===String(user))?.name || '',
  search,
  getGallery,
  fetchImage,
  suggestTags,
  creatorDisplayName,
  creatorPostIds,
  bulk,
  hosts,
  detectUrl,
  parseCreatorUrl,
  buildCreatorUrl,
  buildPostUrl,
  SERVICES,
};
