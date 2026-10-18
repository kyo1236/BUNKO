'use strict';

// PDF を pdf.js に描かせず、頁に貼られた絵をそのまま抜き出す所。
//
// 母屋が組む PDF は「一頁 = 絵一枚」。絵の形は綴じた時期で二通りある:
//   - いま (pdf-write が直に据える) … どの出どころでも JPEG (DCTDecode)。
//     JPEG の頁は原本のバイトそのまま、webp/avif の頁はここと同じ worker で
//     一度だけ JPEG に焼いてから据えてある
//   - 昔 (pdf-builder → Chromium の印刷) … hitomi 由来 (webp/avif) は
//     **生の画素を Flate で縮めたもの** (印刷が webp を貼れなかった)。
//     pawchive 由来 (jpeg) は当時から JPEG のまま
// 昔の本はそのまま棚に在るので、生画素 + Flate の頁は今後も読めないといけない。
// 隠し窓で pdf.js に描かせて webp に焼き直すと原寸一頁 700 ms かかるが、
// ほどいて JPEG にするだけなら 100 ms で済み、worker で何頁も同時に走らせられる。
// 読めない形 (透過・予測子付き・見慣れない色空間・圧縮された xref) は null を返し、
// 呼び手が従来の焼き場 (page-baker) に回す。速さの近道であって、PDF 全般の読み手ではない。
//
// 綴じ方の読みは最小限: 古典的な xref 表を辿り、駄目なら全体を走査して obj を拾う。
// 本体は fd を開いたままにして頁ごとに要る範囲だけ読む (50 MB の本でも最初の頁は 5 MB)。
// 画素を開くのも JPEG に焼くのも worker (sharp/libvips) でやる。主スレッドは触らない。
// sharp が読めない時だけ nativeImage (主スレッド) に落ちる

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { Worker } = require('worker_threads');
const { imageSize } = require('./image-size');
const { unpredict } = require('./pdf-predictor');
const { unpackedPath } = require('./asar-path');

// 同時にほどく数。ほどく側は worker、符号化は主スレッドなので増やしても主が詰まるだけ
const POOL = Math.max(1, Math.min(3, os.cpus().length - 1));
// 開いたままにする本の数 (fd と索引)。読書は一冊ずつなので少なくてよい
const OPEN_MAX = 6;
// 手の空いた worker を畳むまで。読書の間 (頁に数十秒) は保ち、立て直し (1 本 100 ms) を避ける
const WORKER_IDLE_MS = 5 * 60 * 1000;
// 一頁の絵として受け付ける上限。これより大きい生画素は worker の転送が重すぎる
const MAX_PIXELS = 40 * 1000 * 1000;
// 一つの obj の辞書を読むのに要る大きさ。足りなければ広げて読み直す。
// 頁の辞書は実寸 120 バイト前後なので、大きく読むと SMB 越しに無駄が出る
const CHUNK = 4 * 1024;
const CHUNK_MAX = 8 * 1024 * 1024;
// 頁の内容ストリームがこれを超える頁は、絵 1 枚だけの頁ではない (読まずに焼き場へ)
const CONTENT_MAX = 1024 * 1024;
// 開いてある本が差し替わっていないかを訊き直す間隔。SMB 越しの stat は 1 往復かかるので、
// 続けて頁を頼まれている間は訊かない (実体の差し替えは取り込み直した時だけ)
const STAT_TTL_MS = 3000;
// 開けなかった本を憶えておく間。憶えないと、頁を頼まれるたびに丸ごと読み直す
const FAIL_TTL_MS = 30 * 1000;
// worker に出した仕事の時限。詰まった時に読み手を待たせ続けない
const WORKER_TIMEOUT_MS = 20 * 1000;
// 走査の保険で一度に読む大きさ。本体を丸ごと文字列にすると 512 MB で V8 が音を上げる
const SCAN_CHUNK = 8 * 1024 * 1024;
const SCAN_OVERLAP = 128;

const EOF = Symbol('eof');
// unpackPage が「裏の仕事を取り下げた」時に返す印。読めない (null) とは別
const DROPPED = Symbol('dropped');

// ── 字句 ─────────────────────────────────────────────────────
// 値の表し方: 名前は '/Foo' の文字列、参照は { ref: n }、辞書は素の object、
// 配列は配列、数は number、文字列は { str }。テストで見比べやすい形にしてある

const isWs = (c) => c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\0';
const isDelim = (c) => '()<>[]{}/%'.includes(c);

class Lexer {
  constructor(text, pos = 0) {
    this.text = text;
    this.pos = pos;
  }

  skipWs() {
    const { text } = this;
    while (this.pos < text.length) {
      const c = text[this.pos];
      if (isWs(c)) {
        this.pos += 1;
      } else if (c === '%') {
        while (this.pos < text.length && text[this.pos] !== '\n' && text[this.pos] !== '\r') this.pos += 1;
      } else {
        break;
      }
    }
  }

  // 次の字句。文字列は中身を捨てる (辞書の値としてしか出ず、ここでは要らない)
  token() {
    this.skipWs();
    const { text } = this;
    if (this.pos >= text.length) throw EOF;
    const c = text[this.pos];
    if (c === '<') {
      if (text[this.pos + 1] === '<') {
        this.pos += 2;
        return { t: '<<' };
      }
      const end = text.indexOf('>', this.pos);
      if (end < 0) throw EOF;
      this.pos = end + 1;
      return { t: 'str' };
    }
    if (c === '>') {
      if (text[this.pos + 1] === '>') {
        this.pos += 2;
        return { t: '>>' };
      }
      throw new Error('bad token');
    }
    if (c === '[' || c === ']' || c === '{' || c === '}') {
      this.pos += 1;
      return { t: c };
    }
    if (c === '(') {
      let depth = 0;
      for (; this.pos < text.length; this.pos += 1) {
        const d = text[this.pos];
        if (d === '\\') this.pos += 1;
        else if (d === '(') depth += 1;
        else if (d === ')') {
          depth -= 1;
          if (depth === 0) {
            this.pos += 1;
            return { t: 'str' };
          }
        }
      }
      throw EOF;
    }
    if (c === '/') {
      let end = this.pos + 1;
      while (end < text.length && !isWs(text[end]) && !isDelim(text[end])) end += 1;
      const raw = text.slice(this.pos + 1, end);
      this.pos = end;
      return { t: 'name', v: `/${raw.replace(/#([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))}` };
    }
    let end = this.pos;
    while (end < text.length && !isWs(text[end]) && !isDelim(text[end])) end += 1;
    if (end === this.pos) throw new Error('bad token');
    const word = text.slice(this.pos, end);
    this.pos = end;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return { t: 'num', v: Number(word) };
    return { t: 'kw', v: word };
  }

  value(tok = this.token()) {
    switch (tok.t) {
      case 'num': {
        // 「n g R」なら参照。数が続かなければ元の位置に戻す
        const save = this.pos;
        try {
          const gen = this.token();
          if (gen.t === 'num' && Number.isInteger(tok.v) && tok.v >= 0) {
            const r = this.token();
            if (r.t === 'kw' && r.v === 'R') return { ref: tok.v };
          }
        } catch (error) {
          if (error !== EOF) throw error;
        }
        this.pos = save;
        return tok.v;
      }
      case 'name':
        return tok.v;
      case 'str':
        return { str: '' };
      case '<<': {
        const dict = {};
        for (;;) {
          const key = this.token();
          if (key.t === '>>') return dict;
          if (key.t !== 'name') throw new Error('bad dict');
          dict[key.v.slice(1)] = this.value();
        }
      }
      case '[': {
        const list = [];
        for (;;) {
          const next = this.token();
          if (next.t === ']') return list;
          list.push(this.value(next));
        }
      }
      case 'kw':
        if (tok.v === 'true') return true;
        if (tok.v === 'false') return false;
        if (tok.v === 'null') return null;
        throw new Error(`bad keyword ${tok.v}`);
      default:
        throw new Error(`bad value ${tok.t}`);
    }
  }
}

// ── 本体の読み ───────────────────────────────────────────────

