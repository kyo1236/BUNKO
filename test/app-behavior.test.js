'use strict';

// src/renderer/app.js (4,489 行) の振る舞い。ここが長らく試験 0 の面で、
// 実際に回帰も起きている (7be8d95 が 6a189ca の後始末)。
//
// 押さえるのは「利用者の一手が何を起こすか」だけ。描画の中身は見ない。
// app.js は末尾の harness の印で起動を止め、const の state/els を渡してくれる。

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadInVm } = require('./helpers/vm-dom');

// vm の中で作られた object は原型が別の realm の物になるので、
// deepStrictEqual は中身が同じでも落ちる。値だけを見る
const plain = (value) => JSON.parse(JSON.stringify(value));

function app({ hitomi = {}, settings = {} } = {}) {
  const calls = { eagle: [], gallery: [], image: [] };
  const api = {
    imageBase: async () => 'http://img.test',
    gallery: async (id) => ({ id, pageCount: 0 }),
    openEagle: (id) => id,
    annotate: async (list) => list,
    search: async () => ({ galleries: [], total: 0 }),
    settings: async () => settings,
    readerActive() {},
    ...hitomi,
  };
  // 差し替えた口でも呼ばれた事は数える (差し替えが記録を消さないように)
  const inner = { gallery: api.gallery, openEagle: api.openEagle };
  api.gallery = (id) => { calls.gallery.push(id); return inner.gallery(id); };
  api.openEagle = (id) => { calls.eagle.push(id); return inner.openEagle(id); };
  const ctx = loadInVm('src/renderer/app.js', { globals: { hitomi: api } });
  ctx.__harness.state.imageBase = 'http://img.test';
  ctx.__harness.state.settings = settings;
  ctx.calls = calls;
  return ctx;
}

// ── 詳細を開く ────────────────────────────────────────────────

test('一覧に既にある作品は、詳細がまだ閉じていても左クリックで開く (7be8d95 の回帰)', async () => {
  const ctx = app();
  const { state, els } = ctx.__harness;
  state.galleries = [{ id: '123', title: 't', pageCount: 5, source: 'hitomi' }];
  els.detail.hidden = true;           // まだ一度も開いていない状態

  await ctx.openDetail('123');

  assert.equal(state.selected && state.selected.id, '123', '待ち無しで来ても選ばれる');
  assert.equal(els.detail.hidden, false, '詳細が開く');
  assert.deepEqual(ctx.calls.gallery, [], '手元にあるので母屋へ訊きに行かない');
  ctx.__stopTimers();
});

test('手元に無い作品は母屋へ訊きに行き、待っている間に閉じられたら開き直さない', async () => {
  let release;
  const pending = new Promise((done) => { release = done; });
  const ctx = app({ hitomi: { gallery: async () => pending } });
  const { state, els } = ctx.__harness;
  state.galleries = [];

  const opening = ctx.openDetail('999');
  assert.equal(els.detail.hidden, false, '取りに行く間も枠は出る');
  els.detail.hidden = true;           // 利用者が閉じた
  release({ id: '999', title: 'late', pageCount: 3 });
  await opening;

  assert.equal(state.selected, null, '遅れて来た応答で開き直さない');
  ctx.__stopTimers();
});

// ── 所持作品をどう開くか (今回 pawchive を母屋の経路へ回した所) ──

test('所持作品の開き先は設定どおり。Eagle 優先なら Eagle、既定ならこのアプリの読み手', async () => {
  const eagleFirst = app({ settings: { openOwned: 'eagle' } });
  const gallery = { id: 'pweagle:ABC', eagleId: 'ABC', kind: 'eagleItem', source: 'pawchive', owned: true, pageCount: 12 };
  assert.equal(eagleFirst.openOwnedUsesEagle(gallery), true);
  eagleFirst.__stopTimers();

  const inApp = app({ settings: { openOwned: 'app' } });
  assert.equal(inApp.openOwnedUsesEagle(gallery), false, 'pawchive も読み手で開ける');
  assert.equal(inApp.openOwnedUsesEagle({ id: '1', owned: true }), false, 'Eagle の控えが無い作品は対象外');
  inApp.__stopTimers();
});

test('頁数の訊き直しは Eagle アイテムだけ (hitomi の作品を網へ撃たない)', async () => {
  const ctx = app({ hitomi: { gallery: async (id) => ({ id, pageCount: 47 }) } });

  const eagleItem = await ctx.withPageCount({ id: 'pweagle:ABC', eagleId: 'ABC', kind: 'eagleItem', pageCount: 0 });
  assert.equal(eagleItem.pageCount, 47, '原本の綴じ目から数え直す');
  assert.deepEqual(ctx.calls.gallery, ['pweagle:ABC']);

  const named = await ctx.withPageCount({ id: 'pweagle:XYZ', eagleId: 'XYZ', kind: 'eagleItem', pageCount: 17 });
  assert.equal(named.pageCount, 47, '名前の【17P】より原本を信じる');

  ctx.calls.gallery.length = 0;
  const hitomi = await ctx.withPageCount({ id: '123', eagleId: 'E1', pageCount: 0, source: 'hitomi' });
  assert.equal(hitomi.pageCount, 0);
  assert.deepEqual(ctx.calls.gallery, [], 'hitomi は訊き直さない (網への往復になる)');
  ctx.__stopTimers();
});

test('訊き直しに失敗しても札のまま開く (読み手が原本を自分で開く道へ落ちる)', async () => {
  const ctx = app({ hitomi: { gallery: async () => { throw new Error('圏外'); } } });
  const out = await ctx.withPageCount({ id: 'pweagle:A', eagleId: 'A', kind: 'eagleItem', pageCount: 0 });
  assert.equal(out.pageCount, 0);
  ctx.__stopTimers();
});

