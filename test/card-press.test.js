'use strict';

// 札の押し分け (src/renderer/app.js)。左 / 右 / ダブルクリックは設定のマウスの割り当てで
// 詳細 / 読む / 保存 / 何もしない に振られる。同じ割り当てが次の三か所で揃っていることを見る:
//   一覧の札 (bindCardEvents)・詳細の関連作品 (bindDetail)・読む画面の継ぎ目の札 (Reader.setWorkPress。
//   ただし継ぎ目の左は割り当てに依らず「読む」: 読む画面の中なので)
// 左の一打は、ダブルに何か割り当ててある間は一呼吸 (250ms) 待つ: ダブルクリックの一打目で
// 詳細が開いてしまわないように。ダブルが「何もしない」なら即座に動く。
// 題はすべて見本。

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadInVm } = require('./helpers/vm-dom');

const DEPS = [
  'src/renderer/reader.js',
  'src/renderer/downloads-ui.js',
  'src/renderer/dupe-cluster.js',
  'src/renderer/navigation-state.js',
  'src/renderer/virtual-grid.js',
  'src/renderer/home-bundle.js',
  'src/renderer/home.js',
];

const WAIT = 300; // 左の一呼吸 (250ms) を越える間
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 割り当ての先 (詳細・読む・保存) は張りぼてに差し替えて、何が呼ばれたかだけ数える
function app(settings) {
  const ctx = loadInVm('src/renderer/app.js', { globals: { hitomi: { readerActive() {} } }, deps: DEPS });
  ctx.__harness.state.settings = settings;
  const log = [];
  ctx.run = (code) => vm.runInContext(code, ctx);
  ctx.performCardAction = (action, id) => { if (action !== 'none') log.push(`${action}:${id}`); };
  ctx.openDetail = async (id) => { log.push(`detail:${id}`); };
  ctx.readRelatedWork = async (id) => { log.push(`read:${id}`); };
  ctx.startDownload = (id) => { log.push(`save:${id}`); };
  ctx.log = log;
  return ctx;
}

// 押した所の張りぼて: closest は選ばれた選択子にだけ札を返す
function target(selector, node) {
  return { closest: (sel) => (sel === selector ? node : null) };
}

function gridRig(settings) {
  const ctx = app(settings);
  const root = ctx.byId('grid-under-test');
  ctx.bindCardEvents(root);
  const card = { dataset: { id: '123' } };
  const on = target('.card[data-id]', card);
  return {
    ctx,
    click: (detail = 1) => root.dispatch('click', { detail, target: on }),
    dblclick: () => root.dispatch('dblclick', { detail: 2, target: on }),
    right: () => root.dispatch('contextmenu', { target: on }),
    double() { this.click(1); this.click(2); this.dblclick(); },
  };
}

test('一覧の札: 左 = 詳細でもダブルに保存がある間は一呼吸待ち、ダブルクリックでは詳細を開かない', async () => {
  const rig = gridRig({ mouseLeft: 'detail', mouseRight: 'read', mouseDouble: 'save' });
  rig.click();
  assert.deepEqual(rig.ctx.log, [], '一打目ではまだ開かない');
  await sleep(WAIT);
  assert.deepEqual(rig.ctx.log, ['detail:123'], '一呼吸おいて詳細');
  rig.ctx.log.length = 0;
  rig.double();
  await sleep(WAIT);
  assert.deepEqual(rig.ctx.log, ['save:123'], 'ダブルクリックは保存だけ (詳細は開かない)');
  rig.ctx.log.length = 0;
  rig.right();
  assert.deepEqual(rig.ctx.log, ['read:123'], '右は即座に読む');
  rig.ctx.__stopTimers();
});

test('一覧の札: ダブルが「何もしない」なら左は待たずに動き、二打目では重ねない', async () => {
  const rig = gridRig({ mouseLeft: 'detail', mouseRight: 'read', mouseDouble: 'none' });
  rig.click();
  assert.deepEqual(rig.ctx.log, ['detail:123'], '待たずに詳細');
  rig.click(2);
  rig.dblclick();
  await sleep(WAIT);
  assert.deepEqual(rig.ctx.log, ['detail:123'], 'ダブルクリックの二打目では何も足さない');
  rig.ctx.__stopTimers();
});

function detailRig(settings) {
  const ctx = app(settings);
  ctx.bindDetail();
  const detail = ctx.__harness.els.detail;
  const row = { dataset: { relatedDetail: 'px:201' } };
  const on = target('[data-related-detail]', row);
  return {
    ctx,
    click: (detail2 = 1) => detail.dispatch('click', { detail: detail2, target: on }),
    dblclick: () => detail.dispatch('dblclick', { detail: 2, target: on }),
    right: () => detail.dispatch('contextmenu', { target: on }),
  };
}

