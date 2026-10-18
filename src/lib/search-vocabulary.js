'use strict';

// サイトをまたぐ語の言い換えを一箇所で決める。設計は
// docs/search-vocabulary-design-2026-09-21.md。押さえるのは三つ:
//   1. 自由語とサイト固有の書き方は触らない (辞書に当たっただけで語彙へ昇格させない)
//   2. 自動で移すのは「完全一致」と確かめた対応だけ。広い意味・関連は候補どまり
//   3. 「行き先に語が無い (unmapped)」と「こちらは何も言わない (passthrough)」を混ぜない
// 一回の解決で網に触らない。読むのは取り込み済みの JSON と既存の別名表だけ。

const { aliasKey, hasCjk } = require('./search-text');
const aliases = require('./search-aliases');

// 型を決めない語。pixiv で選んだタグはいつもこれ
const GENERIC_TYPES = new Set(['', 'tag', 'either']);
// 「男でも女でもよい」を書ける行き先。今は hitomi だけ (search-providers の namespaces)。
// 広げるかは親の判断なので、一行で開けられる形にしておく
const EITHER_TARGETS = new Set(['hitomi']);
const MAX_CANDIDATES = 4;
const MAX_EVIDENCE = 4;

const text = (value) => String(value == null ? '' : value).trim();
const atom = (name) => text(name).replace(/\s+/g, '_');
// 表記ゆれ (全角・かな・大文字小文字) は吸収する。意味を狭める語は落とさない
const sameName = (a, b) => { const key = aliasKey(a); return Boolean(key) && key === aliasKey(b); };
const sameRow = (a, b) => text(a.type) === text(b.type) && sameName(a.name, b.name);
const slot = (type, name) => `${text(type) || 'tag'}|${aliasKey(name)}`;
const valueOf = (row) => ({ type: text(row.type) || 'tag', name: text(row.name), label: text(row.label) });

const pass = (reason) => ({ status: 'passthrough', reason });
const unmapped = (reason) => ({ status: 'unmapped', reason });
function decided(status, payload, reason, evidence) {
  const out = { status, ...payload, reason };
  if (evidence && evidence.length) out.evidence = evidence;
  return out;
}
const resolvedAs = (value, reason, evidence) => decided('resolved', { value }, reason, evidence);
const ambiguousAs = (candidates, reason, evidence) =>
  decided('ambiguous', { candidates: candidates.slice(0, MAX_CANDIDATES) }, reason, evidence);

// ---- 取り込み済みの対応表 ----------------------------------------------------

function indexEntries(entries) {
  const inputs = new Map();
  const outputs = new Map();
  const add = (map, key, item) => { const list = map.get(key); if (list) list.push(item); else map.set(key, [item]); };
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== 'object') continue;
    for (const input of Array.isArray(entry.inputs) ? entry.inputs : []) {
      if (!input || !aliasKey(input.name)) continue;
      // サイトと型は鍵に残す。hitomi の female と male は別物 (設計 §保存するもの)
      add(inputs, `${text(input.site) || '*'}|${slot(input.type, input.name)}`,
        { entry, relation: text(input.relation) || 'exact' });
    }
    const outs = entry.outputs && typeof entry.outputs === 'object' ? entry.outputs : {};
    for (const [site, out] of Object.entries(outs)) {
      if (!out || !aliasKey(out.name)) continue;
      add(outputs, `${text(site)}|${slot(out.type, out.name)}`, entry);
    }
  }
  return { inputs, outputs };
}

function matched(inputs, key, exact) {
  return (inputs.get(key) || [])
    .filter((hit) => (hit.relation === 'exact') === exact)
    .map((hit) => hit.entry);
}

function evidenceOf(entries) {
  const seen = new Map();
  for (const entry of entries) {
    for (const item of Array.isArray(entry.evidence) ? entry.evidence : []) {
      const key = `${text(item && item.url)}|${text(item && item.method)}`;
      if (!seen.has(key)) seen.set(key, item);
    }
  }
  return [...seen.values()].slice(0, MAX_EVIDENCE);
}

function outputsOf(entries, target) {
  const values = new Map();
  const used = [];
  for (const entry of new Set(entries)) {
    const out = entry.outputs && entry.outputs[target];
    if (!out || !aliasKey(out.name)) continue;
    used.push(entry);
    const value = valueOf(out);
    const key = slot(value.type, value.name);
    if (!values.has(key)) values.set(key, value);
  }
  return { values: [...values.values()], evidence: evidenceOf(used) };
}

