'use strict';

// pixiv の画面 (src/renderer/app.js / downloads-ui.js / lan) の振る舞い。
// 押さえるのは設計 §10 / §15 で決めた「どこに何が出るか」:
//   札の旗は頁数の隣 (角に足さない)、横長の絵は中央で切る、ブックマーク操作なし、
//   タグを押すと裸語・作者は user:<番号>、AI を隠すは伏せ方の一つ、
//   pixiv の live 検索は 900 ms、帯の pixiv の三つ、保存の前に作者フォルダを訊く、
//   控え室は importing / asking の行を消さない、手のひら版の札は源泉を持つ。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadInVm } = require('./helpers/vm-dom');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

function app({ hitomi = {}, settings = {} } = {}) {
  const calls = { pixiv: [], download: [] };
  const api = {
    imageBase: async () => 'http://img.test',
    gallery: async (id) => ({ id, pageCount: 0 }),
    openEagle: (id) => id,
    annotate: async (list) => list,
    search: async () => ({ galleries: [], total: 0 }),
    settings: async () => settings,
    saveSettings: async (partial) => partial,
    cancelSearch: async () => true,
    readerActive() {},
    pixiv: async (payload) => { calls.pixiv.push(payload); return { ask: null }; },
    download: async (id, title) => { calls.download.push([id, title]); return { id }; },
    ...hitomi,
  };
  const ctx = loadInVm('src/renderer/app.js', { globals: { hitomi: api } });
  ctx.__harness.state.imageBase = 'http://img.test';
  ctx.__harness.state.settings = settings;
  ctx.calls = calls;
  return ctx;
}

const pixivCard = (over = {}) => ({
  id: 'px:100', source: 'pixiv', kind: 'gallery', title: '題', type: 'illust', pageCount: 3,
  artists: [{ type: 'artist', name: '作者', userId: '77' }], groups: [], series: null, characters: [],
  tags: [{ type: 'tag', name: 'タグ', label: 'tag' }], owned: false, ai: false, r18: false, bookmarked: false,
  shape: 'tall', url: 'https://www.pixiv.net/artworks/100', userId: '77', ...over,
});

test('タグを押すと裸語、作者は user:<番号> (名前空間を被せない)', () => {
  const ctx = app();
  const owner = pixivCard();
  assert.equal(ctx.tagQuery({ type: 'tag', name: 'ヤンデレ' }, owner), 'ヤンデレ');
  assert.equal(ctx.tagQuery({ type: 'artist', name: '作者', userId: '77' }, owner), 'user:77');
  assert.equal(ctx.tagQuery({ type: 'artist', name: '作者' }, { ...owner, userId: '' }), '作者', '番号が無ければ名前で');
  // 顔は作者の付けた語そのもの。翻訳は title に
  const html = ctx.tagButtons([{ type: 'tag', name: 'ヤンデレ', label: 'yandere' }], owner);
  assert.match(html, /data-query="ヤンデレ"/);
  assert.match(html, />ヤンデレ</);
  assert.match(html, /title="yandere — ヤンデレ"/);
  ctx.__stopTimers();
});

test('札: AI と源泉の旗は頁数の隣、横長は data-shape、候補へは ♥、うごイラに保存は出ない', () => {
  const ctx = app();
  const { state } = ctx.__harness;
  state.source = 'pixiv';
  const wide = ctx.cardMarkup(pixivCard({ ai: true, shape: 'wide' }));
  assert.match(wide, /class="card[^"]* ai"/, 'AI の札は class を持つ (伏せる鍵)');
  assert.match(wide, /data-shape="wide"/);
  assert.match(wide, /class="card-pages"> · AI</, '旗は頁数の隣');
  assert.doesNotMatch(wide, /ai-mark/, '角には足さない');
  assert.doesNotMatch(wide, /data-act="pixiv-bookmark"/, '追加・解除操作は出さない');
  assert.match(wide, /data-act="save"/, '保存は出る');
  const ugoira = ctx.cardMarkup(pixivCard({ badge: 'うごイラ', pageCount: 0, unbindable: true }));
  assert.doesNotMatch(ugoira, /data-act="save"/, 'うごイラは本にしないので保存が無い');
  assert.match(ugoira, /class="card-pages">うごイラ</);
  // 見ている源泉と違う時 (作者棚に pixiv の本) だけ pixiv の字
  state.source = 'pawchive';
  const owned = ctx.cardMarkup(pixivCard({ owned: true, kind: 'eagleItem', eagleId: 'E1', badge: '3p' }));
  assert.match(owned, /class="card-pages"> · pixiv</);
  assert.doesNotMatch(owned, /data-act="pixiv-bookmark"/, '所持の本に候補へは要らない');
  const bookmarked = ctx.cardMarkup(pixivCard({ bookmarked: true }));
  assert.doesNotMatch(bookmarked, /px-bm/);
  ctx.__stopTimers();
});

