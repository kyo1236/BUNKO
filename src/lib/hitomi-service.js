const https = require('https');
const { AsyncLocalStorage } = require('async_hooks');
const { Hitomi, GalleryManager, Extension, ThumbnailSize, SortType } = require('node-hitomi');
const {
  rewriteQuery,
  parseTypePrefix,
  suggestAliases,
  shouldQueryRemoteTags,
  canSuggestTerm,
} = require('./search-aliases');
const { nfkc, hasCjk } = require('./search-text');
// normalize は sources/ のアダプタを遅れて引くだけなので、ここから読んでも輪にならない
const { coverSize } = require('./sources/normalize');

// node-hitomi の中の通信に渡す agent。servername を空にし検証を外しているのは
// あちらが叩く CDN の SNI の癖に合わせるため。**この緩さを他へ持ち出さない**
// (緩める宣言はこの一つだけ。下の二つの agent はどちらも node-hitomi にしか渡さない)
const HITOMI_TLS = {
  servername: '',
  rejectUnauthorized: false,
};
// timeout は使っていない接続の寿命 (30 秒黙った居抜きの接続は agent が捨てる)。画像の置き場は 60 秒で接続を閉じるので、
// 相手が閉じかけた接続を掴む隙を作らない。取得中の要求は切らない (node-hitomi は timeout の合図を聞かない)
const agent = new https.Agent({ keepAlive: true, timeout: 30000, ...HITOMI_TLS });

// 引き直しの一回だけは居抜きの接続を使わない (同じ死んだ接続をもう一度掴まない)
const freshAgent = new https.Agent({ keepAlive: false, ...HITOMI_TLS });
// 今の要求が引き直しの中か (node-hitomi の onRequest まで、約束の続きをたどって届く)
const freshScope = new AsyncLocalStorage();

// BUNKO 自身が出す要求はふつうに検証する (項目 7-11)。
// 以前は上の agent を使い回していて、自前の一往復まで検証なしで出ていた
const ownAgent = new https.Agent({ keepAlive: true });

// 通信は node-hitomi 内蔵の https に任せる (期限なし・keepAlive)。
// 2026-09-05 に共通 http.js の transport (20 秒の絶対期限・host 枠・Retry-After 冷却)
// へ差し替えたところ、頁が期限で落ちて取り直しを繰り返すなど取得の挙動が変わったため、
// 利用者の指示で 2026-09-07 に元へ戻した。落ちた時の引き直しは一回だけ (withRetry)
const hitomi = new Hitomi({
  onRequest(context) {
    context.options.agent = freshScope.getStore() ? freshAgent : agent;
    if (!context.options.headers) context.options.headers = {};
    context.options.headers.Referer = 'https://hitomi.la/';
  },
  indexMaximumAge: 5 * 60 * 1000,
  imageContextMaximumAge: 30 * 60 * 1000,
});

// node-hitomi はメタの tags などが null の作品 (タグ無し等) で落ちる (実例:
// 2419981)。instance の request は凍結されていてラップできないため、
// scripts/patch-node-hitomi.js が gallery.cjs に null ガードを直接当てる
// (postinstall で毎回適用)。ここでは何もしない

const galleryCache = new Map();
const GALLERY_CACHE_MAX = 400;

const searchCache = new Map();
const SEARCH_CACHE_MAX = 40;
const SEARCH_CACHE_TTL = 5 * 60 * 1000;
const imageCache = new Map();
const IMAGE_CACHE_MAX = 120;
const totalCache = new Map();
const TOTAL_CACHE_MAX = 40;

function cacheGallery(gallery) {
  if (galleryCache.has(gallery.id)) galleryCache.delete(gallery.id);
  galleryCache.set(gallery.id, gallery);
  while (galleryCache.size > GALLERY_CACHE_MAX) {
    const oldest = galleryCache.keys().next().value;
    galleryCache.delete(oldest);
  }
  return gallery;
}

// ---- 一度だけの引き直し ------------------------------------------------------
// 作品を開いた直後の一枚目は、作品の目録 (galleries/<id>.js) と、30 分ごとに引き直す画像の置き場の表 (gg.js) を
// 引いてから絵を取る。どれか一つが網の瞬断や相手の一時的な不調で落ちると、その頁だけ出ない
// (頁を送って戻れば出る)。node-hitomi には引き直しが無いので、ここで一回だけ引き直す:
//   network  つながらない・切れた (居抜きの接続が相手に閉じられていた等)・5xx・429 → 少し待って新しい接続で
//   context  絵が 404 / 403 → 置き場の表が古いかもしれない: 表を引き直してから
// 形の誤り (無い頁・拡張子など) は引き直さない
const RETRY_DELAY_MS = 300;
const NETWORK_CODES = new Set([
  'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNABORTED', 'EAI_AGAIN', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH',
]);

