'use strict';

// pawchive の 保存 (ダブルクリック) を外部エンジン (kemono-dl) に任せる道の特性テスト。
// 実ランタイム (third_party/python) も Electron も網も使わない:
//   - 作品の取得口 (src/lib/sources) を差し替え、pawchive の閲覧系 (fetchImage) が
//     保存で叩かれないことをそのまま確かめる
//   - PDF 生成 (pdf-builder = BrowserWindow) も差し替え、綴じ順だけを見る
//   - 取り込みエンジンには偽エンジン (test/fixtures/fake-kemono.js) を差す
//
// 見ているのは「成果物の実在で成否を決める」という契約: 子の終了コードではなく、
// 欲しい hash の実体が staging に居るかどうかで done / 積み直しが分かれる。

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { argValue } = require('./helpers/args');

const FAKE_ENGINE = path.join(__dirname, 'fixtures', 'fake-kemono.js');

// --- 差し替え (downloader を require するより前に済ませる) --------------------

function stub(request, exports) {
  const key = require.resolve(request);
  require.cache[key] = { id: key, filename: key, loaded: true, exports };
}

const { parseId } = require('../src/lib/sources/ids');

// 取りに行った頁の記録。pawchive の保存でここが増えたら設計が壊れている
const fetchCalls = [];
const galleries = new Map();

stub('../src/lib/sources', {
  parseId,
  sanitizeName: (name) => String(name).replace(/[<>:"/\\|?*]/g, '_'),
  async getGallery(id) {
    const gallery = galleries.get(String(id));
    if (!gallery) throw new Error(`知らない作品: ${id}`);
    return gallery;
  },
  async fetchImage(id, index) {
    fetchCalls.push(`${id}#${index}`);
    if (parseId(id).source === 'pawchive') throw new Error('pawchive の閲覧系を保存に使ってはいけない');
    return { bytes: Buffer.from(`page-${index}`), type: 'image/jpeg' };
  },
});

// 綴じた結果は「渡された頁の並び」だけを置く (実物は隠し窓で刷るので呼べない)。
// 返りは本物と同じ「報告」の形。開けなかった頁を仕込む口を持たせる
let pdfFailedPages = [];
stub('../src/lib/pdf-builder', {
  async buildPdf({ pages, dest }) {
    const failed = pdfFailedPages;
    // 本物と同じ順序を守る: **開けなかった頁があるうちは据えない**。
    // ここを本物より甘くすると、複製が増える道が試験を素通りする
    if (!failed.length) {
      fs.writeFileSync(dest, JSON.stringify(pages.map((page) => path.basename(page.file))), 'utf8');
    }
    return {
      dest,
      total: pages.length,
      decoded: pages.length - failed.length,
      failed,
      published: !failed.length,
    };
  },
});

// 頁を一枚ずつ作業場へ写す途中に割り込む口。綴じている最中の取り消しを
// 狙った時点で入れるために、実寸を測る関数へ引っ掛ける (測るのは本物のまま)
const realImageSize = require('../src/lib/image-size').imageSize;
let onMeasure = null;
stub('../src/lib/image-size', {
  imageSize(buffer) {
    if (onMeasure) onMeasure();
    return realImageSize(buffer);
  },
});

const { Downloader } = require('../src/lib/downloader');
const { engine } = require('../src/lib/kemono-engine');

// --- 道具 --------------------------------------------------------------------

const PAW_ID = 'pw:fanbox:1234:5678';

function hashOf(seed) {
  return crypto.createHash('sha256').update(String(seed)).digest('hex');
}

// 置き場のファイル名は hash を含む。route が返す綴じ順もこの並び
function fileEntry(hash, index) {
  return { path: `/data/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}.jpg`, name: `${index + 1}.jpg` };
}

// 作った作業場は最後にまとめて畳む (放っておくと %TEMP% に staging と PDF が溜まる)
const roots = [];

test.after(() => {
  onMeasure = null;
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* 残っても次の走りが別の場所を切る */ }
  }
});

