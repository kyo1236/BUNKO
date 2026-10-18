const { get } = require('../http');
const {
  tag, pickJapanese, record, stripCircleDecorations,
} = require('./normalize');
const { createRemotePager } = require('./remote-pages');
// 一覧はタグを番号でしか寄越さない。番号 -> 名前 の控えはここが持つ
const tagDict = require('./nhentai-tag-dict');
// 札の語は hitomi の言い方で来る。こちらの言い方へ直してから投げる
const { forNhentai } = require('./tag-query');

const DETAIL_TTL = 24 * 60 * 60 * 1000;
const CACHE_MAX = 1500;
const cache = new Map();
const detailInflight = new Map();

// この置き場の顔。main 側の「外部ブラウザで開いて良い先」もここを集めて決める
const hosts = ['nhentai.net'];

const GALLERY_URL = /nhentai\.net\/g\/(\d+)/i;

// 検索欄に貼られた URL を「この置き場のこの画廊」と読む。
// 他所の URL なら null を返し、次のアダプタに渡す
function detectUrl(text) {
  const hit = String(text).match(GALLERY_URL);
  return hit ? { source: 'nhentai', query: hit[1] } : null;
}

function mediaUrl(path, kind) {
  const clean = String(path || '').replace(/^\/+/, '');
  const host = kind === 'thumb' ? 'https://t.nhentai.net' : 'https://i.nhentai.net';
  return `${host}/${clean}`;
}

function languageFromTags(tags) {
  const lang = (tags || []).find((item) => item.type === 'language' && item.name !== 'translated' && item.name !== 'rewrite');
  return lang ? { name: lang.name, localName: lang.name } : null;
}

function typeFromTags(tags) {
  const cat = (tags || []).find((item) => item.type === 'category' || item.type === 'tag' && ['doujinshi', 'manga'].includes(item.name));
  return cat ? cat.name.replace(/\s+/g, '') : 'doujinshi';
}

// nhentai のタグを hitomi と同じ棚 (作者・グループ・原作・キャラ・タグ) に分ける。
// category と language はタグの列に混ぜない: どちらも「種別」「言語」の行として
// 別に出しているので、混ぜると同じ語が二度出る (hitomi の詳細はそうならない)
function splitTags(tags) {
  const groups = {
    artists: [], groups: [], series: [], characters: [], tags: [],
  };
  for (const item of tags || []) {
    const mapped = tag(item.type === 'parody' ? 'series' : item.type, item.name);
    if (item.type === 'artist') groups.artists.push(mapped);
    else if (item.type === 'group') groups.groups.push(mapped);
    else if (item.type === 'parody') groups.series.push(mapped);
    else if (item.type === 'character') groups.characters.push(mapped);
    else if (item.type !== 'category' && item.type !== 'language') groups.tags.push(mapped);
  }
  return groups;
}

function serialize(detail) {
  const tags = detail.tags || [];
  const parts = splitTags(tags);
  // nhentai の題は E-Hentai 式 ((イベント)[サークル]題(原作))。素の題に直す:
  // 札が hitomi と揃い、所持照合も噛み合う
  const title = stripCircleDecorations(
    pickJapanese(detail.title?.english, detail.title?.japanese) || detail.title?.pretty || String(detail.id),
  );
  return record({
    id: `nh:${detail.id}`,
    source: 'nhentai',
    title,
    type: typeFromTags(tags),
    language: languageFromTags(tags),
    ...parts,
    pageCount: (detail.pages || []).length || detail.num_pages || 0,
    addedDate: detail.upload_date ? new Date(detail.upload_date * 1000).toISOString() : null,
    url: `https://nhentai.net/g/${detail.id}/`,
  });
}

// 一覧の行。v2 の検索が行にタグを載せてくれるなら、そのまま札へ通す
// (載っていなければ今までどおり空: 詳細を開いた時に serialize が埋める)。
// **一覧のために detail を人数ぶん引きに行かない** — 札の数だけ往復が増える
function serializeListItem(item) {
  // 一覧はタグを番号 (tag_ids) でしか寄越さない。控えで名前に戻してから札へ通す
  const expanded = Array.isArray(item.tag_ids) ? tagDict.expand(item.tag_ids) : [];
  const tags = Array.isArray(item.tags) ? item.tags
    : (expanded.length ? expanded : null);
  return record({
    id: `nh:${item.id}`,
    source: 'nhentai',
    title: stripCircleDecorations(
      pickJapanese(item.english_title, item.japanese_title) || item.english_title || String(item.id),
    ),
    type: tags ? typeFromTags(tags) : 'doujinshi',
    ...(tags ? { language: languageFromTags(tags) } : {}),
    ...(tags ? splitTags(tags) : {}),
    pageCount: item.num_pages || 0,
    url: `https://nhentai.net/g/${item.id}/`,
    // 札の表紙はこの thumbnail そのもの (fetchImage の index 0)。寸法が分かれば流しが跳ばない
    width: item.thumbnail_width,
    height: item.thumbnail_height,
  });
}

