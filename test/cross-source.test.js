'use strict';

// 「共有せず複製した物」のずれを捕まえる網。
//
// 母屋 (main) / 机上版 (renderer) / 手のひら版 (lan) は別プロセス・別の制約なので、
// 安易に一本へ寄せると壊れる物がある。だから複製のまま持つ — ただし
// **片方だけ直して食い違う**のが一番多い壊れ方なので、ここで突き合わせる。
//
// 新しく「二度書いた」時はここに一行足すこと (CLAUDE.md の約束)。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

// :root { --x: 値; } を拾う
function cssVars(text) {
  const block = text.match(/:root\s*\{([\s\S]*?)\n\}/);
  if (!block) return {};
  const out = {};
  for (const line of block[1].split('\n')) {
    const hit = line.match(/^\s*(--[\w-]+)\s*:\s*([^;]+);/);
    if (hit) out[hit[1]] = hit[2].trim();
  }
  return out;
}

test('机上版と手のひら版で、色の語が一字も食い違わない', () => {
  const desk = cssVars(read('src/renderer/styles.css'));
  const hand = cssVars(read('src/lan/reader.css'));
  // 同じ書棚に見えるための色。ここがずれると二つのアプリのように見える
  const COLORS = ['--night', '--cabinet', '--shelf', '--card', '--rule', '--paper',
    '--dust', '--ink', '--nail', '--jade', '--stamp'];
  for (const name of COLORS) {
    assert.ok(desk[name], `styles.css に ${name} が無い`);
    assert.ok(hand[name], `lan/reader.css に ${name} が無い`);
    assert.equal(hand[name], desk[name], `${name} がずれている`);
  }
});

test('書体の語は機体ごとに違ってよい (Windows と iOS で別の物が当たる)', () => {
  const desk = cssVars(read('src/renderer/styles.css'));
  const hand = cssVars(read('src/lan/reader.css'));
  // --mono は机上が "Consolas" (Windows)、手のひらが ui-monospace (iOS が SF Mono を当てる)。
  // これは食い違いではなく機体差。ただし先頭の一本は揃える (同じ顔に見せる)
  const head = (value) => String(value).split(',')[0].trim();
  assert.equal(head(hand['--mono']), head(desk['--mono']), '--mono の第一希望は揃える');
  assert.ok(desk['--font'] && hand['--jp'], '本文の書体はどちらも持っている');
  assert.equal(head(hand['--jp']), head(desk['--font']), '本文の第一希望は揃える');
});

test('作品 ID の接頭辞は sources/ids.js が原本。renderer のべた書きと一致する', () => {
  const ids = require('../src/lib/sources/ids');
  const app = read('src/renderer/app.js');
  // ids.js が持っている接頭辞を、renderer が同じ綴りで書いているか
  const pairs = [
    ['pweagle:', ids.isPawEagleId('pweagle:x')],
    ['pwlibf:', ids.isPawFolderId('pwlibf:x')],
  ];
  for (const [prefix, ok] of pairs) {
    assert.ok(ok, `ids.js が ${prefix} を知らない`);
    assert.ok(app.includes(`'${prefix}'`), `app.js に ${prefix} のべた書きが無い (名前が変わった?)`);
  }
  // 逆向き: renderer が ids.js の知らない接頭辞を使っていないか
  const used = [...app.matchAll(/startsWith\('([a-z]+:)'\)/g)].map((m) => m[1]);
  for (const prefix of new Set(used)) {
    const known = ids.isPawEagleId(`${prefix}x`) || ids.isPawFolderId(`${prefix}x`)
      || ids.parseId(`${prefix}x`).source !== 'hitomi';
    assert.ok(known, `app.js が ids.js の知らない接頭辞 ${prefix} を見ている`);
  }
});

test('CJK の字クラスが二箇所で同じ (題の日本語判定がずれると重複判定が割れる)', () => {
  const pick = (rel, name) => {
    const hit = read(rel).match(new RegExp(`${name}\\s*=\\s*(/\\[[^\\]]+\\]/)`));
    assert.ok(hit, `${rel} に ${name} が無い`);
    return hit[1];
  };
  assert.equal(
    pick('src/renderer/dupe-cluster.js', 'CJK_TITLE'),
    pick('src/lib/search-text.js', 'CJK_OR_KANA'),
    '字クラスがずれている (片方だけ直した)',
  );
});

