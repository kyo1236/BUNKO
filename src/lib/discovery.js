const fs = require('fs');
const path = require('path');
const https = require('https');
const { writeFileAtomicSync } = require('./atomic-file');

// 発見タブのエンジン。枠は二つだけ:
//   新作の見張り: よく集めている作家の「最終取得作より後」の日本語新作
//   発掘:         同じ作家群の「年間人気上位なのに未所持」
// どちらも「証拠つき・少数・一度見せたら沈む」。無限フィードにはしない。
//
// 「知らない」と「見送った」の区別は表示台帳 (discovery_shown) が時間をかけて行う:
// 見せて保存されなければ回を追うごとに長く沈む。明示の × ボタンは置かない
// (押すのが面倒、という本人の要望)。

// nozomi は 4 byte/ID の生列。hitomi-service と同じ資源ドメインを使う
const NOZOMI_HOST = 'ltn.gold-usergeneratedcontent.net';

// 集める対象の作家数。多いほど巡回が長くなるだけで、枠の性質は変わらない
const FOLLOW_LIMIT = 18;
const BACKLOG_ARTISTS = 12;

// 一回の巡回で許すメタデータ取得 (galleries/<id>.js) の総数。nozomi と違い
// 1 件 1 リクエストで重いので、ここで頭を抑えて礼儀を保つ
const META_BUDGET = 110;
const PACE_MS = 500;

// 巡回結果の寿命。これより古い表示要求は裏で巡回をやり直す
const CACHE_TTL = 12 * 60 * 60 * 1000;

// 表示台帳のクールダウン。回を追うごとに沈む: 「たまに回ってくる」を狙って作る
const COOLDOWNS = [0, 14, 45, 120]; // 表示 n 回後に眠る日数 (3 回目以降は 120 日)
const SHOWN_DEBOUNCE = 20 * 60 * 60 * 1000; // 同じ日の開き直しは回数に数えない

const DAY = 24 * 60 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 巡回の一往復。**期限を必ず置く** (項目 7-1)。
// 以前はここに期限が一つも無く、相手が返事を止めたまま繋ぎっぱなしにすると
// この promise が永久に止まり、発見タブの巡回が再起動まで二度と回らなかった。
// 応答が始まらない・始まっても続きが来ない、の両方を見る
const NOZOMI_TIMEOUT = 20 * 1000;

function fetchNozomi(pathname) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: NOZOMI_HOST,
      path: pathname,
      headers: { referer: 'https://hitomi.la/' },
      timeout: NOZOMI_TIMEOUT,
    }, (res) => {
      const chunks = [];
      // 受け取りの途中で止まった時も切る (headers だけ来て body が続かない形)
      res.setTimeout(NOZOMI_TIMEOUT, () => req.destroy(new Error('nozomi: 応答が途切れました')));
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        const buf = Buffer.concat(chunks);
        const ids = [];
        for (let i = 0; i + 4 <= buf.length; i += 4) ids.push(buf.readUInt32BE(i));
        resolve(ids);
      });
    });
    req.on('timeout', () => req.destroy(new Error('nozomi: 応答がありません')));
    req.on('error', reject);
    req.end();
  });
}

// 作家名 → nozomi のパス。hitomi はタグ名の空白を %20 のまま使う
function artistNozomiPath(artist, orderBy = '') {
  return `/n/artist/${orderBy}${encodeURIComponent(artist)}-japanese.nozomi`;
}

class Discovery {
  constructor({ catalog, cachePath }) {
    this.catalog = catalog || null;
    this.cachePath = cachePath;
    this.refreshing = false;
    this.progress = { phase: '', done: 0, total: 0 };
    this.lastError = '';
  }

  db() {
    return this.catalog && this.catalog.db ? this.catalog.db : null;
  }

  init() {
    const db = this.db();
    if (!db) return this;
    db.run(`
      CREATE TABLE IF NOT EXISTS discovery_shown (
        gallery_id INTEGER PRIMARY KEY,
        section TEXT NOT NULL,
        shown_count INTEGER NOT NULL DEFAULT 0,
        first_shown INTEGER,
        last_shown INTEGER
      );
    `);
    return this;
  }

  // ---- 好みプロファイル (完全ローカル) ----

