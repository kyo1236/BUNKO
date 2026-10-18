'use strict';

// pdf-write の PNG の道 (要件 D5: PNG も無劣化で綴じる)。
//
// 釘は三つ:
//   1. 8 bit の灰・RGB・非 interlace の PNG は **IDAT のバイトがそのまま** PDF に入る
//      (Flate + PNG 式の予測子)。pdf-unpack がそれを「絵 1 枚で全面」と読める
//   2. パレット・透過・16 bit・interlace は生画素に開いて可逆で入る (透過は SMask)。
//      据えた画素は PNG を開いた画素と一致する
//   3. どの形でも読み手 (pdf-unpack) が直に抜ける (焼き場に落ちない)

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const pdfUnpack = require('../src/lib/pdf-unpack');
const { unpredict } = require('../src/lib/pdf-predictor');
const { writePdf, pngProfile, PER_PAGE } = require('../src/lib/pdf-write');

let sharp = null;
try {
  sharp = require('sharp');
} catch {
  sharp = null;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-write-png-'));
test.after(async () => {
  await pdfUnpack.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const W = 40;
const H = 30;

function rgbBytes(seed, channels = 3) {
  const raw = Buffer.alloc(W * H * channels);
  for (let i = 0; i < W * H; i += 1) {
    for (let c = 0; c < channels; c += 1) raw[i * channels + c] = (i * (7 + c * 6) + seed * 31 + c * 17) & 0xff;
  }
  return raw;
}

const transcode = (bytes) => sharp(bytes).rotate()
  .jpeg({ quality: 92, chromaSubsampling: '4:4:4', mozjpeg: false }).toBuffer();
const expand = (bytes) => pdfUnpack.pagePlaneBytes(bytes, { tag: 'test' });

function put(name, bytes) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return { file, width: W, height: H };
}

// PDF の中の絵 (頁 i の XObject) の辞書と stream を取り出す
function imageObject(pdf, i, which = 2) {
  const id = 3 + i * PER_PAGE + which;
  const head = pdf.indexOf(Buffer.from(`\n${id} 0 obj\n`));
  assert.ok(head >= 0, `${id} 0 obj が無い`);
  const dictStart = head + `\n${id} 0 obj\n`.length;
  const streamAt = pdf.indexOf(Buffer.from('\nstream\n'), dictStart);
  const dict = pdf.toString('latin1', dictStart, streamAt);
  const length = Number((dict.match(/\/Length (\d+)/) || [])[1]);
  const start = streamAt + '\nstream\n'.length;
  return { dict, bytes: pdf.subarray(start, start + length) };
}

test('8 bit RGB の PNG は IDAT がそのまま入り、pdf-unpack が直に読める', async (t) => {
  if (!sharp) return t.skip('sharp が無い');
  const raw = rgbBytes(1);
  const png = await sharp(raw, { raw: { width: W, height: H, channels: 3 } }).png({ compressionLevel: 6 }).toBuffer();
  const profile = pngProfile(png);
  assert.ok(profile && profile.direct, `直に据えられる形 (${profile && profile.why})`);
  assert.strictEqual(profile.channels, 3);

  const dest = path.join(dir, 'rgb.pdf');
  await writePdf([put('rgb.png', png)], dest, { transcode, expand });
  const pdf = fs.readFileSync(dest);
  const image = imageObject(pdf, 0);
  assert.match(image.dict, /\/Filter \/FlateDecode/);
  assert.match(image.dict, /\/Predictor 15 \/Colors 3 \/Columns 40 \/BitsPerComponent 8/);
  assert.match(image.dict, /\/ColorSpace \/DeviceRGB/);
  assert.ok(image.bytes.equals(profile.idat), 'IDAT のバイトがそっくりそのまま');
  // 予測子を戻すと元の画素
  const plane = unpredict(zlib.inflateSync(image.bytes), 15, W, 3, 8);
  assert.ok(plane.equals(raw), '画素が一致する (無劣化)');

  // 読み手が直に抜ける (焼き場に落ちない)
  const detail = await pdfUnpack.readPageDetail(dest, 0);
  assert.ok(!detail.reason, `直読みできない: ${detail.reason}`);
  const page = await pdfUnpack.unpackPage(dest, 0, {});
  assert.ok(page && page.bytes && page.bytes.length, '頁が出る');
});

// 灰の PNG は自前で組む (sharp は 1 成分の生画素も RGB の PNG に書き出すことがある)
function crc32(buf) {
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n += 1) {
    let c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function grayPng(raw, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;           // bit depth
  ihdr[9] = 0;           // color type 0 = gray
  const rows = [];
  for (let y = 0; y < h; y += 1) rows.push(Buffer.from([0]), raw.subarray(y * w, (y + 1) * w));
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature, pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

test('8 bit 灰の PNG も IDAT のまま (/DeviceGray, Colors 1)', async (t) => {
  if (!sharp) return t.skip('sharp が無い');
  const raw = rgbBytes(2, 1);
  const png = grayPng(raw, W, H);
  const profile = pngProfile(png);
  assert.ok(profile && profile.direct && profile.channels === 1, `灰 (${profile && profile.why})`);
  const dest = path.join(dir, 'gray.pdf');
  await writePdf([put('gray.png', png)], dest, { transcode, expand });
  const image = imageObject(fs.readFileSync(dest), 0);
  assert.match(image.dict, /\/DeviceGray/);
  assert.match(image.dict, /\/Colors 1 \/Columns 40/);
  assert.ok(unpredict(zlib.inflateSync(image.bytes), 15, W, 1, 8).equals(raw));
  const detail = await pdfUnpack.readPageDetail(dest, 0);
  assert.ok(!detail.reason, `直読みできない: ${detail.reason}`);
});

test('パレットの PNG は生画素に開いて可逆で入る (Flate、予測子なし)', async (t) => {
  if (!sharp) return t.skip('sharp が無い');
  const raw = rgbBytes(3);
  const png = await sharp(raw, { raw: { width: W, height: H, channels: 3 } }).png({ palette: true, colours: 64 }).toBuffer();
  const profile = pngProfile(png);
  assert.ok(profile && !profile.direct, 'パレットは直には据えない');
  assert.match(profile.why, /color:3/);
  // 開いた画素 (パレットの量子化後) と同じ物が PDF に入る
  const expected = await sharp(png).removeAlpha().raw().toBuffer();
  const dest = path.join(dir, 'palette.pdf');
  await writePdf([put('palette.png', png)], dest, { transcode, expand });
  const image = imageObject(fs.readFileSync(dest), 0);
  assert.match(image.dict, /\/Filter \/FlateDecode/);
  assert.doesNotMatch(image.dict, /Predictor/);
  assert.ok(zlib.inflateSync(image.bytes).equals(expected), '画素が一致する');
  const detail = await pdfUnpack.readPageDetail(dest, 0);
  assert.ok(!detail.reason, `直読みできない: ${detail.reason}`);
});

test('透過の PNG は本体 + SMask で入り、読み手は白地に潰して出す', async (t) => {
  if (!sharp) return t.skip('sharp が無い');
  const rgb = rgbBytes(4);
  const rgba = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i += 1) {
    rgba[i * 4] = rgb[i * 3];
    rgba[i * 4 + 1] = rgb[i * 3 + 1];
    rgba[i * 4 + 2] = rgb[i * 3 + 2];
    rgba[i * 4 + 3] = (i * 5) & 0xff;
  }
  const png = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  const profile = pngProfile(png);
  assert.ok(profile && !profile.direct, '透過は直には据えない');
  const dest = path.join(dir, 'alpha.pdf');
  await writePdf([put('alpha.png', png)], dest, { transcode, expand });
  const pdf = fs.readFileSync(dest);
  const image = imageObject(pdf, 0);
  assert.match(image.dict, /\/SMask \d+ 0 R/);
  assert.ok(zlib.inflateSync(image.bytes).equals(rgb), '本体の画素が一致する');
  const mask = imageObject(pdf, 0, 3);
  assert.match(mask.dict, /\/DeviceGray/);
  const alpha = Buffer.from(Array.from({ length: W * H }, (_, i) => (i * 5) & 0xff));
  assert.ok(zlib.inflateSync(mask.bytes).equals(alpha), '透過の平面が一致する');
  const detail = await pdfUnpack.readPageDetail(dest, 0);
  assert.ok(!detail.reason, `直読みできない: ${detail.reason}`);
  const page = await pdfUnpack.unpackPage(dest, 0, {});
  assert.ok(page && page.bytes.length, '白地に潰した頁が出る');
});

test('16 bit の PNG は 8 bit に丸めて入る (D5 の唯一の例外)', async (t) => {
  if (!sharp) return t.skip('sharp が無い');
  const raw = rgbBytes(5);
  const png16 = await sharp(raw, { raw: { width: W, height: H, channels: 3 } }).toColourspace('rgb16').png().toBuffer();
  const profile = pngProfile(png16);
  assert.ok(profile && !profile.direct && /bpc:16/.test(profile.why), `16 bit (${profile && profile.why})`);
  const dest = path.join(dir, 'deep.pdf');
  await writePdf([put('deep.png', png16)], dest, { transcode, expand });
  const image = imageObject(fs.readFileSync(dest), 0);
  assert.match(image.dict, /\/BitsPerComponent 8/);
  assert.strictEqual(zlib.inflateSync(image.bytes).length, W * H * 3);
  const detail = await pdfUnpack.readPageDetail(dest, 0);
  assert.ok(!detail.reason, `直読みできない: ${detail.reason}`);
});

test('JPEG と PNG が混ざった本でも、JPEG はバイトのまま・PNG は IDAT のまま', async (t) => {
  if (!sharp) return t.skip('sharp が無い');
  const jpeg = await sharp(rgbBytes(6), { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toBuffer();
  const png = await sharp(rgbBytes(7), { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  const dest = path.join(dir, 'mixed.pdf');
  await writePdf([put('m0.jpg', jpeg), put('m1.png', png)], dest, { transcode, expand });
  assert.strictEqual(await pdfUnpack.pageCount(dest), 2);
  const first = await pdfUnpack.unpackPage(dest, 0, {});
  assert.ok(first.bytes.equals(jpeg), 'JPEG はそのまま返る');
  const pdf = fs.readFileSync(dest);
  assert.ok(imageObject(pdf, 1).bytes.equals(pngProfile(png).idat), 'PNG は IDAT のまま');
  const second = await pdfUnpack.unpackPage(dest, 1, {});
  assert.ok(second && second.bytes.length, '2 頁目も直に抜ける');
});

test('壊れた PNG や PNG でない物は pngProfile が null', () => {
  assert.strictEqual(pngProfile(Buffer.from('not a png')), null);
  assert.strictEqual(pngProfile(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)])), null);
});
