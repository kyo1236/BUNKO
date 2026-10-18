'use strict';

// 名乗り ↔ 作者 の確定した結び (docs/cross-site-author-search-2026-09-21.md §6-3・docs/adr/0002)。
//
// 作者 (人) の鍵は Eagle の作者フォルダ id。作者フォルダの人の pixiv の user_id は pixiv-library.json の creators、
// Pawchive の service:user は paw-links.json の creators が既に持っているので、ここには写さない
// (三つ目の置き場を作らない)。ここが持つのは足りない一辺だけ:
//   - hitomi / nhentai の名乗り → 作者フォルダ ('<作者フォルダ id>')。hitomi のサークルは 'group:<名>'
//   - 作者フォルダを持たない hitomi だけの人 ('h:<artist>')・サークル ('c:<group>') の pixiv / Pawchive / nhentai の名乗り
//     (置き場の鍵が作者フォルダの二つの台帳には書けないので、ここが持つ)
//   - 作者の★ (ratings: 人の鍵 → 1〜5)。行ではなく今の値だけを持つ
//   - 持ち込みの本の出どころ (origins: 人の鍵 → 'discord')。分からない本の ? を出どころのアイコンに変える
//   - 見出しの名前 (names: 人の鍵 → 名前)。利用者が「〜に統一」と決めた名前が、サークル名や作者名より先に立つ
//   - 見出しの表紙 (covers: 人の鍵 → 本の id)。利用者がその人の所持の本から選んだ一冊。自動の顔 (一番新しい本) より先に立つ
//   - 突き合わせの候補 (suggestions: { personId, source, name, note, by, at })。確かめるまで結ばない。
//     詳細の板に候補 (点線の鎖) として出し、結ぶ / 違う で答えると行 (rows) の方に残る
//
// 一行の形 (§6-3 と同じ):
//   { personId, source: 'hitomi' | 'nhentai' | 'pixiv' | 'pawchive', name, evidence: 'user-confirmed', by, at, note, revokedAt? }
// 行は消さない。「外す」も「違う」(候補を退ける) も revokedAt の立った行で言う
// (同じ判断を二度訊かれないため)。同じ (personId, source, name) の一番新しい行がその組の今の答え。
//
// state-file の KIND 'creator-links' (follow): 母艦が書き、同期で写しへ届く。写しは読むだけで、
// 同期が差し替えたら読み直す (時々 stat を見る)。electron を引かない。

const fs = require('fs');
const stateFile = require('./state-file');

const VERSION = 1;
const SOURCES = new Set(['hitomi', 'nhentai', 'pixiv', 'pawchive']);
// 持ち込みの本の出どころとして選べる物
const ORIGINS = new Set(['discord']);
// 見出しの名前の長さの上限
const NAME_MAX = 80;
// 表紙に選んだ本の id の長さの上限 (pweagle:<Eagle の id> / px:<投稿 ID> / hitomi の gid)
const COVER_MAX = 200;
// 写しで同期が差し替えたかを見る間合い。母艦では自分の書き込みで印を進めるので空振りするだけ
const RELOAD_CHECK_MS = 5000;

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function keyOf(personId, source, name) {
  return JSON.stringify([clean(personId), clean(source), clean(name)]);
}

