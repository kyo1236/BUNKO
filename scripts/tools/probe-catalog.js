const path = require('path');
const Module = require('module');

const electronStub = {
  app: {
    getPath(name) {
      if (name === 'userData') return path.join(__dirname, '..', '..', '_tmp');
      return process.cwd();
    },
  },
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return originalLoad(request, parent, isMain);
};

const { Catalog, extractGalleryIds } = require('../../src/lib/catalog');

(async () => {
  console.log('ids', extractGalleryIds('[20210905] [884537] sample title 2'));
  const catalog = new Catalog();
  await catalog.init();
  const started = Date.now();
  const snapshot = await catalog.refresh({
    // 手元の設定 (userData の config.json) から読む。無ければ空で走る
    eagleLibrary: require('../../src/lib/config').load().eagleLibrary,
    downloadDir: require('../../src/lib/config').load().downloadDir,
    onProgress: (progress) => {
      if (progress.scanned % 2000 === 0) console.log('scan', progress);
    },
  });
  console.log({ snapshot, ms: Date.now() - started, ownedSample: catalog.isOwned(884537, 'マジカルルルイエちゃん2') });
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
