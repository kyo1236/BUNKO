'use strict';

// pixiv API の客 (src/lib/pixiv/api.js)。網は偽物。
// 釘: 頭 (Bearer・X-Client-*)、引数の組み方、next_url の読み、401 の一度きりの撃ち直し、
// 403 "Rate Limit" を 429 と同じ扱いにして作法が止まること、画像の Referer。

const test = require('node:test');
const assert = require('node:assert/strict');

const { PixivApi, nextOffset, nextCursor } = require('../src/lib/pixiv/api');
const { createManners } = require('../src/lib/pixiv/manners');

const quietTrace = { flag() {} };

function fakeAuth() {
  let n = 0;
  return {
    access: null,
    refreshed: 0,
    async accessToken() { return `acc-${n}`; },
    async refresh() { this.refreshed += 1; n += 1; return `acc-${n}`; },
  };
}

function fakeHttp(handler) {
  const calls = [];
  return {
    calls,
    request: async (url, options) => { calls.push({ url, options }); return handler(url, options, calls.length); },
    get: async (url, headers, options) => { calls.push({ url, options: { headers, ...options } }); return handler(url, { headers, ...options }, calls.length); },
  };
}

const ok = (json) => ({ status: 200, headers: {}, json: () => json, text: () => JSON.stringify(json), buffer: Buffer.alloc(0) });

test('cursor pagination preserves bookmark and new-work IDs without offset', async () => {
  assert.deepEqual(nextCursor({next_url:'https://app-api.pixiv.net/x?max_bookmark_id=9007199254740993'}), {maxBookmarkId:'9007199254740993'});
  assert.deepEqual(nextCursor({next_url:'https://app-api.pixiv.net/x?max_illust_id=987654'}), {maxIllustId:'987654'});
  assert.deepEqual(nextCursor({next_url:'https://app-api.pixiv.net/x?offset=60'}), {offset:60});
  assert.equal(nextCursor({next_url:null}), null);
  const {client,http}=api(()=>ok({illusts:[],next_url:null}));
  await client.illustNew({maxIllustId:'987654'});
  await client.bookmarks({userId:'42',maxBookmarkId:'9007199254740993'});
  assert.equal(new URL(http.calls[0].url).searchParams.get('max_illust_id'),'987654');
  assert.equal(new URL(http.calls[1].url).searchParams.get('max_bookmark_id'),'9007199254740993');
});

function api(handler, mannersConfig = {}) {
  const http = fakeHttp(handler);
  const auth = fakeAuth();
  const manners = createManners({ trace: quietTrace, config: { apiSlowAfter: 1000, imageSlowAfter: 1000, ...mannersConfig } });
  return { client: new PixivApi({ auth, manners, http }), http, auth, manners };
}

test('next(next_url) は URL をそのまま辿る (関連作品の seed_illust_ids[] を読み替えない)。相手が違えば断る', async () => {
  const {client,http}=api(()=>ok({illusts:[],next_url:null}));
  await client.next('https://app-api.pixiv.net/v2/illust/related?illust_id=100&seed_illust_ids%5B0%5D=200&seed_illust_ids%5B1%5D=201&offset=30');
  const url=new URL(http.calls[0].url);
  assert.equal(url.pathname,'/v2/illust/related');
  assert.equal(url.searchParams.get('seed_illust_ids[1]'),'201');
  assert.equal(url.searchParams.get('offset'),'30');
  assert.match(http.calls[0].options.headers.Authorization,/^Bearer /);
  await assert.rejects(client.next('https://evil.example/v2/illust/related?offset=30'),/相手/);
  await assert.rejects(client.next('not a url'),/読めない/);
});
test('next_url から次の offset を読む。無ければ null', () => {
  assert.equal(nextOffset({ next_url: 'https://app-api.pixiv.net/v2/illust/follow?restrict=all&offset=30' }), 30);
  assert.equal(nextOffset({ next_url: null }), null);
  assert.equal(nextOffset({}), null);
  assert.equal(nextOffset(null), null);
});

