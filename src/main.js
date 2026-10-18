const fs = require('fs');
const http = require('http');
const path = require('path');
const {
  app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, screen, Tray,
} = require('electron');
const {
  search, getGallery, fetchImage, parseId, setCatalog, setLocalContent,
} = require('./lib/sources');
// 疑似 ID (pweagle:/pwlibf:) の判定・剥がしは sources/ids に集約してある
const {
  isPawEagleId, eagleIdOf, isPawFolderId, pawFolderIdOf, pawTriple,
} = require('./lib/sources/ids');
const { Downloader } = require('./lib/downloader');
const { decorateJobs: decorateDownloadJobs } = require('./lib/download-decorate');
const { Catalog } = require('./lib/catalog');
const { LibraryBackfill } = require('./lib/library-backfill');
const { LibraryMatch } = require('./lib/library-match');
const { EagleTagger } = require('./lib/eagle-tagger');
const { CreatorLabelJob } = require('./lib/creator-labels');
const config = require('./lib/config');
const { readBootConfig } = require('./lib/boot-config');
const pawCookies = require('./lib/paw-cookies');
const mediaCache = require('./lib/media-cache');
const trace = require('./lib/trace');
const reading = require('./lib/reading-store');
const pawFavorites = require('./lib/paw-favorites');
const pawLibrary = require('./lib/paw-library');
const pawLinks = require('./lib/paw-links');
const { PawState } = require('./lib/paw-state');
const { Discovery } = require('./lib/discovery');
const { PawBulk } = require('./lib/paw-bulk');
const { pawSaveRoute } = require('./lib/paw-save-route');
const { engine: kemonoEngine } = require('./lib/kemono-engine');
const { kemonoPaths, kemonoWorkDir } = require('./lib/kemono-paths');
const { LanServer } = require('./lib/lan-server');
// pixiv (docs/pixiv-design-2026-09-19.md)。台帳・取り込み・ログインの窓・口
const { PixivLibrary } = require('./lib/pixiv/library');
const { PixivImporter } = require('./lib/pixiv/importer');
const { PawImporter } = require('./lib/paw-importer');
const pixivEagle = require('./lib/eagle-api');
const { registerPixivIpc } = require('./main/ipc/pixiv-ipc');
const { openPixivLogin } = require('./main/pixiv-login');
// 同期版 (resolveContent) はもう使わない: 札が画面に入るたび主スレッドで readdir していた
const { resolveContentMemo, stampOf } = require('./lib/local-content');
const { parseRange } = require('./lib/http-range');
const { unpackedPath } = require('./lib/asar-path');
const { imageType, imageSize } = require('./lib/image-size');
const localArchive = require('./lib/local-archive');
const pageBaker = require('./lib/page-baker');
const pdfUnpack = require('./lib/pdf-unpack');
const aiMetaService = require('./lib/ai-meta-service');
const { setPageBytesHook } = require('./lib/downloader');
const { renderPdfPage, renderPdfThumb } = require('./lib/pdf-page');
// IPC の口は機能別に src/main/ipc/ へ分けてある。main 側の状態は deps で渡す
const { registerSearchIpc } = require('./main/ipc/search-ipc');
const { registerLibraryIpc } = require('./main/ipc/library-ipc');
const { registerDownloadIpc } = require('./main/ipc/download-ipc');
const { registerPawIpc } = require('./main/ipc/paw-ipc');
const { registerSettingsIpc } = require('./main/ipc/settings-ipc');
const { registerLanIpc } = require('./main/ipc/lan-ipc');
// Home (源泉横断の作者の一覧と作者頁、docs/home-tab-spec-2026-09-23.md)。
// hitomi / nhentai の名乗りの結びは creator-links、pixiv と Pawchive は既存の台帳が持つ
const { registerHomeIpc } = require('./main/ipc/home-ipc');
const { HomeAuthors } = require('./lib/home-authors');
const { CreatorLinks } = require('./lib/creator-links');
const { PageCounts } = require('./lib/page-counts');
const { ReleaseDates } = require('./lib/release-dates');

// データ置き場 (userData) の決定。他のモジュールはどれも userData を関数の中で
// 遅延して引く (config / reading-store / catalog ほか) ので、require 直後・app ready 前の
// ここで確定させれば全員が同じ場所を見る。優先順:
//   1. --data-dir=<path> : 置き場をまるごと差し替える。Homecore が母艦のミラー
//      (robocopy の写し) を直接読むための口。--read-only と併用する。
//      Electron 標準の --user-data-dir は Chromium プロファイル用の引数で
//      app.getPath('userData') を変えないため、自前で受けるしかない
//   2. --user-data-dir   : 検証用の使い捨て置き場。従来どおり Electron の解釈を尊重
//   3. 起動用の一枚      : 既定 userData の config.json の dataDir。引数が
//      何も無いとき (素のアイコン起動・スタートメニュー) だけ見る。写しの機体で
//      毎回引数を付けなくても済むように (boot-config.js を参照)
//   4. 既定              : %APPDATA%\hitomi-box。梱包版 (productName: BUNKO) でも
//      開発中と揃える。これを外すと userData が %APPDATA%\BUNKO に移り、
//      既存の config.json が読めなくなる
const dataDirArg = process.argv.find((arg) => arg.startsWith('--data-dir='));
const dataDirValue = dataDirArg
  ? dataDirArg.slice('--data-dir='.length).trim().replace(/^"(.*)"$/, '$1')
  : '';
const hasUserDataDirArg = process.argv.some((arg) => arg.startsWith('--user-data-dir'));
const defaultUserData = path.join(app.getPath('appData'), 'hitomi-box');
const boot = dataDirValue || hasUserDataDirArg ? {} : readBootConfig(defaultUserData);
const dataDirWanted = dataDirValue || boot.dataDir || '';
if (dataDirWanted) {
  const dataDir = path.resolve(dataDirWanted);
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch {
    // 作れなくても setPath は通す: 実際の読み書きの失敗の方が場所付きで表に出る
  }
  app.setPath('userData', dataDir);
} else if (!hasUserDataDirArg) {
  app.setPath('userData', defaultUserData);
}

// 二重に立てない。トレイへ畳むようになってから「隠れている BUNKO が居るのに
// ショートカットからもう一度叩く」が起きやすく、2 本目が同じ置き場を取り合って
// どちらの窓も出ないことがある。錠が取れなければ二人目は何もせず退き、
// 先客が second-instance で窓を出す。
// 錠は置き場 (userData) ごとなので、上で --data-dir / --user-data-dir を決めた後に
// 取ること: 写しの機体や使い捨ての検証用起動は素の BUNKO と同居できる
if (!app.requestSingleInstanceLock()) {
  app.quit();
  // quit は非同期。この後の module 本体 (IPC の口・台帳・LAN) を走らせないよう即抜ける
  process.exit(0);
}

// 読み取り専用モード (--read-only、起動用の一枚の readOnly、または設定 readOnly)。
// Homecore など robocopy の写しの上で起動するとき用: 閲覧・検索・読書 (栞の保存を
// 含む) はそのままに、ダウンロード・取り込み・Eagle への書き込み・棚 (台帳) の
// 編集をまとめて塞ぐ
const readOnly = process.argv.includes('--read-only') || boot.readOnly === true || config.load().readOnly === true;
const READ_ONLY_ERROR = '読み取り専用モードのため実行できません';
// 控えの番人に役を伝える。ここから先、母艦が作って同期で配る控え
// (eagle-scan-cache / paw-library-cache / paw-favorites / paw-links / 台帳) は
// 写しの機体では書き出されない。焼き頁のように機体ごとに持つ物は今までどおり書く
require('./lib/state-file').setRole({ readOnly });

