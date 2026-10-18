'use strict';

// pawchive の取り込みを外部エンジン (kemono-dl) の子プロセスに任せるラッパの
// 特性テスト。実ランタイム (third_party/python) には依存しない: command に node
// 自身を、baseArgs に偽エンジン (test/fixtures/fake-kemono.js) を差し込んで、
// 引数の組み立て・stderr の読み取り・打ち切り・直列化を固定する。
// クッキーの引っ越しと取り込み (paw-cookies) も一時ディレクトリの中で確かめる。
// ネットワークも Electron も使わない。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  KemonoEngine,
  collectStaged,
  kemonoExt,
  fileHashOf,
  killActive,
} = require('../src/lib/kemono-engine');
const pawCookies = require('../src/lib/paw-cookies');

const FAKE_ENGINE = path.join(__dirname, 'fixtures', 'fake-kemono.js');

// 切った一時ディレクトリは全部ここに控え、最後にまとめて消す。
// クッキーの写しが混じる試験があるので、%TEMP% に置き去りにしない
const MADE_DIRS = [];

function tempDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bunko-kemono-${tag}-`));
  MADE_DIRS.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of MADE_DIRS) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch { /* 消せなくても他の片付けは続ける */ }
  }
});

// 偽エンジンを差した engine と、その run で使う一式の置き場
function makeEngine(tag) {
  const root = tempDir(tag);
  const workDir = path.join(root, 'work');
  const engine = new KemonoEngine().init({
    command: process.execPath,
    baseArgs: [FAKE_ENGINE],
    workDir,
  });
  return { engine, root, workDir, outDir: path.join(root, 'out'), dump: path.join(root, 'dump.json') };
}

function readDump(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// 旗の次に並ぶ値を取る (無ければ null)
function argValue(args, name) {
  const at = args.indexOf(name);
  return at >= 0 && at + 1 < args.length ? args[at + 1] : null;
}

test('引数の組み立て: 3 本までは --links にカンマで並べる', async () => {
  const { engine, outDir, dump } = makeEngine('args3');
  const result = await engine.run({
    links: ['https://pawchive.st/fanbox/user/1/post/11', 'https://pawchive.st/fanbox/user/1/post/22', 'https://pawchive.st/fanbox/user/1/post/33'],
    outDir,
    filenamePattern: '{id}/{filename}.{ext}',
    extraArgs: ['--fake-dump', dump],
  });
  assert.strictEqual(result.spawnError, null);

  const { args } = readDump(dump);
  assert.strictEqual(
    argValue(args, '--links'),
    'https://pawchive.st/fanbox/user/1/post/11,https://pawchive.st/fanbox/user/1/post/22,https://pawchive.st/fanbox/user/1/post/33',
  );
  assert.ok(!args.includes('--from-file'), '3 本なら一覧ファイルは作らない');
  assert.strictEqual(argValue(args, '--dirname-pattern'), outDir);
  assert.strictEqual(argValue(args, '--filename-pattern'), '{id}/{filename}.{ext}');
  assert.ok(args.includes('--force-unlisted'));
  assert.ok(args.includes('--no-dupe-check'));
  assert.strictEqual(argValue(args, '--retry-403'), '2');
});

test('引数の組み立て: 4 本以上は urls.txt に落として --from-file で渡す', async () => {
  const { engine, outDir, dump } = makeEngine('args5');
  const links = [1, 2, 3, 4, 5].map((n) => `https://pawchive.st/fanbox/user/1/post/${n}`);
  await engine.run({ links, outDir, filenamePattern: '{id}.{ext}', extraArgs: ['--fake-dump', dump] });

  const { args, fromFileText } = readDump(dump);
  assert.ok(!args.includes('--links'), '一覧ファイルを使うときは --links を並べない');
  assert.strictEqual(path.basename(argValue(args, '--from-file')), 'urls.txt');
  assert.deepStrictEqual(fromFileText.trim().split('\n'), links);
});

test('引数の組み立て: --state-db は絶対に渡さない (済の台帳はこちらが持つ)', async () => {
  const { engine, outDir, dump } = makeEngine('nostate');
  await engine.run({ links: ['https://pawchive.st/fanbox/user/1/post/1'], outDir, filenamePattern: '{id}.{ext}', extraArgs: ['--fake-dump', dump] });
  const { args } = readDump(dump);
  assert.ok(!args.includes('--state-db'));
  assert.ok(!args.includes('--archive'));
});

