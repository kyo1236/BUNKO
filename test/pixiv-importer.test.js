'use strict';

// pixiv の取り込み (src/lib/pixiv/importer.js)。Eagle は偽物。
// 釘: 作者フォルダの決め方 (台帳 → 名前の一致は問う → 新しく作る)、addFromPath の中身、
// 項目 id の確かめ、台帳への記帳と一時置き場の掃除、job への通知、Eagle が居ない時の待ち、
// 失敗時に実体を残すこと、再起動で続きから。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

require('./helpers/stub-electron');

const { PixivImporter, safeName, annotationOf, pickFile } = require('../src/lib/pixiv/importer');
const { PixivLibrary } = require('../src/lib/pixiv/library');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pixiv-importer-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

let seq = 0;
function staging(pid, files) {
  seq += 1;
  const dir = path.join(root, `case-${seq}`, `px-${pid}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), bytes);
  return dir;
}

// 偽の Eagle。addFromPath で受けた物を「項目」にし、listItems は N 回目から返す
function fakeEagle({ available = true, findAfter = 1, failAdd = false } = {}) {
  const calls = [];
  let folderSeq = 0;
  const items = [];
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

function setup({ eagle, creators = [], library = null } = {}) {
  seq += 1;
  const lib = library || new PixivLibrary({ file: path.join(root, `lib-${seq}.json`) });
  const jobs = [];
  const timers = [];
  const importer = new PixivImporter({
    library: lib,
    eagle,
    pawLibrary: { creatorFolders: () => creators, revalidateSoon: () => { jobs.push(['revalidate']); } },
    queueFile: path.join(root, `queue-${seq}.json`),
    rootFolderId: 'ROOT',
    onJob: (jobId, patch) => jobs.push([jobId, patch]),
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
    sleep: async () => {},
  });
  return { importer, lib, jobs, timers };
}

const meta = (over = {}) => ({
  title: '題名', userId: '9', userName: '作者', url: 'https://www.pixiv.net/artworks/100',
  date: '2026-09-18T20:00:00+09:00', pages: 3, tags: ['a'], ai: false, r18: false, series: { id: '5', title: 'S', order: 2 }, ...over,
});

test('名前は道に使える字に、メモは決めた形に、据える実体は PDF か絵一枚', () => {
  assert.equal(safeName('a/b:c*d?e"f<g>h|i', 'x'), 'a_b_c_d_e_f_g_h_i');
  assert.equal(safeName('   ', 'fallback'), 'fallback');
  assert.equal(safeName('あ'.repeat(200), 'x').length, 120);
  assert.equal(annotationOf({ pid: '100', userName: '作者', userId: '9', date: '2026-09-18T20:00:00+09:00', pages: 3, series: { title: 'S', order: 2 } }),
    'pixiv:100\n作者: 作者 (9)\n投稿日: 2026-09-18\n頁: 3\nシリーズ: S #2');
  assert.equal(annotationOf({ pid: '1' }), 'pixiv:1');
  const dir = staging('1', { 'info.json': '{}', '0001.png': 'x', '0001_thumbnail.png': 'y' });
  assert.equal(pickFile(dir), path.join(dir, '0001.png'));
  const pdfDir = staging('2', { 'info.json': '{}', '題.pdf': 'p' });
  assert.equal(pickFile(pdfDir), path.join(pdfDir, '題.pdf'));
  assert.equal(pickFile(path.join(root, 'nope')), null);
});

test('新しい作者はフォルダを作って入れ、項目 id を確かめて台帳に書き、一時置き場を消す', async () => {
  const eagle = fakeEagle({ findAfter: 2 });
  const { importer, lib, jobs } = setup({ eagle });
  const dir = staging('100', { 'info.json': '{}', '0001.png': 'x' });
  importer.enqueue({ jobId: 'px:100', pid: '100', file: dir, meta: meta() });
  await importer.kick();
  const created = eagle.calls.find((c) => c[0] === 'createFolder');
  assert.deepEqual(created, ['createFolder', '作者', 'ROOT']);
  const added = eagle.calls.find((c) => c[0] === 'addFromPath')[1];
  assert.equal(added.path, path.join(dir, '0001.png'));
  assert.equal(added.name, '題名');
  assert.equal(added.website, 'https://www.pixiv.net/artworks/100');
  assert.equal(added.folderId, 'NEWF1');
  assert.match(added.annotation, /^pixiv:100\n作者: 作者 \(9\)/);
  assert.ok(eagle.calls.filter((c) => c[0] === 'listItems').length >= 2, '見つかるまで引き直す (一瞥 → 入れる → 探す)');
  assert.equal(lib.eagleIdOf('100'), 'ITEM1');
  assert.deepEqual(lib.creatorFolder('9'), { folderId: 'NEWF1', name: '作者' });
  assert.equal(fs.existsSync(dir), false, '一時置き場は消える');
  assert.deepEqual(jobs[0], ['px:100', { status: 'importing' }]);
  const done = jobs.find((j) => j[1] && j[1].status === 'done');
  assert.equal(done[1].eagleItemId, 'ITEM1');
  assert.ok(jobs.some((j) => j[0] === 'revalidate'), '作者棚を引き直す');
  assert.equal(importer.pending().count, 0);
});

test('作者フォルダの名前が一つ当たれば問うて止まり、答えで続く。二度目は台帳が知っている', async () => {
  const eagle = fakeEagle();
  const { importer, lib, jobs } = setup({ eagle, creators: [{ folderId: 'F-OLD', name: '作 者' }] });
  const dir = staging('101', { '0001.png': 'x' });
  importer.enqueue({ jobId: 'px:101', pid: '101', file: dir, meta: meta({ url: 'https://www.pixiv.net/artworks/101' }) });
  await importer.kick();
  assert.equal(eagle.calls.filter((c) => c[0] === 'addFromPath').length, 0, '答えるまで入れない');
  const ask = jobs.find((j) => j[1] && j[1].status === 'asking');
  assert.deepEqual(ask[1].ask, { userId: '9', userName: '作者', folderId: 'F-OLD', folderName: '作 者' });
  assert.deepEqual(importer.pending().asking.map((a) => a.pid), ['101']);
  // 同じ人 → そのフォルダへ
  importer.answer('9', 'F-OLD', '作 者');
  await importer.kick();
  const added = eagle.calls.find((c) => c[0] === 'addFromPath')[1];
  assert.equal(added.folderId, 'F-OLD');
  assert.equal(eagle.calls.filter((c) => c[0] === 'createFolder').length, 0);
  assert.equal(lib.creatorFolder('9').folderId, 'F-OLD');
  // 二冊目は問わない
  const dir2 = staging('102', { '0001.png': 'x' });
  importer.enqueue({ jobId: 'px:102', pid: '102', file: dir2, meta: meta({ url: 'https://www.pixiv.net/artworks/102' }) });
  await importer.kick();
  assert.equal(jobs.filter((j) => j[1] && j[1].status === 'asking').length, 1);
  assert.equal(lib.eagleIdOf('102'), 'ITEM2');
});

test('「別の人」と答えたら新しいフォルダを作る', async () => {
  const eagle = fakeEagle();
  const { importer, lib } = setup({ eagle, creators: [{ folderId: 'F-OLD', name: '作者' }] });
  const dir = staging('103', { '0001.png': 'x' });
  importer.enqueue({ jobId: 'px:103', pid: '103', file: dir, meta: meta({ url: 'https://www.pixiv.net/artworks/103' }) });
  await importer.kick();
  importer.answer('9', null);
  await importer.kick();
  assert.deepEqual(eagle.calls.find((c) => c[0] === 'createFolder'), ['createFolder', '作者', 'ROOT']);
  assert.equal(lib.creatorFolder('9').folderId, 'NEWF1');
  assert.equal(lib.eagleIdOf('103'), 'ITEM1');
});

test('Eagle が居なければ積んだまま待ち、来たら進む', async () => {
  const eagle = fakeEagle({ available: false });
  const { importer, lib, timers } = setup({ eagle });
  const dir = staging('104', { '0001.png': 'x' });
  importer.enqueue({ jobId: 'px:104', pid: '104', file: dir, meta: meta({ url: 'https://www.pixiv.net/artworks/104' }) });
  await importer.kick();
  assert.equal(lib.has('104'), false);
  assert.equal(importer.pending().waitingEagle, 1);
  assert.equal(timers.length, 1, '30 秒後にもう一度見る');
  assert.equal(timers[0].ms, 30 * 1000);
  eagle.available = true;
  timers[0].fn();
  await importer.kick();
  assert.equal(lib.eagleIdOf('104'), 'ITEM1');
  assert.equal(importer.pending().waitingEagle, 0);
});

test('項目は新しい順 (CREATEDATE) の 50 件で探し、外れたらフォルダ丸ごと。古い順の 20 件では末尾の新入りを見落とす', async () => {
  // Eagle の item/list は 'CREATEDATE' が新しい順、'-CREATEDATE' が古い順 (実測)。194 件のフォルダで
  // 入れたばかりの物が見つからず、入れ直して重複の窓を出した (2026-09-20)
  const eagle = fakeEagle();
  const old = Array.from({ length: 194 }, (_, i) => ({ id: `OLD${i}`, url: `https://example.test/${i}`, folders: ['NEWF1'] }));
  eagle.listItems = async ({ folders, orderBy, limit }) => {
    eagle.calls.push(['listItems', folders, orderBy, limit]);
    const all = [...old, ...eagle.items.filter((item) => item.folders.includes(folders[0]))];
    const ordered = orderBy === 'CREATEDATE' ? [...all].reverse() : all;   // 新しい順は逆さ
    return ordered.slice(0, Number(limit) || 20);
  };
  const { importer, lib } = setup({ eagle });
  const dir = staging('107', { '0001.png': 'x' });
  importer.enqueue({ jobId: 'px:107', pid: '107', file: dir, meta: meta({ url: 'https://www.pixiv.net/artworks/107' }) });
  await importer.kick();
  assert.equal(lib.eagleIdOf('107'), 'ITEM1', '新しい順の 50 件で見つかる');
  assert.equal(eagle.calls.filter((c) => c[0] === 'addFromPath').length, 1);
  const lists = eagle.calls.filter((c) => c[0] === 'listItems');
  assert.ok(lists.every((c) => c[2] !== '-CREATEDATE'), '古い順では引かない');
  assert.ok(lists.some((c) => c[2] === 'CREATEDATE' && c[3] === 50), '新しい順の 50 件');
});

