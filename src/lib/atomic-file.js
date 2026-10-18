const fs = require('fs');
const path = require('path');

// tmp に書いてから rename で差し替える。書き込みの途中で落ちても
// 「壊れた本体」ではなく「前回の完全な本体 + tmp の残骸」で済む。
// config.json / jobs.json / reading.json / paw-links.json のように
// 「壊れたら黙って既定値に戻る」読み手を持つファイルは必ずこれで書く
function writeFileAtomicSync(target, data) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}`;
  // rename の前に中身をディスクへ落とす。電源断で「rename だけ残って
  // 中身が全部ゼロ」のファイルができるのを防ぐ
  const fd = fs.openSync(temp, 'w');
  try {
    fs.writeSync(fd, Buffer.isBuffer(data) ? data : Buffer.from(data));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(temp, target);
  } catch (error) {
    try {
      fs.unlinkSync(temp);
    } catch {
      // 掃除に失敗しても本体は無事
    }
    throw error;
  }
}

module.exports = { writeFileAtomicSync };
