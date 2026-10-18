'use strict';

// pawchive の取り込み (src/lib/paw-importer.js)。Eagle は偽物。
// 釘: 作者フォルダの決め方 (手動/当て → 新しく作って結びを記す)、名前はファイル名そのまま、
// 名前で先に探して二つにしない、項目 id を確かめてから実体を消す、job への通知、
// Eagle が居ない時の待ち、再起動で続きから、取り残しの拾い方 (古い物は拾わない)。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

require('./helpers/stub-electron');

const { PawImporter, metaFromPath, annotationOf, stemOf } = require('../src/lib/paw-importer');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paw-importer-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

let seq = 0;
// 出力先の形: <root>/<service>/<作者 [user]>/[YYYYMMDD] [postId] 題【NP】.pdf
function outbox(files, { service = 'fanbox', creator = '偽の作者 [1234]' } = {}) {
  seq += 1;
  const base = path.join(root, `case-${seq}`);
  const dir = path.join(base, service, creator);
  fs.mkdirSync(dir, { recursive: true });
  const made = files.map((name) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, 'x');
    return file;
  });
  return { base, dir, files: made };
}

// 偽の Eagle。addFromPath で受けた物を項目にし、listItems は N 回目から返す
function fakeEagle({ available = true, findAfter = 1, failAdd = false, items = [] } = {}) {
  const calls = [];
  let folderSeq = 0;
  let listCalls = 0;
  return {
    calls,
    items,
    set available(v) { available = v; },
    async isAvailable() { calls.push(['available']); return available; },
    async createFolder(name, parent) { calls.push(['createFolder', name, parent]); folderSeq += 1; return `NEWF${folderSeq}`; },
    async addFromPath(args) {
      calls.push(['addFromPath', args]);
      if (failAdd) throw new Error('Eagle が断った');
      items.push({ id: `ITEM${items.length + 1}`, url: args.website, folders: [args.folderId], name: args.name });
    },
    async listItems({ folders }) {
      listCalls += 1;
      calls.push(['listItems', folders]);
      if (listCalls < findAfter) return [];
      return items.filter((item) => item.folders.includes(folders[0])).reverse();
    },
  };
}

function setup({ eagle, resolve = () => ({ folderId: null }), queueFile = '' } = {}) {
  seq += 1;
  const jobs = [];
  const timers = [];
  const links = [];
  const importer = new PawImporter({
    eagle,
    pawLibrary: { resolveCreatorFolder: resolve, revalidateSoon: () => { jobs.push(['revalidate']); } },
    pawLinks: { setCreator: (service, user, folderId) => links.push([service, user, folderId]) },
    queueFile: queueFile || path.join(root, `queue-${seq}.json`),
    rootFolderId: 'ROOT',
    postUrl: (service, user, postId) => `https://pawchive.pw/${service}/user/${user}/post/${postId}`,
    onJob: (jobId, patch) => jobs.push([jobId, patch]),
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
    sleep: async () => {},
  });
  return { importer, jobs, timers, links };
}

const META = { service: 'fanbox', user: '1234', postId: '5678', creatorName: '偽の作者', date: '2026-01-01', pages: 12 };

test('道から素性を読む。メモは決めた形。名前はファイル名そのまま', () => {
  const { files } = outbox(['[20260101] [5678] 偽の投稿【12P】.pdf']);
  assert.deepEqual(metaFromPath(files[0]), { ...META, date: '20260101' });
  assert.equal(metaFromPath(path.join(root, 'x', 'y', 'nope.pdf')), null, '素性が読めない道は拾わない');
  assert.equal(stemOf(files[0]), '[20260101] [5678] 偽の投稿【12P】');
  assert.equal(annotationOf(META), 'pawchive:fanbox:1234:5678\n作者: 偽の作者 (1234)\n投稿日: 2026-01-01\n頁: 12');
});

test('新しい作者はフォルダを作って結びを記し、名前そのままで入れ、項目 id を確かめてから実体を消す', async () => {
  const eagle = fakeEagle({ findAfter: 2 });
  const { importer, jobs, links } = setup({ eagle });
  const { files } = outbox(['[20260101] [5678] 偽の投稿【12P】.pdf', '[20260101] [5678] 偽の投稿 添付.zip']);
  importer.enqueue({ jobId: 'pw:fanbox:1234:5678', key: 'fanbox:1234:5678', files, meta: META });
  await importer.kick();
  assert.deepEqual(eagle.calls.find((c) => c[0] === 'createFolder'), ['createFolder', '偽の作者', 'ROOT']);
  assert.deepEqual(links, [['fanbox', '1234', 'NEWF1']], '作った時だけ結びを記す');
  const adds = eagle.calls.filter((c) => c[0] === 'addFromPath').map((c) => c[1]);
  assert.equal(adds.length, 2, '本と書庫の両方');
  assert.equal(adds[0].path, files[0]);
  assert.equal(adds[0].name, '[20260101] [5678] 偽の投稿【12P】', '名前はファイル名そのまま (parseName が読む)');
  assert.equal(adds[0].website, 'https://pawchive.pw/fanbox/user/1234/post/5678');
  assert.equal(adds[0].folderId, 'NEWF1');
  assert.match(adds[0].annotation, /^pawchive:fanbox:1234:5678\n/);
  assert.equal(fs.existsSync(files[0]), false, '写しを確かめた実体は消す');
  assert.equal(fs.existsSync(files[1]), false);
  assert.deepEqual(jobs[0], ['pw:fanbox:1234:5678', { status: 'importing' }]);
  const done = jobs.find((j) => j[1] && j[1].status === 'done');
  assert.equal(done[1].eagleItemId, 'ITEM1', '代表 (先頭の本) の項目');
  assert.ok(jobs.some((j) => j[0] === 'revalidate'), '作者棚を引き直す');
  assert.equal(importer.pending().count, 0);
});