// SMB 越しの読みは頼んだ長さより短く返ることがある (ReadFile 一回ぶん)。
// 足りなければ読み足す。pool を使わない Buffer.alloc なので、そのまま worker へ渡せる
async function readRange(doc, offset, length) {
  const buffer = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const { bytesRead } = await doc.handle.read(buffer, got, length - got, offset + got);
    if (!bytesRead) break;
    got += bytesRead;
  }
  return got === length ? buffer : buffer.subarray(0, got);
}

// offset に居る「n g obj」を読む。返すのは { num, value, stream? } で、stream は
// { offset, length } (本体の位置)。辞書が chunk に収まらなければ広げて読み直す
async function readObjectAt(doc, offset, size = CHUNK) {
  const bytes = await readRange(doc, offset, Math.min(size, doc.size - offset));
  const text = bytes.toString('latin1');
  const lexer = new Lexer(text);
  try {
    const num = lexer.token();
    const gen = lexer.token();
    const kw = lexer.token();
    if (num.t !== 'num' || gen.t !== 'num' || kw.t !== 'kw' || kw.v !== 'obj') return null;
    const value = lexer.value();
    const entry = { num: num.v, value };
    lexer.skipWs();
    // 'stream' の語が読み口の端に跨ると「stream の無い obj」に見える。広げて読み直す
    if (lexer.pos + 8 > text.length && size < CHUNK_MAX && offset + size < doc.size) {
      return readObjectAt(doc, offset, size * 4);
    }
    if (text.startsWith('stream', lexer.pos)) {
      let at = lexer.pos + 'stream'.length;
      if (text[at] === '\r') at += 1;
      if (text[at] === '\n') at += 1;
      let length = value && value.Length;
      if (length && typeof length === 'object' && 'ref' in length) length = (await readObject(doc, length.ref))?.value;
      if (!Number.isInteger(length) || length < 0) return null;
      entry.stream = { offset: offset + at, length };
    }
    return entry;
  } catch (error) {
    if (error === EOF && size < CHUNK_MAX && offset + size < doc.size) return readObjectAt(doc, offset, size * 4);
    if (error === EOF) return null;
    throw error;
  }
}

async function readObject(doc, num) {
  if (doc.objects.has(num)) return doc.objects.get(num);
  let where = doc.xref.get(num);
  if (where === undefined && doc.objstmsToExpand.length) {
    await expandObjStms(doc);
    where = doc.xref.get(num);
  }
  let found = null;
  if (Number.isInteger(where)) {
    const entry = await readObjectAt(doc, where);
    found = entry && entry.num === num ? entry : null;
  } else if (where && typeof where === 'object' && Number.isInteger(where.objstm)) {
    found = await readFromObjStm(doc, where.objstm, num);
  }
  doc.objects.set(num, found);
  return found;
}

// ── 圧縮された束 (stream の中身) ─────────────────────────────

// stream の中身を復号して返す (Flate か生のみ。絵の本体はここを通さない)
async function decodeStream(doc, entry) {
  if (!entry || !entry.stream) throw new Error('not a stream');
  const dict = entry.value;
  const filter = filterOf(dict);
  if (filter !== 'flate' && filter !== 'raw') throw new Error('unsupported stream filter');
  let bytes = await readRange(doc, entry.stream.offset, entry.stream.length);
  if (filter === 'flate') bytes = zlib.inflateSync(bytes, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
  let parms = await resolve(doc, dict.DecodeParms);
  if (Array.isArray(parms)) parms = await resolve(doc, parms[0]);
  if (parms && Number(parms.Predictor) > 1) {
    bytes = unpredict(bytes, Number(parms.Predictor), Number(parms.Columns) || 1, Number(parms.Colors) || 1, Number(parms.BitsPerComponent) || 8);
  }
  return bytes;
}

// object stream (/Type /ObjStm) をほどいて、中の obj の位置表を作る
async function getObjStm(doc, num) {
  if (doc.objstms.has(num)) return doc.objstms.get(num);
  const loading = (async () => {
    const holder = await readObject(doc, num);
    if (!holder || !holder.stream || holder.value.Type !== '/ObjStm') return null;
    const text = (await decodeStream(doc, holder)).toString('latin1');
    const count = Number(holder.value.N) || 0;
    const first = Number(holder.value.First) || 0;
    const lexer = new Lexer(text.slice(0, first));
    const offsets = new Map();
    for (let i = 0; i < count; i += 1) {
      const objNum = lexer.token();
      const at = lexer.token();
      if (objNum.t !== 'num' || at.t !== 'num') break;
      offsets.set(objNum.v, first + at.v);
    }
    return { text, offsets };
  })().catch(() => null);
  doc.objstms.set(num, loading);
  return loading;
}

async function readFromObjStm(doc, objstmNum, num) {
  const stm = await getObjStm(doc, objstmNum);
  if (!stm || !stm.offsets.has(num)) return null;
  try {
    return { num, value: new Lexer(stm.text, stm.offsets.get(num)).value() };
  } catch {
    return null;
  }
}

// 走査の保険で見つけた object stream を全部ほどき、中の obj を索引に足す
async function expandObjStms(doc) {
  const list = doc.objstmsToExpand.splice(0);
  for (const num of list) {
    const stm = await getObjStm(doc, num);
    if (!stm) continue;
    for (const inner of stm.offsets.keys()) {
      if (!doc.xref.has(inner)) doc.xref.set(inner, { objstm: num });
    }
  }
}

async function resolve(doc, value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'ref' in value) {
    const entry = await readObject(doc, value.ref);
    return entry ? entry.value : null;
  }
  return value;
}

// ── 索引 (xref) ──────────────────────────────────────────────

async function parseXrefTable(doc, offset, seen) {
  if (seen.has(offset) || seen.size > 32 || offset <= 0 || offset >= doc.size) return;
  seen.add(offset);
  let size = 64 * 1024;
  for (;;) {
    const text = (await readRange(doc, offset, Math.min(size, doc.size - offset))).toString('latin1');
    const lexer = new Lexer(text);
    try {
      const head = lexer.token();
      // 「n g obj」で始まるなら xref stream (PDF 1.5 以降の圧縮された索引)
      if (head.t === 'num') return parseXrefStream(doc, offset, seen);
      if (head.t !== 'kw' || head.v !== 'xref') throw new Error('bad xref');
      for (;;) {
        const first = lexer.token();
        if (first.t === 'kw' && first.v === 'trailer') break;
        const count = lexer.token();
        if (first.t !== 'num' || count.t !== 'num') throw new Error('bad xref');
        for (let i = 0; i < count.v; i += 1) {
          const at = lexer.token();
          const gen = lexer.token();
          const kind = lexer.token();
          if (at.t !== 'num' || gen.t !== 'num' || kind.t !== 'kw') throw new Error('bad xref');
          const num = first.v + i;
          // 新しい版から辿るので、先に見えたものが勝つ
          if (doc.xref.has(num)) continue;
          if (kind.v === 'n') doc.xref.set(num, at.v);
          else if (kind.v === 'f') doc.xref.set(num, null);
        }
      }
      const trailer = lexer.value();
      if (!doc.trailer) doc.trailer = trailer;
      // 混成 (hybrid) の本は表に載らない obj を xref stream に持つ
      if (trailer && Number.isInteger(trailer.XRefStm)) await parseXrefTable(doc, trailer.XRefStm, seen);
      if (trailer && Number.isInteger(trailer.Prev)) await parseXrefTable(doc, trailer.Prev, seen);
      return;
    } catch (error) {
      if (error === EOF && size < CHUNK_MAX && offset + size < doc.size) {
        size *= 4;
        continue;
      }
      throw error;
    }
  }
}

