'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function element() {
  const listeners = new Map();
  return {
    hidden: true,
    innerHTML: '',
    textContent: '',
    dataset: {},
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener(type, fn) {
      const list = listeners.get(type) || [];
      list.push(fn);
      listeners.set(type, list);
    },
    removeAttribute() {},
    setAttribute() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 1, height: 1 }; },
    children: [],
    appendChild(child) { this.children.push(child); return child; },
    remove() {},
    __listeners: listeners,
  };
}

function loadReader(fetchImpl, extra = {}) {
  const nodes = new Proxy({}, { get(target, key) { return target[key] ||= element(); } });
  const slots = [element(), element()];
  const statuses = [element(), element()];
  slots.forEach((slot, index) => { slot.querySelector = () => statuses[index]; });
  nodes.readerImage.closest = () => slots[0];
  nodes.readerImage2.closest = () => slots[1];
  const opened = [];
  const context = {
    console: { warn() {} },
    AbortController,
    Blob,
    Uint8Array,
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    fetch: fetchImpl,
    setTimeout,
    clearTimeout,
    state: { reader: null, imageBase: 'http://example.test', settings: {} },
    els: nodes,
    document: {
      body: element(),
      activeElement: null,
      getElementById: () => element(),
      createElement: () => element(),
    },
    window: { hitomi: { readerActive() {}, openEagle(id) { opened.push(id); } } },
    localStorage: { getItem: () => '1', setItem() {} },
    Image: function Image() { return element(); },
    clamp: (value, min, max) => Math.max(min, Math.min(max, value)),
    sameId: (a, b) => String(a) === String(b),
    imgUrl: (id, page) => `http://example.test/${id}/${page}`,
    isEagleItem: () => false,
    dropRedoUnlessRestoring() {},
    ICON: new Proxy({}, { get: () => '' }),
    ...extra,
  };
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'reader.js'), 'utf8');
  vm.runInContext(`${source}\nglobalThis.__reader = Reader;`, context);
  return { Reader: context.__reader, state: context.state, els: nodes, slots, statuses, opened };
}