// node-hitomi の状態の誤りは番号を文に埋めて返す ('https://… must not respond with 503')
function hitomiStatus(error) {
  const hit = String(error && error.message || '').match(/must not respond with (\d{3})/);
  return hit ? Number(hit[1]) : 0;
}

function retryKind(error, { image = false } = {}) {
  if (!error) return '';
  if (NETWORK_CODES.has(error.code) || /socket hang up|other side closed|premature close/i.test(String(error.message || ''))) return 'network';
  const status = hitomiStatus(error);
  if (status >= 500 || status === 429 || status === 408) return 'network';
  if (image && (status === 404 || status === 403)) return 'context';
  return '';
}

// 置き場の表を次の要求で引き直させる。表を引いた直後 (10 秒以内) なら古くはないので触らない
// (並んで落ちた頁ごとに gg.js を何度も引かない)
function expireImageContext() {
  const provider = hitomi.imageContext;
  if (!provider || !provider.expiresAt) return;
  const fetchedAt = provider.expiresAt - (provider.maximumAge || 0);
  if (Date.now() - fetchedAt > 10 * 1000) provider.expiresAt = 0;
}

async function withRetry(job, { image = false } = {}) {
  try {
    return await job();
  } catch (error) {
    const kind = retryKind(error, { image });
    if (!kind || freshScope.getStore()) throw error;
    if (kind === 'context') expireImageContext();
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    return freshScope.run(true, job);
  }
}

// 目録は同じ作品を同時に何本も引かない (読み手を開くと一枚目と先読みの頁が揃って来る)
const galleryInflight = new Map();

async function getGallery(id) {
  const numeric = Number(id);
  if (galleryCache.has(numeric)) {
    const cached = galleryCache.get(numeric);
    galleryCache.delete(numeric);
    galleryCache.set(numeric, cached);
    return cached;
  }
  if (galleryInflight.has(numeric)) return galleryInflight.get(numeric);
  const pending = withRetry(() => hitomi.galleries.retrieve(numeric))
    .then(cacheGallery)
    .finally(() => galleryInflight.delete(numeric));
  galleryInflight.set(numeric, pending);
  return pending;
}

function tagToJson(tag) {
  return {
    type: tag.type,
    name: tag.name,
    negative: Boolean(tag.isNegative),
  };
}

// 字クラスの原本は search-text.hasCjk

function pickTitle(title, fallback) {
  const japanese = title?.japanese || '';
  const display = title?.display || '';
  if (hasCjk(japanese)) return japanese;
  if (hasCjk(display)) return display;
  return display || japanese || fallback;
}

function galleryPageUrl(rawUrl, id) {
  const fallback = `https://hitomi.la/galleries/${id}.html`;
  const url = String(rawUrl || '').trim();
  if (!url) return fallback;
  if (url.startsWith('https://hitomi.la/')) return url;
  if (url.startsWith('//hitomi.la/')) return `https:${url}`;
  if (url.startsWith('http')) return fallback;
  return `https://hitomi.la/${url.replace(/^\/+/, '')}`;
}

function serializeGallery(gallery) {
  return {
    id: gallery.id,
    source: 'hitomi',
    title: pickTitle(gallery.title, String(gallery.id)),
    type: gallery.type,
    language: gallery.language
      ? { name: gallery.language.name, localName: gallery.language.localName }
      : null,
    artists: gallery.artists.map(tagToJson),
    groups: gallery.groups.map(tagToJson),
    series: gallery.series.map(tagToJson),
    characters: gallery.characters.map(tagToJson),
    tags: gallery.tags.map(tagToJson),
    pageCount: gallery.files.length,
    addedDate: gallery.addedDate ? gallery.addedDate.toISOString() : null,
    publishedDate: gallery.publishedDate ? gallery.publishedDate.toISOString() : null,
    isBlocked: gallery.isBlocked,
    hasVideo: Boolean(gallery.video),
    url: galleryPageUrl(gallery.url, gallery.id),
    // 言語違い (翻訳版) の gallery ID。renderer が同作として束ねる正確な手掛かり
    translationIds: (gallery.translations || [])
      .map((item) => Number(item && item.id))
      .filter((value) => Number.isFinite(value) && value > 0),
    // 札の表紙は 1 頁目 (imgUrl の index 0)。寸法を渡すと流しの並べ方が絵を待たずに札の高さを決められる
    ...coverSize(gallery.files[0] && gallery.files[0].width, gallery.files[0] && gallery.files[0].height),
  };
}

