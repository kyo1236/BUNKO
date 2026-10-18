'use strict';

// 札を押して飛ぶ語は hitomi の言い方 (female:big_breasts のように型付き・下線区切り) で
// 組まれる。**その語がそのまま別のサイトへ飛ぶ** ので、受け取る側の言い方へ直す。
//
// 直さないと何が起きるか (2026-09-15 に実測):
//   nhentai へ "either:mind_control" -> 0 件   (either は BUNKO 内の符丁)
//   nhentai へ "female:big_breasts"  -> 3 件   (型が無いので字面の一致になる)
//   nhentai へ "mind_control"        -> 1 件   (下線が語を繋いでしまう)
//   nhentai へ 'tag:"mind control"'  -> 24,345 件
//
// E-Hentai は hitomi と同じ語彙 (female:/male:) なのでそのまま通る。効かないのは
// either: だけで、そこは型を外して素の語に落とす。
//
// ここは **語の言い換えだけ** を持つ。どのサイトがどの型を持つかはこの表が原本。

// hitomi 側の型。female/male/either は「内容タグ」の仲間
const GENDERED = new Set(['female', 'male', 'either']);

// nhentai が持っている型。series は parody と呼ぶ
const NHENTAI_TYPES = new Set(['tag', 'artist', 'group', 'character', 'parody', 'language']);

// `-female:big_breasts` → { negative:'-', type:'female', name:'big breasts' }
function splitToken(token) {
  const hit = String(token).match(/^(-?)([a-z]+):(.+)$/i);
  if (!hit) return null;
  return {
    negative: hit[1] || '',
    type: hit[2].toLowerCase(),
    name: hit[3].replace(/^"(.*)"$/, '$1').replace(/_/g, ' ').trim(),
  };
}

// 空白を含む語は括る (括らないと語が二つに割れる)
function quote(name) {
  return /\s/.test(name) ? `"${name}"` : name;
}

function mapTokens(query, mapper) {
  return require('../search-type').tokenizeQuery(query)
    .map((token) => {
      const parsed = splitToken(token);
      // 型の付いていない語 (利用者が打った文) は触らない
      if (!parsed) return token;
      const mapped = mapper(parsed);
      // null = そのまま通す / '' = 落とす。空文字を「変更なし」と取り違えない
      return mapped == null ? token : mapped;
    })
    .filter(Boolean)
    .join(' ')
    .trim();
}

// nhentai 向け。内容タグは型を落として tag: に寄せ、下線は空白へ戻す
function forNhentai(query) {
  return mapTokens(query, ({ negative, type, name }) => {
    if (GENDERED.has(type)) return `${negative}tag:${quote(name)}`;
    if (type === 'series') return `${negative}parody:${quote(name)}`;
    if (NHENTAI_TYPES.has(type)) return `${negative}${type}:${quote(name)}`;
    // type: など nhentai に無い型は語ごと落とす (字面で誤爆させない)。
    // 種別の絞り込みは search() が別の引数で渡している
    if (type === 'type') return '';
    return `${negative}${quote(name)}`;
  }).replace(/\s+/g, ' ').trim();
}

// E-Hentai 向け。語彙は hitomi と同じなので、こちらの符丁 (either) だけ外す
function forEhentai(query) {
  return mapTokens(query, ({ negative, type, name }) => {
    if (type !== 'either') return null; // そのまま通す
    return `${negative}${quote(name)}`;
  });
}

module.exports = { forNhentai, forEhentai };
