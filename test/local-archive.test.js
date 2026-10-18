'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const yazl = require('yazl');

const archive = require('../src/lib/local-archive');
const roots = [];

test.after(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* OS 終了時に解放される */ }
  }
});

function setup(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `bunko-local-archive-${tag}-`));
  roots.push(root);
  return root;
}

function makeZip(file, entries) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const [name, body] of entries) zip.addBuffer(Buffer.from(body), name);
    const out = fs.createWriteStream(file);
    out.on('error', reject);
    out.on('close', resolve);
    zip.outputStream.on('error', reject);
    zip.outputStream.pipe(out);
    zip.end();
  });
}

test('kindOf の同期公開契約と画像名フィルタを維持する', () => {
  const root = setup('kind');
  const image = path.join(root, 'cover.JPG');
  const text = path.join(root, 'memo.txt');
  fs.writeFileSync(image, 'image');
  fs.writeFileSync(text, 'text');

  assert.strictEqual(archive.kindOf(root), 'dir');
  assert.strictEqual(archive.kindOf(image), 'image');
  assert.strictEqual(archive.kindOf(text), null);
  assert.strictEqual(archive.kindOf(path.join(root, 'missing.zip')), null);
  assert.strictEqual(archive.isImageName('10.webp'), true);
  assert.strictEqual(archive.isImageName('.hidden.jpg'), false);
  assert.strictEqual(archive.isImageName('thumbnail-1.png'), false);
});

test('ディレクトリは自然順で読み、一覧変更を直ちに反映する', async () => {
  const root = setup('dir');
  fs.writeFileSync(path.join(root, '10.jpg'), 'ten');
  fs.writeFileSync(path.join(root, '2.png'), 'two');
  fs.writeFileSync(path.join(root, '1.webp'), 'one');
  fs.writeFileSync(path.join(root, '.3.jpg'), 'hidden');
  fs.writeFileSync(path.join(root, 'thumbnail.png'), 'thumb');
  fs.writeFileSync(path.join(root, 'info.json'), '{}');

  assert.strictEqual(await archive.pageCount(root), 3);
  const pages = await Promise.all([0, 1, 2].map((index) => archive.readPage(root, index)));
  assert.deepStrictEqual(pages.map((page) => page.name), ['1.webp', '2.png', '10.jpg']);
  assert.deepStrictEqual(pages.map((page) => page.bytes.toString()), ['one', 'two', 'ten']);
  assert.deepStrictEqual(pages.map((page) => page.type), ['image/webp', 'image/png', 'image/jpeg']);
  assert.strictEqual(await archive.readPage(root, -1), null);
  assert.strictEqual(await archive.readPage(root, 3), null);

  fs.writeFileSync(path.join(root, '3.jpg'), 'three');
  assert.strictEqual(await archive.pageCount(root), 4, '古い一覧を返さない');
  assert.strictEqual((await archive.readPage(root, 2)).name, '3.jpg');
});

test('単一画像を非同期で読み、範囲外と消失は null にする', async () => {
  const root = setup('image');
  const file = path.join(root, 'page.bmp');
  fs.writeFileSync(file, 'bmp');
  assert.strictEqual(await archive.pageCount(file), 1);
  assert.deepStrictEqual(await archive.readPage(file, 0), {
    bytes: Buffer.from('bmp'), type: 'image/bmp', name: 'page.bmp',
  });
  assert.strictEqual(await archive.readPage(file, 1), null);
  fs.unlinkSync(file);
  assert.strictEqual(await archive.pageCount(file), 0);
  assert.strictEqual(await archive.readPage(file, 0), null);
});

test('内部の stat が権限エラーでも従来どおり読めない対象として扱う', async () => {
  const original = fs.promises.stat;
  fs.promises.stat = async () => {
    const error = new Error('denied');
    error.code = 'EACCES';
    throw error;
  };
  try {
    assert.strictEqual(await archive.pageCount('denied.jpg'), 0);
    assert.strictEqual(await archive.readPage('denied.jpg', 0), null);
  } finally {
    fs.promises.stat = original;
  }
});

test('ZIP は自然順を保ち、同じ書庫のページを同時に読める', async () => {
  const root = setup('zip');
  const file = path.join(root, 'book.cbz');
  await makeZip(file, [
    ['B/1.jpg', 'B1'], ['A/10.jpg', 'A10'], ['A/2.png', 'A2'],
    ['A/1.webp', 'A1'], ['notes.txt', 'skip'], ['A/thumbnail.jpg', 'skip'],
  ]);

  assert.strictEqual(await archive.pageCount(file), 4);
  const pages = await Promise.all([3, 0, 2, 1].map((index) => archive.readPage(file, index)));
  assert.deepStrictEqual(pages.map((page) => page.bytes.toString()), ['B1', 'A1', 'A10', 'A2']);
  assert.deepStrictEqual(pages.map((page) => page.name), ['1.jpg', '1.webp', '10.jpg', '2.png']);
  assert.strictEqual(await archive.readPage(file, 4), null);
});

test('壊れた ZIP の失敗をキャッシュせず、LRU 上限を守る', () => {
  const root = setup('lru-child');
  const script = String.raw`
    const fs = require('fs');
    const path = require('path');
    const yazl = require('yazl');
    const archive = require(${JSON.stringify(require.resolve('../src/lib/local-archive'))});
    const root = process.argv[1];
    function makeZip(file, body) {
      return new Promise((resolve, reject) => {
        const zip = new yazl.ZipFile();
        zip.addBuffer(Buffer.from(body), '1.jpg');
        const out = fs.createWriteStream(file);
        out.on('error', reject); out.on('close', resolve);
        zip.outputStream.on('error', reject); zip.outputStream.pipe(out); zip.end();
      });
    }
    (async () => {
      const bad = path.join(root, 'bad.zip');
      fs.writeFileSync(bad, 'broken');
      for (let i = 0; i < 2; i += 1) await archive.pageCount(bad).then(
        () => { throw new Error('broken zip resolved'); },
        () => {},
      );
      const files = [];
      for (let i = 0; i < 55; i += 1) {
        const file = path.join(root, i + '.zip');
        await makeZip(file, String(i));
        files.push(file);
      }
      const bodies = await Promise.all(files.map((file) => archive.readPage(file, 0)));
      if (bodies.some((page, i) => page.bytes.toString() !== String(i))) throw new Error('concurrent read mismatch');
      if (archive.openZipCount() > 48) throw new Error('LRU limit: ' + archive.openZipCount());
    })().catch((error) => { console.error(error.stack); process.exitCode = 1; });
  `;
  const result = spawnSync(process.execPath, ['-e', script, root], { encoding: 'utf8', timeout: 30000 });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
});
