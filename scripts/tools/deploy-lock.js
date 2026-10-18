'use strict';
// 配布の錠。組む・配る・9222 で起こす前に取り、終わったら空ける。**他の会に放送で聞かない** (寝ている会が起きて動き出す)。
//
//   node scripts/tools/deploy-lock.js take <会の名> <用途>      錠を取る (他の会の錠が生きていれば断る。古い錠は上書き)
//   node scripts/tools/deploy-lock.js free <会の名> [--note "…"] 錠を空ける (持ち主だけ。--force で強行)
//   node scripts/tools/deploy-lock.js show                        今の錠と、最後に空けた記録
//   node scripts/tools/deploy-lock.js check --owner <会の名>       その会が錠を持っていれば 0、無ければ 1 (deploy.ps1 と cdp-eval.js が呼ぶ)
//
// 置き場は配布先 `<母艦の配布先>\.deploy-lock.json` (機体の物なので、どの枝の作業木からも同じ物が見える)。
// 配布先は母屋の bunko.local.json の mothership (scripts/tools/local-config.js)。
// `--dest <配布先>` か環境変数 BUNKO_DEPLOY_LOCK (ファイルの道) で替えられる (試験用)。
// 錠が他の会の物なら、**その一つの会にだけ** SendMessage して待つ。30 分より古い錠は死んだ会の物とみなして上書きしてよい。
const fs = require('fs');
const path = require('path');
const os = require('os');

const STALE_MS = 30 * 60 * 1000;
function lockPath(opts = {}) {
  if (process.env.BUNKO_DEPLOY_LOCK) return process.env.BUNKO_DEPLOY_LOCK;
  return path.join(opts.dest || require('./local-config').get('mothership'), '.deploy-lock.json');
}
function lastPath(opts) { return lockPath(opts).replace(/\.json$/, '.last.json'); }

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\ufeff/, '')); } catch { return null; }
}
function writeJson(p, obj) {   // BOM 無し・一時名から rename (書きかけを読ませない)
  const tmp = p + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, p);
}
function readLock(opts) { return readJson(lockPath(opts)); }
function isStale(lock, now = Date.now(), staleMs = STALE_MS) {
  const at = Date.parse(lock && lock.at);
  return !Number.isFinite(at) || now - at > staleMs;
}
function describe(lock) {
  if (!lock) return '(錠なし)';
  const age = Math.round((Date.now() - Date.parse(lock.at)) / 60000);
  return `${lock.owner} — ${lock.purpose || ''} (${lock.at}、${age} 分前${isStale(lock) ? '、古い' : ''})`;
}

// その会が錠を持っているか。持っていなければ理由を返す (null = 持っている)
function blocker(owner, opts) {
  const lock = readLock(opts);
  if (!lock) return '錠が無い。先に取る: node scripts/tools/deploy-lock.js take <会の名> <用途>';
  if (lock.owner === owner) return null;
  if (isStale(lock)) return `古い錠 (${describe(lock)}) が残っている。take で上書きしてから`;
  return `錠は別の会の物: ${describe(lock)} → その会にだけ声をかけて待つ (放送しない)`;
}

function cmdTake(owner, purpose, flags, opts) {
  if (!owner || !purpose) throw new Error('usage: take <会の名> <用途>');
  const lock = readLock(opts);
  if (lock && lock.owner !== owner && !isStale(lock) && !flags.force) {
    console.log('[NG] ' + describe(lock) + ' が持っている。その会にだけ声をかけて待つ (--force は死んだ会の錠だと確かな時だけ)');
    process.exit(1);
  }
  if (lock && lock.owner !== owner) console.log('[--] 古い錠を上書き: ' + describe(lock));
  fs.mkdirSync(path.dirname(lockPath(opts)), { recursive: true });
  writeJson(lockPath(opts), { owner, purpose, at: new Date().toISOString(), host: os.hostname(), pid: process.pid });
  console.log('[OK] 錠を取った: ' + owner + ' — ' + purpose);
}

function cmdFree(owner, flags, opts) {
  const lock = readLock(opts);
  if (!lock) { console.log('[--] 錠は無い'); return; }
  if (owner && lock.owner !== owner && !flags.force) {
    console.log('[NG] 錠は ' + describe(lock) + ' の物。自分の物でない錠は空けない (--force は死んだ会の錠だと確かな時だけ)');
    process.exit(1);
  }
  writeJson(lastPath(opts), { ...lock, freedAt: new Date().toISOString(), freedBy: owner || lock.owner, note: flags.note || '' });
  fs.unlinkSync(lockPath(opts));
  console.log('[OK] 錠を空けた: ' + lock.owner + (flags.note ? ' — ' + flags.note : ''));
}

function cmdShow(opts) {
  console.log('錠: ' + describe(readLock(opts)) + '  (' + lockPath(opts) + ')');
  const last = readJson(lastPath(opts));
  if (last) console.log('最後に空けた: ' + last.owner + ' — ' + (last.purpose || '') + ' → ' + last.freedAt + (last.note ? ' — ' + last.note : ''));
}

function cmdCheck(flags, opts) {
  const why = blocker(flags.owner || '', opts);
  if (why) { console.log('[NG] ' + why); process.exit(1); }
  console.log('[OK] 錠は ' + flags.owner + ' の物');
}

function parse(argv) {
  const flags = {}; const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') flags.force = true;
    else if (a === '--note' || a === '--owner' || a === '--dest') flags[a.slice(2)] = argv[++i];
    else rest.push(a);
  }
  return { flags, rest };
}

function main() {
  const { flags, rest } = parse(process.argv.slice(2));
  const opts = { dest: flags.dest };
  const [cmd, a, b] = rest;
  switch (cmd) {
    case 'take': return cmdTake(a, b, flags, opts);
    case 'free': return cmdFree(a, flags, opts);
    case 'show': return cmdShow(opts);
    case 'check': return cmdCheck(flags, opts);
    default: console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 11).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  }
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('[NG] ' + e.message); process.exit(1); }
}
module.exports = { lockPath, readLock, isStale, blocker, describe, STALE_MS };
