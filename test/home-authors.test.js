'use strict';

// Home (源泉横断の作者の一覧) の母屋側 (src/lib/home-authors.js)。docs/home-tab-spec-2026-09-23.md。
// 押さえるのは:
//   人の組み方 (作者フォルダ / hitomi だけの人 / 名前の一致は候補で、一対一に定まる時だけ)
//   結びの置き場 (pixiv は pixiv の台帳、Pawchive は paw-links、hitomi / nhentai は creator-links)
//   並び (★4・5 の割合は同じなら所持の多い順)・絞り・語 (@名前 は作者頁)
//   四つのサイトの URL の形
//   hitomi の網の作品は hasNext の無い返りから続きを決め、20 頁で打ち切る
// 名前・題はすべて見本 (実在の物は使わない)。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  HomeAuthors, buildHome, parseSiteUrl, siteUrl, nameKey, isoDate, comiket, eventOf, authorCard, findByQuery, sortPersons,
  SITE_KEYS, HOME_TYPES, HOME_SORTS, eagleAddedAt, creatorReadTimes, WEB_PAGE_SIZE, WEB_MAX_PAGES, WEB_LIMITS,
} = require('../src/lib/home-authors');
const { CreatorLinks, linkKey } = require('../src/lib/creator-links');
const { homeAuthorId, parseHomeAuthorId, parseId } = require('../src/lib/sources/ids');

const plain = (value) => JSON.parse(JSON.stringify(value));

// 作者根の項目 (paw-library の snapshot().items の形)
function pawItem(eagleId, folderId, extra = {}) {
  return {
    eagleId, creatorFolderId: folderId, name: `[20240501] [123${eagleId.length}45] 見本の題【12P】`,
    title: '見本の題', date: '20240501', postId: `123${eagleId.length}45`, pageCount: 12, star: 0, mtime: 1700000000000,
    ...extra,
  };
}

// 台帳の所持 (artist ごとの行)
function hitomiRow(artist, gid, extra = {}) {
  return {
    artist, gid, star: 0, addedAt: 1700000000000, published: '2023-08-13T00:00:00.000Z', added: null,
    title: `見本 ${gid}`, pages: 20, lang: 'japanese', ...extra,
  };
}

function baseInput(extra = {}) {
  return {
    folders: [
      { folderId: 'FOLDERA', name: '見本 作者' },
      { folderId: 'FOLDERB', name: '別の人' },
    ],
    pawItems: [
      pawItem('A1', 'FOLDERA', { star: 5 }),
      pawItem('A2', 'FOLDERA', { star: 4, date: '20250102', name: '[20250102] (C105) 見本' }),
      pawItem('A3', 'FOLDERA', { star: 1, date: null, postId: null, name: '手で入れた本' }),
      pawItem('B1', 'FOLDERB', { star: 2 }),
    ],
    hitomiRows: [],
    ...extra,
  };
}

test('作者フォルダの人: 本の出どころ・所持の数・★4 以上の割合・顔・最近の本', () => {
  const built = buildHome(baseInput());
  const a = built.byId.get(homeAuthorId('folder', 'FOLDERA'));
  assert.ok(a, '作者フォルダの人が居る');
  assert.equal(a.kind, 'folder');
  assert.equal(a.count, 3);
  assert.deepEqual(plain(a.bySource), { pixiv: 0, pawchive: 2, hitomi: 0, local: 1, discord: 0 });
  assert.equal(a.high, 2);
  assert.ok(Math.abs(a.ratio - 2 / 3) < 1e-9);
  assert.equal(a.cover, 'pwlibf:FOLDERA', '顔は作者フォルダの札 (母屋が一番新しい本の表紙を借りる)');
  assert.equal(a.lastDate, '2025-01-02');
  // 持ち込みの本があるので ? を出す
  assert.equal(a.unsure, true);
  assert.deepEqual(plain(a.sites), ['pawchive']);
  // 本は発表の日付の新しい順、日付の無い本は最後
  assert.deepEqual(a.books.map((book) => book.id), ['pweagle:A2', 'pweagle:A1', 'pweagle:A3']);
  assert.equal(a.books[0].event, 105, '即売会の記号を名前から拾う');
  assert.equal(a.recent.length, 3);
});

test('pixiv の本は台帳の投稿日と頁数、読んだ印は px: と pweagle: の両方を見る', () => {
  const built = buildHome(baseInput({
    pawItems: [pawItem('P1', 'FOLDERA', { source: 'pixiv', pixivId: '900', date: null, postId: null })],
    pixivWork: (pid) => (pid === '900' ? { date: '2024-11-03T10:00:00+09:00', pages: 7, title: '見本の投稿' } : null),
  }));
  const a = built.byId.get(homeAuthorId('folder', 'FOLDERA'));
  const book = a.books[0];
  assert.equal(book.id, 'px:900');
  assert.equal(book.origin, 'pixiv');
  assert.equal(book.date, '2024-11-03');
  assert.equal(book.pages, 7);
  assert.deepEqual(book.readKeys, ['px:900', 'pweagle:P1']);
  assert.deepEqual(plain(a.sites), ['pixiv']);
});

test('pixiv と Pawchive の結びは既存の台帳から。hitomi / nhentai は creator-links から', () => {
  const built = buildHome(baseInput({
    pixivCreators: { 4242: { folderId: 'FOLDERA', name: '見本 作者' } },
    pawCreators: { 'FANBOX:777': 'FOLDERA' },
    links: [
      { personId: 'FOLDERA', source: 'hitomi', name: 'sample artist' },
      { personId: 'FOLDERA', source: 'nhentai', name: 'sample-artist' },
    ],
  }));
  const a = built.byId.get(homeAuthorId('folder', 'FOLDERA'));
  assert.deepEqual(plain(a.links.pixiv), [{ value: '4242', url: 'https://www.pixiv.net/users/4242', state: 'linked' }]);
  assert.deepEqual(plain(a.links.pawchive), [{ value: 'fanbox:777', url: 'https://pawchive.pw/fanbox/user/777', state: 'linked' }]);
  assert.equal(a.links.hitomi[0].url, 'https://hitomi.la/artist/sample%20artist-all.html');
  assert.equal(a.links.nhentai[0].state, 'linked');
  assert.deepEqual(plain(a.sites), ['pixiv', 'pawchive', 'hitomi', 'nhentai']);
  // 結んだ hitomi の名乗りは作者頁の網の引き先になる
  assert.deepEqual(plain(a.handles), [{ type: 'artist', name: 'sample artist', candidate: false }]);
});

test('hitomi だけの人は所持 1 冊から並べる (下限は minOwned で変えられる)。札の名乗りは外せない', () => {
  const rows = [
    hitomiRow('three books', 1), hitomiRow('three books', 2), hitomiRow('three books', 3),
    hitomiRow('two books', 4), hitomiRow('two books', 5),
    hitomiRow('followed one', 6),
  ];
  const built = buildHome(baseInput({ hitomiRows: rows, followed: new Set(['followed one']) }));
  assert.ok(built.byId.get(homeAuthorId('hitomi', 'three books')));
  assert.ok(built.byId.get(homeAuthorId('hitomi', 'two books')), '2 冊も並べる');
  const strict = buildHome(baseInput({ hitomiRows: rows, followed: new Set(['followed one']), minOwned: 3 }));
  assert.equal(strict.byId.get(homeAuthorId('hitomi', 'two books')), undefined, '下限 3 なら 2 冊は並べない');
  assert.ok(strict.byId.get(homeAuthorId('hitomi', 'followed one')), 'followed は下限に関わらず並べる');
  const followed = built.byId.get(homeAuthorId('hitomi', 'followed one'));
  assert.ok(followed, 'followed は 1 冊でも並べる');
  assert.equal(followed.links.hitomi[0].fixed, true);
  assert.equal(followed.links.nhentai[0].state, 'candidate', 'nhentai は名乗りから推した候補');
  assert.equal(followed.links.nhentai[0].value, 'followed-one');
  // nhentai の推測は見出しの印に出さない
  assert.deepEqual(plain(followed.sites), ['hitomi']);
  assert.equal(followed.unsure, false);
  assert.equal(followed.cover, '6', 'hitomi だけの人の顔は一番新しい所持の本');
});

test('名前の一致は候補。一つの作者フォルダと一つの artist に定まる時だけ (確定はしない)', () => {
  const rows = [
    hitomiRow('mihon sakusha', 11), hitomiRow('mihon sakusha', 12),
    // 札が作者フォルダの名前と同じ (空白と大小を無視して一致)
    hitomiRow('other name', 21, { title: '見本 21' }),
  ];
  const labels = { 'mihon sakusha': '見本作者', 'other name': '' };
  const built = buildHome(baseInput({ hitomiRows: rows, labelOf: (artist) => labels[artist] || '' }));
  const a = built.byId.get(homeAuthorId('folder', 'FOLDERA'));
  assert.equal(a.links.hitomi.length, 1);
  assert.equal(a.links.hitomi[0].state, 'candidate');
  assert.equal(a.links.hitomi[0].value, 'mihon sakusha');
  // 候補の本は所持の数に入れない
  assert.equal(a.count, 3);
  assert.equal(a.books.filter((book) => book.candidate).length, 2);
  assert.equal(a.hasCandidate, true);
  assert.equal(a.unsure, true);
  // 候補にした artist は hitomi だけの人として別に立てない
  assert.equal(built.byId.get(homeAuthorId('hitomi', 'mihon sakusha')), undefined);
});

test('候補が二つ以上に割れる時は出さない (作者フォルダ側でも artist 側でも)', () => {
  const rows = [
    hitomiRow('first', 1), hitomiRow('first', 2), hitomiRow('first', 3),
    hitomiRow('second', 4), hitomiRow('second', 5), hitomiRow('second', 6),
  ];
  // 二つの artist が同じ作者フォルダの名前に当たる
  const built = buildHome(baseInput({ hitomiRows: rows, labelOf: () => '見本作者' }));
  const a = built.byId.get(homeAuthorId('folder', 'FOLDERA'));
  assert.equal(a.links.hitomi.length, 0, '二つに割れたら候補にしない');
  // 表示名は人ごとに一つ (作者頁の @名前 が一人に定まる)
  const names = built.persons.map((person) => person.name);
  assert.equal(new Set(names).size, names.length);
  // 同じ名前の作者フォルダが二つあれば、artist 側から見て割れる
  const twin = buildHome({
    folders: [{ folderId: 'F1', name: '同名' }, { folderId: 'F2', name: '同名' }],
    hitomiRows: [hitomiRow('dou mei', 1)],
    labelOf: () => '同名',
  });
  assert.equal(twin.byId.get(homeAuthorId('folder', 'F1')).links.hitomi.length, 0);
  assert.equal(twin.byId.get(homeAuthorId('folder', 'F2')).links.hitomi.length, 0);
});

test('「違う」と退けた候補は二度出さない。結んだ artist の本は作者フォルダの人に束ねる', () => {
  const rows = [hitomiRow('mihon sakusha', 11), hitomiRow('mihon sakusha', 12), hitomiRow('mihon sakusha', 13)];
  const labelOf = () => '見本作者';
  const rejected = buildHome(baseInput({
    hitomiRows: rows, labelOf, rejected: new Set([linkKey('FOLDERA', 'hitomi', 'mihon sakusha')]),
  }));
  assert.equal(rejected.byId.get(homeAuthorId('folder', 'FOLDERA')).links.hitomi.length, 0);
  // 退けたので hitomi だけの人として立つ (所持 3 冊)
  assert.ok(rejected.byId.get(homeAuthorId('hitomi', 'mihon sakusha')));

  const linked = buildHome(baseInput({
    hitomiRows: rows, labelOf, links: [{ personId: 'FOLDERA', source: 'hitomi', name: 'mihon sakusha' }],
  }));
  const a = linked.byId.get(homeAuthorId('folder', 'FOLDERA'));
  assert.equal(a.count, 6, '結んだ artist の本は所持に数える');
  assert.equal(a.bySource.hitomi, 3);
  assert.equal(linked.byId.get(homeAuthorId('hitomi', 'mihon sakusha')), undefined, '別の人として立てない');
});

test('発見の新作は artist ごとに数えて、候補と結んだ作者フォルダにも足す', () => {
  const rows = [hitomiRow('mihon sakusha', 11)];
  const built = buildHome(baseInput({
    hitomiRows: rows, labelOf: () => '見本作者', newByArtist: new Map([['mihon sakusha', 2]]),
  }));
  assert.equal(built.byId.get(homeAuthorId('folder', 'FOLDERA')).newCount, 2);
});

function searchable(extra = {}) {
  const home = new HomeAuthors({ reading: { summary: () => extra.marks || {} } });
  home.cache = { ...buildHome(extra.input || baseInput()), signature: 'x' };
  home.signature = () => 'x';
  return home;
}

test('並び: ★4・5 の割合の多い順 (同じなら所持の多い順)、所持の多い順、名前、向き', async () => {
  const input = baseInput({
    folders: [
      { folderId: 'F1', name: 'い' }, { folderId: 'F2', name: 'あ' }, { folderId: 'F3', name: 'う' },
    ],
    pawItems: [
      pawItem('X1', 'F1', { star: 5 }), pawItem('X2', 'F1', { star: 4 }), // 2/2
      pawItem('Y1', 'F2', { star: 4 }), // 1/1 (同じ割合、所持が少ない)
      pawItem('Z1', 'F3', { star: 3 }), pawItem('Z2', 'F3', { star: 4 }), pawItem('Z3', 'F3', { star: 0 }), // 1/3
    ],
  });
  const home = searchable({ input });
  const names = async (payload) => (await home.search(payload)).galleries.map((g) => g.title);
  assert.deepEqual(await names({ sort: 'stars' }), ['い', 'あ', 'う']);
  assert.deepEqual(await names({ sort: 'owned' }), ['う', 'い', 'あ']);
  assert.deepEqual(await names({ sort: 'title' }), ['あ', 'い', 'う']);
  assert.deepEqual(await names({ sort: 'title', sortDir: 'asc' }), ['う', 'い', 'あ']);
  const page = await home.search({ sort: 'title', pageSize: 2, page: 0 });
  assert.equal(page.total, 3);
  assert.equal(page.hasNext, true);
  assert.equal(page.galleries.length, 2);
  // 札は本体の作者の見出しの形 (人なので済は立てない)
  const card = page.galleries[0];
  assert.equal(card.source, 'home');
  assert.equal(card.kind, 'creator');
  assert.equal(card.owned, false);
  assert.deepEqual(plain(card.artists), []);
});

test('最近読んだ順は栞の新しい順 (所持の本の読んだ印の一番新しい物)', async () => {
  const input = baseInput();
  const home = searchable({ input, marks: { 'pweagle:B1': { updatedAt: 500 }, 'pweagle:A1': { updatedAt: 100 } } });
  const result = await home.search({ sort: 'read' });
  assert.deepEqual(result.galleries.map((g) => g.title), ['別の人', '見本 作者']);
});

