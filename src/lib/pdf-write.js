'use strict';

// 絵をそのまま綴じる。**画素に開かない。**
//
// これまでは隠し窓の印刷 (pdf-builder) に綴じさせていた。Chromium は頁を必ず
// 画素に開いてから紙に焼き直すので、
//   - JPEG の頁 (pawchive) は JPEG のまま入る (これは無駄が無い)
//   - webp/avif の頁 (hitomi・nhentai・e-hentai) は**生の画素 + Flate** で入る
//     (印刷が webp を貼れないため)。33 頁で 44MB の原本が 515MB に膨れる
// 後者が重さの正体で、実測 33 頁の綴じ 14.8 秒のうち 12.0 秒が刷りだった。
//
// ここでやるのは pdf-unpack の裏返し。頁の絵を PDF の絵 (XObject) として
// **バイトのまま**据え、頁には「その絵を紙いっぱいに貼る」とだけ書く。
//   - JPEG の頁 … 一切触らない (読み手もそのまま配るので、綴じ〜読みで無劣化)
//   - PNG の頁 (pixiv) … 8 bit の灰か RGB で非 interlace なら **IDAT をそのまま**据える
//     (/FlateDecode + PNG 式の予測子。pdf-unpack は既にこれを読める)。
//     パレット・透過・16 bit・interlace は worker (sharp) で生画素に開いて可逆で据える
//     (16 bit → 8 bit の丸めだけが例外)。どちらも無劣化 (要件 D5)
//   - それ以外 … worker (sharp) で原寸・色差を間引かない JPEG にする
//
// **webp を JPEG にするのは劣化だが、見え方は今より良くなる。**
// いまの PDF は生画素を可逆で持っているが、`pdf-unpack` は頁を出すたびに
// それを展開して JPEG q90 4:4:4 に焼き直してから読み手へ渡している
// (`unpackPage` の既定 quality = 0.9)。つまり利用者が見ているのは既に q90 で、
// 可逆の画素は一度も画面に出ていない。綴じる時に一度だけ q92 で焼けば、
// 焼き直しは読むたびから綴じる時の一回に減り、しかも q90 → q92 で上がる。
//
// 綴じ方は `pdf-unpack` の「絵 1 枚で全面」の判定を通る形に限る (でないと
// 蔵書が全部焼き場落ちになり、読みが 127ms から 1.4s に戻る)。要は
//   - 頁の Rotate を書かない
//   - MediaBox は [0 0 W H]
//   - 内容は `q W 0 0 H 0 0 cm /Im0 Do Q` だけ (文字も図形も切り抜きも無し)
//   - 絵は /DCTDecode か /FlateDecode・/DeviceRGB か /DeviceGray・8bit。
//     透過は同じ寸法の 8bit 灰の /SMask だけ (pdf-unpack が白地に潰す)
// 釘は test/pdf-write.test.js (JPEG の往復) と test/pdf-write-png.test.js (PNG の往復)。

const fs = require('fs');

// 綴じるための JPEG の質。読み手が頁を出す時の既定 (0.9) より少し上に取る:
// ここで焼いた JPEG は読み手がそのまま配るので、焼くのは生涯この一回だけ
const QUALITY = 0.92;

// 先走って用意する頁の数。worker は 3 本なので少し多めに持たせて遊ばせない。
// 多くしすぎると、用意できた頁のバイトを抱えたまま待つことになる
const AHEAD = 4;

// 紙の寸法は CSS の画素ではなく PDF の単位 (1/72 インチ) で書く。
// Chromium の印刷は CSS 画素 (1/96 インチ) を 0.75 倍して紙にしていたので、
// 同じ倍率にしておくと今までに綴じた蔵書と紙の大きさが揃う
const PT_PER_PX = 0.75;

// 枠 (SOF) のうち、そのまま /DCTDecode に載せてよいもの。
// 可逆 (C3) や算術符号 (C9 以降) は載せられる保証が無いので焼き直しへ回す
const PLAIN_SOF = new Set([0xc0, 0xc1, 0xc2]);

// 画素に開く物の上限 (pdf-unpack の MAX_PIXELS と同じ 40M)。これを超える PNG の
// Flate を据えると読み手が焼き場へ回すので、JPEG に焼く道へ落とす
const MAX_PLANE_PIXELS = 40 * 1000 * 1000;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// 長さを持たないマーカー
function skipMarker(marker) {
  return marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9);
}

