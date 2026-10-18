'use strict';

// 一括更新 (paw-bulk) の取得を kemono-dl の子プロセスへ移した後の契約を固定する。
// 通信も実ランタイム (third_party/python) も使わない:
//   - エンジンは偽エンジン (test/fixtures/fake-kemono.js) を差した KemonoEngine
//   - API は偽アダプタ (listPosts / fetchPost / postFiles) を constructor から注入
//   - pdf-builder は electron のウィンドウで刷るので require.cache で差し替える
// 見るのは「エンジンに何を頼んだか」と「落ちてきた実体をどう組んだか」の二点。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FAKE_ENGINE = path.join(__dirname, 'fixtures', 'fake-kemono.js');

// paw-bulk を読み込む前に差し替える (向こうは読み込み時に buildPdf を掴む)。
// 綴じた頁の控えを残して、中身は「何頁綴じたか」だけの目印にする
const PDF_BUILDER = require.resolve('../src/lib/pdf-builder');
const builtPdfs = [];
// 「次の N 回は刷り損ねる」を仕込む口。組み直しの途中で転んだ投稿を、
// 次の回にもう一度通したときの振る舞い (冪等かどうか) を見るために要る
let pdfFailures = 0;
require.cache[PDF_BUILDER] = {
  id: PDF_BUILDER,
  filename: PDF_BUILDER,
  loaded: true,
  exports: {
    buildPdf: async ({ pages, dest }) => {
      if (pdfFailures > 0) {
        pdfFailures -= 1;
        throw new Error('刷り損ねました');
      }
      builtPdfs.push({ dest, pages: pages.map((page) => path.basename(page.file)) });
      fs.writeFileSync(dest, `pdf:${pages.length}`);
    },
  },
};

const { PawBulk } = require('../src/lib/paw-bulk');
const { KemonoEngine } = require('../src/lib/kemono-engine');

const SERVICE = 'fanbox';
const USER = '9';
const CREATOR = 'テスト作者';

// 作った作業場は最後にまとめて畳む (放っておくと %TEMP% に staging と PDF が溜まる)
const roots = [];

test.after(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* 残っても次の走りが別の場所を切る */ }
  }
});

function tempDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bunko-pawbulk-${tag}-`));
  roots.push(dir);
  return dir;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 添付の path に埋まっている 64 桁 hex。これがエンジンの落とす名前になる
function hashOf(ch) {
  return String(ch).repeat(64);
}

// pawchive の添付はこの形: /<2 桁>/<2 桁>/<64 桁 hex>.<拡張子>
function attach(ch, name) {
  const hash = hashOf(ch);
  return { name, path: `/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}${path.extname(name)}` };
}

// 一覧・本体・添付の仕分けだけを返す偽アダプタ。実体を取りに行く口はもう無い
function makeAdapter(posts) {
  return {
    API_PAGE: 50,
    async creatorIndex() {
      return new Map([[`${SERVICE}:${USER}`, CREATOR]]);
    },
    async listPosts(service, user, page) {
      return page === 0 ? posts : [];
    },
    async fetchPost(service, user, id) {
      return posts.find((post) => String(post.id) === String(id));
    },
    postFiles(post) {
      return { cover: post.cover || null, attachments: post.attachments || [] };
    },
  };
}

// 済んだ投稿の台帳。本物 (paw-state) は catalog.sqlite に持つが、
// ここで要るのは hasCompleted / markCompleted / completedCount だけ
function makeState() {
  const done = new Set();
  return {
    done,
    importLegacy() {},
    hasCompleted(key) { return done.has(key); },
    markCompleted(key) { return done.add(key) && true; },
    completedCount() { return done.size; },
  };
}

// 偽エンジンを差した一本と、頼まれた run の控え
function makeEngine(root, planFile, extra = []) {
  const engine = new KemonoEngine().init({
    command: process.execPath,
    baseArgs: [FAKE_ENGINE, '--fake-mode', 'plan', '--fake-plan', planFile, ...extra],
    workDir: path.join(root, 'work'),
  });
  // 同梱物の実在検査 (third_party/python とその依存) はここでは意味を成さない:
  // 走らせるのは node の偽エンジンなので、使える状態として通す
  engine.available = () => true;
  engine.runtimeError = () => '';
  const runs = [];
  const original = engine.run.bind(engine);
  engine.run = (options) => {
    runs.push(options);
    return original(options);
  };
  return { engine, runs };
}

// 一式 (出力先・指図・エンジン・台帳) を組んで PawBulk を返す
function makeBulk({ tag, posts, plan, extra = [] }) {
  const root = tempDir(tag);
  const dir = path.join(root, 'out');
  const planFile = path.join(root, 'plan.json');
  fs.writeFileSync(planFile, JSON.stringify(plan), 'utf8');
  const { engine, runs } = makeEngine(root, planFile, extra);
  const state = makeState();
  const bulk = new PawBulk({
    state,
    settings: { dir, concurrency: 1 },
    listSources: () => [{ service: SERVICE, user: USER }],
    adapter: makeAdapter(posts),
    engine,
    delay: 0,
  });
  return {
    bulk,
    state,
    runs,
    root,
    dir,
    creatorDir: path.join(dir, SERVICE, `${CREATOR} [${USER}]`),
    staging: path.join(dir, '.kemono-staging', `bulk-${SERVICE}-${USER}`),
  };
}

function listNames(dir) {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

async function waitFor(check, limit = 5000) {
  const until = Date.now() + limit;
  while (Date.now() < until) {
    if (check()) return true;
    await sleep(20);
  }
  return false;
}

test('新着 2 件: エンジンは 1 回だけ・PDF は作品名で 2 冊・台帳に 2 件', async () => {
  const posts = [
    {
      id: '111',
      title: '一冊目',
      published: '2026-01-02T03:04:05',
      attachments: [attach('a', '1.jpg'), attach('b', '2.png'), attach('c', 'source.psd')],
    },
    {
      id: '222',
      title: '二冊目',
      published: '2026-02-03T00:00:00',
      attachments: [attach('d', '1.jpg')],
    },
  ];
  const plan = {
    111: { title: '一冊目', files: [{ hash: hashOf('a'), ext: 'jpg' }, { hash: hashOf('b'), ext: 'png' }, { hash: hashOf('c'), ext: 'psd' }] },
    222: { title: '二冊目', files: [{ hash: hashOf('d'), ext: 'jpg' }] },
  };
  const box = makeBulk({ tag: 'two', posts, plan });
  builtPdfs.length = 0;

  const status = await box.bulk.start();

  // 作者ぶんはまとめて 1 回。頼み方 (置き場・名前・種別) もここで固定する
  assert.strictEqual(box.runs.length, 1);
  assert.deepStrictEqual(box.runs[0].links, [
    `https://pawchive.pw/${SERVICE}/user/${USER}/post/111`,
    `https://pawchive.pw/${SERVICE}/user/${USER}/post/222`,
  ]);
  assert.strictEqual(box.runs[0].filenamePattern, '{id}/{hash}.{ext}');
  assert.strictEqual(box.runs[0].outDir, box.staging);
  // zip は設定ではなく常に頼む (中身を見ないと綴じられるかが分からない)
  assert.deepStrictEqual(box.runs[0].onlyFiletypes, [
    'jpg', 'jpeg', 'png', 'webp', 'gif', 'mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v', 'zip',
  ]);

  // 綴じ上がりは作品名 = "[YYYYMMDD] [postId] タイトル【NP】"
  assert.deepStrictEqual(listNames(box.creatorDir), [
    '[20260102] [111] 一冊目【2P】.pdf',
    '[20260203] [222] 二冊目【1P】.pdf',
  ]);
  // psd は --only-filetypes から外れているので綴じ順にも入らない
  assert.deepStrictEqual(builtPdfs.map((pdf) => pdf.pages.length), [2, 1]);

  assert.deepStrictEqual([...box.state.done].sort(), [`${SERVICE}:${USER}:111`, `${SERVICE}:${USER}:222`]);
  assert.strictEqual(status.postsDone, 2);
  assert.strictEqual(status.postsFailed, 0);
  // 全部組み終えたら隠し箱は畳む
  assert.ok(!fs.existsSync(box.staging), 'staging は残さない');
});