// 男女を明示した語が、行き先では either として取り込んである場合。
// 「どちらでもよい」へ丸めるのは意味を変えるので、逆引きでも候補にとどめる
function looseReverse(index, source, term) {
  const type = text(term.type);
  if (type !== 'male' && type !== 'female') return [];
  return index.outputs.get(`${source}|either|${aliasKey(term.name)}`) || [];
}

function fromCurated(term, source, target, index) {
  const key = slot(term.type, term.name);
  const exact = [
    ...matched(index.inputs, `${source}|${key}`, true),
    ...matched(index.inputs, `*|${key}`, true),
    // 逆向き: 行き先の語として取り込んだ物は、そのまま別の行き先へ渡せる
    ...(index.outputs.get(`${source}|${key}`) || []),
  ];
  if (exact.length) {
    const { values, evidence } = outputsOf(exact, target);
    if (!values.length) return unmapped('取り込み済みだが行き先に語が無い');
    // 複数あるなら先頭を選ばない。どれかは利用者が決める (設計 §検索時の判断 3)
    return values.length === 1
      ? resolvedAs(values[0], '取り込み済みの完全一致', evidence)
      : ambiguousAs(values, '取り込み済みの対応が複数ある', evidence);
  }
  const near = [
    ...matched(index.inputs, `${source}|${key}`, false),
    ...matched(index.inputs, `*|${key}`, false),
    ...looseReverse(index, source, term),
  ];
  if (near.length) {
    const { values, evidence } = outputsOf(near, target);
    if (values.length) return ambiguousAs(values, '意味の広さが同じとは確かめていない', evidence);
  }
  return null;
}

// ---- 既存の別名表 (aliases.json + 手動) への落とし -----------------------------

// pixiv は日本語で引くサイト。日本語を持たないまま英語の下線語を送ると黙って
// 0 件になる (設計で再現した「おしっこ」の裏返し)。出せない時は出せないと返す
function forTarget(value, target) {
  if (target !== 'pixiv') return value;
  if (!hasCjk(value.label) && !hasCjk(value.name)) return null;
  // 画面の札は所属を注記することがある (アスナ(SAO))。そのまま pixiv へ送ると
  // タグとして当たらないので、送る時だけ注記の無い正式名 (結城明日奈) に替える。
  // 表示は替えない — 見た目と送る値は別物
  if (/[()（）]/.test(text(value.label))) {
    try {
      const { searchableName } = require('./search-decorate');
      const entry = aliases.loadData().byValue.get(`${value.type}:${atom(value.name)}`);
      const sendable = searchableName(entry, '');
      if (sendable) return { ...value, label: sendable };
    } catch { /* 辞書が読めなければ札のまま送る */ }
  }
  return value;
}

function isTrusted(name, row, ctx) {
  if (sameName(name, row.name)) return true;   // 正準の値をそのまま入力した
  if (sameName(name, row.label)) return true;  // 辞書が選んだ札と同じ字
  // 手で「これ」と決めた別名 (manual-aliases の preferred) だけは完全一致とみなす
  return ctx.lookup(name).some((hit) => hit && hit.preferred && sameRow(hit, row));
}