test('一度入れた物は自動では入れ直さない (Eagle に重複の窓を出さない)。再試行を押した時だけ', async () => {
  const eagle = fakeEagle({ findAfter: 1000 });
  const { importer, jobs } = setup({ eagle });
  const dir = staging('108', { '0001.png': 'x' });
  importer.enqueue({ jobId: 'px:108', pid: '108', file: dir, meta: meta({ url: 'https://www.pixiv.net/artworks/108' }) });
  await importer.kick();                       // 一巡目: 入れる → 見つからず → 置く
  const item = importer.queue.find((row) => row.pid === '108');
  assert.equal(item.added, true);
  item.notBefore = 0;
  await importer.kick();                       // 二巡目
  item.notBefore = 0;
  await importer.kick();                       // 三巡目 → 誤り
  assert.equal(eagle.calls.filter((c) => c[0] === 'addFromPath').length, 1, '巡を重ねても入れ直さない');
  assert.ok(jobs.some((j) => j[1] && j[1].status === 'error'), '三巡で誤りにする');
  assert.equal(importer.retry('px:108'), true);
  assert.equal(item.added, false, '再試行は入れ直しを許す');
});

test('Eagle の写しが遅い: 一巡で見つからなければ置いて待ち、次の巡は入れ直さずに url で見つける', async () => {
  // 大きい PDF は addFromPath の後、項目が出るまで分単位かかることがある (107 MB で 24 秒では足りなかった)
  let clock = 1000;
  const eagle = fakeEagle({ findAfter: 1000 });   // 一巡目 (一瞥 1 + 60 回) では出ない
  seq += 1;
  const lib = new PixivLibrary({ file: path.join(root, `lib-slow-${seq}.json`) });
  const jobs = [];
  const timers = [];
  const importer = new PixivImporter({
    library: lib,
    eagle,
    pawLibrary: { creatorFolders: () => [] },
    queueFile: path.join(root, `queue-slow-${seq}.json`),
    rootFolderId: 'ROOT',
    onJob: (jobId, patch) => jobs.push([jobId, patch]),
    now: () => clock,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
    sleep: async () => {},
  });
  const dir = staging('106', { '0001.png': 'x' });
  importer.enqueue({ jobId: 'px:106', pid: '106', file: dir, meta: meta({ url: 'https://www.pixiv.net/artworks/106' }) });
  await importer.kick();
  assert.equal(eagle.calls.filter((c) => c[0] === 'addFromPath').length, 1, '一度だけ入れる');
  assert.equal(importer.pending().errors, 0, 'まだ誤りにしない');
  assert.ok(!jobs.some((j) => j[1] && j[1].status === 'error'));
  const waits = timers.filter((t) => t.ms >= 1000);
  assert.ok(waits.length >= 1, '置いて待つ時限が張られる');
  assert.equal(fs.existsSync(path.join(dir, '0001.png')), true, '実体は残す');
  // 時が進み、Eagle に項目が出た。次の巡は一瞥で見つけ、入れ直さない
  clock += 61 * 1000;
  eagle.calls.length = 0;
  const found = eagle.items[0];
  eagle.listItems = async ({ folders }) => { eagle.calls.push(['listItems', folders]); return [found]; };
  await importer.kick();
  assert.equal(eagle.calls.filter((c) => c[0] === 'addFromPath').length, 0, '二つにしない');
  assert.equal(lib.eagleIdOf('106'), 'ITEM1');
  assert.equal(importer.pending().count, 0);
  assert.equal(fs.existsSync(dir), false, '一時置き場は消える');
});

