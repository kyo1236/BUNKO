'use strict';
// AI 作品の生成情報の控え: 一つの永続の表 (better-sqlite3、別ファイル ai-meta.sqlite)。利用者の決め (2026-10-18):
//   範囲 (触れた物 + フォロー + ブックマーク + 所持) で数万行・数十〜数百 MB になるので、丸ごと書き直す JSON や sql.js ではなく
//   一行ずつ書ける本物の DB に。後で FTS5 を足してプロンプトの語で所持を探す予定。catalog.sqlite とは別ファイル (台帳を太らせない)。
//
// 表 works(pid, page, status, source, checked_at, expires_at, format, model, json)、主キー (pid, page)
//   status: ok (情報あり) / none (無し) / unknown (まだ)。無しの根拠は status + source で表す
//   source: aitag / head64k (先頭 64KB) / original (原寸ぜんぶ) / import (取り込みで綴じる前) / pdf-smask (所持の PDF の透過 + RGB)
//   肯定 (ok) は期限を切らない。aitag の 404 だけ expires_at を持つ (新しい投稿は短い)。
//   出どころの強さ: import = original = pdf-smask > head64k > aitag。弱い出どころの「無し」は強い行を上書きしない。
//   head64k の「無し」は「文字チャンクと EXIF が無い」だけ (ステルスは未確定) なので、札の印にはしない。
//
// 役: state-file の KIND 'ai-meta' (follow)。母艦が書き、同期 (sync-to-homecore.ps1) が写しへ配る。
//   写し (readOnly) は読むだけ。**問い合わせごとに開いて閉じる**: 開いたままだと Windows では同期の差し替え (rename) が弾かれる。
//   journal は既定の rollback (WAL だと -wal / -shm も写さないと壊れる)。
//
// 本体 (better-sqlite3) はネイティブ。試験は素の node (node_modules の node 向けの .node)、配布は Electron の ABI の .node を
// third_party/better-sqlite3/electron-v<ABI>-<os>-<arch>/ に別置きして nativeBinding で指す (npm run setup が取る、builder は npmRebuild: false)。
// 読めない時はメモリの控えに落ちる (起動は止めない。板と印は動くが、再起動で消える)。

const fs = require('fs');
const path = require('path');
const stateFile = require('./state-file');

const ROOT = path.join(__dirname, '..', '..');
const VERSION = 1;
const RANK = { aitag: 1, head64k: 2, original: 3, import: 3, 'pdf-smask': 3 };
const NEG_TTL_FRESH = 20 * 60 * 1000;
const NEG_TTL = 3 * 24 * 60 * 60 * 1000;
const MISS_PAGE = -1;   // aitag の 404 の印の頁番号

let driverCache;   // undefined = まだ / null = 読めない / function = better-sqlite3
let driverError = '';

