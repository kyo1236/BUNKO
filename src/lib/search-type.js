'use strict';
(() => {
const nfkc = value => String(value || '').normalize('NFKC');
const TYPE_ALIASES = new Map([
  ['作者', 'artist'],
  ['parody', 'series'],
  ['アーティスト', 'artist'],
  ['グループ', 'group'],
  ['サークル', 'group'],
  ['シリーズ', 'series'],
  ['原作', 'series'],
  ['パロディ', 'series'],
  ['キャラ', 'character'],
  ['キャラクター', 'character'],
  ['言語', 'language'],
  ['タグ', 'tag'],
]);

const TAG_TYPES = new Set([
  'artist',
  'group',
  'type',
  'language',
  'series',
  'character',
  'male',
  'female',
  'tag',
  // 「female でも male でもよい」。hitomi に無い語だが、こちらの検索器が
  // 二つに開いて合わせて引く (nhentai の型無しタグを当てずっぽうにしないため)
  'either',
]);

function parseTypePrefix(token) {
  const text = nfkc(token);
  const match = text.match(/^(-)?([^:]+):(.+)$/);
  if (!match) return null;
  const mapped = TYPE_ALIASES.get(match[2]) || match[2].toLowerCase();
  if (!TAG_TYPES.has(mapped)) return null;
  const value = match[3].replace(/^"(.*)"$/, '$1');
  return {
    negative: Boolean(match[1]),
    type: mapped,
    name: value.replace(/_/g, ' ').trim(),
    token: `${match[1] || ''}${mapped}:${value.replace(/\s+/g, '_')}`,
  };
}


function tokenizeQuery(raw) { return String(raw || '').match(/(?:[^\s"]+|"[^"]*")+/g) || []; }
function splitAuthorQuery(raw) {
  const authors = [], rest = [];
  for (const token of tokenizeQuery(raw)) {
    const typed = parseTypePrefix(token);
    if (typed?.type === 'artist') authors.push(typed); else rest.push(token);
  }
  return { authors, rest: rest.join(' ') };
}
function matchesSearchWords(text, raw) {
  const hay = String(text || '').normalize('NFKC').toLowerCase();
  return tokenizeQuery(raw).every(token => {
    const negative = token.startsWith('-');
    const word = (negative ? token.slice(1) : token).replace(/^"(.*)"$/, '$1').normalize('NFKC').toLowerCase();
    return negative ? !hay.includes(word) : hay.includes(word);
  });
}

if (typeof module !== 'undefined' && module.exports) module.exports = { parseTypePrefix, TYPE_ALIASES, TAG_TYPES, tokenizeQuery, splitAuthorQuery, matchesSearchWords };
else window.BunkoSearchType = { parseTypePrefix, tokenizeQuery, splitAuthorQuery, matchesSearchWords };
})();
