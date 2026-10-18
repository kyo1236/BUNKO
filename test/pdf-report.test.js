'use strict';

// 綴じ上がりの報告と、その読み方 (項目 9-11)。
//
// このアプリで唯一の取り返しのつかない失敗は「白紙の頁を含む PDF を完成として
// 返し、その後ろで原本を消す」こと。以前は pdf-builder が
//   img.decode().catch(() => {})
// で開けなかった頁を握り潰し、呼び手 3 つ (取り込み・一括保存・zip) が
// そのまま原本を片付けていた。
//
// 今は buildPdf が「何頁のうち何頁開けたか」を返すだけで、消してよいかは
// ensureComplete が決める。判じを電子の窓 (pdf-builder) から分けてあるのは、
// 試験が窓を差し替えたときに判じまで消えないようにするため。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ensureComplete, makeReport } = require('../src/lib/pdf-report');

test('欠けの無い報告はそのまま通す', () => {
  const report = makeReport('a.pdf', 3, []);
  assert.deepEqual(report, {
    dest: 'a.pdf', total: 3, decoded: 3, failed: [], published: true,
  });
  assert.equal(ensureComplete(report), report);
});

// 2026-09-11 の事故。開けない頁があるのに PDF を本番の名前に据えてから投げて
// いたので、積み直しのたびに uniqueName が次の番号を取り、同じ作品が 6 冊
// 棚に出た。判じの正しさとは別に「据える順序」が要る
test('欠けた綴じ上がりは据えない (published:false を言う)', () => {
  const report = makeReport('a.pdf', 20, [3, 11], false);
  assert.equal(report.published, false, '据えていないことが報告に出る');
});

test('欠けの例外には印が付く (網の不調と区別して、控えを捨ててから積み直せる)', () => {
  const report = makeReport('a.pdf', 20, [3, 11], false);
  assert.throws(() => ensureComplete(report), (error) => {
    assert.equal(error.incompletePdf, true);
    assert.deepEqual(error.failedPages, [3, 11], '捨てる控えの番号が分かる');
    return true;
  });
});

// 2026-09-11 の二つ目の事故。頁の検めを `Promise.all` で一斉に走らせていたので、
// 大きな作品では後ろの数枚だけが必ず弾かれ、「取れているのに毎回失敗する」形に
// なっていた (2071x2880 の頁は開くと約 24MB。33 枚で 790MB を同時に抱える)。
// バイトは正常な WebP で、刷る段は一頁ずつ描くので問題なく刷れていた —
// 事前の検めだけが落ちていた。実測 33 頁中うしろ 3 枚 / 別の作品では 5 枚・9 枚
test('頁の検めは一枚ずつ開く (一斉に開くと後ろの数枚が必ず弾かれる)', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'pdf-builder.js'), 'utf8');
  const script = text.match(/const DECODE_SCRIPT = `([\s\S]*?)`;/);
  assert.ok(script, 'DECODE_SCRIPT が見つからない');
  assert.ok(
    !/Promise\.all\(\[\.\.\.document\.images\]/.test(script[1]),
    '一斉に開いてはいけない: 画の置き場が尽きて、後ろの頁が壊れていると誤って数えられる',
  );
  assert.match(
    script[1], /for \(let i = 0; i < imgs\.length/,
    '一枚ずつ回して開くこと',
  );
  assert.match(script[1], /await img\.decode\(\)/, '一枚ごとに開き終わるまで待つこと');
});

// 実装が「検めてから据える」順序を守っているかを字面で見る。
// 本物の renderPdf は BrowserWindow が要るのでここでは踏めないが、
// rename が decode の判定の外に出たら気付ける。
//
// **道は二つある** (直に据える / 隠し窓で焼く)。据える所も二つなので、
// 片方だけ見ていると、もう片方が半端な PDF を棚に出しても気付けない
function builderText() {
  return fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'pdf-builder.js'), 'utf8');
}

