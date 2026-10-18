'use strict';

// 所持の本の公開日の控え (Eagle の項目 id → 日付と根拠)。名前に [YYYYMMDD] が無く、作者頁で「日付不明」に
// 落ちていた本に、網で見つけた公開日を当てる (2026-09-24 の調べ)。
//
// 見つけ方は外の道具 (作者の pixiv / Pawchive / hitomi の一覧と題の突き合わせ、店の頁) で、ここは結果を持つだけ。
// 名前の日付・pixiv の台帳の日付が先で、この控えはその次 (home-authors の folderBook が決める)。
//
// 一行の形:
//   { date: 'YYYY-MM-DD', confidence: 'exact' | 'high' | 'medium' | 'low', basis, method, hits: [{ site, id, date }], by, at }
//   confidence  exact = pixiv の投稿 ID そのもの。high = 題の一致で実測 99% が 31 日以内。
//               medium / low = 推定 (画面は「頃」を添える)
//   basis       日付の出どころ (pixiv-post / pawchive-post / hitomi-published / hitomi-uploaded / 店の名 …)
//   hits        根拠の作品の id だけ (題と URL は書かない: 記録に作品名を残さない)
//
// state-file の KIND 'release-dates' (follow): 母艦が書き、同期で写しへ届く。写しは読むだけで、
// 同期が差し替えたら読み直す (時々 stat を見る。creator-links と同じ)。electron を引かない。

const fs = require('fs');
const stateFile = require('./state-file');

const VERSION = 1;
const CONFIDENCE = ['low', 'medium', 'high', 'exact'];
// 推定の日付 (画面は「頃」を添える)
const GUESS = new Set(['low', 'medium']);
// 写しで同期が差し替えたかを見る間合い
const RELOAD_CHECK_MS = 5000;
const EAGLE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SHORT = /^[\w.:/-]{1,120}$/;

function validDate(value) {
  const text = String(value == null ? '' : value).trim();
  const hit = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!hit) return '';
  const year = Number(hit[1]);
  const month = Number(hit[2]);
  const day = Number(hit[3]);
  if (year < 1990 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return '';
  return text;
}

function short(value) {
  const text = String(value == null ? '' : value).trim();
  return SHORT.test(text) ? text : '';
}

// 読み書きの両方で同じ形に揃える。形の悪い行は null
function cleanRow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const date = validDate(raw.date);
  const confidence = CONFIDENCE.includes(raw.confidence) ? raw.confidence : '';
  if (!date || !confidence) return null;
  const hits = (Array.isArray(raw.hits) ? raw.hits : []).slice(0, 8).map((hit) => ({
    site: short(hit && hit.site),
    id: short(hit && hit.id),
    date: validDate(hit && hit.date),
  })).filter((hit) => hit.site && hit.id);
  return {
    date,
    confidence,
    basis: short(raw.basis),
    method: short(raw.method),
    hits,
    by: String(raw.by == null ? '' : raw.by).slice(0, 80),
    at: String(raw.at == null ? '' : raw.at).slice(0, 40),
  };
}

class ReleaseDates {
  // file: release-dates.json の道 (空なら記憶の中だけで持つ。試験用)
  constructor({ file = '', now = Date.now } = {}) {
    this.file = file;
    this.now = now;
    this.rows = new Map();
    this.loaded = false;
    this.stamp = '';
    this.checkedAt = 0;
    this.revision = 0;
  }

  statStamp() {
    if (!this.file) return '';
    try {
      const stat = fs.statSync(this.file);
      return `${stat.size}:${stat.mtimeMs}`;
    } catch {
      return '';
    }
  }

  read() {
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      parsed = null;
    }
    const rows = new Map();
    const source = parsed && parsed.rows && typeof parsed.rows === 'object' ? parsed.rows : {};
    for (const [eagleId, raw] of Object.entries(source)) {
      const row = EAGLE_ID.test(eagleId) ? cleanRow(raw) : null;
      if (row) rows.set(eagleId, row);
    }
    this.rows = rows;
    this.stamp = this.statStamp();
    this.revision += 1;
  }

  load() {
    const now = this.now();
    if (!this.loaded) {
      this.loaded = true;
      this.checkedAt = now;
      if (this.file) this.read();
      return this;
    }
    // 写しでは同期が一枚ごと差し替える。母艦でも外の道具が書き足す。時々だけ stat を見て、変わっていれば読み直す
    if (this.file && now - this.checkedAt >= RELOAD_CHECK_MS) {
      this.checkedAt = now;
      const stamp = this.statStamp();
      // 一瞬 stat できない (差し替えの間) だけでは空にしない
      if (stamp && stamp !== this.stamp) this.read();
    }
    return this;
  }

  save() {
    this.revision += 1;
    if (!this.file) return true;
    const rows = {};
    for (const [eagleId, row] of this.rows) rows[eagleId] = row;
    const ok = stateFile.writeJson('release-dates', this.file, { version: VERSION, rows });
    if (ok) this.stamp = this.statStamp();
    return ok;
  }

  // 変わるたびに進む数。Home の控えがこれで組み直しを知る
  version() {
    this.load();
    return this.revision;
  }

  // 一冊の公開日 ({ date, confidence, basis, guess, … }) か null
  get(eagleId) {
    this.load();
    const row = this.rows.get(String(eagleId || ''));
    return row ? { ...row, guess: GUESS.has(row.confidence) } : null;
  }

  size() {
    this.load();
    return this.rows.size;
  }

  // まとめて書く ([{ eagleId, date, confidence, basis, method, hits }]、by は出どころの一言)。
  // 確かさの低い行で高い行を上書きしない (同じ確かさなら新しい方)。remove: true の行は外す
  set(list = [], { by = '' } = {}) {
    this.load();
    const at = new Date(this.now()).toISOString();
    let added = 0;
    let updated = 0;
    let removed = 0;
    let skipped = 0;
    for (const item of Array.isArray(list) ? list : []) {
      const eagleId = String(item && item.eagleId || '');
      if (!EAGLE_ID.test(eagleId)) {
        skipped += 1;
        continue;
      }
      if (item.remove === true) {
        if (this.rows.delete(eagleId)) removed += 1;
        continue;
      }
      const row = cleanRow({ ...item, by: item.by || by, at });
      if (!row) {
        skipped += 1;
        continue;
      }
      const current = this.rows.get(eagleId);
      if (current && CONFIDENCE.indexOf(row.confidence) < CONFIDENCE.indexOf(current.confidence)) {
        skipped += 1;
        continue;
      }
      this.rows.set(eagleId, row);
      if (current) updated += 1;
      else added += 1;
    }
    const ok = added || updated || removed ? this.save() : true;
    return { ok, added, updated, removed, skipped };
  }
}

module.exports = { ReleaseDates, CONFIDENCE, GUESS: [...GUESS] };
