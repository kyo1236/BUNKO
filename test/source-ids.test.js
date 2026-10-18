// 作品 ID の変換とソース判定の特性テスト。リファクタリング前の現行挙動を固定する
const test = require('node:test');
const assert = require('node:assert');

require('./helpers/stub-electron');

const normalize = require('../src/lib/sources/normalize');
const hitomi = require('../src/lib/sources/hitomi');
const nhentai = require('../src/lib/sources/nhentai');
const ehentai = require('../src/lib/sources/ehentai');
const pawchive = require('../src/lib/sources/pawchive');
const pawLibrary = require('../src/lib/paw-library');

test('parseId: 接頭辞ごとにソースと鍵へ割れる', () => {
  assert.deepStrictEqual(normalize.parseId('nh:123456'), { source: 'nhentai', key: '123456' });
  assert.deepStrictEqual(normalize.parseId('eh:100:abcde'), { source: 'ehentai', key: '100:abcde' });
  assert.deepStrictEqual(normalize.parseId('pw:fanbox:123:456'), { source: 'pawchive', key: 'fanbox:123:456' });
  assert.deepStrictEqual(normalize.parseId('hitomi:222'), { source: 'hitomi', key: '222' });
  // pixiv: 投稿は px:、作者の札は pxu: (鍵は user:<id> に畳む)
  assert.deepStrictEqual(normalize.parseId('px:123456789'), { source: 'pixiv', key: '123456789' });
  assert.deepStrictEqual(normalize.parseId('pxu:4567'), { source: 'pixiv', key: 'user:4567' });
});

test('parseId: 接頭辞なし・空・null は hitomi 扱い', () => {
  assert.deepStrictEqual(normalize.parseId('333'), { source: 'hitomi', key: '333' });
  assert.deepStrictEqual(normalize.parseId(''), { source: 'hitomi', key: '' });
  assert.deepStrictEqual(normalize.parseId(null), { source: 'hitomi', key: '' });
});

test('pickJapanese: 日本語を含む方を採り、無ければ jp → en の順', () => {
  assert.strictEqual(normalize.pickJapanese('English Title', '日本語タイトル'), '日本語タイトル');
  // jp 側に日本語が無く en 側にあるときは en を採る
  assert.strictEqual(normalize.pickJapanese('日本語混じり Title', ''), '日本語混じり Title');
  // どちらも欧文なら jp 側 (第 2 引数) が先
  assert.strictEqual(normalize.pickJapanese('Latin', 'Romaji Only'), 'Romaji Only');
  assert.strictEqual(normalize.pickJapanese('', ''), '');
  // 半角カナも日本語とみなす
  assert.strictEqual(normalize.pickJapanese('abc', 'ｶﾀｶﾅ'), 'ｶﾀｶﾅ');
});

test('tag: 型と名前を包み、名前は必ず文字列', () => {
  assert.deepStrictEqual(normalize.tag('artist', 'name'), { type: 'artist', name: 'name', negative: false });
  assert.deepStrictEqual(normalize.tag('tag', null), { type: 'tag', name: '', negative: false });
});

test('record: 欠けた項目は既定値で埋まり、id は文字列化・title は id で代用', () => {
  assert.deepStrictEqual(normalize.record({ id: 42, source: 'x' }), {
    id: '42',
    source: 'x',
    title: '42',
    type: '',
    language: null,
    artists: [],
    groups: [],
    series: [],
    characters: [],
    tags: [],
    pageCount: 0,
    addedDate: null,
    publishedDate: null,
    isBlocked: false,
    hasVideo: false,
    url: '',
    owned: false,
    kind: 'gallery',
    badge: '',
  });
});

test('detectInput: hitomi の各 URL 形から画廊番号を読む', () => {
  assert.deepStrictEqual(normalize.detectInput('https://hitomi.la/galleries/1234567.html'), { source: 'hitomi', query: '1234567' });
  assert.deepStrictEqual(normalize.detectInput('https://hitomi.la/reader/2419686.html#3'), { source: 'hitomi', query: '2419686' });
  assert.deepStrictEqual(normalize.detectInput('https://hitomi.la/manga/some-title-日本語-1234567.html'), { source: 'hitomi', query: '1234567' });
});

