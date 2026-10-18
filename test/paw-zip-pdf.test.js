'use strict';

// zip 配布の投稿 (サムネ 1 枚 + 本編 zip) を本の形に直す一手の契約を固定する。
// 実 zip を作って通すのは、綴じ順が展開器 (yauzl) の返す並びに左右されるから:
// 名前の比べ方を変えたときにここで気づけないと、章が交錯した本が黙って出来上がる。
//
// pdf-builder だけは差し替える (実物は electron の隠し窓で刷る)。控えには
// 頁の中身をそのまま残す: どの入り口がどの順で綴じられたかは名前では分からない

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yazl = require('yazl');

const PDF_BUILDER = require.resolve('../src/lib/pdf-builder');
const built = [];
require.cache[PDF_BUILDER] = {
  id: PDF_BUILDER,
  filename: PDF_BUILDER,
  loaded: true,
  exports: {
    buildPdf: async ({ pages, dest }) => {
      built.push({ dest, pages: pages.map((page) => fs.readFileSync(page.file, 'utf8')) });
      fs.writeFileSync(dest, `pdf:${pages.length}`);
    },
  },
};

const { convertZip } = require('../src/lib/paw-zip-pdf');

const roots = [];

test.after(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* 残っても次の走りが別の場所を切る */ }
  }
});

// 出す側 (staging) と置く側 (作者フォルダ) を分けて切る。実際の呼び手も別の場所
function setup(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `bunko-pawzip-${tag}-`));
  roots.push(root);
  const from = path.join(root, 'staging');
  const dest = path.join(root, 'out');
  fs.mkdirSync(from, { recursive: true });
  built.length = 0;
  return { root, from, dest };
}

// 実物の zip を作る。中身は「どの入り口か」が分かる文字列にしておく
function makeZip(dir, name, entries) {
  const file = path.join(dir, name);
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const [entryName, body] of entries) zip.addBuffer(Buffer.from(body), entryName);
    zip.end();
    const out = fs.createWriteStream(file);
    out.on('error', reject);
    out.on('close', () => resolve(file));
    zip.outputStream.on('error', reject);
    zip.outputStream.pipe(out);
  });
}

function listNames(dir) {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

test('絵だけの書庫: 1 冊に綴じ、綴じ順はフォルダが先 (章が交錯しない)', async () => {
  const box = setup('order');
  // 入り口の並びはわざと崩す。章ごとにフォルダを切る作者は珍しくないので、
  // 基準名だけで比べると A/1, B/1, A/2 … と章が混ざった本になる (旧実装の穴)
  const zip = await makeZip(box.from, 'pack.zip', [
    ['B/1.jpg', 'B-1'],
    ['A/2.jpg', 'A-2'],
    ['A/1.jpg', 'A-1'],
    ['B/2.jpg', 'B-2'],
    ['A/10.jpg', 'A-10'],
  ]);

  const made = await convertZip({ zipPath: zip, destDir: box.dest, stem: '[20260101] [1] 題+pack' });

  assert.strictEqual(made.pages, 5);
  assert.strictEqual(made.zip, null, '綴じられた書庫は残さない');
  assert.strictEqual(made.pdf, path.join(box.dest, '[20260101] [1] 題+pack【5P】.pdf'));
  assert.deepStrictEqual(listNames(box.dest), ['[20260101] [1] 題+pack【5P】.pdf']);
  // 数字は数として、フォルダは章として: A の中を 1,2,10 の順に読み切ってから B へ
  assert.deepStrictEqual(built[0].pages, ['A-1', 'A-2', 'A-10', 'B-1', 'B-2']);
});

test('絵と素材が混ざった書庫: 絵だけ綴じ、書庫も psd も txt も置かない', async () => {
  const box = setup('mixed');
  const zip = await makeZip(box.from, 'pack.zip', [
    ['1.jpg', 'img-1'],
    ['layers.psd', 'psd-bytes'],
    ['notes.txt', 'notes'],
    ['2.png', 'img-2'],
    ['movie.mp4', 'movie-bytes'],
  ]);

  const made = await convertZip({ zipPath: zip, destDir: box.dest, stem: '基+pack' });

  assert.strictEqual(made.pages, 2);
  assert.strictEqual(made.zip, null);
  assert.deepStrictEqual(built[0].pages, ['img-1', 'img-2']);
  // 置くのは綴じた本だけ。展開した残りも書庫の写しも棚に出さない
  assert.deepStrictEqual(listNames(box.dest), ['基+pack【2P】.pdf']);
});

test('0 バイトの絵は数に入れない (掴んだだけの欠片を白紙で綴じない)', async () => {
  const box = setup('empty-page');
  const zip = await makeZip(box.from, 'pack.zip', [
    ['1.jpg', 'img-1'],
    ['2.jpg', ''],
  ]);

  const made = await convertZip({ zipPath: zip, destDir: box.dest, stem: '基+pack' });

  assert.strictEqual(made.pages, 1);
  assert.deepStrictEqual(built[0].pages, ['img-1']);
  assert.deepStrictEqual(listNames(box.dest), ['基+pack【1P】.pdf']);
});

test('絵が 1 枚も無い書庫は書庫のまま置く (中身が丸ごと失われるのを防ぐ)', async () => {
  const box = setup('noimage');
  const zip = await makeZip(box.from, 'pack.zip', [
    ['notes.txt', 'notes'],
    ['layers.psd', 'psd-bytes'],
  ]);

  const made = await convertZip({ zipPath: zip, destDir: box.dest, stem: '基+pack' });

  assert.strictEqual(made.pdf, null);
  assert.strictEqual(made.pages, 0);
  assert.strictEqual(made.zip, path.join(box.dest, '基+pack.zip'));
  assert.deepStrictEqual(listNames(box.dest), ['基+pack.zip']);
  // 書き換えずにそのまま置く (原本は呼び手の staging に残っている)
  assert.deepStrictEqual(fs.readFileSync(made.zip), fs.readFileSync(zip));
  assert.deepStrictEqual(built, [], '綴じるものが無いので刷らない');
});

test('入り口の無い書庫も書庫のまま置く', async () => {
  const box = setup('noentry');
  const zip = await makeZip(box.from, 'pack.zip', []);

  const made = await convertZip({ zipPath: zip, destDir: box.dest, stem: '基+pack' });

  assert.strictEqual(made.pdf, null);
  assert.deepStrictEqual(listNames(box.dest), ['基+pack.zip']);
});

test('開けない書庫は分かる文言で失敗する (棚には何も置かない)', async () => {
  const box = setup('broken');
  // 落とし切れなかった 0 バイトの実体と、中身が書庫ではない実体。
  // どちらも「置くものが決められない」ので、黙って捨てずに呼び手へ返す
  const zero = path.join(box.from, 'zero.zip');
  fs.writeFileSync(zero, '');
  const garbage = path.join(box.from, 'garbage.zip');
  fs.writeFileSync(garbage, 'not a zip at all');

  for (const bad of [zero, garbage]) {
    await assert.rejects(
      () => convertZip({ zipPath: bad, destDir: box.dest, stem: '基+pack' }),
      (error) => {
        assert.ok(
          /ZIP の取り込みに失敗しました/.test(error.message),
          `失敗の言い分が分からない: ${error.message}`,
        );
        assert.ok(error.message.includes('基+pack'), 'どの添付で転んだか分からない');
        return true;
      },
    );
  }
  assert.deepStrictEqual(listNames(box.dest), [], '半端な置き土産は残さない');
});