// EXIF の向き。1 (そのまま) 以外が付いた JPEG を素通しすると、
// 隠し窓の印刷では回っていた頁が回らずに入る。見つけたら焼き直しへ回す
function exifOrientation(buffer, at, length) {
  const head = at + 4;
  if (head + 14 > buffer.length) return 1;
  if (buffer.toString('ascii', head, head + 6) !== 'Exif\0\0') return 1;
  const tiff = head + 6;
  const order = buffer.toString('ascii', tiff, tiff + 2);
  const le = order === 'II';
  if (!le && order !== 'MM') return 1;
  const u16 = (o) => (le ? buffer.readUInt16LE(o) : buffer.readUInt16BE(o));
  const u32 = (o) => (le ? buffer.readUInt32LE(o) : buffer.readUInt32BE(o));
  if (u16(tiff + 2) !== 42) return 1;
  const ifd = tiff + u32(tiff + 4);
  const end = Math.min(buffer.length, at + 2 + length);
  if (ifd + 2 > end) return 1;
  const count = u16(ifd);
  for (let i = 0; i < count; i += 1) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) break;
    if (u16(entry) === 0x0112) return u16(entry + 8) || 1;
  }
  return 1;
}

// JPEG の素性を頭から読む。そのまま据えてよければ { ok: true, ... }。
// 寸法と色数は **必ずここで読む**: 呼び手が持ってきた寸法を信じて
// /Width /Height に書くと、食い違った時に紙の上で絵が崩れる
function jpegProfile(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  let orientation = 1;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1];
    if (skipMarker(marker)) { offset += 2; continue; }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;
    if (marker === 0xe1) orientation = exifOrientation(buffer, offset, length);
    else if (PLAIN_SOF.has(marker) || (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)) {
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      const channels = buffer[offset + 9];
      const ok = PLAIN_SOF.has(marker) && (channels === 1 || channels === 3)
        && orientation === 1 && width > 0 && height > 0;
      return { ok, width, height, channels };
    }
    offset += 2 + length;
  }
  return null;
}

// PNG の素性を頭から読む。null なら PNG ではない。
// direct: IDAT をそのまま据えてよい形 (8 bit・灰か RGB・非 interlace)。
// それ以外の PNG は { direct: false, why } — 呼び手が生画素に開く
function pngProfile(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33) return null;
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  let offset = 8;
  let header = null;
  const idat = [];
  let palette = false;
  let transparency = false;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > buffer.length) return null;         // 欠けた PNG
    if (type === 'IHDR') {
      header = {
        width: buffer.readUInt32BE(start),
        height: buffer.readUInt32BE(start + 4),
        bitDepth: buffer[start + 8],
        colorType: buffer[start + 9],
        interlace: buffer[start + 12],
      };
    } else if (type === 'IDAT') {
      idat.push(buffer.subarray(start, end));
    } else if (type === 'PLTE') {
      palette = true;
    } else if (type === 'tRNS') {
      transparency = true;
    } else if (type === 'IEND') {
      break;
    }
    offset = end + 4;                                  // CRC を飛ばす
  }
  if (!header || !idat.length || header.width <= 0 || header.height <= 0) return null;
  const channels = header.colorType === 0 ? 1 : header.colorType === 2 ? 3 : 0;
  let why = '';
  if (header.bitDepth !== 8) why = `bpc:${header.bitDepth}`;
  else if (header.interlace) why = 'interlace';
  else if (!channels || palette) why = `color:${header.colorType}`;
  else if (transparency) why = 'trns';
  else if (header.width * header.height > MAX_PLANE_PIXELS) why = 'too-big';
  return {
    ...header,
    channels,
    direct: !why,
    why,
    idat: idat.length === 1 ? idat[0] : Buffer.concat(idat),
  };
}

// 直に綴じられない頁があった時に投げる。pdf-builder はこれを見て**一冊まるごと**
// 隠し窓へ回す (半分だけ直に綴じる、は無し: 頁ごとに道が違うと追えなくなる)
class CannotEmbed extends Error {
  constructor(index, why) {
    super(`pdf-write: ${index} 頁目を直に綴じられない (${why})`);
    this.cannotEmbed = true;
    this.pageIndex = index;
    this.why = why;
  }
}

