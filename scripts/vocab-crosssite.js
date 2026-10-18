'use strict';
// hitomi と nhentai で綴りが違う人物・作品に、行き先ごとの名前を持たせる。
//
// 横断のほとんどは `sites.nhentai` の印と tag-query.js の言い換えで足りる
// (5 冊以上で数えると人物 13,307 件・作品 3,000 件が同じ綴り)。
// 足りないのは綴り自体が違う一握りだけ:
//   hitomi "tamamo no mae" ↔ nhentai "tamamo-no-mae"
//   hitomi "ippo makunouchi" ↔ nhentai "makunouchi ippo"
// ここだけは「行き先ごとの名前」を持つ search-vocabulary の項目でしか表せない。
//
// 当てずっぽうはしない。長音と記号と語順を畳んだ鍵 (search-text.foldRomajiName) で
// **一つに定まる時だけ**結び、両サイトの全語一覧に実在することを根拠に残す。
//
//   node scripts/vocab-crosssite.js --dry   数えるだけ
//   node scripts/vocab-crosssite.js         search-vocabulary.json に足す

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TARGET = path.join(ROOT, 'src', 'lib', 'data', 'search-vocabulary.json');
const RESEARCH = path.join(ROOT, 'work', 'vocabulary-research', 'data');
const DRY = process.argv.includes('--dry');

const aliases = require('../src/lib/search-aliases');
const { foldRomajiName, hasCjk } = require('../src/lib/search-text');

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};
const spaced = (s) => String(s || '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

const hv = readJson(path.join(RESEARCH, 'hitomi-vocabulary.json'), null);
const nv = readJson(path.join(RESEARCH, 'nhentai-vocabulary.json'), null);
if (!hv || !nv) throw new Error('両サイトの全語一覧が要る');

const vocabulary = readJson(TARGET, { version: 1, revision: '', entries: [], sources: [] });
const seen = new Set(vocabulary.entries.map((e) => e.id));

const data = aliases.loadData();
const added = [];

for (const [kind, nSpace, hNs] of [
  ['character', 'character', hv.namespaces.character],
  ['series', 'parody', hv.namespaces.series],
]) {
  const nNs = nv.namespaces[nSpace] || {};
  // nhentai 側を畳んだ鍵で索引する。同じ鍵に二つ以上あるなら見分けが付かないので捨てる
  const byFold = new Map();
  for (const name of Object.keys(nNs)) {
    const k = foldRomajiName(name);
    if (!k) continue;
    if (!byFold.has(k)) byFold.set(k, []);
    byFold.get(k).push(name);
  }
  for (const entry of data.entries) {
    if (entry.type !== kind || !entry.labels.length) continue;
    const hName = spaced(entry.name);
    if (!Object.prototype.hasOwnProperty.call(hNs, hName)) continue;      // hitomi に実在すること
    if (Object.prototype.hasOwnProperty.call(nNs, hName)) continue;        // 綴りが同じなら要らない
    const hits = byFold.get(foldRomajiName(hName)) || [];
    if (hits.length !== 1) continue;                                       // 一つに定まる時だけ
    const nName = hits[0];
    const label = String(entry.label || '');
    if (!hasCjk(label)) continue;                                          // 日本語の札が無いなら出せない
    const id = `x-${kind}-${hName.replace(/[^a-z0-9]+/g, '_')}`;
    if (seen.has(id)) continue;
    seen.add(id);
    added.push({
      id,
      inputs: [{ site: 'pixiv', type: 'tag', name: label, relation: 'exact' }],
      outputs: {
        hitomi: { type: kind, name: hName, label },
        nhentai: { type: kind === 'series' ? 'parody' : 'character', name: nName, label },
        pixiv: { type: 'tag', name: label, label },
      },
      evidence: [
        {
          url: 'https://hitomi.la/all*-{123,a-z}.html',
          method: 'hitomi の名前空間別全語一覧との完全一致',
          checkedAt: hv.fetchedAt,
          note: `hitomi ${kind}:"${hName}" は ${hNs[hName]} 冊`,
        },
        {
          url: `https://nhentai.net/api/v2/tags/${nSpace}?sort=popular&per_page=100`,
          method: '公式 API のタグ全語一覧との完全一致',
          checkedAt: nv.fetchedAt,
          note: `nhentai ${nSpace}:"${nName}" は ${(nNs[nName] || {}).count} 冊。`
            + '綴りの違いは長音・記号・語順を畳んだ鍵が一つに定まった場合のみ結んだ',
        },
      ],
    });
  }
}

added.sort((a, b) => a.id.localeCompare(b.id));
console.log(`行き先ごとの名前を足す語: ${added.length}`);
for (const e of added.slice(0, 25)) {
  console.log(`  ${e.outputs.hitomi.label}  hitomi "${e.outputs.hitomi.name}" -> nhentai "${e.outputs.nhentai.name}"`);
}
if (added.length > 25) console.log(`  ... 他 ${added.length - 25} 件`);

if (DRY) { console.log('--dry: 書き換えていない'); process.exit(0); }
if (!added.length) { console.log('足す物が無い'); process.exit(0); }

vocabulary.entries = [...vocabulary.entries, ...added];
vocabulary.revision = '2026-09-21-vocabulary-5-crosssite';
fs.writeFileSync(TARGET, JSON.stringify(vocabulary));
console.log(`wrote ${TARGET} (計 ${vocabulary.entries.length} 項目 / revision ${vocabulary.revision})`);
