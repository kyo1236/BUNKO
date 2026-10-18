const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const {
  nfkc, aliasKey, romajiToKata, hasCjk,
} = require('./search-text');
const {
  rewriteQuery, parseTypePrefix, setDynamicSource, loadData: loadAliasData,
} = require('./search-aliases');
const { unpackedPath } = require('./asar-path');
const trace = require('./trace');
// ID の判定・組み立てと星の丸めは sources/normalize (実体は sources/ids) に集約
const {
  numericGalleryId, galleryKeyOf, pawEagleGalleryId, normalizeStar,
} = require('./sources/normalize');

// 題の鍵・巻数・シリーズの読み方は title-keys へ切り出してある
// (library-match / creator-labels がここだけを引けるように)
const {
  tagNameKey, titleNeedle, META_TAG_GROUPS, metaTagRows,
  titleKey, titleKeyWeight, titleKeyEligible, volumeSafeContains,
  looseTitleKey, looseKeyFromTitle, normalizeVolumeNumerals,
  seriesBaseOf, seriesTitleOf, seriesVolumeOf, MAX_SERIES_VOLUME,
} = require('./title-keys');

const ITEM_ADDED_JOIN = ' LEFT JOIN (SELECT gallery_id, MAX(added_at) AS eagle_added'
  + ' FROM items WHERE gallery_id IS NOT NULL GROUP BY gallery_id) ad ON ad.gallery_id = g.id';
const ITEM_ADDED_EXPR = "COALESCE(ad.eagle_added, CAST(strftime('%s', g.added_date) AS INTEGER) * 1000, 0)";

const LIBRARY_ORDER = {
  // 同点の中は題名順に整える (2026-08-19 利用者指定)。同じ日に入れた束や
  // 同じ星の群れが、開くたびに違う顔で並ばない
  added: `${ITEM_ADDED_EXPR} DESC, g.title COLLATE NOCASE ASC, g.id DESC`,
  published: 'g.published_date DESC, g.title COLLATE NOCASE ASC, g.id DESC',
  title: 'g.title COLLATE NOCASE ASC, g.id DESC',
  star: 'star DESC, g.title COLLATE NOCASE ASC, g.id DESC',
};

// 栞 (reading.json) 由来の並び。読了回数も読了日も台帳には無いので SQL には
// 落とせず、呼び手が渡した要約 (reading-store の summary) を JS で当てる
const READING_SORTS = new Set(['reread', 'finished']);

// LIBRARY_ORDER と同じ意味の JS 比較器。未照合の Eagle アイテムを一覧に混ぜる
// ときと、栞由来の並び (READING_SORTS) のときに使う (どちらもページ切りを
// SQL に任せられない)。NOCASE は小文字化で、日付の NULL/空は
// 「降順の末尾」で近似する。marks は id → { finishedCount, finishedAt, updatedAt }
function libraryComparator(sort, sortDir, marks) {
  const titleAsc = (a, b) => {
    const x = String(a.title || '').toLowerCase();
    const y = String(b.title || '').toLowerCase();
    if (x < y) return -1;
    return x > y ? 1 : 0;
  };
  const strDesc = (x, y) => {
    if (x < y) return 1;
    return x > y ? -1 : 0;
  };
  // 片方は数値の gallery_id、もう片方は Eagle の文字列 ID。文字列で比べて順を固定する
  const idDesc = (a, b) => strDesc(
    String(a.id != null ? a.id : a.eagleId || ''),
    String(b.id != null ? b.id : b.eagleId || ''),
  );
  // 栞は本の id で引く (hitomi は素の数字。未照合アイテムには栞が無いので 0 扱い)
  const table = marks && typeof marks === 'object' ? marks : {};
  const mark = (row) => table[String(row.id != null ? row.id : row.eagleId || '')] || null;
  const count = (row) => Number(mark(row) && mark(row).finishedCount) || 0;
  const finishedAt = (row) => Number(mark(row) && mark(row).finishedAt) || 0;
  const updatedAt = (row) => Number(mark(row) && mark(row).updatedAt) || 0;
  const mains = {
    added: (a, b) => strDesc(a.added || '', b.added || ''),
    published: (a, b) => strDesc(a.published || '', b.published || ''),
    title: () => 0,
    star: (a, b) => (b.star || 0) - (a.star || 0),
    // 再読の棚: 読み終えた回数の多い順 → 最後に読み終えた順 → 最後に開いた順。
    // 回数を積み始めたばかりで全部 0 のうちは、実質「最後に開いた順」に落ちる
    reread: (a, b) => count(b) - count(a)
      || finishedAt(b) - finishedAt(a)
      || updatedAt(b) - updatedAt(a),
    // 最終読了日順。読み終えていない本は 0 なので自然に末尾へ落ちる
    finished: (a, b) => finishedAt(b) - finishedAt(a)
      || count(b) - count(a)
      || updatedAt(b) - updatedAt(a),
  };
  const main = mains[mains[sort] ? sort : 'added'];
  const dir = sortDir === 'asc' ? -1 : 1;
  return (a, b) => (main(a, b) || titleAsc(a, b) || idDesc(a, b)) * dir;
}

// 作品の評価は、紐付く所持アイテムの最高値。items 側にしか星が無いので繋いで引く。
// 相関サブクエリを行ごとに回すと所持数に比例して遅くなるので、一度だけ畳んで JOIN する
const ITEM_STAR_JOIN = ' LEFT JOIN (SELECT gallery_id, MAX(COALESCE(star, 0)) AS star'
  + ' FROM items WHERE gallery_id IS NOT NULL GROUP BY gallery_id) s ON s.gallery_id = g.id';
const ITEM_STAR_EXPR = 'COALESCE(s.star, 0)';

// ページ数がこの割合以内なら「実質同一の版」とみなす
// よその作品を手持ちの hitomi 版と同じ物とみなす条件。頁数の許しは絶対値で
// 持つ (割合にすると薄い本ほど緩くなる)。この 2 頁は実測で決めた:
// 当たりは 24/28 がぴたり一致、外れは 12 頁以上ずれていて、間が無かった
const CROSS_OWNED_PAGE_TOLERANCE = 2;
// 当てにいくソース。pawchive は別の台帳、Eagle アイテムは自前で所持が確定している
const CROSS_OWNED_SOURCES = new Set(['nhentai', 'ehentai']);

const SIMILAR_PAGE_TOLERANCE = 0.1;

// 台帳の世代バックアップ。ネット照合 (title_matches ほか) は作り直しに時間が
// かかるので、正常に開けた内容だけを .bak → .bak2 → .bak3 の三世代で控える。
// .bak は REFRESH 間隔で上書き更新 (電源断の直前に近い姿を残す)、ROTATE 間隔を
// 超えたら一段ずつ回す (論理破損が .bak に入っても古い世代が生き残る)
const BACKUP_SUFFIXES = ['.bak', '.bak2', '.bak3'];
const BACKUP_REFRESH_INTERVAL = 30 * 60 * 1000;
const BACKUP_ROTATE_INTERVAL = 24 * 60 * 60 * 1000;

// 'unlinked' は手動解除の墓標: 照合器の再挑戦からも、題での所持判定からも外す
const TITLE_MATCH_STATES = new Set(['matched', 'ambiguous', 'none', 'skipped', 'unlinked']);
const TITLE_MATCH_RETRY = 30 * 24 * 60 * 60 * 1000;
// 曖昧で終わった照合は取りこぼしの見直し対象。'none' より短い間隔でやり直す
const TITLE_MATCH_AMBIGUOUS_RETRY = 7 * 24 * 60 * 60 * 1000;

function eagleIdFromPath(filePath) {
  const base = path.basename(String(filePath || '').split('#')[0]);
  return base.replace(/\.info$/i, '') || null;
}

// 台帳の path は書き手 (母艦) の機体でのドライブ表記のまま入る。二台構成の
// 読み手 (Homecore の --read-only) では同じ実体が別のパスに見える (母艦の
// D:\share\... = Homecore の <共有の写し>\storage\...) ので、ライブラリの
// フォルダ名 (例: mybooks.library) を目印に自機の eagleLibrary の根へ
// 読み替えた候補を返す。実在の確認は呼び手の仕事 (ここは純粋な文字列変換)
function rebaseLibraryPath(filePath, localRoot) {
  const real = String(filePath || '');
  const root = String(localRoot || '');
  if (!real || !root) return null;
  const marker = path.sep + path.basename(root) + path.sep;
  const idx = real.toLowerCase().indexOf(marker.toLowerCase());
  if (idx < 0) return null;
  return path.join(root, real.slice(idx + marker.length));
}

// LIKE のメタ文字を殺す。SQL 側で ESCAPE '\' を添えて使う
function likePattern(text) {
  return String(text == null ? '' : text).replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// 一つの Eagle アイテムが持つ items の行ぜんぶ (素の行と `<base>#<gallery_id>`)。
// 引数は [base, `${likePattern(base)}#%`] の二つ。path は Windows の道なので
// 逆斜線を含む: LIKE には必ず ESCAPE を添える
const ESCAPED_PATH_PREFIX_CLAUSE = " AND (path = ? OR path LIKE ? ESCAPE '\\')";

function extractGalleryIds(text) {
  const ids = [];
  const source = String(text || '');
  const re = /\[(\d{5,8})\]/g;
  let match;
  while ((match = re.exec(source))) {
    if (/^20\d{6}$/.test(match[1])) continue;
    ids.push(Number(match[1]));
  }
  return ids;
}

// タグ日本語ラベル: annotate() が付与しに行く配列だけを対象にする
// (language/type は別形式なので対象外)
const TAG_LABEL_LIST_KEYS = ['artists', 'groups', 'series', 'characters', 'tags'];

// Eagle アイテム名の先頭ブラケットを解析する。「サークル (作者)」形式なら
// 外側=グループ候補・括弧内=作者候補、括弧が無ければ単独名の候補として返す
const CREATOR_BRACKET_RE = /^\[([^\]]+)\]/;
const CREATOR_PAREN_RE = /^(.*?)\s*[(（]([^()（）]+)[)）]\s*$/;

function splitCreatorBracket(title) {
  const match = String(title || '').match(CREATOR_BRACKET_RE);
  if (!match) return null;
  const inner = match[1].trim();
  if (!inner) return null;
  const parenMatch = inner.match(CREATOR_PAREN_RE);
  if (parenMatch) {
    const group = parenMatch[1].trim();
    const artist = parenMatch[2].trim();
    return { group: group || null, artist: artist || null, solo: null };
  }
  return { group: null, artist: null, solo: inner };
}

class Catalog {
  constructor() {
    this.db = null;
    this.SQL = null;
    this.dbPath = '';
    this.idSet = new Set();
    this.titleSet = new Set();
    this.looseOwned = new Map();
    this.eagleByGallery = new Map();
    this.eagleByTitle = new Map();
    this.starByGallery = new Map();
    this.starByTitle = new Map();
    this.localById = new Map();
    this.localByTitle = new Map();
    this.ready = false;
    this.scanning = false;
    // 写し (--read-only) の上では台帳を一切書かない。母艦の sync が同じ
    // catalog.sqlite / .bak を rename で差し替えるので、こちらから書くと
    // 差し替え合いになる。読み込みと記憶の中の更新はそのまま通す
    this.readOnly = false;
    // 走査 (scanEagle の BEGIN〜COMMIT) 中に届いた書き込みの控え。
    // トランザクションに巻き込むと ROLLBACK で道連れに消えるので、
    // COMMIT/ROLLBACK が済んでから順に流す (runWhenWritable / drainScanQueue)
    this.scanQueue = [];
    this.stats = { total: 0, eagle: 0, app: 0 };
    this.persistTimer = null;
    // 書き出しの直列化と追い越し判定 (persist / persistSync を参照)
    this.persistBusy = false;
    this.persistAgain = false;
    // 作者名の検索索引 (creatorSearchIndex)。組むのは初めて引かれた時
    this.creatorSearch = null;
    // 検索別名の動的な出どころとして名乗り出る。これで rewriteQuery (所持庫と
    // hitomi 検索の両方が通る) と候補 (suggestAliases) が、台帳の作家名を引ける
    setDynamicSource({
      lookup: (term) => this.creatorLookup(term),
      suggest: (term, limit) => this.creatorSuggest(term, limit),
    });
    this.persistSeq = 0;
    this.persistDone = 0;
    this.metaIds = new Set();
    this.backfillRef = null;
    this.eagleBasePath = new Map();
    this.matchJobRef = null;
    this.titleMatchPending = null;
    this.titleMatchLinks = null;
    // 未照合アイテム一覧 (unmatchedEagleEntries) の控え。検索のたびに全件と
    // 全タグを組み直すのは重いので、台帳の「世代番号」が動いていない間だけ
    // 使い回す。入力 (items の eagle 行・eagle_item_tags・tagLabels) を変える
    // 書き込みは必ず bumpUnmatchedGen() を通す
    this.unmatchedGen = 0;
    this.unmatchedCache = null;
    this.tagLabels = new Map();
    // nhentai の名前だけのタグを hitomi の型へ寄せる索引 (遅延構築)
    this.tagTypeIndex = null;
    this.eagleItemFolders = new Map();
    this.eagleFolderNames = new Map();
    this.eagleFolderParents = new Map();
    this.eagleRootFolders = new Set();
    this.eagleTaggerRef = null;
    this.eagleTagPending = null;
    // Eagle 走査の控え: metadata.json の mtime+size が前回と同じアイテムは
    // 読み直さない (ライブラリがネットワーク越しだと全件読みが体感で重い)。
    // 台帳の作り直し (全消し・全入れ直し) 自体は今までどおりで、控えは
    // 「ファイルを開く手間」だけを省く。壊れていても捨てて全件読みに戻るだけ
    this.eagleScanCache = null;
    this.eagleScanCachePath = '';
    // Eagle のゴミ箱送りの墓標。Eagle (v4) は削除を自分の内部 DB にだけ記録して
    // metadata.json をすぐには書き換えないので、isDeleted だけを頼りにすると
    // 次の走査で削除済みアイテムが台帳に復活する。墓標が実体に追いつかれたら
    // (metadata の isDeleted が立つ / .info ごと消える) 走査が下ろす
    this.eagleTrash = new Set();
  }

