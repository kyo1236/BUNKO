'use strict';
const { splitAuthorQuery, matchesSearchWords } = require('../search-type');

// pixiv の源泉。BUNKO 自身が落とし手 (docs/adr/0001)。
// 網の口は src/lib/pixiv/api.js、作法は pixiv/manners.js、所持の台帳は pixiv/library.js。
// ここはアダプタの顔 (search / getGallery / fetchImage / hosts / detectUrl / suggestTags) だけ。
//
// 一覧の種類は「並び」の選択と検索欄の語で決まる (docs/pixiv-design-2026-09-19.md §4, §15 U1):
//   空 + フォロー (follow)        = フォロー新着
//   空 + 新しい順 (added)         = pixiv の新着作品 (/v1/illust/new)
//   空 + 人気・今日/今週/今月     = ランキング day / week / month (漫画なら *_manga、R-18 なら *_r18)
//   空 + 人気・全期間 (year)      = ランキング month (全期間の口が無い。結果の行で一言)
//   空 + 候補 (bookmarks)         = ブックマーク (公開 + 非公開を合流)
//   語 + 新しい順                 = 検索 date_desc (部分一致。"語" か exact: で完全一致)
//   語 + 人気・…                  = 検索 popular_desc + 期間 (1 / 7 / 30 日 / 無し)
//   語 + フォロー                 = pixiv 全体の検索 date_desc (フォロー新着を語で漉すと 30 件ずつしか
//                                   見えず pixiv の検索と食い違う。画面は select を「新しい順」に倒す)
//   語 + 候補                     = 読み込んだブックマークを語で絞る
//   user:<id>                     = 作者の投稿 (漫画は API に渡す)
//   id:<n> / 数字だけ / URL       = 詳細一枚
//   since: / until: / date:       = 期間と日付の指定
//
// 種別と AI と語の間引きは、遠隔の一頁を取る所 (fetchPage) で行う。pager が足りないぶんを
// 次の頁で埋めるので棚が疎らにならない。空の頁が続いたら打ち切る (§15 U6)。
// 辞書の言い換え (rewriteQuery) は通さない: 通常語を題・キャプション検索へ渡す (exact: はタグ完全一致)

const { captionText } = require('../pixiv/caption');
const { record, tag } = require('./normalize');
const { createRemotePager } = require('./remote-pages');
const { nextCursor, PAGE } = require('../pixiv/api');
const pixiv = require('../pixiv');

// この置き場の顔。main 側の「外部ブラウザで開いて良い先」もここを集めて決める
const hosts = ['www.pixiv.net', 'pixiv.net'];
// 辞書 (search-aliases) の言い換えを受けない
const rewritesAliases = false;

// 投稿の URL。/artworks/<id> (新)、member_illust.php?illust_id= (旧)、/i/<id> (短縮)
const ARTWORK_URL = /pixiv\.net\/(?:en\/)?artworks\/(\d+)/i;
const ARTWORK_URL_OLD = /pixiv\.net\/member_illust\.php\?(?:[^#\s]*&)?illust_id=(\d+)/i;
const ARTWORK_URL_SHORT = /pixiv\.net\/i\/(\d+)/i;
// 作者の URL。/users/<id> (新)、member.php?id= (旧)
const USER_URL = /pixiv\.net\/(?:en\/)?users\/(\d+)/i;
const USER_URL_OLD = /pixiv\.net\/member\.php\?(?:[^#\s]*&)?id=(\d+)/i;

const DETAIL_TTL = 24 * 60 * 60 * 1000;
const CACHE_MAX = 1500;
// 投稿の控え (一覧の行と詳細を同じ箱に)。頁の URL は一覧の行にも載っているので、
// 落とす時に詳細を引き直さずに済む
const cache = new Map();
const detailInflight = new Map();
// 補完の控え (接頭辞ごと)。打鍵のたびに網へ出ない
const suggestCache = new Map();
const SUGGEST_TTL = 10 * 60 * 1000;
// 間引いた頁が空のまま続いたら打ち切る数
const EMPTY_PAGE_LIMIT = 4;

const RANK_BY_SORT = { today: 'day', week: 'week', month: 'month', year: 'month' };
const DAYS_BY_SORT = { today: 1, week: 7, month: 30, year: 0 };
const R18_TAG = 'R-18';

// 検索欄に貼られた URL を「この置き場のこの投稿 (または作者)」と読む。
// 他所の URL なら null を返し、次のアダプタに渡す
function detectUrl(text) {
  const value = String(text || '');
  const work = value.match(ARTWORK_URL) || value.match(ARTWORK_URL_OLD) || value.match(ARTWORK_URL_SHORT);
  if (work) return { source: 'pixiv', query: work[1] };
  const user = value.match(USER_URL) || value.match(USER_URL_OLD);
  if (user) return { source: 'pixiv', query: `user:${user[1]}` };
  return null;
}

// --- 検索欄の語を読む ------------------------------------------------------

function parseQuery(raw) {
  const out = {
    words: [], user: null, id: null, exact: false, since: '', until: '', date: '', bm: null, bookmarks: false,
  };
  let text = String(raw || '').trim();
  // "語" は完全一致。引用の中は空白ごと一語
  text = text.replace(/"([^"]+)"/g, (_, quoted) => {
    const word = quoted.trim();
    if (word) {
      out.words.push(word);
      out.exact = true;
    }
    return ' ';
  });
  for (const token of text.split(/\s+/).filter(Boolean)) {
    const typed = token.match(/^(user|id|exact|since|until|date|bm|bookmarks):(.*)$/i);
    if (!typed) {
      if (/^\d{5,}$/.test(token) && !out.id) out.id = token;
      else out.words.push(token);
      continue;
    }
    const key = typed[1].toLowerCase();
    const value = typed[2].trim();
    if (key === 'user' && /^\d+$/.test(value)) out.user = value;
    else if (key === 'id' && /^\d+$/.test(value)) out.id = value;
    else if (key === 'exact') { out.exact = true; if (value) out.words.push(value); }
    else if (key === 'since' && isDate(value)) out.since = value;
    else if (key === 'until' && isDate(value)) out.until = value;
    else if (key === 'date' && isDate(value)) out.date = value;
    else if (key === 'bm') { out.bookmarks = true; out.bm = /^(private|public|all)$/i.test(value) ? value.toLowerCase() : null; }
    else if (key === 'bookmarks') out.bookmarks = true;
  }
  return out;
}

function isDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function ymd(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function daysAgo(days, now = new Date()) {
  const date = new Date(now.getTime());
  date.setDate(date.getDate() - days);
  return ymd(date);
}

function monthAgo(now) {
  const date = new Date(now.getTime());
  const day = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() - 1);
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(day, lastDay));
  return ymd(date);
}

