'use strict';
// AI 生成情報の試験に使う合成の画像 (他人の作品は使わない)。docs/research/pixiv-ai-meta/make_fixtures.py の Node 版。
// PNG は自前で綴じる (フィルタ 0・非インターレース・CRC 付き。sharp が復号できる正しい PNG)。
// JPEG は SOI + APP1 (EXIF) + EOI だけ (画素は要らない: EXIF の道は画素を見ない)。

const zlib = require('zlib');

const crc32 = typeof zlib.crc32 === 'function' ? (b) => zlib.crc32(b) >>> 0 : crcFallback();
function crcFallback() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
}

function chunk(type, body) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([len, typed, crc]);
}

// pixels: 生画素 (行優先、channels バイト / 画素)。text: { 鍵: 文字列 } を tEXt に (kind で zTXt / iTXt にもできる)
function png({ width, height, channels = 3, pixels, text = {}, textKind = 'tEXt', exif = null, fill = 255 }) {
  const raw = pixels || Buffer.alloc(width * height * channels, fill);
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    rows.push(Buffer.from([0]), raw.subarray(y * width * channels, (y + 1) * width * channels));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : channels === 3 ? 2 : 0;
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)];
  for (const [key, value] of Object.entries(text)) {
    const k = Buffer.from(key, 'latin1');
    const v = Buffer.from(String(value), 'utf8');
    if (textKind === 'zTXt') parts.push(chunk('zTXt', Buffer.concat([k, Buffer.from([0, 0]), zlib.deflateSync(v)])));
    else if (textKind === 'iTXt') parts.push(chunk('iTXt', Buffer.concat([k, Buffer.from([0, 1, 0]), Buffer.from([0]), Buffer.from([0]), zlib.deflateSync(v)])));
    else parts.push(chunk('tEXt', Buffer.concat([k, Buffer.from([0]), v])));
  }
  if (exif) parts.push(chunk('eXIf', exif));
  parts.push(chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))));
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

// NovelAI の形 (チャンクの鍵と同じ dict)。ステルスの本体にもこの JSON を使う
function naiDict({ seed = 123, model = 'NovelAI Diffusion V5 TEST', chars = ['girl, red hair'], negChars = null } = {}) {
  const comment = {
    prompt: '1girl, smile', uc: 'lowres', steps: 28, scale: 5.0, seed, sampler: 'k_euler_ancestral', width: 64, height: 64,
    noise_schedule: 'karras', cfg_rescale: 0.1, sm: false, sm_dyn: false, request_type: 'PromptGenerateRequest',
    v4_prompt: { caption: { base_caption: '1girl', char_captions: chars.map((c) => ({ char_caption: c })) } },
  };
  if (negChars) comment.v4_negative_prompt = { caption: { base_caption: 'lowres', char_captions: negChars.map((c) => ({ char_caption: c })) } };
  return { Description: '1girl, smile', Software: 'NovelAI', Source: model, Comment: JSON.stringify(comment) };
}

// ステルス: 署名 + 32 ビットの長さ + 本体 を、列優先で最下位ビットに書く。
// mode 'alpha' は 1 画素 1 ビット (RGBA)、'rgb' は 1 画素 3 ビット (RGB の順)。channels は alpha なら 4、rgb なら 3 か 4
function stealthPng({ dict, mode = 'alpha', compressed = true, width = 64, height = 0, channels = mode === 'alpha' ? 4 : 3, lengthBits = null, corruptGzip = false }) {
  const sig = mode === 'alpha' ? (compressed ? 'stealth_pngcomp' : 'stealth_pnginfo') : (compressed ? 'stealth_rgbcomp' : 'stealth_rgbinfo');
  const json = Buffer.from(JSON.stringify(dict), 'utf8');
  let payload = compressed ? zlib.gzipSync(json) : json;
  if (corruptGzip) payload = Buffer.concat([payload.subarray(0, 10), Buffer.alloc(payload.length - 10, 0x5a)]);
  const bits = [];
  const push = (byte) => { for (let i = 7; i >= 0; i -= 1) bits.push((byte >> i) & 1); };
  for (const b of Buffer.from(sig, 'latin1')) push(b);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(lengthBits == null ? payload.length * 8 : lengthBits, 0);
  for (const b of len) push(b);
  for (const b of payload) push(b);
  const perPixel = mode === 'alpha' ? 1 : 3;
  if (!height) height = Math.max(64, Math.ceil(bits.length / perPixel / width) + 1);
  const pixels = Buffer.alloc(width * height * channels, 255);
  // 列優先: 画素番号 p → x = floor(p / height), y = p % height
  for (let i = 0; i < bits.length; i += 1) {
    const p = Math.floor(i / perPixel);
    const x = Math.floor(p / height);
    const y = p % height;
    if (x >= width) break;
    const c = mode === 'alpha' ? 3 : i % 3;
    const at = (y * width + x) * channels + c;
    pixels[at] = (pixels[at] & 0xfe) | bits[i];
  }
  return png({ width, height, channels, pixels });
}

