'use strict';

// Home の画面側 (src/renderer/home.js と app.js の継ぎ目)。docs/home-tab-spec-2026-09-23.md。
// 押さえるのは「利用者の一手が何を起こすか」と「どこに何が出るか」:
//   源泉の並び (先頭に Home、E-Hentai は外す)・Home の札と並び
//   作者の見出し (右上の所持の冊数・左上の新・左下のサイトの帯と ?)
//   押し分け (左 = 作者頁の語 @名前、右 = 詳細)・詳細の行 (結び済み / 候補 / 未結び)
//   作者頁の本 (題の頭の出どころの印・候補の ?)・語を Home と源泉の間で持ち運ばない
// 名前・題はすべて見本。

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadInVm } = require('./helpers/vm-dom');

const plain = (value) => JSON.parse(JSON.stringify(value));

const DEPS = [
  'src/renderer/reader.js',
  'src/renderer/downloads-ui.js',
  'src/renderer/dupe-cluster.js',
  'src/renderer/navigation-state.js',
  'src/renderer/virtual-grid.js',
  'src/renderer/home-bundle.js',
  'src/renderer/home.js',
];

function app({ hitomi = {}, settings = {} } = {}) {
  const calls = { search: [], home: [], saved: [] };
  const api = {
    imageBase: async () => 'http://img.test',
    gallery: async (id) => ({ id, pageCount: 0 }),
    annotate: async (list) => list,
    search: async (payload) => { calls.search.push(payload); return { galleries: [], total: 0 }; },
    settings: async () => settings,
    saveSettings: async (partial) => { calls.saved.push(partial); return partial; },
    cancelSearch: async () => true,
    home: async (payload) => { calls.home.push(payload); return { author: null, books: [] }; },
    readerActive() {},
    ...hitomi,
  };
  const ctx = loadInVm('src/renderer/app.js', { globals: { hitomi: api }, deps: DEPS });
  ctx.__harness.state.imageBase = 'http://img.test';
  ctx.__harness.state.settings = settings;
  ctx.calls = calls;
  ctx.run = (code) => vm.runInContext(code, ctx);
  return ctx;
}

function author(over = {}) {
  const home = {
    kind: 'folder', name: '見本 作者', cover: 'pwlibf:FOLDERA', count: 5, newCount: 0,
    sites: ['pixiv', 'hitomi'], unsure: false,
    links: {
      pixiv: [{ url: 'https://www.pixiv.net/users/1', state: 'linked', fixed: false }],
      pawchive: [],
      hitomi: [{ url: 'https://hitomi.la/artist/sample-all.html', state: 'candidate', fixed: false }],
      nhentai: [],
    },
    linkable: { pixiv: true, pawchive: true, hitomi: true, nhentai: true },
    recent: [{ id: 'pweagle:A1', title: '見本の本', date: '2024-05-01', origin: 'pawchive', pages: 12 }],
    ...(over.home || {}),
  };
  return {
    id: 'home:f:FOLDERA', source: 'home', kind: 'creator', title: home.name,
    artists: [], groups: [], series: [], characters: [], tags: [], pageCount: 0, owned: false, url: '',
    ...over, home,
  };
}

test('源泉の並び: 先頭に Home、E-Hentai は外す (URL を貼っても E-Hentai の頁へは入らない)', () => {
  const ctx = app();
  assert.deepEqual(plain(ctx.run('SOURCES.map((s) => s.id)')), ['home', 'hitomi', 'nhentai', 'pawchive', 'pixiv']);
  assert.equal(ctx.sourceShown('ehentai'), false);
  assert.equal(ctx.shownSourceOr('ehentai'), 'hitomi', '閉じた時の続きが E-Hentai なら hitomi から');
  assert.equal(ctx.detectSource('https://e-hentai.org/g/1/abc/').source, 'ehentai', 'URL の見分けは残る (移らないだけ)');
  ctx.__stopTimers();
  // 母屋 (preload) が渡す並びに E-Hentai が居ても外す (手のひら版の机上版は構文の登録簿をそのまま渡す)
  const lan = app({ hitomi: { searchProviders: [{ id: 'hitomi', label: 'hitomi' }, { id: 'ehentai', label: 'E-Hentai' }] } });
  assert.deepEqual(plain(lan.run('SOURCES.map((s) => s.id)')), ['hitomi']);
  lan.__stopTimers();
});

test('Home の種別の札と並び。既定は「最近の動き」、向きは母屋で返せる', () => {
  const ctx = app();
  const { state } = ctx.__harness;
  assert.deepEqual(plain(ctx.typesFor('home')).map((t) => t.label), ['ホーム'], 'サイトと候補の絞りは外し、一覧の頭へ戻る札だけ');
  assert.deepEqual(plain(ctx.sortsFor('home')).map((s) => s.id), ['activity', 'read', 'rating', 'stars', 'owned', 'title']);
  assert.equal(ctx.sortsFor('home').find((s) => s.id === 'stars').label, '作品の評価順');
  assert.equal(ctx.sortsFor('home').find((s) => s.id === 'rating').label, '作者の評価順');
  assert.equal(ctx.sortForSource('home', 'all'), 'activity');
  state.source = 'home';
  state.scope = 'all';
  assert.equal(ctx.sortDirNativeSupported(), true);
  state.type = 'pixiv';
  ctx.renderTypes();
  assert.equal(state.type, '', '前の会の種別は外す');
  assert.match(String(ctx.__harness.els.types.innerHTML), /class="chip active" data-type="">ホーム</);
  assert.doesNotMatch(String(ctx.__harness.els.types.innerHTML), /chip-discover/, 'Home に発見の札は出さない');
  ctx.__stopTimers();
});

test('作者の見出し = 扇: 顔を正面に、後ろに次の二冊。名の下に冊数・新作・★、正面の表紙にサイトの帯 (? は未確定の時だけ)', () => {
  const ctx = app();
  const html = ctx.cardMarkup(author({ home: { newCount: 2, stack: ['pweagle:A2', 'pweagle:A3'] } }));
  assert.match(html, /class="card is-creator home-author home-fan"/);
  assert.match(html, /class="home-fan-card is-back is-back-1" src="http:\/\/img\.test\/[^"]*A2/);
  assert.match(html, /class="home-fan-card is-back is-back-2" src="http:\/\/img\.test\/[^"]*A3/);
  assert.match(html, /class="home-fan-card is-front" src="http:\/\/img\.test\/pwlibf\/FOLDERA"/, '正面は作者フォルダの札');
  assert.ok(html.indexOf('is-back-1') < html.indexOf('is-front'), '後ろの二枚を先に置く (正面が上に重なる)');
  assert.match(html, /class="home-fan-count"[^>]*>5 冊</);
  assert.match(html, /class="home-fan-new"[^>]*>新作 \+2</);
  assert.doesNotMatch(html, /card-meta/, '作者の見出しの .card-meta は本体が伏せるので使わない');
  assert.match(html, /<span class="home-sites">.*icons\/sites\/pixiv\.ico.*icons\/sites\/hitomi\.png.*<\/span>/);
  assert.doesNotMatch(html, /is-unknown/);
  const unsure = ctx.cardMarkup(author({ home: { unsure: true, sites: [], count: 0 } }));
  assert.match(unsure, /home-site is-unknown/);
  assert.doesNotMatch(unsure, /home-fan-count/, '所持 0 冊なら冊数は出さない');
  assert.doesNotMatch(unsure, /is-back/, '後ろの本が無ければ正面だけ');
  ctx.__stopTimers();
});

