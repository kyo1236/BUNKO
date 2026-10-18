'use strict';

// pixiv の所持の台帳 (docs/pixiv-design-2026-09-19.md §7)。
//
//   works    投稿 ID → { eagleId, userId, userName, title, tags, ai, r18, date, pages, series, addedAt }
//   creators user_id → { folderId, name }   (名乗り ↔ 作者フォルダ。docs/adr/0002)
//
// 同一性は Eagle の url (https://www.pixiv.net/artworks/<投稿 ID>) が原本で、台帳はその写しと
// 網から貰った素性 (タグ・AI・投稿日) を持つ。索引 (eagle-scan-cache) に url が pixiv の項目が
// あれば、台帳に無くても所持 (手で入れた物・写し)。reconcile が索引と突き合わせる。
//
// state-file の KIND 'pixiv-library' (follow): 母艦が書き、同期で写しへ届く。
// electron を引かない。

const fs = require('fs');
const path = require('path');
const stateFile = require('../state-file');

const VERSION = 1;
const ARTWORK_URL = /pixiv\.net\/(?:en\/)?artworks\/(\d+)/i;
const ARTWORK_URL_OLD = /pixiv\.net\/member_illust\.php\?(?:[^#\s]*&)?illust_id=(\d+)/i;
const ARTWORK_URL_SHORT = /pixiv\.net\/i\/(\d+)/i;
// 付け直し (D19) の対象: PPD が付けた名前 <投稿 ID>_p<n>-題 で url が空の項目
const LEGACY_NAME = /^(\d{5,10})_p\d+(?:[-_ ]|$)/;

function pidFromUrl(url) {
  const text = String(url || '');
  if (!text) return '';
  const hit = text.match(ARTWORK_URL) || text.match(ARTWORK_URL_OLD) || text.match(ARTWORK_URL_SHORT);
  return hit ? hit[1] : '';
}

function artworkUrl(pid) {
  return `https://www.pixiv.net/artworks/${pid}`;
}

// 名前の照らし合わせ (作者フォルダ ↔ pixiv の表示名)。NFKC・小文字・空白抜き
function foldName(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '').trim();
}

function emptyData() {
  return { version: VERSION, works: {}, creators: {} };
}

class PixivLibrary {
  // file: pixiv-library.json の道
  // indexEntries: () => Map<'<eagleId>.info', { meta: { name, url, folders, isDeleted, star, addedAt } }>
  // creatorNameOf: (folderId) => 作者フォルダの名前 (索引だけでは分からない)
  constructor({ file, indexEntries = null, creatorNameOf = null, now = Date.now } = {}) {
    this.file = file || '';
    this.indexEntries = indexEntries;
    this.creatorNameOf = creatorNameOf;
    this.now = now;
    this.data = emptyData();
    this.byEagle = new Map();
    this.loaded = false;
    // 索引に居るが台帳に無い pixiv の項目 (reconcile が拾う)。pid → { eagleId, name, folders }
    this.indexed = new Map();
  }

  load() {
    if (this.loaded) return this;
    this.loaded = true;
    if (!this.file) return this;
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      parsed = null;
    }
    if (parsed && typeof parsed === 'object' && parsed.works && typeof parsed.works === 'object') {
      this.data = {
        version: VERSION,
        works: parsed.works,
        creators: parsed.creators && typeof parsed.creators === 'object' ? parsed.creators : {},
      };
    }
    this.rebuildReverse();
    return this;
  }

  // 写し (Homecore) が同期で届いた新しい台帳を読み直す口
  reload() {
    this.loaded = false;
    this.data = emptyData();
    return this.load();
  }

  rebuildReverse() {
    this.byEagle = new Map();
    for (const [pid, work] of Object.entries(this.data.works)) {
      if (work && work.eagleId) this.byEagle.set(String(work.eagleId), pid);
    }
  }

  save() {
    if (!this.file) return false;
    return stateFile.writeJson('pixiv-library', this.file, this.data);
  }

  // --- 所持 -------------------------------------------------------------------

  get(pid) {
    this.load();
    return this.data.works[String(pid)] || null;
  }

  // 台帳にある投稿 ID の一覧 (生成情報の埋め戻しが順に当たる)
  pids() {
    this.load();
    return Object.keys(this.data.works);
  }

  has(pid) {
    this.load();
    const key = String(pid);
    return Boolean(this.data.works[key]) || this.indexed.has(key);
  }

  eagleIdOf(pid) {
    this.load();
    const key = String(pid);
    const work = this.data.works[key];
    if (work && work.eagleId) return String(work.eagleId);
    const hit = this.indexed.get(key);
    return hit ? hit.eagleId : null;
  }

  pidOfEagle(eagleId) {
    this.load();
    const key = String(eagleId || '');
    if (this.byEagle.has(key)) return this.byEagle.get(key);
    for (const [pid, hit] of this.indexed) {
      if (hit.eagleId === key) return pid;
    }
    return null;
  }

  record(work) {
    this.load();
    const pid = String(work.pid || '');
    if (!pid) throw new Error('pixiv library: pid が無い');
    const row = {
      eagleId: String(work.eagleId || ''),
      userId: String(work.userId || ''),
      userName: String(work.userName || ''),
      title: String(work.title || ''),
      caption: String(work.caption || ''),
      tags: Array.isArray(work.tags) ? work.tags.map(String).filter(Boolean) : [],
      ai: work.ai === true,
      r18: work.r18 === true,
      date: String(work.date || ''),
      pages: Number(work.pages) || 0,
      series: work.series && work.series.id ? { id: String(work.series.id), title: String(work.series.title || ''), order: Number(work.series.order) || 0 } : null,
      addedAt: Number(work.addedAt) || this.now(),
    };
    this.data.works[pid] = row;
    if (row.eagleId) this.byEagle.set(row.eagleId, pid);
    this.indexed.delete(pid);
    this.save();
    return row;
  }

  forget(eagleId) {
    this.load();
    const pid = this.byEagle.get(String(eagleId || ''));
    if (!pid) return false;
    delete this.data.works[pid];
    this.byEagle.delete(String(eagleId));
    this.save();
    return true;
  }

  // --- 作者 (名乗り ↔ 作者フォルダ) ------------------------------------------------

  creatorBindings() {
    this.load();
    return this.data.creators || {};
  }

  creatorFolder(userId) {
    this.load();
    const hit = this.data.creators[String(userId || '')];
    return hit && hit.folderId ? { folderId: String(hit.folderId), name: String(hit.name || '') } : null;
  }

  bindCreator(userId, folderId, name = '') {
    this.load();
    const key = String(userId || '');
    if (!key || !folderId) return null;
    this.data.creators[key] = { folderId: String(folderId), name: String(name || '') };
    this.save();
    return this.data.creators[key];
  }

  // 結びを外す (Home の詳細の「外す」)。folderId を渡したら、その作者フォルダに結ばれている時だけ外す
  unbindCreator(userId, folderId = null) {
    this.load();
    const key = String(userId || '');
    const hit = key ? this.data.creators[key] : null;
    if (!hit) return false;
    if (folderId != null && String(hit.folderId) !== String(folderId)) return false;
    delete this.data.creators[key];
    this.save();
    return true;
  }

  // 作者フォルダの名前と表示名を照らす。一致は一つの時だけ (二つ以上なら決めない)
  static matchCreatorFolder(name, folders) {
    const key = foldName(name);
    if (!key) return null;
    const hits = (folders || []).filter((folder) => foldName(folder.name) === key);
    return hits.length === 1 ? hits[0] : null;
  }

  // 補完に混ぜる作者 (台帳に居る名乗り)。網に出ずに出せる
  creatorsMatching(term, limit = 5) {
    this.load();
    const key = foldName(term);
    if (!key) return [];
    const out = [];
    for (const [userId, creator] of Object.entries(this.data.creators)) {
      if (foldName(creator.name).includes(key)) out.push({ userId, name: creator.name });
      if (out.length >= limit) break;
    }
    return out;
  }

  // --- 索引との突き合わせ ----------------------------------------------------------
  // 消えた項目 (isDeleted・索引に無い) を落とし、台帳に無い pixiv の項目 (url で分かる) を
  // 最小の情報で拾う。付け直しの候補 (名前に ID、url 無し) も数える

  reconcile(entriesArg = null) {
    this.load();
    const entries = entriesArg || (typeof this.indexEntries === 'function' ? this.indexEntries() : null);
    if (!entries) return { dropped: 0, adopted: 0, legacy: [] };
    const alive = new Map();      // eagleId → meta
    const legacy = [];
    this.indexed = new Map();
    for (const [key, entry] of entries) {
      const meta = entry && entry.meta;
      if (!meta || meta.isDeleted) continue;
      const eagleId = String(key).replace(/\.info$/i, '');
      alive.set(eagleId, meta);
      const pid = pidFromUrl(meta.url);
      if (pid) {
        if (!this.data.works[pid]) {
          this.indexed.set(pid, { eagleId, name: String(meta.name || ''), folders: meta.folders || [], star: meta.star });
        }
        continue;
      }
      const old = String(meta.name || '').match(LEGACY_NAME);
      if (old && !meta.url) legacy.push({ eagleId, pid: old[1], name: String(meta.name || ''), folders: meta.folders || [] });
    }
    let dropped = 0;
    for (const [pid, work] of Object.entries(this.data.works)) {
      if (work && work.eagleId && !alive.has(work.eagleId)) {
        delete this.data.works[pid];
        dropped += 1;
      }
    }
    if (dropped) {
      this.rebuildReverse();
      this.save();
    }
    this.legacy = legacy;
    return { dropped, adopted: this.indexed.size, legacy };
  }

  legacyCandidates() {
    this.load();
    return Array.isArray(this.legacy) ? this.legacy : [];
  }

  // --- 札 -----------------------------------------------------------------------

  toGallery(pid) {
    this.load();
    const key = String(pid);
    const work = this.data.works[key];
    const indexed = this.indexed.get(key);
    if (!work && !indexed) return null;
    const eagleId = work ? work.eagleId : indexed.eagleId;
    const title = work ? work.title : indexed.name;
    const userName = work ? work.userName : this.creatorNameFor(indexed);
    const pages = work ? work.pages : 0;
    return {
      id: `px:${key}`,
      source: 'pixiv',
      sourceId: eagleId,
      title: title || key,
      caption: work ? work.caption || '' : '',
      type: '',
      language: null,
      artists: userName ? [{ type: 'artist', name: userName, negative: false, userId: work ? work.userId : '' }] : [],
      groups: [],
      series: [],
      characters: [],
      tags: (work ? work.tags : []).map((name) => ({ type: 'tag', name, negative: false })),
      pageCount: pages,
      badge: pages ? `${pages}p` : '',
      addedDate: work && work.addedAt ? new Date(work.addedAt).toISOString() : null,
      publishedDate: work ? work.date || null : null,
      isBlocked: false,
      hasVideo: false,
      url: artworkUrl(key),
      offline: true,
      owned: true,
      kind: 'eagleItem',
      eagleId,
      userId: work ? work.userId : '',
      ai: work ? work.ai : false,
      r18: work ? work.r18 : false,
      star: indexed && Number.isFinite(Number(indexed.star)) ? Number(indexed.star) : 0,
    };
  }

  creatorNameFor(indexed) {
    if (!indexed || typeof this.creatorNameOf !== 'function') return '';
    for (const folderId of indexed.folders || []) {
      const name = this.creatorNameOf(String(folderId));
      if (name) return name;
    }
    return '';
  }

  // 網の札に済の印。source が pixiv の物だけ触る
  annotate(galleries) {
    this.load();
    return (galleries || []).map((gallery) => {
      if (!gallery || gallery.error || gallery.source !== 'pixiv') return gallery;
      if (gallery.kind === 'eagleItem' || gallery.kind === 'creator') return gallery;
      const pid = String(gallery.id || '').replace(/^px:/, '');
      const eagleId = this.eagleIdOf(pid);
      if (!eagleId) return gallery;
      return { ...gallery, owned: true, idOwned: true, eagleId };
    });
  }

  // 所持棚 (所持 + pixiv)。語は 題・タグ・作者名 に当てる。並びは 新着 / タイトル / 読了回数 / 最終読了日
  search({ query = '', sort = 'added', type = '', page = 0, pageSize = 24, reading = null } = {}) {
    this.load();
    const words = String(query || '').trim().split(/\s+/).filter(Boolean).map(foldName);
    const rows = [];
    for (const pid of Object.keys(this.data.works)) rows.push(this.toGallery(pid));
    for (const pid of this.indexed.keys()) rows.push(this.toGallery(pid));
    let list = rows.filter(Boolean);
    // 種別の AI (網の棚と同じ札)。素性を貰っていない項目は AI と分からないので出さない
    if (String(type || '').split('-').includes('ai')) list = list.filter((g) => g.ai === true);
    if (words.length) {
      list = list.filter((g) => {
        const hay = foldName([g.title, ...(g.tags || []).map((t) => t.name), ...(g.artists || []).map((a) => a.name)].join(' '));
        return words.every((word) => hay.includes(word));
      });
    }
    const mark = (g) => (reading && g.eagleId ? reading[`pweagle:${g.eagleId}`] || reading[g.id] || null : null);
    const sorters = {
      added: (a, b) => (Date.parse(b.addedDate || 0) || 0) - (Date.parse(a.addedDate || 0) || 0) || String(b.eagleId).localeCompare(String(a.eagleId)),
      title: (a, b) => String(a.title).localeCompare(String(b.title), 'ja'),
      reread: (a, b) => ((mark(b) || {}).finishedCount || 0) - ((mark(a) || {}).finishedCount || 0),
      finished: (a, b) => ((mark(b) || {}).finishedAt || 0) - ((mark(a) || {}).finishedAt || 0),
    };
    list.sort(sorters[sort] || sorters.added);
    const start = page * pageSize;
    return {
      total: list.length,
      page,
      pageSize,
      hasNext: start + pageSize < list.length,
      galleries: list.slice(start, start + pageSize),
    };
  }

  stats() {
    this.load();
    return { works: Object.keys(this.data.works).length, indexed: this.indexed.size, creators: Object.keys(this.data.creators).length };
  }
}

module.exports = { PixivLibrary, pidFromUrl, artworkUrl, foldName, LEGACY_NAME };
