// 設定・窓・外部連携の IPC (settings / save-settings / choose-folder / open-folder /
// show-in-folder / toggle-fullscreen / open-external / open-eagle / reading-get / reading-set)
const pawCookies = require('../../lib/paw-cookies');
const { ipcMain, dialog, shell } = require('electron');
const { allowedHosts } = require('../../lib/sources');

function registerSettingsIpc(deps) {
  const ipcMain = deps.ipcMain || require('electron').ipcMain;
  const {
    config, downloader, reading, settingsView, getMainWindow,
  } = deps;

  ipcMain.handle('settings', async () => settingsView(config.load()));

  ipcMain.handle('reading-get', async (_event, id) => reading.get(id));
  ipcMain.handle('reading-set', async (_event, id, entry) => reading.set(id, entry));

  ipcMain.handle('save-settings', async (_event, partial) => {
    const next = config.save(partial || {});
    pawCookies.setCookieFile(next.pawCookieFile);
    downloader.setLimits({
      concurrency: next.concurrency,
      maxGalleries: next.maxGalleries,
    });
    return settingsView(next);
  });

  // 選び先ごとに、開く場所と書き戻す設定の鍵が違うだけ
  const FOLDER_KINDS = {
    eagle: { title: 'Eagle ライブラリ', key: 'eagleLibrary' },
    pawBulk: { title: 'Pawchive の置き場', key: 'pawBulkDir' },
    download: { title: '取り込み先フォルダ', key: 'downloadDir' },
    syncDest: { title: '同期先 (写しの置き場)', key: 'syncDest' },
  };

  ipcMain.handle('choose-folder', async (_event, kind) => {
    const current = config.load();
    const pickOnly = kind && typeof kind === 'object' && kind.pickOnly === true;
    const target = FOLDER_KINDS[pickOnly ? kind.kind : kind] || FOLDER_KINDS.download;
    const result = await dialog.showOpenDialog(getMainWindow(), {
      title: target.title,
      defaultPath: current[target.key] || undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (pickOnly) return { path: result.canceled ? null : result.filePaths[0] || null };
    if (result.canceled || !result.filePaths[0]) return settingsView(current);
    return settingsView(config.save({ [target.key]: result.filePaths[0] }));
  });

  ipcMain.handle('open-folder', async (_event, target) => {
    if (target) {
      await shell.openPath(String(target));
      return true;
    }
    const current = config.load();
    await shell.openPath(current.downloadDir);
    return true;
  });

  ipcMain.handle('show-in-folder', async (_event, target) => {
    const dest = String(target || '').trim();
    if (!dest) return false;
    shell.showItemInFolder(dest);
    return true;
  });

  ipcMain.handle('toggle-fullscreen', async () => {
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    mainWindow.setFullScreen(!mainWindow.isFullScreen());
    return mainWindow.isFullScreen();
  });

  ipcMain.handle('open-caption-url', async (_event, value) => {
    const url = require('../../lib/caption-link').captionWebUrl(value);
    await shell.openExternal(process.platform === 'win32' ? `microsoft-edge:${url}` : url);
    return true;
  });

  ipcMain.handle('open-external', async (_event, url) => {
    // 許可ドメインは各アダプタの hosts 宣言から集める (サイト追加時の直し忘れ防止)
    const hosts = allowedHosts().map((h) => h.replace(/\./g, '\\.')).join('|');
    if (typeof url === 'string' && new RegExp(`^https://(${hosts})/`, 'i').test(url)) {
      await shell.openExternal(url);
    }
  });

  ipcMain.handle('open-eagle', async (_event, eagleId) => {
    const id = String(eagleId || '').trim();
    if (!id || /[^A-Za-z0-9_-]/.test(id)) return false;
    await shell.openExternal(`eagle://item/${id}`);
    return true;
  });
}

module.exports = { registerSettingsIpc };
