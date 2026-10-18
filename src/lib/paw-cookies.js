'use strict';

const fs = require('fs');
const os = require('os');
// path ではなく nodePath の名で持つ。下の cookieHeader() が引数から作る局所変数を
// path と名付けているので、素の名で入れると読み手が取り違える (あちらは触らない)
const nodePath = require('path');

// pawchive のクッキー (Netscape 形式のクッキーファイル) を読む。
//
// この置き場は無認証だと数枚で 403 に切り替わる。実測では素の取得は 3 枚 (約 7MB)
// で断たれ、同じ 7MB/s でもログイン済みなら断られない: 効いているのは速度ではなく
// 「素性が知れているか」。既存の取り込みツール (kemono-dl) が速度を気にせず
// 動いていたのも、同じクッキーを持たせていたから。
//
// 中身は利用者の資格情報そのものなので、値はログにも画面にも出さない。
// 持たない (ファイルが無い・空・期限切れ) 場合は素のまま取りに行く: その道も
// 塞がってはいない (downloader 側が速度を落として粘る)。
//
// クッキーの綴じられているドメインは pawchive.st だが、今の API とファイル置き場は
// pawchive.pw にある。置き場が引っ越しても同じ証しが通るので、宛先で選り分けず
// そのまま添える (ブラウザの綴じ方とは違うが、狙って添えている)。

let cache = { path: '', at: 0, size: 0, header: '' };

