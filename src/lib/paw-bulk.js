const fs = require('fs');
const os = require('os');
const path = require('path');
const pawFavorites = require('./paw-favorites');
const pawchive = require('./sources/pawchive');
const pawCookies = require('./paw-cookies');
// 種別の線・隠し箱の名・置き場の見立ては取り込みエンジン側に一本だけ持たせる。
// ここで書き写すと、片方だけ直したときに「エンジンは落とさないのにこちらは待つ」
// (= 永久に済にならない投稿) が生まれる
const {
  engine: sharedEngine, collectStaged, fileHashOf, kemonoExt,
  IMAGE_TYPES, VIDEO_TYPES, STAGING_DIR,
} = require('./kemono-engine');
const { buildPdf } = require('./pdf-builder');
const { imageSize } = require('./image-size');
// zip の開け方と置き直し方は手動保存と共有する (paw-zip-pdf)。同じ投稿を
// 二つの道で保存したときに別の名前・別の中身が並ばないよう、判断は向こうに一本
const { convertZip, copyInto } = require('./paw-zip-pdf');
const { ensureComplete } = require('./pdf-report');

// お気に入り作者の新着を丸ごと取り込む仕事。外部ツール (kemono-dl + 後処理スクリプト)
// が二段でやっていたことを 1 つの走りにまとめる:
//   1 投稿 = 画像を 1 冊の PDF、添付は「作品名+元ファイル名」で作者フォルダ直下へ。
//
// 実体を取りに行くのは kemono-dl の子プロセス (kemono-engine)。403 の躱し方・
// 再試行・.part でのレジュームは向こうが何年もかけて育てたもので、こちらで
// 書き直すより借りた方が確かに落ちてくる。こちらが持つのは「どの投稿を取るか」と
// 「落ちてきた実体をどう組むか」だけ。
//
// 作者ひとりの走りは 4 相:
//   1 列挙     一覧を頁送りしながら、台帳に無い投稿を数え上げる
//   2 仕分け   一件ずつ本体を引き直し、何を落とすか (画像/動画/zip) を hash で控える
//   3 取得     作者ぶんをまとめて 1 回の kemono-dl に投げ、隠し箱 (staging) へ落とす
//   4 組み直し hash で突き合わせ、PDF に綴じる / 名前を付けて置き直す
//
// 走り方は library-backfill と同じ約束: start() / stop() / status() と進捗の通知。
//
// どこまで済んだかは「済んだ投稿の台帳」だけが知っている (日付は見ない)。
// 作者ごとに新しい順へ頁を送り、1 頁まるごと済だった時点でその作者は終わり。
// お気に入りに入れたばかりの作者は履歴が無いので全部を取りに行く: それでよい。

// 取り込み中の実体を一度受ける隠し箱 (STAGING_DIR) は出力先の中に切る。
// 同じボリュームなら組み直しの写しが軽く済み、先頭のドットで Eagle と catalog の
// 走査からは外れる。
//
// エンジンに付けさせる名前。{hash} は添付の path に埋まった 64 桁 hex で、
// これがこちらの持つ添付一覧と落ちてきた実体を結ぶ唯一の鍵になる
// (向こうが元ファイル名から作る名は、重複時に細工が入るので当てにしない)
const FILENAME_PATTERN = '{id}/{hash}.{ext}';
const IMAGE_SET = new Set(IMAGE_TYPES);
const VIDEO_SET = new Set(VIDEO_TYPES);
// 素材と本文は取り込まない。エンジンにも --only-filetypes で同じ線を引く
// (IMAGE_TYPES / VIDEO_TYPES / zip) ので、psd/txt はそもそも落ちてこない。
// zip はここには入れない: 中身を開けてから置き場所を決める別枠 (paw-zip-pdf)
const SKIP_SET = new Set(['psd', 'txt']);

// 履歴の無い作者を丸ごと拾う回があるので頁の上限は広く取る。
// それでも青天井にはしない (壊れた API に延々つき合わされないため)
const MAX_PAGES = 200;
const REQUEST_DELAY = 300;
const RETRY_WAITS = [2000, 8000, 30000];
const NOTIFY_INTERVAL = 700;