function setup(tag, { pages = 2, zips = [], cover = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `bunko-dlpaw-${tag}-`));
  roots.push(root);
  const bulkDir = path.join(root, 'pawchive');
  const hashes = Array.from({ length: pages }, (unused, index) => hashOf(`${tag}-${index}`));
  // zip と表紙は本文とは別枠で運ぶ (必須なのは本文と zip、表紙は「落ちれば使う」)
  const zipHashes = zips.map((unused, index) => hashOf(`${tag}-zip-${index}`));
  const coverHash = cover ? hashOf(`${tag}-cover`) : '';
  const plan = {
    downloadDir: path.join(bulkDir, 'fanbox', '偽の作者 [1234]'),
    stagingDir: path.join(bulkDir, '.kemono-staging', 'dl-pw_fanbox_1234_5678'),
    baseName: `20260101 [5678] 偽の投稿 (${pages})`,
    // 表紙 1 枚だけを綴じることになったときの名。本文 PDF とは別の名になる
    coverBaseName: '20260101 [5678] 偽の投稿【1P】',
    pawKey: 'fanbox:1234:5678',
    postUrl: 'https://pawchive.pw/fanbox/user/1234/post/5678',
    files: hashes.map(fileEntry),
    zips: zipHashes.map((hash, index) => ({
      path: `/data/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}.zip`,
      name: zips[index],
    })),
    cover: cover ? { path: `/data/aa/bb/${coverHash}.jpeg`, name: 'cover.jpeg' } : null,
  };
  // pageCount を持たせておく: 万一 API 直取りへ落ちたら fetchCalls が増えて分かる
  galleries.set(PAW_ID, { id: PAW_ID, source: 'pawchive', title: '偽の投稿', pageCount: 3, files: [] });

  const downloader = new Downloader();
  downloader.setRoute(async () => plan);
  const job = downloader.createJob({
    id: PAW_ID,
    title: '偽の投稿',
    downloadDir: path.join(root, '既定の保存先'),
    format: 'zip',
  });
  return { root, bulkDir, downloader, job, plan, hashes, zipHashes, coverHash };
}

// 実物の zip を base64 で作る。偽エンジンは JSON 越しに指図を受け取るので、
// 生のバイト列はこの形でしか渡せない
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

// 「指図どおりに落とす」形の偽エンジン。落とす実体の中身まで決められるので、
// zip のように開けてみないと結果の変わる添付はこちらで組む
function useFakePlanEngine(root, plan, { dump = '' } = {}) {
  const planFile = path.join(root, 'engine-plan.json');
  fs.writeFileSync(planFile, JSON.stringify(plan), 'utf8');
  const args = [FAKE_ENGINE, '--fake-mode', 'plan', '--fake-plan', planFile];
  if (dump) args.push('--fake-dump', dump);
  engine.init({ command: process.execPath, baseArgs: args, workDir: path.join(root, 'work') });
  engine.available = () => true;
  engine.runtimeError = () => '';
}

// 偽エンジンを差す。落とす成果物と吐く ERROR は baseArgs の旗で決める
function useFakeEngine(root, { write = [], error = '', mode = 'save', sleep = 0, dump = '' } = {}) {
  const args = [FAKE_ENGINE, '--fake-mode', mode];
  if (write.length) args.push('--fake-write', write.join(','));
  if (error) args.push('--fake-say-error', error);
  if (sleep) args.push('--fake-sleep', String(sleep));
  if (dump) args.push('--fake-dump', dump);
  engine.init({ command: process.execPath, baseArgs: args, workDir: path.join(root, 'work') });
  // 同梱物の実在検査 (third_party/python とその依存) はここでは意味を成さない:
  // 走らせるのは node の偽エンジンなので、使える状態として通す
  engine.available = () => true;
  engine.runtimeError = () => '';
}

// 同梱物の欠品そのものを見るテストのために、素の検査へ戻す
function useRealEngineChecks() {
  delete engine.available;
  delete engine.runtimeError;
}

async function waitFor(check, limit = 5000) {
  const until = Date.now() + limit;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

// --- テスト ------------------------------------------------------------------

test('保存: 揃った実体を綴じ順に綴じ、staging は畳む', async () => {
  const { root, downloader, job, plan, hashes } = setup('done');
  useFakeEngine(root, { write: [`${hashes[0]}.jpg`, `${hashes[1]}.png`] });
  let completed = null;
  downloader.onComplete = (finished) => { completed = finished; };

  await downloader.run(PAW_ID);

  assert.strictEqual(job.status, 'done');
  assert.strictEqual(job.error, '');
  // 落とし先も名前も台帳の鍵も route の指示に従う (一括更新と同じ棚)
  assert.strictEqual(job.format, 'pdf');
  assert.strictEqual(job.downloadDir, plan.downloadDir);
  assert.strictEqual(job.pawKey, plan.pawKey);
  assert.strictEqual(job.total, 2, '枚数は plan.files が決める (gallery.pageCount ではない)');
  assert.strictEqual(job.done, 2);

  const dest = path.join(plan.downloadDir, `${plan.baseName}.pdf`);
  assert.ok(fs.existsSync(dest));
  // 実拡張子のまま、綴じ順で番号を振る
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(dest, 'utf8')), ['0001.jpg', '0002.png']);
  assert.ok(!fs.existsSync(plan.stagingDir), '綴じ終えた staging は畳む');
  assert.strictEqual(completed && completed.id, PAW_ID, '完了通知は流す');
  assert.deepStrictEqual(fetchCalls.filter((call) => call.startsWith('pw:')), [], '閲覧系は叩かない');
});