// xref stream: /W [a b c] の幅で並ぶ項目。種別 1 は位置、2 は object stream の中
async function parseXrefStream(doc, offset, seen) {
  const entry = await readObjectAt(doc, offset);
  if (!entry || !entry.stream || entry.value.Type !== '/XRef') throw new Error('bad xref stream');
  const dict = entry.value;
  const widths = Array.isArray(dict.W) ? dict.W.map(Number) : null;
  if (!widths || widths.length < 3 || widths.some((w) => !Number.isInteger(w) || w < 0 || w > 8)) throw new Error('bad xref stream');
  const data = await decodeStream(doc, entry);
  const rowLen = widths[0] + widths[1] + widths[2];
  const index = Array.isArray(dict.Index) && dict.Index.length >= 2 ? dict.Index.map(Number) : [0, Number(dict.Size) || 0];
  let pos = 0;
  const field = (width) => {
    let v = 0;
    for (let i = 0; i < width; i += 1) v = v * 256 + data[pos + i];
    pos += width;
    return v;
  };
  for (let k = 0; k + 1 < index.length; k += 2) {
    const start = index[k];
    const count = index[k + 1];
    for (let i = 0; i < count && pos + rowLen <= data.length; i += 1) {
      const type = widths[0] === 0 ? 1 : field(widths[0]);
      const f2 = field(widths[1]);
      const f3 = field(widths[2]);
      const num = start + i;
      if (doc.xref.has(num)) continue;
      if (type === 1) doc.xref.set(num, f2);
      else if (type === 2) doc.xref.set(num, { objstm: f2, idx: f3 });
      // type 0 は「消された」。古い版 (Prev) の位置を拾わないよう墓標を置く
      else if (type === 0) doc.xref.set(num, null);
    }
  }
  if (!doc.trailer) doc.trailer = dict;
  if (Number.isInteger(dict.Prev)) await parseXrefTable(doc, dict.Prev, seen);
}

async function buildIndexFromXref(doc) {
  const tailLength = Math.min(2048, doc.size);
  const tail = (await readRange(doc, doc.size - tailLength, tailLength)).toString('latin1');
  const at = tail.lastIndexOf('startxref');
  if (at < 0) throw new Error('no startxref');
  const offset = Number((tail.slice(at + 'startxref'.length).match(/\s*(\d+)/) || [])[1]);
  if (!Number.isInteger(offset)) throw new Error('bad startxref');
  await parseXrefTable(doc, offset, new Set());
  if (!doc.trailer || !doc.trailer.Root) throw new Error('no root');
}

// xref が読めない本の保険: 全体を走査して「n g obj」を拾う (後に出た定義が勝つ)
async function buildIndexByScan(doc) {
  doc.xref = new Map();
  doc.objects = new Map();
  doc.objstms = new Map();
  doc.objstmsToExpand = [];
  let root = null;
  let lastCatalog = -1;
  let encrypted = false;
  // 本体を丸ごと文字列にすると 512 MB で V8 の上限に当たり、340 MB でも RSS が
  // 700 MB 跳ねる。重ね代つきで刻んで回す (跨いだ語は重ね代で拾える)
  for (let at = 0; at < doc.size; at += SCAN_CHUNK) {
    const start = at ? at - SCAN_OVERLAP : 0;
    const text = (await readRange(doc, start, Math.min(SCAN_CHUNK + SCAN_OVERLAP, doc.size - start))).toString('latin1');
    const objRe = /(\d+)\s+(\d+)\s+obj\b/g;
    let hit;
    while ((hit = objRe.exec(text))) doc.xref.set(Number(hit[1]), start + hit.index);
    const stmRe = /\/Type\s*\/ObjStm\b/g;
    while ((hit = stmRe.exec(text))) {
      const before = text.lastIndexOf(' obj', hit.index);
      const head = before >= 0 ? text.slice(Math.max(0, before - 24), before).match(/(\d+)\s+\d+$/) : null;
      if (head) doc.objstmsToExpand.push(Number(head[1]));
    }
    const rootRe = /\/Root\s+(\d+)\s+\d+\s+R/g;
    while ((hit = rootRe.exec(text))) root = { ref: Number(hit[1]) };
    const catalog = text.search(/\/Type\s*\/Catalog\b/);
    if (catalog >= 0) lastCatalog = start + catalog;
    if (/\/Encrypt\s/.test(text)) encrypted = true;
  }
  if (!root && lastCatalog >= 0) {
    // /Root が無い本は、Catalog の直前に居る obj 番号を拾う
    const back = Math.max(0, lastCatalog - 4096);
    const text = (await readRange(doc, back, lastCatalog - back)).toString('latin1');
    const objs = [...text.matchAll(/(\d+)\s+\d+\s+obj\b/g)];
    if (objs.length) root = { ref: Number(objs[objs.length - 1][1]) };
  }
  if (!root) throw new Error('no root');
  doc.trailer = encrypted ? { Root: root, Encrypt: true } : { Root: root };
}

// ── 頁の木 ───────────────────────────────────────────────────

// 頁の辞書は SMB 越しだと 1 枚 1 往復かかる (359 頁の本で 363 回・236 ms)。
// 木を歩く時点では「葉が並んでいるだけの節 (Count と Kids の数が同じ)」を信じて
// 読まずに並べ、実際に出す頁だけ pageAt が読む。信じた先が節だった本 (入れ子の木) は
// そこで気づいて歩き直すので、間違ったまま進むことはない
async function collectPages(doc, { strict = false } = {}) {
  const root = await resolve(doc, doc.trailer.Root);
  if (!root || !root.Pages) throw new Error('no pages');
  const pages = [];
  const seen = new Set();
  const walk = async (ref, inherited, depth) => {
    const key = ref && typeof ref === 'object' && 'ref' in ref ? ref.ref : null;
    if (key != null) {
      if (seen.has(key)) return;
      seen.add(key);
    }
    const node = await resolve(doc, ref);
    if (!node || typeof node !== 'object') {
      // 引けない頁でも席は空けておく。飛ばすと以降の頁番号が 1 つずつずれ、
      // 栞も一覧も 1 頁ぶん狂う (出せないことは出す時に理由つきで分かる)
      if (depth > 0) pages.push({ ref, inherited, node: null, ready: null });
      return;
    }
    const own = inheritFrom(node, inherited);
    const kids = await resolve(doc, node.Kids);
    if (node.Type === '/Pages' || Array.isArray(kids)) {
      const list = Array.isArray(kids) ? kids : [];
      const count = Number(node.Count);
      if (!strict && list.length > 0 && count === list.length) {
        for (const kid of list) pages.push({ ref: kid, inherited: own, node: null, ready: null });
        return;
      }
      for (const kid of list) {
        if (pages.length > 100000) return;
        await walk(kid, own, depth + 1);
      }
      return;
    }
    pages.push({ ref, inherited, node, ready: null });
  };
  await walk(root.Pages, { resources: null, mediaBox: null, cropBox: null, rotate: 0 }, 0);
  return pages;
}

// 頁の属性は親から継ぐ (自分が持っていれば自分が勝つ)
function inheritFrom(node, inherited) {
  return {
    resources: node.Resources !== undefined ? node.Resources : inherited.resources,
    mediaBox: node.MediaBox !== undefined ? node.MediaBox : inherited.mediaBox,
    cropBox: node.CropBox !== undefined ? node.CropBox : inherited.cropBox,
    rotate: node.Rotate !== undefined ? node.Rotate : inherited.rotate,
  };
}

async function pageAt(doc, index) {
  let slot = doc.pages[index];
  if (!slot) return null;
  if (slot.ready) return slot.ready;
  let node = slot.node || await resolve(doc, slot.ref);
  if (!node || typeof node !== 'object') return null;
  const kids = await resolve(doc, node.Kids);
  if (node.Type === '/Pages' || Array.isArray(kids)) {
    // 葉だと思っていた先が節だった: 横着をやめて木を歩き直す。
    // 同時に何頁も頼まれていても歩くのは一度だけ (同じ約束を待ち合わせる)
    if (!doc.strictWalk) {
      doc.strictWalk = collectPages(doc, { strict: true }).then((pages) => {
        doc.pages = pages;
        return pages;
      });
    }
    await doc.strictWalk;
    slot = doc.pages[index];
    if (!slot) return null;
    if (slot.ready) return slot.ready;
    node = slot.node || await resolve(doc, slot.ref);
    if (!node || typeof node !== 'object') return null;
  }
  slot.node = node;
  slot.ready = { ...inheritFrom(node, slot.inherited), node };
  return slot.ready;
}

