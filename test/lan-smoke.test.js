'use strict';

// 手のひら版 (src/lan/shelf.js 1,526 行 + read.js 1,426 行) の煙試験。
// ここは長らく試験 0 で、机上版と同じ役目を別に書いてある面。
// 押さえるのは「読めること」と「窓口が居ること」と「触って落ちないこと」だけ。
// 画面の中身は見ない (実機での試写は scripts/lan-preview.js が担う)。

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadInVm } = require('./helpers/vm-dom');

function lan({ fetchImpl } = {}) {
  const asked = [];
  const ctx = loadInVm('src/lan/read.js', {
    globals: {
      BUNKO: {},
      fetch: fetchImpl || ((url) => {
        asked.push(String(url));
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ items: [], total: 0, pages: 0 }),
          text: async () => '',
        });
      }),
    },
  });
  ctx.asked = asked;
  return ctx;
}

test('棚と読み手が同じ窓で読め、窓口を置く', () => {
  const ctx = lan();
  assert.equal(typeof ctx.BUNKO.shelf, 'object', '棚の窓口が居る');
  assert.equal(typeof ctx.BUNKO.shelf.neighbor, 'function');
  assert.equal(typeof ctx.BUNKO.shelf.readerClosed, 'function');
  assert.equal(typeof ctx.BUNKO.reader, 'object', '読み手の窓口が居る');
  assert.equal(typeof ctx.BUNKO.reader.open, 'function');
  ctx.__stopTimers();
});

test('読み込んだだけでは棚を引きに行かない (harness の印が効いている)', () => {
  const ctx = lan();
  assert.deepEqual(ctx.asked, [], '網を一度も叩かない');
  ctx.__stopTimers();
});

test('中身の無い本を渡しても読み手は落ちない', () => {
  const ctx = lan();
  assert.doesNotThrow(() => ctx.BUNKO.reader.open(null));
  assert.doesNotThrow(() => ctx.BUNKO.reader.open({}));
  assert.doesNotThrow(() => ctx.BUNKO.reader.open({ id: null }));
  ctx.__stopTimers();
});

test('棚の隣り合わせは、知らない本を訊かれても落ちない', () => {
  const ctx = lan();
  assert.doesNotThrow(() => ctx.BUNKO.shelf.neighbor('知らない id', 1));
  assert.doesNotThrow(() => ctx.BUNKO.shelf.readerClosed());
  ctx.__stopTimers();
});

test('本が開けない時は理由を言い、もう一度を出す (黙って閉じない)', () => {
  const ctx = lan();
  assert.equal(typeof ctx.BUNKO.shelf.say, 'function', '理由を出す口がある');
  // 帯を新しく作らず、棚の note を借りる (高さを増やさない)
  const note = ctx.byId('note');
  ctx.BUNKO.shelf.say('母艦につながりません', { retry: () => {} });
  assert.equal(note.textContent, '母艦につながりません');
  assert.equal(note.children.length, 1, 'もう一度が添う');
  ctx.__stopTimers();
});

test('失敗の顔を分ける (合言葉切れ・母艦が寝ている・本が無い)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const read = fs.readFileSync(path.join(__dirname, '..', 'src', 'lan', 'read.js'), 'utf8');
  assert.match(read, /合言葉が切れました/);
  assert.match(read, /見えなくなっています/);
  assert.match(read, /つながりません/);
  // 黙って閉じる道が残っていないこと
  assert.ok(
    !/\.catch\(function \(\) \{\s*stopSpin\(\);\s*closeReader\(\);\s*\}\)/.test(read),
    '理由を出さずに閉じる道が残っている',
  );
});

// 前の作品へ巻き戻って最終頁から入っただけでは読了にしない (机上版と同じ決まり)。
// 頁を一度でも動かしてから最終頁へ進めば、今までどおり読了
function lanBook() {
  const saved = [];
  const ctx = loadInVm('src/lan/read.js', {
    globals: {
      BUNKO: {},
      history: { pushState() {}, back() {}, replaceState() {}, state: null },
      fetch: (url, opts) => {
        if (String(url).startsWith('/api/book/')) {
          return Promise.resolve({ ok: true, status: 200, json: async () => ({ id: 'a', title: 'a', pageCount: 3, reading: null }) });
        }
        if (String(url).startsWith('/api/reading/')) saved.push(JSON.parse(opts.body));
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ items: [], total: 0, pages: 0 }) });
      },
    },
  });
  const marks = [];
  ctx.BUNKO.shelf.readerClosed = (mark) => marks.push(mark);
  return { ctx, saved, marks };
}

test('手のひら: 前へ巻き戻って最終頁から入り、頁を動かさずに閉じても読了と伝えない', async () => {
  const { ctx, saved, marks } = lanBook();
  ctx.BUNKO.reader.open({ id: 'a', title: 'a', pageCount: 3 }, { start: 'last' });
  await new Promise((r) => setTimeout(r, 20));
  ctx.BUNKO.reader.close();
  ctx.dispatch('popstate');
  assert.equal(marks.length, 1);
  assert.equal(marks[0].page, 2, '最終頁に居た');
  assert.equal(marks[0].finished, false, '入っただけでは読了にしない');
  assert.deepEqual(saved, [], '開いただけでは書き戻さない');
  ctx.__stopTimers();
});

test('手のひら: 最終頁から入っても、一度戻って最終頁へ進めば読了', async () => {
  const { ctx, saved, marks } = lanBook();
  ctx.BUNKO.reader.open({ id: 'a', title: 'a', pageCount: 3 }, { start: 'last' });
  await new Promise((r) => setTimeout(r, 20));
  // 既定は右綴じ: → で戻り、← で進む
  ctx.dispatch('keydown', { key: 'ArrowRight' });
  ctx.dispatch('keydown', { key: 'ArrowLeft' });
  ctx.BUNKO.reader.close();
  ctx.dispatch('popstate');
  assert.equal(marks[0].finished, true);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].finished, true, '進んで最終頁に着いたら読了を書く');
  ctx.__stopTimers();
});
