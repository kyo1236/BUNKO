'use strict';

// pixiv の作法。数字は Powerful Pixiv Downloader (PPD) の既定に合わせる
// (docs/pixiv-requirements-2026-09-19.md §5、利用者指定)。PPD に無い物 (一括の休み) だけ独自。
//
//   API 車線   同時 1。直近 10 分の呼び出しが apiSlowAfter を超えたら次から apiGapMs 空ける
//   画像車線   同時 6。落とす原寸だけ。直近 10 分の取得が imageSlowAfter を超えたら 1 ファイルごとに imageGapMs
//   眺める車線 同時 6。表紙・読み手の頁・作者の顔。間隔は空けない: ブラウザで pixiv を眺めるのと
//             同じ荷で、PPD も落とす物しか数えない (表紙まで数えると 150 枚で 1 枚 1 秒になり、
//             一覧も読み手も分単位で待った — 2026-09-19 の利用者の指摘)
//   429       全車線を cooldownMs 止める。10 分以内に二度目なら cooldownRepeatMs
//   優先       車線の順番待ちは priority の小さい方から (1 秒待つごとに一段上がる)。読み手の頁 0、表紙 10
//   一括       一走りの詳細 bulkBatch 件で bulkRestMs 休む。走りは止められる
//
// http.js の SiteScheduler (host ごと同時 16・Retry-After の冷却) の**手前**に置く:
// ここを通した物だけが網へ降りる。共通化は二源泉目が来てから。
// electron を引かない (試験は素の node で回す)。時計と時限は差し替えられる。

const trace = require('../trace');

const DEFAULTS = Object.freeze({
  apiConcurrency: 1,
  apiSlowAfter: 100,
  apiGapMs: 1600,
  imageConcurrency: 6,
  imageSlowAfter: 150,
  imageGapMs: 1000,
  viewConcurrency: 6,
  viewSlowAfter: 0,
  viewGapMs: 0,
  cooldownMs: 200 * 1000,
  cooldownRepeatMs: 600 * 1000,
  cooldownRepeatWindowMs: 600 * 1000,
  bulkBatch: 300,
  bulkRestMs: 600 * 1000,
  windowMs: 600 * 1000,
});

const COOLDOWN_FLAG = 'pixiv-cooldown';

// pixiv が「もう来るな」と言った返事か。app API は 403 の body に "Rate Limit" を載せる。
// http.js は 429 に status を付けて投げる。どちらも同じ扱い
function isRateLimited(error) {
  if (!error) return false;
  if (error.status === 429 || error.rateLimited === true) return true;
  const body = typeof error.body === 'string' ? error.body : '';
  return /rate limit/i.test(body) || /\b429\b/.test(String(error.message || ''));
}

class Lane {
  constructor(name, { concurrency, slowAfter, gapMs }, shared) {
    this.name = name;
    this.concurrency = Math.max(1, Number(concurrency) || 1);
    this.slowAfter = Math.max(0, Number(slowAfter) || 0);
    this.gapMs = Math.max(0, Number(gapMs) || 0);
    this.shared = shared;           // { now, setTimer, windowMs, pausedUntil() }
    this.active = 0;
    this.waiters = [];
    this.starts = [];               // 直近 windowMs に始めた時刻
    this.lastStartAt = 0;
    this.timer = null;
  }

  // 直近 windowMs の件数 (古い物は捨てる)
  recentCount() {
    const cutoff = this.shared.now() - this.shared.windowMs;
    while (this.starts.length && this.starts[0] < cutoff) this.starts.shift();
    return this.starts.length;
  }

  // 次の一件を始めてよい時刻。今なら now 以下の値
  readyAt() {
    const now = this.shared.now();
    let at = Math.max(now, this.shared.pausedUntil());
    if (this.recentCount() >= this.slowAfter && this.gapMs > 0) {
      at = Math.max(at, this.lastStartAt + this.gapMs);
    }
    return at;
  }

  // 止まっている間は待たせず、429 の顔をした誤りをすぐ返す (§15 E1)。
  // 待たせると downloader の fetchGate の枠を 200 秒抱え、他の源泉の仕事が飢える。
  // 呼び手 (fetchWithRetry / scheduleRetry) は 429 を見て長く退く
  pausedError() {
    const until = this.shared.pausedUntil();
    const error = new Error(`pixiv 冷却中 (429)。あと ${Math.ceil((until - this.shared.now()) / 1000)} 秒`);
    error.status = 429;
    error.rateLimited = true;
    error.throttled = true;
    error.retryAfterMs = Math.max(1, until - this.shared.now());
    return error;
  }

