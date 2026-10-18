const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

require('./helpers/stub-electron');

const httpPath = require.resolve('../src/lib/http');
let getHandler;
let postHandler;
require.cache[httpPath] = {
  id: httpPath,
  filename: httpPath,
  loaded: true,
  exports: {
    get: (...args) => getHandler(...args),
    postJson: (...args) => postHandler(...args),
  },
};

function json(value) {
  return { json: () => value, text: () => String(value), headers: {}, buffer: Buffer.alloc(0) };
}

function post(id, extra = {}) {
  return { id: String(id), service: 'fanbox', user: 'u', title: `post-${id}`, ...extra };
}

test('Pawchive は50件APIを24件の論理ページへ欠落なく再配分する', async () => {
  const paw = require('../src/lib/sources/pawchive');
  const offsets = [];
  getHandler = async (url) => {
    if (url.includes('/creators?')) return json([]);
    const offset = Number(new URL(url).searchParams.get('o'));
    offsets.push(offset);
    return json(Array.from({ length: 50 }, (_, i) => post(offset + i + 1)));
  };
  const pages = [];
  for (let page = 0; page < 3; page += 1) {
    pages.push(...(await paw.search({ query: 'fanbox/u', page, pageSize: 24 })).galleries);
  }
  assert.deepEqual(pages.map((item) => item.id), Array.from({ length: 72 }, (_, i) => `pw:fanbox:u:${i + 1}`));
  assert.deepEqual([...new Set(offsets)], [0, 50]);
});

test('Pawchive の一覧要約は詳細キャッシュを満たさず、詳細を上書きしない', async () => {
  const paw = require('../src/lib/sources/pawchive');
  let detailCalls = 0;
  getHandler = async (url) => {
    if (url.includes('/creators?')) return json([]);
    if (url.includes('/post/')) {
      detailCalls += 1;
      return json(post(901, { user: 'detail-u', attachments: [{ path: '/a.jpg', name: 'a.jpg' }] }));
    }
    return json([post(901, { user: 'detail-u' })]);
  };
  await paw.search({ query: 'fanbox/detail-u', page: 0, pageSize: 24 });
  assert.equal((await paw.getGallery('fanbox:detail-u:901')).pageCount, 1);
  await paw.search({ query: 'fanbox/detail-u', page: 0, pageSize: 24 });
  assert.equal((await paw.getGallery('fanbox:detail-u:901')).pageCount, 1);
  assert.equal(detailCalls, 1);
});

