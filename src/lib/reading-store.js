const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// 既読位置:
//   { "<id>": { page, pageCount, updatedAt, finished,
//               firstOpenedAt, finishedCount, finishedAt } }
// finished は「今の頁が最終頁か」の言い直しなので、読了本を開き直すと消える。
// 何度読み終えたか (finishedCount)・最後にいつ読み終えたか (finishedAt)・
// いつ初めて開いたか (firstOpenedAt) はそれとは別に積む。
// 後ろ 3 つが無い古い項目もそのまま読める (読み手は知らない鍵を無視してよい)
let cached = null;
let writeTimer = null;

function storePath() {
  return path.join(app.getPath('userData'), 'reading.json');
}

function load() {
  if (cached) return cached;
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
    cached = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    cached = {};
  }
  return cached;
}

function write() {
  if (!cached) return;
  try {
    // 素の上書きだと書き込み中のクラッシュで既読位置が全損する
    require('./state-file').writeText('reading', storePath(), JSON.stringify(cached, null, 2));
  } catch {
    // 位置の記憶に失敗しても読書そのものは続けられる
  }
}

function writeSoon() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    write();
  }, 500);
}

function flush() {
  if (!writeTimer) return;
  clearTimeout(writeTimer);
  writeTimer = null;
  write();
}

function get(id) {
  const key = String(id || '');
  if (!key) return null;
  return load()[key] || null;
}

function set(id, entry) {
  const key = String(id || '');
  if (!key) return null;
  const store = load();
  const page = Math.max(0, Math.round(Number(entry?.page) || 0));
  const pageCount = Math.max(0, Math.round(Number(entry?.pageCount) || 0));
  const finished = Boolean(entry?.finished);
  const previous = store[key] || null;
  const now = Date.now();
  // 読了に転じた瞬間だけ数える。読了のまま頁を送り直しても増やさない
  const turned = finished && !(previous && previous.finished);
  const count = Math.max(0, Math.round(Number(previous && previous.finishedCount) || 0));
  store[key] = {
    page,
    pageCount,
    updatedAt: now,
    finished,
    firstOpenedAt: Number(previous && previous.firstOpenedAt) || now,
    finishedCount: turned ? count + 1 : count,
    finishedAt: turned ? now : (Number(previous && previous.finishedAt) || null),
  };
  // 読んだ本の作者 (Home の「最近読んだ順」が他のタブで読んだ本を人へ寄せる鍵)。添えない呼び手 (手のひら版) は前の物を残す
  const by = creatorsOf(entry && entry.by);
  if (by.length) store[key].by = by;
  else if (previous && Array.isArray(previous.by) && previous.by.length) store[key].by = previous.by;
  writeSoon();
  return store[key];
}

// 作者の鍵: pixiv:<user id> / name:<作者の名> / group:<サークルの名> (読む画面が作る形)。数と長さを抑える
const CREATOR_KEY = /^(pixiv|name|group):.{1,120}$/;
function creatorsOf(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || '').trim()).filter((item) => CREATOR_KEY.test(item)))].slice(0, 8);
}

function all() {
  return { ...load() };
}

// 並び替えのための要約: id → { finishedCount, finishedAt, updatedAt }。
// 台帳 (catalog) も Eagle も栞を持っていないので、「再読の棚」の並びは
// この要約を呼び手が渡す形で当てる。欠けている鍵は 0 に均しておく
// (古い項目には finishedCount / finishedAt が無い)
function summary() {
  const out = {};
  for (const [key, entry] of Object.entries(load())) {
    if (!entry || typeof entry !== 'object') continue;
    out[key] = {
      finishedCount: Math.max(0, Math.round(Number(entry.finishedCount) || 0)),
      finishedAt: Number(entry.finishedAt) || 0,
      updatedAt: Number(entry.updatedAt) || 0,
    };
  }
  return out;
}

// 作者の鍵 → その作者の本を最後に読んだ時刻 (Home の「最近読んだ順」)
function creatorReads() {
  const out = {};
  for (const entry of Object.values(load())) {
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.by)) continue;
    const at = Number(entry.updatedAt) || 0;
    for (const key of entry.by) if (at > (out[key] || 0)) out[key] = at;
  }
  return out;
}

module.exports = {
  get, set, all, summary, creatorReads, flush,
};
