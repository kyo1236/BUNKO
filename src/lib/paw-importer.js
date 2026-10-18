'use strict';

// pawchive の取り込み: 綴じた PDF (と書庫) を Eagle API の addFromPath で作者フォルダへ入れる。
//
// 以前は出力先 (<pawBulkDir>/<service>/<作者 [id]>/) を Eagle の自動インポートに拾わせていたが、
// Eagle 4 の見張り先は一つしか持てず、別の場所へ向くと取り残しになる (2026-09-26 に判明)。
// pixiv の取り込み (pixiv/importer.js) と同じ道にして、Eagle の設定に左右されないようにした。
//
//   1. 作者フォルダを決める (手動の結び → 名前の当て → 新しく作る)
//   2. 同じ名前の項目がそのフォルダに無ければ addFromPath (名前 = ファイル名そのまま、url = 投稿の URL)
//   3. listItems で項目 id を確かめ、出力先の実体を消し、job を done にする
//
// 名前は **ファイル名そのまま** ("[YYYYMMDD] [postId] 題【NP】")。paw-library.parseName が
// この形から投稿 ID と頁数を読んで 済 を決めるので、切ったり直したりしない。
// 探すのも名前で行う: 昔 自動インポートで入った項目は url を持たないし、
// 一つの投稿から本文 PDF と zip 由来の PDF が出ると url は同じになる。
//
// Eagle が起動していなければ待ち行列に積んだまま 30 秒ごとに見る。待ち行列は
// paw-queue.json (own) に控え、再起動で続きから。electron を引かない (試験で素の node から使う)。
// 記録には投稿 id だけを書く (題は書かない)

const fs = require('fs');
const path = require('path');
const stateFile = require('./state-file');
const trace = require('./trace');

const EAGLE_POLL_MS = 30 * 1000;
// 入れた項目を名前で探す回数と間合い (pixiv の取り込みと同じ勘定: 一巡 ≈ 3 分)
const FIND_TRIES = 60;
const FIND_GAP_MS = 300;
const FIND_GAP_MAX_MS = 3000;
const FIND_ROUNDS = 3;
const FIND_REST_MS = 60 * 1000;
// 取り残しを拾う時、これより古い物は拾わない (利用者が要るかどうかを決めてから)
const SWEEP_DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SWEEP_EXT = /\.(pdf|zip)$/i;

function stemOf(file) {
  return path.basename(String(file)).replace(/\.[^.]+$/, '');
}

function annotationOf(meta) {
  const lines = [`pawchive:${meta.service}:${meta.user}:${meta.postId}`];
  if (meta.creatorName) lines.push(`作者: ${meta.creatorName} (${meta.user})`);
  if (meta.date) lines.push(`投稿日: ${String(meta.date).slice(0, 10)}`);
  if (meta.pages) lines.push(`頁: ${meta.pages}`);
  return lines.join('\n');
}

// 出力先の道から素性を読む: <root>/<service>/<作者 [user]>/[YYYYMMDD] [postId] 題【NP】.pdf
function metaFromPath(file) {
  const name = path.basename(String(file));
  const creatorDir = path.basename(path.dirname(String(file)));
  const service = path.basename(path.dirname(path.dirname(String(file))));
  const user = (creatorDir.match(/\[(\d+)\]\s*$/) || [])[1] || '';
  const postId = (name.match(/^\[\d{8}\]\s*\[(\d+)\]/) || [])[1] || '';
  if (!service || !user || !postId) return null;
  return {
    service,
    user,
    postId,
    creatorName: creatorDir.replace(/\s*\[\d+\]\s*$/, '').trim() || user,
    date: (name.match(/^\[(\d{8})\]/) || [])[1] || '',
    pages: Number((name.match(/【(\d+)P】/) || [])[1]) || 0,
  };
}

