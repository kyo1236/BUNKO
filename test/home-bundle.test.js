'use strict';

// Home の作者頁の束ね (src/renderer/home-bundle.js)。docs/home-tab-spec-2026-09-23.md の「表示の切り替えと束ね」、
// 考え方は docs/light-logic-and-fun-features-2026-09-23.md §3・§4-3。
// 押さえるのは:
//   題の鍵 (飾り・即売会の記号・見本や告知の語・頁数の印は剥がし、巻数は残す。『』の中身も鍵)
//   役 (決め手の規則 A1〜A5 はその場で決める。点の規則は 2 点差の時だけ。点だけの役は畳む理由にしない)
//   畳み (代表は 揃った本 → 所持 → 頁が多い。代表より頁の多い物は畳まない = 所持が見本だけでも網の本体を隠さない)
//   結びの守り (決まり文句と同じ源泉で三度以上の鍵は三日以内だけ、短い鍵は 120 日以内だけ、店の URL は製品を語る投稿だけ)
// 題はすべて架空 (実在の作品は使わない)。

const test = require('node:test');
const assert = require('node:assert/strict');
const HomeBundle = require('../src/renderer/home-bundle');

function book(id, origin, title, {
  pages = 20, date = '2024-08-20', owned = false, caption = '', tags = [], type = '', series = null,
  galleryOwned = false, idOwned = false, event = null,
} = {}) {
  return {
    id,
    origin,
    candidate: false,
    date,
    event,
    owned,
    gallery: {
      id,
      title,
      pageCount: pages,
      caption,
      tags: tags.map((name) => ({ type: 'tag', name })),
      type,
      series,
      owned: owned || galleryOwned,
      idOwned: owned || idOwned,
    },
  };
}

const info = (marks, id) => marks.get(String(id));

test('題の鍵: 先頭の即売会とサークル、末尾の注記、見本と告知の語、頁数の印を剥がす。巻数は残す', () => {
  const plain = HomeBundle.titleKeys('架空題甲');
  assert.deepEqual(plain, ['架空題甲']);
  assert.deepEqual(HomeBundle.titleKeys('(C104) [架空サークル (架空作者)] 架空題甲 (オリジナル) [DL版]'), plain);
  assert.deepEqual(HomeBundle.titleKeys('【C104新刊】架空題甲【サンプル】'), plain);
  assert.deepEqual(HomeBundle.titleKeys('架空題甲【28P】'), plain);
  assert.ok(HomeBundle.titleKeys('C104新刊『架空題甲』サンプル 6P').includes('架空題甲'), '『』の中身も鍵');
  assert.notDeepEqual(HomeBundle.titleKeys('架空題甲 (2)'), plain, '巻数は飾りではない');
  assert.notDeepEqual(HomeBundle.titleKeys('架空題甲 [上]'), plain);
  assert.deepEqual(HomeBundle.titleKeys('ab'), [], '短すぎる題は鍵にしない');
});

test('宣言の頁数: 仕様の一行 (B5/28P/700円・全24ページ・【16P】)。3 頁以下は宣言とみなさない', () => {
  assert.equal(HomeBundle.declaredPages('B5/28P/700円'), 28);
  assert.equal(HomeBundle.declaredPages('新刊 全24ページ'), 24);
  assert.equal(HomeBundle.declaredPages('架空題甲【16P】'), 16);
  assert.equal(HomeBundle.declaredPages('表紙1P'), 0);
});

test('役の決め手: [見本]・[ページ欠落]・続きは FANBOX・宣言より少ない頁・お品書き', () => {
  const a1 = HomeBundle.roleOf(book('1', 'hitomi', '(C104) [架空] 架空題甲 [見本]'));
  assert.equal(a1.role, 'sample');
  assert.equal(a1.sure, true);
  const a2 = HomeBundle.roleOf(book('2', 'hitomi', '架空題甲 [ページ欠落]'));
  assert.equal(a2.incomplete, true, '欠け版は代表にしない印');
  const a3 = HomeBundle.roleOf(book('3', 'pixiv', '架空題甲', { pages: 4, caption: '続きはFANBOXで公開しています' }));
  assert.deepEqual([a3.role, a3.sure], ['sample', true]);
  const profile = HomeBundle.roleOf(book('4', 'pixiv', '架空題乙', { pages: 1, caption: 'FANBOX: https://example.fanbox.cc/' }));
  assert.notEqual(profile.role, 'sample', 'FANBOX のプロフィールの URL (説明の定型) だけでは見本にしない');
  const a4 = HomeBundle.roleOf(book('5', 'pixiv', '架空題丙', { pages: 6, caption: 'B5/28P/700円' }));
  assert.deepEqual([a4.role, a4.sure, a4.declared], ['sample', true, 28]);
  const a5 = HomeBundle.roleOf(book('6', 'pixiv', '【お品書き】C105', { pages: 2 }));
  assert.deepEqual([a5.role, a5.sure], ['notice', true]);
});