test('Pawchive は同じremote pageと詳細の同時取得を一本にまとめる', async () => {
  const paw = require('../src/lib/sources/pawchive');
  let pageCalls = 0;
  let detailCalls = 0;
  getHandler = async (url) => {
    if (url.includes('/creators?')) return json([]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (url.includes('/post/')) {
      detailCalls += 1;
      return json(post(777, { user: 'parallel' }));
    }
    pageCalls += 1;
    return json(Array.from({ length: 50 }, (_, i) => post(i + 1, { user: 'parallel' })));
  };
  await Promise.all([
    paw.search({ query: 'fanbox/parallel', page: 0, pageSize: 24 }),
    paw.search({ query: 'fanbox/parallel', page: 1, pageSize: 24 }),
  ]);
  await Promise.all([paw.getGallery('fanbox:parallel:777'), paw.getGallery('fanbox:parallel:777')]);
  assert.equal(pageCalls, 1);
  assert.equal(detailCalls, 1);
});

test('Pawchive page flightは全購読者cancel後に交換し、古い完了で新flightを消さない', async () => {
  const paw = require('../src/lib/sources/pawchive');
  const gates = [];
  let pageCalls = 0;
  getHandler = async (url) => {
    if (url.includes('/creators?')) return json([]);
    pageCalls += 1;
    return new Promise((resolve) => gates.push(resolve));
  };
  const controller = new AbortController();
  const old = paw.search({ query: 'unique-abort-flight', page: 0, pageSize: 24, signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error('old cancelled'));
  await assert.rejects(old, /old cancelled/);

  const fresh = paw.search({ query: 'unique-abort-flight', page: 0, pageSize: 24 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pageCalls, 2);
  gates[0](json(Array.from({ length: 50 }, (_, i) => post(`old-${i}`))));
  await new Promise((resolve) => setImmediate(resolve));
  const joined = paw.search({ query: 'unique-abort-flight', page: 0, pageSize: 24 });
  assert.equal(pageCalls, 2);
  gates[1](json(Array.from({ length: 50 }, (_, i) => post(`new-${i}`))));
  const [a, b] = await Promise.all([fresh, joined]);
  assert.match(a.galleries[0].id, /new-0$/);
  assert.deepEqual(b.galleries.map((row) => row.id), a.galleries.map((row) => row.id));
});

test('nhentai は25件APIから24件ページを作り、同一詳細取得を共有する', async () => {
  const nh = require('../src/lib/sources/nhentai');
  let detailCalls = 0;
  getHandler = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.includes('/galleries/')) {
      detailCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return json({ id: 999, title: { english: 'detail' }, pages: [] });
    }
    const remotePage = Number(parsed.searchParams.get('page'));
    const start = (remotePage - 1) * 25 + 1;
    return json({ total: 60, per_page: 25, result: Array.from({ length: Math.min(25, 61 - start) }, (_, i) => ({ id: start + i })) });
  };
  const first = await nh.search({ query: 'x', page: 0, pageSize: 24 });
  const second = await nh.search({ query: 'x', page: 1, pageSize: 24 });
  assert.deepEqual([...first.galleries, ...second.galleries].map((item) => item.id), Array.from({ length: 48 }, (_, i) => `nh:${i + 1}`));
  await Promise.all([nh.getGallery('999'), nh.getGallery('999')]);
  assert.equal(detailCalls, 1);
});

test('E-Hentai はmetadata順を保ち、継続URLと可変サムネイル数で必要ページだけ読む', async () => {
  const eh = require('../src/lib/sources/ehentai');
  const galleryPages = [];
  const searchHtml = (start, next) => `${Array.from({ length: 25 }, (_, i) => `<a href="https://e-hentai.org/g/${start + i}/abcde/">x</a>`).join('')}${next ? `<a href="/?next=${next}">next</a>` : ''}`;
  getHandler = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.startsWith('/g/')) {
      const p = Number(parsed.searchParams.get('p') || 0);
      galleryPages.push(p);
      const start = p * 20 + 1;
      return json(Array.from({ length: 20 }, (_, i) => `<a href="/s/a${(start + i).toString(16)}/77-${start + i}">p</a>`).join(''));
    }
    return json(parsed.searchParams.has('next') ? searchHtml(26, null) : searchHtml(1, 25));
  };
  postHandler = async (_url, body) => json({ gmetadata: [...body.gidlist].reverse().map(([gid, token]) => ({ gid, token, title: String(gid), filecount: 1 })) });
  const first = await eh.search({ query: 'x', page: 0, pageSize: 24 });
  const second = await eh.search({ query: 'x', page: 1, pageSize: 24 });
  assert.deepEqual([...first.galleries, ...second.galleries].map((item) => item.id), Array.from({ length: 48 }, (_, i) => `eh:${i + 1}:abcde`));
  await eh.fetchImage('77:abcde', 45).catch((error) => assert.match(error.message, /image url missing/));
  assert.deepEqual(galleryPages, [0, 2]);
});

test('remote pager は境界分が揃えば不要な次ページを取得しない', async () => {
  const { createRemotePager } = require('../src/lib/sources/remote-pages');
  let calls = 0;
  const load = createRemotePager(async (page) => {
    calls += 1;
    if (page > 0) throw new Error('不要な取得');
    return { rows: Array.from({ length: 24 }, (_, i) => i), hasNext: true };
  });
  assert.equal((await load('boundary', 0, 24)).rows.length, 24);
  assert.equal(calls, 1);
});

