const fs = require('fs');

// pawchive 一括更新の「済んだ投稿」台帳。外部ツール (kemono-dl) が持っていた
// completed_posts と同じ鍵 (service:user:postId) をそのまま引き継ぐ。
//
// 置き場所は catalog.sqlite の中: sql.js の初期化とファイル書き出しを二重に
// 持たないため、catalog の db をそのまま間借りする。

// 旧台帳には URL がそのまま入った行や、連結して壊れた行が混じっている。
// service:user:postId の形をしていないものは取り込まない
const KEY_RE = /^[a-z][a-z0-9]*:[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+$/;

class PawState {
  constructor(catalog) {
    this.catalog = catalog || null;
    this.completed = new Set();
    this.pending = new Map();
    this.ready = false;
  }

  db() {
    return this.catalog && this.catalog.db ? this.catalog.db : null;
  }

  init() {
    const db = this.db();
    if (!db) return this;
    db.run(`
      CREATE TABLE IF NOT EXISTS paw_completed (
        post_key TEXT PRIMARY KEY,
        completed_at TEXT NOT NULL
      );
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS paw_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS paw_pending (
        post_key TEXT PRIMARY KEY,
        service TEXT NOT NULL,
        user_id TEXT NOT NULL,
        post_id TEXT NOT NULL,
        published TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );
    `);
    db.run('CREATE INDEX IF NOT EXISTS idx_paw_pending_creator ON paw_pending(service, user_id);');
    this.reload();
    this.ready = true;
    return this;
  }

  // 済判定は投稿ごとに何度も引く: 台帳は起動時に丸ごと記憶に載せる
  reload() {
    this.completed = new Set();
    this.pending = new Map();
    const db = this.db();
    if (!db) return;
    const result = db.exec('SELECT post_key FROM paw_completed');
    if (result[0]) {
      for (const row of result[0].values) this.completed.add(String(row[0]));
    }
    const pending = db.exec(
      'SELECT post_key, service, user_id, post_id, published, attempts, last_error FROM paw_pending',
    );
    if (pending[0]) {
      for (const row of pending[0].values) {
        const item = {
          key: String(row[0]), service: String(row[1]), user: String(row[2]), id: String(row[3]),
          date: String(row[4] || '00000000'), attempts: Number(row[5]) || 0,
          error: String(row[6] || ''),
        };
        if (!this.completed.has(item.key)) this.pending.set(item.key, item);
      }
    }
  }

  getMeta(key, fallback = null) {
    const db = this.db();
    if (!db) return fallback;
    const rows = this.catalog.queryRows('SELECT value FROM paw_meta WHERE key = ?', [key]);
    return rows.length ? String(rows[0].value) : fallback;
  }

  setMeta(key, value) {
    if (!this.db()) return;
    // 走査中は COMMIT を待ってから書く (トランザクション巻き添えの ROLLBACK 対策)
    this.catalog.runWhenWritable(() => {
      const db = this.db();
      if (!db) return;
      db.run(
        `INSERT INTO paw_meta(key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [String(key), String(value)],
      );
      this.catalog.persistSoon();
    });
  }

  hasCompleted(key) {
    return this.completed.has(String(key));
  }

  listPending(service, user) {
    return [...this.pending.values()].filter(
      (item) => item.service === String(service) && item.user === String(user),
    );
  }

  markPending(item, error = '') {
    const value = item || {};
    const key = String(value.key || '');
    if (!key || this.completed.has(key) || !this.db()) return false;
    const previous = this.pending.get(key);
    const next = {
      key,
      service: String(value.service || (previous && previous.service) || ''),
      user: String(value.user || (previous && previous.user) || ''),
      id: String(value.id || (previous && previous.id) || ''),
      date: String(value.date || (previous && previous.date) || '00000000'),
      attempts: (previous ? previous.attempts : 0) + (error ? 1 : 0),
      error: String(error || ''),
    };
    if (!next.service || !next.user || !next.id) return false;
    this.pending.set(key, next);
    this.catalog.runWhenWritable(() => {
      const db = this.db();
      if (!db) return;
      db.run(
        `INSERT INTO paw_pending
           (post_key, service, user_id, post_id, published, attempts, last_error, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(post_key) DO UPDATE SET
           service = excluded.service, user_id = excluded.user_id, post_id = excluded.post_id,
           published = excluded.published, attempts = excluded.attempts,
           last_error = excluded.last_error, updated_at = excluded.updated_at`,
        [key, next.service, next.user, next.id, next.date, next.attempts, next.error, new Date().toISOString()],
      );
      this.catalog.persistSoon();
    });
    return true;
  }

  markFailed(item, error) {
    return this.markPending(item, String((error && error.message) || error || 'failed'));
  }

  markCompleted(key) {
    const id = String(key || '');
    if (!id || this.completed.has(id)) return false;
    if (!this.db()) return false;
    // 記憶には先に立てる (済判定は即効かせる)。DB へは走査の COMMIT を待って書く:
    // トランザクションに巻き込まれて ROLLBACK で消えると、済んだ投稿を取り直す
    this.completed.add(id);
    this.pending.delete(id);
    this.catalog.runWhenWritable(() => {
      const db = this.db();
      if (!db) return;
      db.run(
        'INSERT OR IGNORE INTO paw_completed(post_key, completed_at) VALUES (?, ?)',
        [id, new Date().toISOString()],
      );
      db.run('DELETE FROM paw_pending WHERE post_key = ?', [id]);
      this.catalog.persistSoon();
    });
    return true;
  }

  completedCount() {
    return this.completed.size;
  }

  // 旧台帳 (外部の kemono-dl の state.sqlite3) の引き継ぎ。読むだけで相手には書かない。
  // 一度きり: 済んだ印を付けたあとは相手を見に行かない。壊れていても「引き継ぎ済み」にはせず、次回また試す。
  // file を渡さなければ引き継ぐ物は無い (空の状態で始めたと記録する)
  importLegacy(file = '') {
    const db = this.db();
    if (!db) return { imported: 0, skipped: true };
    if (this.getMeta('paw_state_imported') === '1') return { imported: 0, skipped: true };
    if (!file || !fs.existsSync(file)) {
      // 相手が居ないなら引き継ぐものが無い: 空の状態で始めたと記録して二度と見ない
      this.setMeta('paw_state_imported', '1');
      return { imported: 0, skipped: false, missing: true };
    }

    let legacy = null;
    try {
      // バイト列を読むだけ。開いた DB は書き戻さない
      legacy = new this.catalog.SQL.Database(fs.readFileSync(file));
    } catch {
      return { imported: 0, skipped: true, error: 'open' };
    }

    let imported = 0;
    let rejected = 0;
    try {
      const rows = legacy.exec('SELECT post_url, completed_at FROM completed_posts');
      if (rows[0]) {
        for (const [key, at] of rows[0].values) {
          const id = String(key || '');
          if (!KEY_RE.test(id)) {
            rejected += 1;
            continue;
          }
          if (this.completed.has(id)) continue;
          db.run(
            'INSERT OR IGNORE INTO paw_completed(post_key, completed_at) VALUES (?, ?)',
            [id, String(at || new Date().toISOString())],
          );
          this.completed.add(id);
          imported += 1;
        }
      }
    } catch {
      // 途中で読めなくなったぶんは諦める。取り込めた行はそのまま活かす
    } finally {
      try { legacy.close(); } catch { /* ignore */ }
    }

    this.setMeta('paw_state_imported', '1');
    this.catalog.persistSoon();
    return { imported, rejected, skipped: false };
  }
}

module.exports = { PawState, KEY_RE };