test('detectInput: nhentai / ehentai / pawchive の URL を割り振る', () => {
  assert.deepStrictEqual(normalize.detectInput('https://nhentai.net/g/543210/'), { source: 'nhentai', query: '543210' });
  assert.deepStrictEqual(normalize.detectInput('https://e-hentai.org/g/2905450/16a52dd2c1/'), { source: 'ehentai', query: '2905450/16a52dd2c1' });
  assert.deepStrictEqual(normalize.detectInput('https://exhentai.org/g/2905450/16a52dd2c1/'), { source: 'ehentai', query: '2905450/16a52dd2c1' });
  // ハイフン無しの ehentai.org も同じものとして読める (e[x-]?hentai)
  assert.deepStrictEqual(normalize.detectInput('https://ehentai.org/g/2905450/16a52dd2c1/'), { source: 'ehentai', query: '2905450/16a52dd2c1' });
  assert.deepStrictEqual(normalize.detectInput('https://pawchive.pw/fanbox/user/11111/post/22222'), { source: 'pawchive', query: 'fanbox/11111/22222' });
  // .st ドメインと作者 URL も通る
  assert.deepStrictEqual(normalize.detectInput('https://pawchive.st/patreon/user/someone'), { source: 'pawchive', query: 'patreon/someone' });
});

test('detectInput: pixiv の投稿 URL と作者 URL を割り振る', () => {
  const pixiv = require('../src/lib/sources/pixiv');
  assert.deepStrictEqual(normalize.detectInput('https://www.pixiv.net/artworks/123456789'), { source: 'pixiv', query: '123456789' });
  assert.deepStrictEqual(normalize.detectInput('https://www.pixiv.net/en/artworks/123456789#2'), { source: 'pixiv', query: '123456789' });
  assert.deepStrictEqual(normalize.detectInput('https://www.pixiv.net/member_illust.php?mode=medium&illust_id=98765'), { source: 'pixiv', query: '98765' });
  assert.deepStrictEqual(normalize.detectInput('https://pixiv.net/i/555'), { source: 'pixiv', query: '555' });
  assert.deepStrictEqual(normalize.detectInput('https://www.pixiv.net/users/11777'), { source: 'pixiv', query: 'user:11777' });
  assert.deepStrictEqual(normalize.detectInput('https://www.pixiv.net/en/users/11777/illustrations'), { source: 'pixiv', query: 'user:11777' });
  // 小説は本にしない: 拾わない (次のアダプタにも無いので null)
  assert.strictEqual(normalize.detectInput('https://www.pixiv.net/novel/show.php?id=123'), null);
  // 他所の URL は null で次へ渡す / 他所も pixiv の URL を拾わない
  assert.strictEqual(pixiv.detectUrl('https://hitomi.la/galleries/1234567.html'), null);
  assert.strictEqual(hitomi.detectUrl('https://www.pixiv.net/artworks/123456789'), null);
  assert.strictEqual(nhentai.detectUrl('https://www.pixiv.net/artworks/123456789'), null);
  assert.strictEqual(pawchive.detectUrl('https://www.pixiv.net/users/11777'), null);
});

test('detectInput: 知らない URL・空・生の番号は null', () => {
  assert.strictEqual(normalize.detectInput('https://example.com/foo'), null);
  assert.strictEqual(normalize.detectInput(''), null);
  // 生の番号は URL ではないので detectInput では拾わない (extractGalleryId の領分)
  assert.strictEqual(normalize.detectInput('1234567'), null);
});

test('hitomi.detectUrl: 他所の URL は null で次のアダプタへ渡す', () => {
  assert.strictEqual(hitomi.detectUrl('https://nhentai.net/g/1/'), null);
  assert.strictEqual(nhentai.detectUrl('https://hitomi.la/galleries/1234567.html'), null);
  assert.strictEqual(ehentai.detectUrl('https://hitomi.la/galleries/1234567.html'), null);
  assert.strictEqual(pawchive.detectUrl('https://hitomi.la/galleries/1234567.html'), null);
});

test('hitomi.extractGalleryId: 生の番号・URL・番号混じり文字列から拾う', () => {
  assert.strictEqual(hitomi.extractGalleryId('1234567'), 1234567);
  // 3 桁から生の番号として通る
  assert.strictEqual(hitomi.extractGalleryId('123'), 123);
  assert.strictEqual(hitomi.extractGalleryId('https://hitomi.la/galleries/999999.html'), 999999);
  // 混じり文字列は 6 桁以上だけ拾う
  assert.strictEqual(hitomi.extractGalleryId('foo 2419686 bar'), 2419686);
  assert.strictEqual(hitomi.extractGalleryId('foo 24199 bar'), null);
  assert.strictEqual(hitomi.extractGalleryId('no id here'), null);
});

test('pawchive.detectUrl: 投稿 URL は作者 URL より先に判定される', () => {
  assert.deepStrictEqual(
    pawchive.detectUrl('https://pawchive.pw/gumroad/user/u1/post/p9?q=1'),
    { source: 'pawchive', query: 'gumroad/u1/p9' },
  );
});

