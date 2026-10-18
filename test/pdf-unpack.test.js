'use strict';

// pdf-unpack: PDF から頁の絵を pdf.js に描かせずに抜く。
// ここで固定するのは三つ:
//   1. 綴じ方の読み (古典 xref / xref stream / object stream / 予測子 / 走査の保険 / 入れ子の木)
//   2. 「絵 1 枚で全面」の見極め (文字・図形・切り抜き・斜め・複数の絵がある頁は抜かない)
//   3. 抜けない時は理由を返し、呼び手が焼き場へ回せること

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const pdfUnpack = require('../src/lib/pdf-unpack');
const {
  toBgra, unwrap, own, renderBase, dctMask, shrink, hasSharp,
} = require('../src/lib/pdf-unpack-worker');
const { unpredict } = require('../src/lib/pdf-predictor');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-unpack-'));
test.after(async () => {
  await pdfUnpack.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// 4x3 の RGB (行ごとに赤・緑・青)
const W = 4;
const H = 3;
const RGB = Buffer.alloc(W * H * 3);
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) RGB[(y * W + x) * 3 + y] = 255;
}
const FLATE = zlib.deflateSync(RGB);
const GRAY = Buffer.alloc(W * H, 255);
const GRAY_FLATE = zlib.deflateSync(GRAY);

// 4x3 の JPEG の骨だけ (SOI, SOF0, EOI)。寸法が読めれば足りる
const JPEG = Buffer.from([
  0xff, 0xd8,
  0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x03, 0x00, 0x04, 0x01, 0x01, 0x11, 0x00,
  0xff, 0xd9,
]);
const JPEG_IN_FLATE = zlib.deflateSync(JPEG);

function stream(dict, bytes) {
  return Buffer.concat([
    Buffer.from(`<<${dict} /Length ${bytes.length}>>\nstream\n`, 'latin1'),
    bytes,
    Buffer.from('\nendstream', 'latin1'),
  ]);
}

const IMAGE_HEAD = '/Type /XObject /Subtype /Image /Width 4 /Height 3 /BitsPerComponent 8';
const flateImage = (extra = '') => stream(`${IMAGE_HEAD} /ColorSpace /DeviceRGB /Filter /FlateDecode${extra}`, FLATE);
const jpegImage = (extra = '') => stream(`${IMAGE_HEAD} /ColorSpace /DeviceRGB /Filter /DCTDecode${extra}`, JPEG);

// 絵 1 枚を紙いっぱいに貼るだけの内容ストリーム (実物と同じ形)
const fullPage = (name = 'X', extra = '') => stream('', Buffer.from(`q ${extra}4 0 0 3 0 0 cm /${name} Do Q`, 'latin1'));