class PawImporter {
  constructor({
    eagle, pawLibrary, pawLinks, queueFile, rootFolderId, postUrl = null, onJob = null, now = Date.now,
    setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = clearTimeout, sleep = null,
  } = {}) {
    if (!eagle) throw new Error('paw importer: eagle が無い');
    if (!pawLibrary) throw new Error('paw importer: pawLibrary が無い');
    this.eagle = eagle;
    this.pawLibrary = pawLibrary;
    this.pawLinks = pawLinks || null;
    this.queueFile = queueFile || '';
    this.rootFolderId = rootFolderId;   // 作者根の Eagle フォルダ id (関数でもよい)
    this.postUrl = typeof postUrl === 'function' ? postUrl : null;
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
        this.queue = parsed.items
          .filter((item) => item && item.key && Array.isArray(item.files) && item.files.length)
          .map((item) => ({ ...item, state: 'queued', error: '' }));
      }
    } catch {
      this.queue = [];
    }
  }

  persist() {
    if (!this.queueFile) return;
    stateFile.writeJson('paw-queue', this.queueFile, {
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

  // files[0] が代表 (job.dest)。job の eagleItemId はその項目
  enqueue({ jobId = '', key, files, meta = {} }) {
    const id = String(key || '');
    const list = (Array.isArray(files) ? files : [files]).map(String).filter(Boolean);
    if (!id || !list.length) throw new Error('paw importer: key か files が無い');
    if (!meta.service || !meta.user || !meta.postId) throw new Error('paw importer: 投稿の素性が無い');
    const existing = this.queue.find((item) => item.key === id && item.state !== 'done');
    if (existing) {
      existing.jobId = jobId || existing.jobId;
      existing.files = list;
      existing.meta = { ...existing.meta, ...meta };
      this.persist();
      this.kick();
      return existing;
    }
    const item = {
      key: id, jobId: String(jobId || ''), files: list, meta: { ...meta }, state: 'queued', error: '', tries: 0, addedAt: this.now(),
    };
    this.queue.push(item);
    this.persist();
    this.patchJob(item, { status: 'importing' });
    this.kick();
    return item;
  }

  // 出力先に取り残された実体 (Eagle に拾われなかった PDF / zip) を拾って積む。
  // maxAgeMs より古い物は拾わない: 要るかどうかを利用者が決めてから
  sweep(root, { maxAgeMs = SWEEP_DEFAULT_MAX_AGE_MS } = {}) {
    const dir = String(root || '');
    if (!dir) return [];
    const picked = [];
    const now = this.now();
    let services = [];
    try {
      services = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.'));
    } catch {
      return [];
    }
    const byPost = new Map();
    for (const service of services) {
      let creators = [];
      try {
        creators = fs.readdirSync(path.join(dir, service.name), { withFileTypes: true }).filter((d) => d.isDirectory());
      } catch {
        continue;
      }
      for (const creator of creators) {
        const folder = path.join(dir, service.name, creator.name);
        let names = [];
        try {
          names = fs.readdirSync(folder);
        } catch {
          continue;
        }
        for (const name of names.sort()) {
          if (!SWEEP_EXT.test(name)) continue;
          const file = path.join(folder, name);
          let stat = null;
          try {
            stat = fs.statSync(file);
          } catch {
            continue;
          }
          if (!stat.isFile() || !(stat.size > 0)) continue;
          if (maxAgeMs > 0 && now - stat.mtimeMs > maxAgeMs) continue;
          const meta = metaFromPath(file);
          if (!meta) continue;
          const key = `${meta.service}:${meta.user}:${meta.postId}`;
          const entry = byPost.get(key) || { key, files: [], meta };
          // 本文 PDF (【NP】付き) を代表に、書庫は後ろへ
          if (/\.pdf$/i.test(name)) entry.files.unshift(file); else entry.files.push(file);
          byPost.set(key, entry);
        }
      }
    }
    for (const entry of byPost.values()) {
      picked.push(this.enqueue({ key: entry.key, files: entry.files, meta: entry.meta }));
    }
    return picked;
  }

  retry(jobId) {
    const item = this.queue.find((row) => row.jobId === String(jobId) && row.state === 'error');
    if (!item) return false;
    item.state = 'queued';
    item.error = '';
    item.tries = 0;
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
        trace.flag('paw-import-wait', true, EAGLE_POLL_MS * 2);
        this.later(EAGLE_POLL_MS);
        return;
      }
      this.eagleDown = false;
      trace.flag('paw-import-wait', false);
      await this.importOne(item);
    }
  }

  async importOne(item) {
    item.state = 'running';
    item.tries += 1;
    const meta = item.meta || {};
    try {
      const folder = await this.resolveFolder(meta);
      const url = meta.url || (this.postUrl ? this.postUrl(meta.service, meta.user, meta.postId) : '');
      // 消えた実体 (利用者が片付けた等) は飛ばす。全部消えていれば「済」にする物が無い
      const files = item.files.filter((file) => {
        try { return fs.statSync(file).isFile(); } catch { return false; }
      });
      if (!files.length) throw new Error('据える実体が見つかりません');
      let primaryId = '';
      let pendingCopy = false;
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const name = stemOf(file);
        // 先に名前で探す: 前の巡で入れてあった物 (Eagle の写しが遅かった) を二つにしない
        let eagleId = await this.findItem(folder.folderId, name, url, 1);
        const added = new Set(item.added || []);
        if (!eagleId && !added.has(file)) {
          await this.eagle.addFromPath({
            path: file,
            name,
            website: url,
            annotation: annotationOf(meta),
            folderId: folder.folderId,
          });
          added.add(file);
          item.added = [...added];
          this.persist();
          eagleId = await this.findItem(folder.folderId, name, url);
        } else if (!eagleId) {
          eagleId = await this.findItem(folder.folderId, name, url);
        }
        if (!eagleId) {
          pendingCopy = true;
          continue;
        }
        // Eagle が写しを持った物だけ手元から消す
        try { fs.rmSync(file, { force: true }); } catch { /* 消せなくても取り込みは済んでいる */ }
        if (index === 0) primaryId = eagleId;
      }
      if (pendingCopy || !primaryId) {
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
      item.state = 'done';
      item.eagleId = primaryId;
      this.patchJob(item, { status: 'done', eagleItemId: primaryId, error: '', finishedAt: this.now() });
      this.queue = this.queue.filter((row) => row !== item);
      this.persist();
      if (typeof this.pawLibrary.revalidateSoon === 'function') {
        try { this.pawLibrary.revalidateSoon(); } catch { /* 次の走査が拾う */ }
      }
    } catch (error) {
      item.state = 'error';
      item.error = (error && error.message) || String(error);
      this.patchJob(item, { status: 'error', error: `取り込み: ${item.error}` });
      this.persist();
      trace.note('download', 'unhandled', { id: `paw-import:${meta.postId || '?'}`, count: item.tries });
    }
  }

  // 作者フォルダ。手動の結び → 名前の当て (paw-library) → 新しく作る (表示名そのまま。
  // 既存の作者フォルダは [id] を付けていないので揃える)。作った時だけ結びを記す
  async resolveFolder(meta) {
    const known = this.pawLibrary.resolveCreatorFolder(meta.service, meta.user, meta.creatorName || '');
    if (known && known.folderId) return { folderId: String(known.folderId), name: known.name || '' };
    const root = typeof this.rootFolderId === 'function' ? this.rootFolderId() : this.rootFolderId;
    const name = String(meta.creatorName || '').trim() || String(meta.user);
    const folderId = String(await this.eagle.createFolder(name, root || ''));
    if (this.pawLinks && typeof this.pawLinks.setCreator === 'function') {
      try { this.pawLinks.setCreator(meta.service, meta.user, folderId); } catch { /* 次は名前で当たる */ }
    }
    return { folderId, name };
  }

  // フォルダの中を名前で照らす (url は補助)。item/list は 'CREATEDATE' で新しい順 (eagle-api.js)。
  // 新しい順の 50 件で外れたら、フォルダを丸ごと (1000 件まで) 見る
  async findItem(folderId, name, url, tries = FIND_TRIES) {
    const wantName = String(name);
    const wantUrl = String(url || '').replace(/\/$/, '');
    const matches = (items) => (items || []).find((row) => String(row.name || '') === wantName
      || (wantUrl && String(row.url || '').replace(/\/$/, '') === wantUrl && String(row.name || '').startsWith(wantName.slice(0, 24))));
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
}

module.exports = { PawImporter, metaFromPath, annotationOf, stemOf };
