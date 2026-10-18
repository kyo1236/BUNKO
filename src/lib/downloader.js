const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { finished } = require('stream/promises');
const yazl = require('yazl');
const { getGallery, fetchImage, sanitizeName, parseId } = require('./sources');
const { buildPdf } = require('./pdf-builder');
const { ensureComplete } = require('./pdf-report');
const { imageSize } = require('./image-size');
const pawCookies = require('./paw-cookies');
// 置き場の見立て (hash の読み方・落ち切った実体の拾い方) は取り込みエンジン側に
// 一本だけ持たせる。こちらで同じ規則を書き直すと、片方だけ直したときに
// 「エンジンは落としたのに綴じ手は見つけられない」という食い違いが生まれる
const {
  engine: kemonoEngine, collectStaged, fileHashOf, IMAGE_TYPES,
} = require('./kemono-engine');
// zip の開け方と「作品名+元ファイル名」の綴りは一括更新と共有する。同じ投稿を
// 保存と一括更新の二つの道で通しても、同じ名前の同じ中身が出来上がるように
const { convertZip } = require('./paw-zip-pdf');
const { attachmentStem } = require('./paw-bulk');

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimit(error) {
  if (!error) return false;
  // http.js が印を付けて返す (冷却中の順番待ちで期限切れになった回を含む)。
  // これが無いと、相手が言ってきた待ち時間が退き幅に届かない (項目 7-5)
  if (error.throttled === true) return true;
  if (error.status === 503 || error.status === 429) return true;
  return /\b(503|429)\b/.test(error.message || '');
}

// 取り消しに気付けるよう小刻みに待つ
async function waitFor(ms, isCancelled) {
  let rest = ms;
  while (rest > 0) {
    if (isCancelled && isCancelled()) return;
    const span = Math.min(250, rest);
    await sleep(span);
    rest -= span;
  }
}

// 待つあいだは同時取得の枠を返す。抱えたまま眠ると他の頁まで止まる
async function backoff(ms, gate, isCancelled) {
  if (!gate) {
    await waitFor(ms, isCancelled);
    return;
  }
  gate.release();
  try {
    await waitFor(ms, isCancelled);
  } finally {
    await gate.acquire();
  }
}

// gate を渡された場合、この関数は「枠を持ったまま入って持ったまま出る」約束を守る
// (待ちのあいだだけ手放す): 呼ぶ側は今までどおり自分で acquire / release すればよい
async function fetchWithRetry(galleryId, index, { tries = 5, gate = null, isCancelled = null } = {}) {
  let lastError;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      if (isCancelled && isCancelled()) throw lastError || new Error('cancelled');
      return await fetchImage(galleryId, index, { size: 'full' });
    } catch (error) {
      lastError = error;
      if (isCancelled && isCancelled()) throw lastError;
      // レート制限は長めの指数バックオフ、それ以外は短い線形リトライ。
      // (2026-08-31 に pawchive の 403 向けに「一度だけ引き直して諦める」へ変えたが、
      // ここは hitomi など画像を頁ごとに引く口だけが通る。pawchive の保存は
      // kemono-dl 経由になったので、2026-09-07 に以前の粘り方へ戻した)
      const wait = isRateLimit(error) ? 2500 * (attempt + 1) + Math.random() * 800 : 500 * (attempt + 1);
      await backoff(wait, gate, isCancelled);
      if (isCancelled && isCancelled()) throw lastError;
    }
  }
  // 粗い絵で代えることはしない (画質優先。2026-08-31 利用者指定)
  throw lastError;
}

class Gate {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.waiters = [];
  }

  setLimit(limit) {
    this.limit = Math.max(1, Number(limit) || this.limit);
    this.pump();
  }

  async acquire() {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise((resolve) => this.waiters.push(resolve));
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    this.pump();
  }

  pump() {
    while (this.active < this.limit && this.waiters.length) {
      const next = this.waiters.shift();
      // 起こした時点で枠を予約する。待機側が再開するまで active を増やさないと、
      // 同じ tick で全待機者を通して上限を越えてしまう。
      this.active += 1;
      next();
    }
  }
}

function uniqueName(dir, title, ext) {
  const base = sanitizeName(title);
  let dest = path.join(dir, `${base}${ext}`);
  let index = 2;
  while (fs.existsSync(dest) || fs.existsSync(`${dest}.part`)) {
    dest = path.join(dir, `${base} (${index})${ext}`);
    index += 1;
  }
  return dest;
}

// 作業用ファイルの拡張子。中身と食い違っていても Chromium は中身で判断するが、
// 素性の分かる名前にしておく (hitomi は webp/avif/jxl、pawchive は jpeg/png)
function imageExt(type) {
  const text = String(type || '');
  if (text.includes('avif')) return '.avif';
  if (text.includes('jxl')) return '.jxl';
  if (text.includes('jpeg') || text.includes('jpg')) return '.jpg';
  if (text.includes('png')) return '.png';
  if (text.includes('gif')) return '.gif';
  return '.webp';
}

function normalizeFormat(value) {
  return value === 'raw' || value === 'pdf' ? value : 'zip';
}

