'use strict';

// PDF の一頁を出す三段。机上版 (main) と手のひら版 (lan-server) が同じ道を通る。
//
//   1. 綴じ目から直に抜く (pdf-unpack)。蔵書の 95% はここで、
//      JPEG の頁なら原本のバイトをそのまま配る (符号化ゼロ・無劣化)
//   2. 取り下げ (DROPPED) なら表の仕事として一度だけやり直す。
//      裏の用意を取り下げた仕事に表の要求が相乗りしていることがあり
//      (控えが同じ鍵で待ち合わせる)、そのまま返すとその頁だけ出ないまま残る
//   3. それでも駄目なら焼き場 (page-baker の隠し窓) へ
//
// 以前は同じ三段が二箇所に書かれていて、片方だけ直すと机上と手のひらで
// 出方が食い違う形になっていた (項目 8-2)。

const pdfUnpack = require('./pdf-unpack');
const pageBaker = require('./page-baker');

// file: PDF の道 / index: 0 始まりの頁
// want: { width, quality } — width 0 は原寸
// options: { background, tag } — 裏の用意かどうかと、取り下げの札
// bake: 焼き場へ回す時の形 ({ width, format, options })。省くと want から組む
async function renderPdfPage(file, index, want, options = {}, bake = {}) {
  let direct = await pdfUnpack
    .unpackPage(file, index, { ...want, ...options })
    .catch(() => null);

  if (direct === pdfUnpack.DROPPED) {
    // 表の仕事として一度だけやり直す (裏の札を外して頼み直す)
    direct = await pdfUnpack.unpackPage(file, index, want).catch(() => null);
    if (direct === pdfUnpack.DROPPED) return null;
  }
  if (direct) return { ...direct, name: String(index) };

  const width = bake.width === undefined ? want.width : bake.width;
  const format = bake.format || 'jpeg';
  const bakeOptions = bake.options || { quality: want.quality, ...options };
  const baked = await pageBaker.bakePdfPage(file, index, width, format, bakeOptions);
  return baked ? { ...baked, name: String(index) } : null;
}

// 小さく出す一枚 (頁一覧の小札・棚の表紙)。**表の頁と作法が違う**:
//   - 取り下げられたら諦める (次に見えた時にまた頼まれる。表のようにやり直さない)
//   - 行列が違う (lane):
//       'idle' 頁一覧の小札。一度に何十枚も来るので読んでいる頁に道を譲り、
//              本を替えれば取り下げられる
//       'soon' 棚の表紙。それ自体が利用者の待っている物なので 'idle' には置けない
//              (本の裏の用意 何百頁の後ろに並んで札が何秒も空になる) が、
//              頁の送りより先に出る必要も無い
// 取り下げ (DROPPED) の扱いをここへ集めておくのは、呼び手ごとに書くと
// 片方だけ直る形になるため
async function renderPdfThumb(file, index, want, tag, { lane = 'idle' } = {}) {
  const direct = await pdfUnpack
    .unpackPage(file, index, { ...want, lane, tag: tag || '' })
    .catch(() => null);
  if (direct === pdfUnpack.DROPPED) return null;
  if (direct) return { ...direct, name: String(index) };
  // 焼き場は行列が二本しかない。譲るのは取り下げてよい仕事だけ
  const baked = await pageBaker.bakePdfPage(file, index, want.width, 'jpeg', {
    quality: want.quality, background: lane === 'idle',
  });
  return baked ? { ...baked, name: String(index) } : null;
}

module.exports = { renderPdfPage, renderPdfThumb };
