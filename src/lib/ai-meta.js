'use strict';
// AI 生成の絵に埋め込まれた生成情報 (プロンプト・ネガティブ・キャラ別・設定) を、原寸の画像のバイトから取り出す。
// 網に出ない純粋な関数。pixiv の AI 作品 (illust_ai_type === 2) の「プロンプトを見る」が使う (issue #3)。
// 参考の実装は docs/research/pixiv-ai-meta/extract.py (Python)。
//
// 読む順 (最初に見つかった物を使う):
//   1. PNG の tEXt / zTXt / iTXt      NovelAI (Comment / Description / Software / Source)・A1111 (parameters)・ComfyUI (prompt / workflow)
//   2. EXIF の UserComment            JPEG の APP1・WebP の EXIF チャンク・PNG の eXIf。中身は A1111 形式か JSON
//   3. NovelAI のステルス情報          アルファか RGB の最下位ビット、列優先。先頭 15 バイトが署名、次の 32 ビットが長さ (ビット数)、
//                                     *comp は gzip。画素は呼び手が注ぐ (pixels({ columns }) → 左端の列だけの生画素)。
//                                     全画素を復号しない: 本体は数十 KB なので、左の数十〜数百列で足りる
//
// 返す形 (画面と IPC で持ち回る。Buffer は入れない):
//   { foundIn, format, positive, negative, characters[], characterNegatives[], settings{}, extra{}, workflowTexts[], note } | null
//   settings は形式を跨いで同じ鍵: model / seed / steps / scale / cfgRescale / sampler / noiseSchedule / width / height / smea / smeaDyn / requestType / software
//   形式固有の残りは extra に (A1111 の "Denoising strength" や ComfyUI の scheduler など)

const zlib = require('zlib');

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const STEALTH_SIGS = {
  stealth_pnginfo: { mode: 'alpha', compressed: false },
  stealth_pngcomp: { mode: 'alpha', compressed: true },
  stealth_rgbinfo: { mode: 'rgb', compressed: false },
  stealth_rgbcomp: { mode: 'rgb', compressed: true },
};
const SIG_BITS = 15 * 8;
const LEN_BITS = 32;
const HEAD_BITS = SIG_BITS + LEN_BITS;
// ステルスの本体の上限 (ビット)。数十 KB の JSON が普通で、これを超える長さは壊れた物として捨てる
const MAX_PAYLOAD_BITS = 8 * 1024 * 1024 * 8;

const utf8Strict = new TextDecoder('utf-8', { fatal: true });
const utf8Loose = new TextDecoder('utf-8', { fatal: false });

function textOf(bytes) {
  try { return utf8Strict.decode(bytes); } catch { return bytes.toString('latin1'); }
}

function kindOf(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return '';
  if (bytes.subarray(0, 8).equals(PNG_SIG)) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpeg';
  if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return '';
}

// ── PNG のチャンク ─────────────────────────────────────────
// text: 鍵 → 文字列。exif: eXIf チャンクの中身 (無ければ null)。壊れた長さでも落ちない (読める所まで)
function pngChunks(bytes) {
  const out = { text: {}, exif: null, width: 0, height: 0 };
  if (kindOf(bytes) !== 'png') return out;
  let at = 8;
  while (at + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString('latin1', at + 4, at + 8);
    const start = at + 8;
    const end = start + length;
    if (end > bytes.length) break;
    const body = bytes.subarray(start, end);
    try {
      if (type === 'IHDR') {
        out.width = body.readUInt32BE(0);
        out.height = body.readUInt32BE(4);
      } else if (type === 'tEXt') {
        const zero = body.indexOf(0);
        if (zero > 0) out.text[body.toString('latin1', 0, zero)] = textOf(body.subarray(zero + 1));
      } else if (type === 'zTXt') {
        const zero = body.indexOf(0);
        if (zero > 0) out.text[body.toString('latin1', 0, zero)] = textOf(zlib.inflateSync(body.subarray(zero + 2)));
      } else if (type === 'iTXt') {
        const zero = body.indexOf(0);
        if (zero > 0) {
          const key = body.toString('latin1', 0, zero);
          const compressed = body[zero + 1] === 1;
          let p = zero + 3;
          const lang = body.indexOf(0, p); p = lang + 1;
          const translated = body.indexOf(0, p); p = translated + 1;
          const payload = body.subarray(p);
          out.text[key] = compressed ? utf8Loose.decode(zlib.inflateSync(payload)) : utf8Loose.decode(payload);
        }
      } else if (type === 'eXIf') {
        out.exif = Buffer.from(body);
      } else if (type === 'IEND') {
        break;
      }
    } catch {
      // 壊れたチャンクは飛ばす (他の鍵は読む)
    }
    at = end + 4;
  }
  return out;
}

