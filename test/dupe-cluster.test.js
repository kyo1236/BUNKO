'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const DupeCluster = require('../src/renderer/dupe-cluster');
const { baselineMark } = require('../scripts/bench-dupe');

const artistOf = (g) => g.artist;
const resultOf = (items, mark) => {
  const copy = structuredClone(items);
  const result = mark(copy, artistOf);
  return {
    items: copy.map((g) => ({ id: g && g.id, hidden: g && g.dupeHidden, cluster: g && g.dupeClusterId })),
    changed: result.changed.map((g) => g.id),
  };
};

function randomData(seed, count) {
  let state = seed >>> 0;
  const random = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 0x100000000);
  const pick = (values) => values[Math.floor(random() * values.length)];
  const result = [];
  for (let i = 0; i < count; i += 1) {
    const work = Math.floor(random() * 24);
    const cjk = random() < 0.5;
    const base = cjk ? `作品題名${work}` : `Work title ${work}`;
    const title = random() < 0.12 ? base.replace('題', '●') : (random() < 0.16 ? `[circle] ${base} [English]` : base);
    const common = [0, 1, 2, 3].map((n) => ({ type: 'female', name: `tag-${work}-${n}` }));
    result.push({
      id: i + 1,
      title,
      artist: random() < 0.08 ? '' : `artist-${Math.floor(random() * 5)}`,
      pageCount: 20 + work + Math.floor(random() * 5),
      dupeKey: random() < 0.15 ? `key-${work}` : null,
      translationIds: random() < 0.12 ? [10000 + work] : [],
      language: pick([null, 'english', cjk ? 'japanese' : null]),
      tags: random() < 0.1 ? common.slice(0, 3) : common,
      series: random() < 0.3 ? [] : [{ name: `series-${work % 6}` }],
      characters: random() < 0.3 ? [] : [{ name: `character-${work % 9}` }],
      owned: random() < 0.08,
      error: random() < 0.02,
      source: random() < 0.03 ? 'nhentai' : 'hitomi',
    });
  }
  return result;
}

test('最適化版は代表順・cluster id・changed 順を baseline と一致させる', () => {
  const fixtures = [
    [
      { id: 1, title: '催●性指導', artist: 'a', owned: false },
      { id: 2, title: '催眠性指導', artist: 'a', owned: true },
      { id: 3, title: '[sample circle] sample title 3 [Japanese]', artist: 'a' },
      { id: 4, title: 'unrelated', artist: 'a', dupeHidden: true },
      { id: 5, title: 'creator', artist: 'a', kind: 'creator', dupeHidden: true, dupeClusterId: 'old' },
    ],
    ...Array.from({ length: 20 }, (_, seed) => randomData(seed + 1, 80)),
  ];
  for (const items of fixtures) assert.deepStrictEqual(resultOf(items, DupeCluster.mark), resultOf(items, baselineMark));
});

test('sameWork と診断用 API の既存規則を維持する', () => {
  const tags = ['a', 'b', 'c', 'd'].map((name) => ({ type: 'female', name }));
  const roman = { id: 1, title: 'Work 2', artist: 'a', pageCount: 30, tags };
  const cjk = { id: 2, title: '作品 2', artist: 'a', pageCount: 33, tags };
  assert.equal(DupeCluster.sameWork(roman, cjk, artistOf), true);
  assert.equal(DupeCluster.sameWork(roman, { ...cjk, title: '作品 3' }, artistOf), false);
  assert.deepStrictEqual(DupeCluster.tagContainment(roman, cjk), { ratio: 1, min: 4, hits: 4 });
});

test('大きな翻訳 family と重複 translationIds でも baseline と一致する', () => {
  const family = Array.from({ length: 300 }, (_, i) => ({
    id: 20000 + i,
    title: i === 150 ? '日本語原版' : `Roman family ${i}`,
    artist: `artist-${i % 3}`,
    translationIds: [99999, 99999],
    language: i === 150 ? 'japanese' : 'english',
    owned: i === 220,
  }));
  assert.deepStrictEqual(resultOf(family, DupeCluster.mark), resultOf(family, baselineMark));
});

test('派生値cacheを再利用する24件刻みでも各prefixがbaselineと一致する', () => {
  const source = randomData(91234, 240);
  source[12].translationIds = [77777];
  source[13].translationIds = [77777];
  source[200] = { ...source[200], id: 77777, title: '後着日本語原版', language: 'japanese', translationIds: [source[12].id] };
  const actual = [];
  const expected = [];
  for (let end = 24; end <= source.length; end += 24) {
    actual.push(...structuredClone(source.slice(end - 24, end)));
    expected.push(...structuredClone(source.slice(end - 24, end)));
    DupeCluster.mark(actual, artistOf);
    baselineMark(expected, artistOf);
    assert.deepStrictEqual(resultOf(actual, (items) => ({ changed: [] })).items,
      resultOf(expected, (items) => ({ changed: [] })).items, `prefix ${end}`);
  }
});