test('呼び出しには Bearer と公式アプリの頭が付き、空の引数は載せない', async () => {
  const { client, http } = api(() => ok({ illust: { id: 1 } }));
  const illust = await client.illustDetail(1);
  assert.deepEqual(illust, { id: 1 });
  const { url, options } = http.calls[0];
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://app-api.pixiv.net/v1/illust/detail');
  assert.equal(u.searchParams.get('illust_id'), '1');
  assert.equal(u.searchParams.get('filter'), 'for_android');
  assert.equal(options.headers.Authorization, 'Bearer acc-0');
  assert.ok(options.headers['X-Client-Hash']);
  assert.equal(options.method, 'GET');
});

test('AI 生成のランキング (day_ai / day_r18_ai) は day に倒さない', async () => {
  const { client, http } = api(() => ok({ illusts: [], next_url: null }));
  await client.ranking({ mode: 'day_ai' });
  await client.ranking({ mode: 'day_r18_ai' });
  const modes = http.calls.map(({ url }) => new URL(url)).filter((u) => u.pathname === '/v1/illust/ranking').map((u) => u.searchParams.get('mode'));
  assert.deepEqual(modes, ['day_ai', 'day_r18_ai']);
});

test('一覧の引数: ランキングの mode と日付、検索の並びと期間、候補の restrict、作者の type', async () => {
  const { client, http } = api(() => ok({ illusts: [], next_url: null }));
  await client.ranking({ mode: 'week_manga', date: '2026-09-18' });
  await client.ranking({ mode: 'bogus' });
  await client.searchIllust('青空', { sort: 'popular_desc', startDate: '2026-09-12', endDate: '2026-09-19', offset: 60 });
  await client.bookmarks({ userId: 123, restrict: 'private', tag: 'あとで' });
  await client.userIllusts(456, { type: 'manga', offset: 30 });
  await client.illustFollow({ offset: 0 });
  const params = http.calls.map(({ url }) => {
    const u = new URL(url);
    return [u.pathname, Object.fromEntries(u.searchParams)];
  });
  assert.deepEqual(params[0], ['/v1/illust/ranking', { mode: 'week_manga', date: '2026-09-18', filter: 'for_android' }]);
  assert.equal(params[1][1].mode, 'day', '知らない mode は day に倒す');
  assert.deepEqual(params[2], ['/v1/search/illust', {
    word: '青空', search_target: 'keyword', sort: 'popular_desc',
    search_ai_type: '0', include_potential_violation_works: 'true', content_type: 'illust_and_manga_and_ugoira',
    start_date: '2026-09-12', end_date: '2026-09-19', offset: '60', filter: 'for_android',
  }]);
  assert.deepEqual(params[3], ['/v1/user/bookmarks/illust', { user_id: '123', restrict: 'private', tag: 'あとで', filter: 'for_android' }]);
  assert.deepEqual(params[4], ['/v1/user/illusts', { user_id: '456', type: 'manga', offset: '30', filter: 'for_android' }]);
  assert.deepEqual(params[5], ['/v2/illust/follow', { restrict: 'all' }], 'offset 0 は載せない');
});

test('候補へ (bookmark/add) は form の POST。既定は非公開に積む。外す口もある', async () => {
  const { client, http } = api(() => ok({}));
  await client.bookmarkAdd(987);
  const { url, options } = http.calls[0];
  assert.equal(new URL(url).pathname, '/v2/illust/bookmark/add');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(options.body)), { illust_id: '987', restrict: 'private' });
  await client.bookmarkAdd(987, { restrict: 'public' });
  assert.equal(new URLSearchParams(http.calls[1].options.body).get('restrict'), 'public');
  await client.bookmarkDelete(987);
  assert.equal(new URL(http.calls[2].url).pathname, '/v1/illust/bookmark/delete');
  assert.equal(new URLSearchParams(http.calls[2].options.body).get('illust_id'), '987');
});

test('新着作品 (illust/new) と AI を除く検索の引数', async () => {
  const { client, http } = api(() => ok({ illusts: [], next_url: null }));
  await client.illustNew({ contentType: 'manga', offset: 30 });
  await client.illustNew({});
  await client.searchIllust('x', { hideAi: true });
  const params = http.calls.map(({ url }) => Object.fromEntries(new URL(url).searchParams));
  assert.deepEqual(params[0], { content_type: 'manga', offset: '30', filter: 'for_android' });
  assert.equal(params[1].content_type, 'illust');
  assert.equal(params[2].search_ai_type, '1');
});

