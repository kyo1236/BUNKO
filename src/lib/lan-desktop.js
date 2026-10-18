'use strict';

// Authenticated LAN transport for the same handlers and renderer used by Electron.
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.join(__dirname, '..');
const CHANNELS = new Set(('search search-author-context search-cancel gallery suggest annotate discovery catalog library-status downloads download cancel retry-download clear-finished reading-get reading-set rescan library-match library-candidates library-link library-unlink eagle-star eagle-trash paw-favorites paw-links paw-bulk pixiv home settings save-settings').split(' '));
// Home の書く action (結び・★・名前・表紙・出どころ・元に戻す) は手のひら版では受けない。電話が繋ぐ写しは
// 読み取り専用で起こしていない事があり、写しで書いた creator-links.json は次の同期で母艦の物に上書きされて消える
const { WRITE_ACTIONS: HOME_WRITE_ACTIONS } = require('../main/ipc/home-ipc');
const EVENTS = new Set(('downloads catalog catalog-progress library-progress paw-bulk-progress pixiv-bulk-progress').split(' '));
const SETTINGS = new Set(('source sortDir sortBySource language type zoom openOwned readerRtl readerFit loupeEnabled readerNextCard readerNextOrder readerResume ownedSaveConfirm showUnmatchedEagle mouseLeft mouseRight mouseDouble hideOwned favoritesOnly favoriteMinStars searchHistory searchPins session uiTheme uiLayout uiDensity uiCoverSize uiCoverSizes uiCaptions uiFit readerSpread saveFormat concurrency maxGalleries pixivHideAi pixivReadOriginal aitagEnabled pixivBookmarkPrivate pixivBookmarkRestrict pawBulkConcurrency').split(' '));
// home.js / home-bundle.js / home.css は机上版の Home の部品 (2026-09-28 から手のひら版でも Home を出す。読むだけ)
const ASSETS = new Set(('styles.css bunko-ui.css bunko-preferences.css home.css ai-meta-ui.css ai-meta-ui.js reader.js downloads-ui.js dupe-cluster.js navigation-state.js virtual-grid.js bunko-ui-model.js bunko-preferences.js bunko-icons.js bunko-ui.js home-bundle.js home.js app.js').split(' '));

