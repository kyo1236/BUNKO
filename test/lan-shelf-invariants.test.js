'use strict';

// 手のひら版の棚 (src/lan/shelf.js) が守るべき掟の釘。
//
// shelf.js はブラウザの IIFE で、母屋から呼べる窓口を持たない。ここは
// readonly-mode.test.js と同じで**字面を走査する**試験だが、意味がある形にしてある:
//   - 掟そのもの (空にしない・押しのけない) は利用者に見える害と一対一で結びつく
//   - 並びの表は母屋 (lan-server.js) と突き合わせるので、番人と検査の出どころが別
// 振る舞いそのものは scripts/lan-preview.js の試写台で実測して確かめた
// (初回 84 → 30 枚 / 組み直しの途中で札が 0 にならない)。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const SHELF = read('src/lan/shelf.js');
const SERVER = read('src/lib/lan-server.js');

// 関数の中身だけを切り出す (次の `\n  function ` まで)
function bodyOf(text, head) {
  const at = text.indexOf(head);
  assert.ok(at > 0, `${head} が見つからない`);
  const rest = text.slice(at + head.length);
  const end = rest.search(/\r?\n  (?:function |var |\/\/ ──)/);
  return rest.slice(0, end > 0 ? end : rest.length);
}

// ── 掟: 読み込み中の空白を作らない ──────────────────────────
test('棚を組み直す時に札を捨てない (捨ててから取りに行くと真っ白になる)', () => {
  const reset = bodyOf(SHELF, 'function reset() {');
  assert.ok(
    !/grid\.(textContent\s*=\s*''|innerHTML\s*=|replaceChildren\(\s*\))/.test(reset),
    '打鍵・並び変更・台帳切替のたびに棚が白くなる。返事が来てから入れ替えること',
  );
  assert.match(reset, /replaceOnNext\s*=\s*true/, '次の一頁目で置き換える印を立てること');
});

test('置き換える時は同じ本の札を使い回す (作り直すと棚が波打つ)', () => {
  assert.match(SHELF, /var kept = replacing \? have\[String\(item\.id\)\] : null;/,
    'id で引いて使い回すこと');
  assert.match(SHELF, /stagger\(added\)/, '入場の動きを付けるのは新しく組んだ札だけ');
});

test('「最近読んだ」の帯を作り直さない (帯が生え直すと下の棚が丸ごと飛ぶ)', () => {
  const paint = bodyOf(SHELF, 'function paintRecent(items) {');
  assert.ok(
    !/resume\.(textContent\s*=\s*''|innerHTML\s*=)/.test(paint),
    '帯を捨てて組み直すと、本を閉じて棚へ戻るたびに棚が 230px ほど飛ぶ',
  );
  assert.match(paint, /have\[String\(item\.id\)\]/, '帯も id で引いて使い回すこと');
});

// ── 追い足しの向き ────────────────────────────────────────
test('追い足しは nearEnd() を否定せずに使う (三つの呼び手で向きが揃うこと)', () => {
  // 2026-09-11 まで、一頁目の後の追い足しだけが `!nearEnd()` になっていた。
  // 画面が埋まっていない時は取りに行かず (巻けないので二度と継がれない)、
  // 埋まっている時は 8 頁先まで取る、と両方向とも註の反対に動いていた
  assert.ok(!/!\s*nearEnd\(\)/.test(SHELF), 'nearEnd() は「続きを取る合図」。否定して使わない');
  const calls = SHELF.match(/nearEnd\(\)/g) || [];
  assert.ok(calls.length >= 3, `呼び手が減っている (${calls.length} 件)`);
});

// ── IME と検索 ────────────────────────────────────────────
test('変換中の断片で棚を組み直さない', () => {
  assert.match(
    SHELF, /if \(composing \|\| \(event && event\.isComposing\)\) return;/,
    '机上版と同じ二重の守り (composing の印 + compositionstart を取り逃す IME への保険)',
  );
});