// --- 札の形 --------------------------------------------------------------

function remember(illust) {
  if (!illust || !illust.id) return illust;
  cache.set(String(illust.id), { value: illust, at: Date.now() });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return illust;
}

function cached(id) {
  const hit = cache.get(String(id));
  if (!hit) return null;
  if (Date.now() - hit.at > DETAIL_TTL) return null;
  return hit.value;
}

function artworkUrl(id) {
  return `https://www.pixiv.net/artworks/${id}`;
}

function serialize(illust) {
  const id = String(illust.id);
  const kind = String(illust.type || 'illust');
  const user = illust.user || {};
  const tags = Array.isArray(illust.tags) ? illust.tags : [];
  const width = Number(illust.width) || 0;
  const height = Number(illust.height) || 0;
  const base = record({
    id: `px:${id}`,
    source: 'pixiv',
    title: String(illust.title || '').trim() || id,
    type: kind,
    artists: user.name ? [{ ...tag('artist', user.name), userId: String(user.id || '') }] : [],
    tags: tags.map((item) => {
      const t = tag('tag', item.name);
      if (item.translated_name) t.label = String(item.translated_name);
      return t;
    }),
    pageCount: Number(illust.page_count) || 0,
    publishedDate: illust.create_date ? String(illust.create_date) : null,
    url: artworkUrl(id),
    badge: kind === 'ugoira' ? 'うごイラ' : '',
  });
  return {
    ...base,
    caption: captionText(illust.caption),
    userId: String(user.id || ''),
    ai: Number(illust.illust_ai_type) === 2,
    r18: Number(illust.x_restrict) > 0,
    bookmarked: illust.is_bookmarked === true,
    bookmarks: Number(illust.total_bookmarks) || 0,
    // pixiv 側でミュートした作者・タグの投稿 (アプリと同じく出さない。passes が見る)
    muted: illust.is_muted === true,
    width,
    height,
    // 横長・正方の絵は表紙の切り方を変える (§15 U7)
    shape: width && height && width > height * 1.15 ? 'wide' : 'tall',
    series: illust.series && illust.series.id
      ? { id: String(illust.series.id), title: String(illust.series.title || '') }
      : null,
    // うごイラは本にしない (要件 D4)。札には印だけ出し、頁は無い物として扱う
    ...(kind === 'ugoira' ? { pageCount: 0, unbindable: true } : {}),
  };
}

// 作者の顔 (profile image) の URL の控え。作者の札の表紙はここから引く: 札ごとに user/detail を
// 叩くと 30 人で 30 往復になり、API 車線の 100 件の間隔 (1.6 秒) に掛かる
const profileImages = new Map();
const PROFILE_MAX = 500;

function rememberProfile(userId, url) {
  if (!userId || !url) return;
  profileImages.set(String(userId), String(url));
  while (profileImages.size > PROFILE_MAX) profileImages.delete(profileImages.keys().next().value);
}

