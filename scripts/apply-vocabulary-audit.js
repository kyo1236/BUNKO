'use strict';
// 横断語彙の候補 (work/vocabulary-research/candidates.jsonl) に監査の判定
// (work/vocabulary-research/audit/overturns.csv) を当てて、
// src/lib/data/search-vocabulary.json に取り込む。網には出ない。
//
// 決まり (docs/search-vocabulary-design-2026-09-21.md §検索時の判断):
//   - 自動で移すのは exact と確かめた対応だけ。broader/narrower/related/ambiguous は
//     候補どまり (entries の inputs に relation 付きで残し、解決器が ambiguous で返す)
//   - 監査が unmapped と言った行 (中国語表記・SNS の表示名) は候補にも出さない
//   - 判断保留は自動変換に回さない
//   - 監査が exact へ戻した行は、作った側と同じ規則で auto に回せるか検め直す
//     (根拠 A/B、hitomi で実在、衝突 high でない、日本語と言い切れる)
//   - 逆向き (hitomi → pixiv) の札は一つに決める。無いと解決器が unmapped を返し、
//     既存の別名表まで塞いでしまう (fromCurated は legacy より先に答える)
//   - 既存の entries (id が c- で始まらない物) は触らない。同じ行き先なら inputs だけ足す
//
// 二度目以降の注意: 衝突の検査 (aliases.lookup) は配布中の search-vocabulary.json も
// 読むので、前回この script が書いた c- の entries と比べることになる。今は同じ値なので
// 害は無いが、札の選び方を変えた時は古い出力を相手に候補へ落としうる。疑わしければ
// git checkout で既定の 208 件に戻してから走らせる。
//
// 使い方:  node scripts/apply-vocabulary-audit.js [--dry]
//          --dry は書かずに集計だけ出す
const fs = require('node:fs');
const path = require('node:path');
const { aliasKey, hasCjk } = require('../src/lib/search-text');
const aliases = require('../src/lib/search-aliases');

const ROOT = path.join(__dirname, '..');
const RESEARCH = path.join(ROOT, 'work', 'vocabulary-research');
const TARGET = path.join(ROOT, 'src', 'lib', 'data', 'search-vocabulary.json');
const REVISION = '2026-09-21-vocabulary-3';
const MAX_EVIDENCE = 4;

// script 判定 (has-simplified-chinese) の誤認。遥・輝・嘘・彦・脚・盗・侠 は日本語の
// 常用字だが、簡体字と形が同じため中国語扱いされて自動変換から外れていた
// (監査 findings.md 型 1)。行き先ごと名指しで免除する
const SCRIPT_FALSE_POSITIVES = new Set([
  '七瀬遥', '蓬莱山輝夜', '芦戸三奈', '嘘つき屋', '快盗天使ツインエンジェル',
  '星方武侠アウトロースター', '神風怪盗ジャンヌ', '星遥ゆめ',
]);
const PERSON_KINDS = new Set(['artist', 'group']);
const CANDIDATE_RELATIONS = new Set(['broader', 'narrower', 'related', 'ambiguous']);

function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i += 1; } else quoted = false; }
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows;
  return body.filter((r) => r.length > 1).map((r) => Object.fromEntries(header.map((h, i) => [h.replace(/^﻿/, ''), r[i]])));
}

