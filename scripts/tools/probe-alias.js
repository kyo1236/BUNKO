const { rewriteQuery, lookup, uniqueLookup, suggestAliases } = require('../../src/lib/search-aliases');
const { parseQuery, search } = require('../../src/lib/hitomi-service');

const samples = [
  'ヤンデレ',
  'ぶるあか',
  'ブルアカ',
  'ブルーアーカイブ',
  '巨乳',
  '爆乳',
  'セリナ',
  '鷲見セリナ',
  '催眠',
  '男の娘',
  'ショタ',
  'せんせい',
  'female:yandere',
  '作者:test',
  'ヤンデレ language:japanese',
];

(async () => {
  console.log('--- rewrite ---');
  for (const sample of samples) {
    const rewritten = rewriteQuery(sample);
    const parsed = parseQuery(sample);
    console.log(JSON.stringify({
      q: sample,
      rewritten: rewritten.query,
      unique: uniqueLookup(sample)?.value || null,
      hits: lookup(sample).map((item) => item.value),
      tags: parsed.tags.map((tag) => tag.toString()),
      title: parsed.title,
    }));
  }

  console.log('--- suggest ---');
  for (const sample of ['ヤン', 'ブルアカ', '巨乳', 'セリナ', 'ショタ']) {
    console.log(sample, suggestAliases(sample, 5).map((item) => `${item.label} -> ${item.value}`));
  }

  console.log('--- search ヤンデレ ---');
  const result = await search({ query: 'ヤンデレ', language: 'japanese', pageSize: 3 });
  console.log(JSON.stringify({
    query: result.query,
    interpreted: result.interpreted,
    total: result.total,
    titles: (result.galleries || []).map((g) => ({ id: g.id, title: g.title, tags: (g.tags || []).slice(0, 6).map((t) => t.name) })),
  }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