// 設定に readOnly の実効値 (起動引数込み) を添えて画面へ渡す。
// レンダラが読み取り専用かどうかを知る口はこの一つ
// 最後の走査が転んだ理由。帯と設定画面がこれを出す (空なら健やか)
// 実体をそのまま配る。**読みの途中で切れても主プロセスを落とさない** (項目 9-4)。
// SMB の共有が一瞬詰まる・Eagle が実体を消す、のどちらでも stream は error を投げ、
// 受けが無いと拾われない例外として上がって窓ごと終わっていた
function pipeFile(res, file, options) {
  const stream = fs.createReadStream(file, options);
  stream.on('error', (error) => {
    trace.warnOnce('serve:read', 'media', 'read-failed', { id: trace.codeOf(error) });
    stream.destroy();
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

let lastScanError = '';
// 激減で見送った回の内訳 ({ prev, kept })。それ以外は null
let lastScanDetail = null;

// 棚の状態に「この機体で今どうなっているか」を添える。画面の帯はこれだけを読む。
// 配線は既にある library-progress に相乗りするので IPC は増えない (項目 9-1/9-2/9-7/5-10)
function libraryView() {
  const base = catalog.libraryStatus();
  let stuck = 0;
  try {
    stuck = pdfUnpack.fallbacks().length;
  } catch {
    stuck = 0;
  }
  // pixiv の帯に添える数 (冷却の残り・Eagle 待ちの件数)。無ければ 0
  let pixivPausedForMs = 0;
  let pixivImportWaiting = 0;
  try {
    pixivPausedForMs = require('./lib/pixiv').manners().state().pausedForMs || 0;
  } catch {
    pixivPausedForMs = 0;
  }
  try {
    pixivImportWaiting = pixivImporter ? pixivImporter.pending().waitingEagle : 0;
  } catch {
    pixivImportWaiting = 0;
  }
  return {
    ...base,
    flags: trace.flags(),
    fallbacks: stuck,
    readOnly,
    scanError: lastScanError,
    scanDetail: lastScanDetail,
    pixivPausedForMs,
    pixivImportWaiting,
  };
}

function settingsView(value) {
  // pixiv の refresh token は画面へ出さない。ログイン済みかどうかと名前だけ
  const { pixivRefreshToken, ...rest } = value || {};
  return { ...rest, readOnly, pixivLoggedIn: Boolean(pixivRefreshToken) };
}

const downloader = new Downloader();
const catalog = new Catalog();
let pixivLibrary = null;
let pixivImporter = null;
let pawImporter = null;
let backfill = null;
let matchJob = null;
let eagleTagger = null;
let creatorLabels = null;
let pawState = null;
let pawBulk = null;
let discovery = null;
// Home の作者の一覧 (控えを持つ) と、hitomi / nhentai の名乗りの結び
let homeAuthors = null;
let creatorLinks = null;
// 所持の Eagle の本の頁数の控え (名前に頁数の無い本も一覧の札に頁数の印を出す)
let pageCounts = null;
let lanServer = null;
let mainWindow = null;
let imageBase = '';
let imageBaseReady = null;
let catalogReady = null;
let boundsTimer = null;
let tray = null;
let trayTimer = null;
// トレイへ畳んでいる最中か。畳んでいる間の破棄 (メモリ返し) と、
// 本当に閉じられたときの終了を 'closed' で見分けるための印
let trayHidden = false;
// 終了に入ったか。× の畳みを通さないための印 (立てるのは before-quit)
let quitting = false;

// 台帳 (sql.js の WASM + catalog.sqlite の読み込み) は起動で一番重い。窓より後に
// 回すので、台帳に触る IPC はここで待ち合わせてから処理する。
// 初期化がこけた場合も待ちは解ける: db 無しのまま (空の結果を返す) 進む
function whenCatalog() {
  return catalogReady || Promise.resolve();
}

const FILE_TYPES = {
  pdf: 'application/pdf',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  zip: 'application/zip',
};

function fileType(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  return FILE_TYPES[ext] || 'application/octet-stream';
}

// 画像は名前ではなく中身で名乗る。Eagle のサムネイルは中身が WebP でも
// <名前>_thumbnail.png と付くので、拡張子を信じると宣言と中身が食い違う。
// 原本は数百 MB のことがあるので、頭だけ読んで本体はそのまま流す
function sniffImageType(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    return imageType(head);
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* 閉じられなくても配信は続く */ }
    }
  }
}

// "<service>/<user>" の語で所持作品を引くときの手がかり。作者フォルダを手で紐付けていない
// 作者は、表示名 (別名のことが多い) と投稿 ID の照合でしか当てられない。
// どちらも圏外なら空で返す: 手がかりが減るだけで検索そのものは落とさない
async function pawCreatorHints(query) {
  const hit = String(query || '').trim().match(/^(\w+)\/([^/\s]+)/);
  if (!hit) return { creatorName: '', creatorPostIds: [] };
  const paw = require('./lib/sources/pawchive');
  let creatorName = '';
  let creatorPostIds = [];
  try {
    creatorName = await paw.creatorDisplayName(hit[1], hit[2]);
  } catch {
    // 作者一覧が引けないだけ。投稿 ID の照合はまだ望みがある
  }
  try {
    creatorPostIds = await paw.creatorPostIds(hit[1], hit[2]);
  } catch {
    // creatorPostIds 自身も握り潰すが、口の取り違えでも落ちないようにここでも受ける
  }
  return { creatorName, creatorPostIds };
}

// 机上版の paw 札の表紙。Eagle のサムネイルは小さく、札の寸法に伸ばすとぼやける。
// LAN の表紙と同じく原本の 1 頁目を 720px に焼いて出す (焼いた結果は mediaCache に
// 残るので、二度目からはサムネイル配りと同じ速さ)。PDF 原本は開かない
const PAW_COVER_WIDTH = 720;
// 札に出すだけなので原寸ほどの品質は要らない。原本が小さければ焼き直さない
const PAW_COVER_QUALITY = 0.8;

// pawchive 所持作品の表紙。
// **綴じ目から直に抜く** (pdf-unpack)。以前は pdf.js の隠し窓で WebP に焼いており、
// 一枚 150〜1200 ms かかって札が何秒も空のままだった (実測)。
// 焼き場は一本の窓を順番待ちするので、一覧 30 枚ぶんが直列に並ぶ。
// 実体の見分けと版も**非同期の控えつき**に直した (以前は readdir と stat を
// 主スレッドで同期に回していて、札が画面に入るたびに窓が止まっていた。項目 2-7)
async function pawCoverImage(eagleId) {
  const folder = pawLibrary.itemFolder(eagleId);
  if (!folder) return null;
  const content = await resolveContentMemo(folder);
  if (!content) return null;
  const stamp = (await stampOf(content.target)) || 0;
  const key = `pawcover:${eagleId}:${stamp}:${PAW_COVER_WIDTH}`;
  if (content.mode === 'pdf') {
    // 'soon' の行列へ。表紙そのものが利用者の待っている物なので裏 ('idle') へは
    // 置けないが (本の裏の用意 何百頁の後ろに並ぶ)、読んでいる頁より先でもない
    return mediaCache.getImage(key, () => renderPdfThumb(
      content.target,
      0,
      { width: PAW_COVER_WIDTH, quality: PAW_COVER_QUALITY },
      `cover:${eagleId}`,
      { lane: 'soon' },
    )).catch(() => null);
  }
  if (content.mode !== 'images') return null;
  return mediaCache.getImage(key, async () => {
    const page = await localArchive.readPage(content.target, 0);
    if (!page) return null;
    const size = imageSize(page.bytes);
    // 元から札に収まる絵は焼き直さない (手間と画質を捨てるだけ)
    if (!size || size.width <= PAW_COVER_WIDTH * 1.15) {
      return { bytes: page.bytes, type: imageType(page.bytes) || 'image/jpeg', name: page.name };
    }
    const made = await pageBaker.fitImage(page.bytes, PAW_COVER_WIDTH, 'webp');
    return made ? { ...made, name: page.name } : null;
  }).catch(() => null);
}

// 所持作品 (hitomi 側) の表紙と頁を手元から出す。以前は所持していても hitomi.la から
// 取っていた (Eagle のアイテムはほぼ PDF で、原本の画像フォルダを探す従来の道は空振り)。
//   表紙: Eagle が原本の隣に作るサムネイル (短辺 480px の WebP)。札の寸法には十分で、
//         SMB 越しでも 1 枚 5 ms。網から取ると 2 往復 (0.4〜1.2 秒) かかっていた
//   頁  : 画像フォルダ/zip はそのまま、PDF は pdf-unpack が綴じ目から絵を抜いて配る。
//         蔵書の 95% は頁に JPEG がそのまま入っているので、そこは原本のバイトを
//         一切触らずに出す (無劣化・符号化なし)。生画素で入っている 4% だけ JPEG にする。
//         幅は原寸 (貼られた絵の幅、2150 前後)。端末向けの 1440 を使っていた時は
//         4K 150% の画面 (実画素 2160 高) で焼き頁を引き伸ばすことになり、Eagle で
//         原本を見るより甘かった。品質は 0.92 → 0.95 (符号化の時間は変わらず 43 ms、
//         大きさが 1 割増えるだけで PSNR が 4 dB 上がる。効くのは生画素の頁だけ)
const LOCAL_PAGE_WIDTH = pageBaker.NATIVE;
const LOCAL_PAGE_QUALITY = 0.95;

const localContent = {
  // 台帳に載らない所持作品 (pawchive / 未照合の Eagle アイテム) の実体の道。
  // 台帳が知っているのは hitomi と紐付いた本だけなので、疑似 ID はここで引く。
  //
  // **網から開いた pawchive の作品 (pw:<service>:<user>:<postId>) も結ぶ。**
  // 所持していれば実体は Eagle の中にあるのに、ここで結ばないと網へ取りに行き、
  // 「画像を読めませんでした」になる (以前は renderer の pdf.js が eagleId で
  // 別経路に逃がしていたので表に出ていなかった)
  pathOf(id) {
    // pixiv の所持 (px:<投稿 ID>) は台帳が Eagle 項目を知っている (url が原本)。
    // 実体は作者根の中の <id>.info なので paw と同じ入れ物の道を返す
    const parsed = parseId(id);
    if (parsed.source === 'pixiv') {
      if (!pixivLibrary || String(parsed.key).startsWith('user:')) return null;
      const eagleId = pixivLibrary.eagleIdOf(parsed.key);
      return eagleId ? pawLibrary.itemFolder(eagleId) : null;
    }
    return pawLibrary.folderForGalleryId(id);
  },
  async fetch(localPath, index, size, options = {}) {
    const content = await resolveContentMemo(localPath);
    if (!content) return null;
    if (size !== 'full') {
      if (index === 0 && content.cover) {
        // サムネイルも media-cache に載せる (記憶 80 MB + 円盤)。二度目からは SMB に
        // 触らないので、全件走査が SMB を塞いでいる最中でも表紙は待たない
        return mediaCache.getImage(`localcover:${content.cover}`, async () => {
          const bytes = await fs.promises.readFile(content.cover);
          return { bytes, type: imageType(bytes) || 'image/webp', name: path.basename(content.cover) };
        }).catch(() => null);
      }
      // 表紙は今までどおり原本の 1 頁目そのまま (札の寸法はここで決めない)
      if (index === 0 && content.mode === 'images') return localArchive.readPage(content.target, 0);
      // 途中の頁の小札 (読み手の頁一覧) も原本から作る。網に頁を貰いに行くより速く、
      // Eagle アイテムのように網に無い本でも出る
      return localThumbBytes(content, index, size);
    }
    if (content.mode === 'images') return localArchive.readPage(content.target, index);
    if (content.mode !== 'pdf') return null;
    const stamp = await stampOf(content.target);
    if (!stamp) return null;
    // 前面の頁を出している間は裏の用意を止める (数え上げは warmLocalBook が見る)
    foregroundPages += 1;
    let page = null;
    try {
      page = await localPageBytes(content, stamp, index);
    } finally {
      foregroundPages -= 1;
    }
    // 読み始めた本は残りを裏で用意する。数頁読んでいる間に揃い、どこへ跳んでも待たない。
    // 札を見ただけ (詳細を開いた時の先回り) では走らせない: 繰っているだけの本まで
    // 丸ごと用意すると、円盤と CPU を browsing に持っていかれる
    if (options.reading) warmLocalBook(content, stamp, index);
    return page;
  },
};