// ── 絵の取り先 ────────────────────────────────────────────────

test('Eagle アイテムの表紙は /pweagle/、頁は /img (原寸も 2 頁目以降も)', () => {
  const ctx = app();
  const id = 'pweagle:ABC';
  assert.match(ctx.imgUrl(id, 0, 'small'), /\/pweagle\/ABC$/, '表紙は Eagle の札');
  assert.match(ctx.imgUrl(id, 0, 'big'), /\/pweagle\/ABC$/);
  assert.match(ctx.imgUrl(id, 0, 'full'), /\/img\?id=pweagle%3AABC&i=0&size=full$/, '原寸は母屋の頁');
  assert.match(ctx.imgUrl(id, 3, 'small'), /\/img\?id=pweagle%3AABC&i=3&size=small$/, '2 頁目以降の小札も母屋');
  assert.match(ctx.imgUrl('123', 0, 'small'), /\/img\?id=123&i=0&size=small$/);
  ctx.__stopTimers();
});

// ── 伏せた札 (項目 4-1 の今の作り。直す前にここで固める) ──────

test('伏せる判定は一本。数え・棚の漉し・該当なしの文が同じ答えを返す', () => {
  const ctx = app();
  const { state } = ctx.__harness;
  state.scope = 'search';
  state.galleries = [
    // 済 は ID が確定しているもの (紐付け済み・ID 抽出済み)
    { id: '1', owned: true, idOwned: true },
    { id: '2' },
    { id: '3', similarOwned: true },
    { id: '4', dupeHidden: true },
    // 同じ作品を二版とも Eagle に持っていると、束ねは二冊目に「重」を立てる
    { id: '5', owned: true, idOwned: true, dupeHidden: true },
  ];

  state.settings = { hideOwnedMode: 'none' };
  assert.deepEqual(ctx.visibleGridItems().map((g) => g.id), ['1', '2', '3', '4', '5']);
  assert.equal(ctx.hiddenCardCount(), 0);

  state.settings = { hideOwnedMode: 'dupes' };
  assert.deepEqual(ctx.visibleGridItems().map((g) => g.id), ['1', '2', '5'], '版違いだけ伏せる。Eagle に在る物は重でも見せる');
  assert.equal(ctx.hiddenCardCount(), 2, '数えと漉しが一致する');

  state.settings = { hideOwnedMode: 'owned' };
  assert.deepEqual(ctx.visibleGridItems().map((g) => g.id), ['2'], '所持も伏せる');
  assert.equal(ctx.hiddenCardCount(), 4);

  // 所持一覧では何も伏せない (伏せたら見るものが無くなる)
  state.scope = 'library';
  assert.deepEqual(ctx.visibleGridItems().map((g) => g.id), ['1', '2', '3', '4', '5']);
  ctx.__stopTimers();
});

// Eagle に同じ題の未照合アイテムが居ると、網の作品が「題だけの 済」になる。
// これを伏せると、持っているのに一覧から消え、**紐付ける口もその札ごと消える**。
// 利用者が実際に踏んだ穴 (所持済みを隠す設定で、ランキングの作品が出てこない)
test('題だけの 済 (ID 未確定) はどのモードでも伏せない — 紐付ける口が消えるため', () => {
  const ctx = app();
  const { state } = ctx.__harness;
  state.scope = 'search';
  state.galleries = [
    { id: '1', owned: true, idOwned: true },   // 確かな済
    { id: '2', owned: true },                  // 題だけの済 (idOwned なし)
    { id: '3' },
  ];

  for (const mode of ['dupes', 'owned']) {
    state.settings = { hideOwnedMode: mode };
    assert.ok(
      ctx.visibleGridItems().some((g) => g.id === '2'),
      `${mode} でも題だけの済は見える`,
    );
  }

  state.settings = { hideOwnedMode: 'owned' };
  assert.deepEqual(ctx.visibleGridItems().map((g) => g.id), ['2', '3'], '確かな済だけ伏せる');
  assert.equal(ctx.hiddenCardCount(), 1, '数えと漉しが一致する');

  // 紐付けて ID が確定したら、次からはちゃんと伏せられる
  state.galleries[1].idOwned = true;
  assert.deepEqual(ctx.visibleGridItems().map((g) => g.id), ['3']);

  // 題だけの済しか無いときは「全部伏さった」の文を出さない (実際に見えている)
  state.galleries = [{ id: '9', owned: true }];
  ctx.updateEmptyState();
  assert.equal(ctx.__harness.els.empty.hidden, true, '見えているのに理由を出さない');
  ctx.__stopTimers();
});

test('全部伏さったら真っ白にせず理由を言う (版違いが混ざっていても)', () => {
  const ctx = app();
  const { state, els } = ctx.__harness;
  state.scope = 'search';

  // 所持と版違いの混在。以前はこの組み合わせで棚も文字も出なかった
  state.settings = { hideOwnedMode: 'owned' };
  state.galleries = [{ id: '1', owned: true, idOwned: true }, { id: '2', similarOwned: true }];
  ctx.updateEmptyState();
  assert.equal(els.empty.hidden, false, '理由が出る');
  assert.match(els.empty.textContent, /2 件/);
  assert.match(els.empty.textContent, /所持済み/);

  // 版違いだけのとき
  state.settings = { hideOwnedMode: 'dupes' };
  state.galleries = [{ id: '1', similarOwned: true }];
  ctx.updateEmptyState();
  assert.equal(els.empty.hidden, false);
  assert.match(els.empty.textContent, /版違い/);

  // 一枚でも残るなら出さない
  state.galleries = [{ id: '1', similarOwned: true }, { id: '2' }];
  ctx.updateEmptyState();
  assert.equal(els.empty.hidden, true);
  ctx.__stopTimers();
});