test('欠けのある投稿: その 1 件だけ失敗に数え、済にせず staging に残す', async () => {
  const posts = [
    { id: '111', title: '揃った方', published: '2026-01-02T00:00:00', attachments: [attach('a', '1.jpg')] },
    {
      id: '222',
      title: '欠けた方',
      published: '2026-01-03T00:00:00',
      attachments: [attach('b', '1.jpg'), attach('c', '2.jpg')],
    },
  ];
  const plan = {
    111: { title: '揃った方', files: [{ hash: hashOf('a'), ext: 'jpg' }] },
    // 2 枚目は落ちてこない (本物なら 403 や切断)
    222: { title: '欠けた方', files: [{ hash: hashOf('b'), ext: 'jpg' }, { hash: hashOf('c'), ext: 'jpg', fail: true }] },
  };
  const box = makeBulk({ tag: 'partial', posts, plan });

  const status = await box.bulk.start();

  // 揃った方だけが本になる。半端な PDF は出さない
  assert.deepStrictEqual(listNames(box.creatorDir), ['[20260102] [111] 揃った方【1P】.pdf']);
  assert.deepStrictEqual([...box.state.done], [`${SERVICE}:${USER}:111`]);
  assert.strictEqual(status.postsDone, 1);
  assert.strictEqual(status.postsFailed, 1);

  // 落ちきったぶんは次の回の資産として残す (済んだ投稿の箱だけ消える)
  assert.deepStrictEqual(listNames(box.staging), ['222']);
  assert.deepStrictEqual(listNames(path.join(box.staging, '222')), [`${hashOf('b')}.jpg`]);
});

test('動画付きの投稿: 「作品名+元ファイル名」で作者フォルダへ置き直す', async () => {
  const posts = [
    {
      id: '333',
      title: '動く方',
      published: '2026-03-04T00:00:00',
      attachments: [attach('a', '1.jpg'), attach('e', '本編.mp4')],
    },
  ];
  const plan = {
    333: {
      title: '動く方',
      files: [{ hash: hashOf('a'), ext: 'jpg' }, { hash: hashOf('e'), ext: 'mp4', body: 'movie-bytes' }],
    },
  };
  const box = makeBulk({ tag: 'video', posts, plan });

  const status = await box.bulk.start();

  const base = '[20260304] [333] 動く方【1P】';
  assert.deepStrictEqual(listNames(box.creatorDir), [`${base}+本編.mp4`, `${base}.pdf`]);
  // 中身はエンジンが落としたものそのまま (原本は成功時の隠し箱ごと片付く)
  assert.strictEqual(fs.readFileSync(path.join(box.creatorDir, `${base}+本編.mp4`), 'utf8'), 'movie-bytes');
  assert.strictEqual(status.postsDone, 1);
  assert.strictEqual(status.postsFailed, 0);
  assert.ok(!fs.existsSync(box.staging));
});

