// Home (源泉横断の作者の一覧と作者頁) の IPC。口は一つ ('home') で action で分ける (pixiv と同じ造り)。
// 一覧そのものは search の口 (source: 'home') が返す。ここは作者頁と結びの口
// (docs/home-tab-spec-2026-09-23.md)。
//
//   author   作者頁: 人と所持の本 ({ id } か { query: '@名前 [語]' }。語があれば filter に当たりの id)  読み
//   web      作者頁の網の作品 ({ id, site }。site = hitomi / pawchive / pixiv。
//            未所持も。作者頁を開いた時だけ。所持作品だけの表示では引かない)  読み
//   hitomi   web の site: 'hitomi' と同じ (前の版の画面が呼ぶ名)            読み
//   webHits  網の作品のうち語に当たる物の id ({ id, site, words })。作品の検索で作者頁を絞る時  読み
//   pages    作者頁の所持の本の頁数 ({ id, ids })。機体ごとの控え (page-counts) に数えて置く  読み
//   link     詳細の行の結び (save / accept / reject / unlink)              書き
//   rate     作者の★ ({ id, star }。star 0 で外す)                        書き
//   suggest  突き合わせの候補をまとめて足す ({ rows: [{ id, site, url, note }], by })  書き
//   origin   持ち込みの本の出どころ ({ id, origin: 'discord' | '' })          書き
//   rename   見出しの名前を決める ({ id, name }。'' で元の名前に戻す)          書き
//   cover    見出しの表紙を所持の本から選ぶ ({ id, cover: 本の id }。'' で自動の顔に戻す)  書き
//   undo     元に戻す / やり直す ({ id, steps })。書く口が返した undo の手順を渡す  書き
//
// 読み書き混在の口なので、読み取り専用モード (写し) は書く action だけを中で塞ぐ

const WRITE_ACTIONS = new Set(['link', 'rate', 'suggest', 'origin', 'undo', 'rename', 'cover']);

function registerHomeIpc(deps) {
  const ipcMain = deps.ipcMain || require('electron').ipcMain;
  const {
    whenCatalog, readOnly, READ_ONLY_ERROR, getHomeAuthors,
  } = deps;

  ipcMain.handle('home', async (_event, payload) => {
    const request = payload || {};
    const action = String(request.action || '');
    if (readOnly && WRITE_ACTIONS.has(action)) throw new Error(READ_ONLY_ERROR);
    await whenCatalog();
    const home = typeof getHomeAuthors === 'function' ? getHomeAuthors() : null;
    if (!home) throw new Error('Home の用意ができていません');
    if (action === 'author') return home.author({ id: request.id, query: request.query });
    if (action === 'hitomi') return home.hitomiWorks({ id: request.id });
    if (action === 'pages') return home.pages({ id: request.id, ids: Array.isArray(request.ids) ? request.ids : [] });
    if (action === 'web') return home.webWorks({ id: request.id, site: request.site });
    // 作品の検索で作者頁を絞る時の、網の作品の当たり (読むだけ)
    if (action === 'webHits') {
      return home.webHits({ id: request.id, site: request.site, words: typeof request.words === 'string' ? request.words.slice(0, 400) : '' });
    }
    if (action === 'link') {
      // by / note は結びの出どころ (詳細の釦なら空。突き合わせの道具が根拠を書く)
      return home.link({
        id: request.id, site: request.site, op: request.op, url: request.url,
        by: typeof request.by === 'string' ? request.by.slice(0, 80) : '', note: typeof request.note === 'string' ? request.note.slice(0, 400) : '',
      });
    }
    if (action === 'rate') return home.rate({ id: request.id, star: request.star });
    if (action === 'origin') return home.origin({ id: request.id, origin: request.origin });
    if (action === 'rename') return home.rename({ id: request.id, name: typeof request.name === 'string' ? request.name : '' });
    if (action === 'cover') return home.cover({ id: request.id, cover: typeof request.cover === 'string' ? request.cover : '' });
    if (action === 'undo') return home.undo({ id: request.id, steps: Array.isArray(request.steps) ? request.steps : [] });
    if (action === 'suggest') {
      return home.suggest({ rows: Array.isArray(request.rows) ? request.rows.slice(0, 2000) : [], by: typeof request.by === 'string' ? request.by.slice(0, 80) : '' });
    }
    throw new Error(`home: 知らない action ${action}`);
  });
}

module.exports = { registerHomeIpc, WRITE_ACTIONS };
