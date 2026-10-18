// 棚 (台帳) の IPC (catalog / rescan / sync-homecore / library-* / eagle-trash / eagle-star)。
// 走査・照合・紐付けと Eagle 本体への書き込み、母艦→Homecore の手動同期を束ねる
const fs = require('fs');
const { execFile } = require('child_process');
const { ipcMain } = require('electron');
const { getGallery } = require('../../lib/sources');
const { numericGalleryId, galleryKeyOf } = require('../../lib/catalog');

// 同期スクリプトの多重起動よけ。この口でしか使わないのでモジュールに置く
let syncRunning = false;

function registerLibraryIpc(deps) {
  const ipcMain = deps.ipcMain || require('electron').ipcMain;
  const {
    catalog, config, pawLibrary, pawLinks, whenCatalog, readOnly, send,
    refreshCatalog, runLibraryJobs, afterLinkChange, syncScriptPath,
    getMatchJob, libraryView,
  } = deps;

  ipcMain.handle('catalog', async () => {
    await whenCatalog();
    return catalog.snapshot();
  });
  ipcMain.handle('rescan', async () => {
    await whenCatalog();
    // 写しの上では走査しない (persist で書き戻すため)。代わりにミラーを読み直す
    if (readOnly) {
      catalog.reloadFromDisk();
      const snapshot = catalog.snapshot();
      send('catalog', { ...snapshot, mirrorReloaded: true });
      return snapshot;
    }
    // 釦からの再スキャンは全件を実体に訊く (mtime.json が追いつかない稀な更新の保険)
    const snapshot = await refreshCatalog({ full: true });
    // 後続のジョブは待たずに返す: 画面はスキャン結果をすぐ受け取れる
    runLibraryJobs().catch(() => {});
    return snapshot;
  });
  ipcMain.handle('sync-homecore', async () => {
    if (syncRunning) return { ok: false, message: '同期を実行中です' };
    const script = syncScriptPath();
    if (!fs.existsSync(script)) {
      return { ok: false, message: `同期スクリプトが見つかりません: ${script}` };
    }
    syncRunning = true;
    try {
      await whenCatalog();
      // 写す前に Eagle を再走査して取り込み直後の新着を台帳へ入れる。
      // これをしないと「同期ボタンを押しても再起動まで写らない」になる
      // (ダウンロード後の自動走査は3分デバウンスで、押した時点では未走査のことがある)
      if (!catalog.scanning) {
        try { await refreshCatalog(); } catch { /* 走査に失敗しても手持ちの台帳で写す */ }
      }
      // メモリ上の棚をディスクの catalog.sqlite へ吐き出しておく
      catalog.flushPersist();
      return await new Promise((resolve) => {
        // 送り先は設定から渡す (項目 6-10)。渡さないと script の既定
        // (<写しの置き場>) に行くので、別の場所で毎時タスクを登録していると
        // 釦とタスクで写し先が食い違う
        const dest = String(config.load().syncDest || '').trim();
        const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script];
        if (dest) args.push('-Dest', dest);
        execFile('powershell.exe', args, {
          windowsHide: true,
          timeout: 10 * 60 * 1000,
          maxBuffer: 8 * 1024 * 1024,
        }, (error, stdout, stderr) => {
          if (!error) {
            resolve({ ok: true, message: '同期が完了しました' });
            return;
          }
          if (error.killed) {
            resolve({ ok: false, message: '時間切れで打ち切りました (10分)' });
            return;
          }
          // 全文はミラー先の logs にある。画面へはログ末尾の手がかりだけ
          const tail = `${stdout || ''}\n${stderr || ''}`
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .slice(-3)
            .join(' / ');
          resolve({ ok: false, message: tail || error.message || '同期に失敗しました' });
        });
      });
    } finally {
      syncRunning = false;
    }
  });
  ipcMain.handle('library-status', async () => {
    await whenCatalog();
    // 画面の帯は棚の数だけでなく「今この機体でどうなっているか」も読む
    return typeof libraryView === 'function' ? libraryView() : catalog.libraryStatus();
  });

  ipcMain.handle('library-match', async (_event, action) => {
    await whenCatalog();
    const matchJob = getMatchJob();
    if (matchJob) {
      if (action === 'stop') matchJob.stop();
      // 走査中の開始は空振りする (対象一覧が途中の items から作られる) ので受けない
      else if (!catalog.scanning) matchJob.start().catch(() => {});
    }
    return catalog.libraryStatus();
  });
  // 手動紐付け: 自動照合が届かない作品 (hitomi 側がローマ字題のみ等) を
  // ユーザーの判断で所持に落とす。台帳 (title_matches) は照合器と共用
  ipcMain.handle('library-candidates', async (_event, query) => {
    await whenCatalog();
    try {
      return catalog.searchEagleItems(query, 20);
    } catch {
      return [];
    }
  });

  ipcMain.handle('library-link', async (_event, payload) => {
    await whenCatalog();
    const data = payload || {};
    const eagleId = String(data.eagleId || '').trim();
    // 鎖の鍵はソース付き (hitomi='123' / 'nh:123' / 'eh:...')。pawchive は別台帳
    const galleryKey = galleryKeyOf(data.galleryId);
    if (!eagleId || galleryKey == null) return { ok: false };

    // 付け替えか新規か。書く前に読まないと、繋ぎが外れる側が分からなくなる
    let previousLink = null;
    try {
      previousLink = catalog.linkedGalleryOf(eagleId);
    } catch {
      previousLink = null;
    }
    if (previousLink === galleryKey) previousLink = null; // 同じ相手への付け直し

    // メタは画面が持っているものを優先する。無ければ取りに行くが、
    // 圏外でも紐付けそのものは成立させる (galleries は hitomi 専用のメタ置き場
    // なので、他ソースの鍵では触らない)
    const numericId = numericGalleryId(data.galleryId);
    let meta = data.gallery && !data.gallery.error ? data.gallery : null;
    if (numericId != null) {
      if (!meta && !catalog.hasGalleryMeta(numericId)) {
        try {
          meta = await getGallery(String(numericId));
        } catch {
          meta = null;
        }
      }
      if (meta) {
        try {
          catalog.storeGalleryMeta({ ...meta, id: numericId, source: 'hitomi' });
        } catch {
          // メタが書けなくても紐付けは残す
        }
      }
    }

    let ok = false;
    try {
      // 手で選んだ紐付けは 'manual'。以後の自動照合はこの行を上書きしない
      ok = catalog.addTitleMatch(
        eagleId,
        galleryKey,
        data.itemTitle,
        (meta && meta.title) || data.galleryTitle || '',
        'matched',
        { origin: 'manual' },
      );
    } catch {
      ok = false;
    }
    if (!ok) return { ok: false };
    afterLinkChange();
    // 付け替えなら、繋ぎが外れた側の作品の鍵を返す。画面はその札も取り直す
    return { ok: true, movedFrom: previousLink };
  });

  ipcMain.handle('library-unlink', async (_event, eagleId) => {
    await whenCatalog();
    let ok = false;
    try {
      ok = catalog.removeTitleMatch(eagleId);
    } catch {
      ok = false;
    }
    if (!ok) return { ok: false };
    afterLinkChange();
    return { ok: true };
  });

  // 詳細の削除釦。Eagle 本体をゴミ箱へ送ってから台帳の痕跡を消す。
  // Eagle に書けなければ台帳は触らない (表示だけ未所持に戻ると実体とずれる)
  ipcMain.handle('eagle-trash', async (_event, payload) => {
    await whenCatalog();
    const data = typeof payload === 'string' ? { eagleId: payload } : (payload || {});
    const id = String(data.eagleId || '').trim();
    if (!id || /[^A-Za-z0-9_-]/.test(id)) return { ok: false };
    try {
      await require('../../lib/eagle-api').moveToTrash(id);
    } catch {
      return { ok: false, reason: 'eagle' };
    }
    try {
      catalog.removeEagleItem(id);
    } catch {
      // 台帳の掃除に失敗しても Eagle 側は済んでいる: 次のスキャンで追いつく
    }
    // リモート機 (Homecore) の Eagle にも届ける (remoteEagle 設定があるとき)。
    // 同じライブラリを別インスタンスで開いている向こうは、こちらの削除に
    // すぐ気づかないため。
    //
    // **待たない。** 以前はここを await していたので、向こうが落ちていたり
    // 寝ていたりすると HTTP の時間切れぶん画面が固まっていた (押しても札が
    // 消えない、の主因)。手元の Eagle には既に書けていて、向こうへの配達は
    // 失敗しても次の走査で辻褄が合う。投げるだけ投げて返事は待たない
    const remote = config.load().remoteEagle;
    if (remote && remote.origin) {
      require('../../lib/eagle-api')
        .moveToTrashRemote(remote.origin, remote.token, id)
        .catch(() => {
          // 向こうへ届かなくても手元は済んでいる
        });
    }
    // pawchive の作品なら手動紐付けの控えも道連れにする (無ければ空振りするだけ)
    const paw = data.paw || null;
    if (paw && paw.service && paw.user && paw.postId) {
      try {
        if (pawLinks.removePost(paw.service, paw.user, paw.postId)) pawLinks.flush();
      } catch {
        // 控えが消せなくてもアイテム自体は無い: annotate が空振りするだけ
      }
    }
    try {
      pawLibrary.dropItem(id);
    } catch {
      // 走査キャッシュに残っても TTL 切れの再走査で消える
    }
    afterLinkChange();
    return { ok: true };
  });

  // リーダーの★。Eagle 本体に書いてから、台帳にも写して表示へ即反映する
  ipcMain.handle('eagle-star', async (_event, eagleId, star) => {
    await whenCatalog();
    await pawLibrary.ready();
    const id = String(eagleId || '').trim();
    if (!id || /[^A-Za-z0-9_-]/.test(id)) return { ok: false };
    const value = Math.max(0, Math.min(5, Math.round(Number(star) || 0)));
    try {
      await require('../../lib/eagle-api').setStar(id, value);
    } catch {
      return { ok: false };
    }
    try {
      // **走査の索引にも書く。** 台帳と paw の控えだけに書いていたので、
      // 次の走査が索引の古い meta を返し、items を DELETE→upsert する所で
      // 押した星が丸ごと巻き戻っていた (項目 3-1)。
      // 索引への書き込みは一行の追記で済む (6 MB の控えは書き直さない)
      require('../../lib/eagle-index').indexFor(config.load().eagleLibrary)
        .noteOwnStar(id, value);
      catalog.setEagleItemStar(id, value);
      // pawchive 側の走査キャッシュにも写す: Eagle の書き換えでは images の
      // mtime が動かず、古い星が annotate 経由で画面を巻き戻すため
      pawLibrary.noteStar(id, value);
    } catch {
      // 台帳への反映が落ちても Eagle には書けている: 次のスキャンで追いつく
    }
    // 同じ作品の別アイテム (分冊・別版) にも同じ星を書く。表示は「最高星を
    // 代表」なので、片方だけ下げても残りが高いままだと必ず巻き戻って見える
    const siblings = new Set();
    try {
      for (const sibling of catalog.eagleSiblings(id)) siblings.add(sibling);
    } catch { /* 姉妹が引けなくても本体は済んでいる */ }
    try {
      for (const sibling of pawLibrary.eagleSiblings(id)) siblings.add(sibling);
    } catch { /* 同上 */ }
    siblings.delete(id);
    for (const sibling of siblings) {
      if (/[^A-Za-z0-9_-]/.test(sibling)) continue;
      try {
        await require('../../lib/eagle-api').setStar(sibling, value);
      } catch {
        continue; // Eagle に書けなかった姉妹はそのまま (代表値はまた巻き戻りうる)
      }
      try {
        require('../../lib/eagle-index').indexFor(config.load().eagleLibrary)
          .noteOwnStar(sibling, value);
        catalog.setEagleItemStar(sibling, value);
        pawLibrary.noteStar(sibling, value);
      } catch { /* ignore */ }
    }
    try {
      send('catalog', catalog.snapshot());
    } catch { /* ignore */ }
    return { ok: true, star: value };
  });
}

module.exports = { registerLibraryIpc };
