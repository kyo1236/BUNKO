// タイトル正規化・巻数判定・所持照合規則の特性テスト。現行挙動を固定する
const test = require('node:test');
const assert = require('node:assert');

require('./helpers/stub-electron');

const searchText = require('../src/lib/search-text');
const aliases = require('../src/lib/search-aliases');
const catalog = require('../src/lib/catalog');
const match = require('../src/lib/library-match');

// ---- search-text ----

test('nfkc: 全角英数と全角空白を半角に寄せる', () => {
  assert.strictEqual(searchText.nfkc('４Ｋ　ＡＢＣ'), '4K ABC');
  assert.strictEqual(searchText.nfkc(null), '');
});

test('hiraToKata: ひらがなだけをカタカナへ (濁点・半濁点も保つ)', () => {
  assert.strictEqual(searchText.hiraToKata('あいうゑん がぱ'), 'アイウヱン ガパ');
});

test('aliasKey: NFKC + ひら→カタ + 小文字化 + 区切り記号の除去', () => {
  assert.strictEqual(searchText.aliasKey('Ｆａｔｅ／ｓｔａｙ－ｎｉｇｈｔ！'), 'fatestaynight');
  // ☆ は区切り扱いではないので残る
  assert.strictEqual(searchText.aliasKey('らき☆すた'), 'ラキ☆スタ');
  assert.strictEqual(searchText.aliasKey('ほしのゆめみ'), 'ホシノユメミ');
});

test('hasCjk / isMostlyLatin: 字種の判定', () => {
  assert.strictEqual(searchText.hasCjk('abc'), false);
  assert.strictEqual(searchText.hasCjk('あ'), true);
  assert.strictEqual(searchText.hasCjk('ｱ'), true);
  assert.strictEqual(searchText.hasCjk('漢'), true);
  assert.strictEqual(searchText.hasCjk(''), false);
  assert.strictEqual(searchText.isMostlyLatin('abc12'), true);
  assert.strictEqual(searchText.isMostlyLatin('あabc'), false);
  // 英数を一つも含まない記号だけの語は latin 扱いしない
  assert.strictEqual(searchText.isMostlyLatin('---'), false);
  assert.strictEqual(searchText.isMostlyLatin(''), false);
});

test('romajiToKata: ヘボン式ローマ字をカタカナに起こす', () => {
  assert.strictEqual(searchText.romajiToKata('hoshino yumemi'), 'ホシノユメミ');
  assert.strictEqual(searchText.romajiToKata('sakkyaku'), 'サッキャク'); // 促音
  assert.strictEqual(searchText.romajiToKata('shinonome'), 'シノノメ'); // n + 母音
  assert.strictEqual(searchText.romajiToKata('kan'), 'カン'); // 語末の撥音
  assert.strictEqual(searchText.romajiToKata('hokke'), 'ホッケ');
  assert.strictEqual(searchText.romajiToKata('matcha'), 'マッチャ'); // tch の促音
});

test('romajiToKata: 起こし切れない語は空文字で諦める', () => {
  assert.strictEqual(searchText.romajiToKata('xyz9'), '');
  // 英単語 (子音の連なり) も起こせない
  assert.strictEqual(searchText.romajiToKata('john'), '');
});

// ---- catalog のタイトル鍵 ----

test('titleKey: 先頭ブラケット除去 + NFKC + 小文字化 + 記号と空白の除去', () => {
  assert.strictEqual(catalog.titleKey('[作者名] タイトル　ＡＢＣ！?'), 'タイトルabc');
  // 先頭以外のブラケットは中身が残る (括弧の記号だけ落ちる)
  assert.strictEqual(catalog.titleKey('【sample】 Title-Name (DL版)'), 'sampletitlenamedl版');
  // 先頭の連続ブラケットは全て剥がれ、途中のものは中身が繋がる
  assert.strictEqual(catalog.titleKey('[a][b] main [c]'), 'mainc');
  assert.strictEqual(catalog.titleKey(''), '');
  // 180 文字で切り詰める
  assert.strictEqual(catalog.titleKey('a'.repeat(200)).length, 180);
});

test('titleKeyWeight: CJK は 1 字 2 点、それ以外は 1 点', () => {
  assert.strictEqual(catalog.titleKeyWeight('abc'), 3);
  assert.strictEqual(catalog.titleKeyWeight('あいう'), 6);
  assert.strictEqual(catalog.titleKeyWeight('a漢'), 3);
  assert.strictEqual(catalog.titleKeyWeight(''), 0);
});