class CreatorLinks {
  // file: creator-links.json の道 (空なら記憶の中だけで持つ。試験用)
  constructor({ file = '', now = Date.now } = {}) {
    this.file = file;
    this.now = now;
    this.rows = [];
    // 作者の★ (人の鍵 → { star, at })
    this.ratings = {};
    // 突き合わせの候補
    this.suggested = [];
    // 持ち込みの本の出どころ (人の鍵 → { origin, at })
    this.origins = {};
    // 見出しの名前 (人の鍵 → { name, at })
    this.names = {};
    // 見出しの表紙 (人の鍵 → { id, at })
    this.covers = {};
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
    const rows = parsed && Array.isArray(parsed.rows) ? parsed.rows : [];
    this.rows = rows
      .filter((row) => row && typeof row === 'object' && SOURCES.has(clean(row.source)) && clean(row.personId) && clean(row.name))
      .map((row) => ({ ...row }));
    this.suggested = (parsed && Array.isArray(parsed.suggestions) ? parsed.suggestions : [])
      .filter((row) => row && typeof row === 'object' && SOURCES.has(clean(row.source)) && clean(row.personId) && clean(row.name))
      .map((row) => ({ ...row }));
    this.names = {};
    const names = parsed && parsed.names && typeof parsed.names === 'object' ? parsed.names : {};
    for (const [personId, value] of Object.entries(names)) {
      const name = clean(value && value.name).slice(0, NAME_MAX);
      if (clean(personId) && name) this.names[clean(personId)] = { name, at: String(value.at || '') };
    }
    this.covers = {};
    const covers = parsed && parsed.covers && typeof parsed.covers === 'object' ? parsed.covers : {};
    for (const [personId, value] of Object.entries(covers)) {
      const id = clean(value && value.id);
      if (clean(personId) && id && id.length <= COVER_MAX) this.covers[clean(personId)] = { id, at: String(value.at || '') };
    }
    this.origins = {};
    const origins = parsed && parsed.origins && typeof parsed.origins === 'object' ? parsed.origins : {};
    for (const [personId, value] of Object.entries(origins)) {
      const origin = clean(value && value.origin);
      if (clean(personId) && ORIGINS.has(origin)) this.origins[clean(personId)] = { origin, at: String(value.at || '') };
    }
    this.ratings = {};
    const ratings = parsed && parsed.ratings && typeof parsed.ratings === 'object' ? parsed.ratings : {};
    for (const [personId, value] of Object.entries(ratings)) {
      const star = Math.round(Number(value && value.star));
      if (clean(personId) && star >= 1 && star <= 5) this.ratings[clean(personId)] = { star, at: String(value.at || '') };
    }
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
    // 写しでは同期が一枚ごと差し替える。時々だけ stat を見て、変わっていれば読み直す
    if (this.file && now - this.checkedAt >= RELOAD_CHECK_MS) {
      this.checkedAt = now;
      const stamp = this.statStamp();
      if (stamp && stamp !== this.stamp) this.read();
    }
    return this;
  }

  save() {
    this.revision += 1;
    if (!this.file) return true;
    const ok = stateFile.writeJson('creator-links', this.file, {
      version: VERSION, rows: this.rows, ratings: this.ratings, suggestions: this.suggested, origins: this.origins, names: this.names, covers: this.covers,
    });
    if (ok) this.stamp = this.statStamp();
    return ok;
  }

  // 変わるたびに進む数。Home の控えがこれで組み直しを知る
  version() {
    this.load();
    return this.revision;
  }

  // 組ごとの一番新しい行
  latest() {
    this.load();
    const map = new Map();
    for (const row of this.rows) map.set(keyOf(row.personId, row.source, row.name), row);
    return map;
  }

  // 今結ばれている行 (一番新しい行に revokedAt が無い物)。personId を渡せばその人の分だけ
  linked(personId = null) {
    const out = [];
    for (const row of this.latest().values()) {
      if (row.revokedAt) continue;
      if (personId != null && clean(row.personId) !== clean(personId)) continue;
      out.push({ ...row });
    }
    return out;
  }

  // 退けた (外した・「違う」と答えた) 組の鍵。候補を二度出さないために引く
  rejectedKeys() {
    const out = new Set();
    for (const [key, row] of this.latest()) if (row.revokedAt) out.add(key);
    return out;
  }

