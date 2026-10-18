const { search, getGallery, fetchImage } = require('../../src/lib/hitomi-service');

(async () => {
  try {
    console.log('searching latest...');
    const result = await search({ query: '', sort: 'added', page: 0, pageSize: 3 });
    console.log(JSON.stringify({
      total: result.total,
      approximate: result.approximate,
      titles: result.galleries.map((g) => ({ id: g.id, title: g.title, pages: g.pageCount, error: g.error })),
    }, null, 2));

    const first = result.galleries.find((g) => !g.error);
    if (!first) throw new Error('no gallery');

    const gallery = await getGallery(first.id);
    console.log('files', gallery.files.length, gallery.files[0]?.name, gallery.files[0]?.hasThumbnail);

    const image = await fetchImage(first.id, 0, { size: 'small' });
    console.log('thumb bytes', image.bytes.length, image.type);
    console.log('OK');
  } catch (error) {
    console.error('FAIL', error);
    process.exit(1);
  }
})();