test('止めても揃った投稿は本にして台帳に載せる (欠けた投稿は数えず残す)', async () => {
  const posts = [
    { id: '444', title: '揃った途中', published: '2026-04-05T00:00:00', attachments: [attach('a', '1.jpg')] },
    {
      id: '555',
      title: '欠けた途中',
      published: '2026-04-06T00:00:00',
      attachments: [attach('b', '1.jpg'), attach('c', '2.jpg')],
    },
  ];
  const plan = {
    444: { title: '揃った途中', files: [{ hash: hashOf('a'), ext: 'jpg' }] },
    555: { title: '欠けた途中', files: [{ hash: hashOf('b'), ext: 'jpg' }, { hash: hashOf('c'), ext: 'jpg', fail: true }] },
  };
  // 落とし終えてから居座る子: 実体がある状態で切られる形を作る
  const box = makeBulk({ tag: 'stop', posts, plan, extra: ['--fake-hold', '30000'] });

  const job = box.bulk.start();
  const landed = await waitFor(() => fs.existsSync(path.join(box.staging, '444', `${hashOf('a')}.jpg`)));
  assert.ok(landed, '偽エンジンが staging に落とすところまでは進む');
  const status = await box.bulk.stop();
  await job;

  assert.strictEqual(box.runs.length, 1);
  assert.strictEqual(typeof box.runs[0].isCancelled, 'function');
  // 組み直しは網に触らない手元の処理: 止めた後でも、落ちきった投稿は本にして
  // 台帳に載せる (ここで降りると次の回が同じ実体をもう一度組み直すことになる)
  assert.deepStrictEqual([...box.state.done], [`${SERVICE}:${USER}:444`]);
  assert.strictEqual(status.postsDone, 1);
  // 止めたぶんの欠けは失敗ではない: 印も付けず、数にも入れない
  assert.strictEqual(status.postsFailed, 0);
  assert.deepStrictEqual(listNames(box.creatorDir), ['[20260405] [444] 揃った途中【1P】.pdf']);
  // 落ちきったぶんは次の回の資産 (組み終えた 444 の箱だけ消える)
  assert.deepStrictEqual(listNames(box.staging), ['555']);
  assert.deepStrictEqual(listNames(path.join(box.staging, '555')), [`${hashOf('b')}.jpg`]);
});

test('表紙は必須ではない: 落ちてこなくても投稿は完了する (落ちれば使う)', async () => {
  const posts = [
    {
      id: '888',
      title: '表紙の来ない書庫',
      published: '2026-08-01T00:00:00',
      cover: attach('a', 'cover.jpg'),
      attachments: [attach('b', 'pack.zip')],
    },
    {
      id: '999',
      title: '表紙だけの投稿',
      published: '2026-08-02T00:00:00',
      cover: attach('c', 'cover.jpg'),
      attachments: [],
    },
  ];
  const mixed = await zipBase64([['1.jpg', 'jpeg-a'], ['readme.txt', 'notes']]);
  const plan = {
    // 表紙 (a) は落ちてこない: エンジンは post.file を必ず落とすとは限らない
    888: { title: '表紙の来ない書庫', files: [{ hash: hashOf('b'), ext: 'zip', bodyBase64: mixed }] },
    999: { title: '表紙だけの投稿', files: [{ hash: hashOf('c'), ext: 'jpg' }] },
  };
  const box = makeBulk({ tag: 'cover', posts, plan });

  const status = await box.bulk.start();

  assert.deepStrictEqual(listNames(box.creatorDir), [
    // 表紙が来なかった投稿は zip の中の絵だけで 1 冊。表紙待ちで足止めしない
    // (txt は綴じずに捨てる: 中に絵が 1 枚でもあれば書庫は残さない)
    '[20260801] [888] 表紙の来ない書庫+pack【1P】.pdf',
    // 表紙が落ちてきた投稿は今までどおり表紙 1 枚を綴じる
    '[20260802] [999] 表紙だけの投稿【1P】.pdf',
  ]);
  assert.deepStrictEqual([...box.state.done].sort(), [`${SERVICE}:${USER}:888`, `${SERVICE}:${USER}:999`]);
  assert.strictEqual(status.postsDone, 2);
  assert.strictEqual(status.postsFailed, 0);
  assert.ok(!fs.existsSync(box.staging));
});