test('titleKeyEligible: 重み 8 以上、または重み 5 以上で数字終わり', () => {
  assert.strictEqual(catalog.titleKeyEligible('abcdefgh'), true); // 8
  assert.strictEqual(catalog.titleKeyEligible('abcd1'), true); // 5 + 数字終わり
  assert.strictEqual(catalog.titleKeyEligible('あい1'), true); // 5 + 数字終わり
  assert.strictEqual(catalog.titleKeyEligible('abcd'), false); // 4
  assert.strictEqual(catalog.titleKeyEligible('あいうえ'), true); // 8
});

test('volumeSafeContains: はみ出しが巻数のしるしなら別巻とみなす', () => {
  // 飾りのはみ出しは同じ本
  assert.strictEqual(catalog.volumeSafeContains('たいとる♥', 'たいとる'), true);
  assert.strictEqual(catalog.volumeSafeContains('たいとる', 'たいとる'), true);
  // 数字・ローマ数字・和物の巻数マーカーは別巻
  assert.strictEqual(catalog.volumeSafeContains('たいとる2', 'たいとる'), false);
  assert.strictEqual(catalog.volumeSafeContains('たいとるiii', 'たいとる'), false);
  assert.strictEqual(catalog.volumeSafeContains('たいとる下巻', 'たいとる'), false);
  assert.strictEqual(catalog.volumeSafeContains('たいとる前編', 'たいとる'), false);
  // マーカーそのものと一致しない語 (完全版など) は同じ本
  assert.strictEqual(catalog.volumeSafeContains('たいとる完全版', 'たいとる'), true);
});

test('catalog の補助: eagleIdFromPath / extractGalleryIds / 鍵の変換', () => {
  assert.strictEqual(catalog.eagleIdFromPath('/x/y/DEF456.info'), 'DEF456');
  // # 以降は落とす
  assert.strictEqual(catalog.eagleIdFromPath('/x/ABC.info#tag'), 'ABC');
  // [5〜8桁] の番号を拾い、[20xxxxxx] (日付) は除外する
  assert.deepStrictEqual(catalog.extractGalleryIds('[123456] foo [20240101] bar [7654321]'), [123456, 7654321]);
  assert.deepStrictEqual(
    [catalog.numericGalleryId('hitomi:42'), catalog.numericGalleryId(' 7 '), catalog.numericGalleryId('nh:1'), catalog.numericGalleryId(null)],
    [42, 7, null, null],
  );
  // nh:/eh: はそのまま、hitomi は数値文字列に寄せ、pw:/px: (作者根の住人)・非数値は null
  assert.deepStrictEqual(
    ['nh:123', 'eh:1:ab', 'hitomi:456', ' 789 ', 'pw:x:y:z', 'px:123456', 'abc', null].map((v) => catalog.galleryKeyOf(v)),
    ['nh:123', 'eh:1:ab', '456', '789', null, null, null, null],
  );
  assert.deepStrictEqual(
    [catalog.tagNameKey('Big_Breasts'), catalog.tagNameKey('ＦＵＬＬ　Ｃｏｌｏｒ'), catalog.tagNameKey('  a  b ')],
    ['big breasts', 'full color', 'a b'],
  );
});

// ---- library-match ----

test('stripEagleDecorations: 結合と分割の目印だけ剥がし、#n は残す', () => {
  assert.strictEqual(match.stripEagleDecorations('タイトル_他3件_結合'), 'タイトル');
  assert.strictEqual(match.stripEagleDecorations('タイトル -1of6'), 'タイトル');
  // 「#n」は hitomi の実タイトルに実例があるので剥がさない
  assert.strictEqual(match.stripEagleDecorations('タイトル #1'), 'タイトル #1');
});

test('cleanName: 先頭/末尾の [] () グループを剥がす', () => {
  assert.strictEqual(match.cleanName('[作者] タイトル [DL版]'), 'タイトル');
  assert.strictEqual(match.cleanName('(C99) [サークル] タイトル'), 'タイトル');
  assert.strictEqual(match.cleanName('【作者】タイトル'), 'タイトル');
});

test('searchTerms: 2 文字以上の語を重い順に最大 2 語', () => {
  assert.strictEqual(match.searchTerms('短い とても長い言葉 あ 中くらい'), 'とても長い言葉 中くらい');
  // 2 文字未満の語しか無ければ null
  assert.strictEqual(match.searchTerms('a b'), null);
});

