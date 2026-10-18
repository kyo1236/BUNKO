'use strict';
// 手のひら版の試写台 (node scripts/lan-preview.js → http://127.0.0.1:18790/)。src/lan の画面をそのまま配り、母艦の API は番号入りの偽頁で代役する。
// 実際の LAN サーバ (Electron) を立てずに、PC のブラウザで iPhone 幅の挙動を確かめるためだけの物
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LAN = path.join(ROOT, 'src', 'lan');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const PORT = Number(process.env.PORT) || 18790;
const LAG = Number(process.env.LAG) || 90;   // 頁を配るまでの見せかけの遅れ (ms)

// 本物の LAN サーバは一頁 30 冊で切る (lan-server.js の LIST_SIZE)。試写台も同じ形で
// 返さないと「画面が埋まるまで追い足す」「巻いたら継ぐ」の道を一度も踏めない
const LIST_SIZE = 30;
// 手で書いた三冊 + 数合わせ。COUNT で増やせる (既定 84 冊 = 三頁ぶん)
const COUNT = Number(process.env.COUNT) || 84;
const BOOKS = [
  { id: '1001', title: '試し読み 甲 (24 頁・縦長)', pageCount: 24, ratio: 0.707, hue: 28 },
  { id: '1002', title: '試し読み 乙 (40 頁・横長混じり)', pageCount: 40, ratio: 0.707, hue: 200, wide: [5, 6, 19] },
  { id: '1003', title: '試し読み 丙 (8 頁)', pageCount: 8, ratio: 0.75, hue: 150 },
];
const KANA = 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろ';
while (BOOKS.length < COUNT) {
  const n = BOOKS.length + 1;
  BOOKS.push({
    id: String(1000 + n),
    title: KANA[n % KANA.length] + 'の本 ' + n + ' (試写)',
    pageCount: 6 + (n % 30),
    ratio: 0.707,
    hue: (n * 37) % 360,
  });
}
const reading = {};

function card(b) {
  return {
    id: b.id, title: b.title, star: 4, type: 'manga',
    artists: [{ name: 'preview', label: '試写' }], groups: [], series: [], characters: [],
    tags: [{ name: 'preview', type: 'tag', label: '試写' }],
    pageCount: b.pageCount, addedDate: '2026-09-01', publishedDate: '2026-09-01',
  };
}

function pageSvg(b, i) {
  const wide = b.wide && b.wide.includes(i);
  const w = wide ? 1400 : 1000;
  const h = wide ? 1000 : Math.round(1000 / b.ratio);
  const n = i + 1;
  const bg = `hsl(${b.hue} 30% 92%)`;
  const ink = `hsl(${b.hue} 40% 25%)`;
  // 頁の中に「右上・左下」の印を置いて、送りの向きが目で追えるようにする
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<rect width="${w}" height="${h}" fill="${bg}"/>
<rect x="30" y="30" width="${w - 60}" height="${h - 60}" fill="none" stroke="${ink}" stroke-width="6"/>
<text x="${w / 2}" y="${h / 2 + 90}" text-anchor="middle" font-family="sans-serif" font-size="280" font-weight="700" fill="${ink}">${n}</text>
<text x="${w / 2}" y="${h / 2 + 200}" text-anchor="middle" font-family="sans-serif" font-size="60" fill="${ink}">${b.title}</text>
<text x="${w - 60}" y="120" text-anchor="end" font-family="sans-serif" font-size="70" fill="${ink}">右 ${n}</text>
<text x="60" y="${h - 60}" font-family="sans-serif" font-size="70" fill="${ink}">左 ${n}</text>
<circle cx="${w / 2}" cy="${h - 200}" r="${40 + (n % 5) * 20}" fill="${ink}" opacity=".35"/>
</svg>`;
}

function coverSvg(b) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="566" viewBox="0 0 400 566">
<rect width="400" height="566" fill="hsl(${b.hue} 35% 80%)"/>
<text x="200" y="300" text-anchor="middle" font-family="sans-serif" font-size="60" fill="hsl(${b.hue} 40% 25%)">${b.id}</text></svg>`;
}

function send(res, code, type, body, extra) {
  res.writeHead(code, Object.assign({ 'Content-Type': type, 'Cache-Control': 'no-store' }, extra || {}));
  res.end(body);
}
function json(res, obj, code) { send(res, code || 200, 'application/json; charset=utf-8', JSON.stringify(obj)); }
function file(res, p, type) {
  fs.readFile(p, (err, bytes) => {
    if (err) { send(res, 404, 'text/plain', 'not found'); return; }
    send(res, 200, type, bytes);
  });
}