// 読み手の頁一覧に出す小札。原本から縮めて作る (sharp が worker で縮めるので 1 枚 数 ms)。
// 表紙 (big) は札いっぱいに出るので少し大きめに
const LOCAL_THUMB_QUALITY = 0.7;

function thumbWidth(size) {
  return size === 'big' ? 720 : 360;
}

// 小札は**裏の仕事**として頼む。頁一覧を開くと一度に何十枚も来るので、
// 表の頁と同じ列に並べると読み手が待たされる
// (実測: 表の仕事として出していた時、一覧を開いた直後の一枚が 804ms)。
// 札は少し遅れて埋まればよく、頁は待てない
function thumbTag(content, stamp) {
  // 本が変わったら前の本の小札は追わない。裏の用意と同じ札の空間に置くので、
  // warmLocalBook の取り下げ (dropBackgroundExcept) が一緒に畳んでくれる
  return `${DESK_TAG}${content.target}:${stamp}`;
}

async function localThumbBytes(content, index, size) {
  const width = thumbWidth(size);
  if (content.mode === 'images') {
    const page = await localArchive.readPage(content.target, index).catch(() => null);
    if (!page) return null;
    const small = await pdfUnpack
      .shrinkBytes(page.bytes, { width, quality: LOCAL_THUMB_QUALITY, background: true })
      .catch(() => null);
    return small ? { ...small, name: String(index) } : page;
  }
  if (content.mode !== 'pdf') return null;
  const stamp = await stampOf(content.target);
  if (!stamp) return null;
  const key = `localthumb:${stamp}:${content.target}:${index}:w${width}:v1`;
  return mediaCache.getImage(key, () => renderPdfThumb(
    content.target,
    index,
    { width, quality: LOCAL_THUMB_QUALITY },
    thumbTag(content, stamp),
  )).catch(() => null);
}

// Eagle アイテムの本当の頁数。名前の【17P】は当てにならず、0 だと読み手が開けない。
// 綴じ目だけ読むので SMB 越しでも数 ms
async function localPageCount(id) {
  try {
    const dir = localContent.pathOf(id);
    if (!dir) return 0;
    const content = await resolveContentMemo(dir);
    if (!content) return 0;
    if (content.mode === 'pdf') return (await pdfUnpack.pageCount(content.target)) || 0;
    if (content.mode === 'images') return (await localArchive.pageCount(content.target)) || 0;
    return 0;
  } catch {
    return 0;
  }
}

// 鍵に幅と品質と作り方が入るので、作り方を変えた時は前の頁が使われず、予算で押し出される。
// まず PDF から絵を直に抜く (pdf-unpack)。抜けるのは「絵 1 枚を紙いっぱいに貼った頁」だけで、
// その時は JPEG の頁なら原本のバイトをそのまま配る (無劣化)。
// 抜けない本 (JPEG2000・透過つきの JPEG・文字が重なる頁) だけ隠し窓で焼く。
// 焼き場も WebP をやめて JPEG にした: 原寸の符号化が 550 ms → 65 ms で、落ちても待たせない。
// options.background は裏の用意 (表示待ちの頁に道を譲る)、tag は取り下げの札
// 裏の用意の札。机上版と手のひら版で名前空間を分ける (互いの用意を消さないため)
const DESK_TAG = 'desk:';

function localPageBytes(content, stamp, index, options = {}) {
  const key = `localpage:${stamp}:${content.target}:${index}:native:q${LOCAL_PAGE_QUALITY}:v3`;
  // 三段 (直抜き → 取り下げの再試行 → 焼き場) は pdf-page が持つ。
  // 手のひら版と同じ一本を通す (項目 8-2)
  return mediaCache.getImage(key, () => renderPdfPage(
    content.target,
    index,
    { width: LOCAL_PAGE_WIDTH, quality: LOCAL_PAGE_QUALITY },
    options,
    { width: LOCAL_PAGE_WIDTH, format: 'jpeg', options: { quality: LOCAL_PAGE_QUALITY, ...options } },
  )).catch(() => null);
}

// 開いた本の残りを裏で用意する (手のひら版の warmBook と同じ考え)。読んでいる頁から
// 先へ、次に後ろへ。読み手が跳んだら (頁の要求が来るたびに want が動く) そこから
// 先を優先し直す: 100 頁跳んだ先で、裏が昔の場所を追い続けないため。一頁ずつ
// (worker 一本と主スレッドの符号化 50 ms) なので、読み手の先読みは追い越して通る。
// 別の本を開いたら前の本の残りは追わない
let localWarm = { tag: '', want: 0 };
// 今まさに出そうとしている頁の数。裏の用意はこれが 0 の間だけ進む
let foregroundPages = 0;

function pause(ms) {
  return new Promise((done) => {
    const timer = setTimeout(done, ms);
    if (timer.unref) timer.unref();
  });
}
async function warmLocalBook(content, stamp, from) {
  const tag = `${DESK_TAG}${content.target}:${stamp}`;
  if (localWarm.tag === tag) {
    localWarm.want = from;
    return;
  }
  pdfUnpack.dropBackgroundExcept(DESK_TAG, tag);
  pageBaker.dropBackgroundExcept(DESK_TAG, tag);
  const mine = { tag, want: from };
  localWarm = mine;
  let total = 0;
  try {
    total = await pdfUnpack.pageCount(content.target);
  } catch {
    total = 0;
  }
  if (total < 2) return;
  const done = new Set();
  const pick = () => {
    for (let i = mine.want + 1; i < total; i += 1) if (!done.has(i)) return i;
    for (let i = mine.want - 1; i >= 0; i -= 1) if (!done.has(i)) return i;
    return -1;
  };
  for (;;) {
    if (localWarm !== mine || quitting) return;
    // 読み手が頁を待っている間は退く。裏の用意は「読んでいる合間」にやる仕事で、
    // 符号化は主スレッドを 40 ms 止めるので、割り込ませると次の本の初回表示が遅れる
    while (foregroundPages > 0 && !quitting) {
      await pause(15);
      if (localWarm !== mine) return;
    }
    const index = pick();
    if (index < 0) return;
    done.add(index);
    await localPageBytes(content, stamp, index, { background: true, tag });
    // 一頁ごとに間を空ける。窓の描き直しと入力に道を譲る
    await pause(4);
  }
}

// 作者札 (pwlibf) は一番新しい作品の表紙を借りる
async function newestPawEagleId(folderId) {
  await pawLibrary.ready();
  // 並びは作者札の扇 (paw-library の recentByFolder) と同じ: 正面が後ろの二枚と重ならない
  const newest = pawLibrary.recentByFolder(1).get(folderId)?.[0];
  return newest ? newest.eagleId : null;
}

function startImageServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'OPTIONS') {
        // Range は安全なヘッダ扱いではない: 許さないと pdf.js の部分取得が preflight で止まる
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD',
          'Access-Control-Allow-Headers': 'Range',
          'Access-Control-Max-Age': '86400',
        });
        res.end();
        return;
      }
      // pawchive 所持作品の表紙。まず原本の 1 頁目を焼いて出し (pawCoverImage)、
      // 焼けない原本 (PDF 等) は従来どおり Eagle のサムネイルに落ちる。
      // 作者フォルダの札 (/pwlibf/) は、その中の一番新しい作品の表紙を借りる
      if (url.pathname.startsWith('/pweagle/') || url.pathname.startsWith('/pwlibf/')) {
        const folder = url.pathname.startsWith('/pwlibf/');
        const key = decodeURIComponent(url.pathname.slice(folder ? '/pwlibf/'.length : '/pweagle/'.length));
        const eagleId = folder ? await newestPawEagleId(key) : key;
        const baked = eagleId ? await pawCoverImage(eagleId) : null;
        if (baked) {
          res.writeHead(200, {
            'Content-Type': baked.type || 'image/webp',
            'Cache-Control': 'public, max-age=604800',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(baked.bytes);
          return;
        }
        const file = folder ? pawLibrary.folderCoverPath(key) : pawLibrary.thumbnailPath(key);
        if (!file) {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        res.writeHead(200, {
          'Content-Type': sniffImageType(file) || fileType(file),
          'Cache-Control': 'public, max-age=604800',
          'Access-Control-Allow-Origin': '*',
        });
        pipeFile(res, file);
        return;
      }
      // pdf.js の worker。file:// から直に起こせないので原本を配って blob に包ませる
      if (url.pathname === '/pdfworker') {
        // 梱包後 (asar) は原本が app.asar.unpacked 側に落ちている。asarUnpack と対になる差し替え
        const file = unpackedPath(
          path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.js')
        );
        if (!fs.existsSync(file)) {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/javascript',
          'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*',
        });
        pipeFile(res, file);
        return;
      }
      // 所持作品の本体 (ほぼ全て PDF)。リーダーが pdf.js に食わせて頁を描く
      if (url.pathname.startsWith('/pwfile/')) {
        const file = pawLibrary.originalPath(decodeURIComponent(url.pathname.slice('/pwfile/'.length)));
        if (!file) {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        let size = 0;
        try {
          size = fs.statSync(file).size;
        } catch {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        // Content-Range などは CORS の既定では読ませてもらえない: 明に開けないと範囲取得が成立しない
        const head = {
          'Content-Type': fileType(file),
          'Cache-Control': 'private, max-age=600',
          'Accept-Ranges': 'bytes',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Range, Content-Length',
        };
        const range = parseRange(req.headers.range, size);
        if (range && range.unsatisfiable) {
          res.writeHead(416, { ...head, 'Content-Range': `bytes */${size}`, 'Content-Length': 0 });
          res.end();
          return;
        }
        if (range) {
          res.writeHead(206, {
            ...head,
            'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
            'Content-Length': range.end - range.start + 1,
          });
          if (req.method === 'HEAD') {
            res.end();
            return;
          }
          pipeFile(res, file, { start: range.start, end: range.end });
          return;
        }
        res.writeHead(200, { ...head, 'Content-Length': size });
        // HEAD は頭だけ返す: pdf.js が長さを見に来ることがある
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        pipeFile(res, file);
        return;
      }
      const galleryId = url.searchParams.get('id') || url.pathname.split('/')[2];
      const fileIndex = Number(url.searchParams.get('i') ?? url.pathname.split('/')[3]);
      if (!galleryId || !Number.isFinite(fileIndex)) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      const size = url.searchParams.get('size') || 'full';
      // read=1 は読み手 (リーダー) から。詳細を開いた時の先回りには付かない
      const reading = url.searchParams.get('read') === '1';
      // 読み手の頁は表紙より先に (小さいほど先。http.js の SiteScheduler と同じ物差し)
      const priority = reading ? 0 : 10;
      // 札を送って見えなくなった表紙、めくって要らなくなった頁は、網の取得ごと取り下げる。
      // 取り下げないと要らない絵を最後まで運んで車線を塞ぐ (同じ絵を待つ別の口が居れば
      // media-cache が数えていて止めない)
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) controller.abort(new Error('client closed'));
      });
      const image = await fetchImage(galleryId, fileIndex, {
        size, reading, priority, signal: controller.signal,
      });
      // 手元にしか無い本 (Eagle アイテム) で出せなかった頁。網に代わりは無い
      if (!image) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      const { bytes, type } = image;
      res.writeHead(200, {
        'Content-Type': type,
        'Cache-Control': 'public, max-age=604800, immutable',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(Buffer.from(bytes));
    } catch (error) {
      // 取り下げた要求 (相手が居ない) には返事を書かない
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(error.status || 500);
      res.end(error.message || 'image error');
    }
  });

  const preferred = 18765;
  return new Promise((resolve, reject) => {
    const listen = (port) => {
      server.once('error', (error) => {
        if (port === preferred && error.code === 'EADDRINUSE') {
          listen(0);
          return;
        }
        reject(error);
      });
      server.listen(port, '127.0.0.1', () => {
        server.removeAllListeners('error');
        resolve(`http://127.0.0.1:${server.address().port}`);
      });
    };
    listen(preferred);
  });
}

function validBounds(bounds) {
  if (!bounds) return null;
  const { x, y, width, height } = bounds;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width < 960 || height < 640) return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const visible = screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return x < area.x + area.width
      && x + width > area.x
      && y < area.y + area.height
      && y + height > area.y;
  });
  return visible ? { x, y, width, height } : null;
}

function rememberBounds() {
  if (boundsTimer) clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    boundsTimer = null;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    config.save({ windowBounds: mainWindow.getNormalBounds() });
  }, 500);
}

// 窓の × を押してから、畳んだ窓を捨てるまでの分数。0 (や壊れた値) なら
// 従来どおり閉じたら終了。設定を書き替えたら次に閉じたときから効く
function trayCloseMinutes() {
  const minutes = Number(config.load().trayCloseMinutes);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : 0;
}

// トレイのアイコン。.ico には複数の大きさが入っているので Windows に選ばせ、
// 読めなかったときだけ 256px の png を 16px に縮めて充てる
function trayImage() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.ico'));
  if (!icon.isEmpty()) return icon;
  return nativeImage
    .createFromPath(path.join(__dirname, '..', 'assets', 'icon-256.png'))
    .resize({ width: 16, height: 16 });
}

// 常駐の姿は畳むときに初めて立てる (0 分の機体には出さない)。一度立てたら
// 終了まで持ち続ける: 参照を手放すと GC でアイコンだけ消える
function ensureTray() {
  if (tray && !tray.isDestroyed()) return;
  tray = new Tray(trayImage());
  tray.setToolTip(readOnly ? 'BUNKO (写し)' : 'BUNKO');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '開く', click: () => showFromTray() },
    // 従来の終了経路をそのまま通す (before-quit の後始末に用がある)
    { label: '終了', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', () => showFromTray());
}

// 窓を隠してタスクバーからも下げ、姿をトレイだけにする。畳んだまま放って
// おく間は窓ごと捨ててメモリを返す (見ていた中身は config と台帳に残る)
function hideToTray(minutes) {
  ensureTray();
  trayHidden = true;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
    mainWindow.setSkipTaskbar(true);
  }
  if (trayTimer) clearTimeout(trayTimer);
  trayTimer = setTimeout(() => {
    trayTimer = null;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
  }, minutes * 60 * 1000);
}

// トレイから呼び戻す。捨てたあとなら建て直す (位置は windowBounds から戻る)
function showFromTray() {
  if (trayTimer) {
    clearTimeout(trayTimer);
    trayTimer = null;
  }
  trayHidden = false;
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  mainWindow.setSkipTaskbar(false);
  mainWindow.show();
  mainWindow.focus();
}