test('役の点: 一番が二番より 2 点以上高い時だけ決める。決まらなければ頁数で本体か一枚絵 (未判定)', () => {
  const full = HomeBundle.roleOf(book('10', 'hitomi', '架空題甲', { pages: 20 }));
  assert.deepEqual([full.role, full.sure, full.decided], ['main', false, true], 'hitomi の 8 頁以上は本体の点');
  const single = HomeBundle.roleOf(book('11', 'pixiv', '架空題乙', { pages: 1 }));
  assert.deepEqual([single.role, single.decided], ['single', false]);
  const close = HomeBundle.roleOf(book('12', 'pixiv', '架空題丙', { pages: 3, tags: ['新刊'] }));
  assert.equal(close.decided, false, '見本 2 点・告知 1 点は 1 点差なので決めない');
  const variant = HomeBundle.roleOf(book('13', 'pawchive', '架空題丁 表情差分', { pages: 6 }));
  assert.deepEqual([variant.role, variant.decided], ['variant', true]);
  assert.equal(HomeBundle.roleBadge({ ...variant }), '差分?', '点だけの役は ? を添える');
  assert.equal(HomeBundle.roleBadge({ role: 'sample', sure: true, decided: true }), '見本');
  assert.equal(HomeBundle.roleBadge(full), '', '本体と一枚絵は印にしない');
});

test('畳み: 所持の本と同じ作品の網の写しは所持の版違い (同) として畳む', () => {
  const marks = HomeBundle.mark([
    book('pweagle:A1', 'pawchive', '架空題甲', { pages: 24, owned: true }),
    book('88', 'hitomi', '(C104) [架空] 架空題甲 [DL版]', { pages: 26 }),
    book('px:5', 'pixiv', '【C104新刊】架空題甲【サンプル】', { pages: 4, date: '2024-07-30' }),
    book('px:6', 'pixiv', '架空題乙', { pages: 1 }),
  ]);
  assert.equal(info(marks, 'pweagle:A1').representative, true, '代表は所持の本');
  assert.equal(info(marks, 'pweagle:A1').folded, false);
  assert.deepEqual([info(marks, '88').folded, info(marks, '88').as], [true, 'similar'], '頁の近い網の写し');
  assert.deepEqual([info(marks, 'px:5').folded, info(marks, 'px:5').as], [true, 'similar'], '代表より頁の少ない見本');
  assert.equal(info(marks, 'px:6').folded, false, '別の作品は畳まない');
  assert.equal(info(marks, 'px:6').cluster, null);
});

test('畳み: 所持が見本だけなら、網の本体を隠さない (代表は揃った本。所持の見本も Eagle に在るので畳まない)', () => {
  const marks = HomeBundle.mark([
    book('px:9', 'pixiv', '架空題甲', { pages: 6, owned: true, caption: 'B5/28P/700円' }),
    book('77', 'hitomi', '(C104) [架空] 架空題甲', { pages: 28 }),
  ]);
  assert.equal(info(marks, '77').folded, false, '網の本体は見せる');
  assert.equal(info(marks, '77').representative, true);
  assert.equal(info(marks, 'px:9').folded, false, '所持の見本は代表でなくても見せる');
  assert.equal(info(marks, 'px:9').cluster, info(marks, '77').cluster, '束には入ったまま');
});

test('畳み: 同じ作品を二版とも所持していれば、どちらも畳まない。網の写しは所持の版違いとして畳む', () => {
  const marks = HomeBundle.mark([
    book('eagle:A', 'local', '(C104) [架空] 架空題甲', { pages: 24, owned: true }),
    book('eagle:B', 'local', '架空題甲 [DL版]', { pages: 24, owned: true }),
    book('eagle:C', 'local', '架空題甲【サンプル】', { pages: 4, owned: true }),
    book('88', 'hitomi', '架空題甲', { pages: 25 }),
  ]);
  for (const id of ['eagle:A', 'eagle:B', 'eagle:C']) assert.equal(info(marks, id).folded, false, `${id} は Eagle に在る`);
  assert.deepEqual([info(marks, '88').folded, info(marks, '88').as], [true, 'similar']);
});

test('畳み: 代表より頁の多い物は畳まない。代表の無い見本だけの束は見本どうしで重ねる', () => {
  const marks = HomeBundle.mark([
    book('pw:fanbox:1:10', 'pawchive', '架空題甲 差分', { pages: 10 }),
    book('px:11', 'pixiv', '架空題甲', { pages: 1 }),
  ]);
  assert.equal(info(marks, 'pw:fanbox:1:10').representative, true, '頁の多い差分の組が代表');
  assert.deepEqual([info(marks, 'px:11').folded, info(marks, 'px:11').as], [true, 'dupe'], '一枚の絵はその組に重ねる');

  const big = HomeBundle.mark([
    book('pweagle:B1', 'pawchive', '架空題乙', { pages: 12, owned: true }),
    book('66', 'hitomi', '架空題乙', { pages: 40 }),
  ]);
  assert.equal(info(big, '66').folded, false, '所持より大きく違う版は見せる');
});

