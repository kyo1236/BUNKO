'use strict';
(() => {
  const client = `phone-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const listeners = new Map();
  const STORE = 'bunko-phone-preferences';
  let local = {};
  try { local = JSON.parse(localStorage.getItem(STORE) || '{}'); } catch { /* Private browsing. */ }
  const sharedSettings = new Set(['saveFormat', 'concurrency', 'maxGalleries', 'pawBulkConcurrency']);
  const defaults = { openOwned: 'app', mouseLeft: 'detail', mouseRight: 'read', mouseDouble: 'none', uiCoverSize: 104, readerSpread: false, loupeEnabled: false };
  async function invoke(channel, ...args) {
    const response = await fetch('/api/desktop', {
      method: 'PUT', credentials: 'same-origin', keepalive: channel === 'reading-set',
      headers: { 'Content-Type': 'application/json', 'X-Bunko-Client': '1' },
      body: JSON.stringify({ channel, args, client }),
    });
    if (response.status === 401 || response.status === 429) throw new Error('PCの「端末で読む」から最新のQRコードで接続し直してください');
    const result = await response.json();
    if (!response.ok || result.error) throw new Error(result.error || 'PCとの通信に失敗しました');
    return result.value;
  }
  // 上部の源泉の並びは preload.js と同じ (先頭に Home、E-Hentai は外す)。test/cross-source.test.js が突き合わせる
  const api = { searchProviders: [{ id: 'home', label: 'Home' }, ...window.BunkoSearchProviders.registry.list().filter(({id})=>id!=='ehentai').map(({id,label})=>({id,label}))], completionRanges: window.BunkoSearchIntent.completionRanges, searchAuthorNames: window.BunkoSearchIntent.authorNames, remote: true, portQuery: (...args) => window.BunkoQueryPort.portQuery(...args), imageBase: async () => `${location.origin}/media`, noteFallback() {} };
  const methods = {
    search:'search', searchAuthorContext:'search-author-context', cancelSearch:'search-cancel', gallery:'gallery', suggest:'suggest', download:'download', cancel:'cancel', retryDownload:'retry-download', downloads:'downloads', clearFinished:'clear-finished',
    setEagleStar:'eagle-star', catalog:'catalog', rescan:'rescan', annotate:'annotate', libraryStatus:'library-status', discovery:'discovery', libraryMatch:'library-match', linkCandidates:'library-candidates', linkOwned:'library-link', unlinkOwned:'library-unlink', trashEagle:'eagle-trash', readingGet:'reading-get', readingSet:'reading-set', pawFavorites:'paw-favorites', pawLinks:'paw-links', pawBulk:'paw-bulk', pixiv:'pixiv', home:'home',
  };
  for (const [method, channel] of Object.entries(methods)) api[method] = (...args) => invoke(channel, ...args);
  api.search = payload => invoke('search', { ...payload,
    ...(typeof local.showUnmatchedEagle === 'boolean' ? { includeUnmatched: local.showUnmatchedEagle } : {}),
  });
  api.settings = async () => ({ ...await invoke('settings'), ...defaults, ...local, openOwned: 'app' });
  api.saveSettings = async partial => {
    const shared = Object.fromEntries(Object.entries(partial || {}).filter(([key]) => sharedSettings.has(key)));
    const result = Object.keys(shared).length ? await invoke('save-settings', shared) : await invoke('settings');
    local = { ...local, ...Object.fromEntries(Object.entries(partial || {}).filter(([key]) => !sharedSettings.has(key))) };
    try { localStorage.setItem(STORE, JSON.stringify(local)); } catch { /* Session remains usable. */ }
    return { ...result, ...defaults, ...local, openOwned: 'app' };
  };
  for (const name of ['chooseFolder', 'openFolder', 'showInFolder', 'openEagle', 'syncHomecore']) api[name] = async () => { throw new Error('この操作はPCで行ってください'); };
  api.lanShare = async () => ({ running: true, remote: true, urls: [] });
  api.readerActive = async () => true;
  api.toggleFullscreen = async () => { if (document.fullscreenElement) await document.exitFullscreen?.(); else await document.documentElement.requestFullscreen?.(); return !!document.fullscreenElement; };
  api.openExternal = async value => {
    const url = new URL(value);
    if (url.protocol === 'https:') window.open(url.href, '_blank', 'noopener,noreferrer');
  };
  api.openCaptionUrl = async value => { const url=new URL(value); if (['https:','http:'].includes(url.protocol) && !url.username && !url.password) window.open(url.href,'_blank','noopener,noreferrer'); };
  const eventNames = { onDownloads:'downloads', onCatalog:'catalog', onNavCommand:'nav-command', onCatalogProgress:'catalog-progress', onPawBulkProgress:'paw-bulk-progress', onLibraryProgress:'library-progress', onPixivBulkProgress:'pixiv-bulk-progress' };
  for (const [method, name] of Object.entries(eventNames)) api[method] = handler => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(handler);
    return () => listeners.get(name).delete(handler);
  };
  window.hitomi = api;
  let version = 0;
  async function poll() {
    try {
      if (!document.hidden) {
        const response = await fetch(`/api/desktop-events?since=${version}`);
        if (response.ok) {
          const data = await response.json();
          for (const event of data.events) for (const fn of listeners.get(event.channel) || []) { try { fn(event.payload); } catch (error) { console.error(error); } }
          version = data.version;
        }
      }
    } catch { /* Reconnect automatically after a temporary Wi-Fi interruption. */ }
    setTimeout(poll, 2000);
  }
  document.addEventListener('DOMContentLoaded', () => {
    document.body.dataset.remote = 'true';
    // Actions that require a native PC window are not presented as phone actions.
    const style = document.createElement('style');
    style.textContent = '.preference-row:has([data-key="eagleLibrary"]),.preference-row:has([data-key="downloadDir"]),.preference-row:has([data-key="pawBulkDir"]),.preference-row:has([data-key="syncDest"]),.preference-row:has([data-key="pawEagleFolder"]),.preference-row:has([data-key="openOwned"]),.preference-row:has([data-key="autoSync"]),.preference-row:has([data-key="trayCloseMinutes"]),.preference-row:has(#set-sync-homecore),.preference-row:has(#set-pixiv-login),.preference-row:has(#set-lan),.preference-row:has(#set-lan-copy){display:none!important}';
    document.head.append(style);
    poll();
  });
})();