const DEFAULT_CONCURRENCY = 2;
// 題が長い投稿はそのままだと Windows のパス長に触る
const TITLE_MAX = 120;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// "2026-08-15T20:29:55" → "20260815"。作品名の頭に置く公開日で、時刻や時差は見ない。
// 日付の分からない投稿は名前に日付を書けないので "00000000" で通す
function toYmd(value) {
  const hit = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return hit ? `${hit[1]}${hit[2]}${hit[3]}` : null;
}

// Windows で使えない字は _ に置き換える (置き換え方は kemono-dl の出力に合わせる)。
// 末尾の . と空白はエクスプローラに落とされるので先に削る
const WIN_BAD_CHARS = new RegExp('[<>:"/\\\\|?*\\u0000-\\u001f]', 'g');

function sanitizeSegment(text, limit = 160) {
  const clean = String(text == null ? '' : text)
    .replace(WIN_BAD_CHARS, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
    .replace(/[. ]+$/, '');
  return clean || '_';
}

// 作者フォルダは "<表示名> [<user id>]"。外部ツールが作った既存の並びと同じ形にする:
// 名前だけにすると同じ作者のフォルダが二重にできて Eagle の取り込みが割れる
function creatorDirName(name, user) {
  return sanitizeSegment(`${name || user} [${user}]`, 120);
}

// 作品名 = "[YYYYMMDD] [postId] タイトル【NP】"。
// paw-library.parseName がこの形から日付・投稿 ID・頁数を読み戻す (所持判定の鍵)
function workName(date, postId, title, imageCount) {
  const head = `[${date}] [${postId}] `;
  const tail = imageCount > 0 ? `【${imageCount}P】` : '';
  return `${head}${sanitizeSegment(title, TITLE_MAX)}${tail}`;
}

// 種別はエンジンと同じ読み方 (kemonoExt) でだけ決める。名前と道の「どちらかが
// 当たれば」で見ていたころは、名前に拡張子が無く道が .jpg の添付を画像として
// 待ってしまった: エンジンは落とさないので、その投稿は永久に済にならなかった
function isImage(file) {
  return IMAGE_SET.has(kemonoExt(file));
}

function isVideo(file) {
  return VIDEO_SET.has(kemonoExt(file));
}

function isZip(file) {
  return kemonoExt(file) === 'zip';
}

function isSkipped(file) {
  return SKIP_SET.has(kemonoExt(file));
}

// 同じ実体を二度載せない (表紙と 1 枚目が同じ添付を指すことがある)
function dedupe(files) {
  const seen = new Set();
  return files.filter((file) => {
    const key = String(file.path || '');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// 添付の実体と投稿を結ぶ鍵。添付の path には中身のハッシュ (64 桁 hex) が
// 埋まっていて、kemono-dl の {hash} はそこを取る (読み方は kemono-engine と共有)
function fileHash(file) {
  return fileHashOf((file && file.path) || '');
}

// 綴じずに置く添付の名の茎。「作品名+元ファイル名 (拡張子抜き)」。名前は投稿の
// 中身だけで決まる: 被ったら (2) を足す形にしていたころは、同じ投稿を組み直すたびに
// (2)(3) と増え続けた (欠けで一度失敗した投稿は必ず二度通る)。
// 尾に何を付けるかは呼び手が決める (書庫なら元の拡張子、綴じるなら【NP】.pdf)
function attachmentStem(file, base) {
  const original = sanitizeSegment(file.name || path.basename(file.path), 100);
  const ext = path.extname(original);
  return `${base}+${original.slice(0, original.length - ext.length)}`;
}

// 綴じずにそのまま置く添付の行き先
function attachmentPath(file, dir, base) {
  const original = sanitizeSegment(file.name || path.basename(file.path), 100);
  return path.join(dir, `${attachmentStem(file, base)}${path.extname(original)}`);
}

// 相 3 が持ち帰った「何が起きたか」を一行に畳む。欠けの理由は相 4 では分からない
// (置き場を見るだけ) ので、画面に出す言い分はここで決める
function engineReason(result) {
  if (!result) return '';
  if (result.failure) return String(result.failure);
  if (result.spawnError) return String(result.spawnError.message || result.spawnError);
  const errors = Array.isArray(result.errors) ? result.errors : [];
  // 流量で断られた行があれば代表に立てる (次の回に効く手が変わる)
  const throttled = errors.find((line) => /\b(403|429|503)\b/.test(line));
  if (throttled) return throttled;
  if (result.timedOut) return 'pawchive の取り込みが無応答のまま打ち切られました';
  return errors[0] || '';
}

// 投稿の添付を種類ごとに仕分ける。一括更新と手動保存で判断がずれないよう、
// 「どれを綴じるか」の決まりはここ 1 箇所だけに持つ
function classifyFiles({ cover, attachments } = {}) {
  const usable = (attachments || []).filter((file) => !isSkipped(file));
  const images = dedupe(usable.filter(isImage));
  return {
    images,
    videos: dedupe(usable.filter(isVideo)),
    zips: dedupe(usable.filter(isZip)),
    // 表紙は本文の 1 枚目と重なることが多いので、本文があるときは載せない
    // (外部ツールの後処理も先頭 1 枚を落としていた)。本文が無いときの控え
    spareCover: !images.length && cover && isImage(cover) && !isSkipped(cover) ? cover : null,
  };
}

function retryable(error) {
  if (!error) return false;
  const status = Number(error.status);
  if (status === 429 || status === 408) return true;
  if (status >= 500) return true;
  // 状態を持たない失敗 = 接続や時間切れ。相手が混んでいるだけのことが多い
  return !Number.isFinite(status);
}

class PawBulk {
  constructor({ state, settings, listSources, adapter, engine, onProgress, delay } = {}) {
    this.state = state || null;
    this.settingsFn = typeof settings === 'function' ? settings : () => ({ ...(settings || {}) });
    this.listSources = typeof listSources === 'function' ? listSources : () => pawFavorites.list();
    this.adapter = adapter || pawchive.bulk;
    // 既定は皆で分け合う一本 (main が起動時に init する)。差せるようにしてあるのは
    // 単体テストで偽エンジンを入れるため
    this.engine = engine || sharedEngine;
    this.onProgress = onProgress || null;
    this.delay = Number.isFinite(delay) ? Number(delay) : REQUEST_DELAY;

    this.running = false;
    this.stopping = false;
    this.job = null;
    this.current = '';
    this.creatorsDone = 0;
    this.creatorsTotal = 0;
    this.postsDone = 0;
    this.postsFailed = 0;
    this.creatorsFailed = 0;
    this.error = '';
    this.names = new Map();
    this.queue = [];
    this.cursor = 0;
    this.nextAt = 0;
    this.lastNotify = 0;
  }

  status() {
    return {
      running: this.running,
      current: this.current,
      creatorsDone: this.creatorsDone,
      creatorsTotal: this.creatorsTotal,
      postsDone: this.postsDone,
      postsFailed: this.postsFailed,
      completed: this.state ? this.state.completedCount() : 0,
      error: this.error,
    };
  }

  notify(force = false) {
    if (!this.onProgress) return;
    const now = Date.now();
    if (!force && now - this.lastNotify < NOTIFY_INTERVAL) return;
    this.lastNotify = now;
    try {
      this.onProgress(this.status());
    } catch {
      // 受け手の失敗で取り込みは止めない
    }
  }

  readSettings() {
    let raw = {};
    try {
      raw = this.settingsFn() || {};
    } catch {
      raw = {};
    }
    const concurrency = Math.round(Number(raw.concurrency));
    return {
      dir: String(raw.dir || '').trim(),
      concurrency: Number.isFinite(concurrency) && concurrency > 0 ? Math.min(6, concurrency) : DEFAULT_CONCURRENCY,
    };
  }

  // API への当たりを均す。作者をまたいで 1 本の間隔にする:
  // 並列で走らせても相手から見た間隔は変わらない (429 を呼び込まないため)。
  // 均すのは一覧と投稿の照会だけ: 実体の取得はエンジンの中で一本に直列化される
  async gate() {
    const now = Date.now();
    const wait = Math.max(0, this.nextAt - now);
    this.nextAt = Math.max(now, this.nextAt) + this.delay;
    if (wait > 0) await sleep(wait);
  }

  // 429 や 5xx は相手の都合: 待ち直す。それでも駄目なら投げて、投稿ごと諦める
  async api(run) {
    let lastError = null;
    for (let attempt = 0; attempt <= RETRY_WAITS.length; attempt += 1) {
      await this.gate();
      if (this.stopping) throw new Error('stopped');
      try {
        return await run();
      } catch (error) {
        lastError = error;
        if (attempt >= RETRY_WAITS.length || !retryable(error)) throw error;
        await sleep(RETRY_WAITS[attempt]);
      }
    }
    throw lastError;
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
    if (!this.state) return this.status();
    const settings = this.readSettings();
    if (!settings.dir) {
      this.error = '出力先フォルダが未設定です';
      this.notify(true);
      return this.status();
    }
    // 同梱物 (Python + kemono-dl) が欠けていたら、この先は誰が相手でも何も
    // 落ちてこない。「出力先未設定」と同じで走り出す前に降りる: 作者ごとに
    // 同じ失敗を積んでも読み手の役に立たないし、一覧の照会だけ無駄に走る
    if (!this.engine.available()) {
      this.error = this.engine.runtimeError() || 'pawchive の取り込みエンジンが使えません';
      this.notify(true);
      return this.status();
    }

    // 旧台帳の引き継ぎは一度きり。まだなら最初の一括更新でここを通る
    try {
      this.state.importLegacy();
    } catch {
      // 引き継げなくても、これまでに溜めたぶんで走れる
    }

    let sources = [];
    try {
      sources = this.listSources() || [];
    } catch {
      sources = [];
    }

    this.queue = sources;
    this.cursor = 0;
    this.creatorsDone = 0;
    this.creatorsTotal = sources.length;
    this.postsDone = 0;
    this.postsFailed = 0;
    this.creatorsFailed = 0;
    this.current = '';
    this.error = '';
    this.stopping = false;
    this.nextAt = 0;
    this.lastNotify = 0;
    if (!this.creatorsTotal) return this.status();

    this.running = true;
    this.notify(true);
    try {
      // 作者名の索引。引けなくても取り込みは続ける (フォルダ名が id になるだけ)
      try {
        this.names = await this.api(() => this.adapter.creatorIndex());
      } catch {
        this.names = new Map();
      }

      const workers = Array.from(
        { length: Math.min(settings.concurrency, this.creatorsTotal) },
        () => this.worker(settings),
      );
      await Promise.all(workers);
    } finally {
      this.running = false;
      this.current = '';
      this.job = null;
      if (this.state.catalog && this.state.catalog.flushPersist) {
        try { this.state.catalog.flushPersist(); } catch { /* ignore */ }
      }
      this.notify(true);
    }
    return this.status();
  }

  async worker(settings) {
    while (!this.stopping && this.cursor < this.queue.length) {
      const source = this.queue[this.cursor];
      this.cursor += 1;
      try {
        await this.processCreator(source, settings);
      } catch (error) {
        // 1 人こけても全体は続ける。ただし「全員無事」ではなくなる
        this.creatorsFailed += 1;
        this.error = String((error && error.message) || error);
      }
      this.creatorsDone += 1;
      this.notify();
    }
  }

  async processCreator(source, settings) {
    const service = String(source.service || '');
    const user = String(source.user || '');
    if (!service || !user) return;
    const name = this.names.get(`${service}:${user}`) || user;
    const dir = path.join(settings.dir, sanitizeSegment(service, 40), creatorDirName(name, user));
    this.current = name;
    this.notify();

    // 相 1: 取りに行く投稿を数え上げる
    const fresh = await this.collectFresh(service, user);
    if (this.stopping || !fresh.length) return;

    // 相 2: 一件ずつ引き直して仕分ける (何を落とすかはここで決まる)
    const jobs = [];
    for (const item of fresh) {
      if (this.stopping) return;
      try {
        const job = await this.planPost(item);
        if (job) jobs.push(job);
      } catch (error) {
        // 印を付けずに次へ: 失敗した投稿は次の回にもう一度当たる
        this.postsFailed += 1;
        this.error = String((error && error.message) || error);
        if (this.state.markFailed) this.state.markFailed(item, error);
      }
      this.notify();
    }
    if (this.stopping || !jobs.length) return;

    // 相 3: 作者ぶんをまとめて 1 回のエンジンに投げる
    const staging = this.stagingDir(settings, service, user);
    const reason = await this.fetchAll(jobs, staging, name);

    // 相 4: 落ちてきた実体を作品の形に組み直す。
    // 止められた後もここは通す: 組み直しは網に触らない手元の処理で、既に揃って
    // いる投稿を本にして台帳に載せるだけ。ここで降りると、落とすところまで
    // 済んでいた投稿が一冊も残らず、次の回が同じ実体をもう一度組み直す羽目になる。
    // 降りるとしても投稿の境界だけ: 一冊の途中で抜けると半端な棚ができる
    for (const job of jobs) {
      try {
        if (await this.harvestPost(job, staging, dir)) {
          this.state.markCompleted(job.key);
          this.postsDone += 1;
        } else if (!this.stopping) {
          // 欠けたまま済にはしない: 次の回にもう一度当たる。
          // なぜ欠けたかは相 3 の言い分でしか分からないので、それを画面に残す
          this.postsFailed += 1;
          if (reason) this.error = reason;
          if (this.state.markFailed) this.state.markFailed(job, reason || 'required files missing');
        }
        // 止めたぶんの欠けは失敗ではない: 数えずに黙って残す
      } catch (error) {
        this.postsFailed += 1;
        this.error = String((error && error.message) || error);
        if (this.state.markFailed) this.state.markFailed(job, error);
      }
      this.notify();
    }
    // 空になっていれば箱ごと畳む。取りこぼしの残骸が居るなら残す:
    // kemono-dl は次の回にその続き (.part) から取る
    try { fs.rmdirSync(staging); } catch { /* まだ中身が居る = 次の回の資産 */ }
  }

  // 相 1: 済判定だけで新着を数え上げる。1 頁まるごと見覚えがあれば、その先は
  // 前に取ったぶん (一覧は新しい順) なので降りる。お気に入りに入れたばかりの
  // 作者は見覚えが無いまま最後まで降り続ける = 全部取る、で構わない
  async collectFresh(service, user) {
    // 前回失敗・中断した投稿は、新着一覧の打ち切り位置とは独立して先に積む。
    // これにより page 1 が全件 completed でも、page 2 以降の失敗を再試行できる。
    const fresh = this.state.listPending ? this.state.listPending(service, user) : [];
    const seen = new Set(fresh.map((item) => item.key));
    for (let page = 0; page < MAX_PAGES; page += 1) {
      if (this.stopping) return fresh;
      let rows;
      try {
        rows = await this.api(() => this.adapter.listPosts(service, user, page));
      } catch (error) {
        // 永続 pending の再試行は新着一覧の可用性にも依存させない。
        // pending が無い通常探索では従来どおり作者失敗として呼び手へ返す。
        if (fresh.length) return fresh;
        throw error;
      }
      if (!rows.length) return fresh;

      let found = 0;
      for (const row of rows) {
        if (this.stopping) return fresh;
        const key = `${service}:${user}:${row.id}`;
        if (this.state.hasCompleted(key)) continue;
        if (seen.has(key)) {
          found += 1;
          continue;
        }
        found += 1;
        const item = {
          service,
          user,
          key,
          id: String(row.id),
          // 日付の分からない投稿もある: 名前の頭は 0 で埋めて形だけ揃える
          date: toYmd(row.published || row.added) || '00000000',
        };
        fresh.push(item);
        seen.add(key);
        if (this.state.markPending) this.state.markPending(item);
      }
      if (!found) return fresh;
      if (rows.length < this.adapter.API_PAGE) return fresh;
    }
    return fresh;
  }

  // 相 2: 一覧の行は添付を省くことがあるので本体を引き直し、何を落とすかを決める。
  // ここで控えた hash が、後で staging の実体と添付を結ぶ
  async planPost({ service, user, id, key, date }) {
    const post = await this.api(() => this.adapter.fetchPost(service, user, id));
    const sorted = classifyFiles(this.adapter.postFiles(post));
    const spareCover = sorted.spareCover;
    // zip は常に取りに行く。zip 配布だけの作者 (サムネ 1 枚 + 本編 zip) は
    // 設定が切だと「表紙 1 枚の本」しか残らず、中身が丸ごと落ちていた
    const zips = sorted.zips;

    if (!sorted.images.length && !spareCover && !sorted.videos.length && !zips.length) {
      // 何も落ちてこない投稿 (本文だけ) も済にする: 毎回引き直さない
      this.state.markCompleted(key);
      this.postsDone += 1;
      return null;
    }

    const mark = (files) => files.map((file) => ({ file, hash: fileHash(file) }));
    const job = {
      service,
      user,
      id,
      key,
      date,
      title: post && post.title,
      images: mark(sorted.images),
      cover: spareCover ? { file: spareCover, hash: fileHash(spareCover) } : null,
      videos: mark(sorted.videos),
      zips: mark(zips),
    };
    // 揃い判定の必須集合。表紙 (cover) はここに入れない: 表紙は投稿の本文ではなく
    // 一覧用の一枚で、エンジンが落としてこないことがある。必須にすると本文も動画も
    // 揃っているのに永久に済にならない投稿ができるので、「あれば使う」に留める
    job.wanted = [...job.images, ...job.videos, ...job.zips];
    // 落ちてきた実体を添付に結び直せるのは hash だけ。読めない添付が混じる投稿は
    // 組みようが無いので、済にせず失敗に数えて飛ばす (API の形が変わった合図)
    if ([...job.wanted, ...(job.cover ? [job.cover] : [])].some((item) => !item.hash)) {
      throw new Error(`添付の見分けが付きません (${key})`);
    }
    return job;
  }

  // 取り込み中の実体の置き場。作者ごとに 1 箱
  stagingDir(settings, service, user) {
    return path.join(
      settings.dir,
      STAGING_DIR,
      `bulk-${sanitizeSegment(service, 40)}-${sanitizeSegment(user, 60)}`,
    );
  }

  // 相 3: 作者ぶんを 1 回のエンジンに投げる。成否はこの戻り値では決めない:
  // kemono-dl は一部の失敗を 0 で返すので、何が取れたかは相 4 が実体を見て決める。
  // 返すのは「何が起きたか」の一行 (相 4 が欠けを数えるときの言い分になる)
  async fetchAll(jobs, staging, name) {
    fs.mkdirSync(staging, { recursive: true });
    // ブラウザ拡張が書き出したクッキーが Downloads に落ちていたら先に引き上げる:
    // 無認証だと数枚で 403 に切り替わる
    let cookieFile = '';
    try {
      pawCookies.adoptDownloadedCookies();
      cookieFile = pawCookies.status().file;
    } catch {
      // クッキーが無くても取りには行ける (途中で断られるだけ)
      cookieFile = '';
    }

    // zip も常に頼む。落ちてきてから中身を見て、絵だけなら綴じ・そうでなければ
    // 書庫のまま置く (paw-zip-pdf)。取りに行かなければその判断すらできない
    const types = [...IMAGE_TYPES, ...VIDEO_TYPES, 'zip'];
    const result = await this.engine.run({
      links: jobs.map((job) => pawchive.buildPostUrl(job.service, job.user, job.id)),
      outDir: staging,
      filenamePattern: FILENAME_PATTERN,
      cookieFile,
      onlyFiletypes: types,
      onEvent: (event) => {
        if (event.type === 'post-start') {
          if (event.title) this.current = `${name} / ${event.title}`;
          this.notify();
          return;
        }
        // 1 ファイル動くたびに知らせる (notify 側が NOTIFY_INTERVAL で間引く)
        if (event.type.startsWith('file-')) this.notify();
      },
      isCancelled: () => this.stopping,
    });

    // 止めたぶんは失敗ではない: 何も言わずに降りる
    if (this.stopping) return '';
    // 断られた行 (403/429/503)・致命死・無応答は、そのまま画面に出す言い分になる。
    // ここで拾わないと、欠けた投稿が「失敗 1 件」とだけ数えられて理由が消える
    const reason = engineReason(result);
    if (reason) this.error = reason;
    return reason;
  }

  // 相 4: staging に落ちた実体を hash で突き合わせ、作品の形に組み直す。
  // 欲しいものが 1 つでも欠けていたら何も作らずに false を返す: 半端な PDF を
  // 出すより、残骸を置いたまま次の回に取り直す方が確か。
  // 一度始めたら投稿ぶんは最後まで通す (途中で降りると半端な棚ができる)
  async harvestPost(job, staging, dir) {
    const postDir = path.join(staging, job.id);
    const staged = collectStaged(postDir);
    // 途中で切れた実体 (416) は「落ちた」ではなく「欠け」。欠片を捨てて次の回に
    // 取り直させる: 綴じてしまうと半分だけの絵が本になって台帳にも載る
    const usable = (hash) => {
      const hit = staged.get(hash);
      if (!hit) return null;
      if (!hit.broken) return hit.file;
      try { fs.rmSync(hit.file, { force: true }); } catch { /* 消せなくても欠け扱いは変わらない */ }
      return null;
    };
    // 表紙は必須ではない (あれば使う): 揃い判定は job.wanted だけで決まる
    const cover = job.cover ? usable(job.cover.hash) : null;
    // some ではなく filter: 途中で打ち切ると、後ろに並んだ欠片が捨てられずに残る
    if (job.wanted.filter((item) => !usable(item.hash)).length) return false;

    fs.mkdirSync(dir, { recursive: true });
    // zip は開けてみるまで PDF になるか分からない。表紙を出すかどうかがそれで決まるので
    // 先に片付ける。zip に添える作品名は本文の枚数だけで決める (表紙の有無に振らせない)
    const zipBase = workName(job.date, job.id, job.title, job.images.length);
    let zipMadePdf = false;
    for (const zip of job.zips) {
      const made = await this.writeZip(usable(zip.hash), zip.file, dir, zipBase);
      if (made.pdf) zipMadePdf = true;
    }

    // zip が中身を 1 冊にまとめたなら、それがその投稿の本体。
    // 表紙 1 枚だけの PDF を隣に並べても雑音にしかならないので出さない。
    // 書庫のまま置いたとき (中身に絵が 1 枚も無かった) は、表紙が見出し代わりに要る
    const pages = job.images.length
      ? job.images.map((item) => usable(item.hash))
      : (cover && !zipMadePdf ? [cover] : []);
    const base = workName(job.date, job.id, job.title, pages.length);
    if (pages.length) {
      await this.writePdf(pages, dir, base, job.key);
    }
    for (const video of job.videos) {
      copyInto(usable(video.hash), attachmentPath(video.file, dir, base));
    }
    // 組み終わった投稿の実体はもう要らない (写しの原本もここで片付く)
    fs.rmSync(postDir, { recursive: true, force: true });
    return true;
  }

  // 落ちてきた画像を作業フォルダへ写してから PDF に綴じる。写すのは 2 つの都合:
  // pdf-builder が「同じフォルダの相対 src」で頁を組むこと、そして綴じ順を
  // 通し番号の名前で固定して取り違えを防ぐこと。原本 (staging) は動かさない:
  // 途中で転んでも次の回にそのまま組み直せる
  async writePdf(sources, dir, base, key) {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pawbulk-'));
    try {
      const pages = [];
      for (let index = 0; index < sources.length; index += 1) {
        const source = sources[index];
        const ext = path.extname(source) || '.jpg';
        const target = path.join(workDir, `${String(index).padStart(4, '0')}${ext}`);
        fs.copyFileSync(source, target);
        const size = imageSize(fs.readFileSync(target)) || {};
        pages.push({ file: target, width: size.width || null, height: size.height || null });
      }
      // buildPdf は .part に書いてから rename する: 途中で落ちても半端な PDF は残らない。
      // 頁が一枚でも開けなかったら投げる: この先で postDir (原本) を消すため
      ensureComplete(await buildPdf({ pages, dest: path.join(dir, `${base}.pdf`) }), 'PDF 生成');
    } catch (error) {
      throw new Error(`PDF 生成に失敗しました (${key}): ${(error && error.message) || error}`);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }

  // zip は中身を見てから置き場所を決める。判断そのものは手動保存と共有の
  // paw-zip-pdf が握るので、ここは仕事の語彙 (添付と作品名) を茎に直すだけ
  async writeZip(source, file, dir, base) {
    return convertZip({ zipPath: source, destDir: dir, stem: attachmentStem(file, base) });
  }
}

module.exports = {
  PawBulk,
  workName,
  creatorDirName,
  sanitizeSegment,
  attachmentStem,
  classifyFiles,
  toYmd,
};