function fromAliasRows(term, target, type, ctx) {
  const rows = ctx.lookup(term.name).filter((row) => row && text(row.name)
    && (GENERIC_TYPES.has(type) || row.type===type));
  if (!rows.length) return null;
  const sexes = rows.filter((row) => row.type === 'male' || row.type === 'female');
  const oneWord = sexes.length > 1 && sexes.every((row) => sameName(row.name, sexes[0].name));
  // 男女で同じ語が並ぶだけなら、型を決めていない入力を片方へ狭めない。
  // either を書ける行き先にはまとめて渡す (男/女 と明示した語はここへ来ない)
  if (oneWord && sexes.length===rows.length && sexes.every(row=>isTrusted(term.name,row,ctx))
      && GENERIC_TYPES.has(type) && EITHER_TARGETS.has(target)) {
    const value = forTarget({ type: 'either', name: text(sexes[0].name), label: text(sexes[0].label) }, target);
    if (value) return resolvedAs(value, '男女で同じ語。行き先は either を書ける');
  }
  const seen = new Set();
  const candidates = rows
    .slice()
    .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
    .map((row) => forTarget(valueOf(row), target))
    .filter((value) => {
      if (!value) return false;
      const key = slot(value.type, value.name);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  if (!candidates.length) return null;
  return ambiguousAs(candidates, '別名表では一つに定まらない');
}

function fromLegacy(term, target, ctx) {
  const name = text(term.name);
  const type = text(term.type) || 'tag';
  let row = ctx.describe(`${type}:${atom(name)}`);
  // pixiv で選んだ語は型を持たない。型付きで当たらない時だけ素の語で訊き直す
  // (キャラ名・原作名は tag: の枠では弾かれるため)
  if (!row && text(term.source) === 'pixiv' && GENERIC_TYPES.has(text(term.type))) row = ctx.describe(name);
  if (row && text(row.name)) {
    const value = forTarget(valueOf(row), target);
    if (!value) return unmapped('行き先に出せる表記が無い');
    if (isTrusted(name, row, ctx)) return resolvedAs(value, '既存の別名表で一意');
    // 「眼鏡男子」と「メガネ」は同じ意味ではない。候補までにして自動では倒さない
    return ambiguousAs([value], '別名としては当たるが完全同義とは確かめていない');
  }
  return fromAliasRows(term, target, type, ctx);
}

// ---- 入口 --------------------------------------------------------------------

// 作者の同一人物判定は語彙の仕事ではない。同じ表示名・同じ番号でも別人でありうる
// (設計 §検索時の判断)。ここで見るのは既存の別名表が一人に定まるかだけ
function fromAuthor(term, ctx) {
  const row = ctx.describe(`artist:${atom(term.name)}`);
  if (row && text(row.name) && text(row.type) === 'artist') return resolvedAs(valueOf(row), '既存の別名表で作者が一意');
  return pass('作者の同一性は別の仕組みが決める');
}

function fromTag(term, target, ctx) {
  const source = text(term.source) || '*';
  const curated = fromCurated(term, source, target, ctx.index);
  if (curated) return curated;
  const legacy = fromLegacy(term, target, ctx);
  if (legacy) return legacy;
  // pixiv で選んだ語に対応が無いまま別サイトへ送ると `tag:日本語` で 0 件になる
  // (設計 §検索時の判断 4)。分からないものは分からないと返す
  if (source === 'pixiv') return unmapped('pixiv の語に対応が無い');
  // 型付きのタグは、今まで通りアダプタが各サイトの構文へ写せる
  return pass('対応が無い。今まで通りの構文で写す');
}

function resolve(term, target, ctx) {
  const site = text(target);
  if (!term || typeof term !== 'object') return pass('語が無い');
  if (!site) return pass('行き先が無い');
  const kind = text(term.kind) || (text(term.type) === 'artist' ? 'author' : 'tag');
  const native = term.native && typeof term.native === 'object' ? term.native : {};
  // 自由語を辞書に当てただけでタグへ変えない (設計 §検索時の判断)
  if (kind === 'text') return pass('自由語はそのまま');
  if (kind === 'native') return pass('サイト固有の書き方はそのまま');
  // 行き先の原文を持っているなら、それを戻すのが往復の正解。訳し直さない
  if (text(native[site])) return pass('行き先の原文を持っている');
  if (text(term.source) === site) return pass('出どころと行き先が同じ');
  if (!text(term.name)) return pass('名前が無い');
  if (kind === 'author') return fromAuthor(term, ctx);
  return fromTag(term, site, ctx);
}

// ---- 組み立て ----------------------------------------------------------------

function defaultDescribeTerm(raw) {
  try {
    return aliases.describeTerm(raw);
  } catch {
    return null;
  }
}

// aliases.lookup は「手で選んだ一つ (preferred)」の印を持たないので、ここで付け足す
function defaultLookup(name) {
  try {
    const preferred = aliases.loadData().preferredByKey.get(aliasKey(name));
    return aliases.lookup(name).map((row) => (row === preferred ? { ...row, preferred: true } : row));
  } catch {
    return [];
  }
}

function createVocabulary(options = {}) {
  const ctx = {
    describe: typeof options.describe === 'function' ? options.describe : defaultDescribeTerm,
    lookup: typeof options.lookup === 'function' ? options.lookup : defaultLookup,
    index: indexEntries(options.entries),
  };
  return {
    revision: text(options.revision),
    resolve: (term, target) => resolve(term, target, ctx),
  };
}

let shared = null;

// 取り込み済みの対応表は一度だけ読む。まだ無い間は既存の別名表だけで動く
// (取り込みの失敗を「対応なし」に見せない — 設計 §検索時の判断)
function vocabulary() {
  if (shared) return shared;
  let data = null;
  try {
    data = require('./data/search-vocabulary.json');
  } catch {
    data = null;
  }
  shared = createVocabulary({ entries: (data && data.entries) || [], revision: (data && data.revision) || '' });
  return shared;
}

module.exports = {
  createVocabulary,
  resolve: (term, target) => vocabulary().resolve(term, target),
  get revision() { return vocabulary().revision; },
};
