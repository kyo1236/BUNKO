const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MEMORY_MAX_BYTES = 80 * 1024 * 1024;
// 円盤の予算。表紙・網の頁に加えて、所持作品の PDF から抜いた読書用の頁も
// ここに溜まる (再読と圏外用)。母艦 C: は 900 GB 超、Homecore も 100 GB 超空いている。
// 開いた本は残りを裏で全部用意する (原寸 JPEG 一頁 2.6 MB、200 頁で 520 MB) ので、
// 再読の多い使い方に合わせて 40 冊ほど抱えられる 20 GB にしてある (2026-09-11)
const DISK_MAX_BYTES = 20 * 1024 * 1024 * 1024;
// 閾値ちょうどまで削ると書き込みのたびに走査が走る: 少し下まで落として間を空ける
const DISK_TRIM_BYTES = Math.floor(DISK_MAX_BYTES * 0.9);
const META_TTL_MS = 24 * 60 * 60 * 1000;
const SEARCH_TTL_MS = 10 * 60 * 1000;
const SEARCH_FRESH_TTL_MS = 2 * 60 * 1000;

// 既定は一時領域 (Electron の外の単体試験・調査用)。本番は main が userData の
// 'media-cache' を渡す。'cache' という名前は Chromium の Cache と衝突して起動ごとに
// 消されるので使わない (main.js の init 呼び出しを参照)
let root = path.join(os.tmpdir(), 'hitomi-box-media-cache');
const memory = new Map();
const inflight = new Map();
let memoryBytes = 0;
// img ディレクトリの合計サイズ。起動後に一度だけ走査して、以後は増減で持ち回る
let diskBytes = 0;
let diskScan = null;
let evicting = false;

function init(dir) {
  if (dir && dir !== root) {
    root = dir;
    // 置き場が変われば数え直し
    diskScan = null;
    diskBytes = 0;
  }
  fs.mkdirSync(path.join(root, 'img'), { recursive: true });
  fs.mkdirSync(path.join(root, 'meta'), { recursive: true });
  fs.mkdirSync(path.join(root, 'search'), { recursive: true });
}

function hashKey(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex');
}

function shardPath(kind, key) {
  const hash = hashKey(key);
  const dir = path.join(root, kind, hash.slice(0, 2));
  return path.join(dir, hash);
}

function touchMemory(key, entry) {
  if (memory.has(key)) memory.delete(key);
  memory.set(key, entry);
}

function putMemory(key, entry) {
  const prev = memory.get(key);
  if (prev) memoryBytes -= prev.bytes.length;
  touchMemory(key, entry);
  memoryBytes += entry.bytes.length;
  while (memoryBytes > MEMORY_MAX_BYTES && memory.size) {
    const oldest = memory.keys().next().value;
    const item = memory.get(oldest);
    memory.delete(oldest);
    memoryBytes -= item.bytes.length;
  }
}

