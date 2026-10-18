'use strict';

// 題から鍵を作る所。catalog から切り出してある。
//
// 切り出した理由: `library-match` と `creator-labels` は titleKey 系だけが要るのに、
// catalog を引くと 3,000 行超と electron (app.getPath) まで一緒に付いてきていた。
// ここは**外に触らない純粋な関数だけ**なので、試験も単体で書ける (項目 10-1)。
//
// 中身は「同じ作品か」を決める規則そのもの: 題の飾り・巻数・版違い・総集編の
// 読み方をここで決め、台帳の照合・重複判定・シリーズの抜けが全部これに乗る。

const { nfkc, hasCjk } = require('./search-text');

function tagNameKey(value) {
  return nfkc(value)
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleNeedle(value) {
  return nfkc(value)
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const META_TAG_GROUPS = new Map([
  ['artist', 'artists'],
  ['group', 'groups'],
  ['series', 'series'],
  ['character', 'characters'],
  ['tag', 'tags'],
  ['male', 'tags'],
  ['female', 'tags'],
]);

function metaTagRows(serialized) {
  const rows = [];
  const seen = new Set();
  const add = (type, name) => {
    const cleanType = String(type || '').toLowerCase().trim();
    const cleanName = tagNameKey(name);
    if (!cleanType || !cleanName) return;
    const key = `${cleanType}\u0000${cleanName}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push([cleanType, cleanName]);
  };
  for (const tag of serialized.artists || []) add(tag.type || 'artist', tag.name);
  for (const tag of serialized.groups || []) add(tag.type || 'group', tag.name);
  for (const tag of serialized.series || []) add(tag.type || 'series', tag.name);
  for (const tag of serialized.characters || []) add(tag.type || 'character', tag.name);
  for (const tag of serialized.tags || []) add(tag.type || 'tag', tag.name);
  if (serialized.language && serialized.language.name) add('language', serialized.language.name);
  if (serialized.type) add('type', serialized.type);
  return rows;
}

// 所持庫の「追加日」= Eagle に保存した日時 (紐付くアイテムの最新、ms)。
// hitomi の追加日 (サイトへの登録日) では公開日との違いが体感できないため、
// 「自分が入れた順」に寄せる (2026-08-28 利用者指定)。Eagle に無い作品
// (ダウンロードのみ) は hitomi の追加日で代用する
function titleKey(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/^(?:\[[^\]]*\]\s*)+/, '')
    .replace(/[\s_\-−–—[\]()（）【】『』「」.,!！?？'"“”‘’~～・:：;；/\\]+/g, '')
    .slice(0, 180);
}

// 字クラスの原本は search-text.hasCjk。ここで書き写すと片方だけ直す形になる

function titleKeyWeight(key) {
  let units = 0;
  for (const ch of String(key || '')) {
    units += hasCjk(ch) ? 2 : 1;
  }
  return units;
}

function titleKeyEligible(key) {
  const weight = titleKeyWeight(key);
  return weight >= 8 || (weight >= 5 && /\d$/.test(String(key || '')));
}

// 片方の鍵がもう片方を含むとき、はみ出しが「巻数のしるし」なら別の巻とみなす。
// アラビア数字は NFKC で半角に寄るが、ローマ数字は i/x… の字に化ける
// (Ⅱ→ii ⊂ Ⅲ→iii で雌ガチャⅡがIIIに誤マッチした実例がある)。
// 上/下/前編/後編 のような和物の巻数も同じ理由ではみ出し検査に掛ける
const VOLUME_LEFTOVER = /^(?:[ivxlcdm]+|[上中下続完新]|前編|後編|中編|上巻|下巻|中巻|続編|完結編?|総集編)$/;

function volumeSafeContains(haystack, needle) {
  const leftover = String(haystack).split(needle).join('');
  if (/[0-9０-９]/.test(leftover)) return false;
  if (VOLUME_LEFTOVER.test(leftover)) return false;
  return true;
}

// 版マーカー: 剥がしても同じ作品とみなす語。巻数マーカー (VOLUME_LEFTOVER) とは
// 逆の役割で、こちらは「消しても作品の同一性が変わらない」飾り。
// titleKey 済みの文字列に掛ける前提なので、すべて小文字・記号なしで書く
const EDITION_MARKERS = [
  '完全版', 'dl版', 'ダウンロード版', '修正版', '加筆修正版', '加筆版',
  '無修正', 'decensored', 'uncensored', 'フルカラー版', 'フルカラー', 'fullcolor',
  'カラー版', '単行本版', '電子版', '特装版', 'プレビュー版', '体験版',
  '高解像度版', 'リマスター版', '新装版', 'おまけ付き', 'おまけ付',
];

// titleKey からさらに版マーカーを剥がした「ゆるい鍵」。同題の再掲・微修正版を
// 同じ作品として束ねるために使う。厳密な所持判定 (titleSet) とは別物
function looseTitleKey(key) {
  // titleKey が残す飾り罫 (━ など) も落とす: 同作の再掲は罫の種類だけ違うことがある
  let loose = String(key || '').replace(/[━─╌╍]+/g, '');
  for (const marker of EDITION_MARKERS) loose = loose.split(marker).join('');
  return loose;
}

// 厳密なローマ数字の値。並びが不正 (civil 等の英単語) なら null
const ROMAN_VALUES = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };

function romanNumeralValue(word) {
  const text = String(word || '').toLowerCase();
  if (!/^[ivxlcdm]+$/.test(text)) return null;
  let total = 0;
  let prev = 0;
  for (let i = text.length - 1; i >= 0; i -= 1) {
    const value = ROMAN_VALUES[text[i]];
    if (value < prev) {
      // 減算記法は I/X/C のみ、かつ一段まで (iiv のような並びは英単語)
      if (prev / value > 10 || ![1, 10, 100].includes(value)) return null;
      total -= value;
    } else {
      total += value;
    }
    prev = Math.max(prev, value);
  }
  return total > 0 ? total : null;
}

// 単独のローマ数字語を算用数字へ (Ⅱ→2、Part III→Part 3)。
// 「〇〇Ⅱ」(Eagle) と「〇〇2」(hitomi) の表記違いで重複を見逃さないため。
// 空白や CJK が境界のうちに変換する必要があるので、titleKey で空白を潰す前の
// 生タイトルに掛けること。巻数を想定して 20 までしか変換しない
// (mix=1009 のような英単語の偶然の解釈を巻き込まない)
function normalizeVolumeNumerals(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/(^|[^0-9A-Za-z])([IVXivx]{1,6})(?![0-9A-Za-z])/g, (match, pre, run) => {
      const value = romanNumeralValue(run);
      return value && value <= 20 ? `${pre}${value}` : match;
    });
}

// 重複判定用の鍵は必ずここを通す: ローマ数字の正規化 → titleKey → 版マーカー剥がし
function looseKeyFromTitle(title) {
  return looseTitleKey(titleKey(normalizeVolumeNumerals(title)));
}

// シリーズの「抜け」を言うための題の読み取り。連番の外挿はしないので、巻数と
// 読むのは「題の末尾に付いた番号」だけ: 途中の数字 (年号・題そのものの一部) は
// 巻数と読まない。ローマ数字は normalizeVolumeNumerals が先に算用数字へ寄せる。
// 題は三つのどれかに読む:
//   volume  「題 N」        … N 巻
//   omnibus 「題 総集編 1～6」「題 1-4」「題【合本版】」 … 収録範囲をまとめて持つ一冊
//   plain   番号の無い「題」 … 同じ題の番号付きが手元にあるとき、その 1 巻
// 巻数の上限: これより大きい数は巻数ではなく題の一部とみなす (2021-05 のような
// 号数・日付を巻数と読み違えると、抜けが何十件も湧く)
const MAX_SERIES_VOLUME = 50;
// 末尾の「(第|#|vol.|part…)? 数字 (巻|話|部|章)?」。前の飾りは剥がしてから掛ける
const VOLUME_TAIL = /^(.*?)\s*(?:第|#|＃|vol\.?|volume|part|chapter|ch\.)?\s*(\d{1,3})\s*(?:巻|話|部|章)?$/i;
// 数字の直前がこれらで終わる題は巻数と読まない (COMIC LO 2021-05 の類)
const VOLUME_BAD_TAIL = /[\d\-‐‑−–—/.,:;]$/;
// 題から飾り (先頭の作者・種別、末尾の注記) を剥がす。library-match の
// strippedName と同じ形だが、あちらは検索語作りで、こちらは巻数読みが目的
const TITLE_DECOR_HEAD = /^(?:\s*[[(（【][^\][)（）【】]*[\])）】])+/;
const TITLE_DECOR_TAIL = /(?:\s*[[(（【][^\][)（）【】]*[\])）】])+$/;
// 版の尾 (「1 ver.1.02」「2 v1.1」)。巻数の後ろに付く更新版のしるしで、題でも巻数でもない
const VERSION_TAIL = /\s*(?:ver\.?|v)\s*\d+(?:\.\d+)+$/i;
// 副題 (「題 ～喰いモノにされた憧れ～」)。突き合わせの鍵からだけ落とす: 番号の無い
// 初巻は副題付きで出ていることがあり、そのままでは 2 巻以降と束にならない
const SUBTITLE_TAIL = /\s*[~～〜][^~～〜]*[~～〜]\s*$/;
// 総集編のしるし。括弧の中 (【合本版】) に居ることもあるので、飾り剥がしの前に外へ出す
const OMNIBUS_MARK = '(?:総集編|総集篇|合本版|合本)';
const OMNIBUS_BRACKET = new RegExp(`\\s*[[(（【]\\s*${OMNIBUS_MARK}\\s*[\\])）】]`, 'g');
// 収録範囲「1～6」「第1-9話」「vol.1-3」
const VOLUME_RANGE = '(?:第|#|＃|vol\\.?|volume)?\\s*(\\d{1,3})\\s*(?:巻|話)?\\s*[-‐‑−–—~～〜]\\s*(?:第)?(\\d{1,3})\\s*(?:巻|話)?';
// 「題 (範囲)? 総集編 (範囲|番号)? (+|+α)?」。範囲は総集編の前後どちらにも付く
const OMNIBUS_TAIL = new RegExp(
  `^(.*?)\\s*(?:${VOLUME_RANGE})?\\s*[-‐―]?\\s*${OMNIBUS_MARK}\\s*[-‐―]?\\s*(?:(?:${VOLUME_RANGE})|\\d{1,3})?\\s*(?:\\+\\s*α?)?$`, 'i',
);
// 総集編のしるしが無くても、末尾の範囲「題 1-4」はまとめた一冊と読む
const RANGE_TAIL = new RegExp(`^(.*?)\\s*${VOLUME_RANGE}\\s*\\+?$`, 'i');

// 突き合わせ用の鍵。副題と版マーカーを落とした titleKey
function seriesBaseOf(label) {
  return looseTitleKey(titleKey(String(label).replace(SUBTITLE_TAIL, '')));
}

// 題 → { kind, base, label, ... }。読めなければ null。
// base は突き合わせ用の鍵、label は画面に出す素の題
function seriesTitleOf(title) {
  const text = normalizeVolumeNumerals(title)
    .replace(OMNIBUS_BRACKET, ' 総集編')
    .replace(TITLE_DECOR_HEAD, '')
    .replace(TITLE_DECOR_TAIL, '')
    .replace(VERSION_TAIL, '')
    .trim();
  if (!text) return null;
  const finish = (kind, label, rest) => {
    if (!label || VOLUME_BAD_TAIL.test(label)) return null;
    const base = seriesBaseOf(label);
    // 短すぎる題は同名の別作品と混ざる。所持判定と同じ足切りを使う
    if (!titleKeyEligible(base)) return null;
    return { kind, base, label, ...rest };
  };
  const span = (from, to) => {
    if (from === undefined && to === undefined) return { from: null, to: null };
    const a = Number(from);
    const b = Number(to);
    if (!(a >= 1 && a < b && b <= MAX_SERIES_VOLUME)) return null;
    return { from: a, to: b };
  };
  const omnibus = text.match(OMNIBUS_TAIL);
  if (omnibus) {
    const range = span(omnibus[2] ?? omnibus[4], omnibus[3] ?? omnibus[5]);
    return range ? finish('omnibus', omnibus[1].trim(), range) : null;
  }
  const bundle = text.match(RANGE_TAIL);
  if (bundle) {
    const range = span(bundle[2], bundle[3]);
    return range ? finish('omnibus', bundle[1].trim(), range) : null;
  }
  const hit = text.match(VOLUME_TAIL);
  if (hit) {
    const volume = Number(hit[2]);
    const label = hit[1].trim();
    if (volume >= 1 && volume <= MAX_SERIES_VOLUME && label && !VOLUME_BAD_TAIL.test(label)) {
      return finish('volume', label, { volume });
    }
  }
  return finish('plain', text, {});
}

// 「題 N」だけを読む従来の口 (巻数が読めなければ null)
function seriesVolumeOf(title) {
  const read = seriesTitleOf(title);
  return read && read.kind === 'volume' ? read : null;
}

module.exports = {
  tagNameKey,
  titleNeedle,
  META_TAG_GROUPS,
  metaTagRows,
  titleKey,
  titleKeyWeight,
  titleKeyEligible,
  volumeSafeContains,
  looseTitleKey,
  looseKeyFromTitle,
  normalizeVolumeNumerals,
  romanNumeralValue,
  seriesBaseOf,
  seriesTitleOf,
  seriesVolumeOf,
  MAX_SERIES_VOLUME,
};
