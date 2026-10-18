'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const vm = require('vm');
const fs = require('fs');
require('./helpers/stub-electron-2').installStub();
const { LanServer } = require('../src/lib/lan-server');
const { LanDesktop } = require('../src/lib/lan-desktop');
const { portQuery } = require('../src/lib/sources/query-port');

async function fixture(t) {
  const desktop = new LanDesktop({getImageBase:async()=>'',portQuery});
  const ipc = desktop.registry({handle(){},removeHandler(){}});
  const lan = new LanServer({catalog:{},reading:{},settings:()=>({}),saveSettings(){},desktop});
  const server = http.createServer((req,res)=>lan.handle(req,res).catch(e=>{res.writeHead(500);res.end(e.message);}));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{server.closeAllConnections();server.close();});
  lan.address='127.0.0.1';lan.port=server.address().port;lan.token='test-key';
  const base=`http://127.0.0.1:${lan.port}`;
  const headers={Cookie:'bunko_lan=test-key','Content-Type':'application/json','X-Bunko-Client':'1',Origin:base};
  const call=(channel,args=[],extra={})=>fetch(base+'/api/desktop',{method:'PUT',headers:{...headers,...extra},body:JSON.stringify({channel,args,client:'phone-a'})});
  return {desktop,ipc,lan,base,headers,call};
}
test('authenticated phone uses desktop HTML, assets and handlers; unauthenticated routes stay closed',async t=>{
  const f=await fixture(t);let payload;
  f.ipc.handle('search',async(e,p)=>{payload={e,p};return {galleries:[{id:'1'}]};});
  const response=await f.call('search',[{scope:'all',source:'pixiv'}]);
  assert.equal(response.status,200);assert.equal((await response.json()).value.galleries[0].id,'1');
  assert.equal(payload.p.scope,'all');assert.equal(payload.e.sender.id,'lan:phone-a');
  const html=await (await fetch(f.base,{headers:f.headers})).text();
  assert.match(html,/phone-reader.js/);assert.match(html,/desktop-bridge.js/);assert.match(html,/bunko-ui.css/);assert.match(html,/mobile.css/);
  for(const p of ['/api/desktop-events','/desktop-bridge.js','/phone-reader','/phone-frame.js','/media/image/1/0','/icons/sites/hitomi.png']) assert.equal((await fetch(f.base+p)).status,401);
  for(const p of ['/desktop-bridge.js','/phone-reader','/phone-reader.js','/phone-frame.js','/shelf.js','/read.js','/app.js','/mobile.css','/search-type.js','/query-port.js','/desktop-pdf.js','/home.js','/home-bundle.js','/home.css']) assert.equal((await fetch(f.base+p,{headers:f.headers})).status,200,p);
});
test('phone reads Home (author page, icons) through the shared handler but cannot write links, stars or names',async t=>{
  const f=await fixture(t);let seen=[];
  f.ipc.handle('home',async(_,p)=>{seen.push(p.action);return {ok:p.action};});
  for(const action of ['author','web','webHits','pages','hitomi']){
    const r=await f.call('home',[{action,id:'p1'}]);
    assert.equal(r.status,200,action);assert.equal((await r.json()).value.ok,action);
  }
  for(const action of ['link','rate','suggest','origin','rename','cover','undo']){
    const r=await f.call('home',[{action,id:'p1'}]);
    assert.equal(r.status,400,action);assert.match((await r.json()).error,/PCで/,action);
  }
  assert.deepEqual(seen,['author','web','webHits','pages','hitomi'],'書く action が母屋の口へ届いている');
  // 札の源泉の印。名は英数だけ、上の階層へは出ない
  const png=await fetch(f.base+'/icons/sites/hitomi.png',{headers:f.headers});
  assert.equal(png.status,200);assert.equal(png.headers.get('content-type'),'image/png');
  const ico=await fetch(f.base+'/icons/sites/pixiv.ico',{headers:f.headers});
  assert.equal(ico.status,200);assert.equal(ico.headers.get('content-type'),'image/x-icon');
  assert.equal((await fetch(f.base+'/icons/sites/nothing.png',{headers:f.headers})).status,404);
  assert.notEqual((await fetch(f.base+'/icons/sites/..%2F..%2Fapp.js',{headers:f.headers})).status,200);
});
test('phone cannot invoke native actions, bypass read-only or change private settings',async t=>{
  const f=await fixture(t);let saved;
  f.ipc.handle('settings',async()=>({uiTheme:'dark',lanToken:'secret',pixivRefreshToken:'secret',remoteEagle:{token:'secret'},downloadDir:'private',readOnly:true}));
  f.ipc.handle('save-settings',async(_,p)=>(saved=p));
  assert.deepEqual((await (await f.call('settings')).json()).value,{uiTheme:'dark',readOnly:true});
  await f.call('save-settings',[{uiTheme:'light',lanToken:'changed',readOnly:false,downloadDir:'other'}]);
  assert.deepEqual(saved,{uiTheme:'light'});
  assert.equal((await f.call('open-folder',['C:/'])).status,400);
  f.ipc.handle('download',async()=>{throw new Error('read only');});
  assert.match((await (await f.call('download',['1'])).json()).error,/read only/);
  assert.equal((await f.call('settings',[],{Origin:'https://evil.example'})).status,403);
  assert.equal((await f.call('settings',[],{'X-Bunko-Client':''})).status,403);
});
test('desktop progress is incremental and isolated search identities do not collide',async t=>{
  const f=await fixture(t);
  f.desktop.publish('downloads',[{id:'1',status:'queued'}]);
  f.desktop.publish('downloads',[{id:'1',status:'done'}]);
  f.desktop.publish('unapproved-event',{secret:true});
  const data=await (await fetch(f.base+'/api/desktop-events?since=0',{headers:f.headers})).json();
  assert.equal(data.events.length,1);assert.equal(data.events[0].payload[0].status,'done');
  const next=await (await fetch(f.base+`/api/desktop-events?since=${data.version}`,{headers:f.headers})).json();
  assert.deepEqual(next.events,[]);
  const ids=[];f.ipc.handle('search',async e=>{ids.push(e.sender.id);});
  await f.desktop.invoke('search',[],'a');await f.desktop.invoke('search',[],'b');assert.notEqual(ids[0],ids[1]);
});
test('browser and desktop port the same Japanese search query',()=>{
  const context=vm.createContext({window:{}});
  for(const file of ['src/lib/search-type.js','src/lib/search-providers.js','src/lib/search-intent.js','src/lib/sources/query-port.js']) vm.runInContext(fs.readFileSync(file,'utf8'),context);
  for(const to of ['hitomi','pixiv','pawchive','nhentai']) {
    const args=['作者:test 原作:sample -female:tag 123456','hitomi',to];
    assert.equal(JSON.stringify(context.window.BunkoQueryPort.portQuery(...args)),JSON.stringify(portQuery(...args)));
  }
});