  acquire(signal, priority = 10) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason || new Error('aborted'));
        return;
      }
      if (this.shared.pausedUntil() > this.shared.now()) {
        reject(this.pausedError());
        return;
      }
      const waiter = {
        resolve, reject, signal, onAbort: null, priority: Number(priority) || 0, queuedAt: this.shared.now(),
      };
      if (signal) {
        waiter.onAbort = () => {
          const at = this.waiters.indexOf(waiter);
          if (at >= 0) this.waiters.splice(at, 1);
          reject(signal.reason || new Error('aborted'));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
      this.pump();
    });
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    this.pump();
  }

  // 冷却に入った: 並んでいる待ち手も同じ誤りで返す (枠を持ったまま眠らせない)
  rejectWaiters() {
    const waiting = this.waiters.splice(0);
    for (const waiter of waiting) {
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
      waiter.reject(this.pausedError());
    }
  }

  pump() {
    while (this.active < this.concurrency && this.waiters.length) {
      const at = this.readyAt();
      const now = this.shared.now();
      if (at > now) {
        this.arm(at - now);
        return;
      }
      const waiter = this.waiters.splice(this.nextIndex(now), 1)[0];
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
      this.active += 1;
      this.lastStartAt = now;
      this.starts.push(now);
      waiter.resolve();
    }
  }

  // 次に出す待ち手。priority の小さい方から、1 秒待つごとに一段上げる (後ろの物も枯らさない)。
  // 同点は先に並んだ方
  nextIndex(now) {
    let best = 0;
    let bestScore = Infinity;
    for (let i = 0; i < this.waiters.length; i += 1) {
      const waiter = this.waiters[i];
      const score = waiter.priority - Math.floor((now - waiter.queuedAt) / 1000);
      if (score < bestScore) {
        best = i;
        bestScore = score;
      }
    }
    return best;
  }

  arm(ms) {
    if (this.timer) return;
    this.timer = this.shared.setTimer(() => {
      this.timer = null;
      this.pump();
    }, Math.max(1, ms));
  }

  async run(fn, { signal, priority } = {}) {
    await this.acquire(signal, priority);
    try {
      return await fn();
    } catch (error) {
      if (isRateLimited(error)) this.shared.pause();
      throw error;
    } finally {
      this.release();
    }
  }

  state() {
    return {
      active: this.active,
      waiting: this.waiters.length,
      recent: this.recentCount(),
      slowed: this.recentCount() >= this.slowAfter && this.gapMs > 0,
    };
  }
}

function createManners(options = {}) {
  const config = { ...DEFAULTS, ...(options.config || {}) };
  const now = options.now || Date.now;
  // 時限は待っている仕事がある間だけ張られる。unref はしない: 待ち手が居るのに
  // 事象の輪が抜けると、約束が宙に浮いたまま終わる (試験がそれで落ちた)
  const setTimer = options.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const tracer = options.trace || trace;

  let pausedUntil = 0;
  let lastPauseAt = 0;
  let pauses = 0;

  // 全車線を止める。近い時期の二度目は長く止める
  function pause() {
    const at = now();
    if (pausedUntil > at) return pausedUntil;        // 止まっている最中の重ね打ちは伸ばさない
    const repeat = lastPauseAt && at - lastPauseAt < config.cooldownRepeatWindowMs;
    const ms = repeat ? config.cooldownRepeatMs : config.cooldownMs;
    pausedUntil = at + ms;
    lastPauseAt = at;
    pauses += 1;
    try { tracer.flag(COOLDOWN_FLAG, true, ms); } catch { /* 印が付かなくても止まりはする */ }
    api.rejectWaiters();
    image.rejectWaiters();
    view.rejectWaiters();
    return pausedUntil;
  }

  const shared = {
    now, setTimer, windowMs: config.windowMs, pause, pausedUntil: () => pausedUntil,
  };
  const api = new Lane('api', {
    concurrency: config.apiConcurrency, slowAfter: config.apiSlowAfter, gapMs: config.apiGapMs,
  }, shared);
  const image = new Lane('image', {
    concurrency: config.imageConcurrency, slowAfter: config.imageSlowAfter, gapMs: config.imageGapMs,
  }, shared);
  // 眺める車線 (表紙・読み手の頁・作者の顔)。落とす物ではないので件数を数えて間隔を空けることはしない
  const view = new Lane('view', {
    concurrency: config.viewConcurrency, slowAfter: config.viewSlowAfter, gapMs: config.viewGapMs,
  }, shared);

  // 一括 (作者・候補) の一走り。詳細 bulkBatch 件ごとに bulkRestMs 休む。止められる
  function createRun(label = '') {
    const controller = new AbortController();
    const run = {
      label,
      signal: controller.signal,
      count: 0,
      resting: false,
      restUntil: 0,
      stop(reason) { controller.abort(reason || new Error('stopped')); },
      get stopped() { return controller.signal.aborted; },
      async tick() {
        if (controller.signal.aborted) throw controller.signal.reason || new Error('stopped');
        run.count += 1;
        if (config.bulkBatch > 0 && run.count % config.bulkBatch === 0) {
          run.resting = true;
          run.restUntil = now() + config.bulkRestMs;
          try {
            await sleepUntil(run.restUntil, controller.signal);
          } finally {
            run.resting = false;
            run.restUntil = 0;
          }
        }
      },
    };
    return run;
  }

  function sleepUntil(at, signal) {
    return new Promise((resolve, reject) => {
      const ms = Math.max(0, at - now());
      if (signal?.aborted) {
        reject(signal.reason || new Error('stopped'));
        return;
      }
      let timer = null;
      const onAbort = () => {
        if (timer && typeof timer === 'object' && typeof timer.close === 'function') clearTimeout(timer);
        else if (timer) clearTimeout(timer);
        reject(signal.reason || new Error('stopped'));
      };
      timer = setTimer(() => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  function state() {
    const at = now();
    return {
      pausedUntil: pausedUntil > at ? pausedUntil : 0,
      pausedForMs: pausedUntil > at ? pausedUntil - at : 0,
      pauses,
      api: api.state(),
      image: image.state(),
      view: view.state(),
      config: { ...config },
    };
  }

  return {
    api: (fn, opts) => api.run(fn, opts),
    image: (fn, opts) => image.run(fn, opts),
    view: (fn, opts) => view.run(fn, opts),
    pause,
    createRun,
    state,
    isRateLimited,
    config,
  };
}

module.exports = { createManners, isRateLimited, DEFAULTS, COOLDOWN_FLAG };
