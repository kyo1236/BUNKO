const path = require('path');
const config = require('./config');
const pawLibrary = require('./paw-library');
const pawBulk = require('./paw-bulk');
const pawchive = require('./sources/pawchive');
// 置き場の名前 (隠し箱の名・実体に埋まった hash) は取り込みエンジン側に一本だけ
// 持たせる。ここで文字列を書き写すと、片方だけ直したときに落とし先がずれる
const { STAGING_DIR, fileHashOf } = require('./kemono-engine');

// pawchive の 保存 は一括更新と同じ棚に落とす。
// 手で押したぶんだけ別の場所・別の名前・別の中身になると、Eagle の自動振り分け
// (<出力先>/<service>/<作者 [id]>/ を見て 作者フォルダへ入れる) から外れて 未分類 に落ちる。
//
// 行き先を決められないとき (出力先が未設定・置くものが何も無い・pawchive ではない) は
// null を返す。pawchive の保存はこの道でしか通さないので、呼ぶ側は「落とし先を
// 決められなかった仕事」として手を止める (API 直取りへは落とさない)

// 実体の引き当ては名前に埋まった hash (64 桁の 16 進) の一致で行う: 取り込みを
// 任せる外部エンジン (kemono-dl) がその名で落とすので、hash の取れない添付が
// 一つでも混ざる投稿はこの道では扱えない (fileHashOf は kemono-engine の見立て)

async function pawSaveRoute(id, gallery) {
  if (!gallery || gallery.error || gallery.source !== 'pawchive') return null;
  const triple = pawLibrary.pawTriple(gallery.id);
  if (!triple) return null;
  const root = String(config.load().pawBulkDir || '').trim();
  if (!root) return null;

  const { service, user, postId } = triple;
  // 一覧の行は添付を欠くことがある: 綴じる前に本体を引き直す
  const post = await pawchive.bulk.fetchPost(service, user, postId);
  // 仕分けの決まりは一括更新と共有する。返しの並びがそのまま綴じ順になる
  const sorted = pawBulk.classifyFiles(pawchive.bulk.postFiles(post));
  // 本文画像だけ。表紙は別枠に回す: zip が中身を 1 冊にまとめたなら表紙は要らず、
  // まとまらなかったときだけ見出し代わりに綴じる (どちらかは落としてみるまで
  // 分からないので、ここでは決めずに両方を渡す)
  const files = sorted.images;
  // 表紙は本文があるときは載せない (classifyFiles の spareCover がその判断を持つ)
  const cover = sorted.spareCover;
  const zips = sorted.zips;
  // zip 配布の投稿 (サムネ 1 枚 + 本編 zip) は本文画像が 0 枚。置くものが
  // 一つでもあれば道は通す
  if (!files.length && !zips.length && !cover) return null;
  const needed = [...files, ...zips, ...(cover ? [cover] : [])];
  if (needed.some((file) => !fileHashOf(file.path))) return null;

  let name = user;
  try {
    name = (await pawchive.bulk.creatorIndex()).get(`${service}:${user}`) || user;
  } catch {
    // 作者名が引けなくても id だけで棚は決まる
  }
  const date = pawBulk.toYmd(post.published || post.added) || '00000000';
  return {
    downloadDir: path.join(
      root,
      pawBulk.sanitizeSegment(service, 40),
      pawBulk.creatorDirName(name, user),
    ),
    // 取り込みの途中経過を置く場所。先頭のドットで catalog / Eagle の走査から外れ、
    // 出力先と同じボリュームに切ってあるので綴じ終わりの片付けも軽い。
    // 仕事ごとに分けるのは、同じ作者の別の投稿と落ちかけを混ぜないため
    stagingDir: path.join(root, STAGING_DIR, `dl-${String(id).replace(/[<>:"/\\|?*]/g, '_')}`),
    // 本文 PDF と zip の茎に使う名。枚数は本文画像だけで決める (一括更新の
    // zipBase と同じ勘定): 表紙の有無で zip 由来の本の名前が振れると、
    // 同じ投稿を二つの道で保存したときに別の名前が並ぶ
    baseName: pawBulk.workName(date, postId, post.title, files.length),
    // 表紙 1 枚だけを綴じることになったときの名。【1P】が付く形は一括更新と同じ
    coverBaseName: cover ? pawBulk.workName(date, postId, post.title, 1) : '',
    pawKey: `${service}:${user}:${postId}`,
    // 取り込みは頁ごとの API ではなく投稿ごと外部エンジンに渡す
    postUrl: pawchive.buildPostUrl(service, user, postId),
    files,
    zips,
    cover,
  };
}

module.exports = { pawSaveRoute };