// ── EXIF の UserComment ───────────────────────────────────
function exifPayload(bytes) {
  const kind = kindOf(bytes);
  if (kind === 'jpeg') {
    let at = 2;
    while (at + 4 <= bytes.length && bytes[at] === 0xff) {
      const marker = bytes[at + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { at += 2; continue; }
      if (marker === 0xda || marker === 0xd9) break;   // 画素 (SOS) か終わり
      const length = bytes.readUInt16BE(at + 2);
      if (length < 2) break;
      if (marker === 0xe1 && bytes.toString('latin1', at + 4, at + 10) === 'Exif\0\0') {
        return bytes.subarray(at + 10, at + 2 + length);
      }
      at += 2 + length;
    }
    return null;
  }
  if (kind === 'webp') {
    let at = 12;
    while (at + 8 <= bytes.length) {
      const fourcc = bytes.toString('latin1', at, at + 4);
      const length = bytes.readUInt32LE(at + 4);
      const start = at + 8;
      if (fourcc === 'EXIF') {
        let payload = bytes.subarray(start, Math.min(bytes.length, start + length));
        if (payload.toString('latin1', 0, 6) === 'Exif\0\0') payload = payload.subarray(6);
        return payload;
      }
      at = start + length + (length & 1);
    }
    return null;
  }
  if (kind === 'png') {
    const exif = pngChunks(bytes).exif;
    if (!exif) return null;
    return exif.toString('latin1', 0, 6) === 'Exif\0\0' ? exif.subarray(6) : exif;
  }
  return null;
}

// TIFF の中を歩いて UserComment (0x9286) を探す。IFD0 と Exif IFD (0x8769) だけ見る
function tiffUserComment(tiff) {
  if (!tiff || tiff.length < 8) return null;
  const order = tiff.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') return null;
  const le = order === 'II';
  const u16 = (p) => (le ? tiff.readUInt16LE(p) : tiff.readUInt16BE(p));
  const u32 = (p) => (le ? tiff.readUInt32LE(p) : tiff.readUInt32BE(p));
  if (u16(2) !== 42) return null;
  const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
  const walk = (offset, depth) => {
    if (depth > 2 || offset + 2 > tiff.length) return null;
    const count = u16(offset);
    let exifIfd = 0;
    for (let i = 0; i < count; i += 1) {
      const e = offset + 2 + i * 12;
      if (e + 12 > tiff.length) break;
      const tag = u16(e);
      const type = u16(e + 2);
      const n = u32(e + 4);
      const size = (TYPE_SIZE[type] || 1) * n;
      const at = size > 4 ? u32(e + 8) : e + 8;
      if (tag === 0x8769) exifIfd = u32(e + 8);
      if (tag === 0x9286 && at + size <= tiff.length) return { bytes: tiff.subarray(at, at + size), le };
    }
    return exifIfd ? walk(exifIfd, depth + 1) : null;
  };
  return walk(u32(4), 0);
}

// UserComment の中身を文字列に。先頭 8 バイトが文字コード (ASCII / UNICODE / JIS / 全部 0)
function decodeUserComment(found) {
  if (!found) return '';
  const { bytes, le } = found;
  if (bytes.length <= 8) return '';
  const code = bytes.toString('latin1', 0, 8).replace(/\0+$/, '');
  const body = bytes.subarray(8);
  if (code === 'UNICODE') {
    let bigEndian;
    if (body[0] === 0xfe && body[1] === 0xff) bigEndian = true;
    else if (body[0] === 0xff && body[1] === 0xfe) bigEndian = false;
    else {
      // BOM が無い: 0 の並びで見分ける (ASCII の範囲なら偶数番か奇数番の片方が 0)。どちらとも言えなければ TIFF の並びに従う
      let even = 0;
      let odd = 0;
      for (let i = 0; i + 1 < body.length && i < 400; i += 2) { if (body[i] === 0) even += 1; if (body[i + 1] === 0) odd += 1; }
      bigEndian = even === odd ? !le : even > odd;
    }
    const swapped = bigEndian ? Buffer.from(body).swap16() : body;
    return swapped.toString('utf16le').replace(/^﻿/, '').replace(/\0+$/, '');
  }
  return textOf(body).replace(/\0+$/, '');
}

function exifUserComment(bytes) {
  try {
    return decodeUserComment(tiffUserComment(exifPayload(bytes)));
  } catch {
    return '';
  }
}

// ── NovelAI のステルス情報 ────────────────────────────────
// strip: 左端の列だけの生画素 { data, width, height, channels } (channels 3 か 4)。
// 列優先に読む: x=0 の列を上から下へ、次に x=1 … 。アルファは 1 画素 1 ビット、RGB は 1 画素 3 ビット (R, G, B の順)
function bitReader(strip, mode) {
  const { data, width, height, channels } = strip;
  const perPixel = mode === 'alpha' ? 1 : 3;
  const total = width * height * perPixel;
  const bit = (i) => {
    const pixel = Math.floor(i / perPixel);
    const x = Math.floor(pixel / height);
    const y = pixel % height;
    const c = mode === 'alpha' ? 3 : i % 3;
    return data[(y * width + x) * channels + c] & 1;
  };
  return { total, bit, perPixel };
}

function bitsToBytes(reader, from, count) {
  const out = Buffer.alloc(Math.ceil(count / 8));
  for (let i = 0; i < count; i += 1) {
    if (reader.bit(from + i)) out[i >> 3] |= 0x80 >> (i & 7);
  }
  return out;
}

// 署名と長さだけ読む。strip は 152 ビットぶんの画素があれば足りる
function stealthProbe(strip) {
  if (!strip || !strip.data || !(strip.channels === 3 || strip.channels === 4)) return null;
  const modes = strip.channels === 4 ? ['alpha', 'rgb'] : ['rgb'];
  for (const mode of modes) {
    const reader = bitReader(strip, mode);
    if (reader.total < HEAD_BITS) continue;
    const sig = bitsToBytes(reader, 0, SIG_BITS).toString('latin1');
    const known = STEALTH_SIGS[sig];
    if (!known || known.mode !== mode) continue;
    const lengthBits = bitsToBytes(reader, SIG_BITS, LEN_BITS).readUInt32BE(0);
    if (!lengthBits || lengthBits > MAX_PAYLOAD_BITS) return null;
    return { signature: sig, mode, compressed: known.compressed, lengthBits, bitsPerColumn: strip.height * reader.perPixel };
  }
  return null;
}

function stealthPayload(strip, probe) {
  const reader = bitReader(strip, probe.mode);
  if (reader.total < HEAD_BITS + probe.lengthBits) return null;   // 画像に入り切らない長さ = 壊れている
  const raw = bitsToBytes(reader, HEAD_BITS, probe.lengthBits);
  try {
    const bytes = probe.compressed ? zlib.gunzipSync(raw) : raw;
    return utf8Loose.decode(bytes);
  } catch {
    return null;
  }
}

// pixels({ columns }) → 左端 columns 列の生画素 (画像の幅で切り詰めてよい) | null
async function readStealth(pixels, { width = 0, height = 0 } = {}) {
  if (typeof pixels !== 'function') return null;
  const probeColumns = height > 0 ? Math.max(1, Math.ceil(HEAD_BITS / height)) : 1;
  const first = await pixels({ columns: probeColumns });
  const probe = stealthProbe(first);
  if (!probe) return null;
  const needBits = HEAD_BITS + probe.lengthBits;
  const columns = Math.ceil(needBits / probe.bitsPerColumn);
  if (width > 0 && columns > width) return null;
  const strip = columns <= first.width ? first : await pixels({ columns });
  if (!strip) return null;
  const text = stealthPayload(strip, probe);
  return text == null ? null : { signature: probe.signature, text };
}

// ── 共通の形へ ─────────────────────────────────────────────
function maybeJson(value) {
  if (typeof value !== 'string') return value;
  const s = value.trim();
  if (!s || (s[0] !== '{' && s[0] !== '[')) return value;
  try { return JSON.parse(s); } catch { return value; }
}
const isDict = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const numberish = (v) => {
  if (typeof v === 'number' || typeof v === 'boolean' || v == null) return v;
  const s = String(v).trim();
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : s;
};

function empty() {
  return {
    foundIn: '', format: '', positive: '', negative: '', characters: [], characterNegatives: [],
    settings: {}, extra: {}, workflowTexts: [], note: '',
  };
}

// NovelAI の Comment (JSON) から。dict は {Description, Software, Source, Comment} でも、Comment の中身そのものでもよい
function fromNovelAI(dict) {
  let comment = maybeJson(dict.Comment);
  let outer = dict;
  if (!isDict(comment)) {
    if (typeof dict.prompt === 'string' && ('uc' in dict || 'seed' in dict || 'sampler' in dict)) { comment = dict; outer = {}; }
    else return null;
  }
  const res = empty();
  res.format = 'NovelAI';
  res.positive = String(comment.prompt || outer.Description || '');
  res.negative = String(comment.uc || '');
  const captions = (key) => {
    const caption = comment[key] && comment[key].caption;
    const list = caption && Array.isArray(caption.char_captions) ? caption.char_captions : [];
    return list.map((x) => String((x && x.char_caption) || ''));
  };
  const chars = captions('v5_prompt').length ? captions('v5_prompt') : captions('v4_prompt');
  res.characters = chars;
  const negChars = captions('v5_negative_prompt').length ? captions('v5_negative_prompt') : captions('v4_negative_prompt');
  if (negChars.some(Boolean)) res.characterNegatives = negChars;
  const s = res.settings;
  const pick = (to, from) => { if (comment[from] !== undefined) s[to] = comment[from]; };
  pick('steps', 'steps'); pick('scale', 'scale'); pick('cfgRescale', 'cfg_rescale'); pick('seed', 'seed');
  pick('sampler', 'sampler'); pick('noiseSchedule', 'noise_schedule'); pick('width', 'width'); pick('height', 'height');
  pick('smea', 'sm'); pick('smeaDyn', 'sm_dyn'); pick('requestType', 'request_type');
  const model = outer.Source || comment.model_name || comment.model || '';
  if (model) s.model = String(model);
  if (outer.Software) s.software = String(outer.Software);
  return res;
}

// A1111 の "Steps: 20, Sampler: Euler a, …" を鍵と値に。引用符の中の , は区切らない
function splitSettingsLine(line) {
  const out = {};
  let key = '';
  let buf = '';
  let quoted = false;
  const flush = () => { if (key) out[key] = buf.trim().replace(/^"(.*)"$/, '$1'); key = ''; buf = ''; };
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') { quoted = !quoted; buf += ch; continue; }
    if (!quoted && ch === ':' && !key && buf.trim()) { key = buf.trim(); buf = ''; continue; }
    if (!quoted && ch === ',' && key) { flush(); continue; }
    buf += ch;
  }
  flush();
  return out;
}