test('segmentTerms / truncatedTerm: 飾り記号で切り、長い語は先頭 8 文字', () => {
  assert.strictEqual(
    match.segmentTerms('悪徳レズクリニック〜おまんこおあずけ精密検査〜'),
    'おまんこおあずけ精密検査 悪徳レズクリニック',
  );
  assert.strictEqual(match.truncatedTerm('悪徳レズクリニック〜おまんこおあずけ精密検査〜'), 'おまんこおあずけ');
  // 先頭語が 8 文字以下なら切り詰めは出さない
  assert.strictEqual(match.truncatedTerm('短い題'), null);
});

test('searchPlans: clean → 区画 → 切り詰め の順で重複なし、の↔ノ の入れ替えも足す', () => {
  assert.deepStrictEqual(match.searchPlans('[作者] 贖罪の間'), ['贖罪の間', '贖罪ノ間']);
  assert.deepStrictEqual(match.searchPlans('悪徳レズクリニック〜おまんこおあずけ精密検査〜'), [
    '悪徳レズクリニック〜おまんこおあずけ精密検査〜',
    'おまんこおあずけ精密検査 悪徳レズクリニック',
    'おまんこおあずけ',
  ]);
});

test('classify: exact / contains / near / null の割り振り', () => {
  assert.strictEqual(match.classify('[作者] タイトルだよ全部', 'タイトルだよ全部'), 'exact');
  // 飾りのはみ出しは contains (採用候補)
  assert.strictEqual(match.classify('[作者] タイトルだよ全部♥', 'タイトルだよ全部'), 'contains');
  // 数字・ローマ数字・和物の巻数のはみ出しは near (続刊の疑い)
  assert.strictEqual(match.classify('[作者] タイトルだよ全部2', 'タイトルだよ全部'), 'near');
  assert.strictEqual(match.classify('タイトルだよ全部iii', 'タイトルだよ全部'), 'near');
  assert.strictEqual(match.classify('[x] ながいたいとるの下巻', 'ながいたいとるの'), 'near');
  assert.strictEqual(match.classify('全然違う', 'タイトルだよ全部'), null);
  // 短い鍵 (重み 8 未満) の包含は採らない
  assert.strictEqual(match.classify('abあ', 'ながいたいとるのなか abあ'), null);
  // exact は短くても通る (弾くのは decide の重み 5 チェック)
  assert.strictEqual(match.classify('本能', '本能'), 'exact');
  // アイテム側の Eagle 装飾は剥がして比べる
  assert.strictEqual(match.classify('タイトルだよ全部_他2件_結合', 'タイトルだよ全部'), 'exact');
});

test('classifyVerified: 作者検証付きの緩い鍵 (版マーカー・の↔ノ を吸収)', () => {
  assert.strictEqual(match.classifyVerified('タイトル総集編', 'タイトル'), 'exact');
  assert.strictEqual(match.classifyVerified('贖罪の間', '贖罪ノ間'), 'exact');
  assert.strictEqual(match.classifyVerified('本能', '本能'), 'exact');
  assert.strictEqual(match.classifyVerified('タイトルながめ♥', 'タイトルながめ'), 'contains');
  // near は無い: 巻数のはみ出しは null (採用しない)
  assert.strictEqual(match.classifyVerified('タイトルながめ2', 'タイトルながめ'), null);
});

test('decide: exact 優先・日本語版優先・短い題は自動採用しない', () => {
  // 同題の exact が並んだら日本語版
  assert.deepStrictEqual(
    match.decide([
      { id: 1, title: 'ながいたいとるあいう', language: 'japanese', quality: 'exact' },
      { id: 2, title: 'ながいたいとるあいう', language: null, quality: 'exact' },
    ]),
    { id: 1, title: 'ながいたいとるあいう', language: 'japanese', quality: 'exact' },
  );
  // 1 件だけなら contains でも採用
  assert.deepStrictEqual(
    match.decide([{ id: 9, title: 'ながいたいとるあいう', language: null, quality: 'contains' }]),
    { id: 9, title: 'ながいたいとるあいう', language: null, quality: 'contains' },
  );
  // 鍵の違う複数 contains は決められない
  assert.strictEqual(
    match.decide([
      { id: 1, title: 'ながいたいとるあいう', quality: 'contains' },
      { id: 2, title: 'べつのながいたいとる', quality: 'contains' },
    ]),
    null,
  );
  // 短い汎用題 (重み 5 未満) は exact でも自動採用しない
  assert.strictEqual(match.decide([{ id: 1, title: 'Ci-en', language: 'japanese', quality: 'exact' }]), null);
  assert.strictEqual(match.decide([]), null);
});

