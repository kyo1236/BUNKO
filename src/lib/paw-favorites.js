const fs = require('fs');
const path = require('path');
const config = require('./config');
// URL の組み立て・読み取りは pawchive のアダプタが持つ (site の知識はそちら一箇所)
const pawchive = require('./sources/pawchive');

// pawchive のお気に入り作者の URL リスト。
// 元は外部ツール (kemono-dl) と共有するファイルだった名残で、行の扱いは今も保守的:
// 読み取れない行はそのままの文字列で書き戻す (人が書いた註記を落とさないため)。
const SERVICES = pawchive.SERVICES;

function filePath() {
  try {
    const value = String(config.load().pawFavoritesFile || '').trim();
    if (value) return value;
  } catch {
    // Electron の外 (単体テスト) では設定を読めない: 既定の場所に落とす
  }
  return config.defaultPawFavoritesFile();
}

// Windows のパスは大小を区別しない。区切りの揺れも均してから比べる
function samePath(a, b) {
  const clean = (value) => (value ? path.resolve(String(value)).toLowerCase() : '');
  return clean(a) === clean(b) && clean(a) !== '';
}

// 置き場の設定を userData の既定に据える。起動時に一度きり。
// 自分で置き場を決めている人には触らない (空なら既定を書き込む)
function migrate() {
  const target = config.defaultPawFavoritesFile();
  const stored = String(config.load().pawFavoritesFile || '').trim();
  if (stored && !samePath(stored, target)) {
    return { moved: false, reason: 'custom', file: stored };
  }
  if (!samePath(stored, target)) config.save({ pawFavoritesFile: target });
  return { moved: false, reason: 'already', file: target };
}

function key(service, user) {
  return `${String(service || '').toLowerCase()}:${String(user || '')}`;
}

// 行 → 作者。空白/引用符/末尾の (new) のようなゴミを剥がしてから見る
function parseLine(text) {
  const clean = String(text || '').trim().replace(/^["'\s]+|["'\s]+$/g, '');
  if (!clean || clean.startsWith('#') || clean.startsWith(';')) return null;
  // 投稿 URL は作者のお気に入りではない: 触らずに残す
  if (/\/post\//i.test(clean)) return null;
  return pawchive.parseCreatorUrl(clean);
}

function readFileText() {
  try {
    return fs.readFileSync(filePath(), 'utf8');
  } catch {
    return null;
  }
}

// 行ごとに「元の文字列」と「読み取れた作者」を持つ。書き戻しは元の文字列を使う
function readLines() {
  const text = readFileText();
  if (text === null) return { lines: [], eol: '\r\n', trailing: true, exists: false };
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const raw = text.split(/\r?\n/);
  const trailing = raw.length > 1 && raw[raw.length - 1] === '';
  if (trailing) raw.pop();
  return {
    lines: raw.map((line) => ({ raw: line, entry: parseLine(line) })),
    eol,
    trailing: trailing || raw.length === 0,
    exists: true,
  };
}

function list() {
  const { lines } = readLines();
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    if (!line.entry) continue;
    const id = key(line.entry.service, line.entry.user);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ ...line.entry });
  }
  return out;
}

function has(service, user) {
  const id = key(service, user);
  return list().some((item) => key(item.service, item.user) === id);
}

// 番人を通す: fsync まで落としてから差し替え、写しの機体では書かない
// (母艦が作って同期で配る側の控え)
function writeAtomic(text) {
  return require('./state-file').writeText('paw-favorites', filePath(), text);
}

// 追加/削除。書く直前に必ず読み直す: 外部ツールの編集を踏み潰さないため
function toggle(service, user) {
  const svc = String(service || '').toLowerCase();
  const usr = String(user || '');
  if (!SERVICES.includes(svc) || !usr) return { favorited: false, list: list() };

  const id = key(svc, usr);
  const state = readLines();
  const hit = state.lines.some((line) => line.entry && key(line.entry.service, line.entry.user) === id);

  const kept = hit
    ? state.lines.filter((line) => !(line.entry && key(line.entry.service, line.entry.user) === id))
    : state.lines.concat([{ raw: pawchive.buildCreatorUrl(svc, usr), entry: { service: svc, user: usr, url: pawchive.buildCreatorUrl(svc, usr) } }]);

  const body = kept.map((line) => line.raw).join(state.eol);
  writeAtomic(kept.length && state.trailing ? `${body}${state.eol}` : body);
  return { favorited: !hit, list: list() };
}

module.exports = { list, has, toggle, migrate, filePath, parseLine, SERVICES };
