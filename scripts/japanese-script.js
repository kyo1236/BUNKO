'use strict';
// 「この字面は日本語か」を、手元の確かな日本語だけから決める。
//
// なぜ表で殴らないか: 簡体字の一覧を書き並べると、抜けた字がそのまま辞書に入る
// (贼 は弾けても 穗 や 焰 は通る)。逆に「確かに日本語だと分かっている字」を
// 集めておけば、そこに無い字を含む語は日本語と言い切れない、と言える。
//
// 確かな日本語の出どころ (どれも人が検めた物か、かなを含む語):
//   - label-overrides.json  2026-08 の全件監査の成果物
//   - manual-aliases.json   手で決めた別名
//   - search-vocabulary.json の入力と札 (監査済み)
//   - かなを含む語は中国語ではありえないので、その中の漢字も数える
//
// かなを含む語は無条件で日本語。漢字だけの語は、全部の字が上の集合に
// 在る時だけ日本語とみなす。
const HIRA_KATA = /[ぁ-んァ-ヶー]/;
const HANGUL = /[가-힯]/;
const KANJI = /[一-鿿]/g;

let cached = null;

function collectFrom(strings, chars) {
  for (const text of strings) {
    const s = String(text || '');
    if (!s || HANGUL.test(s)) continue;
    if (!HIRA_KATA.test(s)) continue; // かなを含む語だけを種にする
    for (const ch of s.match(KANJI) || []) chars.add(ch);
  }
}

function knownKanji(sources = {}) {
  if (cached && !sources.fresh) return cached;
  const chars = new Set();
  const overrides = sources.overrides || safeRequire('../src/lib/data/label-overrides.json', {});
  const manual = sources.manual || safeRequire('../src/lib/data/manual-aliases.json', { entries: [] });
  const vocabulary = sources.vocabulary || safeRequire('../src/lib/data/search-vocabulary.json', { entries: [] });

  // 人が検めた札は、かなが無くても日本語として数える (中野梓・鬼滅の刃)
  for (const value of Object.values(overrides)) {
    for (const ch of String(value || '').match(KANJI) || []) chars.add(ch);
  }
  for (const entry of manual.entries || []) {
    for (const label of entry.labels || []) for (const ch of String(label).match(KANJI) || []) chars.add(ch);
    for (const ch of String(entry.label || '').match(KANJI) || []) chars.add(ch);
  }
  for (const entry of vocabulary.entries || []) {
    for (const input of entry.inputs || []) for (const ch of String(input.name || '').match(KANJI) || []) chars.add(ch);
    for (const out of Object.values(entry.outputs || {})) for (const ch of String((out && out.label) || '').match(KANJI) || []) chars.add(ch);
  }
  // かなを含む語からも字を拾う (danbooru の other_names など、呼び出し側が渡す)
  collectFrom(sources.seed || [], chars);
  cached = chars;
  return chars;
}

function safeRequire(rel, fallback) {
  try { return require(rel); } catch { return fallback; }
}

// 日本語と言い切れるか。かな入りは真、ハングル入りは偽、
// 漢字だけの語は全部の字が既知の時だけ真
function isJapanese(text, chars) {
  const s = String(text || '').trim();
  if (!s) return false;
  if (HANGUL.test(s)) return false;
  if (HIRA_KATA.test(s)) return true;
  const kanji = s.match(KANJI) || [];
  if (!kanji.length) return false;
  const known = chars || knownKanji();
  return kanji.every((ch) => known.has(ch));
}

module.exports = { knownKanji, isJapanese, collectFrom };