test('AI 生成を隠す: 設定が入っていれば AI の札は伏せられ、数にも入る', () => {
  const ctx = app({ settings: { pixivHideAi: true, hideOwnedMode: 'none' } });
  const { state } = ctx.__harness;
  state.galleries = [pixivCard({ ai: true }), pixivCard({ id: 'px:2', ai: false })];
  assert.equal(ctx.isCardHidden(state.galleries[0], 'none'), true);
  assert.equal(ctx.isCardHidden(state.galleries[1], 'none'), false);
  assert.equal(ctx.hiddenCardCount(), 1);
  ctx.__harness.state.settings = { pixivHideAi: false };
  assert.equal(ctx.isCardHidden(state.galleries[0], 'none'), false);
  assert.equal(ctx.hiddenCardCount(), 0);
  ctx.__stopTimers();
});

test('種別 AI の棚では AI を隠す設定より種別が勝つ (伏せると棚が空になる)', () => {
  const ctx = app({ settings: { pixivHideAi: true, hideOwnedMode: 'none' } });
  const { state } = ctx.__harness;
  state.source = 'pixiv';
  state.galleries = [pixivCard({ ai: true }), pixivCard({ id: 'px:2', ai: true })];
  for (const type of ['ai', 'ai-r18']) {
    state.type = type;
    assert.equal(ctx.isCardHidden(state.galleries[0], 'none'), false, type);
    assert.equal(ctx.hiddenCardCount(), 0, type);
  }
  // 種別を外せば設定どおり伏せる
  state.type = 'r18';
  assert.equal(ctx.isCardHidden(state.galleries[0], 'none'), true);
  assert.equal(ctx.hiddenCardCount(), 2);
  ctx.__stopTimers();
});

test('pixiv の打鍵ごとの引き直しは 900 ms (API の車線を食わない)', () => {
  const ctx = app();
  const { state } = ctx.__harness;
  state.scope = 'all';
  state.source = 'hitomi';
  assert.equal(ctx.liveDelay('abc'), 450);
  state.source = 'pixiv';
  assert.equal(ctx.liveDelay('abc'), 900);
  state.scope = 'library';
  assert.equal(ctx.liveDelay('abc'), 150, '所持は早いまま');
  ctx.__stopTimers();
});

test('帯: pixiv の冷却・Eagle 待ち・ログインし直し (残りは分の粒度)', () => {
  const ctx = app();
  const cool = ctx.noticeOf({ flags: { 'pixiv-cooldown': 1 }, pixivPausedForMs: 150000 });
  assert.equal(cool.key, 'pixiv-cooldown');
  assert.match(cool.text, /あと約 3 分/);
  const wait = ctx.noticeOf({ flags: { 'pixiv-import-wait': 1 }, pixivImportWaiting: 2 });
  assert.match(wait.text, /Eagle が起動していない.*2 件/);
  const relogin = ctx.noticeOf({ flags: { 'pixiv-relogin': 1 } });
  assert.match(relogin.text, /ログインし直し/);
  // 走査の失敗のような、直らないまま残る状態が pixiv より先 (帯は一つだけ)
  const scan = ctx.noticeOf({ flags: { 'pixiv-cooldown': 1 }, scanError: 'EACCES' });
  assert.equal(scan.key, 'scan');
  ctx.__stopTimers();
});

test('保存の前に作者フォルダを母屋に訊き、要らなければそのまま積む。うごイラは積まない', async () => {
  const ctx = app();
  const { state } = ctx.__harness;
  state.galleries = [pixivCard(), pixivCard({ id: 'px:200', unbindable: true, badge: 'うごイラ', pageCount: 0 })];
  await ctx.startDownload('px:100');
  assert.deepEqual(ctx.calls.pixiv.map((p) => p.action), ['ask-creator']);
  assert.deepEqual(ctx.calls.download, [['px:100', '題']]);
  await ctx.startDownload('px:200');
  assert.equal(ctx.calls.download.length, 1, 'うごイラは積まない');
  ctx.__stopTimers();
});