// ── 取り返しのつかない操作 (項目 5-3) ──────────────────────────

// boot() まで通すと、設定画面の釦の配線も試験できる。
// 母屋の口は api() が形だけ揃えるので、口が増えても落ちない
async function booted(overrides = {}) {
  const { api } = require('./helpers/vm-dom');
  const saved = [];
  const { proxy } = api({
    libraryStatus: async () => ({ owned: 42 }),
    saveSettings: async (patch) => { saved.push(patch); return {}; },
    ...overrides,
  });
  // autoQuery: innerHTML を組んで querySelector で拾い直す作り (確認の枠) を動かす
  const ctx = loadInVm('src/renderer/app.js', { globals: { hitomi: proxy }, autoQuery: true });
  await ctx.boot();
  ctx.saved = saved;
  return ctx;
}

test('Eagle ライブラリのクリアは、外す前に何を失うかを言って訊く', async () => {
  const ctx = await booted();
  const button = ctx.byId('set-eagle-clear');
  assert.ok(button.__listeners.get('click'), '釦に配線がある');

  button.dispatch('click');
  await new Promise((done) => setImmediate(done));

  // 確認の枠が出るまで、設定は一文字も書き換わらない
  assert.deepEqual(ctx.saved, [], '訊く前に外さない');
  const dialog = ctx.document.body.children.find((node) => node.className.includes('confirm'));
  assert.ok(dialog, '確認の枠が出る');
  assert.match(dialog.innerHTML, /外す/, '何をするのかが釦に出ている');
  ctx.__stopTimers();
});

test('やめると何も起きない / 外すと初めて設定が書き換わる', async () => {
  const ctx = await booted();
  const button = ctx.byId('set-eagle-clear');

  button.dispatch('click');
  await new Promise((done) => setImmediate(done));
  let dialog = ctx.document.body.children.find((node) => node.className.includes('confirm'));
  dialog.dispatch('click', { target: { closest: (sel) => (sel === '[data-cancel]' ? {} : null) } });
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(ctx.saved, [], 'やめたら外れない');

  button.dispatch('click');
  await new Promise((done) => setImmediate(done));
  dialog = ctx.document.body.children.find((node) => node.className.includes('confirm'));
  dialog.dispatch('click', { target: { closest: (sel) => (sel === '[data-ok]' ? {} : null) } });
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(plain(ctx.saved), [{ eagleLibrary: '' }], '外すと初めて書き換わる');
  ctx.__stopTimers();
});

// ── 状態の帯 (項目 9-1 / 9-2 / 9-7 / 5-10) ────────────────────

test('帯は一度に一つだけ出し、困る順に選ぶ', async () => {
  const ctx = await booted();
  const show = (status) => { ctx.__harness.state.library = status; ctx.renderNotice(); return ctx.byId('notice'); };

  assert.equal(show({}).hidden, true, '何も無ければ出さない');

  let band = show({ fallbacks: 12 });
  assert.equal(band.hidden, false);
  assert.match(ctx.byId('notice-text').textContent, /12 冊/);

  // 走査が転んでいる方が、焼き場送りより先に出る
  band = show({ fallbacks: 12, scanError: 'ENOENT' });
  assert.match(ctx.byId('notice-text').textContent, /走査に失敗/);
  assert.ok(band.className.includes('warn'), '直らない物は色を変える');

  // 進んでいる仕事が一番先
  band = show({ fallbacks: 12, scanError: 'ENOENT', backfill: { done: 3, total: 10, running: true } });
  assert.equal(ctx.byId('notice-bar').hidden, false, '進みの棒が出る');
  ctx.__stopTimers();
});

test('帯は棚を押し下げない (流れに入らない)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');
  const block = css.match(/\.notice \{([\s\S]*?)\n\}/);
  assert.ok(block, '.notice の定めが無い');
  assert.match(block[1], /position:\s*fixed/, '流れに入れると札が下へずれてガタつく');
  const workspace = css.match(/\.workspace \{([\s\S]*?)\n\}/);
  assert.match(workspace[1], /position:\s*relative/, '重ねる基準が要る');
});

test('畳んだ帯はその起動のあいだ出ない。別の種類は出る', async () => {
  const ctx = await booted();
  ctx.__harness.state.library = { fallbacks: 5 };
  ctx.renderNotice();
  assert.equal(ctx.byId('notice').hidden, false);

  ctx.byId('notice-close').dispatch('click');
  assert.equal(ctx.byId('notice').hidden, true);
  ctx.renderNotice();
  assert.equal(ctx.byId('notice').hidden, true, '畳んだ種類は出さない');

  ctx.__harness.state.library = { fallbacks: 5, scanError: 'EACCES' };
  ctx.renderNotice();
  assert.equal(ctx.byId('notice').hidden, false, '別の種類なら出す');
  ctx.__stopTimers();
});

test('激減で見送った走査は、数を言って次の一手を示す', async () => {
  const ctx = await booted();
  ctx.__harness.state.library = {
    scanError: 'Error', scanDetail: { prev: 21718, kept: 2231 }, flags: {},
  };
  ctx.renderNotice();
  const text = ctx.byId('notice-text').textContent;
  assert.match(text, /21,718/);
  assert.match(text, /2,231/);
  // 一行に収まらない説明は title へ回す (帯は一行に保つ)
  assert.match(ctx.byId('notice').title, /全件を読み直す/, '次に何をすればよいかを言う');
  assert.ok(ctx.byId('notice').className.includes('warn'));
  ctx.__stopTimers();
});

