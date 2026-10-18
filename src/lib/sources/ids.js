'use strict';

// 作品 ID の表現と判定をここへ集める。文字列の形そのものは SQLite の台帳・
// 栞・端末側のキャッシュに焼き付いているので、絶対に変えない。
//
// デスクトップ側 (台帳・renderer 共通) の作品 ID:
//   hitomi  : 素の数値文字列 '123' (稀に 'hitomi:123')
//   nhentai : 'nh:123'
//   ehentai : 'eh:<gid>:<token>'
//   pawchive: 'pw:<service>:<user>:<postId|profile>'
//   pixiv   : 'px:<投稿 ID>'、作者の札は 'pxu:<user_id>' (鍵は 'user:<user_id>' に畳む)
//   Eagle アイテム由来の疑似 ID: 'pweagle:<eagleId>' (未照合アイテム・paw 所持庫)
//   作者フォルダの札            : 'pwlibf:<folderId>'
//   Home の作者の見出し         : 'home:f:<作者フォルダ id>' / 'home:h:<hitomi の artist を URI 符号化>'
//                                 / 'home:c:<hitomi の group (サークル) を URI 符号化>'
//                                 (本ではなく人。台帳にも栞にも焼き付かない)
// LAN (lan-server) 側の本 ID は別の名前空間:
//   'pw_<eagleId>' / 作者札 'pwf_<folderId>' / hitomi は素の数字

const PAW_EAGLE_PREFIX = 'pweagle:';
const PAW_FOLDER_PREFIX = 'pwlibf:';
const HOME_AUTHOR_PREFIX = 'home:';
const LAN_PAW_PREFIX = 'pw_';
const LAN_PAW_FOLDER_PREFIX = 'pwf_';

// --- ソース判定 -----------------------------------------------------------

// 接頭辞なしは hitomi 扱い (歴史的に hitomi の鍵が素の数字だったため)
function parseId(id) {
  const value = String(id || '');
  if (value.startsWith(HOME_AUTHOR_PREFIX)) return { source: 'home', key: value.slice(HOME_AUTHOR_PREFIX.length) };
  if (value.startsWith('nh:')) return { source: 'nhentai', key: value.slice(3) };
  if (value.startsWith('eh:')) return { source: 'ehentai', key: value.slice(3) };
  if (value.startsWith('pw:')) return { source: 'pawchive', key: value.slice(3) };
  if (value.startsWith('px:')) return { source: 'pixiv', key: value.slice(3) };
  if (value.startsWith('pxu:')) return { source: 'pixiv', key: `user:${value.slice(4)}` };
  if (value.startsWith('hitomi:')) return { source: 'hitomi', key: value.slice(7) };
  return { source: 'hitomi', key: value };
}

// hitomi の画廊番号。'hitomi:' を剥がした残りが数字だけのときに数値で返す
function numericGalleryId(id) {
  const raw = String(id == null ? '' : id).trim();
  const text = raw.startsWith('hitomi:') ? raw.slice(7) : raw;
  if (!/^\d+$/.test(text)) return null;
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : null;
}

// 台帳の鎖 (title_matches / items の gallery_id) に使う作品鍵。hitomi は素の
// 数値文字列 ('123')、他ソースは 'nh:123' 型の接頭辞付きで持つ (SQLite は動的型
// なので INTEGER 列に文字列鍵が同居できる)。pawchive (pw:) と pixiv (px:) は
// 作者根の中に住み、台帳の走査から外れるので対象外 (所持は各自の台帳が答える)。
// hitomi のメタ (galleries ほか) は今までどおり numericGalleryId の世界に閉じる
function galleryKeyOf(id) {
  const raw = String(id == null ? '' : id).trim();
  if (/^(nh|eh):.+$/.test(raw)) return raw;
  const numeric = numericGalleryId(raw);
  return numeric != null ? String(numeric) : null;
}

// pw:<service>:<user>:<postId> → { service, user, postId }。手動紐付けの鍵になる
function pawTriple(id) {
  const parts = String(id || '').split(':');
  if (parts[0] !== 'pw' || parts.length < 4) return null;
  const [, service, user, postId] = parts;
  if (!service || !user || !postId || postId === 'profile') return null;
  return { service, user, postId };
}

// --- Eagle アイテム由来の疑似 ID (pweagle: / pwlibf:) ---------------------

function pawEagleGalleryId(eagleId) {
  return PAW_EAGLE_PREFIX + eagleId;
}

