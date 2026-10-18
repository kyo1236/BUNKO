// Range ヘッダの解釈だけを切り出したもの。所持作品の PDF は数百 MB になることがあり、
// pdf.js に頭から丸ごと渡していると最初の 1 枚が出るまで待たされる: 要る所だけ配るために使う
'use strict';

// 返り値: null = 範囲指定なし / 解せない (丸ごと 200 で返す)
//         { unsatisfiable: true } = 416 を返すべき
//         { start, end } = 両端を含む 206 の範囲
function parseRange(header, size) {
  const raw = String(header || '').trim();
  if (!raw) return null;
  const hit = raw.match(/^bytes=(.*)$/i);
  if (!hit) return null;             // bytes 以外の単位は無視してよい (RFC 9110)
  const spec = hit[1].trim();
  if (!spec || spec.includes(',')) return null;  // 複数範囲は相手をしない: 丸ごと返す方が安い
  const parts = spec.split('-');
  if (parts.length !== 2) return null;
  const head = parts[0].trim();
  const tail = parts[1].trim();
  const total = Number(size);
  if (!Number.isFinite(total) || total < 0) return null;

  // bytes=-n : 末尾 n バイト。pdf.js は xref を読みに来るので必ず要る
  if (head === '') {
    if (!/^\d+$/.test(tail)) return null;
    const want = Number(tail);
    if (want <= 0 || total <= 0) return { unsatisfiable: true };
    return { start: Math.max(0, total - want), end: total - 1 };
  }

  if (!/^\d+$/.test(head)) return null;
  const start = Number(head);
  if (start >= total) return { unsatisfiable: true };  // 範囲外は 416 で知らせる

  // bytes=a- : そこから最後まで
  if (tail === '') return { start, end: total - 1 };
  if (!/^\d+$/.test(tail)) return null;
  const end = Math.min(Number(tail), total - 1);
  if (end < start) return null;      // 逆さの指定は壊れている: 無視して丸ごと返す
  return { start, end };
}

module.exports = { parseRange };