function createWindow() {
  const restored = validBounds(config.load().windowBounds);
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    ...(restored || {}),
    minWidth: 960,
    minHeight: 640,
    title: '文匣',
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    backgroundColor: '#0c1016',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  // × では終わらせず、トレイへ畳むだけにする。窓を閉じたまま常駐する写しでは
  // ここで落ちると電話への配信ごと止まってしまう。0 分なら従来どおり終了
  mainWindow.on('close', (event) => {
    if (quitting) return;
    const minutes = trayCloseMinutes();
    if (minutes <= 0) return;
    event.preventDefault();
    hideToTray(minutes);
  });
  // 窓を閉じたら畳む。頁を焼く隠し窓 (page-baker) が残っていると
  // window-all-closed が来ず、姿の無いまま起きっぱなしになる
  mainWindow.on('closed', () => {
    mainWindow = null;
    // 畳んでいる間の破棄はメモリを返すためのもの: ここでは終わらせない
    if (trayHidden) return;
    if (process.platform !== 'darwin') app.quit();
  });
  mainWindow.on('resize', rememberBounds);
  mainWindow.on('move', rememberBounds);
  mainWindow.on('app-command', (event, command) => {
    if (command === 'browser-backward' || command === 'browser-forward') {
      event.preventDefault();
      send('nav-command', command);
    }
  });
  mainWindow.webContents.setVisualZoomLevelLimits(1, 1);
  mainWindow.webContents.on('console-message', (_event, _level, message) => {
    if (message) console.log('[renderer]', message);
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function send(channel, payload) {
  lanDesktop.publish(channel, payload);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// タスクバーの進捗は進行中 (待機を含む) のジョブをひとまとめにした比率で出す
function updateTaskbarProgress(jobs) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  let done = 0;
  let total = 0;
  for (const job of jobs) {
    if (job.status !== 'queued' && job.status !== 'running') continue;
    done += job.done || 0;
    total += job.total || 0;
  }
  mainWindow.setProgressBar(total > 0 ? Math.min(1, done / total) : -1);
}

// 済んだ仕事の行き先 (downloadDest / eagleItemId / finalPath) を添える。
// 中身は lib/download-decorate に出してある (ここは Electron を抱えていて
// 試験から読めないため)。引く口 (downloads) と押し出す口の両方がこれを通る
function decorateJobs(jobs) {
  return decorateDownloadJobs(jobs, { catalog, pawLinks, pawLibrary, pixivLibrary: () => pixivLibrary });
}

downloader.on('update', (jobs) => {
  send('downloads', decorateJobs(jobs));
  updateTaskbarProgress(jobs);
});
// ダウンロード後の自動同期: Eagle の自動取り込みが済むのを待ってから、
// スキャン→照合→タグ書き込みを一巡させる。連続ダウンロード中は
// 最後の1件から数えて一度だけ走る(デバウンス)
let postDownloadSyncTimer = null;
function schedulePostDownloadSync() {
  if (postDownloadSyncTimer) clearTimeout(postDownloadSyncTimer);
  postDownloadSyncTimer = setTimeout(() => {
    postDownloadSyncTimer = null;
    refreshCatalog()
      .then(() => runLibraryJobs())
      .catch(() => {});
  }, 180000);
}

downloader.onComplete = (job) => {
  // 一括更新と同じ棚に落ちたぶんは台帳にも印を付ける: 次の一括更新で取り直させない
  if (job.pawKey && pawState) {
    try {
      pawState.markCompleted(job.pawKey);
      pawState.catalog.flushPersist();
    } catch {
      // 印が付かなくても保存そのものは済んでいる
    }
  }
  const parsed = parseId(job.id);
  const galleryId = parsed.source === 'hitomi' ? Number(parsed.key) : null;
  // pixiv は台帳の外 (Eagle の url と pixiv-library が答える): 台帳には記帳しない
  if (parsed.source !== 'pixiv') catalog.markApp(job.id, job.title, job.dest);
  if (galleryId && String(galleryId) !== String(job.id)) {
    catalog.rememberLocal(galleryId, job.title, job.dest);
  }
  schedulePostDownloadSync();
  send('catalog', catalog.snapshot());
  if (Number.isFinite(galleryId)) {
    getGallery(String(galleryId))
      .then((gallery) => {
        catalog.storeGalleryMeta(gallery);
        send('library-progress', libraryView());
      })
      .catch(() => {});
  }
};

// 表紙は grid が画面に入って初めて取りに行くので、一枚目は必ず握手ぶん待たされる。
// 検索を返した直後に裏で温めておけば、mediaCache に乗った状態でスクロールが追いつく
let coverWarmGeneration = 0;
const COVER_WARM_CONCURRENCY = 4;

function warmCovers(galleries, { signal } = {}) {
  const generation = (coverWarmGeneration += 1);
  // error 付きは取りに行く先が無い。pweagle:/pwlibf: は手元ファイルだが、
  // 今は 1 頁目を焼くようになったので、焼き上がりを先に済ませておく
  const targets = (galleries || []).filter((gallery) => gallery
    && !gallery.error
    && gallery.id);
  let cursor = 0;
  const worker = async () => {
    // 新しい検索が来たら古い一覧の残りは投げない。飛んでいる分はそのまま終わらせる
    while (cursor < targets.length && generation === coverWarmGeneration && !signal?.aborted) {
      const gallery = targets[cursor];
      cursor += 1;
      try {
        const raw = String(gallery.id);
        if (isPawEagleId(raw)) {
          await pawCoverImage(eagleIdOf(raw));
        } else if (isPawFolderId(raw)) {
          const eagleId = await newestPawEagleId(pawFolderIdOf(raw));
          if (signal?.aborted || generation !== coverWarmGeneration) return;
          if (eagleId) await pawCoverImage(eagleId);
        } else {
          // 札の絵と同じ寸で温める (表紙は big で出している)
          await fetchImage(gallery.id, 0, { size: 'big', signal, priority: 30 });
        }
      } catch {
        // 消えた投稿でも圏外でも先読みは黙って諦める: 検索結果には一切影響させない
      }
    }
  };
  for (let i = 0; i < COVER_WARM_CONCURRENCY; i += 1) worker();
}

function rememberOwnedMeta(galleries) {
  for (const gallery of galleries || []) {
    if (!gallery || gallery.error || !gallery.owned) continue;
    if ((gallery.source || 'hitomi') !== 'hitomi') continue;
    if (catalog.hasGalleryMeta(gallery.id)) continue;
    try {
      if (!catalog.titleMatchesMeta(gallery.id, gallery.title)) continue;
      catalog.storeGalleryMeta(gallery);
    } catch {
      // メタ保存の失敗は検索結果に影響させない
    }
  }
}

// full: 全件を実体に訊く走査 (設定の「再スキャン」)。既定は mtime.json の差分だけ
async function refreshCatalog({ full = false } = {}) {
  const settings = config.load();
  send('catalog', { ...catalog.snapshot(), scanning: true });
  try {
    const snapshot = await catalog.refresh({
      eagleLibrary: settings.eagleLibrary,
      eagleFolders: settings.eagleFolders,
      downloadDir: settings.downloadDir,
      onProgress: (progress) => send('catalog-progress', progress),
      full,
    });
    lastScanError = '';
    lastScanDetail = null;
    // pixiv の台帳を索引と突き合わせる (消えた項目を落とし、手で入れた物を拾う)
    if (pixivLibrary) {
      try { pixivLibrary.reconcile(); } catch { /* 次の走査で */ }
    }
    // Home の作者の一覧は次に引かれた時に裏で組み直す
    if (homeAuthors) homeAuthors.invalidate();
    // scanned: 台帳が組み直された印。renderer は所持作品の一覧を (見ている場所を
    // 動かさずに) 引き直す。済 印の貼り替えだけでは増えた作品が画面に出ない
    send('catalog', { ...snapshot, scanned: true });
    send('library-progress', libraryView());
    return snapshot;
  } catch (error) {
    // 転んでも「走査中」のまま固まらせない (項目 9-1)。以前はここで送る物が
    // 無く、renderer の scanning が立ちっぱなしで再スキャン釦が二度と押せなかった
    lastScanError = trace.codeOf(error);
    // 「激減したので取り込まなかった」は数を添えて出す。理由の分かる唯一の失敗
    lastScanDetail = error && error.code === 'scan-shrank'
      ? { prev: Number(error.prevCount) || 0, kept: Number(error.keptCount) || 0 }
      : null;
    trace.note('catalog', 'scan-failed', { id: lastScanError, count: lastScanDetail ? lastScanDetail.kept : 0 });
    send('catalog', { ...catalog.snapshot(), scanning: false });
    send('library-progress', libraryView());
    throw error;
  }
}

// Eagle の変化の見張り。Eagle は何かを書くたびに <library>/mtime.json を更新するので、
// その stat (SMB でも 3 ms) を時々見るだけで、取り込み・星・タグ・ゴミ箱の変化が分かる。
// 変わっていたら少し待って (連続の取り込み中は落ち着くまで) 差分走査を掛け、後続の
// ジョブ (メタ取得・照合・タグ書き込み) も従来どおり流す。写しの上では見張らない
// (台帳は母艦の sync が差し替える: startMirrorWatch)
const EAGLE_WATCH_INTERVAL = 15 * 1000;
const EAGLE_WATCH_SETTLE = 5 * 1000;
const EAGLE_FULL_SCAN_AFTER_UPTIME = 10 * 60;
function startEagleWatch() {
  if (readOnly) return;
  const stampOf = () => {
    const root = String(config.load().eagleLibrary || '').trim();
    if (!root) return '';
    try {
      const stat = fs.statSync(path.join(root, 'mtime.json'));
      return `${stat.size}:${stat.mtimeMs}`;
    } catch {
      return '';
    }
  };
  let last = stampOf();
  let settle = null;
  const timer = setInterval(() => {
    // 保険の全件走査 (mtime.json が追いつかない稀な更新の取りこぼし用) は一日に一度、
    // 起動から時間が経ってから裏で。起動直後に回すと、その stat の嵐 (SMB) の後ろに
    // 表紙の読みが並んでしまう (実測: 全件走査中は表紙が 1 枚 2.5 秒)
    if (!catalog.scanning && process.uptime() > EAGLE_FULL_SCAN_AFTER_UPTIME) {
      let stale = false;
      try {
        const root = String(config.load().eagleLibrary || '').trim();
        const { FULL_SCAN_INTERVAL } = require('./lib/eagle-index');
        stale = Boolean(root) && Date.now() - catalog.eagleIndex(root).fullScanAt > FULL_SCAN_INTERVAL;
      } catch {
        stale = false;
      }
      if (stale) {
        refreshCatalog({ full: true })
          .then(() => runLibraryJobs())
          .catch(() => {});
        return;
      }
    }
    const current = stampOf();
    if (!current || current === last) return;
    last = current;
    if (settle) clearTimeout(settle);
    settle = setTimeout(() => {
      settle = null;
      if (catalog.scanning) return;
      refreshCatalog()
        .then(() => runLibraryJobs())
        .catch(() => {});
    }, EAGLE_WATCH_SETTLE);
  }, EAGLE_WATCH_INTERVAL);
  if (timer.unref) timer.unref();
}

// 写し (--read-only) 用: 母艦の sync が rename で差し替える catalog.sqlite を
// 見張り、変わっていたら読み直して画面へ押し出す。これで Homecore 側は
// 再起動なしで最新の棚になる。書き手側では動かさない (reloadFromDisk 参照)
const MIRROR_WATCH_INTERVAL = 30 * 1000;
function startMirrorWatch() {
  const dbPath = path.join(app.getPath('userData'), 'catalog.sqlite');
  const statOf = () => {
    try {
      const stat = fs.statSync(dbPath);
      return `${stat.size}:${stat.mtimeMs}`;
    } catch {
      // 差し替えの瞬間は見えないことがある。次の周で拾う
      return null;
    }
  };
  let last = statOf();
  // pixiv の台帳も同期で差し替わる。こちらは軽いので別に見る (台帳の読み直しを起こさない)
  const pixivPath = path.join(app.getPath('userData'), 'pixiv-library.json');
  const pixivStat = () => {
    try {
      const stat = fs.statSync(pixivPath);
      return `${stat.size}:${stat.mtimeMs}`;
    } catch {
      return null;
    }
  };
  let lastPixiv = pixivStat();
  const timer = setInterval(() => {
    const nowPixiv = pixivStat();
    if (nowPixiv && nowPixiv !== lastPixiv && pixivLibrary) {
      lastPixiv = nowPixiv;
      try { pixivLibrary.reload(); pixivLibrary.reconcile(); } catch { /* 次の周で */ }
      if (homeAuthors) homeAuthors.invalidate();
    }
    const current = statOf();
    if (!current || current === last) return;
    // 開けなかった時は last を進めない: 次の周で同じ差分としてもう一度挑む
    if (!catalog.reloadFromDisk()) return;
    last = current;
    if (homeAuthors) homeAuthors.invalidate();
    // mirrorReloaded: 台帳が丸ごと替わった印。renderer は所持作品の一覧を
    // 引き直す (「済」印の貼り替えだけでは増えた作品が画面に出ない)
    send('catalog', { ...catalog.snapshot(), mirrorReloaded: true });
    send('library-progress', libraryView());
  }, MIRROR_WATCH_INTERVAL);
  if (timer.unref) timer.unref();
}

// pixiv の台帳と取り込み (docs/pixiv-design-2026-09-19.md §7)。
// 台帳はどの機体でも読む (写しは同期で届いた物を読むだけ)。取り込みは母艦だけ
function pixivMetaOf(gallery) {
  const artist = (gallery && gallery.artists && gallery.artists[0]) || {};
  return {
    title: gallery.title,
    userId: gallery.userId || artist.userId || '',
    userName: artist.name || '',
    url: gallery.url,
    date: gallery.publishedDate || '',
    pages: gallery.pageCount || 0,
    tags: (gallery.tags || []).map((tag) => tag.name).filter(Boolean),
    ai: gallery.ai === true,
    r18: gallery.r18 === true,
    series: gallery.series || null,
    caption: gallery.caption || '',
  };
}

function initPixiv() {
  const userData = app.getPath('userData');
  pixivLibrary = new PixivLibrary({
    file: path.join(userData, 'pixiv-library.json'),
    indexEntries: () => {
      try {
        const root = String(config.load().eagleLibrary || '').trim();
        if (!root) return null;
        const index = catalog.eagleIndex(root);
        return index ? index.load() : null;
      } catch {
        return null;
      }
    },
    creatorNameOf: (folderId) => {
      try {
        const hit = pawLibrary.creatorFolders().find((folder) => folder.folderId === String(folderId));
        return hit ? hit.name : '';
      } catch {
        return '';
      }
    },
  });
  pixivLibrary.load();
  if (readOnly) return;
  downloader.pixivStaging = path.join(userData, 'pixiv-staging');
  pixivImporter = new PixivImporter({
    library: pixivLibrary,
    eagle: pixivEagle,
    pawLibrary,
    queueFile: path.join(userData, 'pixiv-queue.json'),
    rootFolderId: () => String(config.load().pawEagleFolder || ''),
    onJob: (jobId, patch) => downloader.patchJob(jobId, patch),
  });
  downloader.onImport = (job, gallery) => {
    pixivImporter.enqueue({
      jobId: job.id, pid: parseId(job.id).key, file: job.dest, meta: pixivMetaOf(gallery || {}),
    });
  };
  downloader.onImportRetry = (jobId) => pixivImporter.retry(jobId) || (pawImporter ? pawImporter.retry(jobId) : false);

  // pawchive の取り込みも API で (paw-importer.js)。作者フォルダは paw-library が決め、無ければ作る
  pawImporter = new PawImporter({
    eagle: pixivEagle,
    pawLibrary,
    pawLinks,
    queueFile: path.join(userData, 'paw-queue.json'),
    rootFolderId: () => String(config.load().pawEagleFolder || ''),
    postUrl: (service, user, postId) => require('./lib/sources/pawchive').buildPostUrl(service, user, postId),
    onJob: (jobId, patch) => downloader.patchJob(jobId, patch),
  });
  downloader.onPawImport = (job, gallery, { files }) => {
    const triple = pawLibrary.pawTriple(job.id) || {};
    const artist = (gallery && gallery.artists && gallery.artists[0]) || {};
    pawImporter.enqueue({
      jobId: job.id,
      key: job.pawKey || [triple.service, triple.user, triple.postId].join(':'),
      files,
      meta: {
        service: triple.service, user: triple.user, postId: triple.postId,
        creatorName: artist.label || artist.name || '',
        url: gallery && gallery.url ? gallery.url : '',
        date: gallery && gallery.publishedDate ? gallery.publishedDate : '',
        pages: (gallery && gallery.pageCount) || 0,
      },
    });
  };
  // 出力先に取り残された物 (Eagle の自動インポートに拾われなかった分) を、起動後に全部拾う。
  // 出力先に残っている PDF/zip は「保存したのに Eagle に入っていない物」と決めた (2026-09-26、利用者)
  const sweepTimer = setTimeout(() => {
    try {
      const root = String(config.load().pawBulkDir || '').trim();
      if (root) pawImporter.sweep(root, { maxAgeMs: 0 });
    } catch {
      // 拾えなくても次の起動で
    }
  }, 60 * 1000);
  if (sweepTimer.unref) sweepTimer.unref();
}

// スキャンの後始末は起動時も「更新」も同じ順で流す。多重起動は各 start() の
// ガード(running なら no-op)で無害
async function runLibraryJobs() {
  // 読み取り専用モードでは何も走らせない: メタ取得・照合・Eagle タグ書き込みは
  // どれも母艦 (書き手) 側の仕事で、写しの上で走らせると Eagle に書いてしまう
  if (readOnly) return;
  // 「自動同期」を切っている間は何も走らせない (通信を控えたいとき用)
  if (config.load().autoSync === false) return;
  // 走査中はジョブを起こさない: 対象一覧が「eagle 行の消えた途中の items」から
  // 作られて空振りする。走査を起こした側が完了後にもう一度ここを呼ぶ
  if (catalog.scanning) return;
  // 仕事が終わったら**必ず最後の一報を送る**。進捗の通知は走っている間しか
  // 出ないので、これが無いと画面は「走っている」姿のまま固まる
  // (実際は終わっているのに帯が「0/1」で残り続けていた)
  const settle = (job) => (job ? job.catch(() => {}).then(() => {
    send('library-progress', libraryView());
  }) : Promise.resolve());

  if (backfill) await settle(backfill.start());
  // 照合はタイトル検索で網を投げる重い仕事。ID から引ける分を先に片付けてから
  if (matchJob) settle(matchJob.start());
  if (eagleTagger) settle(eagleTagger.start());
  // 作者名の日本語化 (nhentai 照会)。メタの穴埋め (backfill) が済んでいるほど
  // 対象を正しく絞れるので最後。名義ごとに照会記録が残るため途中終了も無害
  if (creatorLabels) settle(creatorLabels.start());
}

// Homecore への手動同期スクリプト。梱包版では asar の中の .ps1 を powershell に
// 渡せないので、extraResources で resources/scripts に外置きした方を使う
function syncScriptPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'scripts', 'sync-to-homecore.ps1')
    : path.join(__dirname, '..', 'scripts', 'sync-to-homecore.ps1');
}

// 紐付けの増減は台帳・所持数・進捗のすべてに効く。押し出しと書き出しをひとまとめに。
//
// **押し出しが先、書き出しは後。** 逆にしていたので、鎖を外す・ゴミ箱へ送るたびに
// 数 MB の db.export() + fsync (同期) を書き切ってから画面へ知らせていた。
// 利用者から見ると「押してから札が消えるまで待たされる」のはここ。
// 書き出しは返事を送り出した次の回に回す (落ちても before-quit と 2 秒の
// persistSoon が拾う: 取りこぼす窓は元から在ったものより広がらない)
function afterLinkChange() {
  if (homeAuthors) homeAuthors.invalidate();
  send('catalog', catalog.snapshot());
  send('library-progress', libraryView());
  setImmediate(() => {
    try {
      catalog.flushPersist();
    } catch {
      // 書けなくても次の変更でまた出す
    }
  });
}

// 台帳と、それに寄りかかる各ジョブの用意。窓を出したあと裏で走らせる
async function initCatalogJobs() {
  // 写しの上では台帳を書かない。init() の中で版ずれの取り込み・世代バックアップが
  // 走るので、開く前に伝えておく (母艦の sync と同じファイルを rename し合わないため)
  catalog.readOnly = readOnly;
  await catalog.init();
  setCatalog(catalog);
  setLocalContent(localContent);
  backfill = new LibraryBackfill({
    catalog,
    getGallery,
    getNewestId: async () => {
      const result = await search({ query: '', sort: 'added', page: 0, pageSize: 1 });
      const first = (result.galleries || []).find((gallery) => gallery && !gallery.error);
      return first ? Number(first.id) : null;
    },
    onProgress: () => send('library-progress', libraryView()),
  });
  catalog.setBackfill(backfill);
  matchJob = new LibraryMatch({
    catalog,
    priorityOptions: () => {
      const current = config.load();
      return {
        priorityFolders: current.matchPriorityFolders,
        libraryRoot: current.eagleLibrary,
      };
    },
    onProgress: () => send('library-progress', libraryView()),
  });
  catalog.setTitleMatchJob(matchJob);
  eagleTagger = new EagleTagger({
    catalog,
    onProgress: () => send('library-progress', libraryView()),
  });
  catalog.setEagleTagger(eagleTagger);
  creatorLabels = new CreatorLabelJob({
    catalog,
    search: require('./lib/sources/nhentai').search,
  });
  // お気に入り作者リストの引っ越し (外部ツールと共有していた urls.txt → userData)。
  // 台帳の引き継ぎと同じく起動時に一度きり
  try {
    pawFavorites.migrate();
  } catch {
    // 引っ越せなくても、今の置き場のまま読み書きは続けられる
  }
  // pawchive の一括更新。済んだ投稿の台帳は catalog.sqlite に相乗りする。
  // 外部ツール (kemono-dl) の台帳からの引き継ぎは起動時に一度きり
  pawState = new PawState(catalog).init();
  // 発見タブ。表示台帳は catalog.sqlite に相乗り、巡回結果は自前の JSON に持つ
  discovery = new Discovery({
    catalog,
    cachePath: path.join(app.getPath('userData'), 'discovery-cache.json'),
  }).init();
  try {
    pawState.importLegacy();
  } catch {
    // 引き継げなくても、これまでに溜めたぶんで走れる
  }
  pawBulk = new PawBulk({
    state: pawState,
    settings: () => {
      const current = config.load();
      return {
        dir: current.pawBulkDir,
        concurrency: current.pawBulkConcurrency,
      };
    },
    onProgress: (status) => send('paw-bulk-progress', status),
  });
  // 中断していたジョブの復帰は台帳の後で。再開したぶんが完了すると
  // onComplete が catalog に書きに行くので、順を入れ替えられない。
  // 読み取り専用モードでは復帰させない (写しの上でダウンロードを再開しない)
  initPixiv();
  // Home の作者の一覧。材料 (台帳・作者根・pixiv と Pawchive の結び・発見の控え) は借りるだけで、
  // 自前で持つのは hitomi / nhentai の名乗りの結び (creator-links.json) だけ
  creatorLinks = new CreatorLinks({ file: path.join(app.getPath('userData'), 'creator-links.json') });
  pageCounts = new PageCounts({ file: path.join(app.getPath('userData'), 'page-counts.json'), count: (id) => localPageCount(id) });
  homeAuthors = new HomeAuthors({
    catalog,
    pawLibrary,
    pawLinks,
    creatorLinks,
    // 名前に日付の無い所持の本の公開日 (網で見つけた物。書くのは外の道具、ここは読むだけ)
    releaseDates: new ReleaseDates({ file: path.join(app.getPath('userData'), 'release-dates.json') }),
    reading,
    readOnly,
    getPixivLibrary: () => pixivLibrary,
    getDiscovery: () => discovery,
    getPageCounts: () => pageCounts,
    // 作者頁の hitomi の作品は本体の hitomi の検索と同じ道 (控え・同じ語の相乗り) で引く
    searchHitomi: (payload) => search(payload),
    folderTreeFile: () => {
      const root = String(config.load().eagleLibrary || '').trim();
      return root ? path.join(root, 'metadata.json') : '';
    },
    // 作品の検索の当て先 (Eagle の名前・タグ・注釈)。台帳と作者根が共用する走査の控えを借りる (ファイルは開かない)
    eagleEntries: () => {
      const root = catalog.localLibraryRoot();
      return root ? catalog.eagleIndex(root).entries : null;
    },
  });
  if (!readOnly) downloader.init(path.join(app.getPath('userData'), 'jobs.json'));
  if (pixivImporter) pixivImporter.kick();
}

// IPC の口は窓より先に開けておく。台帳を使うものだけが whenCatalog() で待ち合わせる。
// 口の実体は src/main/ipc/ に機能別で置き、ここでは依存 (deps) を束ねて渡すだけ。
// ── 読み取り専用モードの線引き ────────────────────────────────
//
// **基準**: 「この機体の外に残る物を変えるか」で決める。
//   WRITE_CHANNELS = 変える口。写し (readOnly) では断る。
//     - Eagle ライブラリへ書く (星・ゴミ箱・タグ)
//     - 台帳の内容を利用者の指図で変える (紐付け・照合の指示)
//     - 実体を増やす/消す (取り込み・保存)
//     - 母艦にしか意味の無い仕事 (Homecore への同期)
//   READ_ONLY_OK = 変えない口、または「この機体の中だけ」で閉じる口。
//     栞・設定・窓の状態は機体ごとの持ち物なので写しでも書いてよい。
//
// 名簿は**守りの二枚目**。実際に控えを書く所は state-file の番人が止めるので、
// ここを通り抜けた口があっても控えは壊れない。名簿の役目は
// 「断りを利用者に見せる」ことと「新しい口を足す時に分類を迫る」こと。
// 分類の漏れは test/readonly-mode.test.js が落とす
const WRITE_CHANNELS = [
  'download', 'cancel', 'retry-download', 'clear-finished', // 取り込み (実体が増える)
  'library-match', 'library-link', 'library-unlink',        // 棚 (台帳) の編集
  'eagle-trash', 'eagle-star',                              // Eagle への書き込み
  'sync-homecore',                                          // 母艦 (書き手) 専用
];

// 読むだけ、または機体の中だけで閉じる口。写しでも通す
const READ_ONLY_OK = [
  // 引くだけ
  'image-base', 'search', 'search-author-context', 'search-cancel', 'gallery', 'suggest', 'annotate',
  'discovery', 'library-status', 'downloads', 'settings',
  'lan-share', 'lan-qr', 'paw-bulk-status', 'paw-creator-hints', 'paw-candidates',
  'paw-links-call', 'paw-favorites-call', 'open-eagle', 'open-external', 'open-caption-url',
  'reveal', 'reading-get', 'reading-all', 'toggle-fullscreen', 'reader-active',
  'nav-command', 'window-state', 'app-version', 'fallbacks',
  'catalog', 'library-candidates',
  // 場所を選ぶ・開く口。実体は変えない (選んだ結果の保存は save-settings が受ける)
  'choose-folder', 'open-folder', 'show-in-folder',
  // 読み書きが混ざる口。書き込みの枝は各ハンドラの中で塞ぐ
  'paw-favorites', 'paw-links',
  // 機体の中だけ (栞・設定・窓)
  'reading-set', 'save-settings', 'rescan',
  // 読み書きが混ざる口。中の書き込みの枝だけを各ハンドラが塞ぐ
  'paw-bulk', 'paw-cookies', 'eagle-tag-sync', 'pixiv',
  // Home: 作者頁と hitomi の作品は読み、詳細の行の結び (link) だけ中で塞ぐ
  'home',
];

// 登録後に代入される変数 (imageBase / matchJob / pawBulk / lanServer / mainWindow /
// discovery) は値渡しすると undefined を掴むので、getter で遅延して引かせる
const { LanDesktop } = require('./lib/lan-desktop');
const lanDesktop = new LanDesktop({
  getImageBase: async () => { await imageBaseReady; return imageBase; },
});

function registerIpc() {
  const sharedIpc = lanDesktop.registry(ipcMain);
  const deps = {
    ipcMain: sharedIpc,
    // 所持 (pixiv) の PDF から生成情報を埋め戻す材料: 台帳 → Eagle 項目 → PDF → 頁 (JPEG はそのまま / Flate は worker でステルス)
    aiMetaPdfPages: async (pid) => {
      const eagleId = pixivLibrary ? pixivLibrary.eagleIdOf(String(pid)) : null;
      if (!eagleId) return null;
      const folder = pawLibrary.itemFolder(eagleId);
      if (!folder) return null;
      const content = await resolveContentMemo(folder);
      if (!content || content.mode !== 'pdf') return null;
      const file = content.target;
      const total = Math.min(4, Number(await pdfUnpack.pageCount(file)) || 0);
      const pages = [];
      for (let i = 0; i < total; i += 1) {
        const src = await pdfUnpack.pageAiSource(file, i);
        if (!src) continue;
        if (src.kind === 'dct' && !src.bytes && typeof src.unwrap === 'function') src.bytes = await src.unwrap();
        pages.push({ index: i, ...src });
      }
      return { file, pages };
    },
    catalog,
    config,
    downloader,
    pawFavorites,
    pawLibrary,
    pawLinks,
    reading,
    readOnly,
    READ_ONLY_ERROR,
    whenCatalog,
    send,
    settingsView,
    refreshCatalog,
    runLibraryJobs,
    afterLinkChange,
    pawCreatorHints,
    warmCovers,
    rememberOwnedMeta,
    localPageCount,
    getPageCounts: () => pageCounts,
    libraryView,
    syncScriptPath,
    getImageBase: () => imageBase,
    getImageBaseReady: () => imageBaseReady,
    getDiscovery: () => discovery,
    decorateJobs,
    getMatchJob: () => matchJob,
    getPawBulk: () => pawBulk,
    getPawImporter: () => pawImporter,
    getLanServer: () => lanServer,
    getMainWindow: () => mainWindow,
    getPixivLibrary: () => pixivLibrary,
    getPixivImporter: () => pixivImporter,
    getHomeAuthors: () => homeAuthors,
    openPixivLogin,
  };
  registerSearchIpc(deps);
  registerLibraryIpc(deps);
  registerDownloadIpc(deps);
  registerPawIpc(deps);
  registerSettingsIpc(deps);
  registerLanIpc(deps);
  const pixivIpc = registerPixivIpc(deps);
  registerHomeIpc(deps);
  // 取り込みで綴じる前の原寸 (pixiv の AI 作品) から生成情報を表へ。網も時間も要らない (バイトは手元にある)
  if (pixivIpc && pixivIpc.aiMetaStore && !readOnly) {
    setPageBytesHook((job, gallery, index, buffer) => {
      const parsed = parseId(job.id);
      if (parsed.source !== 'pixiv' || !gallery || gallery.ai !== true) return;
      const pid = String(parsed.key);
      if (pixivIpc.aiMetaStore.metaOf(pid, index)) return;
      aiMetaService.analyze(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer))
        .then((found) => pixivIpc.aiMetaStore.put({ pid, page: index, status: found ? 'ok' : 'none', source: 'import', meta: found }))
        .catch(() => {});
    });
  }
  // --- 読み取り専用モードの締め --------------------------------------
  // 書き込みに当たる口を一括で塞ぐ。個別の if を散らさず、登録し終えた
  // ハンドラをここで断りの応答に差し替える。paw-favorites / paw-links /
  // paw-bulk のような読み書き混在の口だけは、各ハンドラの中で書き込みの枝を塞いである
  if (readOnly) {
    for (const channel of WRITE_CHANNELS) {
      sharedIpc.removeHandler(channel);
      sharedIpc.handle(channel, async () => {
        throw new Error(READ_ONLY_ERROR);
      });
    }
  }
}

