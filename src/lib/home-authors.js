'use strict';

// Home (源泉横断の作者の一覧と作者頁) の母屋側。仕様は docs/home-tab-spec-2026-09-23.md。
//
// 作者 = 人 (docs/adr/0002)。人の鍵は Eagle の「作者」根の直下のフォルダ (作者フォルダ)。
// 作者フォルダを持たない hitomi の作者は、台帳の artist タグを鍵にする
// (所持 3 冊以上か、発見の followed に居る作者だけ並べる)。
// 名前が作者フォルダと一つだけ一致した hitomi の作者は「候補」として添えるだけで、確定はしない
// (利用者が詳細で「結ぶ」まで)。
//
// 結びの置き場 (docs/cross-site-author-search-2026-09-21.md §6-3):
//   pixiv    → pixiv-library.json の creators (user_id → 作者フォルダ)
//   Pawchive → paw-links.json の creators ("service:user" → 作者フォルダ)
//   hitomi / nhentai → creator-links.json (足りない一辺だけ)
//   作者フォルダの無い人 (hitomi の作者 'h:<artist>' / サークル 'c:<group>') の pixiv / Pawchive → creator-links.json
//   作者の★ → creator-links.json の ratings
//   見出しの表紙 (利用者が所持の本から選んだ一冊) → creator-links.json の covers
//   名前に日付の無い所持の本の公開日 → release-dates.json (網で見つけた物。書くのは外の道具)
//
// サークルを先に立てる (docs/home-tab-spec-2026-09-23.md「2026-09-24 の指示」): hitomi だけの人は、作者の所持の本の
// 6 割以上が一つのサークルに入っていればそのサークルの見出しに束ねる。作者のタグの無いサークルだけの本もサークルの見出し。
//
// 一覧は組むのが重い (台帳の SQL・作者根の全項目) ので、一度組んで控え、材料が動いた時だけ
// 裏で組み直す (組み直す間は前の控えを返す)。検索・並び・絞りは控えの上で回す。
// 網の作品 (hitomi / pawchive / pixiv) は作者頁を開いた時だけ、源泉ごとに引く (webWorks)。
//
// electron を引かない (材料は main から差し込む。試験は偽物を差す)。
// 作品名・作者名は記録に出さない。

const fs = require('fs');
const { nfkc, hiraToKata } = require('./search-text');
const { titleNeedle, tagNameKey, metaTagRows } = require('./title-keys');
const { parseTypePrefix, tokenizeQuery } = require('./search-type');
const { homeAuthorId, parseHomeAuthorId, parseId } = require('./sources/ids');
const { linkKey } = require('./creator-links');

// 詳細の行と見出しの印に出す源泉。並びもこの順 (画面と試験が同じ並びを見る)
const SITE_KEYS = ['pixiv', 'pawchive', 'hitomi', 'nhentai'];
// 道具の行の種別の札 (renderer の HOME_TYPES と同じ id。test/cross-source が突き合わせる)。
// 2026-09-27 に pixiv / Pawchive / hitomi / 候補あり を外し、一覧の頭へ戻る「ホーム」の一枚だけに (利用者: 絞りは意味が無い)
const HOME_TYPES = [''];
// 並び (renderer の SORTS.home と同じ id。並びもこの順)
const HOME_SORTS = ['activity', 'read', 'rating', 'stars', 'owned', 'title'];

// 作者フォルダに居ない hitomi の作者を並べる下限の冊数。2026-09-24 に 3 → 1 (利用者: Eagle の本は全部 Home から見えるように。
// 3 冊では所持 1〜2 冊の作者の 450 冊がどの見出しにも出なかった)
const HITOMI_MIN_OWNED = 1;
// 共著・合同誌の一冊きり: hitomi だけの人の所持がこの冊数未満で、その本を全部、より多く持つ別の見出しが持っていれば並べない
// (2026-09-26。本はその見出しから読める。二冊以上持てば並ぶ)
const SHARED_MIN_OWNED = 2;
// 主のサークル: 作者の所持の本のうちこの割合以上 (かつこの冊数以上) が一つのサークルに入っていれば、そのサークルに束ねる
// 2026-09-26 に 0.6 → 0: 利用者「しきい値を緩めて 26 人もサークルに寄せて」(サークルはサークル名で出し、個別の作者で Home を埋めない)。
// 一冊でもサークルの本があれば、一番多いサークル (同数なら名の順で先の物) に束ねる
const DOMINANT_SHARE = 0;
// 2026-09-25 に 2 → 1: 所持 1 冊の作者がサークルと作者の二枚に出ていた (1 冊でも、その本がサークルの本ならサークルに寄せる)
const DOMINANT_MIN = 1;
// 詳細の「最近の本」
const RECENT_COUNT = 8;
// 一覧の頭: 最近の動きの帯。直近 2 週間に Eagle へ入れた本がある人だけ (2026-09-27、利用者: 16 人を必ず並べなくてよい)。
// 上限は一度に大量に入れた時の守り
const MOVING_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const OVERVIEW_MOVING_MAX = 60;
// 作者頁で「新」の印を付ける発見の新作の id (人ごとの上限)
const NEW_IDS_MAX = 200;
// 検索欄の候補の数 (本体の候補の窓と同じ)
const SUGGEST_MAX = 10;
// 作品の検索の当て先を裏で先に組む時の一度に組む冊数と、組み直しの後に待つ間 (組み直しの SQL と重ねない)。
// 1.7 万冊の見本で全部組むと 70ms ほど: 500 冊ずつなら一度に 2〜3ms しか主の糸を止めない
const FIND_WARM_CHUNK = 500;
const FIND_WARM_DELAY_MS = 1500;
// 作者頁の hitomi の網の作品。60 件の頁を 20 頁まで (新しい 1200 冊)
const WEB_PAGE_SIZE = 60;
const WEB_MAX_PAGES = 20;
// 作者頁の網の作品を引く源泉と、源泉ごとの頁の幅と上限 (renderer の home.js の WEB_SITES と同じ並び)
//   hitomi   結び済みと候補の名乗り (artist) ごと。60 件 × 20 頁
//   pawchive 結び済みの "service:user" ごと。作者の投稿一覧の API の頁と同じ 50 件 × 10 頁 (新しい 500 件)
//   pixiv    結び済みの利用者 ID ごと。API の 30 件 × 10 頁 (新しい 300 件)。API 車線は同時 1 本で、
//            10 分に 100 回を超えると 1.6 秒ずつ空く (pixiv/manners.js): 作者頁を開くたびに深く掘らない
const WEB_SITES = ['hitomi', 'pawchive', 'pixiv'];
const WEB_LIMITS = {
  hitomi: { pageSize: WEB_PAGE_SIZE, maxPages: WEB_MAX_PAGES },
  pawchive: { pageSize: 50, maxPages: 10 },
  pixiv: { pageSize: 30, maxPages: 10 },
};
// 網の作品の控え。作者頁を開き直すたびに hitomi へ出ない
const WEB_TTL_MS = 30 * 60 * 1000;
const WEB_CACHE_MAX = 64;
// stat の控え (SMB 越しの stat を検索のたびに繰り返さない)
const STAMP_MEMO_MS = 3000;

// paw-library と同じ名前の規約 ([YYYYMMDD] [postId] 題【17P】) のうち、ここで要るのは即売会の記号だけ。
// 前後が英数字でない C84〜C109
const EVENT_RE = /(?:^|[^A-Za-z0-9])C(8[4-9]|9\d|10\d)(?!\d)/;
// PPD が付けた古い pixiv の名前 (<投稿 ID>_p<n>-題)。url の無い pixiv の本 (付け直し前)
const PPD_NAME = /^(\d{5,10})_p\d+(?:[-_ ]|$)/;

// ---------------------------------------------------------------------------
// 小さな道具
// ---------------------------------------------------------------------------

// 名前の突き合わせと絞り込みの鍵: NFKC・大小・ひらカタ・空白と下線と中黒を無視
function nameKey(value) {
  return hiraToKata(nfkc(String(value == null ? '' : value))).toLowerCase().replace(/[\s_・･.]+/g, '');
}

// 日付の字 ('2024-05-01...' / '20240501') と ms のどちらでも受けて 'YYYY-MM-DD'。分からなければ null
function isoDate(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 1e11) return null;
    return new Date(value).toISOString().slice(0, 10);
  }
  const text = String(value).trim();
  let hit = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (hit) return `${hit[1]}-${hit[2]}-${hit[3]}`;
  hit = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (hit) return `${hit[1]}-${hit[2]}-${hit[3]}`;
  if (/^\d+$/.test(text)) return isoDate(Number(text));
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : null;
}

// コミケの回 → 年と季節と月。偶数回が夏 (8 月)、奇数回が冬 (12 月)。C98 は中止、C99 は 2021 冬
function comiket(n) {
  if (n === 98) return { year: 2020, season: '中止', month: 5 };
  if (n === 99) return { year: 2021, season: '冬', month: 12 };
  const summer = n % 2 === 0;
  let year;
  if (n >= 100) year = 2022 + Math.floor((n - 100) / 2);
  else year = summer ? 2019 - (96 - n) / 2 : 2019 - (97 - n) / 2;
  return { year, season: summer ? '夏' : '冬', month: summer ? 8 : 12 };
}

function eventOf(text) {
  const hit = String(text || '').match(EVENT_RE);
  return hit ? Number(hit[1]) : null;
}

function eventInfo(n) {
  if (!n) return null;
  return { code: `C${n}`, ...comiket(n) };
}

// 作者フォルダの中の小分けのフォルダの名前から、公開の年月を読む (名前に [YYYYMMDD] の無い本だけに使う)。
//   「2025年5月 …」「25年5月 …」                  → { year: 2025, month: 5 }
//   「<英字>2603」(英字の後ろに年 2 桁 + 月 2 桁)   → { year: 2026, month: 3 }
//   「4月 …」(年の無い月)                          → { year: null, month: 4 }。年はその作者の年のある名前から推す
function folderMonth(name) {
  const text = nfkc(String(name || '')).trim();
  if (!text) return null;
  const valid = (year, month) => (year >= 2000 && year <= 2099 && month >= 1 && month <= 12 ? { year, month } : null);
  let hit = text.match(/(?:^|[^0-9])(\d{4})\s*年\s*(\d{1,2})\s*月/);
  if (hit) return valid(Number(hit[1]), Number(hit[2]));
  hit = text.match(/(?:^|[^0-9])(\d{2})\s*年\s*(\d{1,2})\s*月/);
  if (hit) return valid(2000 + Number(hit[1]), Number(hit[2]));
  hit = text.match(/^[A-Za-z][A-Za-z ._-]*?(\d{2})(\d{2})(?![0-9])/);
  if (hit) return valid(2000 + Number(hit[1]), Number(hit[2]));
  hit = text.match(/^(\d{1,2})\s*月/);
  if (hit) {
    const month = Number(hit[1]);
    return month >= 1 && month <= 12 ? { year: null, month } : null;
  }
  return null;
}

function monthDate(year, month) {
  return year && month ? `${year}-${String(month).padStart(2, '0')}-01` : null;
}

// nhentai の作者の名は、hitomi の artist の空白を - にした物であることが多い (推測。候補にだけ使う)
function nhentaiSlug(artist) {
  return String(artist || '').trim().toLowerCase().replace(/\s+/g, '-');
}

// ---------------------------------------------------------------------------
// サイトの URL (詳細の行で結ぶ)。形の検めと組み立ては母屋のここだけが持つ
// ---------------------------------------------------------------------------