// ── 開いた本の控え ───────────────────────────────────────────
// 一冊につき fd と索引を抱える。ここで大事なのは「まだ使っている本を閉じない」こと:
// 机上版と手のひら版と裏の用意が同じ本を同時に触るので、数だけで古い順に閉じると
// 読んでいる最中の fd が落ちて「file closed」で頁が出なくなる (実測で 4 千頁が落ちた)。
// 貸出中 (uses > 0) は閉じず、余っている本から順に閉じる

const open = new Map();   // file → { loading, doc, uses, retired }
// 開けなかった本。憶えないと、頁を頼まれるたびに丸ごと読み直す (500 MB の本で 1 頁 200 ms の無駄)
const failed = new Map();   // file → 失敗した時刻

function closeSlot(slot) {
  slot.retired = true;
  if (slot.uses > 0) return;   // 返ってきたときに閉じる
  slot.loading.then((doc) => doc.handle.close().catch(() => {}), () => {});
}

// 余っている本から順に閉じる。全部貸出中なら一時的に増やしたまま進む
function evictIdle() {
  if (open.size <= OPEN_MAX) return;
  for (const [key, slot] of [...open]) {
    if (open.size <= OPEN_MAX) return;
    if (slot.uses > 0) continue;
    open.delete(key);
    closeSlot(slot);
  }
}

async function loadDoc(file) {
  const handle = await fs.promises.open(file, 'r');
  const doc = {
    file, handle, size: 0, mtimeMs: 0, checkedAt: 0, trailer: null, pages: [],
    xref: new Map(),            // obj 番号 → 位置 (number) か { objstm, idx }
    objects: new Map(),         // 読んだ obj の控え
    objstms: new Map(),         // ほどいた object stream (番号 → { text, offsets })
    objstmsToExpand: [],        // 走査の保険で見つけた object stream (まだほどいていない)
    strictWalk: null,           // 木を歩き直している最中の約束 (同時に二度歩かない)
  };
  try {
    const stat = await handle.stat();
    doc.size = stat.size;
    doc.mtimeMs = stat.mtimeMs;
    doc.checkedAt = Date.now();
    try {
      await buildIndexFromXref(doc);
      requireOpenBook(doc);
      doc.pages = await collectPages(doc);
    } catch (error) {
      if (error && error.message === 'encrypted') throw error;
      await buildIndexByScan(doc);
      requireOpenBook(doc);
      doc.pages = await collectPages(doc);
    }
    return doc;
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

// 暗号化された本は stream を復号しないと読めない。手を出さず焼き場 (pdf.js) に任せる
function requireOpenBook(doc) {
  if (doc.trailer && doc.trailer.Encrypt !== undefined) throw new Error('encrypted');
}

async function acquireDoc(file) {
  const key = path.resolve(file);
  const fail = failed.get(key);
  if (fail !== undefined && Date.now() - fail < FAIL_TTL_MS) throw new Error('open failed (memo)');
  const have = open.get(key);
  if (have) {
    const doc = await have.loading.catch(() => null);
    if (doc) {
      const now = Date.now();
      const fresh = now - doc.checkedAt < STAT_TTL_MS;
      // 差し替わった本を掴み続けない。ただし SMB 越しの stat は 1 往復かかるので、
      // 続けて頁を頼まれている間は訊き直さない
      const stat = fresh ? null : await fs.promises.stat(file).catch(() => null);
      if (fresh || (stat && stat.size === doc.size && stat.mtimeMs === doc.mtimeMs)) {
        if (!fresh) doc.checkedAt = now;
        have.uses += 1;
        open.delete(key);
        open.set(key, have);   // 新しい順に並べ直す
        return have;
      }
      open.delete(key);
      closeSlot(have);
    } else {
      open.delete(key);
    }
  }
  const slot = { loading: null, doc: null, uses: 1, retired: false };
  slot.loading = loadDoc(file).then((doc) => {
    slot.doc = doc;
    return doc;
  });
  open.set(key, slot);
  slot.loading.catch(() => {
    if (open.get(key) === slot) open.delete(key);
    failed.set(key, Date.now());
  });
  await slot.loading;
  evictIdle();
  return slot;
}

function releaseDoc(slot) {
  slot.uses -= 1;
  if (slot.retired) closeSlot(slot);
  else evictIdle();
}

// 本を借りて仕事をして返す。呼び手はこの中でだけ doc を触る
async function withDoc(file, run) {
  const slot = await acquireDoc(file);
  try {
    return await run(slot.doc);
  } finally {
    releaseDoc(slot);
  }
}

// 実体を取り込み直した時に忘れる (次に頼まれたら開き直す)
function forget(file) {
  const key = path.resolve(file);
  const slot = open.get(key);
  if (slot) {
    open.delete(key);
    closeSlot(slot);
  }
  failed.delete(key);
  warned.delete(key);
  warned.delete(file);
}

// ── 頁の絵 ───────────────────────────────────────────────────

// stream の解き方。索引や束は Flate か生だけ。絵はここに DCT (JPEG) が加わる
function filterOf(dict) {
  let filter = dict.Filter;
  if (Array.isArray(filter)) {
    if (filter.length === 0) filter = undefined;
    else if (filter.length === 1) [filter] = filter;
    else return null;
  }
  if (filter === undefined) return 'raw';
  if (filter === '/FlateDecode') return 'flate';
  if (filter === '/DCTDecode') return 'dct';
  return null;
}

// 絵の解き方。JPEG を Flate でもう一度包んだ本 ([/FlateDecode /DCTDecode]) があるので、
// 「外側をほどく (preFlate) → 中は JPEG」という形も受ける
function imageCodec(dict) {
  const raw = dict.Filter;
  const names = raw === undefined ? [] : (Array.isArray(raw) ? raw : [raw]);
  const list = names.map((n) => (typeof n === 'string' ? n : '?'));
  if (list.length === 0) return { codec: 'raw', preFlate: false };
  if (list.length === 1) {
    if (list[0] === '/FlateDecode') return { codec: 'flate', preFlate: false };
    if (list[0] === '/DCTDecode') return { codec: 'dct', preFlate: false };
    return { bad: list[0].slice(1) };
  }
  if (list.length === 2 && list[0] === '/FlateDecode' && list[1] === '/DCTDecode') {
    return { codec: 'dct', preFlate: true };
  }
  return { bad: list.map((n) => n.slice(1)).join('+') };
}

async function channelsOf(doc, dict, resources = null) {
  let cs = await resolve(doc, dict.ColorSpace);
  // 頁の Resources で名前を付けた色空間 (/ColorSpace /CS0)。Acrobat 製の本で出る
  if (typeof cs === 'string' && !cs.startsWith('/Device') && !cs.startsWith('/Cal')) {
    const table = resources ? await resolve(doc, resources.ColorSpace) : null;
    const named = table ? await resolve(doc, table[cs.slice(1)]) : null;
    if (named !== null && named !== undefined) cs = named;
  }
  if (cs === '/DeviceRGB' || cs === '/CalRGB') return 3;
  if (cs === '/DeviceGray' || cs === '/CalGray') return 1;
  if (Array.isArray(cs)) {
    if (cs[0] === '/ICCBased') {
      const icc = await readObject(doc, cs[1] && cs[1].ref);
      const n = icc && icc.value && icc.value.N;
      return n === 1 || n === 3 ? n : null;
    }
    if (cs[0] === '/CalRGB') return 3;
    if (cs[0] === '/CalGray') return 1;
  }
  return null;
}

// JPEG をそのまま配ってよい色空間 (none = 色空間の指定が無い = JPEG の中身に従う)
const DCT_COLORS = new Set(['DeviceRGB', 'DeviceGray', 'DeviceCMYK', 'CalRGB', 'CalGray', 'ICCBased', 'none']);

function colorName(dict) {
  const cs = dict.ColorSpace;
  if (typeof cs === 'string') return cs.slice(1);
  if (Array.isArray(cs) && typeof cs[0] === 'string') return cs[0].slice(1);
  return 'none';
}

// 縮める前に掛かっている予測子。Filter が二段なら 1 段目 (Flate) の分を見る
async function predictorOf(doc, dict) {
  let parms = await resolve(doc, dict.DecodeParms);
  if (Array.isArray(parms)) parms = await resolve(doc, parms[0]);
  if (!parms || typeof parms !== 'object') return null;
  const predictor = Number(parms.Predictor) || 1;
  if (predictor <= 1) return null;
  return {
    predictor,
    columns: Number(parms.Columns) || 0,
    colors: Number(parms.Colors) || 0,
    bpc: Number(parms.BitsPerComponent) || 8,
  };
}

// 頁に貼られた絵の素性。抜けない形なら理由を返す (呼び手が焼き場へ回す判断に使う)
async function inspectImage(doc, entry, { allowSmask = true, resources = null } = {}) {
  const dict = entry && entry.value;
  if (!dict || dict.Subtype !== '/Image') return { reason: 'not-image' };
  if (!entry.stream) return { reason: 'no-stream' };
  const width = dict.Width;
  const height = dict.Height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return { reason: 'bad-size' };
  if (dict.ImageMask === true) return { reason: 'image-mask' };
  if (dict.Mask !== undefined) return { reason: 'mask' };
  if (dict.Decode !== undefined) return { reason: 'decode-array' };
  const how = imageCodec(dict);
  if (how.bad) return { reason: `filter:${how.bad}` };
  if (how.codec !== 'dct' && dict.BitsPerComponent !== 8) return { reason: `bpc:${dict.BitsPerComponent}` };
  const channels = await channelsOf(doc, dict, resources);
  // JPEG はそのまま配るので色数を数える必要は無いが、見慣れない色空間 (パレット・
  // 分版) の JPEG は「頁に出るはずの色」と違うものを配ることになるので受けない
  if (!channels && (how.codec !== 'dct' || !DCT_COLORS.has(colorName(dict)))) {
    return { reason: `colorspace:${colorName(dict)}` };
  }
  // 画素に開くものだけ大きさを気にする。JPEG をそのまま配る頁は何画素でも構わない
  const opens = how.codec !== 'dct' || dict.SMask !== undefined;
  if (opens && width * height > MAX_PIXELS) return { reason: 'too-big' };
  const predictor = how.codec === 'dct' && !how.preFlate ? null : await predictorOf(doc, dict);
  const image = {
    width, height, channels: channels || 3, codec: how.codec, preFlate: how.preFlate, predictor,
    offset: entry.stream.offset, length: entry.stream.length, smask: null,
  };
  if (dict.SMask !== undefined) {
    if (!allowSmask) return { reason: 'smask' };
    const maskEntry = dict.SMask && dict.SMask.ref != null ? await readObject(doc, dict.SMask.ref) : null;
    const mask = maskEntry ? await inspectImage(doc, maskEntry, { allowSmask: false, resources }) : { reason: 'smask' };
    // 透過は画素に開けるものだけ受ける。寸法が本体と違うものは伸ばす手が要るので受けない
    if (mask.reason) return { reason: `smask(${mask.reason})` };
    if (mask.image.codec === 'dct' || mask.image.channels !== 1) return { reason: 'smask-codec' };
    if (mask.image.width !== width || mask.image.height !== height) return { reason: 'smask-size' };
    image.smask = mask.image;
  }
  return { image };
}

// ── 頁が「絵 1 枚で全面」かを確かめる ────────────────────────
// 絵をそのまま出してよいのは、その頁が絵 1 枚を紙いっぱいに貼っただけの時に限る。
// 文字や図形が重なっていたり、絵が斜めだったり、一部しか使っていない頁で
// 絵だけ出すと「読み手が見るはずの頁」と違うものが出る: そういう頁は焼き場へ回す

const PAINT_OPS = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'sh', 'EI']);
const TEXT_OPS = new Set(['BT', 'Tj', 'TJ', "'", '"', 'ET']);
// 曲線は四角に直せない。これが出たら切り抜きの形は読めないものとして扱う
const CURVE_OPS = new Set(['c', 'v', 'y']);