test('押し分け: 左 (と Enter) は詳細の板、右とダブルクリックは作者頁 (@名前 で検索)。ダブルクリックは一度だけ開く', async () => {
  const ctx = app();
  const { state, els } = ctx.__harness;
  ctx.BunkoHome.init();
  state.source = 'home';
  state.scope = 'all';
  state.galleries = [author()];
  assert.equal(ctx.BunkoHome.press('home:f:FOLDERA', 'right'), true);
  assert.equal(state.query, '@見本 作者');
  assert.equal(els.query.value, '@見本 作者');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ctx.calls.search.at(-1).source, 'home');
  assert.equal(ctx.calls.search.at(-1).query, '@見本 作者');
  const searches = ctx.calls.search.length;
  // ダブルクリックは click の二度目と dblclick の二度届く: 続けて来た二度目は飲む
  state.galleries = [author()];
  assert.equal(ctx.BunkoHome.press('home:f:FOLDERA', 'double'), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ctx.calls.search.length, searches, '右の直後のダブルクリックで二重に開かない');

  state.query = '';
  state.galleries = [author()];
  assert.equal(ctx.BunkoHome.press('home:f:FOLDERA', 'left'), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(state.selected && state.selected.id, 'home:f:FOLDERA');
  assert.equal(els.detail.hidden, false);
  const body = String(els.detailBody.innerHTML);
  assert.match(body, /作者 · 所持 5 冊/);
  assert.match(body, /data-home-open="home:f:FOLDERA"[^>]*>.*作品を見る/);
  assert.match(body, /class="pixiv-detail-related" open><summary>最近の本/);
  assert.match(body, /data-related-detail="pweagle:A1"/);
  // Home の見出しでなければ本体の割り当てに任せる
  state.galleries = [{ id: '123', source: 'hitomi', title: 't' }];
  assert.equal(ctx.BunkoHome.press('123', 'left'), false);
  ctx.__stopTimers();
});

test('詳細の行: pixiv / Pawchive / hitomi / nhentai の四つだけ。結び済み・候補・未結び', () => {
  const ctx = app();
  const { state } = ctx.__harness;
  state.source = 'home';
  const body = ctx.BunkoHome.detailMarkup(author());
  const labels = [...body.matchAll(/<dt class="row-label">([^<]+)<\/dt>/g)].map((m) => m[1]);
  assert.deepEqual(labels, ['作者の★', 'pixiv', 'Pawchive', 'hitomi', 'nhentai']);
  assert.doesNotMatch(body, /DLsite|FANZA|x\.com/);
  const sites = ctx.BunkoHome.SITES;
  const cell = (key, over = {}, readOnly = false) => ctx.BunkoHome.linkCell(author(over).home, sites.find((s) => s.key === key), readOnly);
  // 結び済み: 鎖の印・URL (押すとサイトで開く)・外す (切れた鎖)。文字の札は出さない
  assert.match(cell('pixiv'), /class="home-chain" title="結び済み"/);
  assert.match(cell('pixiv'), /data-site="https:\/\/www\.pixiv\.net\/users\/1"/);
  assert.match(cell('pixiv'), /data-home-link="unlink"[^>]*aria-label="外す"[^>]*><svg/);
  // 候補: 点線の鎖の印・URL・結ぶ (鎖)・違う (切れた鎖)
  assert.match(cell('hitomi'), /class="home-chain is-candidate" title="候補 \(名前が一致しただけ\)"/);
  assert.match(cell('hitomi'), /data-home-link="accept"[^>]*aria-label="結ぶ"[^>]*><svg/);
  assert.match(cell('hitomi'), /data-home-link="reject"[^>]*aria-label="違う \(候補から外す\)"[^>]*><svg/);
  assert.doesNotMatch(cell('hitomi'), />候補<|>結ぶ<|>違う</, '文字の釦と札はやめた');
  // 未結び: URL の入力欄と結ぶ (鎖)
  assert.match(cell('pawchive'), /<input type="url" class="home-url-input" data-home-input="pawchive"/);
  assert.match(cell('pawchive'), /data-home-link="save"[^>]*aria-label="結ぶ"/);
  // 札の名乗り (hitomi だけの人の hitomi) は外せない
  const fixed = cell('hitomi', { home: { links: { pixiv: [], pawchive: [], nhentai: [], hitomi: [{ url: 'https://hitomi.la/artist/x-all.html', state: 'linked', fixed: true }] } } });
  assert.doesNotMatch(fixed, /data-home-link/);
  // 結べない所 (作者の頁をその場で組んだ時など) は URL だけ
  assert.match(cell('pawchive', { home: { linkable: { pixiv: false, pawchive: false, hitomi: false, nhentai: true } } }), /home-url-none/);
  // 写しでは URL を見せるだけ
  assert.doesNotMatch(cell('pixiv', {}, true), /data-home-link/);
  assert.doesNotMatch(cell('pawchive', {}, true), /input/);
  ctx.__stopTimers();
});