test('絞り: 語は作者名の部分一致 (NFKC・大小・空白と下線を無視)。種別は外した (前の会の type は効かない)', async () => {
  const input = baseInput({
    hitomiRows: [hitomiRow('some_body', 1), hitomiRow('some_body', 2), hitomiRow('some_body', 3)],
    pixivCreators: { 1: { folderId: 'FOLDERB' } },
  });
  const home = searchable({ input });
  const titles = async (payload) => (await home.search(payload)).galleries.map((g) => g.title).sort();
  assert.deepEqual(await titles({ query: 'ｍｉｈｏｎ' }), []);
  assert.deepEqual(await titles({ query: '見本作者' }), ['見本 作者'], '空白を無視');
  assert.deepEqual(await titles({ query: 'SOME BODY' }), ['some body'], '下線と大小を無視');
  const all = await titles({});
  assert.deepEqual(await titles({ type: 'pixiv' }), all, '種別の絞りは無い');
  assert.deepEqual(await titles({ type: 'candidate' }), all);
});

test('@名前 は作者頁の語: 一覧は空で、作者と所持の本を添えて返す', async () => {
  const home = searchable();
  home.bookGalleries = (person) => person.books.map((book) => ({ id: book.id, gallery: { id: book.id } }));
  const result = await home.search({ query: '@見本 作者' });
  assert.deepEqual(plain(result.galleries), []);
  assert.equal(result.homeAuthor.author.id, homeAuthorId('folder', 'FOLDERA'));
  assert.equal(result.homeAuthor.books.length, 3);
  const missing = await home.search({ query: '@居ない人' });
  assert.equal(missing.homeAuthor, null);
});

test('四つのサイトの URL の形', () => {
  assert.equal(parseSiteUrl('pixiv', 'https://www.pixiv.net/users/12345'), '12345');
  assert.equal(parseSiteUrl('pixiv', 'https://www.pixiv.net/en/users/12345/artworks'), '12345', 'en の形も受ける');
  assert.equal(parseSiteUrl('pixiv', 'https://www.pixiv.net/artworks/12345'), '', '作品の URL は作者ではない');
  assert.equal(parseSiteUrl('pawchive', 'https://pawchive.pw/fanbox/user/777'), 'fanbox:777');
  assert.equal(parseSiteUrl('pawchive', 'https://pawchive.st/Patreon/user/888?o=50'), 'patreon:888');
  assert.equal(parseSiteUrl('pawchive', 'https://pawchive.pw/fanbox/post/1'), '');
  assert.equal(parseSiteUrl('hitomi', 'https://hitomi.la/artist/sample%20artist-all.html'), 'sample artist');
  assert.equal(parseSiteUrl('hitomi', 'https://hitomi.la/artist/sample%20artist-japanese.html'), 'sample artist', '-japanese 等も受ける');
  assert.equal(parseSiteUrl('hitomi', 'https://hitomi.la/tag/female%3Aglasses-all.html'), '');
  assert.equal(parseSiteUrl('nhentai', 'https://nhentai.net/artist/sample-artist/'), 'sample-artist');
  assert.equal(parseSiteUrl('nhentai', 'https://nhentai.net/artist/sample-artist'), 'sample-artist');
  assert.equal(parseSiteUrl('nhentai', 'https://nhentai.net/g/123/'), '');
  assert.equal(parseSiteUrl('pixiv', 'https://evil.example/users/1'), '');
  assert.equal(parseSiteUrl('x', 'https://x.com/sample'), '', 'X・DLsite・FANZA の行は作らない');
  // 組み立てと取り出しが往復する
  for (const [site, value] of [['pixiv', '12'], ['pawchive', 'fanbox:9'], ['hitomi', 'two words'], ['nhentai', 'two-words']]) {
    assert.equal(parseSiteUrl(site, siteUrl(site, value)), value, site);
  }
  assert.deepEqual(SITE_KEYS, ['pixiv', 'pawchive', 'hitomi', 'nhentai']);
});

test('名前の鍵・日付・即売会の回', () => {
  assert.equal(nameKey('ミホン・サクシャ'), nameKey('みほん さくしゃ'));
  assert.equal(nameKey('Some_Body'), 'somebody');
  assert.equal(isoDate('20240501'), '2024-05-01');
  assert.equal(isoDate('2024-05-01T12:00:00Z'), '2024-05-01');
  assert.equal(isoDate(0), null);
  assert.equal(isoDate(''), null);
  assert.deepEqual(plain(comiket(104)), { year: 2024, season: '夏', month: 8 });
  assert.deepEqual(plain(comiket(105)), { year: 2024, season: '冬', month: 12 });
  assert.deepEqual(plain(comiket(99)), { year: 2021, season: '冬', month: 12 });
  assert.deepEqual(plain(comiket(98)), { year: 2020, season: '中止', month: 5 });
  assert.deepEqual(plain(comiket(96)), { year: 2019, season: '夏', month: 8 });
  assert.deepEqual(plain(comiket(84)), { year: 2013, season: '夏', month: 8 });
  assert.equal(eventOf('(C104) [見本] 題'), 104);
  assert.equal(eventOf('ABC104 題'), null, '英数字に続く物は即売会ではない');
});

