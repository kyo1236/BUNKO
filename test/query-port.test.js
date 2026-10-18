'use strict';

// 検索語をサイト間で持ち運ぶ港 (2026-09-11 の申告)。
//
// 申告は二つで、原因は一つ:
//   「pawchive の検索が他のサイトへ行っても残る」
//   「hitomi の語で nhentai や e-hentai がそのまま検索できない (できるやつもある)。
//     なのに残り続ける」
// 検索欄に残るのは hitomi の語彙に正規化された字面で、送り先アダプタは誰も
// 翻訳しない。相手に在れば当たり、無ければ外れる = 「できるやつもある」。
//
// ここで一番大事なのは**捨てる側**。相手に無い名前空間は 0 件で済むが、
// 裸の数字や「作者/利用者」形はサイトごとに別の物を指すので、
// 残すと黙って別の作品を一件返す。0 件より悪い。

const test = require('node:test');
const assert = require('node:assert/strict');

const { portQuery } = require('../src/lib/sources/query-port');

const port = (query, from, to) => portQuery(query, from, to).query;
const lost = (query, from, to) => portQuery(query, from, to).dropped;

test('裸語はどこへでも運べる (唯一どのサイトでも同じ意味になる形)', () => {
  assert.equal(port('kumi chan', 'hitomi', 'nhentai'), 'kumi chan');
  assert.equal(port('kumi chan', 'pawchive', 'ehentai'), 'kumi chan');
});

test('相手も同じ綴りを解する名前空間はそのまま通る', () => {
  assert.equal(port('artist:foo_bar', 'hitomi', 'nhentai'), 'artist:foo_bar');
  assert.equal(port('language:japanese', 'hitomi', 'ehentai'), 'language:japanese');
  assert.equal(port('group:x tag:full_color', 'hitomi', 'nhentai'), 'group:x tag:full_color');
});

test('綴りが違うだけの名前空間は言い換える', () => {
  // 原作は nhentai / e-hentai では parody
  assert.equal(port('series:my_work', 'hitomi', 'nhentai'), 'parody:my_work');
  assert.equal(port('series:my_work', 'hitomi', 'ehentai'), 'parody:my_work');
  // 種別の名前空間を持つのは hitomi だけ。他は裸語で書く
  assert.equal(port('type:doujinshi', 'hitomi', 'nhentai'), 'doujinshi');
  assert.equal(port('type:manga', 'hitomi', 'ehentai'), 'manga');
});

test('相手に無い名前空間は外す (0 件の棚を見せない)', () => {
  // nhentai は男性向け/女性向けの名前空間を持たず tag へ畳む
  assert.equal(port('male:beard', 'hitomi', 'nhentai'), 'tag:beard');
  assert.deepEqual(lost('male:beard', 'hitomi', 'nhentai'), []);
  // e-hentai には在る
  assert.equal(port('male:beard', 'hitomi', 'ehentai'), 'male:beard');
});

// ここが本丸。残すと「0 件」ではなく「別の作品を一件」返す形
test('サイトごとに別の物を指す形は必ず外す', () => {
  assert.equal(port('123456', 'hitomi', 'nhentai'), '', '作品 ID は空間がサイトごとに別');
  assert.equal(port('fanbox/12345', 'pawchive', 'hitomi'), '', 'pawchive の作者指定');
  assert.equal(port('fanbox/12345/999', 'pawchive', 'hitomi'), '', 'pawchive の投稿指定');
  assert.equal(port('folder:MABC123', 'pawchive', 'hitomi'), '', 'Eagle のフォルダ id');
  assert.equal(
    port('2851407/fa1d2b0d1a', 'ehentai', 'nhentai'), '',
    'e-hentai の gid/token。pawchive の 作者/利用者 と形が食い合う',
  );
  assert.equal(
    port('https://hitomi.la/doujinshi/x-123.html', 'hitomi', 'ehentai'), '',
    'URL を残すと、選んだサイトと実際に問い合わせる先が食い違う',
  );
});

test('pawchive へは値だけ渡す (名前空間を解さない造り)', () => {
  assert.equal(port('artist:foo_bar', 'hitomi', 'pawchive'), 'artist:foo_bar');
  assert.equal(port('series:my_work', 'hitomi', 'pawchive'), '', 'a global tag must not become an unrelated creator or all-post feed');
  assert.equal(port('artist:foo_bar series:my_work','hitomi','pawchive'),'artist:foo_bar tag:my_work');
});

test('同じサイトのままなら一字も触らない', () => {
  assert.equal(port('series:my_work 123456', 'hitomi', 'hitomi'), 'series:my_work 123456');
  assert.deepEqual(lost('fanbox/12345', 'pawchive', 'pawchive'), []);
});

test('運べる語と運べない語が混ざっていても、運べるぶんは残す', () => {
  const out = portQuery('artist:foo_bar 123456 series:my_work', 'hitomi', 'nhentai');
  assert.equal(out.query, 'artist:foo_bar parody:my_work');
  assert.deepEqual(out.dropped, ['123456'], '何を外したか言えるようにする');
});

test('打ち消し (-) を保ったまま言い換える', () => {
  assert.equal(port('-series:my_work', 'hitomi', 'nhentai'), '-parody:my_work');
});

test('空の語は空のまま (呼び手が余計な検索を起こさない)', () => {
  assert.deepEqual(portQuery('', 'hitomi', 'nhentai'), { query: '', dropped: [] });
  assert.deepEqual(portQuery('   ', 'pawchive', 'hitomi'), { query: '', dropped: [] });
});

