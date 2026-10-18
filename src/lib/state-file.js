'use strict';

// 控えの番人。userData に置く状態ファイルの書き込みは全部ここを通す。
// 三つを一箇所で受け持つ:
//
//   1. **原子的に書く** — tmp に書いて fsync してから rename。
//      途中で落ちても「壊れた本体」ではなく「前の完全な本体」が残る。
//      6 MB を素の writeFile で書いていた控えが、書き込み中の終了で
//      半端な JSON になり、次の起動で丸ごと捨てられて全件走査に戻っていた。
//
//   2. **写しの機体には書かせない** — 母艦が作って同期で配る控え (mirror:'follow') は、
//      写し (readOnly) の側では書かない。差し替えの一瞬に写しが書き返すと、
//      同期が運んできた新しい控えを古い内容で上書きする。
//      **止めるのは書き出しだけで、読みと組み立ては今までどおり動く。**
//      機体ごとに持つ物 (mirror:'own'。焼き頁の控え・栞・設定) は写しでも書く
//      — 写しは自分で頁を焼くので、ここまで止めると一頁も出せなくなる。
//
//   3. **書けなかったことを残す** — 黙って既定値に落ちない (trace へ)。
//
// 「どちらが正か」の表がここ一枚にあるので、同期の script が写す一覧と
// 突き合わせられる (test/cross-source.test.js)。

const fs = require('fs');
const path = require('path');
const { writeFileAtomicSync } = require('./atomic-file');
const trace = require('./trace');

// mirror: 'follow' = 母艦が作り、同期で配る。写しは読むだけ
//         'own'    = 機体ごとに自前で持つ。写しも書いてよい
const KINDS = {
  'eagle-index': { mirror: 'follow', scope: 'eagle' },     // eagle-scan-cache.json
  'paw-library': { mirror: 'follow', scope: 'paw' },       // paw-library-cache.json
  catalog: { mirror: 'follow', scope: 'catalog' },         // catalog.sqlite
  'paw-favorites': { mirror: 'follow', scope: 'paw' },     // paw-favorites.txt
  'paw-links': { mirror: 'follow', scope: 'paw' },         // paw-links.json
  // pixiv の所持の台帳 (投稿 ID ↔ Eagle 項目、作者 ↔ 作者フォルダ)。母艦が作り写しへ配る
  'pixiv-library': { mirror: 'follow', scope: 'store' },   // pixiv-library.json
  // hitomi / nhentai の名乗り ↔ 作者 の確定した結び (Home の詳細で結ぶ)。母艦が作り写しへ配る。
  // pixiv と Pawchive の結びは上の二つが持つ (ここに写さない)
  'creator-links': { mirror: 'follow', scope: 'store' },   // creator-links.json
  // 名前に日付の無い所持の本の公開日 (網で見つけた物)。母艦が作り写しへ配る (Home の作者頁の年表)
  'release-dates': { mirror: 'follow', scope: 'store' },   // release-dates.json
  'page-counts': { mirror: 'own', scope: 'store' },        // page-counts.json (所持の本の頁数。機体ごとに数える)
  // pixiv の取り込みの待ち行列。母艦だけの物 (写しは取り込まない)
  'pixiv-queue': { mirror: 'own', scope: 'download' },     // pixiv-queue.json
  // pawchive の取り込み (API で Eagle へ) の待ち行列。母艦だけの物
  'paw-queue': { mirror: 'own', scope: 'download' },       // paw-queue.json
  config: { mirror: 'own', scope: 'config' },              // 同期から外してある
  reading: { mirror: 'own', scope: 'store' },              // 栞は機体ごと
  jobs: { mirror: 'own', scope: 'download' },
  discovery: { mirror: 'own', scope: 'store' },
  'paw-state': { mirror: 'own', scope: 'paw' },
  // nhentai のタグ番号 -> 名前。網から只で溜まる控えで、機体ごとに持てばよい
  // (写しも自分で溜められるし、写す価値のある利用者の持ち物ではない)
  'nhentai-tags': { mirror: 'own', scope: 'store' },
  // AI 作品の生成情報の控え (better-sqlite3 の一枚ファイル。投稿 ID + 頁 → 出どころ・正規化した JSON)。母艦が書き、同期で写しへ配る。
  // 写しは読むだけで、問い合わせごとに開いて閉じる (開いたままだと差し替えが弾かれる)
  'ai-meta': { mirror: 'follow', scope: 'store' },         // ai-meta.sqlite
  media: { mirror: 'own', scope: 'media' },                // 写しも自前で焼く
};