test('エンジンへの渡し: 投稿 URL ごと staging へ、名前は hash', async () => {
  const { root, downloader, plan, hashes } = setup('args');
  const dump = path.join(root, 'dump.json');
  useFakeEngine(root, { write: hashes.map((hash) => `${hash}.jpg`), dump });

  await downloader.run(PAW_ID);

  const { args } = JSON.parse(fs.readFileSync(dump, 'utf8'));
  assert.strictEqual(argValue(args, '--links'), plan.postUrl);
  assert.strictEqual(argValue(args, '--dirname-pattern'), plan.stagingDir);
  assert.strictEqual(argValue(args, '--filename-pattern'), '{hash}.{ext}');
  assert.strictEqual(argValue(args, '--only-filetypes'), 'jpg,jpeg,png,webp');
});

test('行き先が決まらない pawchive は API 直取りへ落とさず、待たせずに止める', async () => {
  const { root, downloader, job, plan } = setup('noplan');
  useFakeEngine(root, { write: [] });
  downloader.setRoute(async () => null);

  await downloader.run(PAW_ID);

  assert.strictEqual(job.status, 'error');
  assert.ok(job.error.includes('pawchive の保存先'), `理由が出ていない: ${job.error}`);
  assert.deepStrictEqual(fetchCalls.filter((call) => call.startsWith('pw:')), [], '閲覧系へ落とさない');
  assert.strictEqual(downloader.retryTimers.size, 0, '積み直しの待ちも作らない');
  assert.ok(!fs.existsSync(plan.downloadDir), '棚も切らない');
});

test('同梱物が欠けていれば理由を出して止まる (積み直しても現れない)', async () => {
  const { root, downloader, job, plan } = setup('missing');
  useRealEngineChecks();
  engine.init({
    command: path.join(root, 'no-such-python.exe'),
    baseArgs: ['-B', path.join(root, 'no-such-kemono-dl.py')],
    workDir: path.join(root, 'work'),
  });

  await downloader.run(PAW_ID);

  assert.strictEqual(job.status, 'error');
  assert.ok(job.error.includes('Python'), `同梱物の欠品を言っていない: ${job.error}`);
  assert.strictEqual(downloader.retryTimers.size, 0);
  assert.ok(!fs.existsSync(plan.stagingDir), '走れないときは staging も切らない');
});

test('欠けがあれば staging を残して積み直し、一覧から消すときに畳む', async () => {
  const { root, downloader, job, plan, hashes } = setup('partial');
  // 2 枚のうち 1 枚だけ落ちて、残りは流量で断られた
  useFakeEngine(root, {
    write: [`${hashes[0]}.jpg`],
    error: 'failed to download https://example.invalid/file | 403 Forbidden',
  });

  await downloader.run(PAW_ID);

  try {
    assert.strictEqual(job.status, 'queued', '積み直しの列に戻る');
    assert.strictEqual(job.attempts, 0, '一枚でも積めた走りは空振りに数えない');
    assert.ok(/403/.test(job.error), `断られた語が残っていない: ${job.error}`);
    assert.ok(downloader.retryTimers.has(PAW_ID), '積み直しの待ちが立つ');
    // 取れた 1 枚は次の走りの資産として残す
    assert.deepStrictEqual(fs.readdirSync(plan.stagingDir), [`${hashes[0]}.jpg`]);
    assert.ok(!fs.existsSync(path.join(plan.downloadDir, `${plan.baseName}.pdf`)), '欠けたまま綴じない');
  } finally {
    // 積み直しの待ちは流量制限の幅 (分単位)。下ろさないとテストの処理が終わらない
    downloader.cancel(PAW_ID);
  }
  assert.strictEqual(job.status, 'cancelled');
  assert.strictEqual(downloader.retryTimers.size, 0, '待ちのタイマーも下ろす');
  downloader.clearFinished();
  assert.ok(!fs.existsSync(plan.stagingDir), '一覧から消えたら staging も畳む');
});