test('候補へ: 母屋に伝え、札の旗を書き換える', async () => {
  const ctx = app();
  const { state } = ctx.__harness;
  state.galleries = [pixivCard()];
  await ctx.togglePixivBookmark('px:100');
  // vm の中で作られた object は原型が別 realm。値だけ見る
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.calls.pixiv)), [{ action: 'bookmark', pid: 'px:100', on: true }]);
  assert.equal(state.galleries[0].bookmarked, true);
  await ctx.togglePixivBookmark('px:100');
  assert.equal(ctx.calls.pixiv[1].on, false);
  assert.equal(state.galleries[0].bookmarked, false);
  ctx.__stopTimers();
});

test('詳細: 頁数と旗、シリーズは字だけ、ブックマーク操作なし', () => {
  const ctx = app();
  const { state, els } = ctx.__harness;
  const gallery = pixivCard({ ai: true, r18: true, series: { id: '5', title: '連作' } });
  state.galleries = [gallery];
  ctx.renderDetail(gallery);
  const html = String(els.detailBody.innerHTML);
  assert.match(html, /class="kicker">pixiv · AI · R-18</);
  assert.match(html, /連作/);
  assert.doesNotMatch(html, /data-bookmark=/);
  assert.doesNotMatch(html, /data-query="[^"]*連作/, 'シリーズは押せない (抜けは数えない)');
  ctx.__stopTimers();
});

test('作者の札 (pxu:) を押すと user:<番号> の一覧へ', () => {
  const ctx = app();
  const { state } = ctx.__harness;
  state.source = 'pixiv';
  state.scope = 'all';
  assert.equal(ctx.openCreator('pxu:77'), true);
  assert.equal(state.query, 'user:77');
  ctx.__stopTimers();
});

test('一括の釦は 作者の投稿一覧 と 候補 の時だけ (pawchive の釦と指定席を共にする)', () => {
  const ctx = app();
  const { state } = ctx.__harness;
  state.source = 'pixiv';
  state.scope = 'all';
  state.sort = 'follow';
  state.query = '';
  assert.equal(ctx.pawBulkVisible(), false);
  state.sort = 'bookmarks';
  assert.equal(ctx.pawBulkVisible(), true);
  assert.equal(ctx.pixivBulkKind(), 'bookmarks');
  state.sort = 'follow';
  state.query = 'user:77';
  assert.equal(ctx.pixivBulkKind(), 'user');
  assert.equal(ctx.pixivBulkUserId(), '77');
  state.scope = 'library';
  assert.equal(ctx.pawBulkVisible(), false, '所持棚では出さない');
  ctx.__stopTimers();
});

test('控え室: importing と asking の行は消えず、数え上げにも入る (文字列の釘)', () => {
  const ui = read('src/renderer/downloads-ui.js');
  const rank = ui.match(/const RANK = \{([\s\S]*?)\};/);
  assert.ok(rank, 'RANK が見つからない');
  for (const status of ['importing', 'asking']) {
    assert.match(rank[1], new RegExp(`${status}:`), `RANK に ${status}`);
    assert.match(ui, new RegExp(`ACTIVE = new Set\\(\\[[^\\]]*'${status}'`), `ACTIVE に ${status}`);
    assert.match(ui, new RegExp(`${status}: '`), `札名に ${status}`);
  }
  assert.match(ui, /data-answer="same"/, '「同じ人」の釦');
  assert.match(ui, /data-answer="other"/, '「別の人」の釦');
  assert.match(read('src/renderer/app.js'), /closest\('\[data-answer\]'\)/, 'app.js が答えを届ける');
});

test('手のひら版: 札は源泉を持ち、紙の facts に pixiv の一行が出る (文字列の釘)', () => {
  const lan = read('src/lib/lan-server.js');
  assert.match(lan, /source: item\.source \|\| 'pawchive'/, 'paw の札');
  assert.match(lan, /source: gallery\.source \|\| 'hitomi'/, '台帳の札');
  assert.match(read('src/lan/shelf.js'), /item\.source === 'pixiv'/, '紙の一行');
});