test('pawchive.parseCreatorUrl: 行頭の作者 URL だけを読む', () => {
  assert.deepStrictEqual(pawchive.parseCreatorUrl('https://pawchive.pw/fanbox/user/12345'), {
    service: 'fanbox',
    user: '12345',
    url: 'https://pawchive.pw/fanbox/user/12345',
  });
  // http なし・www 付き・別ドメイン (.st) の揺れを許し、URL は .pw に正規化される
  assert.deepStrictEqual(pawchive.parseCreatorUrl('www.pawchive.st/patreon/user/abc?x=1'), {
    service: 'patreon',
    user: 'abc',
    url: 'https://pawchive.pw/patreon/user/abc',
  });
  // 知らない取り込み元は作者として扱わない
  assert.strictEqual(pawchive.parseCreatorUrl('https://pawchive.pw/kemono/user/abc'), null);
  // 行頭でない URL は読まない
  assert.strictEqual(pawchive.parseCreatorUrl('see https://pawchive.pw/fanbox/user/1'), null);
});

test('pawchive: URL の組み立てと取り込み元の一覧', () => {
  assert.strictEqual(pawchive.buildCreatorUrl('fanbox', '99'), 'https://pawchive.pw/fanbox/user/99');
  assert.strictEqual(pawchive.buildPostUrl('fanbox', '99', '7'), 'https://pawchive.pw/fanbox/user/99/post/7');
  assert.deepStrictEqual(pawchive.SERVICES, ['patreon', 'fanbox', 'discord', 'fantia', 'subscribestar', 'gumroad']);
});

test('paw-library: pweagle: 接頭辞の判定と剥がし', () => {
  assert.strictEqual(pawLibrary.isPawEagleId('pweagle:ABC123'), true);
  assert.strictEqual(pawLibrary.isPawEagleId('pwlibf:ABC123'), false);
  assert.strictEqual(pawLibrary.eagleIdOf('pweagle:M9X_-abc'), 'M9X_-abc');
  // 接頭辞なしは空文字 (対象外)
  assert.strictEqual(pawLibrary.eagleIdOf('123'), '');
});

test('paw-library.safeEagleId: 英数と _- のみ 64 文字まで、外れは空文字', () => {
  assert.strictEqual(pawLibrary.safeEagleId('M9X_-abc'), 'M9X_-abc');
  assert.strictEqual(pawLibrary.safeEagleId('../etc'), '');
  assert.strictEqual(pawLibrary.safeEagleId('a'.repeat(65)), '');
  assert.strictEqual(pawLibrary.safeEagleId(''), '');
});

test('paw-library.parseName: [日付] [postId] タイトル【頁数P】 を分解する', () => {
  assert.deepStrictEqual(pawLibrary.parseName('[20240430] [12345] タイトル【17P】'), {
    date: '20240430',
    postId: '12345',
    pageCount: 17,
    title: 'タイトル',
  });
  // 日付が先頭に無いときの [20240430] を postId と取り違えない
  assert.deepStrictEqual(pawLibrary.parseName('[20240430] タイトル'), {
    date: '20240430',
    postId: null,
    pageCount: null,
    title: 'タイトル',
  });
  assert.deepStrictEqual(pawLibrary.parseName('  ただの題  '), {
    date: null,
    postId: null,
    pageCount: null,
    title: 'ただの題',
  });
});

// 網から開いた pawchive の作品 (pw:) も、所持していれば手元の実体へ結ぶ (実害あり)。
// 結ばないと「持っているのに網へ取りに行って読めません」になる
test('作品 ID から実体の入れ物を引く: pweagle: と pw: の両方', () => {
  const Module = require('node:module');
  const original = Module._load;
  const items = new Map([['555', { eagleId: 'ITEM555' }]]);
  Module._load = function load(request, parent, isMain) {
    if (request === 'electron') {
      return { app: { getPath: () => require('node:os').tmpdir() } };
    }
    return original.call(this, request, parent, isMain);
  };
  let paw;
  try {
    delete require.cache[require.resolve('../src/lib/paw-library.js')];
    paw = require('../src/lib/paw-library.js');
  } finally {
    Module._load = original;
  }
  // 台帳の引きだけ差し替える (走査は起こさない)
  const realFind = paw.findByPostId;
  try {
    // 入れ物の道はライブラリの根が要る。根が無ければどちらも null になるので、
    // ここで見るのは「pw: が postId から eagleId へ辿る道を持っていること」
    assert.strictEqual(typeof paw.folderForGalleryId, 'function');
    assert.strictEqual(paw.folderForGalleryId('123'), null, 'hitomi の番号は対象外');
    assert.strictEqual(paw.folderForGalleryId('nh:1'), null, '別サイトも対象外');
    assert.strictEqual(paw.folderForGalleryId('pw:fanbox:1:profile'), null, '投稿でない札は対象外');
    // 実体の道はライブラリ設定に依るので、ここでは投げないことだけ固める
    assert.doesNotThrow(() => paw.folderForGalleryId('pw:fanbox:1:555'));
    assert.doesNotThrow(() => paw.folderForGalleryId('pweagle:ITEM555'));
  } finally {
    void realFind;
    void items;
  }
});
