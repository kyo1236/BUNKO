'use strict';
// 生成情報を確かめる一本の列 (利用者の決め 2026-10-18):
//   取得の順は aitag 単品 → 原寸の先頭 64KB (Range。文字チャンク版と EXIF はここで分かる) → 原寸ぜんぶ (ステルスの確定)。
//   全部「順次」。押した物 (press) を先頭に割り込ませ、残り (新着の確定 confirm・所持の埋め戻し backfill) は後ろから一本ずつ。
//   pixiv の眺める車線と aitag への間隔はそれぞれの口が守る。429 (冷却) が出たら列ごと止めて待つ。
//   結果は全部 ai-meta-store の表へ。写し (readOnly) では confirm / backfill は積まない (press だけ、表には書かない)。
//
// 埋め戻し (所持): aitag → PDF の頁 (JPEG はそのまま EXIF、Flate は worker で RGB + 透過 からステルス) → pixiv にまだあれば原寸 → 確認できず

const { extractFromBytes } = require('./ai-meta');

const CONFIRM_MAX = 300;
const PAUSE_DEFAULT = 5 * 60 * 1000;
const HEAD_BYTES = 65536;
const BACKFILL_PAGES = 4;       // 所持の埋め戻しで覗く頁数 (生成情報は 1 枚目にある事がほとんど)

function rateLimited(error) {
  return Boolean(error && (error.rateLimited || error.status === 429));
}
// http.js と pixiv の作法は retryAfterMs (ms) を添える。無ければ既定の 5 分
function retryAfterMs(error) {
  const ms = Number(error && error.retryAfterMs);
  if (Number.isFinite(ms) && ms > 0) return ms;
  const sec = Number(error && error.retryAfter);
  return Number.isFinite(sec) && sec > 0 ? sec * 1000 : PAUSE_DEFAULT;
}

class AiMetaQueue {
  constructor({
    store, aitag, pixivSource, analyze, now = () => Date.now(), send = () => {}, readOnly = false,
    pdfPages = null,   // 埋め戻し用: async (pid) → { file, pages: [{ index, kind:'dct'|'flate', bytes?, stealth?: async () => text|null }] } | null
  } = {}) {
    this.store = store;
    this.aitag = aitag;
    this.pixiv = pixivSource;
    this.analyze = analyze;
    this.now = now;
    this.send = send;
    this.readOnly = readOnly;
    this.pdfPages = pdfPages;
    this.front = [];      // press
    this.back = [];       // confirm / backfill
    this.running = false;
    this.pausedUntil = 0;
    this.timer = null;
    this.stopped = false;
    this.backfill = null; // { total, done, found, failed, running, startedAt }
  }

  status() {
    return {
      pressing: this.front.length, waiting: this.back.length, running: this.running,
      pausedForMs: Math.max(0, this.pausedUntil - this.now()), backfill: this.backfill ? { ...this.backfill } : null,
    };
  }

  // ---- 積む ----
  press(pid, index = 0, { fresh = false, force = '' } = {}) {
    const key = String(pid).replace(/^px:/, '');
    const page = Math.max(0, Math.floor(Number(index) || 0));
    const same = this.front.find((j) => j.pid === key && j.page === page && j.force === force);
    if (same) return new Promise((resolve, reject) => same.waiters.push({ resolve, reject }));
    const job = { kind: 'press', pid: key, page, fresh, force, waiters: [] };
    const out = new Promise((resolve, reject) => job.waiters.push({ resolve, reject }));
    this.front.push(job);
    this.kick();
    return out;
  }

  confirm(pid, { fresh = false } = {}) {
    if (this.readOnly) return false;
    const key = String(pid).replace(/^px:/, '');
    if (!/^\d+$/.test(key)) return false;
    if (this.back.some((j) => j.pid === key) || this.front.some((j) => j.pid === key)) return false;
    this.back.push({ kind: 'confirm', pid: key, page: 0, fresh });
    while (this.back.length > CONFIRM_MAX) {
      const at = this.back.findIndex((j) => j.kind === 'confirm');
      if (at < 0) break;
      this.back.splice(at, 1);
    }
    this.kick();
    return true;
  }