test('TITLE_MATCH_RULES_VERSION: 照合ルールの版は 3', () => {
  assert.strictEqual(match.TITLE_MATCH_RULES_VERSION, 3);
});

// ---- search-aliases (データファイルに依らない純粋な部分) ----

test('parseTypePrefix: 型接頭辞の解釈と正規化', () => {
  assert.deepStrictEqual(aliases.parseTypePrefix('artist:michiking'), {
    negative: false,
    type: 'artist',
    name: 'michiking',
    token: 'artist:michiking',
  });
  // 日本語の型名は TYPE_ALIASES で英名へ
  assert.deepStrictEqual(aliases.parseTypePrefix('作者:みちきんぐ'), {
    negative: false,
    type: 'artist',
    name: 'みちきんぐ',
    token: 'artist:みちきんぐ',
  });
  // 否定 (-) と、name の _→空白 / token の空白→_ の往復
  assert.deepStrictEqual(aliases.parseTypePrefix('-female:big_breasts'), {
    negative: true,
    type: 'female',
    name: 'big breasts',
    token: '-female:big_breasts',
  });
  assert.deepStrictEqual(aliases.parseTypePrefix('series:fate stay'), {
    negative: false,
    type: 'series',
    name: 'fate stay',
    token: 'series:fate_stay',
  });
  // 知らない型・接頭辞なしは null
  assert.strictEqual(aliases.parseTypePrefix('unknown:foo'), null);
  assert.strictEqual(aliases.parseTypePrefix('plain'), null);
});

test('shouldQueryRemoteTags / canSuggestTerm: 遠隔照会と候補の閾値', () => {
  assert.strictEqual(aliases.shouldQueryRemoteTags('a:b'), true); // : 付きは常に照会
  assert.strictEqual(aliases.shouldQueryRemoteTags('ab'), true); // 欧文 2 文字から
  assert.strictEqual(aliases.shouldQueryRemoteTags('あ'), false); // CJK は照会しない
  assert.strictEqual(aliases.shouldQueryRemoteTags('a'), false);
  assert.strictEqual(aliases.canSuggestTerm('あ'), true); // CJK は 1 文字から
  assert.strictEqual(aliases.canSuggestTerm('a'), false); // 欧文は 2 文字から
  assert.strictEqual(aliases.canSuggestTerm('ab'), true);
  assert.strictEqual(aliases.canSuggestTerm(''), false);
});

test('rewriteQuery: 型接頭辞は訳し、日本語の作者名はローマ字の名乗りへ落ちる', () => {
  // 以前はここで `artist:みちきんぐ` のまま外へ出していた。hitomi の作者名は
  // ローマ字なので、日本語のまま送ると黙って 0 件になる。監査済みの表示名
  // (label-overrides) を検索の鍵にも入れたので、今は名乗りまで解ける
  assert.deepStrictEqual(aliases.rewriteQuery('作者:みちきんぐ language:japanese'), {
    query: 'artist:michiking language:japanese',
    tokens: ['artist:michiking', 'language:japanese'],
    resolved: [{ from: '作者:みちきんぐ', to: 'artist:michiking', label: 'みちきんぐ', type: 'artist' }],
  });
  assert.deepStrictEqual(aliases.rewriteQuery('  '), { query: '', tokens: [], resolved: [] });
});

test('lookup / suggestAliases: 空語と短すぎる欧文は空配列', () => {
  assert.deepStrictEqual(aliases.lookup(''), []);
  assert.deepStrictEqual(aliases.suggestAliases(''), []);
  assert.deepStrictEqual(aliases.suggestAliases('a'), []);
});

test('pickLabel: 優先枠に入らなければ かな入り 3 字以上の短い順', () => {
  // カタカナ枠 (3〜8 字) にも漢字 2 字枠にも該当が無く、最後の「かな入り」枠で
  // 最短の「デカ乳」が選ばれる (現行挙動)
  assert.strictEqual(aliases.pickLabel(['デカ乳', 'おっぱい', 'ムネ']), 'デカ乳');
});
