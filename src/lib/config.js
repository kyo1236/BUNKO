const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  downloadDir: '',
  concurrency: 4,
  maxGalleries: 8,
  saveFormat: 'zip',
  source: 'hitomi',
  // 並びはサイトとスコープごとに覚える ('all:hitomi' / 'library:pawchive' ...)。
  // 単一のスカラだった頃は、所持作品で選んだ 保存日 が web の既定まで潰していた
  sortBySource: {},
  language: '',
  type: '',
  zoom: 3,
  eagleLibrary: '',
  eagleFolders: [],
  matchPriorityFolders: [],
  eagleUncategorized: true,
  openOwned: 'app',
  windowBounds: null,
  // 窓の × を押してから、トレイに畳んだ窓を捨てるまでの分数。閉じてもアプリは
  // 残り、LAN 配信と裏の仕事は続く (窓を閉じたまま常駐する写しが本命)。
  // 0 なら従来どおり、閉じたらそのまま終了する
  trayCloseMinutes: 30,
  readerRtl: true,
  readerFit: 'contain',
  loupeEnabled: true,
  // 最終頁の先で隣の作品へ渡るのは常に (切れない)。これは渡る前に隣の顔 (札) を
  // 一度挟むかどうかだけ。既定は挟まず直に開く (2026-09-20 の利用者の意向)
  readerNextCard: false,
  // 最終頁の先で渡る「次の作品」が一覧のどちら隣か。'up' = 一つ上の行 (新着順なら新しい方)、'down' = 一つ下の行。
  // 既定は上 (2026-09-27 利用者: それまでの下 = 降順に進む向きの逆)。前の作品はその反対
  readerNextOrder: 'up',
  readerResume: true,
  // 済の作品を保存し直す前に一度だけ確認する (誤ダブルクリック対策)
  ownedSaveConfirm: true,
  // スキャン後のメタデータ取得・タイトル照合・Eagle タグ書き込みを自動で走らせる
  autoSync: true,
  // hitomi と対応の取れていない Eagle アイテムも所持一覧に混ぜて出す
  showUnmatchedEagle: true,
  // 読み取り専用モード。--read-only 起動と同じで、どちらかが立てば効く。
  // 母艦から robocopy で写した側 (Homecore) で常用するとき、引数ではなく
  // 設定で固定するための口。書き込み (保存・取り込み・Eagle・棚の編集) を塞ぐ
  readOnly: false,
  // Homecore の写し先。空なら同期 script の既定 (<写しの置き場>)。
  // 釦と毎時タスクで写し先が食い違わないよう、両方がここを見る (項目 6-10)
  syncDest: '',
  // 起動用。既定 userData (%APPDATA%\hitomi-box) の config.json にだけ意味がある:
  // 引数が何も無いときの読み場所 (--data-dir と同じ) をここで指せる。
  // 起動の一番はじめに boot-config.js が生読みするので、この値の変更は
  // 次の起動から効く。移った先の config.json に書いても効かない
  dataDir: '',
  mouseLeft: 'detail',
  mouseRight: 'read',
  mouseDouble: 'save',
  hideOwned: false,
  favoritesOnly: false,
  // Home の一覧を、突き合わせで確かめても決められなかった候補を持つ作者だけにする (デバッグ用)
  homeUnresolvedOnly: false,
  favoriteMinStars: 4,
  // pawchive のお気に入り作者リスト。実際の既定は userData の中 (下の
  // defaultPawFavoritesFile)。downloadDir と同じく、空のまま置いて読み込み時に埋める
  pawFavoritesFile: '',
  // pawchive 所持作品が入っている Eagle フォルダ (「作者」) の id。子孫まで対象にする。
  // 空なら pawchive の所持は数えない (設定画面で入れる。Eagle の URL の末尾や API の /api/folder/list で分かる)
  pawEagleFolder: '',
  // お気に入り一括更新の出力先 (<出力先>/<service>/<作者名 [id]>/ の並び)。
  // 実際の既定は downloadDir と同じく読み込み時に埋める (下の defaultPawBulkDir)
  pawBulkDir: '',
  // pawchive のクッキー (Netscape 形式のファイル)。無認証だと数枚で 403 に
  // 切り替わるので、ログイン済みの証しを添えて取りに行く。入れ替えるとその場で
  // 読み直す。実際の既定は userData の中 (下の defaultPawCookieFile):
  // pawFavoritesFile と同じく、空のまま置いて読み込み時に埋める
  // (外部ツール kemono-dl の data/ に置いていた旧既定からは paw-cookies が引っ越す)
  pawCookieFile: '',
  // 同時に見る作者の数。API はまとめて叩くと 429 を返す: 増やしすぎない
  pawBulkConcurrency: 2,
  searchHistory: [],
  searchPins: [],
  // 同じ Wi-Fi の中の端末から所持作品を読ませる小さなサーバ。
  // 中身が中身なので既定は切: 開けている間だけ立てる。
  // 合言葉は初めて開けたときに作って、この中に持つ (QR で端末に渡す)
  lanShare: false,
  lanPort: 18766,
  lanToken: '',
  // 端末に配る頁を焼く大きさと形式。端末が最後に頼んだものを憶えておいて、
  // 次に立てたときの先焼きに使う (端末の画面は毎回同じなので当たる)
  lanPageWidth: 1080,
  lanPageFormat: 'webp',
  // リモート機 (Homecore) の Eagle API。ゴミ箱送りを向こうの Eagle にも届けて、
  // 二台の Eagle の見え方を揃える。形: { origin: 'http://host:41595', token: '...' }
  remoteEagle: null,
  session: null,
  // pixiv (docs/pixiv-design-2026-09-19.md §2, §12)。refresh token は母艦の config にだけ
  // (config は state-file で own = 写しへ行かない)。画面には出さず「ログイン済み (名前)」だけ
  pixivRefreshToken: '',
  pixivUser: null,
  // 網と所持棚で AI 生成の札を隠す
  pixivHideAi: false,
  // AI 作品の生成情報 (プロンプト) を aitag.win (第三者) に訊く。送るのは投稿の番号だけ。切ると原寸の絵から自前で読む
  aitagEnabled: true,
  // 網の投稿を読み手で原寸で読む。既定は原寸 (画質優先 — 2026-08-31 と 2026-09-20 の利用者の意向。
  // 「分単位で遅い」の正体は表紙まで落とす車線に乗せていたことで、原寸そのものではなかった)。
  // 切ると 1200 px の webp (pixiv の閲覧と同じ大きさ、1/20 の重さ)。落とす時は常に原寸
  pixivReadOriginal: true,
  // 候補 (ブックマーク) に非公開も混ぜる
  pixivBookmarkPrivate: true,
  // 「候補へ」で積む時の公開範囲。R-18 の候補を公開に積ませないので既定は非公開
  pixivBookmarkRestrict: 'private',
  // 作法の数字。空なら PPD の既定 (src/lib/pixiv/manners.js の DEFAULTS)。画面には出さない
  pixivManners: {},
};