function isPawEagleId(id) {
  return String(id || '').startsWith(PAW_EAGLE_PREFIX);
}

function eagleIdOf(id) {
  return isPawEagleId(id) ? String(id).slice(PAW_EAGLE_PREFIX.length) : '';
}

function pawFolderGalleryId(folderId) {
  return PAW_FOLDER_PREFIX + folderId;
}

function isPawFolderId(id) {
  return String(id || '').startsWith(PAW_FOLDER_PREFIX);
}

function pawFolderIdOf(id) {
  return isPawFolderId(id) ? String(id).slice(PAW_FOLDER_PREFIX.length) : '';
}

// --- Home の作者 (人) の見出し ----------------------------------------------
// 作者フォルダの人は 'f'、作者フォルダを持たない hitomi だけの人は 'h'、hitomi だけのサークルは 'c'。
// artist の名は空白や記号を含むので符号化して持つ (札の data-id と選択子に通すため)

function homeAuthorId(kind, key) {
  let tag = 'f';
  if (kind === 'hitomi' || kind === 'h') tag = 'h';
  else if (kind === 'circle' || kind === 'c') tag = 'c';
  return `${HOME_AUTHOR_PREFIX}${tag}:${encodeURIComponent(String(key == null ? '' : key))}`;
}

function isHomeAuthorId(id) {
  return String(id || '').startsWith(HOME_AUTHOR_PREFIX);
}

// 'home:f:<id>' → { kind: 'folder', key }、'home:h:<artist>' → { kind: 'hitomi', key }、
// 'home:c:<group>' → { kind: 'circle', key }。形が違えば null
function parseHomeAuthorId(id) {
  const hit = /^home:([fhc]):(.+)$/.exec(String(id || ''));
  if (!hit) return null;
  let key = '';
  try {
    key = decodeURIComponent(hit[2]);
  } catch {
    return null;
  }
  const kinds = { f: 'folder', h: 'hitomi', c: 'circle' };
  return key ? { kind: kinds[hit[1]], key } : null;
}

// パス区切りや .. を含む id は受け付けない: images/ の外に出さない
function safeEagleId(value) {
  const text = String(value || '');
  if (!text || text.length > 64) return '';
  return /^[A-Za-z0-9_-]+$/.test(text) ? text : '';
}

// --- LAN (lan-server) の本 ID (pw_ / pwf_) --------------------------------
// デスクトップの 'pweagle:' を外へそのまま出さないのは、LAN の口が id を
// URL の一部として使うから: 区切りの ':' を避け、英数と _- だけで組む

function lanPawId(eagleId) {
  return LAN_PAW_PREFIX + eagleId;
}

function lanPawEagleIdOf(id) {
  const text = String(id == null ? '' : id);
  return text.startsWith(LAN_PAW_PREFIX) ? text.slice(LAN_PAW_PREFIX.length) : '';
}

function lanPawFolderId(folderId) {
  return LAN_PAW_FOLDER_PREFIX + folderId;
}

function isLanPawFolderId(id) {
  return String(id == null ? '' : id).startsWith(LAN_PAW_FOLDER_PREFIX);
}

function lanPawFolderIdOf(id) {
  const text = String(id == null ? '' : id);
  return text.startsWith(LAN_PAW_FOLDER_PREFIX) ? text.slice(LAN_PAW_FOLDER_PREFIX.length) : '';
}

// LAN の口が受ける id の顔 (正規表現の断片)。pw_ の後ろは Eagle の id
// (英数と _- で 40 まで)、hitomi は桁数で暴走を防ぐ。表紙の口だけは
// 作者札 (pwf_) も受ける
const LAN_BOOK_ID_PART = 'pw_[A-Za-z0-9_-]{1,40}|\\d{1,12}';
const LAN_COVER_ID_PART = `pwf_[A-Za-z0-9_-]{1,40}|${LAN_BOOK_ID_PART}`;

module.exports = {
  parseId,
  numericGalleryId,
  galleryKeyOf,
  pawTriple,
  pawEagleGalleryId,
  isPawEagleId,
  eagleIdOf,
  pawFolderGalleryId,
  isPawFolderId,
  pawFolderIdOf,
  homeAuthorId,
  isHomeAuthorId,
  parseHomeAuthorId,
  safeEagleId,
  lanPawId,
  lanPawEagleIdOf,
  lanPawFolderId,
  isLanPawFolderId,
  lanPawFolderIdOf,
  LAN_BOOK_ID_PART,
  LAN_COVER_ID_PART,
};