test('組み直しが転んだ投稿を次の回に通しても (2) を生まない', async () => {
  const posts = [
    {
      id: '1010',
      title: '二度通る投稿',
      published: '2026-09-01T00:00:00',
      attachments: [attach('a', '1.jpg'), attach('b', 'pack.zip'), attach('e', '本編.mp4')],
    },
  ];
  const mixed = await zipBase64([['1.jpg', 'jpeg-a'], ['readme.txt', 'notes']]);
  const plan = {
    1010: {
      title: '二度通る投稿',
      files: [
        { hash: hashOf('a'), ext: 'jpg' },
        { hash: hashOf('b'), ext: 'zip', bodyBase64: mixed },
        { hash: hashOf('e'), ext: 'mp4', body: 'movie-bytes' },
      ],
    },
  };
  const box = makeBulk({ tag: 'again', posts, plan });
  // 1 回目は綴じで転ぶ: 書庫だけ置かれた状態で投稿が済まないまま残る
  pdfFailures = 1;

  const first = await box.bulk.start();
  assert.strictEqual(first.postsDone, 0);
  assert.strictEqual(first.postsFailed, 1);
  assert.deepStrictEqual([...box.state.done], []);

  const second = await box.bulk.start();

  const base = '[20260901] [1010] 二度通る投稿【1P】';
  // 二度通っても名前は投稿の中身だけで決まる: (2) は生まれず上書きになる
  assert.deepStrictEqual(listNames(box.creatorDir), [
    `${base}+pack【1P】.pdf`,
    `${base}+本編.mp4`,
    `${base}.pdf`,
  ]);
  assert.strictEqual(fs.readFileSync(path.join(box.creatorDir, `${base}+本編.mp4`), 'utf8'), 'movie-bytes');
  assert.deepStrictEqual([...box.state.done], [`${SERVICE}:${USER}:1010`]);
  assert.strictEqual(second.postsDone, 1);
  assert.ok(!fs.existsSync(box.staging));
});

test('途中で切れた欠片 (416) は取れた扱いにせず、捨てて取り直させる', async () => {
  const posts = [
    {
      id: '1111',
      title: '切れた方',
      published: '2026-10-01T00:00:00',
      attachments: [attach('a', '1.jpg'), attach('b', '2.jpg')],
    },
  ];
  const plan = {
    1111: { title: '切れた方', files: [{ hash: hashOf('a'), ext: 'jpg' }, { hash: hashOf('b'), ext: 'jpg', fail: true }] },
  };
  const box = makeBulk({ tag: 'broken', posts, plan });
  // 前の回が「バイト数が合わない」と言われて残した欠片を置いておく
  const postDir = path.join(box.staging, '1111');
  fs.mkdirSync(postDir, { recursive: true });
  fs.writeFileSync(path.join(postDir, `${hashOf('b')}_statuscode416.jpg`), 'half');

  const status = await box.bulk.start();

  assert.strictEqual(status.postsDone, 0, '欠片を綴じて済にしてはいけない');
  assert.strictEqual(status.postsFailed, 1);
  assert.deepStrictEqual([...box.state.done], []);
  assert.deepStrictEqual(listNames(box.creatorDir), [], '半端な本は出さない');
  // 欠片を残すと次の回も「もう有る」と読んで永久に取り直せない
  assert.deepStrictEqual(listNames(postDir), [`${hashOf('a')}.jpg`]);
});

test('取りこぼしの言い分を画面に残す (欠けを数えるだけで終わらせない)', async () => {
  const posts = [
    {
      id: '1212',
      title: '断られた方',
      published: '2026-11-01T00:00:00',
      attachments: [attach('a', '1.jpg'), attach('b', '2.jpg')],
    },
  ];
  const plan = {
    1212: { title: '断られた方', files: [{ hash: hashOf('a'), ext: 'jpg' }, { hash: hashOf('b'), ext: 'jpg', fail: true }] },
  };
  const box = makeBulk({ tag: 'reason', posts, plan });

  const status = await box.bulk.start();

  assert.strictEqual(status.postsFailed, 1);
  assert.ok(
    status.error.includes(hashOf('b')),
    `取りこぼした実体の言い分が残っていない: ${status.error}`,
  );
});

test('名前に拡張子の無い添付は待たない (エンジンが落とさないので袋小路になる)', async () => {
  const posts = [
    {
      id: '1313',
      title: '名無しの添付',
      published: '2026-12-01T00:00:00',
      // 名前に拡張子が無い添付。道は .jpg だが kemono-dl は拡張子なしで落とすので、
      // {hash}.jpg では引き当てられない = 必須にすると永久に済にならない
      attachments: [attach('a', '1.jpg'), { name: '添付', path: `/aa/bb/${hashOf('z')}.jpg` }],
    },
  ];
  const plan = { 1313: { title: '名無しの添付', files: [{ hash: hashOf('a'), ext: 'jpg' }] } };
  const box = makeBulk({ tag: 'noext', posts, plan });

  const status = await box.bulk.start();

  assert.deepStrictEqual(listNames(box.creatorDir), ['[20261201] [1313] 名無しの添付【1P】.pdf']);
  assert.deepStrictEqual([...box.state.done], [`${SERVICE}:${USER}:1313`]);
  assert.strictEqual(status.postsDone, 1);
  assert.strictEqual(status.postsFailed, 0);
});

