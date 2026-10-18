'use strict';

// pixiv の源泉アダプタ (src/lib/sources/pixiv.js)。網は偽の API で差し替える。
// 釘: 検索欄と並びから一覧の種類が決まること (設計 §4 / §15 U1)、札の形、
// 間引きが遠隔の頁で行われ棚が疎らにならないこと、頁の URL の選び方、補完の作法。

const test = require('node:test');
const assert = require('node:assert/strict');

require('./helpers/stub-electron');

const pixivBundle = require('../src/lib/pixiv');
const adapter = require('../src/lib/sources/pixiv');

function illust(id, over = {}) {
  return {
    id, title: `題 ${id}`, type: 'illust', page_count: 1,
    user: { id: 77, name: '作者' },
    tags: [{ name: 'タグA', translated_name: 'tag a' }, { name: 'タグB', translated_name: null }],
    create_date: '2026-09-18T20:00:00+09:00',
    image_urls: { square_medium: `https://i.pximg.net/c/360x360_70/img-master/${id}_p0_square1200.jpg`, medium: `https://i.pximg.net/c/540x540_70/img-master/${id}_p0_master1200.jpg`, large: `https://i.pximg.net/c/600x1200_90/img-master/${id}_p0_master1200.jpg` },
    meta_single_page: { original_image_url: `https://i.pximg.net/img-original/img/${id}_p0.png` },
    meta_pages: [],
    illust_ai_type: 1, x_restrict: 0, is_bookmarked: false, total_bookmarks: 12, width: 1200, height: 1600,
    ...over,
  };
}

function multi(id, pages, over = {}) {
  return illust(id, {
    page_count: pages,
    meta_single_page: {},
    meta_pages: Array.from({ length: pages }, (_, i) => ({
      image_urls: {
        medium: `https://i.pximg.net/c/540x540_70/img-master/${id}_p${i}_master1200.jpg`,
        large: `https://i.pximg.net/c/600x1200_90/img-master/${id}_p${i}_master1200.jpg`,
        original: `https://i.pximg.net/img-original/img/${id}_p${i}.jpg`,
      },
    })),
    ...over,
  });
}

// 偽の API。呼び出しを記録し、種類ごとの返事を返す
function fakeApi(pages) {
  const calls = [];
  const listing = (name) => async (...args) => {
    calls.push([name, ...args]);
    const offset = Number((args[args.length - 1] || {}).offset || (typeof args[1] === 'object' ? args[1].offset : 0) || 0);
    const rows = pages(name, offset, args);
    const more = rows.length === 30;
    return { illusts: rows, next_url: more ? `https://app-api.pixiv.net/x?offset=${offset + 30}` : null };
  };
  return {
    calls,
    illustFollow: listing('follow'),
    illustNew: listing('new'),
    illustRecommended: listing('recommended'),
    ranking: listing('ranking'),
    searchIllust: listing('search'),
    bookmarks: listing('bookmarks'),
    userIllusts: listing('user'),
    async illustDetail(id) { calls.push(['detail', id]); return multi(id, 3); },
    async userDetail(id) { calls.push(['userDetail', id]); return { user: { id, name: '作者', account: 'acct', profile_image_urls: { medium: 'https://i.pximg.net/user-profile/x.png' } }, profile: { total_illusts: 40, total_manga: 2 } }; },
    async autocomplete(word) { calls.push(['autocomplete', word]); return [{ name: `${word}タグ`, translated_name: 'tr' }, { name: `${word}2`, translated_name: null }]; },
    async image(url) { calls.push(['image', url]); return { buffer: Buffer.from([9]), headers: { 'content-type': 'image/jpeg' } }; },
  };
}

const rows30 = (from) => Array.from({ length: 30 }, (_, i) => illust(from + i));

test('検索期間は公開日順と人気順から独立し、全期間・今日・1週間・1か月を指定できる', () => {
  const now = new Date(2026, 8, 22, 15);
  for (const sort of ['added', 'year', 'month']) {
    for (const [pixivPeriod, since] of [['year', ''], ['today', '2026-09-22'], ['week', '2026-09-15'], ['month', '2026-08-22']]) {
      const plan = adapter.planFor({query:'風景', sort, pixivPeriod}, adapter.parseQuery('風景'), {}, now);
      assert.equal(plan.since, since);
      assert.equal(plan.sortKey, sort === 'added' ? 'date_desc' : 'popular_desc');
      assert.equal(plan.hideAi, false);
      assert.equal(plan.filter.manga, false);
      assert.equal(plan.filter.r18, false);
    }
  }
  const query = '風景 since:2020-01-01 until:2020-12-31';
  const plan = adapter.planFor({query, sort:'added', pixivPeriod:'month'}, adapter.parseQuery(query), {}, now);
  assert.equal(plan.since,'2020-01-01');
  assert.equal(plan.until,'2020-12-31');
  const endOfMonth = adapter.planFor({query:'風景',sort:'added',pixivPeriod:'month'},adapter.parseQuery('風景'),{},new Date(2026,2,31));
  assert.equal(endOfMonth.since,'2026-02-28');
});

