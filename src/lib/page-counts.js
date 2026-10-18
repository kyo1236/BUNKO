'use strict';

// 所持の Eagle の本 (作者根の PDF・画像の束) の本当の頁数の控え。
// 名前の【17P】が無い本 (Discord から持ち込んだ PDF など) は、一覧の札の右上に頁数の印が出なかった。
// 数えるのは綴じ目だけ (main の localPageCount。SMB 越しでも一冊数 ms) だが、一覧のたびに何百冊も
// 数え直さないよう、Eagle の項目の id と mtime で控えて使い回す。
//
// state-file の KIND 'page-counts' (own): 機体ごとに自前で数える (写しも同じ Eagle の実体を数えられる)。
// electron を引かない (数える関数は main から差し込む。試験は偽物を差す)。

const fs = require('fs');
const stateFile = require('./state-file');

const VERSION = 1;
// 一度に数える冊数 (SMB を塞がない)
const CONCURRENCY = 4;
// 書き出しを溜める間 (一冊ずつ書かない)
const SAVE_DELAY_MS = 1500;

class PageCounts {
  // count: async (galleryId) => 頁数 (分からなければ 0)
  constructor({ file = '', count = async () => 0, now = Date.now } = {}) {
    this.file = file;
    this.count = count;
    this.now = now;
    this.rows = null;
    this.saveTimer = null;
    this.inflight = new Map();
  }

  load() {
    if (this.rows) return this.rows;
    this.rows = new Map();
    if (!this.file) return this.rows;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [eagleId, value] of Object.entries((parsed && parsed.rows) || {})) {
        const pages = Math.floor(Number(value && value.pages));
        if (eagleId && pages > 0) this.rows.set(eagleId, { pages, mtime: Number(value.mtime) || 0 });
      }
    } catch {
      // 無い・壊れた控えは空から (数え直すだけ)
    }
    return this.rows;
  }

  // 控えの頁数。mtime が変わっていれば (本が差し替わった) 0
  get(eagleId, mtime = 0) {
    const hit = this.load().get(String(eagleId || ''));
    if (!hit) return 0;
    if (mtime && hit.mtime && Number(mtime) !== hit.mtime) return 0;
    return hit.pages;
  }

  scheduleSave() {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, SAVE_DELAY_MS);
    if (typeof this.saveTimer.unref === 'function') this.saveTimer.unref();
  }

  flush() {
    if (!this.file || !this.rows) return false;
    const rows = {};
    for (const [eagleId, value] of this.rows) rows[eagleId] = value;
    return stateFile.writeJson('page-counts', this.file, { version: VERSION, rows });
  }

  // 数える ({ id: 'pweagle:<eagleId>' | 'px:<投稿 ID>', eagleId, mtime } の並び)。控えにあればそれ、無ければ数えて控える。
  // 返り: Map<id, 頁数>
  async fill(items = []) {
    const out = new Map();
    const todo = [];
    for (const item of Array.isArray(items) ? items : []) {
      const id = String(item && item.id || '');
      const eagleId = String(item && item.eagleId || '');
      if (!id || !eagleId) continue;
      const known = this.get(eagleId, item.mtime);
      if (known) out.set(id, known);
      else todo.push({ id, eagleId, mtime: Number(item.mtime) || 0 });
    }
    let cursor = 0;
    let changed = false;
    const worker = async () => {
      while (cursor < todo.length) {
        const item = todo[cursor];
        cursor += 1;
        let pending = this.inflight.get(item.eagleId);
        if (!pending) {
          pending = Promise.resolve().then(() => this.count(item.id)).catch(() => 0);
          this.inflight.set(item.eagleId, pending);
        }
        const pages = Math.floor(Number(await pending)) || 0;
        this.inflight.delete(item.eagleId);
        if (pages > 0) {
          this.load().set(item.eagleId, { pages, mtime: item.mtime });
          out.set(item.id, pages);
          changed = true;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
    if (changed) this.scheduleSave();
    return out;
  }
}

module.exports = { PageCounts, CONCURRENCY };