// EXIF (TIFF、リトルエンディアン): IFD0 に ExifIFD の指し手、ExifIFD に UserComment (0x9286) だけ
function exifTiff(comment, { unicode = false } = {}) {
  let body;
  if (unicode) body = Buffer.concat([Buffer.from('UNICODE\0', 'latin1'), Buffer.from(comment, 'utf16le').swap16()]);   // BOM 無しのビッグエンディアン
  else body = Buffer.concat([Buffer.alloc(8, 0), Buffer.from(comment, 'utf8')]);
  const header = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);
  // IFD0: 1 entry (0x8769 LONG 1 → offset 26), next 0
  const ifd0 = Buffer.alloc(2 + 12 + 4);
  ifd0.writeUInt16LE(1, 0);
  ifd0.writeUInt16LE(0x8769, 2); ifd0.writeUInt16LE(4, 4); ifd0.writeUInt32LE(1, 6); ifd0.writeUInt32LE(8 + ifd0.length, 10);
  const exifIfd = Buffer.alloc(2 + 12 + 4);
  const dataAt = 8 + ifd0.length + exifIfd.length;
  exifIfd.writeUInt16LE(1, 0);
  exifIfd.writeUInt16LE(0x9286, 2); exifIfd.writeUInt16LE(7, 4); exifIfd.writeUInt32LE(body.length, 6); exifIfd.writeUInt32LE(dataAt, 10);
  return Buffer.concat([header, ifd0, exifIfd, body]);
}

function jpegWithExif(comment, opts) {
  const tiff = exifTiff(comment, opts);
  const app1 = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(app1.length + 2, 0);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xe1]), len, app1, Buffer.from([0xff, 0xd9])]);
}

function webpWithExif(comment, opts) {
  const tiff = exifTiff(comment, opts);
  const exifChunk = Buffer.concat([Buffer.from('EXIF', 'latin1'), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(tiff.length, 0); return b; })(), tiff, tiff.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(4 + exifChunk.length, 0);
  return Buffer.concat([Buffer.from('RIFF', 'latin1'), size, Buffer.from('WEBP', 'latin1'), exifChunk]);
}

const A1111_TEXT = '1girl, smile\nNegative prompt: lowres\nSteps: 20, Sampler: Euler a, CFG scale: 7, Seed: 1, Size: 64x64, Model: testmodel, Lora hashes: "a: 1, b: 2"';
const COMFY_GRAPH = {
  3: { class_type: 'KSampler', inputs: { seed: 5, steps: 25, cfg: 6.0, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0] } },
  4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'test.safetensors' } },
  6: { class_type: 'CLIPTextEncode', inputs: { text: '1girl, smile' } },
  7: { class_type: 'CLIPTextEncode', inputs: { text: 'lowres' } },
};
const COMFY_WORKFLOW = { nodes: [{ id: 2, type: 'CLIPTextEncode', title: 'Positive', widgets_values: ['1girl, smile'] }, { id: 9, type: 'KSampler', widgets_values: [5, 'fixed', 25] }] };

// sharp で左端の列を生画素にする (母屋の ai-meta-service と同じ注ぎ方)。試験の中で使う
function sharpPixels(bytes) {
  const sharp = require('sharp');
  return async ({ columns }) => {
    const meta = await sharp(bytes).metadata();
    const width = Math.min(columns, meta.width);
    const { data, info } = await sharp(bytes).extract({ left: 0, top: 0, width, height: meta.height }).raw().toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height, channels: info.channels };
  };
}

module.exports = { png, stealthPng, naiDict, jpegWithExif, webpWithExif, exifTiff, A1111_TEXT, COMFY_GRAPH, COMFY_WORKFLOW, sharpPixels };
