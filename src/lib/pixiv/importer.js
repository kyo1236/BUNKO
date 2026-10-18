'use strict';

// pixiv の取り込み (docs/pixiv-design-2026-09-19.md §7, §15 U3/E2/E3)。
//
// downloader が頁を集めて (一枚絵ならそのまま、複数枚なら PDF に綴じて) 一時置き場に置いた物を、
//   1. 作者フォルダを決め (台帳 → 表示名の照らし合わせ → 新しく作る)
//   2. Eagle API の addFromPath で入れ (名前 = 題、url = 投稿の URL、メモ = 素性)
//   3. 項目 id を listItems で確かめ、台帳に書き、一時置き場を消し、job を done にする
//
// 「同じ人?」は押した時に renderer が訊いて台帳に書くのが本筋。ここに答えの無いまま
// 名前の一致が来た時 (再起動で復元した job 等) だけ 'asking' で止め、答えを待つ。
// Eagle が起動していなければ待ち行列に積んだまま 30 秒ごとに見る。
// 待ち行列は pixiv-queue.json (own) に控え、再起動で続きから。electron を引かない。

const fs = require('fs');
const path = require('path');
const stateFile = require('../state-file');
const trace = require('../trace');

const EAGLE_POLL_MS = 30 * 1000;
// 入れた項目を url で探す回数と間合い。一度目はすぐ、あとは 0.3 秒刻みで 3 秒まで (一巡 ≈ 3 分)。
// Eagle は addFromPath の返事の直後にはまだ写し終えていない。大きい PDF (100 MB 超) は
// 写しと表紙の描画に分単位かかることがある (2026-09-19: 107 MB の 11 頁で 24 秒では足りなかった)
const FIND_TRIES = 60;
const FIND_GAP_MS = 300;
const FIND_GAP_MAX_MS = 3000;
// 一巡で見つからなくても、しばらく置いて何度か見に行く (入れ直しはしない: 先に url で探す)
const FIND_ROUNDS = 3;
const FIND_REST_MS = 60 * 1000;
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif|bmp)$/i;