function num(value) {
  return String(Math.round(value * 100) / 100);
}

// ── 一頁ぶんの絵を用意する ──────────────────────────────────
// 返す形 (kind ごと):
//   dct        { bytes, width, height, channels }                   JPEG そのまま
//   png        { bytes(IDAT), width, height, channels }             PNG の IDAT そのまま
//   flate      { bytes(plane), smask|null, width, height, channels } 生画素の deflate
async function preparePage(page, index, { transcode, expand, tag }) {
  let bytes;
  try {
    bytes = await fs.promises.readFile(page.file);
  } catch (error) {
    // 理由は種別だけ。fs の message には道が入り、道には作品名が乗ることがある
    throw new CannotEmbed(index, `読めない: ${(error && error.code) || 'unknown'}`);
  }
  const kept = jpegProfile(bytes);
  if (kept && kept.ok) {
    return { kind: 'dct', bytes, width: kept.width, height: kept.height, channels: kept.channels, kept: true };
  }
  const png = pngProfile(bytes);
  if (png && png.direct) {
    return { kind: 'png', bytes: png.idat, width: png.width, height: png.height, channels: png.channels, kept: true };
  }
  if (png && png.why !== 'too-big' && typeof expand === 'function') {
    let plane = null;
    try {
      plane = await expand(bytes, { tag });
    } catch (error) {
      throw new CannotEmbed(index, `開けない: ${(error && error.message) || error}`);
    }
    if (plane && plane.plane && plane.width > 0 && plane.height > 0 && (plane.channels === 1 || plane.channels === 3)
      && plane.width * plane.height <= MAX_PLANE_PIXELS) {
      return {
        kind: 'flate',
        bytes: plane.plane,
        smask: plane.smask || null,
        width: plane.width,
        height: plane.height,
        channels: plane.channels,
        kept: true,
      };
    }
    // 開けなかった (sharp が無い等) 時は JPEG に焼く道へ落ちる
  }
  let jpeg = null;
  try {
    jpeg = await transcode(bytes, { tag, quality: QUALITY });
  } catch (error) {
    throw new CannotEmbed(index, `焼けない: ${(error && error.message) || error}`);
  }
  const made = jpegProfile(jpeg);
  if (!made || !made.ok) throw new CannotEmbed(index, '焼いた物が読めない');
  return { kind: 'dct', bytes: jpeg, width: made.width, height: made.height, channels: made.channels, kept: false };
}

// ── 綴じる ──────────────────────────────────────────────────
// 1 = 目録 / 2 = 頁の束 / 頁 i は 3+4i (頁) 4+4i (内容) 5+4i (絵) 6+4i (透過。無ければ null)
const CATALOG = 1;
const PAGES = 2;
const PER_PAGE = 4;
const pageObj = (i) => 3 + i * PER_PAGE;

function writer(fd) {
  let at = 0;
  return {
    put(chunk) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'latin1');
      fs.writeSync(fd, buf);
      at += buf.length;
    },
    // 位置は**バイト数**で数える。文字数で数えると多バイトが混じった時にずれる
    get offset() { return at; },
  };
}

function imageDict(page, id) {
  const space = page.channels === 1 ? '/DeviceGray' : '/DeviceRGB';
  const head = `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height}`
    + ` /ColorSpace ${space} /BitsPerComponent 8`;
  if (page.kind === 'dct') return `${head} /Filter /DCTDecode /Length ${page.bytes.length} >>`;
  if (page.kind === 'png') {
    return `${head} /Filter /FlateDecode`
      + ` /DecodeParms << /Predictor 15 /Colors ${page.channels} /Columns ${page.width} /BitsPerComponent 8 >>`
      + ` /Length ${page.bytes.length} >>`;
  }
  const smask = page.smask ? ` /SMask ${id + 1} 0 R` : '';
  return `${head} /Filter /FlateDecode${smask} /Length ${page.bytes.length} >>`;
}

