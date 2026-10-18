'use strict';
// 完全一致の置換。会のたびに node -e で書いていた「一か所だけ当てて、当たらなければ止まる」を道具にした。
//
//   node scripts/tools/replace-exact.js <対象ファイル> <spec.json> [--dry]
//   node scripts/tools/replace-exact.js <対象ファイル> --from "<旧>" --to "<新>" [--dry]
//
// spec.json は [{ "from": "...", "to": "..." }, ...] (from は改行を含んでよい。LF で書けば対象の行末に合わせる)。
// 守ること:
//   - from が対象に「ちょうど一回」現れる時だけ置く (0 回・2 回以上は止まる。部分一致で別の所を壊さない)
//   - 行末 (CRLF / LF) と先頭の BOM は対象のまま (PS5.1 は BOM が無いと日本語を読み違え、git は混在を全行差分にする)
//   - 置換の文字列は関数で渡す ($& や $1 を文字として扱う)
// Bash のヒアドキュメントは逆斜線を一本に潰すので、逆斜線を含む文面は spec.json を Write ツールで書いてから渡すこと。
const fs = require('fs');

function main(argv) {
  const args = [...argv];
  const dry = args.includes('--dry');
  const target = args.find((a) => !a.startsWith('--'));
  if (!target) throw new Error('usage: replace-exact.js <file> (<spec.json> | --from <old> --to <new>) [--dry]');
  let pairs;
  const fi = args.indexOf('--from');
  if (fi >= 0) {
    pairs = [{ from: args[fi + 1], to: args[args.indexOf('--to') + 1] }];
  } else {
    const spec = args.filter((a) => !a.startsWith('--') && a !== target)[0];
    if (!spec) throw new Error('spec.json が要る');
    pairs = JSON.parse(fs.readFileSync(spec, 'utf8'));
  }
  const raw = fs.readFileSync(target);
  const bom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  let text = raw.toString('utf8');
  if (bom) text = text.slice(1);
  const crlf = /\r\n/.test(text);
  let work = crlf ? text.replace(/\r\n/g, '\n') : text;
  for (const [i, { from, to }] of pairs.entries()) {
    if (typeof from !== 'string' || typeof to !== 'string') throw new Error(`#${i}: from/to は文字列`);
    const f = from.replace(/\r\n/g, '\n');
    const hits = work.split(f).length - 1;
    if (hits !== 1) throw new Error(`#${i}: 当たりが ${hits} 回 (1 回でないと置かない): ${f.slice(0, 60)}`);
    work = work.replace(f, () => to.replace(/\r\n/g, '\n'));
  }
  const out = (bom ? '﻿' : '') + (crlf ? work.replace(/\n/g, '\r\n') : work);
  if (dry) { console.log(`dry: ${pairs.length} 件とも一回ずつ当たる (${target})`); return; }
  fs.writeFileSync(target, out);
  console.log(`replaced ${pairs.length} in ${target} (${crlf ? 'CRLF' : 'LF'}${bom ? ', BOM' : ''})`);
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (e) { console.error('[NG] ' + e.message); process.exit(1); }
}
module.exports = { main };