test('引数の組み立て: 宛先 (--site-url / --file-url) は常に名指しする', async () => {
  const { engine, outDir, dump } = makeEngine('urls');
  await engine.run({
    links: ['https://pawchive.st/fanbox/user/1/post/1'],
    outDir,
    filenamePattern: '{id}.{ext}',
    extraArgs: ['--fake-dump', dump],
  });
  const { args } = readDump(dump);
  // 既定の pawchive.st が落ちていると、子は起動直後の照会で例外死する
  assert.strictEqual(argValue(args, '--site-url'), 'https://pawchive.pw');
  assert.strictEqual(argValue(args, '--file-url'), 'https://file.pawchive.pw');
});

test('クッキー: 無い道は渡さない (素のまま取りに行く)', async () => {
  const missing = makeEngine('cookie-missing');
  const result = await missing.engine.run({
    links: ['https://pawchive.st/fanbox/user/1/post/1'],
    outDir: missing.outDir,
    filenamePattern: '{id}.{ext}',
    cookieFile: path.join(missing.root, 'no-such-cookies.txt'),
    extraArgs: ['--fake-dump', missing.dump],
  });
  assert.ok(!readDump(missing.dump).args.includes('--cookies'), '無い道は渡さない');
  assert.strictEqual(result.warning, '', '持っていないだけなら断り書きも出さない');
});

test('クッキー: 両方のドメインへ綴じ直した写しを作業場に書いて渡す', async () => {
  const { engine, root, outDir, dump } = makeEngine('cookie-rewrite');
  const cookieFile = path.join(root, 'pawchive.st_cookies.txt');
  const original = [
    '# Netscape HTTP Cookie File',
    '.pawchive.st\tTRUE\t/\tTRUE\t1893456000\tsession\tabc123',
    '#HttpOnly_.pawchive.st\tTRUE\t/\tTRUE\t1893456000\t__ddg2\txyz789',
    '',
  ].join('\n');
  fs.writeFileSync(cookieFile, original);

  const result = await engine.run({
    links: ['https://pawchive.st/fanbox/user/1/post/1'],
    outDir,
    filenamePattern: '{id}.{ext}',
    cookieFile,
    extraArgs: ['--fake-dump', dump],
  });
  assert.strictEqual(result.warning, '');

  const info = readDump(dump);
  const passed = argValue(info.args, '--cookies');
  assert.ok(passed, '--cookies は添える');
  assert.notStrictEqual(passed, cookieFile, '利用者のファイルは直に渡さない');
  // 写しは run ごとの作業場の中 (= 終了時に消える) に置く
  assert.ok(path.basename(path.dirname(passed)).startsWith('run-'));

  const lines = String(info.cookiesText).trim().split('\n');
  assert.strictEqual(lines[0], '# Netscape HTTP Cookie File', 'MozillaCookieJar が要る先頭行');
  const rows = lines.slice(1).map((line) => line.split('\t'));
  // 今の API とファイル置き場は .pw、クッキーの綴じは .st: 両方に複製する
  const pw = rows.filter((row) => row[0] === '.pawchive.pw');
  const st = rows.filter((row) => row[0] === '.pawchive.st');
  assert.strictEqual(pw.length, 2);
  assert.strictEqual(st.length, 2);
  for (const row of rows) {
    assert.strictEqual(row.length, 7);
    assert.strictEqual(row[1], 'TRUE');
    assert.strictEqual(row[2], '/');
    assert.strictEqual(row[3], 'TRUE');
    assert.ok(Number(row[4]) > Math.floor(Date.now() / 1000), '期限は十分先 (読み込み時に捨てられない)');
  }
  assert.deepStrictEqual(pw.map((row) => row[5]).sort(), ['__ddg2', 'session']);
  assert.deepStrictEqual(
    st.map((row) => `${row[5]}=${row[6]}`).sort(),
    ['__ddg2=xyz789', 'session=abc123'],
  );
  // 原本には触らない (利用者の証しはそのまま)
  assert.strictEqual(fs.readFileSync(cookieFile, 'utf8'), original);
  // 作業場ごと消えるので、資格情報の写しは残らない
  assert.ok(!fs.existsSync(passed));
});