test('途中で切れた欠片 (416) は取れた扱いにせず、捨てて取り直させる', async () => {
  const { root, downloader, job, plan, hashes } = setup('broken');
  // 1 枚目は落ち切り、2 枚目は「バイト数が合わない」と言われた欠片で残った
  useFakeEngine(root, {
    write: [`${hashes[0]}.jpg`, `${hashes[1]}_statuscode416.jpg`],
  });

  await downloader.run(PAW_ID);

  try {
    assert.strictEqual(job.status, 'queued', '欠片を綴じて done にしてはいけない');
    assert.ok(/1 枚取得できませんでした/.test(job.error), `欠片を欠けとして数えていない: ${job.error}`);
    assert.ok(
      !fs.existsSync(path.join(plan.downloadDir, `${plan.baseName}.pdf`)),
      '切れた絵を綴じた本を出さない',
    );
    // 欠片を残すと次の走りも「もう有る」と読んで永久に取り直せない
    assert.deepStrictEqual(fs.readdirSync(plan.stagingDir), [`${hashes[0]}.jpg`]);
  } finally {
    downloader.cancel(PAW_ID);
  }
});

test('綴じている最中の取り消し: 本も .part も残さず cancelled で降りる', async () => {
  const { root, downloader, job, plan, hashes } = setup('cancelmid', { pages: 3 });
  useFakeEngine(root, { write: hashes.map((hash) => `${hash}.jpg`) });
  let completed = null;
  downloader.onComplete = (finished) => { completed = finished; };
  // 1 枚目を作業場へ写している最中に取り消す (綴じ込みの輪の中で気付く道)
  onMeasure = () => {
    onMeasure = null;
    downloader.cancel(PAW_ID);
  };

  await downloader.run(PAW_ID);

  assert.strictEqual(job.status, 'cancelled');
  assert.strictEqual(completed, null, '取り消した仕事を台帳へ回さない');
  const dest = path.join(plan.downloadDir, `${plan.baseName}.pdf`);
  assert.ok(!fs.existsSync(dest), '取り消した仕事の本は置かない');
  assert.ok(!fs.existsSync(`${dest}.part`), '書きかけも残さない');
  assert.ok(!fs.existsSync(plan.stagingDir), '落ちかけも畳む');
  assert.strictEqual(downloader.retryTimers.size, 0);
});

test('綴じ終えてから commit までの間の取り消しも cancelled で降りる', async () => {
  const { root, downloader, job, plan, hashes } = setup('cancelcommit');
  useFakeEngine(root, { write: hashes.map((hash) => `${hash}.jpg`) });
  // 最後の 1 枚を写し終えた時点で取り消す = 綴じ込みの輪は抜けた後
  let seen = 0;
  onMeasure = () => {
    seen += 1;
    if (seen < hashes.length) return;
    onMeasure = null;
    downloader.cancel(PAW_ID);
  };

  await downloader.run(PAW_ID);

  assert.strictEqual(job.status, 'cancelled');
  assert.ok(!fs.existsSync(path.join(plan.downloadDir, `${plan.baseName}.pdf`)), '刷り上げてしまわない');
  assert.ok(!fs.existsSync(plan.stagingDir));
});

test('行き先を決める途中で断られたら、止めずに積み直す', async () => {
  const { root, downloader, job, plan } = setup('routeerror');
  useFakeEngine(root, { write: [] });
  downloader.setRoute(async () => {
    throw new Error('HTTP 429 Too Many Requests');
  });

  await downloader.run(PAW_ID);

  try {
    assert.strictEqual(job.status, 'queued', '一過性の失敗は待って引き直す');
    assert.ok(/429/.test(job.error), `断られた語が残っていない: ${job.error}`);
    assert.ok(downloader.retryTimers.has(PAW_ID), '積み直しの待ちが立つ');
    assert.ok(!fs.existsSync(plan.downloadDir), '棚は切らない');
  } finally {
    downloader.cancel(PAW_ID);
  }
});

