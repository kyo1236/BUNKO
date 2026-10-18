'use strict';
// aitag.win (第三者の非公式な口) から、pixiv の AI 作品の生成情報を貰う。
//   利用者の決め (2026-10-18): aitag を主にして既定オン、自前の解析 (ai-meta-service) は予備。
//
//   work(pid)        → { status: 'ok', images: [{ index, meta, model, type }] } | { status: 'none' } | { status: 'off' }。失敗は投げる
//   byUser(userId)   → 索引に載っている投稿 ID の一覧 (作者の一覧を一発で印にする)
//   marks(ids)       → id → 'yes' | 'no' | 'unknown'。控え優先、無い物だけ問い合わせる
//
// 作法: 同時 2 本・150ms 間隔 (http.js の SiteScheduler)。一括では叩かない (札が画面に入った時だけ)。
//   失敗が続いたら数分は黙る (breaker)。向こうは robots で /api/ を拒んでいる非公式の口なので、いつ塞がれてもよい作りに。
//   送るのは投稿 ID と作者 ID だけ。題・タグ・打った語は送らない。
// 控え: 一つの表 (ai-meta-store.js、ai-meta.sqlite)。aitag の答えは頁ごとの行 (source 'aitag') として書き、
//   404 は expires_at 付き (新しい投稿は 20 分、そうでなければ 3 日)。載っている (ok) は消えない。

const http = require('./http');
const { normalizeAny } = require('./ai-meta');
const { AiMetaStore } = require('./ai-meta-store');

const HOST = 'aitag.win';
const BASE = `https://${HOST}`;
const REFERER = `${BASE}/`;
const TIMEOUT = 8000;
const BREAKER_MS = 3 * 60 * 1000;

http.configureHost?.(HOST, { limit: 2, interval: 150 });

function pageIndexOf(fileName) {
  const m = /_p(\d+)\./.exec(String(fileName || ''));
  return m ? Number(m[1]) : -1;
}

// aitag の返事を頁ごとの共通の形に
function imagesOf(json) {
  const list = Array.isArray(json && json.images) ? json.images : [];
  return list.map((im, i) => {
    const index = pageIndexOf(im && im.file_name);
    const meta = normalizeAny(im && im.ai_json, { model: im && im.model, positive: im && im.prompt_text });
    return { index: index >= 0 ? index : i, meta, model: (im && im.model) || '', type: (im && im.image_type) || '' };
  }).filter((row) => row.meta);
}

class AitagClient {
  constructor({ store, transport = http, enabled = () => true, now = () => Date.now() } = {}) {
    this.store = store || new AiMetaStore({ file: ':memory:', now });
    this.http = transport;
    this.enabledFn = enabled;
    this.now = now;
    this.inflight = new Map();
    this.blockedUntil = 0;
    this.failures = 0;
  }

  enabled() {
    try { return this.enabledFn() !== false; } catch { return true; }
  }

  // 控えの答え。'yes' / 'no' / '' (無い、または期限切れ)
  cachedMark(pid) { return this.store.aitagKnown(String(pid).replace(/^px:/, '')); }

  blocked() { return this.now() < this.blockedUntil; }

  noteFailure(error) {
    this.failures += 1;
    if (this.failures >= 2 || (error && error.status === 429)) this.blockedUntil = this.now() + BREAKER_MS;
  }

  noteSuccess() { this.failures = 0; }

  // 404 (索引に無い) は null。他の失敗は投げる (http.js は 4xx/5xx を error.status 付きで投げる)
  async getJson(url, { signal } = {}) {
    let res;
    try {
      res = await this.http.get(url, { Referer: REFERER, Accept: 'application/json' }, { timeout: TIMEOUT, signal, priority: 20 });
    } catch (error) {
      if (error && error.status === 404) return null;
      throw error;
    }
    const status = Number(res && res.status) || 0;
    if (status === 404) return null;
    if (status < 200 || status >= 300) {
      const error = new Error(`aitag ${status}`);
      error.status = status;
      throw error;
    }
    const text = Buffer.isBuffer(res.buffer) ? res.buffer.toString('utf8') : String(res.body || res.text || '');
    return JSON.parse(text);
  }

  // 控えから一作品ぶんの images[] を組む (ok で中身のある aitag の行)
  imagesFromStore(pid) {
    return this.store.pages(pid).filter((r) => r.page >= 0 && r.status === 'ok' && r.source === 'aitag' && r.meta)
      .map((r) => ({ index: r.page, meta: r.meta, model: r.model || '', type: r.format || '' }));
  }

