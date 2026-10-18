const { search, getGallery, fetchImage } = require('../../src/lib/sources');

(async () => {
  for (const source of ['nhentai', 'ehentai', 'pawchive']) {
    console.log('\n===', source);
    const result = await search({ source, query: source === 'pawchive' ? 'fanbox' : 'fate', page: 0, pageSize: 2 });
    console.log(result.galleries.map((g) => ({ id: g.id, title: g.title.slice(0, 50), pages: g.pageCount, source: g.source })));
    const first = result.galleries[0];
    if (!first) continue;
    const full = await getGallery(first.id);
    console.log('detail pages', full.pageCount, full.url);
    const img = await fetchImage(first.id, 0, { size: 'small' });
    console.log('thumb', img.type, img.bytes.length);
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
