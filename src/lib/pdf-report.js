'use strict';

// PDF を綴じた結果の「報告」の形と、その読み方。
//
// pdf-builder (= electron の隠し窓) から分けてあるのは二つの都合:
//   1. 呼び手は報告の読み方だけが要る。電子の窓を引き込まずに済む
//   2. 試験が pdf-builder を丸ごと差し替えても、判じは本物のまま通る
//      (差し替えに埋もれると「原本を消してよいか」の判断が試験されなくなる)
//
// 報告: { dest, total, decoded, failed: [開けなかった頁の番号], published }
// published = dest に実物を据えたか。**欠けた綴じ上がりは据えない**ので false になる

// 綴じ上がりが原本を消してよい出来か。欠けていれば投げる。
// 白紙の頁を含む PDF を「完成」として返し、その後ろで原本を消すのが
// このアプリで唯一の取り返しのつかない失敗だった (docs 項目 9-11)
function ensureComplete(report, what = 'PDF 生成') {
  // 古い形 (dest の文字列だけ) を返す差し替えを落とさない
  if (!report || typeof report !== 'object') return report;
  const failed = Array.isArray(report.failed) ? report.failed : [];
  if (!failed.length) return report;
  const total = Number(report.total) || failed.length;
  const error = new Error(
    `${what}: ${total} 頁のうち ${failed.length} 頁が開けませんでした`
    + ' (白紙の頁を含む PDF になるため、原本は消さずに残します)',
  );
  // 網の不調と区別できるようにする。こちらは「取り切ったが綴じられない」で、
  // 同じ欠片を綴じ直しても結果が変わらない。呼び手は開けなかった頁の控えを
  // 捨ててから積み直す (捨てないと同じ壊れたバイトを綴じ直すだけになる)
  error.incompletePdf = true;
  error.failedPages = failed;
  throw error;
}

function makeReport(dest, total, failed, published = true) {
  const bad = Array.isArray(failed) ? failed : [];
  return { dest, total, decoded: total - bad.length, failed: bad, published: !!published };
}

module.exports = { ensureComplete, makeReport };
