'use strict';

// 候補の見た目を一箇所で決める。hitomi・pixiv・nhentai で別々に書かない。
//
//   主表示 (label)      日本語名。無ければ元の語をそのまま
//   補助表示 (secondary) 所属作品の日本語名。種類は線の色が言うので字では書かない
//   件数 (metric)        そのサイト自身の数だけ。他サイトの数は持ち込まない
//
// 押さえる線:
//   - 飾るのは「辞書で一つに定まる時」だけ。pixiv の「アスナ」は四人以上を指すので
//     人物にも所属作品にもしない (名前が似ているだけで分類しない)
//   - 主表示と同じ字を補助表示に二度出さない
//   - ここは**見た目だけ**。検索に送る値は search-intent の compile が組む
const { aliasKey } = require('./search-text');
const { TYPE_ALIASES } = require('./search-type');
const aliases = require('./search-aliases');

// そのサイトで実際に打てる文字列を組む。構文の持ち主は search-intent 一箇所
function nativeValue(term, site) {
  const engine = require('./search-intent');
  const plan = engine.compile({
    version: 1,
    source: 'hitomi',
    query: '',
    terms: [{
      kind: term.type === 'artist' ? 'author' : 'tag',
      type: term.type,
      name: term.name,
      label: term.label,
      raw: '',
      negative: false,
      native: {},
    }],
  }, site);
  return text(plan.query);
}

// 型の日本語。TYPE_ALIASES を裏返す (表を二つ持たない)
const TYPE_LABELS = (() => {
  const out = new Map();
  for (const [japanese, type] of TYPE_ALIASES) {
    if (/^[ぁ-んァ-ヶー一-鿿]/.test(japanese) && !out.has(type)) out.set(type, japanese);
  }
  out.set('female', '女');
  out.set('male', '男');
  out.set('either', 'タグ');
  return out;
})();

// 人や作品として名前を持つ型。自由なタグとは扱いが違う
const NAMED_TYPES = new Set(['character', 'series', 'artist', 'group']);

const text = (value) => String(value == null ? '' : value).trim();
const atom = (name) => text(name).replace(/\s+/g, '_');

// その語がそのサイトで引けると確かめてあるか。
// 印が無い型は今まで通り通す (印を付けていない = 調べていない、であって「無い」ではない)
function forSite(entry, site) {
  if (!entry) return false;
  const sites = entry.sites;
  // hitomi は既定で通す。ただし「hitomi には無い」と**名指しで**印を付けた語は出さない
  // (pixiv にしか無い人物。出しても 0 件になる)。印が無い語は今まで通り
  if (site === 'hitomi') return !(sites && sites.hitomi === false);
  if (!sites || !Object.prototype.hasOwnProperty.call(sites, site)) return true;
  return sites[site] === true;
}

// 所属作品の日本語名。series の札は辞書が決めている (上書き > 横断語彙 > 一般則)
function seriesLabelOf(entry) {
  const name = text(entry && entry.series);
  if (!name) return '';
  try {
    const row = aliases.loadData().byValue.get(`series:${atom(name)}`);
    if (row && text(row.label)) return text(row.label);
  } catch { /* 辞書が読めなければ正準名をそのまま出す */ }
  return name;
}

// 辞書の項目を引く。
//   1. 正準の型と名前を持っているなら、それで一意に引く (前方一致はしない)
//   2. pixiv の候補のように型を持たない日本語だけの語は、
//      **その型で一つに定まる時だけ** 人物・作品として扱う
function entryFor(item) {
  const type = text(item.type);
  const name = text(item.name);
  if (!name) return null;
  const data = aliases.loadData();
  if (type && type !== 'tag') {
    const direct = data.byValue.get(`${type}:${atom(name)}`);
    if (direct) return direct;
  }
  // 飾りは候補専用の索引 (pixiv にしか無い人物) も見る。どのサイトへ出すかは
  // forSite が別に決めるので、ここで見ても hitomi に漏れない
  const hits = aliases.lookupForDisplay(name).filter((row) => NAMED_TYPES.has(row.type));
  if (hits.length !== 1) return null;
  // 同じ人物が hitomi で二つの語に分かれている場合もあるので、型まで一致を見る
  return hits[0];
}

