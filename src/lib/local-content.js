'use strict';

// 所持作品の「手元の実体」を決める。Eagle のアイテム (<id>.info) の中身は
//   - 画像がそのまま入っている (mode: images, target = フォルダ)
//   - PDF が 1 本 (mode: pdf, target = その PDF)
//   - zip/cbz が 1 本 (mode: images, target = その zip)
// のどれかで、隣に Eagle が作る <名前>_thumbnail.png (中身は WebP) が居る。
// LAN の配信 (lan-server) と机上の表紙・読書 (main.js) が同じ判定を通る。

const fs = require('fs');
const path = require('path');
const localArchive = require('./local-archive');

function shapeFromNames(file, names) {
  const cover = names.find((name) => /_thumbnail\.(png|jpe?g|webp)$/i.test(name));
  const coverPath = cover ? path.join(file, cover) : null;
  // 画像が直に入っているなら、それが頁そのもの
  if (names.some((name) => localArchive.isImageName(name))) {
    return { mode: 'images', target: file, cover: coverPath };
  }
  const pdf = names.find((name) => /\.pdf$/i.test(name));
  if (pdf) return { mode: 'pdf', target: path.join(file, pdf), cover: coverPath };
  const zip = names.find((name) => /\.(zip|cbz)$/i.test(name));
  if (zip) return { mode: 'images', target: path.join(file, zip), cover: coverPath };
  return null;
}

function resolveContent(file) {
  const kind = localArchive.kindOf(file);
  if (kind === 'zip' || kind === 'image') return { mode: 'images', target: file, cover: null };
  if (kind !== 'dir') return null;
  let names = [];
  try {
    names = fs.readdirSync(file);
  } catch {
    return null;
  }
  return shapeFromNames(file, names);
}

// 非同期版。机上の表紙は札が画面に入るたびに引かれるので、main を止めない方で
async function resolveContentAsync(file) {
  const kind = await localArchive.kindOfAsync(file);
  if (kind === 'zip' || kind === 'image') return { mode: 'images', target: file, cover: null };
  if (kind !== 'dir') return null;
  let names = [];
  try {
    names = await fs.promises.readdir(file);
  } catch {
    return null;
  }
  return shapeFromNames(file, names);
}

// 同じフォルダを短い間に何度も readdir しない (一覧を繰るときの札ぶん)。
// 実体が差し替わる (再取り込み) のは稀なので、短い TTL で捨てる
const MEMO_TTL = 60 * 1000;
const memo = new Map();

async function resolveContentMemo(file) {
  const key = String(file || '');
  const now = Date.now();
  const hit = memo.get(key);
  if (hit && now - hit.at < MEMO_TTL) return hit.content;
  const content = await resolveContentAsync(key);
  memo.set(key, { at: now, content });
  if (memo.size > 4000) {
    for (const [k, v] of memo) {
      if (now - v.at >= MEMO_TTL) memo.delete(k);
    }
  }
  return content;
}

// 頁の控えの鍵に混ぜる「実体の版」。頁を 1 枚頼まれるたびに SMB へ stat を投げると
// 1 冊ぶんの先読みで何百往復にもなるので、同じ実体は短い間だけ憶えておく
const STAMP_TTL = 3000;
const stamps = new Map();

function forgetContent(file) {
  const key = String(file || '');
  memo.delete(key);
  stamps.delete(key);
}

async function stampOf(target) {
  const key = String(target || '');
  const now = Date.now();
  const hit = stamps.get(key);
  if (hit && now - hit.at < STAMP_TTL) return hit.stamp;
  let stamp = 0;
  try {
    stamp = Math.floor((await fs.promises.stat(key)).mtimeMs);
  } catch {
    stamp = 0;
  }
  stamps.set(key, { at: now, stamp });
  if (stamps.size > 4000) {
    for (const [k, v] of stamps) {
      if (now - v.at >= STAMP_TTL) stamps.delete(k);
    }
  }
  return stamp;
}

module.exports = { resolveContent, resolveContentAsync, resolveContentMemo, forgetContent, stampOf };