test('ローカル原本の準備中から表示され、閉じると古い失敗は fallback しない', async () => {
  const request = deferred();
  const app = loadReader(() => request.promise);
  app.Reader.open({ id: 'old', source: 'pawchive', eagleId: 'e-old', title: 'old', pageCount: 0 });

  assert.equal(app.Reader.isOpen(), true);
  assert.equal(app.els.reader.hidden, false);
  assert.match(app.els.readerLoading.innerHTML, /キャンセル/);

  app.Reader.close();
  assert.equal(app.Reader.isOpen(), false);
  assert.equal(app.els.reader.hidden, true);
  request.reject(new Error('late HEAD failure'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(app.opened, []);
});

test('古い openLocal の失敗が新しい準備中作品を上書きしない', async () => {
  const oldRequest = deferred();
  const newRequest = deferred();
  let calls = 0;
  const app = loadReader(() => (++calls === 1 ? oldRequest.promise : newRequest.promise));
  app.Reader.open({ id: 'old', source: 'pawchive', eagleId: 'e-old', title: 'old', pageCount: 0 });
  app.Reader.open({ id: 'new', source: 'pawchive', eagleId: 'e-new', title: 'new', pageCount: 0 });

  oldRequest.reject(new Error('late old failure'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.els.readerTitle.textContent, 'new');
  assert.equal(app.Reader.isOpen(), true);
  assert.deepEqual(app.opened, []);

  app.Reader.close();
  newRequest.reject(new Error('late new failure'));
  await new Promise((resolve) => setImmediate(resolve));
});

test('見開きの片側失敗は反対側のload後も残り、再試行は失敗頁だけを更新する', () => {
  const app = loadReader(() => Promise.reject(new Error('unused')));
  app.state.readerSpread = true;
  app.state.readerRtl = false;
  app.state.readerFit = 'contain';
  app.Reader.open({ id: 'book', source: 'hitomi', title: 'book', pageCount: 2 }, 1);

  assert.match(app.statuses[0].textContent, /読み込み中/);
  assert.match(app.statuses[1].textContent, /読み込み中/);
  app.els.readerImage2.onerror();
  assert.match(app.statuses[1].innerHTML, /data-reader-retry="1"/);
  app.els.readerImage.onload();
  assert.match(app.statuses[1].innerHTML, /画像を読めませんでした/);

  app.Reader.bind();
  const retryTarget = {
    dataset: { readerRetry: '1' },
    closest: () => retryTarget,
  };
  const event = {
    target: retryTarget,
    preventDefault() {},
    stopImmediatePropagation() {},
  };
  const captureHandler = app.els.readerPages.__listeners.get('click')[1];
  captureHandler(event);
  assert.match(app.statuses[1].textContent, /読み込み中/);
  assert.equal(app.statuses[0].textContent, '');
  assert.equal(app.els.readerImage.dataset.page, '0');
  assert.equal(app.els.readerImage2.dataset.page, '1');
});

// ---- 所持の本の頁の URL -------------------------------------------------
// 網の版と同じ URL で読むと、所持になる前に網から読んだ軽い絵がブラウザの控えから出続ける

test('所持の本の頁は own=1 の付いた別の URL で頼む (網の版の控えを掴まない)', () => {
  const app = loadReader(() => Promise.reject(new Error('unused')));
  app.state.readerSpread = false;
  app.state.readerRtl = false;
  app.state.readerFit = 'contain';
  app.Reader.open({ id: 'px:1', source: 'pixiv', title: 'net', pageCount: 3 });
  assert.match(String(app.els.readerImage.src), /&read=1&rs=o$/, '網の pixiv は原寸 (既定)');
  app.Reader.close();
  app.state.settings.pixivReadOriginal = false;
  app.Reader.open({ id: 'px:1', source: 'pixiv', title: 'net', pageCount: 3 });
  assert.match(String(app.els.readerImage.src), /&read=1&rs=r$/, '1200 px の設定なら別の URL');
  app.Reader.close();
  app.Reader.open({ id: 'px:1', source: 'pixiv', title: 'own', pageCount: 3, owned: true, eagleId: 'E1' });
  assert.match(String(app.els.readerImage.src), /&read=1&own=1$/, '所持の本は own=1');
  app.Reader.close();
  app.Reader.open({ id: '99', source: 'hitomi', title: 'h', pageCount: 3 });
  assert.match(String(app.els.readerImage.src), /&read=1$/, 'hitomi の網の本は今までどおり');
  app.Reader.close();
});

// ---- ダブルクリックの原寸 ------------------------------------------------
// 頁は窓に合わせて縮めて出している。pixiv の原寸 (3000 px) のような大きい絵は、
// ダブルクリックで 1 画素 = 1 画素に。窓より小さい絵は従来どおり 2 倍

test('ダブルクリックは原寸 (1 画素 = 1 画素)。窓より小さい絵は従来の 2 倍', () => {
  const app = loadReader(() => Promise.reject(new Error('unused')));
  app.state.readerSpread = false;
  app.state.readerRtl = false;
  app.state.readerFit = 'contain';
  app.Reader.open({ id: 'book', source: 'pixiv', title: 'book', pageCount: 3 });
  app.Reader.bind();
  const img = app.els.readerImage;
  img.hidden = false;
  img.naturalHeight = 3000;
  img.getBoundingClientRect = () => ({ left: 0, top: 0, width: 866, height: 1300 });
  app.els.readerStage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1600, height: 1300 });
  const dbl = app.els.readerPages.__listeners.get('dblclick')[0];
  dbl({ clientX: 400, clientY: 600 });
  const transform = String(app.els.readerPages.style.transform);
  assert.match(transform, /scale\(2\.30\d*\)/, `原寸は 3000 / 1300 ≈ 2.31 倍 (${transform})`);
  dbl({ clientX: 400, clientY: 600 });
  assert.equal(app.els.readerPages.style.transform, '', '二度目は戻す');
  img.naturalHeight = 900;
  dbl({ clientX: 400, clientY: 600 });
  assert.match(String(app.els.readerPages.style.transform), /scale\(2\)/, '窓より小さい絵は 2 倍');
});

// ---- ホイールの頁送り ---------------------------------------------------
// 時間で間引くと、刻みの深いマウスを速く回した時に目盛りが落ちて引っかかる。
// 量で数えるので、目盛りは何本回しても落ちない

function wheelRig(fit = 'contain') {
  let clock = 10000;
  const app = loadReader(() => Promise.reject(new Error('unused')), {
    Date: { now: () => clock },
    escapeHtml: value => String(value),
  });
  app.state.readerSpread = false;
  app.state.readerRtl = false;
  app.state.readerFit = fit;
  app.Reader.open({ id: 'book', source: 'hitomi', title: 'book', pageCount: 40 });
  return {
    app,
    page: () => app.state.reader.page,
    // deltaMode 0 = 画素。刻みの深いマウスの一目盛りがおよそ 100
    spin(delta, gap = 0, mode = 0) {
      clock += gap;
      app.Reader.handleWheel({
        deltaY: delta, deltaMode: mode, ctrlKey: false, preventDefault() {},
      });
    },
    wait(ms) { clock += ms; },
  };
}

test('速く回した目盛りは一つも落ちない (時間での間引きをやめた)', () => {
  const rig = wheelRig();
  rig.spin(100);
  rig.spin(100, 50);
  rig.spin(100, 50);
  assert.equal(rig.page(), 3);
});

test('束で届くほど速く回しても、最後の一目盛りが行き場を失わない', () => {
  const rig = wheelRig();
  rig.spin(100);
  rig.spin(100, 20);
  assert.equal(rig.page(), 2);
});

test('刻みの細かいホイールは溜まって初めて一組送る', () => {
  const rig = wheelRig();
  for (let i = 0; i < 10; i += 1) rig.spin(10, 10);
  assert.equal(rig.page(), 1);
});

test('一目盛りが 1 行 (33) の設定でも、一目盛りで一組送る', () => {
  const rig = wheelRig();
  rig.spin(33);
  rig.spin(33, 60);
  rig.spin(33, 60);
  assert.equal(rig.page(), 3);
});

test('溜めきらないうちに向きが変われば、どちらへも送らない', () => {
  const rig = wheelRig();
  rig.spin(100);
  rig.spin(100, 60);
  assert.equal(rig.page(), 2);
  rig.spin(15, 60);
  rig.spin(-15, 10);
  rig.spin(-10, 10);
  assert.equal(rig.page(), 2);
});

test('間が空いた溜めは繰り越さない', () => {
  const rig = wheelRig();
  rig.spin(20);
  rig.spin(20, 300);
  assert.equal(rig.page(), 0);
});

test('一度の wheel で送るのは一組まで', () => {
  const rig = wheelRig();
  rig.spin(1200);
  assert.equal(rig.page(), 1);
});

test('行・画面単位で寄越すホイールも一目盛りで一組送る', () => {
  const lines = wheelRig();
  lines.spin(3, 0, 1);
  assert.equal(lines.page(), 1);
  const pages = wheelRig();
  pages.spin(1, 0, 2);
  assert.equal(pages.page(), 1);
});

test('横倒し (deltaY 0) では頁が動かない', () => {
  const rig = wheelRig();
  rig.spin(0);
  rig.spin(0, 10);
  assert.equal(rig.page(), 0);
});

test('横フィットは流している間は溜めず、端でもう一押しして送る', () => {
  const rig = wheelRig('width');
  const stage = rig.app.els.readerStage;
  stage.scrollTop = 0;
  stage.clientHeight = 800;
  stage.scrollHeight = 2400;
  // 本文の途中: いくら回しても頁は動かない (素の縦スクロールに任せる)
  for (let i = 0; i < 5; i += 1) rig.spin(100, 50);
  assert.equal(rig.page(), 0);
  // 底に着いた。着いた勢いの一押しでは送らず、もう一押しで送る
  stage.scrollTop = 1600;
  rig.spin(40, 50);
  assert.equal(rig.page(), 0);
  rig.spin(100, 50);
  assert.equal(rig.page(), 1);
});

// ---- 作品の継ぎ目 --------------------------------------------------------
// 最終頁の先へ送ったら隣の作品へ渡るのは常に。設定 (readerNextCard) が決めるのは、
// 渡る前に隣の顔 (札) を一度挟むかどうかだけ。既定は挟まず直に開く

function boundaryRig(settings) {
  // showBoundary は app.js の escapeHtml (画面全体の共有) を引く
  const app = loadReader(() => Promise.reject(new Error('unused')), { escapeHtml: (t) => String(t) });
  app.state.readerSpread = false;
  app.state.readerRtl = false;
  app.state.readerFit = 'contain';
  Object.assign(app.state.settings, settings);
  app.Reader.setNeighborProvider((id, delta) => {
    if (String(id) === '1' && delta > 0) return { id: '2', source: 'hitomi', title: 'b', pageCount: 3 };
    if (String(id) === '2' && delta < 0) return { id: '1', source: 'hitomi', title: 'a', pageCount: 2 };
    return null;
  });
  app.Reader.open({ id: '1', source: 'hitomi', title: 'a', pageCount: 2 });
  return {
    app,
    id: () => String(app.state.reader.gallery.id),
    page: () => app.state.reader.page,
    card: () => !app.els.readerBoundary.hidden,
  };
}

test('既定 (札なし): 最終頁の先へ送ると次の作品を直に開く', () => {
  const rig = boundaryRig({});
  rig.app.Reader.move(1);
  assert.equal(rig.page(), 1, 'まず最終頁へ');
  rig.app.Reader.move(1);
  assert.equal(rig.id(), '2', '札を挟まず次の作品へ渡る');
  assert.equal(rig.page(), 0, '次の作品は先頭から');
  assert.equal(rig.card(), false, '札は出ていない');
  // 前へは巻き戻りなので、前の作品の最後の頁から入る
  rig.app.Reader.move(-1);
  assert.equal(rig.id(), '1');
  assert.equal(rig.page(), 1, '前の作品はその最終頁');
  rig.app.Reader.close();
});

test('札を見せる設定: 最終頁の先で札を挟み、同じ向きにもう一度で渡る。逆向きは畳んで留まる', () => {
  const rig = boundaryRig({ readerNextCard: true });
  rig.app.Reader.move(1);
  rig.app.Reader.move(1);
  assert.equal(rig.id(), '1', 'まだ渡らない');
  assert.equal(rig.card(), true, '札が出る');
  rig.app.Reader.move(-1);
  assert.equal(rig.card(), false, '逆向きで札は畳まれる');
  assert.equal(rig.id(), '1');
  assert.equal(rig.page(), 1, '元の頁に留まる');
  rig.app.Reader.move(1);
  assert.equal(rig.card(), true);
  rig.app.Reader.move(1);
  assert.equal(rig.id(), '2', '同じ向きにもう一度で渡る');
  assert.equal(rig.card(), false, '渡ったら札は消える');
  rig.app.Reader.close();
});

test('隣が無ければ最終頁の先では何も起きない (札も出ない・渡らない)', () => {
  const rig = boundaryRig({});
  rig.app.Reader.setNeighborProvider(() => null);
  rig.app.Reader.move(1);
  rig.app.Reader.move(1);
  assert.equal(rig.id(), '1');
  assert.equal(rig.page(), 1);
  assert.equal(rig.card(), false);
  rig.app.Reader.close();
});

for (const preview of [false,true]) test(`wheel bursts pause at work boundaries (preview=${preview})`, () => {
  const rig = wheelRig();
  rig.app.state.settings.readerNextCard = preview;
  rig.app.Reader.setNeighborProvider((id,dir)=>id==='book'&&dir>0?{id:'next',source:'hitomi',title:'next',pageCount:3}:null);
  for(let i=0;i<39;i++) rig.app.Reader.move(1);
  for(let i=0;i<20;i++) rig.spin(100,50);
  assert.equal(rig.app.state.reader.gallery.id,'book');
  rig.spin(100,400);
  assert.equal(rig.app.state.reader.gallery.id,'next');
  rig.app.Reader.close();
});

// ---- pixiv の継ぎ目: 次の作品の下に関連作品 --------------------------------
// 読み終わり (先へ) の札は 次の作品の札 + 細い線 + 関連作品の格子。
// 隣が無くても関連だけは出る (関連から渡った作品でも次の関連へ辿れる)。
// 関連の札を押すと、次の作品と同じ渡り方でそれを開く。引くのは母屋の pixiv 'related' 一度だけ

const RELATED_ROWS = [
  { id: 'px:201', source: 'pixiv', title: 'r1', pageCount: 4, artists: [{ name: '甲' }] },
  { id: 'px:202', source: 'pixiv', title: 'r2', pageCount: 1, owned: true, artists: [] },
  { id: 'px:203', source: 'pixiv', title: 'ugoira', pageCount: 0, artists: [] },
  { id: 'px:100', source: 'pixiv', title: 'self', pageCount: 2, artists: [] },
];

function relatedRig({ settings = { readerNextCard: true }, neighbor = true, pixiv, context = {} } = {}) {
  const calls = [];
  const opened = [];
  let clock = 10000;
  const api = pixiv || (async () => RELATED_ROWS);
  const app = loadReader(() => Promise.reject(new Error('unused')), {
    escapeHtml: (t) => String(t),
    Date: { now: () => clock },
    window: { hitomi: {
      readerActive() {},
      openEagle() {},
      pixiv: (payload) => { calls.push(payload); return api(payload); },
    } },
    ...context,
  });
  app.state.readerSpread = false;
  app.state.readerRtl = false;
  app.state.readerFit = 'contain';
  Object.assign(app.state.settings, settings);
  // 関連の札の押下は bind() が継ぎ目に付ける聞き手で受ける
  app.Reader.bind();
  app.Reader.setNeighborProvider((id, delta) => (
    neighbor && String(id) === 'px:100' && delta > 0 ? { id: 'px:101', source: 'pixiv', title: 'next', pageCount: 3, artists: [{ name: '乙', userId: '9' }] } : null));
  app.Reader.setCreatorOpener((gallery) => { opened.push(String(gallery.id)); return true; });
  // 後から届いた格子の差し替え先: 出ている札の中の .reader-related を一枚の張りぼてで受ける
  const slot = element();
  app.els.readerBoundary.querySelector = (sel) => (sel === '.reader-related' && !app.els.readerBoundary.hidden ? slot : null);
  app.Reader.open({ id: 'px:100', source: 'pixiv', title: 'a', pageCount: 2 });
  // 押した所の張りぼて: closest は選択子に応じて「その札」だけを返す。type は click / contextmenu / dblclick
  const press = (attr, value, type = 'click') => {
    const fn = app.els.readerBoundary.__listeners.get(type)[0];
    const node = { dataset: { [attr]: value } };
    const wanted = `[data-${attr.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}]`;
    fn({ detail: type === 'dblclick' ? 2 : 1, target: { closest: (sel) => (sel === wanted ? node : null) }, preventDefault() {}, stopPropagation() {} });
  };
  return {
    app,
    calls,
    opened,
    slot,
    html: () => app.els.readerBoundary.innerHTML,
    card: () => !app.els.readerBoundary.hidden,
    id: () => String(app.state.reader.gallery.id),
    page: () => app.state.reader.page,
    click: (key) => press('related', key),
    rightClick: (key) => press('related', key, 'contextmenu'),
    doubleClick: (key) => press('related', key, 'dblclick'),
    clickCreator: (key) => press('relatedCreator', key),
    rightClickCreator: (key) => press('relatedCreator', key, 'contextmenu'),
    clickNext: () => press('next', '1'),
    rightClickNext: () => press('next', '1', 'contextmenu'),
    pageClick() {
      const fn = app.els.readerPages.__listeners.get('click')[0];
      fn({ detail: 1, target: {} });
    },
    wait(ms) { clock += ms; },
    spin(delta, gap = 0) {
      clock += gap;
      app.Reader.handleWheel({ deltaY: delta, deltaMode: 0, ctrlKey: false, preventDefault() {} });
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('pixiv: 最終頁に着いたら関連を一度だけ引き、先へ送ると 次の札 + 線 + 格子 が出る', async () => {
  const rig = relatedRig();
  assert.equal(rig.calls.length, 0, '途中の頁では引かない');
  rig.app.Reader.move(1);
  assert.equal(rig.page(), 1);
  assert.equal(rig.calls.length, 1, '最終頁に着いた時に一度');
  assert.equal(rig.calls[0].action, 'related');
  assert.equal(rig.calls[0].id, 'px:100');
  await settle();
  rig.app.Reader.move(1);
  assert.equal(rig.card(), true);
  assert.equal(rig.id(), 'px:100', 'まだ渡らない');
  const html = rig.html();
  assert.match(html, /class="reader-next"/, '次の作品の札');
  assert.match(html, /reader-related-rule/, '細い線');
  // 分かれ道: 次の札は表紙・題・作者だけ (見出しの語も案内も付けない)。格子の見出しはただの「関連作品」
  assert.doesNotMatch(html, /reader-next-kicker/, '次の札に見出しの語を付けない');
  assert.doesNotMatch(html, /続ける|一覧の次|もう一度で開く|寄り道/);
  assert.match(html, /<p class="reader-related-head">関連作品<\/p>/);
  assert.match(html, /data-related="px:201"/);
  assert.match(html, /data-related="px:202"/);
  assert.match(html, /owned-mark/, '所持の印');
  assert.doesNotMatch(html, /px:203/, 'うごイラ (頁の無い物) は並べない');
  assert.doesNotMatch(html, /data-related="px:100"/, '自分自身は並べない');
  assert.equal(rig.calls.length, 1, '札を出す時に引き直さない');
  rig.app.Reader.move(1);
  assert.equal(rig.id(), 'px:101', 'そのまま送れば次の作品');
  assert.equal(rig.card(), false);
  rig.app.Reader.close();
});

// 2026-09-27 に配った版で、分かれ道の display: grid が .reader-boundary[hidden] に勝ち、
// 畳んだはずの空の幕が頁を黒く覆った (pixiv の継ぎ目を一度出した後、どの作品を開いても)。
// 印 (with-related) は畳む時に外し、CSS にも畳んだ幕を消す一行を置く (どちらか一方が崩れても出ないように)
test('pixiv: 分かれ道の印は畳むと外れ、CSS でも畳んだ幕は消える', async () => {
  const rig = relatedRig();
  const names = new Set();
  rig.app.els.readerBoundary.classList = {
    add: (...n) => n.forEach((x) => names.add(x)),
    remove: (...n) => n.forEach((x) => names.delete(x)),
    toggle: (n, on) => { const want = on === undefined ? !names.has(n) : !!on; if (want) names.add(n); else names.delete(n); return want; },
    contains: (n) => names.has(n),
  };
  rig.app.Reader.move(1);
  await settle();
  rig.app.Reader.move(1);
  assert.equal(names.has('with-related'), true, '継ぎ目を出すと付く');
  rig.app.Reader.move(1);
  assert.equal(rig.id(), 'px:101');
  assert.equal(names.has('with-related'), false, '次の作品へ渡ったら外れる');
  // 渡った先 (一覧の次が無い) でも関連だけの継ぎ目を出し、今度は閉じる
  rig.app.Reader.move(1);
  rig.app.Reader.move(1);
  rig.app.Reader.move(1);
  assert.equal(rig.card(), true);
  assert.equal(names.has('with-related'), true);
  rig.app.Reader.close();
  assert.equal(names.has('with-related'), false, '閉じたら外れる');
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');
  assert.match(css, /\.reader-boundary\.with-related\[hidden\]\s*\{\s*display:\s*none;?\s*\}/, '畳んだ分かれ道の幕は CSS でも消す');
});

test('pixiv: 右綴じでも次の札に語は付けない。関連の無い札 (hitomi など) は今までどおり「次の作品」', async () => {
  const rig = relatedRig();
  rig.app.state.readerRtl = true;
  rig.app.Reader.move(1);
  await settle();
  rig.app.Reader.move(1);
  assert.doesNotMatch(rig.html(), /reader-next-kicker|もう一度で開く/);
  rig.app.Reader.close();
  const plain = relatedRig({ settings: { readerNextCard: true }, pixiv: async () => [] });
  plain.app.state.reader.gallery.source = 'hitomi';
  plain.app.Reader.move(1);
  plain.app.Reader.move(1);
  assert.match(plain.html(), /<p class="reader-next-kicker">次の作品<\/p>/, 'hitomi などの札は今までどおり');
  plain.app.Reader.close();
});

// 関連の格子の見出しは巻いても残る (position: sticky)。張り付くのは巻く箱の上の空き (padding) の下なので、
// 箱の中に上の空きがあると、見出しより上を表紙が流れて見える (2026-09-27 に配った版で起きた)。
// 上の空きは箱の外 (margin) に置く
test('pixiv: 関連の格子を巻く箱は、上の空きを箱の中 (padding) に持たない', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const boxes = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].split(',').map((s) => s.trim());
    // 同じ要素 (最後の複合) が .reader-related そのもの・:first-child の変種
    if (!selectors.some((s) => /(?:^|\s)\.reader-related(?::first-child)?$/.test(s))) continue;
    boxes.push(match[2]);
    const top = match[2].match(/padding-top\s*:\s*([^;]+)/);
    if (top) assert.match(top[1].trim(), /^0(?:px)?$/, `padding-top が付いている: ${selectors.join(', ')}`);
    const short = match[2].match(/(?:^|[;\s])padding\s*:\s*([^;]+)/);
    if (short) assert.match(short[1].trim().split(/\s+/)[0], /^0(?:px)?$/, `padding の上が 0 でない: ${selectors.join(', ')}`);
  }
  assert.ok(boxes.length >= 2, '網が規則を拾えていない (読み方が壊れた)');
  assert.match(css, /\.reader-related-head\s*\{[^}]*position:\s*sticky/, '見出しは巻いても残る');
  // 表紙の上の印 (頁数の札は z-index 3) が見出し (z-index 1) の上へ浮かないよう、表紙ごとに閉じ込める
  assert.match(css, /\.reader-related-cover\s*\{[^}]*isolation:\s*isolate/, '表紙の印は表紙の中に閉じる');
});

test('pixiv: 隣が無くても関連の札は出て、同じ向きにもう一度でも留まる。届く前は読み込み中、届いたら格子だけ差し替える', async () => {
  const rig = relatedRig({ neighbor: false });
  rig.app.Reader.move(1);
  rig.app.Reader.move(1);
  assert.equal(rig.card(), true, '隣が無くても札は出る');
  assert.doesNotMatch(rig.html(), /class="reader-next"/, '次の作品の札は無い');
  assert.doesNotMatch(rig.html(), /reader-related-rule/, '線も無い');
  assert.doesNotMatch(rig.html(), /寄り道/, '格子は寄り道とは名乗らない (次の札が無ければ格子が場を全部使う)');
  assert.match(rig.html(), /<p class="reader-related-head">関連作品<\/p>/);
  assert.match(rig.html(), /読み込み中/);
  await settle();
  assert.match(rig.slot.outerHTML, /data-related="px:201"/, '届いた格子は札を組み直さず差し替える');
  rig.app.Reader.move(1);
  assert.equal(rig.id(), 'px:100', '次が無いので留まる');
  assert.equal(rig.page(), 1);
  assert.equal(rig.card(), true);
  rig.app.Reader.move(-1);
  assert.equal(rig.card(), false, '逆向きで畳む');
  rig.app.Reader.close();
});

test('pixiv: 関連の札を押すと、その作品を先頭から開く。その先でも関連を引く', async () => {
  const rig = relatedRig();
  rig.app.Reader.move(1);
  await settle();
  rig.app.Reader.move(1);
  rig.click('px:201');
  assert.equal(rig.id(), 'px:201');
  assert.equal(rig.page(), 0);
  assert.equal(rig.card(), false);
  for (let i = 0; i < 3; i += 1) rig.app.Reader.move(1);
  assert.equal(rig.page(), 3);
  assert.equal(rig.calls.length, 2, '渡った先の最終頁でその作品の関連を引く');
  assert.equal(rig.calls[1].id, 'px:201');
  rig.click('px:999');
  assert.equal(rig.id(), 'px:201', '知らない札は無視');
  rig.app.Reader.close();
});

test('pixiv: 札なしの設定なら関連は引かず、今までどおり直に渡る (隣が無ければ何も起きない)', () => {
  const rig = relatedRig({ settings: {} });
  rig.app.Reader.move(1);
  assert.equal(rig.calls.length, 0);
  rig.app.Reader.move(1);
  assert.equal(rig.id(), 'px:101', '直に渡る');
  rig.app.Reader.close();
  const lone = relatedRig({ settings: {}, neighbor: false });
  lone.app.Reader.move(1);
  lone.app.Reader.move(1);
  assert.equal(lone.id(), 'px:100');
  assert.equal(lone.card(), false);
  assert.equal(lone.calls.length, 0);
  lone.app.Reader.close();
});

test('hitomi の継ぎ目には関連の格子は出ない (今までどおり札だけ)', () => {
  const rig = boundaryRig({ readerNextCard: true });
  rig.app.Reader.move(1);
  rig.app.Reader.move(1);
  assert.equal(rig.card(), true);
  assert.doesNotMatch(rig.app.els.readerBoundary.innerHTML, /reader-related/);
  rig.app.Reader.close();
});

test('pixiv: 取得に失敗しても札は出る (文言だけ)。別の作品へ移ってから届いた分は混ぜない', async () => {
  const rig = relatedRig({ pixiv: async () => { throw new Error('down'); } });
  rig.app.Reader.move(1);
  await settle();
  rig.app.Reader.move(1);
  assert.match(rig.html(), /関連作品を取得できませんでした/);
  assert.doesNotMatch(rig.html(), /data-related=/);
  rig.app.Reader.close();

  const first = deferred();
  let n = 0;
  const late = relatedRig({ neighbor: false, pixiv: () => (n++ === 0 ? first.promise : new Promise(() => {})) });
  late.app.Reader.move(1);
  assert.equal(late.calls.length, 1);
  // 一頁の作品へ移る: 開いた時点で最終頁なので、その作品の分を引きに行く
  late.app.Reader.open({ id: 'px:300', source: 'pixiv', title: 'b', pageCount: 1 });
  assert.equal(late.calls.length, 2);
  first.resolve(RELATED_ROWS);
  await settle();
  late.app.Reader.move(1);
  assert.equal(late.card(), true);
  assert.match(late.html(), /読み込み中/, '前の作品の関連は捨てられている');
  assert.doesNotMatch(late.html(), /data-related=/);
  late.app.Reader.close();
});

test('pixiv: 隣が無くても wheel の勢いは関連の札の前で止まる', () => {
  const rig = relatedRig({ neighbor: false });
  rig.app.Reader.move(1);
  for (let i = 0; i < 10; i += 1) rig.spin(100);
  assert.equal(rig.card(), true, '札は出る');
  assert.equal(rig.id(), 'px:100');
  assert.equal(rig.page(), 1);
  rig.app.Reader.close();
});

// ---- 押して進む ------------------------------------------------------------
// 関連の札が出ている間: ホイールは格子を巻く (渡らない)、頁の空白を押しても渡らない、
// 渡るのは 次の札 / 関連の札 を押した時。作者名を押すと作者の一覧へ (app.js が据える口)

test('pixiv: 関連は 30 件を頼み、次の札と関連の札は押して渡る。作者名は作者の一覧へ', async () => {
  const rig = relatedRig();
  rig.app.Reader.move(1);
  assert.equal(rig.calls[0].limit, 30, '継ぎ目は一頁ぶん (30) を頼む');
  await settle();
  rig.app.Reader.move(1);
  const html = rig.html();
  assert.match(html, /class="reader-next" data-next="1"/, '次の札は押せる');
  assert.match(html, /data-related-creator="px:101"/, '次の札の作者名も押せる');
  assert.match(html, /data-related-creator="px:201"/, '関連の作者名も押せる');
  assert.match(html, /class="reader-related-work" data-related="px:201"/);
  // 頁の空白を押しても渡らない
  rig.pageClick();
  assert.equal(rig.id(), 'px:100');
  assert.equal(rig.card(), true, '札は出たまま');
  // 作者名 → 作者の一覧 (読み手側は渡す口を呼ぶだけ)
  rig.clickCreator('px:201');
  assert.deepEqual(rig.opened, ['px:201']);
  assert.equal(rig.id(), 'px:100', '作者名では作品は開かない');
  rig.clickCreator('px:101');
  assert.deepEqual(rig.opened, ['px:201', 'px:101'], '次の札の作者名も同じ口');
  // 次の札を押すと次の作品へ
  rig.clickNext();
  assert.equal(rig.id(), 'px:101');
  assert.equal(rig.page(), 0);
  assert.equal(rig.card(), false);
  rig.app.Reader.close();
});

test('pixiv: 関連の札が出ている間、ホイールは格子を巻く。天辺でさらに上へ回すと札を畳む', () => {
  const rig = relatedRig();
  rig.app.Reader.move(1);
  // 最終頁で下へ回す: 札が出る。同じ勢いの続きは格子を動かさない
  rig.spin(100, 50);
  assert.equal(rig.card(), true);
  rig.slot.scrollTop = 0;
  rig.slot.scrollHeight = 1000;
  rig.slot.clientHeight = 400;
  rig.spin(100, 50);
  assert.equal(rig.slot.scrollTop, 0, '出した直後の勢いは捨てる');
  assert.equal(rig.id(), 'px:100', '渡らない');
  // 少し置いて回すと格子が巻ける。回し切っても渡らない
  rig.spin(100, 500);
  assert.equal(rig.slot.scrollTop, 100);
  for (let i = 0; i < 20; i += 1) rig.spin(100, 50);
  assert.equal(rig.slot.scrollTop, 600, '底で止まる (scrollHeight - clientHeight)');
  assert.equal(rig.id(), 'px:100', '底まで巻いても次の作品へは渡らない');
  assert.equal(rig.card(), true);
  // 上へ戻して、天辺でもう一度上へ回すと札を畳んで頁に戻る
  for (let i = 0; i < 6; i += 1) rig.spin(-100, 50);
  assert.equal(rig.slot.scrollTop, 0);
  assert.equal(rig.card(), true, '天辺に着いた回では畳まない');
  // 天辺に着いた勢いの続きでは畳まない (区切り)。手を止めてから改めて回した一発で畳む
  rig.spin(-100, 50);
  rig.spin(-100, 50);
  assert.equal(rig.card(), true, '同じ勢いの続きは吸う');
  rig.spin(-100, 600);
  assert.equal(rig.card(), false, '手を止めてから上へ: 畳む');
  assert.equal(rig.page(), 1, '頁はそのまま');
  // 畳んだ勢いの続きで頁まで戻らない。間を置いて回せば今までどおり戻る
  rig.spin(-100, 50);
  rig.spin(-100, 50);
  assert.equal(rig.page(), 1, '畳んだ直後の勢いは捨てる');
  rig.spin(-100, 600);
  assert.equal(rig.page(), 0, '間を置けば戻る');
  rig.app.Reader.move(1);
  // 矢印 (move) は今までどおり明示の送り: 札の上でもう一度なら渡る
  rig.app.Reader.move(1);
  rig.app.Reader.move(1);
  assert.equal(rig.id(), 'px:101');
  rig.app.Reader.close();
});

test('pixiv: 格子の底が近づいたら次の 30 件を頼んで末尾に足す。返りが頼んだ数に届かなければ終わり', async () => {
  // 母屋の関連は 100 件まで出る。頼まれた件数 (limit) までを返す (母屋の related と同じ約束)
  const pool = Array.from({ length: 100 }, (_, i) => ({ id: `px:${500 + i}`, source: 'pixiv', title: `r${i}`, pageCount: 2, artists: [] }));
  const rig = relatedRig({ neighbor: false, pixiv: async (payload) => pool.slice(0, payload.limit) });
  rig.app.Reader.move(1);
  assert.deepEqual(rig.calls.map((c) => c.limit), [30]);
  await settle();
  rig.app.Reader.move(1);
  assert.match(rig.html(), /data-related="px:529"/);
  assert.doesNotMatch(rig.html(), /data-related="px:530"/, '最初は 30 件');
  rig.slot.scrollTop = 0;
  rig.slot.scrollHeight = 2000;
  rig.slot.clientHeight = 600;
  // 途中では頼まない
  rig.spin(100, 500);
  rig.spin(100, 50);
  assert.deepEqual(rig.calls.map((c) => c.limit), [30], '底が遠い間は頼まない');
  // 底の手前 (320px 以内) に来たら続きを頼む。届く前に何度回しても一つだけ
  for (let i = 0; i < 12; i += 1) rig.spin(100, 50);
  assert.equal(rig.slot.scrollTop, 1400);
  assert.deepEqual(rig.calls.map((c) => c.limit), [30, 60]);
  rig.spin(100, 50);
  assert.deepEqual(rig.calls.map((c) => c.limit), [30, 60], '届く前は重ねて頼まない');
  await settle();
  assert.match(rig.slot.outerHTML, /data-related="px:559"/, '届いた分は格子に足される');
  assert.equal(rig.card(), true);
  assert.equal(rig.id(), 'px:100', '足しても渡らない');
  // さらに底へ: 90、120 (100 件しか無いので 100 が返り、そこで終わり)
  rig.spin(100, 50);
  await settle();
  rig.spin(100, 50);
  await settle();
  assert.deepEqual(rig.calls.map((c) => c.limit), [30, 60, 90, 120]);
  assert.match(rig.slot.outerHTML, /data-related="px:599"/);
  for (let i = 0; i < 5; i += 1) { rig.spin(100, 50); await settle(); }
  assert.deepEqual(rig.calls.map((c) => c.limit), [30, 60, 90, 120], '終わった後は頼まない');
  rig.app.Reader.close();
});

// ---- 継ぎ目の作品の札の押し分け ------------------------------------------------
// 次の札・関連の札は一覧の札と同じ割り当て (設定のマウス) で押し分ける。割り当てを読むのは
// app.js が据える口 (setWorkPress)。読み手は押された札の作品と「渡る」手 (cross) を渡すだけ

test('継ぎ目の札: 口が無ければ左で渡るだけ。右とダブルクリックでは何も起きない', async () => {
  const rig = relatedRig();
  rig.app.Reader.move(1);
  await settle();
  rig.app.Reader.move(1);
  rig.rightClick('px:201');
  rig.doubleClick('px:201');
  rig.rightClickNext();
  assert.equal(rig.id(), 'px:100', '右とダブルでは渡らない');
  assert.equal(rig.card(), true);
  rig.click('px:201');
  assert.equal(rig.id(), 'px:201', '左で渡る');
  rig.app.Reader.close();
});

test('継ぎ目の札: 口があれば 左 / 右 / ダブル をそのまま渡し、渡るかどうかは口が決める', async () => {
  const rig = relatedRig();
  const pressed = [];
  let crossNow = null;
  rig.app.Reader.setWorkPress((kind, gallery, event, cross) => {
    pressed.push(`${kind}:${gallery.id}`);
    crossNow = cross;
  });
  rig.app.Reader.move(1);
  await settle();
  rig.app.Reader.move(1);
  rig.click('px:201');
  rig.doubleClick('px:202');
  rig.rightClickNext();
  rig.click('px:999');
  assert.deepEqual(pressed, ['Left:px:201', 'Double:px:202', 'Right:px:101'], '知らない札は口に回さない');
  assert.equal(rig.id(), 'px:100', '口が渡らない限り渡らない');
  // 作者名は作品の札の押し分けに入れない (左は作者の一覧、右は何もしない)
  rig.rightClickCreator('px:201');
  rig.clickCreator('px:201');
  assert.equal(pressed.length, 3);
  assert.deepEqual(rig.opened, ['px:201']);
  // 口が cross() を呼べば、その作品へ渡る (次の札なら次の作品)
  crossNow();
  assert.equal(rig.id(), 'px:101');
  assert.equal(rig.page(), 0);
  assert.equal(rig.app.Reader.trailLength(), 1, '足跡を積む');
  rig.app.Reader.close();
});

test('継ぎ目の札: 口が待っている間に継ぎ目が畳まれたら、遅れて呼ばれた cross() では渡らない', async () => {
  const rig = relatedRig();
  let later = null;
  rig.app.Reader.setWorkPress((kind, gallery, event, cross) => { later = cross; });
  rig.app.Reader.move(1);
  await settle();
  rig.app.Reader.move(1);
  rig.click('px:201');
  rig.app.Reader.move(-1);
  assert.equal(rig.card(), false, '逆向きで畳んだ');
  later();
  assert.equal(rig.id(), 'px:100', '畳んだ後の cross は何もしない');
  assert.equal(rig.page(), 1);
  rig.app.Reader.close();
});

// 格子は一目盛りで一気に飛ばず、コマごとに滑って着く。続けて回すと行き先が延びるだけ
test('pixiv: 関連の格子はホイールで滑って着く (一気に飛ばない)。天辺と底は着く所で見る', async () => {
  const frames = [];
  let at = 0;
  const flush = (n = Infinity) => {
    for (let i = 0; i < n && frames.length; i += 1) {
      at += 1000 / 60;
      frames.shift()(at);
    }
  };
  const rig = relatedRig({ context: {
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    cancelAnimationFrame() {},
  } });
  rig.app.Reader.move(1);
  await settle();
  rig.spin(100, 50);
  rig.slot.scrollTop = 0;
  rig.slot.scrollHeight = 1000;
  rig.slot.clientHeight = 400;
  rig.spin(100, 500);
  assert.equal(rig.slot.scrollTop, 0, '回した瞬間には動かない (次のコマから)');
  flush(1);
  const first = rig.slot.scrollTop;
  assert.ok(first > 0 && first < 40, `一コマ目は一部だけ寄る (${first})`);
  flush(3);
  assert.ok(rig.slot.scrollTop > first && rig.slot.scrollTop < 100, '滑っている途中');
  // 滑っている途中でもう一目盛り: 行き先が 200 に延びる (今の位置 + 100 ではない)
  rig.spin(100, 30);
  flush();
  assert.equal(rig.slot.scrollTop, 200, '二目盛りぶんの所にぴたりと着く');
  // 底: 行き先で止める
  for (let i = 0; i < 10; i += 1) rig.spin(100, 30);
  flush();
  assert.equal(rig.slot.scrollTop, 600, '底で止まる');
  // 上へ一気に回す: 行き先は天辺、まだ滑っている (scrollTop は遅れている) 間に来た上向きは
  // 天辺の勢いの続きとして吸う (畳まない)
  for (let i = 0; i < 6; i += 1) rig.spin(-100, 30);
  flush(2);
  assert.ok(rig.slot.scrollTop > 0, 'まだ着いていない');
  rig.spin(-100, 30);
  assert.equal(rig.card(), true, '天辺へ向かう勢いの続きでは畳まない');
  // 手を止めてから上へ: 畳む (滑りの途中でも、行き先が天辺なら天辺にいるものとして扱う)
  rig.spin(-100, 600);
  assert.equal(rig.card(), false, '手を止めてから上へ: 畳む');
  const left = rig.slot.scrollTop;
  flush();
  assert.equal(rig.slot.scrollTop, left, '畳んだら滑りも止まる (外れた格子を動かし続けない)');
  assert.equal(frames.length, 0);
  rig.app.Reader.close();
});

// ---- 渡り歩いた足跡 (マウスの戻る) --------------------------------------------
// 継ぎ目から渡るたびに足跡を積み、back() で一つ前の作品へ (居た頁で) 帰る。
// 一覧や詳細から開き直したら足跡は捨てる (別の旅)

test('pixiv: 関連から渡った足跡を back() で一つずつ戻れる。開き直せば足跡は消える', async () => {
  const rig = relatedRig();
  assert.equal(rig.app.Reader.trailLength(), 0);
  rig.app.Reader.move(1);
  await settle();
  rig.app.Reader.move(1);
  rig.click('px:201');
  assert.equal(rig.id(), 'px:201');
  assert.equal(rig.app.Reader.trailLength(), 1, '渡ったら足跡が一つ');
  // px:201 (4 頁) の 2 頁目まで進んでから次の作品 (関連) へ
  rig.app.Reader.move(1);
  assert.equal(rig.page(), 1);
  for (let i = 0; i < 3; i += 1) rig.app.Reader.move(1);
  await settle();
  rig.app.Reader.move(1);
  rig.click('px:202');
  assert.equal(rig.id(), 'px:202');
  assert.equal(rig.app.Reader.trailLength(), 2);
  // 戻る: 一つ前の作品へ、居た頁 (最終頁) で
  assert.equal(rig.app.Reader.back(), true);
  assert.equal(rig.id(), 'px:201');
  assert.equal(rig.page(), 3, '去った時の頁に戻る');
  assert.equal(rig.app.Reader.trailLength(), 1);
  assert.equal(rig.app.Reader.back(), true);
  assert.equal(rig.id(), 'px:100');
  assert.equal(rig.page(), 1);
  assert.equal(rig.app.Reader.trailLength(), 0);
  assert.equal(rig.app.Reader.back(), false, '足跡が無ければ false (呼び手が閉じる)');
  // 外から開き直すと足跡は捨てる (戻った作品の関連は引き直しになるので、届くのを待つ)
  await settle();
  rig.app.Reader.move(1);
  rig.click('px:201');
  assert.equal(rig.app.Reader.trailLength(), 1);
  rig.app.Reader.open({ id: 'px:300', source: 'pixiv', title: 'b', pageCount: 1 });
  assert.equal(rig.app.Reader.trailLength(), 0);
  rig.app.Reader.close();
});

test('頁へ飛ぶ欄の Esc は欄だけを畳み、文書の keydown へ渡さない (読む画面ごと閉じていた)', () => {
  const app = loadReader(() => Promise.reject(new Error('unused')));
  app.Reader.open({ id: 'book', source: 'hitomi', title: 'book', pageCount: 6 });
  app.Reader.bind();
  app.els.readerPageInput.focus = () => {};
  app.els.readerPageInput.select = () => {};
  app.els.readerPage.__listeners.get('click')[0]();
  assert.equal(app.els.readerPageInput.hidden, false, '欄が開く');
  const keydown = app.els.readerPageInput.__listeners.get('keydown')[0];
  for (const key of ['Escape', 'Enter']) {
    if (key === 'Enter') app.els.readerPage.__listeners.get('click')[0]();
    let stopped = false;
    keydown({ key, isComposing: false, preventDefault() {}, stopPropagation() { stopped = true; } });
    assert.equal(stopped, true, `${key} は欄で止める`);
    assert.equal(app.els.readerPageInput.hidden, true, `${key} で欄が畳まれる`);
    assert.equal(app.Reader.isOpen(), true, `${key} で読む画面は閉じない`);
  }
});

test('前へ渡って前の作品の最終頁から入り、頁を動かさずに去っても読了に数えない', () => {
  const writes = [];
  const app = loadReader(() => Promise.reject(new Error('unused')), {
    escapeHtml: (t) => String(t),
    window: { hitomi: { readerActive() {}, openEagle() {}, readingSet(id, entry) { writes.push({ id, ...entry }); return Promise.resolve(); } } },
  });
  app.state.readerSpread = false;
  app.state.readerRtl = false;
  app.state.readerFit = 'contain';
  app.Reader.setNeighborProvider((id, delta) => {
    if (String(id) === 'b' && delta < 0) return { id: 'a', source: 'hitomi', title: 'a', pageCount: 3 };
    if (String(id) === 'a' && delta > 0) return { id: 'b', source: 'hitomi', title: 'b', pageCount: 6 };
    return null;
  });
  app.Reader.open({ id: 'b', source: 'hitomi', title: 'b', pageCount: 6 });
  app.Reader.move(-1);                     // 先頭で前へ: 前の作品 a の最終頁へ巻き戻る
  assert.equal(String(app.state.reader.gallery.id), 'a');
  assert.equal(app.state.reader.page, 2, 'a の最終頁から入る');
  app.Reader.move(1);                      // 何も読まずに b へ戻る
  const left = writes.filter((w) => w.id === 'a').pop();
  assert.equal(left.page, 2);
  assert.equal(left.finished, false, '最終頁に入っただけでは読了にしない');

  // 一度でも頁を動かしてから最終頁へ進めば、今までどおり読了
  app.Reader.move(-1);
  app.Reader.move(-1);                     // a の 1 頁目へ
  app.Reader.move(1);                      // 最終頁へ進む
  app.Reader.close();
  const read = writes.filter((w) => w.id === 'a').pop();
  assert.equal(read.page, 2);
  assert.equal(read.finished, true, '進んで最終頁に着いたら読了');
});

test('読む画面を開く時、消えるスクロールバーの幅を余白で埋め、閉じたら外す (後ろの棚を組み直させない)', () => {
  const props = new Map();
  const classes = new Set();
  const body = {
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle() {} },
    style: { setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k) },
  };
  const app = loadReader(() => Promise.reject(new Error('unused')), {
    document: { body, documentElement: { clientWidth: 1270 }, activeElement: null, getElementById: () => ({}), createElement: () => ({}) },
    window: { innerWidth: 1278, hitomi: { readerActive() {}, openEagle() {} } },
  });
  app.Reader.open({ id: 'book', source: 'hitomi', title: 'book', pageCount: 4 });
  assert.equal(classes.has('reader-open'), true);
  assert.equal(props.get('--reader-scrollbar-gap'), '8px', 'スクロールバーの 8px を測って余白にする');
  app.Reader.close();
  assert.equal(classes.has('reader-open'), false);
  assert.equal(props.has('--reader-scrollbar-gap'), false, '閉じたら余白も外す');
});
