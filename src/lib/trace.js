'use strict';

// 失敗の落ち先。今は既定値へ黙って落ちる catch が各所にあり、失敗が正常系と
// 同じ形で返るので、利用者にも次に触る人にも何が起きたか残らない。
//
// 決まり:
//   1. **作品名とタグは書けない。** 書かない作法ではなく、口の形として受け取らない。
//      detail に通るのは { id, count, ms, bytes } だけで、他の鍵は捨てる。
//      id は Eagle のアイテム id や作品 ID のような不透明な鍵に限る (呼び手の責任)。
//   2. code は下の CODES にある語だけ。自由文を入れられないので、
//      「うっかり meta.name を渡す」道が閉じている。
//   3. ここは絶対に投げない。記録が書けないことでアプリが止まってはいけない。
//
// 落ち先は <userData>/logs/bunko-YYYYMMDD.log。7 日で捨てる。
// 画面へ出すぶんは recent() を IPC が拾う (既にある library-progress に相乗り)。

const fs = require('fs');
const path = require('path');

// 記録を残す場所 (誰が)。増やす時はここへ足す
const SCOPES = new Set([
  'boot', 'config', 'store', 'catalog', 'eagle', 'paw', 'pdf', 'baker',
  'media', 'lan', 'net', 'download', 'sync', 'reader', 'ipc',
]);

// 何が起きたか。**自由文を禁じるための表**。足す時はここへ足す
const CODES = new Set([
  // 土台
  'unhandled', 'uncaught', 'write-failed', 'write-skipped-readonly', 'read-failed',
  'corrupt', 'restored-from-backup', 'rebuilt-empty', 'atomic-replace-failed',
  // 走査と控え
  'scan-failed', 'scan-partial', 'scan-skipped', 'cache-version-changed',
  'cache-missing', 'library-unreachable', 'index-reshape',
  // 外との遣り取り
  'request-failed', 'rate-limited', 'auth-failed', 'offline', 'aborted', 'truncated',
  // 頁
  'unpack-fallback', 'bake-failed', 'bake-timeout', 'encoder-missing', 'decode-incomplete',
  // その他
  'eagle-api-failed', 'tag-write-failed', 'lan-listen-failed', 'sync-failed',
]);

const RING = 200;            // 画面へ出すぶん
const KEEP_DAYS = 7;
const ring = [];
const onceKeys = new Set();
const flagged = new Map();

let logDir = '';
let stream = null;
let streamDay = '';
let installed = false;

function init(dir) {
  logDir = String(dir || '');
  if (!logDir) return;
  try {
    fs.mkdirSync(logDir, { recursive: true });
    sweep();
  } catch {
    // 置き場が作れなければ記憶の中だけに残す (recent() は動く)
    logDir = '';
  }
}

