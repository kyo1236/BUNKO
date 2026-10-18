'use strict';

// 同じ Wi-Fi の中の端末に、所持作品を読ませるための小さなサーバ。
//
// 既存の画像サーバ (main.js の startImageServer) を外へ向けないのは、あれが
// 「自分自身からしか繋がらない」前提で組まれているから: 鍵が無く、CORS が全開で、
// hitomi へ画像を取りに行く口まで開いている。外に出すとそこが踏み台になる。
// こちらは別の口として立て、全ての経路で合言葉を要る形にする

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const QRCode = require('qrcode');

const localArchive = require('./local-archive');
const pawLibrary = require('./paw-library');
const { suggestAliases } = require('./search-aliases');
const mediaCache = require('./media-cache');
const pageBaker = require('./page-baker');
const pdfUnpack = require('./pdf-unpack');
const { renderPdfPage } = require('./pdf-page');
const { imageSize, imageType } = require('./image-size');
const { hiraToKata } = require('./search-text');
const { isPrivateAddress, lanAddresses, tailscaleAddresses, hostAllowed } = require('./lan-net');
// LAN の本 ID (pw_ / pwf_) の組み立て・判定は sources/ids に集約してある
const {
  lanPawId, lanPawEagleIdOf, lanPawFolderId, isLanPawFolderId, lanPawFolderIdOf,
  pawEagleGalleryId, isPawEagleId, eagleIdOf,
  LAN_BOOK_ID_PART, LAN_COVER_ID_PART,
} = require('./sources/ids');

const COOKIE_NAME = 'bunko_lan';
const TOKEN_BYTES = 16;
const MAX_FAILS = 5;
const LOCKOUT_MS = 30 * 1000;
const BODY_LIMIT = 8 * 1024;
const LIST_SIZE = 30;
// 台帳引きと readdir を頁ごとに繰り返さないための憶え書き。
// 中身の差し替えには追随しないが、立て直せば消える
const BOOK_MEMO_MAX = 200;
// 一覧の実在確認 (existsSync+readdirSync) の憶え書き。1 頁で 30 冊ぶん走るので books より広く
const CONTENT_MEMO_MAX = 600;
// 「無い」と見えた本を憶えておく時間。共有が数秒詰まっただけの回を
// 永久の不在として焼き付けないための短い窓 (項目 9-9)
const MISSING_TTL = 30 * 1000;
// 立てた時に先へ焼いておく読みかけの冊数と、1 冊あたりの頁数
const WARM_BOOKS = 3;
const WARM_PAGES = 24;
// PDF から直に抜いた頁 (jpeg) の品質。焼き場の jpeg (0.82) と同じ見た目で、荷は 1080px で 200KB 台
const LAN_DIRECT_QUALITY = 0.82;
// 裏の用意の札。机上版 (desk:) と分けて、互いの用意を消し合わないようにする
const LAN_TAG = 'lan:';
const WARM_DELAY_MS = 5 * 1000;
// 表紙は一覧に並ぶだけ。原寸で配らず、札の大きさまで落とす
const COVER_WIDTH = 720;
// 一覧の並び。ここに無い指定は既定 (追加日) に落とす。
// reread / finished は栞 (reading.json) が決める並び (再読の棚)
const LIST_SORTS = new Set(['added', 'published', 'title', 'star', 'random', 'reread', 'finished']);
// 栞が決める並び。要約 (reading-store の summary) を作るのはこの二つのときだけでよい
const READING_SORTS = new Set(['reread', 'finished']);

// 栞由来の並び (再読の棚) の比較器。paw の棚は台帳を通らないので、机上版
// (paw-library.js の同名関数) と同じ考え方をこちらにも書く。同着の解け方だけ
// LAN の流儀 (最後に開いた順 → 題名順) に合わせてある。知らない並びなら null
function readingComparator(sort, marks) {
  if (!READING_SORTS.has(sort)) return null;
  const table = marks && typeof marks === 'object' ? marks : {};
  const mark = (item) => table[pawEagleGalleryId(item.eagleId)] || null;
  const count = (item) => Number(mark(item) && mark(item).finishedCount) || 0;
  const finishedAt = (item) => Number(mark(item) && mark(item).finishedAt) || 0;
  const updatedAt = (item) => Number(mark(item) && mark(item).updatedAt) || 0;
  // 回数を積み始めたばかりで全部 0 のうちは、実質「最後に開いた順」に落ちる
  const rest = (a, b) => updatedAt(b) - updatedAt(a)
    || String(a.title).localeCompare(String(b.title), 'ja');
  if (sort === 'finished') {
    // 読み終えていない本は 0 なので自然に末尾へ落ちる
    return (a, b) => finishedAt(b) - finishedAt(a) || count(b) - count(a) || rest(a, b);
  }
  return (a, b) => count(b) - count(a) || finishedAt(b) - finishedAt(a) || rest(a, b);
}

// random 用の順位付け。同じ seed なら同じ並び (頁をまたいでも揺れない)
function seededRank(seed, key) {
  let h = (seed >>> 0) || 1;
  const text = String(key);
  for (let i = 0; i < text.length; i += 1) {
    h = Math.imul(h ^ text.charCodeAt(i), 2654435761);
    h ^= h >>> 15;
  }
  return h >>> 0;
}

// 一覧系ハンドラ共通の絞り・並びの読み取り (不正値は既定へ落とす)
function listOptions(url) {
  const sortRaw = String(url.searchParams.get('sort') || '');
  return {
    sort: LIST_SORTS.has(sortRaw) ? sortRaw : 'added',
    dir: url.searchParams.get('dir') === 'asc' ? 'asc' : 'desc',
    minStar: Math.max(0, Math.min(5, Math.floor(Number(url.searchParams.get('minStar'))) || 0)),
    seed: Math.max(0, Math.floor(Number(url.searchParams.get('seed'))) || 0),
  };
}
// 「最近読んだ」の窓。目印 (折った角) と同じ 24 時間
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const RECENT_MAX = 8;

// 画面の部品はファイルで配る (inline を許さずに済む)。配るのはこの表に載せた物だけ
const LAN_DIR = path.join(__dirname, '..', 'lan');
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
// ホーム画面に据えた時の顔。滅多に変わらないので持たせ切ってよい。
// public: 合言葉の前に配る — iOS はホーム画面に追加する時、この絵だけを
// Safari とは別の口で取りに来る (据えた後の札も QR の ?k= も付かない)。
// 401 を返すと iOS は顔を諦めて題 (文匣) の一文字目で札を描く。
// 出どころの検め (私的な発信元・Host) は先に済んでいるので、
// ここで外に出るのは導入版に同梱してある絵そのものだけ
const ICON = {
  file: path.join(__dirname, '..', '..', 'assets', 'icon-256.png'),
  type: 'image/png',
  cache: 'private, max-age=604800',
  public: true,
};
const STATIC_FILES = new Map([
  ['/reader.css', { file: path.join(LAN_DIR, 'reader.css'), type: 'text/css; charset=utf-8' }],
  ['/shelf.js', { file: path.join(LAN_DIR, 'shelf.js'), type: 'text/javascript; charset=utf-8' }],
  ['/read.js', { file: path.join(LAN_DIR, 'read.js'), type: 'text/javascript; charset=utf-8' }],
  // 書体は机上版の分割 woff2 をそのまま配る。unicode-range 分割なので、
  // 端末には画面に出た字の分しか落ちていかない
  ['/fonts.css', { file: path.join(RENDERER_DIR, 'fonts.css'), type: 'text/css; charset=utf-8' }],
  ['/icon.png', ICON],
  // 札が読めなかった時に iOS が素で叩きに来る名。同じ絵を同じ口から返す
  ['/apple-touch-icon.png', ICON],
  ['/apple-touch-icon-precomposed.png', ICON],
]);

// 画面の骨組み。静的部品と同じ mtime 判定のキャッシュに載せるため、同じ形の札にしておく
const READER_HTML = { file: path.join(LAN_DIR, 'reader.html'), type: 'text/html; charset=utf-8' };

