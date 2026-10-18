const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildPdf } = require('./pdf-builder');
const { ensureComplete } = require('./pdf-report');
const { imageSize } = require('./image-size');
const zipExtract = require('./zip-extract');
// 画像の線は取り込みエンジン側に一本だけ持たせる。ここで書き写すと、片方だけ
// 直したときに「エンジンは落とすのにこちらは綴じない」種別が生まれる
const { IMAGE_TYPES } = require('./kemono-engine');

// pawchive の zip 配布 (サムネ 1 枚 + 本編 zip) を本の形に直す一手。
// 一括更新と手動保存が同じ答えを出さないと、同じ投稿を二つの道で保存したときに
// 別の名前・別の中身が並ぶ: 判断はこの一箇所だけに持つ。
//
// 決まりは二つだけ。作者ごとにフォルダの切り方が違うので賢い推測はしない:
//   - 中に絵が 1 枚でもあれば、junk を除いて階層順に 1 冊の PDF にする。
//     残り (psd/txt/動画/未知のファイル) も zip 自体も置かない
//   - 絵が 1 枚も無い zip だけは書庫のまま置く。捨ててしまうと中身が
//     丸ごと失われるので、そこだけは安全弁を残す

const IMAGE_SET = new Set(IMAGE_TYPES);

// 展開した後の道はもう添付ではない (name も hash も無い) ので拡張子だけで見る
function isImagePath(file) {
  return IMAGE_SET.has(path.extname(String(file || '')).slice(1).toLowerCase());
}

// 書きかけを Eagle の取り込みや catalog の走査に拾わせないよう、.part に書いてから
// 名前を付け替える。同名が居れば置き換える (同じ投稿の組み直しは同じ中身を作る)
function copyInto(source, dest) {
  const part = `${dest}.part`;
  try {
    fs.copyFileSync(source, part);
    fs.renameSync(part, dest);
  } catch (error) {
    try { fs.rmSync(part, { force: true }); } catch { /* 消せなくても本体の判断は変わらない */ }
    throw error;
  }
  return dest;
}

// zip 1 つを destDir に置き直す。返すのは置いたもの:
//   { pdf: 綴じた本の道 | null, zip: 書庫のまま置いた道 | null, pages: 綴じた枚数 }
// stem は拡張子も 【NP】 も付かない名の茎 (呼び手が命名の約束を握る)。
// 名前は投稿の中身だけで決まるので、同じ zip を二度通しても (2) は生まれず上書きになる
async function convertZip({ zipPath, destDir, stem }) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pawzip-'));
  try {
    fs.mkdirSync(destDir, { recursive: true });
    // extract は階層順 (フォルダ major の自然順) で返す。それがそのまま綴じ順
    const entries = await zipExtract.extract(zipPath, workDir);
    // 0 バイトは掴んだだけで中身の来なかった欠片。綴じても白紙になる
    const images = entries.filter((entry) => isImagePath(entry) && fs.statSync(entry).size > 0);
    if (!images.length) {
      const ext = path.extname(zipPath) || '.zip';
      return { pdf: null, zip: copyInto(zipPath, path.join(destDir, `${stem}${ext}`)), pages: 0 };
    }

    // 綴じる前に通し番号で平坦にする。pdf-builder が「同じフォルダの相対 src」で
    // 頁を組むこと、そして階層をまたいだ同名 (A/1.jpg と B/1.jpg) がぶつからない
    // ようにすること、二つの都合がある
    const flat = path.join(workDir, '_pages');
    fs.mkdirSync(flat, { recursive: true });
    const pages = images.map((entry, index) => {
      const target = path.join(flat, `${String(index).padStart(4, '0')}${path.extname(entry)}`);
      fs.renameSync(entry, target);
      // 実寸を測らないと pdf-builder の既定 (A4 相当) に引き伸ばされて絵が歪む
      const size = imageSize(fs.readFileSync(target)) || {};
      return { file: target, width: size.width || null, height: size.height || null };
    });
    const pdf = path.join(destDir, `${stem}【${pages.length}P】.pdf`);
    // buildPdf は .part に書いてから rename する: 途中で落ちても半端な PDF は残らない。
    // 頁が一枚でも開けなかったら投げる: 呼び手がこの後 zip ごと原本を片付けるため
    ensureComplete(await buildPdf({ pages, dest: pdf }), 'ZIP の取り込み');
    return { pdf, zip: null, pages: pages.length };
  } catch (error) {
    throw new Error(`ZIP の取り込みに失敗しました (${stem}): ${(error && error.message) || error}`);
  } finally {
    // 展開したぶんは必ず畳む (絵も psd も txt も、置き直した後には要らない)
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = { convertZip, copyInto };
