// node-hitomi の GalleryManager.retrieve は、galleryinfo の tags / characters
// などが null の作品 (タグ無し等。実例: 2419981) で
// 「Cannot read properties of null (reading 'length')」と落ちる。
// JSON.parse の直後に null → [] のガードを差し込む。postinstall で毎回当てる
// (冪等: 既に当たっていれば何もしない)
const fs = require('fs');
const path = require('path');

const MARKER = '/* bunko-null-guard */';
const GUARD = `${MARKER} for (const k of ['tags','files','languages','artists','groups','parodys','characters','related']) if (rawGallery[k] == null) rawGallery[k] = [];`;
const NEEDLE = /(const rawGallery = JSON\.parse\([^;]+;)/;

let patched = 0;
for (const flavor of ['cjs', 'esm']) {
  const file = path.join(__dirname, '..', 'node_modules', 'node-hitomi', 'distribution', flavor, 'managers', `gallery.${flavor === 'cjs' ? 'cjs' : 'mjs'}`);
  const candidates = [file, file.replace(/\.mjs$/, '.js')];
  const target = candidates.find((p) => fs.existsSync(p));
  if (!target) continue;
  const text = fs.readFileSync(target, 'utf8');
  if (text.includes(MARKER)) {
    console.log(`patch-node-hitomi: already patched (${flavor})`);
    continue;
  }
  if (!NEEDLE.test(text)) {
    console.warn(`patch-node-hitomi: anchor not found (${flavor}) — library updated? skipping`);
    continue;
  }
  fs.writeFileSync(target, text.replace(NEEDLE, `$1\n\t\t${GUARD}`));
  patched += 1;
  console.log(`patch-node-hitomi: applied (${flavor})`);
}
process.exit(0);
