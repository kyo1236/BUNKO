'use strict';

// PDF の綴じの速さを測る台。**実物の蔵書を使わない** (合成した頁で測る):
// 保存先は Eagle の監視フォルダなので、測るたびに棚へ物が増えるのは困る。
//
//   npx electron scripts/bench-pdf.js
//   npx electron scripts/bench-pdf.js --pages 60 --format jpeg
//
// 測るのは三つの道:
//   いまの道     … 隠し窓の印刷 (読み込み / 検め / 刷り の段ごと)
//   新しい道     … 絵のバイトをそのまま据える (pdf-write)。読み返せるかも見る
//   本番の入口   … pdf-builder.buildPdf。差し戻し (据えられない頁 → 焼き場) まで見る
// 出来た PDF の大きさも見る (元より大きければ、綴じる過程で焼き直している)。
//
// 合成した縞と乱数は実物の原稿より符号が効かないので、**大きさの倍率は誇張される**。
// 向き (どちらが大きいか) と段ごとの時間を見るための台で、絶対値の台ではない。

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.disableHardwareAcceleration();
// 隠し窓を壊すと「窓が全部閉じた」になり、Electron の既定でアプリごと終わる。
// 測るのは窓を壊した後も続くので、既定を潰しておく
// (これを入れるまで、直の道の途中で黙って終了コード 0 で落ちていた)
app.on('window-all-closed', () => {});

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split('=')[1];
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
};

const PAGES = Number(arg('pages', 33));
const WIDTH = Number(arg('width', 2071));
const HEIGHT = Number(arg('height', 2880));
const FORMAT = String(arg('format', 'webp'));

const ms = (t) => Math.round(t);
const mb = (n) => Math.round((n / 1048576) * 10) / 10;

// 実物に近い絵を作る (真っ白だと符号が効きすぎて、焼き直しの重さが出ない)
async function makePages(dir) {
  const sharp = require('sharp');
  const files = [];
  const t0 = performance.now();
  for (let i = 0; i < PAGES; i += 1) {
    const noise = Buffer.alloc(WIDTH * HEIGHT * 3);
    // 斜めの縞 + 疑似乱数。頁ごとに違う絵にして、符号の効きを揃えない
    let seed = (i + 1) * 2654435761;
    for (let p = 0; p < noise.length; p += 3) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const v = ((p / 3) % WIDTH ^ Math.floor(p / 3 / WIDTH)) & 0xff;
      noise[p] = (v + (seed & 31)) & 0xff;
      noise[p + 1] = (v * 2 + (seed >> 5 & 31)) & 0xff;
      noise[p + 2] = (v / 2 + (seed >> 10 & 31)) & 0xff;
    }
    const img = sharp(noise, { raw: { width: WIDTH, height: HEIGHT, channels: 3 } });
    const out = FORMAT === 'jpeg'
      ? await img.jpeg({ quality: 86 }).toBuffer()
      : await img.webp({ quality: 82 }).toBuffer();
    const file = path.join(dir, `${String(i).padStart(4, '0')}.${FORMAT === 'jpeg' ? 'jpg' : 'webp'}`);
    fs.writeFileSync(file, out);
    files.push({ file, width: WIDTH, height: HEIGHT, bytes: out.length });
  }
  return { files, ms: performance.now() - t0 };
}

function buildHtml(pages) {
  const styles = [];
  const body = [];
  pages.forEach((page, index) => {
    styles.push(`@page p${index}{size:${page.width}px ${page.height}px;margin:0}`);
    styles.push(`.pg${index}{page:p${index}}`);
    const src = encodeURIComponent(path.basename(page.file));
    body.push(`<div class="pg${index}"><img src="${src}" style="width:${page.width}px;height:${page.height}px;display:block"></div>`);
  });
  const base = 'html,body{margin:0;padding:0}div{break-after:page}div:last-child{break-after:auto}';
  return `<!doctype html><meta charset="utf-8"><style>${base}${styles.join('')}</style>${body.join('')}`;
}

const DECODE_ONE_BY_ONE = `(async () => {
  const bad = [];
  const imgs = [...document.images];
  for (let i = 0; i < imgs.length; i += 1) {
    try { await imgs[i].decode(); } catch (e) { bad.push(i); }
  }
  return bad;
})()`;

// いまの道を段ごとに測る
async function benchWindow(pages, dir, { offscreen }) {
  const htmlPath = path.join(dir, '_pdf.html');
  fs.writeFileSync(htmlPath, buildHtml(pages), 'utf8');
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen, sandbox: true } });
  const out = { 隠し窓: offscreen ? 'offscreen' : '素' };
  try {
    let t = performance.now();
    await win.loadFile(htmlPath);
    out.読み込み = ms(performance.now() - t);

    t = performance.now();
    const bad = await win.webContents.executeJavaScript(DECODE_ONE_BY_ONE);
    out.検め = ms(performance.now() - t);
    out.開けず = bad.length;

    t = performance.now();
    const data = await win.webContents.printToPDF({
      preferCSSPageSize: true,
      printBackground: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    });
    out.刷り = ms(performance.now() - t);
    out.出来 = mb(data.length);

    t = performance.now();
    fs.writeFileSync(path.join(dir, `out-${offscreen ? 'off' : 'plain'}.pdf`), data);
    out.書き出し = ms(performance.now() - t);
    out.合計 = out.読み込み + out.検め + out.刷り + out.書き出し;
  } catch (e) {
    out.倒れた = String((e && e.message) || e).slice(0, 80);
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
  return out;
}

