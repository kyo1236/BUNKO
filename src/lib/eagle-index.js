'use strict';

// Eagle ライブラリの全アイテム (<id>.info) の metadata.json 要約と、その差分読み。
//
// 台帳の走査 (catalog.collectEagleScan) と pawchive の走査 (paw-library) は、同じ
// 6,967 件の metadata.json を別々に stat していた (母艦は D: が SMB で、読み直し 0 件
// でも 4 秒 + 2 秒)。ここ一か所に寄せて、両方が同じ控えを読む。
//
// 差分の検知は Eagle 自身が保つ <library>/mtime.json を読むだけで済ませる。
// 全アイテムの更新時刻が 1 ファイル (200 KB 前後) に入っていて、読み込みは数 ms。
// 前回控えた値 (mj) と同じアイテムは metadata.json を開かず控えをそのまま使う。
//
// 保険として、次のどれかなら従来どおり全件を stat する (実体の mtime+size で比べる):
//   - mtime.json が無い / 壊れている
//   - 控えが無い・版が違う (初回・更新直後)
//   - 前回の全走査から FULL_SCAN_INTERVAL 経った (mtime.json が追いつかない稀な更新の
//     取りこぼし用。実測では 6,964 件中 37 件が mtime.json の方が古かった)
//   - 明示 (設定の「再スキャン」釦)

const fs = require('fs');
const path = require('path');
const stateFile = require('./state-file');

// **shapeMeta の出力の版**。整形の仕方を変えたら必ず上げる (控えのファイル書式の版ではない)。
// 3 → 4: addedAt が往復で消えていたのを直した回。
// 受け入れ表 (load) には 3 と 2 も残す: 版違いで entries を捨てると、
// 新しい控えが同期で届くまで写しが毎起動 26,468 件を読み直すことになる
const CACHE_VERSION = 4;
// 受け入れる控えの版。古い版も読む (捨てると全件読みに戻るため)
const ACCEPT_VERSIONS = new Set([2, 3, 4]);
const FULL_SCAN_INTERVAL = 24 * 60 * 60 * 1000;
const BATCH = 32;

// 台帳と paw の両方が使う項目だけを控える (metadata.json 全体は持たない)
function shapeMeta(parsed) {
  const source = parsed && typeof parsed === 'object' ? parsed : {};
  return {
    name: source.name || '',
    annotation: source.annotation || '',
    url: source.url || '',
    star: source.star,
    folders: Array.isArray(source.folders) ? source.folders.map(String) : [],
    isDeleted: !!source.isDeleted,
    tags: Array.isArray(source.tags) ? source.tags.map(String).filter(Boolean) : [],
    // **自分の出力を食わせても同じ物を返すこと (冪等)。**
    // save() は整形済みの meta をそのまま書き、load() がそれをもう一度ここへ通す。
    // 入力の addedAt を見ていなかったので二度目で必ず null になり、
    // 既定の並び「保存日」が蔵書の一冊も効いていなかった (項目 2-1)。
    // 優先順 (modificationTime が先) は今のまま: Eagle 側で何が動くかを
    // 確かめるまで入れ替えない。入れ替えると並びが静かに変わる
    addedAt: Number(
      source.addedAt || source.modificationTime || source.btime || source.lastModified || 0,
    ) || null,
    ext: String(source.ext || ''),
  };
}

function infoName(id) {
  return `${id}.info`;
}

class EagleIndex {
  constructor({ libraryRoot, cachePath }) {
    this.root = String(libraryRoot || '').trim();
    this.cachePath = String(cachePath || '');
    // name (<id>.info) → { mtimeMs, size, mj, meta }
    this.entries = new Map();
    this.fullScanAt = 0;
    // 版を上げた回だけ立つ: 整形をやり直すまで近道 (mtime が同じなら読まない) を外す
    this.reshapePending = false;
    // 自分で付けた星 (Eagle の書き出しが追いつくまでの上書き)
    this.own = new Map();
    this.loaded = false;
    // 中身が変わるたびに進む番号。呼び手はこれで「前に組んだ物が古いか」を見る
    this.generation = 0;
    this.refreshing = null;
    this.lastResult = null;
  }