// 直線で書いた四角を四角として読む。切り抜きを `0 0 w h re` ではなく
// `0 0 m w 0 l w h l 0 h l h` と書く本があり、読めないと全部焼き場へ落ちる
function rectFromPoints(pts) {
  let list = pts;
  if (list.length === 5) {
    const [first] = list;
    const last = list[4];
    if (Math.abs(first[0] - last[0]) > 1e-6 || Math.abs(first[1] - last[1]) > 1e-6) return null;
    list = list.slice(0, 4);
  }
  if (list.length !== 4) return null;
  const xs = [...new Set(list.map((q) => Math.round(q[0] * 1e6) / 1e6))];
  const ys = [...new Set(list.map((q) => Math.round(q[1] * 1e6) / 1e6))];
  if (xs.length !== 2 || ys.length !== 2) return null;
  // 4 点が {x0,x1}×{y0,y1} の四隅を一つずつ埋めていること (斜めの帯を弾く)
  const corners = new Set();
  for (const [x, y] of list) corners.add(`${Math.round(x * 1e6)},${Math.round(y * 1e6)}`);
  if (corners.size !== 4) return null;
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function mulMatrix(m, ctm) {
  return [
    m[0] * ctm[0] + m[1] * ctm[2],
    m[0] * ctm[1] + m[1] * ctm[3],
    m[2] * ctm[0] + m[3] * ctm[2],
    m[2] * ctm[1] + m[3] * ctm[3],
    m[4] * ctm[0] + m[5] * ctm[2] + ctm[4],
    m[4] * ctm[1] + m[5] * ctm[3] + ctm[5],
  ];
}

// 単位正方形を ctm で写した四角。絵を貼る向き (upright) を要るときは strict = true。
// 切り抜きの四角は裏返しでも四角なので strict は要らない。Chromium の印刷は
// 紙ごと上下を裏返した座標系で書くので (d が負)、そこで弾くと全部が焼き場へ落ちる
function rectOf(ctm, strict = true) {
  if (Math.abs(ctm[1]) > 1e-6 || Math.abs(ctm[2]) > 1e-6) return null;
  if (strict && (ctm[0] <= 0 || ctm[3] <= 0)) return null;
  const x0 = ctm[4];
  const y0 = ctm[5];
  const x1 = ctm[4] + ctm[0];
  const y1 = ctm[5] + ctm[3];
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
}

function scanContent(text) {
  const lexer = new Lexer(text);
  const out = { draws: [], bad: null, states: [] };
  let ctm = [1, 0, 0, 1, 0, 0];
  // 切り抜きは図形状態の一部で、q/Q で積み降ろしされる。全体で交差し続けると、
  // 絵と関係ない別の q..Q の切り抜きが残って「切られている」と誤判定する
  let clip = null;
  const stack = [];
  let operands = [];
  let pathRect = null;
  let pathPts = [];
  let pathOther = false;
  let pendingClip = false;
  for (;;) {
    let tok;
    try {
      tok = lexer.token();
    } catch (error) {
      if (error === EOF) break;
      out.bad = 'parse';
      return out;
    }
    if (tok.t === 'num' || tok.t === 'name') {
      operands.push(tok.v);
      continue;
    }
    if (tok.t !== 'kw') {
      // 辞書・配列・文字列は読み飛ばすだけ (演算子の引数)
      try {
        lexer.value(tok);
      } catch {
        out.bad = 'parse';
        return out;
      }
      operands.push(null);
      continue;
    }
    const op = tok.v;
    if (op === 'BI') { out.bad = 'inline-image'; return out; }
    if (TEXT_OPS.has(op)) { out.bad = 'text'; return out; }
    if (op === 'q') stack.push({ ctm, clip });
    else if (op === 'Q') {
      const back = stack.pop() || { ctm: [1, 0, 0, 1, 0, 0], clip: null };
      ctm = back.ctm;
      clip = back.clip;
    } else if (op === 'cm' && operands.length >= 6) ctm = mulMatrix(operands.slice(-6).map(Number), ctm);
    else if (op === 're' && operands.length >= 4) {
      const [x, y, w, h] = operands.slice(-4).map(Number);
      const rect = rectOf(mulMatrix([w, 0, 0, h, x, y], ctm), false);
      if (!rect || pathRect || pathPts.length) pathOther = true;   // 四角が二つ以上: 形が読めない
      else pathRect = rect;
    } else if ((op === 'm' || op === 'l') && operands.length >= 2) {
      const [x, y] = operands.slice(-2).map(Number);
      if (pathRect) pathOther = true;
      else pathPts.push([x * ctm[0] + y * ctm[2] + ctm[4], x * ctm[1] + y * ctm[3] + ctm[5]]);
    } else if (op === 'h') { /* 閉じるだけ。点は増えない */ }
    else if (CURVE_OPS.has(op)) pathOther = true;
    else if (op === 'W' || op === 'W*') pendingClip = true;
    else if (op === 'n') {
      if (pendingClip) {
        const rect = pathRect || rectFromPoints(pathPts);
        if (pathOther || !rect) { out.bad = 'clip'; return out; }
        clip = clip ? [
          Math.max(clip[0], rect[0]), Math.max(clip[1], rect[1]),
          Math.min(clip[2], rect[2]), Math.min(clip[3], rect[3]),
        ] : rect;
      }
      pendingClip = false;
      pathRect = null;
      pathPts = [];
      pathOther = false;
    } else if (PAINT_OPS.has(op)) { out.bad = op === 'sh' ? 'shading' : 'paint'; return out; }
    else if (op === 'gs') {
      const name = operands.length ? operands[operands.length - 1] : null;
      if (typeof name === 'string') out.states.push(name);
    } else if (op === 'Do') {
      const name = operands.length ? operands[operands.length - 1] : null;
      out.draws.push({ name: typeof name === 'string' ? name : null, rect: rectOf(ctm), clip });
    }
    operands = [];
  }
  return out;
}

// 紙の見える範囲。CropBox があれば MediaBox との交わり
function visibleBox(mediaValue, cropValue) {
  const media = boxOf(mediaValue);
  if (!media) return null;
  const crop = boxOf(cropValue);
  if (!crop) return media;
  const box = [
    Math.max(media[0], crop[0]), Math.max(media[1], crop[1]),
    Math.min(media[2], crop[2]), Math.min(media[3], crop[3]),
  ];
  return box[2] > box[0] && box[3] > box[1] ? box : null;
}

function boxOf(value) {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const nums = value.map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  return [Math.min(nums[0], nums[2]), Math.min(nums[1], nums[3]), Math.max(nums[0], nums[2]), Math.max(nums[1], nums[3])];
}

function sameRect(a, b, tol) {
  return Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol
    && Math.abs(a[2] - b[2]) <= tol && Math.abs(a[3] - b[3]) <= tol;
}

function coversRect(outer, inner, tol) {
  return outer[0] <= inner[0] + tol && outer[1] <= inner[1] + tol
    && outer[2] >= inner[2] - tol && outer[3] >= inner[3] - tol;
}

// 頁の内容ストリームを読んで「絵 1 枚で全面」を確かめる。
// 返すのは貼られている絵の名前か、駄目な理由
async function singlePictureName(doc, page) {
  const node = page.node;
  if (!node) return { reason: 'no-page-dict' };
  const visible = visibleBox(await resolve(doc, page.mediaBox), await resolve(doc, page.cropBox));
  if (!visible) return { reason: 'no-mediabox' };
  let list = await resolve(doc, node.Contents);
  if (list === undefined || list === null) return { reason: 'no-contents' };
  if (!Array.isArray(list)) list = [node.Contents];
  let text = '';
  let total = 0;
  for (const ref of list) {
    const num = ref && ref.ref;
    if (num == null) return { reason: 'contents-ref' };
    const entry = await readObject(doc, num);
    if (!entry || !entry.stream) return { reason: 'contents-missing' };
    total += entry.stream.length;
    if (total > CONTENT_MAX) return { reason: 'contents-big' };
    try {
      text += `${(await decodeStream(doc, entry)).toString('latin1')}\n`;
    } catch {
      return { reason: 'contents-filter' };
    }
  }
  const scan = scanContent(text);
  if (scan.bad) return { reason: scan.bad };
  if (scan.draws.length !== 1) return { reason: `draws:${scan.draws.length}` };
  // 使っている描画状態 (gs) が絵の見え方を変えるなら、絵だけ出しても同じにならない
  if (scan.states.length) {
    const resources = await resolve(doc, page.resources);
    const table = resources ? await resolve(doc, resources.ExtGState) : null;
    for (const name of scan.states) {
      const state = table ? await resolve(doc, table[name.slice(1)]) : null;
      if (!state || typeof state !== 'object') return { reason: 'gs-unknown' };
      if (state.SMask !== undefined && state.SMask !== '/None') return { reason: 'gs-smask' };
      if (Number(state.ca) < 1 || Number(state.CA) < 1) return { reason: 'gs-alpha' };
      if (state.BM !== undefined && state.BM !== '/Normal' && state.BM !== '/Compatible') return { reason: 'gs-blend' };
    }
  }
  const [draw] = scan.draws;
  if (!draw.name || !draw.rect) return { reason: 'skewed' };
  const tol = Math.max(1, 0.01 * Math.max(visible[2] - visible[0], visible[3] - visible[1]));
  if (!sameRect(draw.rect, visible, tol)) return { reason: 'not-full-page' };
  // 効いているのは、その絵を貼った時点の切り抜きだけ
  if (draw.clip && !coversRect(draw.clip, visible, tol)) return { reason: 'clipped' };
  return { name: draw.name };
}

// index 頁の絵の素性と本体。抜けないときは { reason } を返す
function readPageDetail(file, index) {
  return withDoc(file, (doc) => readPageIn(doc, index));
}

async function readPageIn(doc, index) {
  const page = await pageAt(doc, index);
  if (!page) return { reason: 'no-page' };
  const rotate = (((Number(await resolve(doc, page.rotate)) || 0) % 360) + 360) % 360;
  // 回っている頁は絵も回して出す必要がある。焼き場に任せる
  if (rotate !== 0) return { reason: `rotate:${rotate}` };
  const found = await singlePictureName(doc, page);
  if (found.reason) return { reason: found.reason };
  const resources = await resolve(doc, page.resources);
  const xobjects = resources && await resolve(doc, resources.XObject);
  if (!xobjects || typeof xobjects !== 'object') return { reason: 'no-xobject' };
  const ref = xobjects[found.name.slice(1)];
  if (!ref || typeof ref !== 'object' || ref.ref == null) return { reason: 'no-xobject-entry' };
  const looked = await inspectImage(doc, await readObject(doc, ref.ref), { resources });
  if (looked.reason) return { reason: looked.reason };
  const { image } = looked;
  const bytes = await readRange(doc, image.offset, image.length);
  if (bytes.length !== image.length) return { reason: 'short-read' };
  let smaskBytes = null;
  if (image.smask) {
    smaskBytes = await readRange(doc, image.smask.offset, image.smask.length);
    if (smaskBytes.length !== image.smask.length) return { reason: 'short-read-smask' };
  }
  return { ...image, bytes, smaskBytes, filter: image.codec };
}

// 昔からの呼び名 (テストと棚卸しが使う)。抜けなければ null
async function readPageImage(file, index) {
  const detail = await readPageDetail(file, index);
  return detail.reason ? null : detail;
}

// 直読みできるか・できないなら何故かを見るだけの口 (棚卸しと一度きりの警告に使う)
async function inspectPage(file, index) {
  try {
    const detail = await readPageDetail(file, index);
    if (detail.reason) return { ok: false, reason: detail.reason };
    return {
      ok: true,
      codec: detail.codec,
      preFlate: detail.preFlate,
      width: detail.width,
      height: detail.height,
      channels: detail.channels,
      smask: Boolean(detail.smask),
      predictor: Boolean(detail.predictor),
    };
  } catch (error) {
    return { ok: false, reason: `error:${String((error && error.message) || error).slice(0, 40)}` };
  }
}

function pageCount(file) {
  return withDoc(file, (doc) => doc.pages.length);
}

// 頁ごとの縦横比 (MediaBox から。絵を読まずに済む)
function pageShapes(file) {
  return withDoc(file, (doc) => shapesIn(doc));
}

async function shapesIn(doc) {
  const ratios = [];
  for (let i = 0; i < doc.pages.length; i += 1) {
    const page = await pageAt(doc, i);
    let ratio = 0;
    // 焼き場 (pdf.js の getViewport) は CropBox と MediaBox の交わりで測る。
    // 揃えておかないと、直読みの頁と焼いた頁で枠の縦横比が食い違ってガタつく
    const box = page ? visibleBox(await resolve(doc, page.mediaBox), await resolve(doc, page.cropBox)) : null;
    if (box) {
      const w = box[2] - box[0];
      const h = box[3] - box[1];
      const rotate = Number(await resolve(doc, page.rotate)) || 0;
      const turned = Math.abs(rotate % 180) === 90;
      if (w > 0 && h > 0) ratio = Math.round(((turned ? h : w) / (turned ? w : h)) * 1000) / 1000;
    }
    ratios.push(ratio);
  }
  return { pageCount: doc.pages.length, ratios };
}

// ── ほどく worker ────────────────────────────────────────────

const workers = [];   // { worker, busy, job, idleTimer }

// 行列は三本。空いた worker には上から順に渡す。
//   read — 今出そうとしている頁。利用者が画面を見て待っている
//   soon — 見えている小さい一枚 (棚の表紙)。待たれてはいるが頁の送りには道を譲る。
//          取り下げない (取り下げると札が空のまま残る)
//   idle — 先の頁の用意。いつでも取り下げてよい (dropBackground)
// 二本 (表/裏) だった頃は棚の表紙の置き場が無かった。裏へ回すと本の裏の用意
// 何百頁の後ろに並んで札が何秒も空になり、表へ入れると頁の送りを待たせた (実測 460ms)
const queues = { read: [], soon: [], idle: [] };

// 行列の選び方。lane の名指しが無い古い呼び手は background から決める
function laneOf(background, lane) {
  if (lane && queues[lane]) return lane;
  return background ? 'idle' : 'read';
}

function spawnWorker() {
  const slot = { worker: null, busy: false, job: null, idleTimer: null };
  // asar の中の原本は worker から開けない: asarUnpack で外に置いた写しを指す
  const worker = new Worker(unpackedPath(path.join(__dirname, 'pdf-unpack-worker.js')));
  slot.worker = worker;
  worker.on('message', (message) => {
    const { job } = slot;
    slot.job = null;
    slot.busy = false;
    if (job) {
      if (message && message.error) job.reject(new Error(message.error));
      else job.resolve(message || null);
    }
    pump();
    noteWorkerIdle(slot);
  });
  const drop = (error) => {
    const { job } = slot;
    const at = workers.indexOf(slot);
    if (at >= 0) workers.splice(at, 1);
    clearTimeout(slot.idleTimer);
    slot.job = null;
    if (job) job.reject(error instanceof Error ? error : new Error(String(error)));
    pump();
  };
  worker.on('error', drop);
  worker.on('exit', () => drop(new Error('worker exited')));
  workers.push(slot);
  return slot;
}

function noteWorkerIdle(slot) {
  clearTimeout(slot.idleTimer);
  slot.idleTimer = setTimeout(() => {
    if (slot.busy) return;
    const at = workers.indexOf(slot);
    if (at >= 0) workers.splice(at, 1);
    slot.worker.terminate().catch(() => {});
  }, WORKER_IDLE_MS);
  if (slot.idleTimer.unref) slot.idleTimer.unref();
}

function pump() {
  for (;;) {
    const job = queues.read.shift() || queues.soon.shift() || queues.idle.shift();
    if (!job) return;
    let slot = workers.find((w) => !w.busy);
    if (!slot && workers.length < POOL) slot = spawnWorker();
    if (!slot) {
      queues[job.lane].unshift(job);
      return;
    }
    clearTimeout(slot.idleTimer);
    slot.busy = true;
    slot.job = job;
    slot.worker.postMessage(job.payload, job.transfers);
  }
}

// worker に一仕事投げる。返るのは worker の返事そのもの
// ({ jpeg } / { bgra } / { bytes } / { unsupported })。
// 取り下げられた時は DROPPED (読めない null とは別: 呼び手が焼き場へ回さないため)
function askWorker(payload, { background = false, lane = '', tag = '' } = {}, transfers = []) {
  return new Promise((resolve, reject) => {
    const job = {
      payload, lane: laneOf(background, lane), tag, transfers, resolve: null, reject: null,
    };
    // 詰まった worker のせいで読み手を待たせ続けない。切れたらその頁は焼き場へ回る
    const timer = setTimeout(() => {
      job.done = true;
      reject(new Error('worker timeout'));
    }, WORKER_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    job.resolve = (value) => {
      if (job.done) return;
      job.done = true;
      clearTimeout(timer);
      resolve(value);
    };
    job.reject = (error) => {
      if (job.done) return;
      job.done = true;
      clearTimeout(timer);
      reject(error);
    };
    queues[job.lane].push(job);
    pump();
  });
}


// 自分の側の裏仕事だけ取り下げる (prefix)。今すすめている札 (keep) は残す。
// 机上版と手のひら版が同じ行列を使うので、'' で全消しすると互いの用意を消し合う
function dropBackgroundExcept(prefix, keep) {
  const idle = queues.idle;
  for (let i = idle.length - 1; i >= 0; i -= 1) {
    const tag = String(idle[i].tag || '');
    if (!tag.startsWith(prefix) || tag === keep) continue;
    idle[i].resolve(DROPPED);
    idle.splice(i, 1);
  }
}

// 裏の続きを取り下げる。別の本を開いた時に前の本を追わせない
function dropBackground(tag) {
  const idle = queues.idle;
  for (let i = idle.length - 1; i >= 0; i -= 1) {
    if (tag && idle[i].tag !== tag) continue;
    idle[i].resolve(DROPPED);
    idle.splice(i, 1);
  }
}

// ── 符号化 (sharp が無い時の予備。主スレッドを止めるので普段は通らない) ──────

function nativeImageOrNull() {
  try {
    const electron = require('electron');
    return electron && electron.nativeImage ? electron.nativeImage : null;
  } catch {
    return null;
  }
}

function encodeBgra(bgra, width, height, targetWidth, quality) {
  const nativeImage = nativeImageOrNull();
  if (!nativeImage) return null;
  let image = nativeImage.createFromBitmap(bgra, { width, height });
  // 'good' と 'better' は同じ物が出る (実測でバイト一致)。'best' だけが濾波を強め、
  // 網点のモアレが減る。縮めるのは LAN へ配る時だけなので 1 枚 +8 ms は許せる
  if (targetWidth > 0 && targetWidth < width) image = image.resize({ width: targetWidth, quality: 'best' });
  return image.toJPEG(Math.round(quality * 100));
}

function shrinkJpeg(bytes, targetWidth, quality) {
  const nativeImage = nativeImageOrNull();
  if (!nativeImage) return null;
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) return null;
  return image.resize({ width: targetWidth, quality: 'best' }).toJPEG(Math.round(quality * 100));
}

// 手元の絵を縮める (一覧の小札を原本から作る)。sharp が無ければ主スレッドで縮める
async function shrinkBytes(bytes, options = {}) {
  const target = Math.max(0, Math.round(Number(options.width) || 0));
  if (!target) return null;
  const buf = toBuffer(bytes);
  const quality = Number(options.quality) || 0.8;
  try {
    const res = await askWorker(
      { kind: 'shrink', bytes: buf, encode: { width: target, quality } },
      { background: options.background === true, tag: options.tag || '' },
    );
    if (res === DROPPED) return null;
    if (res && res.jpeg) return { bytes: toBuffer(res.jpeg), type: 'image/jpeg' };
  } catch {
    // 縮められなければ原寸のまま出す (呼び手が null を見て諦めないように)
  }
  const shrunk = shrinkJpeg(buf, target, quality);
  return shrunk ? { bytes: shrunk, type: 'image/jpeg' } : null;
}

// 綴じ手 (pdf-write) のための焼き口。webp/avif/png の頁を**原寸のまま** JPEG にする。
// 縮める shrinkBytes とは別物: あちらは棚の小札用で色差を間引く (4:2:0)。
//
// 行列は soon。read (今めくっている頁) には道を譲りつつ、idle と違って
// **取り下げられない**: 綴じている最中に本を切り替えられて頁が消えると、
// 出来上がった PDF に穴が空く
async function pageJpegBytes(bytes, { quality = 0.92, tag = '' } = {}) {
  const res = await askWorker(
    { kind: 'topdf', bytes: toBuffer(bytes), encode: { quality } },
    { lane: 'soon', tag },
  );
  if (res === DROPPED || !res || !res.jpeg) return null;
  return toBuffer(res.jpeg);
}

// 綴じ手のための開き口 (PNG の例外用)。生画素 (+透過) を deflate した物で返す。
// 可逆で据える (pdf-write の Flate の道)。行列は topdf と同じ soon
async function pagePlaneBytes(bytes, { tag = '' } = {}) {
  const res = await askWorker(
    { kind: 'toplane', bytes: toBuffer(bytes) },
    { lane: 'soon', tag },
  );
  if (res === DROPPED || !res || !res.plane) return null;
  return {
    width: res.width,
    height: res.height,
    channels: res.channels,
    plane: toBuffer(res.plane),
    smask: res.smask ? toBuffer(res.smask) : null,
  };
}

const warned = new Map();
function warnOnce(file, reason) {
  if (warned.has(file)) return;
  warned.set(file, reason);
  // 名指しは Eagle のアイテム id (<id>.info) だけにする。原本の名前は作品名そのもので、
  // 記録に残す物ではない
  console.warn('[pdf-unpack] 直読みできず焼き場へ回します', path.basename(path.dirname(file)), reason);
}

// 焼き場へ回した本と、その理由 (設定画面の棚卸しに出す)
function fallbacks() {
  return [...warned.entries()].map(([file, reason]) => ({ file, reason }));
}

function toBuffer(view) {
  if (Buffer.isBuffer(view)) return view;
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
}

// index 頁を width (0 は原寸) の JPEG にする。抜けない本は null (呼び手が焼き場へ)。
// options.lane は行列 ('read' 頁 / 'soon' 見えている札 / 'idle' 先の用意)、
// tag は取り下げの札。lane を省くと background から決まる (既定は 'read')
async function unpackPage(file, index, options = {}) {
  try {
    return await unpackIn(file, index, options);
  } catch (error) {
    // worker の時限切れ・読みの失敗。焼き場に回せば出るので、ここで握って null にする
    warnOnce(file, `error:${(error && error.message) || error}`);
    return null;
  }
}

async function unpackIn(
  file, index, { width = 0, quality = 0.9, background = false, lane = '', tag = '' } = {},
) {
  const page = await readPageDetail(file, index);
  if (page.reason) {
    warnOnce(file, page.reason);
    return null;
  }
  const target = Math.max(0, Math.round(Number(width) || 0));
  const encode = { quality, width: target };
  const send = (job, transfers) => askWorker(job, { background, lane, tag }, transfers);

  // JPEG がそのまま入っている頁。縮める必要が無ければ原本のバイトをそのまま配る
  // (ここだけは符号化を通らないので無劣化)
  if (page.codec === 'dct') {
    let bytes = page.bytes;
    if (page.preFlate) {
      const undone = await send({ kind: 'unwrap', codec: 'flate', bytes }, [bytes.buffer]);
      if (undone === DROPPED) return DROPPED;
      if (!undone || !undone.bytes) return null;
      bytes = toBuffer(undone.bytes);
    }
    const size = imageSize(bytes);
    if (!size) return null;
    if (!page.smask) {
      if (target === 0 || size.width <= target * 1.15) return { bytes, type: 'image/jpeg' };
      // 縮めるのも worker で。原本は手元に残す (sharp が無ければ主スレッドで縮める)
      const res = await send({ kind: 'shrink', bytes, encode });
      if (res === DROPPED) return DROPPED;
      if (res && res.jpeg) return { bytes: toBuffer(res.jpeg), type: 'image/jpeg' };
      const shrunk = shrinkJpeg(bytes, target, quality);
      return shrunk ? { bytes: shrunk, type: 'image/jpeg' } : null;
    }
    // 透過つきの JPEG: worker で開いて白地に潰し、焼き直す
    const res = await send({ kind: 'dctmask', bytes, smask: maskJob(page), encode });
    if (res === DROPPED) return DROPPED;
    if (res && res.jpeg) return { bytes: toBuffer(res.jpeg), type: 'image/jpeg' };
    // 予備: 主スレッドで画素に開き、透過を worker で重ねてから焼く
    const nativeImage = nativeImageOrNull();
    if (!nativeImage) return null;
    const opened = nativeImage.createFromBuffer(bytes);
    if (opened.isEmpty()) return null;
    const bitmap = opened.toBitmap();
    const masked = await send({
      kind: 'mask', bgra: bitmap, width: size.width, height: size.height, smask: maskJob(page),
    }, [bitmap.buffer]);
    if (masked === DROPPED) return DROPPED;
    if (!masked || !masked.bgra) return null;
    const jpeg = encodeBgra(toBuffer(masked.bgra), size.width, size.height, target, quality);
    return jpeg ? { bytes: jpeg, type: 'image/jpeg' } : null;
  }

  // 生の画素 (Flate か無圧縮)。worker で画素に開いて、そのまま JPEG まで焼く
  const res = await send({
    base: {
      bytes: page.bytes, codec: page.codec, channels: page.channels,
      width: page.width, height: page.height, predictor: page.predictor,
    },
    smask: page.smask ? maskJob(page) : null,
    encode,
  }, [page.bytes.buffer]);
  if (res === DROPPED) return DROPPED;
  if (!res) return null;
  if (res.jpeg) return { bytes: toBuffer(res.jpeg), type: 'image/jpeg' };
  if (!res.bgra) return null;
  const jpeg = encodeBgra(toBuffer(res.bgra), page.width, page.height, target, quality);
  return jpeg ? { bytes: jpeg, type: 'image/jpeg' } : null;
}

function maskJob(page) {
  return {
    bytes: page.smaskBytes, codec: page.smask.codec, channels: 1,
    width: page.smask.width, height: page.smask.height, predictor: page.smask.predictor,
  };
}

// 所持の PDF の頁から AI の生成情報を読む材料 (issue #3 の埋め戻し)。
//   JPEG の頁 → { kind: 'dct', bytes } (原本のバイトそのもの。EXIF は呼び手が読む)
//   Flate の頁 → { kind: 'flate', stealth } (stealth() は worker で RGB + 透過 からステルスの字を読む。裏の行列)
//   直読みできない頁は null
async function pageAiSource(file, index) {
  const page = await readPageDetail(file, index);
  if (!page || page.reason) return null;
  if (page.codec === 'dct') {
    if (!page.preFlate) return { kind: 'dct', bytes: page.bytes };
    return {
      kind: 'dct',
      bytes: null,
      async unwrap() {
        const undone = await askWorker({ kind: 'unwrap', codec: 'flate', bytes: page.bytes }, { background: true, tag: 'ai-meta' });
        return undone && undone !== DROPPED && undone.bytes ? toBuffer(undone.bytes) : null;
      },
    };
  }
  return {
    kind: 'flate',
    async stealth() {
      const image = { bytes: page.bytes, codec: page.codec, predictor: page.predictor, width: page.width, height: page.height, channels: page.channels };
      const res = await askWorker({ kind: 'stealth', image, smask: page.smask ? maskJob(page) : null }, { background: true, tag: 'ai-meta' });
      return res && res !== DROPPED && res.text ? String(res.text) : null;
    },
  };
}

// 終了時: 開いている本と worker を手放す
async function close() {
  dropBackground('');
  for (const job of queues.soon.splice(0)) job.resolve(DROPPED);
  for (const job of queues.read.splice(0)) job.resolve(DROPPED);
  const slots = [...open.values()];
  open.clear();
  await Promise.all(slots.map((slot) => slot.loading.then((doc) => doc.handle.close().catch(() => {}), () => {})));
  await Promise.all(workers.splice(0).map((slot) => {
    clearTimeout(slot.idleTimer);
    return slot.worker.terminate().catch(() => {});
  }));
}

module.exports = {
  shrinkBytes, pageJpegBytes, pagePlaneBytes,
  unpackPage, readPageImage, readPageDetail, inspectPage, fallbacks, forget, pageAiSource,
  dropBackgroundExcept,
  pageCount, pageShapes, dropBackground, close, DROPPED,
  // テスト用
  Lexer, POOL, laneOf,
};
