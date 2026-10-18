// テストを Electron の外で走らせるための 'electron' スタブ。
// 対象モジュールを require するより前にこのファイルを require しておくこと。
// (素の node では electron パッケージはバイナリのパス文字列を返すため、
//  const { app } = require('electron') の app が undefined になり落ちる)
const path = require('path');
const os = require('os');

const stub = {
  app: {
    // userData などの置き場は一時領域へ逃がす。テストからは実際に触らない
    getPath: () => path.join(os.tmpdir(), 'bookshelf-test-userdata'),
    getName: () => 'bookshelf-test',
  },
};

let resolved = null;
try {
  resolved = require.resolve('electron');
} catch {
  resolved = 'electron'; // パッケージが無い環境でも同じ鍵で差し込む
}

if (!require.cache[resolved]) {
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: stub,
  };
}

module.exports = stub;