test('remote pager はabort済みflightを交換し、古い完了で新flightを消さない', async () => {
  const { createRemotePager } = require('../src/lib/sources/remote-pages');
  const gates = [];
  let calls = 0;
  const load = createRemotePager((_page, _key, { signal }) => new Promise((resolve) => {
    calls += 1;
    gates.push({ signal, resolve });
  }));
  const controller = new AbortController();
  const old = load('replace', 0, 2, { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error('old cancelled'));
  await assert.rejects(old, /old cancelled/);

  const fresh = load('replace', 0, 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  gates[0].resolve({ rows: ['old-a', 'old-b'], hasNext: false });
  await new Promise((resolve) => setImmediate(resolve));
  const joined = load('replace', 0, 2);
  assert.equal(calls, 2);
  gates[1].resolve({ rows: ['new-a', 'new-b'], hasNext: false });
  assert.deepEqual((await fresh).rows, ['new-a', 'new-b']);
  assert.deepEqual((await joined).rows, ['new-a', 'new-b']);
});

test('E-Hentai metadata失敗は未処理rejectを残さず次回再試行できる', () => {
  const ehPath = require.resolve('../src/lib/sources/ehentai');
  const script = `
    const httpPath = require.resolve(${JSON.stringify(httpPath)});
    let calls = 0;
    require.cache[httpPath] = { id: httpPath, filename: httpPath, loaded: true, exports: {
      get: async () => { throw new Error('unused'); },
      postJson: async () => { calls += 1; if (calls === 1) throw new Error('temporary'); return { json: () => ({ gmetadata: [{ gid: 1, token: 'abcde', title: 'ok' }] }) }; }
    }};
    const eh = require(${JSON.stringify(ehPath)});
    let unhandled = 0;
    process.on('unhandledRejection', () => { unhandled += 1; });
    (async () => {
      try { await eh.getGallery('1:abcde'); } catch {}
      await new Promise((resolve) => setImmediate(resolve));
      const row = await eh.getGallery('1:abcde');
      await new Promise((resolve) => setImmediate(resolve));
      console.log(JSON.stringify({ calls, unhandled, id: row.id }));
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', cwd: path.dirname(ehPath) });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout.trim()), { calls: 2, unhandled: 0, id: 'eh:1:abcde' });
});

test('Pawchive人気投稿は公開ランキング順を保って50件単位からページングする', async()=>{
  const paw=require('../src/lib/sources/pawchive');const offsets=[];
  getHandler=async url=>{
    if(url.includes('/creators?'))return json([]);
    const u=new URL(url);assert.equal(u.pathname,'/posts/popular');assert.equal(u.searchParams.get('period'),'week');
    const offset=Number(u.searchParams.get('o'));offsets.push(offset);
    const count=offset===0?50:7;
    return {text:()=>'<div class="paginator"></div>'+Array.from({length:count},(_,i)=>`<article class="post-card" data-id="${offset+i+1}" data-service="fanbox" data-user="popular-u"><header>Title &amp; ${offset+i+1}</header><img src="https://img.pawchive.pw/thumbnail/data/a.jpg"><time datetime="2026-09-20"></time></article>`).join('')+(offset===0?'<a class="next" href="?o=50">Next</a>':'')};
  };
  const pages=[];for(let page=0;page<3;page++)pages.push(await paw.search({sort:'popular-week',page,pageSize:24}));
  assert.deepEqual(pages.flatMap(p=>p.galleries.map(g=>g.id)),Array.from({length:57},(_,i)=>`pw:fanbox:popular-u:${i+1}`));
  assert.equal(pages[0].galleries[0].title,'Title & 1');assert.equal(pages[2].hasNext,false);assert.deepEqual(offsets,[0,50]);
});


test('Pawchive author candidates preserve trailing keywords for creator-post filtering', async () => {
  const modulePath=require.resolve('../src/lib/sources/pawchive');delete require.cache[modulePath];
  const paw=require(modulePath);
  getHandler=async url=>{
    if(url.includes('/creators?'))return json([{id:'mix',service:'fanbox',name:'Example Name',favorited:1}]);
    return json([post(90101,{user:'mix',title:'winter scene',content:'day'}),post(90102,{user:'mix',title:'summer scene',content:'night'})]);
  };
  const result=await paw.search({query:'winter artist:"Example Name"',sort:'added'});
  assert.equal(result.galleries.length,1);
  assert.equal(result.galleries[0].query,'fanbox/mix winter');
  const works=await paw.search({query:result.galleries[0].query});
  assert.deepEqual(works.galleries.map(g=>g.id),['pw:fanbox:mix:90101']);
});


test('large creator index parsing and sorting run outside the main thread', async () => {
  const parse=require('../src/lib/creator-list-parser');
  const buffer=Buffer.from(JSON.stringify(Array.from({length:5000},(_,i)=>({id:String(i),name:'synthetic creator name',service:'fanbox',favorited:i}))));
  const rows=await parse({buffer,json(){throw new Error('main-thread parser must not run');}});
  assert.equal(rows.length,5000);assert.equal(rows[0].id,'4999');
});

test('Pawchive matches separator variants as candidates and combines author tags with words',async()=>{
  const modulePath=require.resolve('../src/lib/sources/pawchive');delete require.cache[modulePath];const paw=require(modulePath);
  getHandler=async url=>url.includes('/creators?')?json([{id:'joined',service:'fanbox',name:'ExampleName',favorited:2}]):json([
    post(90201,{user:'joined',title:'winter scene',tags:['blue sky']}),post(90202,{user:'joined',title:'winter scene',tags:['night']}),post(90203,{user:'joined',title:'summer scene',tags:['blue sky']})]);
  const result=await paw.search({query:'artist:example_name tag:blue_sky winter'});assert.equal(result.galleries.length,1);
  const works=await paw.search({query:result.galleries[0].query});assert.deepEqual(works.galleries.map(g=>g.id),['pw:fanbox:joined:90201']);
  assert.equal(paw.rewritesAliases,false);
  await assert.rejects(paw.search({query:'tag:blue_sky',sort:'added'}),/作者/);
});

test('Pawchive はどの口にも素性の分かる UA を添え (ブラウザを名乗らない)、原寸の絵は順番待ちを含めて長めに待つ', async () => {
  const modulePath = require.resolve('../src/lib/sources/pawchive');
  delete require.cache[modulePath];
  const paw = require(modulePath);
  const seen = [];
  getHandler = async (url, headers = {}, options = {}) => {
    seen.push({ url, ua: headers['User-Agent'], timeout: options.timeout });
    if (url.includes('/creators?')) return json([]);
    if (url.includes('/post/')) return json(post(95001, { user: 'ua', file: { name: 'a.jpg', path: '/aa/bb/hash.jpg' }, attachments: [] }));
    return { json: () => ({}), text: () => '', headers: { 'content-type': 'image/jpeg' }, buffer: Buffer.from([1, 2, 3]) };
  };
  const image = await paw.fetchImage('fanbox:ua:95001', 0, { size: 'full' });
  assert.equal(image.type, 'image/jpeg');
  const file = seen.find((row) => row.url.startsWith('https://file.pawchive.pw/'));
  assert.ok(file, '原寸はファイル置き場から');
  assert.equal(file.timeout, 60000, '1 秒に 1 本の作法で並ぶぶん、既定の 20 秒より長く待つ');
  await paw.fetchImage('fanbox:ua:95001', 0, { size: 'big' });
  const thumb = seen.find((row) => row.url.startsWith('https://img.pawchive.pw/'));
  assert.ok(thumb, '縮小は縮小絵の置き場から');
  assert.equal(thumb.timeout, undefined, '縮小絵は既定の期限のまま');
  assert.ok(seen.length >= 3);
  for (const row of seen) {
    assert.match(String(row.ua), /^BUNKO(\/[\d.]+)? \(personal library reader\)$/);
    assert.doesNotMatch(String(row.ua), /Mozilla|Chrome|Safari/, 'ブラウザを名乗らない (名乗ると置き場が 403 で断る)');
  }
});

test('Pawchive の作者の札の扇: 一覧の行の表紙から i 本目の絵のある投稿の縮小絵を引き、一覧は一本・投稿の本体は取らない', async () => {
  const modulePath = require.resolve('../src/lib/sources/pawchive');
  delete require.cache[modulePath];
  const paw = require(modulePath);
  const seen = [];
  getHandler = async (url) => {
    seen.push(url);
    if (url.includes('/posts?')) {
      return json([
        post(96001, { user: 'fan', file: { name: 'n.txt', path: '/00/text.txt' }, attachments: [] }),
        post(96002, { user: 'fan', file: { name: 'a.jpg', path: '/aa/one.jpg' }, attachments: [] }),
        post(96003, { user: 'fan', file: { name: 'b.jpg', path: '/bb/two.jpg' }, attachments: [] }),
      ]);
    }
    return { json: () => ({}), text: () => '', headers: { 'content-type': 'image/jpeg' }, buffer: Buffer.from([1]) };
  };
  await paw.fetchImage('fanbox:fan:profile', 0, { size: 'big' });
  await paw.fetchImage('fanbox:fan:profile', 1, { size: 'big' });
  const thumbs = seen.filter((url) => url.startsWith('https://img.pawchive.pw/'));
  assert.deepEqual(thumbs.map((url) => url.slice(url.lastIndexOf('/') + 1)), ['one.jpg', 'two.jpg'], '絵の無い投稿は飛ばす');
  assert.equal(seen.filter((url) => url.includes('/posts?')).length, 1, '一覧は控えから (三枚で一本)');
  assert.equal(seen.filter((url) => url.includes('/post/')).length, 0, '投稿の本体は取りに行かない');
  await assert.rejects(paw.fetchImage('fanbox:fan:profile', 2, { size: 'big' }), (error) => error.status === 404);
});