function install(api, over = {}) {
  adapter._resetForTest();
  return pixivBundle._setForTest({
    api,
    auth: { loggedIn: () => true, user: { id: '42', name: '自分' } },
    manners: { state: () => ({ api: { waiting: 0 }, pausedForMs: 0 }) },
    settings: { hideAi: false, bookmarkPrivate: true, bookmarkRestrict: 'private' },
    ...over,
  });
}

test('検索欄の語を読む: 語・user:・id:・裸の番号・"完全一致"・期間・候補', () => {
  const p = adapter.parseQuery('ヤンデレ -ホラー "ブルアカ" user:123 since:2026-01-01 until:2026-02-01 date:2026-09-18');
  assert.deepEqual(p.words, ['ブルアカ', 'ヤンデレ', '-ホラー']);
  assert.equal(p.exact, true);
  assert.equal(p.user, '123');
  assert.equal(p.since, '2026-01-01');
  assert.equal(p.until, '2026-02-01');
  assert.equal(p.date, '2026-09-18');
  assert.equal(adapter.parseQuery('123456789').id, '123456789');
  assert.equal(adapter.parseQuery('id:55').id, '55');
  assert.deepEqual(adapter.parseQuery('bm:private').bm, 'private');
  assert.equal(adapter.parseQuery('bookmarks:').bookmarks, true);
  assert.equal(adapter.parseQuery('exact:foo').exact, true);
});

test('並びと語から一覧の種類が決まる (設計 §4 の表)', () => {
  const restore = install(fakeApi(() => []));
  try {
    const plan = (query, sort, type = '') => adapter.planFor({ query, sort, type }, adapter.parseQuery(query), pixivBundle.settings(), new Date(2026, 8, 19));
    assert.equal(plan('', 'follow').mode, 'follow');
    assert.equal(plan('', 'added').mode, 'new');
    assert.equal(plan('', 'added', 'manga').contentType, 'manga');
    assert.deepEqual([plan('', 'today').rankMode, plan('', 'week').rankMode, plan('', 'month').rankMode, plan('', 'year').rankMode], ['day', 'week', 'month', 'month']);
    assert.ok(plan('', 'year').note, '全期間は今月に落として一言');
    assert.equal(plan('', 'today', 'manga').rankMode, 'day_manga');
    assert.equal(plan('', 'today', 'r18').rankMode, 'day_r18');
    assert.equal(plan('', 'month', 'r18').rankMode, 'week_r18', 'month_r18 は無い');
    assert.equal(plan('', 'bookmarks').mode, 'bookmarks');
    assert.equal(plan('', 'bookmarks').restrict, 'all');
    assert.equal(plan('', 'bookmarks').userId, '42');
    const s = plan('ヤンデレ', 'added');
    assert.equal(s.mode, 'search');
    assert.equal(s.sortKey, 'date_desc');
    assert.equal(s.since, '');
    const w = plan('ヤンデレ', 'week');
    assert.equal(w.sortKey, 'popular_desc');
    assert.equal(w.since, '2026-09-12');
    assert.equal(plan('ヤンデレ', 'year').since, '', '全期間は期間なし');
    assert.equal(plan('ヤンデレ', 'today', 'r18').word, 'ヤンデレ R-18', 'R-18 は語で足す');
    // フォロー + 語は pixiv 全体の検索 (フォロー新着を語で漉すと pixiv の検索と食い違う)
    const f = plan('ヤンデレ', 'follow');
    assert.equal(f.mode, 'search', 'フォロー + 語は pixiv 全体の検索');
    assert.equal(f.sortKey, 'date_desc');
    assert.deepEqual(plan('', 'follow').filter.words, [], '空 + フォローは絞らない');
    assert.deepEqual(plan('ヤンデレ', 'bookmarks').filter.words, ['ヤンデレ']);
    assert.equal(plan('user:9', 'today').mode, 'user');
    assert.equal(plan('user:9', 'today', 'manga').type, 'manga', '作者の投稿は API が漫画を絞る');
    assert.equal(plan('"ブルアカ"', 'added').exact, true);
  } finally { restore(); }
});

test('フォロー新着: 一頁ぶんは 30 件ずつ取り、札は px: の形。うごイラは印だけ', async () => {
  const api = fakeApi((name, offset) => (offset < 60 ? rows30(1000 + offset).map((r, i) => (i === 0 && offset === 0 ? { ...r, type: 'ugoira' } : r)) : []));
  const restore = install(api);
  try {
    const out = await adapter.search({ query: '', sort: 'follow', page: 0, pageSize: 24 });
    assert.equal(out.galleries.length, 24);
    assert.equal(api.calls.filter((c) => c[0] === 'follow').length, 1, '一頁目は一往復');
    const [first, second] = out.galleries;
    assert.equal(first.id, 'px:1000');
    assert.equal(first.source, 'pixiv');
    assert.equal(first.badge, 'うごイラ');
    assert.equal(first.pageCount, 0, 'うごイラは頁を持たない');
    assert.equal(second.title, '題 1001');
    assert.deepEqual(second.artists.map((a) => [a.type, a.name, a.userId]), [['artist', '作者', '77']]);
    assert.deepEqual(second.tags.map((t) => [t.name, t.label]), [['タグA', 'tag a'], ['タグB', undefined]]);
    assert.equal(second.url, 'https://www.pixiv.net/artworks/1001');
    assert.equal(second.publishedDate, '2026-09-18T20:00:00+09:00');
    assert.equal(second.ai, false);
    assert.equal(second.r18, false);
    assert.equal(second.shape, 'tall');
    assert.equal(second.owned, false);
    const more = await adapter.search({ query: '', sort: 'follow', page: 1, pageSize: 24 });
    assert.equal(more.galleries.length, 24);
    assert.equal(more.galleries[0].id, 'px:1024');
    assert.equal(api.calls.filter((c) => c[0] === 'follow').length, 2, '二頁目で次の 30 件');
  } finally { restore(); }
});

