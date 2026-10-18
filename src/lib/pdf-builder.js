// 綴じるところ。**まず直に綴じ、駄目なら隠し窓で焼く**。
//
// 直の道 (pdf-write) は絵のバイトをそのまま PDF に据える。隠し窓の印刷は頁を
// 必ず画素に開いて焼き直すので、webp/avif の頁が生画素 + Flate になって
// 桁違いに重く・大きくなっていた (実測 33 頁 / 元 44MB → 515MB・刷りだけで 12.0 秒)。
//
// 隠し窓は**捨てない**。回った頁・見慣れない符号・sharp が読めない形は直に
// 据えられないので、そういう本はこれまでどおり焼いて綴じる。
// 混ぜない: 一頁でも据えられなければ**一冊まるごと**隠し窓へ回す
// (頁ごとに道が違うと、後で「この頁はどちらで出来たか」を追えなくなる)
const fs = require('fs');
const path = require('path');
const { BrowserWindow } = require('electron');
const trace = require('./trace');
const { ensureComplete, makeReport } = require('./pdf-report');
const { writePdf } = require('./pdf-write');
const pdfUnpack = require('./pdf-unpack');

const FALLBACK_WIDTH = 1000;
const FALLBACK_HEIGHT = 1414;

// 隠し窓の中の仕事に期限を置く。返らない窓があると chain が永久に詰まり、
// 呼び手 3 つ (取り込み・一括保存・zip の取り込み) が揃って止まる。
// 速さの上限ではなく「返らない」を見つけるための線なので広めに取る
const LOAD_MS = 60 * 1000;
const DECODE_MS = 120 * 1000;
const PRINT_MS = 5 * 60 * 1000;

// 同時に隠しウィンドウを作らないよう直列化する (複数ジョブの同時完了でメモリが跳ねるのを防ぐ)
let chain = Promise.resolve();

function pageSize(page) {
  const width = Math.max(1, Math.round(Number(page.width) || FALLBACK_WIDTH));
  const height = Math.max(1, Math.round(Number(page.height) || FALLBACK_HEIGHT));
  return { width, height };
}

function withTimeout(promise, ms, code) {
  let timer = null;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`pdf-builder: ${code} が ${ms} ms で返らない`)), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

function buildHtml(pages) {
  const styles = [];
  const body = [];
  pages.forEach((page, index) => {
    const { width, height } = pageSize(page);
    // CSS named page で 1 ページごとに実寸のページサイズを与える
    styles.push(`@page p${index}{size:${width}px ${height}px;margin:0}`);
    styles.push(`.pg${index}{page:p${index}}`);
    const src = encodeURIComponent(path.basename(page.file));
    body.push(
      `<div class="pg${index}"><img src="${src}" style="width:${width}px;height:${height}px;display:block"></div>`,
    );
  });
  // 最終ページの break-after を戻さないと末尾に空白ページが 1 枚増える
  const base = 'html,body{margin:0;padding:0}div{break-after:page}div:last-child{break-after:auto}';
  return `<!doctype html><meta charset="utf-8"><style>${base}${styles.join('')}</style>${body.join('')}`;
}

// 頁が一枚でも開けなかったら、その番号を返す。
// 以前は decode の失敗を握り潰していたので、白紙の頁を含む PDF が「完成」として
// 返り、呼び手がその後ろで**原本を消していた** (取り返しがつかない)。
// ここは数えて返すだけで、どうするかは呼び手が決める。
//
// **一枚ずつ開く。** 一斉に開くと、大きな作品では後ろの数枚だけが必ず弾かれる:
// 2071x2880 の頁は開くと約 24MB の画になり、33 枚を同時に開けば 790MB を
// 一度に抱えることになって、画の置き場が尽きたぶんが EncodingError で返る。
// それを「壊れた頁」と数えていたので、**取れているのに毎回失敗する**作品が出た
// (実測: 33 頁中うしろ 3 枚 / 別の作品では 5 枚・9 枚。バイトはどれも正常な WebP)。
// 刷る段は一頁ずつ描くので同時には抱えない。検めも同じ作法にすれば足りる
const DECODE_SCRIPT = `(async () => {
  const bad = [];
  const imgs = [...document.images];
  for (let i = 0; i < imgs.length; i += 1) {
    const img = imgs[i];
    try {
      await img.decode();
      if (!(img.naturalWidth > 0 && img.naturalHeight > 0)) bad.push(i);
    } catch (e) {
      bad.push(i);
    }
  }
  return bad;
})()`;