test('pawchive は一冊ずつしか枠を取らない (hitomi を飢えさせない)', async () => {
  const { root, downloader, plan, hashes } = setup('slot');
  const other = 'pw:fanbox:1234:9999';
  galleries.set(other, { id: other, source: 'pawchive', title: 'もう一つの投稿', pageCount: 1, files: [] });
  const plans = new Map([
    [PAW_ID, plan],
    [other, { ...plan, stagingDir: path.join(root, 'pawchive', '.kemono-staging', 'dl-other'), pawKey: 'fanbox:1234:9999' }],
  ]);
  downloader.setRoute(async (id) => plans.get(String(id)) || null);
  downloader.createJob({ id: other, title: 'もう一つの投稿', downloadDir: path.join(root, '既定の保存先'), format: 'zip' });
  // どちらも取りこぼす偽エンジン: 走り出しさえすれば積み直しの待ちが立つ
  useFakeEngine(root, { write: [] });

  downloader.queue.push(PAW_ID, other);
  downloader.pump();

  // run は最初の await までは同期に進むので、この時点の数がそのまま枠の取り方
  assert.strictEqual(downloader.activePaw, 1, 'pawchive は一冊ずつ');
  assert.deepStrictEqual(downloader.queue, [other], '二冊目は枠を取らずに列へ戻る');

  const settled = await waitFor(() => downloader.retryTimers.size === 2);
  try {
    assert.ok(settled, '順に片付いて二冊とも積み直しの待ちに入る');
    assert.strictEqual(downloader.activePaw, 0);
  } finally {
    downloader.cancel(PAW_ID);
    downloader.cancel(other);
    galleries.delete(other);
  }
  assert.ok(!fs.existsSync(path.join(plan.downloadDir, `${plan.baseName}.pdf`)), '取れていない本は置かない');
  assert.deepStrictEqual(hashes.length, 2);
});

test('積み直しの控えは再起動をまたぐ: staging の在り処ごと戻して畳める', async () => {
  const { root, plan } = setup('persist');
  const persistPath = path.join(root, 'queue.json');
  const first = new Downloader();
  first.init(persistPath);
  const job = first.createJob({
    id: PAW_ID,
    title: '偽の投稿',
    downloadDir: plan.downloadDir,
    format: 'pdf',
  });
  // 積み直しを使い切って error で落ち着いた形 (落ちかけは staging に残っている)
  job.status = 'error';
  job.error = '403 Forbidden';
  job.destPath = path.join(plan.downloadDir, `${plan.baseName}.pdf`);
  job.pawKey = plan.pawKey;
  job.stagingDir = plan.stagingDir;
  fs.mkdirSync(plan.stagingDir, { recursive: true });
  fs.writeFileSync(path.join(plan.stagingDir, 'landed.jpg'), 'x');
  first.persist();

  const second = new Downloader();
  second.init(persistPath);
  const restored = second.jobs.get(PAW_ID);

  assert.strictEqual(restored.status, 'error');
  assert.strictEqual(restored.stagingDir, plan.stagingDir, '落ちかけの在り処を忘れない');
  assert.strictEqual(restored.pawKey, plan.pawKey);
  assert.strictEqual(restored.destPath, job.destPath);
  // 在り処を覚えているから、一覧から消すときに孤児を残さず畳める
  second.clearFinished();
  assert.ok(!fs.existsSync(plan.stagingDir), '一覧から消えたら落ちかけも畳む');
});

test('積む前に取り消したジョブの落ちかけも畳む', async () => {
  const { root, plan } = setup('cancelqueued');
  const downloader = new Downloader();
  const job = downloader.createJob({
    id: PAW_ID,
    title: '偽の投稿',
    downloadDir: plan.downloadDir,
    format: 'pdf',
  });
  job.stagingDir = plan.stagingDir;
  fs.mkdirSync(plan.stagingDir, { recursive: true });
  fs.writeFileSync(path.join(plan.stagingDir, 'landed.jpg'), 'x');

  downloader.cancel(PAW_ID);

  assert.strictEqual(job.status, 'cancelled');
  assert.ok(!fs.existsSync(plan.stagingDir), '走り出す前に取り消しても孤児を残さない');
  assert.ok(fs.existsSync(root));
});

test('取り消し: 走っている最中に止めると staging ごと畳む', async () => {
  const { root, downloader, job, plan } = setup('cancel');
  useFakeEngine(root, { mode: 'sleep', sleep: 30000 });

  const running = downloader.run(PAW_ID);
  const timer = setTimeout(() => downloader.cancel(PAW_ID), 300);
  await running;
  clearTimeout(timer);

  assert.strictEqual(job.status, 'cancelled');
  assert.ok(!fs.existsSync(plan.stagingDir), '取り消した仕事の落ちかけは残さない');
  assert.strictEqual(downloader.retryTimers.size, 0);
});