test('authenticated media proxy preserves PDF byte ranges without exposing upstream CORS',async t=>{
  const f=await fixture(t);let request;
  const media=http.createServer((req,res)=>{
    request={url:req.url,range:req.headers.range};
    res.writeHead(206,{'Content-Type':'application/pdf','Content-Range':'bytes 0-3/8','Content-Length':'4','Accept-Ranges':'bytes','Access-Control-Allow-Origin':'*'});
    res.end('test');
  });
  await new Promise(r=>media.listen(0,'127.0.0.1',r));
  t.after(()=>{media.closeAllConnections();media.close();});
  f.desktop.getImageBase=async()=>`http://127.0.0.1:${media.address().port}`;
  const response=await fetch(f.base+'/media/pwfile/SAMPLE',{headers:{...f.headers,Range:'bytes=0-3'}});
  assert.equal(response.status,206);assert.equal(await response.text(),'test');
  assert.deepEqual(request,{url:'/pwfile/SAMPLE',range:'bytes=0-3'});
  assert.equal(response.headers.get('content-range'),'bytes 0-3/8');
  assert.equal(response.headers.get('access-control-allow-origin'),null);
});

test('read-only handler replacement changes both Electron and LAN registrations',async()=>{
  const electron=new Map();
  const desktop=new LanDesktop({getImageBase:async()=>'',portQuery});
  const ipc=desktop.registry({handle:(c,h)=>electron.set(c,h),removeHandler:c=>electron.delete(c)});
  ipc.handle('download',async()=>true);
  ipc.removeHandler('download');ipc.handle('download',async()=>{throw new Error('read only');});
  await assert.rejects(desktop.invoke('download',[],'phone'),/read only/);
  await assert.rejects(electron.get('download')(),/read only/);
});


test('phone obtains only the requested confirmed author context through the shared handler',async t=>{
  const f=await fixture(t);
  f.ipc.handle('search-author-context',async(_,p)=>require('../src/lib/search-author-context').searchAuthorContext(p.query,p.from,{pixiv:{77:{folderId:'private-folder',name:'Synthetic'}},pawchive:{'fanbox:88':'private-folder'}}));
  const r=await f.call('search-author-context',[{query:'user:77 word',from:'pixiv'}]);
  assert.equal(r.status,200);const value=(await r.json()).value;
  assert.equal(value.links['pixiv:user:77'].pawchive,'fanbox/88');
  assert.doesNotMatch(JSON.stringify(value),/private-folder/);
});