// URL の見分けはアダプタ (sources/hitomi.js) が持つ。アダプタはこのファイルを
// 使う側なので、読み込みは呼ばれた時点で行う (先に読むと循環参照になる)
let urlAdapter = null;

function extractGalleryId(raw) {
  if (!urlAdapter) urlAdapter = require('./sources/hitomi');
  return urlAdapter.extractGalleryId(raw);
}

function parseQuery(raw) {
  const rewritten = rewriteQuery(raw);
  const text = rewritten.query;
  if (!text) return { tags: [], title: '', id: null, rewritten };

  const id = extractGalleryId(text);
  if (id && !text.includes(' ') && (/^\d+$/.test(text) || /hitomi\.la/i.test(text))) {
    return { tags: [], title: '', id, rewritten };
  }

  const tokens = text.split(/\s+/).filter(Boolean);
  const tagTokens = [];
  const titleParts = [];
  // 「either:<名前>」は hitomi に無い型。node-hitomi の語解析に渡すと落ちるので、
  // ここで抜き取って別に持ち、listIds が female/male の二つに開いて合わせて引く
  const either = [];

  for (const token of tokens) {
    const typed = parseTypePrefix(token);
    if (typed && typed.type === 'either') {
      if (!typed.negative) either.push(typed.name);
      continue;
    }
    if (typed) {
      tagTokens.push(typed.token);
    } else {
      titleParts.push(token.replace(/_/g, ' '));
    }
  }

  return {
    tags: hitomi.tags.parse(tagTokens.join(' ')),
    either,
    title: titleParts.join(' ').trim(),
    id: null,
    rewritten,
  };
}

function canUseRemotePage(parsed) {
  if (parsed.title || parsed.id) return false;
  // 「どちらも」は二つの nozomi を合わせる: 相手の頁切り出しには乗らない
  if (parsed.either && parsed.either.length) return false;
  const negatives = parsed.tags.filter((tag) => tag.isNegative);
  const nonLanguage = parsed.tags.filter((tag) => tag.type !== 'language');
  return negatives.length === 0 && nonLanguage.length <= 1;
}

function searchKey(query, sort, language, type, excludeTypes) {
  return JSON.stringify({ query, sort, language, type, excludeTypes: [...(excludeTypes || [])].sort() });
}

function rememberSearch(key, ids) {
  if (searchCache.has(key)) searchCache.delete(key);
  searchCache.set(key, { ids, expiresAt: Date.now() + SEARCH_CACHE_TTL });
  while (searchCache.size > SEARCH_CACHE_MAX) {
    const oldest = searchCache.keys().next().value;
    searchCache.delete(oldest);
  }
}

function recallSearch(key) {
  const entry = searchCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    searchCache.delete(key);
    return null;
  }
  searchCache.delete(key);
  searchCache.set(key, entry);
  return entry.ids;
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

function mergeFilters(parsed, language, type, excludeTypes = []) {
  const extra = [];
  if (language) extra.push(`language:${language}`);
  if (type) extra.push(`type:${type}`);
  for (const excluded of excludeTypes) {
    if (excluded) extra.push(`-type:${excluded}`);
  }
  if (!extra.length) return parsed;
  return {
    ...parsed,
    tags: [...parsed.tags, ...hitomi.tags.parse(extra.join(' '))],
    rewritten: parsed.rewritten,
  };
}

function resolveSort(sort) {
  const map = {
    added: SortType.DateAdded,
    published: SortType.DatePublished,
    random: SortType.Random,
    today: SortType.PopularityDay,
    week: SortType.PopularityWeek,
    month: SortType.PopularityMonth,
    year: SortType.PopularityYear,
  };
  return map[sort] || SortType.DateAdded;
}

// nozomi ファイルは ID 1件 = 4バイト。Range 応答の Content-Range が持つ全体バイト数から
// 正確な総件数が割り出せる (本家 hitomi.la と同じやり方)。node-hitomi の request() は
// ヘッダを返してくれないので、ここだけ自前でリクエストする
const NOZOMI_HOST = 'ltn.gold-usergeneratedcontent.net';
const NOZOMI_ID_BYTES = 4;
const NOZOMI_TOTAL_TIMEOUT = 8000;

