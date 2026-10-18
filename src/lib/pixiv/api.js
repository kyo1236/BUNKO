'use strict';

// pixiv 公式アプリ API の客 (docs/pixiv-design-2026-09-19.md §3)。
// URL と引数を組み、作法 (manners) を通して網へ出し、JSON を返すだけ。
// 札や本の形に直すのはアダプタ (sources/pixiv.js) の仕事。
//
// 口は pixivpy (upbit/pixivpy) の aapi.py と同じ。一覧は 30 件ずつで、次は
// next_url の offset で頼む。

const { clientHeaders, AuthError } = require('./auth');

const BASE = 'https://app-api.pixiv.net';
const IMAGE_REFERER = 'https://app-api.pixiv.net/';
const PAGE = 30;

const RANKING_MODES = new Set([
  'day', 'week', 'month', 'day_male', 'day_female', 'week_original', 'week_rookie',
  'day_manga', 'week_manga', 'month_manga', 'day_r18', 'week_r18', 'day_male_r18', 'day_female_r18', 'week_r18g',
  // AI 生成は通常のランキングから外され、日間だけの別の一覧になっている
  'day_ai', 'day_r18_ai',
]);

// next_url (…&offset=30) から次の offset を読む。無ければ null (終わり)
function nextOffset(json) {
  const next = json && json.next_url;
  if (!next) return null;
  try {
    const offset = new URL(String(next)).searchParams.get('offset');
    return offset == null ? null : Number(offset);
  } catch {
    const hit = String(next).match(/[?&]offset=(\d+)/);
    return hit ? Number(hit[1]) : null;
  }
}

// Cursor-based lists do not necessarily include offset. Keep IDs as strings.
function nextCursor(json) {
  if (!json?.next_url) return null;
  try {
    const params = new URL(String(json.next_url)).searchParams;
    const cursor = {};
    for (const [remote, local] of [['offset', 'offset'], ['max_bookmark_id', 'maxBookmarkId'], ['max_illust_id', 'maxIllustId']]) {
      const value = params.get(remote);
      if (value !== null && /^\d+$/.test(value)) cursor[local] = remote === 'offset' ? Number(value) : value;
    }
    return Object.keys(cursor).length ? cursor : null;
  } catch { return null; }
}

// 403 "Rate Limit" は 429 と同じ扱いにする (downloader の isRateLimit と manners の両方が見る)
function markRateLimit(error) {
  const body = typeof error.body === 'string' ? error.body : '';
  if (error.status === 429 || (error.status === 403 && /rate limit/i.test(body))) {
    error.rateLimited = true;
    if (error.status !== 429) error.status = 429;
  }
  return error;
}

class PixivApi {
  constructor({ auth, manners, http, base = BASE } = {}) {
    if (!auth) throw new Error('pixiv api: auth が無い');
    if (!manners) throw new Error('pixiv api: manners が無い');
    this.auth = auth;
    this.manners = manners;
    this.http = http || require('../http');
    this.base = base;
  }

