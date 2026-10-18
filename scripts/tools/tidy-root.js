// 作業木の直下に溜まった一時物 (.tmp-* / .verify-*.ps1 / dist-*) を _tmp/leftovers-<日付>/ へ移す (消さない。_tmp/ は版に入らない)。
//   node scripts/tools/tidy-root.js [--dry]
// 中身の無い数字だけのファイル (リダイレクトの取り違えで出来た 0 バイト) と空の debug.log だけは消す。
// 移す前に「追跡されていない」ことを git で確かめ、追跡済みには触らない。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const DEST = path.join(ROOT, '_tmp', 'leftovers-' + new Date().toISOString().slice(0, 10));
const dry = process.argv.includes('--dry');

const tracked = new Set(execFileSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean).map((p) => p.split('/')[0]));

const names = fs.readdirSync(ROOT);
const moveNames = names.filter((n) => n.startsWith('.tmp-') || (n.startsWith('.verify-') && n.endsWith('.ps1')) || (n.startsWith('dist-') && n !== 'dist'));
const zeroNames = names.filter((n) => /^\d+$/.test(n) || n === 'debug.log');

const plan = [];
for (const n of moveNames) {
  if (tracked.has(n)) { console.log('SKIP tracked', n); continue; }
  plan.push(['move', n]);
}
for (const n of zeroNames) {
  const st = fs.statSync(path.join(ROOT, n));
  if (tracked.has(n)) { console.log('SKIP tracked', n); continue; }
  if (!st.isFile() || st.size !== 0) { console.log('SKIP not-empty', n, st.size); continue; }
  plan.push(['delete-empty', n]);
}

console.log(`plan: ${plan.filter((p) => p[0] === 'move').length} move, ${plan.filter((p) => p[0] === 'delete-empty').length} delete-empty`);
if (dry) { for (const p of plan) console.log(p.join(' ')); process.exit(0); }

fs.mkdirSync(DEST, { recursive: true });
const log = [];
for (const [op, n] of plan) {
  const from = path.join(ROOT, n);
  if (op === 'move') {
    const to = path.join(DEST, n);
    if (fs.existsSync(to)) throw new Error('already exists: ' + to);
    fs.renameSync(from, to);
    log.push(`moved\t${n}`);
  } else {
    fs.unlinkSync(from);
    log.push(`deleted-empty\t${n}`);
  }
}
fs.writeFileSync(path.join(DEST, 'README.txt'),
  new Date().toISOString().slice(0, 10) + '、作業木の直下から移した一時物 (試験とビルドの記録・使い捨ての台本・古いビルド・煙の試しの userData)。\n'
  + '要らなければこのフォルダごと消してよい。元の場所へ戻すなら同じ名前で直下へ戻す。\n\n' + log.join('\n') + '\n');
console.log(log.length + ' done');