// 作者の札。user/detail の返事 ({ user, profile }) からも、おすすめの user_previews ({ user }) からも作る
function creatorCard(detail) {
  const user = (detail && detail.user) || {};
  const profile = (detail && detail.profile) || {};
  const id = String(user.id || '');
  const works = (Number(profile.total_illusts) || 0) + (Number(profile.total_manga) || 0);
  if (user.profile_image_urls && user.profile_image_urls.medium) rememberProfile(id, user.profile_image_urls.medium);
  return {
    ...record({
      id: `pxu:${id}`,
      source: 'pixiv',
      title: String(user.name || id),
      artists: user.name ? [{ ...tag('artist', user.name), userId: id }] : [],
      url: `https://www.pixiv.net/users/${id}`,
      kind: 'creator',
      badge: works ? `${works} 件` : '',
    }),
    userId: id,
    query: `user:${id}`,
    account: String(user.account || ''),
    profileImage: user.profile_image_urls ? String(user.profile_image_urls.medium || '') : '',
    following: user.is_followed === true,
  };
}

// --- 網の一覧 --------------------------------------------------------------

function loggedIn() {
  const auth = pixiv.auth();
  return !(auth && typeof auth.loggedIn === 'function' && !auth.loggedIn());
}

function requireLogin() {
  if (loggedIn()) return;
  const error = new Error('pixiv にログインしていません (設定 → 取り込み → pixiv)');
  error.status = 401;
  error.code = 'pixiv-login';
  throw error;
}

async function getDetail(id) {
  const key = String(id);
  const hit = cached(key);
  if (hit && hit.__detail) return hit;
  if (detailInflight.has(key)) return detailInflight.get(key);
  const pending = pixiv.api().illustDetail(key).then((illust) => {
    if (!illust) {
      const error = new Error('投稿が見つかりません');
      error.status = 404;
      throw error;
    }
    return remember({ ...illust, __detail: true });
  }).finally(() => detailInflight.delete(key));
  detailInflight.set(key, pending);
  return pending;
}

// 一覧の行を控えに入れつつ札にする。詳細より古い行で詳細を潰さない
function rowsToGalleries(rows) {
  return (rows || []).map((illust) => {
    const known = cached(illust.id);
    if (!known || !known.__detail) remember(illust);
    return serialize(illust);
  });
}

// 画面の種別の語 (state.type)。種類 (漫画 / AI) と対象 (R-18) を '-' で繋ぐ:
// '' / manga / ai / r18 / manga-r18 / ai-r18。renderer の pixivTypeParts と同じ読み方
// (test/cross-source が突き合わせる)
function typeParts(type) {
  const tokens = String(type || '').split('-');
  return {
    kind: tokens.includes('manga') ? 'manga' : tokens.includes('ai') ? 'ai' : '',
    r18: tokens.includes('r18'),
  };
}

// AI 生成のランキングは日間だけ (通常のランキングには AI 生成が載らない)
function aiRankMode(r18) {
  return r18 ? 'day_r18_ai' : 'day_ai';
}
const AI_RANK_NOTE = 'pixiv の AI 生成ランキングは日間だけなので日間を出しています';