function remember(detail) {
  // 詳細は名前付きで返る: 只で覚えておくと、次の一覧で網に訊かずに済む
  try { tagDict.learn(detail.tags); } catch { /* 控えが書けなくても詳細は出る */ }
  cache.set(String(detail.id), { value: detail, at: Date.now() });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return detail;
}

async function getDetail(id) {
  const key = String(id);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at <= DETAIL_TTL) return cached.value;
  if (detailInflight.has(key)) return detailInflight.get(key);
  const pending = get(`https://nhentai.net/api/v2/galleries/${key}`).then((res) => {
    const detail = res.json();
    if (detail.error) throw new Error(detail.error);
    return remember(detail);
  }).finally(() => detailInflight.delete(key));
  detailInflight.set(key, pending);
  return pending;
}

function buildQuery(query, language, type) {
  const parts = [];
  // female:/male:/either: と下線は nhentai では通らない (実測で 0〜3 件)。
  // tag:"..." の形へ直してから渡す
  const translated = forNhentai(query);
  if (translated) parts.push(translated);
  if (language) parts.push(`language:${language}`);
  if (type === 'doujinshi' || type === 'manga') parts.push(type);
  else if (type === 'artistcg') parts.push('artistcg');
  else if (type === 'imageset') parts.push('imageset');
  return parts.join(' ').trim() || 'pages:>0';
}

// v2 が受け取る並びは date / popular / popular-today / popular-week / popular-month の
// 5 つだけ。外れた値は 400 で撥ねられる (以前の 'recent' がこれで、検索が全滅していた)
function mapSort(sort) {
  if (sort === 'today') return 'popular-today';
  if (sort === 'week') return 'popular-week';
  if (sort === 'month') return 'popular-month';
  if (sort === 'year') return 'popular';
  return 'date';
}

const loadSearchPage = createRemotePager(async (remotePage, key, { signal } = {}) => {
  const { q, sortKey } = JSON.parse(key);
  const params = new URLSearchParams({ query: q, page: String(remotePage + 1), sort: sortKey });
  const data = (await get(`https://nhentai.net/api/v2/search?${params}`, {}, { signal, priority: 10 })).json();
  return {
    rows: data.result || [],
    total: Number(data.total),
    hasNext: (remotePage + 1) * (Number(data.per_page) || (data.result || []).length) < Number(data.total),
  };
});

async function search({ query = '', language = '', type = '', sort = 'added', page = 0, pageSize = 24, signal } = {}) {
  const q = buildQuery(query, language, type);
  if (/^\d{3,}$/.test(query.trim())) {
    const detail = await getDetail(query.trim());
    return { total: 1, page: 0, pageSize, galleries: [serialize(detail)] };
  }
  const sortKey = mapSort(sort);
  const loaded = await loadSearchPage(JSON.stringify({ q, sortKey }), page, pageSize, { signal });
  // 札に出すタグの番号を名前に戻す。控えで足りるぶんは只、足りないぶんだけ
  // まとめて訊く (100 ずつ)。持ち時間を超えたら諦めて棚を先に出す —
  // タグが一拍遅れるのは我慢できるが、棚が出ないのは我慢できない
  try {
    await tagDict.resolve(loaded.rows.flatMap((item) => item.tag_ids || []), { get, signal });
  } catch {
    // 引けなくても一覧は出す (タグが付かないだけ)
  }
  const galleries = loaded.rows.map((item) => {
    if (item.media_id) {
      cache.set(`list:${item.id}`, item);
      while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    }
    return serializeListItem(item);
  });
  return {
    total: loaded.total,
    approximate: false,
    hasNext: loaded.hasNext,
    page,
    pageSize,
    galleries,
  };
}

async function getGallery(id) {
  return serialize(await getDetail(id));
}

async function fetchImage(id, index, { size = 'full', signal, priority = 0 } = {}) {
  const listed = cache.get(`list:${id}`);
  if ((size === 'small' || size === 'big' || size === 'medium') && index === 0 && listed?.thumbnail) {
    const res = await get(mediaUrl(listed.thumbnail, 'thumb'), { Referer: 'https://nhentai.net/' }, { signal, priority });
    return { bytes: res.buffer, type: res.headers['content-type'] || 'image/webp', name: 'thumb.webp' };
  }
  const detail = await getDetail(id);
  const page = (detail.pages || [])[index];
  if (!page) {
    const error = new Error('image not found');
    error.status = 404;
    throw error;
  }
  const thumb = size !== 'full';
  const path = thumb ? (page.thumbnail || detail.thumbnail?.path) : page.path;
  const res = await get(mediaUrl(path, thumb ? 'thumb' : 'full'), { Referer: 'https://nhentai.net/' }, { signal, priority });
  return { bytes: res.buffer, type: res.headers['content-type'] || 'image/webp', name: path.split('/').pop() };
}

// serializeListItem は試験から直に確かめる (一覧の行にタグが載るかどうかは
// 網の返事しだいで、こちらでは選べない。せめて「載っていたら通す」を固定する)
module.exports = {
  search, getGallery, fetchImage, hosts, detectUrl, serializeListItem,
};