test('zip 配布の投稿: 中の絵を綴じ、表紙の本は隣に並べない', async () => {
  const { root, downloader, job, plan, zipHashes, coverHash } = setup('zipbook', {
    // サムネ 1 枚 + 本編 zip という pawchive でよくある形 (本文画像は 0 枚)
    pages: 0,
    zips: ['20260101-JPG.zip'],
    cover: true,
  });
  const dump = path.join(root, 'dump.json');
  useFakePlanEngine(root, {
    5678: {
      title: '偽の投稿',
      files: [
        { hash: coverHash, ext: 'jpeg' },
        { hash: zipHashes[0], ext: 'zip', bodyBase64: await zipBase64([['1.jpg', 'a'], ['2.jpg', 'b']]) },
      ],
    },
  }, { dump });

  await downloader.run(PAW_ID);

  assert.strictEqual(job.status, 'done', job.error);
  // 必須は zip だけ。表紙は落ちれば使うだけで、揃い判定には入れない
  assert.strictEqual(job.total, 1);
  assert.strictEqual(job.done, 1);
  // 綴じ上がりは zip 由来の 1 冊だけ。表紙 1 枚の本を隣に並べても雑音にしかならない
  assert.deepStrictEqual(fs.readdirSync(plan.downloadDir).sort(), [
    `${plan.baseName}+20260101-JPG【2P】.pdf`,
  ]);
  assert.strictEqual(job.dest, path.join(plan.downloadDir, `${plan.baseName}+20260101-JPG【2P】.pdf`));
  // zip を頼む投稿でだけ zip を取りに行く
  const { args } = JSON.parse(fs.readFileSync(dump, 'utf8'));
  assert.strictEqual(argValue(args, '--only-filetypes'), 'jpg,jpeg,png,webp,zip');
  assert.ok(!fs.existsSync(plan.stagingDir), '綴じ終えた staging は畳む');
  assert.deepStrictEqual(fetchCalls.filter((call) => call.startsWith('pw:')), [], '閲覧系は叩かない');
});

test('絵の無い zip は書庫のまま置き、表紙を見出し代わりに綴じる', async () => {
  const { root, downloader, job, plan, zipHashes, coverHash } = setup('zipraw', {
    pages: 0,
    zips: ['pack.zip'],
    cover: true,
  });
  useFakePlanEngine(root, {
    5678: {
      title: '偽の投稿',
      files: [
        { hash: coverHash, ext: 'jpeg' },
        { hash: zipHashes[0], ext: 'zip', bodyBase64: await zipBase64([['notes.txt', 'x'], ['a.psd', 'y']]) },
      ],
    },
  });

  await downloader.run(PAW_ID);

  assert.strictEqual(job.status, 'done', job.error);
  assert.deepStrictEqual(fs.readdirSync(plan.downloadDir).sort(), [
    // 中身を綴じられなかったので書庫のまま。見出しが無いと何の投稿か分からない
    `${plan.baseName}+pack.zip`,
    `${plan.coverBaseName}.pdf`,
  ]);
  // 一覧に出す代表は表紙の本 (書庫は開けない)
  assert.strictEqual(job.dest, path.join(plan.downloadDir, `${plan.coverBaseName}.pdf`));
});

test('本文と zip の両方がある投稿: どちらも置き、代表は本文の本', async () => {
  const { root, downloader, job, plan, hashes, zipHashes } = setup('zipboth', {
    pages: 2,
    zips: ['pack.zip'],
  });
  useFakePlanEngine(root, {
    5678: {
      title: '偽の投稿',
      files: [
        { hash: hashes[0], ext: 'jpg' },
        { hash: hashes[1], ext: 'jpg' },
        { hash: zipHashes[0], ext: 'zip', bodyBase64: await zipBase64([['1.jpg', 'a']]) },
      ],
    },
  });

  await downloader.run(PAW_ID);

  assert.strictEqual(job.status, 'done', job.error);
  assert.strictEqual(job.total, 3, '本文 2 枚と zip 1 つが必須');
  assert.deepStrictEqual(fs.readdirSync(plan.downloadDir).sort(), [
    `${plan.baseName}+pack【1P】.pdf`,
    `${plan.baseName}.pdf`,
  ]);
  assert.strictEqual(job.dest, path.join(plan.downloadDir, `${plan.baseName}.pdf`));
});