// ── e-hentai の人気が黙って投稿日順に化ける件 ──────────────────
//
// /popular と toplist は絞り込みを受け付けないページなので、語があると使えない。
// その判じに「言語・種別を継ぎ足した後の語」を渡していたので、**言語を一つ
// 選んでいるだけで**人気・いま/昨日/月/年 が全部ふつうの検索に落ちていた。
// 画面には一覧が出るので、壊れていることに気付けない類の不具合

const { popularUrl } = require('../src/lib/sources/ehentai');

test('語が無ければ人気の置き場へ行く', () => {
  assert.match(popularUrl('today', '', 0), /e-hentai\.org\/popular/);
  assert.match(popularUrl('week', '', 0), /toplist\.php\?tl=11/);
  assert.match(popularUrl('month', '', 0), /toplist\.php\?tl=12/);
  assert.match(popularUrl('year', '', 0), /toplist\.php\?tl=13/);
});

test('語を打ったら人気は使えない (サイトの造り。通常検索へ落ちる)', () => {
  assert.equal(popularUrl('today', 'kumi', 0), null);
  assert.equal(popularUrl('week', 'kumi', 0), null);
});

test('渡すのは利用者が打った語だけ。言語の絞り込みで人気が落ちてはいけない', () => {
  // 以前はここに 'language:japanese' を継ぎ足した q が渡っていた
  assert.match(
    popularUrl('today', '', 0), /popular/,
    '言語を選んでいても、語が空なら人気のまま',
  );
});

// pixiv は名前空間を持たず、語をタグの部分一致で引く (docs/pixiv-design §4)
test('pixiv へは作者指定を保ち、タグ・原作・キャラは裸語、言語・種別は外す', () => {
  assert.equal(port('tag:full_color', 'hitomi', 'pixiv'), 'full color');
  assert.equal(port('series:my_work character:some_one', 'hitomi', 'pixiv'), 'my work some one');
  assert.equal(port('-tag:full_color', 'hitomi', 'pixiv'), '-full color', '打ち消しは pixiv も -語 で解する');
  assert.equal(port('artist:foo_bar language:japanese type:manga', 'hitomi', 'pixiv'), 'artist:foo_bar');
  assert.deepEqual(lost('artist:foo_bar', 'hitomi', 'pixiv'), []);
  assert.equal(port('kumi chan', 'hitomi', 'pixiv'), 'kumi chan', '裸語はそのまま');
});

test('pixiv 固有の指定はよそへ持ち出さない (作者の番号・期間・候補はサイトごとに別の物)', () => {
  for (const token of ['user:12345', 'exact:foo', 'since:2026-01-01', 'until:2026-02-01', 'date:2026-09-18', 'id:99', 'bm:private', 'bookmarks:']) {
    assert.equal(port(token, 'pixiv', 'hitomi'), '', token);
  }
  assert.deepEqual(lost('user:12345 foo', 'pixiv', 'nhentai'), ['user:12345']);
  // 同じサイトのままなら触らない
  assert.equal(port('user:12345 foo', 'pixiv', 'pixiv'), 'user:12345 foo');
});


test('four sources preserve author intent and use known display names', () => {
  const context = {labels: {'artist:sample': '見本作者'}, creatorQueries: {'pawchive:fanbox/123': '見本作者'}};
  assert.equal(portQuery('artist:sample','hitomi','pixiv',context).query,'artist:見本作者');
  assert.equal(portQuery('fanbox/123','pawchive','nhentai',context).query,'artist:見本作者');
  for (const from of ['hitomi','pixiv','pawchive','nhentai']) for (const to of ['hitomi','pixiv','pawchive','nhentai']) {
    assert.equal(portQuery('artist:sample',from,to).query,'artist:sample');
    assert.equal(portQuery('sample word',from,to).query,'sample word');
  }
});


test('quoted author names stay a single term and confirmed IDs preserve the remaining words', () => {
  assert.equal(portQuery('winter artist:"foo bar" -night','nhentai','hitomi').query,'winter artist:foo_bar -night');
  const context={links:{'pixiv:user:77':{pawchive:'patreon/88'}}};
  assert.equal(portQuery('user:77 winter','pixiv','pawchive',context).query,'patreon/88 winter');
  assert.equal(portQuery('fanbox/77','pawchive','pixiv').query,'','numeric equality alone is not proof');
  const {forNhentai}=require('../src/lib/sources/tag-query');
  assert.equal(forNhentai('artist:foo_bar winter'),'artist:"foo bar" winter');
  assert.equal(forNhentai('artist:"foo bar" winter'),'artist:"foo bar" winter');
});

test('confirmed creator folder joins are read-only, unique, and source-specific', () => {
  const {searchAuthorContext}=require('../src/lib/search-author-context');
  const data={pixiv:{77:{folderId:'f1',name:'Label'}},pawchive:{'patreon:88':'f1','fanbox:77':'other'}};
  const out=searchAuthorContext('user:77 winter','pixiv',data);
  assert.equal(out.links['pixiv:user:77'].pawchive,'patreon/88');
  assert.equal(searchAuthorContext('patreon/88','pawchive',data).links['pawchive:patreon/88'].pixiv,'user:77');
  data.pawchive['fanbox:99']='f1';
  assert.equal(searchAuthorContext('user:77','pixiv',data).links['pixiv:user:77'].pawchive,undefined,'multiple destination identities remain unresolved');
  assert.deepEqual(searchAuthorContext('patreon/77','pawchive',data).links,{});
});