  // 一往復。401 か OAuth の失敗なら一度だけ token を取り直して撃ち直す
  async call(pathname, params = {}, { method = 'GET', form = null, signal, priority = 10, retried = false } = {}) {
    const token = await this.auth.accessToken();
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      query.set(key, String(value));
    }
    const url = `${this.base}${pathname}${query.toString() ? `?${query}` : ''}`;
    const headers = { ...clientHeaders(), Authorization: `Bearer ${token}` };
    let body = null;
    if (form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }
    let res;
    try {
      res = await this.manners.api(
        () => this.http.request(url, { method, headers, body, signal, priority, timeout: 20000 }),
        { signal },
      );
    } catch (error) {
      markRateLimit(error);
      if (!retried && (error.status === 401 || isOauthFailure(error))) {
        this.auth.access = null;
        await this.auth.refresh();
        return this.call(pathname, params, { method, form, signal, priority, retried: true });
      }
      throw error;
    }
    return res.json();
  }

  // --- 投稿 -------------------------------------------------------------

  async illustDetail(illustId) {
    const json = await this.call('/v1/illust/detail', { illust_id: illustId, filter: 'for_android' });
    return json.illust || null;
  }

  // --- 一覧 (どれも { illusts, next_url }) -----------------------------------

  illustFollow({ restrict = 'all', offset = 0, signal } = {}) {
    return this.call('/v2/illust/follow', { restrict, offset: offset || undefined }, { signal });
  }

  ranking({ mode = 'day', date = '', offset = 0, signal } = {}) {
    const safeMode = RANKING_MODES.has(mode) ? mode : 'day';
    return this.call('/v1/illust/ranking', {
      mode: safeMode, date: date || undefined, offset: offset || undefined, filter: 'for_android',
    }, { signal });
  }

  searchUsers(word, { offset = 0, signal } = {}) {
    return this.call('/v1/search/user', { word, sort: 'date_desc', offset: offset || undefined, filter: 'for_android' }, { signal });
  }

  searchIllust(word, {
    target = 'keyword', sort = 'date_desc', startDate = '', endDate = '', offset = 0,
    hideAi = false, signal,
  } = {}) {
    return this.call('/v1/search/illust', {
      word,
      search_target: target,
      sort,
      start_date: startDate || undefined,
      end_date: endDate || undefined,
      // 1 = AI 生成を向こうで除く (無ければ札の側で落とす)
      search_ai_type: hideAi ? 1 : 0,
      include_potential_violation_works: true,
      content_type: 'illust_and_manga_and_ugoira',
      offset: offset || undefined,
      filter: 'for_android',
    }, { signal });
  }

  // pixiv 全体の新着作品 (フォローではない)。content_type は illust か manga
  illustNew({ contentType = 'illust', offset = 0, maxIllustId = null, signal } = {}) {
    return this.call('/v1/illust/new', {
      content_type: contentType === 'manga' ? 'manga' : 'illust',
      offset: offset || undefined,
      max_illust_id: maxIllustId || undefined,
      filter: 'for_android',
    }, { signal });
  }

  bookmarks({ userId, restrict = 'public', tag = '', offset = 0, maxBookmarkId = null, signal } = {}) {
    return this.call('/v1/user/bookmarks/illust', {
      user_id: userId,
      restrict,
      tag: tag || undefined,
      max_bookmark_id: maxBookmarkId || undefined,
      offset: offset || undefined,
      filter: 'for_android',
    }, { signal });
  }

  userIllusts(userId, { type = '', offset = 0, signal } = {}) {
    return this.call('/v1/user/illusts', {
      user_id: userId, type: type || undefined, offset: offset || undefined, filter: 'for_android',
    }, { signal });
  }

  async userDetail(userId, { signal } = {}) {
    const json = await this.call('/v1/user/detail', { user_id: userId, filter: 'for_android' }, { signal });
    return json || null;
  }

  // --- 書く方 ------------------------------------------------------------

  bookmarkAdd(illustId, { restrict = 'private' } = {}) {
    return this.call('/v2/illust/bookmark/add', {}, {
      method: 'POST', form: { illust_id: String(illustId), restrict: restrict === 'public' ? 'public' : 'private' },
    });
  }

  bookmarkDelete(illustId) {
    return this.call('/v1/illust/bookmark/delete', {}, {
      method: 'POST', form: { illust_id: String(illustId) },
    });
  }

  // --- 発見 (おすすめ) ------------------------------------------------------

  // おすすめの作者 (pixiv がフォローから薦める)。{ user_previews: [{ user, illusts, is_muted }], next_url }
  userRecommended({ offset = 0, signal } = {}) {
    return this.call('/v1/user/recommended', { offset: offset || undefined, filter: 'for_android' }, { signal });
  }

  // おすすめの投稿 (アプリのホーム)。{ illusts, next_url }
  illustRecommended({ offset = 0, signal } = {}) {
    return this.call('/v1/illust/recommended', {
      content_type: 'illust', include_ranking_label: 'true', include_ranking_illusts: 'false', filter: 'for_android', offset: offset || undefined,
    }, { signal });
  }

  illustRelated(illustId, { signal } = {}) {
    return this.call('/v2/illust/related', { illust_id: String(illustId), filter: 'for_android' }, { signal });
  }

  // next_url をそのまま辿る。関連作品の続きは offset ではなく seed_illust_ids[] と viewed[] を
  // 抱えた URL で来るので、読み替えずに丸ごと使う。app-api 以外の相手には出ない
  async next(nextUrl, { signal } = {}) {
    let url;
    try {
      url = new URL(String(nextUrl));
    } catch {
      throw new Error('pixiv: next_url が読めない');
    }
    if (url.origin !== new URL(this.base).origin) throw new Error('pixiv: next_url の相手が違う');
    const params = {};
    for (const [key, value] of url.searchParams) params[key] = value;
    return this.call(url.pathname, params, { signal });
  }

  // 作者をフォローする / 外す (pixiv 側に書く)
  followAdd(userId, { restrict = 'public' } = {}) {
    return this.call('/v1/user/follow/add', {}, {
      method: 'POST', form: { user_id: String(userId), restrict: restrict === 'private' ? 'private' : 'public' },
    });
  }

  followDelete(userId) {
    return this.call('/v1/user/follow/delete', {}, { method: 'POST', form: { user_id: String(userId) } });
  }

  // --- 補完 ---------------------------------------------------------------

  async autocomplete(word, { signal } = {}) {
    const json = await this.call('/v2/search/autocomplete', {
      word, merge_plain_keyword_results: 'true',
    }, { signal });
    return Array.isArray(json.tags) ? json.tags : [];
  }

  // --- 画像 (i.pximg.net) ------------------------------------------------------
  // Referer を付ける (無いと 403)。車線は二つ: 落とす原寸は画像車線 (PPD の既定で数える)、
  // 表紙・読み手の頁・作者の顔は眺める車線 (lane: 'view'。ブラウザで眺めるのと同じ荷。間隔を空けない)

  // range: 'bytes=0-65535' のように先頭だけ (i.pximg.net は 206 で返す。生成情報の文字チャンクと EXIF は先頭にある)
  async image(url, { signal, priority = 10, lane = 'download', range = '' } = {}) {
    const run = lane === 'view' ? this.manners.view : this.manners.image;
    const headers = { Referer: IMAGE_REFERER, 'User-Agent': clientHeaders()['User-Agent'] };
    if (range) headers.Range = range;
    return run(
      () => this.http.get(url, headers, { signal, priority, timeout: 60000 })
        .catch((error) => { throw markRateLimit(error); }),
      { signal, priority },
    );
  }
}

function isOauthFailure(error) {
  if (error instanceof AuthError) return false;
  const body = typeof error.body === 'string' ? error.body : '';
  return error.status === 400 && /oauth|invalid_grant|access token/i.test(body);
}

module.exports = { PixivApi, nextOffset, nextCursor, markRateLimit, RANKING_MODES, PAGE, BASE, IMAGE_REFERER };
