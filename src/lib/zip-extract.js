const fs = require('fs');
const path = require('path');
const yauzl = require('yauzl');

// zip を作業フォルダへ展開する。
// 罠は 2 つ: 入り口の名前が "../" や絶対パスで外へ出ようとするもの (zip slip) と、
// 展開すると桁違いに膨らむもの。どちらも書き出す前に弾く。

const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ENTRIES = 5000;

// 数字は数として比べる (2.webp を 10.webp より前に置く)。
// 相手の後処理スクリプト (processor.py の natural_key) と同じ並び
function naturalParts(name) {
  return String(name).toLowerCase().split(/(\d+)/).map((part) => (/^\d+$/.test(part) ? Number(part) : part));
}

// 名前ひとつ (階層の一区切り) を自然順で比べる
function comparePart(a, b) {
  const left = naturalParts(a);
  const right = naturalParts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const x = left[i];
    const y = right[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x - y;
    } else if (String(x) !== String(y)) {
      return String(x) < String(y) ? -1 : 1;
    }
  }
  return 0;
}

// 道のりを区切りで割る。展開先は皆同じなので、絶対パスのまま比べても
// 頭の何段かが揃って消えるだけで、効くのは zip の中の相対位置になる
function pathParts(value) {
  return String(value).split(/[\\/]+/).filter(Boolean);
}

// 綴じ順は「フォルダが先、その中を自然順で」。基準名だけで比べていたころは、
// 章ごとにフォルダを切った zip で A/1, B/1, A/2 … と章が交錯した本になった
// (中身が 1.jpg, 2.jpg … の作者は珍しくないので、名前だけでは章が混ざる)
function naturalCompare(a, b) {
  const left = pathParts(a);
  const right = pathParts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    // 浅い方が先: フォルダの中身より、その隣に置かれた頁を前に置く
    if (left[i] === undefined) return -1;
    if (right[i] === undefined) return 1;
    const order = comparePart(left[i], right[i]);
    if (order) return order;
  }
  // 自然順で差の付かない綴じ (大文字小文字の違いだけ) は道のりで決める
  return String(a) < String(b) ? -1 : (String(a) > String(b) ? 1 : 0);
}

// 展開先の中に収まる道のりだけを通す。収まらない名前は「無かったこと」にする
function safeTarget(root, name) {
  const clean = String(name || '').replace(/\\/g, '/');
  if (!clean || clean.endsWith('/')) return null;
  if (path.isAbsolute(clean) || /^[A-Za-z]:/.test(clean)) return null;
  const target = path.resolve(root, clean);
  const base = path.resolve(root);
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}

function openZip(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (error, zipfile) => {
      if (error) reject(error);
      else resolve(zipfile);
    });
  });
}

// 展開して、書き出したファイルの絶対パスを名前順で返す
function extract(file, dir) {
  return new Promise((resolve, reject) => {
    openZip(file).then((zipfile) => {
      const written = [];
      let total = 0;
      let count = 0;
      let failed = null;

      const fail = (error) => {
        if (failed) return;
        failed = error;
        try { zipfile.close(); } catch { /* ignore */ }
        reject(error);
      };

      zipfile.on('error', fail);
      zipfile.on('end', () => {
        if (!failed) resolve(written.sort(naturalCompare));
      });

      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        if (failed) return;
        count += 1;
        if (count > MAX_ENTRIES) {
          fail(new Error(`zip の中身が多すぎます (${MAX_ENTRIES} 超)`));
          return;
        }
        total += Number(entry.uncompressedSize) || 0;
        if (total > MAX_TOTAL_BYTES) {
          fail(new Error('zip の展開後が大きすぎます'));
          return;
        }
        const target = safeTarget(dir, entry.fileName);
        // フォルダの入り口と、外へ出ようとする名前は読み飛ばす
        if (!target) {
          zipfile.readEntry();
          return;
        }
        zipfile.openReadStream(entry, (error, stream) => {
          if (error) {
            fail(error);
            return;
          }
          try {
            fs.mkdirSync(path.dirname(target), { recursive: true });
          } catch (mkdirError) {
            fail(mkdirError);
            return;
          }
          const out = fs.createWriteStream(target);
          stream.on('error', fail);
          out.on('error', fail);
          out.on('finish', () => {
            written.push(target);
            zipfile.readEntry();
          });
          stream.pipe(out);
        });
      });
    }).catch(reject);
  });
}

module.exports = { extract, naturalCompare, safeTarget };
