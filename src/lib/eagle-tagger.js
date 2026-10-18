const eagleApi = require('./eagle-api');
const trace = require('./trace');

const ITEM_DELAY = 250;
const NOTIFY_EVERY = 5;
const NOTIFY_INTERVAL = 3000;
const MAX_CONSECUTIVE_FAILURES = 5;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 所持作品(このアプリでダウンロード済み)の Eagle アイテムに、作者・グループ・
// 原作・キャラの日本語タグを書き込むジョブ。LibraryBackfill / LibraryMatch と
// 同じ start/stop/status の形にしてある
class EagleTagger {
  constructor({ catalog, onProgress, delay } = {}) {
    this.catalog = catalog;
    this.onProgress = onProgress || null;
    this.delay = Number.isFinite(delay) ? Number(delay) : ITEM_DELAY;
    this.running = false;
    this.stopping = false;
    this.done = 0;
    this.pushed = 0;
    this.skipped = 0;
    this.retracted = 0;
    this.failed = 0;
    this.total = 0;
    this.queue = [];
    this.cursor = 0;
    this.consecutiveFailures = 0;
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
      pushed: this.pushed,
      skipped: this.skipped,
      // 照合し直しで前の作品の札を引いた数 (その Eagle アイテムの数)
      retracted: this.retracted,
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
    if (!this.catalog || typeof this.catalog.eagleTagTargets !== 'function') return this.status();

    // Eagle が起動していない / API が無効 / トークンが切れている。
    // 以前は三つとも黙って何もしなかったので、利用者は「タグが増えない」
    // としか分からなかった (項目 9-2)。区別して残し、帯に出す
    let available = false;
    let why = 'eagle-api-failed';
    try {
      available = await eagleApi.isAvailable();
      if (!available) why = 'offline';
    } catch (error) {
      available = false;
      why = trace.codeOf(error) === 'ECONNREFUSED' ? 'offline' : 'auth-failed';
    }
    if (!available) {
      this.lastError = why;
      trace.warnOnce(`tagger:${why}`, 'eagle', why === 'offline' ? 'offline' : 'auth-failed');
      // 時限つき: Eagle が起きたことを誰も教えてくれないので、
      // 印だけ残って帯が永久に居座るのを防ぐ (仕事が次に走れば立て直る)
      trace.flag('eagle-tag-stalled', true, 30 * 60 * 1000);
      return this.status();
    }
    this.lastError = '';
    trace.flag('eagle-tag-stalled', false);

    this.queue = this.catalog.eagleTagTargets();
    this.cursor = 0;
    this.done = 0;
    this.pushed = 0;
    this.skipped = 0;
    this.retracted = 0;
    this.failed = 0;
    this.consecutiveFailures = 0;
    this.total = this.queue.length;
    this.stopping = false;
    this.nextAt = 0;
    this.sinceNotify = 0;
    this.lastNotify = 0;
    if (!this.total) return this.status();

    this.running = true;
    this.notify(true);
    try {
      while (!this.stopping && this.cursor < this.queue.length) {
        const target = this.queue[this.cursor];
        this.cursor += 1;
        await this.gate();
        if (this.stopping) break;
        const ok = await this.handle(target);
        if (ok) {
          this.consecutiveFailures = 0;
        } else {
          this.failed += 1;
          this.consecutiveFailures += 1;
          // 立て続けに落ちるのは Eagle が落ちた/圏外のとき。畳んで次回に回す
          if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
        }
        this.notify();
      }
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

  // 戻り値は「対象を処理しきれたか」。false は通信の失敗で、台帳に書かず次回へ回す
  async handle(target) {
    const labels = this.catalog.japaneseTagsFor(target.galleryId);
    // 照合し直しで別の作品へ結び直された時は、前の作品のために BUNKO が書き足した札の
    // うち新しい作品の札でない物を引く。引くのは記録にある「自分で書き足した札」だけで、
    // 利用者の札・出どころの分からない古い記録 (added が NULL) には触れない
    const prev = typeof this.catalog.eagleTagPushFor === 'function'
      ? this.catalog.eagleTagPushFor(target.eagleId)
      : null;
    const prevAdded = prev && Array.isArray(prev.added) ? prev.added : [];
    const relinked = Boolean(prev) && prev.galleryId != null
      && Number(prev.galleryId) !== Number(target.galleryId);
    const labelSet = new Set(labels);
    const stale = new Set(relinked ? prevAdded.filter((tag) => !labelSet.has(tag)) : []);

    if (!labels.length && !stale.size) {
      // 書けるラベルが無い。以前は台帳に書かず毎回対象に戻していたので、
      // 更新のたびに同じ数十件が「書き込み中」に並び続けていた。空として
      // 記録して以後は外す。ラベル学習で新しいラベルが増えたときは
      // catalog 側が空記録を落とすので、そのとき拾い直される
      try {
        this.catalog.recordEagleTagPush(target.eagleId, target.galleryId, [], []);
      } catch {
        // 台帳が書けなくても処理そのものは続ける
      }
      this.skipped += 1;
      this.done += 1;
      return true;
    }

    let item = null;
    try {
      item = await eagleApi.getItem(target.eagleId);
    } catch (error) {
      trace.warnOnce('tagger:get', 'eagle', 'eagle-api-failed', { id: trace.codeOf(error) });
      return false;
    }
    const existing = Array.isArray(item.tags) ? item.tags.map((tag) => String(tag)) : [];
    const kept = existing.filter((tag) => !stale.has(tag));
    const removed = existing.length - kept.length;
    const seen = new Set(kept);
    const merged = [...kept];
    const appended = [];
    for (const label of labels) {
      if (seen.has(label)) continue;
      seen.add(label);
      merged.push(label);
      appended.push(label);
    }
    // 自分で書き足して今も付いている札。次に結び直された時に引ける物はこれだけ
    const own = new Set([...prevAdded, ...appended]);
    const added = [...new Set(merged.filter((tag) => own.has(tag)))];
    // ラベルが無い時は空で記録する (ラベルが増えた時に catalog が '[]' を落として拾い直す)
    const recorded = labels.length ? merged : [];

    if (!appended.length && !removed) {
      // 差分なし: API は叩かず、台帳だけ更新して以後は対象から外す
      try {
        this.catalog.recordEagleTagPush(target.eagleId, target.galleryId, recorded, added);
      } catch {
        // 台帳が書けなくても処理そのものは続ける
      }
      if (!labels.length) this.skipped += 1;
      this.done += 1;
      return true;
    }

    try {
      await eagleApi.updateTags(target.eagleId, merged);
    } catch (error) {
      trace.warnOnce('tagger:put', 'eagle', 'tag-write-failed', { id: trace.codeOf(error) });
      return false;
    }
    try {
      this.catalog.recordEagleTagPush(target.eagleId, target.galleryId, recorded, added);
    } catch {
      // ignore
    }
    if (removed) this.retracted += 1;
    this.pushed += 1;
    this.done += 1;
    return true;
  }
}

module.exports = { EagleTagger };