test('間引きは遠隔の頁で行い、足りないぶんを次の頁で埋める。空が続いたら打ち切る', async () => {
  // 漫画は 30 件に 3 件だけ。フォローで漫画の札を選ぶと、pager が頁を重ねて埋める
  const api = fakeApi((name, offset) => (offset < 300 ? rows30(offset).map((r, i) => (i % 10 === 0 ? { ...r, type: 'manga' } : r)) : []));
  const restore = install(api);
  try {
    const out = await adapter.search({ query: '', sort: 'follow', type: 'manga', page: 0, pageSize: 24 });
    assert.equal(out.galleries.length, 24, '24 枚そろう');
    assert.ok(out.galleries.every((g) => g.type === 'manga'));
    assert.equal(api.calls.filter((c) => c[0] === 'follow').length, 8, '30 件に 3 件なので 8 頁重ねる');
    assert.equal(out.hasNext, true);
  } finally { restore(); }

  // 一枚も残らない頁が 4 つ続いたら諦める (網を無限に叩かない)。
  // 鍵 (一覧の種類 + 絞り) が上と違うので pager の控えには当たらない: R-18 の札で
  const none = fakeApi((name, offset) => (offset < 3000 ? rows30(offset) : []));
  const restore2 = install(none);
  try {
    const out = await adapter.search({ query: '', sort: 'follow', type: 'r18', page: 0, pageSize: 24 });
    assert.equal(out.galleries.length, 0);
    assert.equal(out.hasNext, false, '打ち切り');
    assert.equal(none.calls.filter((c) => c[0] === 'follow').length, 4);
  } finally { restore2(); }
});

test('AI を隠す: 検索は API に渡し、他の一覧は札の側で落とす', async () => {
  const api = fakeApi((name, offset) => (offset < 30 ? rows30(0).map((r, i) => (i % 2 ? { ...r, illust_ai_type: 2 } : r)) : []));
  const restore = install(api, { settings: { hideAi: true, bookmarkPrivate: true } });
  try {
    const out = await adapter.search({ query: '', sort: 'follow', page: 0, pageSize: 24 });
    assert.equal(out.galleries.length, 15);
    assert.ok(out.galleries.every((g) => !g.ai));
    await adapter.search({ query: 'ヤンデレ', sort: 'added', page: 0, pageSize: 24 });
    const searchCall = api.calls.find((c) => c[0] === 'search');
    assert.equal(searchCall[2].hideAi, true, '検索は search_ai_type で向こうに除かせる');
  } finally { restore(); }
});

test('種別 AI: AI 生成だけを出す。AI を隠す設定より種別が勝つ', async () => {
  const api = fakeApi((name, offset) => (offset < 30 ? rows30(500).map((r, i) => (i % 2 ? { ...r, illust_ai_type: 2 } : r)) : []));
  const restore = install(api, { settings: { hideAi: true, bookmarkPrivate: true } });
  try {
    const plan = adapter.planFor({ query: '', sort: 'follow', type: 'ai' }, adapter.parseQuery(''), { hideAi: true });
    assert.equal(plan.filter.aiOnly, true);
    assert.equal(plan.filter.hideAi, false, '隠したままでは棚が必ず空になる');
    const out = await adapter.search({ query: '', sort: 'follow', type: 'ai', page: 0, pageSize: 24 });
    assert.equal(out.galleries.length, 15);
    assert.ok(out.galleries.every((g) => g.ai));
    // AI だけの口は検索に無い (search_ai_type は隠すだけ): 向こうで除かせず、札の側で間引く
    const found = await adapter.search({ query: 'AI種別の語', sort: 'added', type: 'ai-r18', page: 0, pageSize: 24 });
    const searchCall = api.calls.find((c) => c[0] === 'search');
    assert.equal(searchCall[1], 'AI種別の語 R-18', 'R-18 は今まで通り語で絞る');
    assert.equal(searchCall[2].hideAi, false);
    assert.equal(found.galleries.length, 15);
    assert.ok(found.galleries.every((g) => g.ai));
  } finally { restore(); }
});