async function renderPdf(pages, dest) {
  // 画像と同じ作業フォルダに置くことで img の相対 src が解決できる
  const workDir = path.dirname(pages[0].file);
  const htmlPath = path.join(workDir, '_pdf.html');
  fs.writeFileSync(htmlPath, buildHtml(pages), 'utf8');

  const partPath = `${dest}.part`;
  const win = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, sandbox: true },
  });

  let failed = [];
  try {
    await withTimeout(win.loadFile(htmlPath), LOAD_MS, 'loadFile');
    // printToPDF は画像のデコード完了を待たないので明示的に待つ
    const bad = await withTimeout(
      win.webContents.executeJavaScript(DECODE_SCRIPT), DECODE_MS, 'decode',
    );
    failed = Array.isArray(bad) ? bad : [];
    const data = await withTimeout(win.webContents.printToPDF({
      preferCSSPageSize: true,
      printBackground: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    }), PRINT_MS, 'printToPDF');
    fs.writeFileSync(partPath, data);
    // **据えるのは検め終えた後**。開けなかった頁があるうちは本番の名前に置かない。
    // 置いてから呼び手に投げさせていたので、積み直しのたびに uniqueName が
    // 次の番号を取り、同じ作品が棚に何冊も出ていた (実測 6 冊)。
    // 「途中で落ちても半端な PDF は残らない」という paw-bulk・paw-zip-pdf の
    // 註も、これでようやく書いてあるとおりの意味になる
    if (failed.length) {
      try { fs.unlinkSync(partPath); } catch { /* ignore */ }
    } else {
      fs.renameSync(partPath, dest);
    }
  } catch (error) {
    if (fs.existsSync(partPath)) {
      try { fs.unlinkSync(partPath); } catch { /* ignore */ }
    }
    throw error;
  } finally {
    win.destroy();
  }

  if (failed.length) {
    trace.note('pdf', 'decode-incomplete', { count: failed.length });
  }
  return makeReport(dest, pages.length, failed, !failed.length);
}

// 直に綴じる。据えられない頁が一つでもあれば CannotEmbed が飛んでくる。
// 焼くのは worker (sharp) なので主スレッドは画素を触らない。隠し窓を使わないので
// chain に並べる必要も無い (同時に綴じても跳ねるのは worker の 3 本ぶんだけ)
async function writeDirect(pages, dest) {
  const partPath = `${dest}.part`;
  try {
    await writePdf(pages, partPath, {
      transcode: (bytes, { quality }) => pdfUnpack.pageJpegBytes(bytes, { quality, tag: 'pdf' }),
      // PNG の例外 (パレット・透過・16 bit・interlace) は生画素に開いて可逆で据える
      expand: (bytes) => pdfUnpack.pagePlaneBytes(bytes, { tag: 'pdf' }),
    });
  } catch (error) {
    if (fs.existsSync(partPath)) {
      try { fs.unlinkSync(partPath); } catch { /* ignore */ }
    }
    throw error;
  }
  // 直の道に「開けなかった頁」は無い: 据えられない頁はここまで来ずに投げる
  fs.renameSync(partPath, dest);
  return makeReport(dest, pages.length, [], true);
}

// 返すのは綴じた結果の報告。**判断はしない**:
//   { dest, total, decoded, failed: [開けなかった頁の番号] }
// 呼び手は failed が空でないとき、原本を消す前に止まること。
// (以前はここが dest だけを返し、白紙混じりでも成功に見えていた)
async function buildPdf({ pages, dest }) {
  if (!pages || !pages.length) throw new Error('ページがありません');
  try {
    return await writeDirect(pages, dest);
  } catch (error) {
    // 据えられない形だった時だけ焼き場へ下がる。書けない・場所が無いといった
    // 本当の失敗で黙って隠し窓に回すと、重い道で同じ所に転ぶだけになる
    if (!error || !error.cannotEmbed) throw error;
    trace.note('pdf', 'bake-fallback', { page: error.pageIndex, why: error.why });
  }
  const next = chain.then(() => renderPdf(pages, dest));
  // 失敗しても後続のビルドが止まらないようにする
  chain = next.catch(() => {});
  return next;
}

// 報告の読み方は pdf-report が持つ (電子の窓と分けてある: 上の註を見よ)
module.exports = { buildPdf, ensureComplete };
