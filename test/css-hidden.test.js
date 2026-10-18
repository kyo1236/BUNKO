'use strict';

// [hidden] で閉じる約束の網。
//
// `.x[hidden] { display: none; }` は「クラス + 属性」の強さしか無い。同じ要素に後から
// `.x.variant { display: grid; }` のような変種を足すと強さが並び、後に書いた方が勝つ:
// hidden を立てても閉じず、中身を空にした幕が画面に居座る。
// 2026-09-27、pixiv の継ぎ目の `.reader-boundary.with-related` がこれで、継ぎ目を一度出すと
// 次に開いた作品が黒い幕の下に隠れた (右クリックで読むと表示されない、と見えた)。
//
// ここでは、閉じる約束 (`X[hidden] { display: none }`) を持つ札 X について、
// X に何かを足した変種が display を張っていたら、約束の側が !important であることを求める。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
// 読む順 (index.html と同じ): 後の物ほど強い
const SHEETS = ['src/renderer/styles.css', 'src/renderer/bunko-ui.css'];

function rules() {
  const out = [];
  for (const sheet of SHEETS) {
    const css = fs.readFileSync(path.join(root, sheet), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    // @media の外枠は [^{}] に当たらないので、中の規則だけが拾われる
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selectors = match[1].split(',').map((s) => s.trim()).filter((s) => s && !s.startsWith('@'));
      if (selectors.length) out.push({ sheet, selectors, body: match[2] });
    }
  }
  return out;
}

// 選択子の最後の複合 (同じ要素に掛かる部分)
function lastCompound(selector) {
  return selector.split(/\s*[\s>+~]\s*/).filter(Boolean).pop() || '';
}

test('[hidden] の display: none は、同じ札に display を張る変種に負けない', () => {
  const all = rules();
  const promises = new Map();
  for (const rule of all) {
    if (!/display\s*:\s*none/.test(rule.body)) continue;
    for (const selector of rule.selectors) {
      const hit = selector.match(/^(\.[\w-]+(?:\.[\w-]+)*)\[hidden\]$/);
      if (hit) promises.set(hit[1], (promises.get(hit[1]) || false) || /!important/.test(rule.body));
    }
  }
  assert.ok(promises.has('.reader-boundary'), '網が規則を拾えていない (読み方が壊れた)');
  const losers = [];
  for (const rule of all) {
    const display = rule.body.match(/(?:^|[;\s])display\s*:\s*([^;!]+)/);
    if (!display || display[1].trim() === 'none') continue;
    for (const selector of rule.selectors) {
      const compound = lastCompound(selector);
      if (compound.includes('[hidden]') || compound.includes(':not([hidden])')) continue;
      // 擬似要素 (::before など) は別の箱。親が display: none なら一緒に消える
      if (/::?(?:before|after|first-letter|first-line|marker|placeholder|selection)\b/.test(compound)) continue;
      for (const [base, important] of promises) {
        if (important || compound === base) continue;
        // base に class・属性・擬似を足した同じ要素 (.reader-boundary-x のような別の札は除く)
        if (compound.startsWith(base) && /^[.[:]/.test(compound.slice(base.length))) {
          losers.push(`${rule.sheet}: ${selector} が ${base}[hidden] に勝つ`);
        }
      }
    }
  }
  assert.deepEqual(losers, []);
});