test('種別 AI のランキングは AI 生成の日間 (R-18 も)。他の期間は日間に落として一言', () => {
  const plan = (sort, type) => adapter.planFor({ query: '', sort, type }, adapter.parseQuery(''), {});
  assert.equal(plan('today', 'ai').rankMode, 'day_ai');
  assert.ok(!plan('today', 'ai').note);
  assert.equal(plan('today', 'ai').filter.aiOnly, true, '口が AI だけを返さなくても札の側で守る');
  assert.equal(plan('today', 'ai-r18').rankMode, 'day_r18_ai');
  assert.equal(plan('week', 'ai').rankMode, 'day_ai');
  assert.ok(plan('week', 'ai').note);
  assert.equal(plan('rookie', 'ai-r18').rankMode, 'day_r18_ai');
  assert.ok(plan('rookie', 'ai').note);
  // 漫画と R-18 は今まで通り
  assert.equal(plan('today', 'manga').rankMode, 'day_manga');
  assert.equal(plan('today', 'manga-r18').rankMode, 'day_manga');
  assert.equal(plan('today', 'r18').rankMode, 'day_r18');
  assert.equal(plan('today', 'r18').filter.aiOnly, false);
});

test('候補: 公開と非公開を合流し、新しい投稿から出す。語があれば絞る', async () => {
  const api = fakeApi((name, offset, args) => {
    if (name !== 'bookmarks') return [];
    const { restrict } = args[0];
    if (offset > 0) return [];
    // 公開は偶数、非公開は奇数の投稿 ID (どちらも新しい順)
    return Array.from({ length: 5 }, (_, i) => illust(restrict === 'public' ? 100 - i * 2 : 99 - i * 2, restrict === 'private' ? { tags: [{ name: '秘' }] } : {}));
  });
  const restore = install(api);
  try {
    const out = await adapter.search({ query: '', sort: 'bookmarks', page: 0, pageSize: 24 });
    assert.deepEqual(out.galleries.map((g) => g.id), ['px:100', 'px:99', 'px:98', 'px:97', 'px:96', 'px:95', 'px:94', 'px:93', 'px:92', 'px:91']);
    assert.equal(out.hasNext, false);
    const restricts = api.calls.filter((c) => c[0] === 'bookmarks').map((c) => c[1].restrict).sort();
    assert.deepEqual(restricts, ['private', 'public']);
    assert.ok(api.calls.filter((c) => c[0] === 'bookmarks').every((c) => c[1].userId === '42'), '自分の user_id で引く');
    const narrowed = await adapter.search({ query: '秘', sort: 'bookmarks', page: 0, pageSize: 24 });
    assert.deepEqual(narrowed.galleries.map((g) => g.id), ['px:99', 'px:97', 'px:95', 'px:93', 'px:91'], '語で絞る (タグに当たる)');
  } finally { restore(); }
});

test('番号か URL は詳細一枚。作者の札は user: で kind creator', async () => {
  const api = fakeApi(() => []);
  const restore = install(api);
  try {
    const one = await adapter.search({ query: '123456789', sort: 'follow' });
    assert.equal(one.total, 1);
    assert.equal(one.galleries[0].id, 'px:123456789');
    assert.equal(one.galleries[0].pageCount, 3);
    const creator = await adapter.getGallery('user:77');
    assert.equal(creator.id, 'pxu:77');
    assert.equal(creator.kind, 'creator');
    assert.equal(creator.badge, '42 件');
    assert.equal(creator.query, 'user:77');
    const detail = await adapter.getGallery('555');
    assert.equal(detail.id, 'px:555');
    assert.equal(api.calls.filter((c) => c[0] === 'detail').length, 2);
    // 二度目は控えから (詳細を引き直さない)
    await adapter.getGallery('555');
    assert.equal(api.calls.filter((c) => c[0] === 'detail').length, 2);
  } finally { restore(); }
});

test('頁の取得: 表紙は master、原本は original、二頁目は meta_pages。うごイラの原本は断る', async () => {
  const api = fakeApi(() => []);
  const restore = install(api);
  try {
    const big = await adapter.fetchImage('555', 0, { size: 'big' });
    assert.equal(big.type, 'image/jpeg');
    assert.match(api.calls.at(-1)[1], /600x1200_90.*555_p0_master1200\.jpg$/, '表紙は large');
    await adapter.fetchImage('555', 0, { size: 'small' });
    assert.match(api.calls.at(-1)[1], /540x540_70/, '小さい札は medium');
    await adapter.fetchImage('555', 1, { size: 'full' });
    assert.match(api.calls.at(-1)[1], /img-original\/img\/555_p1\.jpg$/, '原本');
    await assert.rejects(adapter.fetchImage('555', 9, { size: 'full' }), (e) => e.status === 404);
    adapter._cacheForTest.set('777', { at: Date.now(), value: { ...illust(777, { type: 'ugoira' }), __detail: true } });
    await assert.rejects(adapter.fetchImage('777', 0, { size: 'full' }), (e) => e.status === 415);
    const cover = await adapter.fetchImage('777', 0, { size: 'big' });
    assert.ok(cover.bytes.length, 'うごイラの表紙は出る');
    const face = await adapter.fetchImage('user:77', 0, { size: 'big' });
    assert.ok(face.bytes.length);
    assert.match(api.calls.at(-1)[1], /user-profile/);
  } finally { restore(); }
});