test('語を打つと並びの select はフォローから新しい順に倒れ、語を消しても新着表示を維持する (覚えには書かない)', async () => {
  const saved = [];
  const ctx = app({ hitomi: { saveSettings: async (partial) => { saved.push(JSON.parse(JSON.stringify(partial))); return partial; } } });
  const { state, els } = ctx.__harness;
  state.source = 'pixiv';
  state.scope = 'all';
  state.sort = 'follow';
  state.query = 'ヤンデレ';
  await ctx.runSearch({ reset: true });
  assert.equal(state.sort, 'added', '語 + フォロー → 新しい順');
  assert.match(els.sort.innerHTML, /value="added" selected/, 'select も倒れる');
  assert.ok(!saved.some((p) => p.sortBySource), '自動の倒しは覚えない');
  state.query = 'user:77';
  await ctx.runSearch({ reset: true });
  assert.equal(state.sort, 'added', '作者指定でも作品検索を維持');
  state.query = 'https://www.pixiv.net/artworks/123456';
  await ctx.runSearch({ reset: true });
  assert.equal(state.sort, 'added', 'URL でも作品検索を維持');
  state.query = '';
  await ctx.runSearch({ reset: true });
  assert.equal(state.sort, 'added', '空欄は新着を表示しフォローへ戻らない');
  state.query = '"ブルアカ"';
  await ctx.runSearch({ reset: true });
  assert.equal(state.sort, 'added', '引用の語も語');
  ctx.__stopTimers();
});

test('発見 (pixiv): おすすめの作者は行に、投稿 3 枚と並ぶ。作者の札にフォローの釦。未ログインは案内', async () => {
  const creator = {
    id: 'pxu:501', source: 'pixiv', kind: 'creator', title: '甲', artists: [{ type: 'artist', name: '甲', userId: '501' }],
    tags: [], userId: '501', following: false, url: 'https://www.pixiv.net/users/501', badge: '',
  };
  const ctx = app({ hitomi: { pixiv: async (payload) => {
    if (payload.action !== 'discover') return { ask: null };
    return {
      users: [{ creator, illusts: [pixivCard({ id: 'px:7000' }), pixivCard({ id: 'px:7001' })] }],
      illusts: [pixivCard({ id: 'px:8000' })],
    };
  } } });
  const { state, els } = ctx.__harness;
  state.source = 'pixiv';
  await ctx.enterDiscovery();
  const html = els.grid.innerHTML;
  assert.match(html, /class="pixiv-author-shelf"/, '作者一人ぶんの行');
  assert.match(html, /おすすめの作者/);
  assert.match(html, /おすすめの作品/);
  assert.match(html, /data-follow="pxu:501"/, 'フォローの釦');
  assert.doesNotMatch(html, /card-pages">0p/, '作者の札に 0p は出ない');
  assert.equal(state.galleries.length, 4, '作者も投稿も state に (詳細・保存・♥ が引ける)');
  assert.match(ctx.renderTypes.toString(), /おすすめの作者と投稿/, '発見の札の説明も pixiv 用');
  ctx.__stopTimers();

  const gone = app({ hitomi: { pixiv: async () => { throw new Error("Error invoking remote method 'pixiv': Error: pixiv にログインしていません (設定 → 取り込み → pixiv)"); } } });
  gone.__harness.state.source = 'pixiv';
  await gone.enterDiscovery();
  assert.match(gone.__harness.els.grid.innerHTML, /ログインすると/, '未ログインは案内');
  assert.equal(gone.__harness.els.status.classList.contains('error'), false, '赤にしない');
  gone.__stopTimers();
});

test('フォロー: 母屋に伝え、札と詳細の旗を書き換える', async () => {
  const ctx = app();
  const { state } = ctx.__harness;
  state.source = 'pixiv';
  const creator = {
    id: 'pxu:501', source: 'pixiv', kind: 'creator', title: '甲', artists: [{ type: 'artist', name: '甲', userId: '501' }],
    tags: [], userId: '501', following: false, badge: '',
  };
  state.galleries = [creator];
  await ctx.togglePixivFollow('pxu:501');
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.calls.pixiv)), [{ action: 'follow', userId: '501', on: true }]);
  assert.equal(creator.following, true);
  const card = ctx.cardMarkup(creator);
  assert.match(card, /px-follow is-on/);
  assert.match(card, /フォロー中/);
  assert.doesNotMatch(card, /card-pages">0p/);
  ctx.__stopTimers();
});