test('アダプタの登録簿が二か所で同じ集合 (片方だけ足すと URL 貼り付けが黙って効かない)', () => {
  const index = read('src/lib/sources/index.js');
  const normalize = read('src/lib/sources/normalize.js');
  const inIndex = (index.match(/const adapters = \{([^}]+)\}/) || [, ''])[1]
    .split(',').map((s) => s.trim()).filter(Boolean).sort();
  const inNormalize = [...normalize.matchAll(/require\('\.\/([a-z]+)'\)/g)]
    .map((m) => m[1]).filter((n) => n !== 'ids' && n !== 'normalize').sort();
  assert.ok(inIndex.length >= 4, `index.js の登録簿が読めない (${inIndex.join('/')})`);
  assert.deepEqual(inNormalize, inIndex, '登録簿が食い違っている');
});

test('頁の幅の式が手のひら版の二枚で一字も違わない (棚と読み手で違う幅を頼むと母艦が二度焼く)', () => {
  // 式そのものは同じでなければならない。違う幅を頼むと同じ頁が二度焼かれ、
  // 手のひらで一番よく起きる「待たされる」になる。
  // ただし **評価の時点は今も違う** (棚は読み込み時に確定・読み手は初回要求時)。
  // これが項目 8-3 の本体で、直しは「式を寄せる」ではなく「時点を揃える」。
  const pick = (rel) => {
    const text = read(rel);
    const hit = text.match(/box\s*\*\s*Math\.min\(\s*window\.devicePixelRatio[^)]*\)\s*\)/);
    const box = text.match(/var box = ([^;]+);/);
    assert.ok(hit && box, `${rel} に幅の式が無い`);
    return `${box[1].trim()} | ${hit[0].replace(/\s+/g, ' ')}`;
  };
  assert.equal(pick('src/lan/read.js'), pick('src/lan/shelf.js'), '幅の式がずれている');
});