// 起動の本体。ここで投げると窓も知らせも出ないまま黙って終わるので、
// 受けを一つ被せて「何で起きられなかったか」を必ず出す (項目 9-5)。
// 置き場を作れない・台帳を開けない・ポートが全部塞がっている、のような
// 起きる前の失敗がここに来る
function bootMain() {
  // NSIS のショートカットが持つ AppUserModelID (= appId) と合わせる。
  // これが無いと Windows が窓とショートカットを別アプリ扱いして、
  // タスクバーのアイコンが既定の Electron のものに化ける
  if (process.platform === 'win32') app.setAppUserModelId('com.bunko.app');
  const settings = config.load();
  // クッキーの置き場をまず整える。設定には外部ツール (kemono-dl) の作業場を指す
  // 旧既定や、区切りの落ちた壊れた値が残っていることがある: userData の下へ寄せる
  let pawCookieFile = settings.pawCookieFile;
  // 写しの上 (読み取り専用) では設定も Downloads も動かさない: 引っ越しは
  // config を書き替え、引き上げは利用者のファイルを移す — どちらも書き手の仕事。
  // 読むだけの setCookieFile は下でどちらの機体でも通す (無認証だと数枚で 403)
  if (!readOnly) {
    try {
      pawCookieFile = pawCookies.migrate({
        stored: settings.pawCookieFile,
        defaultFile: config.defaultPawCookieFile(),
        save: (file) => config.save({ pawCookieFile: file }),
      }).file;
    } catch {
      // 引っ越せなくても、今の置き場のまま読み書きは続けられる
    }
    // 置き場が決まってから、Downloads に落ちている書き出し済みクッキーを引き上げる。
    // 順が逆だと引っ越す前の場所に置いてしまう (旧 launcher の cookie_move.py の役目)
    try {
      // 落ちる先は Electron に訊く。homedir\Downloads の決め打ちだと、
      // 保存先を移している機体では黙って空振りする
      pawCookies.adoptDownloadedCookies({
        downloadsDir: app.getPath('downloads'),
        cookieFile: pawCookieFile,
      });
    } catch {
      // 取り込めなくても、これまでのクッキーで走る
    }
  }
  // pawchive は無認証だと数枚で 403 になる: 素性を先に持たせる
  pawCookies.setCookieFile(pawCookieFile);
  // pawchive の取り込みは外部エンジン (kemono-dl) の子プロセスに任せる。
  // 同梱物の置き場 (梱包版は resources/ に外置き) を知っているのは electron を
  // 見る kemono-paths だけなので、起動時にここで一度だけ差し込む
  const kemono = kemonoPaths();
  kemonoEngine.init({
    command: kemono.python,
    baseArgs: ['-B', kemono.script],
    workDir: kemonoWorkDir(),
  });
  downloader.setLimits({
    concurrency: settings.concurrency,
    maxGalleries: settings.maxGalleries,
  });
  downloader.setRoute(pawSaveRoute);
  // 置き場の名前は 'cache' にしない: Electron (Chromium) の HTTP キャッシュが同じ
  // userData の 'Cache' に居て、Windows では同じフォルダになる。Chromium は起動時に
  // その中の自分の物 (Cache_Data) 以外を掃除するので、表紙・頁・焼いた頁が起動の
  // たびに全部消えていた (2026-09-05 実測: 目印ファイルが起動で消え、本番の cache/img
  // 2,001 件は全て当日の起動時刻以降の作成)。別名なら Chromium は触らない
  mediaCache.init(path.join(app.getPath('userData'), 'media-cache'));
  // 失敗の落ち先。既定値へ黙って落ちる catch の行き先で、拾われなかった例外もここへ集まる。
  // 記録に入るのは不透明な id と数だけ (作品名は口の形として通らない)
  trace.init(path.join(app.getPath('userData'), 'logs'));
  trace.install();
  // 画像サーバは待たずに起こす。ポートが要るのは image-base の口だけ
  imageBaseReady = startImageServer()
    .then((base) => {
      imageBase = base;
      return base;
    })
    .catch((error) => {
      console.error('image server failed', error);
      return '';
    });

  lanServer = new LanServer({
    desktop: lanDesktop,
    catalog,
    reading,
    settings: () => config.load(),
    saveSettings: (partial) => config.save(partial),
  });

  // 口を開けてから窓を出す。台帳の用意はそのあと裏で
  registerIpc();
  createWindow();

  // ここで受けておく: 初期化がこけても待ち合わせは解け、db 無しのまま動く
  catalogReady = initCatalogJobs().catch((error) => console.error('catalog init failed', error));
  // 写しの上では母艦からの差し替えを見張る。台帳が開いてから
  if (readOnly) catalogReady.then(() => startMirrorWatch());
  catalogReady
    // 写しの上では起動時走査をしない: ミラーの catalog.sqlite が棚の真実で、
    // 走査は最後に persist で書き戻す (メディアが見えない起動だと空で上書きしうる)
    .then(() => (readOnly ? null : refreshCatalog()))
    .then(() => {
      // Eagle 走査 (paw 側) の温め。裏で並列に組むので main は止まらない。
      // refreshCatalog の後に回すのは、走査同士で D: の帯域を取り合わないため
      pawLibrary.warm().catch(() => { /* ライブラリが読めなくても起動は続ける */ });
      startEagleWatch();
      // Home の作者の一覧を先に組んでおく (最初に Home を開いた時に待たせない)。
      // 起動直後の走査や表紙の読みと重ねないよう、少し置いてから裏で
      const homeWarm = setTimeout(() => {
        if (homeAuthors) homeAuthors.warm().catch(() => {});
      }, 5000);
      if (homeWarm.unref) homeWarm.unref();
      // 焼き場 (所持作品の PDF の頁・paw の表紙・LAN の頁) の窓を先に立てておく。
      // 最初の一冊で窓の用意に 1 秒待たされるのを、棚が出た後の裏で済ませる
      setTimeout(() => pageBaker.prepare().catch(() => {}), 3000);
    })
    .catch((error) => console.error('catalog scan failed', error))
    .then(() => runLibraryJobs())
    .catch(() => {})
    .then(() => {
      // 前回開けたままにしていたら開け直す。台帳が読めるようになってから
      if (!lanServer || config.load().lanShare !== true) return null;
      // 画面へは押し出さない: 設定を開いたときに lan-share の口で引き直される
      return lanServer.start().then((status) => {
        if (!status.running) {
          // 起動時の配信の失敗が黙って落ちていた (項目 9-8)。印を立てて帯に出す
          console.error('lan share failed', status.error);
          trace.note('lan', 'lan-listen-failed', { id: 'start' });
          trace.flag('lan-failed');
          send('library-progress', libraryView());
        } else {
          trace.flag('lan-failed', false);
        }
        return status;
      });
    })
    .catch((error) => {
      console.error('lan share failed', error);
      trace.note('lan', 'lan-listen-failed', { id: trace.codeOf(error) });
      trace.flag('lan-failed');
      send('library-progress', libraryView());
    });
}