test('設定: 原寸で読む (pixiv) の行がある (既定は入 = 原寸。切ると 1200 px)', () => {
  assert.match(read('src/renderer/index.html'), /id="set-pixiv-read-original"/);
  assert.match(read('src/lib/config.js'), /pixivReadOriginal: true/);
  assert.match(read('src/lib/pixiv/index.js'), /readOriginal: current\.pixivReadOriginal !== false/, '母屋の既定も原寸');
  assert.match(read('src/lib/sources/index.js'), /effectiveSize\(parsed\.source, options\)/, '読み手の大きさは控えの鍵にも効く');
});

test('pixiv captions start expanded; related works are inline and cross-site controls are absent', () => {
  const ctx=app();
  const html=ctx.detailExtras(pixivCard({caption:'<img src=x onerror=bad()>'}));
  assert.match(html,/&lt;img/); assert.doesNotMatch(html,/<img/);
  assert.match(html,/open>/); assert.doesNotMatch(html,/data-cross-source|data-pixiv-related/);
  assert.match(ctx.detailRelatedMarkup(pixivCard()),/pixiv-related-list/);
  ctx.__stopTimers();
});
test('pixiv defaults to all dates and retains the chosen period through tabs and history', async () => {
  const requests=[];
  const ctx=app({hitomi:{search:async p=>{requests.push(p);return {galleries:[],total:0,hasNext:false};}}});
  const {state}=ctx.__harness;
  ctx.renderGrid=()=>{};
  state.source='pixiv';state.scope='all';state.sort='follow';state.query='風景';
  assert.equal(ctx.hideOwnedMode(),'none');
  await ctx.runSearch({reset:true});
  assert.equal(requests.at(-1).pixivPeriod,'year');
  state.pixivPeriod='month';state.sort='year';
  await ctx.runSearch({reset:true});
  assert.equal(requests.at(-1).pixivPeriod,'month');
  assert.equal(ctx.sessionPayload().pixivPeriod,'month');
  ctx.pushHistory();
  state.pixivPeriod='today';
  await ctx.runSearch({reset:true});
  ctx.pushHistory();
  await ctx.applyHistoryEntry({source:'pixiv',scope:'all',query:'風景',sort:'year',type:'',language:'',pixivPeriod:'month'});
  assert.equal(state.pixivPeriod,'month');
  await ctx.switchPixivTab('ranking');
  await ctx.switchPixivTab('search');
  assert.equal(state.pixivPeriod,'month');
  const all={source:'pixiv',query:'風景',sort:'year',pixivPeriod:'year'};
  assert.notEqual(ctx.historyKey(all),ctx.historyKey({...all,pixivPeriod:'month'}));
  ctx.__stopTimers();
});

test('pixiv searching always selects work search, switching tabs retains the completed result', async () => {
  const requests=[];
  const ctx=app({hitomi:{search:async p=>{requests.push(p);return {galleries:[pixivCard({id:'px:999',title:p.query||p.sort})],total:1,hasNext:false};}}});
  const {state,els}=ctx.__harness;
  ctx.renderGrid=()=>{};
  state.source='pixiv';state.scope='all';state.sort='bookmarks';state.pixivTab='bookmarks';state.query='user:77';
  await ctx.runSearch({reset:true});
  assert.equal(ctx.pixivViewKey(),'search'); assert.equal(state.sort,'added');
  const count=requests.length;
  await ctx.switchPixivTab('ranking');
  assert.equal(state.query,'');assert.equal(ctx.pixivViewKey(),'ranking');assert.equal(state.galleries[0].title,'today');
  await ctx.switchPixivTab('search');
  assert.equal(state.query,'user:77');assert.equal(els.query.value,'user:77');assert.equal(state.galleries[0].title,'user:77');
  assert.equal(requests.length,count+1,'returning to search reuses its result');
  ctx.__stopTimers();
});

test('artist tags carry the known author name through ordinary source switching', () => {
  const {portQuery}=require('../src/lib/sources/query-port');
  const ctx=app({hitomi:{portQuery}});
  const {state,els}=ctx.__harness;
  state.query=ctx.tagQuery({type:'artist',name:'A B',userId:'77'},pixivCard());
  ctx.portQueryInto('pixiv','hitomi');
  assert.equal(state.query,'artist:a_b');assert.equal(els.query.value,'artist:a_b');
  assert.equal(portQuery('user:99','pixiv','hitomi').query,'','unknown IDs must not become unrelated Hitomi IDs');
  ctx.__stopTimers();
});

