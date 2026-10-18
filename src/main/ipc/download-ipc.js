// ダウンロードの IPC (downloads / download / cancel / retry-download / clear-finished /
// reader-active)。実体は Downloader が持ち、ここは口だけ
const { ipcMain } = require('electron');

function registerDownloadIpc(deps) {
  const ipcMain = deps.ipcMain || require('electron').ipcMain;
  const {
    config, downloader, whenCatalog, decorateJobs,
  } = deps;
  // 押し出し (downloader.on('update')) と同じ飾りをここにも通す。
  // 片方だけだと、控え室を開き直したときに「開く」の行き先が消える
  const decorate = (jobs) => (typeof decorateJobs === 'function' ? decorateJobs(jobs) : jobs);

  // 復帰が済むまでは空を返してしまうので、台帳と一緒に待つ
  ipcMain.handle('downloads', async () => {
    await whenCatalog();
    return decorate(downloader.snapshot());
  });

  ipcMain.handle('download', async (_event, id, title) => {
    const current = config.load();
    return downloader.enqueue({
      id,
      title,
      downloadDir: current.downloadDir,
      format: current.saveFormat,
    });
  });

  ipcMain.handle('cancel', async (_event, id) => {
    downloader.cancel(id);
    return decorate(downloader.snapshot());
  });

  ipcMain.handle('retry-download', async (_event, id) => {
    downloader.retry(id);
    return decorate(downloader.snapshot());
  });

  ipcMain.handle('clear-finished', async () => decorate(downloader.clearFinished()));

  ipcMain.handle('reader-active', async (_event, active) => {
    downloader.setInteractive(Boolean(active));
    return true;
  });
}

module.exports = { registerDownloadIpc };