test('Home の作者の見出しの id は ids.js が形を持つ', () => {
  const id = homeAuthorId('hitomi', 'a "quoted" name');
  assert.ok(!/["\s]/.test(id), '選択子に通る字だけ');
  assert.deepEqual(plain(parseHomeAuthorId(id)), { kind: 'hitomi', key: 'a "quoted" name' });
  assert.deepEqual(plain(parseHomeAuthorId(homeAuthorId('folder', 'ABC'))), { kind: 'folder', key: 'ABC' });
  assert.equal(parseHomeAuthorId('pweagle:ABC'), null);
  assert.equal(parseId(id).source, 'home');
  assert.deepEqual(HOME_TYPES, ['']);
  assert.deepEqual(HOME_SORTS, ['activity', 'read', 'rating', 'stars', 'owned', 'title']);
  // hitomi だけのサークルは 'c'
  const circle = homeAuthorId('circle', 'a circle');
  assert.deepEqual(plain(parseHomeAuthorId(circle)), { kind: 'circle', key: 'a circle' });
});

// ---- 結びを書く ----------------------------------------------------------

function linkable(extra = {}) {
  const pixivBinds = {};
  const pawBinds = {};
  const pixiv = {
    creatorBindings: () => ({ ...pixivBinds }),
    stats: () => ({ works: 0, creators: Object.keys(pixivBinds).length }),
    get: () => null,
    has: () => false,
    bindCreator(userId, folderId, name) { pixivBinds[userId] = { folderId, name }; return pixivBinds[userId]; },
    unbindCreator(userId, folderId = null) {
      // 本物 (pixiv/library.js) と同じく、folderId を渡さなければ誰に結ばれていても外す
      if (!pixivBinds[userId] || (folderId != null && pixivBinds[userId].folderId !== folderId)) return false;
      delete pixivBinds[userId];
      return true;
    },
  };
  const pawLinks = {
    creatorBindings: () => ({ ...pawBinds }),
    getCreator: (service, user) => pawBinds[`${service}:${user}`] || null,
    setCreator(service, user, folderId) {
      if (folderId) pawBinds[`${service}:${user}`] = folderId;
      else delete pawBinds[`${service}:${user}`];
    },
    flush() {},
  };
  const creatorLinks = new CreatorLinks({ now: () => 1700000000000 });
  const input = extra.input || baseInput({
    hitomiRows: [hitomiRow('mihon sakusha', 11), hitomiRow('lonely', 1), hitomiRow('lonely', 2), hitomiRow('lonely', 3)],
  });
  const labels = { 'mihon sakusha': '見本作者' };
  const catalog = {
    queryRows: () => input.hitomiRows,
    lookupTagLabel: (type, artist) => labels[artist] || '',
    unmatchedGen: 1,
    idSet: new Set(),
    db: {},
  };
  const pawLibrary = {
    ready: async () => true,
    snapshot: () => ({ root: 'R', folderId: 'ROOT', stamp: 's', items: input.pawItems }),
    creatorFolders: () => input.folders,
  };
  const home = new HomeAuthors({
    catalog, pawLibrary, pawLinks, creatorLinks, getPixivLibrary: () => pixiv,
  });
  return { home, pixivBinds, pawBinds, creatorLinks };
}

test('結ぶ: pixiv は pixiv の台帳、Pawchive は paw-links、hitomi は creator-links (三つ目を作らない)', async () => {
  const { home, pixivBinds, pawBinds, creatorLinks } = linkable();
  const id = homeAuthorId('folder', 'FOLDERA');
  const pixiv = await home.link({ id, site: 'pixiv', op: 'save', url: 'https://www.pixiv.net/en/users/4242' });
  assert.equal(pixiv.ok, true);
  assert.deepEqual(plain(pixivBinds['4242']), { folderId: 'FOLDERA', name: '見本 作者' });
  assert.equal(pixiv.author.home.links.pixiv[0].state, 'linked', '書いた後の見出しを返す');
  assert.deepEqual(plain(pixiv.author.home.sites).includes('pixiv'), true);

  const paw = await home.link({ id, site: 'pawchive', op: 'save', url: 'https://pawchive.pw/fanbox/user/777' });
  assert.equal(paw.ok, true);
  assert.equal(pawBinds['fanbox:777'], 'FOLDERA');

  // 名前が一致した hitomi の候補を結ぶ
  const before = await home.author({ id });
  assert.equal(before.author.home.links.hitomi[0].state, 'candidate');
  const accept = await home.link({ id, site: 'hitomi', op: 'accept', url: before.author.home.links.hitomi[0].url });
  assert.equal(accept.ok, true);
  assert.equal(accept.author.home.links.hitomi[0].state, 'linked');
  assert.equal(creatorLinks.state('FOLDERA', 'hitomi', 'mihon sakusha'), 'linked');
  assert.equal(accept.author.home.count, 4, '結んだ artist の本が所持に入る');

  // 外す: それぞれの置き場から消える (hitomi は revokedAt の立った行で)
  assert.equal((await home.link({ id, site: 'pixiv', op: 'unlink', url: 'https://www.pixiv.net/users/4242' })).ok, true);
  assert.equal(pixivBinds['4242'], undefined);
  assert.equal((await home.link({ id, site: 'pawchive', op: 'unlink', url: 'https://pawchive.pw/fanbox/user/777' })).ok, true);
  assert.equal(pawBinds['fanbox:777'], undefined);
  const off = await home.link({ id, site: 'hitomi', op: 'unlink', url: 'https://hitomi.la/artist/mihon%20sakusha-all.html' });
  assert.equal(off.ok, true);
  assert.equal(creatorLinks.state('FOLDERA', 'hitomi', 'mihon sakusha'), 'rejected');
  assert.equal(off.author.home.links.hitomi.length, 0, '外した候補を二度出さない');
});

test('結べない時は理由を返す (形の違う URL・札の名乗り)。作者フォルダの無い人の pixiv / Pawchive は creator-links へ', async () => {
  const { home, creatorLinks } = linkable();
  const folder = homeAuthorId('folder', 'FOLDERA');
  const lonely = homeAuthorId('hitomi', 'lonely');
  assert.deepEqual(plain(await home.link({ id: folder, site: 'pixiv', op: 'save', url: 'https://www.pixiv.net/artworks/1' })), { ok: false, reason: 'form' });
  const pixiv = await home.link({ id: lonely, site: 'pixiv', op: 'save', url: 'https://www.pixiv.net/users/1' });
  assert.equal(pixiv.ok, true, '作者フォルダが無くても pixiv を結べる');
  assert.equal(creatorLinks.state('h:lonely', 'pixiv', '1'), 'linked');
  assert.ok(pixiv.author.home.links.pixiv.some((link) => link.state === 'linked' && link.url === 'https://www.pixiv.net/users/1'));
  const paw = await home.link({ id: lonely, site: 'pawchive', op: 'save', url: 'https://pawchive.pw/fanbox/user/1' });
  assert.equal(paw.ok, true);
  assert.equal(creatorLinks.state('h:lonely', 'pawchive', 'fanbox:1'), 'linked');
  assert.equal((await home.link({ id: lonely, site: 'pixiv', op: 'unlink', url: 'https://www.pixiv.net/users/1' })).ok, true);
  assert.equal(creatorLinks.state('h:lonely', 'pixiv', '1'), 'rejected');
  assert.deepEqual(plain(await home.link({ id: lonely, site: 'hitomi', op: 'unlink', url: 'https://hitomi.la/artist/lonely-all.html' })), { ok: false, reason: 'fixed' });
  assert.deepEqual(plain(await home.link({ id: folder, site: 'x', op: 'save', url: 'https://x.com/a' })), { ok: false, reason: 'site' });
  // hitomi だけの人でも nhentai の名乗りは結べる (creator-links の 'h:<artist>')
  const nh = await home.link({ id: lonely, site: 'nhentai', op: 'save', url: 'https://nhentai.net/artist/lonely-one/' });
  assert.equal(nh.ok, true);
  assert.ok(nh.author.home.links.nhentai.some((link) => link.state === 'linked'));
  // 見出しの口: hitomi だけの人も誰でも結べる (hitomi は別の名乗りを結ぶと束ねる。見出しそのものの名乗りは外せない)
  assert.deepEqual(plain(nh.author.home.linkable), { pixiv: true, pawchive: true, hitomi: true, nhentai: true });
});

test('「違う」は候補を退けて覚える (creator-links に退けた行)', async () => {
  const { home, creatorLinks } = linkable();
  const id = homeAuthorId('folder', 'FOLDERA');
  const author = (await home.author({ id })).author;
  const nh = author.home.links.nhentai.find((link) => link.state === 'candidate');
  assert.ok(nh, 'hitomi の候補から nhentai の候補も推している');
  const reply = await home.link({ id, site: 'nhentai', op: 'reject', url: nh.url });
  assert.equal(reply.ok, true);
  assert.equal(reply.author.home.links.nhentai.length, 0);
  assert.equal(creatorLinks.state('FOLDERA', 'nhentai', 'mihon-sakusha'), 'rejected');
});

// ---- 控え -----------------------------------------------------------------

test('控え: 初回は組み上がりを待ち、材料が動いたら前の控えで答えて裏で組み直す', async () => {
  const { home } = linkable();
  let builds = 0;
  const original = home.gather.bind(home);
  home.gather = (snap) => {
    builds += 1;
    return original(snap);
  };
  await home.search({});
  assert.equal(builds, 1);
  await home.search({});
  assert.equal(builds, 1, '動いていなければ組み直さない');
  home.invalidate();
  const stale = home.cache;
  await home.search({});
  assert.equal(home.cache, stale, 'その回は前の控えで答える');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(builds, 2, '裏で組み直した');
});

// ---- hitomi の網の作品 -------------------------------------------------

test('hitomi の網: hasNext の無い返りから続きを決め、20 頁 (60 件ずつ) で打ち切る', async () => {
  const calls = [];
  const fullPage = (page) => Array.from({ length: WEB_PAGE_SIZE }, (_, i) => ({
    id: page * WEB_PAGE_SIZE + i + 1, title: `見本 ${page}-${i}`, publishedDate: '2024-01-01T00:00:00.000Z',
  }));
  const { home } = linkable();
  home.deps.searchHitomi = async (payload) => {
    calls.push(plain(payload));
    return { galleries: fullPage(payload.page), total: 5000 };
  };
  home.deps.catalog.annotate = (list) => list.map((g) => ({ ...g, owned: g.id === 1 }));
  const id = homeAuthorId('hitomi', 'lonely');
  const result = await home.hitomiWorks({ id });
  assert.equal(calls.length, WEB_MAX_PAGES);
  assert.equal(calls[0].query, 'artist:lonely');
  assert.equal(calls[0].language, 'japanese');
  assert.equal(result.works.length, WEB_PAGE_SIZE * WEB_MAX_PAGES);
  assert.equal(result.more, true);
  assert.equal(result.works[0].gallery.owned, true, '台帳の照合で 済 を当てる');
  assert.equal(result.works[0].date, '2024-01-01');

  // 短い頁で止まる。二度目は控えから (網へ出ない)
  const short = linkable();
  const seen = [];
  short.home.deps.searchHitomi = async (payload) => {
    seen.push(payload.page);
    return { galleries: payload.page === 0 ? fullPage(0) : fullPage(1).slice(0, 5), total: null };
  };
  const first = await short.home.hitomiWorks({ id });
  assert.deepEqual(seen, [0, 1]);
  assert.equal(first.works.length, WEB_PAGE_SIZE + 5);
  assert.equal(first.more, false);
  await short.home.hitomiWorks({ id });
  assert.deepEqual(seen, [0, 1], '控えを使う');
});



// ---- サークルを先に・作者の頁への飛び・★ (2026-09-24) -----------------------

// 台帳の所持のサークル (group) の行
function groupRow(group, gid, extra = {}) {
  return {
    kind: 'group', tag: group, gid, star: 0, addedAt: 1700000000000, published: '2023-08-13T00:00:00.000Z',
    title: `見本 ${gid}`, pages: 20, lang: 'japanese', ...extra,
  };
}

function circleInput(extra = {}) {
  const rows = [
    // alpha: 3 冊とも同じサークル。beta: 3 冊のうち 2 冊 (6 割以上) が同じサークル → 二人で一枚
    hitomiRow('alpha', 1), groupRow('the circle', 1),
    hitomiRow('alpha', 2), groupRow('the circle', 2),
    hitomiRow('alpha', 3), groupRow('the circle', 3),
    hitomiRow('beta', 4), groupRow('the circle', 4),
    hitomiRow('beta', 5), groupRow('the circle', 5),
    hitomiRow('beta', 6),
    // free: サークルが割れている (どこにも寄らない)
    hitomiRow('free', 7), groupRow('side x', 7),
    hitomiRow('free', 8), groupRow('side y', 8),
    hitomiRow('free', 9),
    // 作者のタグの無いサークルだけの本
    groupRow('solo circle', 10), groupRow('solo circle', 11), groupRow('solo circle', 12),
  ];
  return baseInput({
    hitomiRows: rows,
    dominantShare: 0.6, // この組は 6 割の決まりで組んだ (既定は 0 = 一冊でもサークルの本があれば寄せる。下の試験)
    labelOf: (artist) => ({ alpha: '甲作者' })[artist] || '',
    groupLabelOf: (group) => ({ 'the circle': '架空サークル' })[group] || '',
    ...extra,
  });
}

test('サークルを先に: 作者の所持の 6 割以上が一つのサークルならサークルの見出しに束ねる (二人でも一枚)。サークルだけの本も見出しに', () => {
  const built = buildHome(circleInput());
  const circle = built.byId.get(homeAuthorId('circle', 'the circle'));
  assert.ok(circle, 'サークルの見出し');
  assert.equal(circle.name, '架空サークル', '名前はサークルの日本語の札');
  assert.equal(circle.count, 6);
  assert.equal(built.byId.get(homeAuthorId('hitomi', 'alpha')), undefined, '束ねた作者は別の見出しにしない');
  assert.equal(built.byId.get(homeAuthorId('hitomi', 'beta')), undefined);
  assert.deepEqual(circle.authors.map((author) => author.label), ['甲作者', 'beta']);
  assert.equal(circle.links.hitomi[0].value, 'group:the circle');
  assert.equal(circle.links.hitomi[0].url, 'https://hitomi.la/group/the%20circle-all.html');
  assert.equal(circle.links.hitomi[0].fixed, true);
  assert.deepEqual(plain(circle.handles), [{ type: 'group', name: 'the circle', candidate: false }], '網の作品はサークルの語で引く');
  // どこにも寄らない作者は作者の見出しのまま。寄り道したサークルは詳細に出すだけ
  const free = built.byId.get(homeAuthorId('hitomi', 'free'));
  assert.ok(free);
  // side x / side y の本は全部 free の物なので、別の見出しにせず free のサークルそのものとして持つ (寄り道ではない)
  assert.deepEqual(free.circles.map((row) => [row.group, row.minor]), [['side x', false], ['side y', false]]);
  assert.equal(built.byId.get(homeAuthorId('circle', 'side x')), undefined, '本が全部一人の作者の物のサークルは見出しにしない');
  const solo = built.byId.get(homeAuthorId('circle', 'solo circle'));
  assert.ok(solo, '作者のタグの無いサークルだけの本 (3 冊) も見出しになる');
  assert.equal(solo.count, 3);
  assert.equal(solo.name, 'solo circle');
  // 見出しの札: 題の下に作者名
  const card = authorCard(circle);
  assert.equal(card.title, '架空サークル');
  assert.equal(card.home.authorLine, '甲作者・beta');
  assert.equal(card.home.kind, 'circle');
});

test('詳細の「作者」から作者の頁へ: 見出しを持たない作者は、その作者の本だけの頁をその場で組む', async () => {
  const built = buildHome(circleInput());
  const circle = built.byId.get(homeAuthorId('circle', 'the circle'));
  const alpha = circle.authors.find((author) => author.artist === 'alpha');
  assert.equal(alpha.query, '@甲作者');
  const page = findByQuery(built, alpha.query);
  assert.ok(page && page.virtual, 'その場で組んだ作者の頁');
  assert.deepEqual(page.books.map((book) => book.id).sort(), ['1', '2', '3']);
  assert.deepEqual(plain(page.handles), [{ type: 'artist', name: 'alpha', candidate: false }]);
  assert.equal(page.circles[0].group, 'the circle');
  assert.equal(authorCard(page).home.linkable.pixiv, false, '組んだ頁は結ぶ口を出さない (人は見出しの方)');
  // 作者頁の口 (id でも語でも)
  const home = new HomeAuthors({});
  home.cache = { ...built, signature: home.signature(), at: 0 };
  const payload = await home.author({ query: alpha.query });
  assert.equal(payload.author.title, '甲作者');
  assert.equal(payload.books.length, 0, '台帳のメタが無い試験の母屋では本の札を組まない');
  // 見出しの名とぶつかる作者の名は「(作者)」を添える
  const clash = buildHome(circleInput({ labelOf: (artist) => ({ alpha: '架空サークル' })[artist] || '' }));
  const clashCircle = clash.byId.get(homeAuthorId('circle', 'the circle'));
  assert.equal(clashCircle.authors.find((author) => author.artist === 'alpha').query, '@架空サークル (作者)');
  assert.ok(findByQuery(clash, '@架空サークル (作者)').virtual);
  assert.equal(findByQuery(clash, '@架空サークル'), clashCircle);
});

test('作者フォルダの人: 確定した名乗りのサークルがまるごと寄れば名前はサークル名 (フォルダ名は作者として先頭)。候補では名前を変えない', () => {
  const built = buildHome(circleInput({
    links: [{ personId: 'FOLDERA', source: 'hitomi', name: 'alpha' }],
    groupLabelOf: (group) => ({ 'the circle': '架空サークル', 'solo circle': '別の人' })[group] || '',
  }));
  const a = built.byId.get(homeAuthorId('folder', 'FOLDERA'));
  assert.equal(a.name, '架空サークル');
  assert.equal(a.authors[0].label, '見本 作者');
  assert.equal(a.authors[0].self, true);
  assert.equal(built.byId.get(homeAuthorId('circle', 'the circle')), undefined, '寄ったサークルは別の見出しにしない');
  assert.equal(authorCard(a).home.authorLine, '見本 作者・甲作者 ほか 1 人', 'サークルの二人目も寄る (二人までと「ほか」)');
  // 名前 (フォルダ名) がサークルの札と一致しただけ: 候補 (group:…)。名前は変えない
  const b = built.byId.get(homeAuthorId('folder', 'FOLDERB'));
  assert.equal(b.name, '別の人');
  assert.deepEqual(plain(b.links.hitomi.map((link) => [link.value, link.state])), [['group:solo circle', 'candidate']]);
  assert.equal(built.byId.get(homeAuthorId('circle', 'solo circle')), undefined);
});

test('hitomi のサークルの URL の形と網の語', () => {
  assert.equal(parseSiteUrl('hitomi', 'https://hitomi.la/group/the%20circle-all.html'), 'group:the circle');
  assert.equal(parseSiteUrl('hitomi', 'https://hitomi.la/artist/alpha-japanese.html'), 'alpha');
  assert.equal(siteUrl('hitomi', 'group:the circle'), 'https://hitomi.la/group/the%20circle-all.html');
  const { home } = linkable();
  assert.equal(home.webQuery('hitomi', 'group:the circle', 0).query, 'group:the_circle');
  assert.equal(home.webQuery('hitomi', 'alpha beta', 0).query, 'artist:alpha_beta');
});

test('Eagle の★の評価: 未判定と★1〜5 の点の平均を均した値。低い★の本が多い人は上に来すぎない', () => {
  const rows = [];
  let gid = 100;
  const add = (artist, count, star) => {
    for (let i = 0; i < count; i += 1) rows.push(hitomiRow(artist, gid++, { star }));
  };
  add('many low', 12, 1);
  add('few high', 3, 5);
  add('many high', 12, 5);
  add('unrated', 6, 0);
  add('mixed', 10, 4);
  add('mixed', 10, 1);
  const built = buildHome(baseInput({ hitomiRows: rows }));
  const order = sortPersons(built.persons.filter((person) => person.kind === 'hitomi'), 'stars').map((person) => person.artist);
  assert.deepEqual(order, ['many high', 'few high', 'mixed', 'unrated', 'many low']);
  const score = (artist) => built.byId.get(homeAuthorId('hitomi', artist)).starScore;
  assert.ok(Math.abs(score('few high') - (15 + 6) / 6) < 1e-9, '(点の和 + 3 × 2) ÷ (冊数 + 3)');
  assert.ok(score('many low') < score('unrated'), '★1 ばかりは未判定より下');
});

test('作者の★: rate で creator-links の ratings に書き、並び rating で上に。写しの口は付けさせない', async () => {
  const { home, creatorLinks } = linkable();
  const id = homeAuthorId('hitomi', 'lonely');
  const reply = await home.rate({ id, star: 4 });
  assert.equal(reply.ok, true);
  assert.equal(reply.author.home.rating, 4);
  assert.equal(creatorLinks.rating('h:lonely'), 4);
  const list = await home.search({ sort: 'rating' });
  assert.equal(list.galleries[0].id, id);
  assert.deepEqual(plain(await home.rate({ id, star: 7 })), { ok: false, reason: 'star' });
  assert.equal((await home.rate({ id, star: 0 })).author.home.rating, 0, '0 で外す');
  const folder = await home.author({ id: homeAuthorId('folder', 'FOLDERA') });
  assert.equal(folder.author.home.rateable, true);
  const mirror = new HomeAuthors({ ...home.deps, readOnly: true });
  const card = (await mirror.author({ id })).author;
  assert.equal(card.home.rateable, false);
});


test('突き合わせの候補: 詳細に点線の鎖で出し (結ぶまで確定しない)、「違う」で退けると二度と出さない', async () => {
  const { home, creatorLinks } = linkable();
  const folder = homeAuthorId('folder', 'FOLDERA');
  const lonely = homeAuthorId('hitomi', 'lonely');
  const added = await home.suggest({
    by: '突き合わせ',
    rows: [
      { id: folder, site: 'pixiv', url: 'https://www.pixiv.net/users/555', note: '辞書一つだけ' },
      { id: lonely, site: 'pawchive', url: 'https://pawchive.pw/fanbox/user/777' },
      { id: lonely, site: 'hitomi', url: 'https://hitomi.la/artist/other-all.html' },
      { id: folder, site: 'pixiv', url: 'https://www.pixiv.net/artworks/1' },
    ],
  });
  assert.deepEqual(plain(added), { ok: true, added: 2, skipped: 2 }, 'hitomi だけの人の hitomi と形の違う URL は足さない');
  const a = (await home.author({ id: folder })).author;
  const cand = a.home.links.pixiv.find((link) => link.state === 'candidate');
  assert.ok(cand && cand.suggested, '候補として出る (結んではいない)');
  assert.equal(a.home.links.pixiv.some((link) => link.state === 'linked'), false);
  // 候補のある人は見出しで未確定 (?) になる
  const listed = await home.search({});
  assert.equal(listed.galleries.find((g) => g.id === lonely).home.unsure, true);
  // 作者フォルダの人の pixiv の候補を「違う」: 退けた答えは creator-links に残り、候補から消える
  const reject = await home.link({ id: folder, site: 'pixiv', op: 'reject', url: cand.url });
  assert.equal(reject.ok, true);
  assert.equal(creatorLinks.state('FOLDERA', 'pixiv', '555'), 'rejected');
  assert.equal(reject.author.home.links.pixiv.some((link) => link.suggested), false);
  assert.equal(creatorLinks.suggest([{ personId: 'FOLDERA', source: 'pixiv', name: '555' }]), 0, '答えた組はもう候補にしない');
  // hitomi だけの人の Pawchive の候補を「結ぶ」: creator-links の行になる
  const accept = await home.link({ id: lonely, site: 'pawchive', op: 'accept', url: 'https://pawchive.pw/fanbox/user/777' });
  assert.equal(accept.ok, true);
  assert.equal(creatorLinks.state('h:lonely', 'pawchive', 'fanbox:777'), 'linked');
  assert.equal(creatorLinks.suggestions().length, 0);
});

test('突き合わせの候補 (hitomi の名乗り → 作者フォルダ): 所持の本がある名乗りは、その塊を候補の本として寄せる', () => {
  const built = buildHome(circleInput({
    suggestions: [{ personId: 'FOLDERB', source: 'hitomi', name: 'group:the circle', note: '' }],
  }));
  const b = built.byId.get(homeAuthorId('folder', 'FOLDERB'));
  const link = b.links.hitomi.find((row) => row.value === 'group:the circle');
  assert.ok(link && link.state === 'candidate' && link.suggested);
  assert.equal(built.byId.get(homeAuthorId('circle', 'the circle')), undefined, '候補として寄せた塊は別の見出しにしない');
  assert.ok(b.books.some((book) => book.candidate && book.id === '1'));
  assert.equal(b.name, '別の人', '候補では名前を変えない');
});


// ---- 2026-09-24 の二回目: nhentai のサークル・見出しの束ね・小分けのフォルダの年月・Discord・元に戻す・頁数 ----

test('nhentai のサークルの URL (group) も結べる。サークルには group の候補を推す', () => {
  assert.equal(parseSiteUrl('nhentai', 'https://nhentai.net/group/sample-circle/'), 'group:sample-circle');
  assert.equal(parseSiteUrl('nhentai', 'https://nhentai.net/artist/sample-one/'), 'sample-one');
  assert.equal(siteUrl('nhentai', 'group:sample-circle'), 'https://nhentai.net/group/sample-circle/');
  const built = buildHome(circleInput());
  const circle = built.byId.get(homeAuthorId('circle', 'the circle'));
  assert.ok(circle.links.nhentai.some((link) => link.value === 'group:the-circle' && link.state === 'candidate'));
});

test('見出しの束ね: hitomi だけの見出しに別の見出しの名乗りを結ぶと、その塊ごと寄る (名前は寄せた先。外せば戻る)', async () => {
  // gather は既定 (一冊でもサークルの本があれば寄せる) で組むので、free は 'side x' のサークルの見出しに束ねられている
  const { home, creatorLinks } = linkable({ input: circleInput() });
  const target = homeAuthorId('circle', 'side x');
  const other = homeAuthorId('circle', 'solo circle');
  assert.ok((await home.author({ id: other })).author, '束ねる前は別の見出し');
  const reply = await home.link({ id: target, site: 'hitomi', op: 'save', url: 'https://hitomi.la/group/solo%20circle-all.html' });
  assert.equal(reply.ok, true);
  assert.equal(reply.author.title, 'side x', '名前は寄せた先の物');
  assert.equal(reply.author.home.count, 6, '寄せた塊の本も数える');
  assert.equal((await home.author({ id: other })).author, null, '寄せた見出しは一覧から消える');
  assert.equal(creatorLinks.state('c:side x', 'hitomi', 'group:solo circle'), 'linked');
  // 見出しそのものの名乗りは外せない
  assert.deepEqual(plain(await home.link({ id: target, site: 'hitomi', op: 'unlink', url: 'https://hitomi.la/group/side%20x-all.html' })), { ok: false, reason: 'fixed' });
  // 元に戻す: 足した行を取り除いて、別の見出しに戻る
  const back = await home.undo({ id: target, steps: reply.undo });
  assert.equal(back.ok, true);
  assert.ok((await home.author({ id: other })).author, '元に戻すと別の見出しに戻る');
  assert.equal(creatorLinks.state('c:side x', 'hitomi', 'group:solo circle'), null, '行ごと取り除く (「違う」の印も残らない)');
  // やり直す
  const again = await home.undo({ id: target, steps: back.redo });
  assert.equal(again.ok, true);
  assert.equal((await home.author({ id: other })).author, null);
});

test('小分けのフォルダの名前の年月: 25年5月 / 英字 + 2603 / 年の無い 4月 (年のある名前の一番古い年の前の年)', () => {
  const { folderMonth } = require('../src/lib/home-authors');
  assert.deepEqual(plain(folderMonth('25年5月 マンスリーパス')), { year: 2025, month: 5 });
  assert.deepEqual(plain(folderMonth('2024年12月 まとめ')), { year: 2024, month: 12 });
  assert.deepEqual(plain(folderMonth('Sample2603')), { year: 2026, month: 3 });
  assert.deepEqual(plain(folderMonth('4月 マンスリーパス')), { year: null, month: 4 });
  assert.equal(folderMonth('Sample2024'), null, '年 4 桁は月にしない');
  assert.equal(folderMonth('おまけ'), null);
  const items = [
    pawItem('D1', 'FOLDERA', { name: 'a.pdf', title: 'a', date: null, postId: null, folderName: '4月 マンスリーパス' }),
    pawItem('D2', 'FOLDERA', { name: 'b.pdf', title: 'b', date: null, postId: null, folderName: '25年5月 マンスリーパス' }),
    pawItem('D3', 'FOLDERA', { name: 'c.pdf', title: 'c', date: null, postId: null, folderName: 'Sample2603' }),
    pawItem('D4', 'FOLDERA', { name: 'd.pdf', title: 'd', date: null, postId: null, folderName: '' }),
  ];
  const built = buildHome(baseInput({ pawItems: items }));
  const a = built.byId.get(homeAuthorId('folder', 'FOLDERA'));
  const date = (id) => a.books.find((book) => book.id === `pweagle:${id}`).date;
  assert.equal(date('D1'), '2024-04-01');
  assert.equal(date('D2'), '2025-05-01');
  assert.equal(date('D3'), '2026-03-01');
  assert.equal(date('D4'), null, '名前もフォルダも日付を持たない本は日付不明のまま');
});

test('持ち込みの本の出どころ: Discord に決めると ? がそのアイコンになる。元に戻せる', async () => {
  const { home, creatorLinks } = linkable();
  const id = homeAuthorId('folder', 'FOLDERA');
  const before = (await home.author({ id })).author;
  assert.equal(before.home.localCount, 1);
  assert.equal(before.home.unsure, true);
  const reply = await home.origin({ id, origin: 'discord' });
  assert.equal(reply.ok, true);
  assert.equal(reply.author.home.localOrigin, 'discord');
  assert.ok(reply.author.home.sites.includes('discord'), '見出しの帯に Discord のアイコン');
  assert.equal(creatorLinks.origin('FOLDERA'), 'discord');
  const built = await home.ensure();
  const person = built.byId.get(id);
  assert.ok(person.books.some((book) => book.origin === 'discord'));
  assert.equal(person.books.some((book) => book.origin === 'local'), false);
  assert.deepEqual(plain(await home.origin({ id, origin: 'x' })), { ok: false, reason: 'origin' });
  const back = await home.undo({ id, steps: reply.undo });
  assert.equal(back.author.home.localOrigin, '');
  assert.equal(creatorLinks.origin('FOLDERA'), '');
});

test('元に戻す: 作者フォルダの pixiv の結び・★・候補の「違う」を、書く前の姿に戻す (やり直しも)', async () => {
  const { home, pixivBinds, creatorLinks } = linkable();
  const id = homeAuthorId('folder', 'FOLDERA');
  const bind = await home.link({ id, site: 'pixiv', op: 'save', url: 'https://www.pixiv.net/users/4242' });
  assert.ok(pixivBinds['4242']);
  assert.deepEqual(plain(bind.undo), [{ k: 'pixiv-set', userId: '4242', value: null }]);
  const back = await home.undo({ id, steps: bind.undo });
  assert.equal(pixivBinds['4242'], undefined, '結ぶ前に戻る');
  await home.undo({ id, steps: back.redo });
  assert.ok(pixivBinds['4242'], 'やり直すと結び直す');
  // ★
  const rated = await home.rate({ id, star: 3 });
  assert.deepEqual(plain(rated.undo), [{ k: 'rating', personId: 'FOLDERA', star: 0 }]);
  await home.undo({ id, steps: rated.undo });
  assert.equal(creatorLinks.rating('FOLDERA'), 0);
  // 候補 (突き合わせ) の「違う」を元に戻すと候補に戻る (退けた印を残さない)
  await home.suggest({ rows: [{ id, site: 'pawchive', url: 'https://pawchive.pw/fanbox/user/9' }] });
  const reject = await home.link({ id, site: 'pawchive', op: 'reject', url: 'https://pawchive.pw/fanbox/user/9' });
  assert.equal(creatorLinks.state('FOLDERA', 'pawchive', 'fanbox:9'), 'rejected');
  const undone = await home.undo({ id, steps: reject.undo });
  assert.equal(creatorLinks.state('FOLDERA', 'pawchive', 'fanbox:9'), null);
  assert.ok(undone.author.home.links.pawchive.some((link) => link.suggested && link.state === 'candidate'), '候補に戻る');
  assert.deepEqual(plain(await home.undo({ id, steps: [{ k: 'unknown' }] })), { ok: false, reason: 'missing' });
});

test('所持の本の頁数: 名前に頁数の無い本は数えて控え、作者頁の返りにも入れる', async () => {
  const { PageCounts } = require('../src/lib/page-counts');
  const counted = [];
  const counts = new PageCounts({ count: async (id) => { counted.push(id); return id === 'pweagle:A3' ? 17 : 0; } });
  const { home } = linkable();
  home.deps.getPageCounts = () => counts;
  home.deps.pawLibrary.toGallery = (item) => ({
    id: `pweagle:${item.eagleId}`, source: 'pawchive', kind: 'eagleItem', eagleId: item.eagleId, title: item.title,
    pageCount: item.eagleId === 'A3' ? 0 : item.pageCount, owned: true,
  });
  const id = homeAuthorId('folder', 'FOLDERA');
  const first = await home.author({ id });
  assert.equal(first.books.find((book) => book.id === 'pweagle:A3').gallery.pageCount, 0, 'まだ数えていない');
  const reply = await home.pages({ id, ids: ['pweagle:A3'] });
  assert.deepEqual(plain(reply.counts), { 'pweagle:A3': 17 });
  assert.equal((await home.pages({ id, ids: ['pweagle:A3'] })).counts['pweagle:A3'], 17);
  assert.equal(counted.length, 1, '二度目は控えから');
  const again = await home.author({ id });
  assert.equal(again.books.find((book) => book.id === 'pweagle:A3').gallery.pageCount, 17, '次からは作者頁の返りに入っている');
  // 本が差し替わった (mtime が違う) 控えは使わない
  assert.equal(counts.get('A3', 1), 0);
});


test('見出しの名前を決める (「〜に統一」): サークル名より先に立ち、元の名前でも探せる。元に戻せる', async () => {
  const { home, creatorLinks } = linkable({ input: circleInput() });
  const id = homeAuthorId('circle', 'the circle');
  const reply = await home.rename({ id, name: 'きめた名前' });
  assert.equal(reply.ok, true);
  assert.equal(reply.author.title, 'きめた名前');
  assert.equal(reply.author.home.renamed, true);
  assert.equal(creatorLinks.displayName('c:the circle'), 'きめた名前');
  const found = await home.search({ query: 'the circle' });
  assert.ok(found.galleries.some((g) => g.id === id), '元の名前 (サークルの名) でも探せる');
  assert.equal((await home.author({ query: '@きめた名前' })).author.id, id, '作者頁の語は新しい名前');
  const back = await home.undo({ id, steps: reply.undo });
  assert.equal(back.author.title, 'the circle', '元に戻すと元の名前');
  assert.equal(creatorLinks.displayName('c:the circle'), '');
  const again = await home.undo({ id, steps: back.redo });
  assert.equal(again.author.title, 'きめた名前');
  assert.equal((await home.rename({ id, name: '' })).author.title, 'the circle', '空で元の名前に戻す');
});

test('見出しの表紙 (組み立て): 選んだ本がその人の確かな所持の本なら顔になる。よその本・消えた本は自動の顔のまま', () => {
  const face = (covers) => buildHome(baseInput({ covers })).byId.get(homeAuthorId('folder', 'FOLDERA'));
  const auto = face({});
  assert.equal(auto.cover, 'pwlibf:FOLDERA');
  assert.equal(auto.coverAuto, 'pwlibf:FOLDERA');
  assert.equal(auto.coverChosen, false);
  const chosen = face({ FOLDERA: 'pweagle:A1' });
  assert.equal(chosen.cover, 'pweagle:A1', '選んだ本の表紙');
  assert.equal(chosen.coverAuto, 'pwlibf:FOLDERA', '自動の顔も持つ (選んだ表紙を外すとこれに戻る)');
  assert.equal(chosen.coverChosen, true);
  assert.equal(face({ FOLDERA: 'pweagle:B1' }).cover, 'pwlibf:FOLDERA', 'よその人の本は顔にしない');
  const gone = face({ FOLDERA: 'pweagle:GONE' });
  assert.equal(gone.cover, 'pwlibf:FOLDERA', 'Eagle から消えた本は黙って自動の顔に戻る (壊れた絵を出さない)');
  assert.equal(gone.coverChosen, false);
  assert.equal(face({ FOLDERB: 'pweagle:A1' }).cover, 'pwlibf:FOLDERA', 'ほかの人の表紙の選びは効かない');
});

test('見出しの表紙を選ぶ: covers に書いて一覧と作者頁の顔に。候補・よその本は断り、元に戻せる。写しでは選べない', async () => {
  const { home, creatorLinks } = linkable();
  const id = homeAuthorId('folder', 'FOLDERA');
  const before = (await home.author({ id })).author;
  assert.equal(before.home.cover, 'pwlibf:FOLDERA');
  assert.equal(before.home.coverChosen, false);
  assert.equal(before.home.coverable, true);
  const reply = await home.cover({ id, cover: 'pweagle:A1' });
  assert.equal(reply.ok, true);
  assert.equal(reply.author.home.cover, 'pweagle:A1');
  assert.equal(reply.author.home.coverAuto, 'pwlibf:FOLDERA');
  assert.equal(reply.author.home.coverChosen, true);
  assert.equal(creatorLinks.cover('FOLDERA'), 'pweagle:A1', '鍵は人の鍵 (作者フォルダ id)');
  assert.deepEqual(plain(reply.undo), [{ k: 'cover', personId: 'FOLDERA', id: '' }]);
  const listed = await home.search({ query: '' });
  assert.equal(listed.galleries.find((g) => g.id === id).home.cover, 'pweagle:A1', '一覧の見出しも選んだ表紙');
  assert.equal((await home.author({ query: '@見本 作者' })).author.home.cover, 'pweagle:A1', '作者頁の頭も');
  assert.deepEqual(plain(await home.cover({ id, cover: 'pweagle:B1' })), { ok: false, reason: 'cover' }, 'よその人の本は選べない');
  assert.deepEqual(plain(await home.cover({ id, cover: '11' })), { ok: false, reason: 'cover' }, '名前が一致しただけの候補の本は選べない');
  assert.deepEqual(plain(await home.cover({ id: 'home:f:NOBODY', cover: 'pweagle:A1' })), { ok: false, reason: 'author' });
  assert.equal(creatorLinks.cover('FOLDERA'), 'pweagle:A1', '断った時は前の表紙のまま');
  const back = await home.undo({ id, steps: reply.undo });
  assert.equal(back.author.home.cover, 'pwlibf:FOLDERA', '元に戻すと自動の顔');
  assert.equal(back.author.home.coverChosen, false);
  const again = await home.undo({ id, steps: back.redo });
  assert.equal(again.author.home.cover, 'pweagle:A1', 'やり直すと選んだ表紙');
  const cleared = await home.cover({ id, cover: '' });
  assert.equal(cleared.author.home.coverChosen, false, '空で自動に戻す');
  assert.deepEqual(plain(cleared.undo), [{ k: 'cover', personId: 'FOLDERA', id: 'pweagle:A1' }]);
  assert.deepEqual(plain((await home.cover({ id, cover: '' })).undo), [], '変わらなければ戻す手順は積まない');
  // hitomi だけの人も選べる (鍵は h:<artist>)
  const lonely = homeAuthorId('hitomi', 'lonely');
  const picked = await home.cover({ id: lonely, cover: '2' });
  assert.equal(picked.author.home.cover, '2');
  assert.equal(creatorLinks.cover('h:lonely'), '2');
  // 写しは表紙を選ぶ口を出さない (選んだ表紙そのものは同期で届いて出る)
  const mirror = new HomeAuthors({ ...home.deps, readOnly: true });
  const card = (await mirror.author({ id: lonely })).author;
  assert.equal(card.home.coverable, false);
  assert.equal(card.home.cover, '2');
});

// ---- Pawchive と pixiv の網の作品 (作者頁の所持作品だけの旗が切れている時) -----------

test('網の作品 (Pawchive): 結び済みの作者の投稿を service/user の語で引き、絵も添付も無い投稿は落とす。作者根の 済 は ID で確か', async () => {
  const { home, pawBinds } = linkable();
  pawBinds['fanbox:777'] = 'FOLDERA';
  const calls = [];
  home.deps.searchHitomi = async (payload) => {
    calls.push(plain(payload));
    if (payload.page === 0) {
      return {
        galleries: [
          { id: 'pw:fanbox:777:1', source: 'pawchive', title: '架空題甲', pageCount: 12, addedDate: '2024-05-01T00:00:00' },
          { id: 'pw:fanbox:777:2', source: 'pawchive', title: 'お知らせ', pageCount: 0, addedDate: '2024-05-02T00:00:00' },
        ],
        hasNext: true,
      };
    }
    return { galleries: [{ id: 'pw:fanbox:777:3', source: 'pawchive', title: '架空題乙', pageCount: 3, addedDate: '2024-04-01' }], hasNext: false };
  };
  home.deps.catalog.annotate = (list) => list.map((g) => ({ ...g, owned: false }));
  home.deps.pawLibrary.annotateAll = (list) => list.map((g) => (g.id === 'pw:fanbox:777:1' ? { ...g, owned: true, eagleId: 'A1' } : g));
  const result = await home.webWorks({ id: homeAuthorId('folder', 'FOLDERA'), site: 'pawchive' });
  assert.equal(calls[0].source, 'pawchive');
  assert.equal(calls[0].query, 'fanbox/777', '作者の投稿一覧の語 (作者の札の query と同じ形)');
  assert.equal(calls[0].pageSize, WEB_LIMITS.pawchive.pageSize);
  assert.equal(calls.length, 2, 'hasNext: false で止まる');
  assert.deepEqual(result.works.map((work) => work.id), ['pw:fanbox:777:1', 'pw:fanbox:777:3'], '文字だけの投稿は本ではない');
  assert.equal(result.works[0].origin, 'pawchive');
  assert.equal(result.works[0].date, '2024-05-01');
  assert.equal(result.works[0].gallery.idOwned, true, '作者根の 済 (投稿 ID か手の結び) は ID で確か');
  assert.equal(result.works[1].gallery.idOwned, undefined);

  // 結んでいない作者は網へ出ない
  const other = await home.webWorks({ id: homeAuthorId('folder', 'FOLDERB'), site: 'pawchive' });
  assert.deepEqual(plain(other), { works: [], more: false, error: false });
});

test('網の作品 (pixiv): 一頁目の頭の作者の札は落とし、10 頁で打ち切る。ログインしていなければ失敗ではなく unavailable', async () => {
  const { home, pixivBinds } = linkable();
  pixivBinds['4242'] = { folderId: 'FOLDERA', name: '見本 作者' };
  const pages = [];
  home.deps.searchHitomi = async (payload) => {
    pages.push(payload.page);
    assert.equal(payload.query, 'user:4242');
    return {
      galleries: [
        ...(payload.page === 0 ? [{ id: 'px:user:4242', source: 'pixiv', kind: 'creator', title: '作者' }] : []),
        { id: `px:${payload.page + 1}`, source: 'pixiv', title: `架空題${payload.page}`, pageCount: 1, publishedDate: '2024-01-01T00:00:00+09:00' },
      ],
      hasNext: true,
    };
  };
  const id = homeAuthorId('folder', 'FOLDERA');
  const result = await home.webWorks({ id, site: 'pixiv' });
  assert.equal(pages.length, WEB_LIMITS.pixiv.maxPages);
  assert.equal(result.works.length, WEB_LIMITS.pixiv.maxPages, '作者の札は作品ではない');
  assert.equal(result.more, true);
  assert.equal(result.works[0].date, '2024-01-01');

  const locked = linkable();
  locked.pixivBinds['4242'] = { folderId: 'FOLDERA', name: '見本 作者' };
  locked.home.deps.searchHitomi = async () => {
    const error = new Error('pixiv にログインしていません');
    error.status = 401;
    error.code = 'pixiv-login';
    throw error;
  };
  const none = await locked.home.webWorks({ id, site: 'pixiv' });
  assert.equal(none.unavailable, true);
  assert.equal(none.error, false, '写し (ログインしていない) で「読めませんでした」を出さない');
});

test('作者頁の所持の本: 作者根と pixiv の台帳の本 (eagleItem) は ID で確かな所持 (所持を隠す表示で伏せられる)', async () => {
  const { home } = linkable();
  home.deps.pawLibrary.toGallery = (item) => ({
    id: `pweagle:${item.eagleId}`, source: 'pawchive', kind: 'eagleItem', eagleId: item.eagleId, title: item.title,
    pageCount: item.pageCount, owned: true,
  });
  const payload = await home.author({ id: homeAuthorId('folder', 'FOLDERA') });
  assert.ok(payload.books.length > 0);
  for (const book of payload.books) assert.equal(book.gallery.idOwned, true);
});

test('hitomi の網: 候補の名乗りから引いた作品には候補の印', async () => {
  const { home } = linkable();
  home.deps.searchHitomi = async () => ({ galleries: [{ id: 99, title: '見本' }], total: 1 });
  const result = await home.hitomiWorks({ id: homeAuthorId('folder', 'FOLDERA') });
  assert.equal(result.works.length, 1);
  assert.equal(result.works[0].candidate, true);
  assert.equal(result.works[0].origin, 'hitomi');
});

// ---- 名前に日付の無い本の公開日 (release-dates の控え) ------------------------

test('公開日の控え: 名前の日付 > pixiv の台帳 > 控え > 小分けのフォルダの年月。推定 (medium / low) には印', () => {
  const found = {
    E1: { date: '2023-03-04', guess: false, basis: 'pixiv-post' },
    E2: { date: '2022-11-20', guess: true, basis: 'hitomi-uploaded' },
    E3: { date: '2021-01-02', guess: false, basis: 'pixiv-post' },
    E4: { date: '2020-06-07', guess: false, basis: 'pixiv-post' },
    E5: { date: '2019-09-09', guess: false, basis: 'pixiv-post' },
    E6: { date: '2018-08-08', guess: false, basis: 'pawchive-post' },
  };
  const items = [
    pawItem('E1', 'FOLDERA', { name: 'a.pdf', title: 'a', date: null, postId: null }),
    pawItem('E2', 'FOLDERA', { name: 'b.pdf', title: 'b', date: null, postId: null }),
    // 名前に日付がある本は控えを見ない
    pawItem('E3', 'FOLDERA', { name: '[20240501] c', title: 'c', date: '20240501', postId: null }),
    // 控えは小分けのフォルダの年月より先
    pawItem('E4', 'FOLDERA', { name: 'd.pdf', title: 'd', date: null, postId: null, folderName: '25年5月 見本' }),
    // PPD の古い名前: pixiv の台帳に同じ投稿が居ればその日付 (控えより先)
    pawItem('E5', 'FOLDERA', { name: '12345678_p0-見本', title: '12345678_p0-見本', date: null, postId: null }),
    // url を持つ pixiv の本: 台帳に居なければ控え
    pawItem('E6', 'FOLDERA', { source: 'pixiv', pixivId: '87654321', name: 'f', title: 'f', date: null, postId: null }),
    pawItem('E7', 'FOLDERA', { name: 'g.pdf', title: 'g', date: null, postId: null }),
  ];
  const works = { 12345678: { date: '2017-07-07T12:00:00+09:00' } };
  const built = buildHome(baseInput({
    pawItems: items,
    pixivWork: (pid) => works[pid] || null,
    releaseDateOf: (eagleId) => found[eagleId] || null,
  }));
  const a = built.byId.get(homeAuthorId('folder', 'FOLDERA'));
  const book = (id) => a.books.find((row) => row.ref.item.eagleId === id);
  assert.equal(book('E1').date, '2023-03-04');
  assert.equal(book('E1').dateGuess, false);
  assert.equal(book('E1').origin, 'local', '控えの日付で出どころの印は変えない');
  assert.equal(book('E2').date, '2022-11-20');
  assert.equal(book('E2').dateGuess, true, '推定の日付には印');
  assert.equal(book('E2').dateBasis, 'hitomi-uploaded');
  assert.equal(book('E3').date, '2024-05-01', '名前の日付が先');
  assert.equal(book('E3').dateGuess, false);
  assert.equal(book('E4').date, '2020-06-07', '控えが小分けのフォルダの年月より先');
  assert.equal(book('E5').date, '2017-07-07', 'PPD の名前の本も pixiv の台帳の日付を引く');
  assert.equal(book('E6').date, '2018-08-08', '台帳に居ない pixiv の本は控え');
  assert.equal(book('E7').date, null, '控えにも無い本は日付不明のまま');
  // 控えを引く口が転んでも組める
  const broken = buildHome(baseInput({ pawItems: items, releaseDateOf: () => { throw new Error('x'); } }));
  assert.equal(broken.byId.get(homeAuthorId('folder', 'FOLDERA')).books.find((row) => row.ref.item.eagleId === 'E1').date, null);
});

test('公開日の控え: 作者頁の返りに日付と推定の印、詳細の「日付」も揃える。控えが動けば組み直す', async () => {
  const { ReleaseDates } = require('../src/lib/release-dates');
  const releaseDates = new ReleaseDates({ now: () => 1700000000000 });
  const { home } = linkable();
  home.deps.releaseDates = releaseDates;
  home.deps.pawLibrary.toGallery = (item) => ({
    id: `pweagle:${item.eagleId}`, source: 'pawchive', kind: 'eagleItem', eagleId: item.eagleId, title: item.title,
    pageCount: item.pageCount, owned: true,
    publishedDate: item.date ? `${item.date.slice(0, 4)}-${item.date.slice(4, 6)}-${item.date.slice(6, 8)}` : null,
  });
  const id = homeAuthorId('folder', 'FOLDERA');
  const before = await home.author({ id });
  assert.equal(before.books.find((book) => book.id === 'pweagle:A3').date, null, '手で入れた本 (A3) は日付不明');
  releaseDates.set([{ eagleId: 'A3', date: '2021-02-03', confidence: 'low', basis: 'hitomi-uploaded', hits: [{ site: 'hitomi', id: '42' }] }], { by: '試験' });
  // 目印が変わるので、次の問いで裏で組み直す (その回は前の控え)
  await home.author({ id });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const after = await home.author({ id });
  const a3 = after.books.find((book) => book.id === 'pweagle:A3');
  assert.equal(a3.date, '2021-02-03');
  assert.equal(a3.dateGuess, true);
  assert.equal(a3.dateBasis, 'hitomi-uploaded');
  assert.equal(a3.gallery.publishedDate, '2021-02-03', '詳細の「日付」も年表と同じ');
  const a1 = after.books.find((book) => book.id === 'pweagle:A1');
  assert.equal(a1.dateGuess, false);
  assert.equal(a1.gallery.publishedDate, '2024-05-01', '名前の日付の本はそのまま');
});

test('公開日の控え: 小分けのフォルダの年月で置いた本は、詳細の「日付」に 1 日を書かない (月までしか分からない)', async () => {
  const input = baseInput({
    pawItems: [pawItem('F1', 'FOLDERA', { name: 'a.pdf', title: 'a', date: null, postId: null, folderName: '25年5月 見本' })],
  });
  const { home } = linkable({ input });
  home.deps.pawLibrary.toGallery = (item) => ({
    id: `pweagle:${item.eagleId}`, source: 'pawchive', kind: 'eagleItem', eagleId: item.eagleId, title: item.title,
    pageCount: item.pageCount, owned: true, publishedDate: null,
  });
  const payload = await home.author({ id: homeAuthorId('folder', 'FOLDERA') });
  const f1 = payload.books.find((book) => book.id === 'pweagle:F1');
  assert.equal(f1.date, '2025-05-01', '年表には置く');
  assert.equal(f1.gallery.publishedDate, null, '詳細の日付は空のまま');
});

// ---- Eagle のタグの道 (2026-09-24) ----------------------------------------

// 台帳の Eagle の項目のうちタグのある物 (buildHome の eagleRows の形)
function eagleRow(eagleId, tags, extra = {}) {
  return {
    eagleId, gid: null, tags, star: 0, addedAt: 1700000000000, itemTitle: `見本の項目 ${eagleId}`,
    title: null, pages: null, lang: null, published: null, added: null, ...extra,
  };
}

test('Eagle のタグの道: 作者のタグが付いた所持の本をその人に寄せる (照合済みは hitomi の本、未照合は疑似ギャラリー)', () => {
  const built = buildHome(circleInput({
    eagleRows: [
      // hitomi の照合先に作者のタグが無い本 (上げ直しなど): サークルの札と同じ Eagle のタグ
      eagleRow('E1', ['架空サークル', 'オリジナル'], { gid: 99, title: '見本 99', pages: 30, lang: 'japanese', published: '2024-01-02T00:00:00.000Z' }),
      // 照合されていない本: 作者フォルダの名前と同じ Eagle のタグ (空白は無視)
      eagleRow('E2', ['見本作者']),
    ],
  }));
  const circle = built.byId.get(homeAuthorId('circle', 'the circle'));
  const tagged = circle.books.find((book) => book.id === '99');
  assert.ok(tagged, 'サークルの本になる');
  assert.equal(tagged.origin, 'hitomi');
  assert.equal(tagged.candidate, false);
  assert.equal(tagged.date, '2024-01-02');
  assert.equal(circle.count, 7, '所持の数に入る');
  const folder = built.byId.get(homeAuthorId('folder', 'FOLDERA'));
  const local = folder.books.find((book) => book.id === 'pweagle:E2');
  assert.ok(local, '作者フォルダの人の本になる');
  assert.equal(local.origin, 'local', '出どころは分からない (持ち込みの ?)');
  assert.deepEqual(plain(local.ref), { type: 'eagle', eagleId: 'E2' });
  assert.equal(folder.count, 4);
});

test('Eagle のタグの道: 二人に当たる語では寄せない。既にその人の本 (同じ gid・同じ Eagle の項目) は重ねない。人は作らない', () => {
  const rows = [
    hitomiRow('pa', 1), hitomiRow('pa', 2), hitomiRow('pa', 3),
    hitomiRow('qa', 4), hitomiRow('qa', 5), hitomiRow('qa', 6),
  ];
  const labelOf = (artist) => (['pa', 'qa'].includes(artist) ? '同名' : '');
  const plainBuilt = buildHome(baseInput({ hitomiRows: rows, labelOf }));
  const built = buildHome(baseInput({
    hitomiRows: rows,
    labelOf,
    eagleRows: [
      eagleRow('E1', ['同名'], { gid: 70, title: '見本 70', lang: 'japanese' }),
      eagleRow('E2', ['qa'], { gid: 71, title: '見本 71', lang: 'japanese' }),
      eagleRow('E3', ['qa'], { gid: 4, title: '見本 4', lang: 'japanese' }),
      eagleRow('A1', ['見本 作者']),
      eagleRow('E5', ['誰でもない']),
    ],
  }));
  assert.equal(built.byId.get(homeAuthorId('hitomi', 'pa')).count, 3, '二人に当たる札 (同名) では寄せない');
  const qa = built.byId.get(homeAuthorId('hitomi', 'qa'));
  assert.equal(qa.count, 4, '名乗り (qa) なら一人に定まる。gid 4 は既に qa の本なので重ねない');
  assert.equal(qa.books.filter((book) => book.id === '4').length, 1);
  assert.equal(built.byId.get(homeAuthorId('folder', 'FOLDERA')).count, 3, '作者フォルダの本と同じ Eagle の項目 (A1) は重ねない');
  assert.equal(built.persons.length, plainBuilt.persons.length, 'どの人にも当たらないタグで人を作らない');
});

test('Eagle のタグの道: 照合先の hitomi に作者・サークルのタグがあれば、それと合わない人へは寄せない (古い照合の札が残っていても)', () => {
  const rows = [
    hitomiRow('pa', 1), hitomiRow('pa', 2), hitomiRow('pa', 3),
    hitomiRow('qa', 4), hitomiRow('qa', 5), hitomiRow('qa', 6),
  ];
  const labelOf = (artist) => ({ pa: 'ぴー', qa: 'きゅー' }[artist] || '');
  const built = buildHome(baseInput({
    hitomiRows: rows,
    labelOf,
    eagleRows: [
      // qa の本 (gid 4) に pa の札が残っている: pa には寄せない
      eagleRow('E1', ['ぴー', 'きゅー'], { gid: 4, title: '見本 4', lang: 'japanese' }),
      // 照合先に作者のタグが無い本は今までどおり札で寄せる
      eagleRow('E2', ['ぴー'], { gid: 80, title: '見本 80', lang: 'japanese' }),
      // 照合先の作者の札 (日本語) が人の名乗りと合えば寄せてよい (qa はもう持っているので重ねない)
      eagleRow('E3', ['きゅー'], { gid: 5, title: '見本 5', lang: 'japanese' }),
    ],
  }));
  const pa = built.byId.get(homeAuthorId('hitomi', 'pa'));
  const qa = built.byId.get(homeAuthorId('hitomi', 'qa'));
  assert.equal(pa.books.some((book) => book.id === '4'), false, '別の作者の本は札が残っていても寄せない');
  assert.ok(pa.books.some((book) => book.id === '80'), '作者のタグの無い照合先は札で寄せる');
  assert.equal(pa.count, 4);
  assert.equal(qa.count, 3, 'qa の本は qa のまま');
});

test('所持の本は言語で伏せない: 照合先が翻訳版の本も最近の本に出る。顔だけは日本語の本を先に選ぶ', () => {
  const built = buildHome(circleInput({
    eagleRows: [eagleRow('E9', ['架空サークル'], { gid: 98, title: '見本 98', lang: 'chinese', published: '2025-06-01T00:00:00.000Z' })],
  }));
  const circle = built.byId.get(homeAuthorId('circle', 'the circle'));
  const book = circle.books.find((row) => row.id === '98');
  assert.equal(book.lang, 'chinese');
  assert.equal(circle.recent[0].id, '98', '一番新しい所持の本 (翻訳版に結ばれていても Eagle に在る)');
  assert.notEqual(circle.cover, '98', '見出しの顔は日本語の本から選ぶ');
});

test('所持の本は言語で伏せない: 作者頁の本の一覧に、照合先が翻訳版の所持の本も並ぶ', async () => {
  const input = baseInput({
    hitomiRows: [hitomiRow('lonely', 1), hitomiRow('lonely', 2), hitomiRow('lonely', 3, { lang: 'chinese' })],
  });
  const { home } = linkable({ input });
  home.deps.catalog.getGalleryMetaBatch = (ids) => new Map(ids.map((id) => [Number(id), { id: Number(id), title: `見本 ${id}` }]));
  const payload = await home.author({ id: homeAuthorId('hitomi', 'lonely') });
  assert.deepEqual(payload.books.map((book) => book.id).sort(), ['1', '2', '3']);
});

test('Eagle のタグの道: 台帳の行 (path の #gid も・壊れたタグは飛ばす) から寄せ、未照合の本は本体の疑似ギャラリーで描く', async () => {
  const { home } = linkable();
  const base = home.deps.catalog.queryRows;
  home.deps.catalog.queryRows = (sql) => (/eagle_tags/.test(sql)
    ? [
      { path: 'D:/lib/images/E2.info', gid: null, tags: JSON.stringify(['見本作者']), star: 3, addedAt: 1, itemTitle: '見本の項目' },
      { path: 'D:/lib/images/E3.info#77', gid: 77, tags: '["見本作者"]', star: 0, addedAt: 2, itemTitle: '見本の項目 2', title: '見本 77', pages: 20, lang: 'japanese' },
      { path: 'D:/lib/images/E4.info', gid: null, tags: 'not json', itemTitle: '壊れたタグ' },
    ]
    : base(sql));
  home.deps.catalog.eagleItemGallery = (eagleId) => ({
    id: `pweagle:${eagleId}`, source: 'pawchive', kind: 'eagleItem', eagleId, title: '見本の項目', pageCount: 0, owned: true,
  });
  const id = homeAuthorId('folder', 'FOLDERA');
  const payload = await home.author({ id });
  const e2 = payload.books.find((book) => book.id === 'pweagle:E2');
  assert.ok(e2, '未照合の本が作者頁に並ぶ');
  assert.equal(e2.origin, 'local');
  assert.equal(e2.gallery.idOwned, true, '題だけの済ではない (所持を隠すで伏せられる)');
  const person = (await home.ensure()).byId.get(id);
  assert.ok(person.books.some((book) => book.id === '77' && book.ref.type === 'hitomi'), '#gid の行は照合先の hitomi の本');
  assert.equal(person.books.some((book) => book.id === 'pweagle:E4'), false);
});

test('Eagle のタグの道: nhentai に手で結んだ本は hitomi の本ではなく、未照合と同じ疑似ギャラリーで寄せる', () => {
  const built = buildHome(circleInput({ eagleRows: [eagleRow('N1', ['架空サークル'], { gid: 'nh:555' })] }));
  const circle = built.byId.get(homeAuthorId('circle', 'the circle'));
  const book = circle.books.find((row) => row.id === 'pweagle:N1');
  assert.ok(book, 'サークルの本になる');
  assert.deepEqual(plain(book.ref), { type: 'eagle', eagleId: 'N1' });
  assert.equal(circle.books.some((row) => row.id === 'nh:555'), false, 'hitomi の素性を引く本にしない');
});

test('作者フォルダの本が台帳で hitomi に照合済みなら、同じ人の所持の hitomi の本と一冊に畳む (? を出さない)', () => {
  const rows = [hitomiRow('mihon sakusha', 11), hitomiRow('mihon sakusha', 12), hitomiRow('mihon sakusha', 13)];
  const input = baseInput({
    hitomiRows: rows,
    labelOf: () => '見本作者',
    links: [{ personId: 'FOLDERA', source: 'hitomi', name: 'mihon sakusha' }],
    // A3 (持ち込みの本) の Eagle の項目は hitomi 11 に照合済み。A1 (Pawchive の本) は 12 に照合済みでも畳まない。
    // B1 の照合先 13 は別の人 (FOLDERB) の頁に無いので畳まない
    eagleLinks: [{ eagleId: 'A3', gid: 11 }, { eagleId: 'A1', gid: 12 }, { eagleId: 'B1', gid: 13 }],
    covers: { FOLDERA: 'pweagle:A3' },
  });
  const built = buildHome(input);
  const a = built.byId.get(homeAuthorId('folder', 'FOLDERA'));
  assert.equal(a.books.some((book) => book.id === 'pweagle:A3'), false, '持ち込みの本は hitomi の本に畳む');
  const twin = a.books.find((book) => book.id === '11');
  assert.equal(twin.origin, 'hitomi');
  assert.equal(twin.star, 1, '星は大きい方');
  assert.deepEqual(plain(twin.readKeys).sort(), ['11', 'pweagle:A3'], '栞は両方の印で見る');
  assert.equal(a.bySource.local, 0, '? の本が無くなる');
  assert.equal(a.count, 5, '同じ本を二冊に数えない');
  assert.equal(a.cover, '11', '選んだ表紙は畳んだ先の本へ移す');
  assert.ok(a.books.some((book) => book.id === 'pweagle:A1'), 'Pawchive の本はそのまま');
  const b = built.byId.get(homeAuthorId('folder', 'FOLDERB'));
  assert.ok(b.books.some((book) => book.id === 'pweagle:B1'), '照合先が別の人の本は畳まない');
  // 束の本は他の人と分け合うので、元の本の印を書き換えない
  const again = buildHome({ ...input, eagleLinks: [] });
  assert.deepEqual(plain(again.byId.get(homeAuthorId('folder', 'FOLDERA')).books.find((book) => book.id === '11').readKeys), ['11']);
});

test('一覧の追い読み (2 頁目から) は 1 頁目と同じ並びから切る。間に組み直しても同じ人を二枚出さない', async () => {
  const persons = (names) => buildHome(baseInput({
    folders: names.map((name, index) => ({ folderId: `F${index}`, name })),
    pawItems: names.map((_, index) => pawItem(`I${index}`, `F${index}`)),
  }));
  const home = new HomeAuthors({});
  home.cache = { ...persons(['あ', 'い', 'う', 'え']), signature: 'x' };
  home.signature = () => 'x';
  const first = await home.search({ sort: 'name', pageSize: 2, page: 0 });
  // 裏で組み直して並びが変わった (新しい人が頭に入った)
  home.cache = { ...persons(['ぁ', 'あ', 'い', 'う', 'え']), signature: 'x' };
  const second = await home.search({ sort: 'name', pageSize: 2, page: 1 });
  const ids = [...first.galleries, ...second.galleries].map((card) => card.id);
  assert.equal(new Set(ids).size, ids.length, '同じ人を二枚出さない');
  assert.equal(ids.length, 4);
  // 1 頁目を引き直せば新しい並び
  const fresh = await home.search({ sort: 'name', pageSize: 2, page: 0 });
  assert.equal(fresh.total, 5);
});

test('同じ人をサークルと作者の二枚に出さない: 1 冊でもサークルの本なら寄せる。本が全部一人の作者の物のサークルは作者に寄せる', () => {
  const rows = [
    // one: 1 冊だけで、その本はサークル solo の本 → solo の見出しに束ねる (作者の見出しは立てない)
    hitomiRow('one', 1), groupRow('solo', 1),
    // wide: 3 冊のうち 1 冊だけ mini の本。mini の本は wide の物だけ → mini は見出しにせず wide のサークルに
    hitomiRow('wide', 2), groupRow('mini', 2), hitomiRow('wide', 3), hitomiRow('wide', 4),
    // shared: wide の本と別の作者の本を持つサークル → 見出しのまま (本を分け合う)
    hitomiRow('wide', 5), groupRow('shared', 5), hitomiRow('other', 6), groupRow('shared', 6), hitomiRow('other', 7),
  ];
  const built = buildHome(baseInput({ hitomiRows: rows, dominantShare: 0.6 }));
  assert.ok(built.byId.get(homeAuthorId('circle', 'solo')));
  assert.equal(built.byId.get(homeAuthorId('hitomi', 'one')), undefined, '1 冊の作者もサークルに寄る');
  assert.equal(built.byId.get(homeAuthorId('circle', 'solo')).authors[0].artist, 'one');
  const wide = built.byId.get(homeAuthorId('hitomi', 'wide'));
  assert.ok(wide);
  assert.equal(wide.count, 4);
  assert.equal(built.byId.get(homeAuthorId('circle', 'mini')), undefined, '本が全部 wide の物のサークルは見出しにしない');
  assert.deepEqual(wide.circles.map((row) => [row.group, row.minor]).sort(), [['mini', false], ['shared', true]]);
  assert.ok(built.byId.get(homeAuthorId('circle', 'shared')), '本を分け合うサークルは見出しのまま');
  // group の名乗り (mini) を作者フォルダに結ぶと、wide の塊ごと寄る
  const linked = buildHome(baseInput({ hitomiRows: rows, links: [{ personId: 'FOLDERA', source: 'hitomi', name: 'group:mini' }] }));
  assert.equal(linked.byId.get(homeAuthorId('folder', 'FOLDERA')).bySource.hitomi, 4);
  assert.equal(linked.byId.get(homeAuthorId('hitomi', 'wide')), undefined);
});

test('作者に寄せたサークルの鍵 (c:) に付いていた結び・★・名前・表紙・候補・退けた答えは、作者の鍵 (h:) で読む', () => {
  const rows = [hitomiRow('wide', 2), groupRow('mini', 2), hitomiRow('wide', 3), hitomiRow('wide', 4)];
  const built = buildHome(baseInput({
    hitomiRows: rows,
    dominantShare: 0.6,
    links: [{ personId: 'c:mini', source: 'pixiv', name: '777' }],
    ratings: { 'c:mini': 4 },
    names: { 'c:mini': '決めた名' },
    covers: { 'c:mini': '3' },
    suggestions: [{ personId: 'c:mini', source: 'pawchive', name: 'fanbox:9', note: 'x', unresolved: true }, { personId: 'c:mini', source: 'pawchive', name: 'patreon:8' }],
    rejected: new Set([linkKey('c:mini', 'pawchive', 'patreon:8')]),
  }));
  const wide = built.byId.get(homeAuthorId('hitomi', 'wide'));
  assert.ok(wide);
  assert.deepEqual(wide.links.pixiv.map((link) => [link.value, link.state]), [['777', 'linked']]);
  assert.equal(wide.rating, 4);
  assert.equal(wide.name, '決めた名');
  assert.equal(wide.cover, '3');
  assert.deepEqual(wide.links.pawchive.map((link) => [link.value, link.state, link.unresolved]), [['fanbox:9', 'candidate', true]], '退けた候補は出さない');
  assert.equal(wide.unresolved, true);
  // 今の鍵 (h:) の値が勝つ
  const both = buildHome(baseInput({ hitomiRows: rows, ratings: { 'c:mini': 4, 'h:wide': 2 }, dominantShare: 0.6 }));
  assert.equal(both.byId.get(homeAuthorId('hitomi', 'wide')).rating, 2);
});

test('判定できなかった候補を持つ作者だけ (unresolvedOnly)', async () => {
  const input = baseInput({
    suggestions: [{ personId: 'FOLDERA', source: 'pixiv', name: '1', unresolved: true }, { personId: 'FOLDERB', source: 'pixiv', name: '2' }],
  });
  const home = searchable({ input });
  const all = await home.search({ sort: 'name' });
  assert.equal(all.total, 2);
  const only = await home.search({ sort: 'name', unresolvedOnly: true });
  assert.deepEqual(only.galleries.map((card) => card.id), [homeAuthorId('folder', 'FOLDERA')]);
  assert.equal(only.galleries[0].home.links.pixiv[0].unresolved, true);
});

test('候補に「決められなかった」の印を後から付ける (suggest の unresolved)', () => {
  const nodeFs = require('node:fs');
  const nodePath = require('node:path');
  const dir = nodeFs.mkdtempSync(nodePath.join(require('node:os').tmpdir(), 'bunko-cl-'));
  const store = new CreatorLinks({ file: nodePath.join(dir, 'creator-links.json') });
  assert.equal(store.suggest([{ personId: 'h:a', source: 'pixiv', name: '1', note: 'n', by: 'b' }]), 1);
  assert.equal(store.suggestions()[0].unresolved, undefined);
  assert.equal(store.suggest([{ personId: 'h:a', source: 'pixiv', name: '1', unresolved: true }]), 1, '印を付け直した');
  assert.equal(store.suggestions()[0].unresolved, true);
  assert.equal(store.suggestions()[0].note, 'n', 'note は元のまま');
  assert.equal(store.suggest([{ personId: 'h:a', source: 'pixiv', name: '1', unresolved: true }]), 0, '同じ印は数えない');
  assert.equal(store.suggest([{ personId: 'h:a', source: 'pixiv', name: '1', unresolved: false }]), 1);
  assert.equal(store.suggestions()[0].unresolved, false);
});

test('共著・合同誌の一冊きりの見出しは並べない: その本を全部、より多く持つ別の見出しが持っていれば一覧から外す (二冊以上か、利用者の印があれば並ぶ)', () => {
  const rows = [
    // gid 1 は big と one の共著。one はこの一冊しか持たない → 並べない (本は big から読める)
    hitomiRow('big', 1), hitomiRow('one', 1), hitomiRow('big', 2), hitomiRow('big', 3),
    // gid 4 は big と two の共著、two は gid 5 も持つ (二冊) → 並べる
    hitomiRow('big', 4), hitomiRow('two', 4), hitomiRow('two', 5),
    // solo の一冊は誰とも分け合っていない → 並べる
    hitomiRow('solo', 6),
    // rated は一冊きりの共著だが利用者の★がある → 並べる
    hitomiRow('big', 7), hitomiRow('rated', 7),
    // gid 8 は作者 big と another の共著で、サークル circ の本。サークルは作者の見出しに隠れない (サークル名で出す)。
    // another は主のサークル circ に束ねられ、サークルの見出し (所持 1 冊) になる
    hitomiRow('big', 8), hitomiRow('another', 8), groupRow('circ', 8),
  ];
  const built = buildHome(baseInput({ hitomiRows: rows, ratings: { 'h:rated': 4 }, dominantShare: 0.6 }));
  const ids = built.persons.map((person) => person.id);
  assert.ok(!ids.includes(homeAuthorId('hitomi', 'one')), '一冊きりの共著は一覧に出ない');
  assert.ok(ids.includes(homeAuthorId('hitomi', 'big')));
  assert.ok(ids.includes(homeAuthorId('hitomi', 'two')), '二冊持てば出る');
  assert.ok(ids.includes(homeAuthorId('hitomi', 'solo')), '分け合っていない一冊は出る');
  assert.ok(ids.includes(homeAuthorId('hitomi', 'rated')), '★を付けた見出しは残す');
  assert.ok(ids.includes(homeAuthorId('circle', 'circ')), '作者の見出しだけが持つ本のサークルは隠さない');
  assert.deepEqual(built.hidden, [homeAuthorId('hitomi', 'one')]);
  // 外した人も id と名前では引ける (詳細の「作者」から作者の頁へ飛べる)
  assert.ok(built.byId.get(homeAuthorId('hitomi', 'one')));
  assert.equal(findByQuery(built, '@one').id, homeAuthorId('hitomi', 'one'));
  // 下限を 1 にすれば従来どおり全員並ぶ
  const loose = buildHome(baseInput({ hitomiRows: rows, sharedMin: 1, dominantShare: 0.6 }));
  assert.ok(loose.persons.some((person) => person.id === homeAuthorId('hitomi', 'one')));
});

test('サークルを先に (既定): 一冊でもサークルの本があれば作者はそのサークルに束ねる。同数なら名の順で先のサークル', () => {
  const rows = [
    // many: 10 冊のうち 1 冊だけサークル one の本 → それでも one の見出しに束ねる (作者の見出しは立てない)
    ...Array.from({ length: 9 }, (_, i) => hitomiRow('many', 100 + i)),
    hitomiRow('many', 200), groupRow('circle one', 200),
    // split: 2 冊が別々のサークル (同数) → 名の順で先の 'a side' に。もう一方は本を分け合う見出しのまま
    hitomiRow('split', 300), groupRow('b side', 300), hitomiRow('split', 301), groupRow('a side', 301),
    hitomiRow('someone', 302), groupRow('b side', 302),
  ];
  const built = buildHome(baseInput({ hitomiRows: rows }));
  assert.equal(built.byId.get(homeAuthorId('hitomi', 'many')), undefined, '一冊でもサークルの本があれば作者の見出しは立てない');
  const one = built.byId.get(homeAuthorId('circle', 'circle one'));
  assert.ok(one);
  assert.equal(one.count, 10, 'サークルの見出しに作者の本が全部入る');
  assert.equal(built.byId.get(homeAuthorId('hitomi', 'split')), undefined);
  assert.ok(built.byId.get(homeAuthorId('circle', 'a side')), '同数なら名の順で先のサークル');
  assert.ok(built.byId.get(homeAuthorId('circle', 'b side')), 'もう一方のサークルも本を分け合うので見出しのまま');
  // 6 割の決まりに戻せば従来どおり作者の見出し
  const strict = buildHome(baseInput({ hitomiRows: rows, dominantShare: 0.6 }));
  assert.ok(strict.byId.get(homeAuthorId('hitomi', 'many')));
});

// ---- 2026-09-27 の作り直し (docs/ui-home-author-2026-09-27.md) ------------------------

test('見出しの扇: 後ろの二枚は顔の次に新しい確かな所持の本 (作者フォルダの自動の顔は一番新しい本なので飛ばす)', () => {
  const built = buildHome(baseInput());
  const a = built.byId.get(homeAuthorId('folder', 'FOLDERA'));
  assert.deepEqual(plain(authorCard(a).home.stack), ['pweagle:A1', 'pweagle:A3']);
  // 表紙を選んだ人は、選んだ本を飛ばして新しい順
  const chosen = buildHome(baseInput({ covers: { FOLDERA: 'pweagle:A1' } }));
  const b = chosen.byId.get(homeAuthorId('folder', 'FOLDERA'));
  assert.equal(b.cover, 'pweagle:A1');
  assert.deepEqual(plain(authorCard(b).home.stack), ['pweagle:A2', 'pweagle:A3']);
  // 一冊の人は後ろが無い
  const single = built.byId.get(homeAuthorId('folder', 'FOLDERB'));
  assert.deepEqual(plain(authorCard(single).home.stack), []);
});

// Eagle の項目の id: 頭の 8 字が入れた時刻の 36 進 (実物と同じ形)
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 27, 12);
function eagleIdAt(at, tail = 'ABCDE') {
  return at.toString(36).toUpperCase().padStart(8, '0') + tail;
}

test('Eagle に入れた時刻は項目の id の頭 8 字から読む (形の違う id は 0)', () => {
  assert.equal(eagleAddedAt(eagleIdAt(NOW - DAY)), NOW - DAY);
  assert.equal(eagleAddedAt('X1'), 0);
  assert.equal(eagleAddedAt('0000000000000'), 0, '2015 年より前は id の形が違う物とみなす');
});

test('最近の動き: 直近 2 週間に Eagle へ入れた本がある人だけを、入れた新しい順に (公開日ではない)。語の無い一頁目だけ', async () => {
  const input = baseInput({
    folders: [{ folderId: 'F1', name: 'い' }, { folderId: 'F2', name: 'あ' }, { folderId: 'F3', name: 'う' }, { folderId: 'F4', name: 'え' }],
    pawItems: [
      pawItem(eagleIdAt(NOW - 3 * DAY, 'AAAAA'), 'F1', { date: '20260901', name: '[20260901] 見本' }),
      pawItem(eagleIdAt(NOW - 10 * DAY, 'BBBBB'), 'F2', { date: '20240101', name: '[20240101] 見本' }),
      pawItem(eagleIdAt(NOW - 30 * DAY, 'CCCCC'), 'F3', { date: '20260920', name: '[20260920] 見本' }),
      pawItem(eagleIdAt(NOW - DAY, 'DDDDD'), 'F4', { date: '20200101', name: '[20200101] 見本' }),
    ],
  });
  const home = new HomeAuthors({ now: () => NOW });
  home.cache = { ...buildHome(input), signature: 'x' };
  home.signature = () => 'x';
  const first = await home.search({ sort: 'title' });
  assert.ok(first.overview, '一頁目には帯が付く');
  assert.deepEqual(first.overview.moving.map((g) => g.title), ['え', 'い', 'あ'], '30 日前に入れた人は出さない');
  assert.equal('favorites' in first.overview, false, '上の顔の札 (よく見る作者) は外した');
  // 一覧の「最近の動き」も入れた新しい順
  assert.deepEqual((await home.search({ sort: 'activity' })).galleries.map((g) => g.title), ['え', 'い', 'あ', 'う']);
  assert.equal((await home.search({ query: 'い' })).overview, null, '語がある時は出さない');
  assert.equal((await home.search({ sort: 'title', pageSize: 1, page: 1 })).overview, null, '追い読みには付けない');
  // 誰も入れていない時は空 (帯は出ない)
  const later = new HomeAuthors({ now: () => NOW + 60 * DAY });
  later.cache = home.cache;
  later.signature = () => 'x';
  assert.deepEqual((await later.search({})).overview.moving, []);
});

test('最近読んだ順は他のタブで読んだ本も作者で寄せる: Pawchive の栞の鍵・栞に添えた pixiv の user id と作者の名', async () => {
  const input = baseInput({
    folders: [
      { folderId: 'FOLDERA', name: '見本 作者' }, { folderId: 'FOLDERB', name: '別の人' }, { folderId: 'FOLDERC', name: '三人目' },
    ],
    pawItems: [pawItem('A1', 'FOLDERA'), pawItem('B1', 'FOLDERB'), pawItem('C1', 'FOLDERC')],
    pixivCreators: { 4242: { folderId: 'FOLDERB' } },
    pawCreators: { 'Fanbox:777': 'FOLDERC' },
    hitomiRows: [hitomiRow('some_body', 1)],
  });
  const home = new HomeAuthors({
    reading: {
      // 見本 作者の所持の本を 100 に読んだ。三人目は Pawchive のタブで所持していない投稿を 300 に
      summary: () => ({ 'pweagle:A1': { updatedAt: 100 }, 'pw:fanbox:777:9999': { updatedAt: 300 } }),
      // 別の人は pixiv のタブで 400 に、some body は nhentai のタブで 200 に (読む画面が栞に添えた作者)
      creatorReads: () => ({ 'pixiv:4242': 400, 'name:Some Body': 200, 'name:x': 999 }),
    },
  });
  home.cache = { ...buildHome(input), signature: 'x' };
  home.signature = () => 'x';
  const result = await home.search({ sort: 'read' });
  assert.deepEqual(result.galleries.map((g) => g.title), ['別の人', '三人目', 'some body', '見本 作者']);
  // 作者の鍵の均し: 名は nameKey、1 字の名は偶然当たるので捨てる、Pawchive の service は小文字
  const times = creatorReadTimes({ 'pw:Fanbox:777:1': { updatedAt: 5 } }, { 'name:x': 9, 'group:見本 サークル': 7 });
  assert.deepEqual([...times.keys()].sort(), ['group:見本サークル', 'pawchive:fanbox:777']);
});

test('発見の新作の id: 人に集めて作者頁の返りに載せる (年ごとの「新」の印)', async () => {
  const rows = [hitomiRow('mihon sakusha', 11)];
  const built = buildHome(baseInput({
    hitomiRows: rows, labelOf: () => '見本作者',
    newByArtist: new Map([['mihon sakusha', 2]]), newIdsByArtist: new Map([['mihon sakusha', new Set(['501', 502])]]),
  }));
  const a = built.byId.get(homeAuthorId('folder', 'FOLDERA'));
  assert.deepEqual([...a.newIds].sort(), ['501', '502']);
  const home = new HomeAuthors({});
  home.cache = { ...built, signature: 'x' };
  home.signature = () => 'x';
  home.bookGalleries = () => [];
  const payload = await home.author({ id: homeAuthorId('folder', 'FOLDERA') });
  assert.deepEqual(plain(payload.newIds).sort(), ['501', '502']);
});

test('作者頁の所持の本: 最後に読んだ時 (栞の updatedAt の一番新しい物) を readAt に。読んだ記録が無ければ 0', async () => {
  const { home } = linkable();
  home.deps.pawLibrary.toGallery = (item) => ({
    id: `pweagle:${item.eagleId}`, source: 'pawchive', kind: 'eagleItem', eagleId: item.eagleId, title: item.title, pageCount: 12, owned: true,
  });
  home.deps.reading = { summary: () => ({ 'pweagle:A1': { updatedAt: 700 }, 'pweagle:A2': { updatedAt: 300 } }) };
  const payload = await home.author({ id: homeAuthorId('folder', 'FOLDERA') });
  const readAt = Object.fromEntries(payload.books.map((book) => [book.id, book.readAt]));
  assert.equal(readAt['pweagle:A1'], 700);
  assert.equal(readAt['pweagle:A2'], 300);
  assert.equal(readAt['pweagle:A3'], 0);
});

// ---- 作品の検索 (2026-09-27): 題・タグ・注釈 (キャプション) に当て、当たった本のある人を残す ----
// 名前・題・タグ・注釈はすべて見本。台帳は SQL の形で答え分ける偽物、Eagle の注釈は走査の控えの形で差す
function findable({ extraFolders = [], extraItems = [], extraEagle = {}, rewrite = null, web = null } = {}) {
  const input = baseInput({
    folders: [
      { folderId: 'FOLDERA', name: '見本 作者' },
      { folderId: 'FOLDERB', name: '別の人' },
      ...extraFolders,
    ],
    pawItems: [
      pawItem('A1', 'FOLDERA', { star: 5 }),
      pawItem('A2', 'FOLDERA', { star: 4, date: '20250102', name: '[20250102] (C105) 見本' }),
      pawItem('A3', 'FOLDERA', { star: 1, date: null, postId: null, name: '手で入れた本' }),
      pawItem('B1', 'FOLDERB', { star: 2 }),
      ...extraItems,
    ],
    hitomiRows: [hitomiRow('tag person', 21), hitomiRow('tag person', 22, { lang: 'english' })],
  });
  const eagle = new Map(Object.entries({
    A1: { name: '見本の項目', tags: ['見本札'], annotation: '' },
    // ひらがなの注釈 (カタカナで打っても当たる)
    A2: { name: '見本の項目 2', tags: [], annotation: '作品キャプション: みほんの語 が入る' },
    // 題に札の語が出るだけ (札は持たない)
    A3: { name: '見本札の出てくる題', tags: [], annotation: '' },
    B1: { name: '別の項目', tags: ['別の札'], annotation: '' },
    ...extraEagle,
  }).map(([id, meta]) => [`${id}.info`, { meta }]));
  const catalog = {
    queryRows: (sql) => {
      if (/FROM gallery_tags t/.test(sql) && /t\.gallery_id IN/.test(sql)) {
        return [{ gid: 21, type: 'female', name: 'sample tag' }, { gid: 22, type: 'female', name: 'other tag' }];
      }
      if (/FROM galleries g/.test(sql) && /g\.id IN/.test(sql)) {
        return [{ gid: 21, title: '見本 21', lang: 'japanese', type: 'doujinshi' }, { gid: 22, title: '見本 22', lang: 'english', type: 'doujinshi' }];
      }
      return [];
    },
    lookupTagLabel: (type, name) => (type === 'female' && name === 'sample tag' ? '見本札' : ''),
    getGalleryMetaBatch: (ids) => new Map(ids.map((id) => [Number(id), { id: Number(id), title: `見本 ${id}` }])),
  };
  const pawLibrary = {
    toGallery: (item) => ({ id: `pweagle:${item.eagleId}`, source: 'pawchive', kind: 'eagleItem', eagleId: item.eagleId, title: item.title, pageCount: 12, owned: true }),
  };
  const home = new HomeAuthors({
    catalog,
    pawLibrary,
    reading: { summary: () => ({}) },
    eagleEntries: () => eagle,
    rewriteQuery: rewrite || ((text) => ({ query: text, resolved: [] })),
    searchHitomi: web || undefined,
  });
  home.cache = { ...buildHome(input), signature: 'x' };
  home.signature = () => 'x';
  return home;
}

async function found(home, query) {
  const result = await home.search({ query, sort: 'title' });
  return Object.fromEntries(result.galleries.map((card) => [card.title, card.home.matched]));
}

test('作品の検索: 題・Eagle のタグ・注釈・hitomi のタグの日本語の札に当て、当たった本のある人と当たった冊数', async () => {
  const home = findable();
  // 見本札: A1 (Eagle のタグ)・A3 (題)・hitomi の 21 (タグの日本語の札)
  assert.deepEqual(await found(home, '見本札'), { 'tag person': 1, '見本 作者': 2 });
  // 注釈 (キャプション) のひらがなにカタカナで当たる
  assert.deepEqual(await found(home, 'ミホンノ語'), { '見本 作者': 1 });
  // 語が無ければ今までどおり全員 (数は添えない)
  const all = await home.search({ sort: 'title' });
  assert.equal(all.galleries.length, 3);
  assert.equal(all.galleries[0].home.matched, null);
  // 扇の後ろは当たった本 (作者フォルダの顔 = 一番新しい A2 は重ねない)
  const list = await home.search({ query: '見本札', sort: 'title' });
  assert.deepEqual(plain(list.galleries.find((card) => card.title === '見本 作者').home.stack), ['pweagle:A1', 'pweagle:A3']);
});

test('作品の検索: 型付きの語はタグに一致・除く型付きの語は札との完全一致だけで弾く・言語', async () => {
  const home = findable();
  // female:sample_tag = hitomi の 21 (タグ)、A1 (日本語の札と同じ Eagle のタグ)、A3 (題に札の語)
  assert.deepEqual(await found(home, 'female:sample_tag'), { 'tag person': 1, '見本 作者': 2 });
  // 除く: A1 (札そのもの) と 21 は弾く。A3 は題に語が出るだけなので残す
  assert.deepEqual(await found(home, '-female:sample_tag'), { 'tag person': 1, '別の人': 1, '見本 作者': 2 });
  // 除く素の語は当て先に出たら弾く
  assert.deepEqual(await found(home, '-見本札'), { 'tag person': 1, '別の人': 1, '見本 作者': 1 });
  // 言語: hitomi の本は台帳の言語、言語の分からない本は日本語とみなす
  assert.deepEqual(await found(home, 'language:english'), { 'tag person': 1 });
});

test('作品の検索: 作者の名に当たった語はその人の本を全部通す (「作者名 語」でその作者の当たりの本)', async () => {
  const home = findable();
  assert.deepEqual(await found(home, '見本 作者 ミホンノ語'), { '見本 作者': 1 });
  // 名だけなら全部の本 (画面は作者頁へ語を付けずに移る)
  assert.deepEqual(await found(home, '見本作者'), { '見本 作者': 3 });
  const byName = (await home.search({ query: '見本作者' })).galleries[0].home;
  assert.equal(byName.matchedByName, true);
  assert.equal((await home.search({ query: '見本 作者 ミホンノ語' })).galleries[0].home.matchedByName, false);
  // 除く語が名に当たれば、その人ごと外す
  assert.equal((await found(home, '見本札 -見本作者'))['見本 作者'], undefined);
});

test('作品の検索: 別名の書き換え (日本語 → 型付きの語) は元の語も当て先に残し、書き換えを interpreted で返す', async () => {
  const rewrite = (text) => (text === '見本札'
    ? { query: 'female:sample_tag', resolved: [{ from: '見本札', to: 'female:sample_tag', label: '見本札', type: 'female' }] }
    : { query: text, resolved: [] });
  const home = findable({ rewrite });
  const result = await home.search({ query: '見本札', sort: 'title' });
  assert.deepEqual(Object.fromEntries(result.galleries.map((card) => [card.title, card.home.matched])), { 'tag person': 1, '見本 作者': 2 });
  assert.deepEqual(plain(result.interpreted).map((item) => item.to), ['female:sample_tag']);
});

test('@名前 語: 名前は長い方から切って人を決め、残りの語で作者頁の本に当たりの印 (本の並びは絞らない)', async () => {
  const home = findable({
    extraFolders: [{ folderId: 'FOLDERC', name: '見本' }],
    extraItems: [pawItem('C1', 'FOLDERC')],
  });
  const aId = homeAuthorId('folder', 'FOLDERA');
  const cId = homeAuthorId('folder', 'FOLDERC');
  const whole = await home.search({ query: '@見本 作者' });
  assert.equal(whole.homeAuthor.author.id, aId, '空白を含む名前を先に');
  assert.equal(whole.homeAuthor.filter, null, '語が無ければ絞らない');
  const filtered = await home.search({ query: '@見本 作者 ミホンノ語' });
  assert.equal(filtered.homeAuthor.author.id, aId);
  assert.equal(filtered.homeAuthor.books.length, 3, '本は全部返す (画面の控えを語ごとに分けない)');
  assert.deepEqual(plain(filtered.homeAuthor.filter.hits), ['pweagle:A2']);
  assert.equal(filtered.homeAuthor.filter.count, 1);
  assert.equal(filtered.homeAuthor.filter.words, 'ミホンノ語');
  assert.equal(filtered.total, 1);
  // 名の語は作者頁の本を絞らない (名に当たるので全部が当たり)
  const named = await home.author({ query: '@見本 作者 見本' });
  assert.equal(named.filter.hits.length, 3);
  const short = await home.search({ query: '@見本 見本札' });
  assert.equal(short.homeAuthor.author.id, cId, '長い名前の人が居なければ短い名前で割る');
  assert.equal(short.homeAuthor.filter.words, '見本札');
  assert.equal((await home.search({ query: '@居ない人 見本札' })).homeAuthor, null);
});

test('作品の検索: 網の作品の当たり (webHits) は網の頁の控えから、題・タグと日本語の札で', async () => {
  const asked = [];
  const web = async (payload) => {
    asked.push(payload.query);
    return {
      galleries: [
        { id: 901, title: 'web one', tags: [{ type: 'female', name: 'sample tag' }] },
        { id: 902, title: 'web two', tags: [{ type: 'female', name: 'other tag' }] },
      ],
      total: 2,
    };
  };
  const home = findable({ web });
  const id = homeAuthorId('hitomi', 'tag person');
  assert.deepEqual(plain((await home.webHits({ id, site: 'hitomi', words: '見本札' })).hits), ['901']);
  assert.deepEqual(plain((await home.webHits({ id, site: 'hitomi', words: '-female:sample_tag' })).hits), ['902']);
  assert.equal(asked.length, 1, '網の頁は控えから (二度目は網へ出ない)');
  assert.deepEqual(plain((await home.webHits({ id, site: 'hitomi', words: '' })).hits), []);
});

test('作品の検索: 一度語で引いた後の組み直しでは、当て先を裏で少しずつ先に組む (組み直されたら止める)', async () => {
  const home = findable();
  home.deps.findWarmDelayMs = 0;
  let gathered = 0;
  const materials = home.findMaterials.bind(home);
  home.findMaterials = () => {
    gathered += 1;
    return materials();
  };
  // 語で引く前は組まない
  assert.equal(home.findUsed, undefined);
  await home.search({ query: 'ミホンノ語' });
  assert.equal(home.findUsed, true);
  assert.equal(gathered, 1);
  // 組み直した控え (新しい入れ物) を裏で組む
  const next = { ...buildHome(baseInput()), signature: 'y' };
  home.cache = next;
  home.warmFind(next);
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gathered, 2, '材料は控えごとに一度');
  await home.search({ query: '見本札', sort: 'title' });
  assert.equal(gathered, 2, '先に組んだ当て先を使う (語で引いても組み直さない)');
  assert.ok(Array.isArray(next.findVocab), '検索欄の候補の材料も先に組む');
  // 組み直されたら古い控えの組み立ては止める
  const stale = { ...buildHome(baseInput()), signature: 'z' };
  home.warmFind(stale);
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gathered, 2, '今の控えでない物は組まない');
});

