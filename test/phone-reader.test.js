'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness(gallery) {
  const calls = [], marks = {}, frames = [];
  let resolveLoad;
  const legacy = { shelf: { openDetail: (...args) => calls.push(['detail', ...args]), closeDetail() {} }, reader: { open: (...args) => calls.push(['open', ...args]), close() {} } };
  const context = { window: { hitomi: {
    gallery: async () => gallery,
    readingGet: async id => marks[id] || null,
    readingSet: async (id, mark) => { marks[id] = mark; },
  } }, document: {
    activeElement: { focus() {} }, documentElement: { style: {} },
    createElement: () => ({ contentWindow: { BUNKO: legacy }, focus() {} }),
    body: { appendChild(frame) { frames.push(frame); resolveLoad = () => frame.onload(); } },
  }, fetch: async url => { calls.push(['fetch', url]); return { ok: true, json: async () => ({ pageCount: 21, version: 7 }) }; }, toast: message => calls.push(['error', message]), applyQuery: query => calls.push(['query', query]) };
  context.state = { source: 'pixiv', sort: 'recommended' };
  context.els = { sort: {} };
  context.libraryScope = () => false;
  context.activeSorts = () => [];
  context.fillSelect = () => {};
  context.isEagleItem = () => false;
  context.pawCreatorOf = () => null;
  context.searchSelections = new Map();
  vm.createContext(context);
  const app = fs.readFileSync(require.resolve('../src/renderer/app.js'), 'utf8');
  vm.runInContext(app.slice(app.indexOf('function tagQuery('), app.indexOf('function tagButtons(')), context);
  vm.runInContext(fs.readFileSync(require.resolve('../src/lan/phone-reader.js'), 'utf8') + '\nwindow.reader = Reader;', context);
  return { context, calls, marks, frames, load: () => resolveLoad(), phone: context.window.BunkoPhone, reader: context.window.reader };
}

test('phone reader retains legacy details, hides on close and ignores superseded opens', async () => {
  const h = harness({ id: '1' });
  const first = h.phone.detail({ id: '1' });
  const second = h.phone.detail({ id: '2' });
  h.load(); await Promise.all([first, second]);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][1].id, '2');
  assert.equal(h.frames[0].hidden, false);
  h.phone.host.closed();
  assert.equal(h.frames[0].hidden, true);
  assert.equal(h.context.document.documentElement.style.overflow, '');
});

test('owned pixiv uses existing phone PDF pages and shared Eagle reading position', async () => {
  const h = harness({ id: 'px:12', source: 'pixiv', owned: true, eagleId: 'ABC', title: 'book' });
  const data = await h.phone.host.api('/api/book/px%3A12');
  assert.equal(data.id, 'px:12');
  assert.equal(data.pageCount, 21);
  assert.equal(h.calls[0][1], '/api/book/pw_ABC');
  assert.equal(h.phone.host.pageUrl('px:12', 3, 780, 7), '/api/book/pw_ABC/page/3?w=780&v=7');
  await h.phone.host.saveReading('px:12', { page: 3 });
  assert.equal(h.marks['pweagle:ABC'].page, 3);
});

test('unowned works use desktop image proxy and preserve adjacent work navigation', async () => {
  const h = harness({ id: 'nh:9', source: 'nhentai', pageCount: 10 });
  const data = await h.phone.host.api('/api/book/nh%3A9');
  assert.equal(data.pageCount, 10);
  assert.equal(h.calls.length, 0);
  assert.equal(h.phone.host.pageUrl('nh:9', 2), '/media/img?id=nh%3A9&i=2&size=full');
  h.reader.setNeighborProvider(() => ({ id: 'nh:10' }));
  assert.equal(h.phone.host.neighbor('nh:9', 1).id, 'nh:10');
  await h.phone.host.saveReading('nh:9', { page: 2 });
  assert.equal(h.marks['nh:9'].page, 2);
});


test('phone pixiv tags reuse desktop queries and leave recommendations/bookmarks for work search', () => {
  const h = harness({});
  h.context.pixivAuthorNames = new Map();
  const owner = { source: 'pixiv', userId: '1234' };
  for (const sort of ['follow', 'recommended', 'bookmarks', 'today']) {
    h.context.state.sort = sort;
    const query = h.phone.host.tagQuery({ type: 'tag', name: '見本 タグ_名' }, owner);
    assert.equal(query, '見本 タグ_名');
    h.phone.host.filter(query, owner);
    assert.equal(h.context.state.sort, 'added');
    assert.deepEqual(h.calls.at(-1), ['query', '見本 タグ_名']);
  }
  assert.equal(h.phone.host.tagQuery({ type: 'artist', name: '作者の表示名' }, owner), 'user:1234');
  assert.equal(h.phone.host.tagQuery({ type: 'female', name: 'sample tag' }, { source: 'hitomi' }), 'female:sample_tag');
  h.context.libraryScope = () => true;
  h.context.state.sort = 'title';
  h.phone.host.filter('見本', owner);
  assert.equal(h.context.state.sort, 'title', 'owned-library scope keeps its sorting');
});