// 取り込み済みの頁を試行をまたいで持ち越す置き場。先頭のドットで catalog のスキャンから外れる。
// これが無いと、48 頁の 40 頁目で断られたジョブが次の試行で 48 頁を丸ごと取り直す:
// 相手から見た通信量が試行のたびに積み上がり、流量制限をこちらから悪化させることになる
function pageCacheDir(job) {
  const safe = String(job.id).replace(/[<>:"/\\|?*]/g, '_');
  return path.join(job.downloadDir, `.resume-${safe}`);
}

// 前の試行が残した頁を拾う。取りに行く番号 → 実体。壊れた欠片は読まない (取り直しに回す)
function loadPageCache(dir) {
  const map = new Map();
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return map;
  }
  for (const name of names) {
    const hit = name.match(/^(\d{4})(\.[A-Za-z0-9]+)$/);
    if (!hit) continue;
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).size > 0) map.set(Number(hit[1]), { file, ext: hit[2] });
    } catch {
      // 読めない欠片は無かったことにする
    }
  }
  return map;
}

// 開けなかった頁の控えだけ捨てる。控えは size > 0 しか見ないので、壊れたバイトが
// 一度入ると積み直しても同じ物が配られ、綴じ直すだけの空回りになる。
// 触るのは .resume-<id>/ の直下だけ (出力先そのものは決して舐めない)
function dropPageCache(dir, indices) {
  const heads = (indices || []).map((index) => `${String(index).padStart(4, '0')}.`);
  if (!heads.length) return;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!heads.some((head) => name.startsWith(head))) continue;
    try { fs.unlinkSync(path.join(dir, name)); } catch { /* ignore */ }
  }
}

// 書き終える前に落ちても半端な欠片を残さないよう、別名で書いてから据える
function savePageCache(dir, index, ext, buffer) {
  const name = `${String(index).padStart(4, '0')}${ext}`;
  const tmp = path.join(dir, `${name}.tmp`);
  try {
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, path.join(dir, name));
  } catch {
    // 持ち越しに失敗しても本筋は進む (次の試行で取り直すだけ)
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
}

// 進み具合の当て。書き途中の .part も足す (画面の速さは bytes の差分で出るので、
// 一枚落ち切るまで 0 のままだと止まって見える)
function stagingBytes(dir) {
  let total = 0;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    try {
      const stat = fs.statSync(path.join(dir, name));
      if (stat.isFile()) total += stat.size;
    } catch {
      // 数え落としても進みの見せ方が少し粗くなるだけ
    }
  }
  return total;
}

// 取れなかったときの言い分。積み直しの退き幅は文言に 403/429/503 が残るかで
// 決まる (scheduleRetry) ので、致命死でなければ流量で断られた行を先に立てる
function pawFailureReason(result, missing) {
  // 致命死 (エンジンが途中で倒れた) は個々の取りこぼしより先に立てる:
  // 一枚の 403 を見せても、実際には全部が落ちていない場面がある
  if (result?.failure) return String(result.failure);
  const errors = Array.isArray(result?.errors) ? result.errors : [];
  const throttled = errors.find((line) => /\b(403|429|503)\b/.test(line));
  if (throttled) return throttled;
  if (result?.spawnError) return `取り込みエンジンを起こせませんでした: ${result.spawnError.message || result.spawnError}`;
  if (result?.timedOut) return '取り込みエンジンが黙り込んだため打ち切りました';
  return errors[0] || `${missing} 枚取得できませんでした`;
}

function createZipSink(job, infoBuffer) {
  const dest = uniqueName(job.downloadDir, job.title, '.zip');
  const partPath = `${dest}.part`;
  job.dest = dest;

  const zipfile = new yazl.ZipFile();
  const output = fs.createWriteStream(partPath);
  const doneWriting = finished(output);
  zipfile.outputStream.pipe(output);
  zipfile.addBuffer(infoBuffer, 'info.json');

  let closing = null;
  const close = () => {
    if (!closing) {
      zipfile.end();
      closing = doneWriting;
    }
    return closing;
  };

  return {
    addImage(index, name, buffer) {
      zipfile.addBuffer(buffer, name);
    },
    async commit() {
      await close();
      fs.renameSync(partPath, dest);
    },
    async abort() {
      try { await close(); } catch { /* 書き込みに失敗しても .part は消す */ }
      if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
    },
  };
}