test('late related responses cannot overwrite a replaced detail panel', async () => {
  let resolve;
  const ctx=app({hitomi:{pixiv:()=>new Promise(r=>{resolve=r;})}});
  const list={isConnected:true,innerHTML:'loading'};
  const pending=ctx.loadDetailRelated(pixivCard(),{querySelector:()=>list});
  list.isConnected=false;resolve([pixivCard({id:'px:200'})]);await pending;
  assert.equal(list.innerHTML,'loading');ctx.__stopTimers();
});
test('late search response is discarded after changing pixiv tabs', async () => {
  let resolve;
  const ctx=app({hitomi:{search:p=>p.query?new Promise(r=>{resolve=r;}):Promise.resolve({galleries:[],total:0,hasNext:false})}});
  ctx.renderGrid=()=>{};
  const {state}=ctx.__harness;state.source='pixiv';state.scope='all';state.sort='added';state.query='pending';
  const pending=ctx.runSearch({reset:true});
  await ctx.switchPixivTab('ranking');
  resolve({galleries:[pixivCard()],total:1,hasNext:false});await pending;
  assert.equal(ctx.pixivViewKey(),'ranking');assert.equal(state.query,'');assert.equal(state.galleries.length,0);
  ctx.__stopTimers();
});

test('caption work references become safe internal links and numeric entities are decoded', () => {
  const ctx=app();const html=ctx.captionMarkup('次回 illust/149809649&#x20;\n前回 illust/149665309 &amp;#x20; <script>bad()</script>');
  assert.match(html,/data-caption-work="px:149809649"/);assert.match(html,/data-caption-work="px:149665309"/);
  assert.doesNotMatch(html,/&#x20;|<script>/);assert.match(html,/&lt;script&gt;/);
  assert.match(ctx.detailRelatedMarkup(pixivCard()),/<details[^>]+open>/);
  ctx.__stopTimers();
});
test('source switch clears pixiv results even when Hitomi search fails', async () => {
  const ctx=app({hitomi:{portQuery:require('../src/lib/sources/query-port').portQuery,search:async()=>{throw new Error('503');}}});
  const {state,els}=ctx.__harness;state.source='pixiv';state.scope='all';state.sort='added';state.query='';state.galleries=[pixivCard()];
  ctx.bindSearchControls();els.source.value='hitomi';els.source.__listeners.get('change').forEach(fn=>fn({}));
  assert.equal(state.galleries.length,0);await new Promise(r=>setImmediate(r));assert.equal(state.galleries.length,0);
  ctx.__stopTimers();
});

test('ordinary caption links are safe and distinct from pixiv work references', () => {
  const ctx=app();const html=ctx.captionMarkup('https://www.patreon.com/masehumi illust/12345 javascript:alert(1) https://user:password@example.com/');
  assert.match(html,/data-caption-url="https:\/\/www.patreon.com\/masehumi"/);
  assert.match(html,/data-caption-work="px:12345"/);
  assert.doesNotMatch(html,/data-caption-url="(?:javascript|https:\/\/user)/);
  ctx.__stopTimers();
});
test('related works can open directly in the reader without changing detail selection', async () => {
  const work=pixivCard({id:'px:200'});const ctx=app({hitomi:{pixiv:async()=>[work]}});
  require('node:vm').runInContext('Reader.open=async g=>{globalThis.openedRelated=g;}',ctx);
  await ctx.loadDetailRelated(pixivCard(),{querySelector:()=>({isConnected:true,innerHTML:''})});
  await ctx.readRelatedWork('px:200');assert.equal(ctx.openedRelated.id,'px:200');ctx.__stopTimers();
});
test('caption external opener accepts only credential-free web URLs', () => {
  const {captionWebUrl}=require('../src/lib/caption-link');
  assert.equal(captionWebUrl('https://www.patreon.com/masehumi'),'https://www.patreon.com/masehumi');
  for(const url of ['javascript:alert(1)','file:///C:/private','https://user:pass@example.com/','https://example.com/\n'])assert.throws(()=>captionWebUrl(url));
});


test('site switching clears type restrictions and restores author ID on roundtrip', () => {
  const ctx=app({hitomi:{portQuery:require('../src/lib/sources/query-port').portQuery}});
  const {state}=ctx.__harness;
  state.query=ctx.tagQuery({type:'artist',name:'作者',userId:'77'},pixivCard());
  state.type='doujinshi'; state.excludedTypes=['manga'];
  ctx.portQueryInto('pixiv','hitomi');
  assert.equal(state.type,''); assert.equal(state.excludedTypes.length,0);
  ctx.portQueryInto('hitomi','pawchive');
  ctx.portQueryInto('pawchive','nhentai');
  ctx.portQueryInto('nhentai','pixiv');
  assert.equal(state.query,'user:77');
  state.query='new word';ctx.portQueryInto('pixiv','hitomi');
  assert.equal(state.query,'new word','edited query starts a new journey');
  state.query='';state.type='doujinshi';ctx.portQueryInto('hitomi','pixiv');
  assert.equal(state.type,'');
  ctx.__stopTimers();
});

test('Hitomi author display label is used to search pixiv candidates', () => {
  const ctx=app({hitomi:{portQuery:require('../src/lib/sources/query-port').portQuery}});
  const {state}=ctx.__harness;
  state.query=ctx.tagQuery({type:'artist',name:'sample',label:'見本作者'},{source:'hitomi'});
  ctx.portQueryInto('hitomi','pixiv');assert.equal(state.query,'artist:見本作者');
  ctx.portQueryInto('pixiv','hitomi');assert.equal(state.query,'artist:sample');
  ctx.__stopTimers();
});


test('pixiv author header stays first under reverse sorting and has a round avatar row', () => {
  const ctx=app({settings:{sortDir:'asc'}});const {state}=ctx.__harness;
  state.source='pixiv';state.query='user:77';
  const creator={id:'pxu:77',source:'pixiv',kind:'creator',title:'作者',userId:'77',pinnedCreator:true,previewId:'px:1'};
  state.galleries=[creator,pixivCard({id:'px:1'}),pixivCard({id:'px:2'})];
  const items=ctx.visibleGridItems();
  assert.equal(items[0],creator);assert.equal(items[1].id,'px:2');
  const html=ctx.cardMarkup(creator);assert.match(html,/pixiv-avatar/);assert.match(html,/data-follow="pxu:77"/);assert.match(html,/pixiv-pinned-creator/);
  ctx.__stopTimers();
});


test('editing to the same text discards old cross-site identity', () => {
  const ctx=app({hitomi:{portQuery:require('../src/lib/sources/query-port').portQuery}});
  const {state,els}=ctx.__harness;
  state.query=ctx.tagQuery({type:'artist',name:'Author',userId:'77'},pixivCard());
  ctx.portQueryInto('pixiv','hitomi');
  ctx.bindQueryClear();els.query.value=state.query;
  els.query.__listeners.get('input').forEach(fn=>fn({isComposing:true}));
  ctx.portQueryInto('hitomi','pixiv');assert.equal(state.query,'artist:author');
  ctx.__stopTimers();
});

test('source roundtrip restores cached results and confirmed context translates IDs', async () => {
  const queries=[];
  const ctx=app({hitomi:{portQuery:require('../src/lib/sources/query-port').portQuery,
    searchAuthorContext:async()=>({links:{'pixiv:user:77':{pawchive:'patreon/88'}}}),
    search:async p=>{queries.push(p.query);return {galleries:[{...pixivCard(),source:p.source}],total:1,hasNext:false};}}});
  ctx.renderGrid=()=>{};
  const {state,els}=ctx.__harness;state.source='pixiv';state.scope='all';state.query='user:77';state.sort='added';state.type='';state.galleries=[pixivCard({id:'px:original'})];state.done=true;
  ctx.bindSearchControls();
  const change=async source=>{els.source.value=source;await Promise.all(els.source.__listeners.get('change').map(fn=>fn({})));};
  await change('pawchive');assert.equal(state.query,'patreon/88');
  await change('pixiv');assert.equal(state.query,'user:77');assert.equal(state.galleries[0].id,'px:original');
  assert.equal(queries.length,1,'returning uses its saved results');ctx.__stopTimers();
});


test('late identity lookup cannot restore a query edited while switching sites', async () => {
  let resolve;
  const ctx=app({hitomi:{portQuery:require('../src/lib/sources/query-port').portQuery,searchAuthorContext:()=>new Promise(r=>{resolve=r;})}});
  const {state,els}=ctx.__harness;state.source='pixiv';state.query='user:77';state.scope='all';state.sort='added';
  ctx.bindSearchControls();ctx.bindQueryClear();els.source.value='pawchive';
  const pending=Promise.all(els.source.__listeners.get('change').map(fn=>fn({})));
  els.query.value='new word';state.query='new word';els.query.__listeners.get('input').forEach(fn=>fn({isComposing:true}));
  resolve({links:{'pixiv:user:77':{pawchive:'fanbox/88'}}});await pending;
  assert.equal(state.query,'new word');ctx.__stopTimers();
});

 test('suggestions selected with keyboard, click or Tab retain metadata and do not erase multiword input', async()=>{
  const engine=require('../src/lib/search-intent');
  for (const mode of ['Enter','Tab','click']) {
    const queries=[];
    const ctx=app({hitomi:{completionRanges:engine.completionRanges,portQuery:require('../src/lib/sources/query-port').portQuery,
      suggest:async()=>engine.normalizeSuggestions([{type:'artist',name:'Example Name',value:'fanbox/987'}],'pawchive'),
      search:async p=>{queries.push(p.query);return {galleries:[],total:0};}}});
    const {state,els}=ctx.__harness;state.source='pawchive';state.scope='all';state.sort='added';els.query.value='example name';
    ctx.bindSuggest();await ctx.maybeSuggest();
    assert.equal(state.suggestItems[0]._range.start,0);
    if(mode==='click') els.suggest.__listeners.get('click')[0]({target:{closest:()=>({dataset:{value:'fanbox/987'}})}});
    else { const key=key=>els.query.__listeners.get('keydown').forEach(fn=>fn({key,preventDefault(){}}));key('ArrowDown');key(mode); }
    assert.equal(els.query.value.trim(),'fanbox/987');
    if(mode==='Tab') state.query=els.query.value.trim();
    ctx.portQueryInto('pawchive','hitomi');assert.equal(state.query,'artist:example_name');
    if(mode!=='Tab') assert.equal(queries[0],'fanbox/987');
    ctx.__stopTimers();
  }
});

test('old suggestion response cannot overwrite an edited prefix or reopen a dismissed menu',async()=>{
  let resolve;
  const ctx=app({hitomi:{suggest:()=>new Promise(r=>{resolve=r;})}}),{state,els}=ctx.__harness;
  els.query.value='first common';const pending=ctx.maybeSuggest();els.query.value='second common';
  resolve([{name:'x',value:'tag:x'}]);await pending;assert.equal(state.suggestItems.length,0);
  const second=ctx.maybeSuggest();ctx.hideSuggest();resolve([{name:'x',value:'tag:x'}]);await second;assert.equal(els.suggest.hidden,true);ctx.__stopTimers();
});

test('cancelled source lookup releases loading even when IME prevents a new live request',async()=>{
  let resolve;const ctx=app({hitomi:{portQuery:require('../src/lib/sources/query-port').portQuery,searchAuthorContext:()=>new Promise(r=>{resolve=r;})}});
  const {state,els}=ctx.__harness;state.source='pixiv';state.query='user:77';state.scope='all';state.sort='added';
  ctx.bindSearchControls();ctx.bindQueryClear();els.source.value='pawchive';
  const pending=Promise.all(els.source.__listeners.get('change').map(fn=>fn({})));
  els.query.value='x';els.query.__listeners.get('input').forEach(fn=>fn({isComposing:true}));
  resolve({});await pending;assert.equal(state.loading,false);assert.match(els.status.textContent,/検索/);ctx.__stopTimers();
});

 test('all sources place multiple-page counts on the cover, never in author metadata', () => {
 const ctx=app();
 for(const source of ['hitomi','nhentai','pawchive','pixiv','ehentai']){
  for(const pageCount of [0,1,2,315]){
   const gallery=pixivCard({source,pageCount,badge:pageCount+'p'});
   const html=ctx.cardMarkup(gallery);
   assert.equal(html.includes('class="page-count-badge"'),pageCount>1,source+': '+pageCount);
   assert.doesNotMatch(html, /class="card-pages">\d+p/);
   if(pageCount>1)assert.ok(html.indexOf('page-count-badge')<html.indexOf('card-body'));
  }
 }
 assert.equal(ctx.pageCountBadge(pixivCard({kind:'creator'})),'');
 assert.equal(ctx.pageCountBadge(pixivCard({pageCount:NaN})), '');
 ctx.__stopTimers();
 });