let readOnly = false;

// main が起動時に一度だけ決める。写しかどうかは起動の引数と config で決まる
function setRole(role = {}) {
  readOnly = role.readOnly === true;
}

function roleIsMirror() {
  return readOnly;
}

function kindOf(kind) {
  const hit = KINDS[String(kind)];
  if (!hit) throw new Error(`state-file: 知らない控え ${kind} (KINDS に足すこと)`);
  return hit;
}

// この機体はこの控えを書いてよいか
function canWrite(kind) {
  const hit = kindOf(kind);
  return !(readOnly && hit.mirror === 'follow');
}

// 書けたら true。書かなかった/書けなかったら false (投げない)。
// 呼び手は「書けなくても動き続ける」ことを前提にしている物ばかりなので、
// ここで投げると却って壊れる。代わりに必ず記録へ残す
function writeText(kind, target, text) {
  const hit = kindOf(kind);
  if (!canWrite(kind)) {
    trace.warnOnce(`${kind}:readonly`, hit.scope, 'write-skipped-readonly', { id: kind });
    return false;
  }
  try {
    writeFileAtomicSync(target, text);
    return true;
  } catch (error) {
    trace.warnOnce(`${kind}:write`, hit.scope, 'write-failed', { id: trace.codeOf(error) });
    return false;
  }
}

// 一行だけ足す。控え全体を書き直さずに済む変化 (★を一つ押した、など) 用。
// 原子性は行単位: 途中で落ちた回の半端な行は、読む側が JSON.parse の失敗で捨てる
function appendLine(kind, target, text) {
  const hit = kindOf(kind);
  if (!canWrite(kind)) {
    trace.warnOnce(`${kind}:readonly`, hit.scope, 'write-skipped-readonly', { id: kind });
    return false;
  }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, `${text}\n`);
    return true;
  } catch (error) {
    trace.warnOnce(`${kind}:append`, hit.scope, 'write-failed', { id: trace.codeOf(error) });
    return false;
  }
}

function writeJson(kind, target, value) {
  let text = '';
  try {
    text = JSON.stringify(value);
  } catch (error) {
    trace.note(kindOf(kind).scope, 'write-failed', { id: trace.codeOf(error) });
    return false;
  }
  return writeText(kind, target, text);
}

// 壊れていた控えを横へ退けて、次の書き込みに道を空ける。
// 消さずに残すのは、後から中身を検められるようにするため (一枚だけ保つ)
function quarantine(kind, target) {
  const hit = kindOf(kind);
  if (!canWrite(kind)) return false;
  try {
    if (!fs.existsSync(target)) return false;
    const broken = `${target}.broken`;
    try { fs.unlinkSync(broken); } catch { /* 無ければそれでよい */ }
    fs.renameSync(target, broken);
    trace.note(hit.scope, 'corrupt', { id: path.basename(target) });
    return true;
  } catch (error) {
    trace.note(hit.scope, 'write-failed', { id: trace.codeOf(error) });
    return false;
  }
}

// 同期の script と突き合わせるための一覧 (試験が使う)
function follows() {
  return Object.keys(KINDS).filter((name) => KINDS[name].mirror === 'follow').sort();
}

function resetForTest() {
  readOnly = false;
}

module.exports = {
  setRole, roleIsMirror, canWrite, writeText, writeJson, appendLine, quarantine,
  follows, resetForTest, KINDS,
};