test('未ログインなら網に出ず、理由の付いた 401 を投げる', async () => {
  const api = fakeApi(() => rows30(0));
  const restore = install(api, { auth: { loggedIn: () => false, user: null } });
  try {
    await assert.rejects(adapter.search({ query: '', sort: 'follow' }), (e) => e.status === 401 && e.code === 'pixiv-login');
    assert.equal(api.calls.length, 0);
    assert.deepEqual(await adapter.suggestTags('ヤン'), []);
  } finally { restore(); }
});

test('補完: 2 字から、控えが効き、車線が混んでいれば網に出ない', async () => {
  const api = fakeApi(() => []);
  let waiting = 0;
  const restore = install(api, { manners: { state: () => ({ api: { waiting }, pausedForMs: 0 }) } });
  try {
    assert.deepEqual(await adapter.suggestTags('ヤ'), []);
    const out = await adapter.suggestTags('ヤン');
    assert.deepEqual(out, [
      { type: 'tag', name: 'ヤンタグ', label: 'ヤンタグ', translation: 'tr' },
      { type: 'tag', name: 'ヤン2', label: 'ヤン2', translation: '' },
    ]);
    await adapter.suggestTags('ヤン');
    assert.equal(api.calls.filter((c) => c[0] === 'autocomplete').length, 1, '二度目は控え');
    waiting = 1;
    assert.deepEqual(await adapter.suggestTags('デレ'), [], '混んでいる間は黙る');
    assert.equal(api.calls.filter((c) => c[0] === 'autocomplete').length, 1);
  } finally { restore(); }
});

test('辞書の言い換えを受けない (語をそのまま部分一致で引く)', () => {
  assert.equal(adapter.rewritesAliases, false);
  const index = require('fs').readFileSync(require.resolve('../src/lib/sources/index.js'), 'utf8');
  assert.match(index, /rewritesAliases === false/, 'sources/index.js がこの旗を見る');
});

test('ミュートした投稿は出さない (pixiv のアプリと同じ)', async () => {
  const api = fakeApi((name, offset) => (offset === 0 ? rows30(3000).map((r, i) => (i < 5 ? { ...r, is_muted: true } : r)) : []));
  const restore = install(api);
  try {
    // 鍵 (一覧の種類) は他の試験と被らない物に: remote-pages の控えは試験をまたいで残る
    const out = await adapter.search({ query: '', sort: 'added', page: 0, pageSize: 24 });
    assert.equal(out.galleries.length, 24);
    assert.ok(out.galleries.every((g) => Number(g.id.slice(3)) >= 3005), '頭の 5 件 (ミュート) が抜ける');
  } finally { restore(); }
});

test('読み手の大きさ: 眺める時は 1200 px の webp → master1200 → large と落ちる。原寸は落とす時だけ画像車線', async () => {
  const fails = new Set();
  const api = fakeApi(() => []);
  api.image = async (url, opts) => {
    api.calls.push(['image', url, opts]);
    if (fails.has(url)) throw Object.assign(new Error('403'), { status: 403 });
    return { buffer: Buffer.from([1]), headers: { 'content-type': 'image/webp' } };
  };
  const restore = install(api);
  try {
    assert.equal(adapter.readingSize('full'), 'read');
    assert.equal(adapter.readingSize('big'), 'big');
    adapter._cacheForTest.set('500', { value: multi(500, 2), at: Date.now() });
    assert.deepEqual(adapter.readUrls(adapter.pageUrls(multi(500, 2), 1)), [
      'https://i.pximg.net/c/1200x1200_90_webp/img-master/500_p1_master1200.jpg',
      'https://i.pximg.net/img-master/500_p1_master1200.jpg',
      'https://i.pximg.net/c/600x1200_90/img-master/500_p1_master1200.jpg',
      'https://i.pximg.net/c/540x540_70/img-master/500_p1_master1200.jpg',
    ]);
    const lastImage = () => api.calls.filter((c) => c[0] === 'image').pop();
    await adapter.fetchImage('500', 1, { size: 'read', reading: true });
    assert.match(lastImage()[1], /c\/1200x1200_90_webp/);
    assert.equal(lastImage()[2].lane, 'view', '読み手の頁は眺める車線');
    fails.add('https://i.pximg.net/c/1200x1200_90_webp/img-master/500_p1_master1200.jpg');
    await adapter.fetchImage('500', 1, { size: 'read', reading: true });
    assert.equal(lastImage()[1], 'https://i.pximg.net/img-master/500_p1_master1200.jpg', '無ければ master1200');
    await adapter.fetchImage('500', 1, { size: 'full' });
    assert.match(lastImage()[1], /img-original/);
    assert.equal(lastImage()[2].lane, 'download', '落とす原寸は画像車線 (PPD の数え方)');
    await adapter.fetchImage('500', 1, { size: 'full', reading: true });
    assert.equal(lastImage()[2].lane, 'view', '設定で原寸を読む時も眺める車線');
    await adapter.fetchImage('500', 0, { size: 'big' });
    assert.equal(lastImage()[2].lane, 'view', '表紙は眺める車線');
    assert.equal(api.calls.filter((c) => c[0] === 'detail').length, 0, '控えにある投稿は詳細を引かない');
  } finally { restore(); }
});