// 検索欄と並びから一覧の種類を決める
function planFor({ query, sort, type, pixivPeriod }, parsed, settings = {}, now = new Date()) {
  const parts = typeParts(type);
  const kind = parts.kind === 'manga' ? 'manga' : parts.r18 ? 'r18' : '';
  // AI だけを見る種別。AI を隠す設定より種別が勝つ (隠したままでは棚が必ず空になる)。
  // AI だけの口は API に無い (search_ai_type は「隠す」だけ): ランキング以外は札の側で間引く
  const aiOnly = parts.kind === 'ai';
  const hideAi = settings.hideAi === true && !aiOnly;
  // 札の側の間引き。API が絞れる物は API に任せ、ここは残りだけ
  const filter = { manga: kind === 'manga', r18: parts.r18, hideAi, aiOnly, words: [] };

  if (sort === 'recommended' && !parsed.user && !parsed.bookmarks) {
    return { mode: 'recommended', filter: { ...filter, words: parsed.words } };
  }
  const extraRanks = { rookie: 'week_rookie', original: 'week_original', male: 'day_male', female: 'day_female' };
  if (extraRanks[sort] && !parsed.user && !parsed.bookmarks && !parsed.words.length) {
    if (aiOnly) {
      return { mode: 'ranking', rankMode: aiRankMode(parts.r18), date: parsed.date, note: AI_RANK_NOTE, filter: { ...filter, manga: false, r18: false } };
    }
    let rankMode = extraRanks[sort];
    if (kind === 'manga') rankMode = 'day_manga';
    else if (kind === 'r18') rankMode = ['male','female'].includes(sort) ? `${rankMode}_r18` : 'day_r18';
    return { mode: 'ranking', rankMode, date: parsed.date, filter: { ...filter, manga: false, r18: false } };
  }

  if (parsed.user) {
    return { mode: 'user', user: parsed.user, type: kind === 'manga' ? 'manga' : '', filter: { ...filter, manga: false, searchWords: parsed.words.join(' ') } };
  }
  if (parsed.bookmarks || sort === 'bookmarks') {
    const user = pixiv.auth().user;
    const restrict = parsed.bm || (settings.bookmarkPrivate === false ? 'public' : 'all');
    return {
      mode: 'bookmarks', userId: user ? String(user.id) : '', restrict, filter: { ...filter, words: parsed.words },
    };
  }
  const word = parsed.words.join(' ').trim();
  // フォロー + 語 は pixiv 全体の検索 (下の search へ)。フォロー新着を語で漉すと、30 件ずつ
  // 読んでは空になり、pixiv で検索した結果と食い違う (2026-09-19 の利用者の指摘)
  if (sort === 'follow' && !word) {
    return { mode: 'follow', filter };
  }
  if (word) {
    const popular = Object.prototype.hasOwnProperty.call(RANK_BY_SORT, sort);
    const period = pixivPeriod === undefined ? (popular ? sort : 'year') : pixivPeriod;
    const days = DAYS_BY_SORT[period] || 0;
    return {
      mode: 'search',
      // R-18 は語として足す (pixiv の検索に R-18 だけの口が無い)
      word: filter.r18 && !parsed.words.includes(R18_TAG) ? `${word} ${R18_TAG}` : word,
      exact: parsed.exact,
      sortKey: popular ? 'popular_desc' : 'date_desc',
      since: parsed.since || (period === 'today' ? ymd(now) : period === 'month' ? monthAgo(now) : days ? daysAgo(days, now) : ''),
      until: parsed.until || '',
      hideAi,
      // AI を隠すのは API が除く。R-18 は語で絞った。漫画と AI だけは札の側
      filter: { ...filter, r18: false, hideAi: false },
    };
  }
  if (Object.prototype.hasOwnProperty.call(RANK_BY_SORT, sort) && aiOnly) {
    return {
      mode: 'ranking',
      rankMode: aiRankMode(parts.r18),
      date: parsed.date,
      note: sort === 'today' ? '' : AI_RANK_NOTE,
      // 口が AI 生成だけを返す。札の側の aiOnly は念のための網
      filter: { ...filter, manga: false, r18: false },
    };
  }
  if (Object.prototype.hasOwnProperty.call(RANK_BY_SORT, sort)) {
    const base = RANK_BY_SORT[sort];
    let rankMode = base;
    if (kind === 'manga') rankMode = `${base}_manga`;
    else if (kind === 'r18') rankMode = base === 'day' ? 'day_r18' : 'week_r18';
    return {
      mode: 'ranking',
      rankMode,
      date: parsed.date,
      note: sort === 'year' ? 'pixiv に全期間のランキングは無いので今月を出しています' : '',
      // ランキングは漫画と R-18 を口が絞る。AI だけ札の側
      filter: { ...filter, manga: false, r18: false },
    };
  }
  // The global new feed excludes adult works; use the R-18 tag in date order.
  if (filter.r18) {
    return { mode: 'search', word: R18_TAG, exact: false, sortKey: 'date_desc',
      since: parsed.since || '', until: parsed.until || '', hideAi,
      filter: { ...filter, r18: false, hideAi: false } };
  }
  // 新しい順 + 空 = pixiv 全体の新着作品
  return {
    mode: 'new',
    contentType: kind === 'manga' ? 'manga' : 'illust',
    filter: { ...filter, manga: false },
  };
}

function matchesWords(gallery, words) {
  if (!words || !words.length) return true;
  const hay = [gallery.title, ...(gallery.tags || []).map((t) => `${t.name} ${t.label || ''}`)].join(' ').toLowerCase();
  return words.every((word) => hay.includes(String(word).toLowerCase()));
}

function passes(gallery, filter) {
  // pixiv 側でミュートした作者・タグの投稿は、pixiv のアプリと同じく出さない
  if (gallery && gallery.muted === true) return false;
  if (!filter) return true;
  if (filter.searchWords && !matchesSearchWords([gallery.title, gallery.caption, ...(gallery.tags || []).map(t => t.name)].join(' '), filter.searchWords)) return false;
  if (filter.manga && gallery.type !== 'manga') return false;
  if (filter.r18 && !gallery.r18) return false;
  if (filter.hideAi && gallery.ai) return false;
  if (filter.aiOnly && !gallery.ai) return false;
  if (filter.words && filter.words.length && !matchesWords(gallery, filter.words)) return false;
  return true;
}

// 一覧の一頁 (30 件) を取る口。種類ごとに API の呼び方だけ違う
function fetchRows(plan, cursor, signal) {
  const offset = cursor.offset || 0;
  const api = pixiv.api();
  switch (plan.mode) {
    case 'recommended':
      return api.illustRecommended({ offset, signal });
    case 'follow':
      return api.illustFollow({ restrict: 'all', offset, signal });
    case 'new':
      return api.illustNew({ contentType: plan.contentType, ...cursor, signal });
    case 'ranking':
      return api.ranking({ mode: plan.rankMode, date: plan.date, offset, signal });
    case 'search':
      return api.searchIllust(plan.word, {
        target: plan.exact ? 'exact_match_for_tags' : 'keyword',
        sort: plan.sortKey,
        startDate: plan.since,
        endDate: plan.until,
        hideAi: plan.hideAi,
        offset,
        signal,
      });
    case 'user':
      return api.userIllusts(plan.user, { type: plan.type || '', offset, signal });
    case 'bookmarks':
      return api.bookmarks({ userId: plan.userId, restrict: plan.restrict, ...cursor, signal });
    default:
      throw new Error(`pixiv: 知らない一覧 ${plan.mode}`);
  }
}