const STATIC = {
  '/': [path.join(LAN, 'reader.html'), 'text/html; charset=utf-8'],
  '/index.html': [path.join(LAN, 'reader.html'), 'text/html; charset=utf-8'],
  '/reader.css': [path.join(LAN, 'reader.css'), 'text/css; charset=utf-8'],
  '/shelf.js': [path.join(LAN, 'shelf.js'), 'text/javascript; charset=utf-8'],
  '/read.js': [path.join(LAN, 'read.js'), 'text/javascript; charset=utf-8'],
  '/fonts.css': [path.join(RENDERER, 'fonts.css'), 'text/css; charset=utf-8'],
  '/icon.png': [path.join(ROOT, 'assets', 'icon-256.png'), 'image/png'],
};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (STATIC[p]) { file(res, STATIC[p][0], STATIC[p][1]); return; }
  let m = p.match(/^\/fonts\/([\w-]+\.woff2)$/);
  if (m) { file(res, path.join(RENDERER, 'fonts', m[1]), 'font/woff2'); return; }
  if (p === '/api/books') {
    // 本物と同じ: 語で絞り、頁で切り、続きの有無は総数で決める (lan-server.serveList)
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
    const page = Math.max(0, Number(url.searchParams.get('page')) || 0);
    const hit = q ? BOOKS.filter((b) => b.title.toLowerCase().includes(q)) : BOOKS;
    const slice = hit.slice(page * LIST_SIZE, (page + 1) * LIST_SIZE);
    json(res, {
      items: slice.map(card),
      page,
      hasMore: (page + 1) * LIST_SIZE < hit.length,
      total: hit.length,
    });
    return;
  }
  if (p === '/api/recent') { json(res, { items: [] }); return; }
  if (p === '/api/suggest') {
    // 候補だけは本物の辞書と飾りを通す (母屋の lan-server と同じ組み方)。
    // 網にも Eagle にも触らない
    const term = String(url.searchParams.get('q') || '');
    let items = [];
    try {
      const { suggestAliases } = require(path.join(ROOT, 'src', 'lib', 'search-aliases'));
      const { decorate } = require(path.join(ROOT, 'src', 'lib', 'search-decorate'));
      items = suggestAliases(term, 8).map((item) => {
        const row = decorate(item, 'hitomi');
        return { value: row.value || item.value, type: row.type, name: row.name, label: row.label || '', secondary: row.secondary || '' };
      });
    } catch { items = []; }
    json(res, { items });
    return;
  }
  if (p === '/api/reading') { json(res, reading); return; }
  m = p.match(/^\/api\/reading\/(\w+)$/);
  if (m) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(body); } catch { /* ignore */ }
      reading[m[1]] = { page: payload.page || 0, pageCount: payload.pageCount || 0, finished: !!payload.finished, updatedAt: Date.now() };
      json(res, reading[m[1]]);
    });
    return;
  }
  m = p.match(/^\/api\/book\/(\w+)$/);
  if (m) {
    const b = BOOKS.find((x) => x.id === m[1]);
    if (!b) { json(res, { error: 'not found' }, 404); return; }
    json(res, { id: b.id, title: b.title, artists: ['preview'], pageCount: b.pageCount, version: 1,
      ratios: [b.ratio], reading: reading[b.id] || null });
    return;
  }
  m = p.match(/^\/api\/book\/(\w+)\/cover$/);
  if (m) {
    const b = BOOKS.find((x) => x.id === m[1]);
    if (!b) { send(res, 404, 'text/plain', 'not found'); return; }
    send(res, 200, 'image/svg+xml', coverSvg(b));
    return;
  }
  m = p.match(/^\/api\/book\/(\w+)\/page\/(\d+)$/);
  if (m) {
    const b = BOOKS.find((x) => x.id === m[1]);
    const i = Number(m[2]);
    if (!b || i >= b.pageCount) { send(res, 404, 'text/plain', 'not found'); return; }
    setTimeout(() => send(res, 200, 'image/svg+xml', pageSvg(b, i)), LAG);
    return;
  }
  send(res, 404, 'text/plain', 'not found');
}).listen(PORT, '127.0.0.1', () => {
  console.log('preview at http://127.0.0.1:' + PORT + '/');
});