// 外の資源を一切引かない画面なので、既定を全部閉じてから自分の分だけ開ける。
// 部品は全部ファイル配信にしたので inline も許さない
const CSP = "default-src 'none'; img-src 'self'; style-src 'self'; "
  + "script-src 'self'; font-src 'self'; connect-src 'self'; "
  + "base-uri 'none'; form-action 'none'";

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  // CORS は付けない。同じ出所の中で完結するので要らないし、付けると上の守りが無になる
};

function makeToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

// 長さで漏らさないため、突き合わせは常に同じ時間で終わらせる
function sameToken(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return '';
    }
  }
  return '';
}

// 端末が読める形で焼く。webp を言わない端末 (古い Safari) には jpeg を返す
// 配る頁は jpeg に固定する。webp は一頁の符号化に 8 倍かかり (1080px で 150 ms 対 20 ms)、
// 荷が 2 割軽くなるだけで LAN では効かない。PDF から直に抜いた頁も jpeg なので形が揃う
function formatFor() {
  return 'jpeg';
}

// 【一時】端末から届いた計測を読める形で出す (2026-08-20)。
// 期待値: 60Hz なら 900ms に約 54 コマ、コマの間隔は 16.7ms。
// 400ms の遷移が正しく描かれていれば、紙の縦ずれが段階的に 0 へ近づく
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// 台帳が指す道のりから、実際に読める中身を取り出す。
// 所持作品のほとんどは Eagle の <id>.info フォルダで、その中に原本 (ほぼ PDF) と
// <名前>_thumbnail.png が並んでいる。zip / 画像フォルダで持っている分もあるので、
// どちらの形でも同じ返り値に均す
// 所持作品の実体の判定 (画像フォルダ / PDF / zip と、隣のサムネイル) は机上の表紙・読書
// (main.js) と共用: local-content.js に置き、ここは従来の名前で使う
const { resolveContent } = require('./local-content');

// pawchive の所持作品は別台帳 (paw-library)。LAN では id を pw_<eagleId> の
// 名前空間で分けて、同じ口 (一冊・表紙・頁・栞) をそのまま通す。
// id の組み立て・剥がしは sources/ids の lanPaw* を使う

// 栞 (reading.json) の鍵だけは机上と共有する。同じ本を机上で読みかけ、続きを
// 端末で開けるように、LAN の pw_<eagleId> は書く前に机上の顔 (pweagle:<eagleId>)
// へ戻す。hitomi の素の数字はどちらの世界でも同じ鍵なのでそのまま
function readingKeyOf(id) {
  const eagleId = lanPawEagleIdOf(id);
  return eagleId ? pawEagleGalleryId(eagleId) : String(id);
}

// 逆向き: reading.json の鍵を LAN の本 id へ戻す
function lanIdOfReadingKey(key) {
  return isPawEagleId(key) ? lanPawId(eagleIdOf(key)) : key;
}

// 口 (URL) が受ける id の顔。断片 (sources/ids) から一度だけ組む
const READING_ID_RE = new RegExp(`^/api/reading/(${LAN_BOOK_ID_PART})$`);
const BOOK_ID_RE = new RegExp(`^/api/book/(${LAN_BOOK_ID_PART})$`);
const COVER_ID_RE = new RegExp(`^/api/book/(${LAN_COVER_ID_PART})/cover$`);
const PAGE_ID_RE = new RegExp(`^/api/book/(${LAN_BOOK_ID_PART})/page/(\\d{1,5})$`);

// 作者フォルダの札。id は pwf_<folderId> — 表紙の口だけがこの id を解し、
// 一冊としては開けない (中身は folder: の絞りで並べる)
function pawFolderCard(folder) {
  return {
    id: lanPawFolderId(folder.folderId),
    folder: folder.folderId,
    title: folder.name || String(folder.folderId),
    star: 0,
    type: '',
    artists: [],
    groups: [],
    series: [],
    characters: [],
    tags: [],
    pageCount: 0,
    addedDate: null,
    publishedDate: null,
  };
}

// paw の札。素性は作者一人だけ (pawchive の投稿に hitomi 式のタグは無い)。
// 作者名は元から日本語なので label にもそのまま入れる
function pawCard(item) {
  const creator = item.creator || '';
  return {
    id: lanPawId(item.eagleId),
    title: item.title || item.name || String(item.eagleId),
    star: Number(item.star) || 0,
    // 源泉の印 (作者根には pawchive と pixiv の本が同居する)。紙の facts に一行出す
    source: item.source || 'pawchive',
    type: '',
    // 作者の値には潜り先を持たせる: 紙で作者を突いたら、字面検索ではなく
    // その作者のフォルダへ落ちる (同名の作者でも外さない — 机上版と同じ考え方)
    artists: creator
      ? [{
        name: creator,
        label: creator,
        token: item.creatorFolderId ? `folder:${item.creatorFolderId}` : '',
      }]
      : [],
    groups: [],
    series: [],
    characters: [],
    tags: [],
    pageCount: Number(item.pageCount) || 0,
    addedDate: item.date || null,
    publishedDate: item.date || null,
  };
}

// 素性の一枠。name は索引の鍵 (ローマ字。絞りのトークンはこちらで組む)、
// label は日本語札 (tag_labels の四層)。表示は label、道具は name — 混ぜない
function tagFaces(list) {
  return (list || [])
    .filter((tag) => tag && tag.name)
    .map((tag) => ({ name: tag.name, label: tag.label || '' }));
}

// 一覧と「最近読んだ」で配る札の形。一冊の紙 (bottom sheet) は端末側で
// この中身だけから組めるようにしてある — 紙を開くたびに母艦へ訊きに来させない
function bookCard(gallery) {
  return {
    // 未照合の Eagle アイテムは台帳が机上の顔 (pweagle:<eagleId>) で返す。口 (URL) は
    // ':' を受けないので、paw の本と同じ pw_<eagleId> に揃えてから出す
    // (hitomi の数字と、既に pw_ の id はそのまま)
    id: lanIdOfReadingKey(String(gallery.id)),
    title: gallery.title || String(gallery.id),
    star: Number(gallery.star) || 0,
    source: gallery.source || 'hitomi',
    type: gallery.type || '',
    artists: tagFaces(gallery.artists),
    groups: tagFaces(gallery.groups),
    series: tagFaces(gallery.series),
    characters: tagFaces(gallery.characters),
    tags: (gallery.tags || [])
      .filter((tag) => tag && tag.name)
      .map((tag) => ({ name: tag.name, type: tag.type || 'tag', label: tag.label || '' })),
    // 台帳の頁数。読む枠を決めるのには使わない (実際の枚数は /api/book が言う)
    pageCount: Number(gallery.pageCount) || 0,
    addedDate: gallery.addedDate || null,
    publishedDate: gallery.publishedDate || null,
  };
}

class LanServer {
  constructor({ catalog, reading, settings, saveSettings, desktop }) {
    this.desktop = desktop;
    this.catalog = catalog;
    this.reading = reading;
    this.settings = settings;
    this.saveSettings = saveSettings;
    this.server = null;
    this.address = '';
    this.port = 0;
    this.token = '';
    this.fails = new Map();
    this.lastError = '';
    this.qr = '';
    // Tailscale の口 (あれば)。家の外からは tailnet 越しにこちらへ入る
    this.tsServer = null;
    this.tsAddress = '';
    this.tsQr = '';
    this.books = new Map();   // id → 解いた本。頁ごとに台帳を引き直さないため
    this.contents = new Map(); // 一覧の実在確認の控え (在る本だけ。null は焼き付けない)
    // 「無い」と見えた本と、そう見えた時刻。共有の詰まりを永久の不在にしない
    this.missing = new Map();
    this.statics = new Map();  // 静的部品の中身 (mtime+size で読み直しを判定)
    this.warmTag = '';        // 今どの本の続きを裏で用意しているか (取り下げの札)
    this.warmBookId = '';     // その本の id (札を解かずに見分けるため)
    this.warmTimer = null;
  }