// 間引いて空になった頁が続いた数 (鍵ごと)。EMPTY_PAGE_LIMIT で打ち切る
const emptyRuns = new Map();

function tallyEmpty(key, rows, kept) {
  if (kept.length || !rows.length) {
    emptyRuns.delete(key);
    return false;
  }
  const n = (emptyRuns.get(key) || 0) + 1;
  emptyRuns.set(key, n);
  while (emptyRuns.size > 200) emptyRuns.delete(emptyRuns.keys().next().value);
  return n >= EMPTY_PAGE_LIMIT;
}

const creatorSearchCursors = new Map();
const loadCreatorSearch = createRemotePager(async (remotePage, word, { signal } = {}) => {
  const offset = remotePage === 0 ? 0 : creatorSearchCursors.get(word);
  if (!Number.isFinite(offset)) throw new Error('pixiv: 作者検索を再読み込みしてください');
  const json = await pixiv.api().searchUsers(word, { offset, signal });
  signal?.throwIfAborted();
  const previews = Array.isArray(json?.user_previews) ? json.user_previews : [];
  const next = nextCursor(json);
  creatorSearchCursors.set(word, next?.offset);
  while (creatorSearchCursors.size > 100) creatorSearchCursors.delete(creatorSearchCursors.keys().next().value);
  return { rows: previews.filter(row => row.user?.id && !row.user.is_access_blocking_user).map(creatorCard), hasNext: Number.isFinite(next?.offset) && next.offset > offset && previews.length > 0 };
});

const pageCursors = new Map();
const loadPage = createRemotePager(async (remotePage, key, { signal } = {}) => {
  const plan = JSON.parse(key);
  if (remotePage === 0) { emptyRuns.delete(key); pageCursors.set(key, { page: 0, cursor: { offset: 0 } }); }
  const current = pageCursors.get(key);
  if (!current || current.page !== remotePage) throw new Error('pixiv: 続きの位置が失われました。一覧を再読み込みしてください');
  const json = await fetchRows(plan, current.cursor, signal);
  signal?.throwIfAborted();
  const rows = Array.isArray(json && json.illusts) ? json.illusts : [];
  const kept = rowsToGalleries(rows).filter((g) => passes(g, plan.filter));
  const next = nextCursor(json);
  const more = next != null && JSON.stringify(next) !== JSON.stringify(current.cursor) && rows.length > 0;
  pageCursors.set(key, { page: remotePage + 1, cursor: next });
  const giveUp = tallyEmpty(key, rows, kept);
  return { rows: kept, hasNext: more && !giveUp };
});

// 公開と非公開のブックマークを合流する。片方ずつの頁を持ち、頭 (投稿 ID の大きい方 =
// 新しい投稿) を見比べて出す
const mergedStates = new Map();
const MERGED_TTL = 10 * 60 * 1000;

const loadMergedBookmarks = createRemotePager(async (remotePage, key, { signal } = {}) => {
  const plan = JSON.parse(key);
  let state = mergedStates.get(key);
  if (!state || Date.now() - state.at > MERGED_TTL || remotePage === 0) {
    state = {
      at: Date.now(),
      sides: ['public', 'private'].map((restrict) => ({ restrict, cursor: { offset: 0 }, done: false, buffer: [] })),
    };
    mergedStates.set(key, state);
    while (mergedStates.size > 50) mergedStates.delete(mergedStates.keys().next().value);
  }
  // Commit only a complete page, so cancellation/retry cannot skip buffered rows.
  state = { ...state, sides: state.sides.map(side => ({ ...side, buffer: [...side.buffer] })) };
  const api = pixiv.api();
  const fill = async (side) => {
    if (side.done || side.buffer.length) return;
    const json = await api.bookmarks({ userId: plan.userId, restrict: side.restrict, ...side.cursor, signal });
    const rows = Array.isArray(json && json.illusts) ? json.illusts : [];
    side.buffer.push(...rows);
    const next = nextCursor(json);
    if (!next || JSON.stringify(next) === JSON.stringify(side.cursor) || rows.length === 0) side.done = true;
    side.cursor = next;
  };
  await Promise.all(state.sides.map(fill));
  const rows = [];
  while (rows.length < PAGE) {
    const heads = state.sides.filter((side) => side.buffer.length);
    if (!heads.length) break;
    heads.sort((a, b) => Number(b.buffer[0].id) - Number(a.buffer[0].id));
    rows.push(heads[0].buffer.shift());
    if (!heads[0].buffer.length && !heads[0].done) await fill(heads[0]);
  }
  const more = state.sides.some((side) => side.buffer.length || !side.done);
  signal?.throwIfAborted();
  state.at = Date.now();
  mergedStates.set(key, state);
  const kept = rowsToGalleries(rows).filter((g) => passes(g, plan.filter));
  const giveUp = tallyEmpty(key, rows, kept);
  return { rows: kept, hasNext: more && !giveUp };
});