app.whenReady().then(() => {
  try {
    bootMain();
  } catch (error) {
    trace.note('boot', 'uncaught', { id: trace.codeOf(error) });
    // 記録に残すだけでは利用者に届かない。窓が出ていないのだから画面にも出せない
    try {
      dialog.showErrorBox(
        'BUNKO を起動できませんでした',
        `${(error && error.message) || error}

`
        + `記録: ${app.getPath('userData')}\logs
`
        + '同じことが続くときは、この置き場の config.json を退けてから起こしてください。',
      );
    } catch {
      // ダイアログすら出せない機体では記録だけが頼り
    }
    throw error;
  }
});

// 「まだ通っている古い道」を数える口。落としてよいかを憶測でなく実測で決める。
// 記録に残るのは道の名前と回数だけ (項目 8-1)
ipcMain.on('note-fallback', (_event, code) => {
  const name = String(code || '').slice(0, 40);
  if (!/^[a-z0-9-]+$/.test(name)) return;
  trace.note('reader', 'unpack-fallback', { id: name, count: 1 });
});

app.on('before-quit', () => {
  // どの終了経路 (トレイの「終了」・更新・OS からの停止) でも × の畳みを
  // 通さない。preventDefault が効いてしまうと、いつまでも終われなくなる
  quitting = true;
  // 窓を閉じても口が開いたままにならないように、真っ先に畳む
  if (lanServer) lanServer.stop().catch(() => {});
  pdfUnpack.close().catch(() => {});
  if (backfill) backfill.stop();
  if (matchJob) matchJob.stop();
  if (eagleTagger) eagleTagger.stop();
  // 一括更新と、それが起こしている外部エンジンの子も畳む。親だけ消えると
  // python が残って同じ staging に書き続け、次の起動の走りと実体を壊し合う
  try { if (pawBulk) pawBulk.stop(); } catch { /* 畳めなくても終了は進める */ }
  try { kemonoEngine.killActive(); } catch { /* もう死んでいる */ }
  catalog.flushPersist();
  reading.flush();
  trace.close().catch(() => {});
});

app.on('window-all-closed', () => {
  // トレイに畳む設定なら、窓が一つも無くなっても終わらせない
  // (LAN 配信と裏の仕事はそのまま続く)
  if (trayCloseMinutes() > 0) return;
  if (process.platform !== 'darwin') app.quit();
});

// 二人目の起動が来たら先客が前に出る。トレイに畳んでいれば窓を出し、
// 畳んだまま窓を捨てた後 (trayCloseMinutes 経過) なら建て直す。
// 最小化しているだけの窓は戻してやらないと前に来ない
app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isMinimized()) mainWindow.restore();
  showFromTray();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
