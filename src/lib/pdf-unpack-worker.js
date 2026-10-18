'use strict';

// pdf-unpack の手足。PDF から抜いた絵を画素に開き、JPEG に焼くところまでを worker で持つ。
// 主スレッドは一切画素を触らない (窓の応答を止めないため)。
//
// 受け取る job:
//   { base, smask, encode }        絵の本体 (+透過)。画素に開いて JPEG を返す
//   { kind:'dctmask', bytes, … }   JPEG + 透過。開いて白地に潰してから焼き直す
//   { kind:'shrink', bytes, … }    JPEG を縮める
//   { kind:'mask', bgra, … }       sharp が無い時の予備 (主スレッドが開いた画素に透過だけ重ねる)
//   { kind:'unwrap', bytes, … }    二段フィルタの外側をほどくだけ
//   { kind:'topdf',  bytes, … }    綴じるために原寸のまま JPEG にする (pdf-write)
// 返す: { jpeg } / { bgra } / { bytes } / { unsupported:true } / { error }
//
// sharp (libvips) があれば JPEG まで worker で作る。色差を間引かない 4:4:4 で焼けるので、
// nativeImage (品質 100 でも 4:2:0 固定) より原本に近い。
// 読めない時は今までどおり画素 (bgra) を返し、主スレッドの nativeImage に任せる。
//
// 透過は「白い紙に貼った見た目」に潰す: 読み物の頁なので、抜けた所は紙の色で構わない。
// 残したまま JPEG にはできず、PNG にすると一頁 10 MB を超える

const zlib = require('zlib');
const { parentPort, isMainThread } = require('worker_threads');
const { unpredict } = require('./pdf-predictor');

const sharp = loadSharp();

function loadSharp() {
  // 試験と予備の道を確かめるための逃げ道
  if (process.env.BUNKO_NO_SHARP === '1') return null;
  try {
    const lib = require('sharp');
    // worker を 3 本立てるので、libvips に更にスレッドを張らせない (表の頁の道を塞ぐ)
    lib.concurrency(1);
    // 一枚ごとに使い捨てる絵なので、libvips の作業控えは持たせない
    lib.cache(false);
    return lib;
  } catch (error) {
    // 予備の道 (nativeImage) でも頁は出るので止めはしないが、黙って落ちると
    // 色差を間引いたまま配り続けることになる。理由を一度だけ残す
    console.warn('[pdf-unpack] sharp を読めません。生画素の頁は nativeImage で焼きます',
      (error && error.message) || error);
    return null;
  }
}

function inflate(bytes) {
  // 尻尾が欠けた stream でも、取れた所までは使う (Z_SYNC_FLUSH)
  return zlib.inflateSync(bytes, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
}

function bufOf(view) {
  if (Buffer.isBuffer(view)) return view;
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
}

// 一枚ぶんの画素を素の並び (channels バイト/画素) に戻す
function planeOf(part) {
  const bytes = bufOf(part.bytes);
  let raw = part.codec === 'flate' ? inflate(bytes) : bytes;
  if (part.predictor) {
    const p = part.predictor;
    raw = unpredict(raw, p.predictor, p.columns || part.width, p.colors || part.channels, p.bpc || 8);
  }
  const need = part.width * part.height * part.channels;
  if (raw.length < need) throw new Error(`画素が足りない (${raw.length} < ${need})`);
  return raw.length === need ? raw : raw.subarray(0, need);
}

// 所持の PDF (pdf-write が据えた RGB + 8bit 灰の SMask) から NovelAI のステルス情報を読む (issue #3 の埋め戻し)。
// 画素は左端の列だけ組む (署名と長さを読んでから要る幅だけ)。返すのは字だけ { text, signature } / { text: null }
function stealthOf(job) {
  const aiMeta = require('./ai-meta');
  const image = job.image;
  if (!image || !(image.channels === 3 || image.channels === 4)) return { text: null };
  let raw;
  let alpha = null;
  try {
    raw = planeOf(image);
    if (job.smask) alpha = planeOf({ ...job.smask, channels: 1 });
  } catch (error) {
    return { text: null, error: (error && error.message) || String(error) };
  }
  const { width, height } = image;
  const srcCh = image.channels;
  const outCh = alpha ? 4 : 3;
  const strip = (columns) => {
    const w = Math.min(columns, width);
    const data = Buffer.alloc(w * height * outCh);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const s = (y * width + x) * srcCh;
        const d = (y * w + x) * outCh;
        data[d] = raw[s]; data[d + 1] = raw[s + 1]; data[d + 2] = raw[s + 2];
        if (alpha) data[d + 3] = alpha[y * width + x];
      }
    }
    return { data, width: w, height, channels: outCh };
  };
  const first = strip(Math.max(1, Math.ceil(aiMeta.HEAD_BITS / height)));
  const probe = aiMeta.stealthProbe(first);
  if (!probe) return { text: null };
  const columns = Math.ceil((aiMeta.HEAD_BITS + probe.lengthBits) / probe.bitsPerColumn);
  if (columns > width) return { text: null };
  const text = aiMeta.stealthPayload(columns <= first.width ? first : strip(columns), probe);
  return text == null ? { text: null } : { text, signature: probe.signature };
}