test('クッキー: 0 バイト・別形式なら --cookies を付けず warning を残す', async () => {
  const { engine, root, outDir, dump } = makeEngine('cookie-empty');
  const cookieFile = path.join(root, 'empty-cookies.txt');
  fs.writeFileSync(cookieFile, '');

  const result = await engine.run({
    links: ['https://pawchive.st/fanbox/user/1/post/1'],
    outDir,
    filenamePattern: '{id}.{ext}',
    cookieFile,
    extraArgs: ['--fake-dump', dump],
  });
  // 空のまま渡すと向こうは LoadError を print して即死する = 無言死に見える
  assert.ok(!readDump(dump).args.includes('--cookies'));
  assert.ok(result.warning.includes('クッキーが読めない形式'));
});

test('引数の組み立て: 種別の絞りはカンマ連結、無ければ渡さない', async () => {
  const withTypes = makeEngine('types');
  await withTypes.engine.run({
    links: ['https://pawchive.st/fanbox/user/1/post/1'],
    outDir: withTypes.outDir,
    filenamePattern: '{id}.{ext}',
    onlyFiletypes: ['jpg', 'png', ''],
    extraArgs: ['--fake-dump', withTypes.dump],
  });
  assert.strictEqual(argValue(readDump(withTypes.dump).args, '--only-filetypes'), 'jpg,png');

  const without = makeEngine('types-none');
  await without.engine.run({
    links: ['https://pawchive.st/fanbox/user/1/post/1'],
    outDir: without.outDir,
    filenamePattern: '{id}.{ext}',
    extraArgs: ['--fake-dump', without.dump],
  });
  assert.ok(!readDump(without.dump).args.includes('--only-filetypes'));
});

test('子プロセスの外堀: cwd は使い捨ての作業場、UTF-8 を env で揃える', async () => {
  const { engine, outDir, dump, workDir } = makeEngine('env');
  await engine.run({ links: ['https://pawchive.st/fanbox/user/1/post/1'], outDir, filenamePattern: '{id}.{ext}', extraArgs: ['--fake-dump', dump] });
  const info = readDump(dump);
  // 作業場は run の終わりに消えているので、実体ではなく道の綴りで見る
  // (Windows は大小を区別しない: 綴りの揺れは均してから比べる)
  assert.strictEqual(path.dirname(info.cwd).toLowerCase(), fs.realpathSync(workDir).toLowerCase());
  assert.ok(path.basename(info.cwd).startsWith('run-'));
  assert.strictEqual(info.utf8, '1');
  assert.strictEqual(info.ioencoding, 'utf-8');
  // 作業場は run のたびに切って、終わりに消す
  assert.deepStrictEqual(fs.readdirSync(workDir), []);
});

test('stderr の読み取り: 行の種別ごとにイベントへ割れる', async () => {
  const { engine, outDir } = makeEngine('events');
  const events = [];
  const result = await engine.run({
    links: ['https://pawchive.st/fanbox/user/1/post/1'],
    outDir,
    filenamePattern: '{id}.{ext}',
    extraArgs: ['--fake-mode', 'lines'],
    onEvent: (event) => events.push(event),
  });

  assert.deepStrictEqual(events.filter((e) => e.type === 'post-start'), [{ type: 'post-start', title: '偽エンジンの投稿' }]);
  assert.deepStrictEqual(events.filter((e) => e.type === 'file-start'), [{ type: 'file-start', name: '1_first.jpg' }]);
  assert.deepStrictEqual(events.filter((e) => e.type === 'file-skip'), [{ type: 'file-skip', name: '2_second.png' }]);
  assert.deepStrictEqual(events.filter((e) => e.type === 'post-skip'), [{ type: 'post-skip', id: '98765' }]);
  assert.deepStrictEqual(events.filter((e) => e.type === 'warn'), [{ type: 'warn', line: 'WARNING:server said something odd' }]);
  assert.deepStrictEqual(events.filter((e) => e.type === 'file-error'), [{ type: 'file-error', line: 'ERROR:failed to get 3_third.zip' }]);
  // 形の合わない行も落とさずそのまま渡す
  assert.deepStrictEqual(events.filter((e) => e.type === 'raw'), [{ type: 'raw', line: 'no level prefix here' }]);

  // ERROR は errors にも積む (呼び出し側が理由を画面に出せるように)
  assert.deepStrictEqual(result.errors, ['ERROR:failed to get 3_third.zip']);
  assert.strictEqual(result.cancelled, false);
  assert.strictEqual(result.timedOut, false);
});

