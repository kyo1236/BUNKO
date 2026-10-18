'use strict';
// label-overrides.json (2026-08 の全件監査) のうち、前方一致の複写に汚染された
// 行を洗い出して直す。
//
// なぜ汚染されたか: 当時の aliases.json は `azusa` に前方一致する六人へ
// 「アズサ/白洲アズサ」一式を複写していた。その一覧を見ながら札を選んだので、
// 別人の名前や、誰を指すか分からない下の名前が札として採られた行がある。
//   character rika_shinozaki => チリ      (チリ はポケモンの人物。篠崎里香ではない)
//   character azusa_miura    => アズサ    (六人の誰でもありうる)
//
// 直し方 (機械で):
//   1. 元の aliases.json から 67 組の複写 (aliases-audit.json) を読む
//   2. その組に属する値へ付いた上書きのうち、札が複写された一式に入っている物を疑う
//   3. 組み直した aliases.json に、その人だけを指す正式名があるなら差し替える
//   4. 無ければ行を消す。ローマ字で出る方が、別人の日本語で出るよりましだから
//
//   node scripts/audit-label-overrides.js --dry
//   node scripts/audit-label-overrides.js
const fs = require('fs');
const path = require('path');
const { aliasKey, romajiToKata } = require('../src/lib/search-text');
const { tagNameKey } = require('../src/lib/title-keys');

const ROOT = path.join(__dirname, '..');
const WORK = path.join(ROOT, 'work', 'vocabulary-audit-2026-09-21');
const TARGET = path.join(ROOT, 'src', 'lib', 'data', 'label-overrides.json');
const DRY = process.argv.includes('--dry');

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};

const NICKNAME_TAIL = /(これ|淫夢|部|パロ|イラコン|化|組|一家|トリオ|コンビ)$/;
function properName(labels) {
  for (const raw of labels) {
    const text = String(raw || '').trim();
    if (!text || text.length > 16 || text.length < 2) continue;
    if (/[()（）]/.test(text)) continue;
    if (/[a-zA-Z0-9]/.test(text)) continue;
    if (!/[぀-ヿ一-鿿]/.test(text)) continue;
    if (NICKNAME_TAIL.test(text)) continue;
    return text;
  }
  return '';
}

function main() {
  const audit = readJson(path.join(WORK, 'aliases-audit.json'), null);
  if (!audit) throw new Error('aliases-audit.json がありません (audit-aliases.js を先に走らせる)');
  const overrides = readJson(TARGET, null);
  if (!overrides) throw new Error('label-overrides.json がありません');
  const rebuilt = readJson(path.join(ROOT, 'src/lib/data/aliases.json'), { entries: [] });
  const byValue = new Map(rebuilt.entries.map((e) => [`${e.type}:${tagNameKey(e.name)}`, e]));

  // 複写された一式に属していた値と、その一式の札
  const tainted = new Map();
  for (const family of audit.families || []) {
    const labels = new Set(family.labels.map(aliasKey));
    for (const row of family.values) {
      const [type, name] = [row.value.split(':')[0], row.value.split(':').slice(1).join(':')];
      tainted.set(`${type}:${tagNameKey(name)}`, labels);
    }
  }

  // 今の辞書で、その札が何人を指すか
  const owners = new Map();
  for (const entry of rebuilt.entries) {
    for (const label of entry.labels || []) {
      const key = `${entry.type}|${aliasKey(label)}`;
      if (!owners.has(key)) owners.set(key, new Set());
      owners.get(key).add(entry.value);
    }
  }

  const replaced = [];
  const removed = [];
  const kept = [];
  const next = {};
  for (const [key, value] of Object.entries(overrides)) {
    const space = String(key).indexOf(' ');
    if (space < 1) { next[key] = value; continue; }
    const type = String(key).slice(0, space).toLowerCase().trim();
    const name = tagNameKey(String(key).slice(space + 1));
    const slot = `${type}:${name}`;
    const labels = tainted.get(slot);
    const label = String(value || '').trim();
    if (!labels || !labels.has(aliasKey(label))) { next[key] = value; continue; }

    const entry = byValue.get(slot);
    // この札がこの人物の名前として辞書に在るなら、複写の巻き添えではない
    if (entry && (entry.labels || []).some((l) => aliasKey(l) === aliasKey(label))) {
      next[key] = value; kept.push({ key, label, why: '辞書でもこの人物の名前' }); continue;
    }
    // hitomi の語はヘボン式の読みそのもの。札の読みが姓か名と一致するなら、
    // 短くて曖昧でも「その人自身の名前」。アスナ (asuna_harukaze) は残す。
    // チリ (rika_shinozaki) は リカ でも シノザキ でもないので残さない
    const ownReading = String(name).split(/[\s_]+/).some((part) => {
      const kata = romajiToKata(part);
      return kata && aliasKey(kata) === aliasKey(label);
    });
    if (ownReading) { next[key] = value; kept.push({ key, label, why: '読みがこの人物の姓名' }); continue; }
    // 他人の名前として辞書に在る = 別人の名前が付いている
    const elsewhere = owners.get(`${type}|${aliasKey(label)}`) || new Set();
    if (!elsewhere.size) { next[key] = value; kept.push({ key, label, why: '他人の名前でもない' }); continue; }
    if (!entry || !(entry.labels || []).length) {
      removed.push({ key, label, reason: '別人の名前で、この人物の名前は辞書に無い', wasNameOf: [...elsewhere].slice(0, 3) });
      continue;
    }

    const candidate = properName(entry.labels || []);
    const unique = candidate && (owners.get(`${type}|${aliasKey(candidate)}`) || new Set()).size === 1;
    if (candidate && unique) {
      next[key] = candidate;
      replaced.push({ key, from: label, to: candidate, wasNameOf: [...elsewhere].slice(0, 3) });
      continue;
    }
    removed.push({ key, label, reason: '別人の名前が付いている', wasNameOf: [...elsewhere].slice(0, 3) });
  }

  const summary = {
    total: Object.keys(overrides).length,
    taintedSlots: tainted.size,
    replaced: replaced.length,
    removed: removed.length,
    keptAfterRecheck: kept.length,
    after: Object.keys(next).length,
  };
  console.log(JSON.stringify(summary, null, 2));
  console.log(replaced.slice(0, 20).map((r) => `  ${r.key}: ${r.from} -> ${r.to}`).join('\n'));
  console.log(removed.slice(0, 20).map((r) => `  x ${r.key}: ${r.label} (${r.reason})`).join('\n'));
  fs.writeFileSync(path.join(WORK, 'label-override-audit.json'), JSON.stringify({ summary, replaced, removed, kept }, null, 1));
  if (DRY) { console.log('--dry: label-overrides.json は書き換えていない'); return; }
  fs.writeFileSync(TARGET, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`wrote ${TARGET}`);
}

// 直に叩かれた時だけ走る。require しただけで辞書を書き換えないこと
if (require.main === module) main();

module.exports = { main };