  // 突き合わせの候補を足す (まとめて足してから一度だけ書く)。既に答えのある組 (結んだ・退けた) は足さない
  suggest(list = []) {
    this.load();
    const latest = this.latest();
    let added = 0;
    for (const item of Array.isArray(list) ? list : [list]) {
      const row = {
        personId: clean(item && item.personId), source: clean(item && item.source), name: clean(item && item.name),
      };
      if (!row.personId || !row.name || !SOURCES.has(row.source)) continue;
      const key = keyOf(row.personId, row.source, row.name);
      if (latest.has(key)) continue;
      const old = this.suggested.find((one) => keyOf(one.personId, one.source, one.name) === key);
      if (old) {
        // 既にある候補には「決められなかった」の印だけ付け直せる (note と by はそのまま)
        if (typeof item.unresolved === 'boolean' && (old.unresolved === true) !== item.unresolved) {
          old.unresolved = item.unresolved;
          added += 1;
        }
        continue;
      }
      this.suggested.push({
        ...row, note: clean(item.note).slice(0, 400), by: clean(item.by).slice(0, 80), at: new Date(this.now()).toISOString(),
        ...(item.unresolved === true ? { unresolved: true } : {}),
      });
      added += 1;
    }
    if (added) this.save();
    return added;
  }

  // まだ答えの無い候補 (結んだ・退けた組は外す)
  suggestions() {
    this.load();
    const latest = this.latest();
    return this.suggested.filter((row) => !latest.has(keyOf(row.personId, row.source, row.name))).map((row) => ({ ...row }));
  }

  // 見出しの名前 (人の鍵 → 名前)
  namesMap() {
    this.load();
    const out = {};
    for (const [personId, value] of Object.entries(this.names)) out[personId] = value.name;
    return out;
  }

  displayName(personId) {
    this.load();
    const value = this.names[clean(personId)];
    return value ? value.name : '';
  }

  // 名前を決める ('' で決めた名前を外し、元の名前に戻す)。書けたら true
  setDisplayName(personId, name) {
    this.load();
    const key = clean(personId);
    const value = clean(name).slice(0, NAME_MAX);
    if (!key) return false;
    if ((this.names[key] ? this.names[key].name : '') === value) return true;
    if (!value) delete this.names[key];
    else this.names[key] = { name: value, at: new Date(this.now()).toISOString() };
    return this.save();
  }

  // 見出しの表紙 (人の鍵 → 本の id)
  coversMap() {
    this.load();
    const out = {};
    for (const [personId, value] of Object.entries(this.covers)) out[personId] = value.id;
    return out;
  }

  cover(personId) {
    this.load();
    const value = this.covers[clean(personId)];
    return value ? value.id : '';
  }

  // 表紙を決める ('' で決めた表紙を外し、自動の顔に戻す)。書けたら true。
  // その本がその人の物かは Home (home-authors の cover) が確かめてから呼ぶ
  setCover(personId, id) {
    this.load();
    const key = clean(personId);
    const value = clean(id);
    if (!key || value.length > COVER_MAX) return false;
    if ((this.covers[key] ? this.covers[key].id : '') === value) return true;
    if (!value) delete this.covers[key];
    else this.covers[key] = { id: value, at: new Date(this.now()).toISOString() };
    return this.save();
  }

  // 持ち込みの本の出どころ (人の鍵 → 'discord')
  originsMap() {
    this.load();
    const out = {};
    for (const [personId, value] of Object.entries(this.origins)) out[personId] = value.origin;
    return out;
  }

  origin(personId) {
    this.load();
    const value = this.origins[clean(personId)];
    return value ? value.origin : '';
  }

  // 出どころを決める ('' で分からないに戻す)。書けたら true
  setOrigin(personId, origin) {
    this.load();
    const key = clean(personId);
    const value = clean(origin);
    if (!key || (value && !ORIGINS.has(value))) return false;
    if ((this.origins[key] ? this.origins[key].origin : '') === value) return true;
    if (!value) delete this.origins[key];
    else this.origins[key] = { origin: value, at: new Date(this.now()).toISOString() };
    return this.save();
  }

  // ---- 元に戻す (Home の Ctrl+Z) のための小さな口。行を名指しするのは (personId, source, name, at) ----

  // その組の行の写し (古い順)
  rowsFor(personId, source, name) {
    this.load();
    const key = keyOf(personId, source, name);
    return this.rows.filter((row) => keyOf(row.personId, row.source, row.name) === key).map((row) => ({ ...row }));
  }

  findRow(ref) {
    const key = keyOf(ref && ref.personId, ref && ref.source, ref && ref.name);
    for (let i = this.rows.length - 1; i >= 0; i -= 1) {
      const row = this.rows[i];
      if (keyOf(row.personId, row.source, row.name) === key && String(row.at) === String(ref.at)) return i;
    }
    return -1;
  }

