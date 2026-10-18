// 画像の実寸をバイト列の頭から読む。
// PDF の頁は 1 枚ごとに実寸の @page を切る (pdf-builder) ので、寸法が分からないと
// 既定の A4 相当に引き伸ばされて絵が歪む。pawchive の API は寸法を返さないため、
// ダウンロードしたバッファから自分で拾う。
//
// 対応は PDF に載せる形式だけ: jpeg / png / webp。分からなければ null を返す

function pngSize(buffer) {
  if (buffer.length < 24) return null;
  if (buffer.readUInt32BE(0) !== 0x89504e47) return null;
  // IHDR は必ず先頭のチャンク: 幅と高さはその中の最初の 8 バイト
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

// SOF (Start Of Frame) に寸法が居る。DHT/DQT などの可変長セグメントを
// 長さぶんだけ飛ばして探す。SOF4(DHT)/SOF8/SOF12 は枠ではないので除く
const SOF = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function jpegSize(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    // 詰め物の 0xff と、長さを持たないマーカーは読み飛ばす
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;
    if (SOF.has(marker)) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

function webpSize(buffer) {
  if (buffer.length < 30) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') return null;
  const kind = buffer.toString('ascii', 12, 16);
  if (kind === 'VP8 ') {
    // 可逆でない VP8: キーフレームの頭 3 バイトを跨いだ先に 14 ビットずつ
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  if (kind === 'VP8L') {
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (kind === 'VP8X') {
    // 拡張形式は 24 ビットの「実寸 - 1」を 3 バイトずつ並べる
    const width = buffer.readUIntLE(24, 3) + 1;
    const height = buffer.readUIntLE(27, 3) + 1;
    return { width, height };
  }
  return null;
}

function imageSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return null;
  let size = null;
  try {
    size = pngSize(buffer) || jpegSize(buffer) || webpSize(buffer);
  } catch {
    // 途中で切れたファイルは読めない: 寸法なしとして扱う
    return null;
  }
  if (!size) return null;
  const width = Number(size.width);
  const height = Number(size.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

// 中身から種別を決める。名前は当てにならない:
// Eagle のサムネイルは中身が WebP でも <名前>_thumbnail.png と付く。
// 拡張子を信じて Content-Type を名乗ると、宣言と中身が食い違う
// (nosniff を付けている口では、それで絵が出ないことがある)
function imageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return '';
  if (buffer.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (buffer.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  // ISO BMFF: 4 バイト目から 'ftyp'、その次が銘柄 (avif / avis / heic …)
  if (buffer.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buffer.toString('ascii', 8, 12);
    if (brand.startsWith('avi')) return 'image/avif';
    if (brand.startsWith('hei') || brand.startsWith('mif')) return 'image/heic';
  }
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp';
  return '';
}

module.exports = { imageSize, imageType };
