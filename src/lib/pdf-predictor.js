'use strict';

// PDF の stream に掛かっている「予測子」を戻す所。
// Flate/LZW で縮める前に、前の画素や前の行との差に直してあることがある (縮みやすくなる)。
// 2 = TIFF 式 (左隣との差)、10〜15 = PNG 式 (行ごとに手口が 1 バイト前置される)。
// 索引 (xref stream)・束 (object stream)・頁の絵 の三か所で要るので、ここに一本だけ置く。
// 絵は worker で戻すので、電子の窓 (electron) に依存しない素の node で動くこと。

function unpredict(data, predictor, columns, colors = 1, bpc = 8) {
  const kind = Number(predictor) || 1;
  if (kind <= 1) return data;
  const cols = Math.max(1, Number(columns) || 1);
  const comps = Math.max(1, Number(colors) || 1);
  const depth = Number(bpc) || 8;
  // 画素 1 つ分のバイト数 (1 未満なら 1 バイト)
  const bpp = Math.max(1, Math.ceil((comps * depth) / 8));
  const rowLen = Math.ceil((cols * comps * depth) / 8);

  if (kind === 2) {
    // TIFF 式。8 ビット以外は使われないので受けない (誤って通すより焼き場へ回す)
    if (depth !== 8) throw new Error('unsupported tiff predictor depth');
    const out = Buffer.from(data);
    for (let row = 0; row + rowLen <= out.length; row += rowLen) {
      for (let i = bpp; i < rowLen; i += 1) out[row + i] = (out[row + i] + out[row + i - bpp]) & 0xff;
    }
    return out;
  }

  // PNG 式。行ごとに [手口 1 バイト][行の中身 rowLen バイト]
  const stride = rowLen + 1;
  const rows = Math.floor(data.length / stride);
  const out = Buffer.alloc(rows * rowLen);
  let prev = Buffer.alloc(rowLen);
  for (let r = 0; r < rows; r += 1) {
    const how = data[r * stride];
    const src = data.subarray(r * stride + 1, (r + 1) * stride);
    const cur = out.subarray(r * rowLen, (r + 1) * rowLen);
    for (let i = 0; i < rowLen; i += 1) {
      const a = i >= bpp ? cur[i - bpp] : 0;      // 左
      const b = prev[i];                          // 上
      const c = i >= bpp ? prev[i - bpp] : 0;     // 左上
      let x = src[i];
      if (how === 1) x += a;
      else if (how === 2) x += b;
      else if (how === 3) x += (a + b) >> 1;
      else if (how === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        x += pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
      } else if (how !== 0) throw new Error(`bad png predictor ${how}`);
      cur[i] = x & 0xff;
    }
    prev = cur;
  }
  return out;
}

module.exports = { unpredict };