test('sources/index: 読み手が頼んだ原寸は源泉の眺める大きさに替わる (控えの鍵も)。落とす側は原寸のまま', () => {
  const sources = require('../src/lib/sources');
  const restore = install(fakeApi(() => []));
  try {
    assert.equal(sources.effectiveSize('pixiv', { size: 'full', reading: true }), 'read');
    assert.equal(sources.effectiveSize('pixiv', { size: 'full' }), 'full', '落とす側');
    assert.equal(sources.effectiveSize('pixiv', { size: 'big', reading: true }), 'big');
    assert.equal(sources.effectiveSize('hitomi', { size: 'full', reading: true }), 'full', '眺める大きさを持たない源泉はそのまま');
  } finally { restore(); }
  const original = install(fakeApi(() => []), { settings: { hideAi: false, bookmarkPrivate: true, bookmarkRestrict: 'private', readOriginal: true } });
  try {
    assert.equal(sources.effectiveSize('pixiv', { size: 'full', reading: true }), 'full', '設定で原寸');
  } finally { original(); }
});

test('発見: おすすめの作者 (投稿 3 枚つき) とおすすめの投稿。作者の顔は控えから。数分は控え', async () => {
  const api = fakeApi(() => []);
  api.userRecommended = async () => {
    api.calls.push(['userRecommended']);
    return {
      user_previews: [
        { user: { id: 501, name: '甲', account: 'a', profile_image_urls: { medium: 'https://i.pximg.net/user-profile/501.png' }, is_followed: false }, illusts: rows30(7000).slice(0, 4), is_muted: false },
        { user: { id: 502, name: '乙', profile_image_urls: { medium: 'https://i.pximg.net/user-profile/502.png' } }, illusts: [], is_muted: true },
      ],
      next_url: null,
    };
  };
  api.illustRecommended = async () => { api.calls.push(['illustRecommended']); return { illusts: rows30(8000).slice(0, 6), next_url: null }; };
  const restore = install(api);
  try {
    const view = await adapter.discover();
    assert.equal(view.users.length, 1, 'ミュートした作者は出さない');
    assert.equal(view.users[0].creator.id, 'pxu:501');
    assert.equal(view.users[0].creator.kind, 'creator');
    assert.equal(view.users[0].creator.following, false);
    assert.equal(view.users[0].creator.badge, '', '数の無い札に 0 件とは書かない');
    assert.equal(view.users[0].illusts.length, 3, '投稿は 3 枚まで');
    assert.equal(view.users[0].illusts[0].id, 'px:7000');
    assert.equal(view.illusts.length, 6);
    await adapter.fetchImage('user:501', 0, { size: 'big' });
    assert.equal(api.calls.filter((c) => c[0] === 'userDetail').length, 0, '顔の URL は控えから (user/detail を叩かない)');
    assert.equal(api.calls.filter((c) => c[0] === 'image').pop()[1], 'https://i.pximg.net/user-profile/501.png');
    await adapter.discover();
    assert.equal(api.calls.filter((c) => c[0] === 'userRecommended').length, 1, '二度目は控え');
    await adapter.discover({ fresh: true });
    assert.equal(api.calls.filter((c) => c[0] === 'userRecommended').length, 2, 'fresh で引き直す');
  } finally { restore(); }
});

test('recommended is distinct from bookmarks and pagination advances the recommendation API', async () => {
  const api=fakeApi((name,offset)=>name==='recommended'?(offset===0?rows30(5000):[illust(5030)]):[]);
  const restore=install(api);
  try {
    const first=await adapter.search({sort:'recommended',pageSize:30,page:0});
    const second=await adapter.search({sort:'recommended',pageSize:30,page:1});
    assert.equal(first.galleries.length,30);
    assert.equal(second.galleries[0].id,'px:5030');
    assert.deepEqual(api.calls.map(c=>c[0]),['recommended','recommended']);
    assert.equal(api.calls[1][1].offset,30);
    for(const [sort,mode] of [['rookie','week_rookie'],['original','week_original'],['male','day_male'],['female','day_female']])assert.equal(adapter.planFor({sort,type:''},adapter.parseQuery('')).rankMode,mode);
  } finally { restore(); }
});
test('recommendations can filter manga and R-18 independently', async () => {
  const api=fakeApi(()=>[illust(9101,{type:'manga',x_restrict:1}),illust(9102,{type:'manga'}),illust(9103,{x_restrict:1})]);
  const restore=install(api);
  try {
    const result=await adapter.search({sort:'recommended',type:'manga-r18',pageSize:30,page:0});
    assert.deepEqual(result.galleries.map(g=>g.id),['px:9101']);
  } finally { restore(); }
});