test('pdf-builder は failed を見てから rename する (隠し窓の道)', () => {
  const text = builderText();
  const bake = text.slice(text.indexOf('async function renderPdf'), text.indexOf('async function writeDirect'));
  const at = bake.indexOf('fs.renameSync(partPath, dest)');
  assert.ok(at > 0, '隠し窓の道に rename が見つからない');
  assert.ok(
    /if \(failed\.length\)/.test(bake.slice(0, at)),
    'rename の手前に failed の判定が無い = 欠けたまま据えている',
  );
});

test('直に据える道は、綴じ手が投げたら rename に辿り着かない', () => {
  const text = builderText();
  const direct = text.slice(text.indexOf('async function writeDirect'), text.indexOf('async function buildPdf'));
  const at = direct.indexOf('fs.renameSync(partPath, dest)');
  assert.ok(at > 0, '直の道に rename が見つからない');
  const before = direct.slice(0, at);
  // 綴じ手が投げた時に握り潰すと、書きかけの .part を本番の名前に据えてしまう
  assert.match(before, /catch \(error\) \{[\s\S]*throw error;[\s\S]*\}/, '綴じ手の失敗を投げ直すこと');
  // 直の道に「開けなかった頁」は無い: 据えられない頁はここまで来ずに投げるので、
  // 報告は必ず「全頁そろって棚に出した」になる
  assert.match(direct, /makeReport\(dest, pages\.length, \[\], true\)/,
    '直の道は全頁そろった報告だけを返すこと');
});

test('焼き場へ下がるのは「据えられない形」の時だけ', () => {
  const text = builderText();
  const build = text.slice(text.indexOf('async function buildPdf'));
  assert.match(
    build, /if \(!error \|\| !error\.cannotEmbed\) throw error;/,
    '書けない・場所が無いといった本当の失敗で隠し窓に回すと、重い道で同じ所に転ぶだけ',
  );
  assert.ok(
    build.indexOf('writeDirect') < build.indexOf('renderPdf'),
    'まず直に据えること',
  );
});

test('一頁でも開けなければ投げる。何頁のうち何頁かを言い、原本を残すと言う', () => {
  const report = makeReport('a.pdf', 20, [3, 11]);
  assert.equal(report.decoded, 18);
  assert.throws(() => ensureComplete(report, 'PDF 生成'), (error) => {
    assert.match(error.message, /20 頁のうち 2 頁/);
    assert.match(error.message, /原本は消さずに残します/);
    assert.match(error.message, /^PDF 生成/);
    return true;
  });
});

test('古い形 (報告を返さない差し替え) でも落とさない', () => {
  assert.equal(ensureComplete(undefined), undefined);
  assert.equal(ensureComplete('a.pdf'), 'a.pdf');
  assert.doesNotThrow(() => ensureComplete({ dest: 'a.pdf' }), 'failed が無い物は通す');
});

test('呼び手 3 つがどれも判じを通している (片方だけ直す形になっていない)', () => {
  const root = path.join(__dirname, '..');
  const callers = ['src/lib/downloader.js', 'src/lib/paw-bulk.js', 'src/lib/paw-zip-pdf.js'];
  for (const rel of callers) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    assert.match(text, /require\('\.\/pdf-report'\)/, `${rel} が判じを引いていない`);
    assert.match(text, /ensureComplete\(/, `${rel} が判じを通していない`);
    // buildPdf の返りを捨てていないこと (await buildPdf(...) を裸で書くと元に戻る)
    assert.ok(
      !/^\s*await buildPdf\(/m.test(text),
      `${rel} が buildPdf の報告を捨てている (ensureComplete を通すこと)`,
    );
  }
});

test('隠し窓の仕事すべてに期限がある (返らない窓で綴じ場が永久に詰まらない)', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'pdf-builder.js'), 'utf8');
  for (const call of ['loadFile', 'executeJavaScript', 'printToPDF']) {
    const hit = new RegExp(`withTimeout\\([^;]*${call}`, 's').test(text);
    assert.ok(hit, `${call} に期限が無い`);
  }
});