test('作者フォルダが決まっていれば作らない。同じ名前が既に居れば入れず、実体だけ片付ける', async () => {
  const eagle = fakeEagle({ items: [{ id: 'OLD1', url: '', folders: ['F-OLD'], name: '[20260101] [5678] 偽の投稿【12P】' }] });
  const { importer, jobs, links } = setup({ eagle, resolve: () => ({ folderId: 'F-OLD', name: '偽の作者', origin: 'manual' }) });
  const { files } = outbox(['[20260101] [5678] 偽の投稿【12P】.pdf']);
  importer.enqueue({ jobId: 'pw:fanbox:1234:5678', key: 'fanbox:1234:5678', files, meta: META });
  await importer.kick();
  assert.equal(eagle.calls.filter((c) => c[0] === 'createFolder').length, 0);
  assert.equal(eagle.calls.filter((c) => c[0] === 'addFromPath').length, 0, '昔 自動インポートで入った物 (url 無し) を二つにしない');
  assert.deepEqual(links, []);
  assert.equal(fs.existsSync(files[0]), false);
  assert.equal(jobs.find((j) => j[1] && j[1].status === 'done')[1].eagleItemId, 'OLD1');
});

test('Eagle が居なければ入れずに待ち、来たら続ける。再起動で待ち行列は戻る', async () => {
  const eagle = fakeEagle({ available: false });
  const queueFile = path.join(root, `queue-restart-${seq}.json`);
  const { importer, timers } = setup({ eagle, queueFile });
  const { files } = outbox(['[20260101] [5678] 偽の投稿【12P】.pdf']);
  importer.enqueue({ jobId: 'pw:fanbox:1234:5678', key: 'fanbox:1234:5678', files, meta: META });
  await importer.kick();
  assert.equal(eagle.calls.filter((c) => c[0] === 'addFromPath').length, 0);
  assert.equal(importer.pending().waitingEagle, 1);
  assert.ok(timers.some((t) => t.ms === 30000), '30 秒後に見に来る');
  assert.equal(fs.existsSync(files[0]), true, '実体は残す');
  // 再起動: 待ち行列は控えから戻る
  const again = setup({ eagle, queueFile });
  assert.equal(again.importer.pending().count, 1);
  eagle.available = true;
  await again.importer.kick();
  assert.equal(eagle.calls.filter((c) => c[0] === 'addFromPath').length, 1);
  assert.equal(again.importer.pending().count, 0);
});

test('断られたら error で止まり実体は残す。再試行で入れ直せる', async () => {
  const eagle = fakeEagle({ failAdd: true });
  const { importer, jobs } = setup({ eagle });
  const { files } = outbox(['[20260101] [5678] 偽の投稿【12P】.pdf']);
  importer.enqueue({ jobId: 'pw:fanbox:1234:5678', key: 'fanbox:1234:5678', files, meta: META });
  await importer.kick();
  const failed = jobs.find((j) => j[1] && j[1].status === 'error');
  assert.match(failed[1].error, /取り込み: Eagle が断った/);
  assert.equal(fs.existsSync(files[0]), true);
  assert.equal(importer.pending().errors, 1);
  assert.equal(importer.retry('nope'), false);
  assert.equal(importer.retry('pw:fanbox:1234:5678'), true);
});

test('取り残しを拾う: 出力先の PDF/zip を投稿ごとに束ね、古い物は拾わない', async () => {
  const eagle = fakeEagle();
  const { importer } = setup({ eagle });
  const { base, files } = outbox([
    '[20260101] [5678] 偽の投稿【12P】.pdf',
    '[20260101] [5678] 偽の投稿 添付.zip',
    '[20260102] [5679] 別の投稿【3P】.pdf',
    'memo.txt',
  ]);
  // 一つは古い (三日前)
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  fs.utimesSync(files[2], old, old);
  const picked = importer.sweep(base);
  assert.deepEqual(picked.map((item) => item.key), ['fanbox:1234:5678']);
  assert.deepEqual(picked[0].files, [files[0], files[1]], '本を代表に、書庫は後ろ');
  assert.equal(picked[0].meta.creatorName, '偽の作者');
  await importer.kick();
  assert.equal(eagle.calls.filter((c) => c[0] === 'addFromPath').length, 2);
  assert.equal(fs.existsSync(files[2]), true, '古い物は触らない');
  assert.equal(fs.existsSync(files[3]), true, 'PDF/zip 以外は触らない');
  // 期限を外せば古い物も拾う
  const more = importer.sweep(base, { maxAgeMs: 0 });
  assert.deepEqual(more.map((item) => item.key), ['fanbox:1234:5679']);
});