test('stderr の読み取り: onEvent が投げても取り込みは止まらない', async () => {
  const { engine, outDir } = makeEngine('throwing');
  const result = await engine.run({
    links: ['https://pawchive.st/fanbox/user/1/post/1'],
    outDir,
    filenamePattern: '{id}.{ext}',
    extraArgs: ['--fake-mode', 'lines'],
    onEvent: () => { throw new Error('受け手がこけた'); },
  });
  assert.deepStrictEqual(result.errors, ['ERROR:failed to get 3_third.zip']);
  assert.strictEqual(result.spawnError, null);
});

test('成果物: エンジンが書いたファイルは outDir に実在する (成否は呼び手が実在で見る)', async () => {
  const { engine, outDir } = makeEngine('files');
  const result = await engine.run({
    links: ['https://pawchive.st/fanbox/user/1/post/1'],
    outDir,
    filenamePattern: '{id}/{filename}.{ext}',
    extraArgs: ['--fake-mode', 'lines'],
  });
  assert.ok(fs.existsSync(path.join(outDir, '12345', 'aaaaaa.jpg')));
  assert.ok(fs.existsSync(path.join(outDir, '12345', 'bbbbbb.png')));
  // 終了コードは成否の判定に使わない: 記録として持ち帰るだけ
  assert.strictEqual(typeof result.exitCode, 'number');
});

test('取り消し: isCancelled が立ったら子を殺し、作業場は片付ける', async () => {
  const { engine, outDir, workDir } = makeEngine('cancel');
  const started = Date.now();
  // 子が起きてから取り消される筋道 (1 回目は素通しする)
  let asked = 0;
  const result = await engine.run({
    links: ['https://pawchive.st/fanbox/user/1/post/1'],
    outDir,
    filenamePattern: '{id}.{ext}',
    extraArgs: ['--fake-mode', 'sleep', '--fake-sleep', '30000'],
    isCancelled: () => { asked += 1; return asked > 1; },
  });
  assert.strictEqual(result.cancelled, true);
  assert.ok(Date.now() - started < 10000, '眠り切る前に打ち切る');
  assert.deepStrictEqual(fs.readdirSync(workDir), [], 'urls.txt / debug.log の置き場は残さない');
  // こちらから殺した回は「異常終了」ではない (理由はもう cancelled が持っている)
  assert.strictEqual(result.failure, null);
});

test('取り消し: 順番待ちの間に立っていたら子を起こさない', async () => {
  const { engine, outDir, workDir, dump } = makeEngine('cancel-early');
  const result = await engine.run({
    links: ['https://pawchive.st/fanbox/user/1/post/1'],
    outDir,
    filenamePattern: '{id}.{ext}',
    extraArgs: ['--fake-dump', dump],
    isCancelled: () => true,
  });
  assert.strictEqual(result.cancelled, true);
  assert.strictEqual(result.exitCode, null);
  assert.strictEqual(result.spawnError, null);
  // 子が起きていたら dump が書かれ、作業場も切られている
  assert.ok(!fs.existsSync(dump), '子を起こさない');
  assert.ok(!fs.existsSync(workDir), '作業場も切らない');
});

test('打ち切り: 無通信が続いたら timedOut を立てて殺す', async () => {
  const { engine, outDir } = makeEngine('idle');
  const started = Date.now();
  const result = await engine.run({
    links: ['https://pawchive.st/fanbox/user/1/post/1'],
    outDir,
    filenamePattern: '{id}.{ext}',
    extraArgs: ['--fake-mode', 'sleep', '--fake-sleep', '30000'],
    idleTimeoutMs: 500,
  });
  assert.strictEqual(result.timedOut, true);
  assert.strictEqual(result.cancelled, false);
  assert.ok(Date.now() - started < 10000);
});

test('直列化: 同時に投げても子プロセスは一本ずつしか走らない', async () => {
  const { engine, outDir, root } = makeEngine('serial');
  const marker = path.join(root, 'marker.txt');
  const spawnRun = (tag) => engine.run({
    links: ['https://pawchive.st/fanbox/user/1/post/1'],
    outDir,
    filenamePattern: '{id}.{ext}',
    extraArgs: ['--fake-mode', 'marker', '--fake-marker', marker, '--fake-tag', tag, '--fake-sleep', '150'],
  });

  // await せずに二本投げる: 直列化が効いていなければ start が並ぶ
  const first = spawnRun('A');
  const second = spawnRun('B');
  await Promise.all([first, second]);

  assert.deepStrictEqual(
    fs.readFileSync(marker, 'utf8').trim().split('\n'),
    ['start:A', 'end:A', 'start:B', 'end:B'],
  );
});