// 透過を白地に潰す (画素の並びは何色でも良い。alpha は 1 バイト/画素)
function flattenWhite(raw, channels, alpha, pixels) {
  for (let i = 0, j = 0; i < pixels; i += 1, j += channels) {
    const a = alpha[i];
    if (a === 255) continue;
    if (a === 0) {
      for (let c = 0; c < channels; c += 1) raw[j + c] = 255;
      continue;
    }
    const inv = 255 - a;
    for (let c = 0; c < channels; c += 1) {
      raw[j + c] = (raw[j + c] * a + 255 * inv + 127) / 255 | 0;
    }
  }
  return raw;
}

// 素の画素を JPEG に焼く。縮めるのは LAN へ配る時だけ
function encodeRaw(raw, width, height, channels, encode = {}) {
  const target = Math.max(0, Math.round(Number(encode.width) || 0));
  let img = sharp(raw, { raw: { width, height, channels } });
  // lanczos3 は nativeImage の 'best' より網点のモアレが出にくい
  if (target > 0 && target < width) img = img.resize({ width: target, kernel: 'lanczos3' });
  // 灰色一色の絵は 1 成分の JPEG のまま出す (色差を持たないので原本に忠実で軽い)。
  // 指定しないと sharp が sRGB に広げて 3 成分になる
  if (channels === 1) img = img.toColourspace('b-w');
  return img.jpeg(jpegOpts(encode, target > 0 && target < width)).toBuffer();
}

function jpegOpts(encode, shrunk) {
  return {
    quality: Math.round((Number(encode.quality) || 0.9) * 100),
    // 原寸で出す時は色差を間引かない (原本に一番近い)。縮めた物は元々色差が半分に
    // なっているので 4:2:0 で軽くする
    chromaSubsampling: shrunk ? '4:2:0' : '4:4:4',
    mozjpeg: false,
  };
}

// 本体 (+透過) を画素に開く。sharp があれば JPEG まで、無ければ BGRA で返す
async function renderBase(job) {
  const { base } = job;
  const raw = planeOf(base);
  const pixels = base.width * base.height;
  const ch = base.channels;
  if (ch !== 1 && ch !== 3) throw new Error(`扱えない色数 ${ch}`);

  let alpha = null;
  if (job.smask) {
    if (job.smask.width !== base.width || job.smask.height !== base.height) {
      throw new Error('透過の寸法が本体と違う');
    }
    alpha = planeOf(job.smask);
  }

  if (sharp) {
    if (alpha) flattenWhite(raw, ch, alpha, pixels);
    // 灰色一色の頁は 1 成分の JPEG になる (色差そのものが無く、原本に忠実で軽い)
    const jpeg = await encodeRaw(raw, base.width, base.height, ch, job.encode);
    return { jpeg };
  }
  return { bgra: toBgraFrom(raw, ch, pixels, alpha) };
}