// Electron の外 (単体試験・調査スクリプト) では app が居ない。
// userData は Windows なら %APPDATA%\<アプリ名>: 同じ場所を手で組んで当てる
function userDataDir() {
  try {
    return app.getPath('userData');
  } catch {
    const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(roaming, 'hitomi-box');
  }
}

function defaultPawFavoritesFile() {
  return path.join(userDataDir(), 'paw-favorites.txt');
}

// クッキーの既定の置き場。名前は書き出し元 (ブラウザ拡張) が付ける名前に合わせてある:
// Downloads に落ちた同名のファイルをそのまま持ち上げられる (paw-cookies の取り込み)
function defaultPawCookieFile() {
  return path.join(userDataDir(), 'pawchive.st_cookies.txt');
}

// お気に入りの基準は 3/4/5 のみ。壊れた値や旧版の値は既定 (★4 以上) に戻す
const FAVORITE_STAR_CHOICES = [3, 4, 5];

function normalizeFavoriteStars(value) {
  const numeric = Math.round(Number(value));
  return FAVORITE_STAR_CHOICES.includes(numeric) ? numeric : DEFAULTS.favoriteMinStars;
}

let cached = null;

function configPath() {
  // userDataDir() は electron の外でも同じ場所を指す (%APPDATA%\hitomi-box)。
  // ここだけ app.getPath を直に呼んでいたので、調査スクリプトからは設定が
  // 空に見えていた (pixiv のログイン状態が読めず「未ログイン」になる)
  return path.join(userDataDir(), 'config.json');
}