test('bookmarks continue beyond 32 entries using independent public/private cursors', async () => {
  const api=fakeApi(()=>[]), calls=[];
  api.bookmarks=async options=>{
    calls.push({...options});
    const first=!options.maxBookmarkId;
    const base=options.restrict==='public'?10000:5000;
    const count=first?16:19;
    return {illusts:Array.from({length:count},(_,i)=>illust(base-(first?0:16)-i,{title:'cursor-fixture'})),next_url:first?`https://app-api.pixiv.net/v1/user/bookmarks/illust?max_bookmark_id=${base-16}`:null};
  };
  const undo=install(api);
  try {
    const all=[];
    for(let page=0;page<5;page++){
      const result=await adapter.search({query:'cursor-fixture',sort:'bookmarks',page,pageSize:24});
      all.push(...result.galleries);
      if(!result.hasNext)break;
    }
    assert.equal(all.length,70);
    assert.equal(new Set(all.map(g=>g.id)).size,70);
    assert.deepEqual(calls.filter(c=>c.maxBookmarkId).map(c=>[c.restrict,c.maxBookmarkId]).sort(),[['private','4984'],['public','9984']]);
  } finally {undo();}
});

test('public-only bookmarks and empty-query new works follow cursor-only next pages', async () => {
  for(const mode of ['bookmarks','new']) {
    const api=fakeApi(()=>[]),calls=[];
    api[mode==='bookmarks'?'bookmarks':'illustNew']=async options=>{
      calls.push({...options});
      const first=!(options.maxBookmarkId||options.maxIllustId);
      return {illusts:Array.from({length:first?30:7},(_,i)=>illust(80000-(first?0:30)-i,{type:'manga',x_restrict:1})),next_url:first?`https://app-api.pixiv.net/x?${mode==='bookmarks'?'max_bookmark_id':'max_illust_id'}=79970`:null};
    };
    const undo=install(api,{settings:{bookmarkPrivate:false}});
    try {
      const args={query:'',sort:mode==='bookmarks'?'bookmarks':'added',type:mode==='new'?'manga':'manga-r18',pageSize:24};
      const first=await adapter.search({...args,page:0});
      const second=await adapter.search({...args,page:1});
      assert.equal(first.galleries.length+second.galleries.length,37);
      assert.equal(second.hasNext,false);
      assert.equal(calls[1][mode==='bookmarks'?'maxBookmarkId':'maxIllustId'],'79970');
    }finally{undo();}
  }
});

test('empty adult work search uses the R-18 tag in newest order without changing user input', () => {
  const plan=adapter.planFor({query:'',sort:'added',type:'r18'},adapter.parseQuery(''),{});
  assert.equal(plan.mode,'search');
  assert.equal(plan.word,'R-18');
  assert.equal(plan.sortKey,'date_desc');
  const manga=adapter.planFor({query:'',sort:'added',type:'manga-r18'},adapter.parseQuery(''),{});
  assert.equal(manga.filter.manga,true);
});

test('normal pixiv searches include title/caption hits; explicit exact queries stay tag-exact', async () => {
  const api = fakeApi(() => [illust(991, { title: '検索語なし', caption: 'キャプションだけの合言葉', tags: [] })]);
  const restore = install(api);
  try {
    const result = await adapter.search({ query: '合言葉', sort: 'added', page: 0, pageSize: 24 });
    const call = api.calls.find(c => c[0] === 'search');
    assert.equal(call[1], '合言葉');
    assert.equal(call[2].target, 'keyword');
    assert.equal(result.galleries.length, 1, 'APIのキャプション一致を手元のタグ判定で捨てない');
    await adapter.search({ query: 'exact:合言葉', sort: 'added', page: 0, pageSize: 24 });
    assert.equal(api.calls.filter(c => c[0] === 'search').at(-1)[2].target, 'exact_match_for_tags');
  } finally { restore(); }
});