test('開けない zip は積み直す (本文の本も出さないまま次の走りへ)', async () => {
  const { root, downloader, job, plan, hashes, zipHashes } = setup('zipbroken', {
    pages: 1,
    zips: ['pack.zip'],
  });
  useFakePlanEngine(root, {
    5678: {
      title: '偽の投稿',
      files: [
        { hash: hashes[0], ext: 'jpg' },
        // 書庫として開けない実体 (落とし切れていない・中身が別物)
        { hash: zipHashes[0], ext: 'zip', body: 'not a zip at all' },
      ],
    },
  });

  await downloader.run(PAW_ID);

  try {
    assert.strictEqual(job.status, 'queued', '開けなかった書庫は次の走りへ回す');
    assert.ok(/ZIP の取り込みに失敗しました/.test(job.error), `失敗の言い分が残っていない: ${job.error}`);
    assert.ok(downloader.retryTimers.has(PAW_ID), '積み直しの待ちが立つ');
    assert.ok(!fs.existsSync(path.join(plan.downloadDir, `${plan.baseName}.pdf`)), '本文だけ先に出さない');
    // 落ちきった実体は次の走りの資産として残す
    assert.ok(fs.existsSync(plan.stagingDir));
  } finally {
    downloader.cancel(PAW_ID);
  }
});

test('表紙だけの投稿でその表紙も落ちてこなければ、置くものが無いので積み直す', async () => {
  const { root, downloader, job, plan } = setup('nocover', { pages: 0, cover: true });
  // 指図に無い投稿 = 何も落ちてこない
  useFakePlanEngine(root, {});

  await downloader.run(PAW_ID);

  try {
    assert.strictEqual(job.status, 'queued');
    assert.ok(/綴じるもの/.test(job.error), `理由が出ていない: ${job.error}`);
    assert.deepStrictEqual(
      fs.existsSync(plan.downloadDir) ? fs.readdirSync(plan.downloadDir) : [],
      [],
      '空の棚に何も置かない',
    );
  } finally {
    downloader.cancel(PAW_ID);
  }
});

test('他ソースは従来どおり: 頁を一枚ずつ取って zip に綴じる', async () => {
  const { root, downloader } = setup('hitomi');
  const id = '99001';
  galleries.set(id, { id, source: 'hitomi', title: 'ひとみの本', pageCount: 3, files: [] });
  downloader.setRoute(async () => null);
  const job = downloader.createJob({
    id,
    title: 'ひとみの本',
    downloadDir: path.join(root, '既定の保存先'),
    format: 'zip',
  });

  await downloader.run(id);

  assert.strictEqual(job.status, 'done');
  assert.strictEqual(job.done, 3);
  assert.strictEqual(job.format, 'zip');
  assert.ok(job.dest.endsWith('.zip'));
  assert.deepStrictEqual(
    fetchCalls.filter((call) => call.startsWith(`${id}#`)).sort(),
    [`${id}#0`, `${id}#1`, `${id}#2`],
  );
  // 頁の控え (.resume-*) は綴じ終えたら畳む
  assert.deepStrictEqual(
    fs.readdirSync(path.join(root, '既定の保存先')).filter((name) => name.startsWith('.resume-')),
    [],
  );
});


// ── 綴じ上がりが欠けたとき (項目 9-11) ────────────────────────

test('頁が一枚でも開けなかったら、原本 (staging) を消さずに失敗にする', async () => {
  const { root, downloader, job, plan, hashes } = setup('broken');
  useFakeEngine(root, { write: [`${hashes[0]}.jpg`, `${hashes[1]}.png`] });
  pdfFailedPages = [1];                 // 2 頁目が開けなかった
  try {
    await downloader.run(PAW_ID);
  } finally {
    pdfFailedPages = [];
  }

  // 失敗は積み直しに回る (4 回まで) ので status は queued。肝心なのは次の三つ
  assert.notStrictEqual(job.status, 'done', '白紙混じりを「完了」にしない');
  assert.match(job.error, /2 頁のうち 1 頁/, '何頁のうち何頁かを言う');
  assert.match(job.error, /原本は消さずに残します/);
  assert.ok(fs.existsSync(plan.stagingDir), '原本は残る (次の回に組み直せる)');
});