const A1111_KEYS = {
  Steps: 'steps', Sampler: 'sampler', 'CFG scale': 'scale', Seed: 'seed', Model: 'model', 'Schedule type': 'noiseSchedule',
};

function fromA1111(text, raw) {
  const res = empty();
  res.format = 'A1111';
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const last = lines[lines.length - 1] || '';
  const hasSettings = /(^|, )Steps: /.test(last);
  const body = (hasSettings ? lines.slice(0, -1) : lines).join('\n');
  const at = body.indexOf('Negative prompt:');
  res.positive = (at >= 0 ? body.slice(0, at) : body).trim();
  res.negative = at >= 0 ? body.slice(at + 'Negative prompt:'.length).trim() : '';
  if (hasSettings) {
    for (const [k, v] of Object.entries(splitSettingsLine(last))) {
      if (k === 'Size') {
        const m = /^(\d+)x(\d+)$/.exec(v);
        if (m) { res.settings.width = Number(m[1]); res.settings.height = Number(m[2]); } else res.extra[k] = v;
      } else if (A1111_KEYS[k]) res.settings[A1111_KEYS[k]] = numberish(v);
      else res.extra[k] = v;
    }
  }
  if (raw && raw.workflow) {
    res.workflowTexts = comfyWorkflowTexts(raw.workflow);
    if (!res.positive && res.workflowTexts.length) res.note = 'workflow-only';
  }
  return res;
}

