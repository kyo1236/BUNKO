'use strict';
// 生成情報の取り出しを、画素の復号 (sharp) と控えを添えて主プロセスから使える形に。
//   analyze(bytes)             → 生成情報 | null。ステルスは sharp で左端の列だけ生画素にして読む
//                                (sharp の復号は libuv のスレッドで走り、主スレッドを止めない。sharp が無ければチャンクと EXIF だけ)
//   createCache({ max })       → 投稿 ID + 頁ごとの控え (メモリ)。「情報なし」も控える (同じ頁を二度開いても網に出ない)
//
// 解析そのものは ai-meta.js (純粋)。ここは注ぐ物を決めるだけ。
const { extractFromBytes, kindOf } = require('./ai-meta');

let sharpLib;
function loadSharp() {
  if (sharpLib !== undefined) return sharpLib;
  if (process.env.BUNKO_NO_SHARP === '1') { sharpLib = null; return null; }
  try {
    sharpLib = require('sharp');
    sharpLib.cache(false);
  } catch {
    sharpLib = null;
  }
  return sharpLib;
}

// ステルス用の画素の口: 左端 columns 列の生画素 (RGBA か RGB)。画像の幅で切り詰める
function pixelsOf(bytes) {
  const sharp = loadSharp();
  if (!sharp) return null;
  let metaPromise = null;
  const metadata = () => { if (!metaPromise) metaPromise = sharp(bytes).metadata(); return metaPromise; };
  return async ({ columns }) => {
    const meta = await metadata();
    if (!meta || !meta.width || !meta.height) return null;
    const width = Math.max(1, Math.min(Math.ceil(columns), meta.width));
    const { data, info } = await sharp(bytes, { limitInputPixels: false })
      .extract({ left: 0, top: 0, width, height: meta.height })
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (!(info.channels === 3 || info.channels === 4)) return null;
    return { data, width: info.width, height: info.height, channels: info.channels };
  };
}

async function analyze(bytes) {
  if (!Buffer.isBuffer(bytes) || !kindOf(bytes)) return null;
  return extractFromBytes(bytes, { pixels: pixelsOf(bytes) });
}

// 控え。鍵は `${pid}:${index}`。走っている取り出しは一つにまとめる (同じ頁を連打しても一度だけ)
function createCache({ max = 200 } = {}) {
  const done = new Map();
  const inflight = new Map();
  const key = (pid, index) => `${pid}:${Number(index) || 0}`;
  return {
    get(pid, index) { return done.get(key(pid, index)); },
    has(pid, index) { return done.has(key(pid, index)); },
    set(pid, index, value) {
      const k = key(pid, index);
      done.delete(k);
      done.set(k, value);
      while (done.size > max) done.delete(done.keys().next().value);
      return value;
    },
    // fetch: 無い時に呼ぶ関数。失敗 (網・冷却・ログイン) は控えずに投げ直す
    async resolve(pid, index, fetch) {
      const k = key(pid, index);
      if (done.has(k)) return done.get(k);
      if (inflight.has(k)) return inflight.get(k);
      const pending = Promise.resolve().then(fetch).then((value) => this.set(pid, index, value)).finally(() => inflight.delete(k));
      inflight.set(k, pending);
      return pending;
    },
    clear() { done.clear(); },
    get size() { return done.size; },
  };
}

module.exports = { analyze, createCache, pixelsOf, _loadSharp: loadSharp };
