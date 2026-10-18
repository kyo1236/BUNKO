'use strict';

// electron を偽物に差し替えてから src/lib 配下を require するための道具。
// userData は毎回作る一時ディレクトリへ向け、実際の設定・台帳・キャッシュには触れない。
// (別系統のテストが test/helpers/stub-electron.js を持つ場合に備え、こちらは -2 の名)

const fs = require('fs');
const os = require('os');
const path = require('path');

let installed = null;

function installStub() {
  if (installed) return installed;
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bunko-test-'));
  const fake = {
    app: {
      // どの名前 (userData / cache など) でも一時ディレクトリを返す
      getPath: () => userData,
      getAppPath: () => path.join(__dirname, '..', '..'),
      isPackaged: false,
    },
    BrowserWindow: class BrowserWindow {},
    ipcMain: { handle() {}, on() {}, removeHandler() {} },
    shell: {},
    nativeImage: {},
  };
  const key = require.resolve('electron');
  require.cache[key] = { id: key, filename: key, loaded: true, exports: fake };
  installed = { fake, userData };
  return installed;
}

module.exports = { installStub };