function defaultDownloadDir() {
  return path.join(app.getPath('downloads'), 'hitomi');
}

function defaultPawBulkDir() {
  return path.join(app.getPath('downloads'), 'pawchive');
}

function writeConfig(value) {
  // 素の上書きだと書き込み中のクラッシュで全設定が既定値に戻る
  require('./state-file').writeText('config', configPath(), JSON.stringify(value, null, 2));
}

function loadFromDisk() {
  const defaults = {
    ...DEFAULTS,
    downloadDir: defaultDownloadDir(),
    pawBulkDir: defaultPawBulkDir(),
    pawFavoritesFile: defaultPawFavoritesFile(),
    pawCookieFile: defaultPawCookieFile(),
  };
  let parsed = null;
  // 壊れた設定を黙って既定に戻さない。今までは次の save() で原本が上書き確定し、
  // lanToken (端末の入り口) と eagleLibrary (棚の所持判定) を誤りも出さずに失っていた。
  //
  // BOM は読む側で剥がす: PS5.1 の -Encoding utf8 で書かれた回に、
  // 中身は正しいのに「壊れている」と見なして設定を全部失った経緯がある
  let raw = null;
  try {
    raw = fs.readFileSync(configPath(), 'utf8').replace(/^﻿/, '');
  } catch {
    return defaults;                   // 無いだけ。初回起動はここ
  }
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 壊れている。原本を横へ退けて中身を残し、印を立てる (設定画面が出す)
    const stateFile = require('./state-file');
    const trace = require('./trace');
    stateFile.quarantine('config', configPath());
    trace.flag('config-corrupt');
    trace.note('config', 'corrupt', { bytes: raw.length });
    // **読み取り専用だけは引き継ぐ。** 既定 (false) に落とすと、写しの機体が
    // 次の起動で書き手として立ち上がる (config.json は同期の対象外なので
    // 母艦から直る当ても無い)。JSON として読めなくても、この一語は拾える
    const readOnly = /"readOnly"\s*:\s*true/.test(raw) ? true : defaults.readOnly;
    return { ...defaults, readOnly };
  }
  const next = { ...defaults, ...parsed };
  // 道は必ず trim する (項目 2-5)。手で書いた config の前後の空白が、
  // 索引・台帳・paw の三者で別の鍵になって走査が噛み合わなくなる
  for (const key of ['eagleLibrary', 'downloadDir', 'dataDir', 'pawBulkDir']) {
    if (typeof next[key] === 'string') next[key] = next[key].trim();
  }
  // 空で書かれた置き場は既定に戻す (空のまま使うと相対の道になって見当違いの所へ落ちる)
  if (!next.pawBulkDir) next.pawBulkDir = defaults.pawBulkDir;
  next.favoriteMinStars = normalizeFavoriteStars(next.favoriteMinStars);
  return next;
}

function load() {
  if (!cached) cached = loadFromDisk();
  return { ...cached };
}

function save(partial) {
  load();
  cached = { ...cached, ...partial };
  if (partial && Object.prototype.hasOwnProperty.call(partial, 'favoriteMinStars')) {
    cached.favoriteMinStars = normalizeFavoriteStars(cached.favoriteMinStars);
  }
  writeConfig(cached);
  return { ...cached };
}

module.exports = {
  load,
  save,
  defaultDownloadDir,
  defaultPawBulkDir,
  defaultPawFavoritesFile,
  defaultPawCookieFile,
};