// ---- 検索欄のタグの候補 (2026-09-27): 所持の本に付いているタグから、前方一致 → 冊数の多い順 ----
function suggestable() {
  return findable({
    extraFolders: [{ folderId: 'FOLDERC', name: '見本 三' }],
    extraItems: [pawItem('C1', 'FOLDERC'), pawItem('C2', 'FOLDERC')],
    extraEagle: {
      // 前方一致の札 (一冊) と、空白を含む札・頭が - の札
      C1: { name: '見本の項目 C1', tags: ['札の見本', 'two words', '-頭'], annotation: '' },
      C2: { name: '見本の項目 C2', tags: ['見本札'], annotation: '' },
    },
  });
}

test('検索欄の候補: 所持の本のタグから、前方一致を先に、同じなら冊数の多い順。Eagle のタグが型付きのタグの日本語の札と同じ字なら畳む', async () => {
  const home = suggestable();
  const rows = plain(await home.suggestWords('札'));
  // 札の見本 (前方一致・1 冊) → 見本札 (female:sample_tag に畳む: 21・A1・C2 の 3 冊) → 別の札 (1 冊)
  assert.deepEqual(rows.map((row) => row.label), ['札の見本', '見本札', '別の札']);
  const folded = rows.find((row) => row.label === '見本札');
  assert.equal(folded.value, 'female:sample_tag', '日本語の札と同じ Eagle のタグは型付きのタグへ');
  assert.equal(folded.type, 'female');
  assert.equal(folded.count, 3);
  assert.deepEqual(folded.metric, { site: 'home', kind: 'works', value: 3, scope: 'owned' });
  const own = rows.find((row) => row.label === '別の札');
  assert.equal(own.value, '別の札', '型の無いタグはそのまま自由語');
  assert.equal(own.secondary, 'Eagle');
  // ローマ字の名でも当たる。頭の - は外して引く (付け直すのは画面)
  assert.equal(plain(await home.suggestWords('-sample')).map((row) => row.value)[0], 'female:sample_tag');
  assert.deepEqual(plain(await home.suggestWords('')), []);
});