function toBgraFrom(raw, channels, pixels, alpha) {
  // allocUnsafe は 4 KB 未満だと 8 KB の共用 pool から切り出す。その ArrayBuffer を
  // transfer すると pool ごと持って行かれて、他の Buffer が壊れる。自前の箱を使う
  const bgra = Buffer.from(new ArrayBuffer(pixels * 4));
  if (channels === 3) {
    for (let i = 0, j = 0; j < bgra.length; i += 3, j += 4) {
      bgra[j] = raw[i + 2];
      bgra[j + 1] = raw[i + 1];
      bgra[j + 2] = raw[i];
      bgra[j + 3] = 255;
    }
  } else {
    for (let i = 0, j = 0; j < bgra.length; i += 1, j += 4) {
      const v = raw[i];
      bgra[j] = v;
      bgra[j + 1] = v;
      bgra[j + 2] = v;
      bgra[j + 3] = 255;
    }
  }
  if (alpha) flattenWhite(bgra, 4, alpha, pixels);
  return bgra;
}

// 旧い道と合わせるための入口 (BGRA を返す)
function toBgra(job) {
  const { base } = job;
  const raw = planeOf(base);
  const ch = base.channels;
  if (ch !== 1 && ch !== 3) throw new Error(`扱えない色数 ${ch}`);
  let alpha = null;
  if (job.smask) {
    if (job.smask.width !== base.width || job.smask.height !== base.height) {
      throw new Error('透過の寸法が本体と違う');
    }
    alpha = planeOf(job.smask);
  }
  return toBgraFrom(raw, ch, base.width * base.height, alpha);
}

// 既に画素に開いてある絵 (JPEG を主スレッドで開いたもの) に透過だけ重ねる
function maskBgra(job) {
  const bgra = bufOf(job.bgra);
  const pixels = job.width * job.height;
  if (bgra.length < pixels * 4) throw new Error('画素が足りない');
  return flattenWhite(bgra, 4, planeOf(job.smask), pixels);
}

// 透過つきの JPEG。開いて白地に潰し、焼き直す (sharp が要る)
async function dctMask(job) {
  if (!sharp) return { unsupported: true };
  const bytes = bufOf(job.bytes);
  // CMYK の JPEG でも 3 成分に揃える (白地に潰す計算が色空間に依らないように)
  const { data, info } = await sharp(bytes).toColourspace('srgb').raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 1 && info.channels !== 3) return { unsupported: true };
  if (info.width !== job.smask.width || info.height !== job.smask.height) {
    throw new Error('透過の寸法が本体と違う');
  }
  flattenWhite(data, info.channels, planeOf(job.smask), info.width * info.height);
  const jpeg = await encodeRaw(data, info.width, info.height, info.channels, job.encode);
  return { jpeg };
}

// JPEG を縮める (手のひら版へ配る時だけ)
async function shrink(job) {
  if (!sharp) return { unsupported: true };
  const target = Math.max(0, Math.round(Number(job.encode && job.encode.width) || 0));
  if (!target) return { unsupported: true };
  const jpeg = await sharp(bufOf(job.bytes))
    .resize({ width: target, kernel: 'lanczos3' })
    .jpeg(jpegOpts(job.encode, true))
    .toBuffer();
  return { jpeg };
}

// sharp が返す Buffer は libvips の外の記憶を指していて transfer できない
// (DataCloneError で worker ごと落ちる)。自前の箱に写してから渡す
function copyOut(buf) {
  const copy = Buffer.from(new ArrayBuffer(buf.byteLength));
  buf.copy(copy);
  return copy;
}

// transfer に出してよい箱か確かめる。zlib や allocUnsafe の返りは共用 pool の
// 切れ端のことがあり、その ArrayBuffer を渡すと pool ごと持って行かれる
function own(buf) {
  if (buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength) return buf;
  const copy = Buffer.from(new ArrayBuffer(buf.byteLength));
  buf.copy(copy);
  return copy;
}

// 二段フィルタ ([/FlateDecode /DCTDecode]) の外側をほどくだけ。中身は JPEG のまま返す
function unwrap(job) {
  const bytes = bufOf(job.bytes);
  return job.codec === 'flate' ? inflate(bytes) : bytes;
}