function requestNozomiTotal(path) {
  return new Promise((resolve, reject) => {
    const request = https.request({
      host: NOZOMI_HOST,
      path,
      agent: ownAgent,
      headers: { range: `bytes=0-${NOZOMI_ID_BYTES - 1}`, referer: 'https://hitomi.la/' },
    }, (response) => {
      response.resume();
      const matched = /\/(\d+)\s*$/.exec(response.headers['content-range'] || '');
      if (response.statusCode !== 206 || !matched) {
        reject(new Error(`nozomi range failed (${response.statusCode})`));
        return;
      }
      resolve(Math.floor(Number(matched[1]) / NOZOMI_ID_BYTES));
    });
    request.setTimeout(NOZOMI_TOTAL_TIMEOUT, () => request.destroy(new Error('nozomi range timeout')));
    request.on('error', reject);
    request.end();
  });
}

// canUseRemotePage が通る条件 (タグなし / language のみ / 非 language タグ1個) について、
// node-hitomi の list() がページ取得に使うのと同じ nozomi パスを組み立てる
function nozomiPathFor(parsed, sort) {
  try {
    const language = parsed.tags.find((tag) => tag.type === 'language');
    return GalleryManager.createNozomiPath({
      tag: parsed.tags.find((tag) => tag.type !== 'language'),
      orderBy: resolveSort(sort),
      language: language ? language.name : undefined,
    });
  } catch {
    return null;
  }
}

// 総件数は nozomi パスだけで決まるので、パスをそのままキャッシュキーにできる。
// 取れなければ null を返し、呼び出し側は従来の概算表示に落とす。
// キャッシュは追い読み (2頁目以降) のためのもの: 先頭頁では毎回引き直す。
// popular 系の nozomi は作り直しの最中に極端に小さい応答を返すことがあり、
// その値を持ち続けると再検索しても件数が壊れたままになる
async function remoteTotal(parsed, sort, allowFetch) {
  const path = nozomiPathFor(parsed, sort);
  if (!path) return null;
  if (!allowFetch) return totalCache.has(path) ? totalCache.get(path) : null;
  try {
    const total = await requestNozomiTotal(path);
    if (totalCache.has(path)) totalCache.delete(path);
    totalCache.set(path, total);
    while (totalCache.size > TOTAL_CACHE_MAX) {
      const oldest = totalCache.keys().next().value;
      totalCache.delete(oldest);
    }
    return total;
  } catch {
    // 引き直しに失敗したら前回の値で凌ぐ (無ければ概算表示に落ちる)
    return totalCache.has(path) ? totalCache.get(path) : null;
  }
}

// 「どちらも」を開いた組み合わせ。either が n 個なら 2^n 通りだが、
// 実際に来るのは札を押した 1 個だけ。増えても 2 個で打ち切り、それ以上は
// female に寄せる (往復が 8 回を超えると棚が出るまでが目に見えて遅くなる)
const EITHER_MAX = 2;
const EITHER_SIDES = ['female', 'male'];

function eitherCombinations(names) {
  const open = names.slice(0, EITHER_MAX);
  const fixed = names.slice(EITHER_MAX).map((name) => ({ type: 'female', name }));
  let rows = [fixed];
  for (const name of open) {
    const next = [];
    for (const row of rows) {
      for (const type of EITHER_SIDES) next.push([...row, { type, name }]);
    }
    rows = next;
  }
  return rows;
}

async function listIds(parsed, sort) {
  const base = { orderBy: resolveSort(sort) };
  if (parsed.title) base.title = parsed.title;
  const names = (parsed.either || []).filter(Boolean);

  if (!names.length) {
    const options = { ...base };
    if (parsed.tags.length) options.tags = parsed.tags;
    const refs = await hitomi.galleries.list(options);
    return refs.map((ref) => ref.id);
  }

  // female の並びを先に置き、male にしか無いぶんを後ろへ足す。
  // node-hitomi の AND は「先頭のタグの nozomi の並び」をそのまま結果の並びに
  // するので (後続は削るだけ)、この合わせ方でも並びの筋は今までと同じ
  const seen = new Set();
  const out = [];
  for (const extra of eitherCombinations(names)) {
    const options = { ...base, tags: [...parsed.tags, ...hitomi.tags.parse(
      extra.map((item) => `${item.type}:${item.name.replace(/\s+/g, '_')}`).join(' '),
    )] };
    let refs = [];
    try {
      refs = await hitomi.galleries.list(options);
    } catch {
      continue; // 片方が存在しない型でも、もう片方だけで結果は出す
    }
    for (const ref of refs) {
      if (seen.has(ref.id)) continue;
      seen.add(ref.id);
      out.push(ref.id);
    }
  }
  return out;
}