// ComfyUI の UI 形式 (workflow) から、プロンプトらしい文字列 (CLIPTextEncode / Prompt / Text / String の widget) を集める
function comfyWorkflowTexts(workflow) {
  const wf = maybeJson(workflow);
  const out = [];
  if (!isDict(wf) || !Array.isArray(wf.nodes)) return out;
  const nodes = [...wf.nodes].sort((a, b) => (Number(a && a.id) || 0) - (Number(b && b.id) || 0));
  for (const node of nodes) {
    if (!isDict(node)) continue;
    const type = String(node.type || '');
    if (!/CLIPTextEncode|Prompt|Text|String/.test(type)) continue;
    for (const v of Array.isArray(node.widgets_values) ? node.widgets_values : []) {
      if (typeof v === 'string' && v.trim().length > 3) out.push({ node: type, title: node.title ? String(node.title) : '', text: v });
    }
  }
  return out;
}

const COMFY_KEYS = { seed: 'seed', steps: 'steps', cfg: 'scale', sampler_name: 'sampler', scheduler: 'noiseSchedule' };

function fromComfy(raw) {
  const res = empty();
  res.format = 'ComfyUI';
  const graph = maybeJson(raw.prompt);
  const texts = [];
  let positiveId = '';
  let negativeId = '';
  if (isDict(graph)) {
    const ids = Object.keys(graph).sort((a, b) => (Number(a) || 0) - (Number(b) || 0));
    for (const id of ids) {
      const node = graph[id];
      if (!isDict(node)) continue;
      const cls = String(node.class_type || '');
      const inputs = isDict(node.inputs) ? node.inputs : {};
      if (/CLIPTextEncode/.test(cls) && typeof inputs.text === 'string') texts.push({ id, text: inputs.text });
      if (/^KSampler/.test(cls)) {
        if (Array.isArray(inputs.positive)) positiveId = String(inputs.positive[0]);
        if (Array.isArray(inputs.negative)) negativeId = String(inputs.negative[0]);
        for (const [k, v] of Object.entries(inputs)) {
          if (Array.isArray(v) || isDict(v)) continue;
          if (COMFY_KEYS[k]) res.settings[COMFY_KEYS[k]] = numberish(v);
          else res.extra[k] = v;
        }
      }
      if (/CheckpointLoader/.test(cls) && typeof inputs.ckpt_name === 'string') res.settings.model = inputs.ckpt_name;
      if (/EmptyLatentImage/.test(cls)) {
        if (inputs.width !== undefined) res.settings.width = numberish(inputs.width);
        if (inputs.height !== undefined) res.settings.height = numberish(inputs.height);
      }
    }
  }
  const byId = (id) => (texts.find((t) => t.id === id) || {}).text;
  res.positive = String(byId(positiveId) || (texts[0] && texts[0].text) || '');
  res.negative = String(byId(negativeId) || (texts[1] && texts[1].id !== positiveId ? texts[1].text : '') || '');
  if (res.negative === res.positive) res.negative = '';
  res.workflowTexts = comfyWorkflowTexts(raw.workflow);
  if (!res.positive && res.workflowTexts.length) res.note = 'workflow-only';
  return res;
}