  // 「フォロー」は手動登録ではなく所持実績から導く: 3 冊以上持っている作家。
  // 錨 (anchor) はその作家の所持作で最新の公開日。それより古い未所持は
  // 「見た上で見送った」可能性が高いので、新作枠では出さない
  followedArtists() {
    if (!this.db()) return [];
    const rows = this.catalog.queryRows(`
      SELECT gt.name AS artist,
             COUNT(DISTINCT g.id) AS owned,
             AVG(COALESCE(i.star, 0)) AS avg_star,
             MAX(g.published_date) AS anchor
      FROM gallery_tags gt
      JOIN galleries g ON g.id = gt.gallery_id
      JOIN items i ON i.gallery_id = g.id
      WHERE gt.type = 'artist'
      GROUP BY gt.name
      HAVING owned >= 3
    `);
    return rows
      .map((row) => ({
        artist: String(row.artist),
        owned: Number(row.owned),
        avgStar: Math.round(Number(row.avg_star) * 100) / 100,
        anchor: row.anchor ? String(row.anchor) : null,
        score: Number(row.owned) * 0.5 + Number(row.avg_star) * 2,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, FOLLOW_LIMIT);
  }

  ownedIdSet() {
    return this.catalog ? this.catalog.idSet : new Set();
  }

  // ---- 巡回 ----

  async getMeta(id) {
    try {
      const service = require('./hitomi-service');
      return service.serializeGallery(await service.getGallery(id));
    } catch {
      return null;
    }
  }

  itemFrom(meta, reason) {
    return {
      id: meta.id,
      source: 'hitomi',
      title: meta.title,
      type: meta.type,
      language: meta.language,
      artists: meta.artists,
      groups: meta.groups,
      series: meta.series,
      characters: meta.characters,
      tags: meta.tags,
      pageCount: meta.pageCount,
      publishedDate: meta.publishedDate,
      url: meta.url,
      reason,
    };
  }

  async refresh() {
    if (this.refreshing) return { started: false };
    if (!this.db()) return { started: false };
    this.refreshing = true;
    this.lastError = '';
    try {
      const owned = this.ownedIdSet();
      const followed = this.followedArtists();
      let budget = META_BUDGET;
      // 合作誌は複数の作家のリストに同じ ID で現れる: 一度拾ったものは拾い直さない
      const seen = new Set();

      // 新作の見張り: 追加日順 nozomi の先頭から、錨より新しい未所持だけ。
      // nozomi は新しい順なので、錨より古い作品に当たったらその作家は打ち切り
      this.progress = { phase: 'new', done: 0, total: followed.length };
      const newReleases = [];
      for (const entry of followed) {
        this.progress.done += 1;
        if (budget <= 0) break;
        const ids = await fetchNozomi(artistNozomiPath(entry.artist));
        await sleep(PACE_MS);
        if (!ids || !ids.length) continue;
        const anchorTime = entry.anchor ? new Date(entry.anchor).getTime() : 0;
        let taken = 0;
        for (const id of ids) {
          if (taken >= 2 || budget <= 0) break;
          if (owned.has(String(id)) || seen.has(id)) continue;
          budget -= 1;
          const meta = await this.getMeta(id);
          await sleep(PACE_MS);
          if (!meta) continue;
          // タイトル一致の所持 (連携漏れ・別版) は推薦に混ぜない
          if (this.catalog.isOwned(id, meta.title)) continue;
          const published = meta.publishedDate ? new Date(meta.publishedDate).getTime() : 0;
          if (published <= anchorTime) break;
          seen.add(id);
          newReleases.push(this.itemFrom(meta, {
            kind: 'new',
            artist: entry.artist,
            owned: entry.owned,
            avgStar: entry.avgStar,
            anchor: entry.anchor,
            totalJa: ids.length,
          }));
          taken += 1;
        }
      }

      // 発掘: 年間人気順の上位から未所持を拾う。人気順位そのものが
      // 「知らなかった可能性」の証拠になる (人気なのに持っていない)
      this.progress = { phase: 'backlog', done: 0, total: Math.min(followed.length, BACKLOG_ARTISTS) };
      const backlog = [];
      for (const entry of followed.slice(0, BACKLOG_ARTISTS)) {
        this.progress.done += 1;
        if (budget <= 0) break;
        const ids = await fetchNozomi(artistNozomiPath(entry.artist, 'popular/year/'));
        await sleep(PACE_MS);
        if (!ids || !ids.length) continue;
        let picks = 0;
        let inspected = 0;
        for (let rank = 0; rank < ids.length && picks < 3 && inspected < 8 && budget > 0; rank += 1) {
          const id = ids[rank];
          if (owned.has(String(id)) || seen.has(id)) continue;
          inspected += 1;
          budget -= 1;
          const meta = await this.getMeta(id);
          await sleep(PACE_MS);
          if (!meta) continue;
          if (this.catalog.isOwned(id, meta.title)) continue;
          seen.add(id);
          backlog.push(this.itemFrom(meta, {
            kind: 'backlog',
            artist: entry.artist,
            owned: entry.owned,
            popRank: rank + 1,
            popTotal: ids.length,
          }));
          picks += 1;
        }
      }
      // 母数の大きい作家の上位ほど前に出す
      backlog.sort((a, b) => (a.reason.popRank / a.reason.popTotal) - (b.reason.popRank / b.reason.popTotal));

      const cache = {
        generatedAt: Date.now(),
        followed: followed.map(({ artist, owned: n, avgStar, anchor }) => ({ artist, owned: n, avgStar, anchor })),
        newReleases,
        backlog,
      };
      writeFileAtomicSync(this.cachePath, JSON.stringify(cache));
      return { started: true, newReleases: newReleases.length, backlog: backlog.length };
    } catch (error) {
      this.lastError = error && error.message ? String(error.message) : 'refresh failed';
      return { started: true, error: this.lastError };
    } finally {
      this.refreshing = false;
      this.progress = { phase: '', done: 0, total: 0 };
    }
  }

  readCache() {
    try {
      return JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
    } catch {
      return null;
    }
  }

  // ---- 表示台帳 ----

  shownRows() {
    if (!this.db()) return new Map();
    const map = new Map();
    for (const row of this.catalog.queryRows(
      'SELECT gallery_id, shown_count, last_shown FROM discovery_shown',
    )) {
      map.set(Number(row.gallery_id), {
        count: Number(row.shown_count),
        last: Number(row.last_shown) || 0,
      });
    }
    return map;
  }

  cooldownUntil(entry) {
    if (!entry || !entry.count) return 0;
    const days = COOLDOWNS[Math.min(entry.count, COOLDOWNS.length - 1)];
    return entry.last + days * DAY;
  }

  // 実際に画面へ出した作品を記録する。同じ日の開き直しは数えない:
  // クールダウンは「目に入った回数」に対して伸ばしたい
  markShown(items) {
    if (!this.db() || !items.length) return;
    const now = Date.now();
    const shown = this.shownRows();
    this.catalog.runWhenWritable(() => {
      const db = this.db();
      if (!db) return;
      for (const item of items) {
        const prev = shown.get(Number(item.id));
        if (prev && now - prev.last < SHOWN_DEBOUNCE) continue;
        db.run(`
          INSERT INTO discovery_shown(gallery_id, section, shown_count, first_shown, last_shown)
          VALUES (?, ?, 1, ?, ?)
          ON CONFLICT(gallery_id) DO UPDATE SET
            shown_count = shown_count + 1,
            last_shown = excluded.last_shown
        `, [Number(item.id), String(item.reason && item.reason.kind || ''), now, now]);
      }
      this.catalog.persistSoon();
    });
  }

  // ---- 表示 ----

  // キャッシュを台帳・所持で漉して返す。古ければ裏で巡回を始める (待たない)
  view() {
    const cache = this.readCache();
    const stale = !cache || (Date.now() - cache.generatedAt > CACHE_TTL);
    if (stale && !this.refreshing) {
      this.refresh(); // 待たない: 返した画面は古いまま、次の開きで新しくなる
    }
    if (!cache) {
      return {
        empty: true,
        refreshing: this.refreshing,
        progress: this.progress,
        error: this.lastError,
      };
    }

    const now = Date.now();
    const shown = this.shownRows();
    const serve = (items) => (items || [])
      // 巡回後に保存したものは 済 になっている: 出しても仕方がない
      .filter((item) => !this.catalog.isOwned(item.id, item.title))
      // 所持済みの版違い (再掲・微修正版) は発見に出しても仕方がない
      .filter((item) => !this.catalog.isSimilarOwned(item))
      .filter((item) => {
        const entry = shown.get(Number(item.id));
        if (!entry || !entry.count) return true;
        // 見せた直後 (デバウンス内) は「今日の顔ぶれ」として据え置く。
        // 表示した瞬間から沈めると、作品を見て戻ってきただけで一覧が
        // 消えてしまい道具にならない。沈むのはデバウンスが明けてから
        if (now - entry.last < SHOWN_DEBOUNCE) return true;
        return now >= this.cooldownUntil(entry);
      });

    const newReleases = serve(cache.newReleases);
    const backlog = serve(cache.backlog);
    this.markShown([...newReleases, ...backlog]);

    return {
      generatedAt: cache.generatedAt,
      refreshing: this.refreshing,
      progress: this.progress,
      error: this.lastError,
      followed: cache.followed,
      newReleases,
      backlog,
    };
  }
}

module.exports = { Discovery };