async function search({
  query = '', sort = 'follow', type = '', pixivPeriod, page = 0, pageSize = 24, signal, authorNames = [],
} = {}) {
  requireLogin();
  const parsed = parseQuery(query);
  if (parsed.id) {
    const detail = await getDetail(parsed.id);
    return { total: 1, page: 0, pageSize, hasNext: false, galleries: [serialize(detail)] };
  }
  const author = splitAuthorQuery(query);
  if (author.authors.length) {
    if (author.authors.length !== 1 || author.authors[0].negative) throw new Error('pixiv の作者候補検索は作者を1人指定してください。除外する語は作者指定の後ろに入力できます。');
    const names=[...new Set([author.authors[0].name,...(Array.isArray(authorNames)?authorNames:[])].filter(name=>typeof name==='string' && name.trim()).map(name=>name.trim().slice(0,200)))].slice(0,3);
    let loaded;
    for (const word of names) {
      const first=await loadCreatorSearch(word,0,pageSize,{signal});
      loaded=page===0 ? first : await loadCreatorSearch(word,page,pageSize,{signal});
      if(first.rows.length || first.hasNext) break;
    }
    return { ...loaded, galleries: loaded.rows.map(g => ({...g, query: `${g.query}${author.rest ? ' ' + author.rest : ''}`})), page, pageSize, approximate: true, interpreted: [], notice: '作者名の検索候補です。作者を選んで作品一覧を開けます。' };
  }
  const plan = planFor({ query, sort, type, pixivPeriod }, parsed, pixiv.settings());
  if (plan.mode === 'bookmarks' && !plan.userId) {
    const error = new Error('pixiv の利用者 ID が分かりません (ログインし直してください)');
    error.status = 401;
    throw error;
  }
  const key = JSON.stringify(plan);
  const pager = plan.mode === 'bookmarks' && plan.restrict === 'all' ? loadMergedBookmarks : loadPage;
  const loaded = await pager(key, page, pageSize, { signal });
  let creator = null;
  if (plan.mode === 'user' && page === 0) {
    try {
      creator = { ...creatorCard(await pixiv.api().userDetail(plan.user, { signal })), pinnedCreator: true, previewId: loaded.rows[0]?.id || '' };
    } catch (error) { signal?.throwIfAborted(); }
  }
  return {
    total: loaded.total,
    approximate: true,
    hasNext: loaded.hasNext,
    page,
    pageSize,
    galleries: creator ? [creator, ...loaded.rows] : loaded.rows,
    interpreted: [],
    ...(plan.note ? { notice: plan.note } : {}),
  };
}

async function getGallery(key) {
  const text = String(key || '');
  requireLogin();
  if (text.startsWith('user:')) {
    const detail = await pixiv.api().userDetail(text.slice(5));
    return creatorCard(detail);
  }
  return serialize(await getDetail(text));
}

// 頁 (と表紙) の URL。一覧の行にも詳細にも同じ形で載っている
function pageUrls(illust, index) {
  const single = illust.meta_single_page && illust.meta_single_page.original_image_url;
  if (index === 0 && single) {
    return { original: single, large: illust.image_urls?.large || '', medium: illust.image_urls?.medium || '' };
  }
  const page = (illust.meta_pages || [])[index];
  if (page && page.image_urls) {
    return { original: page.image_urls.original || '', large: page.image_urls.large || '', medium: page.image_urls.medium || '' };
  }
  if (index === 0 && illust.image_urls) {
    return { original: '', large: illust.image_urls.large || '', medium: illust.image_urls.medium || '' };
  }
  return null;
}

function typeOf(url, fallback) {
  const ext = String(url || '').split('?')[0].split('.').pop().toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  return fallback || 'image/jpeg';
}

function notFound() {
  const error = new Error('image not found');
  error.status = 404;
  return error;
}

// 読み手が頼んだ大きさ。原寸 (full) は落とす時の物: 眺める時は 1200 px の webp にする
// (pixiv の閲覧と同じ大きさで、原寸 PNG の 1/20〜1/50 の重さ。原寸を 12 頁先読みすると
// 復号だけで読み手が分単位で止まった)。設定 (readOriginal) で原寸にもできる
function readingSize(size) {
  if (size !== 'full') return size;
  return pixiv.settings().readOriginal === true ? 'full' : 'read';
}

// 眺める大きさの URL を、望む順に。API の large は c/600x1200_90_webp (600 px)。同じ CDN に
// 1200 px の webp (c/1200x1200_90_webp) と master1200 (1200 px の JPEG、web の閲覧の絵) がある。
// 無い時 (403 / 404) は次へ落ちる
const LARGE_PRESET = /\/c\/600x1200_90(?:_webp)?\//;