test('帯: 文が切られるより先に進みの棒が縮む / バツの字は丸の中心に来る', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const lines = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8')
    .split(/\r?\n/);
  const block = (name) => {
    const at = lines.indexOf(`${name} {`);
    assert.ok(at >= 0, `${name} の定めが無い`);
    const end = lines.indexOf('}', at);
    return lines.slice(at, end).join(' ');
  };
  // 文は伸び縮みする側。棒は譲る側 (棒が縮まないと文が「Eagle タ…」に切られる)
  assert.match(block('.notice-text'), /flex:\s*1 1 auto/);
  // 幅は JS が中身から決める (CSS の床は置かない)
  assert.ok(!/min-width:\s*min\(/.test(block('.notice')), '帯に幅の床を置かない (文の長さに合わせる)');
  assert.match(block('.notice-text'), /min-width:\s*0/);
  assert.match(block('.notice-bar'), /flex:\s*0 1 /, '棒は縮める');
  // × は box だけ 22px にすると字が左上へ寄る (丸がずれて見える)
  const close = block('.notice-close');
  assert.match(close, /display:\s*flex/);
  assert.match(close, /align-items:\s*center/);
  assert.match(close, /justify-content:\s*center/);
  // 帯は窓に貼る (棚を送っても画面から出ない)
  assert.match(block('.notice'), /position:\s*fixed/);
});

test('帯の幅は文の長さに合わせて変わる', async () => {
  const ctx = await booted();
  const band = ctx.byId('notice');
  const widths = [];
  for (const [key, status] of [
    ['短い', { fallbacks: 3, flags: {} }],
    ['長い', { flags: { 'config-corrupt': 1 } }],
  ]) {
    ctx.__harness.state.library = status;
    ctx.renderNotice();
    widths.push({ key, 幅: band.style.width, 文: ctx.byId('notice-text').textContent.length });
  }
  // 張りぼての DOM では実寸が測れないので「幅が入ること」と「長い方が広いこと」を見る
  assert.ok(widths.every((w) => /^\d+px$/.test(w.幅)), `幅が入っていない: ${JSON.stringify(widths)}`);
  assert.ok(widths[1].文 > widths[0].文, '二つ目の方が長い文であること');
  ctx.__stopTimers();
});

test('閉じる釦は帯を描く側で配線する (bind の並びに依らない)', async () => {
  const ctx = await booted();
  ctx.__harness.state.library = { fallbacks: 9, flags: {} };
  ctx.renderNotice();
  const close = ctx.byId('notice-close');
  assert.ok(close.__listeners.get('click'), '描いた時点で配線されている');
  close.dispatch('click');
  assert.equal(ctx.byId('notice').hidden, true, '押したら閉じる');
  ctx.renderNotice();
  assert.equal(ctx.byId('notice').hidden, true, '描き直しても戻らない');
  ctx.__stopTimers();
});

test('帯は hidden で本当に消える (display を書いた要素は属性だけでは消えない)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');
  // 作者の display 宣言が UA の [hidden]{display:none} に勝つので、
  // display を持つ要素には消す道をこちらで書く。
  // これが無いと帯は一度出たら二度と消えず、閉じる釦も効かない。
  // 今は display:none ではなく opacity+visibility で消している (display:none では
  // 遷移が一切効かないため) ので、見る先は「見えず・触れない」ことそのもの
  const block = css.match(/\.notice\[hidden\] \{([\s\S]*?)\n\}/);
  assert.ok(block, '.notice[hidden] の定めが無い = 閉じられない帯に戻る');
  assert.match(block[1], /opacity:\s*0/, '薄れ切らないと字が残る');
  assert.match(block[1], /visibility:\s*hidden/, 'opacity だけでは読み上げにも当たり判定にも残る');
  assert.match(block[1], /pointer-events:\s*none/, '見えない帯がクリックを食う');
  const bar = css.match(/\.notice-bar\[hidden\] \{([\s\S]*?)\n\}/);
  assert.ok(bar, '棒を消す定めが無い');
  assert.match(bar[1], /display:\s*none/, '棒は席ごと畳む (薄くすると隙間が残る)');
});

// ── 並び順 (2026-09-11 の申告: 「ちょっとしたことで既定に戻る」) ──────────
//
// 根は「一覧の先頭 = 既定」という作りと、描画のたびに派生値を記憶へ書き戻して
// いたこと。所持作品には 人気・今日 が無いので、寄って戻るだけで 追加日 に化けた。

function sortApp(settings = {}) {
  const saved = [];
  const ctx = app({
    settings,
    hitomi: { saveSettings: (partial) => { saved.push(plain(partial)); return partial; } },
  });
  ctx.saved = saved;
  return ctx;
}

test('hitomi は通常の追加日順、他サイトは各サイトの既定で始める', () => {
  const ctx = sortApp();
  const { state } = ctx.__harness;
  assert.equal(ctx.sortForSource('hitomi', 'all'), 'added');
  for (const source of ['nhentai', 'ehentai']) {
    assert.equal(ctx.sortForSource(source, 'all'), 'today', `${source} の既定`);
  }
  // pawchive にだけ人気の「作品」が無い (今日/週/月の区別も無く、返るのは作者)
  assert.equal(ctx.sortForSource('pawchive', 'all'), 'favorites');
  assert.equal(ctx.sortForSource('hitomi', 'library'), 'added', '所持作品は集計を持たない');
  ctx.__stopTimers();
});

