'use strict';

const { performance } = require('node:perf_hooks');
const DupeCluster = require('../src/renderer/dupe-cluster');

// 最適化前の mark を、比較用の素直な総当たり実装として保存する。
function baselineMark(items, artistOf) {
  const list = Array.isArray(items) ? items : [];
  const parent = list.map((_, i) => i);
  const find = (x) => {
    let n = x;
    while (parent[n] !== n) { parent[n] = parent[parent[n]]; n = parent[n]; }
    return n;
  };
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[rb] = ra; };
  const artist = (g) => (typeof artistOf === 'function' ? artistOf(g) || '' : '');
  const family = new Map();
  list.forEach((g, i) => {
    if (!DupeCluster.eligible(g)) return;
    for (const key of DupeCluster.familyKeys(g)) {
      if (!family.has(key)) family.set(key, []);
      family.get(key).push(i);
    }
  });
  for (const members of family.values()) for (let n = 1; n < members.length; n += 1) union(members[0], members[n]);
  const familyHasOriginal = new Array(list.length).fill(false);
  list.forEach((g, i) => {
    if (!DupeCluster.eligible(g)) return;
    for (const key of DupeCluster.familyKeys(g)) {
      for (const j of family.get(key) || []) {
        if (j !== i && DupeCluster.isOriginalEdition(list[j])) familyHasOriginal[i] = true;
      }
    }
  });
  const buckets = new Map();
  list.forEach((g, i) => {
    if (!DupeCluster.eligible(g)) return;
    const key = artist(g);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(i);
  });
  for (const [artistName, indexes] of buckets) {
    const keyMap = new Map();
    for (const i of indexes) {
      const key = list[i].dupeKey;
      if (!key) continue;
      const prev = keyMap.get(key);
      if (prev !== undefined) union(prev, i); else keyMap.set(key, i);
    }
    if (!artistName) continue;
    const strippedMap = new Map();
    for (const i of indexes) {
      const key = DupeCluster.censorNormalize(DupeCluster.stripLeadingCredits(list[i].title));
      if (!key) continue;
      const prev = strippedMap.get(key);
      if (prev !== undefined) union(prev, i); else strippedMap.set(key, i);
    }
    const norms = indexes.map((i) => DupeCluster.censorNormalize(list[i].title));
    for (let a = 0; a < indexes.length; a += 1) {
      if (!/[●○◯〇×✕✖*＊☆★■□?？]/.test(norms[a])) continue;
      for (let b = 0; b < indexes.length; b += 1) {
        if (a !== b && DupeCluster.censoredTitleMatch(norms[a], norms[b])) union(indexes[a], indexes[b]);
      }
    }
    for (const rIndex of indexes) {
      const roman = list[rIndex];
      if (DupeCluster.hasCjkTitle(roman.title) || familyHasOriginal[rIndex]) continue;
      const candidates = [];
      for (const jIndex of indexes) {
        if (jIndex === rIndex || !DupeCluster.hasCjkTitle(list[jIndex].title)) continue;
        if (DupeCluster.bridgeEvidence(roman, list[jIndex])) candidates.push(jIndex);
      }
      if (!candidates.length) continue;
      if (!DupeCluster.keysConnected(candidates.map((i) => DupeCluster.groupKeyOf(list[i])))) continue;
      for (const jIndex of candidates) union(rIndex, jIndex);
    }
  }
  const groups = new Map();
  list.forEach((g, i) => {
    if (!DupeCluster.eligible(g)) return;
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  });
  const changed = [];
  const setHidden = (g, hidden) => {
    if (Boolean(g.dupeHidden) !== hidden) { g.dupeHidden = hidden; changed.push(g); }
  };
  list.forEach((g) => {
    if (g && !DupeCluster.eligible(g)) {
      if (g.dupeHidden) setHidden(g, false);
      if (g.dupeClusterId) g.dupeClusterId = null;
    }
  });
  for (const [root, members] of groups) {
    const clusterId = members.length > 1 ? `c${root}` : null;
    let rep = members.find((i) => list[i].owned);
    if (rep === undefined) rep = members[0];
    for (const i of members) { list[i].dupeClusterId = clusterId; setHidden(list[i], i !== rep); }
  }
  return { changed };
}

function makeData(count = 2400) {
  const tags = Array.from({ length: 80 }, (_, i) => ({ type: 'female', name: `tag ${i}` }));
  return Array.from({ length: count }, (_, i) => {
    const work = Math.floor(i / 2);
    return {
      id: i + 1,
      title: i % 2 ? `Roman edition ${work}` : `日本語作品 ${work}`,
      artist: `artist-${work % 8}`,
      pageCount: 20 + (work % 100),
      tags: [tags[work % 80], tags[(work + 7) % 80], tags[(work + 19) % 80], tags[(work + 31) % 80]],
      series: [{ name: `series-${work % 20}` }],
      characters: [{ name: `character-${work % 40}` }],
    };
  });
}

function run(fn, source, rounds) {
  const start = performance.now();
  for (let i = 0; i < rounds; i += 1) fn(structuredClone(source), (g) => g.artist);
  return performance.now() - start;
}

if (require.main === module) {
  const source = makeData(Number(process.argv[2]) || 2400);
  baselineMark(structuredClone(source), (g) => g.artist);
  DupeCluster.mark(structuredClone(source), (g) => g.artist);
  const baselineMs = run(baselineMark, source, 3);
  const optimizedMs = run(DupeCluster.mark, source, 3);
  console.log(JSON.stringify({ items: source.length, rounds: 3, baselineMs: +baselineMs.toFixed(1), optimizedMs: +optimizedMs.toFixed(1), speedup: +(baselineMs / optimizedMs).toFixed(2) }, null, 2));
}

module.exports = { baselineMark, makeData };