function readUrls(urls) {
  const large = String(urls.large || '');
  const out = [];
  if (LARGE_PRESET.test(large)) {
    out.push(large.replace(LARGE_PRESET, '/c/1200x1200_90_webp/'));
    out.push(large.replace(LARGE_PRESET, '/'));
  }
  out.push(large, String(urls.medium || ''));
  return [...new Set(out.filter(Boolean))];
}

// 候補を順に取る。無い大きさ (403 / 404) だけ次へ。冷却 (429) や取り下げはそのまま投げる
async function fetchFirst(api, candidates, { signal, priority, lane, range = '' }) {
  let last = null;
  for (const url of candidates) {
    try {
      const res = await api.image(url, { signal, priority, lane, range });
      return { bytes: res.buffer, type: res.headers['content-type'] || typeOf(url), name: url.split('?')[0].split('/').pop(), url };
    } catch (error) {
      const missing = error && (error.status === 403 || error.status === 404) && !error.rateLimited;
      if (!missing) throw error;
      last = error;
    }
  }
  throw last || notFound();
}

// 車線: 落とす原寸 (full で読み手でない) だけ画像車線 (PPD の 150 件で 1 秒の数え方)。
// 表紙・読み手の頁・作者の顔は眺める車線 (間隔を空けない)。読み手の原寸 (設定) も眺める側
async function fetchImage(key, index, {
  size = 'full', signal, priority = 10, reading = false,
} = {}) {
  const text = String(key || '');
  const api = pixiv.api();
  if (text.startsWith('user:')) {
    // 作者の札: 顔の絵を表紙にする。一覧で見た顔の URL は控えてある (rememberProfile)
    const userId = text.slice(5);
    let url = profileImages.get(userId) || '';
    if (!url) {
      const detail = await api.userDetail(userId, { signal });
      url = String((detail && detail.user && detail.user.profile_image_urls && detail.user.profile_image_urls.medium) || '');
      if (url) rememberProfile(userId, url);
    }
    if (!url) return null;
    return fetchFirst(api, [url], { signal, priority, lane: 'view' });
  }
  const original = size === 'full';
  let illust = cached(text);
  if (!illust || (original && !(pageUrls(illust, index) || {}).original)) illust = await getDetail(text);
  const urls = pageUrls(illust, index);
  if (!urls) throw notFound();
  if ((original || size === 'read') && String(illust.type) === 'ugoira') {
    const error = new Error('うごイラは本にしません');
    error.status = 415;
    throw error;
  }
  let candidates;
  // 落とす原寸は代えない (粗い絵で本を綴じない)。無ければ large (原寸の口が無い投稿)
  if (original) candidates = [urls.original || urls.large];
  else if (size === 'read') candidates = readUrls(urls);
  else if (size === 'small') candidates = [urls.medium, urls.large];
  else candidates = [urls.large, urls.medium];
  candidates = [...new Set(candidates.filter(Boolean))];
  if (!candidates.length) throw notFound();
  const lane = original && !reading ? 'download' : 'view';
  return fetchFirst(api, candidates, { signal, priority, lane });
}

// 原寸の先頭だけ (既定 64KB)。AI 作品の生成情報のうち文字チャンク (NovelAI / A1111 / ComfyUI) と EXIF は先頭にあるので、
// 原寸ぜんぶ (数 MB) を取らずに有無が分かる。眺める車線。原寸の口が無い投稿は null (large の先頭を読んでも意味が無い)
async function fetchImageHead(key, index, { bytes = 65536, signal, priority = 8 } = {}) {
  const text = String(key || '');
  const api = pixiv.api();
  let illust = cached(text);
  if (!illust || !(pageUrls(illust, index) || {}).original) illust = await getDetail(text);
  const urls = pageUrls(illust, index);
  if (!urls || !urls.original) return null;
  if (String(illust.type) === 'ugoira') return null;
  const res = await fetchFirst(api, [urls.original], { signal, priority, lane: 'view', range: `bytes=0-${Math.max(1, bytes) - 1}` });
  return { ...res, pageCount: Number(illust.page_count) || 1 };
}

// --- 発見 (おすすめの作者と投稿) -----------------------------------------------
// pixiv の「おすすめユーザー」(フォローから薦める作者。各 3 枚の投稿つき) と、アプリのホームの
// 「おすすめ」。控えは数分: 発見を出入りするたびに API 車線を使わない。fresh で引き直す

const DISCOVER_TTL = 3 * 60 * 1000;
let discoverMemo = null;