class LanDesktop {
  constructor({ getImageBase }) {
    this.getImageBase = getImageBase;
    this.handlers = new Map();
    this.events = new Map();
    this.version = 0;
  }
  registry(ipc) {
    return {
      handle: (channel, handler) => { ipc.handle(channel, handler); this.handlers.set(channel, handler); },
      removeHandler: channel => { ipc.removeHandler(channel); this.handlers.delete(channel); },
    };
  }
  publish(channel, payload) {
    if (EVENTS.has(channel)) this.events.set(channel, { channel, payload, version: ++this.version });
  }
  async invoke(channel, args, client) {
    if (!CHANNELS.has(channel) || !this.handlers.has(channel)) throw new Error('この操作はPCで行ってください');
    if (channel === 'pixiv' && ['login', 'token', 'logout'].includes(args[0]?.action)) throw new Error('pixivの接続設定はPCで行ってください');
    if (channel === 'home' && HOME_WRITE_ACTIONS.has(String(args[0]?.action || ''))) throw new Error('作者の結び・★・名前の変更はPCで行ってください');
    if (channel === 'save-settings') {
      args = [Object.fromEntries(Object.entries(args[0] || {}).filter(([key]) => SETTINGS.has(key)))];
    }
    const result = await this.handlers.get(channel)({ sender: { id: `lan:${client}` } }, ...args);
    if (channel === 'settings' || channel === 'save-settings') {
      return Object.fromEntries(Object.entries(result || {}).filter(([key]) => SETTINGS.has(key) || ['readOnly', 'pixivLoggedIn'].includes(key)));
    }
    return result;
  }
  async route(server, req, res, url) {
    const p = url.pathname;
    if (p === '/api/desktop') {
      // JSON PUT + same-origin header prevents browser cross-site form writes.
      const origin = `http://${req.headers.host}`;
      if (req.method !== 'PUT' || req.headers['x-bunko-client'] !== '1' ||
          !String(req.headers['content-type'] || '').startsWith('application/json') ||
          (req.headers.origin && req.headers.origin !== origin)) {
        server.sendJson(res, 403, { error: 'invalid request' }); return true;
      }
      try {
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (Buffer.byteLength(body) > 1024 * 1024) throw new Error('要求が大きすぎます');
        }
        const { channel, args = [], client } = JSON.parse(body);
        if (!Array.isArray(args) || args.length > 5 || !/^[a-zA-Z0-9_-]{1,80}$/.test(client || '')) throw new Error('invalid request');
        const value = await this.invoke(channel, args, client);
        server.sendJson(res, 200, { value: value ?? null });
      } catch (error) { server.sendJson(res, 400, { error: error.message || '操作に失敗しました' }); }
      return true;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    if (p === '/api/desktop-events') {
      const since = Number(url.searchParams.get('since')) || 0;
      server.sendJson(res, 200, { version: this.version, events: [...this.events.values()].filter(e => e.version > since).sort((a, b) => a.version - b.version) });
      return true;
    }
    if (p === '/' || p === '/index.html') {
      let html = await fs.promises.readFile(path.join(ROOT, 'renderer/index.html'), 'utf8');
      html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]+>/, '')
        .replace('initial-scale=1', 'initial-scale=1, viewport-fit=cover')
        .replace('</head>', '<link rel="stylesheet" href="/mobile.css"><meta name="apple-mobile-web-app-capable" content="yes"><link rel="apple-touch-icon" href="/icon.png"><script src="/search-type.js"></script><script src="/search-providers.js"></script><script src="/search-intent.js"></script><script src="/query-port.js"></script><script src="/desktop-bridge.js"></script></head>')
        .replace('../../node_modules/pdfjs-dist/build/pdf.min.js', '/desktop-pdf.js')
        .replace('src="reader.js"', 'src="/phone-reader.js"');
      server.send(res, 200, 'text/html; charset=utf-8', html, {
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' blob:; worker-src 'self' blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'",
      });
      return true;
    }
    if (p === '/phone-reader') {
      const html = (await fs.promises.readFile(path.join(ROOT, 'lan/reader.html'), 'utf8'))
        .replace('<script src="/shelf.js">', '<script src="/phone-frame.js"></script><script src="/shelf.js">');
      server.send(res, 200, 'text/html; charset=utf-8', html, {
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'self'; base-uri 'none'",
      });
      return true;
    }
    // Home の札の源泉の印 (home.js が icons/sites/<名>.png|ico を相対で読む)。名は英数だけ
    const iconHit = p.match(/^\/icons\/sites\/([a-z0-9-]+)\.(png|ico)$/);
    if (iconHit) {
      const iconFile = path.join(ROOT, 'renderer', 'icons', 'sites', `${iconHit[1]}.${iconHit[2]}`);
      let bytes;
      try { bytes = await fs.promises.readFile(iconFile); } catch { server.sendJson(res, 404, { error: 'not found' }); return true; }
      server.send(res, 200, iconHit[2] === 'ico' ? 'image/x-icon' : 'image/png', bytes, { 'Cache-Control': 'private, max-age=86400' });
      return true;
    }
    const name = p.slice(1);
    let file;
    if (ASSETS.has(name)) file = path.join(ROOT, 'renderer', name);
    if (name === 'mobile.css' || name === 'desktop-bridge.js' || name === 'phone-reader.js' || name === 'phone-frame.js') file = path.join(ROOT, 'lan', name);
    if (name === 'desktop-pdf.js') file = path.join(ROOT, '../node_modules/pdfjs-dist/build/pdf.min.js');
    if (name === 'search-type.js') file = path.join(ROOT, 'lib/search-type.js');
    if (name === 'query-port.js') file = path.join(ROOT, 'lib/sources/query-port.js');
    if (name === 'search-providers.js') file = path.join(ROOT, 'lib/search-providers.js');
    if (name === 'search-intent.js') file = path.join(ROOT, 'lib/search-intent.js');
    if (file) {
      server.send(res, 200, name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', await fs.promises.readFile(file), { 'Cache-Control': 'no-cache' });
      return true;
    }
    if (p.startsWith('/media/')) {
      const base = await this.getImageBase();
      if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) { server.sendJson(res, 503, { error: '画像の準備中です' }); return true; }
      // A fixed loopback origin, never an arbitrary URL supplied by the phone.
      const target = new URL(base);
      const upstream = http.request({ hostname: target.hostname, port: target.port, path: p.slice('/media'.length) + url.search, method: req.method, headers: req.headers.range ? { Range: req.headers.range } : {} }, response => {
        const headers = { 'Cache-Control': 'private, no-cache', 'X-Content-Type-Options': 'nosniff' };
        for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges']) if (response.headers[key]) headers[key] = response.headers[key];
        res.writeHead(response.statusCode, headers);
        response.pipe(res);
      });
      upstream.on('error', () => { if (!res.headersSent) server.sendJson(res, 502, { error: '画像を取得できませんでした' }); else res.destroy(); });
      upstream.setTimeout(120000, () => upstream.destroy());
      res.on('close', () => upstream.destroy());
      upstream.end();
      return true;
    }
    return false;
  }
}
module.exports = { LanDesktop, CHANNELS, SETTINGS };