  // 足した行を取り除く (元に戻す)。取り除いた行の写しを返す
  dropRow(ref) {
    this.load();
    const index = this.findRow(ref);
    if (index < 0) return null;
    const [row] = this.rows.splice(index, 1);
    this.save();
    return { ...row };
  }

  // 取り除いた行を戻す (やり直す)
  restoreRow(row) {
    this.load();
    if (!row || !SOURCES.has(clean(row.source)) || !clean(row.personId) || !clean(row.name)) return false;
    if (this.findRow(row) >= 0) return true;
    this.rows.push({ ...row });
    return this.save();
  }

  // 行の revokedAt を付け直す (null で外す)。前の値を返す (行が無ければ undefined)
  setRevoked(ref, revokedAt) {
    this.load();
    const index = this.findRow(ref);
    if (index < 0) return undefined;
    const row = this.rows[index];
    const before = row.revokedAt || null;
    if (revokedAt) row.revokedAt = String(revokedAt);
    else delete row.revokedAt;
    this.save();
    return before;
  }

  // 作者の★ (人の鍵 → 1〜5)。Home の一覧が並びと見出しに使う
  ratingsMap() {
    this.load();
    const out = {};
    for (const [personId, value] of Object.entries(this.ratings)) out[personId] = value.star;
    return out;
  }

  rating(personId) {
    this.load();
    const value = this.ratings[clean(personId)];
    return value ? value.star : 0;
  }

  // ★を付ける (0 で外す)。書けたら true
  rate(personId, star) {
    this.load();
    const key = clean(personId);
    const value = Math.round(Number(star));
    if (!key || !Number.isFinite(value) || value < 0 || value > 5) return false;
    const current = this.ratings[key] ? this.ratings[key].star : 0;
    if (current === value) return true;
    if (value === 0) delete this.ratings[key];
    else this.ratings[key] = { star: value, at: new Date(this.now()).toISOString() };
    return this.save();
  }

  state(personId, source, name) {
    const row = this.latest().get(keyOf(personId, source, name));
    if (!row) return null;
    return row.revokedAt ? 'rejected' : 'linked';
  }

  // 結ぶ。既に結ばれていれば何もしない。退けた組をもう一度結ぶ時は新しい行を足す
  link({ personId, source, name, by = '', note = '', evidence = 'user-confirmed' } = {}) {
    const row = {
      personId: clean(personId), source: clean(source), name: clean(name),
    };
    if (!row.personId || !row.name || !SOURCES.has(row.source)) return null;
    const current = this.latest().get(keyOf(row.personId, row.source, row.name));
    if (current && !current.revokedAt) return { ...current };
    const added = {
      ...row, evidence: clean(evidence) || 'user-confirmed', by: clean(by), at: new Date(this.now()).toISOString(), note: clean(note),
    };
    this.rows.push(added);
    this.save();
    return { ...added };
  }

  // 外す / 退ける。結ばれている行には revokedAt を足し、行が無い (候補を「違う」と退ける) 時は
  // 退けた印の行を足す。どちらも消さない
  revoke({ personId, source, name, by = '', note = '' } = {}) {
    const row = {
      personId: clean(personId), source: clean(source), name: clean(name),
    };
    if (!row.personId || !row.name || !SOURCES.has(row.source)) return null;
    const at = new Date(this.now()).toISOString();
    const current = this.latest().get(keyOf(row.personId, row.source, row.name));
    if (current && current.revokedAt) return { ...current };
    if (current) {
      current.revokedAt = at;
      if (by) current.revokedBy = clean(by);
      this.save();
      return { ...current };
    }
    const added = {
      ...row, evidence: 'user-confirmed', by: clean(by), at, note: clean(note), revokedAt: at,
    };
    this.rows.push(added);
    this.save();
    return { ...added };
  }
}

module.exports = { CreatorLinks, linkKey: keyOf, LINK_SOURCES: [...SOURCES], LOCAL_ORIGINS: [...ORIGINS] };