test('URL が空なら子を起こさず spawnError を返す', async () => {
  const { engine, outDir, workDir } = makeEngine('empty');
  const result = await engine.run({ links: [], outDir, filenamePattern: '{id}.{ext}' });
  assert.ok(result.spawnError instanceof Error);
  assert.strictEqual(result.exitCode, null);
  assert.ok(!fs.existsSync(workDir), '作業場も切らない');
});

test('同梱物の欠品: available は偽、runtimeError は日本語の説明を返す', () => {
  const root = tempDir('missing');
  // 埋め込み版 Python の形を真似た置き場 (python.exe の隣に Lib\site-packages)
  const python = path.join(root, 'python.exe');
  fs.writeFileSync(python, '');

  const broken = new KemonoEngine().init({
    command: path.join(root, 'no-such-python.exe'),
    baseArgs: ['-B', path.join(root, 'kemono-dl.py')],
    workDir: root,
  });
  assert.strictEqual(broken.available(), false);
  assert.ok(broken.runtimeError().includes('Python'));

  const noScript = new KemonoEngine().init({
    command: python,
    baseArgs: ['-B', path.join(root, 'kemono-dl.py')],
    workDir: root,
  });
  assert.strictEqual(noScript.available(), false);
  assert.ok(noScript.runtimeError().includes('kemono-dl'));

  // 依存を入れ忘れたビルド。走らせると子が import で即死し、画面には
  // 「取り込み中」のまま何も落ちてこない見え方になるので、ここで弾く
  const noDeps = new KemonoEngine().init({ command: python, baseArgs: [FAKE_ENGINE], workDir: root });
  assert.strictEqual(noDeps.available(), false);
  assert.ok(noDeps.runtimeError().includes('requests'));

  fs.mkdirSync(path.join(root, 'Lib', 'site-packages', 'requests'), { recursive: true });
  const ready = new KemonoEngine().init({ command: python, baseArgs: [FAKE_ENGINE], workDir: root });
  assert.strictEqual(ready.available(), true);
  assert.strictEqual(ready.runtimeError(), '');
});

// --- クッキーの引っ越しと取り込み (S4) --------------------------------

test('migrate: 空・旧既定・壊れた既定値は新しい置き場へ貼り替える', () => {
  const root = tempDir('cookie-migrate');
  const target = path.join(root, 'pawchive.st_cookies.txt');
  // 旧い置き場は差し替える。既定のままだと、この試験が利用者本人の実在する
  // クッキーを %TEMP% へ複製してしまう (資格情報を試験の副産物にしない)
  const legacyFile = path.join(root, 'legacy', 'pawchive.st_cookies.txt');
  fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
  fs.writeFileSync(legacyFile, '# Netscape HTTP Cookie File\n');

  for (const stored of ['', legacyFile, pawCookies.BROKEN_COOKIE_FILE]) {
    fs.rmSync(target, { force: true });
    let saved = null;
    const result = pawCookies.migrate({
      stored, defaultFile: target, legacyFile, save: (file) => { saved = file; },
    });
    assert.strictEqual(result.file, target);
    assert.strictEqual(result.changed, true);
    assert.strictEqual(saved, target);
    // 新既定が空なら旧い置き場から引き取る。原本は消さない
    assert.strictEqual(result.copied, true);
    assert.ok(fs.existsSync(legacyFile));
  }
});

test('migrate: 自分で決めた置き場には触らない', () => {
  const root = tempDir('cookie-custom');
  const target = path.join(root, 'pawchive.st_cookies.txt');
  const custom = path.join(root, 'my', 'cookies.txt');
  let saved = null;
  const result = pawCookies.migrate({ stored: custom, defaultFile: target, save: (file) => { saved = file; } });
  assert.strictEqual(result.file, custom);
  assert.strictEqual(result.changed, false);
  assert.strictEqual(result.reason, 'custom');
  assert.strictEqual(saved, null, '設定を書き換えない');
});

