// LAN 共有の IPC (lan-share)。開閉と様子見だけで、配信本体は LanServer が持つ
const { ipcMain } = require('electron');

function registerLanIpc(deps) {
  const ipcMain = deps.ipcMain || require('electron').ipcMain;
  const { config, whenCatalog, getLanServer } = deps;

  // LAN 共有。台帳を読むので、開ける前に待ち合わせる
  ipcMain.handle('lan-share', async (_event, payload) => {
    await whenCatalog();
    const lanServer = getLanServer();
    if (!lanServer) return { running: false, error: 'まだ用意ができていません' };
    const request = payload || {};
    if (request.action === 'start') {
      const status = await lanServer.start(request.address || '');
      // 開けた時だけ覚える。開けられなかった設定を残すと次の起動で黙って失敗する
      config.save({ lanShare: status.running });
      return status;
    }
    if (request.action === 'stop') {
      const status = await lanServer.stop();
      config.save({ lanShare: false });
      return status;
    }
    return lanServer.status();
  });
}

module.exports = { registerLanIpc };