test('401 なら token を一度だけ取り直して撃ち直す。二度目は投げる', async () => {
  const unauthorized = () => Object.assign(new Error('HTTP 401'), { status: 401, body: '{"error":{"message":"Error occurred at the OAuth process."}}' });
  const once = api((url, options, n) => { if (n === 1) throw unauthorized(); return ok({ illust: { id: 2 } }); });
  assert.deepEqual(await once.client.illustDetail(2), { id: 2 });
  assert.equal(once.auth.refreshed, 1);
  assert.equal(once.http.calls[1].options.headers.Authorization, 'Bearer acc-1', '取り直した token で撃つ');

  const always = api(() => { throw unauthorized(); });
  await assert.rejects(always.client.illustDetail(3), /401/);
  assert.equal(always.http.calls.length, 2, '撃ち直しは一度きり');
});

test('403 の Rate Limit は 429 に読み替え、作法が両車線を止める', async () => {
  const { client, manners } = api(() => {
    throw Object.assign(new Error('HTTP 403'), { status: 403, body: '{"error":{"user_message":"","message":"Rate Limit","reason":""}}' });
  }, { cooldownMs: 50 });
  await assert.rejects(client.illustDetail(4), (e) => e.status === 429 && e.rateLimited === true);
  assert.ok(manners.state().pausedForMs > 0, '止まった');
});

test('画像は Referer と UA を付けて画像車線で取る', async () => {
  const { client, http } = api(() => ({ status: 200, headers: { 'content-type': 'image/jpeg' }, buffer: Buffer.from([1, 2, 3]) }));
  const res = await client.image('https://i.pximg.net/img-original/img/2026/09/19/00/00/00/1_p0.jpg');
  assert.deepEqual([...res.buffer], [1, 2, 3]);
  const { options } = http.calls[0];
  assert.equal(options.headers.Referer, 'https://app-api.pixiv.net/');
  assert.match(options.headers['User-Agent'], /^PixivAndroidApp/);
});

test('画像の車線: 既定は画像車線 (落とす原寸)、lane view は眺める車線 (表紙・読み手)', async () => {
  const { client, manners } = api(() => ({ status: 200, headers: {}, buffer: Buffer.alloc(1) }));
  await client.image('https://i.pximg.net/img-original/img/x_p0.jpg');
  await client.image('https://i.pximg.net/c/1200x1200_90_webp/img-master/img/x_p0_master1200.jpg', { lane: 'view' });
  assert.equal(manners.state().image.recent, 1);
  assert.equal(manners.state().view.recent, 1);
});

test('発見の口: おすすめの作者と投稿は GET、フォローは form の POST', async () => {
  const { client, http } = api(() => ok({ user_previews: [], illusts: [] }));
  await client.userRecommended({ offset: 30 });
  await client.illustRecommended();
  await client.followAdd(55);
  await client.followDelete(55);
  const calls = http.calls.map(({ url, options }) => [
    new URL(url).pathname,
    Object.fromEntries(new URL(url).searchParams),
    options.method,
    options.body ? Object.fromEntries(new URLSearchParams(options.body)) : null,
  ]);
  assert.deepEqual(calls[0], ['/v1/user/recommended', { offset: '30', filter: 'for_android' }, 'GET', null]);
  assert.equal(calls[1][0], '/v1/illust/recommended');
  assert.equal(calls[1][1].include_ranking_illusts, 'false');
  assert.deepEqual(calls[2], ['/v1/user/follow/add', {}, 'POST', { user_id: '55', restrict: 'public' }]);
  assert.deepEqual(calls[3], ['/v1/user/follow/delete', {}, 'POST', { user_id: '55' }]);
});

test('recommendations forward the pagination offset independently from bookmarks', async()=>{
  const {client,http}=api(()=>ok({illusts:[],next_url:null}));
  await client.illustRecommended({offset:60});
  const url=new URL(http.calls[0].url);
  assert.equal(url.pathname,'/v1/illust/recommended');
  assert.equal(url.searchParams.get('offset'),'60');
});
