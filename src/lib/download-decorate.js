'use strict';

// 済んだ仕事の「どこに在るか」を三つに分けて画面へ渡す。
//
//   downloadDest — 落としている間の置き場 (job.dest)。ここは Eagle の見張り
//     フォルダなので、取り込みが済むと **実体ごと消える**。済んだ仕事の
//     「開く」がここを開こうとして、消えた網越しの道にぶつかっていた
//   eagleItemId — 取り込まれた先の Eagle アイテム。「開く」はこれを使う
//   finalPath — 取り込み後に手元から辿れる道 (アイテムの .info)。
//     「フォルダ内で表示」はこれが在るときだけ効かせる
//
// 引くのは索引だけ (ネットワークにも実体にも触らない)。進捗は毎秒何度も
// 流れるので、ここに stat を置くと SMB が寝ている間そのぶん画面が止まる。
//
// 取り込みが済むまで (ダウンロード後の走査は 3 分のデバウンス) は eagleItemId が
// 無い。そのときは空のまま返し、画面は釦を死なせて理由を出す — 無い行き先を
// 掴ませて失敗させるより、待ちだと言うほうが正直
const { galleryKeyOf, pawTriple, parseId } = require('./sources/ids');

function eagleItemIdOf(job, { catalog, pawLinks, pixivLibrary }) {
  const parsed = parseId(job.id);
  if (parsed.source === 'pixiv') {
    // 取り込み (importer) が入れた id が先。無ければ台帳 (索引の url からも引ける)
    if (job.eagleItemId) return String(job.eagleItemId);
    const lib = typeof pixivLibrary === 'function' ? pixivLibrary() : pixivLibrary;
    return lib && typeof lib.eagleIdOf === 'function' ? lib.eagleIdOf(parsed.key) : null;
  }
  const triple = pawTriple(job.id);
  if (triple) {
    if (!pawLinks || typeof pawLinks.getPost !== 'function') return null;
    return pawLinks.getPost(triple.service, triple.user, triple.postId) || null;
  }
  const key = galleryKeyOf(job.id);
  if (key == null || !catalog || !catalog.eagleByGallery) return null;
  return catalog.eagleByGallery.get(key) || null;
}

function finalPathOf(eagleItemId, { catalog, pawLibrary }) {
  if (!eagleItemId) return '';
  if (catalog && catalog.eagleBasePath) {
    const known = catalog.eagleBasePath.get(eagleItemId);
    if (known) return known;
  }
  // pawchive の所持アイテムは台帳ではなく向こうの控えが道を知っている
  if (pawLibrary && typeof pawLibrary.itemFolder === 'function') {
    return pawLibrary.itemFolder(eagleItemId) || '';
  }
  return '';
}

function decorateJobs(jobs, deps = {}) {
  return (jobs || []).map((job) => {
    if (!job || job.status !== 'done') {
      return { ...job, downloadDest: (job && job.dest) || '' };
    }
    let eagleItemId = null;
    try {
      eagleItemId = eagleItemIdOf(job, deps);
    } catch {
      eagleItemId = null;
    }
    let finalPath = '';
    try {
      finalPath = finalPathOf(eagleItemId, deps);
    } catch {
      finalPath = '';
    }
    return {
      ...job, downloadDest: job.dest || '', eagleItemId, finalPath,
    };
  });
}

module.exports = { decorateJobs };