test('一覧では人気が順に並ぶ (既定は先頭に縛られない)', () => {
  const ctx = sortApp();
  const { state, els } = ctx.__harness;
  for (const source of ['hitomi', 'nhentai', 'ehentai']) {
    state.source = source;
    state.scope = 'all';
    state.sort = ctx.sortForSource(source, 'all');
    ctx.renderSources();
    // fillSelect は innerHTML を組む (vm の札は options を持たない)
    const labels = [...String(els.sort.innerHTML).matchAll(/>([^<]+)<\/option>/g)]
      .map((hit) => hit[1]);
    const popular = labels.filter((label) => label.startsWith('人気'));
    const at = labels.indexOf(popular[0]);
    assert.deepEqual(
      labels.slice(at, at + popular.length), popular,
      `${source}: 人気が途切れずに並ぶ`,
    );
    assert.equal(at, 0, `${source}: 人気の塊が先頭`);
  }
  ctx.__stopTimers();
});

test('所持作品へ寄って戻っても web の 人気・今日 は戻る', async () => {
  const ctx = sortApp();
  const { state } = ctx.__harness;
  state.source = 'hitomi';
  state.scope = 'all';
  state.sort = 'today';

  await ctx.setScope('library');
  assert.equal(state.sort, 'added', '所持作品に 人気・今日 は無いので 保存日 へ');

  await ctx.setScope('all');
  assert.equal(state.sort, 'today', 'web へ戻れば 人気・今日 に戻る');
  ctx.__stopTimers();
});

test('描き直しただけでは並びを覚えない (弾かれた値が既定を潰さない)', () => {
  const ctx = sortApp();
  const { state } = ctx.__harness;
  state.source = 'hitomi';
  state.scope = 'library';     // ここに 'today' は無い
  state.sort = 'today';
  ctx.renderSources();

  assert.equal(state.sort, 'added', '表に無いので落とす');
  assert.deepEqual(plain(state.sortBySource), {}, '落とした値は記憶に書かない');
  assert.deepEqual(ctx.saved, [], '描画で設定を書き込まない');
  ctx.__stopTimers();
});

test('自分で選んだ並びはサイトとスコープの鍵で覚える', () => {
  const ctx = sortApp();
  const { state } = ctx.__harness;
  state.source = 'hitomi';
  state.scope = 'all';
  state.sort = 'week';
  ctx.rememberSort();

  assert.equal(plain(state.sortBySource)['all:hitomi'], 'week');
  assert.equal(ctx.sortForSource('hitomi', 'all'), 'week', '次に来た時はそれを出す');
  assert.equal(ctx.sortForSource('hitomi', 'library'), 'added', 'スコープが違えば混ざらない');
  assert.ok(ctx.saved.some((row) => row.sortBySource), '保存もする (再起動をまたぐ)');
  ctx.__stopTimers();
});

test('作者の札を開いても並びを 追加日 に差し替えない', () => {
  const ctx = sortApp();
  const { state } = ctx.__harness;
  state.source = 'pawchive';
  state.scope = 'all';
  state.sort = 'favorites';

  assert.equal(ctx.openCreator('pw:fanbox:12345:profile'), true, '作者札として扱う');
  assert.equal(state.query, 'fanbox/12345');
  assert.equal(
    state.sort, 'favorites',
    '並びは利用者の物。ここで 追加日 を押し付けると x で語を消しても戻れない',
  );
  ctx.__stopTimers();
});

// ── 打鍵ごとの引き直し (2026-09-11 の申告:「検索が enter を押さないと反映されない」) ──
//
// 繋ぐだけなら一行だが、そのまま繋ぐと打鍵のたびに棚が消えて 96px の札が生え、
// また消える。利用者が一番嫌うのがそれなので、「結果が来るまで今の棚を残す」を
// 先に直してある。live はもう「履歴に残すか・声を出すか」だけの旗

// 母屋が返す札の形 (sources/normalize.record)。artists などを欠くと
// 描画が落ちるので、実物と同じ骨で作る
const CARD = (id) => ({
  id, title: `t${id}`, pageCount: 1, source: 'hitomi',
  artists: [], groups: [], series: [], characters: [], tags: [],
});

test('引き直しの最中も棚は消えない (読み込み中の空白を作らない)', async () => {
  let release;
  const pending = new Promise((done) => { release = done; });
  const ctx = sortApp();
  ctx.__harness.state.galleries = [CARD('1')];
  ctx.window.hitomi.search = () => pending;

  const run = ctx.runSearch({ reset: true });
  assert.equal(
    ctx.__harness.state.galleries.length, 1,
    '結果が来るまで今の棚を残す (ここを空にしていたのが空白の本体)',
  );

  release({ galleries: [CARD('2')], total: 1, hasNext: false });
  await run;
  assert.equal(ctx.__harness.state.galleries[0].id, '2', '来たら一息で入れ替わる');
  ctx.__stopTimers();
});

test('打鍵ごとの引き直しは履歴にも設定にも残さない', async () => {
  const ctx = sortApp();
  ctx.window.hitomi.search = async () => ({ galleries: [CARD('9')], total: 1, hasNext: false });
  ctx.__harness.state.query = 'kumi';   // 空の語は元から札に残さない

  await ctx.runSearch({ reset: true, live: true });
  assert.deepEqual(ctx.saved, [], '打鍵ごとにディスクへ書かない');

  await ctx.runSearch({ reset: true });
  assert.ok(ctx.saved.length > 0, 'Enter で決めた語は残す');
  ctx.__stopTimers();
});

test('間合いは相手で変える (手元の台帳は早く、網は遅く)', () => {
  const ctx = sortApp();
  const { state } = ctx.__harness;
  state.scope = 'all';
  assert.equal(ctx.liveDelay('kumi'), 450, '網は流量制限があるので遅く');
  state.scope = 'library';
  assert.equal(ctx.liveDelay('kumi'), 150, '手元の台帳は往復が要らない');
  assert.equal(
    ctx.liveDelay(''), 400,
    '空欄へ戻すのは少し待つ (打ち直しの一瞬の空欄で全件一覧へ飛ばないように)',
  );
  ctx.__stopTimers();
});