// raw (チャンクの鍵 → 文字列、またはステルス / EXIF の JSON の dict) を共通の形に。読めない物は null
function normalize(raw) {
  if (!isDict(raw)) return null;
  const nai = fromNovelAI(raw);
  if (nai) return nai;
  if (typeof raw.parameters === 'string' && raw.parameters.trim()) return fromA1111(raw.parameters, raw);
  if (raw.prompt !== undefined || raw.workflow !== undefined) {
    const out = fromComfy(raw);
    if (out.positive || out.negative || out.workflowTexts.length || Object.keys(out.settings).length) return out;
  }
  return null;
}

// 文字列 (EXIF の UserComment やステルスの本体) を raw の dict に
function rawFromText(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const json = maybeJson(s);
  if (isDict(json)) return json;
  if (/(^|\n)Negative prompt:|(^|, )Steps: /.test(s)) return { parameters: s };
  return null;
}

// よそが解析済みで渡してくる JSON (aitag.win の ai_json) を raw の dict に整える。
//   ComfyUI の UI 形式 (workflow) がそのまま来る → { workflow }、API 形式のグラフ (番号の鍵 + class_type) → { prompt }。
//   NovelAI の dict (Comment が object でもよい)・A1111 の { parameters } はそのまま。文字列なら rawFromText
function rawFromAny(value) {
  const json = typeof value === 'string' ? maybeJson(value) : value;
  if (typeof json === 'string') return rawFromText(json);
  if (!isDict(json)) return null;
  if (Array.isArray(json.nodes) && !('prompt' in json) && !('parameters' in json) && !('Comment' in json)) return { workflow: json };
  const keys = Object.keys(json);
  if (keys.length && keys.every((k) => /^\d+$/.test(k)) && keys.some((k) => isDict(json[k]) && 'class_type' in json[k])) return { prompt: json };
  return json;
}

