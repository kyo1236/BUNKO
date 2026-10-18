const fs = require('fs');
const path = require('path');
const yauzl = require('yauzl');

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif|jxl|bmp)$/i;
const naturalCollator = new Intl.Collator(undefined, { numeric: true });
const pendingDirLists = new Map();

// 開いた zip は入り口一覧ごと取っておく (autoClose: false)。続きの頁が速くなる代わりに、
// 開いた数だけファイルの口を掴み続ける。手元で数冊読む分には見えないが、
// 一覧をずっと繰られると尽きる: 上限を決めて古い方から閉じる
const MAX_OPEN_ZIPS = 48;
const zipCache = new Map();

function mimeFor(name) {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.avif') return 'image/avif';
  if (ext === '.jxl') return 'image/jxl';
  if (ext === '.bmp') return 'image/bmp';
  return 'image/webp';
}

function isImageName(name) {
  const base = path.basename(name);
  if (base.startsWith('.') || /thumbnail/i.test(base) || base === 'info.json') return false;
  return IMAGE_EXT.test(base);
}

function kindOf(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) return 'dir';
  if (/\.(zip|cbz)$/i.test(filePath)) return 'zip';
  if (IMAGE_EXT.test(filePath)) return 'image';
  return null;
}

async function kindOfAsync(filePath) {
  if (!filePath) return null;
  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    // existsSync と同じく、存在確認できない対象は読めない種類として扱う。
    return null;
  }
  if (stat.isDirectory()) return 'dir';
  if (/\.(zip|cbz)$/i.test(filePath)) return 'zip';
  if (IMAGE_EXT.test(filePath)) return 'image';
  return null;
}

async function listDirImages(dir) {
  const existing = pendingDirLists.get(dir);
  if (existing) return existing;
  const pending = fs.promises.readdir(dir)
    .then((names) => names.filter((name) => isImageName(name)).sort(naturalCollator.compare));
  pendingDirLists.set(dir, pending);
  try {
    return await pending;
  } finally {
    if (pendingDirLists.get(dir) === pending) pendingDirLists.delete(dir);
  }
}

function closeRecord(record) {
  record.pending.then((zip) => {
    try {
      zip.zipfile.close();
    } catch {
      // 既に閉じている / 開けていない。どちらでも手放したい事に変わりはない
    }
  }).catch(() => {
    // 開くのに失敗したものには閉じる相手が居ない
  });
}

// 一番古い、今読んでいないものから閉じる。全部読書中なら誰も閉じない:
// 掴み過ぎるより、読んでいる最中に足を払う方が困る
function evictIfNeeded() {
  if (zipCache.size <= MAX_OPEN_ZIPS) return;
  for (const [key, record] of zipCache) {
    if (record.busy > 0) continue;
    zipCache.delete(key);
    closeRecord(record);
    if (zipCache.size <= MAX_OPEN_ZIPS) return;
  }
}

function openZip(filePath) {
  const cached = zipCache.get(filePath);
  if (cached) {
    // Map は入れた順に並ぶ。使ったものを入れ直して新しい側へ回す
    zipCache.delete(filePath);
    zipCache.set(filePath, cached);
    return cached;
  }
  const record = { busy: 0, pending: null };
  const forget = () => {
    // 開き直しの最中なら別の記録が座っている: 自分のときだけ引く
    if (zipCache.get(filePath) === record) zipCache.delete(filePath);
  };
  record.pending = new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: false }, (error, zipfile) => {
      if (error) {
        forget();
        reject(error);
        return;
      }
      const entries = [];
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        if (isImageName(entry.fileName)) entries.push(entry);
        zipfile.readEntry();
      });
      zipfile.on('end', () => {
        entries.sort((a, b) => naturalCollator.compare(a.fileName, b.fileName));
        resolve({ zipfile, entries });
      });
      zipfile.on('error', (err) => {
        forget();
        reject(err);
      });
    });
  });
  zipCache.set(filePath, record);
  return record;
}

// 読んでいる間は busy を立てて、その隙に閉じられないようにする。
// 追い出しは busy を立てた後に回す: 先に回すと、開いたばかりで
// まだ誰も読み手が付いていない自分自身が最後尾で閉じられる
async function withZip(filePath, fn) {
  const record = openZip(filePath);
  record.busy += 1;
  evictIfNeeded();
  try {
    return await fn(await record.pending);
  } finally {
    record.busy -= 1;
    // 全件 busy で一時的に上限を越えた場合も、最後の読み手が抜けた時点で戻す。
    evictIfNeeded();
  }
}

function readZipEntry(zipfile, entry) {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  });
}

async function pageCount(filePath) {
  const kind = await kindOfAsync(filePath);
  if (kind === 'dir') return (await listDirImages(filePath)).length;
  if (kind === 'zip') return withZip(filePath, (zip) => zip.entries.length);
  if (kind === 'image') return 1;
  return 0;
}

async function readPage(filePath, index) {
  const kind = await kindOfAsync(filePath);
  if (!kind) return null;

  if (kind === 'image') {
    if (index !== 0) return null;
    const bytes = await fs.promises.readFile(filePath);
    return { bytes, type: mimeFor(filePath), name: path.basename(filePath) };
  }

  if (kind === 'dir') {
    const files = await listDirImages(filePath);
    const name = files[index];
    if (!name) return null;
    const full = path.join(filePath, name);
    return { bytes: await fs.promises.readFile(full), type: mimeFor(name), name };
  }

  return withZip(filePath, async (zip) => {
    const entry = zip.entries[index];
    if (!entry) return null;
    const bytes = await readZipEntry(zip.zipfile, entry);
    return { bytes, type: mimeFor(entry.fileName), name: path.basename(entry.fileName) };
  });
}

// 掴んでいる zip の数。上限が効いているかを外から見るためだけのもの
function openZipCount() {
  return zipCache.size;
}

module.exports = { kindOf, kindOfAsync, pageCount, readPage, isImageName, openZipCount };