  // 所持の埋め戻し (一度だけ)。pids: 台帳の投稿 ID
  startBackfill(pids) {
    if (this.readOnly) return this.status();
    if (this.backfill && this.backfill.running) return this.status();
    const list = [...new Set((pids || []).map((p) => String(p).replace(/^px:/, '')).filter((p) => /^\d+$/.test(p)))]
      .filter((pid) => this.store.markOf(pid) === '');
    this.backfill = { total: list.length, done: 0, found: 0, failed: 0, running: list.length > 0, startedAt: this.now() };
    for (const pid of list) this.back.push({ kind: 'backfill', pid, page: 0, fresh: false });
    this.sendBackfill();
    this.kick();
    return this.status();
  }

  stopBackfill() {
    this.back = this.back.filter((j) => j.kind !== 'backfill');
    if (this.backfill) { this.backfill.running = false; this.sendBackfill(); }
    return this.status();
  }

  sendBackfill() {
    try { this.send('ai-meta-backfill', this.backfill ? { ...this.backfill } : null); } catch { /* 画面が居なくてもよい */ }
  }

  pause(ms) {
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + Math.max(1000, ms || PAUSE_DEFAULT));
    this.kick();
  }

  stop() { this.stopped = true; clearTimeout(this.timer); this.timer = null; }

  kick() {
    if (this.running || this.stopped) return;
    // 既に待っていても組み直す (冷却が解けた・時計が進んだ時に、古い待ちのまま眠らない)
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const wait = Math.max(0, this.pausedUntil - this.now());
    // unref しない: 押した物の約束が残っている間はプロセスを生かす (試験は stop() で畳む)
    this.timer = setTimeout(() => { this.timer = null; this.run().catch(() => {}); }, wait);
  }

  async run() {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      while (!this.stopped) {
        if (this.now() < this.pausedUntil) break;
        const job = this.front.shift() || this.back.shift();
        if (!job) break;
        await this.work(job);
        // 一本ずつの間に息をつく (主スレッドを長く握らない)
        await new Promise((r) => setImmediate(r));
      }
    } finally {
      this.running = false;
      if (!this.stopped && (this.front.length || this.back.length)) this.kick();
    }
  }

  async work(job) {
    try {
      let out;
      if (job.kind === 'backfill') out = await this.backfillOne(job.pid);
      else out = await this.resolvePage(job.pid, job.page, { fresh: job.fresh, force: job.force });
      // 確定・埋め戻しで「あり」に変わった物は画面へ知らせる (札の控えは no のままなので、言わないと印が付かない)
      if (job.kind !== 'press' && out && out.status === 'ok') {
        try { this.send('ai-meta-mark', { id: `px:${job.pid}`, mark: 'yes' }); } catch { /* 画面が居なくてもよい */ }
      }
      if (job.kind === 'backfill' && this.backfill) {
        this.backfill.done += 1;
        if (out && out.status === 'ok') this.backfill.found += 1;
        if (this.backfill.done >= this.backfill.total) this.backfill.running = false;
        this.sendBackfill();
      }
      for (const w of job.waiters || []) w.resolve(out);
    } catch (error) {
      if (rateLimited(error)) {
        // 冷却: 列ごと止めて、この仕事は先頭へ戻す (押した物は待たせたまま)
        this.pause(retryAfterMs(error));
        if (job.kind === 'press') this.front.unshift(job); else this.back.unshift(job);
        return;
      }
      if (job.kind === 'backfill' && this.backfill) { this.backfill.done += 1; this.backfill.failed += 1; if (this.backfill.done >= this.backfill.total) this.backfill.running = false; this.sendBackfill(); }
      for (const w of job.waiters || []) w.reject(error);
    }
  }

  put(row) { if (!this.readOnly) this.store.put(row); }

  // 一頁ぶんを確かめる: 表 → aitag → 先頭 64KB → 原寸。force: 'original' は原寸から読み直す
  async resolvePage(pid, page, { fresh = false, force = '' } = {}) {
    if (force !== 'original') {
      const kept = this.store.metaOf(pid, page);
      if (kept) return { status: 'ok', source: kept.source, meta: kept.meta };
      const row = this.store.get(pid, page);
      if (row && row.status === 'none' && (row.source === 'original' || row.source === 'import' || row.source === 'pdf-smask')) {
        return { status: 'none', source: row.source };
      }
      // aitag (休止中・網の不調は飛ばして次へ)
      try {
        const hit = await this.aitag.work(pid, { fresh });
        if (hit.status === 'ok') {
          const im = hit.images.find((r) => r.index === page);
          if (im) return { status: 'ok', source: 'aitag', meta: im.meta };
        }
      } catch (error) {
        if (rateLimited(error)) throw error;
      }
      // 先頭 64KB (文字チャンク / EXIF)。head64k で無しと分かっている頁は飛ばす
      if (!(row && row.source === 'head64k')) {
        const head = await this.pixiv.fetchImageHead(pid, page, { bytes: HEAD_BYTES });
        if (!head) return { status: 'no-original', source: 'original' };
        const bytes = Buffer.isBuffer(head.bytes) ? head.bytes : Buffer.from(head.bytes);
        const found = await extractFromBytes(bytes);
        if (found) { this.put({ pid, page, status: 'ok', source: 'head64k', meta: found }); return { status: 'ok', source: 'head64k', meta: found }; }
        this.put({ pid, page, status: 'none', source: 'head64k' });
      }
    }
    // 原寸ぜんぶ (ステルス)
    const image = await this.pixiv.fetchImage(pid, page, { size: 'full', reading: true, priority: 5 });
    if (!image || !image.bytes) return { status: 'no-original', source: 'original' };
    if (image.url && !/\/img-original\//.test(String(image.url))) return { status: 'no-original', source: 'original' };
    const bytes = Buffer.isBuffer(image.bytes) ? image.bytes : Buffer.from(image.bytes);
    const found = await this.analyze(bytes);
    this.put({ pid, page, status: found ? 'ok' : 'none', source: 'original', meta: found });
    return found ? { status: 'ok', source: 'original', meta: found } : { status: 'none', source: 'original' };
  }

  // 所持の一作品: aitag → PDF の頁 → (pixiv にまだあれば) 原寸 → 確認できず
  async backfillOne(pid) {
    if (this.store.markOf(pid) === 'yes') return { status: 'ok', source: 'store' };
    try {
      const hit = await this.aitag.work(pid, { fresh: false });
      if (hit.status === 'ok' && hit.images.length) return { status: 'ok', source: 'aitag' };
    } catch (error) {
      if (rateLimited(error)) throw error;
    }
    let book = null;
    try { book = this.pdfPages ? await this.pdfPages(pid) : null; } catch { book = null; }
    if (book && Array.isArray(book.pages)) {
      let any = false;
      for (const page of book.pages.slice(0, BACKFILL_PAGES)) {
        let found = null;
        try {
          if (page.kind === 'dct' && page.bytes) found = await extractFromBytes(Buffer.isBuffer(page.bytes) ? page.bytes : Buffer.from(page.bytes));
          else if (page.kind === 'flate' && typeof page.stealth === 'function') {
            const text = await page.stealth();
            if (text) {
              const { normalize, rawFromAny } = require('./ai-meta');
              found = normalize(rawFromAny(text));
              if (found) found.foundIn = 'pdf-smask';
            }
          }
        } catch { found = null; }
        if (found) { this.put({ pid, page: page.index, status: 'ok', source: 'pdf-smask', meta: found }); any = true; }
      }
      if (any) return { status: 'ok', source: 'pdf-smask' };
      this.put({ pid, page: 0, status: 'none', source: 'pdf-smask' });
    }
    // pixiv にまだあれば原寸 (取り下げ・ログイン切れ・無しは「確認できず」のまま)
    try {
      const out = await this.resolvePage(pid, 0, { fresh: false, force: book ? '' : '' });
      return out;
    } catch (error) {
      if (rateLimited(error)) throw error;
      return { status: 'unknown', source: '' };
    }
  }
}

module.exports = { AiMetaQueue, HEAD_BYTES, CONFIRM_MAX, BACKFILL_PAGES };
