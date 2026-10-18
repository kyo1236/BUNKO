const MAX_ATTEMPTS = 3;
const FAILURE_COOLDOWN = 7 * 24 * 60 * 60 * 1000;
const REQUEST_DELAY = 300;
const CONCURRENCY = 2;
const NOTIFY_EVERY = 10;
const NOTIFY_INTERVAL = 2000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class LibraryBackfill {
  constructor({ catalog, getGallery, getNewestId, onProgress, delay, concurrency } = {}) {
    this.catalog = catalog;
    this.getGallery = getGallery;
    this.getNewestId = getNewestId || null;
    this.onProgress = onProgress || null;
    this.delay = Number.isFinite(delay) ? Number(delay) : REQUEST_DELAY;
    this.concurrency = Math.max(1, Number(concurrency) || CONCURRENCY);
    this.running = false;
    this.stopping = false;
    this.done = 0;
    this.failed = 0;
    this.total = 0;
    this.queue = [];
    this.cursor = 0;
    this.nextAt = 0;
    this.lastNotify = 0;
    this.sinceNotify = 0;
    this.job = null;
  }

  status() {
    const handled = this.done + this.failed;
    return {
      running: this.running,
      done: this.done,
      failed: this.failed,
      remaining: Math.max(0, this.total - handled),
      total: this.total,
    };
  }

  notify(force = false) {
    if (!this.onProgress) return;
    this.sinceNotify += 1;
    const now = Date.now();
    if (!force && this.sinceNotify < NOTIFY_EVERY && now - this.lastNotify < NOTIFY_INTERVAL) return;
    this.sinceNotify = 0;
    this.lastNotify = now;
    try {
      this.onProgress(this.status());
    } catch {
      // ignore listener errors
    }
  }

  async gate() {
    const now = Date.now();
    const wait = Math.max(0, this.nextAt - now);
    this.nextAt = Math.max(now, this.nextAt) + this.delay;
    if (wait > 0) await sleep(wait);
  }

  start() {
    if (this.running) return this.job || Promise.resolve(this.status());
    this.job = this.run().catch(() => this.status());
    return this.job;
  }

  stop() {
    this.stopping = true;
    return this.job || Promise.resolve(this.status());
  }

  async run() {
    if (!this.catalog || typeof this.getGallery !== 'function') return this.status();
    this.queue = this.catalog.pendingMetaIds({
      maxAttempts: MAX_ATTEMPTS,
      cooldown: FAILURE_COOLDOWN,
    });
    // Eagle のタイトルから拾った ID には他サイト由来の桁違いが混ざる。
    // 現行の最新 ID を仕入れて、それより先の番号は hitomi に存在しないものとして弾く。
    // 仕入れに失敗した(=圏外の)ときは走らせない: 有効な ID に失敗マークを付けてしまうため。
    if (typeof this.getNewestId === 'function') {
      try {
        const newest = Number(await this.getNewestId());
        if (Number.isFinite(newest) && newest > 0) {
          const ceiling = newest + 1000;
          this.queue = this.queue.filter((id) => id <= ceiling);
        } else {
          this.queue = [];
        }
      } catch {
        this.queue = [];
      }
    }
    this.cursor = 0;
    this.done = 0;
    this.failed = 0;
    this.total = this.queue.length;
    this.stopping = false;
    this.nextAt = 0;
    this.sinceNotify = 0;
    this.lastNotify = 0;
    if (!this.total) return this.status();

    this.running = true;
    this.notify(true);
    try {
      const workers = Array.from(
        { length: Math.min(this.concurrency, this.total) },
        () => this.worker(),
      );
      await Promise.all(workers);
    } finally {
      this.running = false;
      this.job = null;
      if (this.catalog.flushPersist) {
        try {
          this.catalog.flushPersist();
        } catch {
          // ignore
        }
      }
      this.notify(true);
    }
    return this.status();
  }

  async worker() {
    while (!this.stopping && this.cursor < this.queue.length) {
      const id = this.queue[this.cursor];
      this.cursor += 1;
      await this.gate();
      if (this.stopping) break;
      try {
        const gallery = await this.getGallery(String(id));
        const matches = gallery && !gallery.error
          && this.catalog.titleMatchesMeta(id, gallery.title);
        if (matches && this.catalog.storeGalleryMeta(gallery)) {
          // 旧 ID を引くと別の正規 ID で返ることがある。所持アイテムは旧 ID しか
          // 知らないので、そちらの番号でも同じメタを引けるようにしておく。
          if (Number(gallery.id) !== Number(id)) {
            this.catalog.storeGalleryMeta({ ...gallery, id, sourceId: id });
          }
          this.done += 1;
        } else {
          this.failed += 1;
          this.catalog.markFetchFailure(id);
        }
      } catch {
        this.failed += 1;
        try {
          this.catalog.markFetchFailure(id);
        } catch {
          // ignore
        }
      }
      this.notify();
    }
  }
}

module.exports = { LibraryBackfill };