// zip の中身は base64 で偽エンジンに渡す (JSON に生のバイト列は載らない)
function zipBase64(entries) {
  const yazl = require('yazl');
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const [name, body] of entries) zip.addBuffer(Buffer.from(body), name);
    zip.end();
    const chunks = [];
    zip.outputStream.on('data', (chunk) => chunks.push(chunk));
    zip.outputStream.on('error', reject);
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
  });
}

test('zip 付きの投稿: 中の絵だけを綴じ、書庫も残り (txt) も置かない', async () => {
  const onlyImages = await zipBase64([['1.jpg', 'jpeg-a'], ['2.jpg', 'jpeg-b']]);
  const mixed = await zipBase64([['1.jpg', 'jpeg-a'], ['readme.txt', 'notes']]);
  // 絵が 1 枚も無い書庫だけは書庫のまま置く (捨てると中身が丸ごと失われる)
  const noImages = await zipBase64([['readme.txt', 'notes'], ['source.psd', 'layers']]);
  const posts = [
    { id: '666', title: '絵だけの書庫', published: '2026-06-07T00:00:00', attachments: [attach('a', 'pack.zip')] },
    { id: '777', title: '混ざった書庫', published: '2026-06-08T00:00:00', attachments: [attach('b', 'pack.zip')] },
    { id: '888', title: '絵の無い書庫', published: '2026-06-09T00:00:00', attachments: [attach('c', 'pack.zip')] },
  ];
  const plan = {
    666: { title: '絵だけの書庫', files: [{ hash: hashOf('a'), ext: 'zip', bodyBase64: onlyImages }] },
    777: { title: '混ざった書庫', files: [{ hash: hashOf('b'), ext: 'zip', bodyBase64: mixed }] },
    888: { title: '絵の無い書庫', files: [{ hash: hashOf('c'), ext: 'zip', bodyBase64: noImages }] },
  };
  const box = makeBulk({ tag: 'zip', posts, plan });

  const status = await box.bulk.start();

  // zip は設定に関わらず常に取りに行く
  assert.ok(box.runs[0].onlyFiletypes.includes('zip'));
  // 絵が 1 枚でもあれば綴じて書庫は残さない。絵ゼロの書庫だけ書庫のまま置く
  assert.deepStrictEqual(listNames(box.creatorDir), [
    '[20260607] [666] 絵だけの書庫+pack【2P】.pdf',
    '[20260608] [777] 混ざった書庫+pack【1P】.pdf',
    '[20260609] [888] 絵の無い書庫+pack.zip',
  ]);
  assert.strictEqual(status.postsDone, 3);
  assert.strictEqual(status.postsFailed, 0);
  assert.ok(!fs.existsSync(box.staging));
});

test('エンジンが欠けていたら走らずに理由を残す', async () => {
  const root = tempDir('missing');
  const broken = new KemonoEngine().init({
    command: path.join(root, 'python.exe'),
    baseArgs: ['-B', path.join(root, 'kemono-dl.py')],
    workDir: root,
  });
  const state = makeState();
  const bulk = new PawBulk({
    state,
    settings: { dir: path.join(root, 'out'), concurrency: 1 },
    listSources: () => [{ service: SERVICE, user: USER }],
    adapter: makeAdapter([{ id: '555', title: '取れない', published: '2026-05-06T00:00:00', attachments: [attach('a', '1.jpg')] }]),
    engine: broken,
    delay: 0,
  });

  const status = await bulk.start();
  assert.ok(status.error.includes('Python'), '欠品の説明をそのまま出す');
  assert.strictEqual(status.postsDone, 0);
  assert.deepStrictEqual([...state.done], []);
});