test('畳み: 決め手で見本と決まった物は、見本でない代表の下なら頁が多くても畳む (本体が PDF 一つの添付の投稿)', () => {
  const marks = HomeBundle.mark([
    book('pw:fanbox:1:70', 'pawchive', '架空題甲', { pages: 1 }),
    book('px:71', 'pixiv', '【C104新刊】架空題甲', { pages: 11, caption: 'B5/28P/700円' }),
  ]);
  assert.equal(info(marks, 'pw:fanbox:1:70').representative, true, '見本と決まった物は代表にしない');
  assert.deepEqual([info(marks, 'px:71').folded, info(marks, 'px:71').as], [true, 'dupe']);

  // 点だけの役 (ラフ = 告知の点) は、代表より頁の多い物を畳む理由にならない
  const guess = HomeBundle.mark([
    book('pweagle:C1', 'pawchive', '架空題乙', { pages: 12, owned: true }),
    book('px:73', 'pixiv', '架空題乙 ラフ', { pages: 30 }),
  ]);
  assert.equal(info(guess, 'px:73').folded, false);
});

test('結びの守り: 決まり文句は三日以内、同じ源泉で三度以上の鍵も三日以内、短い鍵は 120 日以内', () => {
  const generic = HomeBundle.mark([
    book('px:1', 'pixiv', 'ラクガキ', { pages: 1, date: '2024-01-10' }),
    book('px:2', 'pixiv', 'ラクガキ', { pages: 1, date: '2024-03-10' }),
    book('pw:fanbox:1:3', 'pawchive', 'ラクガキ', { pages: 1, date: '2024-06-10' }),
    book('pw:fanbox:1:4', 'pawchive', 'ラクガキ', { pages: 3, date: '2024-01-11' }),
  ]);
  assert.equal(info(generic, 'px:2').folded, false, '月の違う決まり文句は結ばない');
  assert.equal(info(generic, 'pw:fanbox:1:3').folded, false);
  assert.equal(info(generic, 'px:1').folded, true, '同じ頃の同じ投稿 (pixiv と FANBOX) は結ぶ');

  const repeated = HomeBundle.mark([
    book('px:21', 'pixiv', '架空題甲', { pages: 1, date: '2023-01-01' }),
    book('px:22', 'pixiv', '架空題甲', { pages: 1, date: '2023-06-01' }),
    book('px:23', 'pixiv', '架空題甲', { pages: 1, date: '2024-01-01' }),
    book('90', 'hitomi', '架空題甲', { pages: 20, date: '2024-08-01' }),
  ]);
  assert.equal(info(repeated, 'px:21').folded, false, '同じ源泉で三度使われた鍵は連載の決まり文句とみなす');

  const shortFar = HomeBundle.mark([
    book('px:31', 'pixiv', '夏空', { pages: 1, date: '2024-01-01' }),
    book('pw:fanbox:1:32', 'pawchive', '夏空', { pages: 1, date: '2024-08-01' }),
  ]);
  assert.equal(info(shortFar, 'px:31').cluster, null, '短い鍵は日付が離れていれば結ばない');
  const shortNear = HomeBundle.mark([
    book('px:41', 'pixiv', '夏空', { pages: 1, date: '2024-07-01' }),
    book('pw:fanbox:1:42', 'pawchive', '夏空', { pages: 4, date: '2024-07-20' }),
  ]);
  assert.equal(info(shortNear, 'px:41').folded, true);

  const volumes = HomeBundle.mark([
    book('91', 'hitomi', '架空題丙 (2)', { pages: 20 }),
    book('92', 'hitomi', '架空題丙', { pages: 20 }),
  ]);
  assert.equal(info(volumes, '91').cluster, null, '巻の違いは別の作品');
});

test('店の URL: 製品を語る投稿どうしだけを結ぶ (説明の定型の店の URL で無関係の絵を束ねない)', () => {
  const linked = HomeBundle.mark([
    book('px:51', 'pixiv', '新刊のお知らせ', { pages: 1, caption: '通販はこちら https://example.booth.pm/items/123456' }),
    book('px:52', 'pixiv', '架空題甲 サンプル', { pages: 6, caption: '新刊サンプルです https://example.booth.pm/items/123456' }),
  ]);
  assert.equal(info(linked, 'px:51').cluster !== null, true);
  const unrelated = HomeBundle.mark([
    book('px:61', 'pixiv', '架空題乙', { pages: 1, caption: 'https://example.booth.pm/items/123456' }),
    book('px:62', 'pixiv', '架空題丙 サンプル', { pages: 6, caption: '新刊サンプル https://example.booth.pm/items/123456' }),
  ]);
  assert.equal(info(unrelated, 'px:61').cluster, null);
});