function readInputs() {
  const candidates = fs.readFileSync(path.join(RESEARCH, 'candidates.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const audit = new Map();
  for (const row of parseCsv(fs.readFileSync(path.join(RESEARCH, 'audit', 'overturns.csv'), 'utf8'))) {
    audit.set(row.id, row);
  }
  // 監査の id は candidates.csv (handoff/) から引いた物。ここに無い id は無言で
  // 無視されてしまうので、一つでも見つからなければ止める
  const known = new Set(candidates.map((row) => row.id));
  const unmatched = [...audit.keys()].filter((id) => !known.has(id));
  if (unmatched.length) throw new Error(`audit ids not in candidates.jsonl: ${unmatched.join(',')}`);
  const base = JSON.parse(fs.readFileSync(TARGET, 'utf8'));
  const sources = JSON.parse(fs.readFileSync(path.join(RESEARCH, 'sources.json'), 'utf8')).sources || [];
  return { candidates, audit, base, sources };
}

// 作った側の規則 (work/vocabulary-research/scripts/17-assemble.js) を、監査で
// exact に戻した行にも同じように当てる。人物 (artist/group) は二つの出どころが
// 揃った印を candidates.jsonl に持っていないので、元の判定を上書きしない
function recheckAuto(row) {
  const japanese = row.input.text;
  const cls = (row.review && row.review.classifier) || {};
  const pixivArticle = String((row.verification && row.verification.pixiv && row.verification.pixiv.status) || '').startsWith('dictionary-article');
  const kana = /[ぁ-ゖァ-ヺー]/.test(japanese);
  const scriptOk = SCRIPT_FALSE_POSITIVES.has(japanese)
    || (row.script !== 'has-simplified-chinese' && (kana || pixivArticle));
  if (PERSON_KINDS.has(row.termKind)) return Boolean(row.autoConvertible);
  return ['A', 'B'].includes(row.evidenceTier)
    && row.verification && row.verification.hitomi && row.verification.hitomi.status === 'confirmed'
    && cls.collisionRisk !== 'high'
    && scriptOk
    && !/[?？�□]/.test(japanese);
}

function decide(row, audit) {
  const verdict = audit.get(row.id);
  const relation = verdict ? verdict.your_relation : row.relation;
  if (relation === 'unmapped') return { drop: 'audit-unmapped' };
  if (relation === '判断保留') return { drop: 'audit-held' };
  if (relation === 'exact') {
    // 監査が触っていない exact は元の判定に従う。監査が戻した物と script の誤認は検め直す
    const promoted = Boolean(verdict) || (SCRIPT_FALSE_POSITIVES.has(row.input.text) && !row.autoConvertible);
    const auto = promoted ? recheckAuto(row) : Boolean(row.autoConvertible);
    if (!auto) return { drop: promoted ? 'exact-but-not-verifiable' : 'exact-not-auto' };
    return { relation: 'exact', auto: true, promoted };
  }
  if (!CANDIDATE_RELATIONS.has(relation)) return { drop: `unknown-relation:${relation}` };
  // 候補どまり。作者は解決器が候補を見ない (fromAuthor は別名表だけ) ので落とす
  if (PERSON_KINDS.has(row.termKind)) return { drop: 'candidate-person' };
  if (row.script === 'has-simplified-chinese' && !SCRIPT_FALSE_POSITIVES.has(row.input.text)) return { drop: 'candidate-simplified' };
  return { relation, auto: false, promoted: false };
}

function hitomiSlot(row) {
  const outs = row.outputs.filter((o) => o.site === 'hitomi');
  const pair = outs.length === 2 && outs.every((o) => o.namespace === 'female' || o.namespace === 'male');
  const type = pair ? 'either' : outs[0].namespace;
  return { type, name: outs[0].canonical, key: `${type}|${aliasKey(outs[0].canonical)}` };
}

function evidenceOf(rows) {
  const seen = new Map();
  for (const row of rows) {
    for (const item of row.evidence || []) {
      if (!item || !item.url || seen.has(item.url)) continue;
      const out = { url: item.url, method: item.kind };
      const checked = item.retrievedAt || (row.verification && row.verification.hitomi && row.verification.hitomi.checkedAt);
      if (checked) out.checkedAt = checked;
      if (item.license) out.license = item.license;
      seen.set(item.url, out);
    }
  }
  return [...seen.values()].slice(0, MAX_EVIDENCE);
}

// 逆向きの札。(a) 両方向・主表記の exact、(b) 既存の別名表の日本語札、(c) 残った exact
function pickLabel(slot, exactRows, describe) {
  const primary = exactRows.filter((r) => r.direction === 'both' && r.review && r.review.classifier && r.review.classifier.isPrimaryLabel);
  if (primary.length) return { label: primary[0].input.text, from: 'primary' };
  const both = exactRows.filter((r) => r.direction === 'both');
  if (both.length) return { label: both[0].input.text, from: 'both' };
  const known = describe(`${slot.type === 'either' ? 'female' : slot.type}:${slot.name.replace(/\s+/g, '_')}`);
  if (known && hasCjk(known.label)) return { label: known.label, from: 'existing-alias' };
  return { label: aliases.pickLabel(exactRows.map((r) => r.input.text)) || exactRows[0].input.text, from: 'fallback' };
}

function build({ candidates, audit, base, sources }, describe = aliases.describeTerm) {
  const summary = { revision: REVISION, auditRows: audit.size, dropped: {}, kept: { exact: 0, candidate: 0 }, promoted: 0, labels: {}, collisions: [], groups: 0, mergedIntoExisting: 0, candidatesWithoutExact: 0 };
  const drop = (reason) => { summary.dropped[reason] = (summary.dropped[reason] || 0) + 1; };

  const groups = new Map();
  for (const row of candidates) {
    const verdict = decide(row, audit);
    if (verdict.drop) { drop(verdict.drop); continue; }
    const slot = hitomiSlot(row);
    let group = groups.get(slot.key);
    if (!group) { group = { slot, rows: [] }; groups.set(slot.key, group); }
    group.rows.push({ row, relation: verdict.relation, auto: verdict.auto });
    if (verdict.promoted) summary.promoted += 1;
  }

  const kept = base.entries.filter((entry) => !String(entry.id).startsWith('c-'));
  const existingBySlot = new Map();
  for (const entry of kept) {
    const out = entry.outputs && entry.outputs.hitomi;
    if (out && out.name) existingBySlot.set(`${out.type}|${aliasKey(out.name)}`, entry);
  }

  // 同じ日本語が二つの行き先へ exact で向くと解決器は ambiguous を返す。作った側は
  // その組を候補から外している (same-input-multiple-targets) ので、残っていれば報告する
  const exactByInput = new Map();
  const fresh = [];
  for (const group of [...groups.values()].sort((a, b) => a.slot.key.localeCompare(b.slot.key))) {
    const exactRows = group.rows.filter((r) => r.auto).map((r) => r.row);
    const existing = existingBySlot.get(group.slot.key);
    if (!exactRows.length && !existing) { summary.candidatesWithoutExact += group.rows.length; drop('candidate-without-exact-target'); continue; }

    const target = existing || {
      id: `c-${group.slot.type}-${group.slot.name.replace(/\s+/g, '_')}`,
      inputs: [],
      outputs: {},
      evidence: [],
    };
    if (!existing) {
      const picked = pickLabel(group.slot, exactRows, describe);
      summary.labels[picked.from] = (summary.labels[picked.from] || 0) + 1;
      target.outputs.hitomi = { type: group.slot.type, name: group.slot.name, label: picked.label };
      const nh = exactRows.map((r) => r.outputs.find((o) => o.site === 'nhentai')).find(Boolean);
      if (nh) target.outputs.nhentai = { type: nh.namespace, name: nh.canonical, label: picked.label };
      target.outputs.pixiv = { type: 'tag', name: picked.label, label: picked.label };
      target.evidence = evidenceOf(exactRows);
      fresh.push(target);
      summary.groups += 1;
    } else {
      summary.mergedIntoExisting += 1;
      target.evidence = [...(target.evidence || []), ...evidenceOf(exactRows)]
        .filter((item, index, all) => all.findIndex((other) => other.url === item.url) === index);
    }

    // 同じ語が exact と候補の両方にあれば exact を残す (監査 型 8: 重複行)
    const wanted = new Map();
    for (const { row, relation } of group.rows) {
      const key = aliasKey(row.input.text);
      const current = wanted.get(key);
      if (!current || (relation === 'exact' && current.relation !== 'exact')) wanted.set(key, { name: row.input.text, relation });
    }
    for (const { name, relation } of wanted.values()) {
      const key = aliasKey(name);
      if (target.inputs.some((input) => aliasKey(input.name) === key)) continue;
      target.inputs.push({ site: 'pixiv', type: 'tag', name, relation });
      if (relation === 'exact') {
        summary.kept.exact += 1;
        const seenAt = exactByInput.get(key);
        if (seenAt && seenAt !== group.slot.key) summary.collisions.push({ input: name, targets: [seenAt, group.slot.key] });
        exactByInput.set(key, group.slot.key);
      } else summary.kept.candidate += 1;
    }
  }

  // 既存の別名表 (aliases.json) が別の値へ向けている語を exact で上書きしない。
  // 見つかったら候補へ落とす
  for (const entry of fresh) {
    const value = `${entry.outputs.hitomi.type}:${entry.outputs.hitomi.name.replace(/\s+/g, '_')}`;
    const pair = entry.outputs.hitomi.type === 'either'
      ? [`female:${entry.outputs.hitomi.name.replace(/\s+/g, '_')}`, `male:${entry.outputs.hitomi.name.replace(/\s+/g, '_')}`] : [];
    for (const input of entry.inputs) {
      if (input.relation !== 'exact') continue;
      const elsewhere = aliases.lookup(input.name).filter((hit) => hit.value !== value && !pair.includes(hit.value));
      if (elsewhere.length) {
        input.relation = 'ambiguous';
        summary.collisions.push({ input: input.name, targets: [value, ...elsewhere.map((hit) => hit.value)], demoted: true });
        summary.kept.exact -= 1; summary.kept.candidate += 1;
      }
    }
  }
  // exact が一つも残らなかった新規 entry は逆向きの札を保証できないので落とす
  const emitted = fresh.filter((entry) => entry.inputs.some((input) => input.relation === 'exact'));
  summary.groups = emitted.length;

  const provenance = sources.filter((s) => ['ehtag-translation', 'danbooru-tags-wiki', 'danbooru-artists', 'hitomi-all-listings', 'nhentai-api-tags', 'pixiv-encyclopedia'].includes(s.id))
    .map((s) => ({ id: s.id, what: s.what, url: (s.urls || [])[0], version: s.version, license: s.license, checkedAt: s.retrievedAt, useHere: s.useHere }));
  const data = {
    ...base,
    revision: REVISION,
    sources: [...(base.sources || []).filter((s) => !s.id), ...provenance],
    entries: [...kept, ...emitted],
  };
  return { data, summary };
}

function main() {
  const dry = process.argv.includes('--dry');
  const inputs = readInputs();
  const { data, summary } = build(inputs);
  const json = `${JSON.stringify(data, null, 1)}\n`;
  summary.entries = data.entries.length;
  summary.inputs = data.entries.reduce((n, entry) => n + entry.inputs.length, 0);
  summary.bytes = Buffer.byteLength(json);
  if (!dry) {
    fs.writeFileSync(TARGET, json);
    fs.writeFileSync(path.join(RESEARCH, 'audit', 'apply-summary.json'), `${JSON.stringify({ builtAt: new Date().toISOString(), ...summary }, null, 1)}\n`);
  }
  console.log(JSON.stringify(summary, null, 1));
}

if (require.main === module) main();
module.exports = { build, decide, recheckAuto, parseCsv };
