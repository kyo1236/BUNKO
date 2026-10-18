'use strict';
// Isolated real HTTP transport with synthetic handlers; no personal files or external APIs.
require('../test/helpers/stub-electron-2').installStub();
const http = require('http');
const { LanServer } = require('../src/lib/lan-server');
const { LanDesktop } = require('../src/lib/lan-desktop');
const port = Number(process.env.PORT) || 18792;
const desktop = new LanDesktop({ getImageBase: async () => `http://127.0.0.1:${port}`, portQuery: require('../src/lib/sources/query-port').portQuery });
const ipc = desktop.registry({ handle() {}, removeHandler() {} });
const books = Array.from({ length: 60 }, (_, i) => ({ id: String(2000000 + i), source:process.env.PREVIEW_SOURCE || 'hitomi', userId:'1234', caption:'見本のキャプションです。\nhttps://www.patreon.com/masehumi\n次回 illust/149809470&#x20;\n前回 illust/149665970 &#x20;', title:`見本の作品 ${i + 1}`, artists:[{name:'sample',label:'見本作家'}], groups:[],series:process.env.PREVIEW_SOURCE==='pixiv'?{title:'見本のシリーズ名'}:[],characters:[],tags:[{name:'sample',label:'見本タグ',type:'tag'}], type:'manga', language:{name:'japanese'}, pageCount:12, owned:i % 3 === 0, idOwned:i % 3 === 0, star:4, eagleId:i % 3 === 0 ? `sample${i}` : '', url:'https://example.invalid/' }));
let settings = { source:'hitomi',zoom:3,readerRtl:true,readerFit:'contain',saveFormat:'pdf',searchHistory:[],searchPins:[],sortBySource:{},uiTheme:'dark' };
let jobs = [], reading = {};
ipc.handle('settings', async () => settings);
ipc.handle('save-settings', async (_, patch) => (settings = {...settings,...patch}));
ipc.handle('search-author-context', async (_, p) => require('../src/lib/search-author-context').searchAuthorContext(p.query,p.from,{pixiv:{1234:{folderId:'fixture-author',name:'見本作家'}},pawchive:{'fanbox:5678':'fixture-author'}}));
ipc.handle('search', async (_, p) => {
  const keyword=String(p.query || '').replace(/(?:user:1234|fanbox\/5678)/g,'').trim();
  const pool = books.filter(b => (p.scope !== 'library' || b.owned) && (!keyword || b.title.includes(keyword) || b.tags.some(tag => tag.name.includes(keyword))));
  const size = p.pageSize || 24, start = (p.page || 0) * size;
  return { galleries:pool.slice(start,start+size).map(b=>({...b,source:p.source})),total:pool.length,hasNext:start+size<pool.length,query:p.query,requestId:p.requestId };
});
ipc.handle('gallery', async (_, id) => books.find(b => b.id === id) || (/^px:\d+$/.test(id) ? {...books[1],id,title:'リンク先の見本作品'} : null));
ipc.handle('suggest', async () => []);
ipc.handle('search-cancel', async () => true);
ipc.handle('annotate', async (_, rows) => rows);
ipc.handle('downloads', async () => jobs);
ipc.handle('download', async (_, id, title) => {
  const job = { id,title,status:'queued',total:12,done:0 }; jobs.push(job); desktop.publish('downloads', jobs); return job;
});
ipc.handle('cancel', async (_, id) => { jobs = jobs.map(j => j.id === id ? {...j,status:'cancelled'} : j);desktop.publish('downloads',jobs);return jobs; });
ipc.handle('clear-finished', async () => { jobs = jobs.filter(j => j.status === 'queued');desktop.publish('downloads',jobs);return jobs; });
ipc.handle('reading-get', async (_, id) => reading[id] || null);
ipc.handle('reading-set', async (_, id, entry) => (reading[id] = entry));
ipc.handle('catalog', async () => ({scanning:false}));
ipc.handle('library-status', async () => ({owned:20,withMeta:20,flags:{},fallbacks:0}));
ipc.handle('discovery', async () => ({sections:[]}));
ipc.handle('pixiv', async (_, request) => request.action === 'discover' ? { recent:[{seed:books[0],illusts:books.slice(1,7)}], users:[0,1,2].map(n=>({creator:{...books[n],id:`pxu:${n+1}`,kind:'creator',title:`見本作家 ${n+1}`,userId:String(n+1)},illusts:books.slice(10+n*3,13+n*3)})),illusts:books.slice(25,37)} : request.action === 'related' ? books.slice(40,46) : {loggedIn:true});
ipc.handle('paw-bulk', async () => ({running:false}));
ipc.handle('paw-favorites', async () => ({items:[]}));
ipc.handle('eagle-star', async (_, id, star) => ({ok:true,star}));
const lan = new LanServer({catalog:{},reading:{all:()=>({})},settings:()=>({}),saveSettings(){},desktop});
lan.serveBook = async (res, id) => lan.sendJson(res, 200, { id, title: '見本', pageCount: 12, version: 1, ratios: Array(12).fill(400 / 566) });
lan.servePage = async (req, res) => lan.send(res, 200, 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="566"><rect width="400" height="566" fill="#8faca1"/><text x="100" y="280" font-size="40">Sample page</text></svg>');
if (process.env.PREVIEW_DESKTOP === '1') {
  const send = lan.send.bind(lan);
  lan.send = (res, code, type, body, headers) => send(res, code, type, typeof body === 'string' && type.startsWith('text/html') ? body.replace('src="/phone-reader.js"','src="reader.js"').replace('<link rel="stylesheet" href="/mobile.css">','') : body, headers);
}
lan.address = '127.0.0.1'; lan.port = port; lan.token = 'preview-only';
http.createServer(async (req,res) => {
  if (req.url === '/phone-preview') {
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
    res.end('<!doctype html><title>iPhone幅・見本データ</title><body style="margin:0;background:#101113;display:grid;place-items:center;height:100vh"><iframe title="iPhone画面" src="/?k=preview-only" style="width:390px;height:844px;border:1px solid #444;border-radius:18px"></iframe>');return;
  }
  const writeHead = res.writeHead.bind(res);
  res.writeHead = (code, headers) => {
    if (headers?.['Content-Security-Policy']) headers['Content-Security-Policy'] = headers['Content-Security-Policy'].replace("frame-ancestors 'none'", "frame-ancestors 'self'");
    return writeHead(code, headers);
  };
  // The loopback image origin used only by the authenticated media proxy in this fixture.
  if (/^\/(?:img\?|(?:image|thumb|cover|pweagle)\/)/.test(req.url)) {
    const n = Number(req.url.match(/\d+/)?.[0] || 1);
    res.writeHead(200, {'Content-Type':'image/svg+xml'});
    res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="566"><rect width="400" height="566" fill="hsl(${n%360} 28% 72%)"/><circle cx="200" cy="230" r="100" fill="hsl(${n%360} 28% 48%)"/><text x="200" y="440" text-anchor="middle" font-size="40">${n}</text></svg>`);return;
  }
  try { await lan.handle(req,res); } catch(e) { res.writeHead(500);res.end(e.message); }
}).listen(port,'127.0.0.1',()=>console.log(`Synthetic LAN preview: http://127.0.0.1:${port}/?k=preview-only`));

