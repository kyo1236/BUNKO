'use strict';
// 組み上がりの app.asar に「この回で新しく生まれた名前」が入っているかを検める (bunko-release の手順 3)。
//
//   node scripts/tools/asar-check.js src/renderer/bunko-ui.css=--select,ui-key src/lib/catalog.js=linkedGalleryOf [--asar <path>]
//
// 引数は <asar の中の道>=<針1>,<針2>。既定の asar は dist/win-unpacked/resources/app.asar。
// 前から在る名前では「直しが乗ったか」は見分けられない (2026-09-24 の教訓)。針は必ずその回の新しい識別子にする。
const fs = require('fs');
const path = require('path');

function readAsar(file) {
  const buf = fs.readFileSync(file);
  const size = buf.readUInt32LE(12);
  const headerEnd = 16 + size;
  const header = JSON.parse(buf.toString('utf8', 16, headerEnd));
  const base = Math.ceil(headerEnd / 4) * 4;
  return (rel) => {
    let node = header;
    for (const seg of rel.split('/')) { node = node.files && node.files[seg]; if (!node) throw new Error('asar に無い: ' + rel); }
    const off = base + Number(node.offset);
    return buf.toString('utf8', off, off + node.size);
  };
}

function main(argv) {
  const ai = argv.indexOf('--asar');
  const asar = ai >= 0 ? argv[ai + 1] : path.join(process.cwd(), 'dist', 'win-unpacked', 'resources', 'app.asar');
  const checks = argv.filter((a, i) => !a.startsWith('--') && (ai < 0 || i !== ai + 1));
  if (!checks.length) throw new Error('usage: asar-check.js <path>=<needle>[,<needle>] ... [--asar <app.asar>]');
  const read = readAsar(asar);
  let bad = 0;
  for (const c of checks) {
    const [rel, list] = c.split('=');
    const needles = (list || '').split(',').filter(Boolean);
    const text = read(rel);
    const miss = needles.filter((n) => !text.includes(n));
    if (miss.length) bad += 1;
    console.log((miss.length ? '[NG] ' : '[OK] ') + rel + (miss.length ? '  missing: ' + miss.join(', ') : '  (' + needles.length + ' 針)'));
  }
  if (bad) process.exit(1);
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (e) { console.error('[NG] ' + e.message); process.exit(1); }
}
module.exports = { readAsar };