// A missing tag index is an empty match, while outages/auth errors remain errors.
async function search(payload = {}) {
  try { return await searchOnce(payload); }
  catch (error) {
    const message = String(error?.message || error);
    const tagged = parseQuery(payload.query || '').tags.length > 0;
    if (!tagged || !/\.nozomi/.test(message) || !/\b404\b/.test(message)) throw error;
    if (payload.sort && payload.sort !== 'added') {
      const result = await search({...payload, sort:'added'});
      return {...result, notice: result.galleries.length ? 'この条件の人気順がないため、新しい順で表示しています' : result.notice};
    }
    return {galleries:[],total:0,page:Math.max(0,Number(payload.page)||0),pageSize:Math.max(1,Math.min(60,Number(payload.pageSize)||24)),hasNext:false,query:payload.query||'',notice:'この検索語に一致する作品はありません。作者の別名義・表記もお試しください。'};
  }
}

async function searchOnce({ query = '', sort = 'added', sortDir = 'desc', language = '', type = '', excludeTypes = [], page = 0, pageSize = 24 } = {}) {
  const parsed = mergeFilters(parseQuery(query), language, type, excludeTypes);
  const size = Math.max(1, Math.min(60, Number(pageSize) || 24));
  const index = Math.max(0, Number(page) || 0);
  const rewrittenQuery = parsed.rewritten?.query || nfkc(query).trim();
  const interpreted = parsed.rewritten?.resolved || [];

  if (parsed.id) {
    const gallery = await getGallery(parsed.id);
    return {
      total: 1,
      page: 0,
      pageSize: size,
      query: rewrittenQuery,
      interpreted,
      galleries: [serializeGallery(gallery)],
    };
  }

  // 昇順はサーバーのページ切り出しでは作れない (nozomi は新しい順で固定)。
  // ID リストを丸ごと取ってから手元で裏返す経路に落とす
  const ascending = sortDir === 'asc' && sort !== 'random';

  if (!ascending && canUseRemotePage(parsed)) {
    const options = {
      orderBy: resolveSort(sort),
      page: { index, size },
    };
    if (parsed.tags.length) options.tags = parsed.tags;
    // 総件数の取得は先頭ページのときだけ。追い読みではキャッシュに載っていれば使う
    const [refs, total] = await Promise.all([
      hitomi.galleries.list(options).catch((error) => {
        // 結果がページ境界ちょうど (24件=1頁 等) のとき、次頁の Range 要求が
        // nozomi ファイルの末尾を越えて 416 が返る。「その頁は空」の意味なので
        // エラーにせず空で返す
        if (/416/.test(String(error && error.message))) return [];
        throw error;
      }),
      remoteTotal(parsed, sort, index === 0),
    ]);
    // nozomi は作り直しの最中に途中までしか無い応答を返すことがある (popular 系で実測)。
    // 総件数が「まだ続きがある」と言うのに頁が短いときは、この応答を信じず
    // フルリスト経路に落とす (そちらは引き直しなので、欠けが直っていれば拾える)
    const short = total !== null && refs.length < size && index * size + refs.length < total;
    if (!short) {
      const galleries = await mapLimit(refs, 8, async (ref) => {
        try {
          return serializeGallery(await getGallery(ref.id));
        } catch (error) {
          return { id: ref.id, error: error.message || String(error) };
        }
      });
      return {
        // 総件数の応答だけが壊れて小さくても、読めている枚数より下には出さない
        total: total === null ? refs.length : Math.max(total, index * size + refs.length),
        approximate: total === null ? refs.length === size : false,
        page: index,
        pageSize: size,
        query: rewrittenQuery,
        interpreted,
        galleries,
      };
    }
  }

  const key = searchKey(query, sort, language, type, excludeTypes);
  let ids = recallSearch(key);
  if (!ids) {
    ids = await listIds(parsed, sort);
    rememberSearch(key, ids);
  }

  // キャッシュは正順のまま持ち、昇順は切り出す直前に裏返す (向きの切替でも引き直さない)
  const ordered = ascending ? [...ids].reverse() : ids;
  const slice = ordered.slice(index * size, index * size + size);
  const galleries = await mapLimit(slice, 8, async (id) => {
    try {
      return serializeGallery(await getGallery(id));
    } catch (error) {
      return { id, error: error.message || String(error) };
    }
  });

  return {
    total: ids.length,
    page: index,
    pageSize: size,
    query: rewrittenQuery,
    interpreted,
    galleries,
  };
}