async function discover({ signal, fresh = false } = {}) {
  requireLogin();
  if (!fresh && discoverMemo && Date.now() - discoverMemo.at < DISCOVER_TTL) return discoverMemo.value;
  const api = pixiv.api();
  const filter = { hideAi: pixiv.settings().hideAi === true };
  const [users, home] = await Promise.all([api.userRecommended({ signal }), api.illustRecommended({ signal })]);
  const previews = Array.isArray(users && users.user_previews) ? users.user_previews : [];
  const rows = previews
    .filter((row) => row && row.user && row.user.id && row.is_muted !== true)
    .map((row) => ({
      creator: creatorCard({ user: row.user }),
      illusts: rowsToGalleries((row.illusts || []).slice(0, 3)).filter((g) => passes(g, filter)),
    }));
  const illusts = rowsToGalleries(Array.isArray(home && home.illusts) ? home.illusts : []).filter((g) => passes(g, filter));
  const value = { users: rows, illusts, at: Date.now() };
  discoverMemo = { at: value.at, value };
  return value;
}

// 関連作品。API の頁 (30 件) を控えに継ぎ足し、呼び手ごとの件数 (limit) に切って返す:
// 詳細と発見の棚は 12 件 (一頁で足りる)、読み手の継ぎ目は 30 件ずつ増やして頼む。
// 足りない分だけ next_url を辿る (本家の「関連作品」が下るほど増えるのと同じ道)。
// 上限は RELATED_TOTAL (5 頁): 一作品の継ぎ目で本アカウントの予算を使い切らない
const RELATED_PAGE = 30;
const RELATED_DEFAULT = 12;
const RELATED_TOTAL = 150;
const relatedMemo = new Map();
async function related(id, { signal, limit = RELATED_DEFAULT } = {}) {
  requireLogin();
  const pid = String(id).replace(/^px:/, '');
  if (!/^\d+$/.test(pid)) throw new Error('作品IDが不正です');
  const take = Math.max(1, Math.min(RELATED_TOTAL, Number(limit) || RELATED_DEFAULT));
  const hideAi = pixiv.settings().hideAi === true;
  const cacheKey = `${pid}:${hideAi}`;
  let memo = relatedMemo.get(cacheKey);
  if (!memo || Date.now() - memo.at > DISCOVER_TTL) {
    // 空の控えから始める。next は「まだ一頁目も引いていない」の印に undefined
    memo = { at: Date.now(), rows: [], seen: new Set([`px:${pid}`]), next: undefined, pages: 0 };
    relatedMemo.set(cacheKey, memo);
    if (relatedMemo.size > 30) relatedMemo.delete(relatedMemo.keys().next().value);
  }
  const keep = (g) => g.id !== `px:${pid}` && !memo.seen.has(g.id) && passes(g, { hideAi });
  while (memo.rows.length < take && memo.next !== null && memo.pages < RELATED_TOTAL / RELATED_PAGE) {
    const api = pixiv.api();
    const json = memo.next === undefined
      ? await api.illustRelated(pid, { signal })
      : await api.next(memo.next, { signal });
    memo.pages += 1;
    // 続きの頁は前の頁と重なることがある (seed が同じ): id で畳む
    const fresh = rowsToGalleries(json.illusts || []).filter(keep);
    for (const g of fresh) memo.seen.add(g.id);
    memo.rows.push(...fresh);
    memo.next = json.next_url ? String(json.next_url) : null;
    // 一頁が空で返る相手には、それ以上は頼まない
    if (!(json.illusts || []).length) memo.next = null;
  }
  return memo.rows.slice(0, take);
}

// 札の補完。2 字から、接頭辞ごとに控え、車線に待ちが居れば網に出ない (§15 U2)。
// 無ければ黙る (index.js が辞書 + 所持の作家名を出す)
async function suggestTags(term) {
  const word = String(term || '').trim();
  if (word.length < 2 || !loggedIn()) return [];
  const hit = suggestCache.get(word);
  if (hit && Date.now() - hit.at < SUGGEST_TTL) return hit.tags;
  let busy = false;
  try {
    const state = pixiv.manners().state();
    busy = state.api.waiting > 0 || state.pausedForMs > 0;
  } catch {
    busy = false;
  }
  if (busy) return [];
  let tags = [];
  try {
    tags = await pixiv.api().autocomplete(word);
  } catch {
    return [];
  }
  const out = tags.slice(0, 12).map((item) => ({
    type: 'tag',
    name: String(item.name || ''),
    label: String(item.name || ''),
    translation: item.translated_name && item.translated_name !== item.name ? String(item.translated_name) : '',
  })).filter((item) => item.name);
  suggestCache.set(word, { at: Date.now(), tags: out });
  while (suggestCache.size > 300) suggestCache.delete(suggestCache.keys().next().value);
  return out;
}

module.exports = {
  hosts,
  rewritesAliases,
  detectUrl,
  search,
  getGallery,
  fetchImage,
  fetchImageHead,
  readingSize,
  suggestTags,
  discover,
  related,
  // 試験と他の部品が使う
  parseQuery,
  typeParts,
  planFor,
  serialize,
  creatorCard,
  pageUrls,
  readUrls,
  daysAgo,
  passes,
  _cacheForTest: cache,
  _resetForTest() {
    cache.clear();
    suggestCache.clear();
    emptyRuns.clear();
    mergedStates.clear();
    pageCursors.clear();
    profileImages.clear();
    discoverMemo = null;
    relatedMemo.clear();
  },
};