// 綴じるために原寸のまま JPEG にする (pdf-write)。縮めない・色差を間引かない。
// `.rotate()` は引数無しだと EXIF の向きをそのまま画に焼き込む: 隠し窓の印刷が
// 向きを見ていたので、ここで揃えないと回った頁が回らずに綴じられる。
// sharp は既定で EXIF を持ち越さないので、焼いた後に向きの札は残らない
async function toPageJpeg(job) {
  if (!sharp) return { unsupported: true };
  const jpeg = await sharp(bufOf(job.bytes))
    .rotate()
    .jpeg(jpegOpts(job.encode, false))
    .toBuffer();
  return { jpeg };
}

// 綴じ手 (pdf-write) のための開き口。直に据えられない PNG (パレット・透過・16 bit・
// interlace) を 8 bit の生画素に開き、透過は別の平面にして、それぞれ deflate で縮めて返す。
// 可逆 (16 bit → 8 bit の丸めだけが例外: 要件 D5 の註)。主スレッドは画素を触らない
async function toPlane(job) {
  if (!sharp) return { unsupported: true };
  const bytes = bufOf(job.bytes);
  const meta = await sharp(bytes).metadata();
  const hasAlpha = meta.hasAlpha === true;
  const gray = meta.channels === 1 || meta.channels === 2;
  const base = sharp(bytes).removeAlpha();
  const { data, info } = await (gray ? base.toColourspace('b-w') : base.toColourspace('srgb'))
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  if (channels !== 1 && channels !== 3) return { unsupported: true, why: `channels:${channels}` };
  let alpha = null;
  if (hasAlpha) {
    const { data: a } = await sharp(bytes)
      .extractChannel((meta.channels || 4) - 1)
      .raw({ depth: 'uchar' })
      .toBuffer({ resolveWithObject: true });
    alpha = a;
  }
  return {
    width: info.width,
    height: info.height,
    channels,
    plane: zlib.deflateSync(data),
    smask: alpha ? zlib.deflateSync(alpha) : null,
  };
}

async function handle(job) {
  if (job.kind === 'topdf') {
    const res = await toPageJpeg(job);
    if (res.unsupported) return [res, []];
    const out = copyOut(res.jpeg);
    return [{ jpeg: out }, [out.buffer]];
  }
  if (job.kind === 'toplane') {
    const res = await toPlane(job);
    if (res.unsupported) return [res, []];
    const plane = copyOut(res.plane);
    const smask = res.smask ? copyOut(res.smask) : null;
    return [
      { width: res.width, height: res.height, channels: res.channels, plane, smask },
      smask ? [plane.buffer, smask.buffer] : [plane.buffer],
    ];
  }
  if (job.kind === 'unwrap') {
    const out = own(unwrap(job));
    return [{ bytes: out }, [out.buffer]];
  }
  if (job.kind === 'shrink') {
    const res = await shrink(job);
    if (res.unsupported) return [res, []];
    const out = copyOut(res.jpeg);
    return [{ jpeg: out }, [out.buffer]];
  }
  if (job.kind === 'dctmask') {
    const res = await dctMask(job);
    if (res.unsupported) return [res, []];
    const out = copyOut(res.jpeg);
    return [{ jpeg: out }, [out.buffer]];
  }
  if (job.kind === 'mask') {
    const out = own(maskBgra(job));
    return [{ bgra: out }, [out.buffer]];
  }
  if (job.kind === 'stealth') {
    return [stealthOf(job), []];
  }
  const res = await renderBase(job);
  if (res.jpeg) {
    const out = copyOut(res.jpeg);
    return [{ jpeg: out }, [out.buffer]];
  }
  const bgra = own(res.bgra);
  return [{ bgra }, [bgra.buffer]];
}

if (!isMainThread && parentPort) {
  parentPort.on('message', (job) => {
    handle(job).then(
      ([message, transfers]) => {
        // transfer に出せない箱でも worker ごと落とさない (写して渡し直す)
        try {
          parentPort.postMessage(message, transfers);
        } catch {
          parentPort.postMessage(message);
        }
      },
      (error) => parentPort.postMessage({ error: (error && error.message) || String(error) }),
    );
  });
}

module.exports = {
  toBgra, maskBgra, unwrap, own, copyOut, renderBase, dctMask, shrink, handle, hasSharp: () => !!sharp,
};