test('Eagle が断ったら job は error になり、実体は残る。retry で入れ直せる', async () => {
  const eagle = fakeEagle({ failAdd: true });
  const { importer, lib, jobs } = setup({ eagle });
  const dir = staging('105', { '0001.png': 'x' });
  importer.enqueue({ jobId: 'px:105', pid: '105', file: dir, meta: meta({ url: 'https://www.pixiv.net/artworks/105' }) });
  await importer.kick();
  const failed = jobs.find((j) => j[1] && j[1].status === 'error');
  assert.match(failed[1].error, /Eagle が断った/);
  assert.equal(fs.existsSync(path.join(dir, '0001.png')), true, '実体は残す');
  assert.equal(lib.has('105'), false);
  assert.equal(importer.pending().errors, 1);
  eagle.failAdd = false;
  // 偽物の failAdd は閉じ込めた値なので、新しい eagle で入れ直す形を試す
  const eagle2 = fakeEagle();
  importer.eagle = eagle2;
  assert.equal(importer.retry('px:105'), true);
  await importer.kick();
  assert.equal(lib.eagleIdOf('105'), 'ITEM1');
});

test('待ち行列は控えに残り、再起動で続きから', async () => {
  const eagle = fakeEagle({ available: false });
  const first = setup({ eagle });
  const dir = staging('106', { '0001.png': 'x' });
  first.importer.enqueue({ jobId: 'px:106', pid: '106', file: dir, meta: meta({ url: 'https://www.pixiv.net/artworks/106' }) });
  await first.importer.kick();
  // 同じ待ち行列のファイルで組み直す
  const eagle2 = fakeEagle();
  const second = new PixivImporter({
    library: first.lib, eagle: eagle2, pawLibrary: { creatorFolders: () => [] },
    queueFile: first.importer.queueFile, rootFolderId: 'ROOT', onJob: () => {},
    setTimer: () => ({ unref() {} }), sleep: async () => {},
  });
  assert.equal(second.pending().count, 1);
  await second.kick();
  assert.equal(first.lib.eagleIdOf('106'), 'ITEM1');
  assert.equal(second.pending().count, 0);
});

test('同じ投稿を二度積んでも一つ', () => {
  const eagle = fakeEagle({ available: false });
  const { importer } = setup({ eagle });
  const dir = staging('107', { '0001.png': 'x' });
  importer.enqueue({ jobId: 'px:107', pid: '107', file: dir, meta: meta() });
  importer.enqueue({ jobId: 'px:107', pid: '107', file: dir, meta: meta() });
  assert.equal(importer.pending().count, 1);
});