test('作者頁の本: 題の頭に出どころの印 (持ち込みは ?)、候補の本は表紙の左上に ?', () => {
  const ctx = app();
  const book = (origin, candidate = false) => ({
    id: `pweagle:${origin}`, origin, candidate, date: '2024-05-01', event: null,
    gallery: {
      id: `pweagle:${origin}`, source: 'pawchive', kind: 'eagleItem', eagleId: origin, title: '見本の本',
      artists: [], groups: [], series: [], characters: [], tags: [], pageCount: 3, owned: true, idOwned: true, star: 0,
    },
  });
  const pixiv = ctx.BunkoHome.bookCard(book('pixiv'));
  assert.match(pixiv, /<h3 class="card-title"><span class="home-origin" title="pixiv"><img src="icons\/sites\/pixiv\.ico"/);
  assert.match(pixiv, /class="card home-book/);
  const local = ctx.BunkoHome.bookCard(book('local'));
  assert.match(local, /home-origin is-unknown" title="持ち込み"/);
  const candidate = ctx.BunkoHome.bookCard(book('hitomi', true));
  assert.match(candidate, /home-book is-candidate/);
  assert.match(candidate, /class="home-book-q" title="名前が一致しただけの候補"/);
  assert.match(candidate, /済/, '所持の本は本体どおり 済');
  ctx.__stopTimers();
});

test('作者頁の本: 網で見つけた推定の公開日には表紙の左下に「頃」(重ねるだけ)。確かな日付には出さない', () => {
  const ctx = app();
  const book = (extra) => ({
    id: 'pweagle:G1', origin: 'local', candidate: false, date: '2022-11-20', event: null, ...extra,
    gallery: {
      id: 'pweagle:G1', source: 'pawchive', kind: 'eagleItem', eagleId: 'G1', title: '見本の本',
      artists: [], groups: [], series: [], characters: [], tags: [], pageCount: 3, owned: true, idOwned: true, star: 0,
    },
  });
  const guessed = ctx.BunkoHome.bookCard(book({ dateGuess: true, dateBasis: 'hitomi-uploaded' }));
  assert.match(guessed, /<span class="home-marks"><span class="home-mark is-guess" title="公開日は推定 \(hitomi への掲載日[^"]*\)">頃<\/span><\/span>/);
  const sure = ctx.BunkoHome.bookCard(book({ dateGuess: false, dateBasis: 'pixiv-post' }));
  assert.doesNotMatch(sure, /頃/);
  const undated = ctx.BunkoHome.bookCard(book({ date: null, dateGuess: true }));
  assert.doesNotMatch(undated, /頃/, '日付の無い本に印は付けない');
  ctx.__stopTimers();
});

test('作者頁: 検索の返りに添えた作者と本を同じ一巡で並べ、一覧の語に戻ったら畳む', () => {
  const ctx = app();
  const { state, els } = ctx.__harness;
  ctx.BunkoHome.init();
  state.source = 'home';
  state.scope = 'all';
  state.query = '@見本 作者';
  const books = [
    { id: 'pweagle:A1', origin: 'pawchive', candidate: false, date: '2024-05-01', event: { code: 'C104', year: 2024, season: '夏', month: 8 },
      gallery: { id: 'pweagle:A1', source: 'pawchive', kind: 'eagleItem', eagleId: 'A1', title: '見本 一', artists: [], groups: [], series: [], characters: [], tags: [], pageCount: 3, owned: true, star: 0 } },
    { id: '77', origin: 'hitomi', candidate: false, date: null, event: null,
      gallery: { id: 77, source: 'hitomi', title: '見本 二', artists: [], groups: [], series: [], characters: [], tags: [], pageCount: 20, owned: true, star: 0 } },
  ];
  ctx.BunkoHome.sync(true, { homeAuthor: { author: author(), books, handles: 0 } });
  assert.ok(ctx.document.body.hasAttribute('data-home'));
  assert.ok(ctx.document.body.hasAttribute('data-home-author'));
  assert.equal(ctx.findGallery('77').title, '見本 二', '作者頁の本は詳細・読むへ渡せる');
  assert.equal(plain(ctx.BunkoHome.readingOrder()).map((g) => String(g.id)).join(','), 'pweagle:A1,77', '読む画面の次の本は作者頁の並び');
  const merged = ctx.BunkoHome.merged({ books, web: { works: [
    { id: '88', origin: 'hitomi', candidate: false, date: '2025-01-01', gallery: { id: 88, owned: false } },
    { id: '77', origin: 'hitomi', candidate: false, date: null, gallery: { id: 77, owned: true } },
  ] } });
  assert.deepEqual(plain(merged.map((book) => String(book.id))), ['88', 'pweagle:A1', '77'], '網の作品を混ぜ、所持と同じ作品は足さない。日付不明は最後');
  // 一覧の語に戻る: 返りが来た (settled) 時に畳む
  state.query = '';
  ctx.BunkoHome.sync(false);
  assert.ok(ctx.document.body.hasAttribute('data-home-author'), '一覧の返りを待つ間は畳まない (空の棚を挟まない)');
  ctx.BunkoHome.sync(true, { galleries: [] });
  assert.ok(!ctx.document.body.hasAttribute('data-home-author'));
  assert.equal(ctx.BunkoHome.readingOrder(), null, '一覧に戻ったら次の本は本体の一覧のまま');
  // 控えた作者の本は Home に居る間は引ける (詳細の「最近の本」を押した時に待たせない)
  assert.equal(ctx.findGallery('77').title, '見本 二');
  // 源泉を移ったら Home の顔を外す
  state.source = 'hitomi';
  ctx.BunkoHome.sync(false);
  assert.ok(!ctx.document.body.hasAttribute('data-home'));
  assert.equal(els.grid.hidden, false);
  assert.equal(ctx.findGallery('77'), null, 'Home の外では作者頁の本を引かない');
  ctx.__stopTimers();
});

test('語を Home と源泉の間で持ち運ばない (Home は旅に加わらない)', () => {
  const ctx = app();
  const { state } = ctx.__harness;
  // hitomi で引いていた語の旅の途中で Home へ
  ctx.run("homeTrip.query = '@見本 作者'; queryJourney = { hitomi: 'female:sample' };");
  state.query = 'female:sample';
  ctx.portQueryInto('hitomi', 'home');
  assert.equal(state.query, '@見本 作者', 'Home へは Home の前の語で入る');
  // Home から別の源泉へ: 旅の控えの語を戻す
  ctx.portQueryInto('home', 'hitomi');
  assert.equal(state.query, 'female:sample');
  ctx.portQueryInto('home', 'nhentai');
  assert.equal(state.query, '', '旅の控えに無い源泉は空から');
  ctx.__stopTimers();
});

// 作者頁の本 (所持の本の一覧の形)。題は架空
function ownedBook(id, title, pages, date) {
  return {
    id, origin: 'pawchive', candidate: false, date, event: null,
    gallery: {
      id, source: 'pawchive', kind: 'eagleItem', eagleId: id.replace('pweagle:', ''), title, artists: [], groups: [], series: [],
      characters: [], tags: [], pageCount: pages, owned: true, idOwned: true, star: 0,
    },
  };
}

function webWork(id, origin, title, pages, date) {
  return {
    id: String(id), origin, candidate: false, date, event: null,
    gallery: { id, source: origin, title, artists: [], groups: [], series: [], characters: [], tags: [], pageCount: pages, owned: false },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
// 頭の数の札 (冊数と未所持) を前の形 "N 冊 (未所持 M)" に読み直す
const countOf = (ctx) => {
  const html = ctx.BunkoHome.viewHtml();
  const count = (html.match(/class="home-av-pill home-av-count"[^>]*>([^<]*)</) || [])[1];
  const unowned = (html.match(/class="home-av-pill">未所持 (\d+)</) || [])[1];
  return count === undefined ? undefined : `${count}${unowned ? ` (未所持 ${unowned})` : ''}`;
};

test('作者頁: 網の作品を源泉ごとに引き (結び済みと名乗りのある源泉だけ)、表示の切り替えで冊数と並ぶ本が変わる', async () => {
  const requests = [];
  const ctx = app({
    settings: { hideOwnedMode: 'dupes' },
    hitomi: {
      home: async (payload) => {
        requests.push(payload);
        if (payload.action === 'web' && payload.site === 'hitomi') {
          return { works: [webWork(88, 'hitomi', '(C104) [架空] 架空題甲 [DL版]', 26, '2024-09-01')], more: false };
        }
        if (payload.action === 'web' && payload.site === 'pixiv') {
          return { works: [webWork('px:5', 'pixiv', '架空題乙', 1, '2024-10-01')], more: false };
        }
        return { works: [] };
      },
    },
  });
  const { state, els } = ctx.__harness;
  ctx.BunkoHome.init();
  state.source = 'home';
  state.scope = 'all';
  state.query = '@見本 作者';
  ctx.BunkoHome.sync(true, { homeAuthor: { author: author(), books: [ownedBook('pweagle:A1', '架空題甲', 24, '2024-08-12')], handles: 1 } });
  await settle();
  const sites = requests.filter((r) => r.action === 'web').map((r) => r.site).sort();
  assert.deepEqual(plain(sites), ['hitomi', 'pixiv'], 'Pawchive は結んでいないので引かない');
  assert.doesNotMatch(ctx.BunkoHome.viewHtml(), /data-home-back/, '頭の「<」は無い (マウスの戻る・進むで動く)');

  // 所持の版違いを隠す: 所持の本と同じ作品の hitomi の写しは畳み、別の作品の pixiv は出す
  assert.equal(countOf(ctx), '2 冊 (未所持 1)');
  state.settings.hideOwnedMode = 'none';
  ctx.BunkoHome.refresh();
  assert.equal(countOf(ctx), '3 冊 (未所持 2)', '全て表示: 畳んだ物も数える');
  assert.match(ctx.BunkoHome.viewHtml(), /home-mark is-fold[^>]*>版違い</, '畳んだ物には印');
  state.settings.hideOwnedMode = 'owned';
  ctx.BunkoHome.refresh();
  assert.equal(countOf(ctx), '1 冊 (未所持 1)', '所持を隠す: 所持の本とその版違いを伏せる');

  // 右上の「所持作品」釦: 所持作品のスコープへは移らず、作者頁を所持の本だけにする
  assert.equal(ctx.BunkoHome.toggleOwnedOnly(), true);
  assert.equal(state.scope, 'all', 'スコープは動かさない (Home を hitomi へ移さない)');
  assert.equal(state.source, 'home');
  assert.equal(countOf(ctx), '1 冊', '所持の本だけ (網を混ぜない)');
  assert.equal(els.hideOwned.hidden, true, '伏せる網の作品が無いので表示の切り替えは引っ込める');
  assert.match(String(els.scope.title), /所持作品だけを表示中/);
  await settle();
  assert.ok(ctx.calls.saved.some((patch) => patch.homeOwnedOnly === true), '旗は設定に覚える');
  // 旗を立てたまま源泉を移ったら、表示の切り替えは本体どおり出す (旗は Home の中だけ)
  state.source = 'hitomi';
  ctx.BunkoHome.sync(false);
  assert.equal(els.hideOwned.hidden, false);
  state.source = 'home';
  ctx.BunkoHome.sync(false);
  assert.equal(els.hideOwned.hidden, true);
  ctx.BunkoHome.toggleOwnedOnly();
  assert.equal(els.hideOwned.hidden, false);
  ctx.__stopTimers();
});


test('一覧の見出し: サークルを先に立てた時は題の下に作者名、表紙の右下に作者の★', () => {
  const ctx = app();
  const html = ctx.cardMarkup(author({ home: { authorLine: '甲作者・乙作者', rating: 4 } }));
  assert.match(html, /class="home-author-line"><span class="card-artist">甲作者・乙作者</);
  assert.match(html, /class="home-fan-rating" title="作者の★ 4">★4</);
  const plainCard = ctx.cardMarkup(author());
  assert.doesNotMatch(plainCard, /home-author-line|home-fan-rating/);
  ctx.__stopTimers();
});

test('詳細: サークルと作者の行 (作者は押すとその作者の頁へ)、作者の★ (同じ星で外す)', async () => {
  const rated = [];
  const ctx = app({
    hitomi: {
      home: async (payload) => {
        if (payload.action === 'rate') {
          rated.push(payload);
          return { ok: true, author: author({ home: { rating: payload.star } }) };
        }
        return { author: null, books: [] };
      },
    },
  });
  const { state, els } = ctx.__harness;
  ctx.BunkoHome.init();
  state.source = 'home';
  state.scope = 'all';
  const circle = author({
    id: 'home:c:the%20circle',
    home: {
      kind: 'circle', rating: 2, rateable: true,
      circles: [{ group: 'the circle', label: '架空サークル' }],
      authors: [{ label: '甲作者', artist: 'alpha', query: '@甲作者' }, { label: '乙作者', artist: 'beta', query: '' }],
    },
  });
  const body = ctx.BunkoHome.detailMarkup(circle);
  const labels = [...body.matchAll(/<dt class="row-label">([^<]+)<\/dt>/g)].map((m) => m[1]);
  assert.deepEqual(labels, ['作者の★', 'サークル', '作者', 'pixiv', 'Pawchive', 'hitomi', 'nhentai']);
  assert.match(body, /class="kicker">サークル · 所持 5 冊/);
  assert.match(body, /data-home-query="@甲作者"[^>]*>甲作者</);
  assert.match(body, /<span class="home-person">乙作者</, '頁の無い作者は名前だけ');
  assert.equal((body.match(/class="home-star is-on"/g) || []).length, 2);

  // 作者の名前を押す: 詳細を畳んでその作者の頁 (@名前) へ
  state.galleries = [circle];
  state.selected = circle;
  const jump = { dataset: { homeQuery: '@甲作者' } };
  els.detailBody.dispatch('click', { target: { closest: (sel) => (sel === '[data-home-query]' ? jump : null) } });
  assert.equal(state.query, '@甲作者');
  assert.equal(state.selected, null);

  // ★: 3 を押すと 3、今の★ (2) を押すと外す (0)
  state.selected = circle;
  const star = (n) => ({ dataset: { homeRate: String(n) }, disabled: false, closest: () => null });
  els.detailBody.dispatch('click', { target: { closest: (sel) => (sel === '[data-home-rate]' ? star(3) : null) } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  state.selected = circle;
  els.detailBody.dispatch('click', { target: { closest: (sel) => (sel === '[data-home-rate]' ? star(2) : null) } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(plain(rated.map((payload) => [payload.id, payload.star])), [['home:c:the%20circle', 3], ['home:c:the%20circle', 0]]);
  ctx.__stopTimers();
});

test('作者頁: 頭のサイトの釦で出すサイトを切り替える (作者頁ごとに覚える。切ったサイトは薄く)。年 / 月も作者頁ごと', async () => {
  const ctx = app({
    settings: { hideOwnedMode: 'none' },
    hitomi: {
      home: async (payload) => {
        if (payload.action === 'web' && payload.site === 'pixiv') {
          return { works: [webWork('px:5', 'pixiv', '架空題乙', 1, '2024-10-01')], more: false };
        }
        return { works: [] };
      },
    },
  });
  const { state } = ctx.__harness;
  ctx.BunkoHome.init();
  state.source = 'home';
  state.scope = 'all';
  state.query = '@見本 作者';
  ctx.BunkoHome.sync(true, { homeAuthor: { author: author(), books: [ownedBook('pweagle:A1', '架空題甲', 24, '2024-08-12')], handles: 0 } });
  await settle();
  const html = () => ctx.BunkoHome.viewHtml();
  assert.match(html(), /data-home-origin="pixiv" aria-pressed="true"/);
  assert.match(html(), /data-home-origin="pawchive" aria-pressed="true"/);
  assert.doesNotMatch(html(), /data-home-origin="hitomi"/, '本の無いサイトの釦は出さない');
  assert.equal(countOf(ctx), '2 冊 (未所持 1)');
  const view = ctx.BunkoHome.viewNode();
  const click = (attrs) => view.dispatch('click', { target: { closest: (sel) => {
    if (sel === '[data-home-origin]' && attrs.origin) return { dataset: { homeOrigin: attrs.origin } };
    if (sel === '[data-home-group]' && attrs.group) return { dataset: { homeGroup: attrs.group } };
    return null;
  } } });
  click({ origin: 'pixiv' });
  assert.match(html(), /home-origin-toggle is-off" data-home-origin="pixiv" aria-pressed="false"/, '切ったサイトは薄い釦');
  assert.equal(countOf(ctx), '1 冊', '冊数も出しているサイトの本だけで数える');
  click({ group: 'month' });
  assert.match(html(), /data-home-group="month" aria-pressed="true"/);
  // 作者頁ごとに覚える (別の作者は既定: 全部出す・年)
  const saved = JSON.parse(ctx.localStorage.getItem('bunko.homeAuthorView'));
  assert.deepEqual(plain(saved['home:f:FOLDERA'].off), ['pixiv']);
  assert.equal(saved['home:f:FOLDERA'].group, 'month');
  state.query = '@別の人';
  ctx.BunkoHome.sync(true, { homeAuthor: { author: author({ id: 'home:f:FOLDERB', title: '別の人', home: { name: '別の人' } }), books: [ownedBook('pweagle:B1', '架空題丙', 12, '2024-01-01')], handles: 0 } });
  await settle();
  assert.match(html(), /data-home-group="year" aria-pressed="true"/, '既定は年');
  // 元の作者頁へ戻ると覚えた見え方
  state.query = '@見本 作者';
  ctx.BunkoHome.sync(true, { homeAuthor: { author: author(), books: [ownedBook('pweagle:A1', '架空題甲', 24, '2024-08-12')], handles: 0 } });
  await settle();
  assert.match(html(), /data-home-group="month" aria-pressed="true"/);
  assert.match(html(), /data-home-origin="pixiv" aria-pressed="false"/);
  click({ origin: 'pixiv' });
  click({ group: 'year' });
  assert.equal(JSON.parse(ctx.localStorage.getItem('bunko.homeAuthorView'))['home:f:FOLDERA'], undefined, '既定に戻したら覚えを消す');
  ctx.__stopTimers();
});


test('詳細: 持ち込みの行は出さない、結び済みの行の「もう一つ結ぶ」', () => {
  const ctx = app();
  const { state } = ctx.__harness;
  state.source = 'home';
  const body = ctx.BunkoHome.detailMarkup(author({ home: { localCount: 3, localOrigin: 'discord' } }));
  assert.doesNotMatch(body, /持ち込み<\/dt>|data-home-origin-set/, '持ち込みの本があっても詳細の板には出さない (2026-09-27)');
  const cell = ctx.BunkoHome.linkCell(author().home, ctx.BunkoHome.SITES.find((s) => s.key === 'pixiv'), false);
  assert.match(cell, /data-home-add="pixiv"/);
  ctx.__stopTimers();
});

test('Ctrl+Z で Home の操作を元に戻し、Ctrl+Shift+Z でやり直す (文字の欄では効かせない)', async () => {
  const calls = [];
  const ctx = app({
    hitomi: {
      home: async (payload) => {
        calls.push(payload);
        if (payload.action === 'rate') return { ok: true, undo: [{ k: 'rating', personId: 'FOLDERA', star: 2 }], author: author({ home: { rating: payload.star } }) };
        if (payload.action === 'undo') return { ok: true, redo: [{ k: 'rating', personId: 'FOLDERA', star: 4 }], author: author() };
        return { author: null, books: [] };
      },
    },
  });
  const { state, els } = ctx.__harness;
  ctx.BunkoHome.init();
  state.source = 'home';
  state.scope = 'all';
  const who = author({ home: { rating: 2, rateable: true } });
  state.galleries = [who];
  state.selected = who;
  const star = { dataset: { homeRate: '4' }, disabled: false, closest: () => null };
  els.detailBody.dispatch('click', { target: { closest: (sel) => (sel === '[data-home-rate]' ? star : null) } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(plain(ctx.BunkoHome.undoDepth()), { undo: 1, redo: 0 });
  const key = (over) => ctx.document.body.dispatch('keydown', { key: 'z', ctrlKey: true, shiftKey: false, target: { tagName: 'BODY' }, ...over });
  key({ target: { tagName: 'INPUT' } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.filter((c) => c.action === 'undo').length, 0, '文字の欄ではその欄の元に戻すのまま');
  key({});
  await new Promise((resolve) => setTimeout(resolve, 0));
  const undo = calls.filter((c) => c.action === 'undo');
  assert.equal(undo.length, 1);
  assert.deepEqual(plain(undo[0].steps), [{ k: 'rating', personId: 'FOLDERA', star: 2 }]);
  assert.deepEqual(plain(ctx.BunkoHome.undoDepth()), { undo: 0, redo: 1 });
  key({ shiftKey: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(plain(calls.filter((c) => c.action === 'undo')[1].steps), [{ k: 'rating', personId: 'FOLDERA', star: 4 }], 'やり直しは戻した手順の逆');
  assert.deepEqual(plain(ctx.BunkoHome.undoDepth()), { undo: 1, redo: 0 });
  ctx.__stopTimers();
});


test('詳細の名前: 鉛筆で名前を決め (Enter で決める)、決めた名前は「元の名前に戻す」で外せる', async () => {
  const calls = [];
  const ctx = app({
    hitomi: {
      home: async (payload) => {
        calls.push(payload);
        if (payload.action === 'rename') return { ok: true, undo: [{ k: 'name', personId: 'FOLDERA', name: '' }], author: author({ title: payload.name || '見本 作者', home: { renamed: Boolean(payload.name) } }) };
        return { author: null, books: [] };
      },
    },
  });
  const { state, els } = ctx.__harness;
  ctx.BunkoHome.init();
  state.source = 'home';
  state.scope = 'all';
  const who = author();
  assert.match(ctx.BunkoHome.detailMarkup(who), /data-home-rename title="名前を変える"/);
  assert.doesNotMatch(ctx.BunkoHome.detailMarkup(who), /data-home-rename-reset/, '決めていなければ戻す釦は無い');
  assert.match(ctx.BunkoHome.detailMarkup(author({ home: { renamed: true } })), /data-home-rename-reset/);
  // 決める: 名前の欄で Enter
  state.galleries = [who];
  state.selected = who;
  els.detailBody.dispatch('keydown', { key: 'Enter', isComposing: false, target: { closest: (sel) => (sel === '[data-home-name-input]' ? { value: '統一した名前' } : null) } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const rename = calls.find((c) => c.action === 'rename');
  assert.deepEqual(plain(rename), { action: 'rename', id: 'home:f:FOLDERA', name: '統一した名前' });
  assert.deepEqual(plain(ctx.BunkoHome.undoDepth()), { undo: 1, redo: 0 }, '名前も Ctrl+Z で戻せる');
  ctx.__stopTimers();
});

test('詳細の顔で表紙を選ぶ: 板には所持の本 (候補は除く) を並べ、先頭は自動。押すと決まり、Ctrl+Z で戻せる。写しでは出さない', async () => {
  const calls = [];
  const books = [
    { id: 'pweagle:A2', origin: 'pawchive', candidate: false, date: '2025-01-02', gallery: { id: 'pweagle:A2', title: '見本の本 二' } },
    { id: 'pweagle:A1', origin: 'pawchive', candidate: false, date: '2024-05-01', gallery: { id: 'pweagle:A1', title: '見本の本 一' } },
    { id: '11', origin: 'hitomi', candidate: true, date: '2023-08-13', gallery: { id: 11, title: '候補の本' } },
  ];
  const faceOf = (cover) => ({ cover: cover || 'pwlibf:FOLDERA', coverAuto: 'pwlibf:FOLDERA', coverChosen: Boolean(cover), coverable: true });
  const ctx = app({
    hitomi: {
      home: async (payload) => {
        calls.push(payload);
        if (payload.action === 'author') return { author: author({ home: faceOf('') }), books, handles: 0 };
        if (payload.action === 'cover') return { ok: true, undo: [{ k: 'cover', personId: 'FOLDERA', id: '' }], author: author({ home: faceOf(payload.cover) }) };
        return { author: null, books: [] };
      },
    },
  });
  const { state, els } = ctx.__harness;
  ctx.BunkoHome.init();
  state.source = 'home';
  state.scope = 'all';
  const who = author({ home: faceOf('') });
  const markup = ctx.BunkoHome.detailMarkup(who);
  assert.match(markup, /class="detail-cover home-face is-pickable" data-home-cover-open/, '顔を押すと選ぶ板');
  assert.match(markup, /title="表紙を選ぶ \(いまは自動/);
  assert.doesNotMatch(ctx.BunkoHome.detailMarkup(author()), /data-home-cover-open/, '選べない人 (その場で組んだ作者の頁) には出さない');
  state.settings = { ...state.settings, readOnly: true };
  assert.doesNotMatch(ctx.BunkoHome.detailMarkup(who), /data-home-cover-open/, '写しでは出さない');
  state.settings = { ...state.settings, readOnly: false };
  // 並べる本は作者頁の返り (詳細を開いた時に先に引いてある)
  await ctx.BunkoHome.prefetch(who);
  const sheet = ctx.BunkoHome.pickerMarkup(who);
  assert.deepEqual([...sheet.matchAll(/data-home-cover="([^"]*)"/g)].map((m) => m[1]), ['', 'pweagle:A2', 'pweagle:A1'], '先頭は自動、候補の本は出さない');
  assert.match(sheet, /所持 2 冊/);
  assert.match(sheet, /home-cover-tile is-auto is-current/, '選んでいなければ自動に印');
  assert.match(sheet, /src="http:\/\/img\.test\/pwlibf\/FOLDERA"/, '自動の札は自動の顔の絵');
  assert.match(ctx.BunkoHome.pickerMarkup(author({ home: faceOf('pweagle:A1') })), /is-current" data-home-cover="pweagle:A1"/, '選んだ本に印');
  // 表紙を押すと決める
  state.galleries = [who];
  state.selected = who;
  const tile = { dataset: { homeCover: 'pweagle:A1' } };
  els.detailBody.dispatch('click', { target: { closest: (sel) => (sel === '[data-home-cover]' ? tile : null) } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(plain(calls.find((c) => c.action === 'cover')), { action: 'cover', id: 'home:f:FOLDERA', cover: 'pweagle:A1' });
  assert.deepEqual(plain(ctx.BunkoHome.undoDepth()), { undo: 1, redo: 0 }, '表紙も Ctrl+Z で戻せる');
  assert.equal(state.selected.home.cover, 'pweagle:A1', '詳細は選んだ表紙で描き直す');
  // 今の表紙をもう一度押しても口は叩かない
  state.selected = author({ home: faceOf('pweagle:A1') });
  els.detailBody.dispatch('click', { target: { closest: (sel) => (sel === '[data-home-cover]' ? tile : null) } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.filter((c) => c.action === 'cover').length, 1);
  ctx.__stopTimers();
});

test('右上の「所持作品」釦: Home の外では本体のスコープの切り替えのまま', () => {
  const ctx = app();
  const { state } = ctx.__harness;
  ctx.BunkoHome.init();
  state.source = 'hitomi';
  state.scope = 'all';
  assert.equal(ctx.BunkoHome.toggleOwnedOnly(), false);
  assert.equal(ctx.BunkoHome.ownedOnlyActive(), false);
  ctx.__stopTimers();
});

test('Home で本の詳細のタグを押すと、その本の源泉へ移って引く (Home の語にしない)', async () => {
  const ctx = app();
  const { state } = ctx.__harness;
  state.source = 'home';
  state.scope = 'all';
  state.query = '@見本 作者';
  state.selected = { id: '77', source: 'hitomi', title: 't' };
  ctx.applyQuery('female:sample');
  assert.equal(state.source, 'hitomi');
  assert.equal(state.query, 'female:sample');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ctx.calls.search.at(-1).source, 'hitomi');
  assert.equal(ctx.run('homeTrip.query'), '@見本 作者', '戻った時の Home の語は残す');
  ctx.__stopTimers();
});

// ---- 2026-09-27 の作り直し (docs/ui-home-author-2026-09-27.md、案 2 改) ------------------------

test('作者頁: 縦の年表の軸は無い。★の高い本は多くて 12 冊、それより多い時はしばらく読んでいない物から。札は題と★と頁数だけ', () => {
  const ctx = app();
  const { state } = ctx.__harness;
  ctx.BunkoHome.init();
  state.source = 'home';
  state.scope = 'all';
  state.query = '@見本 作者';
  const star = (book, value, readAt) => ({ ...book, readAt, gallery: { ...book.gallery, star: value } });
  const books = [
    star(ownedBook('pweagle:S1', '見本 一', 10, '2026-05-01'), 5, 900),
    star(ownedBook('pweagle:S2', '見本 二', 10, '2026-04-01'), 5, 0),
    star(ownedBook('pweagle:S3', '見本 三', 10, '2025-04-01'), 4, 100),
    star(ownedBook('pweagle:S4', '見本 四', 10, '2025-03-01'), 4, 800),
    star(ownedBook('pweagle:S5', '見本 五', 10, '2024-03-01'), 4, 300),
    star(ownedBook('pweagle:S6', '見本 六', 10, '2024-02-01'), 5, 500),
    star(ownedBook('pweagle:S7', '見本 七', 10, '2024-01-01'), 3, 0),
  ];
  ctx.BunkoHome.sync(true, { homeAuthor: { author: author(), books, handles: 0 } });
  const html = ctx.BunkoHome.viewHtml();
  assert.doesNotMatch(html, /home-av-progress|home-av-node|home-av-timeline/, '軸は無い');
  const section = html.slice(html.indexOf('home-av-stars'), html.indexOf('home-av-years'));
  const ids = [...section.matchAll(/data-id="([^"]+)"/g)].map((m) => m[1]);
  // ★4・5 は 6 冊 (12 冊に満たないので全部)。★の多い順、同じなら読んだのが古い順
  assert.deepEqual(ids, ['pweagle:S2', 'pweagle:S6', 'pweagle:S1', 'pweagle:S3', 'pweagle:S5', 'pweagle:S4']);
  assert.match(section, /class="home-av-bento is-five"/, '五冊以上なら表紙に題を重ねた並びで一冊目を大きく');
  assert.match(section, /Eagle の ★5・★4 · 6 冊</);
  assert.match(section, /home-bento-cell[^>]*data-id="pweagle:S2"[\s\S]*?page-count-badge" aria-label="10ページ"/, '頁数は右上の印');
  assert.doesNotMatch(section, /読んだ記録|日前に読んだ|2026\.04/, '日付と読んだ記録は出さない (四回目の直し)');
  assert.doesNotMatch(section, /home-av-rank/, '番付の数字は付けない');
  assert.match(html, /home-av-years"><h3 class="home-av-kick">公開時期<span class="ui-segments home-av-mode"/, '年 / 月は「公開時期」の見出しの横');
  assert.doesNotMatch(html.slice(0, html.indexOf('home-av-stars')), /data-home-group/, '頭には年 / 月を置かない');
  assert.match(html, /home-av-pill home-av-count[^>]*>7 冊</);
  // 13 冊を超えると、最後に読んだのが新しい物から外す
  const many = Array.from({ length: 14 }, (_, i) => star(ownedBook(`pweagle:M${i}`, `見本 ${i}`, 10, '2025-01-01'), 4, i * 100));
  state.query = '@見本 作者 二';
  ctx.BunkoHome.sync(true, { homeAuthor: { author: author({ id: 'home:f:MANY', title: '見本 作者 二', home: { name: '見本 作者 二' } }), books: many, handles: 0 } });
  const more = ctx.BunkoHome.viewHtml();
  const picked = [...more.slice(more.indexOf('home-av-stars'), more.indexOf('home-av-years')).matchAll(/data-id="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(picked.length, 12);
  assert.ok(!picked.includes('pweagle:M13') && !picked.includes('pweagle:M12'), '一番最近読んだ二冊を外す');
  assert.match(more, /14 冊のうち、しばらく読んでいない 12 冊/);
  ctx.__stopTimers();
});

test('作者頁: 発見の新作に当たる未所持の本に「新」、その年の見出しに「新 N」。頭の「新作 +N」から最初の新作へ', async () => {
  const ctx = app({
    hitomi: {
      home: async (payload) => (payload.action === 'web' && payload.site === 'hitomi'
        ? { works: [webWork('501', 'hitomi', '網 一', 20, '2026-09-01'), webWork('502', 'hitomi', '網 二', 20, '2026-08-01'), webWork('503', 'hitomi', '網 三', 20, '2025-01-01')], more: false }
        : { works: [], more: false }),
    },
  });
  const { state } = ctx.__harness;
  ctx.BunkoHome.init();
  state.source = 'home';
  state.scope = 'all';
  state.query = '@見本 作者';
  const books = [ownedBook('pweagle:A1', '見本 一', 10, '2024-05-01')];
  ctx.BunkoHome.sync(true, { homeAuthor: { author: author({ home: { newCount: 2 } }), books, handles: 1, newIds: ['501', '502'] } });
  await settle();
  await settle();
  const html = ctx.BunkoHome.viewHtml();
  assert.equal((html.match(/home-book[^"]*is-new/g) || []).length, 2, '新作の二冊に印');
  assert.match(html, /data-key="2026"[\s\S]*?home-av-fresh[^>]*>新 2</, '2026 の見出しに「新 2」');
  assert.doesNotMatch(html.slice(html.indexOf('data-key="2025"')), /home-av-fresh/, '新作の無い年には付けない');
  assert.match(html, /data-home-first-new[^>]*>新作 \+2</);
  ctx.__stopTimers();
});

test('一覧の頭: 一頁目の返りの overview で最近の動きの帯を出す (顔の札と +N は無い)。語があれば帯は隠し、帯の人も詳細へ渡せる', () => {
  const ctx = app();
  const { state } = ctx.__harness;
  ctx.BunkoHome.init();
  state.source = 'home';
  state.scope = 'all';
  state.query = '';
  const mover = author({ id: 'home:h:mover', title: '動いた人', home: { name: '動いた人', newCount: 3 } });
  ctx.BunkoHome.sync(true, { galleries: [], overview: { moving: [mover] } });
  const strip = ctx.BunkoHome.stripNode();
  assert.equal(strip.hidden, false);
  assert.match(String(strip.innerHTML), /data-home-person="home:h:mover"[\s\S]*home-strip-new[^>]*>\+3</);
  assert.match(String(strip.innerHTML), /直近 2 週間 · 1 人/);
  assert.doesNotMatch(String(strip.innerHTML), /home-strip-more/, '溢れた人数の +N は出さない');
  assert.equal(typeof ctx.BunkoHome.chipsNode, 'undefined', '道具の行の顔の札は外した');
  assert.equal(ctx.findGallery('home:h:mover').title, '動いた人', '帯の人は一覧の外でも詳細へ渡せる');
  assert.equal(ctx.BunkoHome.uniformList(), true, 'Home の一覧は揃え (流しにしない)');
  // 語で絞った一覧では帯を隠す (前の総覧は覚えておき、語が消えたら出し直す)
  state.query = '動';
  ctx.BunkoHome.sync(true, { galleries: [], overview: null });
  assert.equal(strip.hidden, true);
  state.query = '';
  ctx.BunkoHome.sync(false);
  assert.equal(strip.hidden, false);
  ctx.__stopTimers();
});

// ---- 作品の検索 (2026-09-27): 一覧から作者頁へ移ると語を持って行き、当たった本だけを並べる ----

test('作品の検索の一覧: 見出しに「当たった冊数 / 所持」。作者頁へは語を付けて移る (名に当たっただけなら付けない)', async () => {
  const ctx = app();
  const { state } = ctx.__harness;
  ctx.BunkoHome.init();
  state.source = 'home';
  state.scope = 'all';
  const html = ctx.cardMarkup(author({ home: { matched: 2, matchedByName: false } }));
  assert.match(html, /class="home-fan-count is-matched"[^>]*>2 \/ 5 冊</);
  assert.match(ctx.cardMarkup(author({ home: { matched: 5, matchedByName: true } })), /class="home-fan-count"[^>]*>5 冊</, '名に当たっただけならいつもの冊数');
  assert.match(ctx.cardMarkup(author()), /class="home-fan-count"[^>]*>5 冊</, '検索していなければいつもの冊数');

  state.query = '架空札';
  state.galleries = [author({ home: { matched: 2, matchedByName: false } })];
  ctx.BunkoHome.press('home:f:FOLDERA', 'right');
  assert.equal(state.query, '@見本 作者 架空札');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ctx.calls.search.at(-1).query, '@見本 作者 架空札');

  await new Promise((resolve) => setTimeout(resolve, 700));
  state.query = '見本';
  state.galleries = [author({ home: { matched: 5, matchedByName: true } })];
  ctx.BunkoHome.press('home:f:FOLDERA', 'right');
  assert.equal(state.query, '@見本 作者', '語が名に当たっただけなら絞らない');
  ctx.__stopTimers();
});

test('作品の検索で絞った作者頁: 当たった所持の本と、網の作品は当たり (webHits) が届いた物だけ。絞りの札で外せ、語の無い作者頁は全部', async () => {
  const requests = [];
  const ctx = app({
    hitomi: {
      home: async (payload) => {
        requests.push(payload);
        if (payload.action === 'web' && payload.site === 'hitomi') {
          return { works: [webWork(88, 'hitomi', '架空題丁', 26, '2024-09-01'), webWork(89, 'hitomi', '架空題戊', 20, '2024-10-01')], more: false };
        }
        if (payload.action === 'webHits') return { words: payload.words, hits: ['89'] };
        return { works: [] };
      },
    },
  });
  const { state } = ctx.__harness;
  ctx.BunkoHome.init();
  state.source = 'home';
  state.scope = 'all';
  const books = [
    ownedBook('pweagle:A1', '架空題甲', 24, '2024-08-12'),
    ownedBook('pweagle:A2', '架空題乙', 12, '2023-02-01'),
  ];
  state.query = '@見本 作者 架空札';
  ctx.BunkoHome.sync(true, {
    homeAuthor: { author: author(), books, handles: 1, filter: { words: '架空札', hits: ['pweagle:A2'], count: 1 } },
  });
  let html = ctx.BunkoHome.viewHtml();
  assert.match(html, /class="home-av-pill is-filter" data-home-unfilter[^>]*>「架空札」/);
  assert.equal(countOf(ctx), '1 冊', '当たった所持の本だけ (網の当たりが届くまで網の作品は出さない)');
  assert.doesNotMatch(html, /架空題甲/);
  await settle();
  await settle();
  const asked = requests.filter((r) => r.action === 'webHits');
  assert.deepEqual(plain(asked.map((r) => [r.site, r.words])), [['hitomi', '架空札']]);
  html = ctx.BunkoHome.viewHtml();
  assert.equal(countOf(ctx), '2 冊 (未所持 1)', '網の作品は当たった物だけ');
  assert.match(html, /架空題戊/);
  assert.doesNotMatch(html, /架空題丁/);

  // 絞りの札を押すと語の無い作者頁へ
  ctx.BunkoHome.viewNode().dispatch('click', { target: { closest: (sel) => (sel === '[data-home-unfilter]' ? { dataset: {} } : null) } });
  assert.equal(state.query, '@見本 作者');
  // 語の無い作者頁の返り: 同じ作者の控えを使い回しても、絞りを引きずらない
  ctx.BunkoHome.sync(true, { homeAuthor: { author: author(), books, handles: 1, filter: null } });
  html = ctx.BunkoHome.viewHtml();
  assert.doesNotMatch(html, /is-filter/);
  assert.equal(countOf(ctx), '4 冊 (未所持 2)', '所持も網も全部');
  // 戻るで絞った頁へ: 覚えた絞りで描き直す (母屋に訊き直さない)
  const before = requests.length;
  state.query = '@見本 作者 架空札';
  ctx.BunkoHome.sync(true);
  assert.equal(countOf(ctx), '2 冊 (未所持 1)');
  assert.equal(requests.filter((r) => r.action === 'author').length, requests.slice(0, before).filter((r) => r.action === 'author').length);
  ctx.__stopTimers();
});

test('打ちながら引いた語の一覧から作者頁へ移って戻ると、語の欄も一覧も語の返りのまま', async () => {
  const ctx = app();
  const { state, els } = ctx.__harness;
  ctx.BunkoHome.init();
  state.source = 'home';
  state.scope = 'all';
  // 語の無い一覧が足跡の今
  ctx.run('pushHistory()');
  // 打ちながら引いた (live は足跡を積まない)
  state.query = '架空札';
  els.query.value = '架空札';
  state.galleries = [author({ home: { matched: 2, matchedByName: false } })];
  state.loading = false;
  ctx.BunkoHome.press('home:f:FOLDERA', 'right');
  assert.equal(state.query, '@見本 作者 架空札');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const entries = plain(ctx.run('history.map((entry) => entry.query)'));
  assert.deepEqual(entries.slice(-3), ['', '架空札', '@見本 作者 架空札'], '語の一覧を一つの足跡にしてから作者頁へ');
  ctx.__stopTimers();
});

test('表紙の大きさは一本の欄で決め、頁 (源泉 × 一覧 / 作者頁、所持作品は別) ごとに覚える', () => {
  const ctx = app();
  const { state } = ctx.__harness;
  const cases = [
    ['home', '@見本', true], ['home', '見本', false],
    ['pixiv', 'user:123', true], ['pixiv', 'user:123 見本', false],
    ['pawchive', 'fanbox/123', true], ['pawchive', 'fanbox/123 見本', false],
    ['hitomi', 'artist:mihon', true], ['hitomi', 'artist:mihon language:japanese', true],
    ['hitomi', 'artist:a artist:b', false], ['hitomi', 'female:x', false], ['hitomi', '', false],
    ['nhentai', 'group:mihon', true],
  ];
  for (const [source, query, want] of cases) assert.equal(ctx.authorPageNow(source, query), want, `${source} "${query}"`);
  state.settings = { uiCoverSize: 140, uiCoverSizes: { 'hitomi:author': 200, 'home:list': 180 } };
  state.scope = 'all';
  state.source = 'hitomi';
  state.query = 'artist:mihon';
  assert.equal(ctx.coverPageKey(), 'hitomi:author');
  assert.equal(ctx.currentCoverSize(), 200, 'hitomi の作者頁');
  state.query = 'female:x';
  assert.equal(ctx.currentCoverSize(), 140, '覚えていない頁は前からの大きさ');
  state.source = 'home';
  state.query = '';
  assert.equal(ctx.currentCoverSize(), 180, 'Home の一覧は Home の一覧の大きさ');
  state.source = 'pixiv';
  state.scope = 'library';
  assert.equal(ctx.coverPageKey(), 'pixiv+所持:list');
  assert.equal(ctx.coverPageLabel('pixiv+所持:list'), 'pixiv の所持作品の一覧');
  assert.equal(ctx.coverPageLabel('home:author'), 'Home の作者頁');
  ctx.setCoverSize('pixiv+所持:list', 120);
  assert.equal(ctx.currentCoverSize(), 120, '欄で決めた大きさはその頁にだけ');
  assert.equal(state.settings.uiCoverSizes['hitomi:author'], 200, 'ほかの頁の大きさはそのまま');
  ctx.__stopTimers();
});

// ---- Home の検索欄のタグの候補 (2026-09-27) ----

test('Home の検索欄の候補: 最後の一語を source home で訊き、頭の - は残す。@名前・打ち終えた語では出さない', async () => {
  const asked = [];
  const ctx = app({
    hitomi: {
      suggest: async (term, source) => {
        asked.push([term, source]);
        return [{ type: 'female', name: 'sample tag', label: '見本札', value: 'female:sample_tag', metric: { site: 'home', kind: 'works', value: 3, scope: 'owned' } }];
      },
    },
  });
  const { state, els } = ctx.__harness;
  state.source = 'home';
  state.scope = 'all';
  const ask = async (text) => {
    els.query.value = text;
    await ctx.maybeSuggest();
  };
  await ask('見本 -札');
  assert.deepEqual(plain(asked.at(-1)), ['札', 'home']);
  assert.equal(els.suggest.hidden, false);
  assert.match(String(els.suggest.innerHTML), /見本札/);
  assert.match(String(els.suggest.innerHTML), /class="count" title="このタグの付いた所持の本の数">3</);
  const before = asked.length;
  await ask('@見本 作者');
  await ask('見本 ');
  await ask('"括った 語"');
  assert.equal(asked.length, before, '作者頁の語・打ち終えた語・括った語では訊かない');
  assert.equal(els.suggest.hidden, true);
  ctx.__stopTimers();
});

test('Home の検索欄の候補を選ぶ: Enter は Home のまま置き換えた語で引き (他の源泉へ移らない)、Tab は語を置くだけ', async () => {
  const ctx = app({
    hitomi: {
      suggest: async () => [{ type: 'female', name: 'sample tag', label: '見本札', value: 'female:sample_tag' }],
    },
  });
  const { state, els } = ctx.__harness;
  state.source = 'home';
  state.scope = 'all';
  els.query.value = '見本 -札';
  await ctx.maybeSuggest();
  ctx.acceptSuggestion(state.suggestItems[0], true);
  assert.equal(state.source, 'home', 'Home に居たまま');
  assert.equal(state.query, '見本 -female:sample_tag');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ctx.calls.search.at(-1).source, 'home');
  assert.equal(ctx.calls.search.at(-1).query, '見本 -female:sample_tag');

  els.query.value = '札';
  await ctx.maybeSuggest();
  ctx.acceptSuggestion(state.suggestItems[0], false);
  assert.equal(state.source, 'home');
  assert.equal(els.query.value, 'female:sample_tag ');
  assert.equal(els.suggest.hidden, true);
  ctx.__stopTimers();
});