  status() {
    return {
      running: Boolean(this.server),
      address: this.address,
      port: this.port,
      // 合言葉は QR に載せるので画面には渡す。外へ出るのはこの窓の中だけ
      token: this.server ? this.token : '',
      // keep はホーム画面に据えたときのため (据えた URL がそのまま毎回の入場券になる)
      url: this.server ? `http://${this.address}:${this.port}/?k=${this.token}&keep=1` : '',
      qr: this.server ? this.qr : '',
      // 外から (tailnet 越し) の入り口。母艦に Tailscale が居るときだけ
      tailscale: this.tsServer ? {
        address: this.tsAddress,
        url: `http://${this.tsAddress}:${this.port}/?k=${this.token}&keep=1`,
        qr: this.tsQr,
      } : null,
      candidates: lanAddresses(),
      error: this.lastError,
    };
  }

  // 合言葉は一度作ったら使い回す。端末に配った QR が毎回死ぬのを避ける
  ensureToken() {
    const current = this.settings();
    if (current.lanToken && /^[0-9a-f]{32}$/.test(current.lanToken)) {
      this.token = current.lanToken;
      return this.token;
    }
    this.token = makeToken();
    this.saveSettings({ lanToken: this.token });
    return this.token;
  }

  async start(preferredAddress = '') {
    if (this.server) return this.status();
    this.lastError = '';
    const available = lanAddresses();
    if (!available.length) {
      this.lastError = 'LAN のアドレスが見つかりません (Wi-Fi / 有線に繋がっていますか)';
      return this.status();
    }
    const picked = available.find((nic) => nic.address === preferredAddress) || available[0];
    const settings = this.settings();
    const port = Number(settings.lanPort) || 18766;
    this.ensureToken();

    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        this.send(res, 500, 'text/plain; charset=utf-8', String(error && error.message ? error.message : error));
      });
    });
    // 落ちてきた接続を握ったままにしない。端末が寝るたびに溜まる
    server.keepAliveTimeout = 10 * 1000;
    server.headersTimeout = 15 * 1000;

    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, picked.address, () => {
          server.removeAllListeners('error');
          resolve();
        });
      });
    } catch (error) {
      this.lastError = error && error.code === 'EADDRINUSE'
        ? `ポート ${port} は既に使われています`
        : String(error && error.message ? error.message : error);
      return this.status();
    }

    this.server = server;
    this.address = picked.address;
    this.port = server.address().port;

    // Tailscale が居れば、同じ扉をその口にも開ける (外から読むための道)。
    // 開けられなくても LAN 側はそのまま生きる
    const ts = tailscaleAddresses()[0];
    if (ts && ts.address !== this.address) {
      const second = http.createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, 'text/plain; charset=utf-8', String(error && error.message ? error.message : error));
        });
      });
      second.keepAliveTimeout = 10 * 1000;
      second.headersTimeout = 15 * 1000;
      try {
        await new Promise((resolve, reject) => {
          second.once('error', reject);
          second.listen(this.port, ts.address, () => {
            second.removeAllListeners('error');
            resolve();
          });
        });
        this.tsServer = second;
        this.tsAddress = ts.address;
        try {
          this.tsQr = await QRCode.toDataURL(
            `http://${ts.address}:${this.port}/?k=${this.token}&keep=1`,
            { margin: 2, width: 320, errorCorrectionLevel: 'M' }
          );
        } catch {
          this.tsQr = '';
        }
      } catch {
        // Tailscale の口が開けなくても LAN は使える。黙って諦める
        try { second.close(); } catch { /* 開いてもいない */ }
        this.tsServer = null;
        this.tsAddress = '';
        this.tsQr = '';
      }
    }

    this.fails.clear();
    this.books.clear();
    this.contents.clear();
    this.missing.clear();
    this.warmTag = '';
    this.warmBookId = '';
    // 読みかけの続きを先に焼いておく。立ち上がりの邪魔をしないよう少し置いてから
    clearTimeout(this.warmTimer);
    this.warmTimer = setTimeout(() => {
      this.warmTimer = null;
      this.warmReading().catch(() => { /* 焼けなくても読める */ });
    }, WARM_DELAY_MS);
    // 合言葉つきのアドレスは手で打てる長さではない。QR にして端末のカメラに渡す。
    // 作るのは立てたときの一度だけ (中身が変わるのは立て直したときだけ)
    try {
      this.qr = await QRCode.toDataURL(
        `http://${this.address}:${this.port}/?k=${this.token}&keep=1`,
        { margin: 2, width: 320, errorCorrectionLevel: 'M' }
      );
    } catch {
      // QR が作れなくても、アドレスの文字列は画面に出ている
      this.qr = '';
    }
    return this.status();
  }

  async stop() {
    const server = this.server;
    this.server = null;
    this.address = '';
    this.port = 0;
    this.qr = '';
    const ts = this.tsServer;
    this.tsServer = null;
    this.tsAddress = '';
    this.tsQr = '';
    if (ts) {
      await new Promise((resolve) => {
        ts.close(() => resolve());
        ts.closeAllConnections?.();
      });
    }
    clearTimeout(this.warmTimer);
    this.warmTimer = null;
    this.warmTag = '';
    this.warmBookId = '';
    this.books.clear();
    this.contents.clear();
    this.missing.clear();
    // 誰も読まないのに焼き続けない。隠し窓も畳んで PDF ごと手放す
    pageBaker.dropBackgroundExcept(LAN_TAG, '');
    pdfUnpack.dropBackgroundExcept(LAN_TAG, '');
    pageBaker.close().catch(() => { /* 畳めなくても待たせない */ });
    if (!server) return this.status();
    await new Promise((resolve) => {
      server.close(() => resolve());
      // 繋ぎっぱなしの端末が居ると close は返らない。掴んでいる分は切る
      server.closeAllConnections?.();
    });
    return this.status();
  }

  // --- 入り口 -------------------------------------------------------------

  lockedOut(ip) {
    const record = this.fails.get(ip);
    if (!record) return false;
    if (Date.now() >= record.until) {
      this.fails.delete(ip);
      return false;
    }
    return record.count >= MAX_FAILS;
  }

  retryAfter(ip) {
    const record = this.fails.get(ip);
    return record ? Math.max(1, Math.ceil((record.until - Date.now()) / 1000)) : 1;
  }

  noteFail(ip, cookie = '') {
    const record = this.fails.get(ip) || { count: 0, until: 0 };
    if (cookie) {
      const cookieHash = crypto.createHash('sha256').update(cookie).digest('hex');
      if (record.lastCookieHash === cookieHash) return;
      record.lastCookieHash = cookieHash;
    }
    record.count += 1;
    record.until = Date.now() + LOCKOUT_MS;
    this.fails.set(ip, record);
  }

  send(res, status, type, body, extra = {}) {
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    res.writeHead(status, {
      ...BASE_HEADERS,
      'Content-Type': type,
      'Content-Length': buffer.length,
      ...extra,
    });
    if (res.req && res.req.method === 'HEAD') {
      res.end();
      return;
    }
    res.end(buffer);
  }

  sendJson(res, status, value) {
    this.send(res, status, 'application/json; charset=utf-8', JSON.stringify(value), {
      'Cache-Control': 'no-store',
    });
  }

  async handle(req, res) {
    const remote = req.socket.remoteAddress;
    const ip = String(remote || '');

    // 1. 素性の検め。ここを通らないものは何も見せない
    if (!isPrivateAddress(ip)) {
      this.send(res, 403, 'text/plain; charset=utf-8', 'forbidden');
      return;
    }
    if (!hostAllowed(req.headers.host, [this.address, this.tsAddress].filter(Boolean), this.port)) {
      this.send(res, 403, 'text/plain; charset=utf-8', 'bad host');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'PUT') {
      this.send(res, 405, 'text/plain; charset=utf-8', 'method not allowed');
      return;
    }
    const url = new URL(req.url, `http://${this.address}:${this.port}`);

    // 2. 合言葉の前に出してよい物 (ホーム画面の顔だけ)。
    // 合言葉を名乗らずに来るのが当たり前の要求なので、締め出しの回数にも数えない
    const open = STATIC_FILES.get(url.pathname);
    if (open && open.public) {
      this.serveStatic(res, open, url.searchParams.has('v'));
      return;
    }

    // 3. 合言葉。正しい札・QR は締め出し中でも先に通し、端末が自力で復帰できるようにする
    const fromCookie = readCookie(req.headers.cookie, COOKIE_NAME);
    const fromQuery = url.searchParams.get('k') || '';
    const cookieValid = sameToken(fromCookie, this.token);
    const queryValid = sameToken(fromQuery, this.token);
    if (!cookieValid && !queryValid) {
      if (fromCookie) {
        // 期限切れの札を Safari が送り続けても、同じ値を総当たりとして重複計上しない
        res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
      }
      if (this.lockedOut(ip)) {
        this.serveLocked(res, url, this.retryAfter(ip));
        return;
      }
      if (fromQuery) {
        // URL の明示的な合言葉は、同じ値の再試行でも一回ずつ数える
        this.noteFail(ip);
      } else if (fromCookie) {
        this.noteFail(ip, fromCookie);
      }
      this.serveNeedsKey(res, url);
      return;
    }

    this.fails.delete(ip);
    if (!cookieValid && queryValid) {
      const cookie = `${COOKIE_NAME}=${this.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${60 * 60 * 24 * 30}`;
      if (!url.searchParams.get('keep')) {
        // URL に合言葉を残すと履歴や共有で漏れる。札に移して裸の URL へ送り直す
        url.searchParams.delete('k');
        this.send(res, 302, 'text/plain; charset=utf-8', '', {
          Location: `${url.pathname}${url.search}`,
          'Set-Cookie': cookie,
          'Cache-Control': 'no-store',
        });
        return;
      }
      // 据え置き (ホーム画面) の入り口は剥がさない: iOS のホーム画面アプリは Safari と
      // 札の置き場が別なので、剥がした URL を据えると次の起動で合言葉が無くなる。
      // keep 付きは毎回ここを通って札を貼り直す — 期限が切れても独りでに治る。
      // QR で配る URL にだけ keep が付き、履歴に残るのは自分の端末の中だけ
      res.setHeader('Set-Cookie', cookie);
    }

    // 4. 行き先
    if (this.desktop && await this.desktop.route(this, req, res, url)) return;
    if (url.pathname === '/' || url.pathname === '/index.html') {
      this.serveHtml(res);
      return;
    }
    if (STATIC_FILES.has(url.pathname)) {
      // ?v= (版) 付きで来た要求だけ持たせ切りにする。URL の版が変われば別物として引き直される
      this.serveStatic(res, STATIC_FILES.get(url.pathname), url.searchParams.has('v'));
      return;
    }
    const fontHit = url.pathname.match(/^\/fonts\/([\w-]+\.woff2)$/);
    if (fontHit) {
      this.serveFont(res, fontHit[1]);
      return;
    }
    if (url.pathname === '/api/books') {
      await this.serveList(res, url);
      return;
    }
    if (url.pathname === '/api/recent') {
      this.serveRecent(res);
      return;
    }
    if (url.pathname === '/api/suggest') {
      const term = String(url.searchParams.get('q') || '').slice(0, 80);
      let items = [];
      if (url.searchParams.get('src') === 'paw') {
        // pawchive の候補は作者フォルダの名 (元から日本語)。語は空白を _ に畳んで返す
        // (検索欄は空白で語を切るので、名前が割れないように)
        await pawLibrary.ready();
        items = this.pawSuggest(term);
      } else {
        // 台帳の作家 (日本語札・かな読み) は catalog が search-aliases に
        // 動的な出どころとして差してあるので、ここは訊くだけ
        try {
          // 机上版と同じ飾り (日本語名・種類・所属作品) を通す。
          // 手のひら版は棚と読み手だけなので、行き先は hitomi の語のまま
          const { decorate, forSite } = require('./search-decorate');
          const { loadData } = require('./search-aliases');
          // hitomi に無い語 (pixiv 専用の VTuber) は手のひら版にも出さない。
          // 手のひらは hitomi の語で引くので、出しても 0 件になる
          items = suggestAliases(term, 8)
            .filter((item) => forSite(loadData().byValue.get(item.value) || item, 'hitomi'))
            .map((item) => {
            const row = decorate(item, 'hitomi');
            return {
              value: row.value || item.value,
              type: row.type,
              name: row.name,
              label: row.label || '',
              secondary: row.secondary || '',
            };
          });
        } catch {
          items = [];
        }
      }
      this.sendJson(res, 200, { items });
      return;
    }
    if (url.pathname === '/api/reading') {
      this.sendJson(res, 200, this.readingAll());
      return;
    }
    // 本の id は二世界: hitomi の数字と、pawchive の pw_<eagleId> (英数)。
    // どちらも同じ口を通る (openBook が id の顔で振り分ける)
    const readingHit = url.pathname.match(READING_ID_RE);
    if (readingHit) {
      await this.serveReadingPut(req, res, readingHit[1]);
      return;
    }
    const bookHit = url.pathname.match(BOOK_ID_RE);
    if (bookHit) {
      await this.serveBook(res, bookHit[1]);
      return;
    }
    const coverHit = url.pathname.match(COVER_ID_RE);
    if (coverHit) {
      await this.serveCover(req, res, coverHit[1]);
      return;
    }
    const pageHit = url.pathname.match(PAGE_ID_RE);
    if (pageHit) {
      await this.servePage(req, res, url, pageHit[1], Number(pageHit[2]));
      return;
    }
    this.send(res, 404, 'text/plain; charset=utf-8', 'not found');
  }

  // --- 行き先ごとの中身 ---------------------------------------------------

  // 合言葉が無い・切れているときの顔。画面 (/) を求められたら道筋を言う頁を返す。
  // 据え置いた入り口が期限切れになった人が最初に見るのはここ
  serveNeedsKey(res, url) {
    if (url.pathname !== '/' && url.pathname !== '/index.html') {
      this.send(res, 401, 'text/plain; charset=utf-8', '合言葉が要ります');
      return;
    }
    const html = '<!doctype html><html lang="ja"><head><meta charset="utf-8">'
      + '<meta name="viewport" content="width=device-width, initial-scale=1">'
      + '<title>文匣</title><style>'
      + 'body{margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;'
      + 'background:#0c1016;color:#efe8d8;font:15px/1.9 "Hiragino Sans",sans-serif;text-align:center;padding:32px}'
      + 'b{color:#c9a227;font-weight:600}p{margin:6px 0;color:#8a93a3}h1{font-size:17px;margin:0 0 10px}'
      + '</style></head><body><div><h1>文匣</h1>'
      + '<p>この端末の<b>合言葉</b>が無いか、切れています。</p>'
      + '<p>母艦の設定「端末で読む」の QR を、もう一度読み込んでください。</p>'
      + '</div></body></html>';
    this.send(res, 401, 'text/html; charset=utf-8', html, {
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      'Cache-Control': 'no-store',
    });
  }

  serveLocked(res, url, retryAfter) {
    const seconds = Math.max(1, Number(retryAfter) || 1);
    const extra = {
      'Retry-After': String(seconds),
      'Cache-Control': 'no-store',
    };
    if (url.pathname !== '/' && url.pathname !== '/index.html') {
      this.send(res, 429, 'text/plain; charset=utf-8', 'too many attempts', extra);
      return;
    }
    const html = '<!doctype html><html lang="ja"><head><meta charset="utf-8">'
      + '<meta name="viewport" content="width=device-width, initial-scale=1">'
      + '<title>文匣</title><style>'
      + 'body{margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;'
      + 'background:#0c1016;color:#efe8d8;font:15px/1.9 "Hiragino Sans",sans-serif;text-align:center;padding:32px}'
      + 'b{color:#c9a227;font-weight:600}p{margin:6px 0;color:#8a93a3}h1{font-size:17px;margin:0 0 10px}'
      + '</style></head><body><div><h1>文匣</h1>'
      + '<p>認証を確認できませんでした。</p>'
      + '<p>PC 側の設定「端末で読む」の最新 QR を読み直してください。</p>'
      + `<p>誤った合言葉の再試行は残り <b>${seconds} 秒</b>後です。</p>`
      + '</div></body></html>';
    this.send(res, 429, 'text/html; charset=utf-8', html, {
      ...extra,
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    });
  }

  serveHtml(res) {
    const cached = this.readStatic(READER_HTML);
    if (!cached) {
      this.send(res, 500, 'text/plain; charset=utf-8', '画面が読めません');
      return;
    }
    // 静的部品の参照を版 (mtime) 付きに書き換える。部品は immutable で端末に
    // 持たせ切り、部品を差し替えたらこの版が変わって別 URL として引き直される
    let html = cached.bytes.toString('utf8');
    for (const [pathname, entry] of STATIC_FILES) {
      const part = this.readStatic(entry);
      if (!part) continue;
      html = html.split(`"${pathname}"`).join(`"${pathname}?v=${part.version}"`);
    }
    this.send(res, 200, 'text/html; charset=utf-8', html, {
      'Content-Security-Policy': CSP,
      'Cache-Control': 'no-store',
    });
  }

  // 台帳の所持作品のうち、実体を辿れるものだけ返す。
  // 頁を 1 枚配るたびに台帳引きと readdir をやり直すと、めくるのが遅くなる: 一度解いたら憶える
  resolveBook(id) {
    const key = String(id);
    if (this.books.has(key)) {
      const hit = this.books.get(key);
      // 使ったものを新しい側へ回す (Map は入れた順に並ぶ)
      this.books.delete(key);
      this.books.set(key, hit);
      return hit;
    }
    const book = this.openBook(key);
    this.books.set(key, book);
    while (this.books.size > BOOK_MEMO_MAX) {
      this.books.delete(this.books.keys().next().value);
    }
    return book;
  }

  // 一覧の実在確認の控え。1 頁で 30 冊ぶんの existsSync+readdirSync を毎回やり直さない。
  // books と同じ意味論: 差し替えには追随しないが、立て直せば消える。
  // null (実体なし) も控える — 無い本を頁を繰るたびに確かめ直さないため
  memoContent(key, probe) {
    if (this.contents.has(key)) {
      const hit = this.contents.get(key);
      // 使ったものを新しい側へ回す (Map は入れた順に並ぶ)
      this.contents.delete(key);
      this.contents.set(key, hit);
      return hit;
    }
    let value = null;
    try {
      value = probe();
    } catch {
      value = null;
    }
    // **「無い」は短く、「在る」は長く憶える** (項目 9-9)。
    // 共有 (SMB) が数秒詰まっただけでも probe は null を返すので、それを
    // 立て直すまで焼き付けると、その瞬間に一覧を引いた本 (最大 240 冊) が
    // 電話の棚から消えたまま戻らなくなる。無いと見えた本は少し待って訊き直す
    if (value === null) {
      this.missing.set(key, Date.now());
      return null;
    }
    this.missing.delete(key);
    this.contents.set(key, value);
    while (this.contents.size > CONTENT_MEMO_MAX) {
      this.contents.delete(this.contents.keys().next().value);
    }
    return value;
  }

  // 「無い」と見えた本を訊き直してよいか。詰まりと本当の不在を分ける
  missingIsFresh(key) {
    const at = this.missing.get(key);
    if (!at) return false;
    if (Date.now() - at < MISSING_TTL) return true;
    this.missing.delete(key);
    return false;
  }

  openBook(id) {
    const eagleId = lanPawEagleIdOf(id);
    if (eagleId) return this.openPawBook(eagleId);
    const meta = this.catalog.getGalleryMeta(id);
    if (!meta) return null;
    const file = this.catalog.findLocal(String(id), meta.title);
    if (!file) return null;
    const content = resolveContent(file);
    if (!content) return null;
    // 実体の更新時刻。焼いた頁の鍵に混ぜて、差し替えられた本の古い頁を掴み続けないようにする
    let stamp = 0;
    try {
      stamp = Math.round(fs.statSync(content.target).mtimeMs) || 0;
    } catch {
      stamp = 0;
    }
    return { meta, file, stamp, pageCount: 0, ...content };
  }

  // pawchive の台帳から一冊を起こす。実体の解決は hitomi 側と同じ道
  // (.info の中の PDF を拾う) なので、resolveContent に .info ごと渡す
  openPawBook(eagleId) {
    let original = null;
    try {
      original = pawLibrary.originalPath(eagleId);
    } catch {
      original = null;
    }
    if (!original) return null;
    const dir = path.dirname(original);
    const content = resolveContent(dir);
    if (!content) return null;
    const item = this.pawItems().find((row) => row.eagleId === eagleId);
    const meta = item ? pawCard(item) : this.eagleItemCard(eagleId);
    let stamp = 0;
    try {
      stamp = Math.round(fs.statSync(content.target).mtimeMs) || 0;
    } catch {
      stamp = 0;
    }
    return { meta, file: dir, stamp, pageCount: 0, ...content };
  }

  // paw の台帳に無い Eagle アイテム (作者フォルダに居ない、hitomi 等にも紐付かない
  // 手持ちの本) の札。台帳の疑似ギャラリー (未照合) から起こし、一覧と同じ顔にする。
  // 台帳が口を持たない時 (偽台帳のテスト等) や台帳にも無い時だけ id を題にした札
  eagleItemCard(eagleId) {
    let gallery = null;
    if (typeof this.catalog.eagleItemGallery === 'function') {
      try {
        gallery = this.catalog.eagleItemGallery(eagleId);
      } catch {
        gallery = null;
      }
    }
    if (gallery) return bookCard(this.withLabels(gallery));
    return { id: lanPawId(eagleId), title: eagleId, artists: [] };
  }

  // paw の作者候補。作者フォルダ名がそのまま日本語なので、含み一致で足りる。
  // ひら⇄カタ だけは畳む (漢字の読みは素材が無いので引けない — hitomi 側とは違う)
  pawSuggest(term) {
    const squash = (text) => hiraToKata(String(text || '').normalize('NFKC'))
      .toLowerCase()
      .replace(/[\s_]+/g, '');
    const needle = squash(term);
    if (!needle) return [];
    let folders = [];
    try {
      folders = pawLibrary.creatorFolders() || [];
    } catch {
      folders = [];
    }
    return folders
      .filter((folder) => folder && folder.name && squash(folder.name).includes(needle))
      .slice(0, 8)
      .map((folder) => ({
        // 選んだらその作者の棚へ入る語。名前の字面ではなくフォルダを名指す
        // (同名の作者が居ても外さない)
        value: 'folder:' + folder.folderId,
        type: 'artist',
        name: folder.name,
        label: folder.name,
      }));
  }

  // paw の一覧の種。走査の使い回しは paw-library の snapshot が見ている
  pawItems() {
    try {
      return pawLibrary.snapshot().items || [];
    } catch {
      return [];
    }
  }

  // 未照合の Eagle アイテムを棚に混ぜるか。机上版 (search-ipc.js) と同じ条件で
  // 設定 (showUnmatchedEagle) を読む: 既定は混ぜる
  showUnmatched() {
    let settings = null;
    try {
      settings = this.settings() || {};
    } catch {
      settings = {};
    }
    return settings.showUnmatchedEagle !== false;
  }

  // 一覧に並べてよいか = 手元に実体があるか。判定は一冊を開くときと同じ道を通す:
  // 未照合の Eagle アイテム (pweagle:) は .info の中の原本 (openPawBook と同じ道)、
  // 紐付いた本は台帳の findLocal → resolveContent。前者を findLocal に通すと題での
  // 救済に頼ることになり、短い題は落ち、同じ題の別の本に化ける
  hasContent(gallery) {
    const eagleId = eagleIdOf(gallery.id);
    if (eagleId) {
      return Boolean(this.memoContent(`paw:${eagleId}`, () => pawLibrary.originalPath(eagleId)));
    }
    const file = this.catalog.findLocal(String(gallery.id), gallery.title);
    return Boolean(file && this.memoContent(file, () => resolveContent(file)));
  }

  async serveList(res, url) {
    if (url.searchParams.get('src') === 'paw') {
      await pawLibrary.ready();
      this.servePawList(res, url);
      return;
    }
    const page = Math.max(0, Number(url.searchParams.get('page')) || 0);
    const query = String(url.searchParams.get('q') || '').slice(0, 200);
    const { sort, dir, minStar, seed } = listOptions(url);
    const type = String(url.searchParams.get('type') || '').slice(0, 40);
    const result = this.catalog.searchLibrary({
      query, page, pageSize: LIST_SIZE, sort, type,
      sortDir: dir, minStar, seed,
      // 再読の棚の並びは台帳に無い値で決まる。栞の要約を添えて渡す
      reading: READING_SORTS.has(sort) ? this.readingSummary() : null,
      // hitomi 等に紐付かない手持ちの Eagle アイテム (買った本を PDF にして入れた物など)
      // も混ぜる。渡さないと台帳は紐付いた本しか返さず、電話からは一冊も見えない。
      // 混ぜるかは机上版 (search-ipc) と同じ設定が決める
      includeUnmatched: this.showUnmatched(),
    });
    const items = [];
    for (const gallery of result.galleries || []) {
      if (!gallery) continue;
      // 開けないものは並べない。判定は一冊を開くときと同じ道を通す
      if (!this.hasContent(gallery)) continue;
      items.push(bookCard(this.withLabels(gallery)));
    }
    const total = Number(result.total) || 0;
    this.sendJson(res, 200, {
      items,
      page,
      // 手元に無いものを外したので items が空でも続きがあり得る。続きの有無は総数で決める
      hasMore: (page + 1) * LIST_SIZE < total,
      total,
    });
  }

  // pawchive の棚。机上版と同じ二段: 語も絞りも無ければ**作者ごと**に分かれ、
  // 作者を突く (folder: の語が入る) とその作者の作品が並ぶ
  servePawList(res, url) {
    const page = Math.max(0, Number(url.searchParams.get('page')) || 0);
    const query = String(url.searchParams.get('q') || '').slice(0, 200);
    const { sort, dir, minStar, seed } = listOptions(url);

    if (!query.trim()) {
      this.servePawFolders(res, page, { sort, dir, minStar, seed });
      return;
    }

    // folder:<id> は作者の棚。机上版の paw-library.search と同じ言い方
    const folderHit = query.trim().match(/^folder:([A-Za-z0-9_-]+)$/);
    const folderId = folderHit ? folderHit[1] : '';

    // 候補が入れる語は空白を _ に畳んである。突き合わせは畳んだ同士で。
    // ひら→カタ も畳む (机上の matchKey・候補の pawSuggest と同じ扱い)
    const squash = (text) => hiraToKata(String(text || '').normalize('NFKC'))
      .toLowerCase()
      .replace(/[\s_]+/g, '');
    const tokens = folderId ? [] : query.split(/\s+/).map(squash).filter(Boolean);

    let rows = this.pawItems();
    if (folderId) {
      rows = rows.filter((item) => item.creatorFolderId === folderId);
    }
    if (tokens.length) {
      rows = rows.filter((item) => {
        const hay = squash(item.title) + ' ' + squash(item.creator) + ' ' + squash(item.name);
        return tokens.every((token) => hay.includes(token));
      });
    }

    if (minStar) {
      rows = rows.filter((item) => (item.star || 0) >= minStar);
    }

    rows = rows.slice();
    const byReading = READING_SORTS.has(sort)
      ? readingComparator(sort, this.readingSummary())
      : null;
    if (byReading) {
      rows.sort(byReading);
    } else if (sort === 'random') {
      rows.sort((a, b) => seededRank(seed, a.eagleId || a.title) - seededRank(seed, b.eagleId || b.title));
    } else if (sort === 'title') {
      rows.sort((a, b) => String(a.title).localeCompare(String(b.title), 'ja'));
    } else if (sort === 'star') {
      rows.sort((a, b) => (b.star || 0) - (a.star || 0)
        || String(b.date || '').localeCompare(String(a.date || ''))
        || String(a.title).localeCompare(String(b.title), 'ja'));
    } else {
      // added も published も paw では投稿日。日付の無いものは後ろ、同点は題名順
      rows.sort((a, b) => {
        if ((a.date || '') !== (b.date || '')) {
          if (!a.date) return 1;
          if (!b.date) return -1;
          return a.date < b.date ? 1 : -1;
        }
        return String(a.title).localeCompare(String(b.title), 'ja');
      });
    }
    // 向きは並び全体を裏返す (同点の解決も含めて。catalog の asc と同じ考え方)
    if (dir === 'asc' && sort !== 'random') rows.reverse();

    const total = rows.length;
    const slice = rows.slice(page * LIST_SIZE, page * LIST_SIZE + LIST_SIZE);
    const items = [];
    for (const item of slice) {
      // 実体の無い行は並べない (hitomi 側の一覧と同じ検め)。
      // 鍵は file の道のりと混ざらないよう paw: を被せる
      const original = this.memoContent(`paw:${item.eagleId}`, () => pawLibrary.originalPath(item.eagleId));
      if (!original) continue;
      items.push(pawCard(item));
    }
    // 作者の棚なら、見出しに出す名を添える (folder:<id> は人が読める字ではない)
    let folderName = '';
    if (folderId) {
      try {
        const hit = (pawLibrary.creatorFolders() || []).find((f) => f && f.folderId === folderId);
        folderName = hit ? String(hit.name || '') : '';
      } catch {
        folderName = '';
      }
    }
    this.sendJson(res, 200, {
      items,
      page,
      hasMore: (page + 1) * LIST_SIZE < total,
      total,
      folderName,
    });
  }

  // 作者ごとの棚 (paw の入り口)。札の表紙はその作者の一番新しい作品のサムネイル
  servePawFolders(res, page, { sort = 'added', dir = 'desc', minStar = 0, seed = 0 } = {}) {
    let folders = [];
    try {
      folders = (pawLibrary.creatorFolders() || []).filter((f) => f && f.folderId);
    } catch {
      folders = [];
    }
    // 一番新しい作品の日付で作者を並べる (机上版の既定と同じ)。題名なら名の順
    const newest = new Map();
    // ★絞りのときは「★minStar 以上の作品を一つでも持つ作者」だけを並べる
    const starred = new Set();
    for (const item of this.pawItems()) {
      if (!item.creatorFolderId) continue;
      const now = newest.get(item.creatorFolderId) || '';
      if ((item.date || '') > now) newest.set(item.creatorFolderId, item.date || '');
      if (minStar && (item.star || 0) >= minStar) starred.add(item.creatorFolderId);
    }
    folders = folders.slice();
    if (minStar) {
      folders = folders.filter((f) => starred.has(f.folderId));
    }
    if (sort === 'random') {
      folders.sort((a, b) => seededRank(seed, a.folderId) - seededRank(seed, b.folderId));
    } else if (sort === 'title') {
      folders.sort((a, b) => String(a.name).localeCompare(String(b.name), 'ja'));
    } else {
      folders.sort((a, b) => {
        const x = newest.get(a.folderId) || '';
        const y = newest.get(b.folderId) || '';
        if (x !== y) return x < y ? 1 : -1;
        return String(a.name).localeCompare(String(b.name), 'ja');
      });
    }
    if (dir === 'asc' && sort !== 'random') folders.reverse();
    const total = folders.length;
    const slice = folders.slice(page * LIST_SIZE, page * LIST_SIZE + LIST_SIZE);
    this.sendJson(res, 200, {
      items: slice.map(pawFolderCard),
      page,
      hasMore: (page + 1) * LIST_SIZE < total,
      total,
      folderName: '',
    });
  }

  // 栞を一冊ぶん引く。新しい鍵 (pweagle:) に無ければ、昔 pw_ で書いた栞を見る
  readingMark(id) {
    const key = readingKeyOf(id);
    const hit = this.reading.get(key);
    if (hit || key === String(id)) return hit;
    return this.reading.get(String(id));
  }

  // 再読の棚 (reread / finished) が見る栞の要約。鍵は机上と同じ顔のまま
  // (hitomi は素の数字、paw は pweagle:<eagleId>) 渡す
  readingSummary() {
    if (typeof this.reading.summary !== 'function') return {};
    return this.reading.summary() || {};
  }

  // 栞の全体を LAN の本 id で引き直したもの。pweagle: の鍵は pw_ に戻し、
  // 昔の pw_ の栞も同じ鍵へ並ぶ (両方あるときは新しい鍵の方を採る)
  readingAll() {
    const source = this.reading.all() || {};
    const out = {};
    for (const [key, mark] of Object.entries(source)) {
      if (!isPawEagleId(key)) out[key] = mark;
    }
    for (const [key, mark] of Object.entries(source)) {
      if (isPawEagleId(key)) out[lanIdOfReadingKey(key)] = mark;
    }
    return out;
  }

  // 24 時間以内に読んだ本。棚の「最近読んだ」横帯と折った角の窓は同じ 24 時間
  serveRecent(res) {
    const now = Date.now();
    const marks = Object.entries(this.readingAll())
      .filter(([, mark]) => mark && now - (Number(mark.updatedAt) || 0) <= RECENT_WINDOW_MS)
      .sort((a, b) => (Number(b[1].updatedAt) || 0) - (Number(a[1].updatedAt) || 0));
    const items = [];
    for (const [id, mark] of marks) {
      if (items.length >= RECENT_MAX) break;
      const book = this.resolveBook(id);
      if (!book) continue;
      let star = 0;
      if (lanPawEagleIdOf(id)) {
        star = Number(book.meta.star) || 0;   // paw の星は札に既に載っている
      } else {
        try {
          star = Number(this.catalog.findStar(id, book.meta.title)) || 0;
        } catch {
          star = 0;
        }
      }
      items.push({ ...bookCard(this.withLabels({ ...book.meta, star })), mark });
    }
    this.sendJson(res, 200, { items });
  }

  // 机上版と同じ日本語札 (tag_labels) をタグと素性に付ける。
  // 台帳が口を持たない時 (偽台帳のテスト等) は素のまま返す
  withLabels(gallery) {
    if (typeof this.catalog.withTagLabels !== 'function') return gallery;
    try {
      return this.catalog.withTagLabels(gallery);
    } catch {
      return gallery;
    }
  }

  // 静的部品の中身と版。配るたびの readFileSync をやめ、stat だけで済ませる。
  // mtime+size が控えと違えば読み直すので、開発中に部品を編集しても追随する
  readStatic(entry) {
    let stat = null;
    try {
      stat = fs.statSync(entry.file);
    } catch {
      return null;
    }
    const hit = this.statics.get(entry.file);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit;
    let bytes = null;
    try {
      bytes = fs.readFileSync(entry.file);
    } catch {
      return null;
    }
    const made = {
      bytes,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      version: Math.round(stat.mtimeMs).toString(36),
    };
    this.statics.set(entry.file, made);
    return made;
  }

  serveStatic(res, entry, versioned = false) {
    const cached = this.readStatic(entry);
    if (!cached) {
      this.send(res, 404, 'text/plain; charset=utf-8', 'not found');
      return;
    }
    // 版付き (serveHtml が書き換えた URL) は持たせ切る。版なしは古い画面からの
    // 要求かもしれないので、従来どおり毎回配る
    const cache = versioned ? 'private, max-age=31536000, immutable' : (entry.cache || 'no-store');
    this.send(res, 200, entry.type, cached.bytes, { 'Cache-Control': cache });
  }

  serveFont(res, name) {
    // 名前は経路の正規表現で既に絞ってあるが、道のりの組み立ては basename でもう一段守る
    const file = path.join(RENDERER_DIR, 'fonts', path.basename(name));
    let bytes = null;
    try {
      bytes = fs.readFileSync(file);
    } catch {
      bytes = null;
    }
    if (!bytes) {
      this.send(res, 404, 'text/plain; charset=utf-8', 'not found');
      return;
    }
    // 書体の分割は中身が変わらない。端末に持たせ切る
    this.send(res, 200, 'font/woff2', bytes, {
      'Cache-Control': 'private, max-age=604800, immutable',
    });
  }

  async serveBook(res, id) {
    const book = this.resolveBook(id);
    if (!book) {
      this.sendJson(res, 404, { error: 'not found' });
      return;
    }
    // これから読む本と違う本を裏で焼いていたら、そこで止める。
    // 焼き場が抱えられる PDF は 1 冊だけなので、放っておくと本体の読み直しで往復する
    if (this.warmBookId && this.warmBookId !== String(id)) {
      pageBaker.dropBackgroundExcept(LAN_TAG, '');
      pdfUnpack.dropBackgroundExcept(LAN_TAG, '');
      this.warmTag = '';
      this.warmBookId = '';
    }
    const shape = await this.bookShape(book);
    if (!shape.pageCount) {
      this.sendJson(res, 404, { error: 'no pages' });
      return;
    }
    this.sendJson(res, 200, {
      id: String(id),
      title: book.meta.title || String(id),
      artists: (book.meta.artists || []).map((tag) => tag.name),
      pageCount: shape.pageCount,
      // 焼いた頁は端末に持たせ切る (immutable)。実体が差し替わったら別の頁として
      // 引き直させたいので、頁の URL にこの版を混ぜてもらう
      version: book.stamp,
      // 縦送りの枠を先に決めるのに要る。描いてから伸び縮みすると読んでいる場所が飛ぶ
      ratios: shape.ratios,
      reading: this.readingMark(String(id)),
      // 継ぎ目の「次の作品/前の作品」は端末側が棚の並びから引く (机上版と同じ)。
      // 母艦は隣を知らなくてよい
    });
  }

  // 台帳の頁数は当てにしない: 実際に手元にある枚数で読ませる
  async bookShape(book) {
    if (book.pageCount) return { pageCount: book.pageCount, ratios: book.ratios || [] };
    if (book.mode === 'pdf') {
      // 頁数と縦横比は綴じ方 (MediaBox) から引ける。読めない本だけ隠し窓で数える
      let shape = null;
      try {
        shape = await pdfUnpack.pageShapes(book.target);
      } catch {
        shape = null;
      }
      if (!shape || !shape.pageCount) {
        try {
          shape = await pageBaker.shape(book.target);
        } catch {
          shape = null;
        }
      }
      book.pageCount = (shape && Number(shape.pageCount)) || 0;
      book.ratios = (shape && shape.ratios) || [];
      return { pageCount: book.pageCount, ratios: book.ratios };
    }
    let count = 0;
    try {
      count = await localArchive.pageCount(book.target);
    } catch {
      count = 0;
    }
    book.pageCount = count;
    book.ratios = [];
    // 画像本の縦横比は 1 頁目だけ見る (全頁を測るには zip を丸ごと開くことになる)。
    // 頁ごとに寸法が違う本は、枠の中で上下に余白が出るだけ
    if (count) {
      try {
        const first = await localArchive.readPage(book.target, 0);
        const size = first && imageSize(first.bytes);
        if (size) book.ratios = [Math.round((size.width / size.height) * 1000) / 1000];
      } catch {
        // 測れなければ既定の縦横比で並べる
      }
    }
    return { pageCount: count, ratios: book.ratios };
  }

  // 一覧の表紙。Eagle が原本の隣に作ったサムネイルがあればそれを使う
  // (PDF の 1 頁目を出すには本体を開くしかなく、一覧では高くつく)
  async serveCover(req, res, id) {
    // 作者フォルダの札 (pwf_): 表紙はその作者の一番新しい作品。作品の札と同じく
    // 1 頁目を焼いた方が質が良いので、その作品の id に読み替えて同じ道を通す。
    // 読み替えられないときだけ従来のサムネイル配りに落ちる
    if (isLanPawFolderId(id)) {
      const folderId = lanPawFolderIdOf(id);
      let newest = null;
      try {
        for (const item of this.pawItems()) {
          if (item.creatorFolderId !== folderId) continue;
          if (!newest || (item.date || '') > (newest.date || '')) newest = item;
        }
      } catch {
        newest = null;
      }
      if (newest && newest.eagleId) {
        const book = this.resolveBook(lanPawId(newest.eagleId));
        if (book && book.mode === 'images') {
          let page = null;
          try {
            page = await this.pageBytes(book, 0, COVER_WIDTH, formatFor(req));
          } catch {
            page = null;
          }
          if (page) {
            this.send(res, 200, page.type, page.bytes, { 'Cache-Control': 'private, max-age=86400' });
            return;
          }
        }
      }
      let file = null;
      try {
        file = pawLibrary.folderCoverPath(folderId);
      } catch {
        file = null;
      }
      let bytes = null;
      if (file) {
        try {
          bytes = fs.readFileSync(file);
        } catch {
          bytes = null;
        }
      }
      if (bytes) {
        this.send(res, 200, imageType(bytes) || 'application/octet-stream', bytes, {
          'Cache-Control': 'private, max-age=86400',
        });
      } else {
        this.send(res, 404, 'text/plain; charset=utf-8', 'no cover');
      }
      return;
    }
    const book = this.resolveBook(id);
    if (!book) {
      this.send(res, 404, 'text/plain; charset=utf-8', 'not found');
      return;
    }
    // 画像本の表紙は 1 頁目を札の大きさ (COVER_WIDTH) に落として出す。Eagle の
    // サムネイルは小さく、Retina の格子ではぼやける。焼いた表紙は mediaCache に
    // 残るので、二度目からはサムネイルを配るのと同じ速さ。
    // PDF はここでは開かない (一覧を繰るたびに本体を読み直すことになる) —
    // 従来どおりサムネイルに任せる
    if (book.mode === 'images') {
      let page = null;
      try {
        page = await this.pageBytes(book, 0, COVER_WIDTH, formatFor(req));
      } catch {
        page = null;
      }
      if (page) {
        this.send(res, 200, page.type, page.bytes, { 'Cache-Control': 'private, max-age=86400' });
        return;
      }
    }
    if (book.cover) {
      let bytes = null;
      try {
        bytes = fs.readFileSync(book.cover);
      } catch {
        bytes = null;
      }
      if (bytes) {
        // 名前ではなく中身で名乗る。Eagle のサムネイルは .png でも中身は WebP で、
        // 拡張子を信じると nosniff を付けているこの口では絵が出ない
        this.send(res, 200, imageType(bytes) || 'application/octet-stream', bytes, {
          'Cache-Control': 'private, max-age=86400',
        });
        return;
      }
    }
    this.send(res, 404, 'text/plain; charset=utf-8', 'no cover');
  }

  async servePage(req, res, url, id, index) {
    const book = this.resolveBook(id);
    if (!book) {
      this.send(res, 404, 'text/plain; charset=utf-8', 'not found');
      return;
    }
    const width = pageBaker.snapWidth(url.searchParams.get('w'));
    const format = formatFor(req);
    this.notePageStyle(width, format);
    let page = null;
    try {
      page = await this.pageBytes(book, index, width, format);
    } catch {
      page = null;
    }
    if (!page) {
      this.send(res, 404, 'text/plain; charset=utf-8', 'no page');
      return;
    }
    this.send(res, 200, page.type, page.bytes, {
      // 焼いた頁は二度と変わらない (幅も形式も鍵に入っている)。端末に持たせ切る。
      // 共有物ではないので private
      'Cache-Control': 'private, max-age=31536000, immutable',
    });
    this.warmBook(id, book, index, width, format);
  }

  // 焼いた頁は円盤に残す (容量の面倒は media-cache が見る)。二度目からは出すだけ
  pageBytes(book, index, width, format, options = {}) {
    if (!Number.isInteger(index) || index < 0) return Promise.resolve(null);
    const key = `lanpage:${book.stamp}:${book.target}:${index}:${width}:${format}:v3`;
    if (book.mode === 'pdf') {
      // 三段 (直抜き → 取り下げの再試行 → 焼き場) は pdf-page が持つ。
      // 机上版と同じ一本を通す: 片方だけ直して出方が食い違わないように (項目 8-2)
      return mediaCache.getImage(key, () => renderPdfPage(
        book.target,
        index,
        { width, quality: LAN_DIRECT_QUALITY },
        { background: options.background, tag: options.tag },
        { width, format, options },
      ));
    }
    return this.fitPage(book, index, width, format, key, options);
  }

  // zip / 画像フォルダの本。原本が画面より大きいときだけ焼き直す:
  // 元から収まっている絵を焼き直すのは、手間と画質を捨てるだけ。
  // 原本読みごと loader に入れてあるので、焼き上がりが残っていれば原本には触らない
  // (収まっている絵や焼き損ないは原本 bytes のままキャッシュに載る — 量は増えるが挙動は同じ)
  fitPage(book, index, width, format, key, options) {
    return mediaCache.getImage(key, async () => {
      let page = null;
      try {
        page = await localArchive.readPage(book.target, index);
      } catch {
        page = null;
      }
      if (!page) return null;
      const size = imageSize(page.bytes);
      if (!size || size.width <= width * 1.15) return page;
      const made = await pageBaker.fitImage(page.bytes, width, format, options);
      return made ? { ...made, name: page.name } : page;
    });
  }

  // 次に立てたときの先焼きに要る。端末の画面は毎回同じなので、最後の一つを憶えておけば足りる
  notePageStyle(width, format) {
    const current = this.settings();
    if (Number(current.lanPageWidth) === width && current.lanPageFormat === format) return;
    this.saveSettings({ lanPageWidth: width, lanPageFormat: format });
  }

  // 端末が読み始めた本は、残りを裏で焼いておく。数頁読んでいる間に焼き上がる
  warmBook(id, book, from, width, format) {
    const tag = `${LAN_TAG}${id}:${width}:${format}`;
    if (this.warmTag === tag) return;
    // 読む本が変わった: 前の本の残りは追わない。焼き場が抱えられる PDF は 1 冊だけなので、
    // 追わせると本体の読み直しで行ったり来たりする
    pageBaker.dropBackgroundExcept(LAN_TAG, tag);
    pdfUnpack.dropBackgroundExcept(LAN_TAG, tag);
    this.warmTag = tag;
    this.warmBookId = String(id);
    const total = Number(book.pageCount) || 0;
    if (total < 2) return;
    this.warmPages(tag, book, from, total, total - 1, width, format)
      .catch(() => { /* 焼けない頁は飛ばす */ });
  }

  // 読んでいる所から先へ順に焼く。総数が分からないときは行き止まりまで進んで諦める
  async warmPages(tag, book, from, total, limit, width, format) {
    for (let step = 1; step <= limit; step += 1) {
      if (this.warmTag !== tag || !this.server) return;
      const index = total ? (from + step) % total : from + step;
      try {
        await this.pageBytes(book, index, width, format, { background: true, tag });
      } catch {
        // 焼けない頁で続きを止めない
      }
    }
  }

  // 立てた時に、読みかけの本の続きを少し焼いておく。手に取った時にはもう出来ている
  async warmReading() {
    if (!this.server) return;
    const current = this.settings();
    const width = pageBaker.snapWidth(current.lanPageWidth);
    // 配る形は jpeg に固定した (formatFor)。憶えている設定が古い webp のままだと、
    // 誰も引かない鍵で先に用意することになる
    const format = 'jpeg';
    const marks = Object.entries(this.readingAll())
      .filter(([, mark]) => mark && !mark.finished)
      .sort((a, b) => (Number(b[1].updatedAt) || 0) - (Number(a[1].updatedAt) || 0))
      .slice(0, WARM_BOOKS);
    for (const [id, mark] of marks) {
      if (!this.server) return;
      const book = this.resolveBook(id);
      if (!book) continue;
      const total = Number(mark.pageCount) || 0;
      const from = Math.max(0, Number(mark.page) || 0);
      const limit = total ? Math.min(WARM_PAGES, Math.max(1, total - from)) : WARM_PAGES;
      const tag = `${LAN_TAG}warm:${id}`;
      // 端末が本を開いたら、その本が先。warmTag が入れ替わった時点でこの周回は降りる
      this.warmTag = tag;
      this.warmBookId = String(id);
      await this.warmPages(tag, book, from - 1, total, limit, width, format);
    }
  }

  async serveReadingPut(req, res, id) {
    if (req.method !== 'PUT') {
      this.send(res, 405, 'text/plain; charset=utf-8', 'method not allowed');
      return;
    }
    let payload = null;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      this.sendJson(res, 400, { error: 'bad body' });
      return;
    }
    const saved = this.reading.set(readingKeyOf(id), {
      page: payload && payload.page,
      pageCount: payload && payload.pageCount,
      finished: payload && payload.finished,
    });
    this.sendJson(res, 200, saved || {});
  }
}

module.exports = { LanServer, makeToken, sameToken, readCookie, resolveContent };