// 番号順に obj を並べ、xref と trailer を正しい位置で書く (古典 xref)
function writePdf(name, objects, { breakXref = false } = {}) {
  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets = [];
  let at = parts[0].length;
  objects.forEach((body, i) => {
    offsets.push(at);
    const chunk = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`, 'latin1'),
      Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'),
      Buffer.from('\nendobj\n', 'latin1'),
    ]);
    parts.push(chunk);
    at += chunk.length;
  });
  const xrefAt = at;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<</Size ${objects.length + 1} /Root 1 0 R>>\nstartxref\n${breakXref ? xrefAt + 7 : xrefAt}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.concat(parts));
  return file;
}

// 1: Catalog / 2: Pages (Resources を持つ) / 3..: 頁 / 絵と内容
const BOOK = [
  '<</Type /Catalog /Pages 2 0 R>>',
  '<</Type /Pages /Count 3 /Kids [3 0 R 4 0 R 5 0 R] /Resources <</XObject <</X 9 0 R>>>>>>',
  // 頁 A: 自前の Resources。Length が参照、色空間は ICCBased
  '<</Type /Page /Parent 2 0 R /MediaBox [0 0 4 3] /Resources <</XObject <</X 6 0 R>>>> /Contents 7 0 R>>',
  // 頁 B: Resources は親から (JPEG)。内容に切り抜き (紙いっぱい) が入る
  '<</Type /Page /Parent 2 0 R /MediaBox [0 0 4 3] /Contents 8 0 R>>',
  // 頁 C: 透過つき
  '<</Type /Page /Parent 2 0 R /MediaBox [0 0 4 3] /Resources <</XObject <</X 10 0 R>>>> /Contents 7 0 R>>',
  Buffer.concat([
    Buffer.from(`<<${IMAGE_HEAD} /ColorSpace [/ICCBased 12 0 R] /Filter /FlateDecode /Length 11 0 R>>\nstream\r\n`, 'latin1'),
    FLATE, Buffer.from('\nendstream', 'latin1'),
  ]),
  fullPage('X'),
  stream('', Buffer.from('q 0 0 4 3 re W n /Perceptual ri q 4 0 0 3 0 0 cm /X Do Q Q', 'latin1')),
  jpegImage(),
  stream(`${IMAGE_HEAD} /ColorSpace /DeviceRGB /Filter /FlateDecode /SMask 13 0 R`, FLATE),
  String(FLATE.length),
  stream('/N 3 /Alternate /DeviceRGB', Buffer.from('icc')),
  stream(`${IMAGE_HEAD} /ColorSpace /DeviceGray /Filter /FlateDecode`, GRAY_FLATE),
];

const book = writePdf('book.pdf', BOOK);

test('頁数と縦横比は MediaBox から引ける', async () => {
  assert.strictEqual(await pdfUnpack.pageCount(book), 3);
  assert.deepStrictEqual(await pdfUnpack.pageShapes(book), { pageCount: 3, ratios: [1.333, 1.333, 1.333] });
});

test('Flate の絵: 参照の Length と ICCBased の N を辿って本体を抜く', async () => {
  const image = await pdfUnpack.readPageImage(book, 0);
  assert.ok(image);
  assert.strictEqual(image.codec, 'flate');
  assert.strictEqual(image.channels, 3);
  assert.strictEqual(image.width, 4);
  assert.ok(image.bytes.equals(FLATE), 'stream の本体がそのまま取れる (CRLF の後から)');
});

test('Resources を親から継ぎ、紙いっぱいの切り抜きがある頁の JPEG はそのまま', async () => {
  const image = await pdfUnpack.readPageImage(book, 1);
  assert.ok(image);
  assert.strictEqual(image.codec, 'dct');
  assert.ok(image.bytes.equals(JPEG));
  const page = await pdfUnpack.unpackPage(book, 1, { width: 0 });
  assert.deepStrictEqual(page, { bytes: JPEG, type: 'image/jpeg' }, '原寸なら符号化せず原本のまま');
});

test('透過 (SMask) つきの絵は、透過も一緒に抜いてくる', async () => {
  const detail = await pdfUnpack.readPageDetail(book, 2);
  assert.ok(!detail.reason, detail.reason);
  assert.ok(detail.smask, '透過の素性が付く');
  assert.strictEqual(detail.smask.channels, 1);
  assert.ok(detail.smaskBytes.equals(GRAY_FLATE));
});

test('無い頁は理由つきで断る', async () => {
  assert.strictEqual(await pdfUnpack.readPageImage(book, 9), null);
  assert.deepStrictEqual(await pdfUnpack.inspectPage(book, 9), { ok: false, reason: 'no-page' });
});

test('startxref が壊れていても全体の走査で読める', async () => {
  const broken = writePdf('broken.pdf', BOOK, { breakXref: true });
  assert.strictEqual(await pdfUnpack.pageCount(broken), 3);
  const image = await pdfUnpack.readPageImage(broken, 0);
  assert.ok(image && image.bytes.equals(FLATE));
});

test('差し替わった本は開き直す (取り込み直しの合図か、憶え書きが切れた後)', async () => {
  const file = writePdf('swap.pdf', BOOK);
  assert.strictEqual(await pdfUnpack.pageCount(file), 3);
  const fewer = BOOK.slice();
  fewer[1] = '<</Type /Pages /Count 1 /Kids [3 0 R] /Resources <</XObject <</X 9 0 R>>>>>>';
  writePdf('swap.pdf', fewer);
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(file, future, future);
  // 実体を訊き直すのは数秒に一度なので、直後は前の本のまま (SMB の往復を減らすため)
  pdfUnpack.forget(file);
  assert.strictEqual(await pdfUnpack.pageCount(file), 1);
});

test('同じ本を同時にたくさん開いても、使っている間は閉じない', async () => {
  // 貸出を数えずに古い順で閉じると、読んでいる最中の fd が落ちて頁が出なくなる
  const files = [];
  for (let i = 0; i < 8; i += 1) files.push(writePdf(`many-${i}.pdf`, BOOK));
  const jobs = [];
  for (const file of files) {
    for (let i = 0; i < 3; i += 1) jobs.push(pdfUnpack.inspectPage(file, i % 3));
  }
  const got = await Promise.all(jobs);
  const bad = got.filter((row) => !row.ok && row.reason !== 'smask-codec');
  assert.deepStrictEqual(bad, [], '閉じられた fd による取りこぼしが無い');
});

// ── 絵 1 枚で全面か ────────────────────────────────────────────
// 抜いてよいのは「絵 1 枚を紙いっぱいに貼っただけ」の頁に限る。
// それ以外で絵だけ出すと、読み手が見るはずの頁と違うものが出る

const CASES = [
  ['文字が重なる頁', stream('', Buffer.from('q 4 0 0 3 0 0 cm /X Do Q BT /F1 12 Tf (x) Tj ET', 'latin1')), 'text'],
  ['図形を塗る頁', stream('', Buffer.from('0 0 4 3 re f q 4 0 0 3 0 0 cm /X Do Q', 'latin1')), 'paint'],
  ['絵を二枚貼る頁', stream('', Buffer.from('q 4 0 0 3 0 0 cm /X Do Q q 2 0 0 1 0 0 cm /X Do Q', 'latin1')), 'draws:2'],
  ['絵が紙より小さい頁', stream('', Buffer.from('q 2 0 0 1 0 0 cm /X Do Q', 'latin1')), 'not-full-page'],
  ['絵が斜めの頁', stream('', Buffer.from('q 3 1 1 3 0 0 cm /X Do Q', 'latin1')), 'skewed'],
  ['絵が裏返しの頁', stream('', Buffer.from('q 4 0 0 -3 0 3 cm /X Do Q', 'latin1')), 'skewed'],
  ['絵を貼らない頁', stream('', Buffer.from('0 0 4 3 re n', 'latin1')), 'draws:0'],
  ['埋め込みの絵 (BI) がある頁', stream('', Buffer.from('BI /W 4 /H 3 ID xxxx EI', 'latin1')), 'inline-image'],
];

for (const [name, contents, reason] of CASES) {
  test(`抜かない: ${name}`, async () => {
    const objects = [
      '<</Type /Catalog /Pages 2 0 R>>',
      '<</Type /Pages /Count 1 /Kids [3 0 R]>>',
      '<</Type /Page /Parent 2 0 R /MediaBox [0 0 4 3] /Resources <</XObject <</X 4 0 R>>>> /Contents 5 0 R>>',
      flateImage(),
      contents,
    ];
    const file = writePdf(`case-${reason.replace(/[^a-z0-9]/gi, '-')}.pdf`, objects);
    assert.deepStrictEqual(await pdfUnpack.inspectPage(file, 0), { ok: false, reason });
  });
}

test('抜かない: 紙の一部だけ切り抜く頁', async () => {
  const objects = [
    '<</Type /Catalog /Pages 2 0 R>>',
    '<</Type /Pages /Count 1 /Kids [3 0 R]>>',
    '<</Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources <</XObject <</X 4 0 R>>>> /Contents 5 0 R>>',
    flateImage(),
    stream('', Buffer.from('q 50 50 200 150 re W n q 400 0 0 300 0 0 cm /X Do Q Q', 'latin1')),
  ];
  const file = writePdf('case-clipped.pdf', objects);
  assert.deepStrictEqual(await pdfUnpack.inspectPage(file, 0), { ok: false, reason: 'clipped' });
});

test('抜く: 紙いっぱいの切り抜きは邪魔をしない', async () => {
  const objects = [
    '<</Type /Catalog /Pages 2 0 R>>',
    '<</Type /Pages /Count 1 /Kids [3 0 R]>>',
    '<</Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources <</XObject <</X 4 0 R>>>> /Contents 5 0 R>>',
    flateImage(),
    stream('', Buffer.from('q 0 0 400 300 re W n q 400 0 0 300 0 0 cm /X Do Q Q', 'latin1')),
  ];
  const file = writePdf('case-clip-full.pdf', objects);
  assert.strictEqual((await pdfUnpack.inspectPage(file, 0)).ok, true);
});

// 切り抜きは「四角でありさえすれば」通す。書き方 (re か直線か) と、
// 効く範囲 (q/Q の中だけか) を取り違えると、全部焼き場に落ちて遅くなる
const CLIP_CASES = [
  ['直線で書いた紙いっぱいの切り抜き', 'q 0 0 m 400 0 l 400 300 l 0 300 l h W n q 400 0 0 300 0 0 cm /X Do Q Q', true],
  ['閉じた点が先頭と重なる書き方', 'q 0 0 m 400 0 l 400 300 l 0 300 l 0 0 l W n q 400 0 0 300 0 0 cm /X Do Q Q', true],
  ['絵とは別の q..Q の中の小さな切り抜き', 'q 5 5 10 10 re W n Q q 400 0 0 300 0 0 cm /X Do Q', true],
  ['紙の一部だけを直線で切り抜く', 'q 50 50 m 200 50 l 200 150 l 50 150 l h W n q 400 0 0 300 0 0 cm /X Do Q Q', false],
  ['曲線で切り抜く (形が読めない)', 'q 0 0 m 400 0 c 400 300 0 300 0 0 h W n q 400 0 0 300 0 0 cm /X Do Q Q', false],
];

for (const [name, ops, ok] of CLIP_CASES) {
  test(`切り抜き: ${name} → ${ok ? '抜く' : '焼き場へ'}`, async () => {
    const objects = [
      '<</Type /Catalog /Pages 2 0 R>>',
      '<</Type /Pages /Count 1 /Kids [3 0 R]>>',
      '<</Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources <</XObject <</X 4 0 R>>>> /Contents 5 0 R>>',
      flateImage(),
      stream('', Buffer.from(ops, 'latin1')),
    ];
    const file = writePdf(`clip-${Buffer.from(name).toString('hex').slice(0, 12)}.pdf`, objects);
    const looked = await pdfUnpack.inspectPage(file, 0);
    assert.strictEqual(looked.ok, ok, `reason=${looked.reason}`);
  });
}

test('抜かない: 回した頁 (Rotate)', async () => {
  const objects = [
    '<</Type /Catalog /Pages 2 0 R>>',
    '<</Type /Pages /Count 1 /Kids [3 0 R]>>',
    '<</Type /Page /Parent 2 0 R /MediaBox [0 0 4 3] /Rotate 90 /Resources <</XObject <</X 4 0 R>>>> /Contents 5 0 R>>',
    flateImage(),
    fullPage(),
  ];
  const file = writePdf('case-rotate.pdf', objects);
  assert.deepStrictEqual(await pdfUnpack.inspectPage(file, 0), { ok: false, reason: 'rotate:90' });
});

test('抜かない: CropBox が紙より小さい頁', async () => {
  const objects = [
    '<</Type /Catalog /Pages 2 0 R>>',
    '<</Type /Pages /Count 1 /Kids [3 0 R]>>',
    '<</Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /CropBox [50 50 350 250] /Resources <</XObject <</X 4 0 R>>>> /Contents 5 0 R>>',
    flateImage(),
    stream('', Buffer.from('q 400 0 0 300 0 0 cm /X Do Q', 'latin1')),
  ];
  const file = writePdf('case-crop.pdf', objects);
  assert.deepStrictEqual(await pdfUnpack.inspectPage(file, 0), { ok: false, reason: 'not-full-page' });
});

test('抜かない: 見慣れない解き方 (JPEG2000) は理由を名指しする', async () => {
  const objects = [
    '<</Type /Catalog /Pages 2 0 R>>',
    '<</Type /Pages /Count 1 /Kids [3 0 R]>>',
    '<</Type /Page /Parent 2 0 R /MediaBox [0 0 4 3] /Resources <</XObject <</X 4 0 R>>>> /Contents 5 0 R>>',
    stream('/Type /XObject /Subtype /Image /Width 4 /Height 3 /Filter /JPXDecode', Buffer.from('jp2')),
    fullPage(),
  ];
  const file = writePdf('case-jpx.pdf', objects);
  assert.deepStrictEqual(await pdfUnpack.inspectPage(file, 0), { ok: false, reason: 'filter:JPXDecode' });
  // 焼き場へ回した本は、理由つきで一覧に出る (設定の棚卸し用)
  await pdfUnpack.unpackPage(file, 0, { width: 0 });
  assert.ok(pdfUnpack.fallbacks().some((row) => row.file === file && row.reason === 'filter:JPXDecode'));
});

test('抜く: JPEG を Flate で包み直した本 ([/FlateDecode /DCTDecode])', async () => {
  const objects = [
    '<</Type /Catalog /Pages 2 0 R>>',
    '<</Type /Pages /Count 1 /Kids [3 0 R]>>',
    '<</Type /Page /Parent 2 0 R /MediaBox [0 0 4 3] /Resources <</XObject <</X 4 0 R>>>> /Contents 5 0 R>>',
    stream(`${IMAGE_HEAD} /ColorSpace /DeviceRGB /Filter [/FlateDecode /DCTDecode]`, JPEG_IN_FLATE),
    fullPage(),
  ];
  const file = writePdf('case-chain.pdf', objects);
  const looked = await pdfUnpack.inspectPage(file, 0);
  assert.strictEqual(looked.ok, true);
  assert.strictEqual(looked.codec, 'dct');
  assert.strictEqual(looked.preFlate, true);
  const page = await pdfUnpack.unpackPage(file, 0, { width: 0 });
  assert.ok(page && page.bytes.equals(JPEG), '外側をほどいた JPEG がそのまま出る');
});

test('抜く: 予測子つきの Flate (DecodeParms)', async () => {
  // PNG の Up (2) で行ごとに上との差にする
  const rowLen = W * 3;
  const rows = [];
  let prev = Buffer.alloc(rowLen);
  for (let y = 0; y < H; y += 1) {
    const cur = RGB.subarray(y * rowLen, (y + 1) * rowLen);
    rows.push(Buffer.from([2]), Buffer.from(cur.map((v, i) => (v - prev[i]) & 0xff)));
    prev = cur;
  }
  const packed = zlib.deflateSync(Buffer.concat(rows));
  const objects = [
    '<</Type /Catalog /Pages 2 0 R>>',
    '<</Type /Pages /Count 1 /Kids [3 0 R]>>',
    '<</Type /Page /Parent 2 0 R /MediaBox [0 0 4 3] /Resources <</XObject <</X 4 0 R>>>> /Contents 5 0 R>>',
    stream(`${IMAGE_HEAD} /ColorSpace /DeviceRGB /Filter /FlateDecode /DecodeParms <</Predictor 12 /Columns 4 /Colors 3>>`, packed),
    fullPage(),
  ];
  const file = writePdf('case-predictor.pdf', objects);
  const looked = await pdfUnpack.inspectPage(file, 0);
  assert.strictEqual(looked.ok, true);
  assert.strictEqual(looked.predictor, true);
  const detail = await pdfUnpack.readPageDetail(file, 0);
  const bgra = toBgra({ base: { bytes: detail.bytes, codec: 'flate', channels: 3, width: 4, height: 3, predictor: detail.predictor }, smask: null });
  assert.deepStrictEqual([...bgra.subarray(0, 4)], [0, 0, 255, 255], '1 行目は赤に戻る');
});

// ── PDF 1.5 以降の綴じ方 ──────────────────────────────────────
// 頁の辞書は object stream の中、索引は xref stream。外から来た本はこの形

function writeModernPdf(name, { predictor = false, breakXref = false } = {}) {
  const inner = [
    [1, '<</Type /Catalog /Pages 2 0 R>>'],
    [2, '<</Type /Pages /Count 2 /Kids [3 0 R 4 0 R] /Resources <</XObject <</X 6 0 R>>>>>>'],
    [3, '<</Type /Page /Parent 2 0 R /MediaBox [0 0 4 3] /Resources <</XObject <</X 5 0 R>>>> /Contents 9 0 R>>'],
    [4, '<</Type /Page /Parent 2 0 R /MediaBox [0 0 4 3] /Contents 9 0 R>>'],
  ];
  let header = '';
  let body = '';
  for (const [num, text] of inner) {
    header += `${num} ${body.length} `;
    body += `${text}\n`;
  }
  const objstm = stream(
    `/Type /ObjStm /N ${inner.length} /First ${header.length} /Filter /FlateDecode`,
    zlib.deflateSync(Buffer.from(header + body, 'latin1')),
  );

  const parts = [Buffer.from('%PDF-1.5\n', 'latin1')];
  let at = parts[0].length;
  const offsets = new Map();
  const put = (num, body2) => {
    offsets.set(num, at);
    const chunk = Buffer.concat([Buffer.from(`${num} 0 obj\n`, 'latin1'), body2, Buffer.from('\nendobj\n', 'latin1')]);
    parts.push(chunk);
    at += chunk.length;
  };
  put(5, jpegImage());
  put(6, flateImage());
  put(7, objstm);
  put(9, fullPage());
  const xrefAt = at;
  const row = (type, f2, f3) => Buffer.from([type, (f2 >> 8) & 0xff, f2 & 0xff, f3]);
  const rows = [];
  rows[0] = row(0, 0, 255);
  inner.forEach(([num], i) => { rows[num] = row(2, 7, i); });
  for (const num of [5, 6, 7, 9]) rows[num] = row(1, offsets.get(num), 0);
  rows[8] = row(0, 0, 255);
  rows[10] = row(1, xrefAt, 0);
  let table = Buffer.concat(rows);
  let parms = '';
  if (predictor) {
    const width = 4;
    const out = [];
    let prev = Buffer.alloc(width);
    for (let r = 0; r < rows.length; r += 1) {
      const cur = table.subarray(r * width, (r + 1) * width);
      out.push(Buffer.from([2]), Buffer.from(cur.map((v, i) => (v - prev[i]) & 0xff)));
      prev = cur;
    }
    table = Buffer.concat(out);
    parms = ' /DecodeParms <</Predictor 12 /Columns 4>>';
  }
  put(10, stream(`/Type /XRef /Size 11 /W [1 2 1] /Root 1 0 R /Filter /FlateDecode${parms}`, zlib.deflateSync(table)));
  parts.push(Buffer.from(`startxref\n${breakXref ? xrefAt + 3 : xrefAt}\n%%EOF\n`, 'latin1'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.concat(parts));
  return file;
}

test('xref stream + object stream の本を読む', async () => {
  const file = writeModernPdf('modern.pdf');
  assert.deepStrictEqual(await pdfUnpack.pageShapes(file), { pageCount: 2, ratios: [1.333, 1.333] });
  const a = await pdfUnpack.readPageImage(file, 0);
  assert.ok(a && a.codec === 'dct' && a.bytes.equals(JPEG));
  const b = await pdfUnpack.readPageImage(file, 1);
  assert.ok(b && b.codec === 'flate' && b.bytes.equals(FLATE), '親の Resources から辿れる');
});

test('xref stream の PNG 予測子 (Up) を戻せる', async () => {
  const file = writeModernPdf('modern-pred.pdf', { predictor: true });
  assert.strictEqual(await pdfUnpack.pageCount(file), 2);
  const a = await pdfUnpack.readPageImage(file, 0);
  assert.ok(a && a.bytes.equals(JPEG));
});

test('xref stream が壊れていても、走査で object stream の中まで見て読める', async () => {
  const file = writeModernPdf('modern-broken.pdf', { breakXref: true });
  assert.strictEqual(await pdfUnpack.pageCount(file), 2);
  const b = await pdfUnpack.readPageImage(file, 1);
  assert.ok(b && b.bytes.equals(FLATE));
});

test('入れ子の頁の木 (葉と節が混ざる) でも順番どおりに読める', async () => {
  const objects = [
    '<</Type /Catalog /Pages 2 0 R>>',
    '<</Type /Pages /Count 3 /Kids [3 0 R 6 0 R]>>',
    '<</Type /Pages /Count 2 /Kids [4 0 R 5 0 R]>>',
    '<</Type /Page /Parent 3 0 R /MediaBox [0 0 4 3] /Resources <</XObject <</X 7 0 R>>>> /Contents 8 0 R>>',
    '<</Type /Page /Parent 3 0 R /MediaBox [0 0 4 3] /Resources <</XObject <</X 9 0 R>>>> /Contents 8 0 R>>',
    '<</Type /Page /Parent 2 0 R /MediaBox [0 0 4 3] /Resources <</XObject <</X 7 0 R>>>> /Contents 8 0 R>>',
    flateImage(),
    fullPage(),
    jpegImage(),
  ];
  const file = writePdf('nested.pdf', objects);
  assert.strictEqual(await pdfUnpack.pageCount(file), 3);
  assert.strictEqual((await pdfUnpack.readPageImage(file, 0)).codec, 'flate');
  assert.strictEqual((await pdfUnpack.readPageImage(file, 1)).codec, 'dct');
  assert.strictEqual((await pdfUnpack.readPageImage(file, 2)).codec, 'flate');
});

// ── worker と予測子 ───────────────────────────────────────────

test('worker: Flate の RGB を BGRA に並べ直す / Gray は三つに広げる', () => {
  const bgra = toBgra({ base: { bytes: FLATE, codec: 'flate', channels: 3, width: 4, height: 3 }, smask: null });
  assert.strictEqual(bgra.length, 4 * 3 * 4);
  assert.deepStrictEqual([...bgra.subarray(0, 4)], [0, 0, 255, 255], '1 行目は赤 (B,G,R,A)');
  assert.deepStrictEqual([...bgra.subarray(8 * 4, 8 * 4 + 4)], [255, 0, 0, 255], '3 行目は青');
  const gray = toBgra({ base: { bytes: Buffer.from([7, 9]), codec: 'raw', channels: 1, width: 2, height: 1 }, smask: null });
  assert.deepStrictEqual([...gray], [7, 7, 7, 255, 9, 9, 9, 255]);
  assert.throws(
    () => toBgra({ base: { bytes: Buffer.alloc(2), codec: 'raw', channels: 3, width: 2, height: 1 }, smask: null } ),
    /画素が足りない/,
  );
});

test('worker: 透過は白い紙に重ねて潰す', () => {
  const base = Buffer.from([0, 0, 0, 0, 0, 0]);            // 黒 2 画素
  const alpha = Buffer.from([255, 0]);                      // 左は不透明、右は透明
  const out = toBgra({
    base: { bytes: base, codec: 'raw', channels: 3, width: 2, height: 1 },
    smask: { bytes: alpha, codec: 'raw', channels: 1, width: 2, height: 1 },
  });
  assert.deepStrictEqual([...out], [0, 0, 0, 255, 255, 255, 255, 255]);
});

test('worker: 二段フィルタの外側をほどくだけの仕事', () => {
  assert.ok(unwrap({ codec: 'flate', bytes: JPEG_IN_FLATE }).equals(JPEG));
  assert.ok(unwrap({ codec: 'raw', bytes: JPEG }).equals(JPEG));
});

test('予測子: PNG の Up と TIFF の左差分を戻す', () => {
  const png = Buffer.from([2, 10, 20, 2, 1, 2]);            // 行 1: そのまま / 行 2: 上との差
  assert.deepStrictEqual([...unpredict(png, 12, 2, 1, 8)], [10, 20, 11, 22]);
  const tiff = Buffer.from([10, 5, 3]);
  assert.deepStrictEqual([...unpredict(tiff, 2, 3, 1, 8)], [10, 15, 18]);
  assert.deepStrictEqual([...unpredict(Buffer.from([1, 2]), 1, 2, 1, 8)], [1, 2], '1 は何もしない');
});

test('暗号化された本には手を出さない (焼き場へ)', async () => {
  const objects = BOOK.slice();
  const file = writePdf('encrypted.pdf', objects);
  const raw = fs.readFileSync(file).toString('latin1')
    .replace('/Root 1 0 R>>', '/Root 1 0 R /Encrypt 20 0 R>>');
  fs.writeFileSync(file, Buffer.from(raw, 'latin1'));
  const looked = await pdfUnpack.inspectPage(file, 0);
  assert.strictEqual(looked.ok, false);
  assert.match(looked.reason, /encrypted|no root/);
});

test('頁の Resources で名前を付けた色空間 (/CS0) も辿れる', async () => {
  const objects = [
    '<</Type /Catalog /Pages 2 0 R>>',
    '<</Type /Pages /Count 1 /Kids [3 0 R]>>',
    '<</Type /Page /Parent 2 0 R /MediaBox [0 0 4 3] /Resources <</ColorSpace <</CS0 6 0 R>> /XObject <</X 4 0 R>>>> /Contents 5 0 R>>',
    stream(`${IMAGE_HEAD} /ColorSpace /CS0 /Filter /FlateDecode`, FLATE),
    fullPage(),
    stream('/N 3 /Alternate /DeviceRGB', Buffer.from('icc')),
  ];
  // 6 番は ICCBased の中身なので、色空間そのものは配列で置き直す
  objects[5] = '[/ICCBased 7 0 R]';
  objects.push(stream('/N 3 /Alternate /DeviceRGB', Buffer.from('icc')));
  const file = writePdf('named-cs.pdf', objects);
  const looked = await pdfUnpack.inspectPage(file, 0);
  assert.strictEqual(looked.ok, true, looked.reason);
  assert.strictEqual(looked.channels, 3);
});

test('枠は CropBox と MediaBox の交わりで測る (焼き場と揃える)', async () => {
  const objects = [
    '<</Type /Catalog /Pages 2 0 R>>',
    '<</Type /Pages /Count 1 /Kids [3 0 R]>>',
    '<</Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /CropBox [0 0 200 300] /Resources <</XObject <</X 4 0 R>>>> /Contents 5 0 R>>',
    flateImage(),
    fullPage(),
  ];
  const file = writePdf('cropbox-shape.pdf', objects);
  assert.deepStrictEqual(await pdfUnpack.pageShapes(file), { pageCount: 1, ratios: [0.667] });
});

test('worker が返す箱は自前の ArrayBuffer (小さな絵でも共用 pool を渡さない)', () => {
  const out = own(toBgra({ base: { bytes: Buffer.from([1, 2, 3]), codec: 'raw', channels: 3, width: 1, height: 1 }, smask: null }));
  assert.strictEqual(out.byteOffset, 0);
  assert.strictEqual(out.byteLength, out.buffer.byteLength);
});

test('Lexer: 参照・名前の #xx・入れ子の辞書と配列', () => {
  const lexer = new pdfUnpack.Lexer('<</A 1 0 R /B [0 0 1613.04 2275.92] /C#20D /Name /E <</F true /N 3>> /G (s\\)tr) /H <414243>>>');
  assert.deepStrictEqual(lexer.value(), {
    A: { ref: 1 }, B: [0, 0, 1613.04, 2275.92], 'C D': '/Name', E: { F: true, N: 3 }, G: { str: '' }, H: { str: '' },
  });
});

// ── sharp で焼く (色差を間引かない) ───────────────────────────

// JPEG の SOF から色差の間引き方を読む ('1x1,1x1,1x1' なら 4:4:4、'2x2,1x1,1x1' なら 4:2:0)
function sampling(buf) {
  let p = 2;
  while (p + 4 < buf.length) {
    if (buf[p] !== 0xFF) { p += 1; continue; }
    const marker = buf[p + 1];
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      const n = buf[p + 9];
      const out = [];
      for (let i = 0; i < n; i += 1) {
        const b = buf[p + 11 + i * 3];
        out.push(`${b >> 4}x${b & 15}`);
      }
      return { sampling: out.join(','), height: (buf[p + 5] << 8) | buf[p + 6], width: (buf[p + 7] << 8) | buf[p + 8] };
    }
    p += 2 + ((buf[p + 2] << 8) | buf[p + 3]);
  }
  return null;
}

const sharpTest = { skip: hasSharp() ? false : 'sharp が読めない' };

test('worker: 原寸は色差を間引かずに焼く (4:4:4)', sharpTest, async () => {
  const out = await renderBase({
    base: { bytes: FLATE, codec: 'flate', channels: 3, width: 4, height: 3 },
    smask: null,
    encode: { quality: 0.95, width: 0 },
  });
  assert.ok(out.jpeg, 'sharp があれば JPEG が返る');
  assert.deepStrictEqual(sampling(out.jpeg), { sampling: '1x1,1x1,1x1', width: 4, height: 3 });
});

test('worker: 灰色の頁は 1 成分の JPEG (色差そのものを持たない)', sharpTest, async () => {
  const gray = Buffer.alloc(64 * 64, 128);
  const out = await renderBase({
    base: { bytes: gray, codec: 'raw', channels: 1, width: 64, height: 64 },
    smask: null,
    encode: { quality: 0.9, width: 0 },
  });
  assert.deepStrictEqual(sampling(out.jpeg), { sampling: '1x1', width: 64, height: 64 });
});

test('worker: 縮めた物は 4:2:0 で軽くする', sharpTest, async () => {
  const out = await renderBase({
    base: { bytes: Buffer.alloc(64 * 64 * 3, 90), codec: 'raw', channels: 3, width: 64, height: 64 },
    smask: null,
    encode: { quality: 0.82, width: 32 },
  });
  assert.deepStrictEqual(sampling(out.jpeg), { sampling: '2x2,1x1,1x1', width: 32, height: 32 });
});

test('worker: 透過は焼く前に白地へ潰す', sharpTest, async () => {
  const base = Buffer.alloc(8 * 8 * 3, 0);                   // 真っ黒
  const alpha = Buffer.alloc(8 * 8, 0);                      // 全部透明
  const out = await renderBase({
    base: { bytes: base, codec: 'raw', channels: 3, width: 8, height: 8 },
    smask: { bytes: alpha, codec: 'raw', channels: 1, width: 8, height: 8 },
    encode: { quality: 0.95, width: 0 },
  });
  const back = await require('sharp')(out.jpeg).raw().toBuffer();
  assert.ok(back[0] > 240, `白地に潰れている (${back[0]})`);
});

test('worker: JPEG を縮める仕事 / 透過つき JPEG を焼き直す仕事', sharpTest, async () => {
  const sharp = require('sharp');
  const src = await sharp(Buffer.alloc(40 * 30 * 3, 200), { raw: { width: 40, height: 30, channels: 3 } })
    .jpeg().toBuffer();
  const small = await shrink({ bytes: src, encode: { quality: 0.82, width: 20 } });
  assert.deepStrictEqual(sampling(small.jpeg), { sampling: '2x2,1x1,1x1', width: 20, height: 15 });

  const masked = await dctMask({
    bytes: src,
    smask: { bytes: Buffer.alloc(40 * 30, 0), codec: 'raw', channels: 1, width: 40, height: 30 },
    encode: { quality: 0.95, width: 0 },
  });
  const back = await sharp(masked.jpeg).raw().toBuffer();
  assert.ok(back[0] > 240, `透過つき JPEG も白地に潰れる (${back[0]})`);
});

test('sharp が読めない時は画素を返し、主スレッドの nativeImage に任せる', () => {
  const { execFileSync } = require('child_process');
  const code = `const w = require(${JSON.stringify(path.resolve('src/lib/pdf-unpack-worker.js'))});
    if (w.hasSharp()) { console.log('SHARP'); process.exit(0); }
    w.renderBase({ base: { bytes: Buffer.alloc(3), codec: 'raw', channels: 3, width: 1, height: 1 },
      smask: null, encode: { quality: 0.9, width: 0 } })
      .then((r) => console.log(r.jpeg ? 'JPEG' : 'BGRA:' + r.bgra.length));`;
  const out = execFileSync(process.execPath, ['-e', code], {
    env: { ...process.env, BUNKO_NO_SHARP: '1' }, encoding: 'utf8',
  }).trim();
  assert.strictEqual(out, 'BGRA:4');
});

test('抜いた頁がそのまま JPEG として出る (生画素の本)', sharpTest, async () => {
  const objects = [
    '<</Type /Catalog /Pages 2 0 R>>',
    '<</Type /Pages /Count 1 /Kids [3 0 R]>>',
    '<</Type /Page /Parent 2 0 R /MediaBox [0 0 4 3] /Resources <</XObject <</X 4 0 R>>>> /Contents 5 0 R>>',
    flateImage(),
    fullPage(),
  ];
  const file = writePdf('unpack-jpeg.pdf', objects);
  const out = await pdfUnpack.unpackPage(file, 0);
  assert.strictEqual(out.type, 'image/jpeg');
  assert.deepStrictEqual(sampling(out.bytes), { sampling: '1x1,1x1,1x1', width: 4, height: 3 });
});