test('失敗しても、出ている棚は残したまま黙る', async () => {
  const ctx = sortApp();
  const { state } = ctx.__harness;
  state.galleries = [CARD('1')];
  ctx.window.hitomi.search = async () => { throw new Error('網が切れた'); };

  await ctx.runSearch({ reset: true, live: true });
  assert.equal(state.galleries.length, 1, '棚は残る');
  assert.equal(state.page, 0, '何も当てていないので頁の数えは元のまま');
  ctx.__stopTimers();
});

// pixiv: 既定は フォロー (作家追い)。人気の札は先頭に固まる。
// 言語の選択は隠れ、種別の札は pixiv 用の三札 (すべて / 漫画 / R-18) に替わる
test('pixiv の既定はフォローで、人気の札は先頭に固まり、言語は隠れる', () => {
  const ctx = sortApp();
  const { state, els } = ctx.__harness;
  assert.equal(ctx.sortForSource('pixiv', 'all'), 'follow');
  state.source = 'pixiv';
  state.scope = 'all';
  state.sort = ctx.sortForSource('pixiv', 'all');
  ctx.renderSources();
  const labels = [...String(els.sort.innerHTML).matchAll(/>([^<]+)<\/option>/g)].map((hit) => hit[1]);
  const popular = labels.filter((label) => label.startsWith('人気'));
  assert.ok(popular.length >= 3, '人気の札がある');
  assert.deepEqual(labels.slice(0, popular.length), popular, '人気が先頭に途切れず並ぶ');
  assert.ok(labels.includes('ブックマーク'), 'ブックマークはおすすめとは別の取得先');
  assert.ok(labels.includes('フォロー'), 'フォロー が並びの一つ');
  assert.equal(els.language.hidden, true, '言語の選択は隠れる');
  assert.equal(els.types.hidden, false, '種別の札は出る');
  ctx.renderTypes();
  assert.match(String(els.types.innerHTML), /data-type="manga"/, '漫画の札');
  assert.match(String(els.types.innerHTML), /data-type="r18"/, 'R-18 の札');
  assert.doesNotMatch(String(els.types.innerHTML), /data-type="illust"/, 'イラストだけの札は出ない (API に口が無い)');
  assert.doesNotMatch(String(els.types.innerHTML), /data-type="doujinshi"/, '同人誌の札は出ない');
  ctx.__stopTimers();
});

test('候補のホバーはEnterで確定せず、矢印キーで選んだ候補だけ確定する', () => {
  const ctx = app();
  const { state, els } = ctx.__harness;
  ctx.bindSuggest();
  els.query.value = 'にじさんじ';
  els.suggest.hidden = false;
  state.suggestItems = [{ value: 'series:nijisanji', label: 'にじさんじ' }];
  state.suggestIndex = 0;
  state.suggestKeyboard = false;
  let applied = null;
  ctx.applyQuery = (value) => { applied = value; };
  els.query.dispatch('keydown', { key: 'Enter' });
  assert.equal(applied, null);
  assert.equal(els.query.value, 'にじさんじ');
  els.query.dispatch('keydown', { key: 'ArrowDown' });
  els.query.dispatch('keydown', { key: 'Enter', isComposing: true });
  assert.equal(applied, null, 'IME確定は検索候補を選ばない');
  els.query.dispatch('keydown', { key: 'Enter' });
  assert.equal(applied, 'series:nijisanji');
  els.query.dispatch('input');
  assert.equal(state.suggestKeyboard, false);
  assert.equal(state.suggestIndex, -1);
  ctx.__stopTimers();
});

test('所持の判定更新で表示対象が変わった場合だけ一覧を詰め直す', async () => {
  const ctx = app({ settings: { hideOwnedMode: 'owned' }, hitomi: {
    annotate: async list => list.map(item => ({ ...item, owned: true, idOwned: true })),
  } });
  const { state } = ctx.__harness;
  state.scope = 'all';
  state.galleries = [{ id: '123', title: '見本', owned: true, idOwned: false }];
  assert.equal(ctx.visibleGridItems().length, 1, 'タイトル一致のみは確認用に残す');
  let reflows = 0;
  ctx.renderGrid = () => { reflows += 1; };
  await ctx.refreshOwnedMarks();
  assert.equal(ctx.visibleGridItems().length, 0);
  assert.equal(reflows, 1);
  await ctx.refreshOwnedMarks();
  assert.equal(reflows, 1, '所持状態が同じなら再配置しない');
  ctx.__stopTimers();
});

test('詳細の紐付けはpixiv所持作品に出さず、Pawchiveの投稿には残す', () => {
  const ctx=app(); const {els}=ctx.__harness;
  ctx.renderDetail({id:'px:100',source:'pixiv',title:'所持見本',owned:true,idOwned:false,eagleId:'E1',pageCount:12});
  assert.doesNotMatch(els.detailBody.innerHTML,/data-link=/);
  assert.doesNotMatch(els.detailBody.innerHTML,/data-bookmark=/);
  assert.match(els.detailBody.innerHTML,/12ページ/);
  ctx.renderDetail({id:'pw:fanbox:100:200',source:'pawchive',title:'投稿見本',owned:true,idOwned:true,eagleId:'E1',pageCount:12});
  assert.match(els.detailBody.innerHTML,/data-link=/);
  assert.match(els.detailBody.innerHTML,/data-trash=/);
  ctx.__stopTimers();
});