// 新しい道: 絵のバイトをそのまま据える (pdf-write)
async function benchDirect(pages, dir) {
  const pdfUnpack = require('../src/lib/pdf-unpack');
  const { writePdf } = require('../src/lib/pdf-write');
  const dest = path.join(dir, 'out-direct.pdf');
  const out = { 道: '直に据える' };
  const t0 = performance.now();
  try {
    await writePdf(pages, dest, {
      transcode: (bytes, { quality }) => pdfUnpack.pageJpegBytes(bytes, { quality, tag: 'bench' }),
    });
    out.合計 = ms(performance.now() - t0);
    out.出来 = mb(fs.statSync(dest).size);

    // 綴じた物を読み返せるか (ここが崩れると蔵書が全部焼き場落ちになる)
    const t1 = performance.now();
    let direct = 0;
    for (let i = 0; i < pages.length; i += 1) {
      const detail = await pdfUnpack.readPageDetail(dest, i);
      if (!detail.reason) direct += 1;
      else if (!out.読めぬ理由) out.読めぬ理由 = detail.reason;
    }
    out.直読みできた頁 = `${direct}/${pages.length}`;
    out.読み返すのに = ms(performance.now() - t1);
  } catch (e) {
    out.倒れた = String((e && e.message) || e).slice(0, 80);
  } finally {
    await pdfUnpack.close().catch(() => {});
  }
  return out;
}

// 本番の入口をそのまま踏む。pdf-builder は「まず直に据え、駄目なら焼く」ので、
// 配線 (差し戻し・報告の形) が効いているかはここでしか見えない。
// 棚に物を増やさないよう、綴じるのは合成した頁だけ
async function benchBuilder(pages, dir) {
  const { buildPdf } = require('../src/lib/pdf-builder');
  const pdfUnpack = require('../src/lib/pdf-unpack');
  const out = {};
  try {
    let t = performance.now();
    const good = await buildPdf({ pages, dest: path.join(dir, 'via-builder.pdf') });
    out.直に据える = {
      ms: ms(performance.now() - t),
      出来: mb(fs.statSync(good.dest).size),
      報告: `total=${good.total} failed=${good.failed.length} published=${good.published}`,
    };

    // 据えられない頁を一つ混ぜて、一冊まるごと焼き場へ下がるかを見る
    const junk = path.join(dir, 'junk.bin');
    fs.writeFileSync(junk, Buffer.from('絵ではない'));
    const mixed = [...pages.slice(0, 3), { file: junk, width: WIDTH, height: HEIGHT }];
    t = performance.now();
    const fell = await buildPdf({ pages: mixed, dest: path.join(dir, 'via-bake.pdf') });
    out.焼き場へ差し戻し = {
      ms: ms(performance.now() - t),
      報告: `total=${fell.total} failed=${fell.failed.length} published=${fell.published}`,
      棚に出たか: fs.existsSync(fell.dest),
      半端が残ったか: fs.existsSync(`${fell.dest}.part`),
    };
  } catch (e) {
    out.倒れた = String((e && e.message) || e).slice(0, 120);
  } finally {
    await pdfUnpack.close().catch(() => {});
  }
  return out;
}

const REPORT = arg('out', '');
const step = (what) => {
  if (REPORT) fs.appendFileSync(`${REPORT}.steps`, `${new Date().toISOString()} ${what}\n`, 'utf8');
};

app.whenReady().then(async () => {
  step('起きた');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunko-pdfbench-'));
  try {
    step("頁を作る");
    const { files, ms: genMs } = await makePages(dir);
    step("頁ができた");
    const src = files.reduce((a, f) => a + f.bytes, 0);
    const head = {
      頁数: PAGES,
      寸法: `${WIDTH}x${HEIGHT}`,
      形式: FORMAT,
      元の合計: mb(src) + 'MB',
      頁を作るのに: ms(genMs) + 'ms',
    };
    const rows = [];
    rows.push(await benchWindow(files, dir, { offscreen: true }));
    step("隠し窓おわり");
    const direct = await benchDirect(files, dir);
    step("直の道おわり");
    const wired = await benchBuilder(files, dir);
    step("本番の入口おわり");
    const text = JSON.stringify({ 前提: head, いまの道: rows, 新しい道: direct, 本番の入口: wired }, null, 1);
    console.log(text);
    // Electron の窓付きプロセスは端末に標準出力が繋がらないことがある。控えも残す
    const report = arg('out', '');
    if (report) fs.writeFileSync(report, text, 'utf8');
  } catch (e) {
    step("倒れた: " + ((e && e.stack) || e));
  } finally {
    step("片付け");
    fs.rmSync(dir, { recursive: true, force: true });
    app.quit();
  }
});
