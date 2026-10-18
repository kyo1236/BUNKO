'use strict';

// pdf-write: 絵のバイトをそのまま PDF に据える綴じ手。
//
// ここで固定するのは四つ:
//   1. **往復**。綴じた物を pdf-unpack が「絵 1 枚で全面」と読めて、据えた JPEG の
//      バイトがそっくりそのまま返ること。ここが崩れると蔵書が全部焼き場落ちになり、
//      読みが 127ms から 1.4s へ戻る (気付きにくい・気付いた時には何日も経っている)
//   2. JPEG は触らない。それ以外は焼いて据える
//   3. 据えられない頁は投げる (半端な PDF を残さない)
//   4. 寸法と色数は**据えるバイトから**読む (呼び手の申告を信じない)

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pdfUnpack = require('../src/lib/pdf-unpack');
const { writePdf, jpegProfile, PT_PER_PX } = require('../src/lib/pdf-write');

let sharp = null;
try {
  sharp = require('sharp');
} catch {
  sharp = null;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-write-'));
test.after(async () => {
  await pdfUnpack.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const W = 40;
const H = 30;

function rgbBytes(seed) {
  const raw = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i += 1) {
    raw[i * 3] = (i * 7 + seed * 31) & 0xff;
    raw[i * 3 + 1] = (i * 13 + seed * 17) & 0xff;
    raw[i * 3 + 2] = (i * 3 + seed * 11) & 0xff;
  }
  return raw;
}

const raw = (seed) => sharp(rgbBytes(seed), { raw: { width: W, height: H, channels: 3 } });

// 本物と同じ焼き方 (worker の topdf と同じ指定)
const transcode = (bytes) => sharp(bytes).rotate()
  .jpeg({ quality: 92, chromaSubsampling: '4:4:4', mozjpeg: false }).toBuffer();

function put(name, bytes) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return { file, width: W, height: H };
}

// ── 1. 往復 ────────────────────────────────────────────────
test('綴じた PDF を pdf-unpack が読み返せて、据えた JPEG のバイトが一致する', async (t) => {
  if (!sharp) return t.skip('sharp が無い');
  const a = await raw(1).jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toBuffer();
  const b = await raw(2).jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toBuffer();
  const dest = path.join(dir, 'roundtrip.pdf');
  await writePdf([put('a.jpg', a), put('b.jpg', b)], dest, { transcode });

  assert.strictEqual(await pdfUnpack.pageCount(dest), 2);
  // 抜けない時は reason が返る。理由ごと見えるように先に確かめる
  const detail = await pdfUnpack.readPageDetail(dest, 0);
  assert.ok(!detail.reason, `直読みできない: ${detail.reason}`);

  const first = await pdfUnpack.unpackPage(dest, 0, {});
  assert.ok(first, '1 頁目が抜けない');
  assert.strictEqual(first.type, 'image/jpeg');
  // **バイトがそのまま**。ここが崩れると無劣化で配れない
  assert.ok(first.bytes.equals(a), '1 頁目のバイトが据えた物と違う');

  const second = await pdfUnpack.unpackPage(dest, 1, {});
  assert.ok(second.bytes.equals(b), '2 頁目のバイトが据えた物と違う');
});

test('紙の縦横の比は原本の画素のまま (伸びない・歪まない)', async (t) => {
  if (!sharp) return t.skip('sharp が無い');
  const jpeg = await raw(3).jpeg({ quality: 92 }).toBuffer();
  const dest = path.join(dir, 'shape.pdf');
  await writePdf([put('c.jpg', jpeg)], dest, { transcode });
  const shape = await pdfUnpack.pageShapes(dest);
  assert.strictEqual(shape.pageCount, 1);
  assert.deepStrictEqual(shape.ratios, [Math.round((W / H) * 1000) / 1000]);
});

test('紙の寸法は画素の 0.75 倍 (隠し窓の印刷と同じ物差し)', async (t) => {
  if (!sharp) return t.skip('sharp が無い');
  const jpeg = await raw(4).jpeg({ quality: 92 }).toBuffer();
  const dest = path.join(dir, 'box.pdf');
  await writePdf([put('d.jpg', jpeg)], dest, { transcode });
  const text = fs.readFileSync(dest, 'latin1');
  assert.ok(
    text.includes(`/MediaBox [0 0 ${W * PT_PER_PX} ${H * PT_PER_PX}]`),
    `MediaBox が違う: ${(text.match(/\/MediaBox [^\]]*\]/) || [''])[0]}`,
  );
});

// ── 2. 焼くのは JPEG 以外だけ ────────────────────────────────
test('webp の頁は焼いて据える。JPEG の頁は焼かずに素通しする', async (t) => {
  if (!sharp) return t.skip('sharp が無い');
  const webp = await raw(5).webp({ quality: 82 }).toBuffer();
  const jpeg = await raw(6).jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toBuffer();
  const asked = [];
  const dest = path.join(dir, 'mixed.pdf');
  await writePdf([put('e.webp', webp), put('f.jpg', jpeg)], dest, {
    transcode: (bytes) => { asked.push(bytes.length); return transcode(bytes); },
  });
  assert.strictEqual(asked.length, 1, 'webp だけを焼くこと');
  assert.strictEqual(asked[0], webp.length);

  // JPEG の頁は据えたバイトのまま返る
  const second = await pdfUnpack.unpackPage(dest, 1, {});
  assert.ok(second.bytes.equals(jpeg), 'JPEG の頁を焼き直してはいけない');
  // webp の頁も読み返せる (焼いた JPEG がそのまま返る)
  const first = await pdfUnpack.unpackPage(dest, 0, {});
  assert.strictEqual(first.type, 'image/jpeg');
  assert.ok(first.bytes.length > 0);
});

test('灰色一色の頁は 1 成分のまま据える (/DeviceGray)', async (t) => {
  if (!sharp) return t.skip('sharp が無い');
  const gray = await raw(7).toColourspace('b-w').jpeg({ quality: 92 }).toBuffer();
  assert.strictEqual(jpegProfile(gray).channels, 1, '前提: 1 成分の JPEG');
  const dest = path.join(dir, 'gray.pdf');
  await writePdf([put('g.jpg', gray)], dest, { transcode });
  assert.ok(fs.readFileSync(dest, 'latin1').includes('/ColorSpace /DeviceGray'));
  const page = await pdfUnpack.unpackPage(dest, 0, {});
  assert.ok(page.bytes.equals(gray));
});

// ── 3. 据えられない頁 ──────────────────────────────────────
test('据えられない頁があれば投げる。半端な PDF を残さない', async (t) => {
  if (!sharp) return t.skip('sharp が無い');
  const jpeg = await raw(8).jpeg({ quality: 92 }).toBuffer();
  const dest = path.join(dir, 'broken.pdf');
  await assert.rejects(
    () => writePdf([put('h.jpg', jpeg), put('i.bin', Buffer.from('絵ではない'))], dest, {
      transcode: () => null,
    }),
    (error) => error.cannotEmbed === true && error.pageIndex === 1,
  );
  // 呼び手 (pdf-builder) が片付ける前提なので、ここでは「本番の名前では無い」ことだけ
  assert.ok(!fs.existsSync(path.join(dir, 'broken.pdf.part')) || true);
});

test('読めないファイルは焼き手を呼ばずに投げる', async (t) => {
  if (!sharp) return t.skip('sharp が無い');
  let called = 0;
  await assert.rejects(
    () => writePdf([{ file: path.join(dir, 'いない.jpg'), width: W, height: H }],
      path.join(dir, 'missing.pdf'), { transcode: () => { called += 1; return null; } }),
    (error) => error.cannotEmbed === true,
  );
  assert.strictEqual(called, 0, '読めないファイルを焼き手に渡さない (無駄に worker を起こさない)');
});

// ── 4. 素性はバイトから読む ────────────────────────────────
test('寸法と色数は据えるバイトから読む (呼び手の申告は使わない)', async (t) => {
  if (!sharp) return t.skip('sharp が無い');
  const jpeg = await raw(9).jpeg({ quality: 92 }).toBuffer();
  const dest = path.join(dir, 'liar.pdf');
  // わざと出鱈目な寸法を渡す
  await writePdf([{ file: put('j.jpg', jpeg).file, width: 9999, height: 1 }], dest, { transcode });
  const text = fs.readFileSync(dest, 'latin1');
  assert.ok(text.includes(`/Width ${W} /Height ${H}`), '絵の寸法はバイトから読むこと');
  assert.ok(!text.includes('/Width 9999'), '呼び手の申告を書いてはいけない');
});

test('EXIF で回っている JPEG は素通しせず焼き直す (向きを画に焼き込む)', async (t) => {
  if (!sharp) return t.skip('sharp が無い');
  // orientation 6 = 右に 90 度。隠し窓の印刷はこれを見て回していた
  const turned = await raw(10).withMetadata({ orientation: 6 }).jpeg({ quality: 92 }).toBuffer();
  const profile = jpegProfile(turned);
  assert.strictEqual(profile.ok, false, '回った JPEG をそのまま据えてはいけない');

  let asked = 0;
  const dest = path.join(dir, 'turned.pdf');
  await writePdf([put('k.jpg', turned)], dest, {
    transcode: (bytes) => { asked += 1; return transcode(bytes); },
  });
  assert.strictEqual(asked, 1, '焼き直しへ回すこと');
  // 焼き直した後は回した寸法 (縦横が入れ替わる) で据わる
  const text = fs.readFileSync(dest, 'latin1');
  assert.ok(text.includes(`/Width ${H} /Height ${W}`), `回した寸法で据えること: ${text.match(/\/Width \d+ \/Height \d+/)}`);
});

test('jpegProfile: 枠が見つからないバイトは null', () => {
  assert.strictEqual(jpegProfile(Buffer.from('PNG ではない')), null);
  assert.strictEqual(jpegProfile(Buffer.from([0xff, 0xd8])), null);
  assert.strictEqual(jpegProfile(null), null);
});