  // 作品一つ。fresh: 投稿が新しい (載っていなくてもすぐ訊き直す)
  async work(pid, { fresh = false, signal } = {}) {
    const key = String(pid).replace(/^px:/, '');
    if (!/^\d+$/.test(key)) throw new Error('投稿の番号が無い');
    const known = this.cachedMark(key);
    if (known === 'yes') {
      const images = this.imagesFromStore(key);
      if (images.length) return { status: 'ok', images };
      // 一括で「載っている」と分かっただけ (中身は無い): 取りに行く
    } else if (known === 'no') {
      return { status: 'none' };
    }
    if (!this.enabled()) return { status: 'off' };
    if (this.blocked()) { const e = new Error('aitag は休止中'); e.code = 'aitag-paused'; throw e; }
    if (this.inflight.has(key)) return this.inflight.get(key);
    const pending = (async () => {
      let json;
      try {
        json = await this.getJson(`${BASE}/api/work/${encodeURIComponent(key)}`, { signal });
      } catch (error) {
        this.noteFailure(error);
        throw error;
      }
      this.noteSuccess();
      const images = json ? imagesOf(json) : [];
      if (!images.length) { this.store.aitagMiss(key, { fresh }); return { status: 'none' }; }
      this.store.batch((put) => { for (const im of images) put({ pid: key, page: im.index, status: 'ok', source: 'aitag', meta: im.meta }); });
      return { status: 'ok', images };
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, pending);
    return pending;
  }

  // 作者の索引済みの投稿 ID。最大 3 頁 (180 件)。失敗は空
  async byUser(userId, { signal } = {}) {
    const uid = String(userId || '').replace(/^pxu:|^user:/, '');
    if (!/^\d+$/.test(uid) || !this.enabled() || this.blocked()) return [];
    const ids = [];
    try {
      for (let page = 1; page <= 3; page += 1) {
        const url = `${BASE}/api/ai_works_search?q=${uid}&search_kind=work&sort=new&time_range=all&page=${page}&page_size=60&show_r18=1`;
        const json = await this.getJson(url, { signal });
        const items = Array.isArray(json && json.items) ? json.items : [];
        for (const it of items) {
          const id = String(it && it.id || '');
          if (!/^\d+$/.test(id) || String(it.userId) !== uid) continue;
          ids.push(id);
        }
        if (items.length < 60 || ids.length >= Number(json.total || 0)) break;
      }
      this.store.batch(() => { for (const id of ids) this.store.aitagListed(id); });
      this.noteSuccess();
    } catch (error) {
      this.noteFailure(error);
    }
    return ids;
  }

  // 印。rows: [{ id, fresh }] か id の配列。控えに無い物だけ訊く (同時 2 本は http の作法が抑える)
  async marks(rows, { signal } = {}) {
    const out = {};
    const ask = [];
    for (const row of rows || []) {
      const id = typeof row === 'string' ? row : row && row.id;
      const pid = String(id || '').replace(/^px:/, '');
      if (!/^\d+$/.test(pid)) continue;
      const fresh = typeof row === 'object' && row && row.fresh === true;
      const hit = this.store.markOf(pid);
      if (hit) out[`px:${pid}`] = hit;
      else ask.push({ pid, fresh });
    }
    if (!ask.length || !this.enabled() || this.blocked()) {
      for (const { pid } of ask) out[`px:${pid}`] = 'unknown';
      return out;
    }
    // 同時 2 本の自前の絞り。一度に 60 件を http の順番待ちに積むと、待ちが 8 秒の期限で切れて
    // 失敗に数えられ、口が黙ってしまう (2026-10-18 の実機で 341 件のうち 226 件が unknown になった)
    const list = ask.slice(0, 60);
    for (const { pid } of ask.slice(60)) out[`px:${pid}`] = 'unknown';
    let at = 0;
    const worker = async () => {
      while (at < list.length) {
        const { pid, fresh } = list[at];
        at += 1;
        if (this.blocked()) { out[`px:${pid}`] = 'unknown'; continue; }
        try {
          const res = await this.work(pid, { fresh, signal });
          out[`px:${pid}`] = res.status === 'ok' ? 'yes' : res.status === 'none' ? 'no' : 'unknown';
        } catch {
          out[`px:${pid}`] = 'unknown';
        }
      }
    };
    await Promise.all([worker(), worker()]);
    return out;
  }
}

module.exports = { AitagClient, imagesOf, pageIndexOf, HOST, BASE };