// Electron の中では third_party の ABI 向けの .node を、素の node では node_modules の物を
function nativeBindingPath() {
  if (!process.versions.electron) return null;
  const dir = `electron-v${process.versions.modules}-${process.platform}-${process.arch}`;
  const bases = [];
  if (process.resourcesPath) bases.push(path.join(process.resourcesPath, 'better-sqlite3'));
  bases.push(path.join(ROOT, 'third_party', 'better-sqlite3'));
  for (const base of bases) {
    const file = path.join(base, dir, 'better_sqlite3.node');
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function loadDriver() {
  if (driverCache !== undefined) return driverCache;
  if (process.env.BUNKO_NO_SQLITE === '1') { driverCache = null; driverError = 'BUNKO_NO_SQLITE'; return null; }
  try {
    const Database = require('better-sqlite3');
    const binding = nativeBindingPath();
    driverCache = binding ? (file, opts) => new Database(file, { ...opts, nativeBinding: binding }) : (file, opts) => new Database(file, opts);
    // 一度だけ本当に開けるか試す (ABI 違いは require でなく new で分かる)
    const probe = driverCache(':memory:', {});
    probe.close();
  } catch (error) {
    driverCache = null;
    driverError = (error && error.message) || String(error);
    console.warn('[ai-meta-store] better-sqlite3 を読めません。生成情報の控えはメモリだけになります', driverError.slice(0, 160));
  }
  return driverCache;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS works (
  pid TEXT NOT NULL,
  page INTEGER NOT NULL,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  checked_at INTEGER NOT NULL,
  expires_at INTEGER,
  format TEXT,
  model TEXT,
  json TEXT,
  PRIMARY KEY (pid, page)
);
CREATE INDEX IF NOT EXISTS works_status ON works(status, source);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

function rowOut(r) {
  if (!r) return null;
  let meta = null;
  if (r.json) { try { meta = JSON.parse(r.json); } catch { meta = null; } }
  return { pid: String(r.pid), page: Number(r.page), status: r.status, source: r.source, checkedAt: Number(r.checked_at) || 0, expiresAt: r.expires_at == null ? null : Number(r.expires_at), format: r.format || '', model: r.model || '', meta };
}

class AiMetaStore {
  constructor({ file = '', readOnly = false, now = () => Date.now(), driver } = {}) {
    this.file = file;
    this.readOnly = readOnly === true;
    this.now = now;
    this.driver = driver;         // 試験の差し替え。無ければ loadDriver()
    this.db = null;
    this.memory = null;           // 落ちた時の控え (Map)
    this.stmts = null;
  }

  // ---- 開閉 ----
  available() { return Boolean(this.driver || loadDriver()); }

  openDb() {
    const make = this.driver || loadDriver();
    if (!make) return null;
    if (this.readOnly) {
      // 写し: 問い合わせごとに開いて閉じる。無ければ null
      if (!this.file || !fs.existsSync(this.file)) return null;
      try { return make(this.file, { readonly: true, fileMustExist: true }); } catch { return null; }
    }
    if (this.db) return this.db;
    try {
      if (this.file && this.file !== ':memory:') fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const db = make(this.file || ':memory:', {});
      db.pragma('journal_mode = DELETE');
      db.pragma('synchronous = NORMAL');
      db.exec(SCHEMA);
      db.prepare('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)').run('version', String(VERSION));
      this.db = db;
      this.stmts = {
        get: db.prepare('SELECT * FROM works WHERE pid = ? AND page = ?'),
        pages: db.prepare('SELECT * FROM works WHERE pid = ? ORDER BY page'),
        put: db.prepare('INSERT OR REPLACE INTO works(pid, page, status, source, checked_at, expires_at, format, model, json) VALUES (@pid, @page, @status, @source, @checked_at, @expires_at, @format, @model, @json)'),
        count: db.prepare('SELECT COUNT(*) AS n FROM works'),
        pids: db.prepare('SELECT DISTINCT pid FROM works'),
      };
      return db;
    } catch (error) {
      console.warn('[ai-meta-store] 開けません。メモリの控えに落ちます', (error && error.message) || error);
      return null;
    }
  }

  mem() { if (!this.memory) this.memory = new Map(); return this.memory; }
  key(pid, page) { return `${pid}:${page}`; }

  // 読み (写しは開いて閉じる)
  query(fn) {
    if (this.readOnly) {
      const db = this.openDb();
      if (!db) return fn(null);
      try { return fn(db); } finally { try { db.close(); } catch { /* 閉じ損ねても次で開き直す */ } }
    }
    return fn(this.openDb());
  }

  close() {
    if (this.db) { try { this.db.close(); } catch { /* 既に閉じている */ } this.db = null; this.stmts = null; }
  }

  // ---- 行 ----
  get(pid, page = 0) {
    const key = String(pid).replace(/^px:/, '');
    const n = page === MISS_PAGE ? MISS_PAGE : Math.max(0, Number(page) || 0);
    return this.query((db) => {
      if (!db) return this.mem().get(this.key(key, n)) || null;
      const row = this.readOnly ? db.prepare('SELECT * FROM works WHERE pid = ? AND page = ?').get(key, n) : this.stmts.get.get(key, n);
      return rowOut(row);
    });
  }

  pages(pid) {
    const key = String(pid).replace(/^px:/, '');
    return this.query((db) => {
      if (!db) return [...this.mem().values()].filter((r) => r.pid === key).sort((a, b) => a.page - b.page);
      const rows = this.readOnly ? db.prepare('SELECT * FROM works WHERE pid = ? ORDER BY page').all(key) : this.stmts.pages.all(key);
      return rows.map(rowOut);
    });
  }

  // 書く。弱い出どころの「無し」で強い行を潰さない。ok は常に書く (より強い ok は上書き、同じ強さも上書き)
  put({ pid, page = 0, status = 'unknown', source = 'aitag', meta = null, ttl = null, checkedAt } = {}) {
    if (this.readOnly) return false;
    const key = String(pid).replace(/^px:/, '');
    if (!/^\d+$/.test(key)) return false;
    const n = page === MISS_PAGE ? MISS_PAGE : Math.max(0, Number(page) || 0);
    const existing = this.get(key, n);
    if (existing) {
      const oldRank = RANK[existing.source] || 0;
      const newRank = RANK[source] || 0;
      if (existing.status === 'ok' && status !== 'ok') return false;
      if (existing.status === 'ok' && status === 'ok' && newRank < oldRank) return false;
      if (existing.status === 'none' && status === 'none' && newRank < oldRank) return false;
      if (status === 'unknown' && existing.status !== 'unknown') return false;
    }
    const now = typeof checkedAt === 'number' ? checkedAt : this.now();
    const row = {
      pid: key, page: n, status, source, checked_at: now,
      expires_at: ttl == null ? null : now + ttl,
      format: meta && meta.format ? String(meta.format) : null,
      model: meta && meta.settings && meta.settings.model ? String(meta.settings.model) : null,
      json: meta ? JSON.stringify(meta) : null,
    };
    const db = this.openDb();
    if (!db) { this.mem().set(this.key(key, n), rowOut(row)); return true; }
    this.stmts.put.run(row);
    return true;
  }

  // aitag に載っていなかった (404)。頁 -1 の印として残す (頁ごとの行に潰されない)。新しい投稿は短く、そうでなければ 3 日
  aitagMiss(pid, { fresh = false } = {}) {
    return this.put({ pid, page: MISS_PAGE, status: 'none', source: 'aitag', ttl: fresh ? NEG_TTL_FRESH : NEG_TTL });
  }

  // 一括 (byUser) で「載っている」と分かっただけの作品: 中身は無いが ok (板を開く時に aitag へ取りに行く)
  aitagListed(pid) {
    const row = this.get(pid, 0);
    if (row && row.status === 'ok') return false;
    return this.put({ pid, page: 0, status: 'ok', source: 'aitag', meta: null });
  }

  expired(row) { return row && row.expiresAt != null && this.now() >= row.expiresAt; }

  // aitag に訊き直す必要があるか: 'yes' (載っている) / 'no' (期限内の 404) / '' (訊く)
  aitagKnown(pid) {
    const rows = this.pages(pid);
    if (rows.some((r) => r.page >= 0 && r.status === 'ok' && r.source === 'aitag')) return 'yes';
    const miss = rows.find((r) => r.page === MISS_PAGE && r.status === 'none' && r.source === 'aitag');
    if (miss && !this.expired(miss)) return 'no';
    // 強い出どころ (原寸・取り込み・PDF) で頁 0 が決まっていれば aitag には訊かない ('no' = 訊かない。印は markOf が別に出す)
    if (rows.some((r) => r.page === 0 && (RANK[r.source] || 0) >= 3)) return 'no';
    return '';
  }

  // 札の印: 'yes' (どこかの頁に ok) / 'no' (頁 0 が無し、根拠は aitag の期限内の 404 か強い出どころ) / '' (まだ)
  markOf(pid) {
    const rows = this.pages(pid);
    if (!rows.length) return '';
    if (rows.some((r) => r.page >= 0 && r.status === 'ok')) return 'yes';
    const first = rows.find((r) => r.page === 0 && r.status === 'none');
    if (first && first.source !== 'head64k') return 'no';
    const miss = rows.find((r) => r.page === MISS_PAGE && r.source === 'aitag');
    if (miss && !this.expired(miss)) return 'no';
    return '';
  }

  // 頁ごとの答え (板が使う)。ok で中身のある行だけ返す
  metaOf(pid, page = 0) {
    const row = this.get(pid, page);
    return row && row.status === 'ok' && row.meta ? row : null;
  }

  count() {
    return this.query((db) => {
      if (!db) return this.mem().size;
      return Number((this.readOnly ? db.prepare('SELECT COUNT(*) AS n FROM works').get() : this.stmts.count.get()).n) || 0;
    });
  }

  pids() {
    return this.query((db) => {
      if (!db) return [...new Set([...this.mem().values()].map((r) => r.pid))];
      return (this.readOnly ? db.prepare('SELECT DISTINCT pid FROM works').all() : this.stmts.pids.all()).map((r) => String(r.pid));
    });
  }

  // 小さなトランザクションでまとめて書く (埋め戻し)。fn(put) の中で put を呼ぶ
  batch(fn) {
    const db = this.readOnly ? null : this.openDb();
    if (!db) { fn((row) => this.put(row)); return; }
    db.transaction(() => fn((row) => this.put(row)))();
  }
}

// 置き場: userData の ai-meta.sqlite。写し (readOnly) は state-file の役で決まる
function createStore({ dir, now } = {}) {
  const file = dir ? path.join(dir, 'ai-meta.sqlite') : ':memory:';
  return new AiMetaStore({ file, readOnly: !stateFile.canWrite('ai-meta'), now });
}

module.exports = { AiMetaStore, createStore, loadDriver, nativeBindingPath, RANK, NEG_TTL, NEG_TTL_FRESH, MISS_PAGE, _driverError: () => driverError };