// 名前と値に割ってから返す。ヘッダの綴りに畳む前の形も要る: 取り込みエンジン
// (kemono-engine) は同じクッキーをドメインだけ替えて綴じ直した写しを書くので、
// 'a=1; b=2' の綴りから割り戻すと値の中の '; ' で割れてしまう
function parsePairs(text) {
  const pairs = [];
  for (const line of String(text).split('\n')) {
    const row = line.trim();
    // #HttpOnly_ 付きの行も読む (先頭が # でも実体はクッキー)
    if (!row || (row.startsWith('#') && !row.startsWith('#HttpOnly_'))) continue;
    const fields = row.replace(/^#HttpOnly_/, '').split('\t');
    if (fields.length < 7) continue;
    const name = fields[5].trim();
    const value = fields[6].trim();
    if (name) pairs.push({ name, value });
  }
  return pairs;
}

function parse(text) {
  return parsePairs(text).map(({ name, value }) => `${name}=${value}`).join('; ');
}

// 差し替えを取り込みたいので、ファイルの更新を見て読み直す
// (クッキーを入れ替えるたびにアプリを立て直さずに済む)
function cookieHeader(file) {
  const path = String(file || '').trim();
  if (!path) return '';
  let stat;
  try {
    stat = fs.statSync(path);
  } catch {
    return '';
  }
  const at = stat.mtimeMs;
  if (cache.path === path && cache.at === at && cache.size === stat.size) return cache.header;
  let header = '';
  try {
    header = parse(fs.readFileSync(path, 'utf8'));
  } catch {
    header = '';
  }
  cache = { path, at, size: stat.size, header };
  return header;
}

// 設定から渡された道。main 側が起動時と設定変更時に差す
let cookieFile = '';

function setCookieFile(file) {
  cookieFile = String(file || '').trim();
}

function headers(extra = {}) {
  const cookie = cookieHeader(cookieFile);
  return cookie ? { ...extra, Cookie: cookie } : { ...extra };
}

// ブラウザ拡張が書き出すクッキーの名。置き場が pawchive.st → .pw と移っても
// 同じ証しが通るので、どちらの名でも拾う (先に見つかった方を採る)
const DOWNLOADED_COOKIE_NAMES = ['pawchive.st_cookies.txt', 'pawchive.pw_cookies.txt'];

// Windows のパスは大小を区別しない。区切りの揺れも均してから比べる
function samePath(a, b) {
  const clean = (value) => (value ? nodePath.resolve(String(value)).toLowerCase() : '');
  return clean(a) === clean(b) && clean(a) !== '';
}

// 設定に残っている置き場を既定 (userData の下) へ寄せる。起動時に一度きり。
//
// config を require しないのは循環参照を避けるため: 呼び手 (main) が今の値と
// 既定、そして書き戻す手を渡す。自分で置き場を決めている人には触らない。
// legacyFile (旧い置き場) を渡した時だけ、そこに育っているクッキーを引き取る:
// この引っ越しは「実在する誰かのクッキー」を写す働きなので、既定では何も写さない
function migrate({ stored, defaultFile, save, legacyFile } = {}) {
  const legacy = String(legacyFile || '').trim();
  const target = String(defaultFile || '').trim();
  const current = String(stored || '').trim();
  if (!target) return { file: current, changed: false, copied: false, reason: 'no-default' };

  const replaceable = !current || (legacy && samePath(current, legacy));
  if (!replaceable) return { file: current, changed: false, copied: false, reason: 'custom' };

  // 新既定の場所が空なら、旧い置き場に育っているクッキーを引き取る。
  // 原本は消さない: 外部ツールを併用している間も向こうが読めるようにしておく
  let copied = false;
  try {
    if (legacy && !fs.existsSync(target) && fs.existsSync(legacy)) {
      fs.mkdirSync(nodePath.dirname(target), { recursive: true });
      fs.copyFileSync(legacy, target);
      copied = true;
    }
  } catch {
    // 引き取れなくても、置き場を貼り替えるところまでは進める
  }

  let changed = false;
  if (!samePath(current, target) && typeof save === 'function') {
    save(target);
    changed = true;
  }
  return { file: target, changed, copied, reason: copied ? 'copied' : 'already' };
}

// ブラウザで書き出したクッキーが Downloads に落ちていたら設定の置き場へ引き上げる。
// 旧 launcher (cookie_move.py) の役目をそのまま持ってきたもの: 利用者はこれまで
// どおり「拡張で書き出して起動する」だけでよい。
//
// 移動 (move) にするのは、Downloads に資格情報の写しを残さないため。無ければ
// 何もしない (今持っているクッキーをそのまま使う)
function adoptDownloadedCookies({ downloadsDir, cookieFile: target } = {}) {
  const dir = String(downloadsDir || '').trim() || nodePath.join(os.homedir(), 'Downloads');
  const dest = String(target || cookieFile || '').trim();
  if (!dest) return { adopted: false, reason: 'no-target' };

  for (const name of DOWNLOADED_COOKIE_NAMES) {
    const source = nodePath.join(dir, name);
    if (!fs.existsSync(source)) continue;
    // 書き出し先そのものを置き場に選んでいる人がいる。自分を自分へ引き上げると
    // 「移動」の後始末で手持ちのクッキーごと消える: 何もしないのが正解
    if (samePath(source, dest)) return { adopted: false, reason: 'same', file: dest };
    fs.mkdirSync(nodePath.dirname(dest), { recursive: true });
    try {
      // 先に dest を消さない: Windows の rename は既存の宛先を上書きするので
      // 消す必要が無く、消してから rename が転ぶと古い証しまで失って無認証に落ちる
      fs.renameSync(source, dest);
    } catch {
      // Downloads と userData が別ドライブだと rename は通らない: 写して据える。
      // 直に dest へ写すと途中で転んだとき半端な証しが居座るので、一時名へ
      // 写し切ってから名前を付け替える
      const staging = `${dest}.tmp`;
      try {
        fs.copyFileSync(source, staging);
        fs.renameSync(staging, dest);
      } catch (error) {
        try { fs.rmSync(staging, { force: true }); } catch { /* 残っても次の写しが上書きする */ }
        // 据えられなかったのだから原本は消さない (Downloads に残る方がまだ良い)
        return { adopted: false, reason: 'failed', file: dest, error };
      }
      // 据わってから消す。順が逆だと、写しに失敗した回に証しごと消える
      try { fs.unlinkSync(source); } catch { /* 原本が残っても取り込みは済んでいる */ }
    }
    return { adopted: true, from: source, file: dest };
  }
  return { adopted: false, reason: 'none', file: dest };
}

// 画面に出す用の状態。値は返さない (何個持っているかだけ)
function status() {
  const cookie = cookieHeader(cookieFile);
  return { file: cookieFile, present: Boolean(cookie), count: cookie ? cookie.split('; ').length : 0 };
}

module.exports = {
  setCookieFile,
  headers,
  status,
  parse,
  parsePairs,
  migrate,
  adoptDownloadedCookies,
};