  async init() {
    const initSqlJs = require('sql.js');
    // asar 内は fs から「ファイル」に見えない。asarUnpack した原本の方を指す
    const wasmPath = unpackedPath(
      path.join(path.dirname(require.resolve('sql.js')), 'sql-wasm.wasm')
    );
    this.SQL = await initSqlJs({ locateFile: () => wasmPath });
    this.dbPath = path.join(app.getPath('userData'), 'catalog.sqlite');
    this.eagleScanCachePath = path.join(app.getPath('userData'), 'eagle-scan-cache.json');
    // 追い越されて残った書き出しの tmp (catalog.sqlite.<n>.tmp) を掃除する
    try {
      const dir = path.dirname(this.dbPath);
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith('catalog.sqlite.') && name.includes('.tmp')) {
          fs.rmSync(path.join(dir, name), { force: true });
        }
      }
    } catch {
      // 掃除できなくても起動は続ける
    }

    if (fs.existsSync(this.dbPath)) {
      // 電源断などで本体が壊れていることがある (中身が全部ゼロ等)。
      // 壊れた台帳で起動全体を巻き添えにしない: 横に退避して、最新の正常
      // バックアップ (.bak 世代) から復元する。バックアップも無ければ空から
      let cleanBytes = null;
      try {
        const bytes = fs.readFileSync(this.dbPath);
        this.db = new this.SQL.Database(bytes);
        if (!this.dbLooksOk(this.db)) throw new Error('quick_check failed');
        cleanBytes = bytes;
      } catch (error) {
        try { if (this.db) this.db.close(); } catch { /* ignore */ }
        this.db = null;
        const corrupt = `${this.dbPath}.corrupt-${Date.now()}`;
        try {
          fs.renameSync(this.dbPath, corrupt);
          console.error(`catalog.sqlite is corrupt (${error.message}); moved to ${corrupt}`);
        } catch {
          // 退避できなくても、次の persist が上から書き直す
        }
        const restored = this.restoreFromBackup();
        if (restored) {
          this.db = restored.db;
          console.error(`catalog.sqlite restored from ${restored.file}`);
          trace.note('catalog', 'restored-from-backup', { id: trace.codeOf(error) });
          trace.flag('catalog-restored');
          // 復元した内容を本体のパスへも早めに書き戻しておく
          this.persistSoon();
        } else {
          this.db = new this.SQL.Database();
          // 空から作り直したことを利用者に言う (項目 9-3)。黙って 0 件になると
          // 「所持が全部消えた」ようにしか見えず、走査のやり直しにも気づけない
          console.error('catalog.sqlite rebuilt empty (no usable backup)');
          trace.note('catalog', 'rebuilt-empty', { id: trace.codeOf(error) });
          trace.flag('catalog-empty');
        }
      }
      // 正常に開けた時だけ世代バックアップを更新する (壊れた内容で上書きしない)。
      // 起動はこれを待たない: 数 MB の書き出し+fsync で catalogReady を遅らせる
      // 理由が無い (内容は cleanBytes として確保済みで、後から書いても同じ)
      if (cleanBytes) {
        this.maybeBackup(cleanBytes).catch(() => {
          // バックアップに失敗しても起動は続ける
        });
      }
    } else {
      this.db = new this.SQL.Database();
    }

    this.db.run(`
      CREATE TABLE IF NOT EXISTS items (
        source TEXT NOT NULL,
        path TEXT NOT NULL,
        gallery_id INTEGER,
        title TEXT,
        title_key TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (source, path)
      );
    `);
    this.db.run('CREATE INDEX IF NOT EXISTS idx_items_gallery ON items(gallery_id);');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_items_title ON items(title_key);');
    // 星は後から足した列。既存の catalog.sqlite には継ぎ足しで追いつかせる
    this.ensureColumn('items', 'star', 'INTEGER');
    // 未照合アイテムを所持一覧に混ぜるための列 (どちらも Eagle の metadata 由来)。
    // added_at は Eagle 側の更新時刻 (ms)、eagle_tags は Eagle のタグの JSON 配列
    this.ensureColumn('items', 'added_at', 'INTEGER');
    this.ensureColumn('items', 'eagle_tags', 'TEXT');

    this.db.run(`
      CREATE TABLE IF NOT EXISTS galleries (
        id INTEGER PRIMARY KEY,
        title TEXT,
        type TEXT,
        language TEXT,
        language_local TEXT,
        page_count INTEGER,
        added_date TEXT,
        published_date TEXT,
        url TEXT,
        fetched_at INTEGER NOT NULL
      );
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS gallery_tags (
        gallery_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        PRIMARY KEY (gallery_id, type, name)
      );
    `);
    this.db.run('CREATE INDEX IF NOT EXISTS idx_gtags_type_name ON gallery_tags(type, name);');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_gtags_gallery ON gallery_tags(gallery_id);');
    this.db.run(`
      CREATE TABLE IF NOT EXISTS gallery_fetch_failures (
        id INTEGER PRIMARY KEY,
        attempts INTEGER NOT NULL,
        last_attempt INTEGER NOT NULL
      );
    `);
    // Eagle アイテムのタイトル照合の台帳。eagle_id は .info フォルダ名なので
    // 再スキャンしても変わらない。gallery_id が NULL なら未紐付け
    this.db.run(`
      CREATE TABLE IF NOT EXISTS title_matches (
        eagle_id TEXT PRIMARY KEY,
        gallery_id INTEGER,
        status TEXT NOT NULL,
        item_title TEXT,
        matched_title TEXT,
        attempts INTEGER NOT NULL DEFAULT 1,
        last_attempt INTEGER NOT NULL
      );
    `);
    this.db.run('CREATE INDEX IF NOT EXISTS idx_title_matches_gallery ON title_matches(gallery_id);');
    // 誰が決めた紐付けか。'manual' は利用者が詳細の鎖で選んだもの。照合器の
    // 自動判定より強く、自動の書き込みはこの行を上書きしない。後から足した列
    this.ensureColumn('title_matches', 'origin', 'TEXT');

    // Eagle への日本語タグ書き込み台帳。eagle_id ごとに一度書けば以後は対象から外す
    this.db.run(`
      CREATE TABLE IF NOT EXISTS eagle_tag_pushes (
        eagle_id TEXT PRIMARY KEY,
        gallery_id INTEGER,
        pushed_at INTEGER NOT NULL,
        tags TEXT
      );
    `);
    // BUNKO 自身が書き足した札 (JSON 配列)。tags は利用者の札と混ざった全体なので、
    // 照合し直しで前の作品の札を引く時に「どれが自分の書いた物か」をここで知る。
    // NULL はこの列より前の記録で、出どころが分からないので引かない。後から足した列
    this.ensureColumn('eagle_tag_pushes', 'added', 'TEXT');

    // 未照合の Eagle アイテムに付ける詳細タグ (BUNKO 表示・検索用)。
    // 出どころは番号付きの兄弟作品 (hitomi) や e-hentai/nhentai の同作。
    // Eagle 本体へ書くタグは少数精鋭のまま、この表は棚の中でだけ使う
    this.db.run(`
      CREATE TABLE IF NOT EXISTS eagle_item_tags (
        eagle_id TEXT NOT NULL,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        PRIMARY KEY (eagle_id, type, name)
      );
    `);

    // 起動ごとの作り直しを省くための覚え書き置き場 (取り込み済みの辞書の版など)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);

    // タグの日本語表示ラベル。'dict' は aliases.json 由来(辞書が変わった時だけ作り直す)、
    // 'learned' は所持アイテム名からの作者・グループ名の学習(learnCreatorLabels)、
    // 'nhentai' は所持作品の題を nhentai で引いて括弧書きから拾ったもの (creator-labels)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS tag_labels (
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        label TEXT NOT NULL,
        source TEXT NOT NULL,
        votes INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (type, name)
      );
    `);

    // nhentai への作者名照会の台帳。一度試した名義は冷却期間を置くまで引き直さない
    this.db.run(`
      CREATE TABLE IF NOT EXISTS creator_label_lookups (
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 1,
        found INTEGER NOT NULL DEFAULT 0,
        last_attempt INTEGER NOT NULL,
        PRIMARY KEY (type, name)
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS eagle_trash (
        id TEXT PRIMARY KEY,
        at INTEGER NOT NULL
      );
    `);

    // 走査の控え (全 .info の一覧) を先に読む: rebuildMemory がアイテムの実在を
    // ここから引く (ネットワーク越しのライブラリに行ごとに訊かずに済む)
    if (!this.eagleScanCache) this.eagleScanCache = this.loadEagleScanCache();
    this.rebuildMemory();
    this.rebuildMetaIds();
    this.importDictLabels();
    this.loadEagleTrash();
    this.ready = true;
    return this.snapshot();
  }

  loadEagleTrash() {
    this.eagleTrash = new Set();
    if (!this.db) return;
    try {
      for (const row of this.queryRows('SELECT id FROM eagle_trash')) {
        if (row.id) this.eagleTrash.add(String(row.id));
      }
    } catch {
      // 旧い DB (表が無い) を読み直した時。墓標なしで進める
    }
  }

  // 写し (Homecore の --read-only) 用: 母艦の sync が rename で差し替えた
  // catalog.sqlite を読み直し、動かしたまま棚を最新にする。書き手側では使わない
  // (メモリ上の未書き出し分をディスクの内容で巻き戻してしまうため)
  reloadFromDisk() {
    if (!this.SQL || !this.dbPath || this.scanning) return false;
    let db = null;
    try {
      const bytes = fs.readFileSync(this.dbPath);
      db = new this.SQL.Database(bytes);
      if (!this.dbLooksOk(db)) throw new Error('quick_check failed');
    } catch {
      // 差し替えの瞬間に当たると開けないことがある。呼び手が次の見張りで再挑戦する
      try { if (db) db.close(); } catch { /* ignore */ }
      return false;
    }
    try { if (this.db) this.db.close(); } catch { /* ignore */ }
    this.db = db;
    // 母艦の sync は控え (eagle-scan-cache.json) も DB より先に写している。
    // 起動時に読んだ控えのままだと、増えたアイテムが実在しない扱いになる
    this.eagleScanCache = this.loadEagleScanCache();
    this.rebuildMemory();
    this.rebuildMetaIds();
    this.importDictLabels();
    this.loadEagleTrash();
    return true;
  }

  setBackfill(ref) {
    this.backfillRef = ref || null;
  }

  setTitleMatchJob(ref) {
    this.matchJobRef = ref || null;
  }

  setEagleTagger(ref) {
    this.eagleTaggerRef = ref || null;
  }

  queryRows(sql, params = []) {
    if (!this.db) return [];
    const stmt = this.db.prepare(sql);
    const rows = [];
    try {
      if (params.length) stmt.bind(params);
      while (stmt.step()) rows.push(stmt.getAsObject());
    } finally {
      stmt.free();
    }
    return rows;
  }

  queryValue(sql, params = []) {
    const rows = this.queryRows(sql, params);
    if (!rows.length) return null;
    const keys = Object.keys(rows[0]);
    return keys.length ? rows[0][keys[0]] : null;
  }

  // 列の後付け。CREATE TABLE IF NOT EXISTS は既存テーブルには効かないので、
  // 版が上がって列が増えたぶんはここで継ぎ足す
  ensureColumn(table, column, type) {
    if (!this.db) return;
    const rows = this.queryRows(`PRAGMA table_info(${table})`);
    if (rows.some((row) => String(row.name) === column)) return;
    this.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  rebuildMetaIds() {
    this.metaIds = new Set();
    if (!this.db) return;
    const result = this.db.exec('SELECT id FROM galleries');
    if (result[0]) {
      for (const row of result[0].values) this.metaIds.add(Number(row[0]));
    }
  }

  hasGalleryMeta(id) {
    const numeric = numericGalleryId(id);
    return numeric != null && this.metaIds.has(numeric);
  }

  loadTagLabels() {
    this.tagLabels = new Map();
    // nhentai の名前だけのタグを hitomi の型へ寄せる索引 (遅延構築)
    this.tagTypeIndex = null;
    // 札が変われば作者索引の日本語鍵も変わる。次に引かれた時に組み直す
    this.invalidateCreatorSearch();
    // 未照合一覧の haystack と日本語ラベルもここの札から組んでいる
    this.bumpUnmatchedGen();
    if (!this.db) return;
    for (const row of this.queryRows('SELECT type, name, label FROM tag_labels')) {
      const type = String(row.type || '').toLowerCase().trim();
      const name = String(row.name || '');
      const label = String(row.label || '');
      if (!type || !name || !label) continue;
      this.tagLabels.set(`${type}\u0000${name}`, label);
    }
  }

  lookupTagLabel(type, name) {
    const cleanType = String(type || '').toLowerCase().trim();
    const cleanName = tagNameKey(name);
    if (!cleanType || !cleanName) return null;
    const hit = this.tagLabels.get(`${cleanType}\u0000${cleanName}`);
    if (hit) return hit;
    // nhentai は内容タグを型分けせず、全部 'tag' で寄越す。日本語の札は
    // hitomi 由来なので female:/male: の下に溜まっており、'tag' で引くと
    // 素通りする — それが「nhentai のタグだけ英語のまま出る」の正体。
    // 同じ名前の hitomi 側の札へ回す (型は名乗り直さない: 出るのは札だけ)
    if (cleanType === 'tag') {
      for (const alt of ['female', 'male']) {
        const fallback = this.tagLabels.get(`${alt}\u0000${cleanName}`);
        if (fallback) return fallback;
      }
    }
    return null;
  }

  // 名前だけのタグ (nhentai) が hitomi ではどの型かを台帳に訊く。
  // hitomi には female:glasses と male:glasses が別物として在り、nhentai の
  // glasses はそのどちらでもある。**どちらか**を当てずっぽうで選ばず、
  // 在る型を全部返す (両方在るなら検索は二つを合わせて引く)
  hitomiTagTypeIndex() {
    if (this.tagTypeIndex) return this.tagTypeIndex;
    const byName = new Map();
    if (this.db) {
      for (const row of this.queryRows(
        "SELECT DISTINCT type, name FROM gallery_tags WHERE type IN ('female', 'male', 'tag')",
      )) {
        const key = tagNameKey(row.name);
        if (!key) continue;
        if (!byName.has(key)) byName.set(key, new Set());
        byName.get(key).add(String(row.type));
      }
    }
    this.tagTypeIndex = byName;
    return byName;
  }

  // その名前が hitomi で名乗っている型の一覧 (無ければ空)。
  // 並びは female → male → tag で固定する (合わせて引くときの先頭が決まる:
  // 実測で female が常に多数派なので、正しく並ぶ側を先に置く)
  hitomiTagTypes(name) {
    const key = tagNameKey(name);
    if (!key) return [];
    const hit = this.hitomiTagTypeIndex().get(key);
    if (!hit) return [];
    return ['female', 'male', 'tag'].filter((type) => hit.has(type));
  }

  hitomiTagType(name) {
    const types = this.hitomiTagTypes(name);
    return types.length === 1 ? types[0] : null;
  }

  // ── 作者名の検索索引 ───────────────────────────────────────
  // 検索欄に日本語 (漢字・かな) で作家名を打っても引けるようにする。
  // 鍵は三系統: hitomi のローマ字名そのもの / tag_labels の日本語札 (四層) /
  // ローマ字→カナに起こした読み。aliasKey が ひら⇄カタ を吸収するので、
  // 「かがりび」でも「カガリビ」でも同じ鍵に落ちる

  invalidateCreatorSearch() {
    this.creatorSearch = null;
  }

  creatorSearchIndex() {
    if (this.creatorSearch) return this.creatorSearch;
    const entries = [];
    const exact = new Map();
    if (this.db) {
      const rows = this.queryRows(
        "SELECT type, name, SUM(n) AS n FROM (SELECT type, name, COUNT(DISTINCT gallery_id) AS n FROM gallery_tags WHERE type IN ('artist','group') GROUP BY type,name UNION ALL SELECT type,name,0 AS n FROM tag_labels WHERE type IN ('artist','group')) GROUP BY type,name",
      );
      for (const row of rows) {
        const type = String(row.type || '');
        const name = String(row.name || '');
        if (!name) continue;
        const label = this.lookupTagLabel(type, name) || '';
        const kata = romajiToKata(name);
        const keys = new Set();
        for (const raw of [name, label, kata]) {
          const key = raw && aliasKey(raw);
          if (key) keys.add(key);
        }
        if (!keys.size) continue;
        const entry = {
          value: `${type}:${name.replace(/\s+/g, '_')}`,
          type,
          name,
          label,
          count: Number(row.n) || 0,
          source: 'creator',
          keys: [...keys],
        };
        entries.push(entry);
        for (const key of keys) {
          if (!exact.has(key)) exact.set(key, []);
          exact.get(key).push(entry);
        }
      }
    }
    this.creatorSearch = { entries, exact };
    return this.creatorSearch;
  }

  creatorLookup(term) {
    const key = aliasKey(term);
    if (!key) return [];
    return (this.creatorSearchIndex().exact.get(key) || []).slice();
  }

  creatorSuggest(term, limit = 8) {
    const needle = aliasKey(term);
    if (!needle) return [];
    const best = [];
    for (const entry of this.creatorSearchIndex().entries) {
      let score = null;
      for (const key of entry.keys) {
        if (key === needle) { score = 0; break; }
        if (key.startsWith(needle)) { score = score == null ? 1 : Math.min(score, 1); continue; }
        // 中間一致は 2 文字から。1 文字の含みは候補が濁流になる
        if (needle.length >= 2 && key.includes(needle)) score = score == null ? 2 : Math.min(score, 2);
      }
      if (score == null) continue;
      best.push({ entry, score });
    }
    return best
      .sort((a, b) => a.score - b.score
        || b.entry.count - a.entry.count
        || a.entry.value.localeCompare(b.entry.value))
      .slice(0, Math.max(1, Number(limit) || 8))
      .map(({ entry }) => ({
        type: entry.type,
        name: entry.name,
        value: entry.value,
        label: entry.label,
        count: entry.count,
        source: 'creator',
      }));
  }

  // meta テーブルの読み書き。値は文字列で持つ
  metaValue(key) {
    const value = this.queryValue('SELECT value FROM meta WHERE key = ?', [key]);
    return value == null ? '' : String(value);
  }

  setMetaValue(key, value) {
    if (!this.db) return;
    this.db.run(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [key, String(value == null ? '' : value)],
    );
  }

  // 辞書ファイルの版。version があればそれ、無ければ mtime+size で代用する。
  // 読めなければ空を返し、その場合は取り込みを毎回やり直す (安全側)
  dictLabelStamp() {
    const parts = [];
    // 札の出どころ全部を数える。一つでも漏らすと、辞書を直しても
    // 前の版の札が tag_labels に残り続ける (二台とも作り直さない)
    for (const name of ['aliases.json', 'label-overrides.json', 'search-vocabulary.json', 'manual-aliases.json']) {
      try {
        const file = require.resolve(`./data/${name}`);
        const stat = fs.statSync(file);
        parts.push(`${name}:${stat.size}:${Math.floor(stat.mtimeMs)}`);
      } catch {
        return '';
      }
    }
    try {
      const version = require('./data/aliases.json').version;
      if (version) parts.push(`v:${version}`);
      const revision = require('./data/search-vocabulary.json').revision;
      if (revision) parts.push(`r:${revision}`);
    } catch {
      // 版が読めなくても mtime+size だけで判定できる
    }
    return parts.join('|');
  }

  // aliases.json (hitomi の全タグ辞書) から表示ラベルを取り込む。数千行の
  // INSERT になるので、辞書が前回と同じなら丸ごと省く。'learned' の行は消さない
  importDictLabels() {
    if (!this.db) return;
    // 取り込み済みの版と一致し、'dict' の行が実際に残っていれば作り直さない
    const stamp = this.dictLabelStamp();
    if (stamp && stamp === this.metaValue('dict_labels_stamp')) {
      const kept = Number(this.queryValue("SELECT COUNT(*) AS n FROM tag_labels WHERE source = 'dict'")) || 0;
      if (kept > 0) {
        this.loadTagLabels();
        return;
      }
    }
    // 札は search-aliases が既に一本化している (一般則 < 横断語彙 < 監査済みの
    // 上書き < 手で決めた物)。ここで同じ突き合わせを二度書くと、補完に出る名前と
    // 詳細に出る名前がずれる — それが「候補は日本語なのに詳細は英語」の正体だった。
    // 辞書に無い語 (label-overrides や search-vocabulary だけが持つ series) も
    // loadData が項目を起こすので、ここは並べて入れるだけでよい
    const dictionary = loadAliasData();
    this.db.run("DELETE FROM tag_labels WHERE source = 'dict'");
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO tag_labels (type, name, label, source, votes) VALUES (?, ?, ?, \'dict\', 1)',
    );
    try {
      for (const entry of dictionary.entries || []) {
        const type = String(entry.type || '').toLowerCase().trim();
        const name = tagNameKey(entry.name);
        const label = String(entry.label || '').trim();
        if (!type || !name || !label) continue;
        // 監修済み (上書き・手決め・横断語彙) は CJK 検査を通さない。
        // 一般則で選んだ札だけは日本語であることを求める
        if (!entry.labelRank && !hasCjk(label)) continue;
        stmt.run([type, name, label]);
      }
      if (!dictionary.byValue.has('series:original')) stmt.run(['series', 'original', 'オリジナル']);
    } finally {
      stmt.free();
    }
    // 次の起動で省けるように、取り込んだ辞書の版を控える
    if (stamp) this.setMetaValue('dict_labels_stamp', stamp);
    this.loadTagLabels();
    this.persistSoon();
  }

  // 所持アイテム名(Eagle)の先頭ブラケットから作者・グループの日本語名を学習する。
  // ネットワーク不要、ローカルの items/gallery_tags だけで完結する
  learnCreatorLabels() {
    if (!this.db) return;
    const itemRows = this.queryRows(
      `SELECT i.gallery_id AS gallery_id, i.title AS title
         FROM items i
        WHERE i.gallery_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM galleries g WHERE g.id = i.gallery_id)`,
    );
    const titlesByGallery = new Map();
    for (const row of itemRows) {
      const id = Number(row.gallery_id);
      const title = String(row.title || '').trim();
      if (!Number.isFinite(id) || !title) continue;
      if (!titlesByGallery.has(id)) titlesByGallery.set(id, new Set());
      titlesByGallery.get(id).add(title);
    }
    if (!titlesByGallery.size) return;

    const ids = [...titlesByGallery.keys()].join(',');
    const tagRows = this.queryRows(
      `SELECT gallery_id, type, name FROM gallery_tags
        WHERE type IN ('artist', 'group') AND gallery_id IN (${ids})`,
    );
    const creatorsByGallery = new Map();
    for (const row of tagRows) {
      const id = Number(row.gallery_id);
      if (!creatorsByGallery.has(id)) creatorsByGallery.set(id, { artist: [], group: [] });
      const bucket = creatorsByGallery.get(id);
      if (row.type === 'artist') bucket.artist.push(String(row.name));
      else if (row.type === 'group') bucket.group.push(String(row.name));
    }

    // (type\u0000ローマ字名) -> Map(日本語名 -> 得票)
    const votes = new Map();
    const addVote = (type, romajiName, label) => {
      if (!type || !romajiName || !label || !hasCjk(label)) return;
      const key = `${type}\u0000${romajiName}`;
      if (!votes.has(key)) votes.set(key, new Map());
      const byLabel = votes.get(key);
      byLabel.set(label, (byLabel.get(label) || 0) + 1);
    };

    for (const [galleryId, titles] of titlesByGallery) {
      const creators = creatorsByGallery.get(galleryId) || { artist: [], group: [] };
      for (const title of titles) {
        const split = splitCreatorBracket(title);
        if (!split) continue;
        if (split.artist && creators.artist.length === 1) {
          addVote('artist', creators.artist[0], split.artist);
        }
        if (split.group && creators.group.length === 1) {
          addVote('group', creators.group[0], split.group);
        }
        if (split.solo) {
          if (creators.artist.length === 1 && creators.group.length === 0) {
            addVote('artist', creators.artist[0], split.solo);
          } else if (creators.group.length === 1 && creators.artist.length === 0) {
            addVote('group', creators.group[0], split.solo);
          }
        }
      }
    }

    // フォルダ名からの学習: 作者名フォルダに入った作品群の hitomi 側名義が
    // 一人に集中していれば、フォルダ名をその日本語名義とみなす。
    // 作品ごとの小分けフォルダ(名前=作品名)は、メンバー作品のタイトルとの
    // 照合で除外する
    if (this.eagleItemFolders.size && this.eagleFolderNames.size) {
      const eagleRows = this.queryRows(
        "SELECT path, gallery_id FROM items WHERE source = 'eagle' AND gallery_id IS NOT NULL",
      );
      const galleriesByFolder = new Map();
      const addToFolder = (folderId, galleryId) => {
        if (!galleriesByFolder.has(folderId)) galleriesByFolder.set(folderId, new Set());
        galleriesByFolder.get(folderId).add(galleryId);
      };
      for (const row of eagleRows) {
        const id = Number(row.gallery_id);
        if (!Number.isFinite(id) || !creatorsByGallery.has(id)) continue;
        const eagleId = eagleIdFromPath(row.path);
        for (const folderId of this.eagleItemFolders.get(eagleId) || []) {
          // 祖先にも集計する。作品別サブフォルダより親の作者名フォルダが
          // 広く票を集めて勝つように
          let current = String(folderId);
          const hops = new Set();
          while (current && !hops.has(current)) {
            hops.add(current);
            addToFolder(current, id);
            current = this.eagleFolderParents ? this.eagleFolderParents.get(current) : null;
          }
        }
      }
      for (const [folderId, galleryIds] of galleriesByFolder) {
        if (galleryIds.size < 2) continue;
        if (this.eagleRootFolders && this.eagleRootFolders.has(String(folderId))) continue;
        const folderName = String(this.eagleFolderNames.get(String(folderId)) || '').trim();
        if (!folderName || !hasCjk(folderName)) continue;
        // 作品別サブフォルダ対策は祖先への伝播が担う: 親(作者名フォルダ)が
        // サブフォルダ以上の票を必ず集め、多数決で勝つ。同数なら不採用
        const counts = { artist: new Map(), group: new Map() };
        for (const galleryId of galleryIds) {
          const creators = creatorsByGallery.get(galleryId) || { artist: [], group: [] };
          for (const type of ['artist', 'group']) {
            if (creators[type].length !== 1) continue;
            const name = creators[type][0];
            counts[type].set(name, (counts[type].get(name) || 0) + 1);
          }
        }
        for (const type of ['artist', 'group']) {
          const ranked = [...counts[type].entries()].sort((a, b) => b[1] - a[1]);
          if (!ranked.length) continue;
          const [name, top] = ranked[0];
          const second = ranked.length > 1 ? ranked[1][1] : 0;
          const totalTyped = [...counts[type].values()].reduce((sum, count) => sum + count, 0);
          if (top < 2 || top === second) continue;
          if (top < totalTyped * 0.6) continue; // 支配的でないフォルダは見送り
          for (let i = 0; i < top; i += 1) addVote(type, name, folderName);
        }
      }
    }

    const winners = [];
    for (const [key, byLabel] of votes) {
      const [type, name] = key.split('\u0000');
      const ranked = [...byLabel.entries()].sort((a, b) => b[1] - a[1]);
      if (!ranked.length) continue;
      const [topLabel, topVotes] = ranked[0];
      const secondVotes = ranked.length > 1 ? ranked[1][1] : 0;
      if (topVotes === secondVotes) continue; // 最多と次点が同数: 採用しない
      if (topVotes < 2 && ranked.length > 1) continue; // 得票1で候補が複数種類: 採用しない
      winners.push({ type, name, label: topLabel, votes: topVotes });
    }
    // 学習結果は導出データなので毎回作り直す。票の変化で採用が取り消された
    // 名前の古い行を残さないため
    const labelsBefore = new Set(this.queryRows(
      "SELECT type, name, label FROM tag_labels WHERE source = 'learned'",
    ).map((row) => `${row.type}|${row.name}|${row.label}`));
    this.db.run("DELETE FROM tag_labels WHERE source = 'learned'");
    if (!winners.length) {
      this.loadTagLabels();
      return;
    }

    const stmt = this.db.prepare(
      `INSERT INTO tag_labels (type, name, label, source, votes)
       VALUES (?, ?, ?, 'learned', ?)
       ON CONFLICT(type, name) DO UPDATE SET
         label = excluded.label,
         source = 'learned',
         votes = excluded.votes
       WHERE tag_labels.source != 'dict'`,
    );
    try {
      for (const winner of winners) stmt.run([winner.type, winner.name, winner.label, winner.votes]);
    } finally {
      stmt.free();
    }
    // 新しいラベルが増えたときだけ、「書けるラベルが無い」として空で記録した
    // Eagle タグ書き込みを台帳から落とし、次の実行で拾い直させる。
    // 学習は毎回全部作り直すので、実際に増えたかは前後の突き合わせで判断する
    const labelsAfter = this.queryRows(
      "SELECT type, name, label FROM tag_labels WHERE source = 'learned'",
    ).map((row) => `${row.type}|${row.name}|${row.label}`);
    if (labelsAfter.some((entry) => !labelsBefore.has(entry))) {
      this.db.run("DELETE FROM eagle_tag_pushes WHERE tags = '[]'");
      this.eagleTagPending = null;
    }
    this.loadTagLabels();
    this.persistSoon();
  }

  // nhentai 照会の対象: 所持作品の作者・サークル名義のうち、日本語ラベルが
  // 無く、まだ照会していない (または冷却期間の過ぎた) もの。名義ごとに、
  // その名義が唯一の作者/サークルである日本語題の作品を検索の種として添える
  // (複数名義の作品では括弧書きの名前をどちらに帰するか決められないため)
  pendingCreatorLabelTargets({ cooldown = 30 * 24 * 60 * 60 * 1000, maxAttempts = 2 } = {}) {
    if (!this.db) return [];
    const works = this.queryRows(`
      SELECT DISTINCT i.gallery_id AS id, g.title AS title, g.page_count AS page_count
        FROM items i JOIN galleries g ON g.id = i.gallery_id
    `).filter((row) => hasCjk(String(row.title || '')));
    if (!works.length) return [];
    const workIds = works.map((row) => Number(row.id)).filter(Number.isFinite);
    const tagRows = this.queryRows(
      `SELECT gallery_id, type, name FROM gallery_tags
        WHERE type IN ('artist', 'group') AND gallery_id IN (${workIds.join(',')})`,
    );
    const creatorsByWork = new Map();
    for (const row of tagRows) {
      const id = Number(row.gallery_id);
      if (!creatorsByWork.has(id)) creatorsByWork.set(id, { artist: [], group: [] });
      creatorsByWork.get(id)[row.type].push(String(row.name));
    }
    const labeled = new Set(this.queryRows(
      "SELECT type, name FROM tag_labels WHERE type IN ('artist', 'group')",
    ).map((row) => `${row.type}\u0000${row.name}`));
    const cutoff = Date.now() - cooldown;
    const tried = new Map();
    for (const row of this.queryRows('SELECT type, name, attempts, last_attempt FROM creator_label_lookups')) {
      tried.set(`${row.type}\u0000${row.name}`, row);
    }

    const byCreator = new Map();
    for (const work of works) {
      const creators = creatorsByWork.get(Number(work.id));
      if (!creators) continue;
      for (const type of ['artist', 'group']) {
        if (creators[type].length !== 1) continue;
        const name = creators[type][0];
        const key = `${type}\u0000${name}`;
        if (labeled.has(key)) continue;
        const prior = tried.get(key);
        if (prior && (prior.attempts >= maxAttempts || Number(prior.last_attempt) >= cutoff)) continue;
        if (!byCreator.has(key)) byCreator.set(key, { type, name, candidates: [] });
        const target = byCreator.get(key);
        if (target.candidates.length < 3) {
          target.candidates.push({
            title: String(work.title || ''),
            pageCount: Number(work.page_count) || 0,
            // 相方の名義 (artist に対する group、またはその逆) がいる作品か。
            // いるなら [名前] 単独の括弧書きはどちらの名か決められない
            hasOther: creators[type === 'artist' ? 'group' : 'artist'].length > 0,
          });
        }
      }
    }
    return [...byCreator.values()];
  }

  recordCreatorLabelLookup(type, name, found) {
    if (this.scanning) {
      this.scanQueue.push(() => this.recordCreatorLabelLookup(type, name, found));
      return true;
    }
    if (!this.db) return false;
    this.db.run(
      `INSERT INTO creator_label_lookups (type, name, attempts, found, last_attempt)
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(type, name) DO UPDATE SET
         attempts = creator_label_lookups.attempts + 1,
         found = excluded.found,
         last_attempt = excluded.last_attempt`,
      [String(type), String(name), found ? 1 : 0, Date.now()],
    );
    this.persistSoon();
    return true;
  }

  // nhentai 由来のラベルは既存 (dict / learned) を上書きしない。逆に learned は
  // 毎回作り直しても source='nhentai' の行には触らないので共存できる
  storeCreatorLabel(type, name, label) {
    if (this.scanning) {
      this.scanQueue.push(() => this.storeCreatorLabel(type, name, label));
      return true;
    }
    if (!this.db) return false;
    const text = String(label || '').trim();
    if (!text || !hasCjk(text)) return false;
    this.db.run(
      `INSERT INTO tag_labels (type, name, label, source, votes)
       VALUES (?, ?, ?, 'nhentai', 1)
       ON CONFLICT(type, name) DO NOTHING`,
      [String(type), String(name), text],
    );
    // 「書けるラベルが無い」として空記録した Eagle タグ書き込みを拾い直させる
    this.db.run("DELETE FROM eagle_tag_pushes WHERE tags = '[]'");
    this.eagleTagPending = null;
    this.loadTagLabels();
    this.persistSoon();
    return true;
  }

  storeGalleryMeta(serialized) {
    if (this.scanning) {
      this.scanQueue.push(() => this.storeGalleryMeta(serialized));
      return true;
    }
    if (!this.db || !serialized || serialized.error) return false;
    const numeric = numericGalleryId(serialized.id);
    if (numeric == null) return false;
    if (serialized.source && serialized.source !== 'hitomi') return false;

    const language = serialized.language || null;
    this.db.run(
      `INSERT INTO galleries
         (id, title, type, language, language_local, page_count, added_date, published_date, url, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         type = excluded.type,
         language = excluded.language,
         language_local = excluded.language_local,
         page_count = excluded.page_count,
         added_date = excluded.added_date,
         published_date = excluded.published_date,
         url = excluded.url,
         fetched_at = excluded.fetched_at`,
      [
        numeric,
        String(serialized.title || ''),
        String(serialized.type || ''),
        language && language.name ? String(language.name).toLowerCase() : '',
        language && language.localName ? String(language.localName) : '',
        Number(serialized.pageCount) || 0,
        serialized.addedDate ? String(serialized.addedDate) : null,
        serialized.publishedDate ? String(serialized.publishedDate) : null,
        String(serialized.url || ''),
        Date.now(),
      ],
    );

    // 名前 -> 型 の索引はこの表から作る。書き換えたら組み直させる
    // (annotate は札を描くたびに引くので、毎回作り直させない)
    this.tagTypeIndex = null;
    this.db.run('DELETE FROM gallery_tags WHERE gallery_id = ?', [numeric]);
    const rows = metaTagRows(serialized);
    if (rows.length) {
      const stmt = this.db.prepare(
        'INSERT OR IGNORE INTO gallery_tags (gallery_id, type, name) VALUES (?, ?, ?)',
      );
      try {
        for (const [type, name] of rows) stmt.run([numeric, type, name]);
      } finally {
        stmt.free();
      }
    }

    this.db.run('DELETE FROM gallery_fetch_failures WHERE id = ?', [numeric]);
    this.metaIds.add(numeric);
    // ID からメタが引けた作品は照合の対象から外れる。数え上げをやり直させる
    this.titleMatchPending = null;
    this.persistSoon();
    return true;
  }

  getGalleryMeta(id) {
    const numeric = numericGalleryId(id);
    if (numeric == null) return null;
    return this.getGalleryMetaBatch([numeric]).get(numeric) || null;
  }

  // 一覧用のメタデータをまとめて引く。返す形とタグ順を保ったまま、
  // 1ページぶんの galleries + gallery_tags を2本のSQLで組み立てる。
  getGalleryMetaBatch(ids) {
    const numericIds = [...new Set((ids || []).map(numericGalleryId).filter((id) => id != null))];
    const output = new Map();
    if (!this.db || !numericIds.length) return output;
    const slots = numericIds.map(() => '?').join(', ');
    const rows = this.queryRows(`SELECT * FROM galleries WHERE id IN (${slots})`, numericIds);
    const groupedById = new Map(rows.map((row) => [Number(row.id), {
      artists: [], groups: [], series: [], characters: [], tags: [],
    }]));
    for (const tag of this.queryRows(
      `SELECT gallery_id, type, name FROM gallery_tags WHERE gallery_id IN (${slots})`
        + ' ORDER BY gallery_id, type, name',
      numericIds,
    )) {
      const grouped = groupedById.get(Number(tag.gallery_id));
      const bucket = META_TAG_GROUPS.get(String(tag.type));
      if (!grouped || !bucket) continue;
      grouped[bucket].push({ type: String(tag.type), name: String(tag.name), negative: false });
    }
    for (const row of rows) {
      const numeric = Number(row.id);
      const grouped = groupedById.get(numeric);
      output.set(numeric, {
        id: numeric,
        source: 'hitomi',
        sourceId: numeric,
        title: row.title || String(numeric),
        type: row.type || '',
        language: row.language
          ? { name: row.language, localName: row.language_local || row.language }
          : null,
        artists: grouped.artists,
        groups: grouped.groups,
        series: grouped.series,
        characters: grouped.characters,
        tags: grouped.tags,
        pageCount: Number(row.page_count) || 0,
        addedDate: row.added_date || null,
        publishedDate: row.published_date || null,
        isBlocked: false,
        hasVideo: false,
        url: row.url || `https://hitomi.la/galleries/${numeric}.html`,
        offline: true,
      });
    }
    return output;
  }

  searchLibrary(payload = {}) {
    // pageSizeMax: 起動時の復元や走査後の引き直しが「今の頁数ぶん」を一度に取るときの上限
    const cap = Math.max(60, Number(payload.pageSizeMax) || 0);
    const size = Math.max(1, Math.min(cap, Number(payload.pageSize) || 24));
    const index = Math.max(0, Number(payload.page) || 0);
    const rewritten = rewriteQuery(payload.query || '');
    const text = rewritten.query;
    const interpreted = rewritten.resolved || [];

    const empty = {
      total: 0,
      page: index,
      pageSize: size,
      query: text,
      interpreted,
      source: 'library',
      galleries: [],
    };
    if (!this.db) return empty;

    const where = ['g.id IN (SELECT DISTINCT gallery_id FROM items WHERE gallery_id IS NOT NULL)'];
    const params = [];
    const titleFilters = [];

    const typedNeedleGroups = [];
    for (const token of text.split(/\s+/).filter(Boolean)) {
      const typed = parseTypePrefix(token);
      if (typed) {
        const name = tagNameKey(typed.name);
        if (!name) continue;
        // 未照合アイテムへの当て方: 詳細タグ (eagle_item_tags) があれば厳密に、
        // 無ければ近似 (タグ名・日本語ラベル・別名辞書の元の語を題 + Eagle タグに
        // 含むか) で判定する。負の指定は詳細タグとの厳密一致だけで弾く
        const needles = new Set([titleNeedle(name)]);
        const label = this.lookupTagLabel(typed.type, name);
        if (label) needles.add(titleNeedle(label));
        for (const entry of interpreted) {
          if (entry && entry.to === token && entry.from) needles.add(titleNeedle(entry.from));
        }
        needles.delete('');
        typedNeedleGroups.push({
          negative: typed.negative === true,
          key: `${typed.type} ${name}`,
          needles: [...needles],
        });
        where.push(
          `${typed.negative ? 'NOT EXISTS' : 'EXISTS'} (SELECT 1 FROM gallery_tags t`
          + ' WHERE t.gallery_id = g.id AND t.type = ? AND t.name = ?)',
        );
        params.push(typed.type, name);
        continue;
      }
      const negative = token.startsWith('-');
      const needle = titleNeedle(negative ? token.slice(1) : token);
      if (!needle) continue;
      // フリーワードは絞り込み後の全件を JS で舐める。所持数が数万規模になったら FTS 化を検討
      titleFilters.push({ negative, needle });
    }

    const language = tagNameKey(payload.language || '');
    if (language) {
      where.push('LOWER(g.language) = ?');
      params.push(language);
    }
    const type = tagNameKey(payload.type || '');
    if (type) {
      where.push('LOWER(g.type) = ?');
      params.push(type);
    }
    const excludeTypeKeys = [...new Set(
      (Array.isArray(payload.excludeTypes) ? payload.excludeTypes : [])
        .map((item) => tagNameKey(item))
        .filter(Boolean),
    )];
    if (excludeTypeKeys.length) {
      where.push(`LOWER(g.type) NOT IN (${excludeTypeKeys.map(() => '?').join(', ')})`);
      params.push(...excludeTypeKeys);
    }

    // お気に入り: 紐付く Eagle アイテムの最高評価がしきい値以上のものだけ
    const minStar = normalizeStar(payload.minStar);
    if (minStar > 0) {
      where.push(`${ITEM_STAR_EXPR} >= ?`);
      params.push(minStar);
    }

    // 栞由来の並びは SQL に落とせない。取り出す順は既定 (追加日) のままにして、
    // 全件を並べ直してから JS で頁を切る (未照合を混ぜるときと同じ道)
    const readingSort = READING_SORTS.has(payload.sort);
    // 栞順は直後にJSで全件を並べ直すため、SQL側は追加日集計を避けられる題名順でよい。
    let order = readingSort ? LIBRARY_ORDER.title : (LIBRARY_ORDER[payload.sort] || LIBRARY_ORDER.added);
    if (payload.sort === 'random') {
      // シード付きの疑似乱数順。同じシードなら頁をまたいでも並びが揺れない
      // (LAN の棚は 30 件ずつ継ぎ足すので、毎回本物の乱数だと重複と抜けが出る)。
      // seed は数値に落としてから埋め込む (文字列を繋がない)
      const seed = Math.floor(Number(payload.seed)) || 0;
      order = `((g.id + ${seed}) * 2654435761) % 4294967296 ASC, g.id ASC`;
    } else if (payload.sortDir === 'asc') {
      // 並びの向き: asc 指定は ORDER BY の向きを丸ごと裏返す (同点解決の列も含めて)
      order = order
        .replace(/\bASC\b/g, '@@')
        .replace(/\bDESC\b/g, 'ASC')
        .replace(/@@/g, 'DESC');
    }
    // 未知のsortとrandom+未照合はJS比較器が追加日へフォールバックする。
    // addedを参照しないことが確実な並びだけ集計JOINを外す。
    const needsAdded = !['published', 'title', 'star', 'reread', 'finished'].includes(payload.sort);
    const from = ` FROM galleries g${ITEM_STAR_JOIN}${needsAdded ? ITEM_ADDED_JOIN : ''}`
      + ` WHERE ${where.join(' AND ')}`;
    const countFrom = ` FROM galleries g${minStar > 0 ? ITEM_STAR_JOIN : ''}`
      + ` WHERE ${where.join(' AND ')}`;
    const columns = `SELECT g.id AS id, g.title AS title, ${ITEM_STAR_EXPR} AS star`;
    const passesTitleFilters = (haystack) => titleFilters.every(({ negative, needle }) => (
      negative ? !haystack.includes(needle) : haystack.includes(needle)
    ));

    // 未照合の Eagle アイテム (設定で混ぜるとき)。種別の指定は満たしようがなく
    // 外す。言語は、詳細タグに language があればそれで判定し、無ければ「日本語」
    // だけ通す (この棚の Eagle アイテムは日本語作品が主で、言語=日本語 を常用して
    // いる環境で未照合が丸ごと消えるのは期待に反する。2026-08-28 実害あり)
    let unmatched = [];
    if (!type) {
      // nhentai・E-Hentai に手で結んだ項目は未照合ではない: 設定で混ぜない時も並べる
      // (hitomi の素性の表に居ないので、ここで拾わないと所持作品の一覧から消える)
      const entries = this.unmatchedEagleEntries();
      unmatched = payload.includeUnmatched === true ? entries : entries.filter((entry) => entry.link);
    }
    if (unmatched.length) {
      if (language) {
        unmatched = unmatched.filter((entry) => (
          entry.languages && entry.languages.length
            ? entry.languages.includes(language)
            : language === 'japanese'
        ));
      }
      if (minStar > 0) unmatched = unmatched.filter((entry) => entry.star >= minStar);
      if (typedNeedleGroups.length) {
        unmatched = unmatched.filter((entry) => typedNeedleGroups.every((group) => {
          const hasTag = entry.tagKeys && entry.tagKeys.has(group.key);
          if (group.negative) return !hasTag;
          return hasTag || group.needles.some((needle) => entry.haystack.includes(needle));
        }));
      }
      if (titleFilters.length) {
        unmatched = unmatched.filter((entry) => passesTitleFilters(entry.haystack));
      }
    }

    let total = 0;
    let slice = [];
    if (unmatched.length || readingSort) {
      // 混ぜるとき・栞で並べるときはページ切りを SQL に任せられない。所持作品は
      // 多くて数千件なので、両方を並べてから JS で切る (並び方は LIBRARY_ORDER と同じ意味)
      const rows = this.queryRows(
        `${columns}, ${needsAdded ? ITEM_ADDED_EXPR : '0'} AS added_ms,`
          + ` g.published_date AS published${from}`,
        params,
      )
        .filter((row) => !titleFilters.length || passesTitleFilters(titleNeedle(row.title)))
        .map((row) => ({
          id: row.id,
          title: String(row.title || ''),
          star: normalizeStar(row.star),
          // 未照合側 (ISO 文字列) と比べられる形に揃える
          added: Number(row.added_ms) ? new Date(Number(row.added_ms)).toISOString() : '',
          published: String(row.published || ''),
        }));
      const compare = libraryComparator(payload.sort, payload.sortDir, payload.reading);
      const merged = rows.concat(unmatched).sort((a, b) => {
        const result = compare(a, b);
        if (result) return result;
        // gallery id と Eagle id が同じ文字列になった場合も、従来の連結順を固定する。
        return Number(Boolean(a.eagleId)) - Number(Boolean(b.eagleId));
      });
      total = merged.length;
      slice = merged.slice(index * size, index * size + size);
    } else if (titleFilters.length) {
      // フリーワードは SQL に落とせない。従来どおり絞り込み後の全件を JS で舐める
      const rows = this.queryRows(`${columns}${from} ORDER BY ${order}`, params)
        .filter((row) => passesTitleFilters(titleNeedle(row.title)));
      total = rows.length;
      slice = rows.slice(index * size, index * size + size);
    } else {
      // 語が無ければ SQL 側で切り出す。件数は COUNT で別に数える
      total = Number(this.queryValue(`SELECT COUNT(*) AS n${countFrom}`, params)) || 0;
      slice = this.queryRows(
        `${columns}${from} ORDER BY ${order} LIMIT ? OFFSET ?`,
        [...params, size, index * size],
      );
    }

    // 星は絞り込みに使った値をそのまま持たせる。annotate の照合 (ID 検証 + タイトル
    // 代替) は別の道筋なので、任せると「★4 以上」の一覧に ★3 の札が混じる
    const metaById = this.getGalleryMetaBatch(slice.filter((row) => !row.eagleId).map((row) => row.id));
    const galleries = slice
      .map((row) => {
        if (row.eagleId) return this.eagleItemGalleryFromEntry(row);
        const meta = metaById.get(Number(row.id));
        return meta ? { ...meta, star: normalizeStar(row.star) } : null;
      })
      .filter(Boolean);

    return { ...empty, total, galleries };
  }

  // 未照合アイテムの詳細タグの書き込み。serializedList は hitomi/eh/nh の
  // ギャラリー (serialize 済み) の配列で、全部の和を持つ (兄弟話ぶんの合算)
  storeEagleItemTags(eagleId, serializedList) {
    if (this.scanning) {
      this.scanQueue.push(() => this.storeEagleItemTags(eagleId, serializedList));
      return true;
    }
    if (!this.db) return false;
    const key = String(eagleId || '').trim();
    if (!key) return false;
    const seen = new Set();
    const rows = [];
    for (const serialized of serializedList || []) {
      for (const [type, name] of metaTagRows(serialized || {})) {
        const rowKey = `${type} ${name}`;
        if (seen.has(rowKey)) continue;
        seen.add(rowKey);
        rows.push([type, name]);
      }
    }
    this.bumpUnmatchedGen(); // 詳細タグは haystack と metaTags の入力
    this.db.run('DELETE FROM eagle_item_tags WHERE eagle_id = ?', [key]);
    if (rows.length) {
      const stmt = this.db.prepare(
        'INSERT OR IGNORE INTO eagle_item_tags (eagle_id, type, name) VALUES (?, ?, ?)',
      );
      try {
        for (const [type, name] of rows) stmt.run([key, type, name]);
      } finally {
        stmt.free();
      }
    }
    this.persistSoon();
    return true;
  }

  // eagle_item_tags を eagle_id ごとに束ねて返す (無ければ空配列)
  eagleItemTagMap(eagleIds = null) {
    const map = new Map();
    if (!this.db) return map;
    let rows;
    if (eagleIds && eagleIds.length) {
      const marks = eagleIds.map(() => '?').join(', ');
      rows = this.queryRows(
        `SELECT eagle_id, type, name FROM eagle_item_tags WHERE eagle_id IN (${marks})`,
        eagleIds.map(String),
      );
    } else {
      rows = this.queryRows('SELECT eagle_id, type, name FROM eagle_item_tags');
    }
    for (const row of rows) {
      const key = String(row.eagle_id);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push({ type: String(row.type), name: String(row.name) });
    }
    return map;
  }

  // 未照合一覧の控えを無効にする。入力を変える書き込みは全部ここを通す:
  // upsert (走査・紐付け・復元の実書き込み) / storeEagleItemTags /
  // loadTagLabels (辞書・学習ラベル) / rebuildMemory (解除・削除・星の総仕上げ) /
  // scanEagle の COMMIT・ROLLBACK (消えたアイテムぶんは upsert を通らない)
  bumpUnmatchedGen() {
    this.unmatchedGen += 1;
  }

  // ── よそのサイトの作品を、手持ちの hitomi 版と突き合わせる ──────────
  //
  // 所持は「ソースごとの ID」で持っている。hitomi の 4187532 を持っていても、
  // nhentai の nh:12345 とは何も結びつかないので、**nhentai を見ている間は
  // 何を持っているのか分からなかった**。
  //
  // 蔵書は hitomi 中心 (実測: 題が一致した 28 件すべてに hitomi の ID が有った)
  // なので、当て先を hitomi のメタ (galleries) にする。Eagle のファイル名ではなく
  // サイトのメタ同士を比べられるので、**頁数**という決め手が使える。
  //
  // 規則: 題の鍵が一致 かつ 頁数が ±2。実測 (2026-09-15、所持 212 冊):
  //   nhentai にも在る作品のうち拾えた率 82.9% / 対照 311 件での誤爆 0。
  //   頁数を外すと、短い題を共用する連作を取り違える (63 頁の作品に 51/41/35 頁が
  //   ぶら下がった) ので **頁数は必須**
  crossOwnedIndex() {
    if (this.crossOwned && this.crossOwnedGen === this.unmatchedGen) return this.crossOwned;
    const byKey = new Map();
    if (this.db) {
      for (const row of this.queryRows(
        `SELECT g.id AS id, g.title AS title, g.page_count AS pages
           FROM galleries g JOIN items i ON i.gallery_id = g.id
          WHERE g.title IS NOT NULL AND g.title != '' AND g.page_count > 0
          GROUP BY g.id`,
      )) {
        const key = titleKey(row.title);
        if (!key || !titleKeyEligible(key)) continue;
        const list = byKey.get(key) || [];
        list.push({ galleryId: Number(row.id), pages: Number(row.pages) || 0 });
        byKey.set(key, list);
      }
    }
    this.crossOwned = byKey;
    this.crossOwnedGen = this.unmatchedGen;
    return byKey;
  }

  crossSourceOwned(gallery) {
    if (!gallery || gallery.error) return null;
    const source = String(gallery.source || 'hitomi');
    // hitomi は自前の ID で分かる。pawchive と Eagle アイテムは別の台帳の持ち場
    if (!CROSS_OWNED_SOURCES.has(source)) return null;
    const pages = Number(gallery.pageCount) || 0;
    if (!pages) return null; // 頁数が分からなければ決めない
    const key = titleKey(gallery.title);
    if (!key || !titleKeyEligible(key)) return null;
    const hits = this.crossOwnedIndex().get(key);
    if (!hits) return null;
    const hit = hits.find((row) => Math.abs(row.pages - pages) <= CROSS_OWNED_PAGE_TOLERANCE);
    if (!hit) return null;
    return {
      galleryId: hit.galleryId,
      // 所持の実体 (Eagle のアイテム)。「Eagle で開く」がそのまま使える
      eagleId: this.eagleByGallery.get(String(hit.galleryId)) || null,
    };
  }

  // 未照合の Eagle アイテムを、所持一覧に混ぜられる形で引く。
  // haystack はフリーワード検索の当て先 (題 + Eagle のタグ + 詳細タグとそのラベル)
  unmatchedEagleEntries() {
    if (!this.db) return [];
    // 世代が動いていなければ組み直さない。外側の配列だけ浅くコピーして返す
    // (呼び手の filter/concat は要素を書き換えないが、配列自体の共有は避ける)
    if (this.unmatchedCache && this.unmatchedCache.gen === this.unmatchedGen) {
      return this.unmatchedCache.entries.slice();
    }
    // nhentai・E-Hentai に手で結んだ項目 (gallery_id が 'nh:123' 型の文字列) も同じ疑似ギャラリーで出す:
    // hitomi の素性の表 (galleries) に居ないので、ここで拾わないと所持作品の一覧からも作者頁からも消える
    const rows = this.queryRows(
      "SELECT path, title, star, added_at, eagle_tags, gallery_id FROM items"
      + " WHERE source = 'eagle'"
      + " AND (gallery_id IS NULL OR (typeof(gallery_id) = 'text' AND (gallery_id LIKE 'nh:%' OR gallery_id LIKE 'eh:%')))"
      + " AND title IS NOT NULL AND title != ''",
    );
    const metaTagsById = this.eagleItemTagMap();
    const entries = [];
    for (const row of rows) {
      const eagleId = eagleIdFromPath(row.path);
      if (!eagleId) continue;
      let tags = [];
      try {
        tags = JSON.parse(String(row.eagle_tags || '[]'));
      } catch {
        tags = [];
      }
      tags = (Array.isArray(tags) ? tags : []).map(String).filter(Boolean);
      const addedAt = Number(row.added_at) || 0;
      const metaTags = metaTagsById.get(eagleId) || [];
      // 詳細タグの名前と日本語ラベルもフリーワードの当て先に混ぜる
      const labelWords = [];
      const tagKeys = new Set();
      for (const tag of metaTags) {
        tagKeys.add(`${tag.type} ${tag.name}`);
        labelWords.push(tag.name);
        const label = this.lookupTagLabel(tag.type, tag.name);
        if (label) labelWords.push(label);
      }
      const link = row.gallery_id != null && /^(nh|eh):/.test(String(row.gallery_id)) ? String(row.gallery_id) : null;
      entries.push({
        eagleId,
        // 手の結び先 (nh:/eh:)。null なら未照合
        link,
        title: String(row.title || ''),
        star: normalizeStar(row.star),
        // galleries.added_date と同じ ISO 表記に揃えて、混ぜても並びが成立するように
        added: addedAt ? new Date(addedAt).toISOString() : '',
        published: '',
        tags,
        metaTags,
        tagKeys,
        languages: metaTags.filter((tag) => tag.type === 'language').map((tag) => tag.name),
        haystack: titleNeedle(`${row.title} ${tags.join(' ')} ${labelWords.join(' ')}`),
      });
    }
    // 組み立ては同期処理なので、途中で世代が動くことはない
    this.unmatchedCache = { gen: this.unmatchedGen, entries };
    return entries.slice();
  }

  // 未照合アイテムの疑似ギャラリー。pawchive の Eagle アイテム (pweagle:) と同じ
  // 形にして、表紙 (/pweagle/)・読書 (/pwfile/)・「Eagle で開く」の経路を共用する。
  // 詳細タグ (eagle_item_tags: 兄弟話や eh/nh 由来) があれば hitomi 作品と同じ
  // 顔でタグを並べる。Eagle 側のタグは重複しないぶんだけ添える
  eagleItemGalleryFromEntry(entry) {
    const grouped = { artists: [], groups: [], series: [], characters: [], tags: [] };
    let language = null;
    const shown = new Set();
    for (const tag of entry.metaTags || []) {
      if (tag.type === 'language') {
        if (!language) language = { name: tag.name, localName: tag.name };
        continue;
      }
      if (tag.type === 'type') continue;
      const bucket = META_TAG_GROUPS.get(tag.type);
      if (!bucket) continue;
      const label = this.lookupTagLabel(tag.type, tag.name);
      // typed: hitomi 流の型付きタグの印。renderer はこれを hitomi 作品と同じ
      // 顔 (male:馬並み) で描き、検索も male:horse_cock で組む。印の無い行は
      // Eagle 利用者の付けた語そのもの (型なし) として扱う
      grouped[bucket].push({
        type: tag.type, name: tag.name, negative: false, typed: true,
        ...(label ? { label } : {}),
      });
      shown.add(tagNameKey(tag.name));
      if (label) shown.add(tagNameKey(label));
    }
    for (const name of entry.tags || []) {
      if (shown.has(tagNameKey(name))) continue; // ラベルと同じ Eagle タグは重ねない
      grouped.tags.push({ type: 'tag', name, negative: false });
    }
    // nhentai・E-Hentai に手で結んだ項目は、札の印をその源泉にし、nhentai なら頁へ渡る道を持たせる
    const link = entry.link ? String(entry.link) : '';
    const nhId = /^nh:(\d+)$/.exec(link);
    return {
      id: pawEagleGalleryId(entry.eagleId),
      source: 'pawchive',
      sourceId: entry.eagleId,
      title: entry.title,
      type: '',
      language,
      artists: grouped.artists,
      groups: grouped.groups,
      series: grouped.series,
      characters: grouped.characters,
      tags: grouped.tags,
      pageCount: 0,
      badge: link ? (link.startsWith('nh:') ? 'nhentai' : 'E-Hentai') : '未照合',
      addedDate: entry.added || null,
      publishedDate: null,
      isBlocked: false,
      hasVideo: false,
      url: nhId ? `https://nhentai.net/g/${nhId[1]}/` : '',
      offline: true,
      owned: true,
      kind: 'eagleItem',
      eagleId: entry.eagleId,
      star: entry.star,
      unmatched: !link,
      ...(link ? { linkedKey: link } : {}),
    };
  }

  // 疑似ギャラリーを eagleId で引き直す口 (詳細表示の 'gallery' IPC と、手のひら版の
  // 一冊の札から来る)。一覧 (unmatchedEagleEntries) と同じ行から起こす。
  // 以前は読み替え後の道 (eagleBasePath) で items.path を引いていたが、台帳の path は
  // 母艦の表記のまま写るので、写し (別の根で同じライブラリを開く機体) では一件も当たらなかった
  eagleItemGallery(eagleId) {
    const key = String(eagleId || '').trim();
    if (!key || !this.db) return null;
    const entry = this.unmatchedEagleEntries().find((row) => row.eagleId === key);
    return entry ? this.eagleItemGalleryFromEntry(entry) : null;
  }

  libraryStatus() {
    if (!this.db) {
      return {
        owned: 0,
        withMeta: 0,
        unmatchedEagle: 0,
        backfill: null,
        titleMatch: { matched: 0, ambiguous: 0, none: 0, skipped: 0, pending: 0 },
        matchJob: null,
        eagleTag: { pushed: 0, pending: 0 },
        eagleTagJob: null,
      };
    }
    const owned = Number(this.queryValue(
      'SELECT COUNT(DISTINCT gallery_id) AS n FROM items WHERE gallery_id IS NOT NULL',
    )) || 0;
    const withMeta = Number(this.queryValue(
      'SELECT COUNT(*) AS n FROM galleries'
      + ' WHERE id IN (SELECT DISTINCT gallery_id FROM items WHERE gallery_id IS NOT NULL)',
    )) || 0;
    const unmatchedEagle = Number(this.queryValue(
      "SELECT COUNT(*) AS n FROM items WHERE source = 'eagle' AND gallery_id IS NULL",
    )) || 0;
    let backfill = null;
    try {
      backfill = this.backfillRef ? this.backfillRef.status() : null;
    } catch {
      backfill = null;
    }
    let matchJob = null;
    try {
      matchJob = this.matchJobRef ? this.matchJobRef.status() : null;
    } catch {
      matchJob = null;
    }
    let eagleTagJob = null;
    try {
      eagleTagJob = this.eagleTaggerRef ? this.eagleTaggerRef.status() : null;
    } catch {
      eagleTagJob = null;
    }
    return {
      owned,
      withMeta,
      unmatchedEagle,
      backfill,
      titleMatch: this.titleMatchStats(),
      matchJob,
      eagleTag: this.eagleTagStats(),
      eagleTagJob,
    };
  }

  // タイトルから拾った ID は別サイトの番号と衝突しうる。取得したギャラリーの
  // タイトルが、その ID の出所アイテム名とかけ離れていたら別作品とみなす
  titleMatchesMeta(galleryId, galleryTitle) {
    const numeric = numericGalleryId(galleryId);
    if (numeric == null) return false;
    const galleryKey = titleKey(galleryTitle);
    if (!galleryKey) return false;
    const rows = this.queryRows('SELECT DISTINCT title FROM items WHERE gallery_id = ?', [numeric]);
    if (!rows.length) return true; // 出所アイテムが無ければ照合しようがない
    for (const row of rows) {
      const itemKey = titleKey(row.title);
      if (!itemKey) continue;
      if (itemKey === galleryKey) return true;
      // 包含を許すのは、はみ出しが巻数のしるしでないときだけ。
      // ここが素通しだと、続刊同士 (ii ⊂ iii など) が同じ本と検証されてしまう
      if (titleKeyWeight(galleryKey) >= 6 && itemKey.includes(galleryKey)
        && volumeSafeContains(itemKey, galleryKey)) return true;
      if (titleKeyWeight(itemKey) >= 6 && galleryKey.includes(itemKey)
        && volumeSafeContains(galleryKey, itemKey)) return true;
    }
    return false;
  }

  // 台帳で 'matched' になっている gallery_id → eagle_id の対応。isOwned は
  // カードを描くたびに通るので、一度作って覚えておき台帳が動いたら捨てる
  titleMatchLinkMap() {
    if (this.titleMatchLinks) return this.titleMatchLinks;
    const map = new Map();
    for (const row of this.queryRows(
      "SELECT eagle_id, gallery_id FROM title_matches WHERE status = 'matched' AND gallery_id IS NOT NULL",
    )) {
      const key = galleryKeyOf(row.gallery_id);
      if (key != null && !map.has(key)) map.set(key, String(row.eagle_id));
    }
    this.titleMatchLinks = map;
    return map;
  }

  // その Eagle アイテムが今どの作品へ繋がっているか (鍵、無ければ null)。
  // 付け替えの前に「どの作品から外れるか」を知るために引く
  linkedGalleryOf(eagleId) {
    const key = String(eagleId || '').trim();
    if (!key || !this.db) return null;
    const row = this.queryRows(
      "SELECT gallery_id FROM title_matches WHERE eagle_id = ? AND status = 'matched'",
      [key],
    )[0];
    return row ? galleryKeyOf(row.gallery_id) : null;
  }

  // 台帳経由で紐付いている Eagle アイテム。解除 (removeTitleMatch) の相手になる
  findTitleMatchLink(id) {
    const key = galleryKeyOf(id);
    if (key == null || !this.db) return null;
    return this.titleMatchLinkMap().get(key) || null;
  }

  pendingMetaIds({ maxAttempts = 3, cooldown = 7 * 24 * 60 * 60 * 1000 } = {}) {
    if (!this.db) return [];
    const rows = this.queryRows(
      `SELECT i.gallery_id AS id, MAX(i.updated_at) AS updated_at
         FROM items i
        WHERE i.gallery_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM galleries g WHERE g.id = i.gallery_id)
          AND NOT EXISTS (
            SELECT 1 FROM gallery_fetch_failures f
             WHERE f.id = i.gallery_id AND f.attempts >= ? AND f.last_attempt >= ?
          )
        GROUP BY i.gallery_id
        ORDER BY updated_at DESC`,
      [maxAttempts, Date.now() - cooldown],
    );
    return rows.map((row) => Number(row.id)).filter((id) => Number.isFinite(id));
  }

  // 入れ子にならない BEGIN〜COMMIT。走査 (applyEagleScan) も張るが、走査中の
  // 書き込みは scanQueue に退避されるので、ここと同時に開くことはない。
  // 途中で落ちたら ROLLBACK: 台帳 (title_matches) と棚 (items) が片方だけ
  // 進んだ姿を残さない
  txn(fn) {
    if (!this.db || this.inTxn) return fn();
    this.inTxn = true;
    this.db.run('BEGIN');
    try {
      const out = fn();
      this.db.run('COMMIT');
      return out;
    } catch (error) {
      try {
        this.db.run('ROLLBACK');
      } catch {
        // 既に落ちているときは戻すものが無い
      }
      throw error;
    } finally {
      this.inTxn = false;
    }
  }

  // タイトル照合の結果を台帳に書く。'matched' はその場で items にも紐付けて、
  // 次のスキャンを待たずに所持判定へ反映する。
  // origin === 'manual' は利用者が選んだ紐付け: 以後の自動照合は断る
  addTitleMatch(eagleId, galleryId, itemTitle, matchedTitle, status, options = {}) {
    if (this.scanning) {
      this.scanQueue.push(
        () => this.addTitleMatch(eagleId, galleryId, itemTitle, matchedTitle, status, options),
      );
      return true;
    }
    if (!this.db) return false;
    const key = String(eagleId || '').trim();
    if (!key) return false;
    const state = TITLE_MATCH_STATES.has(status) ? status : 'none';
    const linkKey = state === 'matched' ? galleryKeyOf(galleryId) : null;
    const manual = String((options && options.origin) || '') === 'manual';
    // **書く前に今の行を読む。** 付け替え (別の作品へ繋ぎ直す) では、この
    // gallery_id が「引き継ぎ元の items 行」を指す唯一の手がかりになる
    const prior = this.queryRows(
      'SELECT gallery_id, status, origin FROM title_matches WHERE eagle_id = ?',
      [key],
    )[0] || null;
    // 手で決めた紐付けは自動照合より強い。走査のたびに機械が上書きしない
    if (!manual && prior && String(prior.origin || '') === 'manual' && String(prior.status || '') === 'matched') {
      return false;
    }
    const priorLink = prior ? galleryKeyOf(prior.gallery_id) : null;
    const origin = manual ? 'manual' : (prior ? (prior.origin || null) : null);

    this.txn(() => {
      this.db.run(
        `INSERT INTO title_matches
           (eagle_id, gallery_id, status, item_title, matched_title, attempts, last_attempt, origin)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(eagle_id) DO UPDATE SET
           gallery_id = excluded.gallery_id,
           status = excluded.status,
           item_title = excluded.item_title,
           matched_title = excluded.matched_title,
           attempts = title_matches.attempts + 1,
           last_attempt = excluded.last_attempt,
           origin = excluded.origin`,
        [
          key,
          linkKey,
          state,
          String(itemTitle || ''),
          String(matchedTitle || ''),
          Date.now(),
          origin,
        ],
      );
      if (state === 'matched' && linkKey != null) {
        this.linkTitleMatch(key, linkKey, itemTitle, priorLink);
      }
    });

    // 付け替えのときだけ索引を組み直す。前の作品の ID が idSet / eagleByGallery に
    // 残ったままだと、繋ぎ直したのに元の作品が 済 のまま出る。
    // 新規の紐付け (照合器の通り道) では起きないので、そちらは走らせない
    // — 1 万件のランで毎回 items を全走査させないため
    if (state === 'matched' && linkKey != null && priorLink != null && priorLink !== linkKey) {
      this.rebuildMemory();
    }
    if (!prior) this.titleMatchPending = null;
    this.titleMatchLinks = null;
    this.persistSoon();
    return true;
  }

  // 台帳の行を 'unlinked' の墓標に替え、items の `<path>#<gallery_id>` 行も戻す。
  // 手動の紐付け解除と、誤った自動照合の取り消しに使う。行ごと消すと照合器が
  // 「未処理」と見なして同じ紐付けを作り直すので、墓標を残して再挑戦を止める
  // (題での所持判定からも外す: rebuildMemory が墓標持ちを titleSet に入れない)
  removeTitleMatch(eagleId) {
    if (this.scanning) {
      this.scanQueue.push(() => this.removeTitleMatch(eagleId));
      return true;
    }
    if (!this.db) return false;
    const key = String(eagleId || '').trim();
    if (!key) return false;
    const row = this.queryRows(
      'SELECT gallery_id, item_title FROM title_matches WHERE eagle_id = ?',
      [key],
    )[0] || null;
    const base = this.eagleBasePath.get(key);
    let galleryId = row ? galleryKeyOf(row.gallery_id) : null;
    // 照合の記録に結び先が無い (照合器が飛ばした・一度も照合していない) のに結ばれているのは、
    // 名前・注釈・URL の [数字] から走査が作った行 (<base>#<id>)。それを外す時は墓標に外した番号を残し、
    // 走査がその項目の番号を拾い直さないようにする (残さないと次の走査で結び直され、hitomi から
    // 消えた作品に結ばれたまま一覧から消えていた。2026-09-24)。照合器・手の結びを外す時は今までどおり
    // その結びだけを外し、墓標の番号は空 (名前の番号の結びは残る)
    let fromName = null;
    if (galleryId == null && base) {
      fromName = galleryKeyOf(this.queryValue(
        "SELECT gallery_id AS value FROM items WHERE source = 'eagle' AND path LIKE ? ESCAPE '\\' LIMIT 1",
        [`${likePattern(base)}#%`],
      ));
      galleryId = fromName;
    }
    if (!row && fromName == null) return false;
    if (row) {
      this.db.run(
        "UPDATE title_matches SET gallery_id = ?, status = 'unlinked', last_attempt = ? WHERE eagle_id = ?",
        [fromName, Date.now(), key],
      );
    } else {
      this.db.run(
        `INSERT INTO title_matches
           (eagle_id, gallery_id, status, item_title, matched_title, attempts, last_attempt, origin)
         VALUES (?, ?, 'unlinked', '', '', 1, ?, NULL)`,
        [key, fromName, Date.now()],
      );
    }

    if (galleryId != null && base) {
      // 名前の番号を外す時は、その項目の番号の行を全部外す (名前に番号が二つある時も)
      const linkedPaths = fromName != null
        ? this.queryRows(
          "SELECT path FROM items WHERE source = 'eagle' AND path LIKE ? ESCAPE '\\'",
          [`${likePattern(base)}#%`],
        ).map((linked) => linked.path)
        : [`${base}#${galleryId}`];
      const linkedRow = this.queryRows(
        "SELECT title, star, added_at, eagle_tags FROM items WHERE source = 'eagle' AND path = ?",
        [linkedPaths[0]],
      )[0];
      for (const linkedPath of linkedPaths) {
        this.db.run("DELETE FROM items WHERE source = 'eagle' AND path = ?", [linkedPath]);
      }
      // ID 付きの行が全て消えたら ID 無しの素の行に戻す: 紐付けは解いても
      // アイテムそのものは Eagle に在る (次のスキャンまで消さない)。
      // 残りの有無を見るだけなので、eagle の全行を JS へ引き出さず 1 件で打ち切る
      const remaining = this.queryValue(
        "SELECT 1 AS n FROM items WHERE source = 'eagle'"
        + ESCAPED_PATH_PREFIX_CLAUSE
        + ' LIMIT 1',
        [base, `${likePattern(base)}#%`],
      ) != null;
      if (!remaining) {
        // 解除でも星・追加日時・タグは落とさない (紐付けの引き継ぎと対)
        let restoredTags = null;
        if (linkedRow && linkedRow.eagle_tags) {
          try {
            const parsed = JSON.parse(String(linkedRow.eagle_tags));
            if (Array.isArray(parsed) && parsed.length) restoredTags = parsed;
          } catch {
            // 読めない控えは次の走査が入れ直す
          }
        }
        this.upsert({
          source: 'eagle',
          filePath: base,
          galleryId: null,
          title: linkedRow ? String(linkedRow.title || '') : String((row && row.item_title) || ''),
          star: linkedRow ? linkedRow.star : null,
          addedAt: linkedRow ? linkedRow.added_at : null,
          eagleTags: restoredTags,
        });
      }
    }

    this.titleMatchLinks = null;
    this.titleMatchPending = null;
    // idSet などは items から作り直す。手動操作なので全走査で構わない
    this.rebuildMemory();
    this.persistSoon();
    return true;
  }

  // Eagle のゴミ箱送りに合わせて、アイテムの痕跡を台帳から丸ごと落とす。
  // removeTitleMatch と違い素の行も戻さない (アイテム自体がもう無い)。
  // Eagle が metadata.json の isDeleted を書くのは遅い (内部 DB が先) ので、
  // 走査が拾い直さないよう墓標 (eagle_trash) を残す
  removeEagleItem(eagleId) {
    const key = String(eagleId || '').trim();
    if (!key) return false;
    // 墓標だけは走査中でも先に立てる。走査が途中で拾い直すのを止められるし、
    // 書き込みを待たせても「もう捨てた」という事実は今すぐ効かせたい
    this.eagleTrash.add(key);
    if (this.scanning) {
      this.scanQueue.push(() => this.removeEagleItem(key));
      return true;
    }
    if (!this.db) return false;
    this.db.run('INSERT OR REPLACE INTO eagle_trash (id, at) VALUES (?, ?)', [key, Date.now()]);
    const base = this.eagleBasePath.get(key);
    this.txn(() => {
      this.db.run('DELETE FROM title_matches WHERE eagle_id = ?', [key]);
      if (base) {
        // 以前はここで eagle の全行を JS へ引き出して 1 件ずつ見比べていた。
        // 2 万件の蔵書では、釦を押すたびにその全走査が主スレッドに入っていた。
        // 素の行と `<base>#<id>` の行は 1 本の DELETE で足りる
        this.db.run(
          "DELETE FROM items WHERE source = 'eagle'" + ESCAPED_PATH_PREFIX_CLAUSE,
          [base, `${likePattern(base)}#%`],
        );
      }
    });
    this.titleMatchLinks = null;
    this.titleMatchPending = null;
    this.rebuildMemory();
    this.persistSoon();
    return true;
  }

  // 手動紐付けのピッカー用。Eagle アイテムを名前で引く。既に台帳で紐付いて
  // いるものは候補から外す (付け替えるなら先に解除する)
  // リーダーで付けた星をその場で台帳に写す。次のスキャンを待たずに
  // お気に入り絞り込みや札の★表示へ反映させるため
  setEagleItemStar(eagleId, star) {
    if (this.scanning) {
      this.scanQueue.push(() => this.setEagleItemStar(eagleId, star));
      return true;
    }
    if (!this.db) return false;
    const key = String(eagleId || '').trim();
    if (!key) return false;
    const base = this.eagleBasePath.get(key);
    if (!base) return false;
    const rating = normalizeStar(star);
    for (const row of this.queryRows("SELECT path FROM items WHERE source = 'eagle'")) {
      const value = String(row.path || '');
      if (value === base || value.startsWith(`${base}#`)) {
        this.db.run("UPDATE items SET star = ? WHERE source = 'eagle' AND path = ?", [rating, value]);
      }
    }
    // 星の索引 (starByGallery / starByTitle) は最大値で持っている: 下げにも
    // 対応できるよう items から作り直す
    this.rebuildMemory();
    this.persistSoon();
    return true;
  }

  // 同じ作品 (同じ gallery_id) に紐付く他の Eagle アイテム。星の表示は
  // 「最高星を代表」なので、下げるときは姉妹にも同じ星を書かないと巻き戻る
  eagleSiblings(eagleId) {
    if (!this.db) return [];
    const key = String(eagleId || '').trim();
    const base = this.eagleBasePath.get(key);
    if (!base) return [];
    const ids = this.queryRows(
      "SELECT DISTINCT gallery_id FROM items WHERE source = 'eagle' AND gallery_id IS NOT NULL"
      + " AND (path = ? OR path LIKE ? ESCAPE '\\')",
      [base, `${likePattern(base)}#%`],
    ).map((row) => galleryKeyOf(row.gallery_id)).filter((value) => value != null);
    const out = new Set();
    for (const galleryId of ids) {
      for (const row of this.queryRows(
        "SELECT path FROM items WHERE source = 'eagle' AND gallery_id = ?", [galleryId],
      )) {
        const sibling = eagleIdFromPath(row.path);
        if (sibling) out.add(sibling);
      }
    }
    out.delete(key);
    return [...out];
  }

  searchEagleItems(query, limit = 20) {
    if (!this.db) return [];
    const max = Math.max(1, Math.min(50, Number(limit) || 20));
    const text = String(query || '').trim();
    // **別の作品へ繋がっているアイテムも候補に残す。** 以前はここで落として
    // いたが、「一度繋いだアイテムが二度と検索に出ない」ので、繋ぎ先を間違えた
    // ときに直す手立てが無くなっていた (先に解除する、を利用者が思いつけない)。
    // 落とさずに繋ぎ先を添えて返し、画面が鎖の印で見分ける。選べば付け替え
    const linked = new Map();
    for (const row of this.queryRows(
      "SELECT eagle_id, gallery_id FROM title_matches WHERE status = 'matched' AND gallery_id IS NOT NULL",
    )) {
      const key = galleryKeyOf(row.gallery_id);
      if (key != null) linked.set(String(row.eagle_id), key);
    }

    const params = [];
    let sql = "SELECT path, title, gallery_id FROM items"
      + " WHERE source = 'eagle' AND title IS NOT NULL AND title != ''";
    if (text) {
      sql += " AND title LIKE ? ESCAPE '\\'";
      params.push(`%${likePattern(text)}%`);
    }
    // 同じアイテムが ID ごとに複数行あるので、畳む前提で多めに引く
    sql += ' ORDER BY title LIMIT ?';
    params.push(max * 4);

    const seen = new Map();
    for (const row of this.queryRows(sql, params)) {
      const eagleId = eagleIdFromPath(row.path);
      if (!eagleId || seen.has(eagleId)) continue;
      seen.set(eagleId, {
        eagleId,
        title: String(row.title || ''),
        galleryId: galleryKeyOf(row.gallery_id),
        // 台帳で別の作品へ繋がっているなら、その鍵 (画面の鎖の印と付け替えの目印)
        linkedGalleryId: linked.has(eagleId) ? linked.get(eagleId) : null,
      });
    }
    // まだ ID の付いていないアイテムが本命。先頭に寄せる
    const hits = [...seen.values()];
    hits.sort((a, b) => (a.galleryId == null ? 0 : 1) - (b.galleryId == null ? 0 : 1));
    return hits.slice(0, max);
  }

  // 紐付いた作品は `<フォルダ>#<gallery_id>` の行として items に置く。
  // ID 無しで登録していた素の行 (と、付け替えなら前の紐付け先の行) はその
  // 置き換えなので、**空の行を作って捨てるのではなく中身を引き継ぐ**。
  // 星・追加日時・Eagle のタグは走査が metadata から入れた値で、items にしか
  // 無い。作り直すと次の走査まで null のままになり、Eagle では ★4 なのに
  // 付け替え直後の BUNKO から星が消える (それがこの引き継ぎの理由)。
  //
  // 名前から ID が採れているアイテムの兄弟行 (`base#<抽出 ID>`) は触らない。
  // あれは走査が metadata から組み直す持ち物で、紐付けの管轄ではない
  linkTitleMatch(eagleId, galleryId, itemTitle, previousGalleryId = null) {
    const base = this.eagleBasePath.get(eagleId);
    if (!base) return;
    const key = String(galleryId);
    const target = `${base}#${key}`;
    // 引き継ぎ元。素の行が本命で、付け替えでは前の紐付け先の行が持っている
    const donorPaths = [base];
    const previous = galleryKeyOf(previousGalleryId);
    if (previous != null && previous !== key) donorPaths.push(`${base}#${previous}`);
    // 行き先が既に在るとき (名前から採れた ID と繋ぎ先が同じ) は自分から引き継ぐ。
    // 引き継ぎ元なしで upsert すると、その行の星を null で塗り潰してしまう
    donorPaths.push(target);

    let donorPath = null;
    let donor = null;
    for (const candidate of donorPaths) {
      const row = this.queryRows(
        "SELECT title, star, added_at, eagle_tags FROM items WHERE source = 'eagle' AND path = ?",
        [candidate],
      )[0];
      if (row) {
        donorPath = candidate;
        donor = row;
        break;
      }
    }

    let tags = null;
    if (donor && donor.eagle_tags) {
      try {
        const parsed = JSON.parse(String(donor.eagle_tags));
        if (Array.isArray(parsed) && parsed.length) tags = parsed;
      } catch {
        // 読めない控えは引き継がない (次の走査が metadata から入れ直す)
      }
    }

    this.upsert({
      source: 'eagle',
      filePath: target,
      galleryId,
      title: String(itemTitle || (donor && donor.title) || ''),
      star: donor ? donor.star : null,
      addedAt: donor ? donor.added_at : null,
      eagleTags: tags,
    });
    if (donorPath && donorPath !== target) {
      this.db.run("DELETE FROM items WHERE source = 'eagle' AND path = ?", [donorPath]);
    }
  }

  // 優先フォルダ(子孫込み)と未分類のアイテムを先頭に並べ替える。
  // フォルダ所属は各 metadata.json を読んで判定する(ラン開始時の一度きり)
  prioritizeTargets(targets, { priorityFolders, libraryRoot } = {}) {
    const folderIds = (priorityFolders || []).map((id) => String(id || '').trim()).filter(Boolean);
    if (!folderIds.length || !libraryRoot) return targets;
    const allowed = this.collectEagleFolderIds(libraryRoot, folderIds);
    const first = [];
    const rest = [];
    for (const target of targets) {
      let prioritized = false;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(target.path, 'metadata.json'), 'utf8'));
        const folders = Array.isArray(meta.folders) ? meta.folders : [];
        prioritized = folders.length === 0
          || folders.some((id) => allowed.has(String(id)));
      } catch {
        // 読めないものは後回し組へ
      }
      (prioritized ? first : rest).push(target);
    }
    return [...first, ...rest];
  }

  // 照合の対象: まだ台帳に無い Eagle アイテム。'none'/'ambiguous' は
  // 冷却期間を置いて再挑戦する(hitomi 側に後から上がることがある)
  // 照合ルールの版が上がったとき、none/ambiguous の冷却を一度だけ解いて
  // 新しいルールでの再挑戦を許す。matched/skipped/unlinked の結論は触らない
  expireTitleMatchCooldowns(version) {
    if (!this.db) return;
    const stamp = String(version == null ? '' : version);
    if (!stamp || this.metaValue('title_match_rules_version') === stamp) return;
    this.db.run("UPDATE title_matches SET last_attempt = 0 WHERE status IN ('none', 'ambiguous')");
    this.setMetaValue('title_match_rules_version', stamp);
    this.titleMatchPending = null;
    this.persistSoon();
  }

  pendingTitleMatchTargets({ retryAfter = TITLE_MATCH_RETRY, priorityFolders, libraryRoot } = {}) {
    if (!this.db) return [];
    const resolved = new Set();
    const resolvedRows = this.queryRows(
      "SELECT i.path AS path FROM items i WHERE i.source = 'eagle' AND i.gallery_id IS NOT NULL"
      + ' AND EXISTS (SELECT 1 FROM galleries g WHERE g.id = i.gallery_id)',
    );
    for (const row of resolvedRows) {
      const id = eagleIdFromPath(row.path);
      if (id) resolved.add(id);
    }
    const recorded = new Map();
    for (const row of this.queryRows('SELECT eagle_id, status, last_attempt FROM title_matches')) {
      recorded.set(String(row.eagle_id), row);
    }
    const cutoff = Date.now() - retryAfter;
    const ambiguousCutoff = Date.now() - Math.min(retryAfter, TITLE_MATCH_AMBIGUOUS_RETRY);
    const seen = new Set();
    const targets = [];
    const rows = this.queryRows(
      "SELECT path, title, eagle_tags FROM items WHERE source = 'eagle' AND title IS NOT NULL AND title != ''",
    );
    for (const row of rows) {
      const eagleId = eagleIdFromPath(row.path);
      if (!eagleId || seen.has(eagleId)) continue;
      seen.add(eagleId);
      if (resolved.has(eagleId)) continue; // ID から引けている作品は照合の出番が無い
      const prior = recorded.get(eagleId);
      if (prior) {
        const status = String(prior.status || '');
        if (status !== 'none' && status !== 'ambiguous') continue;
        const retryAt = status === 'ambiguous' ? ambiguousCutoff : cutoff;
        if (Number(prior.last_attempt) >= retryAt) continue;
      }
      // Eagle 側のタグ (作者名など)。照合器の作者検証付きパス (creatorIntersect) が使う
      let tags = [];
      try {
        tags = JSON.parse(String(row.eagle_tags || '[]'));
      } catch {
        tags = [];
      }
      targets.push({
        eagleId,
        title: String(row.title || ''),
        path: String(row.path).split('#')[0],
        tags: (Array.isArray(tags) ? tags : []).map(String).filter(Boolean),
      });
    }
    return this.prioritizeTargets(targets, { priorityFolders, libraryRoot });
  }

  // 残りの数は **数えるだけ**。以前はここが pendingTitleMatchTargets().length で、
  // 整数ひとつのために items を 2 周し、title_matches を 1 周し、1 万件の
  // 目標オブジェクトの配列を組んでいた。照合ジョブは 2.5 秒ごとに進捗を送るので、
  // 何時間も続く間ずっとこれが主スレッドに同期で入っていた。
  // 棚がジョブ中に引っかかるのは通信待ちではなくここ (項目 4-4)。
  //
  // 目標を組む側 (pendingTitleMatchTargets) の条件と一字一句合わせること。
  // 合わせ損ねると「残り 0 なのに終わらない」になる — 試験がそこを見る
  pendingTitleMatchCount({ retryAfter = TITLE_MATCH_RETRY } = {}) {
    const now = Date.now();
    if (this.titleMatchPending && now - this.titleMatchPending.at < 5000) {
      return this.titleMatchPending.value;
    }
    const value = this.db ? this.countPendingTitleMatches(retryAfter) : 0;
    this.titleMatchPending = { at: now, value };
    return value;
  }

  countPendingTitleMatches(retryAfter = TITLE_MATCH_RETRY) {
    const cutoff = Date.now() - retryAfter;
    const ambiguousCutoff = Date.now() - Math.min(retryAfter, TITLE_MATCH_AMBIGUOUS_RETRY);
    // items.path は道なので eagle_id と直に結べない。道の末尾 (<id>.info) で当てる。
    // rtrim/replace ではなく LIKE を使うのは sql.js の関数の揃いに依らないため
    const rows = this.queryRows(
      `SELECT COUNT(*) AS n FROM (
         SELECT DISTINCT i.path AS path FROM items i
          WHERE i.source = 'eagle' AND i.title IS NOT NULL AND i.title != ''
            AND NOT (i.gallery_id IS NOT NULL
                     AND EXISTS (SELECT 1 FROM galleries g WHERE g.id = i.gallery_id))
       ) live
       WHERE NOT EXISTS (
         SELECT 1 FROM title_matches t
          WHERE live.path LIKE '%' || t.eagle_id || '.info'
            AND (
              (t.status NOT IN ('none', 'ambiguous'))
              OR (t.status = 'none' AND t.last_attempt >= ?)
              OR (t.status = 'ambiguous' AND t.last_attempt >= ?)
            )
       )`,
      [cutoff, ambiguousCutoff],
    );
    return Number(rows[0] && rows[0].n) || 0;
  }

  titleMatchStats() {
    const stats = { matched: 0, ambiguous: 0, none: 0, skipped: 0, pending: 0 };
    if (!this.db) return stats;
    // 実体の無い行を数えない。Eagle から消えたアイテムの照合結果が墓として残り、
    // 画面に出る「照合済み」の数がその分だけ水増しされていた (蔵書では 45%)。
    //
    // SQL で結べないのは、items.path が道 (D:\...\<id>.info) で、title_matches の
    // 鍵は id そのものだから。道から id を取るのは JS の側の仕事なので、
    // 生きている id の集合を一度作ってから数える
    const live = new Set();
    for (const row of this.queryRows("SELECT path FROM items WHERE source = 'eagle'")) {
      const id = eagleIdFromPath(row.path);
      if (id) live.add(id);
    }
    for (const row of this.queryRows('SELECT eagle_id, status FROM title_matches')) {
      const key = String(row.status || '');
      if (!Object.prototype.hasOwnProperty.call(stats, key)) continue;
      if (!live.has(String(row.eagle_id))) continue;   // 墓は数えない
      stats[key] += 1;
    }
    stats.pending = this.pendingTitleMatchCount();
    return stats;
  }

  // Eagle タグ書き込みの対象: メタが取れている所持作品すべて(ダウンロード
  // 済みかどうかは問わない)に対応する Eagle アイテム。
  // 台帳(eagle_tag_pushes)に同じ作品で記録済みの eagle_id は除外する。
  // 照合し直しで別の作品へ結び直された物は、前の札を引いて書き直すため対象に戻す
  eagleTagTargets() {
    if (!this.db) return [];
    const rows = this.queryRows(
      `SELECT i.path AS path, i.gallery_id AS gallery_id
         FROM items i
        WHERE i.source = 'eagle'
          AND i.gallery_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM galleries g WHERE g.id = i.gallery_id)`,
    );
    const pushed = new Map();
    for (const row of this.queryRows('SELECT eagle_id, gallery_id FROM eagle_tag_pushes')) {
      pushed.set(String(row.eagle_id), row.gallery_id == null ? null : Number(row.gallery_id));
    }
    const seen = new Set();
    const targets = [];
    for (const row of rows) {
      const eagleId = eagleIdFromPath(row.path);
      if (!eagleId || seen.has(eagleId)) continue;
      seen.add(eagleId);
      const galleryId = Number(row.gallery_id);
      if (!Number.isFinite(galleryId)) continue;
      if (pushed.has(eagleId) && pushed.get(eagleId) === galleryId) continue;
      targets.push({ eagleId, galleryId });
    }
    return targets;
  }

  // 作者・グループ・原作・キャラの日本語ラベルだけを重複無しで返す。
  // ラベルが無い(ローマ字のまま学習/辞書化されていない)名前はスキップする
  japaneseTagsFor(galleryId) {
    const numeric = numericGalleryId(galleryId);
    if (numeric == null || !this.db) return [];
    const rows = this.queryRows(
      "SELECT type, name FROM gallery_tags WHERE gallery_id = ? AND type IN ('artist', 'group', 'series', 'character')",
      [numeric],
    );
    const seen = new Set();
    const labels = [];
    for (const row of rows) {
      const label = this.lookupTagLabel(row.type, row.name);
      if (!label || !hasCjk(label) || seen.has(label)) continue;
      seen.add(label);
      labels.push(label);
    }
    return labels;
  }

  // 前回の書き込みの記録。added が null なら出どころの分からない古い記録
  eagleTagPushFor(eagleId) {
    if (!this.db) return null;
    const key = String(eagleId || '').trim();
    if (!key) return null;
    const row = this.queryRows(
      'SELECT gallery_id, added FROM eagle_tag_pushes WHERE eagle_id = ?',
      [key],
    )[0];
    if (!row) return null;
    let added = null;
    if (row.added != null) {
      try {
        const parsed = JSON.parse(String(row.added));
        if (Array.isArray(parsed)) added = parsed.map((tag) => String(tag));
      } catch {
        // 読めない記録は古い記録と同じ扱い (引かない)
      }
    }
    return { galleryId: row.gallery_id == null ? null : Number(row.gallery_id), added };
  }

  // added は BUNKO が書き足して今も付いている札。省くと NULL (出どころ不明) になる
  recordEagleTagPush(eagleId, galleryId, tags, added = null) {
    if (this.scanning) {
      this.scanQueue.push(() => this.recordEagleTagPush(eagleId, galleryId, tags, added));
      return true;
    }
    if (!this.db) return false;
    const key = String(eagleId || '').trim();
    if (!key) return false;
    const numeric = numericGalleryId(galleryId);
    this.db.run(
      `INSERT INTO eagle_tag_pushes (eagle_id, gallery_id, pushed_at, tags, added)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(eagle_id) DO UPDATE SET
         gallery_id = excluded.gallery_id,
         pushed_at = excluded.pushed_at,
         tags = excluded.tags,
         added = excluded.added`,
      [key, numeric, Date.now(), JSON.stringify(tags || []), Array.isArray(added) ? JSON.stringify(added) : null],
    );
    this.eagleTagPending = null;
    this.persistSoon();
    return true;
  }

  eagleTagStats() {
    if (!this.db) return { pushed: 0, pending: 0 };
    const pushed = Number(this.queryValue('SELECT COUNT(*) AS n FROM eagle_tag_pushes')) || 0;
    const now = Date.now();
    if (this.eagleTagPending && now - this.eagleTagPending.at < 5000) {
      return { pushed, pending: this.eagleTagPending.value };
    }
    const pending = this.eagleTagTargets().length;
    this.eagleTagPending = { at: now, value: pending };
    return { pushed, pending };
  }

  markFetchFailure(id) {
    if (this.scanning) {
      this.scanQueue.push(() => this.markFetchFailure(id));
      return;
    }
    if (!this.db) return;
    const numeric = numericGalleryId(id);
    if (numeric == null) return;
    this.db.run(
      `INSERT INTO gallery_fetch_failures (id, attempts, last_attempt)
       VALUES (?, 1, ?)
       ON CONFLICT(id) DO UPDATE SET
         attempts = gallery_fetch_failures.attempts + 1,
         last_attempt = excluded.last_attempt`,
      [numeric, Date.now()],
    );
    this.persistSoon();
  }

  // ── 世代バックアップ ─────────────────────────────────────
  // 書き込む内容は「正常に開けた本体の中身」か「export したての中身」だけ。
  // 復元は quick_check を通った世代のうち最新のものを使う

  backupPaths() {
    return BACKUP_SUFFIXES.map((suffix) => `${this.dbPath}${suffix}`);
  }

  // 開けた直後の壊れ方 (全部ゼロ等) は Database() が投げるが、部分的な破損は
  // 開けてしまうことがあるので quick_check まで確かめる
  dbLooksOk(db) {
    try {
      const result = db.exec('PRAGMA quick_check');
      const value = result && result[0] && result[0].values && result[0].values[0];
      return String(value && value[0]) === 'ok';
    } catch {
      return false;
    }
  }

  // .bak が REFRESH より新しければ何もしない。ROTATE を超えて古ければ一段
  // 回してから書く。書き方は persist と同じ tmp + fsync + rename
  // (catalog.sqlite.bak.tmp は起動時の tmp 掃除の対象名に収まる)
  async maybeBackup(data) {
    if (this.readOnly) return;
    if (!this.dbPath || !data || !data.length) return;
    const [bak] = this.backupPaths();
    let age = Infinity;
    try {
      age = Date.now() - fs.statSync(bak).mtimeMs;
    } catch {
      // .bak がまだ無い: そのまま書く
    }
    if (age < BACKUP_REFRESH_INTERVAL) return;
    if (age >= BACKUP_ROTATE_INTERVAL) this.rotateBackups();
    const tmp = `${bak}.tmp`;
    const handle = await fs.promises.open(tmp, 'w');
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.promises.rename(tmp, bak);
  }

  rotateBackups() {
    const paths = this.backupPaths();
    for (let i = paths.length - 1; i >= 1; i -= 1) {
      try {
        if (!fs.existsSync(paths[i - 1])) continue;
        fs.rmSync(paths[i], { force: true });
        fs.renameSync(paths[i - 1], paths[i]);
      } catch {
        // 回せなくても新しい .bak の書き込みは続ける
      }
    }
  }

  // 新しい世代から順に、開けて quick_check が通るものを探す。無ければ null
  restoreFromBackup() {
    if (!this.SQL) return null;
    for (const file of this.backupPaths()) {
      let db = null;
      try {
        if (!fs.existsSync(file)) continue;
        db = new this.SQL.Database(fs.readFileSync(file));
        if (this.dbLooksOk(db)) return { db, file };
        db.close();
      } catch {
        try { if (db) db.close(); } catch { /* ignore */ }
      }
    }
    return null;
  }

  // 台帳は数 MB になる。書き出しは既定で非同期にして UI を止めない。
  // どの書き出しも中身は「その時点の丸ごと」なので、後から出したものが常に正。
  // 番号 (persistSeq) を振って、追い越された古い書き出しは差し替えの手前で降ろす
  async persist() {
    if (this.readOnly) return;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (!this.db) return;
    // 走査中は書き出さない: sql.js の export は接続を作り直すため、scanEagle が
    // 開いているトランザクションを巻き添えに落とす (COMMIT が失敗して走査が
    // 途中で死に、items が欠けて 済 や星が消える)。走査が終わってから改めて出す
    if (this.scanning) {
      this.persistSoon();
      return;
    }
    // 書き出し中に来た要求は溜めず、終わってから 1 回だけやり直す
    if (this.persistBusy) {
      this.persistAgain = true;
      return;
    }
    this.persistBusy = true;
    const seq = (this.persistSeq += 1);
    const tmp = `${this.dbPath}.${seq}.tmp`;
    try {
      const data = Buffer.from(this.db.export());
      await fs.promises.mkdir(path.dirname(this.dbPath), { recursive: true });
      // rename の前に中身をディスクへ落とす。電源断で「rename だけ残って
      // 中身が全部ゼロ」の台帳ができるのを防ぐ
      const handle = await fs.promises.open(tmp, 'w');
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (seq < this.persistDone) {
        // 書いている間に同期書き出し (終了時など) が追い越した。差し替えない
        await fs.promises.rm(tmp, { force: true });
      } else {
        await fs.promises.rename(tmp, this.dbPath);
        this.persistDone = seq;
        // export したての中身は正常なので、そのまま世代バックアップの種になる。
        // 鮮度は maybeBackup が見る (REFRESH 間隔より新しければ何もしない)
        try {
          await this.maybeBackup(data);
        } catch {
          // バックアップに失敗しても本体の書き出しは成立している
        }
      }
    } catch (error) {
      try {
        await fs.promises.rm(tmp, { force: true });
      } catch {
        // 後始末が出来なくても本体には影響しない
      }
      throw error;
    } finally {
      this.persistBusy = false;
    }
    if (this.persistAgain) {
      this.persistAgain = false;
      await this.persist();
    }
  }

  // 待てない場面 (終了時) 用の同期書き出し。非同期の順番待ちを飛び越すので、
  // 番号を進めて飛んでいる古い書き出しを無効化する
  persistSync() {
    if (this.readOnly) return;
    if (!this.db) return;
    // 走査の途中の姿 (eagle の行が消えた状態) を保存しない。前回の完全な
    // 書き出しを残しておくほうが、次の起動の走査でそのまま埋め直せる
    if (this.scanning) return;
    const seq = (this.persistSeq += 1);
    const tmp = `${this.dbPath}.${seq}.tmp`;
    const data = Buffer.from(this.db.export());
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    // persist() と同じ: rename の前に中身をディスクへ落とす
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.dbPath);
    this.persistDone = seq;
  }

  persistSoon() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persist().catch(() => {
        // 書き出しに失敗しても次の変更でまた出す
      });
    }, 2000);
  }

  // 走査中に届いた書き込みをここで受け止める。走査していなければ即実行。
  // paw-state など db を間借りしている側もこの入り口を通す
  runWhenWritable(fn) {
    if (!this.scanning) return fn();
    this.scanQueue.push(fn);
    return true;
  }

  drainScanQueue() {
    const queue = this.scanQueue.splice(0);
    for (const fn of queue) {
      try {
        fn();
      } catch {
        // 保留していた 1 件が落ちても残りは流す
      }
    }
  }

  // 溜まっているぶんを取りこぼさずに落とす。待ち合わせられない呼び出し元
  // (before-quit, 紐付け直後) 用なので同期で書き切る
  flushPersist() {
    // 非同期の persist が rename 前で走っている最中も「保留」とみなす。
    // ここで見逃すと、直後の終了で 1 世代前のファイルに戻る
    const pending = Boolean(this.persistTimer) || this.persistAgain || this.persistBusy;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (!pending) return;
    if (this.scanning) {
      // 今は書けない (persistSync が走査中を拒む)。保留を消費せず持ち越して、
      // 走査後の書き出しに拾わせる
      this.persistSoon();
      return;
    }
    this.persistAgain = false;
    this.persistSync();
  }

  // 自機の Eagle ライブラリの根 (config の eagleLibrary)。台帳のパスを読み替える
  // 目印に使う。config は electron 依存なので、テストから素で呼ばれても壊れない
  // よう遅延 require + 失敗は空扱いにする
  localLibraryRoot() {
    try {
      // trim は必ず (項目 2-5)。付け忘れると同じライブラリの索引が二つになる
      return String(require('./config').load().eagleLibrary || '').trim();
    } catch {
      return '';
    }
  }

  rebuildMemory() {
    // 走査で作品が増減すれば作家の顔ぶれも変わる。索引は次に引かれた時に組み直す
    this.invalidateCreatorSearch();
    // ここに来るのは items が動いた後 (解除・削除・星書き・DB 差し替えの総仕上げ)。
    // upsert を通らない DELETE / UPDATE の取りこぼしをここで拾う
    this.bumpUnmatchedGen();
    this.idSet = new Set();
    this.titleSet = new Set();
    this.looseOwned = new Map();
    this.eagleByGallery = new Map();
    this.eagleByTitle = new Map();
    this.starByGallery = new Map();
    this.starByTitle = new Map();
    this.localById = new Map();
    this.localByTitle = new Map();
    this.eagleBasePath = new Map();
    this.titleMatchPending = null;
    this.titleMatchLinks = null;
    const result = this.db.exec(`
      SELECT i.gallery_id, i.title_key, i.source, i.path, i.star, i.title, g.page_count
      FROM items i LEFT JOIN galleries g ON g.id = i.gallery_id
    `);
    // 手動で紐付けを解いたアイテム (墓標 'unlinked')。題が同じでも 済 に戻さない
    const unlinked = new Set(
      this.queryRows("SELECT eagle_id FROM title_matches WHERE status = 'unlinked'")
        .map((row) => String(row.eagle_id)),
    );
    let eagle = 0;
    let app = 0;
    // 読み替え先の根は 1 回だけ引く (rebuild は行数が多く、config を行ごとに
    // 読み直すほど安くない)
    const localRoot = this.localLibraryRoot();
    // 自機ライブラリの実在は根 (images) で一度だけ確かめ、配下の各アイテムは
    // 直前の走査の控え (全 .info の一覧) から引く。行ごとの existsSync は
    // ネットワーク越しのライブラリ (母艦の D: = SMB) で 1 件 2ms、2 千件で
    // 5 秒ほど main を止め、窓が出るのを遅らせていた (実測)
    const localImagesDir = localRoot ? path.join(localRoot, 'images') : '';
    const localRootOk = Boolean(localImagesDir) && fs.existsSync(localImagesDir);
    const scanCache = this.eagleScanCache && this.eagleScanCache.size ? this.eagleScanCache : null;
    const pathState = new Map();
    const resolveEaglePath = (sourcePath) => {
      const rebased = rebaseLibraryPath(sourcePath, localRoot);
      if (rebased && localRootOk) {
        const base = path.basename(rebased);
        // 控えが無い (初回・版違い) か、.info 以外を指す古い行だけ実体に訊く
        const exists = scanCache && /\.info$/i.test(base)
          ? scanCache.has(base)
          : fs.existsSync(rebased);
        return { real: rebased, exists };
      }
      // ライブラリ名の目印が無い・自機の根が見えない: 従来どおり元のパス →
      // 読み替え先の順に実体へ訊く
      let real = sourcePath;
      let exists = real ? fs.existsSync(real) : false;
      if (!exists && rebased && fs.existsSync(rebased)) {
        real = rebased;
        exists = true;
      }
      return { real, exists };
    };
    if (result[0]) {
      for (const row of result[0].values) {
        const [galleryId, key, source, filePath, star, title, pageCount] = row;
        const rowEagleId = source === 'eagle' ? eagleIdFromPath(filePath) : null;
        // 鍵は文字列で統一: hitomi の数値も 'nh:123' 型もひとつの Set で持つ
        if (galleryId) this.idSet.add(String(galleryId));
        // upsert と同じ理由で、題での救済は ID 未確定の行だけに絞る
        if (!galleryId && key && titleKeyEligible(key)
          && !(rowEagleId && unlinked.has(rowEagleId))) this.titleSet.add(String(key));
        this.rememberLoose(title, pageCount);
        this.rememberStar(galleryId, key, star);
        if (source === 'eagle') {
          eagle += 1;
          const eagleId = rowEagleId;
          // 実在の確認と読み替えは同じ実体パスに一度だけ (読み手が母艦と別の
          // 機体でも棚が空にならないよう、自機のライブラリ根へ読み替える)
          const sourcePath = String(filePath || '').split('#')[0];
          let state = pathState.get(sourcePath);
          if (!state) {
            state = resolveEaglePath(sourcePath);
            pathState.set(sourcePath, state);
          }
          const { real, exists } = state;
          if (eagleId) {
            if (galleryId) this.eagleByGallery.set(String(galleryId), eagleId);
            if (key && titleKeyEligible(key)) this.eagleByTitle.set(String(key), eagleId);
            this.eagleBasePath.set(eagleId, real);
          }
          this.rememberLocal(galleryId, key, real, exists);
        }
        if (source === 'app') {
          app += 1;
          this.rememberLocal(galleryId, key, filePath);
        }
      }
    }
    this.stats = {
      total: this.idSet.size,
      eagle,
      app,
    };
  }

  snapshot() {
    return {
      ready: this.ready,
      scanning: this.scanning,
      ownedCount: this.idSet.size,
      eagle: this.stats.eagle,
      app: this.stats.app,
    };
  }

  // 所持作品の「ゆるい鍵」索引。値はページ数の一覧 (不明は null)。
  // 同題の再掲・別版を束ねる用途なので、短すぎる鍵は登録しない (偶然一致対策)。
  // ローマ数字の正規化は空白が要る: 保存済みの title_key ではなく生の題を渡すこと
  rememberLoose(title, pageCount) {
    const key = looseKeyFromTitle(title);
    if (!key || !titleKeyEligible(key)) return;
    const list = this.looseOwned.get(key) || [];
    list.push(pageCount ? Number(pageCount) : null);
    this.looseOwned.set(key, list);
  }

  // 未所持だが「所持済みの版違い」とみなせるか。ゆるい鍵が一致し、
  // ページ数が近い (またはどちらか不明) なら実質同一と判定する。
  // ページ数が大きく違うもの (総集編・増補版) はここでは束ねない
  isSimilarOwned(gallery) {
    if (!gallery || gallery.error) return false;
    if (gallery.source && gallery.source !== 'hitomi') return false;
    const key = looseKeyFromTitle(gallery.title);
    if (!key || !titleKeyEligible(key)) return false;
    const pages = this.looseOwned.get(key);
    if (!pages || !pages.length) return false;
    const own = Number(gallery.pageCount) || 0;
    return pages.some((count) => {
      if (!own || !count) return true; // 片方でもページ数不明なら題を信じる
      return Math.abs(own - count) / Math.max(own, count) <= SIMILAR_PAGE_TOLERANCE;
    });
  }

  // ID が一致しても、アイテム側の連番(日付+通し番号など)との偶然の衝突がありうる。
  // タイトルまで照合して初めて「同じ作品」とみなす。鍵は galleryKeyOf の文字列
  idMatchVerified(key, title) {
    if (!this.idSet.has(key)) return false;
    // 接頭辞付きの鍵 (nh:/eh:) は手動リンクからしか台帳に入らない: 検証済み扱い
    if (!/^\d+$/.test(key)) return true;
    if (!title) return true; // タイトルが無く検証できないときは従来どおり
    // 台帳に 'matched' で載っている ID は、照合器か手動リンクが「この作品だ」と
    // 明示した結果。hitomi 側がローマ字題のみでアイテム名と永久に噛み合わない
    // ことがあるので、題名の再検証は免除する(裸の [数字] 由来は対象外)
    if (this.titleMatchLinkMap().has(key)) return true;
    return this.titleMatchesMeta(Number(key), title);
  }

  // ID の裏付けがある所持。タイトル一致だけの「済」と違い、所持作品の一覧に並ぶ
  isIdOwned(id, title) {
    const key = galleryKeyOf(id);
    return Boolean(key != null && this.idMatchVerified(key, title));
  }

  isOwned(id, title) {
    if (this.isIdOwned(id, title)) return true;
    const key = titleKey(title);
    return Boolean(key && titleKeyEligible(key) && this.titleSet.has(key));
  }

  // known: 呼び手が実在チェック済みなら true/false を渡す (rebuild の行ループは
  // 読み替えを兼ねて先に確かめている)。省略時はここで確かめる — ネットワーク
  // 越しの existsSync は安くないので、同じパスに二度は訊かない
  rememberLocal(id, titleOrKey, filePath, known) {
    if (!filePath) return;
    const real = String(filePath).split('#')[0];
    const exists = known === undefined ? fs.existsSync(real) : Boolean(known);
    if (!exists) return;
    if (id != null && String(id)) this.localById.set(String(id), real);
    const key = titleKey(titleOrKey);
    if (key && titleKeyEligible(key)) this.localByTitle.set(key, real);
    // info.json (ダウンロード保存の覚え書き) は Eagle のアイテム (<id>.info) には
    // 構造上存在しない。全行が eagle の台帳では、この探索は全件空振りの負の
    // ルックアップで、ネットワーク越しだと起動あたり 1 秒級を捨てていた (実測)
    if (real.toLowerCase().endsWith('.info')) return;
    try {
      const infoPath = path.join(real, 'info.json');
      if (fs.existsSync(infoPath)) {
        const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
        if (info.id != null) this.localById.set(String(info.id), real);
      }
    } catch {
      // ignore
    }
  }

  findLocal(id, title) {
    const raw = String(id || '');
    if (raw && this.localById.has(raw)) return this.localById.get(raw);
    // numericGalleryId とは意図的に別実装: あちらは /^\d+$/ の厳格判定だが、
    // ここは Number() で緩く読む (localById の鍵は自前の台帳なので実害が無く、
    // 統一すると '1e3' のような入力の当たり外れが変わってしまう)
    const numeric = raw.startsWith('hitomi:') ? Number(raw.slice(7)) : Number(raw);
    if (Number.isFinite(numeric) && this.localById.has(String(numeric))) {
      return this.localById.get(String(numeric));
    }
    const key = titleKey(title);
    if (key && this.localByTitle.has(key)) return this.localByTitle.get(key);
    return null;
  }

  findEagle(id, title) {
    const linkKey = galleryKeyOf(id);
    if (linkKey != null && this.eagleByGallery.has(linkKey)
      && this.idMatchVerified(linkKey, title)) {
      return this.eagleByGallery.get(linkKey);
    }
    const key = titleKey(title);
    if (key && this.eagleByTitle.has(key)) return this.eagleByTitle.get(key);
    return null;
  }

  // 1 作品に複数の Eagle アイテムが紐付くことがある (分冊・別版)。
  // その場合は一番高い星を作品の評価として扱う
  rememberStar(galleryId, titleOrKey, star) {
    const rating = normalizeStar(star);
    if (!rating) return;
    const linkKey = galleryKeyOf(galleryId);
    if (linkKey != null) {
      this.starByGallery.set(linkKey, Math.max(this.starByGallery.get(linkKey) || 0, rating));
    }
    const key = titleKey(titleOrKey);
    if (key && titleKeyEligible(key)) {
      this.starByTitle.set(key, Math.max(this.starByTitle.get(key) || 0, rating));
    }
  }

  // 済 が出る場所では星も引ける: 所持判定と同じ道筋 (ID 照合 → タイトル鍵) をたどる
  findStar(id, title) {
    const linkKey = galleryKeyOf(id);
    if (linkKey != null && this.starByGallery.has(linkKey)
      && this.idMatchVerified(linkKey, title)) {
      return this.starByGallery.get(linkKey);
    }
    const key = titleKey(title);
    if (key && this.starByTitle.has(key)) return this.starByTitle.get(key);
    return 0;
  }

  // annotate 用: isIdOwned / isOwned / findEagle / findStar / findTitleMatchLink が
  // それぞれ辿り直していた同じ照合経路 (ID の鍵 → ID 照合の検証 → タイトル鍵) を
  // 1 回で済ませる。idMatchVerified は titleMatchesMeta で台帳を引くことがあり、
  // 1 ギャラリーにつき 5 回呼ぶのは無駄が大きかった。判定はすべて純粋な参照で、
  // 各メソッド単体の結果と厳密に同値になるよう条件を写している
  ownershipFacts(id, title) {
    const linkKey = galleryKeyOf(id);
    const key = titleKey(title);
    const idVerified = linkKey != null && this.idMatchVerified(linkKey, title);
    const idOwned = Boolean(idVerified);
    const owned = idOwned || Boolean(key && titleKeyEligible(key) && this.titleSet.has(key));
    // findEagle / findStar のタイトル救済は titleKeyEligible を課さない (原文どおり)
    let eagleId = null;
    if (idVerified && this.eagleByGallery.has(linkKey)) {
      eagleId = this.eagleByGallery.get(linkKey);
    } else if (key && this.eagleByTitle.has(key)) {
      eagleId = this.eagleByTitle.get(key);
    }
    let star = 0;
    if (idVerified && this.starByGallery.has(linkKey)) {
      star = this.starByGallery.get(linkKey);
    } else if (key && this.starByTitle.has(key)) {
      star = this.starByTitle.get(key);
    }
    const linkedEagleId = (linkKey != null && this.db)
      ? (this.titleMatchLinkMap().get(linkKey) || null)
      : null;
    // ゴミ箱へ送った直後のアイテム。走査中は items の掃除が scanQueue で待たされる
    // ことがあり、索引 (idSet / eagleByGallery) にはまだ残っている。墓標が立って
    // いれば所持を名乗らせない — でないと画面が 済 → 未 → 済 と点滅する
    if (eagleId && this.eagleTrash.has(eagleId)) {
      return {
        owned: false, idOwned: false, eagleId: null, star: 0, linkedEagleId: null,
      };
    }
    return { owned, idOwned, eagleId, star, linkedEagleId };
  }

  // タグ配列に、tag_labels にヒットした日本語表示ラベルを付与する。
  // ヒットしなければ元のタグをそのまま(浅いコピーで)返す
  withTagLabels(gallery) {
    const next = { ...gallery };
    // 名前だけのタグ (nhentai) に hitomi での型を添える。添えるだけで
    // 型そのものは書き換えない: 出所は nhentai のまま、検索の語だけ hitomi へ
    // 通じるようにする (画面が tag.hitomiType を見て語を組む)
    const bare = String(gallery.source || '') === 'nhentai';
    for (const key of TAG_LABEL_LIST_KEYS) {
      if (!Array.isArray(gallery[key])) continue;
      next[key] = gallery[key].map((tag) => {
        const out = { ...tag };
        const label = this.lookupTagLabel(tag.type, tag.name);
        if (label) out.label = label;
        if (bare && tag.type === 'tag') {
          const types = this.hitomiTagTypes(tag.name).filter((type) => type !== 'tag');
          if (types.length === 1) out.hitomiType = types[0];
          // female と male の両方に在る語。画面はこれを見て「どちらも」で引く
          else if (types.length > 1) out.hitomiTypes = types;
        }
        return out;
      });
    }
    return next;
  }

  annotate(galleries) {
    return (galleries || []).map((gallery) => {
      // Eagle が持ち主の疑似作品 (未照合アイテム・pawchive の所持作品)。所持も星も
      // eagleId も自前で確定している: 台帳の照合に任せると、短い題で eagleId が
      // 落ちたり (titleKeyEligible 未満)、同題の姉妹に付け替わったりする
      if (gallery && gallery.kind === 'eagleItem') return { ...gallery };
      // Home の作者の見出し (人) は本ではない: 題 (= 作者名) を台帳の題の鍵に当てると 済 や ★ が立つ
      if (gallery && gallery.source === 'home') return { ...gallery };
      // 照合経路 (ID 検証 + タイトル鍵) は 1 ギャラリー 1 回で済ませる。
      // エラー行は照合しない (owned:false / eagleId:null / star:0 で確定)
      const facts = gallery.error
        ? { owned: false, idOwned: false, eagleId: null, star: 0, linkedEagleId: null }
        : this.ownershipFacts(gallery.id, gallery.title);
      // よそのサイトの作品でも、同じ物を hitomi 版で持っていれば所持として出す。
      // ID は確定していない (idOwned は立てない) ので札は枠だけの 済 になり、
      // 伏せられず、鎖で確かめる道も残る
      const cross = facts.owned ? null : this.crossSourceOwned(gallery);
      const owned = facts.owned || Boolean(cross);
      const base = {
        ...gallery,
        owned,
        // 未所持だが所持済みの版違いとみなせる札。表示の間引きは renderer の
        // 「重複を隠す」モードが行う: ここでは印を付けるだけ
        similarOwned: !gallery.error
          && !owned
          && this.isSimilarOwned(gallery),
        // 手持ちの hitomi 版の作品 ID。画面はここへ渡す道を出す
        ...(cross ? { ownedGalleryId: cross.galleryId } : {}),
        // 検索結果の中で同作の再アップロードを束ねるための鍵。renderer が
        // 同じ鍵×同じ作家の札を代表 1 枚に畳む (短い題は偶然一致するので出さない)
        dupeKey: (() => {
          if (gallery.error || (gallery.source && gallery.source !== 'hitomi')) return null;
          const key = looseKeyFromTitle(gallery.title);
          return key && titleKeyEligible(key) ? key : null;
        })(),
        // タイトル一致だけの「済」は所持一覧に並ばない。詳細で紐付けの口を
        // 出すかどうかを renderer が判断できるよう、裏付けの種類を渡す
        idOwned: facts.idOwned,
        eagleId: facts.eagleId || (cross ? cross.eagleId : null),
        // 台帳経由で済になっている作品だけ、詳細に解除の口を出せるようにする
        linkedEagleId: facts.linkedEagleId,
        // 所持作品スコープの行は star を持って来ている: 絞り込みと札を食い違わせない
        star: gallery.error ? 0 : (
          Object.prototype.hasOwnProperty.call(gallery, 'star')
            ? normalizeStar(gallery.star)
            : facts.star
        ),
      };
      return gallery.error ? base : this.withTagLabels(base);
    });
  }

  upsert({ source, filePath, galleryId, title, star, addedAt, eagleTags }) {
    // items が動く実書き込みはすべてここを通る (走査・markApp・linkTitleMatch・
    // removeTitleMatch の復元)。app 行でも無効化するが、過剰無効化は安全側
    this.bumpUnmatchedGen();
    const key = titleKey(title);
    const rating = normalizeStar(star);
    const tagsJson = Array.isArray(eagleTags) && eagleTags.length
      ? JSON.stringify(eagleTags.map(String).filter(Boolean))
      : null;
    this.db.run(
      `INSERT INTO items (source, path, gallery_id, title, title_key, star, added_at, eagle_tags, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, path) DO UPDATE SET
         gallery_id = excluded.gallery_id,
         title = excluded.title,
         title_key = excluded.title_key,
         star = excluded.star,
         added_at = COALESCE(excluded.added_at, items.added_at),
         eagle_tags = COALESCE(excluded.eagle_tags, items.eagle_tags),
         updated_at = excluded.updated_at`,
      [source, filePath, galleryId || null, title || '', key, rating,
        Number(addedAt) || null, tagsJson, Date.now()],
    );
    if (galleryId) this.idSet.add(String(galleryId));
    // タイトルでの所持判定は「ID がまだ分からないアイテム」の救済に限る。
    // ID が確定している行の題まで登録すると、hitomi 側の同名別 ID (再掲や
    // 別言語版) が紐付いていないのに 済 になってしまう
    if (!galleryId && titleKeyEligible(key)) this.titleSet.add(key);
    // ページ数はメタ未取得のことがある: 走査後の rebuildMemory が埋め直す
    this.rememberLoose(title, null);
    this.rememberStar(galleryId, key, rating);
    if (source === 'eagle') {
      const eagleId = eagleIdFromPath(filePath);
      if (eagleId) {
        if (galleryId) this.eagleByGallery.set(String(galleryId), eagleId);
        if (titleKeyEligible(key)) this.eagleByTitle.set(key, eagleId);
        this.eagleBasePath.set(eagleId, String(filePath || '').split('#')[0]);
      }
    }
  }

  markApp(galleryId, title, filePath) {
    if (this.scanning) {
      this.scanQueue.push(() => this.markApp(galleryId, title, filePath));
      return;
    }
    const persistentId = galleryKeyOf(galleryId);
    const key = filePath || String(galleryId);
    // 同じ作品の保存し直しは UPDATE になる: 件数は新規のときだけ進める
    const known = this.db
      && this.queryValue("SELECT 1 AS n FROM items WHERE source = 'app' AND path = ?", [key]) != null;
    this.upsert({
      source: 'app',
      filePath: key,
      galleryId: persistentId,
      title,
    });
    this.rememberLocal(galleryId, title, filePath);
    if (!known) this.stats.app += 1;
    this.stats.total = this.idSet.size;
    this.persistSoon();
  }

  async refresh({ eagleLibrary, eagleFolders, downloadDir, onProgress, full = false } = {}) {
    if (this.scanning) return this.snapshot();
    this.scanning = true;
    try {
      // 走査は「集める」(非同期・台帳に触らない) と「入れ替える」(同期・一息) に分ける。
      // 以前は BEGIN → eagle 行の全削除 → 32 件ずつ戻す、を数秒かけていたので、その間に
      // 届いた検索 (起動直後の棚がまさにそれ) は 0 件〜途中までの台帳を見ていた
      let staged = null;
      if (eagleLibrary) {
        staged = await this.collectEagleScan(eagleLibrary, onProgress, eagleFolders, { full });
      }
      // ここから persist まで await を挟まない: 入れ替え・保留した書き込み・記憶の作り直しを
      // 一息で済ませ、途中の姿を誰にも見せない
      if (staged) this.applyEagleScan(staged);
      if (downloadDir) this.scanDownloadDir(downloadDir);
      this.scanning = false;
      this.drainScanQueue();
      this.pruneMissingAppItems();
      this.rebuildMemory();
      try {
        this.learnCreatorLabels();
      } catch {
        // ラベル学習が失敗しても走査そのものは成功として扱う
      }
      await this.persist();
    } finally {
      this.scanning = false;
      // 走査が失敗したときも保留は流す (台帳には触っていないので巻き添えにならない)
      this.drainScanQueue();
    }
    return this.snapshot();
  }

  // 指定フォルダとその子孫の ID を集める。ツリーが読めなければ指定分だけで進める
  collectEagleFolderIds(libraryRoot, folderIds) {
    const allowed = new Set(folderIds);
    try {
      const raw = fs.readFileSync(path.join(libraryRoot, 'metadata.json'), 'utf8');
      const tree = JSON.parse(raw);
      const visit = (folder, inside) => {
        const id = String(folder?.id || '');
        const hit = inside || allowed.has(id);
        if (hit && id) allowed.add(id);
        for (const child of folder?.children || []) visit(child, hit);
      };
      for (const folder of tree.folders || []) visit(folder, false);
    } catch {
      // ツリーが読めない場合は指定 ID のみで判定
    }
    return allowed;
  }

  // Eagle 走査の索引 (eagle-index)。全 .info の metadata 要約を持ち、mtime.json の差分で
  // 更新する。台帳と paw-library が同じ物を掴む。控えのファイルは従来どおり
  // userData/eagle-scan-cache.json (母艦の sync が写し、読み手は実在の確認に使う)
  eagleIndex(libraryRoot) {
    const { indexFor } = require('./eagle-index');
    return indexFor(libraryRoot || this.localLibraryRoot(), this.eagleScanCachePath);
  }

  // 控えの読み込み (起動時と、写しでの差し替え後)。無い・壊れている・版が違うときは空から
  // (全件読みに戻るだけで、台帳の正しさには影響しない)
  loadEagleScanCache() {
    const root = this.localLibraryRoot();
    if (!root) return new Map();
    try {
      const index = this.eagleIndex(root);
      // 写し (Homecore) では母艦の sync が控えを差し替える: 呼ばれるたびに読み直す
      index.loaded = false;
      index.entries = new Map();
      return index.load();
    } catch {
      return new Map();
    }
  }

  saveEagleScanCache(cache) {
    const root = this.localLibraryRoot();
    if (!root) return;
    try {
      const index = this.eagleIndex(root);
      if (cache && cache !== index.entries) index.entries = cache;
      index.save();
    } catch {
      // 書けなくても次回が全件読みになるだけ
    }
  }

  // 走査の前半: ライブラリを読んで「台帳に入れる行」を組む。台帳にも記憶 (idSet ほか) にも
  // 触らないので、この間に届いた検索は今までどおりの完全な台帳を見る。
  // 読むのは eagle-index (mtime.json の差分。変わったアイテムだけ metadata.json を開く)
  async collectEagleScan(libraryRoot, onProgress, eagleFolders, { full = false } = {}) {
    const imagesDir = path.join(libraryRoot, 'images');
    if (!fs.existsSync(imagesDir)) return null;

    // 作品フォルダの指定があるときは、その子孫と未分類だけを所持として扱う。
    // ライブラリには作品以外(3次元画像など)が別フォルダで同居しているため
    const folderIds = (eagleFolders || []).map((id) => String(id || '').trim()).filter(Boolean);
    const allowedFolders = folderIds.length
      ? this.collectEagleFolderIds(libraryRoot, folderIds)
      : null;

    // pawchive 所持作品 (「作者」フォルダ配下) は hitomi の台帳に入れない。
    // 名前の [12342207] は fanbox の投稿 ID で、hitomi のギャラリー ID ではない。
    // 許可フォルダに「作者」が入っている構成では、これが無いと大量に誤登録される
    let pawFolders = null;
    try {
      const pawRoot = String(require('./config').load().pawEagleFolder || '').trim();
      if (pawRoot) pawFolders = this.collectEagleFolderIds(libraryRoot, [pawRoot]);
    } catch {
      // 設定が読めない環境 (単体テスト) では従来どおり全部を対象にする
    }

    // フォルダ名は作者名学習(learnCreatorLabels)の材料になるので覚えておく。
    // 親子関係も持つ: サブフォルダ(作品別の小分け)の作品を親(作者名)にも集計するため。
    // ルートフォルダ(「作者」「R-18同人誌」等)は構造上の器なので学習のラベルにしない
    const folderNames = new Map();
    const folderParents = new Map();
    try {
      const tree = JSON.parse(fs.readFileSync(path.join(libraryRoot, 'metadata.json'), 'utf8'));
      const visit = (folder, parentId) => {
        if (folder && folder.id) {
          const id = String(folder.id);
          folderNames.set(id, String(folder.name || ''));
          if (parentId) folderParents.set(id, parentId);
          for (const child of folder.children || []) visit(child, id);
        }
      };
      for (const folder of tree.folders || []) visit(folder, null);
    } catch {
      // フォルダ名が取れなくてもスキャンは続ける
    }

    // items は毎回作り直すが、タイトル照合の台帳は残る。紐付け済みの作品は
    // 抽出 ID と同じ扱いで items に戻して、所持判定から落ちないようにする
    const titleMatched = new Map();
    for (const row of this.queryRows(
      "SELECT eagle_id, gallery_id FROM title_matches WHERE status = 'matched' AND gallery_id IS NOT NULL",
    )) {
      const linked = galleryKeyOf(row.gallery_id);
      if (linked != null) titleMatched.set(String(row.eagle_id), linked);
    }
    // 名前の番号の結びを手で外した項目 (墓標 'unlinked' に外した番号が残る: removeTitleMatch)。
    // その項目の名前・注釈・URL の [数字] は拾わない (拾うと外した結びが走査のたびに戻る)
    const nameUnlinked = new Set(this.queryRows(
      "SELECT eagle_id FROM title_matches WHERE status = 'unlinked' AND gallery_id IS NOT NULL",
    ).map((row) => String(row.eagle_id)));

    const index = this.eagleIndex(libraryRoot);
    const result = await index.refresh({ full, onProgress });

    const rows = [];
    const itemFolders = new Map();
    const trashDrop = [];
    for (const [dirName, entry] of result.entries) {
      const meta = entry.meta;
      const itemId = dirName.replace(/\.info$/i, '');
      if (meta.isDeleted) {
        // Eagle のゴミ箱に入っているアイテム。実体側にも削除が書かれたので、
        // 繋ぎの墓標が残っていれば下ろす
        if (this.eagleTrash.has(itemId)) trashDrop.push(itemId);
        continue;
      }
      // ゴミ箱送り済みの墓標。Eagle が metadata.json に isDeleted を書き出す
      // まで実体は「生きている」ように見えるので、拾い直さない
      if (this.eagleTrash.has(itemId)) continue;
      // pawchive 所持 (「作者」フォルダ配下) の扱い。作者フォルダ「だけ」に居る
      // アイテムは pawchive の持ち場なので棚に入れない。通常棚 (R-18同人誌等) と
      // 併置されているものは棚に出す — ただし名前の [数字] は fanbox 投稿 ID の
      // 恐れがあるので、抽出 ID は使わない (照合器・手動リンクの鎖だけを信じる)
      const itemFolderIds = Array.isArray(meta.folders) ? meta.folders.map(String) : [];
      let inPawFolder = false;
      if (pawFolders) {
        inPawFolder = itemFolderIds.some((id) => pawFolders.has(id));
        const outsidePaw = itemFolderIds.some((id) => !pawFolders.has(id));
        if (inPawFolder && !outsidePaw) continue;
      }
      if (allowedFolders) {
        const uncategorized = itemFolderIds.length === 0;
        if (!uncategorized && !itemFolderIds.some((id) => allowedFolders.has(id))) {
          continue;
        }
      }
      const name = meta.name || '';
      itemFolders.set(itemId, itemFolderIds);
      const ids = inPawFolder || nameUnlinked.has(itemId)
        ? [] // 併置アイテム: 名前の [数字] は fanbox 投稿 ID かもしれない / 名前の番号の結びを手で外した
        : extractGalleryIds(`${name} ${meta.annotation || ''} ${meta.url || ''}`);
      const filePath = path.join(imagesDir, dirName);
      const linked = titleMatched.get(itemId);
      // 鍵は文字列 ('123' / 'nh:123')、抽出 ID は数値: 比べるときだけ揃える
      if (linked != null && !ids.some((id) => String(id) === linked)) ids.push(linked);
      const star = normalizeStar(meta.star);
      // 未照合アイテムを一覧に混ぜるとき用: 並び (added) と検索の種になる
      const addedAt = Number(meta.addedAt) || null;
      const eagleTags = Array.isArray(meta.tags) ? meta.tags.map(String).filter(Boolean) : [];
      if (ids.length) {
        for (const galleryId of ids) {
          rows.push({
            source: 'eagle',
            filePath: `${filePath}#${galleryId}`,
            galleryId,
            title: name,
            star,
            addedAt,
            eagleTags,
          });
        }
      } else {
        rows.push({
          source: 'eagle',
          filePath,
          galleryId: null,
          title: name,
          star,
          addedAt,
          eagleTags,
        });
      }
    }
    return {
      rows,
      itemFolders,
      folderNames,
      folderParents,
      rootFolders: new Set(folderIds),
      trashDrop,
      entries: result.entries,
      reread: result.reread,
      mode: result.mode,
    };
  }

  // 走査の後半: 組んだ行で台帳の eagle 行を入れ替える。同期で一息に済ませるので、
  // 他の誰か (検索・照合) が途中の姿を見ることはない
  applyEagleScan(staged) {
    if (!staged || !this.db) return;
    const prevEagle = Number(this.queryValue(
      "SELECT COUNT(*) AS n FROM items WHERE source = 'eagle'",
    )) || 0;
    const kept = staged.rows.length;
    // ライブラリが「見えるが空/激減」(遅延マウント・移動直後・設定ミス) のときに
    // 全消しを確定させない。
    //
    // **見るのは「走査が実体を何件見たか」で、棚に入った数ではない。**
    // 棚に入る数はフォルダ分けの変更で正しく減る (pawchive の作者フォルダへ
    // 移した等)。そこを異常と見なすと、一度フォルダを組み替えただけで
    // 台帳が二度と追いつけなくなる — 実際そうなっていた
    // (索引 26,465 件のうち 24,111 件が作者フォルダ専属で、棚に入るのは 2,231 件。
    //  それを古い 21,718 件と比べて毎回中断していた)
    const seen = staged.entries ? staged.entries.size : 0;
    const prevSeen = Number(this.metaValue('eagle_seen')) || 0;
    const invisible = seen === 0 || (prevSeen >= 200 && seen < prevSeen / 2);
    if (invisible && prevEagle >= 200) {
      // 数だけを持たせる (作品名も道も入れない)。呼び手が画面に出すので、
      // 「なぜ取り込まなかったか」が利用者に届く (項目 9-1)
      const error = new Error(`eagle scan aborted: items unreadable ${prevSeen} -> ${seen}`);
      error.code = 'scan-shrank';
      error.prevCount = prevSeen;
      error.keptCount = seen;
      throw error;
    }
    // 棚に入る数が大きく減ったのは、たいていフォルダを組み替えた結果。
    // 止めはしないが、後から辿れるように残す
    if (prevEagle >= 200 && kept < prevEagle / 2) {
      trace.note('catalog', 'scan-partial', { count: kept });
    }
    this.db.run('BEGIN');
    try {
      this.db.run("DELETE FROM items WHERE source = 'eagle'");
      for (const row of staged.rows) this.upsert(row);
      for (const itemId of staged.trashDrop) {
        this.db.run('DELETE FROM eagle_trash WHERE id = ?', [itemId]);
      }
      this.db.run('COMMIT');
    } catch (error) {
      try {
        this.db.run('ROLLBACK');
      } catch {
        // トランザクションが既に落ちているときは戻すものが無い
      }
      this.bumpUnmatchedGen();
      throw error;
    }
    for (const itemId of staged.trashDrop) this.eagleTrash.delete(itemId);
    this.eagleRootFolders = staged.rootFolders;
    // 次の回が「ライブラリが見えているか」を測るための基準
    this.setMetaValue('eagle_seen', String(staged.entries ? staged.entries.size : 0));
    this.eagleItemFolders = staged.itemFolders;
    this.eagleFolderNames = staged.folderNames;
    this.eagleFolderParents = staged.folderParents;
    // Eagle から消えたアイテムの行は冒頭の全消しでしか落ちない (upsert を通らない)
    this.bumpUnmatchedGen();
    // 控えは索引が既に保存している。読み手 (rebuildMemory) が引く Map を差し替える
    this.eagleScanCache = staged.entries;
  }

  // 従来の一括の口 (集める → 入れ替える)。refresh 以外から呼ぶとき用
  async scanEagle(libraryRoot, onProgress, eagleFolders, options = {}) {
    const staged = await this.collectEagleScan(libraryRoot, onProgress, eagleFolders, options);
    if (staged) this.applyEagleScan(staged);
  }

  // ダウンロード由来 (source='app') の行は登録しっぱなしだったので、ファイルが
  // 消えた作品が永遠に「済」のままになる。走査のたびに実在を確かめて下ろす。
  // ドライブごと見えていないときは外付けの取り外しとみなして手を付けない
  pruneMissingAppItems() {
    if (!this.db) return;
    const rows = this.queryRows("SELECT path FROM items WHERE source = 'app'");
    for (const row of rows) {
      const file = String(row.path || '').split('#')[0];
      if (!file || !path.isAbsolute(file)) continue;
      try {
        if (!fs.existsSync(path.parse(file).root)) continue;
        if (fs.existsSync(file)) continue;
      } catch {
        continue;
      }
      this.db.run("DELETE FROM items WHERE source = 'app' AND path = ?", [row.path]);
    }
  }

  scanDownloadDir(downloadDir) {
    if (!downloadDir || !fs.existsSync(downloadDir)) return;
    let entries = [];
    try {
      entries = fs.readdirSync(downloadDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      // ダウンロード中の作業フォルダ (.part-*) は所有物として数えない
      if (entry.name.startsWith('.')) continue;
      const full = path.join(downloadDir, entry.name);
      if (entry.isDirectory()) {
        let title = entry.name.replace(/^\d{4,8}\s+/, '');
        let galleryId = null;
        const infoPath = path.join(full, 'info.json');
        if (fs.existsSync(infoPath)) {
          try {
            const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
            galleryId = galleryKeyOf(info.id);
            title = info.title || title;
          } catch {
            // ignore
          }
        }
        const fromName = extractGalleryIds(entry.name);
        if (!galleryId && fromName[0]) galleryId = String(fromName[0]);
        // markApp が保存した nh:/eh: 鍵はファイル名だけから復元できないことがある。
        // 再走査で NULL に上書きせず、同じ実体パスの既存リンクを引き継ぐ。
        if (!galleryId) {
          galleryId = galleryKeyOf(this.queryValue(
            "SELECT gallery_id AS value FROM items WHERE source = 'app' AND path = ?",
            [full],
          ));
        }
        this.upsert({ source: 'app', filePath: full, galleryId, title });
      } else if (/\.(zip|cbz|pdf|rar|7z)$/i.test(entry.name)) {
        const base = entry.name.replace(/\.(zip|cbz|pdf|rar|7z)$/i, '');
        const ids = extractGalleryIds(base);
        // 同じパスに確定リンクがあれば、ファイル名の数字推測より優先する。
        // 接頭辞付きIDを、題に偶然含まれた5〜8桁の数字へ貼り替えないため。
        const linked = galleryKeyOf(this.queryValue(
          "SELECT gallery_id AS value FROM items WHERE source = 'app' AND path = ?",
          [full],
        ));
        const galleryId = linked || (ids[0] ? String(ids[0]) : null);
        this.upsert({
          source: 'app',
          filePath: full,
          galleryId,
          title: base,
        });
      }
    }
  }
}

module.exports = {
  Catalog,
  titleKey,
  titleKeyWeight,
  titleKeyEligible,
  volumeSafeContains,
  eagleIdFromPath,
  rebaseLibraryPath,
  seriesVolumeOf,
  seriesTitleOf,
  extractGalleryIds,
  tagNameKey,
  numericGalleryId,
  galleryKeyOf,
};