test('migrate: 既に新しい置き場を指していれば書き戻さない', () => {
  const root = tempDir('cookie-same');
  const target = path.join(root, 'pawchive.st_cookies.txt');
  let saved = null;
  const result = pawCookies.migrate({ stored: target, defaultFile: target, save: (file) => { saved = file; } });
  assert.strictEqual(result.changed, false);
  assert.strictEqual(saved, null);
});

test('adoptDownloadedCookies: Downloads に落ちた書き出しを置き場へ引き上げる', () => {
  const root = tempDir('cookie-adopt');
  const downloads = path.join(root, 'Downloads');
  fs.mkdirSync(downloads, { recursive: true });
  const source = path.join(downloads, 'pawchive.st_cookies.txt');
  fs.writeFileSync(source, '# Netscape HTTP Cookie File\nnew\n');
  const cookieFile = path.join(root, 'userData', 'pawchive.st_cookies.txt');

  const result = pawCookies.adoptDownloadedCookies({ downloadsDir: downloads, cookieFile });
  assert.strictEqual(result.adopted, true);
  assert.ok(fs.readFileSync(cookieFile, 'utf8').includes('new'));
  assert.ok(!fs.existsSync(source), '資格情報の写しを Downloads に残さない');
});

test('adoptDownloadedCookies: .pw 名でも拾い、既にあるものは置き換える', () => {
  const root = tempDir('cookie-adopt-pw');
  const downloads = path.join(root, 'Downloads');
  fs.mkdirSync(downloads, { recursive: true });
  fs.writeFileSync(path.join(downloads, 'pawchive.pw_cookies.txt'), 'newer\n');
  const cookieFile = path.join(root, 'pawchive.st_cookies.txt');
  fs.writeFileSync(cookieFile, 'older\n');

  const result = pawCookies.adoptDownloadedCookies({ downloadsDir: downloads, cookieFile });
  assert.strictEqual(result.adopted, true);
  assert.strictEqual(fs.readFileSync(cookieFile, 'utf8'), 'newer\n');
});

test('adoptDownloadedCookies: 見つからなければ何もしない', () => {
  const root = tempDir('cookie-adopt-none');
  const downloads = path.join(root, 'Downloads');
  fs.mkdirSync(downloads, { recursive: true });
  const cookieFile = path.join(root, 'pawchive.st_cookies.txt');
  fs.writeFileSync(cookieFile, 'keep me\n');

  const result = pawCookies.adoptDownloadedCookies({ downloadsDir: downloads, cookieFile });
  assert.strictEqual(result.adopted, false);
  assert.strictEqual(fs.readFileSync(cookieFile, 'utf8'), 'keep me\n', '今持っているクッキーは残す');
});

test('adoptDownloadedCookies: 書き出し先そのものを置き場にしていても消さない', () => {
  const root = tempDir('cookie-adopt-same');
  const source = path.join(root, 'pawchive.st_cookies.txt');
  fs.writeFileSync(source, 'keep me\n');

  // Downloads を置き場に選んでいる人がいる: 自分を自分へ引き上げてはいけない
  const result = pawCookies.adoptDownloadedCookies({ downloadsDir: root, cookieFile: source });
  assert.strictEqual(result.adopted, false);
  assert.strictEqual(result.reason, 'same');
  assert.strictEqual(fs.readFileSync(source, 'utf8'), 'keep me\n', '手持ちの証しを消さない');
});

// --- 落ちてきた実体の見立て (paw-bulk / downloader と共有する語彙) ------

// 64 桁の 16 進を種から作る (実体の名に埋まる鍵)
function hashOf(seed) {
  return String(seed).padStart(2, '0').repeat(32).slice(0, 64);
}

test('fileHashOf: 名前に埋まった 64 桁 hex を小文字で返す', () => {
  const hash = hashOf('ab');
  assert.strictEqual(fileHashOf(`${hash}.jpg`), hash);
  assert.strictEqual(fileHashOf(`/data/ab/cd/${hash.toUpperCase()}.png`), hash);
  assert.strictEqual(fileHashOf('cover.jpg'), '');
  assert.strictEqual(fileHashOf(null), '');
});