// 候補一つを飾る。item は {type,name,label?,count?,metric?,translation?}
function decorate(item, site) {
  const row = item && typeof item === 'object' ? { ...item } : {};
  const entry = entryFor(row);
  const original = text(row.label) || text(row.name);

  if (entry) {
    if (NAMED_TYPES.has(entry.type)) row.type = entry.type;
    if (text(entry.label)) row.label = text(entry.label);
    const series = seriesLabelOf(entry);
    if (series) row.seriesLabel = series;
    if (entry.series) row.series = entry.series;
    if (entry.vtuber && text(entry.vtuber.label)) row.vtuber = { ...entry.vtuber };
  }
  if (!text(row.label)) row.label = original;

  const typeLabel = TYPE_LABELS.get(text(row.type)) || '';
  if (typeLabel) row.typeLabel = typeLabel;

  // 補助表示は所属作品だけ。種類は画面が線の色で言う (詳細画面のタグと同じ色)。
  // 主表示と同じ字は出さない (同じ文字を二段にしない)
  // 札が既に所属を名乗っている時は繰り返さない (「アスナ(ブルアカ)」に ブルアカ を添えない)
  // VTuber は「作品」ではなく「事務所」に属する。所属が分かっているなら
  // 「VTuber (ホロライブ)」、事務所に属さないなら「VTuber (個人)」と出す。
  // hitomi に series が無い事務所 (ぶいすぽ・あおぎり・ななしいんく) もここで出せる。
  // 押して飛ぶ値は今まで通り人物の語なので、引けない札にはならない
  if (row.vtuber && text(row.vtuber.label)) {
    row.secondary = `VTuber (${text(row.vtuber.label)})`;
    delete row.seriesLabel;
  } else {
    const series = text(row.seriesLabel);
    const shown = aliasKey(row.label);
    const key = aliasKey(series);
    row.secondary = series && key && !shown.includes(key) ? series : '';
    if (!row.secondary) delete row.seriesLabel;
  }

  // 件数はそのサイト自身の物だけ。無ければ持たない
  if (!row.metric || row.metric.site !== site) {
    delete row.metric;
    if (row.count != null && !(item && item.metric && item.metric.site === site)) delete row.count;
  }
  return row;
}

// pixiv へ送る日本語。札は「アスナ(SAO)」のように所属の注記が付くことがあり、
// そのまま打っても 0 件になる。括弧の無い正式名 (結城明日奈) を選ぶ
function searchableName(entry, fallback) {
  const ok = (label) => Boolean(label) && !/[()（）]/.test(label)
    && !/[A-Za-z0-9]/.test(label) && /[぀-ヿ一-鿿]/.test(label);
  // 画面に出している札が素直ならそれが一番いい (日野下花帆)
  const shown = text(entry && entry.label);
  if (ok(shown)) return shown;
  // 札が注記付き (アスナ(SAO)) の時だけ、別名から正式名を拾う。
  // 長い物ほど正式名に近いが、同人の長い符丁を掴まないよう丈を抑える
  const labels = (entry && Array.isArray(entry.labels) ? entry.labels : []).map(text).filter(ok);
  const full = labels.filter((label) => /[一-鿿]/.test(label) && label.length >= 3 && label.length <= 10);
  if (full.length) return full.sort((a, b) => b.length - a.length)[0];
  return labels[0] || text(fallback);
}

// 辞書から、そのサイトで引ける候補を作る。
// 対応先を確かめられない語は確定候補にしない (検索できない候補を出さない)
function fromDictionary(term, site, limit = 8) {
  const rows = [];
  for (const hit of aliases.suggestAliases(term, limit * 2)) {
    const entry = aliases.loadData().byValue.get(hit.value);
    if (!forSite(entry || hit, site)) continue;
    // pixiv は日本語で引くサイト。日本語名を持たない語は送っても 0 件になる
    if (site === 'pixiv' && !/[぀-ヿ一-鿿]/.test(text(hit.label))) continue;
    const decorated = decorate({ ...hit, series: entry && entry.series, sites: entry && entry.sites, vtuber: entry && entry.vtuber }, site);
    // 送る値はサイトごと。hitomi の `character:～` を pixiv へ素で送らない
    const sendLabel = site === 'pixiv' ? searchableName(entry, decorated.label) : decorated.label;
    if (site === 'pixiv' && !sendLabel) continue;
    const value = nativeValue({ type: decorated.type, name: String(decorated.name).replace(/_/g, ' '), label: sendLabel }, site);
    if (!value) continue;
    decorated.value = value;
    rows.push(decorated);
    if (rows.length >= limit) break;
  }
  return rows;
}

module.exports = { decorate, forSite, fromDictionary, searchableName, TYPE_LABELS };