// 頁を一つ据えたら、その頁のバイトはもう要らない。**溜めずに書く**:
// 全頁ぶんを抱えてから書くと、200 頁の本で数百 MB を一度に持つことになる
// (それを避けるために隠し窓をやめたのに、同じ所で同じ失敗をすることになる)
function document(fd, count) {
  const out = writer(fd);
  const offsets = new Array(2 + count * PER_PAGE + 1).fill(0);
  const open = (id) => { offsets[id] = out.offset; out.put(`${id} 0 obj\n`); };
  const close = () => out.put('endobj\n');

  // 頭の二行目は「この先は文字ではない」の目印 (8bit を落とす道具よけ)
  out.put('%PDF-1.4\n');
  out.put(Buffer.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  open(CATALOG);
  out.put(`<< /Type /Catalog /Pages ${PAGES} 0 R >>\n`);
  close();

  // 頁の番号は決まった式で振るので、中身を見る前に束を書ける
  open(PAGES);
  const kids = Array.from({ length: count }, (_, i) => `${pageObj(i)} 0 R`).join(' ');
  out.put(`<< /Type /Pages /Count ${count} /Kids [${kids}] >>\n`);
  close();

  return {
    page(page, i) {
      const id = pageObj(i);
      const w = page.width * PT_PER_PX;
      const h = page.height * PT_PER_PX;
      // **Rotate は書かない**。回った頁は pdf-unpack が読まずに焼き場へ回す
      open(id);
      out.put(
        `<< /Type /Page /Parent ${PAGES} 0 R /MediaBox [0 0 ${num(w)} ${num(h)}]`
        + ` /Resources << /XObject << /Im0 ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>\n`,
      );
      close();

      // 絵 1 枚を紙いっぱいに貼るだけ。文字も図形も切り抜きも置かない
      const content = Buffer.from(`q ${num(w)} 0 0 ${num(h)} 0 0 cm /Im0 Do Q\n`, 'latin1');
      open(id + 1);
      out.put(`<< /Length ${content.length} >>\nstream\n`);
      out.put(content);
      out.put('endstream\n');
      close();

      open(id + 2);
      out.put(`${imageDict(page, id + 2)}\nstream\n`);
      out.put(page.bytes);
      out.put('\nendstream\n');
      close();

      // 透過の平面 (無い頁は空の物を置いて番号を埋める: 索引は全ての番号に実体が要る)
      open(id + 3);
      if (page.kind === 'flate' && page.smask) {
        out.put(
          `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height}`
          + ` /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${page.smask.length} >>\nstream\n`,
        );
        out.put(page.smask);
        out.put('\nendstream\n');
      } else {
        out.put('null\n');
      }
      close();
    },
    end() {
      const startxref = out.offset;
      const total = offsets.length;
      out.put(`xref\n0 ${total}\n`);
      out.put('0000000000 65535 f \n');
      for (let id = 1; id < total; id += 1) {
        // 一項目は必ず 20 バイト
        out.put(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
      }
      out.put(`trailer\n<< /Size ${total} /Root ${CATALOG} 0 R >>\nstartxref\n${startxref}\n%%EOF\n`);
    },
  };
}

// 頁を綴じて dest に書く。据え直し (.part → 本番) は呼び手の仕事。
// 直に綴じられない頁が一つでもあれば CannotEmbed を投げる (一冊まるごと差し戻し)
async function writePdf(pages, dest, { transcode, expand = null, tag = '' } = {}) {
  if (!pages || !pages.length) throw new Error('ページがありません');
  if (typeof transcode !== 'function') throw new Error('pdf-write: 焼き手がいない');

  const jobs = new Array(pages.length).fill(null);
  const start = (i) => {
    if (i >= pages.length || jobs[i]) return;
    const job = preparePage(pages[i], i, { transcode, expand, tag });
    // 先走りが倒れた時に unhandledRejection を出さない (受け取りは下で待つ)
    job.catch(() => {});
    jobs[i] = job;
  };
  for (let i = 0; i < AHEAD; i += 1) start(i);

  const fd = fs.openSync(dest, 'w');
  try {
    const doc = document(fd, pages.length);
    for (let i = 0; i < pages.length; i += 1) {
      const page = await jobs[i];
      jobs[i] = null;
      doc.page(page, i);
      page.bytes = null;      // 据えた頁のバイトはもう要らない
      page.smask = null;
      start(i + AHEAD);
    }
    doc.end();
  } finally {
    fs.closeSync(fd);
  }
  return { total: pages.length };
}

module.exports = {
  writePdf,
  // テスト用
  jpegProfile, pngProfile, CannotEmbed, PT_PER_PX, QUALITY, PER_PAGE,
};
