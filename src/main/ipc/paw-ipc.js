// pawchive の IPC (paw-favorites / paw-links / paw-bulk)。お気に入り作者・手動紐付け・
// 一括更新。読み書き混在の口なので、読み取り専用モードは各ハンドラの中の枝で塞ぐ
const { ipcMain } = require('electron');

function registerPawIpc(deps) {
  const ipcMain = deps.ipcMain || require('electron').ipcMain;
  const {
    pawFavorites, pawLibrary, pawLinks, whenCatalog,
    readOnly, READ_ONLY_ERROR, send, getPawBulk, getPawImporter = () => null,
  } = deps;

  ipcMain.handle('paw-favorites', async (_event, payload) => {
    const request = payload || {};
    if (request.action === 'toggle') {
      // 一覧 (読み) は残し、書き込みの toggle だけ塞ぐ
      if (readOnly) throw new Error(READ_ONLY_ERROR);
      return pawFavorites.toggle(request.service, request.user);
    }
    return { list: pawFavorites.list() };
  });
  // pawchive の手動紐付け。作者 → Eagle のフォルダ、投稿 → Eagle のアイテム。
  // 名前に [postId] が入っていない作品は自動照合が届かないので、ここが唯一の口
  ipcMain.handle('paw-links', async (_event, payload) => {
    const request = payload || {};
    const { action, service, user, name, postId, eagleId, folderId, query } = request;

    // 紐付けの書き込み三口だけ塞ぐ (creator-of / candidates などの読みは残す)
    if (readOnly && (action === 'map-creator' || action === 'link' || action === 'unlink')) {
      throw new Error(READ_ONLY_ERROR);
    }
    if (action === 'creator-folders' || action === 'creator-of' || action === 'candidates') {
      await pawLibrary.ready();
    }

    if (action === 'creator-folders') {
      return { folders: pawLibrary.creatorFolders() };
    }

    if (action === 'map-creator') {
      pawLinks.setCreator(service, user, folderId);
      pawLinks.flush();
      return { creator: pawLibrary.resolveCreatorFolder(service, user, name) };
    }

    if (action === 'creator-of') {
      return { creator: pawLibrary.resolveCreatorFolder(service, user, name) };
    }

    if (action === 'candidates') {
      const creator = pawLibrary.resolveCreatorFolder(service, user, name);
      // 語で全体から探し、縁のある作者フォルダのものを上に寄せる。
      // 語が無ければそのフォルダの中身をそのまま (未紐付けが先)
      const items = pawLibrary.candidateItems({
        query,
        folderId: creator.folderId,
      });
      return { creator, items, folders: pawLibrary.creatorFolders() };
    }

    if (action === 'link') {
      const value = pawLinks.setPost(service, user, postId, eagleId);
      if (!value) return { ok: false };
      pawLinks.flush();
      return { ok: true, eagleId: value };
    }

    if (action === 'unlink') {
      const ok = pawLinks.removePost(service, user, postId);
      if (ok) pawLinks.flush();
      return { ok };
    }

    return { ok: false };
  });

  // お気に入り作者の一括更新。走らせる/止める/今の様子、の 3 つだけ。
  // 進捗は paw-bulk-progress で押し出す (library-progress と同じ流し方)
  ipcMain.handle('paw-bulk', async (_event, payload) => {
    await whenCatalog();
    const pawBulk = getPawBulk();
    if (!pawBulk) return { running: false };
    const action = (payload && payload.action) || 'status';
    // 様子見 (status) は読み。走らせる/止める、だけ塞ぐ
    if (readOnly && action !== 'status') throw new Error(READ_ONLY_ERROR);
    // 出力先に取り残された PDF/zip (Eagle に入っていない物) を、期限なしで取り込みに積む
    if (action === 'import-leftovers') {
      const importer = getPawImporter();
      if (!importer) return { queued: 0 };
      const root = String(payload && payload.root || (require('../../lib/config').load().pawBulkDir) || '').trim();
      const picked = root ? importer.sweep(root, { maxAgeMs: 0 }) : [];
      return { queued: picked.length, pending: importer.pending() };
    }
    if (action === 'start') {
      pawBulk.start()
        .then((status) => send('paw-bulk-progress', status))
        .catch(() => {});
    } else if (action === 'stop') {
      pawBulk.stop();
    }
    return pawBulk.status();
  });
}

module.exports = { registerPawIpc };