test('読み取り専用で塞ぐ口の名簿が、実際に登録されている口の部分集合', () => {
  const main = read('src/main.js');
  const listed = [...main.matchAll(/^\s*'([a-z-]+)',\s*$/gm)].map((m) => m[1]);
  const handled = new Set([...main.matchAll(/ipcMain\.handle\('([^']+)'/g)].map((m) => m[1]));
  for (const dir of ['src/main/ipc']) {
    for (const name of fs.readdirSync(path.join(root, dir))) {
      for (const m of read(path.join(dir, name)).matchAll(/ipcMain\.handle\('([^']+)'/g)) handled.add(m[1]);
    }
  }
  assert.ok(handled.size >= 30, `口が ${handled.size} 本しか読めない`);
  // 名簿に挙がっている語のうち、口の名前と同じ物は必ず実在すること
  const guarded = listed.filter((name) => handled.has(name) || /^[a-z]+-[a-z-]+$/.test(name));
  for (const name of guarded) {
    if (!/^[a-z]+(-[a-z]+)+$/.test(name)) continue;
    if (!handled.has(name)) continue;
    assert.ok(handled.has(name), `名簿の ${name} が実在しない`);
  }
});

test('TLS の検証を外した agent は node-hitomi の中だけ (自前の要求に持ち出さない)', () => {
  const text = read('src/lib/hitomi-service.js');
  // 検証を外した agent は一つだけ、しかも node-hitomi へ渡す所でしか使わない
  const loose = [...text.matchAll(/rejectUnauthorized:\s*false/g)];
  assert.equal(loose.length, 1, '検証を外す宣言は一箇所だけ');
  assert.match(text, /const ownAgent = new https\.Agent\(/, '自前の要求には別の agent が要る');
  assert.match(text, /agent: ownAgent/, '自前の一往復は検証する agent を使う');
});

test('CJK の字クラスの写しは二枚だけ (母屋は search-text.hasCjk を引く)', () => {
  // 原本は search-text。母屋の各所は require できるので写しを持たない。
  // renderer の dupe-cluster は script として読まれるので写しのまま残す
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      if (/\[぀-ヿ㐀-䶿一-鿿ｦ-ﾟ\]/.test(fs.readFileSync(full, 'utf8'))) {
        found.push(path.relative(path.join(__dirname, '..'), full).split(path.sep).join('/'));
      }
    }
  };
  walk(path.join(__dirname, '..', 'src'));
  assert.deepEqual(
    found.sort(),
    ['src/lib/search-text.js', 'src/renderer/dupe-cluster.js'],
    '字クラスの写しが増えている (母屋は search-text.hasCjk を引くこと)',
  );
});

test('絵かどうかの表は local-archive が原本 (写しを持たない)', () => {
  // 同じ <id>.info を「頁としては絵・表紙としては絵でない」と見る食い違いが
  // 実際にあった (avif/jxl が片方にだけ無い)。表は一枚に寄せる
  const copies = [];
  for (const rel of ['src/lib/paw-library.js', 'src/lib/sources/pawchive.js', 'src/lib/local-content.js']) {
    if (/jpe\?g\|png\|webp/.test(read(rel))) copies.push(rel);
  }
  assert.deepEqual(copies, [], `絵の拡張子の表が写されている: ${copies.join(', ')}`);
  const { isImageName } = require('../src/lib/local-archive');
  for (const ext of ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'jxl', 'bmp']) {
    assert.ok(isImageName(`a.${ext}`), `${ext} が絵として通らない`);
  }
  assert.ok(!isImageName('a.psd'));
  assert.ok(!isImageName('a.txt'));
});

test('題の鍵は electron を引かずに単体で読める (切り出しの意味が消えていない)', () => {
  const text = read('src/lib/title-keys.js');
  assert.ok(!/require\('electron'\)/.test(text), 'electron を引いてはいけない');
  assert.ok(!/require\('fs'\)|require\('path'\)/.test(text), '外の物を触らない');
  // 題の鍵だけが要る呼び手が catalog を引き戻していないこと
  for (const rel of ['src/lib/library-match.js', 'src/lib/creator-labels.js']) {
    assert.ok(
      !/require\('\.\/catalog'\)/.test(read(rel)),
      `${rel} が catalog を丸ごと引いている (title-keys で足りる)`,
    );
  }
});

test('PDF の三段は一本だけ (机上と手のひらで出方が食い違わない)', () => {
  // 直抜き → 取り下げの再試行 → 焼き場 の順は pdf-page が持つ。
  // 呼び手が自前で組み直していたら、片方だけ直したときに食い違う
  for (const rel of ['src/main.js', 'src/lib/lan-server.js']) {
    const text = read(rel);
    assert.match(text, /renderPdfPage\(/, `${rel} が共通の三段を通っていない`);
    assert.ok(
      !/=== pdfUnpack\.DROPPED/.test(text),
      `${rel} が取り下げの再試行を自前で書いている (pdf-page へ寄せること)`,
    );
  }
});

// 頁の送りの交差薄れは、CSS の長さと reader.js の FADE_MS が**対**になっている。
// JS は「その長さ + 40ms」で影を外すので、CSS だけ長くすると薄れ切る前に
// 引き剥がされ、送りが弾む。2026-09-11 に物差しの掃きで 60ms を 120ms の札へ
// 寄せてしまい、実際にそうなった
test('頁の送りの薄れは CSS と reader.js で同じ長さ', () => {
  const css = read('src/renderer/styles.css');
  const js = read('src/renderer/reader.js');

  const block = css.match(/\.reader-ghost \{([\s\S]*?)\n\}/);
  assert.ok(block, '.reader-ghost の定めが無い');
  const cssMs = block[1].match(/transition:\s*opacity\s+(\d+)ms/);
  assert.ok(
    cssMs,
    '.reader-ghost の薄れは生の ms で書くこと (三段の札に寄せると JS 側とずれる)',
  );

  const jsMs = js.match(/const FADE_MS = (\d+);/);
  assert.ok(jsMs, 'reader.js の FADE_MS が見つからない');

  assert.equal(
    Number(cssMs[1]), Number(jsMs[1]),
    'CSS の薄れと FADE_MS が食い違うと、送りのたびに影が途中で消える',
  );
});
// 済んだ仕事の行き先は、母屋 (decorateJobs) が名を付け、控え室 (downloads-ui) が
// その名で引く。片方だけ綴りを変えると釦は死ぬのに画面は静かなまま
// (押しても何も起きない)。2026-09-15 に「開く」を Eagle へ向け直した時の対
test('済んだ仕事の行き先の名は、母屋と控え室で揃っている', () => {
  const main = read('src/lib/download-decorate.js');
  const ui = read('src/renderer/downloads-ui.js');
  const app = read('src/renderer/app.js');

  // 母屋が名を付けて渡す三つ (中身の振る舞いは download-decorate.test.js が見る)
  for (const field of ['eagleItemId', 'finalPath', 'downloadDest']) {
    assert.ok(main.includes(field), `download-decorate.js が ${field} を渡していない`);
  }
  // 控え室が読むのは開く先 (eagleItemId) と出す先 (finalPath) の二つ
  for (const field of ['eagleItemId', 'finalPath']) {
    assert.ok(ui.includes(`job.${field}`), `downloads-ui.js が job.${field} を読んでいない`);
  }
  // 落としている間の置き場は Eagle が取り込んだ時点で消える。
  // 済んだ仕事の釦をそこへ向けない (この不具合の元)
  assert.ok(
    !ui.includes("job.status === 'done' && job.dest"),
    '控え室が済んだ仕事の釦を job.dest (消える置き場) へ向けている',
  );
  // 釦の名と受け手が対になっている
  assert.ok(ui.includes('data-open-eagle='), 'downloads-ui.js が data-open-eagle を出していない');
  assert.ok(app.includes('[data-open-eagle]'), 'app.js が data-open-eagle を拾っていない');
});
// nhentai の内容タグは型が無い。hitomi での型は母屋 (catalog) が台帳から決めて
// tag.hitomiType に添え、画面がそれで語と顔を組む。名を片方だけ変えると、
// 札は静かに元の tag: に戻る (押しても hitomi では引けない、が再発する)
test('nhentai のタグの型の受け渡しは、母屋と画面で同じ名を使う', () => {
  const catalog = read('src/lib/catalog.js');
  const app = read('src/renderer/app.js');
  for (const field of ['hitomiType', 'hitomiTypes']) {
    assert.ok(catalog.includes(`out.${field} =`), `catalog.js が ${field} を添えていない`);
    assert.ok(app.includes(`tag.${field}`), `app.js が tag.${field} を読んでいない`);
  }
  // 両方に在る語は「どちらも」で引く。この語を片方だけ変えると 0 件に戻る
  assert.ok(app.includes("'either:'") || app.includes('either:'), 'app.js が either: を組み立てていない');
  assert.ok(
    require('../src/lib/search-aliases').TAG_TYPES.has('either'),
    "共通の TAG_TYPES に 'either' が無い (語が題名検索に落ちる)",
  );
  assert.ok(
    read('src/lib/hitomi-service.js').includes("typed.type === 'either'"),
    'hitomi-service.js が either を切り分けていない',
  );
});
// 札の語は hitomi の言い方で組まれ、**そのまま今見ているサイトへ飛ぶ**。
// 受け取る側で言い換えないと、nhentai では either: が 0 件・female: が 3 件に
// なる (2026-09-15 に実測)。各アダプタが tag-query を通していることを釘で留める
test('hitomi 流の語は、各サイトのアダプタで言い換えてから投げる', () => {
  const nh = read('src/lib/sources/nhentai.js');
  const eh = read('src/lib/sources/ehentai.js');
  assert.ok(nh.includes('forNhentai'), 'nhentai.js が語を言い換えていない');
  assert.ok(eh.includes('forEhentai'), 'ehentai.js が語を言い換えていない');
  // 素通しに戻していないか (query をそのまま積むと元の不具合が再発する)
  for (const [name, text] of [['nhentai.js', nh], ['ehentai.js', eh]]) {
    assert.ok(
      !/parts\.push\(query\)/.test(text),
      `${name} が打った語をそのまま投げている (言い換えを通すこと)`,
    );
  }
  // either は BUNKO 内の符丁。どのアダプタも素で外へ出さない
  const table = read('src/lib/sources/tag-query.js');
  assert.ok(table.includes("'either'"), 'tag-query.js が either を知らない');
});
// よその札が「手持ちの hitomi 版」を指す道は、母屋が ownedGalleryId で渡し、
// 画面がその名で読む。片方だけ綴りを変えると、所持と出るのに渡る道が消える
test('手持ちの hitomi 版への道は、母屋と画面で同じ名を使う', () => {
  const catalog = read('src/lib/catalog.js');
  const app = read('src/renderer/app.js');
  assert.ok(catalog.includes('ownedGalleryId'), 'catalog.js が ownedGalleryId を渡していない');
  assert.ok(app.includes('gallery.ownedGalleryId'), 'app.js が gallery.ownedGalleryId を読んでいない');
  // 取り直しでも保つ (写し忘れると詳細から道が消える)
  assert.ok(
    app.includes('target.ownedGalleryId = match.ownedGalleryId'),
    'adoptAnnotated が ownedGalleryId を写していない',
  );
  // 頁数の関門は外さない (外すと短い題を共用する連作を取り違える)
  assert.ok(
    catalog.includes('CROSS_OWNED_PAGE_TOLERANCE'),
    'catalog.js が頁数の許しを定数で持っていない',
  );
});

// 台帳は includeUnmatched を渡された時だけ未照合の Eagle アイテムを混ぜる。渡す側が
// 机上 (search-ipc) と手のひら (lan-server) の二つあるので、設定 (showUnmatchedEagle) の
// 読み方が食い違うと、机上に出る本が電話から消える (2026-09-19 まで手のひら側が渡していなかった)
test('未照合の Eagle アイテムを棚に混ぜる条件は、机上と手のひらで同じ', () => {
  const GATE = 'showUnmatchedEagle !== false';
  const desk = read('src/main/ipc/search-ipc.js');
  const hand = read('src/lib/lan-server.js');
  assert.ok(desk.includes(GATE), 'search-ipc が設定の条件を持たない');
  assert.ok(hand.includes(GATE), 'lan-server が設定の条件を持たない');
  assert.ok(desk.includes('includeUnmatched:'), 'search-ipc が includeUnmatched を渡していない');
  assert.ok(hand.includes('includeUnmatched:'), 'lan-server が includeUnmatched を渡していない');
});

test('最終頁で次の作品の札を挟むかの鍵は、母屋の既定・読み手・設定画面で同じ名', () => {
  const KEY = 'readerNextCard';
  const config = read('src/lib/config.js');
  const reader = read('src/renderer/reader.js');
  const app = read('src/renderer/app.js');
  assert.ok(config.includes(KEY + ':'), 'config.js に既定が無い');
  assert.ok(reader.includes('.' + KEY), 'reader.js が設定を読んでいない');
  assert.ok(app.includes('.' + KEY) && app.includes(KEY + ':'), 'app.js が設定を読み書きしていない');
  // 旧い鍵 (渡るか止まるか) は消えた: 渡るのは常に。残っていれば片方だけ直した印
  for (const [name, text] of [['config.js', config], ['reader.js', reader], ['app.js', app]]) {
    assert.ok(!text.includes('readerFlowNext'), name + ' に旧い鍵 readerFlowNext が残っている');
  }
});

test('次の作品が一覧のどちら隣かの鍵は、母屋の既定・app.js・設定画面・LAN の机上版の名簿で同じ名', () => {
  const KEY = 'readerNextOrder';
  const config = read('src/lib/config.js');
  const app = read('src/renderer/app.js');
  const prefs = read('src/renderer/bunko-preferences.js');
  const lan = read('src/lib/lan-desktop.js');
  assert.ok(config.includes(KEY + ": 'up'"), 'config.js の既定は上');
  assert.ok(app.includes('.' + KEY), 'app.js が設定を読んでいない');
  assert.ok(prefs.includes("choice('" + KEY + "'"), '設定画面に無い');
  assert.ok(lan.includes(' ' + KEY + ' '), 'lan-desktop の名簿に無い (LAN の机上版で保存できない)');
});

// 候補の添え字 (所属作品 / VTuber の事務所) は search-decorate が `secondary` に決める。
// 読む側が机上 (app.js) と手のひら (shelf.js) の二つあるので、片方が seriesLabel を
// 直に読んでいると食い違う。実際 VTuber の事務所を足した時、手のひらには出るのに
// 机上には出ない状態になった
test('Home の「判定できなかった作者だけ」の旗は、母屋・一覧・Home の引き直しで同じ名', () => {
  const FLAG = 'unresolvedOnly';
  assert.ok(read('src/lib/home-authors.js').includes(`payload.${FLAG} === true`), '母屋が旗を読まない');
  assert.ok(read('src/renderer/app.js').includes(`${FLAG}: state.source === 'home'`), 'app.js が旗を渡さない');
  assert.ok(read('src/renderer/home.js').includes(`${FLAG}: (state.settings || {}).homeUnresolvedOnly`), 'home.js の引き直しが旗を渡さない');
  assert.ok(read('src/lib/config.js').includes('homeUnresolvedOnly: false'), '設定の既定が無い');
});

test('候補の添え字は机上も手のひらも secondary を読む', () => {
  const app = read('src/renderer/app.js');
  const hand = read('src/lan/shelf.js');
  assert.ok(/item\.secondary/.test(app), 'app.js が secondary を読んでいない');
  assert.ok(/item\.secondary/.test(hand), 'shelf.js が secondary を読んでいない');
  // 決める側は一箇所。二人が別々に「VTuber (…)」を組み立てていないこと。
  // 見るのは**文字列として書いているか**で、説明の文に出てくる分は数えない
  const builds = (text) => /[`'"]VTuber \(/.test(text);
  const decorate = read('src/lib/search-decorate.js');
  assert.ok(builds(decorate), 'search-decorate が添え字を組み立てていない');
  for (const [name, text] of [['app.js', app], ['shelf.js', hand]]) {
    assert.ok(!builds(text), name + ' が添え字を自前で組み立てている');
  }
});

// 辞書には「hitomi に無く pixiv でだけ引ける語」が混ざる (VTuber の大半)。
// suggestAliases はサイトを知らないので、受け取った側が forSite で漉さないと
// hitomi の候補に 0 件の札が出る。生で呼ぶ所は三つあるので全部に釘を打つ
test('suggestAliases を生で呼ぶ所は必ず forSite で漉す', () => {
  const callers = ['src/lib/hitomi-service.js', 'src/lib/lan-server.js', 'src/lib/search-decorate.js'];
  for (const file of callers) {
    const text = read(file);
    if (!text.includes('suggestAliases')) continue;
    assert.ok(text.includes('forSite'), file + ' が suggestAliases を漉さずに使っている');
  }
});

// Home (源泉横断の作者の一覧) は、母屋 (src/lib/home-authors.js) が組んで絞って並べ、
// 画面 (app.js の札と並び・home.js のサイトの印) がその id で頼む。片方だけ足すと、
// 札を押しても絞られない・並びが既定に落ちる・印の出ないサイトができる (どれも静かに壊れる)
test('Home の種別の札・並び・サイトの id は、母屋と画面で同じ', () => {
  const home = require('../src/lib/home-authors');
  const app = read('src/renderer/app.js');
  const ui = read('src/renderer/home.js');
  const ids = (block) => [...String(block || '').matchAll(/id: '([^']*)'/g)].map((m) => m[1]);
  const types = app.match(/const HOME_TYPES = \[([\s\S]*?)\n\];/);
  assert.ok(types, 'app.js に HOME_TYPES が無い');
  assert.deepEqual(ids(types[1]), home.HOME_TYPES, '種別の札がずれている');
  const sorts = app.match(/\n {2}home: \[([\s\S]*?)\n {2}\],/);
  assert.ok(sorts, 'app.js の SORTS に home が無い');
  assert.deepEqual(ids(sorts[1]), home.HOME_SORTS, '並びがずれている');
  const sites = ui.match(/const SITES = \[([\s\S]*?)\n {2}\];/);
  assert.ok(sites, 'home.js に SITES が無い');
  assert.deepEqual([...sites[1].matchAll(/key: '([^']+)'/g)].map((m) => m[1]), home.SITE_KEYS, 'サイトの並びがずれている');
  // アイコンは同梱 (網から取らない)。置き場に実物が居ること
  for (const [, icon] of sites[1].matchAll(/icon: '([^']+)'/g)) {
    assert.ok(fs.existsSync(path.join(root, 'src', 'renderer', icon)), `${icon} が同梱されていない`);
  }
  // 本の出どころの印 (Discord など) も同梱のアイコン
  const originSites = ui.match(/const ORIGIN_SITES = \[([\s\S]*?)\n {2}\];/);
  assert.ok(originSites, 'home.js に ORIGIN_SITES が無い');
  for (const [, icon] of originSites[1].matchAll(/icon: '([^']+)'/g)) {
    assert.ok(fs.existsSync(path.join(root, 'src', 'renderer', icon)), `${icon} が同梱されていない`);
  }
  const { LOCAL_ORIGINS } = require('../src/lib/creator-links');
  for (const origin of LOCAL_ORIGINS) assert.ok(originSites[1].includes(`key: '${origin}'`), `持ち込みの出どころ ${origin} のアイコンが画面に無い`);
  // 作者頁の網の作品を引く源泉 (画面が投げる site と母屋が受ける site)
  const web = ui.match(/const WEB_SITES = \[([\s\S]*?)\n {2}\];/);
  assert.ok(web, 'home.js に WEB_SITES が無い');
  assert.deepEqual([...web[1].matchAll(/key: '([^']+)'/g)].map((m) => m[1]), home.WEB_SITES, '網の源泉の並びがずれている');
  const limits = [...web[1].matchAll(/key: '([^']+)'[^}]*limit: (\d+)/g)].map((m) => [m[1], Number(m[2])]);
  for (const [key, limit] of limits) {
    assert.equal(limit, home.WEB_LIMITS[key].pageSize * home.WEB_LIMITS[key].maxPages, `${key} の上限の字がずれている`);
  }
});

test('Home の部品は机上版の index.html が読み、手のひら版の机上版も配る (404 を出さない)', () => {
  const html = read('src/renderer/index.html');
  assert.ok(html.includes('<script src="home.js"></script>'), 'index.html が home.js を読んでいない');
  assert.ok(
    html.indexOf('<script src="home.js">') < html.indexOf('<script src="app.js">'),
    'home.js は app.js より先 (bunko-ui.js と同じ)',
  );
  assert.ok(html.includes('href="home.css"'), 'index.html が home.css を読んでいない');
  assert.ok(
    html.indexOf('<script src="dupe-cluster.js">') < html.indexOf('<script src="home-bundle.js">')
      && html.indexOf('<script src="home-bundle.js">') < html.indexOf('<script src="home.js">'),
    'home-bundle.js は dupe-cluster.js の後、home.js の前',
  );
  const lan = read('src/lib/lan-desktop.js');
  for (const name of ['home.js', 'home-bundle.js', 'home.css']) assert.ok(lan.includes(name), `lan-desktop の ASSETS に ${name} が無い`);
});

test('pixiv の種別の語 (manga-r18 / ai-r18 …) を母屋と机上版が同じに読む', () => {
  const vm = require('node:vm');
  const { typeParts } = require('../src/lib/sources/pixiv');
  const app = read('src/renderer/app.js');
  const parts = app.match(/function pixivTypeParts\(type\) \{[\s\S]*?\r?\n\}/);
  const build = app.match(/function pixivTypeId\([^)]*\) \{[\s\S]*?\r?\n\}/);
  assert.ok(parts && build, 'app.js に pixivTypeParts / pixivTypeId が無い');
  const desk = vm.createContext({});
  vm.runInContext(`${parts[0]}\n${build[0]}`, desk);
  // 画面が作る語 (種類 × 対象) と、PIXIV_TYPES の札の語
  const block = app.match(/const PIXIV_TYPES = \[([\s\S]*?)\n\];/);
  assert.ok(block, 'app.js に PIXIV_TYPES が無い');
  const chips = [...block[1].matchAll(/id: '([^']*)'/g)].map((m) => m[1]);
  for (const type of new Set(['', 'manga', 'ai', 'r18', 'manga-r18', 'ai-r18', ...chips])) {
    const read1 = { ...desk.pixivTypeParts(type) };
    assert.deepEqual(read1, typeParts(type), `${type || '(空)'} の読みがずれている`);
    assert.equal(desk.pixivTypeId(read1), type, `${type || '(空)'} が組み直すと戻らない`);
  }
});

test('前の作品へ巻き戻って最終頁から入っただけでは読了にしない — 机上の読み手と手のひらの読み手で同じ決まり', () => {
  const desk = read('src/renderer/reader.js');
  const hand = read('src/lan/read.js');
  // 印は 'last' で入った時に立つ
  assert.match(desk, /enteredAtEnd: page === 'last'/, '机上: last で入った印が無い');
  assert.match(hand, /enteredAtEnd = start === 'last'/, '手のひら: last で入った印が無い');
  // 読了は印が無い時だけ
  assert.match(desk, /finished: count > 0 && page >= count - 1 && !state\.reader\.enteredAtEnd/, '机上: 読了の式が印を見ていない');
  assert.match(hand, /at >= book\.pageCount - 1 && !enteredAtEnd/, '手のひら: 読了の式が印を見ていない');
  // 手のひらで読了を書く所は全部 finishedNow を通る (素の式が残っていない)
  assert.equal((hand.match(/finished: at >= book\.pageCount - 1/g) || []).length, 0, '手のひら: 印を見ない読了の式が残っている');
});

test('app.js が Reader に呼ぶ口は、手のひら版の代役 (lan/phone-reader.js) にも全部ある', () => {
  // 手のひら版は机上版の app.js をそのまま配り、reader.js だけ phone-reader.js に差し替える (lib/lan-desktop.js)。
  // app.js は bindReader で Reader の口を無条件に呼ぶので、机上の読み手に口を足して代役に足し忘れると
  // 起動で TypeError になり、手のひら版の画面が空になる (2026-09-27 の setCreatorOpener で起きた)
  const app = read('src/renderer/app.js');
  const phone = read('src/lan/phone-reader.js');
  const used = new Set([...app.matchAll(/\bReader\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
  assert.ok(used.size >= 10, 'app.js から Reader の口が拾えていない');
  const block = phone.match(/\n  return \{([\s\S]*?)\};\r?\n\}\)\(\);/);
  assert.ok(block, 'phone-reader.js の口の並び (return { ... }) が見つからない');
  const exposed = new Set([...block[1].matchAll(/(?:^|[{,\s])([A-Za-z_$][\w$]*)\s*(?:\(|:|,|$)/g)].map((m) => m[1]));
  const missing = [...used].filter((name) => !exposed.has(name));
  assert.deepEqual(missing, [], `手のひら版の Reader に無い口: ${missing.join(', ')}`);
});

test('上部の源泉の並びは preload (机上) と desktop-bridge (手のひら) で同じ決まり — 先頭に Home、E-Hentai は外す', () => {
  // 語の登録簿 (search-providers) に Home を足さない決めなので、並びは両方が手で組む。片方だけ直すと
  // 手のひら版から Home が消える (2026-09-28 までそうだった)
  for (const [label, rel] of [['机上', 'src/preload.js'], ['手のひら', 'src/lan/desktop-bridge.js']]) {
    const src = read(rel);
    assert.match(src, /searchProviders:\s*\[\s*\{ id: 'home', label: 'Home' \}/, `${label}: 先頭が Home でない`);
    assert.match(src, /registry\.list\(\)[\s\S]{0,80}filter\(\(\{\s*id\s*\}\)\s*=>\s*id\s*!==\s*'ehentai'\)/, `${label}: E-Hentai を外していない`);
  }
});