test('related works exclude seed and muted works, cache the bounded result', async () => {
  let calls=0; const nexts=[];
  const api=fakeApi(()=>[]);
  api.illustRelated=async()=>{calls++;return {illusts:[illust(100),illust(101,{is_muted:true}),...rows30(200)],next_url:'https://app-api.pixiv.net/v2/illust/related?illust_id=100&seed_illust_ids%5B0%5D=200&offset=30'};};
  // 続きの頁: 一頁目と重なる一枚 (200) を混ぜる。三頁目は空 (終わり)
  api.next=async(url)=>{nexts.push(url);const page=nexts.length;return page===1?{illusts:[illust(200),...rows30(300)],next_url:'https://app-api.pixiv.net/v2/illust/related?illust_id=100&offset=60'}:{illusts:[],next_url:null};};
  const restore=install(api);
  try {
    const rows=await adapter.related('px:100');
    assert.equal(rows.length,12); assert.ok(rows.every(g=>g.id!=='px:100'&&g.id!=='px:101'));
    await adapter.related('px:100'); assert.equal(calls,1);
    // 読み手の継ぎ目は 30 件ずつ。一頁で足りる間は続きを辿らない
    const more=await adapter.related('px:100',{limit:30}); assert.equal(more.length,30); assert.equal(calls,1); assert.equal(nexts.length,0);
    // 足りなくなったら next_url を辿る。重なりは id で畳む
    const deep=await adapter.related('px:100',{limit:60}); assert.equal(deep.length,60); assert.equal(calls,1); assert.equal(nexts.length,1);
    assert.match(nexts[0],/seed_illust_ids/,'next_url をそのまま辿る');
    assert.equal(new Set(deep.map(g=>g.id)).size,60,'重なりは畳む');
    // 空の頁で終わり。終わりは控えに残り、頼み直しても網には出ない
    const all=await adapter.related('px:100',{limit:150}); assert.equal(all.length,60); assert.equal(nexts.length,2);
    await adapter.related('px:100',{limit:150}); assert.equal(nexts.length,2);
    assert.equal((await adapter.related('px:100',{limit:999})).length,60,'上限 150 を超える件数は求めない');
    await assert.rejects(adapter.related('bad'),/ID/);
  } finally { restore(); }
});
test('caption text is decoded once and preserved in Eagle annotation', () => {
  const {captionText}=require('../src/lib/pixiv/caption');
  const {annotationOf}=require('../src/lib/pixiv/importer');
  const text=captionText('Hello<br>A &lt; B &amp; C<script>bad()</script>');
  assert.equal(text,'Hello\nA < B & C');
  assert.ok(annotationOf({caption:text}).includes(text));
});


test('author name search returns creator candidates instead of guessing a user ID', async () => {
  const calls=[];
  const restore=install({searchUsers:async (word, options)=>{calls.push([word,options.offset]);return {user_previews:[{user:{id:501,name:'見本作者'}},{user:{id:502,name:'見本作者'}}],next_url:null};}});
  try {
    const result=await adapter.search({query:'artist:見本作者',pageSize:24});
    assert.deepEqual(calls,[['見本作者',0]]);
    assert.equal(result.galleries.length,2);
    assert.equal(result.galleries[0].kind,'creator');
    assert.equal(result.galleries[0].query,'user:501');
    assert.equal(result.hasNext,false);
  } finally {restore();}
});

test('author candidates follow the returned offset and stop a repeated cursor', async () => {
  const offsets=[];
  const restore=install({searchUsers:async (word, {offset})=>{offsets.push(offset);return {user_previews:[{user:{id:600+offset,name:'候補'}}],next_url:'https://app-api.pixiv.net/v1/search/user?offset=7'};}});
  try {
    const result=await adapter.search({query:'artist:paging_test',pageSize:24});
    assert.deepEqual(offsets,[0,7]);
    assert.equal(result.galleries.length,2);assert.equal(result.hasNext,false);
  } finally {restore();}
});


test('user search includes one author card on the first page only', async () => {
  const restore=install(fakeApi(()=>rows30(9000)));
  try {
    const first=await adapter.search({query:'user:77',page:0,pageSize:24});
    assert.equal(first.galleries[0].pinnedCreator,true);
    assert.equal(first.galleries[0].userId,'77');
    assert.equal(first.galleries[0].previewId,first.galleries[1].id);
    const next=await adapter.search({query:'user:77',page:1,pageSize:24});
    assert.equal(next.galleries.some(g=>g.pinnedCreator),false);
  }finally{restore();}
});


test('mixed author search preserves words when selecting a candidate, then filters that user', async () => {
  const api=fakeApi(()=>[illust(88251,{title:'winter scene'}),illust(88102,{title:'summer scene'})]);
  const words=[];api.searchUsers=async word=>{words.push(word);return {user_previews:[{user:{id:811,name:'Foo Bar'}}],next_url:null};};
  const restore=install(api);
  try {
    const candidates=await adapter.search({query:'winter artist:"Foo Bar"',pageSize:24});
    assert.deepEqual(words,['Foo Bar']);assert.equal(candidates.galleries[0].query,'user:811 winter');
    const works=await adapter.search({query:candidates.galleries[0].query,pageSize:24});
    assert.deepEqual(works.galleries.filter(g=>g.kind!=='creator').map(g=>g.id),['px:88251']);
  } finally {restore();}
});

test('creator candidate lookup falls back to retained names only after zero matches and keeps paging stable',async()=>{
 const api=fakeApi(()=>[]),calls=[];api.searchUsers=async(word,{offset})=>{calls.push([word,offset]);return {user_previews:word==='Canonical Example'?[{user:{id:899,name:'Candidate'}}]:[],next_url:null};};
 const restore=install(api);
 try {const result=await adapter.search({query:'artist:Missing_Display winter',authorNames:['Canonical Example','Unused Alias'],pageSize:24});assert.equal(result.galleries[0].query,'user:899 winter');assert.deepEqual(calls.map(c=>c[0]),['Missing Display','Canonical Example']);const next=await adapter.search({query:'artist:Missing_Display winter',authorNames:['Canonical Example','Unused Alias'],page:1,pageSize:24});assert.equal(next.galleries.length,0);assert.equal(calls.length,2);}finally{restore();}
});
