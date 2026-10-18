const { contextBridge, ipcRenderer } = require('electron');

// 検索語をサイト間で持ち運ぶ判じ。**同期**で答える: IPC の待ちを挟むと
// サイトを移った瞬間に棚が一度空く (利用者が一番嫌う空白)。
// 表そのものは母屋の sources/query-port が持ち、renderer に写しを作らない
const { portQuery } = require('./lib/sources/query-port');

contextBridge.exposeInMainWorld('hitomi', {
  // 上部の源泉の並び。先頭に Home (源泉横断の作者の一覧)、E-Hentai は並びから外した
  // (docs/home-tab-spec-2026-09-23.md。構文の登録簿 search-providers には Home を足さない:
  // 語の持ち運びと LAN の机上版がその登録簿を読む)
  searchProviders: [
    { id: 'home', label: 'Home' },
    ...require('./lib/search-providers').registry.list()
      .filter(({ id }) => id !== 'ehentai')
      .map(({ id, label }) => ({ id, label })),
  ],
  completionRanges: require('./lib/search-intent').completionRanges,
  searchAuthorNames: require('./lib/search-intent').authorNames,
  portQuery: (query, from, to, context) => portQuery(query, from, to, context),
  imageBase: () => ipcRenderer.invoke('image-base'),
  searchAuthorContext: (payload) => ipcRenderer.invoke('search-author-context', payload),
  search: (payload) => ipcRenderer.invoke('search', payload),
  cancelSearch: (requestId) => ipcRenderer.invoke('search-cancel', requestId),
  gallery: (id) => ipcRenderer.invoke('gallery', id),
  suggest: (term, source) => ipcRenderer.invoke('suggest', term, source),
  download: (id, title) => ipcRenderer.invoke('download', id, title),
  cancel: (id) => ipcRenderer.invoke('cancel', id),
  retryDownload: (id) => ipcRenderer.invoke('retry-download', id),
  downloads: () => ipcRenderer.invoke('downloads'),
  clearFinished: () => ipcRenderer.invoke('clear-finished'),
  settings: () => ipcRenderer.invoke('settings'),
  saveSettings: (partial) => ipcRenderer.invoke('save-settings', partial),
  chooseFolder: (kind) => ipcRenderer.invoke('choose-folder', kind),
  openFolder: (target) => ipcRenderer.invoke('open-folder', target),
  showInFolder: (target) => ipcRenderer.invoke('show-in-folder', target),
  openCaptionUrl: (url) => ipcRenderer.invoke('open-caption-url', url),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openEagle: (eagleId) => ipcRenderer.invoke('open-eagle', eagleId),
  setEagleStar: (eagleId, star) => ipcRenderer.invoke('eagle-star', eagleId, star),
  toggleFullscreen: () => ipcRenderer.invoke('toggle-fullscreen'),
  readerActive: (active) => ipcRenderer.invoke('reader-active', active),
  catalog: () => ipcRenderer.invoke('catalog'),
  rescan: () => ipcRenderer.invoke('rescan'),
  syncHomecore: () => ipcRenderer.invoke('sync-homecore'),
  annotate: (galleries) => ipcRenderer.invoke('annotate', galleries),
  libraryStatus: () => ipcRenderer.invoke('library-status'),
  // 「まだ通っている古い道」を数えるための口。落としてよいかの判断に要る
  noteFallback: (code) => ipcRenderer.send('note-fallback', String(code || '')),
  discovery: () => ipcRenderer.invoke('discovery'),
  libraryMatch: (action) => ipcRenderer.invoke('library-match', action),
  linkCandidates: (query) => ipcRenderer.invoke('library-candidates', query),
  linkOwned: (payload) => ipcRenderer.invoke('library-link', payload),
  unlinkOwned: (eagleId) => ipcRenderer.invoke('library-unlink', eagleId),
  trashEagle: (payload) => ipcRenderer.invoke('eagle-trash', payload),
  readingGet: (id) => ipcRenderer.invoke('reading-get', id),
  readingSet: (id, entry) => ipcRenderer.invoke('reading-set', id, entry),
  lanShare: (payload) => ipcRenderer.invoke('lan-share', payload),
  pawFavorites: (payload) => ipcRenderer.invoke('paw-favorites', payload),
  pawLinks: (payload) => ipcRenderer.invoke('paw-links', payload),
  pawBulk: (payload) => ipcRenderer.invoke('paw-bulk', payload),
  // pixiv の口は一つ (action で分ける)。ログイン・候補へ・同じ人?・一括・付け直し
  pixiv: (payload) => ipcRenderer.invoke('pixiv', payload),
  // Home の口も一つ (action で分ける)。作者頁・hitomi の作品・詳細の行の結び
  home: (payload) => ipcRenderer.invoke('home', payload),
  // 後ろの列で「プロンプトあり」に変わった札 (印を付け直す)
  onAiMetaMark: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('ai-meta-mark', listener);
    return () => ipcRenderer.removeListener('ai-meta-mark', listener);
  },
  // 所持の生成情報の埋め戻しの進み (設定の行が受ける)
  onAiMetaBackfill: (handler) => {
    const listener = (_event, status) => handler(status);
    ipcRenderer.on('ai-meta-backfill', listener);
    return () => ipcRenderer.removeListener('ai-meta-backfill', listener);
  },
  onPixivBulkProgress: (handler) => {
    const listener = (_event, status) => handler(status);
    ipcRenderer.on('pixiv-bulk-progress', listener);
    return () => ipcRenderer.removeListener('pixiv-bulk-progress', listener);
  },
  onDownloads: (handler) => {
    const listener = (_event, jobs) => handler(jobs);
    ipcRenderer.on('downloads', listener);
    return () => ipcRenderer.removeListener('downloads', listener);
  },
  onCatalog: (handler) => {
    const listener = (_event, snapshot) => handler(snapshot);
    ipcRenderer.on('catalog', listener);
    return () => ipcRenderer.removeListener('catalog', listener);
  },
  onNavCommand: (handler) => {
    const listener = (_event, command) => handler(command);
    ipcRenderer.on('nav-command', listener);
    return () => ipcRenderer.removeListener('nav-command', listener);
  },
  onCatalogProgress: (handler) => {
    const listener = (_event, progress) => handler(progress);
    ipcRenderer.on('catalog-progress', listener);
    return () => ipcRenderer.removeListener('catalog-progress', listener);
  },
  onPawBulkProgress: (handler) => {
    const listener = (_event, status) => handler(status);
    ipcRenderer.on('paw-bulk-progress', listener);
    return () => ipcRenderer.removeListener('paw-bulk-progress', listener);
  },
  onLibraryProgress: (handler) => {
    const listener = (_event, status) => handler(status);
    ipcRenderer.on('library-progress', listener);
    return () => ipcRenderer.removeListener('library-progress', listener);
  },
});