async function suggestTags(term) {
  const text = nfkc(term).trim();
  if (!canSuggestTerm(text)) return [];

  // 辞書には hitomi に無い語 (pixiv 専用の VTuber) も居る。hitomi の候補には出さない
  const { forSite } = require('./search-decorate');
  const { loadData } = require('./search-aliases');
  const aliases = suggestAliases(text, 8)
    .filter((item) => forSite(loadData().byValue.get(item.value) || item, 'hitomi'));
  const seen = new Set(aliases.map((item) => item.value));
  let remote = [];
  if (shouldQueryRemoteTags(text)) {
    try {
      const results = await hitomi.tags.search(text);
      remote = results.slice(0, 12).map(([tag, count]) => ({
        type: tag.type,
        name: tag.name,
        value: tag.toString(),
        label: '',
        count,
        metric: {site:'hitomi',kind:'works',value:count,scope:'tag',observedAt:Date.now()},
        source: 'tag',
      })).filter((item) => {
        if (seen.has(item.value)) return false;
        seen.add(item.value);
        return true;
      });
    } catch {
      remote = [];
    }
  }

  return [...aliases, ...remote].slice(0, 12);
}

function pickExtension(image) {
  if (image.hasWebp) return Extension.Webp;
  if (image.hasAvif) return Extension.Avif;
  return Extension.Webp;
}

function pickThumbSize(size) {
  if (size === 'big') return ThumbnailSize.Big;
  if (size === 'medium') return ThumbnailSize.Medium;
  return ThumbnailSize.Small;
}

function contentTypeFor(ext) {
  if (ext === Extension.Avif) return 'image/avif';
  if (ext === Extension.Jxl) return 'image/jxl';
  return 'image/webp';
}

async function fetchImage(galleryId, fileIndex, { size = 'full' } = {}) {
  const cacheKey = size === 'full' ? null : `${galleryId}:${fileIndex}:${size}`;
  if (cacheKey && imageCache.has(cacheKey)) {
    return imageCache.get(cacheKey);
  }

  const gallery = await getGallery(galleryId);
  const image = gallery.files[fileIndex];
  if (!image) {
    const error = new Error('image not found');
    error.status = 404;
    throw error;
  }

  const ext = pickExtension(image);
  // 原寸は置き場の表 (gg.js) から道を組む: 落ちたら一回だけ引き直す (表が古ければ表から)
  const full = () => withRetry(() => image.fetch(ext), { image: true });
  let result;
  if (size === 'full' || !image.hasThumbnail) {
    const bytes = await full();
    result = { bytes, type: contentTypeFor(ext), name: image.name };
  } else {
    const thumbSize = pickThumbSize(size);
    try {
      const bytes = await image.fetch(
        thumbSize === ThumbnailSize.Medium ? Extension.Avif : ext,
        thumbSize,
      );
      result = {
        bytes,
        type: thumbSize === ThumbnailSize.Medium ? 'image/avif' : contentTypeFor(ext),
        name: image.name,
      };
    } catch {
      const bytes = await full();
      result = { bytes, type: contentTypeFor(ext), name: image.name };
    }
  }

  if (cacheKey) {
    imageCache.set(cacheKey, result);
    while (imageCache.size > IMAGE_CACHE_MAX) {
      const oldest = imageCache.keys().next().value;
      imageCache.delete(oldest);
    }
  }
  return result;
}

function sanitizeName(name) {
  return String(name || 'untitled')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'untitled';
}

// 試験用の継ぎ目。語の解析から ID の並びまでを、網に出ずに確かめるため
// (either を開く所は分岐が多く、実物の検索越しでは押さえにくい)
async function __testListIds(query, sort = 'added') {
  return listIds(parseQuery(query), sort);
}

module.exports = {
  __testListIds,
  hitomi,
  search,
  getGallery,
  serializeGallery,
  pickTitle,
  suggestTags,
  parseQuery,
  fetchImage,
  sanitizeName,
  SortType,
  Extension,
  _internals: {
    rememberSearch, recallSearch, searchCache, SEARCH_CACHE_TTL, withRetry, retryKind, freshScope, galleryCache,
  },
};
