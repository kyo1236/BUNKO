'use strict';

// nhentai の一覧 (api/v2/search) は、タグを **番号でしか寄越さない** (`tag_ids`)。
// 詳細 (api/v2/galleries/<id>) だけが {id, type, name} の形で返す。
//
// そのため一覧から作った札にはタグが無く、**一覧に居る作品の詳細を開いても
// タグの行が出なかった** (画面は一覧の器をそのまま詳細に使うため)。hitomi の
// 一覧は最初からタグ付きなので、そちらとの差はここから来ている。
//
// 番号は `api/v2/tags/ids?ids=...` でまとめて引ける (一度に 100 まで。
// 120 は 400 で撥ねられる)。引いた対応は控えに残すので、同じ語は二度引かない。
// 詳細を開くたびにも只で覚える (あちらは名前付きで返ってくる)。
//
// **一覧を待たせない。** 控えで足りるぶんだけ即座に付け、足りないぶんは
// 引き終えるのを待つが、時間切れなら諦めて次に回す (次の一覧では控えが効く)。
const fs = require('fs');
const path = require('path');

const ENDPOINT = 'https://nhentai.net/api/v2/tags/ids';
const CHUNK = 100;          // 相手の上限 (120 で 400)
const LOOKUP_BUDGET_MS = 2500; // 一覧を待たせてよい上限
const MAX_ENTRIES = 20000;

let cached = null;
let writeTimer = null;
const inflight = new Map();

function storePath() {
  // electron を抱えない機体 (試験) でも読める形にしておく
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'nhentai-tags.json');
}

function load() {
  if (cached) return cached;
  cached = new Map();
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
    for (const [id, value] of Object.entries(parsed && parsed.tags ? parsed.tags : {})) {
      const type = String((value && value.t) || '').trim();
      const name = String((value && value.n) || '').trim();
      if (type && name) cached.set(Number(id), { type, name });
    }
  } catch {
    // 控えが無い・壊れている時は空から始める (引き直せばまた溜まる)
  }
  return cached;
}

function write() {
  if (!cached) return;
  const tags = {};
  for (const [id, value] of cached) tags[id] = { t: value.type, n: value.name };
  try {
    require('../state-file').writeText(
      'nhentai-tags', storePath(), JSON.stringify({ version: 1, tags }),
    );
  } catch {
    // 書けなくてもその場の一覧には効いている
  }
}

function writeSoon() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    write();
  }, 1000);
}

// 詳細の返事から只で覚える (あちらは名前付き)
function learn(tags) {
  const map = load();
  let added = 0;
  for (const item of tags || []) {
    const id = Number(item && item.id);
    const type = String((item && item.type) || '').trim();
    const name = String((item && item.name) || '').trim();
    if (!Number.isFinite(id) || !type || !name) continue;
    const seen = map.get(id);
    if (seen && seen.type === type && seen.name === name) continue;
    map.set(id, { type, name });
    added += 1;
  }
  if (added) {
    while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value);
    writeSoon();
  }
  return added;
}

function known(id) {
  return load().get(Number(id)) || null;
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// 番号の束を名前に変える。控えに無いものだけ網へ訊く。
// 同じ束が同時に二度飛ばないよう、走っている問い合わせは束ねる
async function resolve(ids, { get, signal, budgetMs = LOOKUP_BUDGET_MS } = {}) {
  const map = load();
  const missing = [...new Set((ids || []).map(Number).filter(Number.isFinite))]
    .filter((id) => !map.has(id));
  if (!missing.length || typeof get !== 'function') return map;

  const deadline = Date.now() + budgetMs;
  const jobs = chunk(missing, CHUNK).map((part) => {
    const key = part.join(',');
    if (inflight.has(key)) return inflight.get(key);
    const job = get(`${ENDPOINT}?ids=${key}`, {}, { signal, priority: 20 })
      .then((res) => { learn(res.json()); })
      .catch(() => {
        // 引けなかった番号はそのまま。次の一覧でまた挑む
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, job);
    return job;
  });

  // 待つのは持ち時間まで。**棚を待たせない** のが先
  await Promise.race([
    Promise.all(jobs),
    new Promise((done) => setTimeout(done, Math.max(0, deadline - Date.now()))),
  ]);
  return map;
}

// 番号の並びを、詳細と同じ形のタグの配列にする (引けなかった番号は落とす)
function expand(ids) {
  const map = load();
  const out = [];
  for (const raw of ids || []) {
    const hit = map.get(Number(raw));
    if (hit) out.push({ id: Number(raw), type: hit.type, name: hit.name });
  }
  return out;
}

function resetForTest(entries) {
  cached = new Map();
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  inflight.clear();
  for (const [id, value] of entries || []) cached.set(Number(id), value);
  return cached;
}

module.exports = {
  learn, known, resolve, expand, resetForTest, CHUNK, LOOKUP_BUDGET_MS,
};