test('kemonoExt: name があればその名から、無ければ path のベース名から切る', () => {
  // kemono-dl (main.py:588-594) と同じ順・同じ規則
  assert.strictEqual(kemonoExt({ name: '第01話.PNG', path: '/data/ab/cd/xyz.jpg' }), 'png');
  assert.strictEqual(kemonoExt({ name: '', path: '/data/ab/cd/xyz.JPG' }), 'jpg');
  assert.strictEqual(kemonoExt({ path: '/data/ab/cd/xyz.tar.gz' }), 'gz');
  // ドットの無い名は拡張子なし。先頭のドットも拡張子とは見なさない
  assert.strictEqual(kemonoExt({ name: 'no-extension' }), '');
  assert.strictEqual(kemonoExt({ name: '.gitignore' }), '');
  assert.strictEqual(kemonoExt({}), '');
  assert.strictEqual(kemonoExt(null), '');
});

test('collectStaged: 落ち切った実体だけを hash で引ける形にする', () => {
  const dir = tempDir('staged');
  const done = hashOf('01');
  const part = hashOf('02');
  const empty = hashOf('03');
  fs.writeFileSync(path.join(dir, `${done}.jpg`), 'fake-bytes');
  fs.writeFileSync(path.join(dir, `${part}.mp4.part`), 'half');
  fs.writeFileSync(path.join(dir, `${part}.MKV.PART`), 'half');
  fs.writeFileSync(path.join(dir, `${empty}.png`), '');
  fs.writeFileSync(path.join(dir, 'cover.jpg'), 'no hash in the name');
  fs.mkdirSync(path.join(dir, `${hashOf('04')}.dir`));

  const staged = collectStaged(dir);
  assert.deepStrictEqual([...staged.keys()], [done]);
  const entry = staged.get(done);
  assert.strictEqual(entry.file, path.join(dir, `${done}.jpg`));
  assert.strictEqual(entry.ext, '.jpg');
  assert.strictEqual(entry.size, 'fake-bytes'.length);
  assert.strictEqual(entry.broken, false);
});

test('collectStaged: _statuscode416 は broken、_noserverhash は正常扱い', () => {
  const dir = tempDir('staged-suffix');
  const broken = hashOf('05');
  const noserver = hashOf('06');
  fs.writeFileSync(path.join(dir, `${broken}_statuscode416.jpg`), 'incomplete');
  fs.writeFileSync(path.join(dir, `${noserver}_noserverhash.png`), 'complete');

  const staged = collectStaged(dir);
  // 416 はバイト数が合わないと向こうが認めた欠片 (hash 照合を通らない昇格)
  assert.strictEqual(staged.get(broken).broken, true);
  // hash を返さなかっただけで、落ちたバイト列そのものは揃っている
  assert.strictEqual(staged.get(noserver).broken, false);
});

test('collectStaged: 同じ hash が並んだら健全な方を採る', () => {
  const dir = tempDir('staged-dupe');
  const hash = hashOf('07');
  // 名前順で欠片が先に読まれても、取り直した方が勝つ
  fs.writeFileSync(path.join(dir, `${hash}_statuscode416.jpg`), 'incomplete');
  fs.writeFileSync(path.join(dir, `${hash}.jpg`), 'complete');

  const staged = collectStaged(dir);
  assert.strictEqual(staged.size, 1);
  assert.strictEqual(staged.get(hash).broken, false);
  assert.strictEqual(path.basename(staged.get(hash).file), `${hash}.jpg`);
});

test('collectStaged: 置き場が無ければ空の Map (まだ 1 つも落ちていない)', () => {
  const dir = tempDir('staged-none');
  const staged = collectStaged(path.join(dir, 'no-such-dir'));
  assert.ok(staged instanceof Map);
  assert.strictEqual(staged.size, 0);
});

test('collectStaged: エンジンが置いていった実体をそのまま読める', async () => {
  const { engine, outDir } = makeEngine('staged-run');
  const done = hashOf('11');
  const broken = hashOf('12');
  const part = hashOf('13');
  const empty = hashOf('14');
  await engine.run({
    links: ['https://pawchive.st/fanbox/user/1/post/1'],
    outDir,
    filenamePattern: '{hash}.{ext}',
    extraArgs: ['--fake-mode', 'save', '--fake-write', [
      `${done}.jpg`,
      `${broken}_statuscode416.jpg`,
      `${part}.mp4.part`,
      `${empty}.png|empty`,
    ].join(',')],
  });

  const staged = collectStaged(outDir);
  assert.deepStrictEqual([...staged.keys()].sort(), [done, broken].sort());
  assert.strictEqual(staged.get(done).broken, false);
  assert.strictEqual(staged.get(broken).broken, true);
});