test('鍵盤の「検索」で語が決まり、鍵盤が退く', () => {
  assert.match(SHELF, /addEventListener\('keydown'/, 'Enter の耳が無い');
  const keydown = SHELF.slice(SHELF.indexOf("qInput.addEventListener('keydown'"));
  assert.match(keydown.slice(0, 400), /commitQuery\(\);/, 'Enter で語を決めること');
  assert.match(keydown.slice(0, 400), /qInput\.blur\(\)/, 'Enter で鍵盤を退けること');
});

test('打ち直しは履歴に積まず上書きする (電話の「戻る」が語を一字ずつ遡らない)', () => {
  assert.match(SHELF, /function pushShelf\(replaceTop\)/, '上書きの口が無い');
  assert.match(SHELF, /pushShelf\(wasSearching && Boolean\(next\)\)/,
    '検索に入る時と出る時だけ積み、語から語への打ち直しは上書きにすること');
});

// ── 並びの表を母屋と突き合わせる ────────────────────────────
function idsOf(source, name) {
  const at = source.indexOf(`var ${name} = [`);
  assert.ok(at > 0, `${name} が見つからない`);
  const block = source.slice(at, source.indexOf('];', at));
  return (block.match(/id: '([^']*)'/g) || []).map((s) => s.slice(5, -1));
}

test('手のひら版が出す並びは、母屋が受ける並びに全部在る', () => {
  const sorts = idsOf(SHELF, 'SORTS');
  const set = SERVER.match(/const LIST_SORTS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(set, 'LIST_SORTS が見つからない');
  const known = (set[1].match(/'([^']*)'/g) || []).map((s) => s.slice(1, -1));
  for (const id of sorts) {
    assert.ok(known.includes(id), `shelf.js の ${id} を lan-server の LIST_SORTS が知らない`);
  }
});

test('作者の棚に出す並びは、母屋が実際に分岐を持つ物だけ', () => {
  // 出しているのに母屋が既定へ落とすと「釦は真鍮に灯り、棚は組み直り、
  // 一字も並びが変わらない」という嘘になる (2026-09-11 まで四つがこれだった)
  const at = SHELF.indexOf('var FOLDER_SORTS = [');
  assert.ok(at > 0, 'FOLDER_SORTS が見つからない');
  const folderSorts = (SHELF.slice(at, SHELF.indexOf('];', at)).match(/'([^']*)'/g) || [])
    .map((s) => s.slice(1, -1));
  assert.ok(folderSorts.includes('added'), '既定 (追加日) は必ず出すこと');

  // 定義の頭から次の口までを切る。呼び出しの側に当たらないよう、既定引数ごと狙う
  const from = SERVER.indexOf('servePawFolders(res, page, { sort =');
  assert.ok(from > 0, 'servePawFolders の定義が見つからない');
  const after = SERVER.slice(from);
  const to = after.search(/\n {2}[A-Za-z]+\(/);
  const body = to > 0 ? after.slice(0, to) : after;
  for (const id of folderSorts) {
    if (id === 'added') continue;   // 既定なので else 側。分岐は持たない
    assert.ok(body.includes(`sort === '${id}'`), `母屋が作者の棚で ${id} を分岐していない`);
  }
  // 逆向き: 外した並びに母屋が対応したら、ここが落ちて「選択肢に戻せる」と言う
  for (const id of ['published', 'star', 'reread', 'finished']) {
    assert.ok(
      !body.includes(`sort === '${id}'`),
      `母屋が作者の棚で ${id} を分岐するようになった。FOLDER_SORTS に戻せる`,
    );
  }
});

test('覚えていた並び・種別は選択肢に照らしてから使う', () => {
  assert.match(SHELF, /sort: inList\(SORTS, read\('bunko\.sort', 'added'\), 'added'\)/,
    '消えた id を握ると釦だけが灯る');
  assert.match(SHELF, /type: inList\(TYPES, read\('bunko\.type', ''\), ''\)/,
    '消えた種別を握ると空の棚が返る');
  // 選択肢を決めた**後**に検めること (先に検めると前の画面の選択肢と突き合わせる)
  const reset = bodyOf(SHELF, 'function reset() {');
  assert.match(reset, /settleSort\(\);/, '棚を組み直す前に並びを落ち着かせること');
});

// ── 台帳を移る時に運べない語を落とす ────────────────────────
test('hitomi へ移る時に folder: の語を落とす (持ち越すと必ず 0 件になる)', () => {
  const drop = bodyOf(SHELF, 'function dropForeignTerms(query, to) {');
  assert.match(drop, /if \(to === 'paw'\) return/, 'paw へ移る時は落とさないこと');
  assert.match(drop, /word\.indexOf\('folder:'\) !== 0/, 'folder: を落とすこと');
  // 落ちた事が検索欄に映ること (机上版は札で見せる。こちらは欄が変わって伝わる)
  assert.match(SHELF, /qInput\.value = ported\.query;/, '落とした結果を検索欄に映すこと');
});