test('検索欄の候補: 型を付けて打てばその型だけ (型だけなら冊数の順)。空白・頭の - を含む札は括って送る', async () => {
  const home = suggestable();
  assert.deepEqual(plain(await home.suggestWords('female:')).map((row) => [row.value, row.count]), [['female:sample_tag', 3], ['female:other_tag', 1]]);
  assert.deepEqual(plain(await home.suggestWords('female:oth')).map((row) => row.value), ['female:other_tag']);
  assert.deepEqual(plain(await home.suggestWords('male:')), []);
  assert.equal(plain(await home.suggestWords('two')).find((row) => row.label === 'two words').value, '"two words"');
  assert.equal(plain(await home.suggestWords('頭')).find((row) => row.label === '-頭').value, '"-頭"');
  // 括った値で引くと、その札の本に当たる (除くの語にならない)
  const found = await home.search({ query: '"-頭"', sort: 'title' });
  assert.deepEqual(found.galleries.map((card) => card.title), ['見本 三']);
});

test('検索欄の候補: 辞書 (読み・別名) で当たった hitomi の語は、所持の本に在る物だけ足す', async () => {
  const home = suggestable();
  const decorate = require('../src/lib/search-decorate');
  const original = decorate.fromDictionary;
  decorate.fromDictionary = () => [
    { type: 'female', name: 'other_tag', label: '別の見本', value: 'female:other_tag' },
    { type: 'female', name: 'absent_tag', label: '無い見本', value: 'female:absent_tag' },
  ];
  try {
    const rows = plain(await home.suggestWords('よみ'));
    assert.deepEqual(rows.map((row) => row.value), ['female:other_tag'], '所持に無い語 (0 冊) は出さない');
    assert.equal(rows[0].count, 1);
  } finally {
    decorate.fromDictionary = original;
  }
});