function dayOf(at) {
  const d = new Date(at);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function sweep() {
  if (!logDir) return;
  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  let names = [];
  try {
    names = fs.readdirSync(logDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!/^bunko-\d{8}\.log$/.test(name)) continue;
    const file = path.join(logDir, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    } catch {
      // 消せなくても構わない
    }
  }
}

// detail の漉し器。ここが「作品名が書けない」の本体
function shape(detail) {
  if (!detail || typeof detail !== 'object') return null;
  const out = {};
  if (detail.id != null) out.id = String(detail.id).slice(0, 64);
  if (Number.isFinite(Number(detail.count))) out.count = Number(detail.count);
  if (Number.isFinite(Number(detail.ms))) out.ms = Math.round(Number(detail.ms));
  if (Number.isFinite(Number(detail.bytes))) out.bytes = Number(detail.bytes);
  return Object.keys(out).length ? out : null;
}

function line(entry) {
  const detail = entry.detail ? ` ${JSON.stringify(entry.detail)}` : '';
  return `${new Date(entry.at).toISOString()} ${entry.scope} ${entry.code}${detail}\n`;
}

function append(entry) {
  if (!logDir) return;
  const day = dayOf(entry.at);
  try {
    if (!stream || streamDay !== day) {
      if (stream) stream.end();
      streamDay = day;
      stream = fs.createWriteStream(path.join(logDir, `bunko-${day}.log`), { flags: 'a' });
      // 書けなくなっても落ちない: 以後は記憶の中だけ
      stream.on('error', () => { stream = null; });
      sweep();
    }
    stream.write(line(entry));
  } catch {
    stream = null;
  }
}

// 一件残す。scope と code は表にある語だけ。無い語は 'ipc'/'unhandled' に倒して
// 落とさない (記録の仕組みのせいでアプリが止まるより、粗くても残る方が良い)
function note(scope, code, detail) {
  const entry = {
    at: Date.now(),
    scope: SCOPES.has(scope) ? scope : 'ipc',
    code: CODES.has(code) ? code : 'unhandled',
    detail: shape(detail),
  };
  ring.push(entry);
  while (ring.length > RING) ring.shift();
  append(entry);
  return entry;
}

// 同じ鍵では一度きり。鍵も不透明な物に限る (呼び手が作品名を混ぜられないよう
// 64 字で切り、記録には鍵そのものを出さない)
function warnOnce(key, scope, code, detail) {
  const k = `${scope}:${code}:${String(key || '').slice(0, 64)}`;
  if (onceKeys.has(k)) return null;
  onceKeys.add(k);
  return note(scope, code, detail);
}

// 「今この機体はこういう状態」を立てる印 (控えが無い・ライブラリが見えない 等)。
// 設定画面と帯がこれを読む。
//
// **時限を付けられる。** 裏の仕事の不調 (Eagle が起きていない等) は、
// 直ったことを誰も教えてくれないまま印だけ残り、帯が永久に居座ることになる。
// 条件が続いていれば立て直されるので、時限が切れて消えても実害は無い
function flag(name, on = true, ttlMs = 0) {
  if (on) flagged.set(String(name), { at: Date.now(), ttl: Number(ttlMs) || 0 });
  else flagged.delete(String(name));
}

function flags() {
  const now = Date.now();
  const out = {};
  for (const [name, hit] of flagged) {
    if (hit.ttl && now - hit.at > hit.ttl) {
      flagged.delete(name);
      continue;
    }
    out[name] = hit.at;
  }
  return out;
}

function recent(limit = 50) {
  const n = Math.max(1, Math.min(RING, Number(limit) || 50));
  return ring.slice(-n);
}

// 拾われなかった例外をここへ集める。一度だけ
function install() {
  if (installed) return;
  installed = true;
  process.on('unhandledRejection', (reason) => {
    note('boot', 'unhandled', { id: whereOf(reason) });
  });
  process.on('uncaughtException', (error) => {
    note('boot', 'uncaught', { id: whereOf(error) });
  });
}

// 例外から「名前だけ」取る。message は原本の道 (= 作品名) を含みうるので使わない
function codeOf(error) {
  if (!error) return 'unknown';
  if (error.code) return String(error.code).slice(0, 32);
  if (error.name) return String(error.name).slice(0, 32);
  return 'Error';
}

// 例外がどこで起きたか。**このアプリ自身の source の file:line だけ**を取る。
// 名前 (message) は原本の道を含みうるので触らず、道も src/ から下だけに刈る。
// これが無いと記録が 'Error' の一語になり、拾われない例外を追えない
function frameOf(error) {
  const stack = String((error && error.stack) || '');
  for (const line of stack.split(/\r?\n/).slice(1)) {
    const hit = line.match(/[\\/](src[\\/][^\s)]+?):(\d+):\d+/);
    if (hit) return `${hit[1].split('\\').join('/')}:${hit[2]}`;
  }
  return '';
}

// 記録に残す一語。「何が」と「どこで」を 64 字に収める
function whereOf(error) {
  const at = frameOf(error);
  return at ? `${codeOf(error)}@${at}`.slice(0, 64) : codeOf(error);
}

function reset() {
  ring.length = 0;
  onceKeys.clear();
  flagged.clear();
}

async function close() {
  if (!stream) return;
  const s = stream;
  stream = null;
  await new Promise((done) => s.end(done));
}

module.exports = {
  init, note, warnOnce, flag, flags, recent, install, close, reset, codeOf, frameOf, whereOf,
  SCOPES, CODES,
};