  imagesDir() {
    return path.join(this.root, 'images');
  }

  mtimeJsonPath() {
    return path.join(this.root, 'mtime.json');
  }

  // 差し替えの目印。mtime.json の (size:mtime)。無ければ images の mtime
  stampNow() {
    try {
      const stat = fs.statSync(this.mtimeJsonPath());
      return `${stat.size}:${stat.mtimeMs}`;
    } catch {
      try {
        return `dir:${fs.statSync(this.imagesDir()).mtimeMs}`;
      } catch {
        return '';
      }
    }
  }

  // 控えの読み込み。無い・壊れている・版違い・別ライブラリなら空から (全件読みに戻るだけ)。
  // 版 2 (mj 無し) は項目だけ引き継ぎ、次の走査を全件にする
  load() {
    if (this.loaded) return this.entries;
    this.loaded = true;
    if (!this.cachePath) return this.entries;
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
    } catch {
      return this.entries;
    }
    if (!parsed || !parsed.items || typeof parsed.items !== 'object') return this.entries;
    // 版違いでも entries は引き継ぐ。捨てると母艦も写しも全件読みからやり直しになり、
    // 写しは新しい控えが同期で届くまで毎起動それを繰り返す
    if (!ACCEPT_VERSIONS.has(parsed.version)) return this.entries;
    // root は記録するだけで照合しない: 母艦 (D:storage...) が写した控えを、同じライブラリを
    // 別のパス (C:...storage...) で開く Homecore がそのまま使えるように。項目は
    // <id>.info で引き、mtime.json の値も同じファイルなので機体をまたいで意味が変わらない
    for (const [name, entry] of Object.entries(parsed.items)) {
      if (!entry || typeof entry !== 'object' || !entry.meta) continue;
      this.entries.set(name, {
        mtimeMs: Number(entry.mtimeMs) || 0,
        size: Number(entry.size) || 0,
        mj: Number(entry.mj) || 0,
        meta: shapeMeta(entry.meta),
      });
    }
    // 版が上がった回は、母艦が一度だけ全件を払って整形し直す (避ける道は無い)。
    // 写しは払わせない: 書き出せない機体に 26,468 件を読ませても一つも得が無く、
    // 母艦が組み直した控えが同期で届くのを待てばよい
    const stale = parsed.version !== CACHE_VERSION;
    this.fullScanAt = (stale && !stateFile.roleIsMirror())
      ? 0
      : (Number(parsed.fullScanAt) || 0);
    // 版が古い控えは、整形をやり直すまで addedAt が欠けている。母艦だけが直せる
    this.reshapePending = stale && !stateFile.roleIsMirror();
    // 自分で付けた星を最後に被せる (Eagle の書き出しが追いつくまでの間)
    this.loadOwn();
    return this.entries;
  }

  // 書き出しの番人はここ一箇所。写しの機体は書かない: 検索結果を描くだけでも
  // annotate → revalidateSoon → refresh → save まで届くので、呼び手側で塞ぐと漏れる。
  // 原子的に書くのも state-file の仕事 (6 MB を素で書くと、途中で終了した回に
  // 半端な JSON が残り、次の起動で丸ごと捨てられて全件走査に戻っていた)
  // 整形のやり直しが済んだ印を降ろす。次の走査からは近道が効く
  markReshaped() {
    this.reshapePending = false;
  }

  // 自分で付けた星の置き場。控え本体 (6 MB) と分けて**一行ずつ追記**する。
  // ★を一つ押すたびに 26,468 件を JSON にして書き直すわけにいかない (項目 3-1)
  ownPath() {
    return this.cachePath ? `${this.cachePath}.own.jsonl` : '';
  }

  // 利用者が付けた星を憶える。Eagle 側の metadata.json は Eagle アプリの API が
  // 書く (こちらは触らない) が、書き出しは遅れるので、追いつくまでこちらを被せる。
  // これが無いと、★を押した直後の走査が古い meta を返して棚から巻き戻っていた
  noteOwnStar(eagleId, star) {
    const name = infoName(String(eagleId || ''));
    if (!name || !this.ownPath()) return false;
    const value = Number(star);
    const entry = this.entries.get(name);
    if (entry && entry.meta) entry.meta = { ...entry.meta, star: value };
    this.own.set(name, value);
    this.generation += 1;
    return stateFile.appendLine('eagle-index', this.ownPath(), JSON.stringify({ n: name, s: value }));
  }

  // 追記した星を控えへ重ねる。半端な行 (書き込みの途中で落ちた回) は捨てる
  loadOwn() {
    this.own = new Map();
    const file = this.ownPath();
    if (!file) return;
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return;                       // 無いのが普通 (★を一度も押していない)
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row && row.n) this.own.set(String(row.n), Number(row.s));
      } catch {
        // 半端な行は落とす (次の save で書き直る)
      }
    }
    for (const [name, star] of this.own) {
      const entry = this.entries.get(name);
      if (entry && entry.meta) entry.meta = { ...entry.meta, star };
    }
  }

  // 控えを書き切ったら追記ぶんは畳み込み済み。置き場を空にする
  clearOwn() {
    const file = this.ownPath();
    if (!file || !this.own || !this.own.size) return;
    this.own = new Map();
    try {
      fs.unlinkSync(file);
    } catch {
      // 消せなくても次の load が控えと同じ値を重ねるだけ
    }
  }

  save() {
    if (!this.cachePath) return;
    const wrote = stateFile.writeJson('eagle-index', this.cachePath, {
      version: CACHE_VERSION,
      root: this.root,
      fullScanAt: this.fullScanAt,
      items: Object.fromEntries(this.entries),
    });
    // 控えに畳み込めたので、追記ぶんはもう要らない
    if (wrote) this.clearOwn();
  }

  // id → 更新時刻 (ms)。無い・壊れているときは null (全件読みへ)
  readMtimeJson() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.mtimeJsonPath(), 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      const map = new Map();
      for (const [id, value] of Object.entries(parsed)) {
        const stamp = Number(value);
        if (id && Number.isFinite(stamp)) map.set(id, stamp);
      }
      return map.size ? map : null;
    } catch {
      return null;
    }
  }

  // 控えが無い (初回・版違い) ときだけ自動で全件へ。一日一度の保険の全件走査は
  // 呼び手 (main の見張り) が起動から時間を置いて full: true で頼む — 起動直後に
  // 回すと stat の嵐が表紙の読みを塞ぐ
  needsFullScan() {
    // 版 2 からの引き継ぎ直後 (fullScanAt が無い) も一度は全件: mj を覚えるため
    return !this.entries.size || !this.fullScanAt;
  }

  fullScanStale() {
    return Date.now() - this.fullScanAt > FULL_SCAN_INTERVAL;
  }

  // 走査の本体。同時には一本だけ (裏の温めと台帳の走査が重なっても同じ結果を待つ)。
  // 返り値: { entries, reread, total, mode: 'diff' | 'full', changed }
  refresh({ full = false, onProgress } = {}) {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.walk({ full, onProgress }).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  async walk({ full, onProgress }) {
    this.load();
    const imagesDir = this.imagesDir();
    // 読めないライブラリを「0 件」にしない: 呼び手へ失敗として返す
    await fs.promises.access(imagesDir, fs.constants.R_OK);

    const mtimeJson = this.readMtimeJson();
    const useDiff = !full && !this.needsFullScan() && Boolean(mtimeJson);
    const mjOf = new Map();
    let names;
    if (useDiff) {
      names = [];
      for (const [id, stamp] of mtimeJson) {
        const name = infoName(id);
        names.push(name);
        mjOf.set(name, stamp);
      }
      // 控えにはあるが mtime.json に載っていないアイテム (Eagle が書き漏らした物。
      // 実測で 6,967 件中 2 件) は消さずに実体へ訊く。mj が無いので毎回 stat になるが数件
      for (const name of this.entries.keys()) {
        if (!mjOf.has(name)) names.push(name);
      }
    } else {
      const dirs = await fs.promises.readdir(imagesDir, { withFileTypes: true });
      names = dirs
        .filter((entry) => entry.isDirectory() && entry.name.endsWith('.info'))
        .map((entry) => entry.name);
      if (mtimeJson) {
        for (const [id, stamp] of mtimeJson) mjOf.set(infoName(id), stamp);
      }
    }

    const next = new Map();
    const toCheck = [];
    const total = names.length;
    let scanned = 0;
    let reread = 0;
    for (const name of names) {
      const prior = this.entries.get(name);
      const mj = mjOf.get(name) || 0;
      // 差分読み: mtime.json の値が前回と同じなら stat すらしない
      if (useDiff && prior && prior.mj && prior.mj === mj) {
        next.set(name, prior);
        scanned += 1;
        continue;
      }
      toCheck.push(name);
    }
    if (onProgress) onProgress({ scanned, total, reread });

    for (let base = 0; base < toCheck.length; base += BATCH) {
      const chunk = toCheck.slice(base, base + BATCH);
      await Promise.all(chunk.map(async (name) => {
        const metaPath = path.join(imagesDir, name, 'metadata.json');
        try {
          const stat = await fs.promises.stat(metaPath);
          const prior = this.entries.get(name);
          const mj = mjOf.get(name) || 0;
          // 近道: 実体が動いていなければ metadata.json を読み直さない。
          // ただし**整形をやり直す回だけは通さない** — 版を上げても、動いていない
          // アイテムはここで弾かれるので、欠けた addedAt が永久に埋まらない
          const shaped = !this.reshapePending || (prior && prior.meta && prior.meta.addedAt != null);
          if (shaped && prior && prior.mtimeMs === stat.mtimeMs && prior.size === stat.size) {
            next.set(name, prior.mj === mj ? prior : { ...prior, mj });
            return;
          }
          // (据え置く側の meta は load/noteOwnStar で既に星が被さっている)
          const parsed = JSON.parse(await fs.promises.readFile(metaPath, 'utf8'));
          const meta = shapeMeta(parsed);
          // Eagle がまだ星を書き出していなければ、自分で付けた値を被せたままにする。
          // 被せないと、押した直後の走査で棚の★が古い値へ巻き戻る (項目 3-1)
          if (this.own && this.own.has(name)) meta.star = this.own.get(name);
          next.set(name, { mtimeMs: stat.mtimeMs, size: stat.size, mj, meta });
          reread += 1;
        } catch {
          // 読めないアイテムは控えにも残さず次回また試す (mtime.json に居て実体が無い物も同じ)
        }
      }));
      scanned += chunk.length;
      if (onProgress) onProgress({ scanned: Math.min(scanned, total), total, reread });
      await new Promise((resolve) => setImmediate(resolve));
    }

    let changed = reread > 0 || next.size !== this.entries.size;
    if (!changed) {
      for (const name of next.keys()) {
        if (!this.entries.has(name)) {
          changed = true;
          break;
        }
      }
    }
    if (!useDiff) {
      this.fullScanAt = Date.now();
      // 全件を回ったので、整形のやり直しは済んだ。次からは近道が効く
      this.markReshaped();
    }
    this.entries = next;
    if (changed) this.generation += 1;
    if (changed || !useDiff) this.save();
    this.lastResult = { reread, total, mode: useDiff ? 'diff' : 'full', changed, at: Date.now() };
    return { entries: next, reread, total, mode: useDiff ? 'diff' : 'full', changed };
  }
}

// ライブラリごとに一つ。台帳と paw が同じ物を掴む
const registry = new Map();

// 索引は「ライブラリの道ごとに一つ」。**鍵は必ず trim する** (項目 2-5)。
// 呼び手によって trim したりしなかったりで、同じライブラリに索引が二つ生まれ、
// 片方は fullScanAt を持たないので全件走査が回り続ける、という形になっていた
function indexFor(libraryRoot, cachePath) {
  const root = String(libraryRoot || '').trim();
  let index = registry.get(root);
  if (!index) {
    index = new EagleIndex({ libraryRoot: root, cachePath });
    registry.set(root, index);
  } else if (cachePath && !index.cachePath) {
    index.cachePath = cachePath;
  }
  return index;
}

// 単体試験用: 覚えた索引を捨てる
function resetForTest() {
  registry.clear();
}

module.exports = {
  EagleIndex, indexFor, shapeMeta, resetForTest, CACHE_VERSION, FULL_SCAN_INTERVAL,
};