// --- 診断可能性 (無言死をなくす) --------------------------------------

test('打ち切り: stdout の進捗だけでもアイドル計は延びる', async () => {
  const { engine, outDir } = makeEngine('stdout-idle');
  const started = Date.now();
  const result = await engine.run({
    links: ['https://pawchive.st/fanbox/user/1/post/1'],
    outDir,
    filenamePattern: '{id}.{ext}',
    // stderr は無音のまま、stdout にだけ進捗を刻む (大物を掴んでいる最中の姿)
    extraArgs: ['--fake-mode', 'progress', '--fake-progress-every', '100', '--fake-progress-count', '12'],
    idleTimeoutMs: 400,
  });
  assert.strictEqual(result.timedOut, false, '転送中の子を無通信と見て殺さない');
  assert.ok(Date.now() - started > 800, '進捗の続く間ずっと生きている');
  assert.ok(result.stdoutTail.some((line) => line.includes('%')), '進捗は末尾に残す');
  assert.strictEqual(result.failure, null);
});

test('致命死: 一枚も触らず非 0 で死んだら failure に言い残しを添える', async () => {
  const { engine, outDir } = makeEngine('die');
  const result = await engine.run({
    links: ['https://pawchive.st/fanbox/user/1/post/1'],
    outDir,
    filenamePattern: '{id}.{ext}',
    extraArgs: ['--fake-mode', 'die', '--fake-exit', '3'],
  });
  assert.strictEqual(result.exitCode, 3);
  assert.ok(result.failure.startsWith('エンジンが異常終了しました (exit 3)'));
  assert.ok(result.failure.includes('ModuleNotFoundError'), '死因の行をそのまま添える');
  assert.ok(result.stderrTail.some((line) => line.startsWith('Traceback')));
});

test('致命死: stdout にしか言い残しが無くても拾う', async () => {
  const { engine, outDir } = makeEngine('die-stdout');
  const result = await engine.run({
    links: ['https://pawchive.st/fanbox/user/1/post/1'],
    outDir,
    filenamePattern: '{id}.{ext}',
    extraArgs: ['--fake-mode', 'die', '--fake-die-where', 'stdout', '--fake-exit', '1'],
  });
  // クッキーの読み損ねもこの形 (向こうは stdout に一行 print して exit する)
  assert.ok(result.failure.includes('ModuleNotFoundError'));
  assert.deepStrictEqual(result.stderrTail, []);
});

test('致命死: 一枚でも触っていれば failure は立てない (成否は成果物で見る)', async () => {
  const { engine, outDir } = makeEngine('die-partial');
  const result = await engine.run({
    links: ['https://pawchive.st/fanbox/user/1/post/1'],
    outDir,
    filenamePattern: '{id}/{filename}.{ext}',
    extraArgs: ['--fake-mode', 'lines', '--fake-exit', '4'],
  });
  assert.strictEqual(result.exitCode, 4);
  assert.strictEqual(result.failure, null, '途中で転んだ走りは異常終了と断じない');
  assert.ok(result.stderrTail.length > 0);
});

test('killActive: アプリを畳むとき、走っている子を置き去りにしない', async () => {
  const { engine, outDir, dump } = makeEngine('kill-active');
  const running = engine.run({
    links: ['https://pawchive.st/fanbox/user/1/post/1'],
    outDir,
    filenamePattern: '{id}.{ext}',
    // 打ち切りは無効 (この子を落とせるのは killActive だけ)
    idleTimeoutMs: 0,
    extraArgs: ['--fake-mode', 'sleep', '--fake-sleep', '30000', '--fake-dump', dump],
  });

  // dump は子が起きた直後に書かれる: 起きるまで待ってから畳む
  const started = Date.now();
  while (!fs.existsSync(dump) && Date.now() - started < 10000) {
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
  assert.ok(fs.existsSync(dump), '子が起きている');
  assert.strictEqual(engine.killActive(), true);

  const result = await running;
  assert.ok(Date.now() - started < 10000, '眠り切る前に落ちる');
  assert.strictEqual(result.cancelled, false);
  assert.strictEqual(killActive(), false, '走っていなければ何もしない');
});
