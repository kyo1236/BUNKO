'use strict';

// PDF の頁に貼られた画像の「原寸」を、pdf.js の描画命令から拾う。
//
// 頁の寸法 (getViewport scale 1) は 72dpi のポイント値で、595x842 の頁に 2150x3035 の
// 絵が貼ってあるのが普通。scale 1 で描くと絵は 1/4 に潰れる。
// 焼き場が「縮めない」ためには、貼られた絵そのものの幅で描く必要がある。
//
// baker.html (窓の中) と test (node) の両方から読むので、module があれば exports、
// 無ければ window.nativeWidth に置く

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.nativeWidth = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // ops:       pdfjs の OPS (命令番号の表)
  // fnArray:   getOperatorList() の fnArray
  // argsArray: 同 argsArray
  // lookup:    名前 → 画像 (page.objs.get)。無い名前には null を返すこと
  // 戻り: 一番大きな絵の幅。絵が無ければ 0
  function pick(ops, fnArray, argsArray, lookup) {
    var best = 0;
    for (var i = 0; i < fnArray.length; i += 1) {
      var fn = fnArray[i];
      var args = argsArray[i] || [];
      var image = null;
      if (fn === ops.paintImageXObject || fn === ops.paintImageXObjectRepeat) {
        image = lookup(args[0]);
      } else if (fn === ops.paintInlineImageXObject) {
        image = args[0];
      }
      var width = image && Number(image.width);
      if (width > best) best = width;
    }
    return best;
  }

  return { pick: pick };
});
