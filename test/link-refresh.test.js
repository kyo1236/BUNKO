'use strict';

// 紐付けを動かした後の描き直し。題は合成の物だけを使う。
//
// ここで押さえるのは二つ:
//   1. 星を台帳から引き直すこと (annotate は札が持っている星を信じるので、
//      黙って訊くと付け替える前の星が残る)
//   2. 札・詳細・リーダーを **一度の** 問い合わせの答えから描くこと
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadInVm } = require('./helpers/vm-dom');

// vm の中で作られた配列は原型が別の realm の物になる。中身だけ見る
const plain = (value) => JSON.parse(JSON.stringify(value));

// 台帳の代わり。id ごとに「今の星と所持」を持ち、annotate はそれを答える。
// 本物と同じく「札が star を持っていればそれを信じる」枝も写す
function ledger(rows) {
  const calls = [];
  const annotate = async (list) => {
    calls.push((list || []).map((item) => ({
      id: item && item.id,
      hadStar: Boolean(item && Object.prototype.hasOwnProperty.call(item, 'star')),
    })));
    return (list || []).map((item) => {
      const fact = rows[String(item.id)] || { owned: false, star: 0 };
      const kept = Object.prototype.hasOwnProperty.call(item, 'star');
      return {
        ...item,
        owned: fact.owned,
        idOwned: fact.owned,
        similarOwned: false,
        eagleId: fact.eagleId || null,
        linkedEagleId: fact.eagleId || null,
        star: kept ? item.star : fact.star,
      };
    });
  };
  return { annotate, calls };
}

// 本物の札が必ず持っている欄。artistName などが素で読む
function card(id, title) {
  return {
    id, title, source: 'hitomi', artists: [], groups: [], tags: [], pageCount: 1,
  };
}

function app(rows) {
  const book = ledger(rows);
  const ctx = loadInVm('src/renderer/app.js', {
    globals: {
      hitomi: {
        imageBase: async () => 'http://img.test',
        gallery: async (id) => ({ id, pageCount: 0 }),
        openEagle: () => {},
        annotate: book.annotate,
        search: async () => ({ galleries: [], total: 0 }),
        settings: async () => ({}),
        readerActive() {},
      },
    },
  });
  ctx.__harness.state.imageBase = 'http://img.test';
  ctx.book = book;
  return ctx;
}

test('付け替えの後は星を訊き直す (札が持っている古い星を信じない)', async () => {
  // 111 から 222 へ鎖が移った後の台帳。星は Eagle のまま ★4
  const ctx = app({
    111: { owned: false, star: 0 },
    222: { owned: true, star: 4, eagleId: 'SYNTH0001' },
  });
  const { state } = ctx.__harness;
  // 画面が持っている姿は付け替える前のもの (222 は未所持・星なしで描いてある)
  state.galleries = [
    { ...card('111', 'Synthetic One'), owned: true, star: 4 },
    { ...card('222', 'Synthetic Two'), owned: false, star: 0 },
  ];
  state.selected = state.galleries[1];

  await ctx.__harness.refreshAfterLink('111');

  const asked = plain(ctx.book.calls.at(-1));
  assert.ok(asked.every((row) => !row.hadStar), '動いた二つは星を落としてから訊く');
  assert.equal(state.galleries[1].star, 4, '付け替え先に Eagle の星が載る');
  assert.equal(state.galleries[1].owned, true);
  assert.equal(state.galleries[0].star, 0, '外れた側の星は落ちる');
  assert.equal(state.galleries[0].owned, false);
  ctx.__stopTimers();
});

test('星を引き直すのは鎖の動いた札だけ (棚ぜんぶの星は捨てない)', async () => {
  // 所持棚では札の star が本物 (★ の絞り込みと札を食い違わせないための約束)。
  // 付け替えのたびに棚ぜんぶの星を捨てると、分冊の代表星が最高値に化ける
  const ctx = app({
    111: { owned: false, star: 0 },
    222: { owned: true, star: 4, eagleId: 'SYNTH0001' },
    333: { owned: true, star: 4, eagleId: 'SYNTH0003' },
  });
  const { state } = ctx.__harness;
  state.galleries = [
    { ...card('111', 'Synthetic One'), owned: true, star: 4 },
    { ...card('222', 'Synthetic Two'), owned: false, star: 0 },
    // 関係の無い札。棚の問い合わせが持って来た★2 (分冊の片割れ) を守る
    { ...card('333', 'Synthetic Three'), owned: true, star: 2 },
  ];
  state.selected = state.galleries[1];

  ctx.book.calls.length = 0;
  await ctx.__harness.refreshAfterLink('111');

  const asked = plain(ctx.book.calls[0]);
  const hadStar = Object.fromEntries(asked.map((row) => [row.id, row.hadStar]));
  assert.equal(hadStar['111'], false, '外れた側は引き直す');
  assert.equal(hadStar['222'], false, '繋いだ先も引き直す');
  assert.equal(hadStar['333'], true, '関係の無い札の星はそのまま渡す');
  assert.equal(state.galleries[2].star, 2, '棚が持って来た星が最高値に化けない');
  ctx.__stopTimers();
});

test('札・詳細・リーダーは一度の問い合わせの答えから描く', async () => {
  const ctx = app({ 222: { owned: true, star: 4, eagleId: 'SYNTH0001' } });
  const { state } = ctx.__harness;
  const gallery = { ...card('222', 'Synthetic Two'), owned: false, star: 0 };
  state.galleries = [gallery];
  state.selected = gallery;
  state.reader = { gallery };

  ctx.book.calls.length = 0;
  await ctx.__harness.refreshAfterLink();

  assert.equal(ctx.book.calls.length, 1, '問い合わせは一度だけ (合間に走査が挟まらない)');
  assert.equal(state.selected.star, 4, '詳細にも同じ星が載る');
  assert.equal(state.selected.idOwned, true, 'idOwned まで写す (鎖の口の出し分けに要る)');
  assert.equal(state.reader.gallery.star, 4, 'リーダーにも同じ星が載る');
  ctx.__stopTimers();
});

test('一覧に居ない詳細も同じ問い合わせに混ぜる', async () => {
  const ctx = app({
    111: { owned: false, star: 0 },
    999: { owned: true, star: 3, eagleId: 'SYNTH0009' },
  });
  const { state } = ctx.__harness;
  state.galleries = [{ ...card('111', 'Synthetic One'), owned: true, star: 4 }];
  // URL 直開きなどで一覧に居ない作品を詳細に出している
  state.selected = { ...card('999', 'Synthetic Nine'), owned: false, star: 0 };

  ctx.book.calls.length = 0;
  await ctx.__harness.refreshAfterLink();

  assert.equal(ctx.book.calls.length, 1, '二度訊かない');
  assert.deepEqual(plain(ctx.book.calls[0]).map((row) => row.id), ['111', '999'], '一覧の後ろに足して一緒に訊く');
  assert.equal(state.galleries.length, 1, '一覧に余分な行を足さない');
  assert.equal(state.selected.star, 3, '一覧の外の詳細にも星が載る');
  assert.equal(state.selected.owned, true);
  ctx.__stopTimers();
});
