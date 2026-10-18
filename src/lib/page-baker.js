'use strict';

// 端末に配る頁を、母艦側で「画面に合う画像」に焼く所。
//
// 所持作品のほとんどは PDF で、その中身は 1 頁 1 枚の大きな画像 (2150x3035 前後)。
// 束のまま端末へ流すと 1 頁 700KB を落とした上、その復号を端末の JS (pdf.js) が
// 引き受けることになる。めくるたびに待たされるのはここ。
// 母艦で 1080px の webp にしてから配れば、荷は 1/5 になり、復号は端末の内蔵デコーダが
// ハードウェアでやる。焼いた頁は円盤に残るので、二度目からは出すだけ
//
// 焼き場は隠しウィンドウ (pdf-builder.js と同じ形)。Chromium の中でしか
// pdf.js の canvas 描画も webp の符号化もできないため。隠すと描画が止まる質があるので
// backgroundThrottling は切っておく

const path = require('path');
const { BrowserWindow } = require('electron');

// 端末が頼める幅はこれだけ。任意の幅を許すと同じ頁が幅ごとに焼き直され、置き場が散る
const WIDTHS = [720, 1080, 1440, 1800];
// 幅 0 は原寸 (頁に貼られた絵の幅で描く)。母艦の読書用で、端末には配らない
const NATIVE = 0;
const QUALITY = { webp: 0.8, jpeg: 0.82 };
// 誰も頼まなくなったら窓を畳む。抱えている PDF の本体ごと手放したい
const IDLE_MS = 60 * 1000;

let win = null;
let ready = null;
let idleTimer = null;
let pumping = false;
let closing = null;

// 待ち行列は二段。端末が今めくった頁は、裏で焼いている続きより先に通す
const urgent = [];
const later = [];

function snapWidth(value) {
  const want = Number(value) || 0;
  for (const width of WIDTHS) {
    if (want <= width) return width;
  }
  return WIDTHS[WIDTHS.length - 1];
}

function typeFor(format) {
  return format === 'jpeg' ? 'image/jpeg' : 'image/webp';
}

function clearIdle() {
  if (!idleTimer) return;
  clearTimeout(idleTimer);
  idleTimer = null;
}

function noteIdle() {
  clearIdle();
  if (!win) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (urgent.length || later.length || pumping) return;
    dropWindow();
  }, IDLE_MS);
}

function dropWindow() {
  const old = win;
  win = null;
  ready = null;
  if (!old) return;
  try {
    old.destroy();
  } catch {
    // 既に畳んでいる
  }
}

function ensureWindow() {
  if (ready) return ready;
  const next = new BrowserWindow({
    show: false,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      // 砂場に入れると窓口 (baker-preload) から fs が引けない。窓の中身は自分の物だけ
      sandbox: false,
      preload: path.join(__dirname, '..', 'lan', 'baker-preload.js'),
    },
  });
  win = next;
  // 転んだ窓を掴み続けない。次の注文で起こし直す
  next.webContents.on('render-process-gone', () => {
    if (win === next) dropWindow();
  });
  ready = next.loadFile(path.join(__dirname, '..', 'lan', 'baker.html'))
    .then(() => next.webContents.executeJavaScript('boot()'))
    .then(() => next)
    .catch((error) => {
      if (win === next) dropWindow();
      throw error;
    });
  return ready;
}

async function pump() {
  if (pumping) return;
  pumping = true;
  clearIdle();
  try {
    for (;;) {
      const task = urgent.shift() || later.shift();
      if (!task) break;
      try {
        task.resolve(await task.run());
      } catch (error) {
        task.reject(error);
      }
    }
  } finally {
    pumping = false;
    noteIdle();
  }
}

function schedule(run, { background = false, tag = '' } = {}) {
  if (closing) return Promise.reject(new Error('焼き場は畳んでいます'));
  return new Promise((resolve, reject) => {
    (background ? later : urgent).push({ run, resolve, reject, tag });
    pump().catch(() => { /* 個々の失敗は task 側で受けている */ });
  });
}


// 自分の側の裏仕事だけ取り下げる (prefix)。今すすめている札 (keep) は残す。
// 机上版と手のひら版が同じ行列を使うので、'' で全消しすると互いの用意を消し合う
function dropBackgroundExcept(prefix, keep) {
  for (let i = later.length - 1; i >= 0; i -= 1) {
    const tag = String(later[i].tag || '');
    if (!tag.startsWith(prefix) || tag === keep) continue;
    later[i].resolve(null);
    later.splice(i, 1);
  }
}

// 裏で焼いている続きを取り下げる。別の本を開いた時に、前の本の残りを追わせない
function dropBackground(tag) {
  for (let i = later.length - 1; i >= 0; i -= 1) {
    if (tag && later[i].tag !== tag) continue;
    later[i].resolve(null);
    later.splice(i, 1);
  }
}

function callWindow(expression) {
  return ensureWindow().then((target) => target.webContents.executeJavaScript(expression));
}

// 頁数と、頁ごとの縦横比。縦送りの枠を先に決めるのに要る
function shape(file) {
  return schedule(() => callWindow(`shape(${JSON.stringify(file)})`));
}

// options.quality で既定 (端末向けの軽さ優先) を上書きできる。母艦の読書は高めで焼く
function bakePdfPage(file, index, width, format, options = {}) {
  const type = typeFor(format);
  const quality = Number(options.quality) || QUALITY[format] || QUALITY.webp;
  const call = `bake(${JSON.stringify(file)},${Number(index)},${Number(width)},${JSON.stringify(type)},${quality})`;
  return schedule(() => callWindow(call), options)
    .then((base64) => (base64 ? { bytes: Buffer.from(base64, 'base64'), type } : null));
}

function fitImage(bytes, width, format, options = {}) {
  const type = typeFor(format);
  const quality = QUALITY[format] || QUALITY.webp;
  const source = Buffer.from(bytes).toString('base64');
  const call = `fit(${JSON.stringify(source)},${Number(width)},${JSON.stringify(type)},${quality})`;
  return schedule(() => callWindow(call), options)
    .then((base64) => (base64 ? { bytes: Buffer.from(base64, 'base64'), type } : null));
}

// 待っている分を捌ききってから畳む。焼き途中の窓を落とすと呼び手が待ちっぱなしになる
function close() {
  if (closing) return closing;
  dropBackground('');
  closing = new Promise((resolve) => {
    const wait = () => {
      if (pumping || urgent.length || later.length) {
        setTimeout(wait, 50);
        return;
      }
      clearIdle();
      dropWindow();
      resolve();
    };
    wait();
  }).then(() => {
    closing = null;
  });
  return closing;
}

// 起動後に窓だけ先に立てておく (初めての本で 1 秒ほど待たされるのは窓の用意)。
// 立てても pump は動かさないので、最初の注文まで畳まれない
function prepare() {
  if (closing) return Promise.resolve(null);
  return ensureWindow().catch(() => null);
}

module.exports = {
  snapWidth, shape, bakePdfPage, fitImage, dropBackground, dropBackgroundExcept,
  close, prepare, WIDTHS, NATIVE,
};
