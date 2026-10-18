'use strict';

// 所持の PDF から生成情報を読み戻す往復 (issue #3 の埋め戻し)。
//   RGBA のステルス PNG → pdf-write (RGB + 8bit 灰の SMask、可逆) → pdf-unpack.pageAiSource → worker でステルスの字 → 同じ seed
//   EXIF 付きの JPEG → pdf-write (JPEG はそのまま) → pageAiSource の dct のバイト → extractFromBytes で EXIF
// 画素は全部合成 (他人の作品は無い)。sharp が無ければ飛ばす

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pdfUnpack = require('../src/lib/pdf-unpack');
const { writePdf } = require('../src/lib/pdf-write');
const { extractFromBytes, normalizeAny } = require('../src/lib/ai-meta');
const F = require('./helpers/ai-meta-fixtures');

let sharp = null;
try { sharp = require('sharp'); } catch { sharp = null; }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-meta-pdf-'));
test.after(async () => {
  await pdfUnpack.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const transcode = (bytes) => sharp(bytes).rotate().jpeg({ quality: 92, chromaSubsampling: '4:4:4', mozjpeg: false }).toBuffer();
const expand = (bytes) => pdfUnpack.pagePlaneBytes(bytes, { tag: 'test' });

async function sizeOf(bytes) { const m = await sharp(bytes).metadata(); return { width: m.width, height: m.height }; }
async function put(name, bytes) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return { file, ...(await sizeOf(bytes)) };
}

test('RGBA のステルス PNG は PDF (RGB + SMask) に可逆で入り、透過と RGB から同じ生成情報が読み戻せる', { skip: !sharp && 'sharp が無い' }, async () => {
  const dict = F.naiDict({ seed: 4242 });
  const png = F.stealthPng({ dict, mode: 'alpha', compressed: true, width: 96, height: 160 });
  const dest = path.join(dir, 'stealth.pdf');
  await writePdf([await put('stealth.png', png)], dest, { transcode, expand });
  const src = await pdfUnpack.pageAiSource(dest, 0);
  assert.ok(src, '直読みできる頁');
  assert.equal(src.kind, 'flate');
  const text = await src.stealth();
  assert.ok(text, 'ステルスの字が読める');
  const meta = normalizeAny(text);
  assert.equal(meta.format, 'NovelAI');
  assert.equal(meta.settings.seed, 4242);
  assert.equal(meta.settings.model, 'NovelAI Diffusion V5 TEST');
});

test('RGB のステルス (stealth_rgbcomp) も PDF の IDAT から読み戻せる。情報の無い絵は null', { skip: !sharp && 'sharp が無い' }, async () => {
  const dict = F.naiDict({ seed: 5 });
  const png = F.stealthPng({ dict, mode: 'rgb', compressed: true, width: 64, height: 200 });
  const dest = path.join(dir, 'rgb.pdf');
  await writePdf([await put('rgb.png', png), await put('plain.png', F.png({ width: 64, height: 64 }))], dest, { transcode, expand });
  const src = await pdfUnpack.pageAiSource(dest, 0);
  assert.equal(src.kind, 'flate');
  const meta = normalizeAny(await src.stealth());
  assert.equal(meta && meta.settings.seed, 5);
  const none = await pdfUnpack.pageAiSource(dest, 1);
  assert.equal(none.kind, 'flate');
  assert.equal(await none.stealth(), null);
});

test('EXIF 付きの JPEG は PDF にそのまま入り、dct のバイトから EXIF が読める', { skip: !sharp && 'sharp が無い' }, async () => {
  const body = await sharp({ create: { width: 48, height: 64, channels: 3, background: { r: 200, g: 180, b: 160 } } }).jpeg({ quality: 90 }).toBuffer();
  // SOI の直後に APP1 (EXIF) を差す
  const exif = F.jpegWithExif(F.A1111_TEXT).subarray(2, -2);
  const jpeg = Buffer.concat([body.subarray(0, 2), exif, body.subarray(2)]);
  assert.equal((await extractFromBytes(jpeg)).format, 'A1111', '差した EXIF が読める');
  const dest = path.join(dir, 'exif.pdf');
  await writePdf([await put('exif.jpg', jpeg)], dest, { transcode, expand });
  const src = await pdfUnpack.pageAiSource(dest, 0);
  assert.equal(src.kind, 'dct');
  const bytes = src.bytes || (src.unwrap && await src.unwrap());
  assert.ok(bytes);
  const meta = await extractFromBytes(bytes);
  assert.equal(meta && meta.format, 'A1111');
  assert.equal(meta.settings.steps, 20);
});
