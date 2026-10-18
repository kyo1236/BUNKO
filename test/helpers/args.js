'use strict';

// 子プロセスに渡した引数から「この旗の値」を読む。偽エンジンが書き出した控え
// (--fake-dump) を検分する口はどのテストでも同じ形なので、写しを増やさずここに置く

function argValue(args, name) {
  const list = Array.isArray(args) ? args : [];
  const at = list.indexOf(name);
  return at >= 0 && at + 1 < list.length ? list[at + 1] : null;
}

module.exports = { argValue };
