// 検索・作品情報の IPC (image-base / search / gallery / suggest / annotate / discovery)。
// 済 印の付与や表紙の先読みなど main 側の状態に触る処理は deps 経由で借りる
const { ipcMain } = require('electron');
const trace = require('../../lib/trace');
const {
  search, getGallery, suggestTags, parseId,
} = require('../../lib/sources');

function registerSearchIpc(deps) {
  const ipcMain = deps.ipcMain || require('electron').ipcMain;
  const {
    catalog, config, pawLibrary, reading, whenCatalog,
    pawCreatorHints, warmCovers, rememberOwnedMeta, localPageCount,
    getImageBase, getImageBaseReady, getDiscovery, getPixivLibrary, getHomeAuthors, getPageCounts,
  } = deps;

  // 名前に頁数の無い所持の本 (Eagle の項目) に、数えて控えた頁数を当てる。控えに無い物は裏で数える
  // (待たない: 次に並べた時に印が出る)
  function withCachedPages(galleries) {
    const counts = typeof getPageCounts === 'function' ? getPageCounts() : null;
    if (!counts) return galleries;
    const missing = [];
    const out = (galleries || []).map((gallery) => {
      if (!gallery || gallery.kind !== 'eagleItem' || Number(gallery.pageCount) > 1 || !gallery.eagleId) return gallery;
      const pages = counts.get(gallery.eagleId);
      if (pages > 1) return { ...gallery, pageCount: pages };
      missing.push({ id: gallery.id, eagleId: gallery.eagleId });
      return gallery;
    });
    if (missing.length) counts.fill(missing.slice(0, 400)).catch(() => {});
    return out;
  }
  const homeAuthors = () => (typeof getHomeAuthors === 'function' ? getHomeAuthors() : null);

  ipcMain.handle('search-author-context', (_event, payload = {}) => {
    const library = getPixivLibrary?.();
    return require('../../lib/search-author-context').searchAuthorContext(
      String(payload.query || '').slice(0, 4096), payload.from, {
        pixiv: library?.creatorBindings?.() || {},
        pawchive: deps.pawLinks?.creatorBindings?.() || {},
        label: (type, name) => catalog.lookupTagLabel?.(type, name) || '',
        describe: require('../../lib/search-aliases').describeTerm,
        creatorName: require('../../lib/sources/pawchive').cachedCreatorName,
        intent: payload.intent, selections: payload.selections, target: payload.to,
        resolve: require('../../lib/search-vocabulary').resolve,
      });
  });

  // 済 の印は三段: 台帳 (hitomi 等) → pawchive の所持庫 → pixiv の台帳。
  // pixiv の台帳は起動の後で組まれるので、無い間は素通し
  function annotateAll(galleries) {
    const marked = pawLibrary.annotateAll(catalog.annotate(galleries || []));
    const pixivLibrary = typeof getPixivLibrary === 'function' ? getPixivLibrary() : null;
    return pixivLibrary ? pixivLibrary.annotate(marked) : marked;
  }

  // Eagle アイテムの頁数は名前の【17P】頼みで、無い本も、原本と食い違う本もある
  // (表紙ぶんや取り落とした頁)。読み手はこの数で最後の頁を決めるので、一冊を開く時
  // (gallery) だけ原本の綴じ目から数え直して上書きする。札に出す badge は名前のまま。
  // 一覧 (search) では引かない: 何百冊ぶんの綴じ目を読むことになる
  async function withPageCount(gallery) {
    if (!gallery || gallery.error) return gallery;
    if (typeof localPageCount !== 'function') return gallery;
    const count = await localPageCount(gallery.id).catch(() => 0);
    return count > 0 ? { ...gallery, pageCount: count } : gallery;
  }

  // 画像サーバは待たされても一瞬。renderer は最初にここを引きに来るので、
  // ポートが決まるまではこの口で待たせる
  // 済 の印を付けるためだけに所持庫を待つ所。**待てなくても結果は返す** (項目 9-6)。
  // Eagle の置き場が見えないというだけで、網の検索や作品詳細まで丸ごと失敗していた
  // (所持していない新刊を探す、という手元と関係の無い用事まで止まっていた)
  async function ownedReady() {
    try {
      await pawLibrary.ready();
      return true;
    } catch (error) {
      trace.warnOnce('paw:ready', 'paw', 'library-unreachable', { id: trace.codeOf(error) });
      trace.flag('library-unreachable');
      return false;
    }
  }

  ipcMain.handle('image-base', async () => {
    const imageBaseReady = getImageBaseReady();
    if (imageBaseReady) await imageBaseReady;
    return getImageBase();
  });
  const activeSearches = new Map();
  const senderKey = (event) => event?.sender?.id ?? event?.processId ?? 'renderer';
  ipcMain.handle('search-cancel', async (event, requestId) => {
    const active = activeSearches.get(senderKey(event));
    if (!active || active.requestId !== String(requestId || '')) return false;
    active.controller.abort(new Error('search cancelled'));
    activeSearches.delete(senderKey(event));
    return true;
  });
  ipcMain.handle('search', async (event, payload) => {
    const request = payload || {};
    const requestId = String(request.requestId || '');
    // 裏の道具 (突き合わせの調べ。CDP から window.hitomi.search を並べて呼ぶ) の検索は background で来る。
    // 画面の検索を打ち切らず、画面の検索や別の裏の検索にも打ち切られない (送り手の鍵を要求ごとに分ける)。
    // 2026-09-25: 四本の調べを並列に回したら互いに打ち切り合い、19 回中 18 回が失敗した
    const background = request.background === true;
    const key = background ? `${senderKey(event)}#${requestId || Math.random().toString(36).slice(2)}` : senderKey(event);
    const prior = activeSearches.get(key);
    if (prior) prior.controller.abort(new Error('search superseded'));
    const controller = new AbortController();
    const active = { requestId, controller };
    activeSearches.set(key, active);
    const isCurrent = () => activeSearches.get(key) === active && !controller.signal.aborted;
    try {
    await whenCatalog();
    if (!isCurrent()) throw controller.signal.reason || new Error('search cancelled');
    // Home (源泉横断の作者の一覧)。網にも台帳の検索にも出ない: 母屋で組んだ控えの上で絞って並べる。
    // 画面のスコープに依らない (Home は所持作品のスコープに入らない)
    if (request.source === 'home') {
      const home = homeAuthors();
      if (!home) return { total: 0, page: 0, pageSize: 24, hasNext: false, galleries: [], requestId };
      const result = await home.search(request);
      if (!isCurrent()) throw controller.signal.reason || new Error('search cancelled');
      return { ...result, requestId };
    }
    if (request.scope === 'library') {
      // 再読の棚 (読了回数順・最終読了日順) は台帳にも Eagle にも無い値で並ぶ。
      // 栞の要約はここで注ぎ足す (棚の持ち主が誰であっても同じ形で渡る)
      const marks = reading.summary();
      // 起動時の復元と走査後の引き直しは「今の頁数ぶん」を一度に取る (spanPages)。
      // 24 頁を直列に 24 往復していたのをやめる。応答の pageSize は 1 頁ぶんのまま返し、
      // 何頁ぶん入っているかは spanPages で伝える (手元の台帳なので数百件でも数十 ms)
      const size = Math.max(1, Math.min(60, Number(request.pageSize) || 24));
      const span = Math.max(1, Math.min(60, Math.floor(Number(request.spanPages)) || 1));
      const spanned = span > 1
        ? { ...request, page: 0, pageSize: size * span, pageSizeMax: size * span }
        : request;
      // pawchive の所持作品は SQLite の台帳ではなく Eagle の「作者」フォルダが持ち主
      if (request.source === 'pawchive') {
        await pawLibrary.ready();
        if (!isCurrent()) throw controller.signal.reason || new Error('search cancelled');
        const hints = await pawCreatorHints(request.query);
        if (!isCurrent()) throw controller.signal.reason || new Error('search cancelled');
        const result = pawLibrary.search({
          ...spanned, reading: marks, ...hints,
        });
        return { ...result, galleries: withCachedPages(result.galleries), pageSize: size, spanPages: span, requestId };
      }
      // pixiv の所持は pixiv の台帳 (投稿 ID ↔ Eagle 項目) が持ち主
      if (request.source === 'pixiv') {
        const pixivLibrary = typeof getPixivLibrary === 'function' ? getPixivLibrary() : null;
        if (!pixivLibrary) return { total: 0, page: 0, pageSize: size, hasNext: false, galleries: [], spanPages: span, requestId };
        const result = pixivLibrary.search({ ...spanned, reading: marks });
        return { ...result, pageSize: size, spanPages: span, requestId };
      }
      const result = catalog.searchLibrary({
        ...spanned,
        reading: marks,
        // 未照合の Eagle アイテムを混ぜるかは設定が決める (既定は混ぜる)
        includeUnmatched: typeof request.includeUnmatched === 'boolean'
          ? request.includeUnmatched : config.load().showUnmatchedEagle !== false,
      });
      return {
        ...result,
        pageSize: size,
        spanPages: span,
        requestId,
        galleries: catalog.annotate(result.galleries),
      };
    }
    const result = await search(request, { signal: controller.signal });
    if (!isCurrent()) throw controller.signal.reason || new Error('search cancelled');
    if ((result.galleries || []).some((gallery) => gallery?.source === 'pawchive')) {
      await ownedReady();
      if (!isCurrent()) throw controller.signal.reason || new Error('search cancelled');
    }
    // pawchive の所持は台帳ではなく Eagle 側の投稿 ID で決まる。sources のキャッシュは
    // 素の結果を持っているので、済 は取り出したあと (ここ) で当てる
    const galleries = annotateAll(result.galleries);
    rememberOwnedMeta(galleries);
    // 待たない: 応答を返す速さは今までどおりで、表紙だけ裏で先に温める
    if (isCurrent()) warmCovers(galleries, { signal: controller.signal });
    return { ...result, galleries, requestId };
    } finally {
      /* controller は warm 完了/次 request/cancel まで sender に保持する。裏の検索は要求ごとの鍵なので終わったら外す */
      if (background && activeSearches.get(key) === active) activeSearches.delete(key);
    }
  });
  ipcMain.handle('gallery', async (_event, id) => {
    await whenCatalog();
    // Eagle アイテムは取りに行く先が無い: 走査結果をそのまま返す。
    // pawchive 側に居なければ、未照合アイテムの疑似ギャラリー (台帳側) を試す
    if (pawLibrary.isPawEagleId(id)) {
      await ownedReady();
      return withPageCount(
        pawLibrary.getGallery(id) || catalog.eagleItemGallery(pawLibrary.eagleIdOf(id)),
      );
    }
    // pixiv の所持 (px:) は網に出ない: 台帳の札に、綴じ目から数えた頁数を添えて返す
    // (§15 E4。写しには token が無いので、網へ行くと失敗の一往復を挟んでから開く所だった)
    const parsedId = parseId(id);
    // Home の作者の見出し (人)。取りに行く網は無い: 母屋の控えから返す
    if (parsedId.source === 'home') {
      const home = homeAuthors();
      return home ? home.gallery(id) : null;
    }
    const pixivLibrary = typeof getPixivLibrary === 'function' ? getPixivLibrary() : null;
    if (parsedId.source === 'pixiv' && pixivLibrary && !String(parsedId.key).startsWith('user:')
      && pixivLibrary.has(parsedId.key)) {
      return withPageCount(pixivLibrary.toGallery(parsedId.key));
    }
    try {
      const gallery = await getGallery(id);
      if (gallery?.source === 'pawchive') await ownedReady();
      return annotateAll([gallery])[0];
    } catch (error) {
      const offline = catalog.getGalleryMeta(id);
      if (offline) return catalog.annotate([offline])[0];
      throw error;
    }
  });
  ipcMain.handle('suggest', async (_event, term, source) => {
    // Home の候補は所持の本に付いているタグから (源泉の補完でも辞書だけでもない)
    if (source === 'home') {
      await whenCatalog();
      const home = homeAuthors();
      return home ? home.suggestWords(term) : [];
    }
    return suggestTags(term, source);
  });
  // 済 の取り直し。pawchive は Eagle 側が持ち主なので、台帳のあとに当てる
  ipcMain.handle('annotate', async (_event, galleries) => {
    await whenCatalog();
    if ((galleries || []).some((gallery) => gallery?.source === 'pawchive')) await ownedReady();
    return annotateAll(galleries || []);
  });
  // 発見タブ。返すのは漉した後のキャッシュ: 巡回はエンジンが裏で進める
  ipcMain.handle('discovery', async () => {
    await whenCatalog();
    const discovery = getDiscovery();
    if (!discovery) return { empty: true, refreshing: false };
    const view = discovery.view();
    return {
      ...view,
      newReleases: catalog.annotate(view.newReleases || []),
      backlog: catalog.annotate(view.backlog || []),
    };
  });
}

module.exports = { registerSearchIpc };