test('作者カードは名前を一度だけ表示し、その横にお気に入りとフォルダ操作を置く', () => {
  const ctx=app();
  const html=ctx.cardMarkup({id:'pw:fanbox:100:profile',source:'pawchive',kind:'creator',title:'見本作者',artists:[{name:'見本作者'}],pageCount:0});
  assert.equal(html.split('見本作者').length-1,1);
  assert.match(html,/creator-actions.*paw-fav.*paw-folder/);
  const coverActions=html.match(/<div class="card-acts">(.*?)<\/div>/)?.[1]||'';
  assert.doesNotMatch(coverActions,/paw-fav|paw-folder|paw-link|pixiv-bookmark/);
  ctx.__stopTimers();
});

test('全サイトで並び方向を選べ、非対応APIでは取得済みの配列だけ反転する', () => {
  const ctx=app({settings:{sortDir:'asc'}}); const {state}=ctx.__harness;
  state.scope='web'; state.sort='added';
  state.galleries=[{id:'3'},{id:'2'},{id:'1'}];
  for(const source of ['nhentai','ehentai','pixiv','pawchive']){
    state.source=source;
    assert.equal(ctx.sortDirSupported(),true);
    assert.equal(ctx.sortDirNativeSupported(),false);
    assert.deepEqual(plain(ctx.visibleGridItems()).map(x=>x.id),['1','2','3']);
    assert.deepEqual(plain(state.galleries).map(x=>x.id),['3','2','1']);
  }
  state.source='hitomi';
  assert.equal(ctx.sortDirNativeSupported(),true);
  assert.deepEqual(plain(ctx.visibleGridItems()).map(x=>x.id),['3','2','1'],'サーバーで並べた順を二重反転しない');
  state.source='pawchive';state.sort='favorites';
  assert.equal(ctx.sortDirNativeSupported(),true);
  ctx.__stopTimers();
});

test('所持作品のタイトル順は元が昇順なので降順時だけ反転する',()=>{
  const ctx=app({settings:{sortDir:'asc'}});const {state}=ctx.__harness;
  state.scope='library';state.source='pixiv';state.sort='title';state.galleries=[{id:'a'},{id:'b'}];
  assert.deepEqual(plain(ctx.visibleGridItems()).map(x=>x.id),['a','b']);
  state.settings.sortDir='desc';
  assert.deepEqual(plain(ctx.visibleGridItems()).map(x=>x.id),['b','a']);
  ctx.__stopTimers();
});

// ── 設定の LAN の行 ──────────────────────────────────────────

test('共有を止めている時の QR は src を空にせず属性ごと外す (空の src は頁を絵として読みに行き error を出す)', () => {
  const ctx = app();
  const { els } = ctx.__harness;
  const writes = [];
  const removed = [];
  for (const img of [els.setLanQrImg, els.setLanTsQrImg]) {
    Object.defineProperty(img, 'src', { configurable: true, get: () => 'data:old', set: (v) => writes.push(v) });
    img.removeAttribute = (name) => removed.push(name);
  }
  ctx.fillLanShare();
  assert.deepEqual(writes, [], "src に '' を入れない");
  assert.deepEqual(removed, ['src', 'src'], '二枚とも src 属性を外す');
  ctx.__stopTimers();
});

test('流し (ウォーターフォール) で並べた時も 該当なし を描き直す (札があるのに「見つかりませんでした」が残っていた)', () => {
  const ctx = app();
  const { state, els } = ctx.__harness;
  ctx.BunkoUI = { renderWaterfall: () => true };
  state.settings = { hideOwnedMode: 'none' };
  state.galleries = [{ id: '1' }, { id: '2' }];
  els.empty.hidden = false;           // 前の 0 件の時に出たまま
  ctx.renderGrid();
  assert.equal(els.empty.hidden, true, '札があるので 該当なし は消える');
  ctx.__stopTimers();
});

test('スクロールバーの出入りで上の帯を横へ揺らさない (溝を常に取っておく)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');
  const block = css.match(/\nhtml \{([\s\S]*?)\n\}/);
  assert.ok(block, 'html の定めが無い');
  assert.match(block[1], /scrollbar-gutter:\s*stable/, '棚が空になる瞬間にスクロールバーが消え、帯が横へずれる');
});

test('送り (scroll の rAF、force=false) では 該当なし を描き直さない (熱い道に全件の filter を置かない)', () => {
  const ctx = app();
  const { state, els } = ctx.__harness;
  ctx.BunkoUI = { renderWaterfall: () => true };
  state.settings = { hideOwnedMode: 'none' };
  state.galleries = [{ id: '1' }];
  els.empty.hidden = false;
  ctx.renderGrid(false, false);
  assert.equal(els.empty.hidden, false, 'force=false では触らない');
  ctx.renderGrid(false, true);
  assert.equal(els.empty.hidden, true, 'force=true (検索・描き直し) では描き直す');
  ctx.__stopTimers();
});

// ── ui-probe で見つけたガタつきの直し (2026-09-27) ────────────────────

test('nhentai で所持を往復すると nhentai へ戻る (所持に入る時に hitomi へ移したのを覚えておく)', async () => {
  const ctx = app({ hitomi: { saveSettings: async () => ({}) } });
  const { state } = ctx.__harness;
  state.settings = {};
  state.source = 'nhentai';
  state.scope = 'all';
  await ctx.setScope('library');
  assert.equal(state.source, 'hitomi', '所持に nhentai は無いので hitomi へ');
  await ctx.setScope('all');
  assert.equal(state.source, 'nhentai', '出る時は元のサイトへ');
  ctx.__stopTimers();
});

