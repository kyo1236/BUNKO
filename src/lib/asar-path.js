const fs = require('fs');

// asar に固めると、中の .wasm や worker の原本は「ファイル」として外部に見えない。
// electron-builder の asarUnpack で app.asar.unpacked 側にも原本を置いてあるので、
// パスをそちらへ差し替える。開発中 (asar 無し) は素通り。
function unpackedPath(p) {
  if (typeof p !== 'string' || !p.includes('app.asar')) return p;
  const unpacked = p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  try {
    if (fs.existsSync(unpacked)) return unpacked;
  } catch { /* ignore */ }
  return p;
}

module.exports = { unpackedPath };