// Eagle は name をファイル名にも使う。道に使えない字を落とし、長すぎる題を切る
function safeName(title, fallback) {
  const text = String(title || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim();
  const cut = text.length > 120 ? text.slice(0, 120).trim() : text;
  return cut || String(fallback || 'pixiv');
}

function annotationOf(meta) {
  const lines = [`pixiv:${meta.pid}`];
  if (meta.userName || meta.userId) lines.push(`作者: ${meta.userName || ''}${meta.userId ? ` (${meta.userId})` : ''}`.trim());
  if (meta.date) lines.push(`投稿日: ${String(meta.date).slice(0, 10)}`);
  if (meta.pages) lines.push(`頁: ${meta.pages}`);
  if (meta.series && meta.series.title) {
    lines.push(`シリーズ: ${meta.series.title}${meta.series.order ? ` #${meta.series.order}` : ''}`);
  }
  if (meta.caption) lines.push('', '作品キャプション:', String(meta.caption).slice(0, 20000));
  return lines.join('\n');
}

// 一時置き場のフォルダから、据える実体を一つ選ぶ。PDF があればそれ、無ければ絵一枚
function pickFile(target) {
  let stat = null;
  try {
    stat = fs.statSync(target);
  } catch {
    return null;
  }
  if (stat.isFile()) return target;
  let names = [];
  try {
    names = fs.readdirSync(target);
  } catch {
    return null;
  }
  const pdf = names.find((name) => /\.pdf$/i.test(name));
  if (pdf) return path.join(target, pdf);
  const images = names.filter((name) => IMAGE_EXT.test(name) && !/thumbnail/i.test(name)).sort();
  return images.length ? path.join(target, images[0]) : null;
}

class PixivImporter {
  constructor({
    library, eagle, pawLibrary, queueFile, rootFolderId, onJob = null, now = Date.now,
    setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = clearTimeout, sleep = null,
  } = {}) {
    if (!library) throw new Error('pixiv importer: library が無い');
    if (!eagle) throw new Error('pixiv importer: eagle が無い');
    this.library = library;
    this.eagle = eagle;
    this.pawLibrary = pawLibrary || null;
    this.queueFile = queueFile || '';
    this.rootFolderId = rootFolderId;   // 作者根の Eagle フォルダ id (関数でもよい)
    this.onJob = onJob;                  // (jobId, patch) → downloader の job を書き換える
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.sleep = sleep || ((ms) => new Promise((resolve) => { this.setTimer(resolve, ms); }));
    this.queue = [];
    this.running = null;
    this.timer = null;
    this.eagleDown = false;
    this.restore();
  }

  // --- 待ち行列 -----------------------------------------------------------------

  restore() {
    if (!this.queueFile) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.queueFile, 'utf8'));
      if (parsed && Array.isArray(parsed.items)) {
        this.queue = parsed.items.filter((item) => item && item.pid && item.file).map((item) => ({
          ...item, state: item.state === 'asking' ? 'asking' : 'queued', error: '',
        }));
      }
    } catch {
      this.queue = [];
    }
  }

  persist() {
    if (!this.queueFile) return;
    stateFile.writeJson('pixiv-queue', this.queueFile, {
      version: 1,
      items: this.queue.filter((item) => item.state !== 'done').map((item) => ({ ...item })),
    });
  }

  patchJob(item, patch) {
    if (typeof this.onJob === 'function' && item.jobId) {
      try {
        this.onJob(item.jobId, patch);
      } catch {
        // 画面への通知が転んでも取り込みは進める
      }
    }
  }

  enqueue({ jobId = '', pid, file, meta = {} }) {
    const key = String(pid || '');
    if (!key || !file) throw new Error('pixiv importer: pid か file が無い');
    const existing = this.queue.find((item) => item.pid === key && item.state !== 'done');
    if (existing) {
      existing.jobId = jobId || existing.jobId;
      existing.file = file;
      return existing;
    }
    const item = {
      pid: key, jobId: String(jobId || ''), file: String(file), meta: { ...meta, pid: key }, state: 'queued', error: '', tries: 0, addedAt: this.now(),
    };
    this.queue.push(item);
    this.persist();
    this.patchJob(item, { status: 'importing' });
    this.kick();
    return item;
  }

  // 「同じ人?」の答え。folderId を渡せばそのフォルダへ、null なら新しく作る
  answer(userId, folderId, name = '') {
    const key = String(userId || '');
    if (folderId) this.library.bindCreator(key, folderId, name);
    for (const item of this.queue) {
      if (item.state === 'asking' && String(item.meta.userId) === key) {
        item.state = 'queued';
        item.createFolder = !folderId;
        this.patchJob(item, { status: 'importing', ask: null });
      }
    }
    this.persist();
    this.kick();
  }

  retry(jobId) {
    const item = this.queue.find((row) => row.jobId === String(jobId) && row.state === 'error');
    if (!item) return false;
    item.state = 'queued';
    item.error = '';
    item.tries = 0;
    // 利用者が押した再試行だけは入れ直してよい (先に url で探すので、入っていれば入れ直さない)
    item.added = false;
    this.patchJob(item, { status: 'importing', error: '' });
    this.persist();
    this.kick();
    return true;
  }

  pending() {
    const open = this.queue.filter((item) => item.state !== 'done');
    return {
      count: open.length,
      waitingEagle: this.eagleDown ? open.filter((item) => item.state === 'queued').length : 0,
      asking: open.filter((item) => item.state === 'asking').map((item) => ({
        jobId: item.jobId, pid: item.pid, userId: item.meta.userId, userName: item.meta.userName, folder: item.ask || null,
      })),
      errors: open.filter((item) => item.state === 'error').length,
    };
  }

  // --- 進める ------------------------------------------------------------------

  kick() {
    if (this.running) return this.running;
    this.running = this.drain().catch(() => {}).finally(() => { this.running = null; });
    return this.running;
  }

  later(ms) {
    if (this.timer) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.kick();
    }, ms);
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
  }

  async drain() {
    while (true) {
      const now = this.now();
      const item = this.queue.find((row) => row.state === 'queued' && !(row.notBefore > now));
      if (!item) {
        // 置いてある物 (Eagle の写し待ち) があれば、その時刻に見に来る
        const deferred = this.queue.filter((row) => row.state === 'queued' && row.notBefore > now);
        if (deferred.length) this.later(Math.max(1000, Math.min(...deferred.map((row) => row.notBefore)) - now));
        return;
      }
      let available = false;
      try {
        available = await this.eagle.isAvailable();
      } catch {
        available = false;
      }
      if (!available) {
        this.eagleDown = true;
        trace.flag('pixiv-import-wait', true, EAGLE_POLL_MS * 2);
        this.later(EAGLE_POLL_MS);
        return;
      }
      this.eagleDown = false;
      trace.flag('pixiv-import-wait', false);
      await this.importOne(item);
    }
  }

  async importOne(item) {
    item.state = 'running';
    item.tries += 1;
    try {
      const folder = await this.resolveFolder(item);
      if (!folder) return;                      // asking で止まった
      const file = pickFile(item.file);
      if (!file) throw new Error('据える実体が見つかりません');
      const meta = item.meta || {};
      const url = meta.url || `https://www.pixiv.net/artworks/${item.pid}`;
      // 先に url で探す: 前の巡で入れてあった (Eagle の写しが遅かった) 物を二つにしない。
      // 一度入れた物 (added) は自動では入れ直さない: Eagle は同じ実体を受けると「どう扱うか」の窓を
      // 利用者の画面に出す。入れ直すのは利用者が控え室で再試行を押した時だけ (retry が added を下ろす)
      let eagleId = await this.findItem(folder.folderId, url, 1);
      if (!eagleId && !item.added) {
        await this.eagle.addFromPath({
          path: file,
          name: safeName(meta.title, item.pid),
          website: url,
          annotation: annotationOf({ ...meta, pid: item.pid }),
          folderId: folder.folderId,
        });
        item.added = true;
        this.persist();
        eagleId = await this.findItem(folder.folderId, url);
      } else if (!eagleId) {
        eagleId = await this.findItem(folder.folderId, url);
      }
      if (!eagleId) {
        // Eagle がまだ写している最中かもしれない。しばらく置いてもう一度探す (入れ直さない)
        if (item.tries < FIND_ROUNDS) {
          item.state = 'queued';
          item.notBefore = this.now() + FIND_REST_MS;
          item.error = '';
          this.patchJob(item, { status: 'importing', error: '' });
          this.persist();
          return;
        }
        throw new Error('Eagle に入ったはずの項目が見つかりません');
      }
      this.library.record({
        pid: item.pid,
        eagleId,
        userId: meta.userId,
        userName: meta.userName,
        title: meta.title,
        caption: meta.caption,
        tags: meta.tags,
        ai: meta.ai,
        r18: meta.r18,
        date: meta.date,
        pages: meta.pages,
        series: meta.series,
      });
      this.removeStaging(item.file);
      item.state = 'done';
      item.eagleId = eagleId;
      this.patchJob(item, { status: 'done', eagleItemId: eagleId, error: '', finishedAt: this.now() });
      this.queue = this.queue.filter((row) => row !== item);
      this.persist();
      if (this.pawLibrary && typeof this.pawLibrary.revalidateSoon === 'function') {
        try { this.pawLibrary.revalidateSoon(); } catch { /* 次の走査が拾う */ }
      }
    } catch (error) {
      item.state = 'error';
      item.error = (error && error.message) || String(error);
      this.patchJob(item, { status: 'error', error: `取り込み: ${item.error}` });
      this.persist();
      trace.note('download', 'unhandled', { id: 'pixiv-import', count: item.tries });
    }
  }

  // 作者フォルダ。台帳 → 名前の一致 (答えが要る) → 新しく作る
  async resolveFolder(item) {
    const meta = item.meta || {};
    const userId = String(meta.userId || '');
    const known = userId ? this.library.creatorFolder(userId) : null;
    if (known) return known;
    const folders = this.creatorFolders();
    if (!item.createFolder) {
      const match = this.library.constructor.matchCreatorFolder(meta.userName, folders);
      if (match) {
        item.state = 'asking';
        item.ask = { folderId: match.folderId, name: match.name };
        this.patchJob(item, { status: 'asking', ask: { userId, userName: meta.userName, folderId: match.folderId, folderName: match.name } });
        this.persist();
        return null;
      }
    }
    const root = typeof this.rootFolderId === 'function' ? this.rootFolderId() : this.rootFolderId;
    const name = safeName(meta.userName, userId ? `pixiv ${userId}` : 'pixiv');
    const folderId = await this.eagle.createFolder(name, root || '');
    if (userId) this.library.bindCreator(userId, folderId, name);
    item.createFolder = false;
    return { folderId, name };
  }

  creatorFolders() {
    if (!this.pawLibrary || typeof this.pawLibrary.creatorFolders !== 'function') return [];
    try {
      return this.pawLibrary.creatorFolders() || [];
    } catch {
      return [];
    }
  }

  // 入れた項目の id を url で照らして探す。Eagle の写しが済むまで少し掛かる。
  // tries = 1 は「もう入っているか」の一瞥 (待たない)。
  // Eagle の item/list は orderBy 'CREATEDATE' で**新しい順**、'-CREATEDATE' で古い順に返す
  // (書き方が逆に見えるが実測 2026-09-20)。以前は '-CREATEDATE' の 20 件で探していて、
  // 194 件のフォルダでは入れたばかりの物が末尾に居て見つからず、入れ直しで Eagle に重複の窓を出した。
  // 新しい順の 50 件で外れたら、フォルダを丸ごと (1000 件まで) 見る
  async findItem(folderId, url, tries = FIND_TRIES) {
    const want = String(url).replace(/\/$/, '');
    const matches = (items) => (items || []).find((row) => String(row.url || '').replace(/\/$/, '') === want);
    for (let i = 0; i < tries; i += 1) {
      let hit = null;
      try {
        hit = matches(await this.eagle.listItems({ folders: [folderId], orderBy: 'CREATEDATE', limit: 50 }));
        if (!hit) hit = matches(await this.eagle.listItems({ folders: [folderId], limit: 1000 }));
      } catch {
        hit = null;
      }
      if (hit && hit.id) return String(hit.id);
      if (i + 1 < tries) await this.sleep(Math.min(FIND_GAP_MAX_MS, FIND_GAP_MS * (i + 1)));
    }
    return null;
  }

  // 一時置き場は job ごとのフォルダ px-<pid> (downloader が作る)。据えた物の親を三段まで
  // 遡ってその名のフォルダを探し、丸ごと消す (.resume や raw の子フォルダも一緒に)。
  // 見つからなければ据えた物 (かそのフォルダ) だけ消す
  removeStaging(target) {
    try {
      const stat = fs.statSync(target);
      let dir = stat.isDirectory() ? target : path.dirname(target);
      for (let i = 0; i < 3; i += 1) {
        if (/^px-\d+$/.test(path.basename(dir))) {
          fs.rmSync(dir, { recursive: true, force: true });
          return;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
      if (stat.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
      else fs.rmSync(target, { force: true });
    } catch {
      // 消せなくても取り込みは済んでいる (次の起動で掃く)
    }
  }
}

module.exports = { PixivImporter, safeName, annotationOf, pickFile };