function readJson(file, ttl) {
  try {
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs > ttl) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

async function readImage(file) {
  try {
    const [metaText, bytes] = await Promise.all([
      fs.promises.readFile(`${file}.json`, 'utf8'),
      fs.promises.readFile(file),
    ]);
    const meta = JSON.parse(metaText);
    // 参照時刻の更新は捨て順の目安でしかない: 待たず、失敗しても読みは通す
    const now = new Date();
    fs.promises.utimes(file, now, now).catch(() => {});
    return { bytes, type: meta.type || 'application/octet-stream', name: meta.name || 'image' };
  } catch {
    return null;
  }
}

// 呼ぶ側は書き終わりを待たない。本体 → .json の順に書くので、
// 途中で読まれても .json が無くて readImage が諦めるだけ (取り直しになる)
function writeImage(file, entry) {
  const size = entry.bytes.length;
  const meta = JSON.stringify({ type: entry.type, name: entry.name, size });
  fs.promises.mkdir(path.dirname(file), { recursive: true })
    .then(() => fs.promises.writeFile(file, entry.bytes))
    .then(() => fs.promises.writeFile(`${file}.json`, meta))
    .then(() => noteWrite(size))
    .catch((error) => {
      console.warn('[media-cache] 画像を保存できませんでした', error?.message || error);
    });
}

function listImages() {
  const imgRoot = path.join(root, 'img');
  return fs.promises.readdir(imgRoot, { withFileTypes: true })
    .then(async (shards) => {
      const entries = [];
      for (const shard of shards) {
        if (!shard.isDirectory()) continue;
        const dir = path.join(imgRoot, shard.name);
        let names = [];
        try {
          names = await fs.promises.readdir(dir);
        } catch {
          continue;
        }
        for (const name of names) {
          if (name.endsWith('.json')) continue;
          const file = path.join(dir, name);
          try {
            const stat = await fs.promises.stat(file);
            entries.push({ file, size: stat.size, mtime: stat.mtimeMs });
          } catch {
            // skip
          }
        }
      }
      return entries;
    })
    .catch(() => []);
}

// 全走査は起動後の一度だけ。以後の増減は writeImage / evictDisk が足し引きする
let diskScanDone = false;

function scanDisk() {
  if (!diskScan) {
    diskScan = listImages().then((entries) => {
      diskBytes = entries.reduce((sum, item) => sum + item.size, 0);
      diskScanDone = true;
    });
  }
  return diskScan;
}

function noteWrite(size) {
  // 走査が終わっているときだけ足す。走査前/走査中の書き込みは、走査の
  // 集計がそのファイルも拾う (完了フラグではなく開始フラグで見ると二重計上)
  const counted = diskScanDone;
  scanDisk().then(() => {
    if (counted) diskBytes += size;
    return evictDisk();
  }).catch(() => {});
}

async function evictDisk() {
  if (evicting || diskBytes <= DISK_MAX_BYTES) return;
  evicting = true;
  try {
    // 溢れたときだけ改めて mtime を集め、古いものから落とす
    const entries = await listImages();
    entries.sort((a, b) => a.mtime - b.mtime);
    for (const item of entries) {
      if (diskBytes <= DISK_TRIM_BYTES) break;
      // json を先に消す: 本体だけ消えて json が残ると、以後 readImage が
      // 毎回失敗して取り直し続ける (逆なら本体の孤児が次の掃除で拾われるだけ)
      try {
        await fs.promises.unlink(`${item.file}.json`);
      } catch {
        // ignore
      }
      try {
        await fs.promises.unlink(item.file);
      } catch {
        continue;
      }
      diskBytes -= item.size;
    }
  } finally {
    evicting = false;
  }
}

async function getImage(key, loader, { memoryOk = true, signal } = {}) {
  if (memoryOk && memory.has(key)) {
    const hit = memory.get(key);
    touchMemory(key, hit);
    return hit;
  }
  let flight = inflight.get(key);
  if (flight?.controller.signal.aborted) {
    if (inflight.get(key) === flight) inflight.delete(key);
    flight = null;
  }
  if (!flight) {
    const file = shardPath('img', key);
    const controller = new AbortController();
    flight = { controller, subscribers: 0, promise: null };
    flight.promise = Promise.resolve()
      .then(() => readImage(file))
      .then((disk) => {
        if (disk) return disk;
        return Promise.resolve().then(() => loader({ signal: controller.signal })).then((entry) => {
          if (entry?.bytes && inflight.get(key) === flight) writeImage(file, entry);
          return entry;
        });
      })
      .finally(() => {
        if (inflight.get(key) === flight) inflight.delete(key);
      });
    inflight.set(key, flight);
  }
  flight.subscribers += 1;
  let onAbort;
  let entry;
  try {
    if (!signal) entry = await flight.promise;
    else {
      if (signal.aborted) throw signal.reason || new Error('aborted');
      const aborted = new Promise((_, reject) => {
        onAbort = () => reject(signal.reason || new Error('aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
      });
      entry = await Promise.race([flight.promise, aborted]);
    }
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    flight.subscribers -= 1;
    if (signal?.aborted && flight.subscribers === 0) {
      if (inflight.get(key) === flight) inflight.delete(key);
      flight.controller.abort(signal.reason);
    }
  }
  // inflight を共有しても、メモリへ置くかは各呼出側の指定を尊重する。
  if (memoryOk && entry?.bytes && entry.bytes.length < 800 * 1024) putMemory(key, entry);
  return entry;
}

function getMeta(key) {
  return readJson(`${shardPath('meta', key)}.json`, META_TTL_MS);
}

function setMeta(key, value) {
  writeJson(`${shardPath('meta', key)}.json`, value);
}

function searchTtl(payload) {
  const empty = !String(payload.query || '').trim();
  return empty ? SEARCH_FRESH_TTL_MS : SEARCH_TTL_MS;
}

function getSearch(key, ttl) {
  return readJson(`${shardPath('search', key)}.json`, ttl);
}

function setSearch(key, value) {
  writeJson(`${shardPath('search', key)}.json`, value);
}

function imageKey(id, index, size) {
  return `img:${id}:${index}:${size || 'full'}`;
}

init();

module.exports = {
  init,
  getImage,
  getMeta,
  setMeta,
  getSearch,
  setSearch,
  searchTtl,
  imageKey,
};
