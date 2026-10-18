'use strict';
// ui-probe の記録を読みやすい表にする (数・id・伏せ字済みの UI の語だけ)。
//   node scripts/tools/ui-probe-report.js <report.json>   → 同じ所に report.md を書き直す
const fs = require('fs');
const path = require('path');

const cell = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

function markdown(records, { stamp = '' } = {}) {
  const measured = records.filter((r) => r.result);
  const flagged = measured.filter((r) => r.flags.length || (r.jev && (r.jev.problem !== 'none' || r.jev.fits < 0.5)));
  const lines = [];
  lines.push(`# ui-probe ${stamp}`, '');
  lines.push(`測った ${measured.length} 件 / 旗 ${measured.filter((r) => r.flags.length).length} 件 / Jev が困り事ありと見た ${measured.filter((r) => r.jev && r.jev.problem && r.jev.problem !== 'none').length} 件`, '');
  const notes = records.filter((r) => r.note);
  if (notes.length) {
    lines.push('## 記', '');
    for (const n of notes) lines.push(`- **${cell(n.step)}**: \`${cell(JSON.stringify(n.note))}\``);
    lines.push('');
  }
  lines.push('## 目立つ物', '');
  lines.push('| 場面 | 釦 | 旗 | Jev 役目どおり | Jev 困り事 (確信) | Jev 重さ 0-3 |', '|---|---|---|---|---|---|');
  for (const r of flagged) {
    const c = r.control || {};
    lines.push(`| ${cell(r.step)} | \`${cell(r.selector || '')}\` ${cell(c.label || c.aria || c.title || '')} | ${cell(r.flags.join(' '))} | ${r.jev ? cell(r.jev.fits) : ''} | ${r.jev ? `${cell(r.jev.problem)} (${cell(r.jev.problemConf)})` : ''} | ${r.jev ? cell(r.jev.severity) : ''} |`);
  }
  lines.push('', '## 全部', '');
  lines.push('| 場面 | 反応 ms | 落ち着き ms | 空白 ms | 最長の仕事 ms | ずれ | 動き (性質・ms) | コマ落ち | 戻り | 旗 |', '|---|---|---|---|---|---|---|---|---|---|');
  for (const r of measured) {
    const x = r.result;
    const lt = x.longtasks.length ? Math.max(...x.longtasks.map((t) => t.ms)) : '';
    const anims = x.anims.slice(0, 3).map((a) => `${a.props.join('+')}:${a.duration}`).join(' ');
    lines.push(`| ${cell(r.step)} | ${cell(x.firstMutationMs)} | ${x.settleMs} | ${x.blank.ms || ''} | ${lt} | ${x.shifts.length || ''} | ${cell(anims)} | ${x.frames.over33 ? `${x.frames.over33}/${x.frames.count}` : ''} | ${r.restore ? (r.restore.ok ? 'ok' : cell(r.restore.diff.join(','))) : ''} | ${cell(r.flags.join(' '))} |`);
  }
  const skipped = records.filter((r) => r.skipped);
  if (skipped.length) {
    lines.push('', '## 見つからなかった', '');
    for (const s of skipped) lines.push(`- ${cell(s.step)} \`${cell(s.selector)}\``);
  }
  return lines.join('\n') + '\n';
}

if (require.main === module) {
  const file = process.argv[2];
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(path.join(path.dirname(file), 'report.md'), markdown(data.records, { stamp: data.stamp }));
  console.log('[OK] report.md');
}
module.exports = { markdown };