// 貼られた URL から名乗りの値を取り出す。形が違えば ''
//   pixiv    https://www.pixiv.net/users/<数字> (en の形も) → '<数字>'
//   Pawchive https://pawchive.pw/<service>/user/<id>        → '<service>:<id>'
//   hitomi   https://hitomi.la/artist/<名>-all.html (-japanese 等も) → '<名>'
//            https://hitomi.la/group/<名>-all.html (サークル)          → 'group:<名>'
//   nhentai  https://nhentai.net/artist/<名>/               → '<名>'
//            https://nhentai.net/group/<名>/ (サークル)      → 'group:<名>'
function parseSiteUrl(site, raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return '';
  let hit = null;
  if (site === 'pixiv') {
    hit = text.match(/^(?:https?:\/\/)?(?:www\.)?pixiv\.net\/(?:[a-z]{2}\/)?users\/(\d{1,12})(?:[/?#]|$)/i);
    return hit ? hit[1] : '';
  }
  if (site === 'pawchive') {
    hit = text.match(/^(?:https?:\/\/)?(?:www\.)?pawchive\.(?:pw|st)\/([a-z]+)\/user\/([^/?#\s]+)(?:[/?#]|$)/i);
    return hit ? `${hit[1].toLowerCase()}:${safeDecode(hit[2])}` : '';
  }
  if (site === 'hitomi') {
    hit = text.match(/^(?:https?:\/\/)?(?:www\.)?hitomi\.la\/(artist|group)\/([^/?#]+)-([a-z]+)\.html(?:[?#]|$)/i);
    if (!hit) return '';
    const name = safeDecode(hit[2]).trim().toLowerCase();
    if (!name) return '';
    return hit[1].toLowerCase() === 'group' ? `group:${name}` : name;
  }
  if (site === 'nhentai') {
    hit = text.match(/^(?:https?:\/\/)?(?:www\.)?nhentai\.net\/(artist|group)\/([^/?#\s]+)\/?(?:[?#]|$)/i);
    if (!hit) return '';
    const name = safeDecode(hit[2]).trim().toLowerCase();
    if (!name) return '';
    return hit[1].toLowerCase() === 'group' ? `group:${name}` : name;
  }
  return '';
}

function safeDecode(value) {
  try {
    return decodeURIComponent(String(value));
  } catch {
    return String(value);
  }
}

// 名乗りの値から開く URL を組む
function siteUrl(site, value) {
  const text = String(value == null ? '' : value);
  if (!text) return '';
  if (site === 'pixiv') return `https://www.pixiv.net/users/${encodeURIComponent(text)}`;
  if (site === 'pawchive') {
    const cut = text.indexOf(':');
    if (cut <= 0) return '';
    return `https://pawchive.pw/${encodeURIComponent(text.slice(0, cut))}/user/${encodeURIComponent(text.slice(cut + 1))}`;
  }
  if (site === 'hitomi') {
    if (text.startsWith('group:')) return `https://hitomi.la/group/${encodeURIComponent(text.slice(6))}-all.html`;
    return `https://hitomi.la/artist/${encodeURIComponent(text)}-all.html`;
  }
  if (site === 'nhentai') {
    if (text.startsWith('group:')) return `https://nhentai.net/group/${encodeURIComponent(text.slice(6))}/`;
    return `https://nhentai.net/artist/${encodeURIComponent(text)}/`;
  }
  return '';
}

// paw-links の鍵 ("service:user") を値の形へ。service は小文字
function pawValue(key) {
  const text = String(key || '');
  const cut = text.indexOf(':');
  if (cut <= 0 || cut === text.length - 1) return '';
  return `${text.slice(0, cut).toLowerCase()}:${text.slice(cut + 1)}`;
}

// ---------------------------------------------------------------------------
// 一覧を組む (純粋な関数。材料は gather が集める)
// ---------------------------------------------------------------------------

// hitomi の名乗り。artist はそのまま、サークル (group) は 'group:<名>' の値で持つ
function handleValue(handle) {
  return handle.type === 'group' ? `group:${handle.name}` : handle.name;
}

function parseHandleValue(value) {
  const text = String(value || '');
  if (text.startsWith('group:')) return { type: 'group', name: text.slice(6) };
  return { type: 'artist', name: text };
}

// タグの名を読める形へ (下線は空白)。日本語の札が無い時の名前
function prettyTag(name) {
  return String(name || '').replace(/_/g, ' ').trim();
}

function newPerson(kind, key, name) {
  return {
    id: homeAuthorId(kind, key),
    kind,
    key: String(key),
    name: String(name || ''),
    folderName: kind === 'folder' ? String(name || '') : '',
    folderId: kind === 'folder' ? String(key) : '',
    artist: kind === 'hitomi' ? String(key) : '',
    group: kind === 'circle' ? String(key) : '',
    books: [],
    newCount: 0,
    // 発見の新作の hitomi の id (作者頁で新作の本に「新」の印を付ける)
    newIds: new Set(),
    // 網の作品を引く名乗り ({ type: 'artist' | 'group', name, candidate })
    handles: [],
    // 詳細の板の「サークル」「作者」(サークル = { group, label, candidate }、作者 = { artist, label, candidate })
    circles: [],
    authors: [],
    links: { pixiv: [], pawchive: [], hitomi: [], nhentai: [] },
    rating: 0,
  };
}

// creator-links の personId。作者フォルダの人はフォルダ id、hitomi だけの人は 'h:<artist>'、サークルは 'c:<group>'
function personIdOf(person) {
  if (person.kind === 'folder') return person.folderId;
  if (person.kind === 'circle') return `c:${person.group}`;
  return `h:${person.artist}`;
}

function pushLink(person, site, value, state, extra = {}) {
  if (!value) return;
  const list = person.links[site];
  const current = list.find((link) => link.value === value);
  if (current) {
    // 確定が候補に勝つ
    if (state === 'linked') current.state = 'linked';
    Object.assign(current, extra);
    return;
  }
  list.push({ value, url: siteUrl(site, value), state, ...extra });
}

function addUnique(list, item, key) {
  const current = list.find((row) => row[key] === item[key]);
  if (!current) {
    list.push({ ...item });
    return;
  }
  // 確定が候補に勝つ
  if (!item.candidate) current.candidate = false;
}

// 公開日の控え (release-dates) の一行を本の日付に。推定 (medium / low) は画面が「頃」を添える
function foundDate(found) {
  const date = found && isoDate(found.date);
  if (!date) return null;
  return { date, guess: found.guess === true, basis: String(found.basis || '') };
}

// 作者フォルダの本 (paw-library の項目) を一冊の形へ。
// 日付の順: 名前の [YYYYMMDD] > pixiv の台帳 > 公開日の控え (網で見つけた物) > 小分けのフォルダの名前の年月
function folderBook(item, pixivWork, releaseDateOf = () => null) {
  const eagleId = String(item.eagleId || '');
  const name = String(item.name || '');
  const found = () => {
    try {
      return foundDate(releaseDateOf(eagleId));
    } catch {
      return null;
    }
  };
  if (item.source === 'pixiv' && item.pixivId) {
    const pid = String(item.pixivId);
    const work = pixivWork(pid);
    const known = isoDate(work && work.date);
    const guessed = known ? null : found();
    return {
      id: `px:${pid}`,
      origin: 'pixiv',
      candidate: false,
      date: known || (guessed ? guessed.date : null),
      dateGuess: Boolean(guessed && guessed.guess),
      dateBasis: guessed ? guessed.basis : '',
      pages: Number(work && work.pages) || 0,
      title: String((work && work.title) || item.title || name),
      star: Number(item.star) || 0,
      lang: null,
      mtime: Number(item.mtime) || 0,
      event: eventOf(name),
      readKeys: [`px:${pid}`, `pweagle:${eagleId}`],
      ref: { type: 'folder', item, pid },
    };
  }
  // url の無い古い pixiv の本 (PPD の名前)。Eagle の項目のまま読む (台帳に同じ投稿が居れば、その日付)
  const legacy = name.match(PPD_NAME);
  const origin = legacy ? 'pixiv' : (item.date || item.postId ? 'pawchive' : 'local');
  const legacyWork = legacy ? pixivWork(legacy[1]) : null;
  const fromName = isoDate(item.date) || isoDate(legacyWork && legacyWork.date);
  const guessed = fromName ? null : found();
  // 名前にも控えにも日付の無い本は、小分けのフォルダの名前の年月 (年の無い月は作者ごとに後で推す)
  const month = fromName || guessed ? null : folderMonth(item.folderName);
  return {
    id: `pweagle:${eagleId}`,
    origin,
    candidate: false,
    date: fromName || (guessed ? guessed.date : null) || (month ? monthDate(month.year, month.month) : null),
    dateGuess: Boolean(guessed && guessed.guess),
    dateBasis: guessed ? guessed.basis : '',
    folderMonth: month,
    pages: Number(item.pageCount) || 0,
    title: legacy ? (name.replace(PPD_NAME, '').trim() || name) : String(item.title || name),
    star: Number(item.star) || 0,
    lang: null,
    mtime: Number(item.mtime) || 0,
    event: eventOf(name),
    readKeys: [`pweagle:${eagleId}`],
    ref: { type: 'folder', item, pid: '' },
  };
}

function hitomiBook(row) {
  const gid = String(row.gid);
  const title = String(row.title || '');
  return {
    id: gid,
    origin: 'hitomi',
    candidate: false,
    date: isoDate(row.published) || isoDate(row.added),
    pages: Number(row.pages) || 0,
    title,
    star: Number(row.star) || 0,
    lang: String(row.lang || '').toLowerCase() || null,
    mtime: Number(row.addedAt) || 0,
    event: eventOf(title),
    readKeys: [gid],
    ref: { type: 'hitomi', gid },
  };
}

// Eagle のタグで人に寄せた、hitomi に照合されていない所持の本 (台帳の未照合の項目)。
// 札は本体の未照合の疑似ギャラリー (pweagle:) を借りる (表紙・読む・Eagle で開くの道が同じ)。
// 出どころは分からないので 'local' (持ち込みの ?)。日付は公開日の控えにあればそれ、無ければ日付不明
function eagleTagBook(row, releaseDateOf = () => null) {
  const eagleId = String(row.eagleId || '');
  const title = String(row.itemTitle || '');
  let found = null;
  try {
    found = foundDate(releaseDateOf(eagleId));
  } catch {
    found = null;
  }
  return {
    id: `pweagle:${eagleId}`,
    origin: 'local',
    candidate: false,
    date: found ? found.date : null,
    dateGuess: Boolean(found && found.guess),
    dateBasis: found ? found.basis : '',
    pages: 0,
    title,
    star: Number(row.star) || 0,
    lang: null,
    mtime: Number(row.addedAt) || 0,
    event: eventOf(title),
    readKeys: [`pweagle:${eagleId}`],
    ref: { type: 'eagle', eagleId },
  };
}

// 日本語の本か。hitomi だけ言語を持つ。見出しの顔を選ぶ時だけ使う (翻訳版の表紙を作者の顔にしない)。
// 所持の本そのものは言語で伏せない (2026-09-24: Eagle の所持は全て見せる。照合先が翻訳版でも利用者の本は在る)
function japanese(book) {
  return !book.lang || book.lang === 'japanese';
}

function byDateDesc(a, b) {
  const x = a.date || '';
  const y = b.date || '';
  if (x !== y) return x < y ? 1 : -1;
  return (b.mtime || 0) - (a.mtime || 0);
}

// Eagle の★の点。未判定も点を持つ (まだ評価していない = 推す根拠が無い。★2 と★3 の間)
const STAR_POINTS = [2, 0, 1, 2.5, 4, 5];
// 事前の重みと値 (冊数の少ない人が上下に跳ねないよう、この数だけ未判定の本があるとみなして均す)
const STAR_PRIOR_WEIGHT = 3;
const STAR_PRIOR_POINTS = 2;

function starPoints(star) {
  const n = Math.max(0, Math.min(5, Math.round(Number(star) || 0)));
  return STAR_POINTS[n];
}

// 台帳の items.path (…/<id>.info か、紐付けた行の …/<id>.info#<gid>) から Eagle の項目の id
function eagleIdOfPath(filePath) {
  const base = String(filePath || '').split('#')[0].replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
  return base.replace(/\.info$/i, '');
}

// Eagle に入れた時刻 (ms)。Eagle の項目の id は頭の 8 字が入れた時の Date.now() の 36 進 (実物で確かめた推測: btime との差の中央値 0)。
// metadata の modificationTime はタグや★の書き込みでも動くので「落とした日」には使えない (2026-09-27、7 割が後から動いていた)
const EAGLE_ID_FLOOR = Date.UTC(2015, 0, 1);
function eagleAddedAt(eagleId) {
  const id = String(eagleId || '');
  if (!/^[0-9A-Z]{13}$/.test(id)) return 0;
  const at = parseInt(id.slice(0, 8), 36);
  return at > EAGLE_ID_FLOOR && at < Date.now() + 24 * 60 * 60 * 1000 ? at : 0;
}

// 本を Eagle に入れた時刻。所持の hitomi の本は照合元の Eagle の項目から (addedOfGid)
function bookAddedAt(book, addedOfGid) {
  const ref = book.ref || {};
  if (ref.type === 'hitomi') return (addedOfGid && addedOfGid.get(String(ref.gid))) || 0;
  const eagleId = (ref.item && ref.item.eagleId) || ref.eagleId || '';
  return eagleAddedAt(eagleId);
}

// Eagle のタグと突き合わせる人の名前の鍵。確定した物だけ (候補の名乗り・寄り道したサークルは入れない)。
// 1 字の鍵は偶然当たるので使わない
function tagMatchKeys(person) {
  return [...new Set([
    nameKey(person.name),
    nameKey(person.folderName),
    ...person.handles.filter((handle) => !handle.candidate).map((handle) => nameKey(handle.name)),
    ...person.circles.filter((circle) => !circle.candidate && !circle.minor).flatMap((circle) => [nameKey(circle.group), nameKey(circle.label)]),
    ...person.authors.filter((author) => !author.candidate).flatMap((author) => [nameKey(author.artist), nameKey(author.label)]),
  ].filter((key) => key && [...key].length >= 2))];
}

// Eagle のタグの道 (2026-09-24): 所持の本の Eagle のタグに人の名前と同じ語があれば、その人の本にする。
// 作者フォルダに入れていない本や、hitomi の照合先に作者のタグが無い本 (翻訳版の上げ直しなど) を拾う。
//   人は作らない (今居る人に寄せるだけ)。一つの語が二人以上に当たる時は、その語では寄せない
//   既にその人の本なら足さない (同じ本の id か、同じ Eagle の項目)
//   hitomi に照合済みの本は hitomi の本 (言語もそのまま: 作者頁の日本語の決まりはここでも効く)、
//   照合されていない本は未照合の疑似ギャラリー (eagleTagBook)
//   照合先の hitomi に作者・サークルのタグがあれば、それが答え。その名乗りと合わない人へは寄せない
//   (2026-09-24: 以前の誤った照合で BUNKO が書いた札が Eagle に残り、別の作者の頁に本が出ていた)
function attachByEagleTags(persons, eagleRows, releaseDateOf, creatorKeysOf = () => null) {
  const rows = Array.isArray(eagleRows) ? eagleRows : [];
  if (!rows.length) return;
  const owners = new Map();
  const keysOf = new Map();
  for (const person of persons) {
    const keys = tagMatchKeys(person);
    keysOf.set(person, new Set(keys));
    for (const key of keys) {
      if (!owners.has(key)) owners.set(key, person);
      else if (owners.get(key) !== person) owners.set(key, null);
    }
  }
  // hitomi の照合先 (数字の gid) だけを hitomi の本として扱う。nhentai・E-Hentai に手で結んだ本 ('nh:123' 型) は
  // hitomi の素性が無いので、未照合と同じ疑似ギャラリー (catalog が同じ口で出す) で寄せる
  const hitomiGid = (row) => (row && row.gid != null && /^\d+$/.test(String(row.gid)) ? String(row.gid) : '');
  const eagleOfGid = new Map();
  for (const row of rows) {
    if (hitomiGid(row) && row.eagleId) eagleOfGid.set(hitomiGid(row), String(row.eagleId));
  }
  // 人ごとの今の本の印 (本の id と eagle:<項目>)。一度作って足すたびに書き足す
  const held = new Map();
  const heldBy = (person) => {
    let marks = held.get(person);
    if (marks) return marks;
    marks = new Set();
    for (const book of person.books) {
      marks.add(book.id);
      const ref = book.ref || {};
      const eagleId = (ref.item && ref.item.eagleId) || ref.eagleId
        || (ref.type === 'hitomi' ? eagleOfGid.get(String(ref.gid)) : '');
      if (eagleId) marks.add(`eagle:${eagleId}`);
    }
    held.set(person, marks);
    return marks;
  };
  for (const row of rows) {
    const eagleId = String((row && row.eagleId) || '');
    if (!eagleId) continue;
    const targets = new Set();
    for (const tag of row.tags || []) {
      const owner = owners.get(nameKey(tag));
      if (owner) targets.add(owner);
    }
    if (!targets.size) continue;
    const gid = hitomiGid(row);
    const creators = gid ? creatorKeysOf(gid) : null;
    for (const person of targets) {
      if (creators && creators.size && ![...creators].some((key) => keysOf.get(person).has(key))) continue;
      const marks = heldBy(person);
      if (marks.has(`eagle:${eagleId}`) || (gid && marks.has(gid))) continue;
      const book = gid
        ? hitomiBook({
          gid, title: row.title || row.itemTitle, pages: row.pages, lang: row.lang,
          published: row.published, added: row.added, star: row.star, addedAt: row.addedAt,
        })
        : eagleTagBook(row, releaseDateOf);
      book.viaTag = true;
      person.books.push(book);
      marks.add(book.id);
      marks.add(`eagle:${eagleId}`);
    }
  }
}

// 作者フォルダの本のうち、台帳で hitomi に照合済みの Eagle の項目は、同じ人の hitomi の本と同じ一冊
// (作者フォルダの道は pweagle:<項目>、所持の hitomi の道は gid で出るので、id では重ならない)。
// hitomi の本に畳む: 出どころの分からない ? を消し、栞 (pweagle:) と星と選んだ表紙は hitomi の本へ移す。
// 畳むのは出どころが持ち込み (local / discord) の本だけ (pixiv・Pawchive の本はその源泉の素性の方が確か)。
// 同じ人に照合先の gid が無い本 (照合先が別の作者) は畳まない
function foldLinkedTwins(person, gidOfEagle) {
  if (person.kind !== 'folder' || !gidOfEagle || !gidOfEagle.size) return;
  const byId = new Map();
  person.books.forEach((book, index) => {
    if (book.ref && book.ref.type === 'hitomi' && !byId.has(book.id)) byId.set(book.id, index);
  });
  const drop = new Set();
  person.books.forEach((book, index) => {
    if (!book.ref || book.ref.type !== 'folder' || book.origin === 'pixiv' || book.origin === 'pawchive') return;
    const eagleId = String(book.ref.item && book.ref.item.eagleId || '');
    const gid = eagleId ? gidOfEagle.get(eagleId) : '';
    if (!gid || !byId.has(gid)) return;
    const at = byId.get(gid);
    const twin = person.books[at];
    // 束の hitomi の本は他の人と分け合う物なので、写してから書き足す。作者フォルダに在る本は確か (候補でない)
    person.books[at] = {
      ...twin,
      candidate: false,
      star: Math.max(Number(twin.star) || 0, Number(book.star) || 0),
      readKeys: [...new Set([...(twin.readKeys || []), ...(book.readKeys || [])])],
    };
    if (person.chosenCover === book.id) person.chosenCover = gid;
    drop.add(index);
  });
  if (drop.size) person.books = person.books.filter((_, index) => !drop.has(index));
}

// 見出しと詳細に要る数を人に書き足す
function finish(person) {
  // 同じ本 (サークルと作者の両方から来た hitomi の本) は一冊に
  const seen = new Map();
  for (const book of person.books) {
    const current = seen.get(book.id);
    if (!current || (current.candidate && !book.candidate)) seen.set(book.id, book);
  }
  person.books = [...seen.values()];
  person.books.sort(byDateDesc);
  const confirmed = person.books.filter((book) => !book.candidate);
  const bySource = { pixiv: 0, pawchive: 0, hitomi: 0, local: 0, discord: 0 };
  let high = 0;
  let points = 0;
  for (const book of confirmed) {
    bySource[book.origin] = (bySource[book.origin] || 0) + 1;
    if (book.star >= 4) high += 1;
    points += starPoints(book.star);
  }
  person.count = confirmed.length;
  person.bySource = bySource;
  person.high = high;
  person.ratio = confirmed.length ? high / confirmed.length : 0;
  // Eagle の★の評価 = 点の平均を事前の重みで均した値 (低い★の本が多い人は下がり、冊数の少ない人は真ん中へ寄る)
  person.starScore = (points + STAR_PRIOR_WEIGHT * STAR_PRIOR_POINTS) / (confirmed.length + STAR_PRIOR_WEIGHT);
  let lastDate = '';
  let newest = 0;
  for (const book of person.books) {
    if (book.date && book.date > lastDate) lastDate = book.date;
    if (book.mtime > newest) newest = book.mtime;
  }
  person.lastDate = lastDate || isoDate(newest) || null;
  // 最近の動き = 確かな所持の本を最後に Eagle へ入れた時刻 (落とした日。公開日ではない)
  person.lastAddedAt = confirmed.reduce((max, book) => Math.max(max, Number(book.addedAt) || 0), 0);
  // 顔: 作者フォルダの人はフォルダの札 (一番新しい本の表紙を母屋が借りる)、ほかは一番新しい所持の本
  const coverBook = confirmed.find((book) => japanese(book)) || confirmed[0] || person.books[0];
  person.coverAuto = person.kind === 'folder' ? `pwlibf:${person.folderId}` : (coverBook ? coverBook.id : '');
  // 利用者が選んだ表紙 (creator-links の covers) は、その人の確かな所持の本を指している時だけ効く。
  // 本が Eagle から消えた・結びを外して人から離れた時は、黙って自動の顔に戻る (壊れた絵を出さない)
  const chosen = person.chosenCover ? confirmed.find((book) => book.id === person.chosenCover) : null;
  person.cover = chosen ? chosen.id : person.coverAuto;
  person.coverChosen = Boolean(chosen);
  // つながっているサイト (見出しの左下)。結び済みか、その源泉の所持の本がある物だけ。
  // nhentai の推測は見出しに出さない (詳細の板でだけ見せる)
  const sites = [];
  for (const site of SITE_KEYS) {
    const linked = person.links[site].some((link) => link.state === 'linked');
    const owned = site !== 'nhentai' && bySource[site] > 0;
    if (linked || owned) sites.push(site);
  }
  // 持ち込みの本の出どころが分かっている時 (Discord) は、そのアイコンも帯に並べる
  if (bySource.discord > 0) sites.push('discord');
  const candidate = ['pixiv', 'pawchive', 'hitomi'].some((site) => person.links[site].some((link) => link.state === 'candidate'));
  person.sites = sites;
  person.unsure = candidate || bySource.local > 0 || !sites.length;
  person.hasCandidate = candidate;
  // 突き合わせで確かめても決められなかった候補を持つ人 (設定の「判定できなかった作者だけ」で絞る)
  person.unresolved = SITE_KEYS.some((site) => person.links[site].some((link) => link.state === 'candidate' && link.unresolved === true));
  person.readKeys = person.books.flatMap((book) => book.readKeys);
  person.keys = [...new Set([
    nameKey(person.name),
    nameKey(person.folderName),
    ...person.handles.map((handle) => nameKey(handle.name)),
    ...person.circles.flatMap((circle) => [nameKey(circle.group), nameKey(circle.label)]),
    ...person.authors.flatMap((author) => [nameKey(author.artist), nameKey(author.label)]),
    ...(person.labels || []).map(nameKey),
  ].filter(Boolean))];
  person.recent = person.books.slice(0, RECENT_COUNT).map((book) => ({
    id: book.id, title: book.title, date: book.date, origin: book.origin, pages: book.pages, candidate: book.candidate,
  }));
  return person;
}

// 表示名を人ごとに一つに決める (作者頁の語 @名前 が一人に定まるように)。作者フォルダの人が先
function uniqueNames(persons) {
  const used = new Set();
  const order = { folder: 0, circle: 1, hitomi: 2 };
  const ordered = [...persons].sort((a, b) => (order[a.kind] ?? 3) - (order[b.kind] ?? 3));
  for (const person of ordered) {
    const base = person.name || person.key;
    let name = base;
    if (used.has(name) && person.kind === 'hitomi') name = `${base} (${person.artist})`;
    if (used.has(name) && person.kind === 'circle') name = `${base} (${person.group})`;
    let n = 2;
    while (used.has(name)) {
      name = `${base} (${n})`;
      n += 1;
    }
    person.name = name;
    used.add(name);
  }
  return used;
}

// input:
//   folders       [{ folderId, name }]            作者根の直下
//   pawItems      paw-library の snapshot().items (creatorFolderId を持つ物)
//   pixivWork     (pid) => pixiv-library の works の一行 | null
//   pixivCreators { userId: { folderId, name } }
//   pawCreators   { "service:user": folderId }
//   links         creator-links の今結ばれている行
//   rejected      Set<linkKey>  退けた組
//   ratings       { personId: ★ }  作者の★
//   suggestions   creator-links のまだ答えの無い突き合わせの候補 ({ personId, source, name, note })
//   origins       { personId: 'discord' }  持ち込みの本の出どころ
//   names         { personId: 名前 }  利用者が決めた見出しの名前 (サークル名や作者名より先に立つ)
//   covers        { personId: 本の id }  利用者が選んだ見出しの表紙 (その人の確かな所持の本の時だけ効く)
//   releaseDateOf (eagleId) => 公開日の控えの一行 ({ date, guess, basis }) | null。名前に日付の無い本に当てる
//   hitomiRows    [{ kind: 'artist' | 'group', tag, gid, star, addedAt, published, added, title, pages, lang }]
//                 台帳の所持 (タグごと)。kind の無い行は { artist } の作者の行として読む (前の形)
//   labelOf       (artist) => 日本語の札
//   groupLabelOf  (group) => 日本語の札
//   followed      Set<artist>  発見の followed
//   newByArtist   Map<artist, 新作の数>
//   newIdsByArtist Map<artist, Set<新作の hitomi の id>>  (作者頁の「新」の印)
//   eagleRows     [{ eagleId, gid | null, tags: [Eagle のタグ], star, addedAt, itemTitle, title, pages, lang, published, added }]
//                 台帳の Eagle の項目のうちタグのある物 (attachByEagleTags が人に寄せる)
//   eagleLinks    [{ eagleId, gid }]  台帳で照合先のある Eagle の項目 (作者フォルダの本と所持の hitomi の本を一冊に畳む)
function buildHome(input = {}) {
  let {
    folders = [], pawItems = [], pixivWork = () => null, pixivCreators = {}, pawCreators = {},
    links = [], rejected = new Set(), ratings = {}, suggestions = [], origins = {}, names = {}, covers = {}, hitomiRows = [], labelOf = () => '', groupLabelOf = () => '',
    releaseDateOf = () => null, eagleRows = [], eagleLinks = [],
    followed = new Set(), newByArtist = new Map(), newIdsByArtist = new Map(), minOwned = HITOMI_MIN_OWNED, dominantMin = DOMINANT_MIN, dominantShare = DOMINANT_SHARE, sharedMin = SHARED_MIN_OWNED,
  } = input;

  const persons = new Map();
  const folderPersons = new Map();
  for (const folder of folders) {
    const folderId = String(folder && folder.folderId || '');
    if (!folderId || folderPersons.has(folderId)) continue;
    const person = newPerson('folder', folderId, String(folder.name || ''));
    folderPersons.set(folderId, person);
    persons.set(person.id, person);
  }

  for (const item of pawItems) {
    const person = folderPersons.get(String(item && item.creatorFolderId || ''));
    if (person) person.books.push(folderBook(item, pixivWork, releaseDateOf));
  }
  for (const person of folderPersons.values()) {
    // 小分けのフォルダの名前の年の無い月は、その作者の年のある名前の一番古い年の前の年とみなす
    // (年を書き始める前の月は年を省いていた、という書き方。年のある名前が無ければ日付不明のまま)
    const years = person.books.map((book) => book.folderMonth && book.folderMonth.year).filter(Boolean);
    const bare = years.length ? Math.min(...years) - 1 : null;
    for (const book of person.books) {
      if (!book.date && book.folderMonth && !book.folderMonth.year && bare) book.date = monthDate(bare, book.folderMonth.month);
    }
    // 持ち込みの本の出どころ (利用者が決めた物)。分からない本の ? をそのアイコンに変える
    person.localOrigin = String(origins[person.folderId] || '');
    if (person.localOrigin) {
      for (const book of person.books) if (book.origin === 'local') book.origin = person.localOrigin;
    }
  }

  // pixiv と Pawchive の結びは、作者フォルダの人は既存の台帳が答え (§6-3)
  for (const [userId, bind] of Object.entries(pixivCreators || {})) {
    const person = folderPersons.get(String(bind && bind.folderId || ''));
    if (person && /^\d+$/.test(String(userId))) pushLink(person, 'pixiv', String(userId), 'linked');
  }
  for (const [key, folderId] of Object.entries(pawCreators || {})) {
    const person = folderPersons.get(String(folderId || ''));
    const value = pawValue(key);
    if (person && value) pushLink(person, 'pawchive', value, 'linked');
  }

  // ---- hitomi の所持: 本は gid ごとに一冊、作者 (artist) とサークル (group) ごとの束 ----
  const booksByGid = new Map();
  const artistBooks = new Map();
  const groupBooks = new Map();
  const groupsOfGid = new Map();
  const artistsOfGid = new Map();
  for (const row of hitomiRows) {
    if (!row) continue;
    const kind = row.kind === 'group' || (!row.kind && row.group && !row.artist) ? 'group' : 'artist';
    const tag = String(row.tag || (kind === 'group' ? row.group : row.artist) || '');
    if (!tag || row.gid == null || row.gid === '') continue;
    const gid = String(row.gid);
    if (!booksByGid.has(gid)) booksByGid.set(gid, hitomiBook(row));
    const map = kind === 'group' ? groupBooks : artistBooks;
    if (!map.has(tag)) map.set(tag, new Set());
    map.get(tag).add(gid);
    if (kind === 'group') {
      if (!groupsOfGid.has(gid)) groupsOfGid.set(gid, new Set());
      groupsOfGid.get(gid).add(tag);
    } else {
      if (!artistsOfGid.has(gid)) artistsOfGid.set(gid, new Set());
      artistsOfGid.get(gid).add(tag);
    }
  }
  const labels = new Map();
  const artistLabel = (artist) => {
    const key = `a:${artist}`;
    if (!labels.has(key)) labels.set(key, String(labelOf(artist) || ''));
    return labels.get(key);
  };
  const groupLabel = (group) => {
    const key = `g:${group}`;
    if (!labels.has(key)) labels.set(key, String(groupLabelOf(group) || ''));
    return labels.get(key);
  };
  const artistName = (artist) => artistLabel(artist) || prettyTag(artist);
  const groupName = (group) => groupLabel(group) || prettyTag(group);

  // 主のサークル: 作者の本の 6 割以上 (2 冊以上) が入るサークル
  const dominantOf = new Map();
  for (const [artist, gids] of artistBooks) {
    const counts = new Map();
    for (const gid of gids) for (const group of groupsOfGid.get(gid) || []) counts.set(group, (counts.get(group) || 0) + 1);
    let best = '';
    let bestCount = 0;
    for (const [group, count] of counts) {
      if (count > bestCount || (count === bestCount && group < best)) {
        best = group;
        bestCount = count;
      }
    }
    if (best && bestCount >= dominantMin && bestCount / gids.size >= dominantShare) dominantOf.set(artist, best);
  }

  // hitomi の塊 (unit): サークル (主のサークルにする作者と、そのサークルの本) か、どのサークルにも寄らない作者
  const units = new Map();
  const unitOfArtist = new Map();
  const unitOfGroup = new Map();
  const circleUnit = (group) => {
    let unit = unitOfGroup.get(group);
    if (!unit) {
      unit = { type: 'circle', group, members: [], gids: new Set(groupBooks.get(group) || []) };
      unitOfGroup.set(group, unit);
      units.set(`c:${group}`, unit);
    }
    return unit;
  };
  for (const [artist, gids] of artistBooks) {
    const group = dominantOf.get(artist);
    let unit;
    if (group) {
      unit = circleUnit(group);
      unit.members.push(artist);
      for (const gid of gids) unit.gids.add(gid);
    } else {
      unit = { type: 'artist', artist, members: [artist], gids: new Set(gids) };
      units.set(`h:${artist}`, unit);
    }
    unitOfArtist.set(artist, unit);
  }
  // 作者のタグの無いサークルだけの本。ただし、そのサークルの本が全部一人の作者 (どのサークルにも寄らない作者) の本なら、
  // 別の見出しにせず、その作者の塊に寄せる (2026-09-25: 同じ人がサークルと作者の二枚に出ていた)。
  // group の名乗りはその作者の塊を指す (結び・候補・束ねはこれまでどおり効く)
  for (const group of groupBooks.keys()) {
    if (unitOfGroup.has(group)) continue;
    const gids = groupBooks.get(group) || new Set();
    let owner = null;
    for (const gid of gids) {
      const artists = artistsOfGid.get(gid);
      const unit = artists && artists.size === 1 ? unitOfArtist.get([...artists][0]) : null;
      if (!unit || unit.type !== 'artist' || (owner && owner !== unit)) {
        owner = null;
        break;
      }
      owner = unit;
    }
    if (owner) {
      unitOfGroup.set(group, owner);
      (owner.groups = owner.groups || []).push(group);
      continue;
    }
    circleUnit(group);
  }
  const unitFor = (handle) => (handle.type === 'group' ? unitOfGroup.get(handle.name) : unitOfArtist.get(handle.name)) || null;
  const unitHandle = (unit) => (unit.type === 'circle' ? { type: 'group', name: unit.group } : { type: 'artist', name: unit.artist });
  const unitBooks = (unit, candidate = false) => [...unit.gids].map((gid) => booksByGid.get(gid))
    .filter(Boolean).map((book) => (candidate ? { ...book, candidate: true } : book));
  const unitKeys = (unit) => {
    const keys = [];
    if (unit.type === 'circle') keys.push(nameKey(groupLabel(unit.group)), nameKey(unit.group), nameKey(prettyTag(unit.group)));
    for (const group of unit.groups || []) keys.push(nameKey(groupLabel(group)), nameKey(group), nameKey(prettyTag(group)));
    for (const artist of unit.members) keys.push(nameKey(artistLabel(artist)), nameKey(artist), nameKey(prettyTag(artist)));
    return [...new Set(keys.filter(Boolean))];
  };
  const unitNews = (unit) => unit.members.reduce((sum, artist) => sum + (newByArtist.get(artist) || 0), 0);
  const unitNewIds = (unit) => unit.members.flatMap((artist) => [...(newIdsByArtist.get(artist) || [])]);

  // 本が全部一人の作者の物だったサークルの鍵 (c:<group>) は、その作者の鍵 (h:<artist>) に読み替える
  // (以前はサークルの見出しだった物に付けた結び・★・名前・表紙・候補・退けた答えを迷子にしない。書く時は今の鍵)。
  // 両方の鍵に値がある時は今の鍵 (h:) の物が勝つ
  const aliasId = new Map();
  for (const [group, unit] of unitOfGroup) if (unit.type === 'artist') aliasId.set(`c:${group}`, `h:${unit.artist}`);
  if (aliasId.size) {
    const tr = (id) => aliasId.get(String(id)) || String(id);
    const trRows = (rows) => rows.map((row) => (aliasId.has(String(row.personId)) ? { ...row, personId: tr(row.personId) } : row));
    const trMap = (map) => {
      const out = {};
      for (const [key, value] of Object.entries(map || {})) if (!aliasId.has(key)) out[key] = value;
      for (const [key, value] of Object.entries(map || {})) if (aliasId.has(key) && !(tr(key) in out)) out[tr(key)] = value;
      return out;
    };
    links = trRows(links);
    suggestions = trRows(suggestions);
    ratings = trMap(ratings);
    names = trMap(names);
    covers = trMap(covers);
    rejected = new Set([...rejected].map((key) => {
      try {
        const [personId, source, name] = JSON.parse(key);
        return linkKey(tr(personId), source, name);
      } catch {
        return key;
      }
    }));
  }

  // 人に塊を写す (確定なら名前と見出しの印も、候補なら ? の本だけ)
  const absorb = (person, unit, candidate) => {
    person.books.push(...unitBooks(unit, candidate));
    person.newCount += unitNews(unit);
    for (const id of unitNewIds(unit)) person.newIds.add(String(id));
    const handle = { ...unitHandle(unit), candidate };
    if (!person.handles.some((row) => row.type === handle.type && row.name === handle.name)) person.handles.push(handle);
    else if (!candidate) person.handles.find((row) => row.type === handle.type && row.name === handle.name).candidate = false;
    if (unit.type === 'circle') addUnique(person.circles, { group: unit.group, label: groupName(unit.group), candidate }, 'group');
    for (const artist of unit.members) addUnique(person.authors, { artist, label: artistName(artist), candidate }, 'artist');
    for (const artist of unit.members) {
      const label = artistLabel(artist);
      if (label) (person.labels = person.labels || []).push(label);
    }
    if (unit.type === 'circle' && groupLabel(unit.group)) (person.labels = person.labels || []).push(groupLabel(unit.group));
  };

  // 作者フォルダの無い見出しどうしの束ね (利用者が「同じ人」と結んだ hitomi の名乗り)。
  // 'c:<group>' / 'h:<artist>' の人に別の塊の名乗りを結ぶと、その塊ごと寄る (名前は寄せた先の物)
  const mergedInto = new Map();
  const mergeChildren = new Map();
  const mergeLinks = new Map();
  const rootOf = (unit) => {
    let node = unit;
    const seen = new Set();
    while (mergedInto.has(node) && !seen.has(node)) {
      seen.add(node);
      node = mergedInto.get(node);
    }
    return node;
  };
  for (const row of links) {
    if (row.source !== 'hitomi') continue;
    const personId = String(row.personId);
    let target = null;
    if (personId.startsWith('c:')) target = unitOfGroup.get(personId.slice(2)) || null;
    else if (personId.startsWith('h:')) target = unitOfArtist.get(personId.slice(2)) || null;
    if (!target) continue;
    const handle = parseHandleValue(String(row.name));
    const other = unitFor(handle);
    if (!mergeLinks.has(target)) mergeLinks.set(target, []);
    mergeLinks.get(target).push(handleValue(handle));
    if (!other || rootOf(other) === rootOf(target) || mergedInto.has(other)) continue;
    mergedInto.set(other, target);
    if (!mergeChildren.has(target)) mergeChildren.set(target, []);
    mergeChildren.get(target).push(other);
  }
  // 塊と、それに束ねた塊 (子の子まで)
  const withMerged = (unit) => {
    const out = [unit];
    for (let i = 0; i < out.length; i += 1) for (const child of mergeChildren.get(out[i]) || []) if (!out.includes(child)) out.push(child);
    return out;
  };

  // 確定した hitomi の名乗り (creator-links)。塊の一つの名乗りを結べば、その塊ごと作者フォルダに寄る
  const claimed = new Map();
  for (const row of links) {
    if (row.source !== 'hitomi') continue;
    const person = folderPersons.get(String(row.personId));
    if (!person) continue;
    const handle = parseHandleValue(String(row.name));
    pushLink(person, 'hitomi', handleValue(handle), 'linked');
    const unit = unitFor(handle);
    if (!unit) {
      // 所持の本が無い名乗り: 網の作品だけ引く
      if (!person.handles.some((row2) => row2.type === handle.type && row2.name === handle.name)) person.handles.push({ ...handle, candidate: false });
      continue;
    }
    if (claimed.has(unit)) continue;
    for (const part of withMerged(rootOf(unit))) {
      if (claimed.has(part)) continue;
      claimed.set(part, person);
      absorb(person, part, false);
    }
  }

  // 名前の一致は「候補」。一つの作者フォルダ ↔ 一つの塊に定まる時だけ (二つ以上なら出さない)
  const folderByKey = new Map();
  for (const person of folderPersons.values()) {
    const key = nameKey(person.folderName);
    if (!key) continue;
    if (!folderByKey.has(key)) folderByKey.set(key, []);
    folderByKey.get(key).push(person);
  }
  const proposals = new Map();
  for (const unit of units.values()) {
    if (claimed.has(unit) || mergedInto.has(unit)) continue;
    const matched = new Set();
    for (const key of unitKeys(unit)) for (const person of folderByKey.get(key) || []) matched.add(person);
    if (matched.size !== 1) continue;
    const person = [...matched][0];
    if (person.links.hitomi.some((link) => link.state === 'linked')) continue;
    const value = handleValue(unitHandle(unit));
    if (rejected.has(linkKey(person.folderId, 'hitomi', value))) continue;
    if (!proposals.has(person)) proposals.set(person, []);
    proposals.get(person).push(unit);
  }
  const candidateUnits = new Set();
  for (const [person, list] of proposals) {
    if (list.length !== 1) continue;
    const unit = list[0];
    pushLink(person, 'hitomi', handleValue(unitHandle(unit)), 'candidate');
    for (const part of withMerged(unit)) {
      if (claimed.has(part) || candidateUnits.has(part)) continue;
      candidateUnits.add(part);
      absorb(person, part, true);
    }
  }
  // 突き合わせの候補 (hitomi の名乗り → 作者フォルダ)。所持の本がある名乗りなら、その塊を候補の本として寄せる
  for (const row of suggestions) {
    if (row.source !== 'hitomi') continue;
    const person = folderPersons.get(String(row.personId));
    if (!person || person.links.hitomi.some((link) => link.state === 'linked')) continue;
    const handle = parseHandleValue(String(row.name));
    const value = handleValue(handle);
    if (rejected.has(linkKey(person.folderId, 'hitomi', value))) continue;
    pushLink(person, 'hitomi', value, 'candidate', { suggested: true, note: String(row.note || ''), unresolved: row.unresolved === true });
    const unit = unitFor(handle);
    if (unit && !claimed.has(unit) && !candidateUnits.has(unit)) {
      for (const part of withMerged(rootOf(unit))) {
        if (claimed.has(part) || candidateUnits.has(part)) continue;
        candidateUnits.add(part);
        absorb(person, part, true);
      }
    }
  }

  // 残った塊は hitomi だけの人 (サークルか作者)。所持 3 冊以上か、発見でよく集めている作者を含む物だけ
  for (const unit of units.values()) {
    if (claimed.has(unit) || candidateUnits.has(unit) || mergedInto.has(unit)) continue;
    const parts = withMerged(unit).filter((part) => !claimed.has(part) && !candidateUnits.has(part));
    const gids = new Set(parts.flatMap((part) => [...part.gids])).size;
    const follow = parts.some((part) => part.members.some((artist) => followed.has(artist)));
    if (gids < minOwned && !follow) continue;
    let person;
    if (unit.type === 'circle') {
      person = newPerson('circle', unit.group, groupName(unit.group));
      // サークルの名乗りそのもの (確定。外せない)
      pushLink(person, 'hitomi', handleValue(unitHandle(unit)), 'linked', { fixed: true });
    } else {
      person = newPerson('hitomi', unit.artist, artistName(unit.artist));
      pushLink(person, 'hitomi', unit.artist, 'linked', { fixed: true });
    }
    for (const part of parts) absorb(person, part, false);
    // 束ねた名乗り (外せる)
    for (const value of mergeLinks.get(unit) || []) pushLink(person, 'hitomi', value, 'linked');
    persons.set(person.id, person);
  }

  // どのサークルにも寄らない作者の、寄り道したサークル (詳細の「サークル」に出すだけ)
  for (const person of persons.values()) {
    if (person.kind !== 'hitomi') continue;
    const counts = new Map();
    for (const gid of artistBooks.get(person.artist) || []) {
      for (const group of groupsOfGid.get(gid) || []) counts.set(group, (counts.get(group) || 0) + 1);
    }
    // 本が全部この作者の物だったサークル (別の見出しにしなかった物) は、その人のサークルそのもの (寄り道ではない)
    const own = new Set((unitOfArtist.get(person.artist) || {}).groups || []);
    [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 3)
      .forEach(([group]) => addUnique(person.circles, { group, label: groupName(group), candidate: false, minor: !own.has(group) }, 'group'));
  }

  // pixiv / Pawchive / nhentai の、作者フォルダを持たない人の結び (creator-links)。作者フォルダの人の nhentai もここ
  const byPersonId = new Map();
  for (const person of persons.values()) byPersonId.set(personIdOf(person), person);
  for (const row of links) {
    if (!['pixiv', 'pawchive', 'nhentai'].includes(row.source)) continue;
    const person = byPersonId.get(String(row.personId));
    if (!person) continue;
    if (row.source !== 'nhentai' && person.kind === 'folder') continue;
    pushLink(person, row.source, String(row.name), 'linked');
  }
  // 突き合わせの候補 (pixiv / Pawchive)。結び済みの値と、退けた組は出さない
  for (const row of suggestions) {
    if (row.source !== 'pixiv' && row.source !== 'pawchive') continue;
    const person = byPersonId.get(String(row.personId));
    if (!person) continue;
    const value = String(row.name);
    if (person.links[row.source].some((link) => link.value === value && link.state === 'linked')) continue;
    if (rejected.has(linkKey(personIdOf(person), row.source, value))) continue;
    pushLink(person, row.source, value, 'candidate', { suggested: true, note: String(row.note || ''), unresolved: row.unresolved === true });
  }
  // nhentai: 確定が無ければ作者 (artist) の名乗りから推した候補 (退けた物は出さない)
  for (const person of persons.values()) {
    if (person.links.nhentai.some((link) => link.state === 'linked')) continue;
    for (const author of person.authors) {
      const slug = nhentaiSlug(author.artist);
      if (!slug || rejected.has(linkKey(personIdOf(person), 'nhentai', slug))) continue;
      pushLink(person, 'nhentai', slug, 'candidate');
    }
    // サークルは nhentai の group の頁 (名の空白を - にした推測)
    for (const circle of person.circles) {
      if (circle.minor || circle.candidate) continue;
      const slug = nhentaiSlug(circle.group);
      const value = slug ? `group:${slug}` : '';
      if (!value || rejected.has(linkKey(personIdOf(person), 'nhentai', value))) continue;
      pushLink(person, 'nhentai', value, 'candidate');
    }
  }

  // 名前: サークルと作者の両方が分かる時はサークルを先に。作者フォルダの人は、確定した名乗りから
  // サークルが一つに定まる時だけサークル名にする (候補では変えない。フォルダ名は作者として残る)
  for (const person of persons.values()) {
    person.rating = Math.max(0, Math.min(5, Math.round(Number(ratings[personIdOf(person)]) || 0)));
    if (person.kind !== 'folder') continue;
    const sure = person.circles.filter((circle) => !circle.candidate && !circle.minor);
    if (sure.length === 1) {
      person.name = sure[0].label || person.name;
      // フォルダ名は作者として先頭に残す (同じ名の hitomi の作者が居ればそちら = 作者頁へ飛べる方を残す)
      const key = nameKey(person.folderName);
      if (key && !person.authors.some((author) => nameKey(author.label) === key || nameKey(author.artist) === key)) {
        person.authors.unshift({ artist: '', label: person.folderName, candidate: false, self: true });
      }
    }
  }
  for (const person of persons.values()) {
    if (person.kind === 'hitomi') person.authors.forEach((author) => { if (author.artist === person.artist) author.self = true; });
  }
  // 利用者が決めた名前 (「〜に統一」)。サークル名を先に立てる決まりより先に効く。元の名前は検索の鍵に残る
  for (const person of persons.values()) {
    const chosen = String(names[personIdOf(person)] || '').trim();
    if (!chosen) continue;
    (person.labels = person.labels || []).push(person.name);
    person.name = chosen;
    person.renamed = true;
  }
  // 利用者が選んだ表紙。当てるのは finish (本を一冊に畳んだ後で、その人の本かを確かめる)
  for (const person of persons.values()) {
    const cover = String(covers[personIdOf(person)] || '').trim();
    if (cover) person.chosenCover = cover;
  }

  // Eagle のタグで人に寄せる所持の本 (名前と結びが出そろった後で)。照合先の作者・サークルの鍵 (名乗りと札) を添える
  const creatorKeys = new Map();
  const addCreatorKeys = (gids, keys) => {
    for (const gid of gids) {
      if (!creatorKeys.has(gid)) creatorKeys.set(gid, new Set());
      for (const key of keys) if (key) creatorKeys.get(gid).add(key);
    }
  };
  for (const [artist, gids] of artistBooks) addCreatorKeys(gids, [nameKey(artist), nameKey(prettyTag(artist)), nameKey(artistLabel(artist))]);
  for (const [group, gids] of groupBooks) addCreatorKeys(gids, [nameKey(group), nameKey(prettyTag(group)), nameKey(groupLabel(group))]);
  // 作者フォルダの本と、同じ Eagle の項目の所持の hitomi の本を一冊に (タグの道より先に: 道の「持っている」の印を揃える)
  const gidOfEagle = new Map();
  for (const row of eagleLinks) {
    const eagleId = String(row && row.eagleId || '');
    const gid = row && row.gid != null ? String(row.gid) : '';
    if (eagleId && /^\d+$/.test(gid)) gidOfEagle.set(eagleId, gid);
  }
  for (const person of folderPersons.values()) foldLinkedTwins(person, gidOfEagle);
  attachByEagleTags(persons.values(), eagleRows, releaseDateOf, (gid) => creatorKeys.get(gid) || null);
  // 所持の hitomi の本を Eagle に入れた時刻は、照合元の項目のうち一番早い物
  const addedOfGid = new Map();
  for (const [eagleId, gid] of gidOfEagle) {
    const at = eagleAddedAt(eagleId);
    if (at && (!addedOfGid.has(gid) || at < addedOfGid.get(gid))) addedOfGid.set(gid, at);
  }

  const list = [...persons.values()];
  const used = uniqueNames(list);
  const byId = new Map();
  const byName = new Map();
  for (const person of list) {
    for (const book of person.books) book.addedAt = bookAddedAt(book, addedOfGid);
    finish(person);
    byId.set(person.id, person);
    byName.set(person.name, person);
  }

  // 共著・合同誌の一冊きりの見出しは並べない (2026-09-26、利用者: 二人の共著で片方がその一冊しか持っていないなら Home に出さない。
  // 二冊以上持つようになったら出す)。hitomi だけの人 (作者・サークル) で、所持が sharedMin 冊未満、かつその本を全部、
  // より多く持つ別の見出しが持っている時は一覧に出さない。本はその見出しから読め、作者の頁は詳細の「作者」(@名) から開ける
  // (byId / byName には残す)。利用者が★・名前・表紙を付けた見出しと、発見で集めている作者は残す
  const hidden = new Set();
  const holders = new Map();
  for (const person of list) {
    for (const book of person.books) {
      if (book.candidate || !book.ref || book.ref.type !== 'hitomi') continue;
      const gid = String(book.ref.gid);
      if (!holders.has(gid)) holders.set(gid, []);
      holders.get(gid).push(person);
    }
  }
  for (const person of list) {
    if (person.kind === 'folder' || !person.count || person.count >= sharedMin) continue;
    if (person.rating > 0 || person.renamed || person.coverChosen) continue;
    if (person.authors.some((author) => author.artist && followed.has(author.artist))) continue;
    // サークルはサークル名で出す (利用者: 個別の作者で Home を埋めない)。作者の見出しだけが持つ本のサークルは隠さない
    const bigger = (other) => other !== person && other.count > person.count && !(person.kind === 'circle' && other.kind === 'hitomi');
    const confirmed = person.books.filter((book) => !book.candidate);
    const covered = confirmed.every((book) => book.ref && book.ref.type === 'hitomi'
      && (holders.get(String(book.ref.gid)) || []).some(bigger));
    if (covered) hidden.add(person.id);
  }
  const shown = hidden.size ? list.filter((person) => !hidden.has(person.id)) : list;

  // 作者の頁への飛び: 作者の見出しを持たない作者には、その作者の本だけの頁 (語は作者の名。見出しとぶつかる時は「(作者)」)
  const ownArtistEntry = new Map();
  for (const person of list) if (person.kind === 'hitomi') ownArtistEntry.set(person.artist, person);
  const virtualByName = new Map();
  const virtualName = new Map();
  const nameForArtist = (artist) => {
    if (virtualName.has(artist)) return virtualName.get(artist);
    const base = artistName(artist);
    let name = base;
    if (used.has(name) || virtualByName.has(name)) name = `${base} (作者)`;
    let n = 2;
    while (used.has(name) || virtualByName.has(name)) {
      name = `${base} (作者 ${n})`;
      n += 1;
    }
    virtualName.set(artist, name);
    virtualByName.set(name, artist);
    return name;
  };
  for (const person of list) {
    for (const author of person.authors) {
      if (!author.artist || author.self) continue;
      const own = ownArtistEntry.get(author.artist);
      author.query = `@${own ? own.name : nameForArtist(author.artist)}`;
    }
  }

  // 作者の頁をその場で組む (一覧には並べない)
  const virtualPerson = (artist) => {
    const gids = artistBooks.get(artist);
    if (!gids) return null;
    const person = newPerson('hitomi', artist, nameForArtist(artist));
    person.virtual = true;
    person.books = [...gids].map((gid) => booksByGid.get(gid)).filter(Boolean);
    person.handles.push({ type: 'artist', name: artist, candidate: false });
    person.authors.push({ artist, label: artistName(artist), candidate: false, self: true });
    const group = dominantOf.get(artist);
    if (group) person.circles.push({ group, label: groupName(group), candidate: false });
    pushLink(person, 'hitomi', artist, 'linked', { fixed: true });
    person.newCount = newByArtist.get(artist) || 0;
    person.newIds = new Set([...(newIdsByArtist.get(artist) || [])].map(String));
    return finish(person);
  };

  return { persons: shown, byId, byName, virtualByName, virtualPerson, hidden: [...hidden] };
}

// ---------------------------------------------------------------------------
// 画面へ渡す形
// ---------------------------------------------------------------------------

// 見出しの扇の後ろの二枚: 顔の次に新しい確かな所持の本 (候補は入れない)。
// 作者フォルダの自動の顔 (pwlibf:) はフォルダの一番新しい本の表紙なので、その本 (日付順の先頭) は飛ばす
// 作品の検索の間は、語に当たった本から選ぶ (pool)
function stackOf(person, pool = null) {
  const confirmed = person.books.filter((book) => !book.candidate);
  // 作者フォルダの札の顔は一番新しい本の表紙を借りる: 同じ絵を後ろに重ねない
  const faceBook = person.kind === 'folder' && !person.coverChosen && confirmed.length ? confirmed[0].id : null;
  return (pool || confirmed)
    .filter((book) => !book.candidate && book.id !== person.cover && book.id !== faceBook)
    .slice(0, 2)
    .map((book) => book.id);
}

// 見出し一枚 (と詳細)。本体の札と同じ器 (gallery の形) に Home の持ち物を home に添える。
// match は作品の検索の当たり ({ books, count })。見出しに当たった冊数を添え、扇の後ろを当たった本にする
function authorCard(person, { readOnly = false, match = null } = {}) {
  const links = {};
  for (const site of SITE_KEYS) {
    links[site] = person.links[site].map((link) => ({
      url: link.url, state: link.state, fixed: link.fixed === true, suggested: link.suggested === true, note: link.note || '', unresolved: link.unresolved === true,
    }));
  }
  // 題の下に添える作者名 (サークル名を先に立てた時だけ。二人までと「ほか」)
  const others = person.authors.filter((author) => !author.candidate && author.label && author.label !== person.name);
  const shown = person.kind === 'circle' || (person.kind === 'folder' && person.name !== person.folderName);
  const authorLine = shown && others.length
    ? `${others.slice(0, 2).map((author) => author.label).join('・')}${others.length > 2 ? ` ほか ${others.length - 2} 人` : ''}`
    : '';
  return {
    id: person.id,
    source: 'home',
    kind: 'creator',
    title: person.name,
    artists: [],
    groups: [],
    series: [],
    characters: [],
    tags: [],
    pageCount: 0,
    badge: '',
    owned: false,
    url: '',
    home: {
      kind: person.kind,
      name: person.name,
      folderName: person.folderName,
      authorLine,
      cover: person.cover,
      // 自動の顔 (選んだ表紙を外すとこれに戻る) と、利用者が表紙を選んでいるか
      coverAuto: person.coverAuto || '',
      coverChosen: person.coverChosen === true,
      // 扇の後ろの二枚 (本の id。画面は顔と同じ imgUrl で描く)
      stack: stackOf(person, match ? match.books : null),
      count: person.count,
      // 作品の検索に当たった確かな所持の本の数 (検索していない時は null) と、語が全部作者の名に当たった印
      // (画面は作者頁へ移る時に語を付けない: 全部の本が当たり)
      matched: match ? match.count : null,
      matchedByName: Boolean(match && match.byName),
      newCount: person.newCount,
      sites: person.sites,
      unsure: person.unsure,
      rating: person.rating,
      // 利用者が名前を決めた見出し (詳細で「元の名前に戻す」を出す)
      renamed: person.renamed === true,
      // 持ち込みの本 (出どころの分からない本か、利用者が出どころを決めた本) の数と、その出どころ
      localCount: (person.bySource.local || 0) + (person.bySource.discord || 0),
      localOrigin: person.localOrigin || '',
      circles: person.circles.map((circle) => ({ group: circle.group, label: circle.label, candidate: circle.candidate === true, minor: circle.minor === true })),
      authors: person.authors.map((author) => ({
        label: author.label, artist: author.artist, candidate: author.candidate === true, self: author.self === true, query: author.query || '',
      })),
      links,
      // 誰でも結べる (作者フォルダの無い人の pixiv / Pawchive / hitomi は creator-links に書く)。
      // hitomi だけの人の hitomi の見出しそのもの (fixed) は外せないが、別の名乗りを結べばその塊ごと束ねる
      linkable: {
        pixiv: !readOnly && !person.virtual,
        pawchive: !readOnly && !person.virtual,
        hitomi: !readOnly && !person.virtual,
        nhentai: !readOnly && !person.virtual,
      },
      rateable: !readOnly && !person.virtual,
      // 表紙を所持の本から選べる (写しでは選ばない)
      coverable: !readOnly && !person.virtual,
      recent: person.recent,
    },
  };
}

// ---------------------------------------------------------------------------
// 検索・並び・絞り (控えの上で回す)
// ---------------------------------------------------------------------------

// 読んだ作者の鍵: pixiv:<user id> / pawchive:<service>:<user> / name:<作者の名の鍵> / group:<サークルの名の鍵>。
// 読む画面が栞に添える形 (name: と group: は生の名で来るので、ここで鍵に均す)。形の違う物は ''
function readCreatorKey(value) {
  const text = String(value || '');
  const cut = text.indexOf(':');
  if (cut <= 0) return '';
  const kind = text.slice(0, cut);
  const rest = text.slice(cut + 1);
  if (kind === 'name' || kind === 'group') {
    const key = nameKey(rest);
    return [...key].length >= 2 ? `${kind}:${key}` : '';
  }
  if (kind === 'pixiv' || kind === 'pawchive') return rest ? text : '';
  return '';
}

// 人の読んだ作者の鍵。確かな名乗りだけ (候補は入れない)。hitomi / nhentai の名乗りは名の鍵で突き合わせる
function personReadKeys(person) {
  const keys = new Set();
  const nameOf = (value) => {
    const text = String(value || '');
    return text.startsWith('group:') ? readCreatorKey(text) : readCreatorKey(`name:${text}`);
  };
  for (const link of person.links.pixiv) if (link.state === 'linked') keys.add(`pixiv:${link.value}`);
  for (const link of person.links.pawchive) if (link.state === 'linked') keys.add(`pawchive:${link.value}`);
  for (const site of ['hitomi', 'nhentai']) for (const link of person.links[site]) if (link.state === 'linked') keys.add(nameOf(link.value));
  for (const author of person.authors) if (!author.candidate) keys.add(nameOf(author.artist));
  for (const circle of person.circles) if (!circle.candidate && !circle.minor) keys.add(nameOf(`group:${circle.group}`));
  keys.delete('');
  return keys;
}

// 作者の鍵ごとの最後に読んだ時刻。栞の鍵が人の本に当たらない読み (他のタブで読んだ本・所持していない本) を作者で人へ寄せる (2026-09-27)。
//   pw:<service>:<user>:<投稿> の栞は鍵そのものが作者を言う (前からの分も寄る)
//   ほかは読む画面が栞に添えた作者 (reading-store の creatorReads)。添え始める前の pixiv / nhentai / 未所持の hitomi の読みは寄らない
function creatorReadTimes(marks, creatorReads) {
  const out = new Map();
  const bump = (key, at) => {
    if (key && at > (out.get(key) || 0)) out.set(key, at);
  };
  for (const [key, mark] of Object.entries(marks || {})) {
    if (!key.startsWith('pw:')) continue;
    const [, service, user] = key.split(':');
    if (service && user) bump(`pawchive:${pawValue(`${service}:${user}`)}`, Number(mark && mark.updatedAt) || 0);
  }
  for (const [key, at] of Object.entries(creatorReads || {})) bump(readCreatorKey(key), Number(at) || 0);
  return out;
}

function lastReadOf(person, marks, byCreator) {
  let last = 0;
  for (const key of person.readKeys) {
    const mark = marks[key];
    const at = Number(mark && mark.updatedAt) || 0;
    if (at > last) last = at;
  }
  if (byCreator && byCreator.size) {
    for (const key of personReadKeys(person)) {
      const at = byCreator.get(key) || 0;
      if (at > last) last = at;
    }
  }
  return last;
}

// 最近の動きの帯: 直近 2 週間に Eagle へ入れた本がある人を、入れた新しい順に
function movingOf(persons, now = Date.now()) {
  const since = now - MOVING_WINDOW_MS;
  return sortPersons(persons.filter((person) => (person.lastAddedAt || 0) >= since), 'activity').slice(0, OVERVIEW_MOVING_MAX);
}

// reads: { marks: 栞の要約, creators: 作者ごとの読んだ時刻 } (並びが 'read' の時だけ要る)
function sortPersons(list, sort, reads = {}) {
  const byName = (a, b) => String(a.name).localeCompare(String(b.name), 'ja');
  let compare;
  if (sort === 'owned') compare = (a, b) => b.count - a.count || byName(a, b);
  else if (sort === 'read') {
    const byCreator = creatorReadTimes(reads.marks, reads.creators);
    const times = new Map(list.map((person) => [person, lastReadOf(person, reads.marks || {}, byCreator)]));
    compare = (a, b) => times.get(b) - times.get(a) || byName(a, b);
  } else if (sort === 'title') compare = byName;
  // 作品の評価順: 所持の本の Eagle の★ (点の平均を均した値)。同じ値なら所持の多い順
  else if (sort === 'stars') compare = (a, b) => b.starScore - a.starScore || b.count - a.count || byName(a, b);
  // 作者の評価順: 作者の★ (付けていない人は後ろ)。同じ★なら作品の評価、所持の多い順
  else if (sort === 'rating') compare = (a, b) => (b.rating || 0) - (a.rating || 0) || b.starScore - a.starScore || b.count - a.count || byName(a, b);
  else {
    // 最近の動き: 所持の本を最後に Eagle へ入れた新しい順 (2026-09-27 に公開日の新しい順から変えた。利用者: 動き = 落とした本)。
    // 同じなら新しい本の公開日、所持の多い順
    compare = (a, b) => {
      const added = (b.lastAddedAt || 0) - (a.lastAddedAt || 0);
      if (added) return added;
      const x = a.lastDate || '';
      const y = b.lastDate || '';
      if (x !== y) return x < y ? 1 : -1;
      return b.count - a.count || byName(a, b);
    };
  }
  return list.slice().sort(compare);
}

// ---------------------------------------------------------------------------
// 作品の検索 (2026-09-27): 語を本の題・タグ・注釈 (pixiv のキャプション) と作者の名に当て、当たった本のある人を残す。
// 語の読み方は本体の所持作品の検索 (catalog.searchLibrary) に合わせる:
//   空白で区切った語は全部を満たす (かつ)。頭の - は除く。female:… のような型付きの語は本のタグに一致するか、
//   タグの名・日本語の札・別名の元の語が当て先に含まれれば当たり。除く型付きの語はタグとの完全一致だけで弾く。
//   日本語の語は別名の辞書 (search-aliases の rewriteQuery) で型付きの語に書き換わる (元の語も当て先に残す)。
// 作者の名に当たった語はその人の本を全部通す (「作者名 タグ」でその作者のタグの本)。
// 当て先の文字列は母屋の中だけで持ち、画面へは渡さない (渡すのは当たった本の id と数)
// ---------------------------------------------------------------------------

// 当て先の区切り (語は空白で割るので、区切りを跨いで当たらない)
const FIND_SEP = '\u0001';

// ひらがなの一続きをカタカナへ (search-text の hiraToKata と同じ写し。字ごとに関数を呼ばず、続きごとに一度)
const HIRA_RUN = /[\u3041-\u3096]+/g;
function kataRun(run) {
  if (run.length > 4096) return hiraToKata(run);
  const codes = new Array(run.length);
  for (let index = 0; index < run.length; index += 1) codes[index] = run.charCodeAt(index) + 0x60;
  return String.fromCharCode(...codes);
}

// 当て先と語を同じ形へ: NFKC・小文字・下線は空白・ひらがなはカタカナ
function findText(value) {
  return titleNeedle(value == null ? '' : String(value)).replace(HIRA_RUN, kataRun);
}

// 当て先の一冊ぶんを一つの文字列に。部分ごとに整えず、区切りで繋いでから一度だけ整える
// (整えは部分の中でしか字を動かさない。一冊ごとに何十回も NFKC を回すと 1.7 万冊で 170ms かかった)
function findHay(parts) {
  return findText(parts.filter(Boolean).join(FIND_SEP));
}

// 繰り返し出る短い語 (タグの名・日本語の札) の整えを覚える
function findMemo() {
  const memo = new Map();
  return (value) => {
    const key = String(value == null ? '' : value);
    let text = memo.get(key);
    if (text === undefined) {
      text = findText(key);
      memo.set(key, text);
    }
    return text;
  };
}

// 語を条件の並びへ。rewrite は別名の書き換え ({ query, resolved } を返す)、labelOf はタグの日本語の札
function parseFind(query, { rewrite = null, labelOf = () => '' } = {}) {
  const text = String(query || '').trim();
  if (!text) return { terms: [], interpreted: [] };
  let rewritten = { query: text, resolved: [] };
  if (typeof rewrite === 'function') {
    try {
      rewritten = rewrite(text) || rewritten;
    } catch {
      rewritten = { query: text, resolved: [] };
    }
  }
  const resolved = Array.isArray(rewritten.resolved) ? rewritten.resolved : [];
  const terms = [];
  for (const token of tokenizeQuery(rewritten.query || text)) {
    const typed = parseTypePrefix(token);
    if (typed) {
      const name = tagNameKey(typed.name);
      if (!name) continue;
      const words = new Set([name]);
      let label = '';
      try {
        label = labelOf(typed.type, name) || '';
      } catch {
        label = '';
      }
      if (label) words.add(label);
      // 書き換える前の語 (打った日本語) も当て先に探す。型付きで打った語は名の方を
      for (const entry of resolved) {
        if (!entry || entry.to !== token || !entry.from) continue;
        const from = String(entry.from).replace(/^-/, '');
        const typedFrom = parseTypePrefix(from);
        words.add(typedFrom ? typedFrom.name : from.replace(/^"(.*)"$/, '$1'));
      }
      terms.push({
        negative: typed.negative === true,
        type: typed.type,
        name,
        needles: [...new Set([...words].map(findText).filter(Boolean))],
        keys: [...new Set([...words].map(nameKey).filter(Boolean))],
      });
      continue;
    }
    const negative = token.length > 1 && token.startsWith('-');
    const word = (negative ? token.slice(1) : token).replace(/^"(.*)"$/, '$1');
    const needle = findText(word);
    if (!needle) continue;
    terms.push({ negative, type: '', name: '', needles: [needle], keys: [nameKey(word)].filter(Boolean) });
  }
  return { terms, interpreted: resolved };
}

// 本の当て先を組む。材料 (m) は HomeAuthors.findMaterials の形:
//   galleries   hitomi の id → { title, lang, type, tags: [[型, 名]] }
//   eaglesOfGid hitomi の id → [Eagle の id]   gidsOfEagle  Eagle の id → [hitomi の id]
//   itemTags    Eagle の id → [{ type, name }] (未照合の項目の詳細タグ)
//   eagleMeta   (Eagle の id) => { name, tags, annotation } | null
//   pixivWork   (pid) => { title, caption, tags } | null
//   labelOf     (型, 名) => 日本語の札
// 返り: { hay: 当て先の文字列, tagKeys: '型 名' の集まり, tags: 本自身のタグ (完全一致用), own: 型の無いタグの元の字 (候補に出す), lang, type }
function bookFind(book, m) {
  const parts = [book && book.title];
  const tagKeys = new Set();
  const tags = new Set();
  const own = [];
  let lang = String((book && book.lang) || '').toLowerCase();
  let type = '';
  const norm = typeof m.norm === 'function' ? m.norm : findText;
  const ownTag = (value) => {
    const text = norm(value);
    if (text) tags.add(text);
    parts.push(value);
  };
  const tagKey = typeof m.tagKey === 'function' ? m.tagKey : tagNameKey;
  const addTag = (tagType, tagName) => {
    const kind = String(tagType || '').toLowerCase().trim();
    const name = tagKey(tagName);
    if (!kind || !name) return;
    tagKeys.add(`${kind} ${name}`);
    ownTag(name);
    let label = '';
    try {
      label = m.labelOf(kind, name) || '';
    } catch {
      label = '';
    }
    if (label) ownTag(label);
  };
  const addGallery = (gid) => {
    const gallery = m.galleries.get(String(gid));
    if (!gallery) return;
    parts.push(gallery.title);
    if (!lang && gallery.lang) lang = gallery.lang;
    if (!type && gallery.type) type = gallery.type;
    for (const [tagType, tagName] of gallery.tags) addTag(tagType, tagName);
  };
  const addEagle = (eagleId) => {
    let meta = null;
    try {
      meta = m.eagleMeta(eagleId);
    } catch {
      meta = null;
    }
    if (meta) {
      parts.push(meta.name, meta.annotation);
      for (const tag of Array.isArray(meta.tags) ? meta.tags : []) {
        ownTag(tag);
        own.push(String(tag));
      }
    }
    for (const tag of m.itemTags.get(String(eagleId)) || []) addTag(tag && tag.type, tag && tag.name);
  };
  const ref = (book && book.ref) || {};
  const gids = new Set();
  const eagleIds = new Set();
  if (ref.type === 'hitomi') {
    gids.add(String(ref.gid));
    for (const id of m.eaglesOfGid.get(String(ref.gid)) || []) eagleIds.add(id);
  } else {
    const eagleId = ref.type === 'eagle' ? ref.eagleId : (ref.item && ref.item.eagleId);
    if (eagleId) {
      eagleIds.add(String(eagleId));
      for (const gid of m.gidsOfEagle.get(String(eagleId)) || []) gids.add(gid);
    }
  }
  for (const gid of gids) addGallery(gid);
  for (const eagleId of eagleIds) addEagle(eagleId);
  if (ref.type === 'folder' && ref.pid) {
    let work = null;
    try {
      work = m.pixivWork(ref.pid);
    } catch {
      work = null;
    }
    if (work) {
      parts.push(work.title, work.caption);
      for (const tag of Array.isArray(work.tags) ? work.tags : []) {
        ownTag(tag);
        own.push(String(tag));
      }
    }
  }
  return {
    hay: findHay(parts),
    tagKeys,
    tags,
    own,
    lang: String(lang || '').toLowerCase(),
    type: String(type || '').toLowerCase(),
  };
}

// 網の作品 (本体の札の形) の当て先。題・キャプション・タグ (型付き) と日本語の札
function galleryFind(gallery, labelOf = () => '', norm = findText) {
  const g = gallery || {};
  const parts = [g.title, g.caption];
  const tagKeys = new Set();
  const tags = new Set();
  for (const [kind, name] of metaTagRows(g)) {
    tagKeys.add(`${kind} ${name}`);
    parts.push(name);
    tags.add(norm(name));
    let label = '';
    try {
      label = labelOf(kind, name) || '';
    } catch {
      label = '';
    }
    if (label) {
      parts.push(label);
      tags.add(norm(label));
    }
  }
  const lang = g.language && typeof g.language === 'object' ? g.language.name : g.language;
  return {
    hay: findHay(parts),
    tagKeys,
    tags,
    lang: String(lang || '').toLowerCase(),
    type: String(g.type || '').toLowerCase(),
  };
}

function termTagKeys(term) {
  return term.type === 'either' ? [`female ${term.name}`, `male ${term.name}`] : [`${term.type} ${term.name}`];
}

// 語が本に当たるか (除くの向きは呼ぶ側で裏返す)
function bookHit(term, find) {
  if (!find) return false;
  // 言語の分からない本 (pixiv・Pawchive・持ち込み) は日本語とみなす (本体の所持の検索と同じ)
  if (term.type === 'language') return find.lang ? find.lang === term.name : term.name === 'japanese';
  if (term.type === 'type') return Boolean(find.type) && find.type === term.name;
  if (term.type && termTagKeys(term).some((key) => find.tagKeys.has(key))) return true;
  // 除く型付きの語はタグとの完全一致だけで弾く (題や注釈に語が出ただけの本は残す)
  if (term.type && term.negative) return term.needles.some((needle) => find.tags.has(needle));
  return term.needles.some((needle) => find.hay.includes(needle));
}

// 語が作者の名に当たるか。当たればその人の本は全部通る (除くの語なら全部弾く)
function personHit(term, person) {
  if (term.type === 'language' || term.type === 'type') return false;
  if (term.type && term.negative) {
    // 除く型付きの語: 作者・サークルの名乗りとの完全一致だけ
    if (term.type !== 'artist' && term.type !== 'group') return false;
    const named = term.type === 'artist'
      ? [person.artist, ...person.authors.map((author) => author.artist), ...person.handles.filter((h) => h.type === 'artist').map((h) => h.name)]
      : [person.group, ...person.circles.map((circle) => circle.group), ...person.handles.filter((h) => h.type === 'group').map((h) => h.name)];
    return named.some((value) => value && tagNameKey(value) === term.name);
  }
  return term.keys.some((key) => person.keys.some((own) => own.includes(key)));
}

function termsPass(terms, personHits, find) {
  return terms.every((term, index) => {
    const hit = personHits[index] || bookHit(term, find);
    return term.negative ? !hit : hit;
  });
}

// 人の本のうち語に当たる物。確かな所持の本 (候補でない) が一冊でも当たれば人を残す。
// 本の無い人は名が語を満たす時だけ。返りは null (外す) か { books: 当たった本, count: 当たった確かな本の数, byName }。
// byName は語が全部作者の名に当たった (除く語も無い) 印: 作者頁を語で絞らなくても全部が当たり
function matchPerson(person, terms, findOf) {
  const personHits = terms.map((term) => personHit(term, person));
  const byName = terms.every((term, index) => !term.negative && personHits[index]);
  const books = byName ? person.books.slice() : person.books.filter((book) => termsPass(terms, personHits, findOf(book)));
  const count = books.filter((book) => !book.candidate).length;
  if (count > 0) return { books, count, byName };
  if (!person.books.length && terms.every((term, index) => (term.negative ? !personHits[index] : personHits[index]))) {
    return { books: [], count: 0, byName };
  }
  return null;
}

// 判定できなかった作者だけ・語で絞る。terms が無ければ query を別名の書き換え無しで読む。
// hits (Map) を渡すと、残した人ごとの当たりを書き込む (見出しの数と扇の後ろの二枚に使う)
function filterPersons(persons, {
  query = '', terms = null, findOf = () => null, unresolvedOnly = false, hits = null,
} = {}) {
  const list = Array.isArray(terms) ? terms : parseFind(query).terms;
  return persons.filter((person) => {
    if (unresolvedOnly && person.unresolved !== true) return false;
    if (!list.length) return true;
    const found = matchPerson(person, list, findOf);
    if (!found) return false;
    if (hits) hits.set(person, found);
    return true;
  });
}

// @名前 → 人。表示名がそのまま一致すればそれ、無ければ鍵の一致が一人に定まる時だけ。
// 見出しを持たない作者の名 (詳細の板の「作者」から飛んだ時) は、その作者の本だけの頁をその場で組む
function findByQuery(built, query) {
  const text = String(query || '').trim();
  if (!text.startsWith('@')) return null;
  const name = text.slice(1).trim();
  if (!name) return null;
  if (built.byName.has(name)) return built.byName.get(name);
  if (built.virtualByName && built.virtualByName.has(name) && typeof built.virtualPerson === 'function') {
    return virtualFor(built, built.virtualByName.get(name));
  }
  const key = nameKey(name);
  const hits = built.persons.filter((person) => nameKey(person.name) === key);
  return hits.length === 1 ? hits[0] : null;
}

// '@名前 語…' を人と絞りの語に割る (検索の一覧から作者頁へ移ると、打っていた語が後ろに付く)。
// 名前は空白を含みうるので、長い方から切って人が定まった所で割る ('@名 前' の人が居れば '名 前' が名前)
function splitAuthorQuery(built, query) {
  const text = String(query || '').trim();
  if (!text.startsWith('@')) return { person: null, words: '' };
  const rest = text.slice(1).trim();
  if (!rest) return { person: null, words: '' };
  const cuts = [rest.length];
  const gaps = [];
  const space = /\s+/g;
  let found = space.exec(rest);
  while (found) {
    gaps.push(found.index);
    found = space.exec(rest);
  }
  cuts.push(...gaps.reverse());
  for (const cut of cuts) {
    const person = findByQuery(built, `@${rest.slice(0, cut)}`);
    if (person) return { person, words: rest.slice(cut).trim() };
  }
  return { person: null, words: '' };
}

// 作者の頁の控え (一覧を組み直すまで使い回す)
function virtualFor(built, artist) {
  if (!built.virtualCache) built.virtualCache = new Map();
  if (!built.virtualCache.has(artist)) built.virtualCache.set(artist, built.virtualPerson(artist));
  return built.virtualCache.get(artist);
}

// id から人 (一覧の見出しか、見出しを持たない作者の頁)
function personById(built, id) {
  const key = String(id || '');
  if (built.byId.has(key)) return built.byId.get(key);
  const parsed = parseHomeAuthorId(key);
  if (parsed && parsed.kind === 'hitomi' && typeof built.virtualPerson === 'function') return virtualFor(built, parsed.key);
  return null;
}

// ---------------------------------------------------------------------------
// 母屋に据える本体 (材料を集め、控え、作者頁の本と hitomi の網を引き、結びを書く)
// ---------------------------------------------------------------------------

// 所持の hitomi の本を、作者 (artist) とサークル (group) のタグごとに一行ずつ
const OWNED_SQL = `
  SELECT t.type AS kind, t.name AS tag, i.gallery_id AS gid, MAX(COALESCE(i.star, 0)) AS star, MAX(i.added_at) AS addedAt,
         g.published_date AS published, g.added_date AS added, g.title AS title, g.page_count AS pages, g.language AS lang
  FROM items i
  JOIN gallery_tags t ON t.gallery_id = i.gallery_id AND t.type IN ('artist', 'group')
  LEFT JOIN galleries g ON g.id = i.gallery_id
  WHERE i.gallery_id IS NOT NULL AND i.gallery_id <> ''
  GROUP BY t.type, t.name, i.gallery_id`;

// 台帳の Eagle の項目のうち Eagle のタグのある物 (Eagle のタグの道)。照合済みなら照合先の素性も添える
const EAGLE_TAG_SQL = `
  SELECT i.path AS path, i.gallery_id AS gid, i.eagle_tags AS tags, i.star AS star, i.added_at AS addedAt, i.title AS itemTitle,
         g.title AS title, g.page_count AS pages, g.language AS lang, g.published_date AS published, g.added_date AS added
  FROM items i
  LEFT JOIN galleries g ON g.id = i.gallery_id
  WHERE i.source = 'eagle' AND i.eagle_tags IS NOT NULL AND i.eagle_tags <> '' AND i.eagle_tags <> '[]'`;

// 台帳で照合先のある Eagle の項目 (作者フォルダの本と所持の hitomi の本の重なりを畳む)。
// 紐付けた行は path が …/<id>.info#<gid> の形で一つの項目に何行か在りうる
const EAGLE_LINK_SQL = `
  SELECT i.path AS path, i.gallery_id AS gid
  FROM items i
  WHERE i.source = 'eagle' AND i.gallery_id IS NOT NULL AND i.gallery_id <> ''`;

// 作品の検索の材料 (最初に語で引かれた時に一度だけ): 所持の hitomi の本の素性とタグ
const FIND_GALLERY_SQL = `
  SELECT g.id AS gid, g.title AS title, g.language AS lang, g.type AS type
  FROM galleries g
  WHERE g.id IN (SELECT gallery_id FROM items WHERE gallery_id IS NOT NULL AND gallery_id <> '')`;
const FIND_TAG_SQL = `
  SELECT t.gallery_id AS gid, t.type AS type, t.name AS name
  FROM gallery_tags t
  WHERE t.gallery_id IN (SELECT gallery_id FROM items WHERE gallery_id IS NOT NULL AND gallery_id <> '')`;

function eagleLinkRows(rows) {
  const out = [];
  for (const row of rows || []) {
    const eagleId = eagleIdOfPath(row && row.path);
    if (eagleId && row.gid != null && row.gid !== '') out.push({ eagleId, gid: row.gid });
  }
  return out;
}

// EAGLE_TAG_SQL の行を buildHome の eagleRows の形へ (タグは JSON の文字列で入っている)
function eagleTagRows(rows) {
  const out = [];
  for (const row of rows || []) {
    const eagleId = eagleIdOfPath(row && row.path);
    if (!eagleId) continue;
    let tags = [];
    try {
      tags = JSON.parse(String(row.tags || '[]'));
    } catch {
      tags = [];
    }
    tags = (Array.isArray(tags) ? tags : []).map(String).filter(Boolean);
    if (!tags.length) continue;
    out.push({
      eagleId,
      gid: row.gid != null && row.gid !== '' ? row.gid : null,
      tags,
      star: row.star,
      addedAt: row.addedAt,
      itemTitle: row.itemTitle,
      title: row.title,
      pages: row.pages,
      lang: row.lang,
      published: row.published,
      added: row.added,
    });
  }
  return out;
}

class HomeAuthors {
  // deps:
  //   catalog          台帳 (queryRows / lookupTagLabel / getGalleryMetaBatch / annotate / isOwned / unmatchedGen)
  //   pawLibrary       作者根の所持 (ready / snapshot / creatorFolders / toGallery)
  //   pawLinks         Pawchive の結び (creatorBindings / setCreator / flush)
  //   creatorLinks     hitomi / nhentai の結び (CreatorLinks)
  //   releaseDates     名前に日付の無い本の公開日の控え (ReleaseDates。get / version)
  //   reading          栞 (summary)
  //   getPixivLibrary  () => PixivLibrary | null
  //   getDiscovery     () => Discovery | null (readCache だけ使う。view は表示台帳を書くので呼ばない)
  //   searchHitomi     (payload) => Promise<{ galleries, total }>  (sources.search を hitomi で)
  //   folderTreeFile   () => 作者根の目録 (<library>/metadata.json) の道。組み直しの合図に stat だけ見る
  //   eagleEntries     () => Map ('<Eagle の id>.info' → { meta: { name, tags, annotation } }) 走査の控え (作品の検索の当て先)
  //   rewriteQuery     (語) => { query, resolved } 別名の書き換え (無ければ search-aliases の物)
  //   readOnly         写しなら true (結びの口を出さない)
  constructor(deps = {}) {
    this.deps = deps;
    this.now = deps.now || Date.now;
    this.cache = null;
    this.building = null;
    this.scheduled = null;
    this.dirty = 0;
    this.web = new Map();
    this.stampMemo = new Map();
    this.listMemo = null;
  }

  pixiv() {
    try {
      return typeof this.deps.getPixivLibrary === 'function' ? this.deps.getPixivLibrary() : null;
    } catch {
      return null;
    }
  }

  // 走査・結びの変化などで材料が動いた (次に引かれた時に裏で組み直す)
  invalidate() {
    this.dirty += 1;
  }

  fileStamp(file) {
    if (!file) return '';
    const now = this.now();
    const memo = this.stampMemo.get(file);
    if (memo && now - memo.at < STAMP_MEMO_MS) return memo.value;
    let value = '';
    try {
      const stat = fs.statSync(file);
      value = `${stat.size}:${stat.mtimeMs}`;
    } catch {
      value = '';
    }
    this.stampMemo.set(file, { at: now, value });
    return value;
  }

  pawSnapshot() {
    try {
      return this.deps.pawLibrary ? this.deps.pawLibrary.snapshot() : null;
    } catch {
      return null;
    }
  }

  // 材料の目印。どれかが動いたら組み直す (どれも安い: 数と小さな結びの表と stat の控え)
  signature() {
    const { catalog, pawLinks, creatorLinks } = this.deps;
    const snap = this.pawSnapshot();
    const pixiv = this.pixiv();
    let pixivPart = '-';
    try {
      if (pixiv) pixivPart = `${JSON.stringify(pixiv.creatorBindings())}|${JSON.stringify(pixiv.stats())}`;
    } catch {
      pixivPart = '-';
    }
    let pawPart = '-';
    try {
      if (pawLinks) pawPart = JSON.stringify(pawLinks.creatorBindings());
    } catch {
      pawPart = '-';
    }
    let discoveryFile = '';
    try {
      const discovery = typeof this.deps.getDiscovery === 'function' ? this.deps.getDiscovery() : null;
      discoveryFile = discovery ? discovery.cachePath || '' : '';
    } catch {
      discoveryFile = '';
    }
    let treeFile = '';
    try {
      treeFile = typeof this.deps.folderTreeFile === 'function' ? this.deps.folderTreeFile() || '' : '';
    } catch {
      treeFile = '';
    }
    return [
      snap ? `${snap.root}|${snap.folderId}|${snap.stamp}|${(snap.items || []).length}` : '-',
      this.fileStamp(treeFile),
      catalog ? `${catalog.unmatchedGen || 0}|${catalog.idSet ? catalog.idSet.size : 0}|${catalog.db ? 1 : 0}` : '-',
      pixivPart,
      pawPart,
      creatorLinks ? creatorLinks.version() : 0,
      this.releaseDatesVersion(),
      this.fileStamp(discoveryFile),
      this.dirty,
    ].join('#');
  }

  // 組む材料を集める。重いのは台帳の SQL (同期) と作者根の目録の読み
  gather(snap) {
    const { catalog, pawLibrary, pawLinks, creatorLinks } = this.deps;
    let folders = [];
    let pawItems = [];
    if (snap && pawLibrary) {
      try {
        folders = pawLibrary.creatorFolders();
      } catch {
        folders = [];
      }
      pawItems = (snap.items || []).filter((item) => item && item.creatorFolderId);
    }
    const pixiv = this.pixiv();
    let hitomiRows = [];
    try {
      hitomiRows = catalog && typeof catalog.queryRows === 'function' ? catalog.queryRows(OWNED_SQL) : [];
    } catch {
      hitomiRows = [];
    }
    let eagleRows = [];
    try {
      eagleRows = catalog && typeof catalog.queryRows === 'function' ? eagleTagRows(catalog.queryRows(EAGLE_TAG_SQL)) : [];
    } catch {
      eagleRows = [];
    }
    let eagleLinks = [];
    try {
      eagleLinks = catalog && typeof catalog.queryRows === 'function' ? eagleLinkRows(catalog.queryRows(EAGLE_LINK_SQL)) : [];
    } catch {
      eagleLinks = [];
    }
    const labels = new Map();
    const lookup = (type, name) => {
      const key = `${type}:${name}`;
      if (!labels.has(key)) {
        let label = '';
        try {
          label = catalog && typeof catalog.lookupTagLabel === 'function' ? catalog.lookupTagLabel(type, name) || '' : '';
        } catch {
          label = '';
        }
        labels.set(key, label);
      }
      return labels.get(key);
    };
    const labelOf = (artist) => lookup('artist', artist);
    const groupLabelOf = (group) => lookup('group', group);
    // 発見の控え (読むだけ): よく集めている hitomi の作者と、その新作
    const followed = new Set();
    const newByArtist = new Map();
    const newIdsByArtist = new Map();
    try {
      const discovery = typeof this.deps.getDiscovery === 'function' ? this.deps.getDiscovery() : null;
      const cached = discovery && typeof discovery.readCache === 'function' ? discovery.readCache() : null;
      for (const row of (cached && cached.followed) || []) if (row && row.artist) followed.add(String(row.artist));
      for (const release of (cached && cached.newReleases) || []) {
        if (!release) continue;
        // 巡回の後で落とした物は新作ではない
        if (catalog && typeof catalog.isOwned === 'function' && catalog.isOwned(release.id, release.title)) continue;
        const names = new Set((release.artists || []).map((tag) => String(tag && tag.name || '')).filter(Boolean));
        if (release.reason && release.reason.artist) names.add(String(release.reason.artist));
        for (const name of names) {
          newByArtist.set(name, (newByArtist.get(name) || 0) + 1);
          if (release.id == null) continue;
          if (!newIdsByArtist.has(name)) newIdsByArtist.set(name, new Set());
          newIdsByArtist.get(name).add(String(release.id));
        }
      }
    } catch {
      // 発見の控えが読めなくても一覧は組める
    }
    let linked = [];
    let rejected = new Set();
    let ratings = {};
    let suggestions = [];
    let origins = {};
    let names = {};
    let covers = {};
    try {
      if (creatorLinks) {
        linked = creatorLinks.linked();
        rejected = creatorLinks.rejectedKeys();
        ratings = typeof creatorLinks.ratingsMap === 'function' ? creatorLinks.ratingsMap() : {};
        suggestions = typeof creatorLinks.suggestions === 'function' ? creatorLinks.suggestions() : [];
        origins = typeof creatorLinks.originsMap === 'function' ? creatorLinks.originsMap() : {};
        names = typeof creatorLinks.namesMap === 'function' ? creatorLinks.namesMap() : {};
        covers = typeof creatorLinks.coversMap === 'function' ? creatorLinks.coversMap() : {};
      }
    } catch {
      linked = [];
      rejected = new Set();
      ratings = {};
      suggestions = [];
      origins = {};
      names = {};
      covers = {};
    }
    let pixivCreators = {};
    try {
      pixivCreators = pixiv ? pixiv.creatorBindings() || {} : {};
    } catch {
      pixivCreators = {};
    }
    let pawCreators = {};
    try {
      pawCreators = pawLinks ? pawLinks.creatorBindings() || {} : {};
    } catch {
      pawCreators = {};
    }
    return {
      folders,
      pawItems,
      pixivWork: (pid) => {
        try {
          return pixiv ? pixiv.get(pid) : null;
        } catch {
          return null;
        }
      },
      pixivCreators,
      pawCreators,
      links: linked,
      rejected,
      ratings,
      suggestions,
      origins,
      names,
      covers,
      hitomiRows,
      eagleRows,
      eagleLinks,
      labelOf,
      groupLabelOf,
      followed,
      newByArtist,
      newIdsByArtist,
      releaseDateOf: (eagleId) => {
        try {
          return this.deps.releaseDates ? this.deps.releaseDates.get(eagleId) : null;
        } catch {
          return null;
        }
      },
    };
  }

  releaseDatesVersion() {
    try {
      return this.deps.releaseDates ? this.deps.releaseDates.version() : 0;
    } catch {
      return 0;
    }
  }

  // 組み直し (同時に一本)。作者根が読めない時は作者フォルダ無しで組み、読めるようになったら目印が変わって組み直る
  rebuild() {
    if (this.building) return this.building;
    this.building = (async () => {
      const { pawLibrary } = this.deps;
      if (pawLibrary && typeof pawLibrary.ready === 'function') {
        try {
          await pawLibrary.ready();
        } catch {
          // Eagle の置き場が見えない: hitomi の作者だけで組む
        }
      }
      const signature = this.signature();
      const built = buildHome(this.gather(this.pawSnapshot()));
      this.cache = { ...built, signature, at: this.now() };
      if (this.findUsed) this.warmFind(this.cache);
      return this.cache;
    })().finally(() => {
      this.building = null;
    });
    return this.building;
  }

  scheduleRebuild() {
    if (this.scheduled || this.building) return;
    this.scheduled = setTimeout(() => {
      this.scheduled = null;
      this.rebuild().catch(() => {});
    }, 0);
    if (this.scheduled && typeof this.scheduled.unref === 'function') this.scheduled.unref();
  }

  // 控えを返す。初回だけは組み上がりを待つ。材料が動いていれば今回は前の控えで答え、裏で組み直す
  async ensure() {
    if (!this.cache) return this.building || this.rebuild();
    if (!this.building && this.signature() !== this.cache.signature) this.scheduleRebuild();
    return this.cache;
  }

  // 起動の後で先に組んでおく (最初に Home を開いた時に待たせない)
  warm() {
    return this.ensure().then(() => true, () => false);
  }

  // タグの日本語の札 (台帳の tag_labels)。作品の検索の語と当て先の両方が引く
  labelOf(type, name) {
    const { catalog } = this.deps;
    try {
      return catalog && typeof catalog.lookupTagLabel === 'function' ? catalog.lookupTagLabel(type, name) || '' : '';
    } catch {
      return '';
    }
  }

  // 語を条件の並びへ (別名の書き換えと札を差す)
  parseFind(query) {
    let rewrite = this.deps.rewriteQuery;
    if (typeof rewrite !== 'function') {
      try {
        rewrite = require('./search-aliases').rewriteQuery;
      } catch {
        rewrite = null;
      }
    }
    return parseFind(query, { rewrite, labelOf: (type, name) => this.labelOf(type, name) });
  }

  // 作品の検索の材料 (台帳の hitomi の本の素性とタグ・Eagle の照合・走査の控え・pixiv の台帳)。
  // 重いのは台帳の SQL (所持の本のタグ 4 万行ほどで 40ms 台)。控え (組み直し) ごとに一度、最初の語で集める
  findMaterials() {
    const { catalog } = this.deps;
    const rows = (sql) => {
      try {
        return catalog && typeof catalog.queryRows === 'function' ? catalog.queryRows(sql) : [];
      } catch {
        return [];
      }
    };
    const galleries = new Map();
    for (const row of rows(FIND_GALLERY_SQL)) {
      galleries.set(String(row.gid), {
        title: String(row.title || ''), lang: String(row.lang || '').toLowerCase(), type: String(row.type || '').toLowerCase(), tags: [],
      });
    }
    for (const row of rows(FIND_TAG_SQL)) {
      const gallery = galleries.get(String(row.gid));
      if (gallery && row.type && row.name) gallery.tags.push([String(row.type), String(row.name)]);
    }
    const eaglesOfGid = new Map();
    const gidsOfEagle = new Map();
    for (const link of eagleLinkRows(rows(EAGLE_LINK_SQL))) {
      const gid = String(link.gid);
      if (!eaglesOfGid.has(gid)) eaglesOfGid.set(gid, []);
      eaglesOfGid.get(gid).push(link.eagleId);
      if (!gidsOfEagle.has(link.eagleId)) gidsOfEagle.set(link.eagleId, []);
      gidsOfEagle.get(link.eagleId).push(gid);
    }
    let itemTags = new Map();
    try {
      itemTags = catalog && typeof catalog.eagleItemTagMap === 'function' ? catalog.eagleItemTagMap() || new Map() : new Map();
    } catch {
      itemTags = new Map();
    }
    let entries = null;
    try {
      entries = typeof this.deps.eagleEntries === 'function' ? this.deps.eagleEntries() : null;
    } catch {
      entries = null;
    }
    const pixiv = this.pixiv();
    const labels = new Map();
    return {
      galleries,
      eaglesOfGid,
      gidsOfEagle,
      itemTags,
      eagleMeta: (eagleId) => {
        const hit = entries && typeof entries.get === 'function' ? entries.get(`${eagleId}.info`) : null;
        return hit && hit.meta ? hit.meta : null;
      },
      pixivWork: (pid) => (pixiv ? pixiv.get(pid) : null),
      norm: findMemo(),
      tagKey: (() => {
        const keys = new Map();
        return (value) => {
          const raw = String(value == null ? '' : value);
          if (!keys.has(raw)) keys.set(raw, tagNameKey(raw));
          return keys.get(raw);
        };
      })(),
      labelOf: (type, name) => {
        const key = `${type}\u0000${name}`;
        if (!labels.has(key)) labels.set(key, this.labelOf(type, name));
        return labels.get(key);
      },
    };
  }

  // 作品の検索の当て先と検索欄の候補の材料を裏で少しずつ先に組む (組み直しの後、最初の語で待たせない)。
  // この会で一度でも語で引かれた後だけ (Home で検索しない人に組ませない)。組み直されたら止める
  warmFind(built) {
    if (!built || built.findWarming) return;
    built.findWarming = true;
    const findOf = this.findSource(built);
    const books = [];
    for (const person of built.persons || []) for (const book of person.books || []) books.push(book);
    let index = 0;
    const step = () => {
      if (this.cache !== built) return;
      const end = Math.min(books.length, index + FIND_WARM_CHUNK);
      for (; index < end; index += 1) findOf(books[index]);
      if (index < books.length) {
        const next = setImmediate(step);
        if (next && typeof next.unref === 'function') next.unref();
        return;
      }
      // 当て先が揃ったら検索欄の候補の材料も (当て先を借りるので 20ms ほど)
      this.findVocabulary(built);
    };
    const delay = Number.isFinite(this.deps.findWarmDelayMs) ? this.deps.findWarmDelayMs : FIND_WARM_DELAY_MS;
    const timer = setTimeout(step, delay);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  // 本 → 当て先。控え (組み直し) ごとに一つ。当て先は本ごとに一度だけ組んで覚える (画面へは渡さない)
  findSource(built) {
    if (!built) return () => null;
    if (built.findOf) return built.findOf;
    let materials = null;
    const memo = new WeakMap();
    built.findMaterialsOf = () => {
      if (!materials) materials = this.findMaterials();
      return materials;
    };
    built.findOf = (book) => {
      if (!book) return null;
      let find = memo.get(book);
      if (!find) {
        find = bookFind(book, built.findMaterialsOf());
        memo.set(book, find);
      }
      return find;
    };
    return built.findOf;
  }

  // 検索欄の候補の材料 (控えごとに一度): 所持の本に付いているタグと、それを持つ所持の本の数。
  //   型付きのタグ (hitomi の gallery_tags・未照合の項目の詳細タグ) は日本語の札と一緒に
  //   型の無いタグ (Eagle のタグ・pixiv の台帳のタグ) は元の字のまま。型付きのタグの日本語の札と同じ字なら、そちらに畳む
  // 数は本 (id) ごとに一度。当て先の組み立て (findSource) を借りるので、組み上がっていれば数 ms
  findVocabulary(built) {
    if (!built) return [];
    if (built.findVocab) return built.findVocab;
    const findOf = this.findSource(built);
    const materials = built.findMaterialsOf();
    // 数えるのは確かな所持の本だけ (候補の本は見出しの冊数にも数えない)
    const books = new Map();
    for (const person of built.persons || []) {
      for (const book of person.books || []) if (!book.candidate && !books.has(String(book.id))) books.set(String(book.id), book);
    }
    const typed = new Map();
    for (const book of books.values()) {
      for (const key of findOf(book).tagKeys) {
        if (typed.has(key)) continue;
        const cut = key.indexOf(' ');
        const type = key.slice(0, cut);
        const name = key.slice(cut + 1);
        typed.set(key, { type, name, label: materials.labelOf(type, name) || '', value: `${type}:${name.replace(/ /g, '_')}`, count: 0 });
      }
    }
    const byLabel = new Map();
    for (const entry of typed.values()) {
      const key = entry.label ? findText(entry.label) : '';
      if (key && !byLabel.has(key)) byLabel.set(key, entry);
    }
    const plain = new Map();
    for (const book of books.values()) {
      const find = findOf(book);
      const hit = new Set();
      for (const key of find.tagKeys) hit.add(typed.get(key));
      for (const raw of find.own || []) {
        const key = materials.norm(raw);
        if (!key) continue;
        let entry = byLabel.get(key) || plain.get(key);
        if (!entry) {
          const label = String(raw).trim();
          // 空白・頭の - ・型のような : を含む字は括って送る (語の読み方で一語の自由語のまま)
          const value = /[\s:"]|^-/.test(label) ? `"${label.replace(/"/g, '')}"` : label;
          entry = { type: 'tag', name: label, label, value, own: true, count: 0 };
          plain.set(key, entry);
        }
        hit.add(entry);
      }
      for (const entry of hit) if (entry) entry.count += 1;
    }
    const list = [...typed.values(), ...plain.values()].filter((entry) => entry.count > 0);
    for (const entry of list) entry.keys = [...new Set([entry.label, entry.name].filter(Boolean).map(findText).filter(Boolean))];
    built.findVocab = list.sort((a, b) => b.count - a.count);
    return built.findVocab;
  }

  // 検索欄の候補 (source: 'home' の suggest の口)。打った語 (頭の - は外して渡す) を含むタグを、
  // 前方一致 → 所持の冊数の多い順で。'female:…' のように型を付けて打てば、その型のタグだけ。
  // 辞書 (読み・ローマ字・別名) で当たった hitomi の語も、所持の本に在る物だけ足す (冊数 0 は出さない)。
  // 返りは本体の候補と同じ形 (normalizeSuggestions)。件数は所持の本の冊数 (metric.scope 'owned')
  async suggestWords(term) {
    const built = await this.ensure();
    let text = String(term || '').trim().replace(/^-/, '');
    if (!text) return [];
    let type = '';
    const prefixed = text.match(/^([^:\s]+):(.*)$/);
    if (prefixed) {
      const parsed = parseTypePrefix(`${prefixed[1]}:x`);
      if (parsed) {
        type = parsed.type;
        text = prefixed[2];
      }
    }
    const needle = findText(text);
    const vocab = this.findVocabulary(built);
    const scored = new Map();
    for (const entry of vocab) {
      if (type && (entry.own || !(entry.type === type || (type === 'either' && (entry.type === 'female' || entry.type === 'male'))))) continue;
      if (!needle) {
        if (type) scored.set(entry, 2);
        continue;
      }
      let score = -1;
      for (const key of entry.keys) {
        if (key.startsWith(needle)) {
          score = 0;
          break;
        }
        if (key.includes(needle)) score = 1;
      }
      if (score >= 0) scored.set(entry, score);
    }
    // 読み・ローマ字・別名で当たる辞書の語 (hitomi で引ける物) を、所持に在るタグへ結ぶ
    if (text && [...text].length >= 1) {
      let rows = [];
      try {
        rows = require('./search-decorate').fromDictionary(text, 'hitomi', SUGGEST_MAX);
      } catch {
        rows = [];
      }
      const byKey = new Map(vocab.filter((entry) => !entry.own).map((entry) => [`${entry.type} ${entry.name}`, entry]));
      for (const row of rows) {
        const parsed = parseTypePrefix(String(row && row.value || ''));
        if (!parsed || parsed.negative) continue;
        const entry = byKey.get(`${parsed.type} ${tagNameKey(parsed.name)}`);
        if (!entry || (type && type !== 'either' && entry.type !== type)) continue;
        if (!scored.has(entry) || scored.get(entry) > 0.5) scored.set(entry, Math.min(scored.get(entry) ?? 0.5, 0.5));
      }
    }
    const picked = [...scored.entries()]
      .sort((a, b) => a[1] - b[1] || b[0].count - a[0].count)
      .slice(0, SUGGEST_MAX)
      .map(([entry]) => entry);
    const decorate = require('./search-decorate');
    const items = picked.map((entry) => {
      const metric = { site: 'home', kind: 'works', value: entry.count, scope: 'owned' };
      if (entry.own) return { type: 'tag', name: entry.name, label: entry.label, value: entry.value, secondary: 'Eagle', metric };
      const row = decorate.decorate({ type: entry.type, name: entry.name, label: entry.label || prettyTag(entry.name), metric }, 'home');
      return { ...row, value: entry.value };
    });
    return require('./search-intent').normalizeSuggestions(items, 'home');
  }

  // search の口 (source: 'home')。@名前 は作者頁: 一覧は空で、作者と所持の本を homeAuthor に添えて返す
  // (画面は一覧の差し替えと同じ一巡で作者頁を並べる。間に空の棚を挟まない)。
  // '@名前 語' は語に当たる本で作者頁を絞る (一覧の検索から作者頁へ移った時)。
  // 語だけの時は作品の題・タグ・注釈と作者の名に当て、当たった本のある人を残す
  async search(payload = {}) {
    const built = await this.ensure();
    const size = Math.max(1, Math.min(60, Number(payload.pageSize) || 24));
    const index = Math.max(0, Number(payload.page) || 0);
    const span = Math.max(1, Math.min(60, Math.floor(Number(payload.spanPages)) || 1));
    const query = String(payload.query || '').trim();
    if (query.startsWith('@')) {
      const { person, words } = splitAuthorQuery(built, query);
      const homeAuthor = person ? this.authorPayload(person, { built, words }) : null;
      const filter = homeAuthor && homeAuthor.filter;
      return {
        total: person ? (filter ? filter.count : person.count) : 0, page: index, pageSize: size, spanPages: span, hasNext: false,
        query, interpreted: filter ? filter.interpreted : [], galleries: [], homeAuthor,
      };
    }
    const sort = HOME_SORTS.includes(String(payload.sort || '')) ? String(payload.sort) : 'activity';
    const reads = { marks: {}, creators: {} };
    if (sort === 'read') {
      const reading = this.deps.reading;
      try {
        reads.marks = reading && typeof reading.summary === 'function' ? (reading.summary() || {}) : {};
        reads.creators = reading && typeof reading.creatorReads === 'function' ? (reading.creatorReads() || {}) : {};
      } catch {
        reads.marks = {};
        reads.creators = {};
      }
    }
    // 追い読み (2 頁目から) は 1 頁目と同じ並びから切る。間に裏で組み直すと並びが動き、
    // 同じ人が二枚出て別の人が抜ける (2026-09-24、一覧に同じ作者が二人居た)
    // 判定できなかった作者だけ (設定 homeUnresolvedOnly。画面が旗で渡す)
    const unresolvedOnly = payload.unresolvedOnly === true;
    const listKey = JSON.stringify([query, sort, payload.sortDir === 'asc', unresolvedOnly]);
    let memo;
    if (index > 0 && this.listMemo && this.listMemo.key === listKey) {
      memo = this.listMemo;
    } else {
      const find = query ? this.parseFind(query) : { terms: [], interpreted: [] };
      if (find.terms.length) this.findUsed = true;
      const hits = new Map();
      let list = sortPersons(filterPersons(built.persons, {
        terms: find.terms, findOf: this.findSource(built), unresolvedOnly, hits,
      }), sort, reads);
      if (payload.sortDir === 'asc') list = list.reverse();
      memo = { key: listKey, list, hits: find.terms.length ? hits : null, interpreted: find.interpreted };
      this.listMemo = memo;
    }
    const { list } = memo;
    const start = index * size;
    const end = start + size * span;
    // 一覧の頭: 最近の動きの帯。一頁目の、語の無い時だけ。
    // 同じ返りに載せる (後から引くと帯が一覧を押し下げる)
    const readOnly = this.deps.readOnly === true;
    const card = (person) => authorCard(person, { readOnly });
    const overview = index === 0 && !query && !unresolvedOnly ? {
      moving: movingOf(built.persons, this.now()).map(card),
    } : null;
    return {
      total: list.length,
      page: index,
      pageSize: size,
      spanPages: span,
      hasNext: end < list.length,
      approximate: false,
      query,
      interpreted: memo.interpreted || [],
      galleries: list.slice(start, end).map((person) => authorCard(person, { readOnly, match: memo.hits ? memo.hits.get(person) || null : null })),
      overview,
    };
  }

  // gallery の口 (home: の id)。一覧から外れた見出しの詳細を開き直す時用
  async gallery(id) {
    const built = await this.ensure();
    const person = personById(built, id);
    return person ? authorCard(person, { readOnly: this.deps.readOnly === true }) : null;
  }

  // 作者頁: 人と所持の本 (本体の札と同じ gallery の形)。{ id } か { query: '@名前 [語]' } で引く
  async author(request = {}) {
    const built = await this.ensure();
    let person = null;
    let words = '';
    if (request.id) person = personById(built, request.id);
    else ({ person, words } = splitAuthorQuery(built, request.query));
    if (!person) return { author: null, books: [], handles: 0 };
    return this.authorPayload(person, { built, words });
  }

  // 作者頁の一式: 見出し・所持の本・hitomi の名乗りの数 (網の作品を引くかの目印)。
  // 語がある時は filter に当たった所持の本の id を添える (本の並びそのものは絞らない: 画面の控えを語ごとに分けない)
  authorPayload(person, { built = this.cache, words = '' } = {}) {
    const text = String(words || '').trim();
    const find = text ? this.parseFind(text) : null;
    let filter = null;
    let options;
    if (find && find.terms.length) {
      const findOf = this.findSource(built);
      const personHits = find.terms.map((term) => personHit(term, person));
      filter = { words: text, interpreted: find.interpreted, hits: [], count: 0 };
      options = { pass: (book) => termsPass(find.terms, personHits, findOf(book)), hits: filter.hits };
    }
    const books = this.bookGalleries(person, options);
    if (filter) {
      const hit = new Set(filter.hits);
      filter.count = books.filter((row) => hit.has(String(row.id)) && !row.candidate).length;
    }
    return {
      author: authorCard(person, { readOnly: this.deps.readOnly === true }),
      books,
      handles: person.handles.length,
      // 発見の新作の hitomi の id (作者頁の年ごとの「新」の印)
      newIds: [...(person.newIds || [])].slice(0, NEW_IDS_MAX),
      filter,
    };
  }

  // 所持の本を本体の札の形へ。作者フォルダの本は作者根の項目から、hitomi の本は台帳のメタから。
  // options.pass (本 → 真偽) を渡すと、通った本の札の id を options.hits に積む (作品の検索で作者頁を絞る)
  bookGalleries(person, options = {}) {
    const { catalog, pawLibrary } = this.deps;
    const pixiv = this.pixiv();
    // 所持の本は言語で伏せない (照合先が翻訳版の本も、利用者の Eagle に在る本)
    const books = person.books;
    const hitomiIds = books.filter((book) => book.ref.type === 'hitomi').map((book) => book.ref.gid);
    let metas = new Map();
    try {
      metas = hitomiIds.length && catalog && typeof catalog.getGalleryMetaBatch === 'function'
        ? catalog.getGalleryMetaBatch(hitomiIds) : new Map();
    } catch {
      metas = new Map();
    }
    // 最後に読んだ時 (栞の updatedAt の一番新しい物)。★の高い本をしばらく読んでいない物から選ぶのに使う
    let marks = {};
    try {
      marks = this.deps.reading && typeof this.deps.reading.summary === 'function' ? (this.deps.reading.summary() || {}) : {};
    } catch {
      marks = {};
    }
    const readAtOf = (book) => (book.readKeys || []).reduce((max, key) => Math.max(max, Number(marks[key] && marks[key].updatedAt) || 0), 0);
    const raw = [];
    for (const book of books) {
      let gallery = null;
      if (book.ref.type === 'hitomi') {
        gallery = metas.get(Number(book.ref.gid)) || null;
      } else if (book.ref.type === 'eagle') {
        // Eagle のタグで寄せた未照合の本: 本体の未照合の疑似ギャラリー (pweagle:) をそのまま借りる
        try {
          gallery = catalog && typeof catalog.eagleItemGallery === 'function' ? catalog.eagleItemGallery(book.ref.eagleId) : null;
        } catch {
          gallery = null;
        }
      } else if (pawLibrary && typeof pawLibrary.toGallery === 'function') {
        try {
          gallery = pawLibrary.toGallery(book.ref.item);
          if (book.ref.pid && pixiv && pixiv.has(book.ref.pid)) {
            // pixiv の台帳の素性 (投稿日・頁数・タグ) を被せる。星と Eagle の項目は作者根の物
            gallery = { ...pixiv.toGallery(book.ref.pid), star: gallery.star, eagleId: gallery.eagleId, sourceId: gallery.sourceId };
          }
        } catch {
          gallery = null;
        }
      }
      if (gallery) raw.push({ book, gallery });
    }
    // hitomi の本は台帳の照合で 済・星・Eagle の項目を当てる (作者根の本は自前で確定している)
    let annotated = raw.map((row) => row.gallery);
    try {
      if (catalog && typeof catalog.annotate === 'function') annotated = catalog.annotate(annotated);
    } catch {
      annotated = raw.map((row) => row.gallery);
    }
    return raw.map((row, index) => {
      // 作者根と pixiv の台帳の本 (eagleItem) は Eagle の項目そのもの: 所持は ID で確か。
      // idOwned が無いと画面は「題だけの済」と読み、所持を隠す表示で伏せられない
      let gallery = annotated[index] && annotated[index].kind === 'eagleItem'
        ? { ...annotated[index], idOwned: true } : annotated[index];
      // 名前に頁数の無い本は、数えて控えた頁数 (無ければ画面が pages の口で数えさせる)
      if (gallery && gallery.kind === 'eagleItem' && !(Number(gallery.pageCount) > 1)) {
        const pages = this.cachedPages(gallery, row.book);
        if (pages > 1) gallery = { ...gallery, pageCount: pages };
      }
      // 名前に日付の無い所持の本は、年表に置いた日付を詳細の「日付」にも出す (軸と詳細を食い違わせない)。
      // 小分けのフォルダの年月から置いた本は月までしか分からないので出さない (1 日と書くと日付を知っているように見える)
      if (gallery && gallery.kind === 'eagleItem' && !gallery.publishedDate && row.book.date && !row.book.folderMonth) {
        gallery = { ...gallery, publishedDate: row.book.date };
      }
      if (options && typeof options.pass === 'function' && Array.isArray(options.hits) && options.pass(row.book)) {
        options.hits.push(String(gallery.id));
      }
      return {
        id: String(gallery.id),
        origin: row.book.origin,
        candidate: row.book.candidate,
        date: row.book.date,
        // 網で見つけた推定の日付 (画面は「頃」を添える) と、その出どころ
        dateGuess: row.book.dateGuess === true,
        dateBasis: String(row.book.dateBasis || ''),
        event: eventInfo(row.book.event),
        readAt: readAtOf(row.book),
        gallery,
      };
    });
  }

  pageCounts() {
    try {
      return typeof this.deps.getPageCounts === 'function' ? this.deps.getPageCounts() : null;
    } catch {
      return null;
    }
  }

  cachedPages(gallery, book) {
    const counts = this.pageCounts();
    const eagleId = String(gallery && gallery.eagleId || '');
    if (!counts || !eagleId) return 0;
    const mtime = Number(book && book.ref && book.ref.item && book.ref.item.mtime) || 0;
    return counts.get(eagleId, mtime);
  }

  // 作者頁の所持の本の頁数を数える ({ id: 作者, ids: [本の id] })。控えに無い物だけ綴じ目を読む。
  // 返り: { counts: { 本の id: 頁数 } }
  async pages(request = {}) {
    const counts = this.pageCounts();
    if (!counts) return { counts: {} };
    const built = await this.ensure();
    const person = personById(built, request.id);
    if (!person) return { counts: {} };
    const wanted = new Set((Array.isArray(request.ids) ? request.ids : []).map(String).slice(0, 2000));
    const items = [];
    for (const book of person.books) {
      if (!book.ref || !wanted.has(book.id)) continue;
      if (book.ref.type === 'folder') {
        const eagleId = String(book.ref.item && book.ref.item.eagleId || '');
        if (eagleId) items.push({ id: book.id, eagleId, mtime: Number(book.ref.item.mtime) || 0 });
      } else if (book.ref.type === 'eagle' && book.ref.eagleId) {
        // 台帳の未照合の項目は mtime を持たない: 一度数えた頁数をそのまま使う
        items.push({ id: book.id, eagleId: String(book.ref.eagleId), mtime: 0 });
      }
    }
    const found = await counts.fill(items);
    return { counts: Object.fromEntries(found) };
  }

  // hitomi の artist 一つぶんの日本語の作品 (網)。作者頁を開いた時だけ、artist ごとに控える
  // handle は hitomi の名乗り ({ type, name } か、その値 'artist' / 'group:<名>')
  webFor(handle) {
    return this.webPages('hitomi', typeof handle === 'string' ? handle : handleValue(handle));
  }

  // 源泉の検索の一頁 (本体の検索と同じ道: 控え・同じ語の相乗り)
  webQuery(site, handle, page) {
    const { pageSize } = WEB_LIMITS[site];
    if (site === 'hitomi') {
      const parsed = parseHandleValue(handle);
      return {
        source: 'hitomi', query: `${parsed.type}:${parsed.name.replace(/\s+/g, '_')}`, language: 'japanese', sort: 'added', page, pageSize,
      };
    }
    if (site === 'pawchive') {
      // 名乗りの値は "service:user"。作者の投稿一覧の語は "service/user" (作者の札の query と同じ形)
      const cut = handle.indexOf(':');
      return { source: 'pawchive', query: `${handle.slice(0, cut)}/${handle.slice(cut + 1)}`, sort: 'added', page, pageSize };
    }
    return { source: 'pixiv', query: `user:${handle}`, sort: 'added', page, pageSize };
  }

  // 名乗り一つぶんの網の作品を頁を追って集め、源泉と名乗りごとに控える (作者頁を開き直すたびに網へ出ない)
  webPages(site, handle) {
    const value = String(handle || '').trim();
    const key = `${site}:${value}`;
    const now = this.now();
    const hit = this.web.get(key);
    if (hit && (hit.pending || now - hit.at < WEB_TTL_MS)) return hit.promise;
    const entry = { at: now, pending: true, promise: null };
    entry.promise = (async () => {
      const { pageSize, maxPages } = WEB_LIMITS[site];
      const galleries = [];
      let total = null;
      let more = false;
      for (let page = 0; page < maxPages; page += 1) {
        const result = await this.deps.searchHitomi(this.webQuery(site, value, page));
        const rows = Array.isArray(result && result.galleries) ? result.galleries : [];
        for (const gallery of rows) {
          // pixiv の一頁目の頭には作者の札が乗る (作品ではない)
          if (gallery && !gallery.error && gallery.id != null && gallery.kind !== 'creator') galleries.push(gallery);
        }
        const reported = result ? result.total : null;
        if (page === 0 && typeof reported === 'number' && Number.isFinite(reported) && reported > 0) total = reported;
        // pixiv と pawchive は hasNext で続きを言う (pixiv は AI・ミュートを間引くので頁が埋まらなくても続く)。
        // hitomi-service は hasNext を返さない: 頁の埋まり具合と総数で続きを決める
        const reached = (page + 1) * pageSize;
        const ended = typeof (result && result.hasNext) === 'boolean'
          ? !result.hasNext
          : (rows.length < pageSize || (total != null && reached >= total));
        if (ended) break;
        if (page === maxPages - 1) more = true;
      }
      return { galleries, more };
    })();
    entry.promise.then(() => {
      entry.pending = false;
      entry.at = this.now();
    }, () => {
      if (this.web.get(key) === entry) this.web.delete(key);
    });
    this.web.set(key, entry);
    while (this.web.size > WEB_CACHE_MAX) this.web.delete(this.web.keys().next().value);
    return entry.promise;
  }

  // 網の札に 済 を当てる。台帳 (hitomi 等) → 作者根 (pawchive の投稿 ID と手の結び) → pixiv の台帳 の三段
  // (search の口の annotateAll と同じ順)。作者根と pixiv の台帳の 済 は ID で確かなので idOwned を立てる
  // (台帳の題の一致だけの 済 と見分ける。画面はこれで「同じ投稿の網の写し」を所持の本に重ねる)
  annotateWeb(galleries) {
    const { catalog, pawLibrary } = this.deps;
    let list = galleries;
    try {
      if (catalog && typeof catalog.annotate === 'function') list = catalog.annotate(list);
    } catch {
      list = galleries;
    }
    try {
      if (pawLibrary && typeof pawLibrary.annotateAll === 'function') {
        const marked = pawLibrary.annotateAll(list);
        list = marked.map((gallery, index) => (gallery !== list[index] && gallery && gallery.owned && gallery.eagleId
          ? { ...gallery, idOwned: true } : gallery));
      }
    } catch {
      // 作者根が読めない: 台帳の印だけで出す
    }
    try {
      const pixiv = this.pixiv();
      if (pixiv && typeof pixiv.annotate === 'function') list = pixiv.annotate(list);
    } catch {
      // pixiv の台帳が無い
    }
    return list;
  }

  // 作者頁の網の作品。site ごとに引く (画面は三つを並べて投げ、届いた順に混ぜる)。
  //   hitomi   hitomiWorks (結び済みと候補の名乗り)
  //   pawchive 結び済みの "service:user" の投稿。絵も添付も無い投稿 (文字だけのお知らせ) は本ではないので落とす
  //   pixiv    結び済みの利用者 ID の投稿。ログインしていなければ (写し) 失敗ではなく unavailable
  async webWorks(request = {}) {
    const site = String(request.site || 'hitomi');
    if (site === 'hitomi') return this.hitomiWorks(request);
    if (!WEB_SITES.includes(site)) return { works: [], more: false, error: false };
    const built = await this.ensure();
    const person = personById(built, request.id);
    const handles = person ? person.links[site].filter((link) => link.state === 'linked').map((link) => link.value) : [];
    if (!handles.length || typeof this.deps.searchHitomi !== 'function') return { works: [], more: false, error: false };
    const results = await Promise.all(handles.map((handle) => this.webPages(site, handle)
      .then((value) => ({ value }), (error) => ({ error }))));
    const seen = new Set();
    const rows = [];
    let more = false;
    let failed = false;
    let unavailable = false;
    for (const result of results) {
      if (result.error) {
        const login = result.error.status === 401 || result.error.code === 'pixiv-login';
        if (login) unavailable = true;
        else failed = true;
        continue;
      }
      if (result.value.more) more = true;
      for (const gallery of result.value.galleries) {
        const id = String(gallery.id);
        if (seen.has(id)) continue;
        if (site === 'pawchive' && !(Number(gallery.pageCount) > 0)) continue;
        seen.add(id);
        rows.push(gallery);
      }
    }
    const annotated = this.annotateWeb(rows);
    return {
      works: annotated.map((gallery) => ({
        id: String(gallery.id),
        origin: site,
        candidate: false,
        date: isoDate(gallery.publishedDate) || isoDate(gallery.addedDate),
        event: eventInfo(eventOf(gallery.title)),
        gallery,
      })),
      more,
      error: failed && !rows.length,
      unavailable: unavailable && !rows.length,
    };
  }

  // 作者頁の hitomi の作品 (未所持も)。作者の hitomi の名乗り (結び済みと候補) ごとに引いて束ねる
  async hitomiWorks(request = {}) {
    const built = await this.ensure();
    const person = personById(built, request.id);
    if (!person || !person.handles.length || typeof this.deps.searchHitomi !== 'function') {
      return { works: [], more: false, error: false };
    }
    const results = await Promise.all(person.handles.map((handle) => this.webFor(handle)
      .then((value) => ({ handle, value }), () => ({ handle, failed: true }))));
    const seen = new Set();
    const rows = [];
    let more = false;
    let failed = false;
    for (const result of results) {
      if (result.failed) {
        failed = true;
        continue;
      }
      if (result.value.more) more = true;
      for (const gallery of result.value.galleries) {
        const id = String(gallery.id);
        if (seen.has(id)) continue;
        seen.add(id);
        rows.push({ gallery, candidate: result.handle.candidate });
      }
    }
    const { catalog } = this.deps;
    let annotated = rows.map((row) => row.gallery);
    try {
      if (catalog && typeof catalog.annotate === 'function') annotated = catalog.annotate(annotated);
    } catch {
      annotated = rows.map((row) => row.gallery);
    }
    return {
      works: rows.map((row, index) => ({
        id: String(annotated[index].id),
        origin: 'hitomi',
        candidate: row.candidate,
        date: isoDate(annotated[index].publishedDate) || isoDate(annotated[index].addedDate),
        event: eventInfo(eventOf(annotated[index].title)),
        gallery: annotated[index],
      })),
      more,
      error: failed && !rows.length,
    };
  }

  // 作者頁の網の作品のうち、語に当たる物の id ({ id: 作者, site, words })。作品の検索で作者頁を絞る時に、
  // 源泉ごとに引く。網の頁は webPages の控え (作者頁を開いた時に引いた物) から読むので、普通は網へ出ない。
  // 当て方は所持の本と同じ (題・キャプション・タグと日本語の札、作者の名)。返り: { words, hits: [id] }
  async webHits(request = {}) {
    const words = String(request.words || '').trim();
    const site = String(request.site || 'hitomi');
    const built = await this.ensure();
    const person = personById(built, request.id);
    if (!person || !words || !WEB_SITES.includes(site) || typeof this.deps.searchHitomi !== 'function') return { words, hits: [] };
    const find = this.parseFind(words);
    const handles = site === 'hitomi'
      ? person.handles.map(handleValue)
      : person.links[site].filter((link) => link.state === 'linked').map((link) => link.value);
    const results = await Promise.all(handles.map((handle) => this.webPages(site, handle).catch(() => null)));
    const personHits = find.terms.map((term) => personHit(term, person));
    const labels = new Map();
    const labelOf = (type, name) => {
      const key = `${type}\u0000${name}`;
      if (!labels.has(key)) labels.set(key, this.labelOf(type, name));
      return labels.get(key);
    };
    const norm = findMemo();
    const hits = new Set();
    for (const result of results) {
      for (const gallery of (result && result.galleries) || []) {
        const id = String(gallery.id);
        if (hits.has(id)) continue;
        if (termsPass(find.terms, personHits, galleryFind(gallery, labelOf, norm))) hits.add(id);
      }
    }
    return { words, hits: [...hits] };
  }

  // 詳細の行の結び。op: save (URL を結ぶ) / accept (候補を結ぶ) / reject (候補を「違う」) / unlink (外す)。
  // 書いたら組み直し、新しい見出しを返す
  async link(request = {}) {
    const site = String(request.site || '');
    const op = String(request.op || '');
    if (!SITE_KEYS.includes(site)) return { ok: false, reason: 'site' };
    if (!['save', 'accept', 'reject', 'unlink'].includes(op)) return { ok: false, reason: 'op' };
    const built = await this.ensure();
    const person = built.byId.get(String(request.id || ''));
    if (!person) return { ok: false, reason: 'author' };
    const value = parseSiteUrl(site, request.url);
    if (!value) return { ok: false, reason: 'form' };
    const folder = person.kind === 'folder';
    const { pawLinks, creatorLinks } = this.deps;
    const by = String(request.by || '') || 'Home の詳細';
    // 元に戻す (Ctrl+Z) の手順を作るため、書く前の姿を撮る
    const undo = this.snapshotLink(person, site, value);
    if ((site === 'pixiv' || site === 'pawchive') && !folder) {
      // 作者フォルダの無い人 (hitomi の作者・サークル) の pixiv / Pawchive は creator-links に書く
      if (!creatorLinks) return { ok: false, reason: 'store' };
      const personId = personIdOf(person);
      if (op === 'reject' || op === 'unlink') {
        if (op === 'unlink' && creatorLinks.state(personId, site, value) !== 'linked') return { ok: false, reason: 'missing' };
        creatorLinks.revoke({ personId, source: site, name: value, by });
      } else if (!creatorLinks.link({ personId, source: site, name: value, by, note: String(request.note || '') })) {
        return { ok: false, reason: 'store' };
      }
    } else if ((site === 'pixiv' || site === 'pawchive') && op === 'reject') {
      // 作者フォルダの人の候補 (突き合わせ) を「違う」: 結びの置き場は二つの台帳だが、退けた答えは creator-links に残す
      if (!creatorLinks) return { ok: false, reason: 'store' };
      creatorLinks.revoke({ personId: personIdOf(person), source: site, name: value, by });
    } else if (site === 'pixiv' || site === 'pawchive') {
      if (site === 'pixiv') {
        const pixiv = this.pixiv();
        if (!pixiv) return { ok: false, reason: 'store' };
        if (op === 'unlink') {
          if (typeof pixiv.unbindCreator !== 'function' || !pixiv.unbindCreator(value, person.folderId)) return { ok: false, reason: 'missing' };
        } else if (!pixiv.bindCreator(value, person.folderId, person.folderName || person.name)) {
          return { ok: false, reason: 'store' };
        }
      } else {
        if (!pawLinks) return { ok: false, reason: 'store' };
        const cut = value.indexOf(':');
        const service = value.slice(0, cut);
        const user = value.slice(cut + 1);
        if (op === 'unlink') {
          const current = pawLinks.getCreator ? pawLinks.getCreator(service, user) : null;
          if (String(current || '') !== person.folderId) return { ok: false, reason: 'missing' };
          pawLinks.setCreator(service, user, null);
        } else {
          pawLinks.setCreator(service, user, person.folderId);
        }
        if (typeof pawLinks.flush === 'function') pawLinks.flush();
      }
    } else {
      if (!creatorLinks) return { ok: false, reason: 'store' };
      // hitomi だけの人の見出しそのものの名乗り (台帳のタグ) は外せない。別の名乗りを結ぶと、その塊ごと束ねる
      if (site === 'hitomi' && !folder && person.links.hitomi.some((link) => link.fixed && link.value === value)) {
        return { ok: false, reason: 'fixed' };
      }
      const personId = personIdOf(person);
      if (op === 'reject' || op === 'unlink') creatorLinks.revoke({ personId, source: site, name: value, by });
      else creatorLinks.link({ personId, source: site, name: value, by, note: String(request.note || '') });
    }
    const steps = undo();
    this.invalidate();
    // 書く前に始まっていた組み直しは古い結びで組んでいる: 済むのを待ってから組み直す
    if (this.building) await this.building.catch(() => {});
    const fresh = await this.rebuild();
    const next = fresh.byId.get(person.id);
    return { ok: true, undo: steps, author: next ? authorCard(next, { readOnly: this.deps.readOnly === true }) : null };
  }

  // 結びの書く前の姿を撮り、書いた後に呼ぶと「元に戻す手順」を返す関数を返す
  snapshotLink(person, site, value) {
    const { pawLinks, creatorLinks } = this.deps;
    const pixiv = this.pixiv();
    const personId = personIdOf(person);
    const rows = () => (creatorLinks && typeof creatorLinks.rowsFor === 'function' ? creatorLinks.rowsFor(personId, site, value) : []);
    const before = rows();
    let pixivBefore;
    let pawBefore;
    let paw = null;
    if (site === 'pixiv' && pixiv && person.kind === 'folder') {
      const hit = (pixiv.creatorBindings() || {})[value];
      pixivBefore = hit ? { folderId: String(hit.folderId), name: String(hit.name || '') } : null;
    }
    if (site === 'pawchive' && pawLinks && person.kind === 'folder') {
      const cut = value.indexOf(':');
      paw = { service: value.slice(0, cut), user: value.slice(cut + 1) };
      pawBefore = pawLinks.getCreator ? (pawLinks.getCreator(paw.service, paw.user) || null) : null;
    }
    return () => {
      const steps = [];
      const after = rows();
      for (const row of after) {
        const old = before.find((item) => String(item.at) === String(row.at));
        if (!old) steps.push({ k: 'cl-drop', row: { personId: row.personId, source: row.source, name: row.name, at: row.at } });
        else if ((old.revokedAt || null) !== (row.revokedAt || null)) {
          steps.push({ k: 'cl-revoked', row: { personId: row.personId, source: row.source, name: row.name, at: row.at }, value: old.revokedAt || null });
        }
      }
      if (pixivBefore !== undefined) {
        const hit = (pixiv.creatorBindings() || {})[value];
        const now = hit ? { folderId: String(hit.folderId), name: String(hit.name || '') } : null;
        if (JSON.stringify(now) !== JSON.stringify(pixivBefore)) steps.push({ k: 'pixiv-set', userId: value, value: pixivBefore });
      }
      if (pawBefore !== undefined) {
        const now = pawLinks.getCreator ? (pawLinks.getCreator(paw.service, paw.user) || null) : null;
        if (String(now || '') !== String(pawBefore || '')) steps.push({ k: 'paw-set', service: paw.service, user: paw.user, folderId: pawBefore });
      }
      return steps.reverse();
    };
  }

  // 元に戻す手順の一歩を行い、その逆 (やり直す手順) を返す。分からない一歩は null
  applyStep(step) {
    const { pawLinks, creatorLinks } = this.deps;
    const pixiv = this.pixiv();
    if (!step || typeof step !== 'object') return null;
    const cleanRow = (row) => ({
      personId: String(row && row.personId || ''), source: String(row && row.source || ''), name: String(row && row.name || ''), at: String(row && row.at || ''),
    });
    if (step.k === 'cl-drop' && creatorLinks) {
      const removed = creatorLinks.dropRow(cleanRow(step.row));
      return removed ? { k: 'cl-restore', row: removed } : null;
    }
    if (step.k === 'cl-restore' && creatorLinks && step.row) {
      const row = { ...step.row };
      return creatorLinks.restoreRow(row) ? { k: 'cl-drop', row: cleanRow(row) } : null;
    }
    if (step.k === 'cl-revoked' && creatorLinks) {
      const before = creatorLinks.setRevoked(cleanRow(step.row), step.value || null);
      return before === undefined ? null : { k: 'cl-revoked', row: cleanRow(step.row), value: before };
    }
    if (step.k === 'pixiv-set' && pixiv) {
      const userId = String(step.userId || '');
      if (!/^\d+$/.test(userId)) return null;
      const hit = (pixiv.creatorBindings() || {})[userId];
      const before = hit ? { folderId: String(hit.folderId), name: String(hit.name || '') } : null;
      if (step.value && step.value.folderId) pixiv.bindCreator(userId, String(step.value.folderId), String(step.value.name || ''));
      else if (typeof pixiv.unbindCreator === 'function') pixiv.unbindCreator(userId);
      return { k: 'pixiv-set', userId, value: before };
    }
    if (step.k === 'paw-set' && pawLinks) {
      const service = String(step.service || '').toLowerCase();
      const user = String(step.user || '');
      if (!service || !user) return null;
      const before = pawLinks.getCreator ? (pawLinks.getCreator(service, user) || null) : null;
      pawLinks.setCreator(service, user, step.folderId ? String(step.folderId) : null);
      if (typeof pawLinks.flush === 'function') pawLinks.flush();
      return { k: 'paw-set', service, user, folderId: before };
    }
    if (step.k === 'rating' && creatorLinks) {
      const personId = String(step.personId || '');
      const before = creatorLinks.rating(personId);
      return creatorLinks.rate(personId, Number(step.star) || 0) ? { k: 'rating', personId, star: before } : null;
    }
    if (step.k === 'name' && creatorLinks) {
      const personId = String(step.personId || '');
      const before = creatorLinks.displayName(personId);
      return creatorLinks.setDisplayName(personId, String(step.name || '')) ? { k: 'name', personId, name: before } : null;
    }
    if (step.k === 'origin' && creatorLinks) {
      const personId = String(step.personId || '');
      const before = creatorLinks.origin(personId);
      return creatorLinks.setOrigin(personId, String(step.origin || '')) ? { k: 'origin', personId, origin: before } : null;
    }
    if (step.k === 'cover' && creatorLinks && typeof creatorLinks.setCover === 'function') {
      const personId = String(step.personId || '');
      const before = creatorLinks.cover(personId);
      return creatorLinks.setCover(personId, String(step.id || '')) ? { k: 'cover', personId, id: before } : null;
    }
    return null;
  }

  // 元に戻す / やり直す ({ id, steps })。行った一歩の逆をまとめて返す (次にこれを渡せば元の姿に戻る)
  async undo(request = {}) {
    const steps = Array.isArray(request.steps) ? request.steps.slice(0, 20) : [];
    if (!steps.length) return { ok: false, reason: 'steps' };
    const inverse = [];
    for (const step of steps) {
      const back = this.applyStep(step);
      if (back) inverse.unshift(back);
    }
    if (!inverse.length) return { ok: false, reason: 'missing' };
    this.invalidate();
    if (this.building) await this.building.catch(() => {});
    const fresh = await this.rebuild();
    const next = request.id ? fresh.byId.get(String(request.id)) : null;
    return { ok: true, redo: inverse, author: next ? authorCard(next, { readOnly: this.deps.readOnly === true }) : null };
  }

  // 見出しの名前を決める ({ id, name }。'' で決めた名前を外す)。どの人でも (作者フォルダ・サークル・作者)
  async rename(request = {}) {
    const { creatorLinks } = this.deps;
    if (!creatorLinks || typeof creatorLinks.setDisplayName !== 'function') return { ok: false, reason: 'store' };
    const built = await this.ensure();
    const person = built.byId.get(String(request.id || ''));
    if (!person) return { ok: false, reason: 'author' };
    const personId = personIdOf(person);
    const before = creatorLinks.displayName(personId);
    const value = String(request.name == null ? '' : request.name).trim().slice(0, 80);
    if (!creatorLinks.setDisplayName(personId, value)) return { ok: false, reason: 'store' };
    this.invalidate();
    if (this.building) await this.building.catch(() => {});
    const fresh = await this.rebuild();
    const next = fresh.byId.get(person.id);
    return {
      ok: true,
      undo: before === value ? [] : [{ k: 'name', personId, name: before }],
      author: next ? authorCard(next, { readOnly: this.deps.readOnly === true }) : null,
    };
  }

  // 見出しの表紙を決める ({ id, cover: 本の id }。'' で決めた表紙を外して自動の顔に戻す)。
  // 選べるのはその人の確かな所持の本だけ (候補の本・よその本は断る)
  async cover(request = {}) {
    const { creatorLinks } = this.deps;
    if (!creatorLinks || typeof creatorLinks.setCover !== 'function') return { ok: false, reason: 'store' };
    const built = await this.ensure();
    const person = built.byId.get(String(request.id || ''));
    if (!person) return { ok: false, reason: 'author' };
    const value = String(request.cover == null ? '' : request.cover).trim();
    if (value && !person.books.some((book) => !book.candidate && book.id === value)) return { ok: false, reason: 'cover' };
    const personId = personIdOf(person);
    const before = creatorLinks.cover(personId);
    if (!creatorLinks.setCover(personId, value)) return { ok: false, reason: 'store' };
    this.invalidate();
    if (this.building) await this.building.catch(() => {});
    const fresh = await this.rebuild();
    const next = fresh.byId.get(person.id);
    return {
      ok: true,
      undo: before === value ? [] : [{ k: 'cover', personId, id: before }],
      author: next ? authorCard(next, { readOnly: this.deps.readOnly === true }) : null,
    };
  }

  // 持ち込みの本の出どころ ({ id, origin: 'discord' | '' })。作者フォルダの人だけ
  async origin(request = {}) {
    const { creatorLinks } = this.deps;
    if (!creatorLinks || typeof creatorLinks.setOrigin !== 'function') return { ok: false, reason: 'store' };
    const built = await this.ensure();
    const person = built.byId.get(String(request.id || ''));
    if (!person || person.kind !== 'folder') return { ok: false, reason: 'author' };
    const value = String(request.origin || '');
    const before = creatorLinks.origin(person.folderId);
    if (!creatorLinks.setOrigin(person.folderId, value)) return { ok: false, reason: 'origin' };
    this.invalidate();
    if (this.building) await this.building.catch(() => {});
    const fresh = await this.rebuild();
    const next = fresh.byId.get(person.id);
    return {
      ok: true,
      undo: before === value ? [] : [{ k: 'origin', personId: person.folderId, origin: before }],
      author: next ? authorCard(next, { readOnly: this.deps.readOnly === true }) : null,
    };
  }

  // 突き合わせの候補をまとめて足す ({ rows: [{ id, site, url, note }] })。書いたら一度だけ組み直す
  async suggest(request = {}) {
    const { creatorLinks } = this.deps;
    if (!creatorLinks || typeof creatorLinks.suggest !== 'function') return { ok: false, reason: 'store' };
    const built = await this.ensure();
    const rows = [];
    let skipped = 0;
    for (const item of Array.isArray(request.rows) ? request.rows : []) {
      const site = String(item && item.site || '');
      const person = built.byId.get(String(item && item.id || ''));
      const value = SITE_KEYS.includes(site) ? parseSiteUrl(site, item.url) : '';
      if (!person || !value || site === 'nhentai' || (site === 'hitomi' && person.kind !== 'folder')) {
        skipped += 1;
        continue;
      }
      // unresolved: 確かめても決められなかった印 (既にある候補にも付け直せる)
      rows.push({
        personId: personIdOf(person), source: site, name: value, note: String(item.note || ''), by: String(request.by || ''),
        ...(typeof item.unresolved === 'boolean' ? { unresolved: item.unresolved } : {}),
      });
    }
    const added = rows.length ? creatorLinks.suggest(rows) : 0;
    if (added) {
      this.invalidate();
      if (this.building) await this.building.catch(() => {});
      await this.rebuild();
    }
    return { ok: true, added, skipped };
  }

  // 作者の★ (1〜5、0 で外す)。creator-links の ratings に書き、組み直して新しい見出しを返す
  async rate(request = {}) {
    const { creatorLinks } = this.deps;
    if (!creatorLinks || typeof creatorLinks.rate !== 'function') return { ok: false, reason: 'store' };
    const built = await this.ensure();
    const person = built.byId.get(String(request.id || ''));
    if (!person) return { ok: false, reason: 'author' };
    const star = Math.round(Number(request.star));
    if (!Number.isFinite(star) || star < 0 || star > 5) return { ok: false, reason: 'star' };
    const personId = personIdOf(person);
    const before = creatorLinks.rating(personId);
    if (!creatorLinks.rate(personId, star)) return { ok: false, reason: 'store' };
    this.invalidate();
    if (this.building) await this.building.catch(() => {});
    const fresh = await this.rebuild();
    const next = fresh.byId.get(person.id);
    return {
      ok: true,
      undo: before === star ? [] : [{ k: 'rating', personId, star: before }],
      author: next ? authorCard(next, { readOnly: this.deps.readOnly === true }) : null,
    };
  }
}

module.exports = {
  HomeAuthors,
  buildHome,
  authorCard,
  filterPersons,
  sortPersons,
  movingOf,
  eagleAddedAt,
  creatorReadTimes,
  findByQuery,
  splitAuthorQuery,
  parseFind,
  bookFind,
  galleryFind,
  matchPerson,
  parseSiteUrl,
  siteUrl,
  nameKey,
  isoDate,
  comiket,
  eventOf,
  SITE_KEYS,
  HOME_TYPES,
  HOME_SORTS,
  WEB_PAGE_SIZE,
  WEB_MAX_PAGES,
  WEB_SITES,
  WEB_LIMITS,
  STAR_POINTS,
  folderMonth,
  personIdOf,
  personById,
  handleValue,
  parseHandleValue,
  parseHomeAuthorId,
  isHomeId: (id) => parseId(id).source === 'home',
};