function createRawSink(job, infoBuffer) {
  const dir = uniqueName(job.downloadDir, job.title, '');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'info.json'), infoBuffer);
  job.dest = dir;

  return {
    async addImage(index, name, buffer) {
      await fs.promises.writeFile(path.join(dir, name), buffer);
    },
    async commit() {},
    async abort() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// 取り込みで綴じる前の原寸のバイトを覗く口 (pixiv の AI 作品の生成情報を表へ。main.js が結ぶ)。
// pdf-write は RGB の PNG を IDAT だけ据えるので文字チャンクは PDF に残らない: ここで読むのが唯一の機会
let pageBytesHook = null;
function setPageBytesHook(fn) { pageBytesHook = typeof fn === 'function' ? fn : null; }

function createPdfSink(job, gallery) {
  // 行き先が決まっているジョブ (pawchive の一括更新と同じ棚に置くもの) は
  // その名前をそのまま使い、同名は上書きする。一括更新の走りと同じ振る舞い
  const dest = job.destPath || uniqueName(job.downloadDir, job.title, '.pdf');
  const partPath = `${dest}.part`;
  // 先頭のドットで catalog のスキャン対象から外れる
  const workDir = path.join(job.downloadDir, `.part-${String(job.id).replace(/[<>:"/\\|?*]/g, '_')}`);
  // 中断したジョブの残骸が混ざらないよう作り直す
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  job.dest = dest;

  const pages = [];

  return {
    async addImage(index, name, buffer) {
      const file = path.join(workDir, name);
      await fs.promises.writeFile(file, buffer);
      if (pageBytesHook) { try { pageBytesHook(job, gallery, index, buffer); } catch { /* 覗きの失敗で綴じを止めない */ } }
      // 実寸はバイト列から測る。どのサイトも一覧・詳細の JSON に寸法を載せてこないので、
      // 測らないと pdf-builder の既定 (A4 相当) に引き伸ばされて絵が歪む
      const measured = imageSize(buffer);
      pages[index] = {
        file,
        width: measured?.width || gallery.files?.[index]?.width || null,
        height: measured?.height || gallery.files?.[index]?.height || null,
      };
    },
    async commit() {
      try {
        const report = await buildPdf({ pages: pages.filter(Boolean), dest });
        // 白紙の頁を含む PDF を「完成」にしない。pdf-builder は開けない頁が
        // あるうちは dest に据えないので、ここで止めても棚に半端な本は出ない
        ensureComplete(report, 'PDF 生成');
      } catch (error) {
        // 開けなかった頁の控えを捨ててから投げる。残したまま積み直すと、
        // 同じ壊れた欠片を綴じ直すだけで何度やっても同じ所で倒れる
        if (error.incompletePdf) dropPageCache(pageCacheDir(job), error.failedPages);
        const wrapped = new Error(`PDF 生成に失敗しました: ${error.message || error}`);
        wrapped.incompletePdf = !!error.incompletePdf;
        throw wrapped;
      }
      fs.rmSync(workDir, { recursive: true, force: true });
    },
    async abort() {
      fs.rmSync(workDir, { recursive: true, force: true });
      if (fs.existsSync(partPath)) {
        try { fs.unlinkSync(partPath); } catch { /* ignore */ }
      }
    },
  };
}

function createSink(job, gallery, infoBuffer) {
  if (job.format === 'raw') return createRawSink(job, infoBuffer);
  if (job.format === 'pdf') return createPdfSink(job, gallery);
  return createZipSink(job, infoBuffer);
}

class Downloader extends EventEmitter {
  constructor() {
    super();
    this.jobs = new Map();
    this.activeGalleries = 0;
    // 走っている pawchive の本数。この置き場だけは一冊ずつに絞る (下の pump)
    this.activePaw = 0;
    this.maxGalleries = 8;
    this.concurrency = 4;
    this.queue = [];
    this.fetchGate = new Gate(8);
    this.onComplete = null;
    this.updateTimer = null;
    this.normalLimit = 8;
    this.interactive = false;
    this.persistPath = '';
    this.retryTimers = new Map();
    // 行き先を差し替える口。pawchive の保存だけ一括更新と同じ棚に落とすために使う。
    // ここは素の入れ物のまま: 設定も台帳も知らせない (呼ぶ側が組み立てて渡す)
    this.route = null;
  }

  setRoute(route) {
    this.route = typeof route === 'function' ? route : null;
  }

  init(persistPath) {
    this.persistPath = persistPath;
    this.restore();
  }

  persist() {
    if (!this.persistPath) return;
    const jobs = this.snapshot()
      .filter((job) => ['queued', 'running', 'error', 'importing', 'asking'].includes(job.status))
      .map((job) => ({
        id: job.id,
        title: job.title,
        downloadDir: job.downloadDir,
        format: job.format,
        attempts: job.attempts || 0,
        status: job.status === 'running' ? 'queued' : job.status,
        error: job.status === 'error' ? job.error || '' : '',
        failedPages: job.status === 'error' ? job.failedPages || [] : [],
        // 落ちかけの置き場は次の走りの資産であると同時に、畳み忘れると
        // 出力先に残り続ける孤児になる。誰の置き場かを覚えていないと、
        // 一覧から消すときにも取り消すときにも畳めない
        stagingDir: job.stagingDir || '',
        pawKey: job.pawKey || '',
        destPath: job.destPath || '',
      }));
    try {
      // 素の上書きだと書き込み中のクラッシュでキューが全損する
      require('./atomic-file').writeFileAtomicSync(this.persistPath, JSON.stringify(jobs));
    } catch {
      // ignore
    }
  }

  restore() {
    if (!this.persistPath || !fs.existsSync(this.persistPath)) return;
    let rows = [];
    try {
      rows = JSON.parse(fs.readFileSync(this.persistPath, 'utf8'));
    } catch {
      return;
    }
    for (const row of rows) {
      if (!row?.id || !row.downloadDir) continue;
      const args = { id: row.id, downloadDir: row.downloadDir, format: row.format };
      // 失敗したまま終わったジョブは失敗のまま戻す (勝手に再開させない)。
      // Eagle へ入れている最中だった物も落とし直さない (取り込みの待ち行列が続きを持つ)
      const held = row.status === 'error' || row.status === 'importing' || row.status === 'asking';
      const job = held ? this.createJob(args) : this.enqueue(args);
      if (row.status === 'importing' || row.status === 'asking') job.status = row.status;
      job.attempts = Number(row.attempts) || 0;
      job.title = row.title || job.title;
      // 落ちかけの置き場を詰め直す。ここを空のまま戻すと、前の起動が残した
      // staging が誰のものでもなくなって出力先に居座る
      job.stagingDir = row.stagingDir || '';
      job.pawKey = row.pawKey || '';
      job.destPath = row.destPath || '';
      if (row.status === 'error') {
        job.status = 'error';
        job.error = row.error || '';
        job.failedPages = Array.isArray(row.failedPages) ? row.failedPages : [];
        job.finishedAt = Date.now();
      }
    }
    this.emitUpdate(true);
  }

  snapshot() {
    return [...this.jobs.values()].map((job) => ({ ...job }));
  }

  emitUpdate(force = false) {
    if (force) {
      if (this.updateTimer) {
        clearTimeout(this.updateTimer);
        this.updateTimer = null;
      }
      this.emit('update', this.snapshot());
      this.persist();
      return;
    }
    if (this.updateTimer) return;
    this.updateTimer = setTimeout(() => {
      this.updateTimer = null;
      this.emit('update', this.snapshot());
    }, 100);
  }

  setLimits({ concurrency, maxGalleries } = {}) {
    if (concurrency) this.concurrency = Math.max(1, Math.min(16, Number(concurrency)));
    if (maxGalleries) this.maxGalleries = Math.max(1, Math.min(16, Number(maxGalleries)));
    // hitomi 側のレート制限(503)を避けるため全体の同時取得は控えめに保つ
    this.normalLimit = Math.max(4, Math.min(10, this.maxGalleries * 2));
    this.fetchGate.setLimit(this.interactive ? 3 : this.normalLimit);
    this.pump();
  }

  setInteractive(active) {
    this.interactive = Boolean(active);
    this.fetchGate.setLimit(this.interactive ? 3 : this.normalLimit);
  }

  createJob({ id, title, downloadDir, format }) {
    const jobId = String(id);
    const job = {
      id: jobId,
      // 画面が題を知っていれば最初からそれを出す。無ければメタ取得後に入れ替わる
      title: String(title || '').trim() || `#${id}`,
      dest: '',
      status: 'queued',
      done: 0,
      total: 0,
      bytes: 0,
      failed: 0,
      failedPages: [],
      error: '',
      startedAt: 0,
      finishedAt: 0,
      downloadDir,
      format: normalizeFormat(format),
      attempts: 0,
      // 直前の走りで新しく取れた頁の数 (再試行を続けるかの目安。持ち越さない)
      gained: 0,
    };
    this.jobs.set(jobId, job);
    return job;
  }

  // 走っている最中の job を書き換える口 (pixiv の取り込みが status や eagleItemId を入れる)
  patchJob(id, patch) {
    const job = this.jobs.get(String(id));
    if (!job) return false;
    Object.assign(job, patch || {});
    this.emitUpdate(true);
    this.persist();
    return true;
  }

  enqueue({ id, title, downloadDir, format }) {
    const jobId = String(id);
    const existing = this.jobs.get(jobId);
    // Eagle へ入れている最中 (importing / asking) も走っている内: 二重に落とさない
    if (existing && ['queued', 'running', 'importing', 'asking'].includes(existing.status)) {
      return existing;
    }

    const job = this.createJob({ id, title, downloadDir, format });
    this.queue.push(jobId);
    this.emitUpdate(true);
    this.persist();
    this.pump();
    return job;
  }

  // 走りをまたぐ置き土産を畳む。取れた頁を捨てるので、成功・取り消し・後片付けの
  // ときだけ呼ぶ。頁の控え (.resume-*) も pawchive の staging (.kemono-staging\dl-*) も
  // 「次の走りのための資産」なので、消してよい場面は同じ
  dropScratch(job) {
    try {
      fs.rmSync(pageCacheDir(job), { recursive: true, force: true });
    } catch {
      // 消せなくても実害は無い (次の走りが同じ頁を読み直すだけ)
    }
    if (!job.stagingDir) return;
    try {
      fs.rmSync(job.stagingDir, { recursive: true, force: true });
    } catch {
      // 同上 (次の走りが同じ置き場を使い回す)
    }
  }

  scheduleRetry(job) {
    if (job.cancelled) {
      job.status = 'cancelled';
      return;
    }
    // 相手の窓が分単位で閉じるので、大きな作品は何度かに分けてしか落とせない。
    // 頁を積めた走りは「空振り」と数えない: 前へ進んでいる限り続けさせる
    // (一頁も積めなかった走りだけを数えるので、本当に詰まった仕事は 4 回で止まる)
    job.attempts = job.gained > 0 ? 0 : (job.attempts || 0) + 1;
    job.gained = 0;
    // 流量で断られているだけなら、待てばフル画質で取れる。控えがあるので
    // 待った時間は無駄にならない: 画質優先の指定に合わせて長めに粘る。
    // 分単位の窓は pawchive の実測から決めた値なので pawchive にだけ効かせる。
    // hitomi などは以前どおり秒単位で叩き直す (2026-09-07)
    // pixiv も同じ (作法が 200 秒の冷却に入ると 429 を即返す。秒で叩き直しても空振り)
    const slowSite = ['pawchive', 'pixiv'].includes(parseId(job.id).source);
    const throttled = slowSite && /\b(403|429|503)\b/.test(job.error || '');
    if (job.attempts >= (throttled ? 6 : 4)) {
      job.status = 'error';
      job.finishedAt = Date.now();
      this.emitUpdate(true);
      this.persist();
      return;
    }
    job.status = 'queued';
    job.failed = 0;
    job.failedPages = [];
    // 取れた頁は控えに残っているので、積み直しても取り直すのは断られた頁だけ
    job.done = 0;
    job.bytes = 0;
    // 相手が流量で断っているときの窓は分単位 (403 が 6 分以上続くのを実測した)。
    // 秒で叩き直しても窓の中で空振りするだけなので、退く幅を窓に合わせる。
    // それ以外の失敗 (瞬断など) は今までどおりすぐ引き直す
    // 空振りが続くほど長く退く。頁を積めた走り (attempts = 0) でも先頭の幅は必ず置く:
    // ここを 0 にすると窓が閉じたまま即座に叩き直すことになる
    const waits = throttled ? [60000, 300000, 900000, 1800000] : [2500, 5000, 7500];
    const delay = waits[Math.max(0, Math.min(job.attempts, waits.length - 1))];
    const timer = setTimeout(() => {
      this.retryTimers.delete(job.id);
      if (job.cancelled || job.status === 'running') return;
      if (!this.queue.includes(job.id)) this.queue.push(job.id);
      this.pump();
    }, delay);
    this.retryTimers.set(job.id, timer);
    this.emitUpdate(true);
    this.persist();
  }

  // 失敗したジョブを手で積み直す。自動リトライの回数はここで帳消しにする
  retry(id) {
    const job = this.jobs.get(String(id));
    if (!job || job.status !== 'error') return;
    // 取り込み (Eagle に入れる段) で転んだ物は落とし直さず、入れ直すだけ
    if (typeof this.onImportRetry === 'function' && this.onImportRetry(job.id)) return;
    job.cancelled = false;
    job.attempts = 0;
    job.error = '';
    job.done = 0;
    job.bytes = 0;
    job.failed = 0;
    job.failedPages = [];
    job.finishedAt = 0;
    job.status = 'queued';
    if (!this.queue.includes(job.id)) this.queue.push(job.id);
    this.emitUpdate(true);
    this.persist();
    this.pump();
  }

  cancel(id) {
    const job = this.jobs.get(String(id));
    if (!job) return;
    job.cancelled = true;
    const timer = this.retryTimers.get(String(id));
    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(String(id));
    }
    if (job.status === 'queued') {
      this.queue = this.queue.filter((item) => item !== String(id));
      job.status = 'cancelled';
      // まだ走り出していないぶんはここでしか畳めない (走っていれば run 側が畳む)
      this.dropScratch(job);
    }
    this.emitUpdate(true);
    this.persist();
  }

  clearFinished() {
    for (const [id, job] of this.jobs) {
      if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') {
        // 再試行待ちのタイマーも一緒に下ろす (発火しても幽霊 id が積まれるだけだが)
        const timer = this.retryTimers.get(id);
        if (timer) {
          clearTimeout(timer);
          this.retryTimers.delete(id);
        }
        // 諦めたジョブの控えはここで畳む: 一覧から消えたら手で積み直す道も消える
        this.dropScratch(job);
        this.jobs.delete(id);
      }
    }
    this.emitUpdate(true);
    this.persist();
    return this.snapshot();
  }

  pump() {
    // 順番待ちに戻す組。while の中で queue に積み直すと同じ id を掴み続ける
    const deferred = [];
    while (this.activeGalleries < this.maxGalleries && this.queue.length) {
      const id = this.queue.shift();
      // pawchive は一冊ずつ。取り込みエンジンはモジュールに一本の列で直列化される
      // ので、二冊目以降は枠を握ったまま順番待ちに入る = その間 hitomi が飢える。
      // 走らせないと決めたぶんは枠に触れずに退かせる
      if (parseId(id).source === 'pawchive' && this.activePaw > 0) {
        deferred.push(id);
        continue;
      }
      this.run(id).catch((error) => {
        const job = this.jobs.get(id);
        if (job) {
          job.error = error.message || String(error);
          this.scheduleRetry(job);
        }
      });
    }
    if (deferred.length) this.queue.unshift(...deferred);
  }

  async run(id) {
    const job = this.jobs.get(id);
    if (!job || job.cancelled) return;

    const paw = parseId(id).source === 'pawchive';
    if (paw) this.activePaw += 1;
    this.activeGalleries += 1;
    job.status = 'running';
    job.startedAt = Date.now();
    this.emitUpdate(true);

    let sink = null;
    try {
      const gallery = await getGallery(id);
      job.title = gallery.title || String(id);

      // 行き先の差し替えが効くジョブは、綴じる中身もその指示に従う
      // (pawchive なら表紙を落とした本文だけ = 一括更新と同じ中身)
      let plan = null;
      let routeError = null;
      if (this.route) {
        try {
          plan = await this.route(id, gallery);
        } catch (error) {
          routeError = error;
          plan = null;
        }
      }
      if (plan) {
        // 行き先の決まった仕事 (pawchive) は丸ごと外部エンジンに任せる。
        // 頁を一枚ずつ拾う下のループには入らない
        await this.runPawEngine(job, gallery, plan);
        return;
      }
      if (parseId(id).source === 'pawchive') {
        // 行き先の決まらない pawchive を API 直取りへ落とさない。素のまま取りに
        // 行くと数枚で断たれるうえ、落とし先も名前も一括更新と食い違う。
        if (routeError) {
          // 行き先を決める途中で転んだだけ (投稿の引き直しが 403/429/503 など) なら
          // 一過性: 待てば決まる。文言はそのまま残す (退き幅の判断がこの語で効く)
          job.error = routeError.message || String(routeError);
          this.scheduleRetry(job);
          return;
        }
        // route が意図して断った (出力先が未設定・置くものが無い) 場合だけ即座に止める:
        // 積み直しても設定は変わらないので、待たせずに理由を見せる
        job.error = 'pawchive の保存先を決められませんでした (一括更新の出力先が未設定か、保存できる中身がありません)';
        job.status = 'error';
        job.finishedAt = Date.now();
        return;
      }
      // 前の走りで差し替わっていた名残を残さない
      job.destPath = '';
      job.pawKey = '';
      job.stagingDir = '';
      if (parseId(id).source === 'pixiv') {
        // うごイラと作者の札は本にしない (要件 D4)
        if (gallery.unbindable || gallery.kind === 'creator') {
          job.error = gallery.kind === 'creator' ? '作者の札は落とせません (作品一覧から選んでください)' : 'うごイラは本にしません';
          job.status = 'error';
          job.finishedAt = Date.now();
          return;
        }
        // 一時置き場は job ごと (同じ題が衝突しない・頁の控えも中)。落とし終えたら
        // 取り込み (importer) が Eagle API で入れて丸ごと消す (docs/pixiv-design §5, §15 E3)。
        // 単頁は絵のまま、複数頁は PDF に綴じる (要件 D5)
        const key = String(parseId(id).key).replace(/[^0-9]/g, '') || 'x';
        job.downloadDir = path.join(this.pixivStaging || job.downloadDir, `px-${key}`);
        job.format = (Number(gallery.pageCount) || 0) <= 1 ? 'raw' : 'pdf';
      }
      job.total = gallery.pageCount || gallery.files?.length || 0;

      fs.mkdirSync(job.downloadDir, { recursive: true });

      const infoBuffer = Buffer.from(JSON.stringify({
        id: gallery.id,
        source: gallery.source || parseId(id).source,
        title: job.title,
        type: gallery.type,
        language: gallery.language?.name || null,
        artists: (gallery.artists || []).map((item) => item.name || item),
        groups: (gallery.groups || []).map((item) => item.name || item),
        // pixiv has one series object; other sources supply an array of parody tags.
        series: (Array.isArray(gallery.series) ? gallery.series : gallery.series?.title ? [gallery.series.title] : []).map((item) => item.name || item),
        characters: (gallery.characters || []).map((item) => item.name || item),
        tags: (gallery.tags || []).map((item) => item.type ? `${item.type}:${item.name}` : item),
        pages: job.total,
        url: gallery.url || '',
      }, null, 2));

      sink = createSink(job, gallery, infoBuffer);

      let cursor = 0;
      // この走りで新しく取れた頁の数。控えから読んだ頁は数えない:
      // 前へ進んでいる限り再試行の回数を使い切らせないための目安になる
      let gained = 0;
      job.failed = 0;
      job.failedPages = [];
      // 前の試行で取れた頁は取り直さない。断られた頁だけを拾いに行く
      const cacheDir = pageCacheDir(job);
      fs.mkdirSync(cacheDir, { recursive: true });
      const cached = loadPageCache(cacheDir);
      const workers = Array.from(
        { length: Math.min(this.concurrency, job.total) },
        async () => {
          while (cursor < job.total) {
            if (job.cancelled) return;
            const index = cursor++;
            await this.fetchGate.acquire();
            try {
              if (job.cancelled) return;
              let buffer = null;
              let ext = '';
              const hit = cached.get(index);
              if (hit) {
                try {
                  buffer = fs.readFileSync(hit.file);
                  ext = hit.ext;
                } catch {
                  buffer = null;
                }
              }
              if (!buffer) {
                const got = await fetchWithRetry(id, index, {
                  gate: this.fetchGate,
                  isCancelled: () => job.cancelled,
                });
                buffer = Buffer.from(got.bytes);
                ext = imageExt(got.type);
                savePageCache(cacheDir, index, ext, buffer);
                gained += 1;
              }
              if (job.cancelled) return;
              const name = `${String(index + 1).padStart(4, '0')}${ext}`;
              await sink.addImage(index, name, buffer);
              job.done += 1;
              job.bytes += buffer.length;
            } catch (error) {
              // 取り消しで打ち切った分は失敗として数えない (リトライ待ちの中断もここへ来る)
              if (!job.cancelled) {
                job.failed += 1;
                job.error = error.message || String(error);
                if (!job.failedPages.includes(index)) job.failedPages.push(index);
              }
            } finally {
              this.fetchGate.release();
              this.emitUpdate();
            }
          }
        },
      );

      await Promise.all(workers);

      if (job.cancelled) {
        await sink.abort();
        this.dropScratch(job);
        job.status = 'cancelled';
        job.finishedAt = Date.now();
      } else if (job.failed === 0 && job.done === job.total) {
        await sink.commit();
        // 綴じ終えた頁の控えはもう要らない
        this.dropScratch(job);
        // pixiv は Eagle に入るまでが仕事: done は取り込み (importer) が付ける
        const importing = parseId(id).source === 'pixiv' && typeof this.onImport === 'function';
        job.status = importing ? 'importing' : 'done';
        job.error = '';
        job.finishedAt = Date.now();
        // 完了通知 (台帳への記帳など) が転んでも、保存そのものは済んでいる。
        // 外側の catch に落とすと abort → raw では保存済みフォルダの削除 →
        // 再ダウンロード、と成功を台無しにするので、ここで堰き止める
        try {
          if (this.onComplete) this.onComplete(job);
          if (importing) this.onImport(job, gallery);
        } catch {
          // 記帳は次のスキャンが拾い直す
        }
      } else {
        await sink.abort();
        job.error = job.error || `${job.failed} 枚失敗`;
        // 断られながらも頁を積めているなら、まだ諦める場面ではない
        job.gained = gained;
        this.scheduleRetry(job);
      }
    } catch (error) {
      job.error = error.message || String(error);
      if (sink) {
        try { await sink.abort(); } catch { /* ignore */ }
      }
      this.scheduleRetry(job);
    } finally {
      this.activeGalleries -= 1;
      if (paw) this.activePaw = Math.max(0, this.activePaw - 1);
      this.emitUpdate(true);
      this.persist();
      this.pump();
    }
  }

  // 取り消しで降りる。綴じかけの sink があれば先に畳む: commit していない .part を
  // 棚の隣に残すと、次の走りが「もう置いてある」と読み違える
  async finishCancelled(job, sink) {
    if (sink) {
      try { await sink.abort(); } catch { /* 畳め損ねても取り消しは通す */ }
    }
    // 取り消した仕事の落ちかけを棚の隣に残さない
    this.dropScratch(job);
    job.status = 'cancelled';
    job.finishedAt = Date.now();
  }

  // 落ちてきた実体を 1 冊に綴じる。取り消しで降りたときは '' を返す
  // (finishCancelled まで済ませてあるので、呼び手はそのまま抜ければよい)
  async bindPawPages(job, gallery, sources) {
    const sink = createPdfSink(job, gallery);
    // 綴じ先は sink が job.dest に置く。後で「何を代表に出すか」を決めるのに要る
    const dest = job.dest;
    try {
      for (let index = 0; index < sources.length; index += 1) {
        // 子を切ってから綴じ上がるまでの間にも取り消しは届く。ここを見ないと、
        // 取り消した仕事が棚に本を置いて台帳にまで載る
        if (job.cancelled) {
          await this.finishCancelled(job, sink);
          return '';
        }
        // 作業ファイルの名は綴じ順で振る (素性が分かれば十分)
        const name = `${String(index + 1).padStart(4, '0')}${sources[index].ext}`;
        await sink.addImage(index, name, fs.readFileSync(sources[index].file));
      }
      if (job.cancelled) {
        await this.finishCancelled(job, sink);
        return '';
      }
      await sink.commit();
    } catch (error) {
      try { await sink.abort(); } catch { /* 綴じ損ねた欠片は消す */ }
      // staging は残す: 取れている実体を捨てず、綴じ直しからやり直せるようにする
      throw error;
    }
    return dest;
  }

  // pawchive の保存。頁を一枚ずつ API から拾うのではなく、投稿の URL ごと外部
  // エンジン (kemono-dl) の子プロセスに渡し、落ちてきた実体をこちらで綴じる。
  // 403 の躱し方・再試行・.part でのレジュームは向こうが持っている資産で、
  // こちらで書き直すより借りた方が確かに落ちてくる。
  //
  // 成否は子の終了コードでは見ない (取れていないのに 0 で終わることがある):
  // 欲しい hash の実体が staging に居るかどうか、それだけで決める
  async runPawEngine(job, gallery, plan) {
    // zip 配布の投稿 (サムネ 1 枚 + 本編 zip) は本文画像が 0 枚。表紙と zip も
    // 落として組み立てる (どちらが本体になるかは開けてみるまで決まらない)
    const zips = plan.zips || [];
    const cover = plan.cover || null;
    job.downloadDir = plan.downloadDir;
    job.destPath = path.join(plan.downloadDir, `${plan.baseName}.pdf`);
    job.format = 'pdf';
    job.pawKey = plan.pawKey || '';
    job.stagingDir = plan.stagingDir || '';
    // 揃い判定の必須集合。表紙は入れない: 一覧用の一枚でエンジンが落としてこない
    // ことがあり、必須にすると本文も zip も揃っているのに永久に済にならない
    const wanted = [...plan.files, ...zips];
    job.total = wanted.length;
    job.done = 0;
    job.bytes = 0;
    job.failed = 0;
    job.failedPages = [];

    // 同梱物が欠けていると子は起こせない。待っても現れないので積み直さない
    if (!kemonoEngine.available()) {
      job.error = kemonoEngine.runtimeError() || 'pawchive の取り込みエンジンが使えません';
      job.status = 'error';
      job.finishedAt = Date.now();
      return;
    }

    fs.mkdirSync(job.downloadDir, { recursive: true });
    fs.mkdirSync(job.stagingDir, { recursive: true });

    // 綴じ順に並んだ hash。落ちてきたファイル名と突き合わせて実体を引く
    const wantedHashes = wanted.map((file) => fileHashOf(file.path));
    // 数えるのは「読める実体」だけ。壊れた欠片 (_statuscode416) は落ちていても
    // 綴じられないので、居ないものとして数える
    const countStaged = (staged) => wantedHashes.reduce(
      (sum, hash) => sum + (staged.get(hash) && !staged.get(hash).broken ? 1 : 0),
      0,
    );
    // 走る前から居る枚数。この走りで何枚積めたかは差で見る (再試行を続ける目安)
    const before = countStaged(collectStaged(job.stagingDir));

    // 書き出したばかりのクッキーを実行の直前に取り込む: 無認証だと数枚で断たれる
    try {
      pawCookies.adoptDownloadedCookies();
    } catch {
      // 取り込めなくても、今持っているクッキーのまま走る
    }

    // 子が黙って落としている間も進みを見せる。画面の速度表示は bytes の差分で出る
    const ticker = setInterval(() => {
      job.bytes = stagingBytes(job.stagingDir);
      this.emitUpdate();
    }, 1000);
    if (ticker.unref) ticker.unref();

    let result;
    try {
      result = await kemonoEngine.run({
        links: [plan.postUrl],
        outDir: job.stagingDir,
        // 名前を hash にすると、題や添付の並びが変わっても実体を取り違えない
        filenamePattern: '{hash}.{ext}',
        cookieFile: pawCookies.status().file,
        // 種別の線はエンジン側の語彙から引く。zip は要る投稿でだけ頼む
        onlyFiletypes: zips.length ? [...IMAGE_TYPES, 'zip'] : [...IMAGE_TYPES],
        onEvent: (event) => {
          if (event.type !== 'file-start' && event.type !== 'file-skip') return;
          // 向こうの言い分ではなく、置き場に実際に居る枚数を数える
          job.done = Math.min(countStaged(collectStaged(job.stagingDir)), job.total);
          this.emitUpdate();
        },
        isCancelled: () => job.cancelled,
      });
    } finally {
      clearInterval(ticker);
    }

    if (job.cancelled) {
      await this.finishCancelled(job, null);
      return;
    }

    const staged = collectStaged(job.stagingDir);
    job.bytes = stagingBytes(job.stagingDir);
    const found = [];
    const missing = [];
    wantedHashes.forEach((hash, index) => {
      const hit = staged.get(hash);
      if (hit && !hit.broken) {
        // ext は collectStaged がドット込みで返す (綴じ先の名の尾にそのまま付く形)
        found.push({ index, file: hit.file, ext: hit.ext });
        return;
      }
      // 途中で切れた実体 (416) は「取れた」ではなく「欠け」。綴じてしまうと
      // 半分だけの絵が本になって台帳にも載る: 欠片を捨てて取り直させる
      if (hit) {
        try { fs.rmSync(hit.file, { force: true }); } catch { /* 消せなくても欠け扱いは変わらない */ }
      }
      missing.push(index);
    });
    job.done = found.length;
    // この走りで何枚積めたか。積めている限り積み直しは空振りに数えない
    job.gained = found.length - before;

    if (missing.length) {
      // 落ちた分は staging に残す: 次の走りは欠けた分だけを取りに行く
      job.failed = missing.length;
      job.failedPages = missing;
      job.error = pawFailureReason(result, missing.length);
      this.scheduleRetry(job);
      return;
    }

    // 綴じ始める前にもう一度見る: 子を切ってから綴じ上がるまでの間にも取り消しは届く。
    // ここを見ないと、取り消した仕事が棚に本を置いて台帳にまで載る
    if (job.cancelled) {
      await this.finishCancelled(job, null);
      return;
    }

    // wanted は [本文画像…, zip…] の順に並べたので、境目は本文の枚数
    const pageFiles = found.filter((item) => item.index < plan.files.length);
    const zipFiles = found.filter((item) => item.index >= plan.files.length);
    // 表紙は必須ではない (あれば使う)。欠片 (416) なら無かったことにする
    const coverHit = cover ? staged.get(fileHashOf(cover.path)) : null;
    const coverFile = coverHit && !coverHit.broken ? coverHit : null;

    // zip を先に開ける: 中身が 1 冊になったかどうかで、表紙を綴じるかが決まる
    const zipMade = [];
    let zipMadePdf = false;
    try {
      for (const item of zipFiles) {
        const source = zips[item.index - plan.files.length];
        const made = await convertZip({
          zipPath: item.file,
          destDir: plan.downloadDir,
          stem: attachmentStem(source, plan.baseName),
        });
        if (made.pdf) zipMadePdf = true;
        zipMade.push(made);
      }
    } catch (error) {
      // 開けなかった書庫は次の走りにもう一度。実体は staging に残っている
      job.error = (error && error.message) || String(error);
      this.scheduleRetry(job);
      return;
    }
    if (job.cancelled) {
      await this.finishCancelled(job, null);
      return;
    }

    let bodyPdf = '';
    let coverPdf = '';
    if (pageFiles.length) {
      bodyPdf = await this.bindPawPages(job, gallery, pageFiles);
      if (!bodyPdf) return; // 綴じている最中に取り消された (後始末は済んでいる)
    } else if (!zipMadePdf && coverFile) {
      // 本文が無く、zip も 1 冊にまとまらなかったときだけ表紙を綴じる。
      // 書庫だけが棚に並ぶと見出しが無くて何の投稿か分からなくなる。
      // 逆に zip が本になったなら、表紙 1 枚の本を隣に並べても雑音にしかならない
      job.destPath = path.join(plan.downloadDir, `${plan.coverBaseName || plan.baseName}.pdf`);
      coverPdf = await this.bindPawPages(job, gallery, [coverFile]);
      if (!coverPdf) return;
    }

    if (!bodyPdf && !coverPdf && !zipMade.length) {
      // 表紙 1 枚だけの投稿で、その表紙すら落ちてこなかった。置くものが何も無い
      job.error = 'pawchive: 綴じるものが落ちてきませんでした';
      this.scheduleRetry(job);
      return;
    }

    // 一覧に出す代表は「本文 PDF > 最初の zip 由来 PDF > 表紙 PDF > 書庫」の順
    const firstZipPdf = zipMade.find((made) => made.pdf);
    const firstZipFile = zipMade.find((made) => made.zip);
    job.dest = bodyPdf
      || (firstZipPdf && firstZipPdf.pdf)
      || coverPdf
      || (firstZipFile && firstZipFile.zip)
      || job.dest;
    // Eagle へは API で入れる (paw-importer)。口が据わっていれば done は取り込みが付ける。
    // 出力先を Eagle の自動インポートに拾わせる昔の道は、口が無い時 (試験・写し) だけ残る
    const importing = typeof this.onPawImport === 'function';
    job.status = importing ? 'importing' : 'done';
    job.error = '';
    job.finishedAt = Date.now();
    // 完了通知 (台帳への記帳など) が転んでも、保存そのものは済んでいる
    try {
      if (this.onComplete) this.onComplete(job);
      if (importing) {
        // 代表 (job.dest) を先頭に。残りは zip 由来の本・書庫・表紙
        const files = [job.dest, ...zipMade.map((made) => made.pdf), ...zipMade.map((made) => made.zip), coverPdf]
          .filter((file, index, list) => file && list.indexOf(file) === index);
        this.onPawImport(job, gallery, { files, plan });
      }
    } catch {
      // 記帳は次のスキャンが拾い直す
    }
    this.dropScratch(job);
  }
}

module.exports = { Downloader, Gate, setPageBytesHook };
