'use strict';
// ui-probe の report.json を何回ぶんか並べて、場面ごとの数を表にする (変更の前後を同じ条件で比べる用)。
//
//   node scripts/tools/ui-probe-compare.js [--steps <場面,…>] <report の dir か json> …
//
// 出す数: 落ち着き ms・最初の札 ms・最長の仕事 ms (と回数)・33ms 超のこま / こま数・DOM の変化の数・旗。
// 数と場面の名だけ (題・タグ・語は report に元から無い)。
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const DEFAULT_STEPS = [
  'source:nhentai', 'source:pixiv', 'pixiv:scroll:down', 'pixiv:scroll:top', 'pixiv:view:follow', 'source:pawchive',
  'source:hitomi', 'hitomi:scroll:down', 'source:home', 'home:scroll:down', 'home:strip-author', 'home:group:month',
  'home:group:year', 'home:author-scroll:down', 'home:back-to-list',
];
const steps = (opt('--steps', '') || '').split(',').filter(Boolean);
const wanted = steps.length ? steps : DEFAULT_STEPS;
const files = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--steps');
if (!files.length) { console.log('usage: ui-probe-compare.js [--steps a,b] <dir|json> …'); process.exit(1); }

function load(p) {
  const file = p.endsWith('.json') ? p : path.join(p, 'report.json');
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  const map = new Map();
  for (const r of json.records || []) if (r.step && r.result) map.set(r.step, r);
  return { name: path.basename(path.dirname(file)) || file, map };
}

function cell(r) {
  if (!r) return '—';
  const res = r.result;
  const lt = res.longtasks || [];
  const longest = lt.length ? Math.max(...lt.map((t) => t.ms)) : 0;
  const frames = res.frames || {};
  const parts = [
    `落${res.settleMs ?? '-'}`,
    res.firstCardsMs != null ? `札${res.firstCardsMs}` : '',
    longest ? `仕事${longest}×${lt.length}` : '仕事-',
    frames.count != null ? `駒${frames.over33 || 0}/${frames.count}` : '',
    res.mutations != null ? `変${res.mutations}` : '',
    (r.flags || []).length ? `旗:${r.flags.join(' ')}` : '',
  ].filter(Boolean);
  return parts.join(' ');
}

const reports = files.map(load);
console.log(`| 場面 | ${reports.map((r) => r.name).join(' | ')} |`);
console.log(`|---|${reports.map(() => '---').join('|')}|`);
for (const step of wanted) {
  const cells = reports.map((r) => cell(r.map.get(step)));
  if (cells.every((c) => c === '—')) continue;
  console.log(`| ${step} | ${cells.join(' | ')} |`);
}
console.log('\n落=落ち着き ms  札=最初の札 ms  仕事=最長の主スレッドの仕事 ms×回数  駒=33ms 超のこま/こま数  変=DOM の変化の数');