// value (dict か文字列) → 共通の形 | null。hints: { model, positive } は中身が欠けている時の補い
function normalizeAny(value, hints = {}) {
  const found = normalize(rawFromAny(value));
  if (!found) return null;
  if (!found.settings.model && hints.model) found.settings.model = String(hints.model);
  if (!found.positive && !found.workflowTexts.length && hints.positive) found.positive = String(hints.positive);
  return found;
}

// 画像のバイト → 生成情報 | null。pixels を注ぐとステルスも読む (注がなければチャンクと EXIF だけ)
async function extractFromBytes(bytes, { pixels } = {}) {
  const kind = kindOf(bytes);
  if (!kind) return null;
  let size = { width: 0, height: 0 };
  if (kind === 'png') {
    const chunks = pngChunks(bytes);
    size = { width: chunks.width, height: chunks.height };
    const found = normalize(chunks.text);
    if (found) return { ...found, foundIn: 'png_text' };
  }
  const comment = exifUserComment(bytes);
  if (comment) {
    const found = normalize(rawFromText(comment));
    if (found) return { ...found, foundIn: 'exif' };
  }
  if (pixels && (kind === 'png' || kind === 'webp')) {
    let stealth = null;
    try { stealth = await readStealth(pixels, size); } catch { stealth = null; }
    if (stealth) {
      const found = normalize(rawFromText(stealth.text));
      if (found) return { ...found, foundIn: stealth.signature };
    }
  }
  return null;
}

module.exports = {
  extractFromBytes,
  normalize,
  normalizeAny,
  rawFromAny,
  pngChunks,
  exifUserComment,
  readStealth,
  stealthProbe,
  stealthPayload,
  comfyWorkflowTexts,
  splitSettingsLine,
  kindOf,
  HEAD_BITS,
};