// 2026-09-11 の事故の釘。綴じ上がりを本番の名前に据えてから「頁が開けない」と
// 投げていたので、積み直しのたびに uniqueName が次の番号を取り、同じ作品が
// 6 冊棚に出た。被害が出るのは棚 (= Eagle の監視フォルダ) なので、
// 「失敗したら物が出ない」を実際に走らせて確かめる
test('綴じられなかった PDF は棚に出ず、積み直しても複製が増えない', async () => {
  const { root, downloader } = setup('dupes');
  const dir = path.join(root, '既定の保存先');
  const id = '99002';
  galleries.set(id, { id, source: 'hitomi', title: 'こわれた本', pageCount: 3, files: [] });
  downloader.setRoute(async () => null);
  const job = downloader.createJob({
    id, title: 'こわれた本', downloadDir: dir, format: 'pdf',
  });
  const pdfs = () => fs.readdirSync(dir).filter((name) => name.endsWith('.pdf')).sort();
  const cacheDir = path.join(dir, '.resume-99002');
  const cached = () => fs.readdirSync(cacheDir).sort();

  pdfFailedPages = [1];                 // 2 頁目がどうしても開けない
  try {
    await downloader.run(id);
    assert.deepStrictEqual(pdfs(), [], '開けない頁があるうちは棚に出さない');
    assert.deepStrictEqual(
      cached(), ['0000.jpg', '0002.jpg'],
      '開けなかった頁の控えだけ捨てる (取れている頁は残して通信を無駄にしない)',
    );

    await downloader.run(id);           // 積み直し
    assert.deepStrictEqual(pdfs(), [], 'まだ棚に出ない');
    assert.ok(
      !pdfs().some((name) => /\(\d+\)\.pdf$/.test(name)),
      '番号付きの複製が生まれない (これが 6 冊になった道)',
    );
    assert.ok(
      fetchCalls.filter((call) => call === `${id}#1`).length >= 2,
      '捨てた頁は取り直す (同じ壊れた欠片を綴じ直すだけにしない)',
    );

    pdfFailedPages = [];                // 取り直したら開けた
    await downloader.run(id);
    assert.strictEqual(pdfs().length, 1, '直れば一冊だけ出る');
    assert.strictEqual(job.status, 'done');
  } finally {
    pdfFailedPages = [];
    downloader.cancel(id);
  }
});

test('pixiv series objects save single images and multi-page PDFs without map errors', async () => {
  for (const pages of [1, 2]) {
    const { root, downloader } = setup(`pixiv-series-${pages}`);
    const id = `px:${88000 + pages}`;
    galleries.set(id, { id, source: 'pixiv', title: 'シリーズ付きの見本', pageCount: pages, files: [], series: { id: '123', title: '見本シリーズ' } });
    downloader.setRoute(async () => null);
    const job = downloader.createJob({ id, title: '見本', downloadDir: path.join(root, 'output'), format: 'zip' });
    try {
      await downloader.run(id);
      assert.strictEqual(job.status, 'done', job.error);
      assert.strictEqual(job.done, pages);
      assert.ok(fs.existsSync(job.dest));
      if (pages === 1) {
        const info = JSON.parse(fs.readFileSync(path.join(job.dest, 'info.json'), 'utf8'));
        assert.deepStrictEqual(info.series, ['見本シリーズ']);
        assert.ok(fs.existsSync(path.join(job.dest, '0001.jpg')));
      } else {
        assert.ok(job.dest.endsWith('.pdf'));
      }
    } finally { downloader.cancel(id); }
  }
});

// Eagle へは API で入れる (paw-importer)。口が据わっていれば done は取り込みが付ける
test('取り込みの口が据わっていれば importing で止め、代表を先頭に実体の道を渡す', async () => {
  const { root, downloader, job, plan, hashes } = setup('importing');
  useFakeEngine(root, { write: [`${hashes[0]}.jpg`, `${hashes[1]}.png`] });
  const order = [];
  downloader.onComplete = () => { order.push('complete'); };
  let handed = null;
  downloader.onPawImport = (finished, gallery, extra) => { order.push('import'); handed = { finished, gallery, extra }; };

  await downloader.run(PAW_ID);

  assert.strictEqual(job.status, 'importing', 'done は取り込みが付ける');
  assert.deepStrictEqual(order, ['complete', 'import'], '台帳の記帳 (onComplete) が先');
  const dest = path.join(plan.downloadDir, `${plan.baseName}.pdf`);
  assert.strictEqual(handed.finished.id, PAW_ID);
  assert.strictEqual(handed.gallery && handed.gallery.id, PAW_ID);
  assert.deepStrictEqual(handed.extra.files, [dest], '代表 (job.dest) を先頭に');
  assert.ok(fs.existsSync(dest), '実体は取り込みが写しを確かめるまで残す');
});