test('所持で nhentai の札を押すと、hitomi の全体を引かずにスコープだけ戻してすぐ nhentai へ移る (ui-probe: 0.9 秒後も前のサイトのままだった)', async () => {
  const searches = [];
  let releaseHitomi;
  const ctx = app({ hitomi: {
    saveSettings: async () => ({}),
    cancelSearch: async () => true,
    search: async (payload) => {
      searches.push({ source: payload.source, scope: payload.scope });
      // hitomi の全体はいつまでも返らない (冷えた網): これを待っていたのが前の作り
      if (payload.source === 'hitomi') return new Promise((done) => { releaseHitomi = done; });
      return { galleries: [{ id: 'n1', source: 'nhentai', title: 't' }], total: 1 };
    },
  } });
  const { state, els } = ctx.__harness;
  state.settings = {};
  state.source = 'hitomi';
  state.scope = 'library';
  state.galleries = [];   // 張りぼての DOM は札を組めない (写しの有無だけを見る)
  ctx.renderSources();
  ctx.bindSearchControls();

  // bunko-ui.js の chooseSource と同じ手順: スコープだけ戻し、選べるようになった先へ change で移る
  await ctx.setScope('all', { search: false });
  assert.equal(state.scope, 'all');
  assert.equal(state.source, 'hitomi', '行き先は押した札が決める: 元へ戻す約束は使わない');
  assert.deepEqual(searches, [], 'スコープを戻すだけでは引かない');
  els.source.value = 'nhentai';
  await Promise.all(els.source.__listeners.get('change').map((fn) => fn({})));
  assert.deepEqual(searches, [{ source: 'nhentai', scope: 'all' }], 'hitomi の全体は引かず、nhentai だけを引く');
  assert.equal(state.source, 'nhentai');
  assert.equal(require('node:vm').runInContext('siteSearchSnapshots.has("hitomi")', ctx), false, '所持の棚を hitomi の全体の写しとして取らない');
  ctx.__stopTimers();
});

test('読む画面の「次の作品」は一覧の一つ上 (既定 readerNextOrder=up)。down なら一つ下。前はその反対。作者の札と読めない行は飛ばす', () => {
  const ctx = app();
  const { state } = ctx.__harness;
  state.settings = {};
  state.galleries = [
    { id: '1', source: 'hitomi' },
    { id: 'c', source: 'pixiv', kind: 'creator' },
    { id: '2', source: 'hitomi' },
    { id: 'x', source: 'hitomi', error: 'broken' },
    { id: '3', source: 'hitomi' },
  ];
  const next = (id) => { const g = ctx.readerNeighbor(id, 1); return g ? g.id : null; };
  const prev = (id) => { const g = ctx.readerNeighbor(id, -1); return g ? g.id : null; };
  assert.equal(next('2'), '1', '既定: 次は一つ上 (作者の札を飛ばす)');
  assert.equal(prev('2'), '3', '既定: 前は一つ下 (読めない行を飛ばす)');
  assert.equal(next('1'), null, '端では無し');
  state.settings.readerNextOrder = 'down';
  assert.equal(next('2'), '3', 'down: 次は一つ下');
  assert.equal(prev('2'), '1', 'down: 前は一つ上');
  assert.equal(ctx.readerNeighbor('zz', 1), null, '一覧に居ない作品に隣は無い');
  ctx.__stopTimers();
});

test('所持の間に自分でサイトを替えたら、出る時に元へは戻さない', async () => {
  const ctx = app({ hitomi: { saveSettings: async () => ({}) } });
  const { state } = ctx.__harness;
  state.settings = {};
  state.source = 'nhentai';
  state.scope = 'all';
  await ctx.setScope('library');
  state.source = 'pixiv';                // 利用者が所持のまま pixiv へ (約束の相手と違う)
  await ctx.setScope('all');
  assert.equal(state.source, 'pixiv');
  ctx.__stopTimers();
});

test('詳細の表紙は、寸法か覚えた比が分かれば枠を縦横比で取る (絵の到着で下がずれない)', () => {
  const ctx = app();
  assert.match(ctx.coverAspectStyle({ id: '1', source: 'pixiv', width: 600, height: 839 }), /aspect-ratio:1 \/ 1\.398/);
  assert.equal(ctx.coverAspectStyle({ id: '2', source: 'hitomi' }), '', '分からなければ今までどおり');
  ctx.BunkoUI = { coverRatio: (key) => (key === 'hitomi:3' ? 1.5 : undefined) };
  assert.match(ctx.coverAspectStyle({ id: '3', source: 'hitomi' }), /aspect-ratio:1 \/ 1\.5000/, '一覧で覚えた比を使う');
  assert.match(ctx.coverAspectStyle({ id: '4', source: 'x', width: 100, height: 1000 }), /1 \/ 2\.2000/, '極端な比は流しと同じ幅で丸める');
  ctx.__stopTimers();
});

test('詳細は棚の横の列に出る (本に重ねない) / 所持の時もサイトの札は全部出す / 読む画面の余白', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', 'src', 'renderer');
  const styles = fs.readFileSync(path.join(dir, 'styles.css'), 'utf8');
  const ui = fs.readFileSync(path.join(dir, 'bunko-ui.css'), 'utf8');
  const uiJs = fs.readFileSync(path.join(dir, 'bunko-ui.js'), 'utf8');
  // 利用者の決め (2026-09-27): 重ねる形を試したが下の本が隠れるので、横の列に戻した
  assert.match(ui, /body\.detail-open \.workspace\{margin-right:var\(--detail-w\)\}/, '詳細の幅だけ棚を空ける (本に重ねない)');
  assert.match(styles, /body\.detail-open \.workspace,\s*body\.detail-open \.filters \{\s*margin-right: var\(--detail-w\);/);
  assert.match(uiJs, /navItems\(sourceNav,SOURCES\.map\(/, 'サイトの札を所持で抜くと列が縮んで検索欄が跳ぶ');
  assert.match(styles, /body\.reader-open \{[^}]*padding-right:\s*var\(--reader-scrollbar-gap/, '読む画面で消えるスクロールバーの幅を余白で埋める');
});