test('詳細の関連作品: 一覧の札と同じ割り当て (左 = 詳細・右 = 読む・ダブル = 保存)', async () => {
  const rig = detailRig({ mouseLeft: 'detail', mouseRight: 'read', mouseDouble: 'save' });
  rig.click();
  await sleep(0);
  assert.deepEqual(rig.ctx.log, [], '一打目ではまだ詳細を開かない');
  await sleep(WAIT);
  assert.deepEqual(rig.ctx.log, ['detail:px:201']);
  rig.ctx.log.length = 0;
  rig.click(1);
  rig.click(2);
  rig.dblclick();
  await sleep(WAIT);
  assert.deepEqual(rig.ctx.log, ['save:px:201'], 'ダブルクリックは保存だけ');
  rig.ctx.log.length = 0;
  rig.right();
  await sleep(0);
  assert.deepEqual(rig.ctx.log, ['read:px:201']);
  // 打鍵で押した (detail 0) 時は待たない: ダブルクリックの一打目にはなり得ない
  rig.ctx.log.length = 0;
  rig.click(0);
  await sleep(0);
  assert.deepEqual(rig.ctx.log, ['detail:px:201']);
  rig.ctx.__stopTimers();
});

test('詳細の関連作品: 割り当てを入れ替えればそのとおりに動く (左 = 読む・右 = 詳細)', async () => {
  const rig = detailRig({ mouseLeft: 'read', mouseRight: 'detail', mouseDouble: 'none' });
  rig.click();
  await sleep(0);
  assert.deepEqual(rig.ctx.log, ['read:px:201'], 'ダブルが無いので待たない');
  rig.right();
  await sleep(0);
  assert.deepEqual(rig.ctx.log, ['read:px:201', 'detail:px:201']);
  rig.ctx.__stopTimers();
});

// 読む画面の継ぎ目の札: 読み手は (kind, 作品, event, cross) を渡すだけ。割り当ては app.js が読む
function readerRig(settings) {
  const ctx = app(settings);
  ctx.run('Reader.bind = () => {}; Reader.setWorkPress = (fn) => { globalThis.__workPress = fn; };');
  ctx.bindReader();
  const press = ctx.__workPress;
  const { state } = ctx.__harness;
  ctx.run('Reader.close = () => { globalThis.__closed = (globalThis.__closed || 0) + 1; state.reader = null; };');
  const work = { id: 'px:201', source: 'pixiv', title: '見本', pageCount: 3 };
  let crossed = 0;
  const open = () => { state.reader = { gallery: { id: 'px:100' }, boundary: { related: true } }; };
  open();
  return {
    ctx,
    state,
    work,
    crossed: () => crossed,
    open,
    press: (kind, detail = 1) => press(kind, work, { detail }, () => { crossed += 1; }),
  };
}

test('継ぎ目の札: 左は割り当てに依らず読む (一呼吸おいて渡る)。右は割り当てのとおり読む', async () => {
  const rig = readerRig({ mouseLeft: 'detail', mouseRight: 'read', mouseDouble: 'save' });
  rig.press('Right');
  assert.equal(rig.crossed(), 1, '右で渡る');
  rig.press('Left');
  assert.equal(rig.crossed(), 1, '一打目ではまだ渡らない (ダブルクリックを待つ)');
  await sleep(WAIT);
  assert.equal(rig.crossed(), 2, '左 = 詳細 の割り当てでも、継ぎ目では読む');
  assert.equal(rig.ctx.__closed, undefined, '読み手は閉じない');
  assert.deepEqual(rig.ctx.log, [], '詳細は開かない');
  rig.ctx.__stopTimers();
});

test('継ぎ目の札: ダブル = 保存 は左の予約を取り消して保存だけ。待つ間に畳まれたら何もしない', async () => {
  const rig = readerRig({ mouseLeft: 'detail', mouseRight: 'read', mouseDouble: 'save' });
  rig.press('Left', 1);
  rig.press('Left', 2);
  rig.press('Double', 2);
  await sleep(WAIT);
  assert.deepEqual(rig.ctx.log, ['save:px:201'], '詳細は開かず保存だけ');
  assert.equal(rig.ctx.__closed, undefined, '読み手は閉じない');
  assert.equal(rig.crossed(), 0);
  // 左を押した直後に継ぎ目が畳まれた (頁へ戻った・閉じた)
  rig.ctx.log.length = 0;
  rig.press('Left');
  rig.state.reader.boundary = null;
  await sleep(WAIT);
  assert.deepEqual(rig.ctx.log, [], '畳まれた後は何もしない');
  rig.ctx.__stopTimers();
});

test('継ぎ目の札: ダブル = 何もしない なら左は待たずに渡る。右 = 詳細 なら読み手を閉じてその作品の詳細を開く', () => {
  const rig = readerRig({ mouseLeft: 'detail', mouseRight: 'detail', mouseDouble: 'none' });
  rig.press('Left');
  assert.equal(rig.crossed(), 1, '待たずに渡る');
  rig.press('Double', 2);
  assert.equal(rig.crossed(), 1, 'ダブルは何もしない');
  rig.press('Right');
  assert.equal(rig.ctx.__closed, 1, '読み手を閉じる');
  assert.deepEqual(rig.ctx.log, ['detail:px:201']);
  // 一覧の外の作品は札ごと預ける (詳細が pixiv を引き直さない)
  assert.equal(rig.ctx.run("relatedDetailItems.get('px:201').title"), '見本');
  rig.ctx.__stopTimers();
});
