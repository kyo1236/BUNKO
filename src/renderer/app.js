// 上部の源泉の並び。先頭の Home は源泉横断の作者の一覧 (src/renderer/home.js、母屋は src/lib/home-authors.js)。
// E-Hentai は並びから外した (docs/home-tab-spec-2026-09-23.md): 作品 ID・URL の判定・保存の口は
// アダプタに残るが、URL を貼っても E-Hentai の頁へは入らない。手のひら版の机上版は構文の登録簿を
// そのまま渡してくる (Home の口も持たない) ので、ここでも外す
const SOURCES = (Array.isArray(window.hitomi.searchProviders) ? window.hitomi.searchProviders : [
  { id: 'home', label: 'Home' },
  { id: 'hitomi', label: 'hitomi' },
  { id: 'nhentai', label: 'nhentai' },
  { id: 'pawchive', label: 'pawchive' },
  { id: 'pixiv', label: 'pixiv' },
]).filter((item) => item.id !== 'ehentai');

const TYPES = [
  { id: '', label: 'すべて' },
  { id: 'doujinshi', label: '同人誌' },
  { id: 'manga', label: '漫画' },
  { id: 'artistcg', label: 'Artist CG' },
  { id: 'gamecg', label: 'Game CG' },
  { id: 'imageset', label: '画像集' },
];

// pixiv の種別の札。イラストだけの口は API に無く (札の側で間引くと棚が疎らになる)、
// R-18 は pixiv では絞り込みでなく別の一覧なので、ここに置く (docs/pixiv-design §15 U5)
const PIXIV_TYPES = [
  { id: '', label: 'すべて' },
  { id: 'manga', label: '漫画' },
  { id: 'ai', label: 'AI' },
  { id: 'r18', label: 'R-18' },
];

// pixiv の種別の語は種類 (漫画 / AI) と対象 (R-18) を '-' で繋ぐ: manga-r18 / ai-r18。
// 母屋の sources/pixiv.js の typeParts と同じ読み方 (test/cross-source が突き合わせる)
function pixivTypeParts(type) {
  const tokens = String(type || '').split('-');
  return {
    kind: tokens.includes('manga') ? 'manga' : tokens.includes('ai') ? 'ai' : '',
    r18: tokens.includes('r18'),
  };
}

function pixivTypeId({ kind = '', r18 = false } = {}) {
  return [kind, r18 ? 'r18' : ''].filter(Boolean).join('-');
}

// Home (作者の一覧) の種別の札。id は母屋の home-authors の HOME_TYPES と同じ (test/cross-source が突き合わせる)。
// 2026-09-27 にサイトと候補の絞りを外し、一覧の頭へ戻る「ホーム」の一枚だけに (押すと語も作者頁も外して一頁目へ。home.js)
const HOME_TYPES = [
  { id: '', label: 'ホーム' },
];

function typesFor(source = state.source) {
  if (source === 'home') return HOME_TYPES;
  return source === 'pixiv' ? PIXIV_TYPES : TYPES;
}

// 右上に置く言語は 2 文字の顔で。何語かはツールチップ (title) が言う
const LANGUAGES = [
  { id: '', label: 'ALL', name: 'すべて' },
  { id: 'japanese', label: 'JP', name: '日本語' },
  { id: 'english', label: 'EN', name: 'English' },
  { id: 'chinese', label: 'ZH', name: '中文' },
  { id: 'korean', label: 'KO', name: '한국어' },
  { id: 'spanish', label: 'ES', name: 'Español' },
  { id: 'french', label: 'FR', name: 'Français' },
  { id: 'indonesian', label: 'ID', name: 'Indonesia' },
  { id: 'russian', label: 'RU', name: 'Русский' },
  { id: 'thai', label: 'TH', name: 'ไทย' },
  { id: 'vietnamese', label: 'VI', name: 'Tiếng Việt' },
];

// **一覧に並べる順と、既定の並びは別の物**。ここは見せ方 (人気の塊 -> 日付 -> その他)
// だけを決め、既定は下の DEFAULT_SORT が持つ。
// 以前は「配列の先頭 = 既定」だったので、人気系をまとめて並べ直すと既定まで動き、
// 「どのサイトでも人気が既定」と「一覧では人気が順に並ぶ」が同時に満たせなかった。
//
// 札は**実際に飛ぶ先**に合わせてある (合わせないと同じ「人気」が三つの意味で並ぶ):
//   nhentai  sources/nhentai.js:111-117  today/week/month -> popular-{today,week,month} / year -> popular (全期間)
//   ehentai  sources/ehentai.js:156-164  today -> /popular (いま人気) / week -> toplist tl=11 (昨日) / month -> 12 / year -> 13
//   pawchive sources/pawchive.js:621-624 today は作品ではなく**作者**を favorited 順に返す
const SORTS = {
  hitomi: [
    { id: 'today', label: '人気・今日' },
    { id: 'week', label: '人気・週' },
    { id: 'month', label: '人気・月' },
    { id: 'year', label: '人気・年' },
    { id: 'added', label: '追加日' },
    { id: 'published', label: '公開日' },
    { id: 'random', label: 'ランダム' },
  ],
  nhentai: [
    { id: 'today', label: '人気・今日' },
    { id: 'week', label: '人気・週' },
    { id: 'month', label: '人気・月' },
    // mapSort は前から year -> popular (全期間) を持っていたが、一覧に無いので
    // 画面からは辿り着けなかった
    { id: 'year', label: '人気・全期間' },
    { id: 'added', label: '追加日' },
  ],
  ehentai: [
    // /popular は「いま人気」で当日の集計ではない。toplist の 11 は昨日
    { id: 'today', label: '人気・いま' },
    { id: 'week', label: '人気・昨日' },
    { id: 'month', label: '人気・月' },
    { id: 'year', label: '人気・年' },
    { id: 'added', label: '追加日' },
  ],
  pawchive: [
    // 作者一覧と投稿一覧を分け、人気投稿は公開の日・週・月集計を使う。
    { id: 'favorites', label: 'お気に入り' },
    { id: 'today', label: '人気の作者' },
    { id: 'added', label: '追加日' },
    { id: 'popular-day', label: '人気・今日' },
    { id: 'popular-week', label: '人気・今週' },
    { id: 'popular-month', label: '人気・今月' },
  ],
  pixiv: [
    // 並びが一覧の種類を兼ねる (hitomi の「空 + 人気・今日 = 人気一覧」と同じ作法)。
    // 空 + 人気 = ランキング、空 + 新しい順 = pixiv の新着作品、空 + フォロー = フォロー新着、
    // 空 + 候補 = ブックマーク。語があれば 人気 = 人気順 + 期間、新しい順 = 新着順の検索、
    // フォロー / 候補 = 読み込んだ一覧を語で絞る (docs/pixiv-design §4, §15 U1)
    { id: 'today', label: '人気・今日' },
    { id: 'week', label: '人気・今週' },
    { id: 'month', label: '人気・今月' },
    { id: 'year', label: '人気・全期間' },
    { id: 'added', label: '新しい順' },
    { id: 'follow', label: 'フォロー' },
    { id: 'bookmarks', label: 'ブックマーク' },
    { id: 'recommended', label: 'おすすめ' },
    { id: 'rookie', label: 'ルーキー' },
    { id: 'original', label: 'オリジナル' },
    { id: 'male', label: '男性に人気' },
    { id: 'female', label: '女性に人気' },
  ],
  // Home (作者の一覧)。並べる物は人。id と並びは母屋の home-authors の HOME_SORTS と同じ。
  home: [
    // 所持の本を最後に Eagle へ入れた新しい順
    { id: 'activity', label: '最近の動き' },
    // 所持の本を読んだ新しい順 (他のタブで読んだその作者の本も数える)
    { id: 'read', label: '最近読んだ順' },
    // 作者の★ (Home の詳細の板で付ける)
    { id: 'rating', label: '作者の評価順' },
    // 所持の本の Eagle の★: 未判定と★1〜5 の点の平均を均した値 (母屋の home-authors の STAR_POINTS)
    { id: 'stars', label: '作品の評価順' },
    { id: 'owned', label: '所持の多い順' },
    { id: 'title', label: '名前' },
  ],
};

// 既定の並び。**一覧の位置から独立している**ので、並べ替えても既定は動かない。
// Pawchive はお気に入り作者を入口にし、投稿の人気順は別に選べる。
const DEFAULT_SORT = {
  hitomi: 'added', nhentai: 'today', ehentai: 'today', pawchive: 'favorites',
  // pixiv は作家追いが目的: 既定はフォロー新着
  pixiv: 'follow',
  home: 'activity',
};
// 所持作品は手元の台帳が相手: 人気のような集計をそもそも持たない
const DEFAULT_LIBRARY_SORT = 'added';

// 表に無い既定を指していても落ちない (表を削っても画面が白くならない)
function defaultSortId(options, source, scope) {
  const want = scope === 'library' ? DEFAULT_LIBRARY_SORT : DEFAULT_SORT[source];
  return options.some((item) => item.id === want) ? want : options[0].id;
}

// 所持作品スコープはローカルDBが相手: 人気順のような集計は持たない
const LIBRARY_SORTS = [
  // 保存日 = Eagle に入れた日時 (公開日 = 作品の発行日 との違いを名前で言う)
  { id: 'added', label: '保存日' },
  { id: 'published', label: '公開日' },
  { id: 'title', label: 'タイトル' },
  // 星は Eagle 側にしか無い: web 検索の並びには出さない
  { id: 'star', label: '星の高い順' },
  // 再読の棚。専用の枠は作らず、並びの一つとして出す (栞が持ち主)
  { id: 'reread', label: '読了回数' },
  { id: 'finished', label: '最終読了日' },
];

// お気に入りの基準として選べる星の下限 (設定と同じ並び)
const FAVORITE_STAR_CHOICES = [3, 4, 5];

function sortsFor(source) {
  return SORTS[source] || SORTS.hitomi;
}

function libraryScope() {
  return state.scope === 'library';
}

// pawchive の所持作品は Eagle の「作者」フォルダが持ち主: 台帳の並びは使えない
const PAW_LIBRARY_SORTS = [
  { id: 'added', label: '新着' },
  { id: 'title', label: 'タイトル' },
  { id: 'reread', label: '読了回数' },
  { id: 'finished', label: '最終読了日' },
];

// 所持の裏付けがあるのは hitomi (台帳)・pawchive (Eagle の作者根)・pixiv (作者根 + 台帳) だけ
const LIBRARY_SOURCES = SOURCES.filter((item) => item.id === 'hitomi' || item.id === 'pawchive' || item.id === 'pixiv');

function pawLibraryScope() {
  return libraryScope() && state.source === 'pawchive';
}

// pixiv の所持は pixiv の台帳が持ち主 (作者根の項目 + 網から貰った素性)。
// 台帳の並び (公開日・星) は無く、paw と同じ四つで足りる
function pixivLibraryScope() {
  return libraryScope() && state.source === 'pixiv';
}

function activeSorts() {
  if (pawLibraryScope() || pixivLibraryScope()) return PAW_LIBRARY_SORTS;
  return libraryScope() ? LIBRARY_SORTS : sortsFor(state.source);
}

// スコープ込みで覚える: 所持作品側の並びが web 側の既定を潰さないように
function sortMemoryKey(source = state.source, scope = state.scope) {
  return `${scope === 'library' ? 'library' : 'all'}:${source}`;
}

// サイトを移ったときの並び。前に見ていた並びがあればそれ、無ければ先頭 (= 既定)
function sortForSource(source, scope = state.scope) {
  const remembered = state.sortBySource[sortMemoryKey(source, scope)];
  const library = scope === 'library';
  const options = source === 'pawchive' && library
    ? PAW_LIBRARY_SORTS
    : (library ? LIBRARY_SORTS : sortsFor(source));
  if (remembered && options.some((item) => item.id === remembered)) return remembered;
  return defaultSortId(options, source, scope);
}

// **覚えるのは利用者が自分で選んだ並びだけ。** 描画のたびに覚えると、表に無くて
// 弾かれただけの値 (所持作品で 人気・今日 が 保存日 に落ちた等) が記憶に焼き付き、
// 以後その組み合わせでは既定が二度と出なくなる。
// 呼ぶのは三箇所だけ: 並びを選んだ時・サイトを移る時・スコープを移る時
function rememberSort(source = state.source, scope = state.scope) {
  state.sortBySource[sortMemoryKey(source, scope)] = state.sort;
  window.hitomi.saveSettings({ sortBySource: { ...state.sortBySource } });
}

const state = {
  query: '',
  source: 'hitomi',
  scope: 'all',
  // 発見ビュー (新作の見張り + 発掘)。検索とは別モードで、検索操作で抜ける
  discovery: false,
  type: '',
  excludedTypes: [],
  language: '',
  sort: 'added',
  pixivPeriod: 'year',
  page: 0,
  pageSize: 24,
  total: 0,
  approximate: false,
  truncated: 0,          // 打ち切った件数 (0 = 打ち切っていない)
  galleries: [],
  loading: false,
  done: false,
  error: '',
  selected: null,
  reader: null,
  downloads: [],
  settings: { downloadDir: '', concurrency: 4, zoom: 3 },
  suggestIndex: -1,
  suggestKeyboard: false,
  suggestItems: [],
  // pawchive のお気に入り作者 ("service:user")。札の初期状態はここだけを見る
  pawFavs: new Set(),
  // サイトごとに最後に見ていた並び。サイトを移ると既定に戻ってしまうのを防ぐ
  sortBySource: {},
  imageBase: '',
  zoom: 3,
  library: { owned: 0, withMeta: 0, backfill: null },
  // pawchive お気に入りの一括更新。進捗は main から押し出される
  pawBulk: { running: false },
  // pixiv の一括 (作者の未所持 / 候補の未所持) と、ログイン等の状態
  pixivBulk: { running: false },
  pixivStatus: null,
  searchNotice: '',
  scanning: false,
  scanProgress: null,
  loupeId: null,
  loupePage: 0,
  loupeGallery: null,
  readerRtl: true,
  readerFit: 'contain',
  readerSpread: false,
  readerOffset: 0,
  readerFullscreen: false,
};

// Lucide の作法: 24 の viewBox・線のみ・stroke-width 2・端と角は丸め
const svgIcon = (body, size = 16) => (
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
);

// 入り切りを枠の色だけで言うと弱い印がある: 星は入のとき塗り潰す
const svgIconFilled = (body, size = 16) => (
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
);

const STAR_PATH = '<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>';

const ICON = {
  chevronLeft: svgIcon('<path d="m15 18-6-6 6-6"/>'),
  chevronRight: svgIcon('<path d="m9 18 6-6-6-6"/>'),
  // 候補へ (pixiv のブックマーク)。★ は Eagle の物なので ♥ で分ける
  heart: svgIcon('<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/>'),
  heartOn: svgIcon('<path fill="currentColor" d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/>'),
  single: svgIcon('<rect width="18" height="18" x="3" y="3" rx="2"/>'),
  spread: svgIcon('<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>'),
  // 綴じ: 綴じ側に背の罫を引いた頁と、読む向きを示す矢印を上に添える
  bindRtl: svgIcon('<path d="M16 4H8"/><path d="m10.5 1.5-2.5 2.5 2.5 2.5"/><rect width="16" height="13" x="4" y="8" rx="1"/><path d="M16 8v13"/>'),
  bindLtr: svgIcon('<path d="M8 4h8"/><path d="m13.5 1.5 2.5 2.5-2.5 2.5"/><rect width="16" height="13" x="4" y="8" rx="1"/><path d="M8 8v13"/>'),
  eye: svgIcon('<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff: svgIcon('<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>'),
  // 所持作品: 棚に並んだ背表紙
  library: svgIcon('<path d="M4 4v16"/><path d="M8 8v12"/><path d="M12 6v14"/><path d="m16 6 4 14"/>', 18),
  // 画像が無い / 取れなかった表紙の代わり (壊れた画像の記号を見せないため)
  image: svgIcon('<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>', 28),
  star: svgIcon(STAR_PATH),
  starOn: svgIconFilled(STAR_PATH),
  // 並びの向き。降順 = 新しい/多い順 (既定)、昇順はその逆
  sortDesc: svgIcon('<path d="m3 16 4 4 4-4"/><path d="M7 20V4"/><path d="M11 4h10"/><path d="M11 8h7"/><path d="M11 12h4"/>', 16),
  sortAsc: svgIcon('<path d="m3 8 4-4 4 4"/><path d="M7 4v16"/><path d="M11 12h4"/><path d="M11 16h7"/><path d="M11 20h10"/>', 16),
  stop: svgIcon('<rect width="12" height="12" x="6" y="6" rx="1"/>'),
  search: svgIcon('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>', 18),
  settings: svgIcon('<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>', 18),
  // トレイ = ダウンロードの控え室。保存そのもの (save) とは別の顔にする
  tray: svgIcon('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>', 18),
  save: svgIcon('<path d="M12 15V3"/><path d="m6 9 6 6 6-6"/><path d="M19 21H5"/>'),
  close: svgIcon('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  eraser: svgIcon('<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>'),
  folder: svgIcon('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>'),
  folderShow: svgIcon('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><circle cx="12" cy="13" r="2"/>', 14),
  external: svgIcon('<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'),
  rescan: svgIcon('<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>'),
  // 表示の大きさ。札は一枚で、押すたびに 6 段を巡る (± の二枚は畳んだ)
  zoomGrid: svgIcon('<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>'),
  // 虫眼鏡+ = ホバープレビュー。見えている/いないは .active で言う
  fitWidth: svgIcon('<polyline points="18 8 22 12 18 16"/><polyline points="6 8 2 12 6 16"/><line x1="2" x2="22" y1="12" y2="12"/>'),
  fitHeight: svgIcon('<polyline points="8 18 12 22 16 18"/><polyline points="8 6 12 2 16 6"/><line x1="12" x2="12" y1="2" y2="22"/>'),
  offset: svgIcon('<rect width="7" height="11" x="3" y="3" rx="1"/><rect width="7" height="11" x="14" y="3" rx="1"/><path d="M5 19h14"/><path d="m8 16-3 3 3 3"/><path d="m16 16 3 3-3 3"/>'),
  info: svgIcon('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>'),
  feather: svgIcon('<path d="M12.67 19a2 2 0 0 0 1.416-.588l6.154-6.172a6 6 0 0 0-8.49-8.49L5.586 9.914A2 2 0 0 0 5 11.328V18a1 1 0 0 0 1 1z"/><path d="M16 8 2 22"/><path d="M17.5 15H9"/>'),
  // 鎖 = 所持アイテムとの手動紐付け。切れた鎖はその解除
  link: svgIcon('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
  unlink: svgIcon('<path d="m18.84 12.25 1.72-1.71a5 5 0 0 0-.12-7.07 5 5 0 0 0-6.95 0l-1.72 1.71"/><path d="m5.17 11.75-1.71 1.71a5 5 0 0 0 .12 7.07 5 5 0 0 0 6.95 0l1.71-1.71"/><path d="M8 2v3"/><path d="M2 8h3"/><path d="M16 19v3"/><path d="M19 16h3"/>'),
  // ゴミ箱 = Eagle 側の実体ごと捨てる。解除 (unlink) より一段重い操作
  trash: svgIcon('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>', 15),
  // ◯に× = すべて中止。個々の中止 (close) より一段大きい操作
  cancelAll: svgIcon('<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>', 16),
};

// 読む = 見開きの本アイコンをそのまま流用: 同じパスを二重に持たせない
ICON.book = ICON.spread;

// HTML 側は空の器だけ置き、中身はここから流し込む
const ICON_SLOTS = {
  'search-go': 'search',
  'btn-settings': 'settings',
  'btn-queue': 'tray',
  'open-dest': 'folder',
  'clear-finished': 'trash',
  'cancel-all': 'cancelAll',
  'zoom-cycle': 'zoomGrid',
  'detail-close': 'close',
  'settings-close': 'close',
  'help-close': 'close',
  'paw-link-close': 'close',
  'set-download-choose': 'folder',
  'set-download-open': 'external',
  'set-eagle-choose': 'folder',
  'set-eagle-clear': 'eraser',
  'set-paw-bulk-choose': 'folder',
  'set-paw-bulk-open': 'external',
  'reader-close': 'close',
  'reader-prev': 'chevronLeft',
  'reader-next': 'chevronRight',
  'reader-offset': 'offset',
  'reader-download': 'save',
};

function fillIcons() {
  Object.entries(ICON_SLOTS).forEach(([id, key]) => {
    const node = document.getElementById(id);
    // バッジなど既にある子は残す
    if (node) node.insertAdjacentHTML('afterbegin', ICON[key]);
  });
}

// 表紙の大きさは表示設定の一本の欄で決め、頁ごとに覚える (2026-09-27、利用者の指示)。
// 頁 = 源泉 × (一覧 / 作者頁)。所持作品の頁は別に覚える。設定 uiCoverSizes = { '<源泉>[+所持]:<list|author>': 大きさ }。
// 覚えていない頁は前からの uiCoverSize (無ければ 152)。作者頁 = 語が一人の作者を指す時:
//   Home の @名前 / pixiv の user:<数字> / Pawchive の <service>/<user> / ほかは artist: か group: が一つ (言語と種別の絞りは添えてよい)
const COVER_SIZE_DEFAULT = 152;

function authorPageNow(source = state.source, query = state.query) {
  const q = String(query || '').trim();
  if (!q) return false;
  if (source === 'home') return q.startsWith('@');
  const tokens = q.split(/\s+/).filter(Boolean);
  if (source === 'pixiv') return tokens.length === 1 && /^user:\d+$/.test(tokens[0]);
  if (source === 'pawchive') return tokens.length === 1 && /^\w+\/[^/\s]+$/.test(tokens[0]);
  const authors = tokens.filter((token) => /^(artist|group):\S/i.test(token));
  const rest = tokens.filter((token) => !authors.includes(token));
  return authors.length === 1 && rest.every((token) => /^(language|type):\S/i.test(token));
}

// 今の頁の鍵 ('hitomi:list' / 'home:author' / 'pixiv+所持:list' …)
function coverPageKey(source = state.source, query = state.query, scope = state.scope) {
  return `${source}${scope === 'library' ? '+所持' : ''}:${authorPageNow(source, query) ? 'author' : 'list'}`;
}

function coverSizeOf(key) {
  const settings = state.settings || {};
  const sizes = settings.uiCoverSizes && typeof settings.uiCoverSizes === 'object' ? settings.uiCoverSizes : {};
  return Number(sizes[key]) || Number(settings.uiCoverSize) || COVER_SIZE_DEFAULT;
}

// 頁の大きさを覚える (保存は呼び手が uiCoverSizes ごと)
function setCoverSize(key, size) {
  if (!state.settings) state.settings = {};
  const sizes = state.settings.uiCoverSizes && typeof state.settings.uiCoverSizes === 'object' ? state.settings.uiCoverSizes : {};
  state.settings.uiCoverSizes = { ...sizes, [key]: Number(size) };
  return state.settings.uiCoverSizes;
}

// 表示設定の窓に添える頁の名 (「hitomi の一覧」「Home の作者頁」「pixiv の所持作品の一覧」)
function coverPageLabel(key = coverPageKey()) {
  const match = /^([^+:]+)(\+所持)?:(list|author)$/.exec(String(key));
  if (!match) return '';
  const source = (SOURCES.find((item) => item.id === match[1]) || { label: match[1] }).label;
  return `${source} の${match[2] ? '所持作品の' : ''}${match[3] === 'author' ? '作者頁' : '一覧'}`;
}

// 今の頁の表紙の大きさ
function currentCoverSize() {
  return coverSizeOf(coverPageKey());
}

const ZOOM_LEVELS = [
  { id: 'list', min: 0, label: 'リスト' },
  { id: 'xs', min: 88, label: '最小' },
  { id: 's', min: 124, label: '小' },
  { id: 'm', min: 168, label: '中' },
  { id: 'l', min: 220, label: '大' },
  { id: 'xl', min: 280, label: '特大' },
];
// 表示の釦の title (bunko-ui.js も同じ語を置く)
const ZOOM_BUTTON_TITLE = '表示設定';

const els = {
  form: document.getElementById('search-form'),
  query: document.getElementById('query'),
  queryClear: document.getElementById('query-clear'),
  sortDir: document.getElementById('sort-dir'),
  suggest: document.getElementById('suggest'),
  source: document.getElementById('source'),
  scope: document.getElementById('scope'),
  types: document.getElementById('types'),
  language: document.getElementById('language'),
  sort: document.getElementById('sort'),
  grid: document.getElementById('grid'),
  favOnly: document.getElementById('fav-only'),
  pawBulk: document.getElementById('paw-bulk'),
  pawBulkStatus: document.getElementById('paw-bulk-status'),
  hideOwned: document.getElementById('hide-owned'),
  empty: document.getElementById('empty'),
  status: document.getElementById('status'),
  sentinel: document.getElementById('sentinel'),
  detail: document.getElementById('detail'),
  detailBody: document.getElementById('detail-body'),
  detailClose: document.getElementById('detail-close'),
  queue: document.getElementById('queue'),
  jobs: document.getElementById('jobs'),
  jobsDone: document.getElementById('jobs-done'),
  queueActive: document.getElementById('queue-active'),
  queueDone: document.getElementById('queue-done'),
  queueActiveCount: document.getElementById('queue-active-count'),
  queueDoneCount: document.getElementById('queue-done-count'),
  queueCount: document.getElementById('queue-count'),
  destPath: document.getElementById('dest-path'),
  loupe: document.getElementById('loupe'),
  loupePages: document.getElementById('loupe-pages'),
  loupeCaption: document.getElementById('loupe-caption'),
  reader: document.getElementById('reader'),
  readerTitle: document.getElementById('reader-title'),
  readerStars: document.getElementById('reader-stars'),
  readerPage: document.getElementById('reader-page'),
  readerImage: document.getElementById('reader-image'),
  readerImage2: document.getElementById('reader-image2'),
  readerPages: document.getElementById('reader-pages'),
  readerPageInput: document.getElementById('reader-page-input'),
  readerSeek: document.getElementById('reader-seek'),
  readerLoading: document.getElementById('reader-loading'),
  readerThumbs: document.getElementById('reader-thumbs'),
  readerThumbsGrid: document.getElementById('reader-thumbs-grid'),
  readerStage: document.getElementById('reader-stage'),
  readerBody: document.getElementById('reader-body'),
  readerPrev: document.getElementById('reader-prev'),
  readerNext: document.getElementById('reader-next'),
  readerRtl: document.getElementById('reader-rtl'),
  readerFit: document.getElementById('reader-fit'),
  readerSpread: document.getElementById('reader-spread'),
  readerOffset: document.getElementById('reader-offset'),
  readerHint: document.getElementById('reader-hint'),
  readerBoundary: document.getElementById('reader-boundary'),
  readerSide: document.getElementById('reader-side'),
  toasts: document.getElementById('toasts'),
  zoomCycle: document.getElementById('zoom-cycle'),
  zoomName: document.getElementById('zoom-name'),
  recents: document.getElementById('recents'),
  resultInfo: document.getElementById('result-info'),
  settings: document.getElementById('settings'),
  settingsClose: document.getElementById('settings-close'),
  help: document.getElementById('help'),
  helpBody: document.getElementById('help-body'),
  helpClose: document.getElementById('help-close'),
  pawLink: document.getElementById('paw-link'),
  pawLinkTitle: document.getElementById('paw-link-title'),
  pawLinkNote: document.getElementById('paw-link-note'),
  pawLinkBody: document.getElementById('paw-link-body'),
  setDownloadDir: document.getElementById('set-download-dir'),
  setDownloadChoose: document.getElementById('set-download-choose'),
  setDownloadOpen: document.getElementById('set-download-open'),
  setSaveFormat: document.getElementById('set-save-format'),
  setEagleDir: document.getElementById('set-eagle-dir'),
  setEagleChoose: document.getElementById('set-eagle-choose'),
  setEagleClear: document.getElementById('set-eagle-clear'),
  setPixivStatus: document.getElementById('set-pixiv-status'),
  setPixivLogin: document.getElementById('set-pixiv-login'),
  setPixivToken: document.getElementById('set-pixiv-token'),
  setPixivLogout: document.getElementById('set-pixiv-logout'),
  setPixivHint: document.getElementById('set-pixiv-hint'),
  setPixivHideAi: document.getElementById('set-pixiv-hide-ai'),
  setPixivReadOriginal: document.getElementById('set-pixiv-read-original'),
  setAitag: document.getElementById('set-aitag'),
  setAiMetaCount: document.getElementById('set-ai-meta-count'),
  setAiMetaBackfill: document.getElementById('set-ai-meta-backfill'),
  setPixivRelabel: document.getElementById('set-pixiv-relabel'),
  setPixivRelabelCount: document.getElementById('set-pixiv-relabel-count'),
  setPawBulkDir: document.getElementById('set-paw-bulk-dir'),
  setPawBulkChoose: document.getElementById('set-paw-bulk-choose'),
  setPawBulkOpen: document.getElementById('set-paw-bulk-open'),
  setPawBulkConcurrency: document.getElementById('set-paw-bulk-concurrency'),
  setOpenOwned: document.getElementById('set-open-owned'),
  setHomeUnresolved: document.getElementById('set-home-unresolved'),
  setFavoriteStars: document.getElementById('set-favorite-stars'),
  setFavoriteValue: document.getElementById('set-favorite-value'),
  setOwned: document.getElementById('set-owned'),
  setRescan: document.getElementById('set-rescan'),
  setSyncHomecore: document.getElementById('set-sync-homecore'),
  setHealth: document.getElementById('set-health'),
  notice: document.getElementById('notice'),
  noticeText: document.getElementById('notice-text'),
  noticeBar: document.getElementById('notice-bar'),
  noticeClose: document.getElementById('notice-close'),
  setLibraryBar: document.getElementById('set-library-bar'),
  setLibraryHint: document.getElementById('set-library-hint'),
  setConcurrency: document.getElementById('set-concurrency'),
  setMaxGalleries: document.getElementById('set-max-galleries'),
  setTrayClose: document.getElementById('set-tray-close'),
  setLoupe: document.getElementById('set-loupe'),
  setLan: document.getElementById('set-lan'),
  setLanUrl: document.getElementById('set-lan-url'),
  setLanCopy: document.getElementById('set-lan-copy'),
  setLanNote: document.getElementById('set-lan-note'),
  setLanQr: document.getElementById('set-lan-qr'),
  setLanQrImg: document.getElementById('set-lan-qr-img'),
  setLanTsRow: document.getElementById('set-lan-ts-row'),
  setLanTsUrl: document.getElementById('set-lan-ts-url'),
  setLanTsCopy: document.getElementById('set-lan-ts-copy'),
  setLanTsQr: document.getElementById('set-lan-ts-qr'),
  setLanTsQrImg: document.getElementById('set-lan-ts-qr-img'),
  setReaderNextCard: document.getElementById('set-reader-next-card'),
  setReaderResume: document.getElementById('set-reader-resume'),
  setOwnedConfirm: document.getElementById('set-owned-confirm'),
  setAutoSync: document.getElementById('set-auto-sync'),
  setShowUnmatched: document.getElementById('set-show-unmatched'),
  setMouseLeft: document.getElementById('set-mouse-left'),
  setMouseRight: document.getElementById('set-mouse-right'),
  setMouseDouble: document.getElementById('set-mouse-double'),
};

const TOAST_MAX = 4;

function toast(message, { type = 'info', duration } = {}) {
  const life = duration === undefined ? (type === 'error' ? 6000 : 3500) : duration;
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = message;
  let timer = 0;
  const dismiss = () => {
    if (node.dataset.leaving) return;
    node.dataset.leaving = '1';
    clearTimeout(timer);
    node.classList.add('is-leaving');
    setTimeout(() => node.remove(), 200);
  };
  node.addEventListener('click', dismiss);
  els.toasts.appendChild(node);
  timer = setTimeout(dismiss, life);
  while (els.toasts.children.length > TOAST_MAX) {
    els.toasts.firstElementChild.remove();
  }
}

function imgUrl(id, index, size = 'small') {
  // Eagle アイテムの表紙はライブラリの中にある: 取得元は別の口になる。
  // 頁 (原寸・2 頁目以降) は母屋の /img が原本から出す
  const raw = String(id || '');
  if (raw.startsWith('pweagle:') && index === 0 && size !== 'full') {
    return `${state.imageBase}/pweagle/${encodeURIComponent(raw.slice('pweagle:'.length))}`;
  }
  // 所持作品側の作者札。表紙はそのフォルダの一番新しい作品から借りる
  if (raw.startsWith('pwlibf:')) {
    return `${state.imageBase}/pwlibf/${encodeURIComponent(raw.slice('pwlibf:'.length))}`;
  }
  return `${state.imageBase}/img?id=${encodeURIComponent(id)}&i=${index}&size=${size}`;
}

function sameId(a, b) {
  return String(a) === String(b);
}

function detectSource(raw) {
  const text = String(raw || '').trim();
  if (/hitomi\.la\//i.test(text)) return { source: 'hitomi', query: text };
  if (/nhentai\.net\/g\//i.test(text)) return { source: 'nhentai', query: text };
  if (/e[x-]?hentai\.org\/g\//i.test(text)) return { source: 'ehentai', query: text };
  if (/pawchive\.(pw|st)\//i.test(text)) return { source: 'pawchive', query: text };
  if (/pixiv\.net\//i.test(text)) return { source: 'pixiv', query: text };
  return null;
}

function sourceLabel(source) {
  // 並びから外した源泉の作品 (URL を貼って引いた E-Hentai の一冊など) も名乗りは正しく
  return SOURCES.find((item) => item.id === source)?.label
    || ({ ehentai: 'E-Hentai' })[source] || source || 'hitomi';
}

// 上部の並びに出ている源泉か。E-Hentai は外したので、URL を貼ってもその頁へは入らない
// (網の検索は URL から E-Hentai の作品を一枚返すので、今の源泉の一覧に出るだけ)
function sourceShown(source) {
  return SOURCES.some((item) => item.id === source);
}

// 閉じた時の続き・札 (ピン) が並びから外れた源泉を指していたら hitomi へ寄せる
function shownSourceOr(source, fallback = 'hitomi') {
  if (sourceShown(source)) return source;
  if (sourceShown(fallback)) return fallback;
  return SOURCES[0] ? SOURCES[0].id : 'hitomi';
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function fillSelect(select, items, current) {
  select.innerHTML = items
    .map((item) => `<option value="${item.id}" ${item.id === current ? 'selected' : ''}${item.name ? ` title="${item.name}"` : ''}>${item.label}</option>`)
    .join('');
}

// 入り切りの札はどれも同じ形をしている: 絵・題・aria・active をまとめて置く。
// iconOff を渡さない札は据え置きの絵で、入り切りは枠の色だけで言う
function setToggle(node, { on, iconOn, iconOff, label, pressed = true }) {
  if (!node) return;
  node.innerHTML = on ? iconOn : (iconOff === undefined ? iconOn : iconOff);
  node.title = label;
  node.setAttribute('aria-label', label);
  if (pressed) node.setAttribute('aria-pressed', on ? 'true' : 'false');
  node.classList.toggle('active', on);
}

// 設定画面の文字付きスイッチ。絵の札 (setToggle) と違い、状態を言葉で言う
function setSwitch(node, { on, onText = 'する', offText = 'しない', label }) {
  if (!node) return;
  node.innerHTML = `<span class="set-switch-text">${on ? onText : offText}</span><span class="set-switch-knob"></span>`;
  const title = label ? `${label}: ${on ? onText : offText}` : (on ? onText : offText);
  node.title = title;
  node.setAttribute('aria-label', title);
  node.setAttribute('aria-pressed', on ? 'true' : 'false');
  node.classList.toggle('active', on);
}

// 設定の保存はどこも同じ形: 通れば新しい設定、落ちればトーストを出して null
async function saveSetting(patch, { announce = true } = {}) {
  try {
    state.settings = await window.hitomi.saveSettings(patch);
    if (announce) toast('設定を保存しました');
    return state.settings;
  } catch {
    toast('設定を保存できませんでした', { type: 'error' });
    return null;
  }
}

// pawLinks が落ちても画面は止めない。呼び先はどこも「返事なし」を扱える。
// 落ちたことだけ知りたい呼び先は onFail に目印を渡す
const PAW_LINKS_FAILED = Symbol('paw-links-failed');

async function pawLinksCall(payload, onFail = null) {
  try {
    return await window.hitomi.pawLinks(payload);
  } catch {
    return onFail;
  }
}

// 表示に使う作者名。作者が無ければグループで代える
function artistName(gallery) {
  return gallery.artists[0]?.label || gallery.artists[0]?.name
    || gallery.groups[0]?.label || gallery.groups[0]?.name || '';
}

function fillScopeToggle() {
  // Home では所持作品のスコープへ移らない: 同じ釦が作者頁を所持の本だけにする旗になる (home.js)
  if (state.source === 'home' && !libraryScope() && window.BunkoHome?.toggleOwnedOnly) {
    const on = Boolean(window.BunkoHome.ownedOnlyActive());
    setToggle(els.scope, {
      on,
      iconOn: ICON.library,
      label: on ? '所持作品だけを表示中 — 網の作品も出す' : '所持作品だけを表示',
    });
    return;
  }
  const on = libraryScope();
  setToggle(els.scope, {
    on,
    iconOn: ICON.library,
    label: on ? '所持作品から検索中 — 全体に戻す' : '所持作品から検索 - オフライン対応',
  });
}

// ---- 並びの向き ----
// 逆順にできるのは、ID リストを手元で反転できる経路だけ:
// 全体を並べ替えられる一覧と、取得済みの範囲で反転する一覧を区別する。
function sortDirValue() {
  return (state.settings || {}).sortDir === 'asc' ? 'asc' : 'desc';
}

function sortDirSupported() { return true; }

function sortDirNativeSupported() {
  // Home は母屋が控えの上で全員を並べ替える: 向きも母屋で返せる
  if (state.source === 'home' && !libraryScope()) return true;
  if (pawLibraryScope()) return false;
  // pawchive のお気に入り一覧は手元で並べる (最終更新日順) ので向きを返せる
  if (state.source === 'pawchive') return state.sort === 'favorites';
  return state.source === 'hitomi';
}

function fillSortDir() {
  queueMicrotask(() => window.BunkoUI?.sync());
  if (!els.sortDir) return;
  const dir = sortDirValue();
  const supported = sortDirSupported();
  // できない道具は出さない: 灰色の札を残さず引っ込める。
  // 枠 (.sort-slot) が幅を持ち続けるので、消えても帯の折り返しは動かない
  els.sortDir.hidden = !supported;
  if (!supported) return;
  els.sortDir.innerHTML = dir === 'asc' ? ICON.sortAsc : ICON.sortDesc;
  const label = dir === 'asc' ? '昇順 — クリックで降順' : '降順 — クリックで昇順';
  els.sortDir.title = label;
  els.sortDir.setAttribute('aria-label', label);
}

function renderSources() {
  if (!els.source) return;
  const library = libraryScope();
  // 所持作品では nhentai/ehentai は裏付けが無い: 選べる先を絞る
  if (library && !LIBRARY_SOURCES.some((item) => item.id === state.source)) {
    state.source = 'hitomi';
  }
  fillSelect(els.source, library ? LIBRARY_SOURCES : SOURCES, state.source);
  fillScopeToggle();
  els.source.disabled = false;
  els.source.title = library ? 'サイト — 所持作品は hitomi / Pawchive / pixiv' : 'サイト';
  const bare = state.source === 'pawchive';
  els.types.hidden = bare;
  // 言語セレクトは 6c で rail 右上へ移った (label には包まれていない)。
  // pixiv は言語で絞る口を持たない (種別の札はある)
  if (els.language) els.language.hidden = bare || state.source === 'pixiv';
  const options = activeSorts();
  if (!options.some((item) => item.id === state.sort)) {
    // この表に無い並びだった: 既定へ落とす。**落とした値は覚えない** —
    // 覚えると、往復しただけで既定が書き換わる (rememberSort の註)
    state.sort = defaultSortId(options, state.source, state.scope);
  }
  fillSelect(els.sort, options, state.sort);
  fillSortDir();
  fillPawBulk();
  const placeholders = {
    home: '作者名・作品名・タグ・キャプション',
    hitomi: '作品名・タグ・URL',
    nhentai: '作品名・タグ・URL',
    ehentai: '作品名・タグ・URL',
    pawchive: '作者名・URL',
    pixiv: 'タグ・タイトル・キャプション / user:ID / URL',
  };
  if (pawLibraryScope()) {
    els.query.placeholder = '所持作品を検索  /  作者  /  タイトル';
  } else if (library) {
    els.query.placeholder = '所持作品を検索  /  タイトル  /  作者  /  タグ';
  } else {
    els.query.placeholder = placeholders[state.source] || placeholders.hitomi;
  }
  applyHideAi();
  // Home の顔 (道具の出し入れ・作者頁) を源泉と語に合わせる。一覧の差し替えは検索の返りを待つ
  window.BunkoHome?.sync(false);
}

// サイトを移る時に検索語を持ち運ぶ。運べない語は消す。
// **残すほうが危ない**: 相手に無い名前空間は 0 件で済むが、裸の数字や
// 「作者/利用者」形はサイトごとに別の物を指すので、黙って別の作品を一件返す。
// 判じの本体は sources/query-port (母屋と共有。renderer に写しを置かない)
const pixivAuthorNames = new Map();
const portableAuthorLabels = new Map();
const portableCreatorQueries = new Map();
const searchSelections = new Map();
let queryJourney = null;
let searchIntent = null;
const queryPlans = new Map();
let activeSearchPlan = null;
let queryDraftEdited = false;
let sourceTransitionEpoch = 0;
const siteSearchSnapshots = new Map();
// 棚の中身が今の state (スコープ・サイト) の物でない間は true (setScope の search=false の後)。
// 引き直しが始まるか写しを戻した時に下りる。立っている間はサイト替えの写しに取らない
let searchViewStale = false;
function invalidateSearchIntent() {
  searchIntent = null;
  queryJourney = null;
  queryPlans.clear(); activeSearchPlan=null;
  siteSearchSnapshots.clear();
  sourceTransitionEpoch++;
}
function captureSearchView() {
  for (const gallery of state.galleries) {
    if (gallery.source === 'pixiv' && gallery.userId) {
      const name=gallery.kind==='creator' ? gallery.title : gallery.artists?.[0]?.name;
      if (name) pixivAuthorNames.set(String(gallery.userId),name);
    }
    for (const tag of gallery.artists || []) {
      if (tag.name && tag.label) portableAuthorLabels.set(`artist:${tag.name.replaceAll(' ','_')}`,tag.label);
    }
  }
  while (pixivAuthorNames.size>256) pixivAuthorNames.delete(pixivAuthorNames.keys().next().value);
  while (portableAuthorLabels.size>256) portableAuthorLabels.delete(portableAuthorLabels.keys().next().value);
  return {...Object.fromEntries(pixivTabFields.map(k => [k,state[k]])), scope:state.scope, language:state.language,
    excludedTypes:[...state.excludedTypes], discovery:state.discovery, shelf:pixivShelfView,
    pixivTab:state.pixivTab, scroll:window.scrollY};
}
function restoreSearchView(saved) {
  for (const key of pixivTabFields) state[key]=saved[key];
  state.loading=false;state.discovery=!!saved.discovery;searchViewStale=false;
  els.query.value=state.query;syncQueryClear();renderSources();renderTypes();
  // Home の作者頁を畳む/並べるのは一覧を描く前 (畳まれた器で Waterfall が幅 0 の段を組まないように)
  window.BunkoHome?.sync(true);
  if (saved.shelf && state.discovery) renderPixivDiscovery(saved.shelf);
  else {renderGrid();renderResultInfo(state.interpreted || []);}
  setStatus('');window.scrollTo(0,saved.scroll||0);window.BunkoUI?.sync();
}
// Home と源泉の行き来。Home は語の旅に加わらない (作者名や @作者 は源泉の語ではない)。
//   from  Home へ入る前に居た源泉と、その語と種別 (Home を出る時はそこから移ったものとして運ぶ)
//   query Home を出た時の Home の語 (戻った時に同じ一覧・同じ作者頁から続ける)
const homeTrip = { from: null, query: '' };

function portQueryInto(from, to, context = {}) {
  if (from === to) return;
  state.type = '';
  state.excludedTypes = [];
  // Home の語は持ち運ばない。入る時は Home の前の語、出る時は旅の控えにある行き先の語
  // (旅の控えは Home に居る間も残してある。行き先の語が無ければ空から)
  if (from === 'home' || to === 'home') {
    state.query = to === 'home' ? homeTrip.query : (queryJourney?.[to] ?? '');
    activeSearchPlan = to === 'home' ? null : (queryPlans.get(to) || null);
    els.query.value = state.query;
    syncQueryClear();
    return;
  }
  if (!state.query && !searchIntent) { queryJourney = null; activeSearchPlan=null; return; }
  if (!queryJourney || queryJourney[from] !== state.query) { searchIntent=null; queryPlans.clear(); queryJourney = { [from]: state.query }; }
  const ported = !context.refresh && queryJourney[to] !== undefined ? (queryPlans.get(to) || {query: queryJourney[to], dropped: []}) : window.hitomi.portQuery(state.query, from, to, {...context, retainIntent:true, intent:searchIntent, selections:Object.fromEntries(searchSelections), pixivAuthors: {...Object.fromEntries(pixivAuthorNames), ...context.pixivAuthors}, labels: {...Object.fromEntries(portableAuthorLabels), ...context.labels}, creatorQueries: {...Object.fromEntries(portableCreatorQueries),...context.creatorQueries}});
  if (ported?.intent) searchIntent = ported.intent;
  if (ported) {queryJourney[to] = ported.query;queryPlans.set(to,ported);activeSearchPlan=ported;}
  if (!ported) return;
  state.query = ported.query;
  els.query.value = state.query;
  syncQueryClear();
  const lost = (ported.dropped || []).length;
  // 知らせるのは既にある toast だけ。帯や札を足すと高さが動いてガタつく
  if (lost && !context.silent) toast(`このサイトで使えない条件 ${lost} 件は、他サイト用に保持しています`);
}

function showSearchResolution() {
  const issue=activeSearchPlan?.unresolved?.[0];
  if(!issue) {setStatus('このサイトで使える検索条件がありません。別のサイトに切り替えると条件を引き継げます。');return;}
  const reason=issue.status==='unavailable' ? '対応を確認できませんでした' : issue.status==='ambiguous' ? '対応を一つに決められません' : '対応するタグが見つかりません';
  setStatus(`「${issue.raw}」：${reason}。検索欄で候補を選ぶか、検索語を編集してください。`);
  const start=state.query.indexOf(issue.raw);
  if(start<0) return;
  const candidates=(issue.candidates || []).map((candidate,index)=>{
    const token=`${candidate.type}:${String(candidate.name).replace(/\s+/g,'_')}`;
    const converted=window.hitomi.portQuery(token,'hitomi',state.source,{labels:{[token]:candidate.label || ''}});
    const value=(issue.raw.startsWith('-')?'-':'')+(converted?.query || token);
    return {...candidate,value,label:candidate.label || candidate.name,_input:state.query,_range:{start,end:start+issue.raw.length},
      term:{type:candidate.type,name:candidate.name,label:candidate.label,native:{[state.source]:value}}};
  });
  if(candidates.length) renderSuggest(candidates);
}

// 所持へ入る時に、所持の裏付けが無いサイト (nhentai など) から hitomi へ自動で移した時の元のサイト。
// 所持から出る時、その間に利用者がサイトを替えていなければ元へ戻す (往復しただけで hitomi に居残っていた)
let libraryDetour = null;

// search=false: スコープだけ替えて引き直さない (直後にサイトを移る時。所持から nhentai へ押すと、
// まず hitomi の全体を引いてから nhentai へ移っていたので、その間 (1 秒ほど) 所持の棚と回る印が残った)。
// その時は元のサイトへ戻す約束 (libraryDetour) も使わない: 行き先は押した札が決める
async function setScope(next, { search = true } = {}) {
  if (state.scope === next) return;
  // 出ていくスコープの並びを控え、入る側の並びを引き直す。サイトを移る時
  // (els.source の change) と同じ作法。これが無いので、所持作品へ寄って戻る
  // だけで web 側の 人気・今日 が 追加日 に化けていた
  rememberSort();
  const prevSource = state.source;
  const originalQuery = state.query;
  state.scope = next;
  const detour = libraryDetour;
  libraryDetour = null;
  if (search && next !== 'library' && detour && state.source === detour.to) state.source = detour.from;
  // 所持作品の札 (PIXIV_TYPES) は種類と対象を重ねない: 種類の方を残す
  if (next === 'library' && /^(manga|ai)-r18$/.test(state.type)) state.type = pixivTypeParts(state.type).kind;
  state.sort = sortForSource(state.source, next);
  // 所持作品では nhentai/ehentai が裏付けを持たないので renderSources が
  // hitomi へ差し替える。利用者から見れば移ったのと同じなので語も運ぶ
  renderSources();
  if (next === 'library' && state.source !== prevSource) libraryDetour = { from: prevSource, to: state.source };
  if (state.source !== prevSource) {
    const destination=state.source, transition=++sourceTransitionEpoch;
    const transitionSearchEpoch=++searchEpoch;
    portQueryInto(prevSource,destination,{silent:true});
    const portedQuery=state.query;
    if (originalQuery && window.hitomi.searchAuthorContext) {
      try {
        const context=await window.hitomi.searchAuthorContext({query:originalQuery,from:prevSource,to:destination,intent:searchIntent,selections:Object.fromEntries(searchSelections)});
        if (transition!==sourceTransitionEpoch || searchEpoch!==transitionSearchEpoch || state.source!==destination || state.query!==portedQuery) return;
        state.query=originalQuery;
        portQueryInto(prevSource,destination,{...context,refresh:true});
      } catch {
        if (transition!==sourceTransitionEpoch || searchEpoch!==transitionSearchEpoch || state.source!==destination || state.query!==portedQuery) return;
        if(searchIntent?.terms.some(term=>term.kind==='tag')) {
          activeSearchPlan={...activeSearchPlan,blocked:true,unresolved:searchIntent.terms.filter(term=>term.kind==='tag').map(term=>({raw:term.raw,status:'unavailable'}))};
          queryPlans.set(destination,activeSearchPlan);
        }
      }
    }
  }
  renderTypes();
  fillHideOwnedToggle();
  fillFavToggle();
  hideSuggest();
  persistSession();
  if (!search) {
    // 棚に並んでいるのは前のスコープの物: 次のサイト替えで写し (siteSearchSnapshots) に取らない
    searchViewStale = true;
    return;
  }
  await runSearch({ reset: true });
}

// 除外は正規化して常にソート済み配列で持つ: 履歴/ピンの一致判定を壊さないため
function normalizeExcludedTypes(list) {
  return [...new Set((list || []).filter(Boolean))].sort();
}

// 除外は hitomi ソースと所持作品スコープでのみ意味を持つ
function typeExclusionSupported() {
  if (pawLibraryScope()) return false;
  return libraryScope() || state.source === 'hitomi';
}

function renderTypes() {
  queueMicrotask(() => window.BunkoUI?.sync());
  // 種別が AI に入る・出ると AI の札の伏せ方が変わる (aiHiddenNow)
  if (els.grid) els.grid.classList.toggle('hide-ai', aiHiddenNow());
  const supported = typeExclusionSupported();
  // Home の種別は「ホーム」だけ (前の会の控えや足跡に残った pixiv などの種別は外す)
  if (state.source === 'home' && state.type) state.type = '';
  els.types.innerHTML = typesFor().map((item) => {
    const excluded = supported && item.id !== '' && state.excludedTypes.includes(item.id);
    const classes = ['chip'];
    if (item.id === state.type) classes.push('active');
    if (excluded) classes.push('excluded');
    const title = item.id ? (excluded ? '右クリックで除外解除' : '右クリックで除外') : '';
    return `<button type="button" class="${classes.join(' ')}" data-type="${item.id}"${title ? ` title="${title}"` : ''}>${item.label}</button>`;
  }).join('')
  // 「アニメ」の跡地。type ではなくビューの切り替え: 新作の見張りと発掘。
  // Home には出さない (発見の新作は作者の見出しの「新 N」が言う)
  + (state.source === 'home' ? '' : `<button type="button" class="chip chip-discover${state.discovery ? ' active' : ''}" data-view="discovery" title="${state.source === 'pixiv' ? 'おすすめの作者と投稿 (pixiv)' : '新作の見張りと発掘'}">発見</button>`);
}

function sessionPayload() {
  return {
    query: state.query,
    source: state.source,
    scope: state.scope,
    sort: state.sort,
    pixivPeriod: state.pixivPeriod,
    language: state.language,
    type: state.type,
    excludedTypes: state.excludedTypes,
    zoom: state.zoom,
    scroll: window.scrollY,
    loadedPages: state.page,
    scrollAnchor: currentScrollAnchor(),
  };
}

let sessionTimer = 0;
function persistSession() {
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => {
    window.hitomi.saveSettings({ session: sessionPayload() });
  }, 400);
}

function historyKey(entry) {
  return [
    entry.scope || 'all',
    entry.source || '',
    entry.query || '',
    entry.sort || '',
    entry.source === 'pixiv' ? entry.pixivPeriod || 'year' : '',
    entry.language || '',
    entry.type || '',
    normalizeExcludedTypes(entry.excludedTypes).join(','),
  ].join('\t');
}

function rememberHistory() {
  const entry = {
    query: state.query,
    source: state.source,
    scope: state.scope,
    sort: state.sort,
    pixivPeriod: state.pixivPeriod,
    language: state.language,
    type: state.type,
    excludedTypes: state.excludedTypes,
  };
  persistSession();
  if (!entry.query && !entry.type && !entry.excludedTypes.length) {
    renderRecents();
    return;
  }
  const key = historyKey(entry);
  const next = (state.settings.searchHistory || []).filter((item) => historyKey(item) !== key);
  next.unshift(entry);
  state.settings.searchHistory = next.slice(0, 20);
  window.hitomi.saveSettings({ searchHistory: state.settings.searchHistory, session: sessionPayload() });
  renderRecents();
}

function isPinned(entry) {
  return (state.settings.searchPins || []).some((item) => historyKey(item) === historyKey(entry));
}

function findSavedSearch(kind, index) {
  if (kind === 'p') return (state.settings.searchPins || [])[Number(index)] || null;
  return (state.settings.searchHistory || []).filter((item) => !isPinned(item))[Number(index)] || null;
}

function togglePin(entry) {
  const key = historyKey(entry);
  let pins = state.settings.searchPins || [];
  if (pins.some((item) => historyKey(item) === key)) {
    pins = pins.filter((item) => historyKey(item) !== key);
  } else {
    pins = [entry, ...pins].slice(0, 5);
  }
  state.settings.searchPins = pins;
  window.hitomi.saveSettings({ searchPins: pins });
  renderRecents();
}

function applySavedSearch(entry) {
  if (!entry) return;
  // 前の画面の名残 (サジェスト・詳細・リーダー) を閉じてから条件を差し替える。
  // 残したままだと、新しい結果に居ない作品の詳細や金枠が残る
  hideSuggest();
  if (Reader.isOpen()) Reader.close();
  if (!els.detail.hidden) {
    state.selected = null;
    renderDetail(null);
  }
  state.query = entry.query || '';
  // 並びから外した源泉 (E-Hentai) の札は hitomi で引き直す
  state.source = shownSourceOr(entry.source || 'hitomi');
  state.scope = entry.scope === 'library' ? 'library' : 'all';
  state.sort = entry.sort || sortForSource(state.source);
  state.pixivPeriod = entry.pixivPeriod || 'year';
  state.language = entry.language || '';
  state.type = entry.type || '';
  state.excludedTypes = normalizeExcludedTypes(entry.excludedTypes);
  els.query.value = state.query;
  renderSources();
  renderTypes();
  fillHideOwnedToggle();
  fillFavToggle();
  fillSelect(els.language, LANGUAGES, state.language);
  runSearch({ reset: true });
}

function recentLabel(entry) {
  if (entry.query) return entry.query;
  if (entry.type) return entry.type;
  return '最新';
}

function renderRecents() {
  if (!els.recents) return;
  const pins = state.settings.searchPins || [];
  const chips = pins.map((item, index) => ({ item, kind: 'p', index, pin: true }));
  els.recents.hidden = chips.length === 0;
  els.recents.innerHTML = chips.map((chip) => `
    <div class="recent${chip.pin ? ' pin' : ''}">
      <button type="button" data-apply="${chip.kind}-${chip.index}">${escapeHtml(recentLabel(chip.item))}</button>
      <button type="button" data-star="${chip.kind}-${chip.index}" title="${chip.pin ? 'ピンを外す' : 'ピン'}">${chip.pin ? '★' : '☆'}</button>
    </div>
  `).join('');
}

// 「この札は今伏せられているか」の判定はここ一本。
// 以前は四通り (件数の数え・棚の漉し・該当なしの文・CSS) に散っていて、
// 所持済みを隠すモードで棚が一枚も出ないのに理由も出ない、という穴があった (項目 4-1)
function hideMode() {
  return libraryScope() ? 'none' : hideOwnedMode();
}

// 題だけで 済 になっている札 (ID が確定していない)。Eagle に同じ題の
// 未照合アイテムが居ると、網の作品がこれになる
function titleOnlyOwned(gallery) {
  return Boolean(gallery && gallery.owned && !gallery.idOwned);
}

// pixiv の AI 生成を伏せる設定 (網と所持棚の両方)
function hideAiEnabled() {
  return (state.settings || {}).pixivHideAi === true;
}

// 網の pixiv の投稿を読み手で原寸で読む設定 (既定は原寸。切ると 1200 px の webp。落とす時は常に原寸)
// 所持の埋め戻しの進み (設定の行)。走っている間は釦が「止める」になる
function paintAiMetaBackfill(status) {
  if (!els.setAiMetaCount || !els.setAiMetaBackfill) return;
  const s = status || null;
  els.setAiMetaCount.textContent = s
    ? `${s.done} / ${s.total} (あり ${s.found}${s.failed ? ` · 失敗 ${s.failed}` : ''})${s.running ? ' …' : ''}`
    : '';
  els.setAiMetaBackfill.textContent = s && s.running ? '止める' : '確かめる';
  els.setAiMetaBackfill.hidden = Boolean((state.settings || {}).readOnly);
}

// aitag.win (第三者) に AI 作品の生成情報を訊く。既定オン (2026-10-18 利用者)。切ると札の印は出ず、板は原寸から自前で読む
function aitagEnabled() {
  return (state.settings || {}).aitagEnabled !== false;
}

function readOriginalEnabled() {
  return (state.settings || {}).pixivReadOriginal !== false;
}

// 今の棚で AI 生成を伏せるか。pixiv の種別が AI の時は種別が勝つ (伏せたままでは棚が必ず空になる)
function aiHiddenNow() {
  if (!hideAiEnabled()) return false;
  return !(state.source === 'pixiv' && pixivTypeParts(state.type).kind === 'ai');
}

function applyHideAi() {
  if (els.grid) els.grid.classList.toggle('hide-ai', aiHiddenNow());
  // Home の作者頁は一覧の器の外に並ぶ: 変わっていれば描き直す (変わっていなければ何もしない)
  window.BunkoHome?.refresh?.();
}

function isCardHidden(gallery, mode = hideMode()) {
  if (!gallery || gallery.error) return false;
  // AI 生成は所持の伏せ方とは独立に伏せる (pixiv の札だけが旗を持つ)
  if (gallery.ai === true && aiHiddenNow()) return true;
  if (mode === 'none') return false;
  // **題だけの 済 は伏せない。** ID が確定していない = まだ本当に同じ物か
  // 分かっていない、という札で、確かめる手立て (鎖) はその札の詳細にしか無い。
  // 伏せると「Eagle に持っているのに網の一覧から消え、紐付ける口も消える」に
  // なる — 所持済みを隠す設定では実際そうなっていた。
  // 紐付ければ idOwned が立ち、次からはちゃんと伏せられる
  if (titleOnlyOwned(gallery)) return false;
  // **ID で確かな所持 (Eagle に在る物) は版違いの伏せ方では伏せない。** 同じ作品を
  // 二版とも持っていると、束ねは二冊目に「重」を立てる (代表は一冊だけ)。それで伏せると
  // Eagle に在るのに一覧から消える。伏せるのは所持を隠す時だけ
  if (gallery.owned) return mode === 'owned';
  return Boolean(gallery.similarOwned || gallery.dupeHidden);
}

// 今の表示モードで伏せられている札の数 (読み込み済みのぶんだけ)。
// 全体の総数はサーバー側の数字なので、伏せた後の「真の総数」は分からない:
// 件数はそのまま出し、伏せている数を添える
function hiddenCardCount() {
  const mode = hideMode();
  if (mode === 'none' && !aiHiddenNow()) return 0;
  return state.galleries.filter((item) => isCardHidden(item, mode)).length;
}

function renderResultInfo(interpreted) {
  if (!interpreted) {
    els.resultInfo.hidden = true;
    els.resultInfo.innerHTML = '';
    els.resultInfo.removeAttribute('title');
    return;
  }
  const count = Number(state.total) || 0;
  const hidden = hiddenCardCount();
  // 伏せている札があるときは「見えている数」を主役に、総数を括弧へ。
  // 見えている数は読み込み済みのぶんから数える (追い読みで増えていく)
  const visible = Math.max(0, state.galleries.filter((item) => item && !item.error).length - hidden);
  const head = hidden
    ? `${visible.toLocaleString()}件 (${state.approximate ? '約' : '全'} ${count.toLocaleString()} 件)`
    : `${state.approximate ? '約' : '全'} ${count.toLocaleString()} 件`;
  // 相手の都合で途中までしか見ていないなら、そう言う
  const cut = Number(state.truncated) > 0
    ? ` · 先頭 ${Number(state.truncated).toLocaleString()} 投稿までで打ち切り`
    : '';
  const rules = (interpreted || [])
    .filter((item) => item && item.from && item.to)
    .map((item) => `${item.from} → ${item.to}`);
  const note = state.searchNotice ? ` · ${state.searchNotice}` : '';
  els.resultInfo.innerHTML = `<span>${escapeHtml(head + cut + note)}</span>${rules.length
    ? `<span class="interpreted">${escapeHtml(rules.join(' / '))}</span>`
    : ''}`;
  if (rules.length) els.resultInfo.title = rules.join('\n');
  else els.resultInfo.removeAttribute('title');
  if (window.BunkoUI) {
    // Home の一覧は人 (作者) だけを並べる: 0 人でも「人」で数える
    const unit = (state.source === 'home' && !libraryScope())
      || (state.galleries.length && state.galleries.every(item => item.kind === 'creator' && !item.pinnedCreator)) ? '人' : '冊';
    els.resultInfo.innerHTML = `<span>${state.approximate ? '約' : ''}${(hidden ? visible : count).toLocaleString()}<small>${unit}</small></span>`;
    els.resultInfo.title = [head + cut + note, ...rules].join('\n');
    els.resultInfo.setAttribute('aria-label', head + cut + note);
  }
  els.resultInfo.hidden = false;
}

// 母屋の誤りは IPC の包み紙 ("Error invoking remote method 'search': Error: …") を
// 被って来る。利用者に見せるのは中の一文だけ
function ipcErrorText(message) {
  return String(message || '')
    .replace(/^Error invoking remote method '[^']+':\s*/, '')
    .replace(/^Error:\s*/, '')
    .trim();
}

function setStatus(text, isError = false, busy = false) {
  els.status.hidden = !text;
  els.status.textContent = text;
  els.status.classList.toggle('error', isError);
  els.status.classList.toggle('busy', busy && !isError);
}

// 読み取り専用モード (--read-only 起動)。実効値は main が settings に添えてくる
function readOnlyMode() {
  return (state.settings || {}).readOnly === true;
}

// 書き込みの釦・欄をまとめて引っ込める (実際に塞ぐのは main 側の IPC ガード)。
// 隠し分けは styles.css の body.read-only 一式が受け持つ
function applyReadOnly() {
  if (!readOnlyMode()) return;
  document.body.classList.add('read-only');
  // 取り込みの設定タブは丸ごと用済みなので釦ごと外す (中身は styles.css が伏せる)
  document.querySelector('.settings-tab[data-tab="download"]')?.remove();
}

// Home の一覧を、突き合わせで決められなかった候補を持つ作者だけにする (設定の棚。母屋の search に unresolvedOnly で渡す)
function homeUnresolvedOnly() {
  return (state.settings || {}).homeUnresolvedOnly === true;
}

function openOwnedPrefersEagle() {
  return (state.settings || {}).openOwned === 'eagle';
}

function openOwnedUsesEagle(gallery) {
  if (!gallery?.eagleId) return false;
  // Eagle アイテム (pawchive の所持・未照合) の原本も母屋が読めるようになったので、
  // どの所持作品も設定どおり: 既定はこのアプリの読み手、望めば Eagle
  return openOwnedPrefersEagle();
}

// Eagle アイテムの頁数は名前の【17P】頼みで、無い本も原本と食い違う本もある。
// 母屋は綴じ目から本当の数を出せるので、開く直前に訊き直す (中央 14 ms)。
// hitomi の作品は網に訊きに行くことになるので対象外 (頁数は台帳が正しく持っている)
async function withPageCount(gallery) {
  if (!gallery || gallery.kind !== 'eagleItem') return gallery;
  try {
    const full = await window.hitomi.gallery(gallery.id);
    if (full && !full.error && Number(full.pageCount) > 0) {
      return { ...gallery, pageCount: full.pageCount };
    }
  } catch {
    // 訊けなければ札のまま開く (読み手が原本を自分で開く道に落ちる)
  }
  return gallery;
}

async function openOwnedWork(gallery) {
  if (!gallery || gallery.error) return;
  if (openOwnedUsesEagle(gallery)) {
    window.hitomi.openEagle(gallery.eagleId);
    return;
  }
  Reader.open(await withPageCount(gallery));
}

// 未評価 (星なし / 0) は札を出さない: 「まだ点けていない」と「低い」は別のこと
function starBadge(gallery) {
  const star = Math.round(Number(gallery && gallery.star)) || 0;
  if (star <= 0) return '';
  return `<span class="star-mark">★${star}</span>`;
}

// pw:<service>:<user>:<postId|profile> から作者を取り出す。pawchive 以外は null
function pawCreatorOf(gallery) {
  if (!gallery || gallery.source !== 'pawchive') return null;
  // Eagle アイテム (pweagle:...) は service/user を持たない: 札の対象外
  if (gallery.kind === 'eagleItem') return null;
  const parts = String(gallery.id || '').split(':');
  if (parts[0] !== 'pw' || !parts[1] || !parts[2]) return null;
  return { service: parts[1], user: parts[2] };
}

// Eagle が持ち主の行。読む・保存・詳細取得のどれも当てはまらない
function isEagleItem(gallery) {
  return Boolean(gallery && gallery.kind === 'eagleItem' && gallery.eagleId);
}

function pawFavKey(creator) {
  return `${creator.service}:${creator.user}`;
}

// ★ は作者に付ける印。投稿の札には出さない (作者一覧でだけ意味を持つ)
function pawFavButton(gallery) {
  if (!gallery || gallery.kind !== 'creator') return '';
  const creator = pawCreatorOf(gallery);
  if (!creator) return '';
  const on = state.pawFavs.has(pawFavKey(creator));
  const label = on ? 'お気に入りから外す' : 'お気に入りに追加';
  const heart = pawHeart(on);
  return `<button type="button" class="card-act paw-fav${on ? ' is-on' : ''}" data-act="paw-fav" title="${label}" aria-label="${label}" aria-pressed="${on}">${heart}</button>`;
}

function pawHeart(on) {
  return svgIcon(`<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z"${on ? ' fill="currentColor"' : ''}/>`);
}

// pw:<service>:<user>:<postId>。作者の札と Eagle アイテムは投稿ではないので null
function pawPostOf(gallery) {
  if (!gallery || gallery.source !== 'pawchive' || gallery.error) return null;
  if (gallery.kind === 'creator' || gallery.kind === 'eagleItem') return null;
  const parts = String(gallery.id || '').split(':');
  if (parts[0] !== 'pw' || parts.length < 4) return null;
  const [, service, user, postId] = parts;
  if (!service || !user || !postId || postId === 'profile') return null;
  return { service, user, postId };
}

// 作者の呼び名。作者札は題がそのまま名前、投稿札は作者欄しか手がかりが無い
function pawCreatorName(gallery) {
  if (!gallery) return '';
  if (gallery.kind === 'creator') return String(gallery.title || '');
  return String(gallery.artists?.[0]?.name || gallery.artists?.[0]?.label || '');
}

// 鎖 = pawchive の投稿を Eagle のアイテムに手で結ぶ。
// 投稿 ID で自動的に当たっている作品には出さない (触らせる先が無い)
function pawLinkButton(gallery) {
  if (!pawPostOf(gallery)) return '';
  if (gallery.owned && !gallery.linkedEagleId) return '';
  const on = Boolean(gallery.linkedEagleId);
  const label = on ? '紐付けを解除' : '所持アイテムと紐付ける';
  return `<button type="button" class="card-act paw-link${on ? ' is-on' : ''}" data-act="paw-link" title="${label}" aria-label="${label}">${on ? ICON.unlink : ICON.link}</button>`;
}

// 作者 → Eagle のフォルダ。決めておくと投稿の紐付けがその中だけで済む
function pawFolderButton(gallery) {
  if (!gallery || gallery.kind !== 'creator' || !pawCreatorOf(gallery)) return '';
  return `<button type="button" class="card-act paw-folder" data-act="paw-folder" title="Eagle のフォルダと対応付ける" aria-label="Eagle のフォルダと対応付ける">${ICON.folder}</button>`;
}

// 対応付けが付いている作者に小さな印。中身は stampCreatorFolders が後から入れる
function folderBadge(gallery) {
  if (!gallery || gallery.kind !== 'creator' || !pawCreatorOf(gallery)) return '';
  return '<span class="folder-mark" hidden></span>';
}

// 作者 → creator-of の返答の控え。同じ作者へ IPC を投げ直さないための memo。
// 返答が変わる契機は手動の対応付け (pawMapCreator) だけなので、そこで捨てる
const creatorFolderMemo = new Map();

// 作者札のフォルダ印を引き直す。走査は主側の持ち物なので聞くしかない。
// 押印が済んだ印には data-stamped を付け、次回の走査から外す:
// 追い読みで札が増えても、増えたぶんだけ聞けば済む (root で 1 枚に絞ることもできる)
async function stampCreatorFolders(root) {
  const marks = [...(root || els.grid).querySelectorAll('.card[data-id] .folder-mark:not([data-stamped])')];
  if (!marks.length) return;
  await Promise.all(marks.map(async (mark) => {
    const card = mark.closest('.card[data-id]');
    // 引き直している間に棚が組み変わると、印だけ残って親の札が居ないことがある
    if (!card) return;
    const gallery = findGallery(card.dataset.id);
    const creator = pawCreatorOf(gallery);
    if (!creator) return;
    const key = `${creator.service}:${creator.user}:${pawCreatorName(gallery)}`;
    let pending = creatorFolderMemo.get(key);
    if (!pending) {
      pending = pawLinksCall({
        action: 'creator-of',
        service: creator.service,
        user: creator.user,
        name: pawCreatorName(gallery),
      });
      creatorFolderMemo.set(key, pending);
    }
    const reply = await pending;
    if (!reply) {
      // 失敗は控えに残さない: 次の走査で聞き直せるように
      if (creatorFolderMemo.get(key) === pending) creatorFolderMemo.delete(key);
      return;
    }
    if (!mark.isConnected) return;
    mark.dataset.stamped = '1';
    const hit = reply.creator;
    if (!hit || !hit.folderId) return;
    mark.hidden = false;
    mark.classList.toggle('is-guess', hit.origin === 'guess');
    mark.innerHTML = ICON.folderShow;
    mark.title = hit.origin === 'guess'
      ? `フォルダ候補: ${hit.name}（名前から推測）`
      : `対応フォルダ: ${hit.name}`;
  }));
}

// 対応付けが手で変わったあとの引き直し: 控えと押印済みの印を捨てて全札を押し直す
function restampCreatorFolders() {
  creatorFolderMemo.clear();
  els.grid.querySelectorAll('.folder-mark[data-stamped]').forEach((mark) => {
    delete mark.dataset.stamped;
  });
  stampCreatorFolders();
}

async function refreshPawFavs() {
  try {
    const result = await window.hitomi.pawFavorites({ action: 'list' });
    state.pawFavs = new Set((result?.list || []).map((item) => `${item.service}:${item.user}`));
  } catch {
    // 一覧が引けなければ札は消えたままにする: 誤った ★ を出すよりまし
  }
}

// 押した札だけ描き替える: 一覧ごと作り直すと読み位置が飛ぶ
function paintPawFavButtons() {
  els.grid.querySelectorAll('.card[data-id] .paw-fav').forEach((button) => {
    const card = button.closest('.card[data-id]');
    const parts = String(card?.dataset.id || '').split(':');
    if (parts[0] !== 'pw') return;
    const on = state.pawFavs.has(`${parts[1]}:${parts[2]}`);
    const label = on ? 'お気に入りから外す' : 'お気に入りに追加';
    button.classList.toggle('is-on', on);
    button.setAttribute('aria-pressed', String(on));
    button.title = label;
    button.setAttribute('aria-label', label);
    button.innerHTML = pawHeart(on);
  });
}

async function togglePawFav(id) {
  const gallery = findGallery(id) || { id, source: 'pawchive' };
  const creator = pawCreatorOf({ ...gallery, source: 'pawchive' });
  if (!creator) return;
  try {
    const result = await window.hitomi.pawFavorites({ action: 'toggle', ...creator });
    state.pawFavs = new Set((result?.list || []).map((item) => `${item.service}:${item.user}`));
    // お気に入り一覧を見ている最中なら、外した作者はその場から消えるべき
    if (state.source === 'pawchive' && state.sort === 'favorites' && !result?.favorited) {
      await runSearch({ reset: true });
      return;
    }
    paintPawFavButtons();
  } catch (error) {
    toast('お気に入りを更新できませんでした', { type: 'error' });
  }
}

// 表紙の代わり。壊れた画像の記号は「壊れたファイル」に見えるので出さない
function coverBlank() {
  return `<span class="cover-blank" aria-hidden="true">${ICON.image}</span>`;
}

// 最初から画像が無いと分かっている札は、取りに行かずに代わりを描く。
// 作者の札は最初の投稿から表紙を引くので、頁数 0 でも画像はある
function coverIsEmpty(gallery) {
  if (gallery.source !== 'pawchive' || gallery.kind === 'creator') return false;
  // Eagle アイテムの表紙はライブラリの中にある: 頁数が分からなくても絵は出せる
  if (isEagleItem(gallery)) return false;
  return !gallery.pageCount;
}

function coverMedia(gallery) {
  if (coverIsEmpty(gallery)) return coverBlank();
  // 札は 168px〜250px 超に伸びる。small (〜150px 幅) では引き伸ばしでぼやける
  // decoding=async: 送りで見えてきた表紙の復号を主スレッドの描画から外す (作者頁の送りで JS が無いのにこまが落ちていた)
  return `<img src="${imgUrl(gallery.id, 0, 'big')}" alt="" loading="lazy" decoding="async" />`;
}

// 読み込みに失敗した表紙も同じ代わりに差し替える。
// error は上がってこないので捕捉相で受ける (CSP のため onerror 属性は使えない)
function swapCoverBlank(img) {
  const cover = img.closest('.cover');
  // 扇: 後ろの二枚は黙って外す (絵のある投稿が一本や二本の作者)。正面は扇の形のまま空の札に
  if (img.classList.contains('home-fan-card')) {
    if (img.classList.contains('is-front')) img.insertAdjacentHTML('afterend', `<span class="home-fan-card is-front is-blank">${coverBlank()}</span>`);
    img.remove();
    return;
  }
  if (!cover || cover.querySelector('.cover-blank')) return;
  img.remove();
  cover.insertAdjacentHTML('afterbegin', coverBlank());
}

// フォロー (pixiv の作者の札)。頁数の席に字の釦で出す (作者の札に頁数は無い)。pixiv 側に書く
function pixivFollowMarkup(gallery) {
  if (!gallery || gallery.source !== 'pixiv' || gallery.kind !== 'creator' || !gallery.userId) return '';
  const on = gallery.following === true;
  const label = on ? 'フォローを外す (pixiv)' : 'pixiv でフォローする';
  return `<button type="button" class="px-follow${on ? ' is-on' : ''}" data-follow="${escapeHtml(String(gallery.id))}" aria-pressed="${on}" title="${label}">${on ? 'フォロー中' : 'フォロー'}</button>`;
}

// 札の右下の字 (頁数の隣)。pixiv の旗はここに置く: 角の印は小さい段で読めない (§15 U7)。
// 源泉の印は、見ている源泉と違う時だけ (作者棚に pixiv の本が混ざる時)
function cardFlags(gallery) {
  const flags = [];
  if (gallery.source === 'pixiv' && state.source !== 'pixiv') flags.push('pixiv');
  if (gallery.ai === true) flags.push('AI');
  return flags.length ? ` · ${flags.join(' · ')}` : '';
}

// 表紙の右上の数の印 (重ねた紙の絵 + 数)。頁数のほか、Home の作者の見出しが所持の冊数に使う
function countBadge(count, label) {
  return `<span class="page-count-badge" aria-label="${escapeHtml(label)}"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 17h8a2 2 0 0 0 2-2V7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><rect x="2" y="2" width="12" height="12" rx="2" fill="currentColor"/></svg><span>${count}</span></span>`;
}

function pageCountBadge(gallery) {
  const count = Number(gallery?.pageCount);
  if (gallery?.kind === 'creator' || !Number.isSafeInteger(count) || count <= 1) return '';
  return countBadge(count, `${count}ページ`);
}

// 詳細の表紙の枠を、絵が届く前から縦横比で取る。高さを絵の到着で決めると、その下の題・釦・札が
// 全部ずれていた (pixiv で開いて 0.1〜0.2 秒後に 4〜7px)。比は項目の寸法、無ければ一覧で覚えた比。
// 分からなければ今までどおり (絵が決める)
function coverAspectStyle(gallery) {
  const w = Number(gallery?.width) || 0;
  const h = Number(gallery?.height) || 0;
  let ratio = w > 0 && h > 0 ? h / w : 0;
  if (!ratio && gallery) ratio = Number(window.BunkoUI?.coverRatio?.(`${gallery.source}:${gallery.id}`)) || 0;
  if (!(ratio > 0)) return '';
  ratio = Math.max(0.45, Math.min(2.2, ratio));
  return ` style="aspect-ratio:1 / ${ratio.toFixed(4)}"`;
}

function cardMarkup(gallery) {
  if (gallery.error) {
    return `<article class="card card-error">#${gallery.id}<br>${escapeHtml(gallery.error)}</article>`;
  }
  // Home の作者の見出し (人)。器は本体の作者の見出しと同じで、印の並べ方だけ Home が持つ
  if (gallery.source === 'home' && window.BunkoHome) return window.BunkoHome.cardMarkup(gallery);
  if (gallery.source === 'pixiv' && gallery.kind === 'creator') {
    const preview = gallery.previewId ? `<div class="cover"><img src="${imgUrl(gallery.previewId, 0, 'big')}" alt="" loading="lazy" /></div>` : '';
    return `<article class="card is-creator pixiv-creator-card${gallery.pinnedCreator ? ' pixiv-pinned-creator' : ''}" tabindex="0" role="button" data-id="${escapeHtml(gallery.id)}">${preview}<div class="card-body pixiv-creator-row"><img class="pixiv-avatar" src="${imgUrl(gallery.id, 0, 'small')}" alt="" loading="lazy" /><h3 class="card-title">${escapeHtml(gallery.title)}</h3>${pixivFollowMarkup(gallery)}</div></article>`;
  }
  if (gallery.source === 'pawchive' && gallery.kind === 'creator' && window.BunkoHome?.fanFromUrls) return pawFanCardMarkup(gallery);
  const artist = artistName(gallery);
  const ownedAct = openOwnedUsesEagle(gallery)
    ? `<button type="button" class="card-act" data-act="open-owned" title="Eagle で開く" aria-label="Eagle で開く">${ICON.feather}</button>`
    : `<button type="button" class="card-act" data-act="open-owned" title="読む" aria-label="読む">${ICON.book}</button>`;
  const primaryAct = gallery.owned
    ? ownedAct
    : `<button type="button" class="card-act" data-act="save" title="保存" aria-label="保存">${ICON.save}</button>`;
  // Eagle アイテムも走査で分かるぶん (作者・日付・評価) は詳細に出せる
  const detailAct = `<button type="button" class="card-act" data-act="detail" title="詳細" aria-label="詳細">${ICON.info}</button>`;
  return `
      <article class="card${gallery.kind === 'creator' ? ' is-creator' : ''}${gallery.owned ? ' owned' : ''}${gallery.similarOwned ? ' similar' : ''}${gallery.dupeHidden ? ' dupe' : ''}${gallery.ai === true ? ' ai' : ''}${gallery.ai === true && window.BunkoAiMeta?.markOf(gallery.id) === 'yes' ? ' has-prompt' : ''}" tabindex="0" role="button" data-id="${gallery.id}"${gallery.shape === 'wide' ? ' data-shape="wide"' : ''}>
        <div class="cover">
          ${coverMedia(gallery)}${pageCountBadge(gallery)}
          ${gallery.owned ? `<span class="owned-mark${titleOnlyOwned(gallery) ? ' loose-mark' : ''}"${titleOnlyOwned(gallery) ? ' title="題が一致しているだけ (ID 未紐付け)。詳細の鎖で確かめられる"' : ''}>済</span>` : ''}${gallery.similarOwned ? '<span class="owned-mark similar-mark">同</span>' : ''}${gallery.dupeHidden ? '<span class="owned-mark dupe-mark">重</span>' : ''}${starBadge(gallery)}${folderBadge(gallery)}
          <div class="card-acts">${gallery.unbindable && !gallery.owned ? '' : primaryAct}${detailAct}</div>
        </div>
        <div class="card-body">
          <div class="card-heading"><h3 class="card-title">${escapeHtml(gallery.title)}</h3>${gallery.kind === 'creator' ? `<span class="creator-actions">${pawFavButton(gallery)}${pawFolderButton(gallery)}</span>` : ''}</div>
          <p class="card-meta"><span class="card-artist">${gallery.kind === 'creator' ? '' : escapeHtml(artist)}</span><span class="card-pages">${escapeHtml((/^\d+\s*p$/i.test(gallery.badge || '') ? '' : gallery.badge || '') + cardFlags(gallery))}</span>${pixivFollowMarkup(gallery)}</p>
          ${gallery.reason ? `<p class="card-reason">${escapeHtml(discoveryReasonText(gallery.reason))}</p>` : ''}
        </div>
      </article>
    `;
}

// Pawchive の作者の見出し = Home の作者の見出しと同じ扇 (2026-09-27)。正面はこれまでの表紙。
// 後ろの二枚は、網の作者なら投稿一覧の二本目と三本目の絵 (同じ id の i=1・2、母屋の fetchProfileImage)、
// 所持の作者フォルダなら二冊目と三冊目 (paw-library の fan)。字は 名 + 釦 / 札 (網は最終更新日、作者フォルダは件数)。
// サービス名は出さない (利用者「日付だけ」2026-09-27)
function pawFanCardMarkup(gallery) {
  const id = String(gallery.id);
  const back = /^pw:[^:]+:[^:]+:profile$/.test(id)
    ? [imgUrl(id, 1, 'big'), imgUrl(id, 2, 'big')]
    : (Array.isArray(gallery.fan) ? gallery.fan : []).map((item) => imgUrl(item, 0, 'big'));
  const meta = gallery.badge ? `<span>${escapeHtml(gallery.badge)}</span>` : '';
  return `<article class="card is-creator home-fan paw-fan${gallery.owned ? ' owned' : ''}" tabindex="0" role="button" data-id="${escapeHtml(id)}">`
    + `<div class="cover home-fan-cover">${window.BunkoHome.fanFromUrls(imgUrl(id, 0, 'big'), back)}</div>`
    + `<div class="card-body"><div class="card-heading"><h3 class="card-title">${escapeHtml(gallery.title)}</h3><span class="creator-actions">${pawFavButton(gallery)}${pawFolderButton(gallery)}</span></div>`
    + `<p class="home-fan-meta">${meta}</p></div></article>`;
}

// 一覧が Pawchive の作者の見出しだけの時は揃え (扇は同じ大きさの札。流しにしない)。
// bunko-ui.js の流しの判定と、段の幅 (home.css の #grid.paw-fan-list) が見る
let fanListMemo = { list: null, length: -1, key: '', value: false };
function pawFanList() {
  const list = state.galleries || [];
  const key = `${state.source}:${state.discovery ? 1 : 0}`;
  if (fanListMemo.list === list && fanListMemo.length === list.length && fanListMemo.key === key) return fanListMemo.value;
  const value = state.source === 'pawchive' && !state.discovery && list.length > 0
    && list.every((gallery) => gallery.kind === 'creator');
  fanListMemo = { list, length: list.length, key, value };
  return value;
}

// 紐付けの前後で札 1 枚だけ描き直す: 一覧ぜんぶを作り直すと位置が飛ぶ
function refreshCard(gallery) {
  const card = els.grid.querySelector(`.card[data-id="${gallery.id}"]`);
  if (!card) return;
  // 使い回しの控えも捨てて作り直す (古い HTML のまま次の描画で戻らないように)
  cardNodes.delete(String(gallery.id));
  const fresh = cardNode(gallery);
  card.replaceWith(fresh);
  // 描き直したのはこの 1 枚だけなので、押印もこの 1 枚に絞る
  stampCreatorFolders(fresh);
  markCurrentCard(currentDetailId);
}

// 詳細を開いている札の印。札を描き直すたびに付け直す (class は HTML ごと消えるので)
let currentDetailId = '';

function markCurrentCard(id) {
  const key = id == null ? '' : String(id);
  els.grid.querySelectorAll('.card.is-current').forEach((node) => {
    if (node.dataset.id !== key) node.classList.remove('is-current');
  });
  if (!key) return;
  const card = els.grid.querySelector(`.card[data-id="${key}"]`);
  if (card) card.classList.add('is-current');
}

// 詳細の開閉で作業領域の幅が変わり、段組みが変わって札が動く。
// 視界から出てしまったときだけ、入るぶんだけ寄せる ('nearest')。
// すでに見えているなら何も動かさない: 選ぶたびに景色が動くほうが読みにくい。
//
// 幅は一こまで確定するようになった (margin-right の遷移を外した) ので、
// 次のこまには落ち着いている。以前はここに transitionend の待ち受けと
// 保険のタイマが要り、張りっぱなしのリスナが古い札へ勝手に寄せる事故もあった
function keepCardInView(id) {
  const key = id == null ? '' : String(id);
  if (!key) return;
  requestAnimationFrame(() => {
    const card = els.grid.querySelector(`.card[data-id="${key}"]`);
    if (card) card.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
}

// 同作の再アップロード・伏字題・ローマ字題・翻訳版を代表 1 枚に畳む。
// 判定そのものは dupe-cluster.js (app.js より先に読む純粋ロジック) が持つ。
// ここは state と繋ぐだけ: 返り値は dupeHidden が変わった gallery の配列
function markResultDupes({ reset = false } = {}) {
  return DupeCluster.mark(state.galleries, artistName).changed;
}

let gridRowHeight = 360;
let gridRenderQueued = false;
let gridWindowKey = '';

// 札の DOM は作り直さず使い回す (id → { node, html })。innerHTML で全部を置き直すと、
// 表紙の <img> が捨てられて読み込みと復号がやり直しになり (60 枚の窓に 96 回の要求)、
// 送りのたびに白く抜けていた。同じ札は同じ節を位置だけ直して置き直す
const cardNodes = new Map();
const gridSpacers = { top: null, bottom: null };

function cardNode(gallery) {
  const id = String(gallery.id);
  const html = cardMarkup(gallery);
  const entry = cardNodes.get(id);
  if (entry && entry.html === html) return entry.node;
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  const node = tpl.content.firstElementChild;
  cardNodes.set(id, { node, html });
  return node;
}

// 見えていない行ぶんの詰め物。高さだけ直して同じ節を使う
function gridSpacer(kind, height, gap) {
  if (!(height > 0)) return null;
  let node = gridSpacers[kind];
  if (!node) {
    node = document.createElement('div');
    node.className = `grid-spacer grid-spacer-${kind}`;
    node.setAttribute('aria-hidden', 'true');
    node.style.gridColumn = '1/-1';
    gridSpacers[kind] = node;
  }
  node.style.height = `${Math.max(0, height - gap)}px`;
  return node;
}

// 親の子を desired の並びに揃える。既に居る節はそのまま、位置だけ直す
function reconcileChildren(parent, desired) {
  desired.forEach((node, index) => {
    const current = parent.children[index];
    if (current !== node) parent.insertBefore(node, current || null);
  });
  while (parent.children.length > desired.length) parent.lastElementChild.remove();
}

function visibleGridItems() {
  const mode = hideMode();
  const pinned = state.galleries.filter(item => item.pinnedCreator === true);
  const items = state.galleries.filter((item) => !item.pinnedCreator && !isCardHidden(item, mode));
  const baseAsc = libraryScope() && state.sort === 'title';
  if (!sortDirNativeSupported() && (sortDirValue() === 'asc') !== baseAsc) items.reverse();
  return pinned.concat(items);
}

function gridColumns() {
  const template = getComputedStyle(els.grid).gridTemplateColumns;
  return Math.max(1, template.split(' ').filter(Boolean).length);
}

// remeasure: 描き終えた札から行の高さを測り直して、違っていればもう一度描く。
// 測り直しから呼ぶ再描画では false にして、測る → 描く → 測る … の連鎖を断つ
// (行の高さが札ごとに揺れると、窓の先頭が変わるたびに違う値を測って一覧が
// 一行ぶん跳ね続けた)
function renderGrid(_append, force = true, remeasure = true) {
  if (state.discovery && pixivShelfView) { renderPixivDiscovery(pixivShelfView); return; }
  if (window.BunkoUI && state.zoom !== 0) els.grid.style.setProperty('--card-min', `${currentCoverSize()}px`);
  els.grid.classList.toggle('paw-fan-list', pawFanList());
  // 流し (ウォーターフォール) が並べた時も 該当なし を描き直す。ここで帰っていたので、
  // 既定の並べ方では 札が並んでいるのに「見つかりませんでした」が残る / 0 件なのに何も言わない、が起きていた。
  // 送り (scroll の rAF は force=false) では中身が変わらないので描き直さない: 熱い道に全件の filter を置かない
  // pixiv の AI の札に「プロンプトあり」の印 (aitag の控え)。見えている札ぶんだけ訊き、届いたら class を写す。
  // 流し (waterfall) で並べる時もここを通ってから帰る
  if (window.BunkoAiMeta && state.source === 'pixiv' && force) window.BunkoAiMeta.want(visibleGridItems());
  if (window.BunkoUI?.renderWaterfall(force)) { if (force) updateEmptyState(); return; }
  const focusedId = document.activeElement?.classList?.contains('card')
    ? document.activeElement.dataset.id : '';
  const items = visibleGridItems();
  const gap = Number.parseFloat(getComputedStyle(els.grid).rowGap) || 0;
  const plan = VirtualGrid.plan({
    items,
    columns: gridColumns(),
    rowHeight: gridRowHeight,
    scrollTop: Math.max(0, window.scrollY - els.grid.offsetTop),
    viewportHeight: window.innerHeight,
    overscanRows: 3,
  });
  const nextWindowKey = `${plan.startIndex}:${plan.endIndex}:${items.length}:${gridColumns()}:${Math.round(gridRowHeight)}`;
  if (!force && nextWindowKey === gridWindowKey) return;
  gridWindowKey = nextWindowKey;
  const desired = [];
  const top = gridSpacer('top', plan.topSpacer, gap);
  if (top) desired.push(top);
  const keep = new Set();
  for (const gallery of plan.items) {
    const id = String(gallery.id);
    // 同じ id が二度並ぶことは稀にある (追い読みで同じ作品が返る): 二枚目は控えを使わない
    if (keep.has(id)) {
      const tpl = document.createElement('template');
      tpl.innerHTML = cardMarkup(gallery).trim();
      desired.push(tpl.content.firstElementChild);
      continue;
    }
    keep.add(id);
    desired.push(cardNode(gallery));
  }
  const bottom = gridSpacer('bottom', plan.bottomSpacer, gap);
  if (bottom) desired.push(bottom);
  reconcileChildren(els.grid, desired);
  // 窓から外れた札の控えは捨てる (持ち続けると一覧ぶん溜まる)
  for (const id of [...cardNodes.keys()]) {
    if (!keep.has(id)) cardNodes.delete(id);
  }
  if (state.loupeId && !els.grid.querySelector(`.card[data-id="${CSS.escape(String(state.loupeId))}"]`)) hideLoupe(true);
  // 行の高さは窓にある札のいちばん高いもので取る (段の中で札は伸びて揃うので、
  // どの札を見ても同じ段なら同じ高さ。先頭の札だけを見ると、先頭の段しだいで値が変わる)
  if (remeasure) {
    let tallest = 0;
    for (const card of els.grid.querySelectorAll('.card')) {
      if (card.offsetHeight > tallest) tallest = card.offsetHeight;
    }
    const measured = tallest + gap;
    if (tallest > 0 && Math.abs(measured - gridRowHeight) > 1) {
      gridRowHeight = measured;
      if (!gridRenderQueued) {
        gridRenderQueued = true;
        requestAnimationFrame(() => { gridRenderQueued = false; renderGrid(false, true, false); });
      }
    }
  }
  stampCreatorFolders();
  markCurrentCard(currentDetailId);
  if (focusedId) els.grid.querySelector(`.card[data-id="${CSS.escape(focusedId)}"]`)?.focus({ preventScroll: true });
  updateEmptyState();
}

// 該当なし は「検索が終わって、失敗もしていない」ときだけ出す。
// 伏せた結果として一枚も出なくなったときは、真っ白にせず理由を言う。
// 以前は「全札が owned」のときだけ特例に入ったので、版違い (similarOwned) が
// 一枚でも混ざると棚も文字も出ない、という真っ白が起きていた (項目 4-1)
function updateEmptyState() {
  const mode = hideMode();
  const loaded = state.galleries.filter((item) => item && !item.error);
  if (mode !== 'none' && loaded.length > 0 && loaded.every((item) => isCardHidden(item, mode))) {
    els.empty.textContent = mode === 'owned'
      ? `該当 ${loaded.length} 件はすべて所持済み (とその版違い) です`
      : `該当 ${loaded.length} 件はすべて所持作品の版違いです`;
    els.empty.hidden = false;
    return;
  }
  els.empty.textContent = libraryScope()
    ? '所持作品に一致はありません'
    : '見つかりませんでした';
  // searchEpoch 0 = まだ一度も検索していない (起動直後): 該当なし は出さない
  els.empty.hidden = searchEpoch === 0 || state.loading || Boolean(state.error) || state.galleries.length > 0;
}

function updateOwnedMarks(ids) {
  let grew = false;
  ids.forEach((id) => {
    const card = els.grid.querySelector(`.card[data-id="${id}"]`);
    if (!card || card.classList.contains('owned')) return;
    card.classList.add('owned');
    grew = true;
    const cover = card.querySelector('.cover');
    if (!cover) return;
    const mark = document.createElement('span');
    mark.className = 'owned-mark';
    mark.textContent = '済';
    cover.appendChild(mark);
  });
  // 伏せる設定が効いている間に済が生えたら、棚を組み直して本当に外す。
  // CSS の display:none だけで消すと、仮想棚の詰め物はその一枚ぶんの高さを
  // 抱えたままになり、行の高さの帳尻がずれる (= 空白のガタつき)
  if (grew && hideMode() !== 'none') {
    renderGrid();
  } else if (grew) {
    updateEmptyState();
  }
}

// 済 の札は付け外しの両方が要る: 手動の紐付け解除で消えることがある
function setOwnedMark(card, owned) {
  card.classList.toggle('owned', owned);
  const cover = card.querySelector('.cover');
  if (!cover) return;
  const mark = cover.querySelector('.owned-mark');
  if (owned && !mark) {
    const node = document.createElement('span');
    node.className = 'owned-mark';
    node.textContent = '済';
    cover.appendChild(node);
  } else if (!owned && mark) {
    mark.remove();
  }
}

// ---- 発見ビュー ----
// 検索と同じ器 (grid / 札 / 詳細 / 保存) を使い回す別モード。
// 中身はエンジン (lib/discovery.js) が巡回したキャッシュで、開くたびに
// 表示台帳へ記録される: 保存されず無視された作品は次第に沈む

let discPollTimer = 0;
let discEpoch = 0;

function discoveryReasonText(reason) {
  if (!reason) return '';
  if (reason.kind === 'new') {
    const anchor = reason.anchor ? String(reason.anchor).slice(0, 10) : '';
    return `新作 — ${reason.artist} (${reason.owned}冊所持${anchor ? ` / 最終取得 ${anchor}` : ''})`;
  }
  if (reason.kind === 'backlog') {
    return `発掘 — ${reason.artist} の年間人気 ${reason.popRank}位/${reason.popTotal}冊`;
  }
  return '';
}

function discoveryHead(title, desc) {
  return `<div class="disc-head"><span class="disc-title">${escapeHtml(title)}</span>${desc ? `<span class="disc-desc">${escapeHtml(desc)}</span>` : ''}</div>`;
}

function renderDiscovery(view) {
  const newReleases = view.newReleases || [];
  const backlog = view.backlog || [];
  // 札の操作 (保存・詳細・虫眼鏡) は state.galleries から引く: そこへ流し込む
  state.galleries = [...newReleases, ...backlog];
    markResultDupes({ reset: true });
  state.loading = false;
  state.done = true; // 追い読みは無い: 無限フィードにしない
  state.error = '';

  const when = view.generatedAt
    ? new Date(view.generatedAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '';
  const phase = view.progress && view.progress.phase === 'backlog' ? '発掘' : '新作';
  const refreshNote = view.refreshing
    ? `巡回中 (${phase} ${view.progress ? view.progress.done : 0}/${view.progress ? view.progress.total : 0})…`
    : (when ? `巡回 ${when}` : '');

  const parts = [];
  parts.push(discoveryHead(
    '新作の見張り',
    `所持3冊以上の作家 × 最終取得より後 — ${newReleases.length}件${refreshNote ? ` · ${refreshNote}` : ''}`,
  ));
  if (newReleases.length) parts.push(newReleases.map((item) => cardMarkup(item)).join(''));
  else parts.push('<p class="disc-empty">追いつけています。新しく出たものはありません</p>');
  parts.push(discoveryHead('発掘', `同じ作家の「年間人気上位なのに未所持」 — ${backlog.length}件`));
  if (backlog.length) parts.push(backlog.map((item) => cardMarkup(item)).join(''));
  else parts.push('<p class="disc-empty">いまは掘り出しものがありません (沈んでいる作品は時間を置くと戻ります)</p>');

  els.grid.innerHTML = parts.join('');
  els.empty.hidden = true;
  markCurrentCard(currentDetailId);
}

async function loadDiscovery() {
  const epoch = (discEpoch += 1);
  setStatus('発見を読み込み中…', false, true);
  let view = null;
  try {
    view = await window.hitomi.discovery();
  } catch {
    if (state.discovery && epoch === discEpoch) setStatus('発見の読み込みに失敗しました', true);
    return;
  }
  // 待っている間に検索へ戻った/開き直したなら、この応答は捨てる
  if (!state.discovery || epoch !== discEpoch) return;
  setStatus('');
  if (view.empty) {
    els.grid.innerHTML = discoveryHead(
      '発見',
      view.refreshing ? '初回の巡回中です。数分かかります…' : (view.error ? `巡回に失敗しました: ${view.error}` : '巡回結果がまだありません'),
    );
    els.empty.hidden = true;
    state.galleries = [];
  } else {
    renderDiscovery(view);
  }
  clearTimeout(discPollTimer);
  if (view.refreshing) {
    discPollTimer = setTimeout(() => {
      if (state.discovery) loadDiscovery();
    }, 3000);
  }
}

let pixivShelfView = null;
async function enterDiscovery() {
  searchEpoch++;
  if (activeSearchRequestId) window.hitomi.cancelSearch?.(activeSearchRequestId).catch(() => {});
  state.discovery = true;
  state.loading = false; state.done = true;
  if (!navigating) pushHistory();
  renderTypes();
  hideSuggest();
  els.grid.innerHTML = '';
  els.empty.hidden = true;
  // 発見は検索の件数と無関係: 前の検索の「全n件」を残さない
  renderResultInfo(null);
  // pixiv は台帳の巡回ではなく pixiv のおすすめ (作者と投稿)
  await (state.source === 'pixiv' ? loadPixivDiscovery() : loadDiscovery());
}

function leaveDiscovery() {
  if (!state.discovery) return;
  state.discovery = false;
  pixivShelfView = null;
  els.grid.classList.remove("pixiv-shelves");
  clearTimeout(discPollTimer);
  renderTypes();
}

// ---- 発見 (pixiv) ----
// pixiv の「おすすめユーザー」(フォローから薦める作者。投稿 3 枚つき) と、ホームの「おすすめ」。
// 器は同じ (grid / 札 / 詳細 / 保存 / ♥)。作者一人ぶんは .disc-user の行に納め、
// 作者の札はフォローの釦を持つ (pixiv 側に書く)。控えは母屋 (数分)。追い読みは無い

async function loadPixivDiscovery() {
  const epoch = (discEpoch += 1);
  setStatus('おすすめを読み込み中…', false, true);
  let view = null;
  try {
    view = await window.hitomi.pixiv({ action: 'discover' });
  } catch (error) {
    if (!state.discovery || epoch !== discEpoch) return;
    const text = ipcErrorText(error && error.message ? error.message : error);
    state.galleries = [];
    els.empty.hidden = true;
    if (/ログインしていません/.test(text)) {
      // 未ログインは誤りではない: 案内だけ (赤にしない)
      setStatus('');
      els.grid.innerHTML = discoveryHead('発見', 'pixiv にログインすると、おすすめの作者と投稿が出ます (設定 → 取り込み → pixiv)');
    } else {
      setStatus(`おすすめの読み込みに失敗しました: ${text}`, true);
    }
    return;
  }
  if (!state.discovery || epoch !== discEpoch) return;
  setStatus('');
  renderPixivDiscovery(view || {});
}

function renderPixivDiscovery(view) {
  pixivShelfView = view;
  const users = Array.isArray(view.users) ? view.users.filter(r => r?.creator) : [];
  const recent = Array.isArray(view.recent) ? view.recent : [];
  const works = Array.isArray(view.illusts) ? view.illusts : [];
  state.galleries = [...new Map([...users.flatMap(r => [r.creator, ...(r.illusts || [])]), ...recent.flatMap(r => r.illusts || []), ...works].map(g => [String(g.id), g])).values()];
  markResultDupes({ reset: true });
  // おすすめの棚 (作者・最近読んだ物の関連・おすすめの投稿) の AI の札にも「プロンプトあり」の印を頼む
  window.BunkoAiMeta?.want(state.galleries);
  state.loading = false; state.done = true; state.error = '';
  window.BunkoUI?.renderWaterfall();
  els.grid.classList.add('pixiv-shelves');
  const ordered = rows => sortDirValue() === 'asc' ? [...rows].reverse() : rows;
  const visible = new Set(visibleGridItems().map(g => String(g.id)));
  const typeParts = pixivTypeParts(state.type);
  const cards = rows => ordered(rows || []).filter(g => visible.has(String(g.id)) && (typeParts.kind !== 'manga' || g.type === 'manga') && (typeParts.kind !== 'ai' || g.ai === true) && (!typeParts.r18 || g.r18)).map(cardMarkup).join('');
  const shelf = (title, note, body) => `<section class="pixiv-shelf"><header><h2>${escapeHtml(title)}</h2>${note ? `<p>${escapeHtml(note)}</p>` : ''}</header>${body}</section>`;
  const parts = recent.map(row => shelf(row.seed?.title || '最近読んだ作品から', row.error || '', `<div class="pixiv-shelf-books">${cards(row.illusts)}</div>`));
  if (!recent.length && !view.relatedTitle) parts.push(shelf('最近読んだ作品から', 'pixivの作品を読むと、ここに関連作品が並びます。', ''));
  if (users.length) parts.push(shelf('おすすめの作者', '', `<div class="pixiv-shelf-authors">${ordered(users).map(row => `<article class="pixiv-author-shelf"><div class="pixiv-author-previews">${cards(row.illusts)}</div><div class="pixiv-author-profile">${cardMarkup(row.creator)}</div></article>`).join('')}</div>`));
  parts.push(shelf(view.relatedTitle ? '関連作品' : 'おすすめの作品', view.relatedTitle || 'pixivのおすすめ', `<div class="pixiv-shelf-books">${cards(works)}</div>`));
  els.grid.innerHTML = parts.join(''); els.empty.hidden = true;
  markCurrentCard(currentDetailId);
}

function captionMarkup(value) {
  let text = String(value || '');
  for (let i=0;i<2;i++) text=text.replace(/&amp;(?=#(?:x[0-9a-f]+|\d+);)/gi,'&').replace(/&#(x[0-9a-f]+|\d+);/gi,(all,code)=>{const n=code[0].toLowerCase()==='x'?parseInt(code.slice(1),16):Number(code);return n>0&&n<=0x10ffff?String.fromCodePoint(n):all;});
  const pattern=/https?:\/\/[^\s<>"'\u3000]+|\billust\/\d+/g;
  let html='',at=0;
  for (const match of text.matchAll(pattern)) {
    const token=match[0].replace(/[。、，．）)]+$/,'');
    const work=/^(?:https?:\/\/(?:www\.)?pixiv\.net\/(?:[a-z]{2}\/)?artworks\/|illust\/)(\d+)(?:[?#].*)?$/.exec(token);
    let link=escapeHtml(token);
    if (work) link=`<a href="https://www.pixiv.net/artworks/${work[1]}" data-caption-work="px:${work[1]}">${escapeHtml(token)}</a>`;
    else {
      try { const url=new URL(token); if (['https:','http:'].includes(url.protocol) && !url.username && !url.password) link=`<a href="${escapeHtml(url.href)}" data-caption-url="${escapeHtml(url.href)}">${escapeHtml(token)}</a>`; } catch {}
    }
    html+=escapeHtml(text.slice(at,match.index))+link+escapeHtml(match[0].slice(token.length));
    at=match.index+match[0].length;
  }
  return html+escapeHtml(text.slice(at));
}
function detailExtras(gallery) {
  if (gallery.source !== 'pixiv' || !gallery.caption) return '';
  return `<div class="pixiv-detail-extras"><details class="pixiv-caption" open><summary>作品キャプション</summary><p>${captionMarkup(gallery.caption)}</p></details></div>`;
}
const relatedDetailItems = new Map();
// 一覧の外の作品 (関連作品) を札ごと預かる: 詳細・保存が引き直さずに題・所持・うごイラを見られる
// (pixiv の gallery を連投すると 429 の冷却に当たる)。新しい方から 200 件まで
function keepRelatedItems(rows) {
  for (const g of rows) { relatedDetailItems.delete(String(g.id)); relatedDetailItems.set(String(g.id),g); }
  while (relatedDetailItems.size > 200) relatedDetailItems.delete(relatedDetailItems.keys().next().value);
}
function detailRelatedMarkup(gallery) {
  return gallery.source === 'pixiv' && gallery.kind !== 'creator' ? '<details class="pixiv-detail-related" open><summary>関連作品</summary><div class="pixiv-related-list" aria-live="polite">読み込み中…</div></details>' : '';
}
async function loadDetailRelated(gallery, container) {
  const list = container?.querySelector('.pixiv-related-list');
  if (!list) return;
  try {
    const rows = await window.hitomi.pixiv({action:'related',id:gallery.id});
    if (!list.isConnected) return;
    const works = (Array.isArray(rows) ? rows : []).filter(g => String(g.id) !== String(gallery.id));
    keepRelatedItems(works);
    list.innerHTML = works.length ? works.map(g => `<button type="button" class="pixiv-related-item${window.BunkoAiMeta?.markOf(g.id) === 'yes' ? ' has-prompt' : ''}" data-related-detail="${escapeHtml(g.id)}"${g.ai ? ' data-ai="1"' : ''}><div class="pixiv-related-cover"><img src="${escapeHtml(imgUrl(g.id,0,'big'))}" loading="lazy" alt="">${pageCountBadge(g)}</div><span><strong>${escapeHtml(g.title)}</strong><span class="pixiv-related-meta"><span class="pixiv-related-author">${escapeHtml(artistName(g))}</span></span></span></button>`).join('') : '<p class="pixiv-related-empty">関連作品はありません</p>';
    window.BunkoAiMeta?.want(works);
  } catch { if (list.isConnected) list.textContent = '関連作品を取得できませんでした'; }
}

// annotate で引き直した 済/★/紐付け を、詳細とリーダーが抱えている
// 同じ作品のオブジェクトにも写す (一覧と別インスタンスに分岐しているため)
function adoptAnnotated(fresh) {
  const targets = [state.selected, state.reader && state.reader.gallery];
  for (const target of targets) {
    if (!target) continue;
    const match = (fresh || []).find((item) => item && sameId(item.id, target.id));
    if (!match) continue;
    target.owned = match.owned;
    target.star = match.star;
    target.eagleId = match.eagleId;
    target.linkedEagleId = match.linkedEagleId;
    // idOwned まで写す。詳細の鎖の口はこれで出し分けるので、写し忘れると
    // 紐付けた直後の詳細に「所持アイテムを探す」が残ったままになる
    target.idOwned = match.idOwned;
    target.similarOwned = match.similarOwned;
    // 手持ちの hitomi 版への道。写し忘れると詳細の「hitomi 版を読む」が消える
    target.ownedGalleryId = match.ownedGalleryId;
  }
}

// 紐付けの前後で 済 は動く。一覧を取り直して札を合わせる
// restar: 星を台帳から引き直す作品の鍵の集合 (無ければ引き直さない)。
//
// annotate は「札が既に star を持っていればそれを信じる」。所持棚の行は棚の
// 問い合わせが持って来た星が本物で、★での絞り込みと札を食い違わせないための
// 約束だからそこは崩せない。一方その据え置きのせいで、**紐付けを付け替えても
// 前の作品の星が札に残り続けた** — リーダーで★を押し直すと直って見えたのは
// これが理由。そこで、鎖が動いた作品**だけ**手元の星を捨てて訊き直す
// (棚ぜんぶを捨てると、分冊の代表星が最高値に化けて絞り込みとずれる)
async function refreshOwnedMarks(extra = [], { restar = null } = {}) {
  if (!state.galleries.length && !extra.length) return false;
  const epoch = searchEpoch;
  const visibleBefore = visibleGridItems().map(item => String(item.id)).join('|');
  // 描き直す札を選ぶための控え。取り直す前の姿を鍵ごとに覚えておく
  const before = new Map();
  state.galleries.forEach((gallery) => {
    if (gallery && gallery.id != null) {
      before.set(String(gallery.id), { star: gallery.star || 0, eagleId: gallery.eagleId || '' });
    }
  });
  const ask = [...state.galleries, ...extra];
  const restarIds = restar && restar.size ? restar : null;
  let answered = null;
  try {
    answered = await window.hitomi.annotate(
      restarIds ? ask.map((item) => {
        if (!item || item.kind === 'eagleItem') return item;
        if (!restarIds.has(String(item.id))) return item;
        const { star, ...rest } = item;
        return rest;
      }) : ask,
    );
  } catch {
    return false;
  }
  // 待っている間に検索が切り替わっていたら、古い一覧で上書きしない
  if (epoch !== searchEpoch) return false;
  // 一覧の分と、一覧に居ない詳細の分を切り分ける
  const fresh = extra.length ? answered.slice(0, state.galleries.length) : answered;
  const outside = extra.length ? answered.slice(state.galleries.length) : [];
  state.galleries = fresh;
  adoptAnnotated([...fresh, ...outside]);
  state.galleries.forEach((gallery) => {
    const card = els.grid.querySelector(`.card[data-id="${gallery.id}"]`);
    if (!card) return;
    // 札は ★ も出す。付け替えでは 済 の付き外れだけでなく星も動くので、
    // 印の差し替えだけでは前の作品の星が残る。変わった札だけ描き直す
    // (全部やると絵の読み込みが走ってガタつく)
    const was = before.get(String(gallery.id));
    const moved = was
      && (was.star !== (gallery.star || 0) || was.eagleId !== (gallery.eagleId || ''));
    if (moved) refreshCard(gallery);
    else setOwnedMark(card, Boolean(gallery.owned));
  });
  if (visibleBefore !== visibleGridItems().map(item => String(item.id)).join('|')) renderGrid();
  updateEmptyState();
  return true;
}

function updateJobStrips(jobs) {
  jobs.forEach((job) => {
    const card = els.grid.querySelector(`.card[data-id="${job.id}"]`);
    if (!card) return;
    const cover = card.querySelector('.cover');
    if (!cover) return;
    const strip = cover.querySelector('.dl-strip');
    if (job.status === 'running' && job.total > 0) {
      const node = strip || cover.appendChild(document.createElement('span'));
      if (!strip) {
        node.className = 'dl-strip';
        node.innerHTML = '<i></i>';
      }
      node.firstElementChild.style.width = `${Math.round((job.done / job.total) * 100)}%`;
      return;
    }
    if (strip) strip.remove();
  });
}

// 札を押したときに走る検索。pawchive のタグは横断で引けない (API に無い) ので、
// その作者の中の絞り込みとして組み立てる
function tagQuery(tag, owner) {
  // pixiv は名前空間を持たない: 作者は user:<番号>、タグはその語で部分一致 (§15 U4)
  if (owner && owner.source === 'pixiv') {
    if (tag.type === 'artist') {
      const userId = tag.userId || owner.userId || '';
      if (userId) { pixivAuthorNames.set(String(userId), tag.name); if (pixivAuthorNames.size > 256) pixivAuthorNames.delete(pixivAuthorNames.keys().next().value); }
      return userId ? `user:${userId}` : tag.name;
    }
    searchSelections.set(`pixiv:${tag.name}`,{type:tag.type || 'tag',name:tag.name,label:tag.label || '',native:{pixiv:tag.name}});
    if (searchSelections.size>256) searchSelections.delete(searchSelections.keys().next().value);
    return tag.name;
  }
  // Eagle アイテムでも、詳細タグ (typed: 兄弟話や eh/nh 由来の hitomi 流タグ) は
  // hitomi 作品と同じ male:horse_cock 型で引く。型なしは Eagle の語そのもの
  if (isEagleItem(owner) && !tag.typed) return tag.name;
  const creator = owner && owner.source === 'pawchive' ? pawCreatorOf(owner) : null;
  if (creator && tag.type === 'tag') return `${creator.service}/${creator.user} tag:${tag.name.replace(/\s+/g,'_')}`;
  if (creator && tag.type === 'artist') {
    const query = `${creator.service}/${creator.user}`;
    portableCreatorQueries.set(`pawchive:${query}`, tag.name);
    if (portableCreatorQueries.size > 256) portableCreatorQueries.delete(portableCreatorQueries.keys().next().value);
    return query;
  }
  // nhentai は内容タグを型分けしない。台帳が hitomi での型を決められたなら
  // その型で引く。female と male の両方に在る語は **どちらかに賭けない**:
  // 「either:」で投げて、母屋が二つを合わせて引く
  const name = tag.name.replaceAll(' ', '_');
  if (Array.isArray(tag.hitomiTypes) && tag.hitomiTypes.length > 1) return `either:${name}`;
  const token = `${tag.hitomiType || tag.type}:${name}`;
  if (tag.label) {
    portableAuthorLabels.set(token, tag.label);
    if (portableAuthorLabels.size > 256) portableAuthorLabels.delete(portableAuthorLabels.keys().next().value);
  }
  return token;
}

function tagButtons(tags, owner, compact = false) {
  return tags.map((tag) => {
    const value = tagQuery(tag, owner);
    // 型が hitomi のものに定まっているなら、顔も色もそちらで揃える
    // (同じ語が hitomi の札と nhentai の札で違う顔をしていると読み分けられない)。
    // 両方に在る語は「female/male:」と名乗る — either: は内部の符丁で、
    // 画面に出す言葉ではない
    const many = Array.isArray(tag.hitomiTypes) && tag.hitomiTypes.length > 1;
    const type = many ? tag.hitomiTypes.join('/') : (tag.hitomiType || tag.type);
    const plain = `${type}:${tag.name.replaceAll(' ', '_')}`;
    // pawchive の札は "type:" を被せない: 出るのは作者の付けた語そのもの。
    // ただし詳細タグ (typed) は hitomi 作品と同じ型付きの顔で揃える
    const bare = owner && (owner.source === 'pawchive' || owner.source === 'pixiv') && !tag.typed;
    // pixiv の翻訳名 (label) は顔ではなく title に回す: 札は作者の付けた語そのもの
    const pixivFace = owner && owner.source === 'pixiv';
    const display = compact ? (pixivFace ? tag.name : (tag.label || tag.name)) : bare ? (pixivFace ? tag.name : (tag.label || tag.name)) : (tag.label ? `${type}:${tag.label}` : plain);
    const title = ` title="${escapeHtml(pixivFace && tag.label ? `${tag.label} — ${value}` : value)}"`;
    // class は色分けにしか使わない: 「female/male」は斜線を含むので female に寄せる
    const klass = many ? tag.hitomiTypes[0] : type;
    return `<button type="button" class="tag ${klass}" data-query="${escapeHtml(value)}"${title}>${escapeHtml(display)}</button>`;
  }).join('');
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

function detailRow(label, valueHtml) {
  if (!valueHtml) return '';
  return `<dt class="row-label">${escapeHtml(label)}</dt><dd class="row-value">${valueHtml}</dd>`;
}

function detailTextRow(label, text) {
  if (!text) return '';
  return detailRow(label, `<span class="row-text">${escapeHtml(text)}</span>`);
}

function detailTagRow(label, tags, owner) {
  if (!tags || !tags.length) return '';
  return detailRow(label, tagButtons(tags, owner, true));
}

// 手動紐付け。hitomi / nhentai / ehentai は台帳 (title_matches) にソース付きの
// 鍵で落とす。pawchive だけは Eagle の「作者」フォルダを台帳代わりに使う別の道
// (投稿の札だけ)
function linkable(gallery) {
  if (!gallery || gallery.error || gallery.kind === 'creator') return false;
  const source = gallery.source || 'hitomi';
  if (source === 'pawchive') return Boolean(pawPostOf(gallery));
  return true;
}

// 検索の種はギャラリー題から括弧の類を落としたぶん。ローマ字題だと当たらない
// ことが多いので、開いたときに全選択して打ち直せるようにしてある
function linkSeedTerm(title) {
  return String(title || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function linkPickerMarkup(gallery) {
  // タイトル一致だけの 済 (idOwned が立たない) は紐付けの口を残す
  if (gallery.idOwned || !linkable(gallery)) return '';
  // pawchive の候補は題の検索ではなく作者フォルダの中身: 別仕立ての窓で選ばせる
  if (gallery.source === 'pawchive') return '';
  return `
    <div class="link-picker" hidden>
      <input type="search" class="link-query" placeholder="所持アイテムを検索"
        value="${escapeHtml(linkSeedTerm(gallery.title))}" />
      <ul class="link-hits"></ul>
    </div>
  `;
}

// 詳細を開いた作品と「同作」とみなせるか。一覧の外から来た作品 (URL 直開きなど)
// にも変種を出せるよう、markResultDupes と同じ規則を対で判定する
function sameWorkAs(gallery, item) {
  return DupeCluster.sameWork(gallery, item, artistName);
}

// 詳細の下に出す「版違い・再掲」の候補一覧。伏せ札で見えないぶんを
// ここで開陳する: 頁数と日付が並べば、どれが完全版・最新かは一目で分かる
function detailVariantList(gallery) {
  // 隠していないモードなら一覧に全部見えている: 二重に出さない
  if (libraryScope() || hideOwnedMode() === 'none') return '';
  if (!gallery || gallery.error) return '';
  const inList = findGallery(gallery.id);
  const variants = inList && inList.dupeClusterId
    ? state.galleries.filter((item) => item && !item.error
      && item.dupeClusterId === inList.dupeClusterId && !sameId(item.id, gallery.id))
    : state.galleries.filter((item) => sameWorkAs(gallery, item));
  if (!variants.length) return '';
  // 追加日で新しい順: 発行日は再掲同士で同じ日付が並んでしまい役に立たない
  const stamp = (item) => String(item.addedDate || item.publishedDate || '');
  const rows = variants
    .slice()
    .sort((a, b) => stamp(b).localeCompare(stamp(a)))
    .map((item) => `
      <li><button type="button" class="variant-row" data-variant="${escapeHtml(String(item.id))}">
        <span class="variant-cover"><img class="variant-thumb" src="${imgUrl(item.id, 0, 'small')}" alt="" loading="lazy" />${pageCountBadge(item)}</span>
        <span class="variant-body">
          <span class="variant-title">${escapeHtml(item.title)}</span>
          <span class="variant-meta">${escapeHtml(formatDate(item.addedDate || item.publishedDate) || '?')}${item.owned ? ' · 済' : ''}</span>
        </span>
      </button></li>`)
    .join('');
  return `
    <section class="detail-variants">
      <p class="variants-head">版違い・再掲 <span class="queue-num">${variants.length}</span></p>
      <ul>${rows}</ul>
    </section>`;
}

function renderDetail(gallery) {
  // 手のひら版は本の詳細を電話の板 (phone-reader.js の枠) で出す。Home の作者 (人) の札は本ではないので
  // 机上と同じ板 (下の Home の中身) を出す。電話の枠が開いていれば先に畳む
  if (gallery && window.BunkoPhone && gallery.source !== 'home') {
    els.detail.hidden = true;
    window.BunkoPhone.detail(gallery);
    return;
  }
  if (gallery && window.BunkoPhone) window.BunkoPhone.close?.();
  if (!gallery) {
    detailGeneration.next();
    detailTrail.length = 0;
    els.detail.hidden = true;
    document.body.classList.remove('detail-open');
    window.BunkoUI?.renderWaterfall();
    // 閉じても段組みは戻る: 見ていた札はそのまま画面に残す
    const last = currentDetailId;
    currentDetailId = '';
    markCurrentCard('');
    keepCardInView(last);
    return;
  }
  els.detail.hidden = false;
  document.body.classList.add('detail-open');
  window.BunkoUI?.sync();
  window.BunkoUI?.renderWaterfall();
  currentDetailId = String(gallery.id);
  markCurrentCard(currentDetailId);
  keepCardInView(currentDetailId);
  // Home の作者 (人) の詳細: 板の開け閉めと段組みの寄せは上のとおり、中身だけ Home が組む
  if (gallery.source === 'home' && window.BunkoHome) {
    els.detailBody.innerHTML = window.BunkoHome.detailMarkup(gallery);
    return;
  }
  els.detailBody.innerHTML = detailBodyMarkup(gallery);
  loadDetailRelated(gallery, els.detailBody);
  if (window.BunkoAiMeta?.canPrompt(gallery)) window.BunkoAiMeta.want([gallery]);
}

// 詳細の板の中身 (表紙・題・釦・行・関連の器)。詳細 (#detail-body) と、読む画面の右の板の「情報」(ai-meta-ui.js) が同じ物を描く
function detailBodyMarkup(gallery) {
  const language = gallery.language?.localName || gallery.language?.name || '';
  const star = Math.round(Number(gallery.star)) || 0;
  const rows = [
    detailTextRow('日付', formatDate(gallery.publishedDate || gallery.addedDate)),
    detailTextRow('種別', ({doujinshi:'同人誌',manga:'漫画',artistcg:'Artist CG',gamecg:'Game CG',imageset:'画像集'})[gallery.type] || gallery.type),
    detailTextRow('言語', language),
    // 評価は Eagle 側の星。付いていないものは行ごと出さない
    star > 0 ? detailTextRow('評価', `★${star}`) : '',
    detailTagRow('作者', gallery.artists, gallery),
    detailTagRow('グループ', gallery.groups, gallery),
    detailTagRow('原作', gallery.series, gallery),
    detailTagRow('キャラ', gallery.characters, gallery),
    detailTagRow('タグ', gallery.tags, gallery),
    // pixiv のシリーズは字だけ (抜けは数えない: 要件 §2)
    gallery.source === 'pixiv' && gallery.series && !Array.isArray(gallery.series) && gallery.series.title
      ? detailTextRow('シリーズ', gallery.series.title)
      : '',
  ].join('');
  // 頁数の分からない作品 (Eagle アイテムなど) に「0ページ」と言わせない

  // pixiv の旗は腰帯に (札の角に印を足すと小さい段で読めない: §15 U7)
  const flags = gallery.source === 'pixiv'
    ? `${gallery.badge === 'うごイラ' ? ' · うごイラ' : ''}${gallery.ai ? ' · AI' : ''}${gallery.r18 ? ' · R-18' : ''}`
    : '';

  // 主操作は 読む → サイトで開く → 保存 → 栞。Eagle はその後に置く。
  const eagleId = gallery.owned && gallery.eagleId ? String(gallery.eagleId) : '';
  // 作者の札に中身は無い: 読むものが無いので、代わりに作品一覧へ送る
  const isCreator = gallery.kind === 'creator';
  const readBtn = (primary) => (isCreator
    ? `<button${primary ? ' class="primary"' : ''} type="button" data-creator="${gallery.id}">作品一覧</button>`
    : `<button${primary ? ' class="primary"' : ''} type="button" data-read="${gallery.id}">${window.BunkoIcons?.['open-book'] || ICON.book}読む</button>`);
  const eagleBtn = (primary) => (eagleId
    ? `<button${primary ? ' class="primary"' : ''} type="button" data-eagle="${escapeHtml(eagleId)}">${ICON.feather}Eagle で開く</button>`
    : '');
  // よそのサイトの作品を、手持ちの hitomi 版として持っているとき。
  // **読むのは hitomi 側の所持copy**: こちらの札から読むと網へ取りに行ってしまう。
  // 版違いへ渡るのと同じ道 (data-variant) を使うので、マウスの戻るで帰れる
  const ownedElsewhere = gallery.ownedGalleryId != null
    && (gallery.source || 'hitomi') !== 'hitomi';
  const ownedBtn = ownedElsewhere
    ? `<button class="primary" type="button" data-variant="${escapeHtml(String(gallery.ownedGalleryId))}">${window.BunkoIcons?.['open-book'] || ICON.book}hitomi 版を読む</button>`
    : '';
  const actions = [
    ownedElsewhere ? ownedBtn : readBtn(true),
    gallery.url ? `<button type="button" data-site="${escapeHtml(gallery.url)}">${window.BunkoIcons?.['open-new-window'] || ICON.external}サイトで開く</button>` : '',
    // うごイラは本にしない (保存は出さない)
    gallery.owned || isCreator || gallery.unbindable ? '' : `<button type="button" data-save="${gallery.id}">${window.BunkoIcons?.download || ICON.save}保存</button>`,
    // フォロー (pixiv の作者の札)。pixiv 側に書く
    gallery.source === 'pixiv' && isCreator && gallery.userId
      ? `<button type="button" data-follow="${gallery.id}" aria-pressed="${gallery.following ? 'true' : 'false'}">${gallery.following ? 'フォロー中' : 'フォロー'}</button>`
      : '',
    // AI 作品 (pixiv) だけ: 読む画面をプロンプトの板つきで開く (issue #3)。印 (has-prompt) は aitag の控えから
    window.BunkoAiMeta?.canPrompt(gallery)
      ? `<button type="button" data-ai-meta="${gallery.id}" class="${window.BunkoAiMeta.markOf(gallery.id) === 'yes' ? 'has-prompt' : ''}" title="生成情報 (プロンプト・設定) を読む画面の横に出す">プロンプト</button>`
      : '',
    eagleBtn(false),

  ].join('');

  // 鎖は毎日押す口ではない: 開き方の列から外し、絵だけの札をやめて言葉で名乗らせ、
  // 削除の一段上へ落とす。
  // タイトル一致だけで 済 になることがある (ID 未紐付けで所持一覧に
  // 並ばない)。その場合も鎖を出して、手動で ID を確定できるようにする
  const linkActs = [
    linkable(gallery) && ((gallery.source || 'hitomi') === 'pawchive'
      ? !gallery.linkedEagleId
      : gallery.source === 'pixiv' ? !gallery.owned : !gallery.idOwned)
      ? `<button type="button" class="quiet-act" data-link="${gallery.id}">${ICON.link}<span>所持アイテムと紐付ける</span></button>`
      : '',
    gallery.owned && gallery.linkedEagleId
      ? `<button type="button" class="quiet-act" data-unlink="${escapeHtml(gallery.linkedEagleId)}">${ICON.unlink}<span>紐付けを解除</span></button>`
      : '',
  ].join('');
  // 検索窓は鎖と対で動く (data-link → toggleLinkPicker)。linkPickerEl は
  // .link-picker を class で引くので、一緒に下へ移しても壊れない
  const linkRow = linkActs
    ? `<div class="detail-quiet">${linkActs}${linkPickerMarkup(gallery)}</div>`
    : '';

  // 一番下の削除: Eagle 本体をゴミ箱へ送り、所持 (ダウンロード済み) からも外す。
  // pawchive も対象 (紐付けの控えの掃除は main 側が paw の三つ組で行う)
  const trashRow = eagleId && !isCreator
    ? `<div class="detail-danger">
        <button type="button" class="danger-act" data-trash="${escapeHtml(eagleId)}"
          title="Eagle のアイテムをゴミ箱へ送り、未ダウンロードに戻す">${ICON.trash}<span>Eagle のゴミ箱へ</span></button>
      </div>`
    : '';

  return `
    <div class="detail-cover"><img src="${imgUrl(gallery.id, 0, 'big')}" alt=""${coverAspectStyle(gallery)} />${pageCountBadge(gallery)}</div>
    <h2>${escapeHtml(gallery.title)}</h2>
    <p class="kicker">${escapeHtml(sourceLabel(gallery.source))}${escapeHtml(flags)}${gallery.owned ? ' · 保存済み' : ''}</p>
    <div class="detail-actions">${actions}</div>
    ${rows ? `<dl class="detail-rows${gallery.source === 'pixiv' ? ' pixiv-metadata' : ''}">${rows}</dl>` : ''}
    ${detailExtras(gallery)}
    ${detailVariantList(gallery)}
    ${linkRow}
    ${trashRow}
    ${detailRelatedMarkup(gallery)}
  `;
}

function renderJobs() {
  DownloadsUI.render();
}

let hideLoupeTimer = 0;
let showLoupeTimer = 0;
let pendingLoupeCard = null;

function cancelLoupeTimer() {
  clearTimeout(showLoupeTimer);
  pendingLoupeCard = null;
}

function hideLoupe(immediate = false) {
  const close = () => {
    els.loupe.hidden = true;
    els.loupePages.innerHTML = '';
    state.loupeId = null;
    state.loupePage = 0;
    state.loupeGallery = null;
  };
  clearTimeout(hideLoupeTimer);
  if (immediate) close();
  else hideLoupeTimer = setTimeout(close, 160);
}

function placeLoupe(card) {
  const rect = card.getBoundingClientRect();
  const width = Math.min(380, window.innerWidth * 0.44);
  const left = rect.right + 16 + width < window.innerWidth
    ? rect.right + 16
    : Math.max(12, rect.left - width - 16);
  const top = Math.min(window.innerHeight - 240, Math.max(16, rect.top - 20));
  els.loupe.style.left = `${left}px`;
  els.loupe.style.top = `${top}px`;
}

function renderLoupePage() {
  const gallery = state.loupeGallery;
  if (!gallery) return;
  const page = state.loupePage;
  els.loupePages.innerHTML = `<img src="${imgUrl(gallery.id, page, 'big')}" alt="" />`;
  const artist = artistName(gallery);
  els.loupeCaption.innerHTML = `
    ${escapeHtml(gallery.title)}
    <small>${escapeHtml(artist)}${artist ? ' · ' : ''}${page + 1} / ${gallery.pageCount}</small>
  `;
  const preload = [page + 1, page - 1].filter((index) => index >= 0 && index < gallery.pageCount);
  preload.forEach((index) => {
    const img = new Image();
    img.src = imgUrl(gallery.id, index, 'big');
  });
}

function stepLoupe(delta) {
  const gallery = state.loupeGallery;
  if (!gallery) return;
  const next = state.loupePage + delta;
  if (next < 0 || next >= gallery.pageCount) return;
  state.loupePage = next;
  renderLoupePage();
}

function showLoupe(card, gallery) {
  // Home の作者の見出しは本ではない (めくる頁が無い)
  if (!gallery || gallery.error || gallery.source === 'home') return;
  clearTimeout(hideLoupeTimer);
  placeLoupe(card);
  els.loupe.hidden = false;
  if (state.loupeId === gallery.id) return;

  state.loupeId = gallery.id;
  state.loupeGallery = gallery;
  state.loupePage = 0;
  renderLoupePage();
}

// 種類の札を初めて押した時に一度だけ、その札の脇に「右クリックで除外」を 1.6 秒浮かべる (幅も高さも取らない。
// 右クリックの除外は知らないと見つけにくいが、常設の字で帯を伸ばしたくない)。一回の起動で一度きり
let typeHintShown = false;
let typeHintTimer = 0;
function flashTypeHint(id) {
  if (typeHintShown || !typeExclusionSupported() || !els.types) return;
  const chip = els.types.querySelector(`[data-type="${CSS.escape(id)}"]`);
  if (!chip) return;
  typeHintShown = true;
  const hint = document.createElement('span');
  hint.className = 'chip-hint';
  hint.setAttribute('aria-hidden', 'true');
  hint.textContent = '右クリックで除外';
  hint.style.left = `${chip.offsetLeft + chip.offsetWidth + 6}px`;
  els.types.appendChild(hint);
  requestAnimationFrame(() => hint.classList.add('show'));
  clearTimeout(typeHintTimer);
  typeHintTimer = setTimeout(() => { hint.classList.remove('show'); setTimeout(() => hint.remove(), 200); }, 1600);
}

let zoomNameTimer = 0;

// 段の名は「重ねて」出す: 流れに入らないので、出ても消えても帯の幅も高さも動かない
function flashZoomName(label) {
  if (!els.zoomName) return;
  els.zoomName.textContent = label;
  els.zoomName.classList.add('show');
  clearTimeout(zoomNameTimer);
  zoomNameTimer = setTimeout(() => els.zoomName.classList.remove('show'), 1200);
}

// 大きさは Ctrl+ホイールの ±1 (端で止まる) と、表示の小窓の「表紙の大きさ」で替える
function applyZoom(level, persist = true) {
  const anchor = state.galleries.length ? currentScrollAnchor() : null;
  const fallbackScroll = window.scrollY;
  state.zoom = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, level));
  const current = ZOOM_LEVELS[state.zoom];
  if (persist && current.min && window.BunkoUI) setCoverSize(coverPageKey(), current.min);
  els.grid.classList.toggle('is-list', current.id === 'list');
  // 段を CSS へ渡す。小さい段で札の釦を間引くのは CSS だけの仕事にして、
  // 段を変えるたびに札を組み直さない (組み直すと一覧が跳ねる)
  els.grid.dataset.zoom = current.id;
  els.grid.style.setProperty('--card-min', current.min ? `${window.BunkoUI ? currentCoverSize() : current.min}px` : '168px');
  // 常設の名札は畳んだ: 今の段は釦の title と、押した時に浮く名札が言う。
  els.zoomCycle.title = ZOOM_BUTTON_TITLE;
  els.zoomCycle.setAttribute('aria-label', '表示設定');
  gridRowHeight = current.id === 'list' ? 82 : 360;
  if (state.galleries.length) renderGrid(false);
  window.BunkoHome?.relayout?.();
  if (anchor) requestAnimationFrame(() => restoreScroll(anchor, fallbackScroll));
  // 起動時の復元 (persist = false) では名札を出さない: 開いた瞬間に何も光らせない
  if (persist) {
    flashZoomName(current.label);
    window.hitomi.saveSettings({ zoom: state.zoom, ...(current.min && window.BunkoUI ? { uiCoverSizes: state.settings.uiCoverSizes } : {}) });
  }
}

function pulseQueueBadge() {
  els.queueCount.classList.remove('pulse');
  void els.queueCount.offsetWidth;
  els.queueCount.classList.add('pulse');
}

function applyCatalog(snapshot) {
  if (!snapshot) return;
  state.scanning = Boolean(snapshot.scanning);
  if (!state.scanning) state.scanProgress = null;
  renderLibrary();
}

async function runRescan() {
  if (state.scanning) return;
  state.scanning = true;
  state.scanProgress = null;
  renderLibrary();
  try {
    const result = await window.hitomi.rescan();
    applyCatalog(result);
    toast(`スキャン完了: 済 ${result.ownedCount.toLocaleString()}`, { type: 'success' });
    const epoch = searchEpoch;
    const fresh = await window.hitomi.annotate(state.galleries);
    // 待っている間に検索が切り替わっていたら、古い一覧で上書きしない
    if (epoch !== searchEpoch) return;
    state.galleries = fresh;
    adoptAnnotated(fresh);
    updateOwnedMarks(state.galleries.filter((item) => item.owned).map((item) => item.id));
  } catch {
    state.scanning = false;
    renderLibrary();
    toast('再スキャンに失敗しました', { type: 'error' });
  }
}

async function runSyncHomecore() {
  const btn = els.setSyncHomecore;
  if (btn.disabled) return;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '同期中…';
  try {
    const result = await window.hitomi.syncHomecore();
    if (result && result.ok) {
      toast('写しへ送りました', { type: 'success' });
    } else {
      const reason = (result && result.message) || '';
      toast(reason ? `同期できませんでした: ${reason}` : '同期できませんでした', { type: 'error' });
    }
  } catch {
    toast('同期できませんでした', { type: 'error' });
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

const LIBRARY_HINT = 'メタデータと Eagle タグは自動で同期';
// 裏の自動処理を切っている間は、言っていることと起きていることが食い違う (項目 5-2)
const LIBRARY_HINT_MANUAL = '裏の自動処理は切っています (メタもタグも取りに行きません)';

// 走っている仕事を上から 1 つだけ拾う。行はひとつなので先勝ちでいい
function activeLibraryJob(status) {
  if (state.scanning) {
    const scanned = Number(state.scanProgress?.scanned || 0);
    const total = Number(state.scanProgress?.total || 0);
    const reread = state.scanProgress?.reread;
    const tail = total ? `/${total.toLocaleString()}` : '';
    // 「確認」は mtime の突き合わせだけ。実際にファイルを開いた数を別に見せて、
    // 毎回全部を読み直しているように見える誤解を避ける
    const detail = Number.isFinite(Number(reread)) ? ` · 読み直し ${Number(reread).toLocaleString()}` : '';
    return { text: `確認中… ${scanned.toLocaleString()}${tail}${detail}`, done: scanned, total };
  }
  const backfill = status.backfill;
  if (backfill && backfill.running) {
    const done = Number(backfill.done || 0) + Number(backfill.failed || 0);
    const total = Number(backfill.total || 0);
    return { text: `メタデータ取得中 ${done.toLocaleString()}/${total.toLocaleString()}`, done, total };
  }
  const match = status.matchJob;
  if (match && match.running) {
    const done = Number(match.done || 0);
    const total = Number(match.total || 0);
    const matched = Number(match.matched || 0).toLocaleString();
    return {
      text: `タイトル照合中 ${done.toLocaleString()}/${total.toLocaleString()} · 一致 ${matched}`,
      done,
      total,
    };
  }
  const tagger = status.eagleTagJob;
  if (tagger && tagger.running) {
    const done = Number(tagger.done || 0);
    const total = Number(tagger.total || 0);
    return { text: `Eagle タグ書き込み中 ${done.toLocaleString()}/${total.toLocaleString()}`, done, total };
  }
  return null;
}

// ライブラリはこの 1 行に集約: 値は検索できる所持作品数、ヒントは今動いている仕事
function renderLibrary() {
  const status = state.library || {};
  els.setRescan.disabled = state.scanning;
  els.setOwned.textContent = `${Number(status.withMeta || 0).toLocaleString()} 作品`;
  const job = activeLibraryJob(status);
  const autoOff = (state.settings || {}).autoSync === false;
  els.setLibraryHint.textContent = job
    ? job.text
    : (autoOff ? LIBRARY_HINT_MANUAL : LIBRARY_HINT);
  els.setLibraryBar.hidden = !job || !job.total;
  const bar = els.setLibraryBar.firstElementChild;
  if (!els.setLibraryBar.hidden && bar) {
    bar.style.width = `${Math.min(100, Math.round((job.done / job.total) * 100))}%`;
  }
  renderHealth(status);
}

// 走査・照合・タグ・控えの内訳。数えてはいたのに画面のどこにも出ていなかった
// (項目 5-4 / 5-10)。帯は一つしか出せないので、内訳はここで見る
function renderHealth(status) {
  if (!els.setHealth) return;
  const n = (value) => Number(value || 0).toLocaleString();
  const match = status.titleMatch || {};
  const tag = status.eagleTag || {};
  const parts = [];
  if (Number(status.unmatchedEagle)) parts.push(`未照合 ${n(status.unmatchedEagle)}`);
  if (Number(match.pending)) parts.push(`照合待ち ${n(match.pending)}`);
  if (Number(tag.pending)) parts.push(`タグ待ち ${n(tag.pending)}`);
  if (Number(status.fallbacks)) parts.push(`焼いて出す本 ${n(status.fallbacks)}`);
  els.setHealth.textContent = parts.length ? parts.join(' · ') : '待ちなし';

  // 直らない状態は色を変えて、理由を下の行に出す
  const flags = status.flags || {};
  let trouble = '';
  if (status.scanError) {
    const d = status.scanDetail;
    trouble = d
      ? `走査: ${Number(d.prev).toLocaleString()} → ${Number(d.kept).toLocaleString()} 件に激減したので見送りました`
      : `走査が転びました (${status.scanError})`;
  }
  else if (flags['library-unreachable']) trouble = 'Eagle ライブラリが見えません';
  else if (flags['catalog-empty']) trouble = '台帳を空から作り直しました';
  else if (flags['eagle-tag-stalled']) trouble = 'Eagle へのタグ書き込みが止まっています';
  els.setHealth.classList.toggle('warn', Boolean(trouble));
  // 内訳は一行に収まらないことがある: 全文は札 (tooltip) に持たせる
  els.setHealth.title = els.setHealth.textContent;
  // 直らない状態は、いま動いている仕事より先に言う (下の行はひとつしかない)
  if (trouble) els.setLibraryHint.textContent = trouble;
  // 写しでは控えを捨てられない (写しを読み直すだけ)。釦の名乗りを実態に合わせる
  els.setRescan.textContent = readOnlyMode() ? '写しを読み直す' : '全件を読み直す';
}

function applyLibrary(status) {
  if (!status) return;
  state.library = status;
  renderLibrary();
  renderNotice();
}

// 状態の帯。「今この機体で何が起きているか」を一枚にまとめて棚へ重ねる。
// 個別のトーストを増やさないのは、トーストは消えてしまうから:
// 走査が転んだ・控えが無い・配信が落ちた は、直るまで出ていてほしい。
//
// 出す順は「利用者が今困る順」。一度に一つだけ出す (積むと帯が育ってガタつく)
const NOTICE_SILENCED = new Set();

function noticeOf(status) {
  const flags = (status && status.flags) || {};
  // 1. 進んでいる仕事 (進みの棒つき)
  const job = activeLibraryJob(status);
  if (job) return { key: 'job', text: job.text, done: job.done, total: job.total };
  // 2. 直らないまま残っている状態
  if (status && status.scanError) {
    const d = status.scanDetail;
    // 「激減したので取り込まなかった」は、何が起きたかを数で言う。
    // これは安全弁が働いた結果なので、利用者が確かめてから組み直す
    // 帯は一行。長い説明は title (載せると読めるようにする) へ回す
    const text = d
      ? `蔵書が ${Number(d.prev).toLocaleString()} → ${Number(d.kept).toLocaleString()} 件に激減。取り込みを見送りました`
      : `蔵書の走査に失敗しました (${status.scanError})`;
    const hint = d
      ? 'Eagle のフォルダ分けを確かめて、設定の「全件を読み直す」で組み直せます'
      : '';
    return { key: 'scan', text, hint, warn: true };
  }
  if (flags['library-unreachable']) {
    return { key: 'library', text: 'Eagle ライブラリが見えません。所持の判定と所持作品の頁が出ません', warn: true };
  }
  if (flags['catalog-empty']) {
    return { key: 'catalog-empty', text: '棚の台帳が壊れていたので空から作り直しました。設定から「再スキャン」で組み直せます', warn: true };
  }
  if (flags['catalog-restored']) {
    return { key: 'catalog-restored', text: '棚の台帳が壊れていたので控えから戻しました', warn: true };
  }
  if (flags['config-corrupt']) {
    return { key: 'config', text: '設定が壊れていたので既定に戻しました (元の設定は config.json.broken に残しています)', warn: true };
  }
  if (flags['lan-failed']) {
    return {
      key: 'lan',
      text: '手のひら版の配信を開けませんでした (設定の「スマホ・タブレットから読む」で開き直せます)',
      warn: true,
    };
  }
  if (flags['eagle-tag-stalled']) {
    return { key: 'tagger', text: 'Eagle へのタグ書き込みが止まっています (Eagle が起動していないか、API が無効です)', warn: true };
  }
  // pixiv の状態 (残り時間は分の粒度: 秒で書き換えると帯の幅が毎秒揺れる)
  if (flags['pixiv-relogin']) {
    return { key: 'pixiv-relogin', text: 'pixiv にログインし直してください (設定の「取り込み」)', warn: true };
  }
  if (flags['pixiv-cooldown']) {
    const minutes = Math.max(1, Math.ceil((Number(status.pixivPausedForMs) || 0) / 60000));
    return { key: 'pixiv-cooldown', text: `pixiv が混んでいます。あと約 ${minutes} 分は網に出ません`, warn: true };
  }
  if (flags['pixiv-import-wait']) {
    const count = Number(status.pixivImportWaiting) || 0;
    return { key: 'pixiv-import', text: `Eagle が起動していないので pixiv の取り込みを待っています${count ? ` (${count} 件)` : ''}`, warn: true };
  }
  if (flags.cacheless) {
    return { key: 'cacheless', text: '走査の控えが無いので、起動のたびに全件を読み直しています', warn: true };
  }
  if (Number(status && status.fallbacks) > 0) {
    return { key: 'fallbacks', text: `${status.fallbacks} 冊は綴じ目から直に読めず、焼いて出しています`, warn: false };
  }
  return null;
}

// 帯の幅は**文の長さに合わせる**。
// flex の内在サイズ計算は中身より狭い値を出すことがあり (実測 240px)、
// CSS だけだと短い報せでも「Eagle タ…」に切られる。
// 写し身を一枚置いて素の幅を測り、余白と部品のぶんを足して幅を決める
let noticeRuler = null;

function noticeTextWidth(text) {
  if (!noticeRuler) {
    noticeRuler = document.createElement('span');
    noticeRuler.setAttribute('aria-hidden', 'true');
    noticeRuler.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;'
      + 'white-space:nowrap;top:-1000px;left:0';
    document.body.appendChild(noticeRuler);
  }
  // 文と同じ顔で測る (帯の font-size は .84rem)
  noticeRuler.style.font = getComputedStyle(els.noticeText).font;
  noticeRuler.textContent = String(text || '');
  return Math.ceil(noticeRuler.getBoundingClientRect().width);
}

// 左の余白 14 + 右の余白 8 + 枠線 2 + × 22 + × の前の隙間 10
const NOTICE_CHROME = 56;
// 進みの棒 84 + その前の隙間 10
const NOTICE_BAR = 94;

function fitNotice(text, hasBar) {
  const want = noticeTextWidth(text) + NOTICE_CHROME + (hasBar ? NOTICE_BAR : 0);
  const room = Math.min(720, Math.max(240, window.innerWidth - 120));
  els.notice.style.width = `${Math.max(160, Math.min(room, want))}px`;
}

// 閉じる釦と窓の測り直しは帯の描画側で束ねる。
// bind の並びに置くと、前の行が転んだ回に配線されず「閉じられない帯」になる
let noticeWired = false;

function wireNotice() {
  if (noticeWired || !els.notice) return;
  noticeWired = true;
  els.noticeClose?.addEventListener('click', () => {
    const key = els.notice.dataset.key;
    if (key) NOTICE_SILENCED.add(key);
    els.notice.hidden = true;
  });
  // 窓の幅が変わると入る量も変わる: 出ている間だけ測り直す
  window.addEventListener('resize', () => {
    if (els.notice.hidden) return;
    renderNotice();
  });
}

function renderNotice() {
  wireNotice();
  if (!els.notice) return;
  const item = noticeOf(state.library || {});
  if (!item || NOTICE_SILENCED.has(item.key)) {
    els.notice.hidden = true;
    return;
  }
  els.notice.classList.toggle('warn', item.warn === true);
  els.noticeText.textContent = item.text;
  // 一行に収まらない説明は載せた時に読める
  els.notice.title = item.hint ? `${item.text}
${item.hint}` : item.text;
  els.notice.dataset.key = item.key;
  const hasBar = Number(item.total) > 0;
  els.noticeBar.hidden = !hasBar;
  // 幅を決めてから出す。先に出すと、前の報せの幅から新しい幅へ滑るのが見える
  // (畳んでいる間も席は残っているので、出す前に測れる)
  fitNotice(item.text, hasBar);
  els.notice.hidden = false;
  const fill = els.noticeBar.firstElementChild;
  if (hasBar && fill) {
    const ratio = Math.min(100, Math.round((Number(item.done) || 0) / item.total * 100));
    fill.style.width = `${ratio}%`;
  }
}

// 数え上げが取れなくても検索そのものは続けられる: 黙って諦める
async function refreshLibrary() {
  try {
    applyLibrary(await window.hitomi.libraryStatus());
  } catch {
    renderLibrary();
  }
}

// 所持済みの伏せ札: 表示だけを間引く。取得や頁送りには手を出さない。
// 3 モード: dupes = 所持済みの版違いだけ伏せる / owned = 所持済みも伏せる
// / none = すべて見せる。クリックで dupes → owned → none → dupes と巡る
const HIDE_OWNED_MODES = ['dupes', 'owned', 'none'];

function hideOwnedMode() {
  const stored = (state.settings || {}).hideOwnedMode;
  if (HIDE_OWNED_MODES.includes(stored)) return stored;
  // hitomi / pixiv は本家の結果を間引かず表示する。明示した非表示設定は維持する。
  if ((state.settings || {}).hideOwned === true) return 'owned';
  return ['hitomi', 'pixiv'].includes(state.source) ? 'none' : 'dupes';
}


const HIDE_OWNED_LABELS = {
  dupes: '表示: 所持済みの版違いを隠す (クリックで所持済みも隠す)',
  owned: '表示: 所持済みを隠す (クリックですべて表示)',
  none: '表示: すべて (クリックで版違いを隠す)',
};

function fillHideOwnedToggle() {
  queueMicrotask(() => window.BunkoUI?.sync());
  // ライブラリは所持作品しか出さない: ここで伏せたら何も残らない
  const library = libraryScope();
  const mode = library ? 'none' : hideOwnedMode();
  // できない道具は出さない: 所持作品では押しても何も変わらないので引っ込める
  // (枠 .tail-tools が幅を持ち続けるので、消えても帯の折り返しは動かない)。
  // Home の作者頁を所持の本だけにしている間も同じ (伏せる網の作品が無い)
  els.hideOwned.hidden = library || Boolean(window.BunkoHome?.ownedOnlyActive?.());
  if (!window.BunkoUI) setToggle(els.hideOwned, {
    on: mode !== 'none',
    iconOn: mode === 'owned' ? ICON.eyeOff : ICON.eye,
    iconOff: ICON.eye,
    label: library ? '所持作品では表示の間引きは無効' : HIDE_OWNED_LABELS[mode],
  });
  els.grid.classList.toggle('hide-owned', mode === 'owned');
  // 版違いの伏せ札は owned モードでも効かせる (所持済みを隠すなら、その
  // 版違いはなおさら見たくないはず)
  els.grid.classList.toggle('hide-similar', mode === 'owned' || mode === 'dupes');
  if (state.galleries.length) renderGrid(false);
  // 件数表示の「伏せ中」もモードに追随させる (検索前はまだ出ていない)
  if (state.interpreted) renderResultInfo(state.interpreted);
  // 全札が伏さったときの案内 (updateEmptyState) はこの切替でも動く
  updateEmptyState();
  // Home の作者頁 (一覧の器の外) にも同じ切り替えを写す。冊数もこれで数え直る
  window.BunkoHome?.refresh?.();
}

// お気に入り: Eagle の星がしきい値以上のものだけを残す。星は所持作品にしか
// 無いので、この札は所持作品スコープでしか立たない
function favoriteMinStars() {
  const raw = Math.round(Number((state.settings || {}).favoriteMinStars));
  return FAVORITE_STAR_CHOICES.includes(raw) ? raw : 4;
}

function favoritesOnlyEnabled() {
  return (state.settings || {}).favoritesOnly === true;
}

function favoriteLabel() {
  const min = favoriteMinStars();
  return min >= 5 ? '★5 のみ' : `★${min} 以上`;
}

function fillFavToggle() {
  if (!els.favOnly) return;
  const library = libraryScope();
  const on = favoritesOnlyEnabled() && library;
  // web 検索には Eagle の評価が無い: 押せる札を出さずに引っ込める
  els.favOnly.hidden = !library;
  setToggle(els.favOnly, {
    on,
    iconOn: ICON.starOn,
    iconOff: ICON.star,
    label: `お気に入りだけ (${favoriteLabel()})`,
  });
}

// pawchive のお気に入り一覧にだけ出す釦。押すと外部ツールがやっていた
// 「新着を全部取り込む」が走る。走っている間は停止釦に化ける
function pawBulkVisible() {
  // pixiv: 作者の投稿一覧 (user:<番号>) と候補の一覧に「未所持を全部落とす」を出す (§15 U8)。
  // 同じ釦と脇文を使い回す (指定席の幅を動かさない)
  if (state.source === 'pixiv') return Boolean(pixivBulkKind());
  // web のお気に入り一覧と、所持作品の pawchive 一覧の両方に出す。
  // 取り込む先はどちらの画面でも同じ (お気に入り作者の新着) なので隠す理由が無い
  if (state.source !== 'pawchive') return false;
  return libraryScope() || state.sort === 'favorites';
}

// pixiv の一括の種類。作者の投稿一覧なら user、候補の一覧なら bookmarks、他は無し
function pixivBulkKind() {
  if (state.source !== 'pixiv' || libraryScope()) return '';
  if (/(^|\s)user:\d+(\s|$)/.test(state.query || '')) return 'user';
  if (state.sort === 'bookmarks') return 'bookmarks';
  return '';
}

function pixivBulkUserId() {
  const hit = String(state.query || '').match(/(^|\s)user:(\d+)(\s|$)/);
  return hit ? hit[2] : '';
}

function pixivBulkLine(status) {
  const parts = [`積んだ ${Number(status.queued || 0)}`];
  if (status.seen) parts.push(`見た ${Number(status.seen)}`);
  if (status.resting) parts.push('休憩中');
  if (status.error) parts.push(`失敗: ${status.error}`);
  return parts.join(' ・ ');
}

// 今の画面で釦が指す一括の状態 (pixiv か pawchive か)
function bulkStatusNow() {
  return state.source === 'pixiv' ? (state.pixivBulk || {}) : (state.pawBulk || {});
}

async function togglePixivBulk() {
  const running = (state.pixivBulk || {}).running === true;
  const kind = pixivBulkKind();
  if (!running && !kind) return;
  if (!running) {
    const what = kind === 'user' ? 'この作者の未所持を全部' : '候補 (ブックマーク) の未所持を全部';
    const ok = await confirmDialog(`${what}落としますか? (pixiv の作法で数分掛かることがあります)`, { okLabel: '落とす' });
    if (!ok) return;
  }
  try {
    const status = await window.hitomi.pixiv({
      action: 'bulk', op: running ? 'stop' : 'start', kind, userId: pixivBulkUserId(),
    });
    state.pixivBulk = status || { running: false };
    fillPawBulk();
  } catch (error) {
    toast(`一括を始められませんでした: ${error && error.message ? error.message : error}`, { type: 'error' });
  }
}

function applyPixivBulk(status) {
  if (!status) return;
  const was = (state.pixivBulk || {}).running === true;
  state.pixivBulk = status;
  fillPawBulk();
  if (was && !status.running) {
    if (status.error) toast(`pixiv の一括: ${status.error}`, { type: 'error' });
    else toast(`pixiv の一括: ${Number(status.queued || 0)} 件を積みました`);
    pulseQueueBadge();
  }
}

function pawBulkLine(status) {
  const parts = [`作者 ${Number(status.creatorsDone || 0)}/${Number(status.creatorsTotal || 0)}`];
  parts.push(`投稿 ${Number(status.postsDone || 0)}件`);
  if (status.postsFailed) parts.push(`失敗 ${Number(status.postsFailed)}`);
  return parts.join(' ・ ');
}

function fillPawBulk() {
  if (!els.pawBulk) return;
  const show = pawBulkVisible();
  els.pawBulk.hidden = !show;
  els.pawBulkStatus.hidden = !show;
  if (!show) return;
  const pixiv = state.source === 'pixiv';
  const status = bulkStatusNow();
  const running = status.running === true;
  // この札だけは aria-pressed を持たない (入り切りではなく走る/止めるなので)
  const idle = pixiv
    ? (pixivBulkKind() === 'user' ? 'この作者の未所持を全部落とす' : '候補の未所持を全部落とす')
    : 'お気に入りを一括更新';
  setToggle(els.pawBulk, {
    on: running,
    iconOn: ICON.stop,
    iconOff: ICON.rescan,
    label: running ? (pixiv ? '一括を止める' : '一括更新を止める') : idle,
    pressed: false,
  });
  // 止まっているときは何も言わない: どこまで済んだかは台帳が持っていて、
  // 画面に出して意味のある「前回」のような節目はもう無い
  els.pawBulkStatus.textContent = running ? (pixiv ? pixivBulkLine(status) : pawBulkLine(status)) : '';
  els.pawBulkStatus.hidden = !els.pawBulkStatus.textContent;
}

// 走り終わったら一覧を引き直す: 取り込んだぶんの 済 を出すため
async function applyPawBulk(status) {
  if (!status) return;
  const was = (state.pawBulk || {}).running === true;
  state.pawBulk = status;
  fillPawBulk();
  if (was && !status.running) {
    if (status.postsDone) toast(`一括更新: ${status.postsDone} 件を取り込みました`, { type: 'success' });
    else if (status.error) toast(`一括更新: ${status.error}`, { type: 'error' });
    else toast('一括更新: 新着はありませんでした');
    if (pawBulkVisible()) await runSearch({ reset: true });
  }
}

async function togglePawBulk() {
  if (state.source === 'pixiv') {
    await togglePixivBulk();
    return;
  }
  const running = (state.pawBulk || {}).running === true;
  try {
    const status = await window.hitomi.pawBulk({ action: running ? 'stop' : 'start' });
    state.pawBulk = status;
    fillPawBulk();
  } catch {
    toast('一括更新を開始できませんでした', { type: 'error' });
  }
}

function loupeEnabled() {
  return (state.settings || {}).loupeEnabled !== false;
}

function fillLoupeToggle() {
  setSwitch(els.setLoupe, { on: loupeEnabled(), label: 'カードに載せると拡大' });
}

function setImgSource(img, src) {
  if (src) img.src = src;
  else img.removeAttribute('src');
}

// LAN 共有。状態は設定ファイルではなくサーバ自身が持っている (立っているか / どこに)
let lanStatus = { running: false, url: '', address: '', port: 0, candidates: [], error: '' };

function fillLanShare() {
  if (!els.setLan) return;
  setSwitch(els.setLan, {
    on: lanStatus.running,
    onText: '共有中',
    offText: '止めている',
    label: 'スマホ・タブレットから読む',
  });
  els.setLanUrl.textContent = lanStatus.running ? lanStatus.url : '—';
  els.setLanUrl.title = lanStatus.running ? lanStatus.url : '';
  els.setLanCopy.disabled = !lanStatus.running;
  const qr = lanStatus.running ? (lanStatus.qr || '') : '';
  els.setLanQr.hidden = !qr;
  // 止めているときは前の QR を残さない (もう繋がらないアドレスなので)。
  // 空の src は頁 (index.html) を絵として読みに行き、設定を開くたびに error を出していた。属性ごと外す
  setImgSource(els.setLanQrImg, qr);
  // Tailscale の口 (母艦に居るときだけ)。外から読むための第二の入り口
  const ts = lanStatus.running ? lanStatus.tailscale : null;
  els.setLanTsRow.hidden = !ts;
  els.setLanTsUrl.textContent = ts ? ts.url : '';
  els.setLanTsUrl.title = ts ? ts.url : '';
  els.setLanTsQr.hidden = !(ts && ts.qr);
  setImgSource(els.setLanTsQrImg, ts && ts.qr);
  if (lanStatus.error) {
    els.setLanNote.textContent = lanStatus.error;
    return;
  }
  els.setLanNote.textContent = lanStatus.running
    ? 'このアドレスを同じ Wi-Fi の端末のブラウザで開くと、手元にある作品を読めます。'
      + '合言葉はアドレスに含まれているので、渡す相手に気をつけてください。\n'
      + '初回は Windows のファイアウォールが確認を出します。プライベートネットワークだけ許可してください。'
    : '共有を入れると、この PC が小さなサーバになります。'
      + '繋がるのは同じ Wi-Fi の中だけで、合言葉付きのアドレスを知っている端末に限られます。';
}

// 口が投げた時だけでなく、**何も返さなかった時**も受ける。
// 返りをそのまま入れると lanStatus が undefined になり、次の fillLanShare が
// 拾われない例外で落ちて、設定画面の LAN の行が死んだままになる
function lanShapeOf(value) {
  if (value && typeof value === 'object') return value;
  return { running: false, url: '', address: '', port: 0, candidates: [], error: '状態を取得できませんでした' };
}

async function refreshLanShare() {
  if (!els.setLan) return;
  try {
    lanStatus = lanShapeOf(await window.hitomi.lanShare({ action: 'status' }));
  } catch {
    lanStatus = lanShapeOf(null);
  }
  fillLanShare();
}

async function toggleLanShare() {
  const next = !lanStatus.running;
  els.setLan.disabled = true;
  try {
    lanStatus = await window.hitomi.lanShare({ action: next ? 'start' : 'stop' });
  } catch {
    lanStatus = { running: false, url: '', candidates: [], error: '切り替えられませんでした' };
  }
  els.setLan.disabled = false;
  fillLanShare();
  if (next && lanStatus.running) toast('LAN 共有を始めました');
  else if (next) toast(lanStatus.error || 'LAN 共有を始められませんでした', { type: 'error' });
  else toast('LAN 共有を止めました');
}

// 最終頁の先で隣へ渡るのは常に。ここは渡る前に札 (隣の顔) を一度挟むかどうか
function readerNextCardEnabled() {
  return (state.settings || {}).readerNextCard === true;
}

function fillReaderNextCardToggle() {
  setSwitch(els.setReaderNextCard, {
    on: readerNextCardEnabled(),
    onText: '見せる',
    offText: '直に開く',
    label: '最終頁で次の作品の札',
  });
}

function readerResumeEnabled() {
  return (state.settings || {}).readerResume !== false;
}

function fillReaderResumeToggle() {
  setSwitch(els.setReaderResume, { on: readerResumeEnabled(), label: '途中から再開' });
}

function ownedSaveConfirmEnabled() {
  return (state.settings || {}).ownedSaveConfirm !== false;
}

function fillOwnedConfirmToggle() {
  setSwitch(els.setOwnedConfirm, {
    on: ownedSaveConfirmEnabled(),
    onText: '確認する',
    offText: '確認しない',
    label: '持っている作品を保存する前に確認する',
  });
}

function autoSyncEnabled() {
  return (state.settings || {}).autoSync !== false;
}

function fillAutoSyncToggle() {
  setSwitch(els.setAutoSync, {
    on: autoSyncEnabled(),
    onText: '自動',
    offText: '手動',
    label: '裏の自動処理',
  });
}

function showUnmatchedEnabled() {
  return (state.settings || {}).showUnmatchedEagle !== false;
}

function fillShowUnmatchedToggle() {
  setSwitch(els.setShowUnmatched, {
    on: showUnmatchedEnabled(),
    onText: '表示',
    offText: '隠す',
    label: '紐付いていない所持作品',
  });
}

// 保存形式: zip = ZIP に固める / raw = 画像のままフォルダへ / pdf = 1 冊にまとめる
const SAVE_FORMATS = ['zip', 'raw', 'pdf'];

function saveFormat() {
  const value = (state.settings || {}).saveFormat;
  return SAVE_FORMATS.includes(value) ? value : 'zip';
}

// long paths are elided in the row: the full string lives in the tooltip
function fillPathValue(node, value) {
  node.textContent = value || '未設定';
  if (value) node.title = value;
  else node.removeAttribute('title');
}

function fillSettingsFields() {
  const settings = state.settings || {};
  fillPathValue(els.setDownloadDir, settings.downloadDir);
  fillPathValue(els.setEagleDir, settings.eagleLibrary);
  fillPathValue(els.setPawBulkDir, settings.pawBulkDir);
  els.setPawBulkConcurrency.value = String(settings.pawBulkConcurrency ?? 2);
  els.setSaveFormat.value = saveFormat();
  els.setConcurrency.value = String(settings.concurrency ?? 4);
  els.setMaxGalleries.value = String(settings.maxGalleries ?? 8);
  els.setTrayClose.value = String(settings.trayCloseMinutes ?? 30);
  els.setOpenOwned.value = openOwnedPrefersEagle() ? 'eagle' : 'app';
  els.setHomeUnresolved.value = homeUnresolvedOnly() ? 'on' : 'off';
  fillFavoriteSetting();
  els.setMouseLeft.value = cardAction('Left');
  els.setMouseRight.value = cardAction('Right');
  els.setMouseDouble.value = cardAction('Double');
  fillLoupeToggle();
  fillReaderNextCardToggle();
  fillReaderResumeToggle();
  fillOwnedConfirmToggle();
  fillAutoSyncToggle();
  fillShowUnmatchedToggle();
  fillLanShare();
  // 立っているかはサーバに訊かないと分からない。設定を開くたび引き直す
  refreshLanShare();
  renderLibrary();
}

function fillFavoriteSetting() {
  if (!els.setFavoriteStars) return;
  els.setFavoriteStars.value = String(favoriteMinStars());
  if (els.setFavoriteValue) els.setFavoriteValue.textContent = favoriteLabel();
}

// the modal is two panes now: the left rail picks which drawer the right pane shows
function selectSettingsTab(name) {
  const tabs = document.querySelectorAll('.settings-tab');
  const panels = document.querySelectorAll('.settings-tabpanel');
  if (!tabs.length) return;
  let target = name;
  if (!Array.prototype.some.call(tabs, (tab) => tab.dataset.tab === target)) {
    target = tabs[0].dataset.tab;
  }
  tabs.forEach((tab) => {
    const on = tab.dataset.tab === target;
    tab.classList.toggle('active', on);
    tab.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  panels.forEach((panel) => {
    panel.hidden = panel.dataset.tab !== target;
  });
  const pane = document.querySelector('.settings-pane');
  if (pane) pane.scrollTop = 0;
}

// 最後に開いていた頁を憶える。設定を開くたび先頭へ戻ると、同じ所を直すのに
// 毎回探し直すことになる (項目 5-12)
const SETTINGS_TAB_KEY = 'bunko.settingsTab';

function rememberSettingsTab(name) {
  try {
    localStorage.setItem(SETTINGS_TAB_KEY, String(name || ''));
  } catch {
    // 憶えられなくても開く邪魔はしない
  }
}

function lastSettingsTab() {
  try {
    return localStorage.getItem(SETTINGS_TAB_KEY) || null;
  } catch {
    return null;
  }
}

function bindSettingsTabs() {
  document.querySelectorAll('.settings-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      selectSettingsTab(tab.dataset.tab);
      rememberSettingsTab(tab.dataset.tab);
    });
  });
}

function openSettings() {
  if (window.BunkoPreferences) { window.BunkoPreferences.open(); return; }
  fillSettingsFields();
  selectSettingsTab(lastSettingsTab());
  els.settings.hidden = false;
  refreshLibrary();
  refreshPixivStatus();
  // 焦点を窓の中へ入れる。入っていないと Esc も Tab も外の棚に効いてしまう
  const first = document.querySelector('.settings-tab.active') || els.settings;
  if (first && typeof first.focus === 'function') first.focus();
}

function closeSettings() {
  window.BunkoPreferences?.discard();
  els.settings.hidden = true;
}

function isTypingGlobal() {
  const node = document.activeElement;
  if (!node) return false;
  const tag = node.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable;
}

const MOUSE_ACTION_LABELS = { detail: '詳細', read: '読む', save: '保存', none: 'なし' };

function mouseActionLabel(kind) {
  return MOUSE_ACTION_LABELS[cardAction(kind)] || 'なし';
}

function renderHelp() {
  els.helpBody.innerHTML = `
    <div class="help-group">
      <h3>グローバル</h3>
      <div class="help-rows">
        <div class="help-row"><kbd>/</kbd><span>検索</span></div>
        <div class="help-row"><kbd>Ctrl+ホイール</kbd><span>カードサイズ</span></div>
      </div>
    </div>
    <div class="help-group">
      <h3>リーダー頁</h3>
      <div class="help-rows">
        <div class="help-row"><kbd>← →</kbd><span>頁送り</span></div>
        <div class="help-row"><kbd>Space</kbd><span>次の頁</span></div>
        <div class="help-row"><kbd>Home</kbd><span>先頭へ</span></div>
        <div class="help-row"><kbd>End</kbd><span>最後へ</span></div>
        <div class="help-row"><kbd>g</kbd><span>頁ジャンプ</span></div>
      </div>
    </div>
    <div class="help-group">
      <h3>リーダー表示</h3>
      <div class="help-rows">
        <div class="help-row"><kbd>s</kbd><span>見開き</span></div>
        <div class="help-row"><kbd>d</kbd><span>綴じ</span></div>
        <div class="help-row"><kbd>f</kbd><span>全画面</span></div>
        <div class="help-row"><kbd>t</kbd><span>サムネイル</span></div>
        <div class="help-row"><kbd>ダブルクリック</kbd><span>拡大</span></div>
        <div class="help-row"><kbd>ドラッグ</kbd><span>移動</span></div>
        <div class="help-row"><kbd>Ctrl+ホイール</kbd><span>ズーム</span></div>
      </div>
    </div>
    <div class="help-group">
      <h3>マウス割り当て</h3>
      <div class="help-rows">
        <div class="help-row"><kbd>左クリック</kbd><span>${mouseActionLabel('Left')}</span></div>
        <div class="help-row"><kbd>右クリック</kbd><span>${mouseActionLabel('Right')}</span></div>
        <div class="help-row"><kbd>ダブルクリック</kbd><span>${mouseActionLabel('Double')}</span></div>
      </div>
    </div>
    <div class="help-group">
      <h3>絞り込みと表示</h3>
      <div class="help-rows">
        <div class="help-row"><kbd>右クリック</kbd><span>種類の札: その種類を除外 (もう一度で解除)</span></div>
        <div class="help-row"><kbd>Ctrl+ホイール</kbd><span>表紙の大きさ</span></div>
      </div>
    </div>
  `;
}

function openHelp() {
  renderHelp();
  els.help.hidden = false;
}

function closeHelp() {
  els.help.hidden = true;
}

function toggleHelp() {
  if (els.help.hidden) openHelp();
  else closeHelp();
}

function clampNumber(value, min, max, fallback) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

async function saveLimit(key, input, min, max) {
  const next = clampNumber(input.value, min, max, state.settings[key] ?? min);
  input.value = String(next);
  if (await saveSetting({ [key]: next })) fillSettingsFields();
}

const history = [];
let historyIndex = -1;
let navigating = false;
let historyRestoreToken = 0;
const historySnapshots = NavigationState.createCache();

function currentScrollAnchor() {
  const cards = [...els.grid.querySelectorAll('.card[data-id]')].map((card) => ({
    id: card.dataset.id,
    top: card.getBoundingClientRect().top + window.scrollY,
    height: card.offsetHeight,
  }));
  return NavigationState.scrollAnchor(cards, window.scrollY);
}

function restoreScroll(anchor, fallback = 0) {
  // Home: 作者頁は一覧の札を持たない (見ていた高さへ戻すだけ)。一覧を頭で閉じていた時は頭のまま
  // (見ていた札が無い時に先頭の札の上端 = 上部の下へ潜る位置へ送らない)
  if (state.source === 'home' && !libraryScope()) {
    const author = String(state.query || '').trim().startsWith('@');
    if (author || !(Number(fallback) > 0)) {
      window.scrollTo(0, Math.max(0, Number(fallback) || 0));
      return;
    }
  }
  const cards = [...els.grid.querySelectorAll('.card[data-id]')].map((card) => ({
    id: card.dataset.id,
    top: card.getBoundingClientRect().top + window.scrollY,
    height: card.offsetHeight,
  }));
  const exact = cards.some((item) => anchor && String(item.id) === String(anchor.id));
  if (exact || !anchor) {
    window.scrollTo(0, NavigationState.anchorScrollTop(anchor, cards, fallback));
    return;
  }
  const index = visibleGridItems().findIndex((item) => sameId(item.id, anchor.id));
  if (index < 0) {
    window.scrollTo(0, Number(fallback) || 0);
    return;
  }
  window.scrollTo(0, els.grid.getBoundingClientRect().top + window.scrollY
    + Math.floor(index / gridColumns()) * gridRowHeight + (Number(anchor.offset) || 0));
  renderGrid(false, true);
  requestAnimationFrame(() => restoreScroll(anchor, fallback));
}

function snapshotCurrentHistory() {
  const entry = history[historyIndex];
  if (!entry || state.discovery || state.loading) return;
  entry.loadedPages = state.page;
  entry.scroll = window.scrollY;
  entry.scrollAnchor = currentScrollAnchor();
  historySnapshots.put(historyKey(entry), {
    galleries: state.galleries,
    page: state.page,
    pageSize: state.pageSize,
    total: state.total,
    approximate: state.approximate,
    done: state.done,
    interpreted: state.interpreted || [],
    scroll: window.scrollY,
    anchor: currentScrollAnchor(),
    sortDir: sortDirValue(),
    pixivPeriod: state.pixivPeriod,
  });
}

// forward has to undo what back did: closing the reader / the drawer is a
// navigation too, so those closes leave a redo crumb here.
const redoStack = [];
let redoRestoring = false;

// 詳細やリーダーを開くのは履歴の前進: redo の面倒はここで見る (reader.js からも呼ぶ)
function dropRedoUnlessRestoring() {
  if (!redoRestoring) redoStack.length = 0;
}

function pushHistory() {
  redoStack.length = 0;
  // 発見ビューも足跡になる: 作品を見て戻ったとき一覧へ帰れるように
  const entry = state.discovery ? { view: 'discovery', source: state.source, sort: state.sort, scope: state.scope } : {
    query: state.query,
    source: state.source,
    scope: state.scope,
    type: state.type,
    excludedTypes: normalizeExcludedTypes(state.excludedTypes),
    language: state.language,
    sort: state.sort,
    sortDir: sortDirValue(),
    pixivPeriod: state.pixivPeriod,
  };
  const current = history[historyIndex];
  if (current && JSON.stringify(current) === JSON.stringify(entry)) return;
  history.splice(historyIndex + 1);
  history.push(entry);
  historyIndex = history.length - 1;
}

async function applyHistoryEntry(entry) {
  const restoreToken = (historyRestoreToken += 1);
  hideSuggest();
  if (entry.view === 'discovery') {
    state.source = entry.source || state.source; state.sort = entry.sort || state.sort; state.scope = entry.scope || 'all';
    state.query = ''; els.query.value = ''; renderSources(); window.BunkoUI?.sync();
    navigating = true;
    try {
      await enterDiscovery();
    } finally {
      navigating = false;
    }
    return;
  }
  state.query = entry.query;
  state.source = entry.source || 'hitomi';
  state.scope = entry.scope === 'library' ? 'library' : 'all';
  state.type = entry.type;
  state.excludedTypes = normalizeExcludedTypes(entry.excludedTypes);
  state.language = entry.language;
  state.sort = entry.sort;
  state.pixivPeriod = entry.pixivPeriod || 'year';
  if (entry.sortDir === 'asc' || entry.sortDir === 'desc') {
    state.settings = { ...(state.settings || {}), sortDir: entry.sortDir };
  }
  els.query.value = entry.query;
  renderSources();
  renderTypes();
  fillHideOwnedToggle();
  fillFavToggle();
  fillSelect(els.language, LANGUAGES, state.language);
  fillSelect(els.sort, activeSorts(), state.sort);
  fillSortDir();
  hideSuggest();
  navigating = true;
  try {
    const cached = historySnapshots.get(historyKey(entry));
    if (cached && cached.sortDir === sortDirValue()) {
      searchEpoch += 1;
      state.galleries = cached.galleries;
      state.page = cached.page;
      state.total = cached.total;
      state.approximate = cached.approximate;
      state.done = cached.done;
      state.interpreted = cached.interpreted;
      state.error = '';
      state.loading = false;
      markResultDupes({ reset: true });
      renderResultInfo(state.interpreted);
      // Home の作者頁を畳む/並べるのは一覧を描く前 (畳まれた器で Waterfall が幅 0 の段を組まないように)
      window.BunkoHome?.sync(true);
      renderGrid(false, true);
      requestAnimationFrame(() => {
        if (restoreToken === historyRestoreToken) restoreScroll(cached.anchor, cached.scroll);
      });
      refreshOwnedMarks();
    } else {
      await runSearch({ reset: true, restoreToken });
      const restorePages = Math.max(1, Number(entry.loadedPages) || 1);
      while (restoreToken === historyRestoreToken && state.page < restorePages && !state.done && !state.error) {
        const before = state.page;
        await runSearch({ reset: false, restoreToken });
        if (restoreToken !== historyRestoreToken || state.page <= before) break;
      }
      if (entry.scroll || entry.scrollAnchor) {
        requestAnimationFrame(() => {
          if (restoreToken === historyRestoreToken) restoreScroll(entry.scrollAnchor, entry.scroll);
        });
      }
    }
  } finally {
    navigating = false;
  }
}

// the same physical mouse press can arrive twice (DOM mouseup + Windows APPCOMMAND)
let lastNavAt = 0;

function navBack() {
  const now = Date.now();
  if (now - lastNavAt < 250) return;
  lastNavAt = now;
  // the settings modal is not worth a redo crumb: reopening it would be noise
  if (!els.settings.hidden) closeSettings();
  else if (Reader.isOpen()) {
    if (state.reader?.gallery) {
      // 一覧に居ない作品 (関連から渡った物) でも進むで戻れるよう、札そのものを抱える
      redoStack.push({ kind: 'reader', id: state.reader.gallery.id, page: state.reader.page, gallery: state.reader.gallery });
    }
    // 継ぎ目 (次の作品・関連作品) で渡り歩いた途中なら、閉じずに一つ前の作品へ帰る
    if (Reader.trailLength() && Reader.back()) return;
    Reader.close();
  } else if (!els.detail.hidden) {
    // 版違いリストから渡り歩いた途中なら、閉じずに一つ前の詳細へ帰る
    if (detailTrail.length) {
      openDetail(detailTrail.pop(), { keepTrail: true });
      return;
    }
    if (state.selected?.id) redoStack.push({ kind: 'detail', id: state.selected.id });
    state.selected = null;
    renderDetail(null);
  } else if (historyIndex > 0) {
    snapshotCurrentHistory();
    redoStack.push({ kind: 'history' });
    historyIndex -= 1;
    applyHistoryEntry(history[historyIndex]);
  }
}

function stepHistoryForward() {
  if (historyIndex >= history.length - 1) return;
  snapshotCurrentHistory();
  historyIndex += 1;
  applyHistoryEntry(history[historyIndex]);
}

function navForward() {
  const now = Date.now();
  if (now - lastNavAt < 250) return;
  lastNavAt = now;

  const entry = redoStack.pop();
  if (entry) {
    if (entry.kind === 'history') {
      stepHistoryForward();
      return;
    }
    redoRestoring = true;
    try {
      const gallery = entry.kind === 'reader' ? (findGallery(entry.id) || entry.gallery || null) : null;
      // pawchive の ID は文字列 (pw:...) なので Number 比較は常に外れる: sameId で見る
      if (gallery && !gallery.error && sameId(gallery.id, entry.id)) {
        Reader.open(gallery, entry.page || 0);
      } else {
        openDetail(entry.id);
      }
    } finally {
      redoRestoring = false;
    }
    return;
  }

  if (!els.settings.hidden || !els.reader.hidden || !els.detail.hidden) return;
  stepHistoryForward();
}

// Home で語を差す (本の詳細のタグを押した等)。作者名で絞る Home の語にはならないので、
// その本の源泉 (分からなければ hitomi) へ移って引く。Home の見ていた所は写しに残す
function applyQueryFromHome(value) {
  const from = state.selected && state.selected.source !== 'home' ? state.selected.source : 'hitomi';
  const destination = shownSourceOr(from === 'ehentai' ? 'hitomi' : from);
  rememberSort();
  // 新しい語の旅を始める (前の旅の控えは捨てる)。Home の見ていた所はその後で写す
  invalidateSearchIntent();
  if (!state.loading) siteSearchSnapshots.set('home', captureSearchView());
  homeTrip.query = state.query;
  homeTrip.from = null;
  state.source = destination;
  state.sort = sortForSource(destination);
  state.type = '';
  state.excludedTypes = [];
  state.query = value;
  els.query.value = value;
  syncQueryClear();
  hideSuggest();
  window.hitomi.saveSettings({ source: destination });
  renderSources();
  renderTypes();
  runSearch({ reset: true });
}

// 圏外での取りこぼしは一度だけ拾う: 手動で全体に戻したらまた拾えるようにする
let offlineFallbackUsed = false;

// 検索の世代。追い読みの途中で条件が変わったとき、古い応答が新しい一覧に
// 混ざらないようにする (絞り込みを切り替えた直後がとくに危ない)
let searchEpoch = 0;
let activeSearchRequestId = '';
let searchRequestSequence = 0;

// spanPages: 所持作品の棚で「何頁ぶん」を一度に取るか (起動時の復元用)。網の検索は常に 1
// live = 打鍵ごとの引き直し。**引き直しそのものは同じ**で、live が変えるのは
// 「履歴に残すか」「候補を畳むか」「失敗を声に出すか」だけ
async function runSearch({
  reset = true, restoreToken = null, spanPages = 1, live = false,
} = {}) {
  if(activeSearchPlan?.blocked && activeSearchPlan.query===state.query) {state.loading=false;showSearchResolution();return;}
  if (reset && restoreToken == null) historyRestoreToken += 1;
  if (restoreToken != null && restoreToken !== historyRestoreToken) return;
  if (reset) syncPixivSortWithQuery();
  // 検索の操作は発見ビューから抜ける合図。追い読みは発見では起きない (done)
  if (reset && state.source === 'pixiv' && !libraryScope() && state.sort === 'recommended' && !state.query.trim()) { await enterDiscovery(); return; }
  if (reset) leaveDiscovery();
  else if (state.discovery) return;
  // 追い読みは 1 本だけ。条件を変えた引き直しは在庫を捨てて割り込む
  if (state.loading && !reset) return;
  if (!reset && state.done) return;

  if (reset && activeSearchRequestId && window.hitomi.cancelSearch) {
    window.hitomi.cancelSearch(activeSearchRequestId).catch(() => {});
  }
  const epoch = (searchEpoch += 1);
  const requestId = `renderer-${Date.now().toString(36)}-${(searchRequestSequence += 1).toString(36)}`;
  activeSearchRequestId = requestId;

  // 履歴・セッション復元などで value が組み替わった直後の × の出方を揃える
  syncQueryClear();
  // pixiv: 語が入ったら並びの select を「フォロー」から「新しい順」へ (履歴に積む前に)
  if (reset) syncPixivSortWithQuery();
  if(reset && state.source==='pawchive' && state.query.trim() && state.sort.startsWith('popular-')){
    state.sort='added';fillSelect(els.sort,activeSorts(),state.sort);window.BunkoUI?.sync();
  }

  // renderGrid が 該当なし を出すかは state.loading を見る。
  // 先に立てておかないと、reset の一瞬だけ 該当なし と 検索しています… が並ぶ。
  state.loading = true;
  if (reset) searchViewStale = false;

  // **結果が来るまで今の棚を残す。** 以前はここで galleries を空にして描き直して
  // いたので、引き直しのたびに棚が消えて 96px の「検索しています…」が生え、また
  // 消えていた。利用者の言う「読み込み中の空白とガタつき」の本体がこれ。
  // 差し替えは下の reconcileChildren が同期の一巡でやるので、空の中間は描かれない
  const priorPage = state.page;
  const priorDone = state.done;
  if (reset) {
    if (!navigating && !live) pushHistory();
    state.page = 0;
    state.done = false;
    state.error = '';
  }

  // 打鍵ごとの引き直しでは声を出さない。代わりに検索欄の 1px が脈打つ (高さは動かない)
  if (reset && !live) setStatus(libraryScope() ? '所持作品を検索しています…' : '検索しています…', false, true);
  else if (!reset) setStatus('続きを読み込み中…', false, true);
  const busyTimer = live ? setTimeout(() => els.form?.classList?.add('searching'), 120) : 0;
  const clearBusy = () => {
    if (!live) return;
    clearTimeout(busyTimer);
    els.form?.classList?.remove('searching');
  };

  let fallback = false;
  try {
    const result = await window.hitomi.search({
      requestId,
      query: state.query,
      authorNames: window.hitomi.searchAuthorNames?.(searchIntent),
      source: state.source,
      scope: state.scope,
      sort: state.sort,
      sortDir: sortDirNativeSupported() ? sortDirValue() : 'desc',
      pixivPeriod: state.source === 'pixiv' ? state.pixivPeriod : undefined,
      language: state.language,
      type: state.type,
      excludeTypes: typeExclusionSupported() ? state.excludedTypes : [],
      minStar: libraryScope() && favoritesOnlyEnabled() ? favoriteMinStars() : 0,
      unresolvedOnly: state.source === 'home' && homeUnresolvedOnly(),
      page: state.page,
      pageSize: state.pageSize,
      spanPages: libraryScope() ? Math.max(1, Math.min(60, Number(spanPages) || 1)) : 1,
    });
    // 待っている間に条件が変わったなら、この応答はもう古い
    if (epoch !== searchEpoch || (result.requestId && result.requestId !== requestId)) return;
    // 母屋が返す正規形で欄を整えるのは Enter で決めた時だけ。live でやると
    // 打鍵の途中で字が入れ替わり、カーソルごと飛ぶ
    if (reset && !live && result.query && result.query !== state.query) {
      if (queryJourney?.[state.source] === state.query) queryJourney[state.source] = result.query;
      state.query = result.query;
      els.query.value = result.query;
    }
    state.total = result.total;
    state.approximate = Boolean(result.approximate);
    // 相手が「この先は返せない」で打ち切った数。黙ると「これで全部」に見える (項目 7-10)
    state.truncated = Number(result.truncatedAfter) || 0;
    if (reset) state.interpreted = result.interpreted || [];
    // 相手が言い換えた時の一言 (pixiv の「全期間は無いので今月」など)。件数の行に添える
    if (reset) state.searchNotice = String(result.notice || '');
    state.galleries = reset ? result.galleries : state.galleries.concat(result.galleries);
    // 追い読みで代表が差し替わった札 (後から所持版が来た等) だけ描き直す
    markResultDupes({ reset }).forEach((item) => {
      const card = els.grid.querySelector(`.card[data-id="${item.id}"]`);
      if (card) refreshCard(item);
    });
    // 伏せ中の数は追い読みのたびに増えうる: 件数表示はここで毎回描き直す
    renderResultInfo(state.interpreted || []);
    // 何頁ぶん入っていたか (所持作品の一括取りは spanPages ぶん進む)
    const span = Math.max(1, Number(result.spanPages) || 1);
    state.done = typeof result.hasNext === 'boolean'
      ? !result.hasNext
      : result.galleries.length < state.pageSize * span;
    state.page += span;
    state.error = '';
    // ★ の初期状態は一覧を描く前に揃える。取りに行くのは引き直しのときだけでいい
    if (reset && !live && state.source === 'pawchive') {
      await refreshPawFavs();
      if (epoch !== searchEpoch) return;
    }
    // 描画の前に検索を終わらせる: 0 件のとき 該当なし を出せるようにする
    state.loading = false;
    setStatus('');
    // 札 (よく使う語) と 戻る/進む に残すのは「Enter で決めた語」だけ。
    // 打鍵ごとに残すと履歴が一字ずつの残骸で埋まり、設定の書き込みも毎打鍵になる
    if (reset && !live) rememberHistory();
    // 札には残さないが、閉じた時の続きには残す。rememberHistory の中で
    // 呼ばれている persistSession をここで補わないと、打った語が再起動で消える
    else if (reset) persistSession();
    // 当てる瞬間に頭へ戻す (renderGrid は window.scrollY を見て窓を決めるので前に)
    if (reset && window.scrollY > 0) window.scrollTo(0, 0);
    // Home: 作者頁の語なら本を並べ、一覧の語なら作者頁を畳む。一覧の差し替えと同じ一巡で
    // (間に空の棚を一こまも挟まない)。一覧を描く前に: 作者頁の間は一覧の器が畳まれていて、
    // 畳まれたまま描くと Waterfall が幅 0 で段を組む
    window.BunkoHome?.sync(true, reset ? result : null);
    renderGrid(!reset);
    if (state.source === 'pixiv' && !libraryScope()) rememberPixivTab();
    if (reset) window.BunkoUI?.revealResults();
    if (!state.done) {
      setTimeout(() => {
        if (state.loading || state.done) return;
        if (els.sentinel.getBoundingClientRect().top < window.innerHeight + 800) {
          runSearch({ reset: false, restoreToken });
        }
      }, 0);
    }
  } catch (error) {
    if (epoch !== searchEpoch) return;
    if (error && (error.name === 'AbortError' || /aborted|cancelled|canceled/i.test(error.message || ''))) return;
    state.error = error.message || String(error);
    // 何も当てないまま終わったので、頁の数え方を元へ戻す。戻さないと追い読みが
    // 古い一覧へ新しい語の頁 0 を継ぎ足して二重に並ぶ
    if (reset) {
      state.page = priorPage;
      state.done = priorDone;
    }
    fallback = reset && !live && !libraryScope() && navigator.onLine === false && !offlineFallbackUsed;
    // 打鍵の途中の失敗は黙る (棚は残っている)。空のまま失敗した時だけ言う
    if (!fallback && (!live || !state.galleries.length)) {
      const text = ipcErrorText(state.error);
      // pixiv に入っていないだけなら失敗ではなく案内 (赤にしない)
      if (/pixiv にログインしていません/.test(text)) {
        setStatus('pixiv にログインすると一覧が出ます (設定 → 取り込み → pixiv)', false);
      } else {
        setStatus(`検索に失敗しました: ${text}`, true);
      }
    }
  } finally {
    // 追い越された側は旗を降ろさない: 走っている新しい検索の持ち物なので
    if (activeSearchRequestId === requestId) activeSearchRequestId = '';
    if (epoch === searchEpoch) state.loading = false;
    clearBusy();
  }

  // 圏外なら所持作品へ退避する。スコープはユーザーが戻すまでそのまま
  if (fallback) {
    offlineFallbackUsed = true;
    state.scope = 'library';
    renderSources();
    renderTypes();
    fillHideOwnedToggle();
    persistSession();
    toast('オフラインのため所持作品から検索します');
    await runSearch({ reset: true, restoreToken });
  }
}

// 走査のあと (と写しの台帳の差し替えのあと) の棚の引き直し。今の頁数ぶんを一度に
// 取り直して札を入れ替える。見ている場所は動かさない (景色が飛ぶのが一番目につく)。
// 検索の最中なら少し待ってからもう一度 (回数は頭打ち)
async function refreshLibraryInPlace(attempt = 0) {
  if (!libraryScope() || state.discovery) return;
  if (state.loading) {
    if (attempt < 10) setTimeout(() => refreshLibraryInPlace(attempt + 1).catch(() => {}), 500);
    return;
  }
  const epoch = searchEpoch;
  const anchor = currentScrollAnchor();
  const fallback = window.scrollY;
  const span = Math.max(1, Math.min(60, state.page || 1));
  let result = null;
  try {
    result = await window.hitomi.search({
      requestId: `refresh-${Date.now().toString(36)}-${(searchRequestSequence += 1).toString(36)}`,
      query: state.query,
      authorNames: window.hitomi.searchAuthorNames?.(searchIntent),
      source: state.source,
      scope: state.scope,
      sort: state.sort,
      sortDir: sortDirNativeSupported() ? sortDirValue() : 'desc',
      language: state.language,
      type: state.type,
      excludeTypes: typeExclusionSupported() ? state.excludedTypes : [],
      minStar: libraryScope() && favoritesOnlyEnabled() ? favoriteMinStars() : 0,
      page: 0,
      pageSize: state.pageSize,
      spanPages: span,
    });
  } catch {
    return;
  }
  // 待っている間に検索が切り替わっていたら、古い一覧で上書きしない
  if (epoch !== searchEpoch || !result || state.loading) return;
  state.galleries = result.galleries || [];
  state.total = result.total;
  state.approximate = Boolean(result.approximate);
  state.done = state.galleries.length < state.pageSize * span;
  state.page = span;
  state.error = '';
  markResultDupes({ reset: true });
  adoptAnnotated(state.galleries);
  renderResultInfo(state.interpreted || []);
  renderGrid(false, true);
  restoreScroll(anchor, fallback);
}

function findGallery(id) {
  return state.galleries.find((item) => sameId(item.id, id))
    || (state.selected && sameId(state.selected.id, id) ? state.selected : null)
    // Home の作者頁の本 (一覧の外に並ぶ)。押した時に詳細・読むが本体の本と同じに動くように
    || window.BunkoHome?.findBook(id)
    || null;
}

// 詳細の取得は追い越しうる: 待っている間に閉じた/別の詳細を開いたら、
// 遅れて来た応答で勝手に開き直さない
const detailGeneration = NavigationState.createGeneration();

// 詳細から詳細へ渡り歩いた道筋 (版違いリスト経由)。マウスの戻るで一歩ずつ帰る
const detailTrail = [];

async function openDetail(id, { keepTrail = false } = {}) {
  const epoch = detailGeneration.next();
  dropRedoUnlessRestoring();
  if (!keepTrail) detailTrail.length = 0;
  let gallery = findGallery(id) || relatedDetailItems.get(String(id));
  if (!gallery || gallery.error) {
    els.detail.hidden = false;
    document.body.classList.add('detail-open');
  window.BunkoUI?.sync();
  window.BunkoUI?.renderWaterfall();
    els.detailBody.innerHTML = '<p class="kicker busy">読み込み中…</p>';
    try {
      gallery = await window.hitomi.gallery(id);
    } catch {
      if (!detailGeneration.isCurrent(epoch)) return;
      // 前の作品の selected や金枠を残さない: renderDetail(null) が丸ごと畳む
      state.selected = null;
      renderDetail(null);
      toast('詳細の取得に失敗しました', { type: 'error' });
      return;
    }
    if (!detailGeneration.isCurrent(epoch) || els.detail.hidden) return;
  }
  // 手元に無くて取りに行った間に閉じられた場合は上の分岐で戻っている。ここは
  // 待ち無しで来ることがあり (作品が既に一覧にある)、その時は詳細がまだ閉じた
  // ままなので hidden を見てはいけない (見ると左クリックで一度も開かなくなる)
  if (!detailGeneration.isCurrent(epoch)) return;
  state.selected = gallery;
  renderDetail(gallery);
  warmFirstPage(gallery);
}

// 詳細を開いた時点で 1 頁目だけ先に用意させる。所持作品は母屋が PDF を開き直す
// ところから始まるので、読むを押してから頼むと最初の一枚で待たされる。
// 頼むのは 1 頁だけ (read=1 は付けない): 繰っているだけの本を丸ごと用意させない
let warmedFirst = '';
function warmFirstPage(gallery) {
  if (!gallery || gallery.error || !gallery.owned) return;
  const id = String(gallery.id || '');
  if (!id || id === warmedFirst) return;
  warmedFirst = id;
  const img = new Image();
  img.decoding = 'async';
  img.src = imgUrl(id, 0, 'full');
}

let linkSearchTimer = 0;

function linkPickerEl() {
  return els.detailBody.querySelector('.link-picker');
}

async function runLinkSearch(query) {
  if (!linkPickerEl()) return;
  let hits = [];
  try {
    hits = await window.hitomi.linkCandidates(query);
  } catch {
    hits = [];
  }
  // 待っている間に詳細が閉じた・差し替わった・打鍵が進んだことがある
  const picker = linkPickerEl();
  if (!picker) return;
  const field = picker.querySelector('.link-query');
  if (field && field.value !== query) return;
  const here = state.selected ? state.selected.id : null;
  picker.querySelector('.link-hits').innerHTML = (hits || []).length
    ? hits.map((hit) => {
      // 別の作品へ繋がっているアイテムも候補に出す (隠すと直せない)。鎖の印を
      // 添えて見分けさせ、選ばれたら付け替える。この作品自身への繋ぎは金で示す
      const current = hit.linkedGalleryId != null && here != null
        && sameId(hit.linkedGalleryId, here);
      const used = hit.linkedGalleryId != null && !current;
      const mark = hit.linkedGalleryId != null
        ? `<span class="link-chain" title="${current ? 'この作品と紐付け済み' : '別の作品と紐付け済み (選ぶと付け替え)'}">⛓️</span>`
        : '';
      return `
      <li><button type="button" class="link-hit${current ? ' is-current' : ''}${used ? ' is-used' : ''}"
        data-eagle-item="${escapeHtml(hit.eagleId)}"
        data-item-title="${escapeHtml(hit.title)}"
        ${used ? 'data-relink="1"' : ''}><span class="link-hit-name">${escapeHtml(hit.title)}</span>${mark}</button></li>
    `;
    }).join('')
    : '<li class="link-note">一致する所持アイテムがありません</li>';
}

function scheduleLinkSearch(query) {
  clearTimeout(linkSearchTimer);
  linkSearchTimer = setTimeout(() => runLinkSearch(query), 200);
}

function closeLinkPicker() {
  const picker = linkPickerEl();
  if (!picker || picker.hidden) return false;
  clearTimeout(linkSearchTimer);
  picker.hidden = true;
  return true;
}

function toggleLinkPicker() {
  // pawchive は作者フォルダから選ぶ: 詳細の中ではなく専用の窓を開く
  if (state.selected && state.selected.source === 'pawchive') {
    openPawPicker(state.selected.id);
    return;
  }
  const picker = linkPickerEl();
  if (!picker) return;
  if (!picker.hidden) {
    closeLinkPicker();
    return;
  }
  picker.hidden = false;
  const field = picker.querySelector('.link-query');
  field.focus();
  field.select(); // 種は当てにならないので、そのまま打ち直せるようにする
  runLinkSearch(field.value);
}

// 紐付けの前後で詳細と一覧の 済 を取り直す。
//
// **一度の annotate で、札・詳細・リーダーを同じ姿から描く。** 以前は詳細用と
// 一覧用に二度訊いていたので、その合間に走査が挟まると詳細と札が別の台帳の
// 姿を映した (付け替えた直後に片方だけ星が古い、が起きる)
async function refreshAfterLink(movedFrom = null) {
  const selected = state.selected;
  const inList = selected
    && state.galleries.some((item) => item && sameId(item.id, selected.id));
  // 一覧に居ない詳細 (URL 直開きなど) は末尾に足して一緒に訊く
  const extra = selected && !inList ? [selected] : [];
  // 星を引き直すのは鎖が動いた二つだけ: 繋いだ先と、繋ぎが外れた側
  const restar = new Set();
  if (selected && selected.id != null) restar.add(String(selected.id));
  if (movedFrom != null) restar.add(String(movedFrom));
  const adopted = await refreshOwnedMarks(extra, { restar });
  // 詳細とリーダーも同じ答えから描き直す (値は adoptAnnotated が入れてある)。
  // ここに置くのは、鎖が動いた時だけで十分だから — 取り込み後の 済 の付け直し
  // (refreshOwnedMarks の他の呼び手) に詳細の描き直しまで背負わせない
  if (!adopted) return;
  if (state.selected) renderDetail(state.selected);
  Reader.repaintMeta();
}

async function linkOwned(eagleId, itemTitle, relink = false) {
  const gallery = state.selected;
  if (!gallery || !eagleId) return;
  // 付け替えは元の作品を未所持に戻す。取り違えを黙って通さない
  if (relink) {
    const ok = await confirmDialog(
      'この所持アイテムは別の作品と紐付いています。\nこちらへ付け替えますか?\n元の作品は未ダウンロードの扱いに戻ります。',
      { okLabel: '付け替える' },
    );
    if (!ok) return;
  }
  let result = null;
  try {
    result = await window.hitomi.linkOwned({
      eagleId,
      itemTitle,
      galleryId: gallery.id,
      galleryTitle: gallery.title,
      gallery,
    });
  } catch {
    result = null;
  }
  if (!result || !result.ok) {
    toast('紐付けできませんでした', { type: 'error' });
    return;
  }
  toast(result.movedFrom ? '所持アイテムを付け替えました' : '所持アイテムと紐付けました', { type: 'success' });
  closeLinkPicker();
  // 繋ぎが外れた側の札も星を引き直させる (そちらは未所持・星なしへ戻る)
  await refreshAfterLink(result.movedFrom || null);
}

async function unlinkOwned(eagleId) {
  // pawchive の紐付けは投稿の三つ組で持っている: 台帳の解除とは別口
  if (state.selected && state.selected.source === 'pawchive') {
    await pawUnlink(state.selected.id);
    return;
  }
  let result = null;
  try {
    result = await window.hitomi.unlinkOwned(eagleId);
  } catch {
    result = null;
  }
  if (!result || !result.ok) {
    toast('紐付けを解除できませんでした', { type: 'error' });
    return;
  }
  toast('紐付けを解除し、未ダウンロードに戻しました');
  await refreshAfterLink();
}

// 詳細の一番下の削除釦。Eagle 本体をゴミ箱へ送る (Eagle 側で復元できる)。
// pawchive は紐付けの控えも消すので、投稿の三つ組を添えて渡す
async function trashOwned(eagleId) {
  const gallery = state.selected;
  if (!eagleId) return;
  const name = String((gallery && gallery.title) || '');
  const ok = await confirmDialog(
    `「${name}」を Eagle のゴミ箱へ送りますか?\n未ダウンロードの扱いに戻ります。`,
    { okLabel: 'ゴミ箱へ送る' },
  );
  if (!ok) return;
  const paw = gallery && gallery.source === 'pawchive' ? pawPostOf(gallery) : null;
  // **返事を待たずに未所持へ倒す。** Eagle への書き込み・台帳の掃除・向こうの
  // 機体への配達が済むまで札が 済 のままだと、押しても何も起きていないように
  // 見える。落ちたら元に戻す (押し間違いより、固まって見えるほうが嫌われる)
  const undo = markOwnedLocally(gallery, false);
  let result = null;
  try {
    result = await window.hitomi.trashEagle(paw ? { eagleId, paw } : { eagleId });
  } catch {
    result = null;
  }
  if (!result || !result.ok) {
    undo();
    toast(result && result.reason === 'eagle'
      ? 'Eagle に接続できませんでした (Eagle を起動して再試行)'
      : '削除できませんでした', { type: 'error' });
    return;
  }
  toast('Eagle のゴミ箱へ送りました', { type: 'success' });
  if (paw && gallery) await refreshPawGallery(gallery.id);
  else await refreshAfterLink();
}

// 母屋の返事を待たずに札と詳細の 済 を倒す/戻す。戻す手を返す。
// 高さは動かさない (帯と同じ約束: 押しのけず、印だけ差し替える)
function markOwnedLocally(gallery, owned) {
  if (!gallery) return () => {};
  const id = gallery.id;
  const listed = state.galleries.find((item) => sameId(item.id, id)) || null;
  const before = {
    owned: gallery.owned,
    idOwned: gallery.idOwned,
    eagleId: gallery.eagleId,
    linkedEagleId: gallery.linkedEagleId,
    listedOwned: listed ? listed.owned : null,
  };
  const apply = (value, eagleId, linkedEagleId) => {
    gallery.owned = value;
    gallery.idOwned = value ? gallery.idOwned : false;
    gallery.eagleId = eagleId;
    gallery.linkedEagleId = linkedEagleId;
    if (listed) listed.owned = value;
    const card = els.grid.querySelector(`.card[data-id="${id}"]`);
    if (card) setOwnedMark(card, Boolean(value));
    if (state.selected && sameId(state.selected.id, id)) renderDetail(gallery);
  };
  apply(owned, owned ? before.eagleId : null, owned ? before.linkedEagleId : null);
  return () => {
    gallery.idOwned = before.idOwned;
    if (listed) listed.owned = before.listedOwned;
    apply(before.owned, before.eagleId, before.linkedEagleId);
  };
}

// ---- pawchive の手動紐付け -------------------------------------------
// hitomi の鎖 (詳細の中の検索付き picker) と役目は同じだが、当てる先が違う:
// あちらは台帳 (title_matches)、こちらは Eagle の「作者」フォルダの中身
let pawPicker = null;
let pawSearchTimer = 0;

function closePawPicker() {
  if (els.pawLink.hidden) return false;
  clearTimeout(pawSearchTimer);
  els.pawLink.hidden = true;
  els.pawLinkBody.innerHTML = '';
  pawPicker = null;
  return true;
}

function starText(star) {
  const value = Math.round(Number(star)) || 0;
  return value > 0 ? `<span class="paw-star">★${value}</span>` : '';
}

function creatorLine(creator, folders) {
  const known = creator && creator.folderId;
  const label = known
    ? `${escapeHtml(creator.name || creator.folderId)}${creator.origin === 'guess' ? '（推測）' : ''}`
    : '未設定';
  const count = folders ? folders.length : 0;
  return `
    <p class="paw-line">
      <span class="paw-line-label">作者フォルダ</span>
      <span class="paw-line-value${known ? '' : ' is-empty'}">${label}</span>
      <button type="button" class="ghost sm" data-paw-folders="1" title="${count} 件のフォルダから選ぶ">フォルダを選ぶ</button>
    </p>
  `;
}

// 候補の行だけを差し替える。入れ物ごと描き直すと打ちかけの語と焦点が飛ぶ
function renderPawRows(items) {
  const list = els.pawLinkBody.querySelector('.paw-hits');
  if (!list) return;
  const { gallery, folderId } = pawPicker;
  const linked = gallery.linkedEagleId ? String(gallery.linkedEagleId) : '';
  const rows = (items || []).map((item) => {
    const current = linked && item.eagleId === linked;
    // 別の作者のフォルダから来た候補は、それと分かるように作者名を添える
    const other = folderId && item.folderId !== folderId;
    const creator = item.creator
      ? `<span class="paw-owner${other ? ' is-other' : ''}">${escapeHtml(item.creator)}</span>`
      : '';
    return `
      <li><button type="button" class="link-hit paw-hit${current ? ' is-current' : ''}${item.linked && !current ? ' is-used' : ''}" data-paw-item="${escapeHtml(item.eagleId)}">
        <span class="paw-hit-name">${escapeHtml(item.name || item.title)}</span>${creator}${starText(item.star)}${item.linked ? '<span class="paw-used">紐付け済</span>' : ''}
      </button></li>
    `;
  }).join('');
  list.innerHTML = rows || '<li class="link-note">一致する所持アイテムがありません</li>';
}

function pawQueryEl() {
  return els.pawLinkBody.querySelector('.paw-query');
}

async function runPawSearch(query) {
  if (!pawPicker) return;
  const { gallery, post, id } = pawPicker;
  const reply = await pawLinksCall({
    action: 'candidates',
    service: post.service,
    user: post.user,
    name: pawCreatorName(gallery),
    query,
  });
  // 待っている間に閉じた・別の札に移ったことがある
  if (!pawPicker || pawPicker.id !== id) return;
  // 打ち続けている間に古い返事が届くことがある: 今の語のぶんだけ映す
  const field = pawQueryEl();
  if (field && String(field.value).trim() !== String(query).trim()) return;
  pawPicker.folderId = (reply && reply.creator && reply.creator.folderId) || '';
  renderPawRows(reply && reply.items);
}

function schedulePawSearch(query) {
  clearTimeout(pawSearchTimer);
  pawSearchTimer = setTimeout(() => runPawSearch(query), 200);
}

async function loadPawCandidates() {
  if (!pawPicker) return;
  const { gallery, post, id } = pawPicker;
  els.pawLinkBody.innerHTML = '<p class="link-note">読み込み中…</p>';
  const reply = await pawLinksCall({
    action: 'candidates',
    service: post.service,
    user: post.user,
    name: pawCreatorName(gallery),
  });
  if (!pawPicker || pawPicker.id !== id) return;
  const creator = (reply && reply.creator) || null;
  const linked = gallery.linkedEagleId ? String(gallery.linkedEagleId) : '';
  pawPicker.folderId = (creator && creator.folderId) || '';
  els.pawLinkBody.innerHTML = `
    ${creatorLine(creator, (reply && reply.folders) || [])}
    ${linked ? '<p class="paw-line"><button type="button" class="ghost sm" data-paw-unlink="1">紐付けを解除</button></p>' : ''}
    <input type="search" class="link-query paw-query" placeholder="所持アイテムを検索" />
    <ul class="link-hits paw-hits"></ul>
  `;
  renderPawRows(reply && reply.items);
  const field = pawQueryEl();
  if (field) field.focus();
}

function openPawPicker(id) {
  const gallery = findGallery(id);
  const post = pawPostOf(gallery);
  if (!post) return;
  clearTimeout(pawSearchTimer);
  pawPicker = { mode: 'post', id, gallery, post, folderId: '' };
  els.pawLink.hidden = false;
  els.pawLinkTitle.textContent = gallery.linkedEagleId ? '紐付けを変える' : '所持アイテムと紐付ける';
  els.pawLinkNote.textContent = gallery.title;
  loadPawCandidates();
}

async function openPawFolderPicker() {
  if (!pawPicker) return;
  const { gallery } = pawPicker;
  const creator = pawCreatorOf(gallery);
  if (!creator) return;
  pawPicker.mode = 'folder';
  els.pawLinkTitle.textContent = '作者フォルダを選ぶ';
  els.pawLinkNote.textContent = pawCreatorName(gallery) || `${creator.service}/${creator.user}`;
  els.pawLinkBody.innerHTML = '<p class="link-note">読み込み中…</p>';
  const reply = await pawLinksCall({
    action: 'candidates',
    service: creator.service,
    user: creator.user,
    name: pawCreatorName(gallery),
  });
  if (!pawPicker || pawPicker.mode !== 'folder') return;
  const current = (reply && reply.creator && reply.creator.folderId) || '';
  const folders = (reply && reply.folders) || [];
  const rows = folders.map((folder) => `
    <li><button type="button" class="link-hit paw-hit${folder.folderId === current ? ' is-current' : ''}" data-paw-folder-id="${escapeHtml(folder.folderId)}">
      <span class="paw-hit-name">${escapeHtml(folder.name)}</span><span class="paw-count">${folder.itemCount}</span>
    </button></li>
  `).join('');
  els.pawLinkBody.innerHTML = `
    ${current ? '<p class="paw-line"><button type="button" class="ghost sm" data-paw-folder-id="">対応付けを解除</button></p>' : ''}
    <ul class="link-hits paw-hits">${rows || '<li class="link-note">Eagle の「作者」フォルダが読めません</li>'}</ul>
  `;
}

// 紐付けの前後で、その札 (と開いていれば詳細) の 済 を取り直す
async function refreshPawGallery(id) {
  const gallery = findGallery(id);
  if (!gallery) return null;
  let fresh = null;
  try {
    [fresh] = await window.hitomi.annotate([gallery]);
  } catch {
    return null;
  }
  if (!fresh) return null;
  const index = state.galleries.findIndex((item) => sameId(item.id, id));
  if (index >= 0) state.galleries[index] = fresh;
  if (state.selected && sameId(state.selected.id, id)) {
    state.selected = fresh;
    renderDetail(fresh);
  }
  refreshCard(fresh);
  return fresh;
}

async function pawLinkTo(eagleId) {
  if (!pawPicker || !eagleId) return;
  const { post, id } = pawPicker;
  const result = await pawLinksCall({
    action: 'link',
    service: post.service,
    user: post.user,
    postId: post.postId,
    eagleId,
  });
  if (!result || !result.ok) {
    toast('紐付けできませんでした', { type: 'error' });
    return;
  }
  closePawPicker();
  toast('所持アイテムと紐付けました', { type: 'success' });
  await refreshPawGallery(id);
}

async function pawUnlink(id) {
  const gallery = findGallery(id);
  const post = pawPostOf(gallery);
  if (!post) return;
  const result = await pawLinksCall({
    action: 'unlink',
    service: post.service,
    user: post.user,
    postId: post.postId,
  });
  if (!result || !result.ok) {
    toast('紐付けを解除できませんでした', { type: 'error' });
    return;
  }
  closePawPicker();
  toast('紐付けを解除しました');
  await refreshPawGallery(id);
}

async function pawMapCreator(folderId) {
  if (!pawPicker) return;
  const { gallery } = pawPicker;
  const creator = pawCreatorOf(gallery);
  if (!creator) return;
  const reply = await pawLinksCall({
    action: 'map-creator',
    service: creator.service,
    user: creator.user,
    name: pawCreatorName(gallery),
    folderId: folderId || null,
  }, PAW_LINKS_FAILED);
  if (reply === PAW_LINKS_FAILED) {
    toast('フォルダを対応付けられませんでした', { type: 'error' });
    return;
  }
  toast(folderId ? 'フォルダを対応付けました' : '対応付けを解除しました');
  restampCreatorFolders();
  // 投稿から入ったときは候補一覧へ戻る。作者札から入ったときはそこで用が済む
  if (pawPicker.mode === 'folder' && pawPicker.post) {
    pawPicker.mode = 'post';
    els.pawLinkTitle.textContent = '所持アイテムと紐付ける';
    els.pawLinkNote.textContent = pawPicker.gallery.title;
    loadPawCandidates();
    return;
  }
  closePawPicker();
}

// 作者札から: 投稿を挟まずフォルダの対応付けだけを決める
function openPawCreatorFolders(id) {
  const gallery = findGallery(id);
  if (!gallery || !pawCreatorOf(gallery)) return;
  pawPicker = { mode: 'folder', id, gallery, post: null };
  els.pawLink.hidden = false;
  openPawFolderPicker();
}

// 帯の高さを CSS に返す。窓が狭くて折り返したぶんだけ詳細パネルを下げる:
// 上端の 設定/ダウンロード が隠れないのは、この一点で決まっている
function watchRailHeight() {
  const rail = document.querySelector('.rail');
  if (!rail) return;
  const apply = () => {
    const height = Math.round(rail.getBoundingClientRect().height);
    if (height > 0) document.documentElement.style.setProperty('--rail-h', `${height}px`);
  };
  apply();
  if (typeof ResizeObserver === 'function') new ResizeObserver(apply).observe(rail);
  else window.addEventListener('resize', apply);
}

function bindPawPicker() {
  // 打つたびに探し直す。hitomi の鎖と同じ間合い (200ms)
  els.pawLink.addEventListener('input', (event) => {
    const field = event.target.closest('.paw-query');
    if (field) schedulePawSearch(field.value);
  });

  els.pawLink.addEventListener('click', (event) => {
    if (event.target === els.pawLink) {
      closePawPicker();
      return;
    }
    const close = event.target.closest('#paw-link-close');
    if (close) {
      closePawPicker();
      return;
    }
    const folders = event.target.closest('[data-paw-folders]');
    if (folders) {
      openPawFolderPicker();
      return;
    }
    const folder = event.target.closest('[data-paw-folder-id]');
    if (folder) {
      pawMapCreator(folder.dataset.pawFolderId);
      return;
    }
    const unlink = event.target.closest('[data-paw-unlink]');
    if (unlink) {
      pawUnlink(pawPicker && pawPicker.id);
      return;
    }
    const item = event.target.closest('[data-paw-item]');
    if (item) pawLinkTo(item.dataset.pawItem);
  });
}

let cardClickTimer = 0;

// what a card does on click / right click / double click is user assignable
const CARD_ACTIONS = ['detail', 'read', 'save', 'none'];
const CARD_ACTION_DEFAULTS = { Left: 'detail', Right: 'read', Double: 'save' };

function cardAction(kind) {
  const value = (state.settings || {})[`mouse${kind}`];
  return CARD_ACTIONS.includes(value) ? value : CARD_ACTION_DEFAULTS[kind];
}

// 左の一打。ダブルクリックに何か割り当ててある間は一呼吸 (250ms) 待ち、二打目が来たら
// dblclick の側が予約を取り消す (一打目で詳細が開いてからダブルの保存が走る、を起こさない)。
// ダブルが「何もしない」なら待つ理由が無いので即座に。一覧の札・詳細の関連作品・読む画面の継ぎ目の札が同じ物を使う
function pressLeft(event, run) {
  clearTimeout(cardClickTimer);
  // 速いダブルの二打目 (detail > 1) は dblclick の持ち物: ここでは動かない
  if (event.detail > 1) return;
  // 打鍵 (Enter で押した釦は detail が 0) はダブルクリックの一打目になり得ない: 待たない
  if (!event.detail || cardAction('Double') === 'none') {
    run();
    return;
  }
  cardClickTimer = setTimeout(run, 250);
}

function readCard(id) {
  const gallery = findGallery(id);
  if (gallery && !gallery.error) {
    if (gallery.owned) openOwnedWork(gallery);
    else Reader.open(gallery);
    return;
  }
  openDetail(id);
}

function openCreator(id) {
  const raw = String(id);
  // pixiv の作者の札 (pxu:<user_id>) は作者の投稿一覧へ
  if (raw.startsWith('pxu:')) {
    const known = findGallery(raw);
    if (known?.title) pixivAuthorNames.set(raw.slice('pxu:'.length), known.title);
    state.query = known?.query || `user:${raw.slice('pxu:'.length)}`;
    els.query.value = state.query;
    renderSources();
    runSearch({ reset: true });
    return true;
  }
  // 所持作品側の作者札。開く語は札が持っている (紐付け済みなら service/user、無ければ folder:)
  if (raw.startsWith('pwlibf:')) {
    const gallery = findGallery(raw);
    state.query = String(gallery?.query || '') || `folder:${raw.slice('pwlibf:'.length)}`;
    if (gallery?.title) portableCreatorQueries.set(`pawchive:${state.query.split(/\s+/)[0]}`,gallery.title);
    els.query.value = state.query;
    // 並びには触らない。paw-library は PAW_LIBRARY_SORTS の 4 つを全部扱えるので
    // 'added' を押し付ける要が無く、押し付けると x で語を消した後も残る
    renderSources();
    runSearch({ reset: true });
    return true;
  }
  const parts = raw.split(':');
  if (parts[0] !== 'pw' || parts[3] !== 'profile') return false;
  const known = findGallery(raw);
  state.query = known?.query || `${parts[1]}/${parts[2]}`;
  if (known?.title) portableCreatorQueries.set(`pawchive:${state.query.split(/\s+/)[0]}`, known.title);
  els.query.value = state.query;
  // 同上。作者の投稿一覧 (pawchive.js:615-620) は並びを読まないので押し付けは不要。
  // 押し付けると、x で語を消した時に お気に入り 一覧へ戻れなくなる
  renderSources();
  runSearch({ reset: true });
  return true;
}

function performCardAction(action, id) {
  // 何を開くにせよ、出しかけ/出ているルーペは畳む (リーダーの裏に残るのを防ぐ)
  cancelLoupeTimer();
  hideLoupe(true);
  if (openCreator(id)) return;
  // Eagle が持ち主の行に保存は無い (取りに行く先が無い): 読むほうに回す。
  // 詳細も読むも普通の札と同じ扱いで、割り当てた操作のとおりに動く
  const act = action === 'save' && isEagleItem(findGallery(id)) ? 'read' : action;
  if (act === 'detail') openDetail(id);
  else if (act === 'read') readCard(id);
  else if (act === 'save') startDownload(id);
}

// OS の confirm はレンダラごと止めてしまう (描画もタイマーも固まる)。
// アプリ内の小さな確認窓で代える。Enter=実行 / Esc・外側クリック=やめる
function confirmDialog(message, { okLabel = 'はい', cancelLabel = 'やめる' } = {}) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'confirm';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.innerHTML = `
      <div class="confirm-panel">
        <p class="confirm-text"></p>
        <div class="confirm-acts">
          <button type="button" class="ghost" data-cancel>${escapeHtml(cancelLabel)}</button>
          <button type="button" class="ghost confirm-ok" data-ok>${escapeHtml(okLabel)}</button>
        </div>
      </div>`;
    wrap.querySelector('.confirm-text').textContent = message;
    const done = (value) => {
      document.removeEventListener('keydown', onKey, true);
      wrap.remove();
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === 'Escape' || event.key === 'Enter') {
        event.stopPropagation();
        event.preventDefault();
        done(event.key === 'Enter');
      }
    };
    document.addEventListener('keydown', onKey, true);
    wrap.addEventListener('click', (event) => {
      if (event.target.closest('[data-ok]')) done(true);
      else if (event.target.closest('[data-cancel]') || event.target === wrap) done(false);
    });
    document.body.appendChild(wrap);
    wrap.querySelector('[data-ok]').focus();
  });
}

// 一行だけ書いてもらう窓 (pixiv の token を貼る)。confirmDialog と同じ組み。
// 空のまま決めたら null。password なら伏せ字
function promptDialog(message, { okLabel = '決める', cancelLabel = 'やめる', placeholder = '', password = false } = {}) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'confirm';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.innerHTML = `
      <div class="confirm-panel">
        <p class="confirm-text"></p>
        <input class="confirm-input" type="${password ? 'password' : 'text'}" autocomplete="off" spellcheck="false" />
        <div class="confirm-acts">
          <button type="button" class="ghost" data-cancel>${escapeHtml(cancelLabel)}</button>
          <button type="button" class="ghost confirm-ok" data-ok>${escapeHtml(okLabel)}</button>
        </div>
      </div>`;
    wrap.querySelector('.confirm-text').textContent = message;
    const input = wrap.querySelector('.confirm-input');
    if (placeholder) input.placeholder = placeholder;
    const done = (value) => {
      document.removeEventListener('keydown', onKey, true);
      wrap.remove();
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        event.preventDefault();
        done(null);
      } else if (event.key === 'Enter') {
        event.stopPropagation();
        event.preventDefault();
        done(input.value.trim() || null);
      }
    };
    document.addEventListener('keydown', onKey, true);
    wrap.addEventListener('click', (event) => {
      if (event.target.closest('[data-ok]')) done(input.value.trim() || null);
      else if (event.target.closest('[data-cancel]') || event.target === wrap) done(null);
    });
    document.body.appendChild(wrap);
    input.focus();
  });
}

// ---- pixiv ----
// 候補へ (ブックマーク)。押した札は控えの旗も書き換えて描き直す
async function togglePixivBookmark(id) {
  if (readOnlyMode()) {
    toast('読み取り専用モードのため候補に入れられません', { type: 'error' });
    return;
  }
  const gallery = findGallery(id) || (state.selected && sameId(state.selected.id, id) ? state.selected : null);
  const next = !(gallery && gallery.bookmarked);
  try {
    await window.hitomi.pixiv({ action: 'bookmark', pid: id, on: next });
  } catch (error) {
    toast(`候補に入れられませんでした: ${error && error.message ? error.message : error}`, { type: 'error' });
    return;
  }
  const apply = (item) => { if (item) item.bookmarked = next; };
  state.galleries.forEach((item) => { if (item && sameId(item.id, id)) apply(item); });
  if (state.selected && sameId(state.selected.id, id)) apply(state.selected);
  if (gallery) refreshCard(gallery);
  if (state.selected && sameId(state.selected.id, id)) renderDetail(state.selected);
  toast(next ? '候補に入れました' : '候補から外しました');
}

// フォロー (pixiv の作者)。pixiv 側に書く。札と詳細の両方の旗を書き換える
async function togglePixivFollow(id) {
  if (readOnlyMode()) {
    toast('読み取り専用モードのためフォローできません', { type: 'error' });
    return;
  }
  const gallery = findGallery(id) || (state.selected && sameId(state.selected.id, id) ? state.selected : null);
  if (!gallery || !gallery.userId) return;
  const next = !(gallery.following === true);
  try {
    await window.hitomi.pixiv({ action: 'follow', userId: gallery.userId, on: next });
  } catch (error) {
    toast(`フォローできませんでした: ${ipcErrorText(error && error.message ? error.message : error)}`, { type: 'error' });
    return;
  }
  const apply = (item) => { if (item) item.following = next; };
  state.galleries.forEach((item) => { if (item && sameId(item.id, id)) apply(item); });
  if (state.selected && sameId(state.selected.id, id)) apply(state.selected);
  refreshCard(gallery);
  if (state.selected && sameId(state.selected.id, id)) renderDetail(state.selected);
  toast(next ? 'フォローしました' : 'フォローを外しました');
}

// pixiv: 語を打ったら並びの select を「フォロー」から「新しい順」に倒す。語 + フォローは pixiv 全体の
// 検索 (sources/pixiv.js の planFor) なので、select がフォローのままだと嘘になる。語を消したら戻す。
// 覚え (rememberSort) は触らない: 利用者が選んだ並びではない

function pixivQueryHasWords(query) {
  const text = String(query || '').replace(/"[^"]*"/g, ' 語 ');
  return text.split(/\s+/).filter(Boolean).some((token) => (
    !/^(user|id|bm|bookmarks|since|until|date):/i.test(token)
    && !/^exact:$/i.test(token)
    && !/^\d{5,}$/.test(token)
    && !/^https?:\/\//i.test(token)
  ));
}

const pixivTabSnapshots = new Map();
function pixivViewKey() {
  if (state.pixivTab) return state.pixivTab;
  if (state.query.trim()) return 'search';
  if (['follow','bookmarks','recommended'].includes(state.sort)) return state.sort;
  return state.sort === 'added' ? 'search' : 'ranking';
}
const pixivTabFields = ['query','sort','type','pixivPeriod','page','pageSize','total','approximate','truncated','done','error','interpreted','searchNotice','galleries'];
function rememberPixivTab() {
  if (state.source !== 'pixiv' || libraryScope() || state.loading) return;
  pixivTabSnapshots.set(pixivViewKey(), captureSearchView());
}
async function switchPixivTab(tab) {
  if (state.source !== 'pixiv' || libraryScope()) return;
  if (pixivViewKey() === tab) return;
  rememberPixivTab(); clearTimeout(liveSearchTimer); searchEpoch++;
  if (activeSearchRequestId) window.hitomi.cancelSearch?.(activeSearchRequestId).catch(()=>{});
  leaveDiscovery(); state.pixivTab=tab; state.loading=false;
  const saved=pixivTabSnapshots.get(tab);
  if (saved) {
    restoreSearchView(saved); return;
  }
  state.query=''; els.query.value=''; state.galleries=[]; state.total=0; state.done=false;
  state.sort=({search:'added',ranking:'today'})[tab]||tab;
  if (tab === 'search') state.pixivPeriod = 'year';
  if (tab==='ranking' && state.type==='manga-r18') state.type='manga';
  els.grid.innerHTML=''; renderResultInfo(null); renderSources(); renderTypes(); window.BunkoUI?.sync();
  await runSearch({reset:true});
}
function syncPixivSortWithQuery() {
  if (state.source !== 'pixiv' || libraryScope() || !state.query.trim()) return;
  if (pixivViewKey() !== 'search' || !['added','today','week','month','year'].includes(state.sort)) state.sort='added';
  state.pixivTab='search';
  if (els.sort) fillSelect(els.sort, activeSorts(), state.sort);
  fillPawBulk(); window.BunkoUI?.sync();
}

// 保存の前に、作者フォルダを決める必要があるかを母屋に訊く (§15 U3)。
// 台帳が知らない作者で同じ名前のフォルダがあれば、同じ人かをここで一度だけ訊く。
// 答えは台帳に残るので、次からは訊かれない
async function settlePixivCreator(id) {
  let answer = null;
  try {
    answer = await window.hitomi.pixiv({ action: 'ask-creator', id });
  } catch {
    return true;                // 訊けなくても保存は進める (取り込みが後で決める)
  }
  if (!answer || !answer.ask) return true;
  const { ask } = answer;
  const same = await confirmDialog(
    `pixiv の作者「${ask.userName}」は、作者フォルダ「${ask.folderName}」と同じ人ですか?`,
    { okLabel: '同じ人', cancelLabel: '別の人' },
  );
  try {
    await window.hitomi.pixiv({
      action: 'bind-creator', userId: ask.userId, folderId: same ? ask.folderId : null, name: same ? ask.folderName : '',
    });
  } catch {
    // 結べなくても取り込みが新しく作る
  }
  return true;
}

// 設定の pixiv の行。ログインの状態は母屋に訊く (token そのものは画面に来ない)
async function refreshPixivStatus() {
  if (!els.setPixivStatus) return;
  try {
    state.pixivStatus = await window.hitomi.pixiv({ action: 'status' });
  } catch {
    state.pixivStatus = null;
  }
  fillPixivSettings();
}

function fillPixivSettings() {
  if (!els.setPixivStatus) return;
  const status = state.pixivStatus;
  const loggedIn = status ? status.loggedIn : Boolean((state.settings || {}).pixivLoggedIn);
  const user = status && status.user;
  let text = loggedIn ? `ログイン済み${user && user.name ? `: ${user.name}` : ''}${user && user.premium ? ' (プレミアム)' : ''}` : '未ログイン';
  if (status && status.needsLogin) text = 'ログインし直しが必要です';
  els.setPixivStatus.textContent = text;
  els.setPixivLogin.hidden = loggedIn && !(status && status.needsLogin);
  els.setPixivToken.hidden = loggedIn && !(status && status.needsLogin);
  els.setPixivLogout.hidden = !loggedIn;
  const pending = status && status.pending ? status.pending : null;
  const hints = [];
  if (pending && pending.count) hints.push(`取り込み待ち ${pending.count} 件${pending.waitingEagle ? ' (Eagle の起動待ち)' : ''}`);
  if (status && status.pausedForMs > 0) hints.push(`混雑で休止中 (あと約 ${Math.max(1, Math.ceil(status.pausedForMs / 60000))} 分)`);
  els.setPixivHint.textContent = hints.length ? hints.join(' ・ ') : '落とした本は Eagle の作者根に、題だけの名前で入ります';
  setSwitch(els.setPixivHideAi, { on: hideAiEnabled(), label: 'AI 生成を隠す' });
  if (els.setPixivReadOriginal) setSwitch(els.setPixivReadOriginal, { on: readOriginalEnabled(), label: '原寸で読む' });
  if (els.setAitag) setSwitch(els.setAitag, { on: aitagEnabled(), label: 'プロンプトを aitag.win に訊く' });
  paintAiMetaBackfill(state.aiMetaBackfill);
  const legacy = status ? Number(status.legacy) || 0 : 0;
  els.setPixivRelabelCount.textContent = legacy ? `${legacy} 件` : '対象なし';
  els.setPixivRelabel.hidden = !legacy;
}

async function pixivLogin() {
  els.setPixivLogin.disabled = true;
  try {
    state.pixivStatus = await window.hitomi.pixiv({ action: 'login' });
    toast('pixiv にログインしました');
  } catch (error) {
    toast(`ログインできませんでした: ${error && error.message ? error.message : error}`, { type: 'error' });
  } finally {
    els.setPixivLogin.disabled = false;
    fillPixivSettings();
  }
}

async function pixivPasteToken() {
  const token = await promptDialog('pixiv の refresh token を貼ってください', {
    okLabel: '検めて持つ', placeholder: 'refresh token', password: true,
  });
  if (!token) return;
  try {
    state.pixivStatus = await window.hitomi.pixiv({ action: 'token', token });
    toast('token を受け付けました');
  } catch (error) {
    toast(`${error && error.message ? error.message : error}`, { type: 'error' });
  }
  fillPixivSettings();
}

async function pixivLogout() {
  const ok = await confirmDialog('pixiv からログアウトしますか? (網の一覧と保存が使えなくなります)', { okLabel: 'ログアウト' });
  if (!ok) return;
  try {
    state.pixivStatus = await window.hitomi.pixiv({ action: 'logout' });
  } catch {
    // 失敗しても次の status で分かる
  }
  fillPixivSettings();
}

async function pixivRelabel() {
  els.setPixivRelabel.disabled = true;
  try {
    const out = await window.hitomi.pixiv({ action: 'relabel' });
    toast(`付け直し: ${Number(out && out.done) || 0} 件${out && out.failed ? ` (失敗 ${out.failed})` : ''}`);
  } catch (error) {
    toast(`付け直しができませんでした: ${error && error.message ? error.message : error}`, { type: 'error' });
  } finally {
    els.setPixivRelabel.disabled = false;
    refreshPixivStatus();
  }
}

async function startDownload(id) {
  // 保存の釦は隠してあるが、マウス割り当て (ダブルクリック=保存 等) からは
  // まだ届く: ここで受け止めて理由を言う
  if (readOnlyMode()) {
    toast('読み取り専用モードのため保存できません', { type: 'error' });
    return;
  }
  // 誤ダブルクリックで取得済みの作品を落とし直さないよう、ここで一度だけ確認する。
  // 未所持の保存は今までどおり即開始 (キュー内の重複は downloader 側が弾く)
  // リーダーからの保存は一覧に居ないことがある: 開いている本からも題を引く
  const gallery = findGallery(id)
    || (state.reader && state.reader.gallery && sameId(state.reader.gallery.id, id)
      ? state.reader.gallery
      : null)
    // 関連作品 (詳細の欄・読む画面の継ぎ目) の札は一覧の外に居る
    || relatedDetailItems.get(String(id))
    || null;
  if (gallery && gallery.owned && ownedSaveConfirmEnabled()) {
    const name = String(gallery.title || id);
    const ok = await confirmDialog(`「${name}」は取得済みです。もう一度保存しますか?`, { okLabel: '保存する' });
    if (!ok) return;
  }
  // pixiv: うごイラは本にしない。作者フォルダに同じ名前があれば、押した時に訊く (§15 U3)
  if (String(id).startsWith('px:')) {
    if (gallery && gallery.unbindable) {
      toast('うごイラは本にしません', { type: 'error' });
      return;
    }
    if (!await settlePixivCreator(id)) return;
  }
  try {
    // 題を添える: キュー一覧が最初から「#ID」ではなく作品名で並ぶように
    await window.hitomi.download(id, gallery ? gallery.title : '');
    toast('保存を開始しました');
    pulseQueueBadge();
  } catch {
    toast('保存を開始できませんでした', { type: 'error' });
  }
}

function replaceLastToken(value) {
  const parts = els.query.value.trim().split(/\s+/).filter(Boolean);
  parts[parts.length ? parts.length - 1 : 0] = value;
  return parts.join(' ');
}

function applyQuery(value) {
  queryDraftEdited=false;
  clearTimeout(liveSearchTimer);
  if (state.source === 'home' && !libraryScope()) {
    applyQueryFromHome(value);
    return;
  }
  invalidateSearchIntent();
  state.query = value;
  els.query.value = value;
  syncQueryClear();
  hideSuggest();
  runSearch({ reset: true });
}

// ---- 打鍵ごとの引き直し ----
// 間合いは相手で変える。手元の台帳は往復が要らないので早く、網は遅く。
// 空欄へ戻す時だけ少し長いのは、打ち直しの途中の一瞬の空欄で全件一覧へ
// 戻ってしまわないため (以前の「空欄 500ms の特例」はこれに吸収した)
let liveSearchTimer = 0;

function liveDelay(raw) {
  if (!raw) return 400;
  // Home は母屋の控えの上で絞るだけ (網へ出ない): 手元の台帳と同じ間合い
  if (libraryScope() || state.source === 'home') return 150;
  // pixiv は API の車線が一本で、本アカウントの予算でもある: 打鍵ごとには出さない (§15 U2)
  return state.source === 'pixiv' ? 900 : 450;
}

function scheduleLiveSearch() {
  clearTimeout(liveSearchTimer);
  if (composingQuery) return;                 // 変換中は組まない
  const raw = els.query.value.trim();
  if (!libraryScope()) {
    // URL・作品 ID の貼り付けは取り寄せ先ごと差し替わる操作。Enter の持ち場
    if (detectSource(raw)) return;
    // 一文字で網へ出さない (相手の流量制限をこちらから悪化させる)。Home は網へ出ないので一字でも絞る
    if (raw.length === 1 && state.source !== 'home') return;
  }
  liveSearchTimer = setTimeout(() => {
    if (composingQuery) return;
    const next = els.query.value.trim();
    if (next === state.query && state.done) return;
    state.query = next;
    // 候補は畳まない: 候補 (180ms) が先に出て指を止め、棚が後から入れ替わる
    runSearch({ reset: true, live: true });
  }, liveDelay(raw));
}

function syncQueryClear() {
  if (els.queryClear) els.queryClear.hidden = !els.query.value.length;
}

function resetQueryToBlank() {
  // Home の語 (作者名で絞る・作者頁) を消しても、他の源泉の語の旅は続いている
  if (state.source !== 'home') invalidateSearchIntent();
  clearTimeout(liveSearchTimer);
  els.query.value = '';
  syncQueryClear();
  hideSuggest();
  if (state.query !== '') {
    state.query = '';
    runSearch({ reset: true });
  }
}

function bindQueryClear() {
  els.query.addEventListener('input', (event) => {
    queryDraftEdited=true;
    // Home で作者名を打っても、他の源泉の語の旅は壊さない (Home は旅に加わらない)
    if (state.source !== 'home') invalidateSearchIntent();
    syncQueryClear();
    // compositionstart を取り逃す IME への保険
    if (composingQuery || event?.isComposing) return;
    scheduleLiveSearch();
  });
  els.queryClear.addEventListener('click', () => {
    resetQueryToBlank();
    els.query.focus();
  });
}

function hideSuggest() {
  ++suggestEpoch;
  clearTimeout(suggestTimer);
  els.suggest.hidden = true;
  els.suggest.innerHTML = '';
  state.suggestIndex = -1;
  state.suggestKeyboard = false;
  state.suggestItems = [];
}

function renderSuggest(items) {
  state.suggestItems = items;
  if (!items.length) {
    hideSuggest();
    return;
  }
  els.suggest.hidden = false;
  els.suggest.dataset.source=state.source;
  els.suggest.innerHTML = items.map((item, index) => `
    <li>
      <button type="button" data-value="${escapeHtml(item.value)}" data-suggest-index="${index}" data-kind="${escapeHtml(item.type || 'tag')}" title="${escapeHtml(item.value)}" class="${index === state.suggestIndex ? 'active' : ''}">
        <span class="suggest-bar" aria-hidden="true"></span>
        <span class="suggest-main">
          <span class="suggest-line">
            ${item.label ? `<span class="label">${escapeHtml(item.label)}</span>` : ''}
            ${suggestSeries(item)}
          </span>
          ${suggestValue(item)}
        </span>
        ${suggestMetric(item)}
      </button>
    </li>
  `).join('');
}

// 候補の一行は三つで出来ている:
//   日本語名 + 所属作品 (同じ行) / そのサイトへ送る値 (下段) / 件数 (右)
// 種類は左端の線の色で言う (詳細画面のタグと同じ色)。字では書かない。
// 所属作品が無い候補は行が短くなるだけで、空の枠は出さない
function suggestSeries(item) {
  // 添える字は search-decorate が `secondary` に決めている。VTuber なら
  // 「VTuber (ホロライブ)」、それ以外は所属作品。ここで seriesLabel を直に
  // 読むと、手のひら版 (secondary を読む) と食い違う — 同じ概念は一箇所から
  const series = String(item.secondary || item.seriesLabel || '').trim();
  if (series && series !== item.label) return `<span class="series">${escapeHtml(series)}</span>`;
  // pixiv の候補が訳を持つ時だけ、その訳を所属の位置に出す
  const translation = String(item.translation || '').trim();
  return translation && translation !== item.label ? `<span class="series">${escapeHtml(translation)}</span>` : '';
}

// 送る値。名前と同じ字なら二度書かない (pixiv は値がそのまま日本語名になる)
function suggestValue(item) {
  const value = String(item.value || '').trim();
  if (!value || value === item.label) return '';
  return `<span class="kind">${escapeHtml(value)}</span>`;
}

function suggestMetric(item) {
  const metric=item.metric;
  if(!metric || metric.site!==state.source || !Number.isFinite(metric.value) || metric.value<0) return '';
  const label=metric.kind==='favorites' ? 'お気に入り ' : metric.kind==='works' ? (metric.approximate?'約':'') : null;
  if(label===null) return '';
  const title=metric.kind==='favorites' ? '作者のお気に入り数' : metric.scope==='tag' ? 'タグ全体の作品数（現在の絞り込み前）' : metric.scope==='owned' ? 'このタグの付いた所持の本の数' : '作品数';
  return `<span class="count" title="${title}">${label}${metric.value.toLocaleString()}</span>`;
}

const jobStatuses = new Map();

function syncJobStatuses() {
  jobStatuses.clear();
  state.downloads.forEach((job) => jobStatuses.set(job.id, job.status));
}

let suggestTimer = 0;
let composingQuery = false;
let suggestEpoch = 0;
function acceptSuggestion(item, submit = true) {
  if (!item?.value || (item._input !== undefined && item._input !== els.query.value)) return;
  const raw=els.query.value, range=item._range;
  const value=range ? raw.slice(0,range.start)+item.value+raw.slice(range.end) : replaceLastToken(item.value);
  if (item.type==='artist' && item.name) {
    portableCreatorQueries.set(`${state.source}:${item.value}`,item.name);
    if (state.source==='pixiv' && /^user:\d+$/.test(item.value)) pixivAuthorNames.set(item.value.slice(5),item.name);
  }
  if (item.term) searchSelections.set(`${state.source}:${item.value}`,item.term);
  while(searchSelections.size>256) searchSelections.delete(searchSelections.keys().next().value);
  while(portableCreatorQueries.size>256) portableCreatorQueries.delete(portableCreatorQueries.keys().next().value);
  // Home の候補は Home の検索の語。applyQuery は Home では本の源泉へ移る道 (詳細のタグを押した時) なので通さない。
  // Enter はその語で引き (足跡を積む)、Tab は語を置いて打鍵ごとの引き直しに任せる
  if (state.source === 'home' && !libraryScope()) {
    clearTimeout(liveSearchTimer);
    hideSuggest();
    if (submit) {
      state.query = value.trim();
      els.query.value = state.query;
      syncQueryClear();
      runSearch({ reset: true });
    } else {
      els.query.value = value + ' ';
      syncQueryClear();
      scheduleLiveSearch();
    }
    return;
  }
  if (submit) applyQuery(value);
  else {invalidateSearchIntent();els.query.value=value+' ';syncQueryClear();hideSuggest();clearTimeout(liveSearchTimer);}
}
// Home の候補の当て所: 打っている最後の一語だけ (空白で区切った語は全部を満たす読み方なので、句を丸ごとは見ない)。
// 頭の - は当て所の外に残す (候補を選んでも除くの語のまま)。語を打ち終えた (後ろが空白) 時・括った語・
// '@名前 …' (作者頁の語。空白を含む名前の尻を候補で書き換えない) では出さない
function homeSuggestRange(input) {
  const text = String(input || '');
  if (!text.trim() || text.trim().startsWith('@') || /\s$/.test(text)) return null;
  const tokens = [...text.matchAll(/(?:[^\s"]+|"[^"]*")+/g)];
  const last = tokens[tokens.length - 1];
  if (!last) return null;
  let start = last.index;
  let word = last[0];
  if (word.startsWith('-')) {
    start += 1;
    word = word.slice(1);
  }
  if (!word || word.includes('"')) return null;
  return { text: word, start, end: text.length };
}

async function maybeSuggest() {
  if (composingQuery) return;
  const source = state.source;
  const input = els.query.value, epoch=++suggestEpoch;
  // Home は所持の本に付いているタグから候補を出す (母屋の homeAuthors.suggestWords)
  const home = source === 'home' && !libraryScope();
  const homeRange = home ? homeSuggestRange(input) : null;
  if (home && !homeRange) {
    hideSuggest();
    return;
  }
  const ranges = home ? [homeRange] : (window.hitomi.completionRanges?.(input) || [{text:input.trim().split(/\s+/).pop(),start:input.lastIndexOf(' ')+1,end:input.length}]);
  if (!ranges[0]?.text) {
    hideSuggest();
    return;
  }
  try {
    // どのサイトでも候補は出す。hitomi 以外は遠くへ訊きに行かず、
    // 辞書 + 所持庫の作家名 (日本語・かな) だけが返ってくる
    let items=[];
    for (const range of ranges) {
      const rows = await window.hitomi.suggest(range.text, source);
      if (epoch!==suggestEpoch || composingQuery || els.query.value!==input || state.source!==source) return;
      items=(rows || []).filter(item=>typeof item.value==='string' && item.value).map(item=>({...item,_input:input,_range:range}));
      if(items.length) break;
    }
    // 待っている間に打鍵が進んでいたら、古い語の候補は出さない
    // (Enter/Tab がその候補で置換してしまい、誤検索になる)
    if (epoch!==suggestEpoch || composingQuery || els.query.value !== input || state.source !== source) return;
    if (state.suggestKeyboard && state.suggestItems[0]?._input===input) return;
    state.suggestIndex = -1;
    state.suggestKeyboard = false;
    renderSuggest(items);
  } catch {
    if (epoch===suggestEpoch && state.source===source && els.query.value===input) hideSuggest();
  }
}

// 繋ぎ込みの目次。中身はクラスタごとの関数に分けてある。
// 初期描画はここでは行わない: 設定を戻したあとの boot 側が持ち場
function bind() {
  bindSearchControls();
  bindSuggest();
  bindQueryClear();
  bindFilterToggles();
  bindGrid();
  bindLoupe();
  bindDetail();
  bindSettings();
  bindQueue();
  bindReader();
  bindGlobalKeys();
  bindIpc();
}

// 検索欄・履歴の札・スコープ・サイト
function bindSearchControls() {
  els.form.addEventListener('submit', (event) => {
    event.preventDefault();
    // 待たせてある古い語の発火を捨てる (Enter の語が後から上書きされないように)
    clearTimeout(liveSearchTimer);
    const raw = els.query.value.trim();
    const detected = detectSource(raw);
    // 並びから外した源泉 (E-Hentai) の URL では頁を移らない。語はそのまま今の源泉で引く
    if (detected && sourceShown(detected.source)) {
      state.source = detected.source;
      window.hitomi.saveSettings({ source: state.source });
      renderSources();
    }
    state.query = raw;
    hideSuggest();
    runSearch({ reset: true });
  });

  els.recents.addEventListener('click', (event) => {
    const apply = event.target.closest('[data-apply]');
    const star = event.target.closest('[data-star]');
    const token = (apply || star)?.dataset.apply || (star && star.dataset.star);
    if (!token) return;
    const [kind, index] = token.split('-');
    const entry = findSavedSearch(kind, index);
    if (!entry) return;
    if (star) togglePin(entry);
    else applySavedSearch(entry);
  });

  window.addEventListener('scroll', persistSession, { passive: true });

  els.scope.addEventListener('click', () => {
    // Home では所持作品のスコープへ移らず、作者頁を所持の本だけにする旗を切り替える (home.js)
    if (window.BunkoHome?.toggleOwnedOnly?.()) return;
    offlineFallbackUsed = false;
    setScope(libraryScope() ? 'all' : 'library');
  });

  els.source.addEventListener('change', async () => {
    if (els.source.value === state.source) return;
    // 利用者が自分でサイトを替えた: 所持から出る時に元へ戻す約束は無しにする
    libraryDetour = null;
    rememberSort();
    // Home は語の旅に加わらない。Home を出る時は、入る前の源泉から移ったものとして運ぶ
    // (旅の控え = 語と一覧の写しは Home に居る間も残してある)。Home の見た目は 'home' の写しに
    const leftHome = state.source === 'home';
    if (leftHome) {
      if (!state.loading) siteSearchSnapshots.set('home', captureSearchView());
      homeTrip.query = queryDraftEdited ? els.query.value.trim() : state.query;
      queryDraftEdited = false;
      // 入る前の源泉へそのまま戻るなら、旅の控えの語と写しがそのまま使える。
      // 別の源泉へ行くなら、入る前の源泉の語をいつも通り持ち運ぶ
      if (homeTrip.from) {
        state.source = homeTrip.from.source;
        state.query = homeTrip.from.query;
        state.type = homeTrip.from.type;
        state.excludedTypes = [...homeTrip.from.excludedTypes];
      }
    }
    const prevSource=state.source;
    if (queryDraftEdited) { invalidateSearchIntent(); state.query=els.query.value.trim(); queryDraftEdited=false; }
    const originalQuery=state.query;
    hideSuggest();
    if (prevSource !== 'home' && (!queryJourney || queryJourney[prevSource] !== originalQuery)) {
      siteSearchSnapshots.clear(); queryPlans.clear(); activeSearchPlan=null; searchIntent=null; queryJourney={ [prevSource]:originalQuery };
    }
    // Home から出た時の今の画面は Home の物 (上で写した): 入る前の源泉の写しを上書きしない
    if (!state.loading && !leftHome && !searchViewStale) siteSearchSnapshots.set(prevSource,captureSearchView());
    if (els.source.value === 'home') {
      homeTrip.from = prevSource === 'home' ? null : {
        source: prevSource, query: originalQuery, type: state.type, excludedTypes: [...state.excludedTypes],
      };
    }
    rememberPixivTab();
    state.pixivTab=null;
    state.source=els.source.value;
    const destination=state.source, hadDestination=queryJourney?.[destination] !== undefined;
    portQueryInto(prevSource,destination,{silent:!!window.hitomi.searchAuthorContext && !hadDestination});
    const portedQuery=state.query, transition=++sourceTransitionEpoch;
    const transitionSearchEpoch=++searchEpoch; clearTimeout(liveSearchTimer);
    if (activeSearchRequestId) window.hitomi.cancelSearch?.(activeSearchRequestId).catch(()=>{});
    leaveDiscovery();state.galleries=[];state.total=0;state.error='';state.loading=true;state.done=false;
    els.grid.innerHTML='';renderResultInfo(null);renderDetail(null);
    state.sort=sortForSource(destination);
    window.hitomi.saveSettings({source:destination});renderSources();renderTypes();
    const abandonTransition=()=>{
      if(searchEpoch===transitionSearchEpoch && state.source===destination) {
        state.loading=false;setStatus('検索語を入力して検索してください');
      }
    };
    // Home との行き来は語を運ばないので、作者の対応を母屋に訊くことも無い
    const homeHop = prevSource === 'home' || destination === 'home';
    if (window.hitomi.searchAuthorContext && originalQuery && !hadDestination && !homeHop) {
      try {
        const context=await window.hitomi.searchAuthorContext({query:originalQuery,from:prevSource,to:destination,intent:searchIntent,selections:Object.fromEntries(searchSelections)});
        if (transition!==sourceTransitionEpoch || searchEpoch!==transitionSearchEpoch || state.source!==destination || state.query!==portedQuery) {abandonTransition();return;}
        state.query=originalQuery;
        portQueryInto(prevSource,destination,{...context,refresh:true});
      } catch {
        if (transition!==sourceTransitionEpoch || searchEpoch!==transitionSearchEpoch || state.source!==destination || state.query!==portedQuery) {abandonTransition();return;}
        if(searchIntent?.terms.some(term=>term.kind==='tag')) {
          activeSearchPlan={...activeSearchPlan,blocked:true,unresolved:searchIntent.terms.filter(term=>term.kind==='tag').map(term=>({raw:term.raw,status:'unavailable'}))};
          queryPlans.set(destination,activeSearchPlan);
        }
      }
    }
    if (transition!==sourceTransitionEpoch || searchEpoch!==transitionSearchEpoch || state.source!==destination) {abandonTransition();return;}
    state.loading=false;
    if(activeSearchPlan?.blocked) {showSearchResolution();return;}
    const saved=siteSearchSnapshots.get(destination);
    if (saved && saved.query===state.query && saved.scope===state.scope && saved.language===state.language && !saved.type && !saved.excludedTypes?.length) {
      state.pixivTab=destination==='pixiv' && state.query ? 'search' : saved.pixivTab;
      restoreSearchView(saved);persistSession();return;
    }
    if (!homeHop && searchIntent?.terms.length && !state.query) { setStatus('このサイトで使える検索条件がありません。別のサイトに切り替えると条件を引き継げます。'); return; }
    await runSearch({reset:true});
  });
}

// 検索語の補完 (打鍵・変換・候補の一覧)
function bindSuggest() {
  els.query.addEventListener('compositionstart', () => {
    composingQuery = true;
    // 待たせてある発火が変換の途中で落ちないように
    clearTimeout(liveSearchTimer);
    hideSuggest();
  });
  els.query.addEventListener('compositionend', () => {
    composingQuery = false;
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(maybeSuggest, 60);
    // Chromium は compositionend の後に input も投げるが、投げない IME もある。
    // 同じ一本のタイマなので二重に予約しても潰れる
    scheduleLiveSearch();
  });
  els.query.addEventListener('input', () => {
    ++suggestEpoch;
    state.suggestIndex = -1;
    state.suggestKeyboard = false;
    if (composingQuery) return;
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(maybeSuggest, 180);
  });

  els.query.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      // 一度目は候補を畳むだけ。畳んだ後の Esc で語を消して初期状態へ
      if (!els.suggest.hidden) {
        hideSuggest();
        return;
      }
      if (els.query.value || state.query) {
        event.preventDefault();
        resetQueryToBlank();
      }
      return;
    }
    const items = state.suggestItems;
    if (composingQuery || event.isComposing || event.keyCode === 229) return;
    if (els.suggest.hidden || !items.length) return;
    if (event.key === 'Enter') {
      if (!state.suggestKeyboard || state.suggestIndex < 0) return;
      event.preventDefault();
      acceptSuggestion(items[state.suggestIndex]);
      return;
    }
    if (event.key === 'ArrowDown') {
      state.suggestKeyboard = true;
      event.preventDefault();
      state.suggestIndex = Math.min(items.length - 1, state.suggestIndex + 1);
      renderSuggest(items);
    }
    if (event.key === 'ArrowUp') {
      state.suggestKeyboard = true;
      event.preventDefault();
      state.suggestIndex = Math.max(0, state.suggestIndex - 1);
      renderSuggest(items);
    }
    if (event.key === 'Tab' && state.suggestKeyboard && state.suggestIndex >= 0) {
      event.preventDefault();
      acceptSuggestion(items[state.suggestIndex],false);
    }
  });

  els.suggest.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-value]');
    if (!button) return;
    const index=Number(button.dataset.suggestIndex);
    acceptSuggestion(button.dataset.suggestIndex!==undefined ? state.suggestItems[index] : state.suggestItems.find(item=>item.value===button.dataset.value));
  });

  els.suggest.addEventListener('mouseover', (event) => {
    const button = event.target.closest('button[data-value]');
    if (!button) return;
    const buttons = [...els.suggest.querySelectorAll('button[data-value]')];
    const index = buttons.indexOf(button);
    if (index < 0 || index === state.suggestIndex) return;
    state.suggestKeyboard = false;
    state.suggestIndex = index;
    buttons.forEach((item, i) => item.classList.toggle('active', i === state.suggestIndex));
  });
}

// 絞り込みの札と並び (種別・言語・並び順・一括更新・伏せ札・お気に入り)
function bindFilterToggles() {
  els.types.addEventListener('click', (event) => {
    const view = event.target.closest('[data-view="discovery"]');
    if (view) {
      if (!state.discovery) enterDiscovery();
      return;
    }
    const button = event.target.closest('[data-type]');
    if (!button) return;
    const id = button.dataset.type;
    if (id === '') {
      state.excludedTypes = [];
    } else if (state.excludedTypes.includes(id)) {
      state.excludedTypes = state.excludedTypes.filter((item) => item !== id);
    }
    state.type = id;
    renderTypes();
    if (id) flashTypeHint(id);
    persistSession();
    runSearch({ reset: true });
  });

  els.types.addEventListener('contextmenu', (event) => {
    const button = event.target.closest('[data-type]');
    if (!button) return;
    event.preventDefault();
    const id = button.dataset.type;
    if (!id || !typeExclusionSupported()) return;
    if (state.type) state.type = '';
    const set = new Set(state.excludedTypes);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    state.excludedTypes = normalizeExcludedTypes([...set]);
    renderTypes();
    persistSession();
    runSearch({ reset: true });
  });

  els.language.addEventListener('change', () => {
    state.language = els.language.value;
    window.hitomi.saveSettings({ language: state.language });
    runSearch({ reset: true });
  });

  els.sortDir.addEventListener('click', async () => {
    if (!sortDirSupported()) return;
    const next = sortDirValue() === 'asc' ? 'desc' : 'asc';
    state.settings = { ...(state.settings || {}), sortDir: next };
    fillSortDir();
    if (!await saveSetting({ sortDir: next }, { announce: false })) {
      state.settings = { ...(state.settings || {}), sortDir: next === 'asc' ? 'desc' : 'asc' };
      fillSortDir();
      return;
    }
    if (sortDirNativeSupported()) runSearch({ reset: true });
    else renderGrid(false, true);
  });

  els.sort.addEventListener('change', () => {
    state.sort = els.sort.value;
    // 利用者が自分で選んだ: pixiv の自動の倒し (語 → 新しい順) は忘れる
    rememberSort();
    // 向き釦の効く/効かないは並び (お気に入り等) にも依るので描き直す
    fillSortDir();
    fillPawBulk();
    runSearch({ reset: true });
  });

  // 走っていれば止める。止めるのに確認は挟まない (途中まででも取り込みは残る)
  els.pawBulk.addEventListener('click', () => togglePawBulk());

  els.hideOwned.addEventListener('click', async () => {
    const before = hideOwnedMode();
    const next = HIDE_OWNED_MODES[(HIDE_OWNED_MODES.indexOf(before) + 1) % HIDE_OWNED_MODES.length];
    state.settings = { ...(state.settings || {}), hideOwnedMode: next };
    fillHideOwnedToggle();
    if (await saveSetting({ hideOwnedMode: next }, { announce: false })) {
      fillHideOwnedToggle();
    } else {
      // 保存できなかったら見た目も戻す: 表示と永続値を食い違わせない
      state.settings = { ...(state.settings || {}), hideOwnedMode: before };
      fillHideOwnedToggle();
    }
  });

  // 伏せ札と違って表示の間引きでは済まない: 絞り込みは検索そのものを引き直す
  els.favOnly.addEventListener('click', async () => {
    const before = favoritesOnlyEnabled();
    const next = !before;
    state.settings = { ...(state.settings || {}), favoritesOnly: next };
    fillFavToggle();
    if (!await saveSetting({ favoritesOnly: next }, { announce: false })) {
      state.settings = { ...(state.settings || {}), favoritesOnly: before };
      fillFavToggle();
      return;
    }
    fillFavToggle();
    await runSearch({ reset: true });
  });
}

// 一覧の札 (表紙の差し替え・割り当てた操作・虫眼鏡の出し入れ・追い読み)
function bindGrid() {
  bindCardEvents(els.grid);

  new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) {
      if (state.discovery) return; // 発見は追い読みしない
      if (state.galleries.length) runSearch({ reset: false });
    }
  }, { rootMargin: '800px 0px' }).observe(els.sentinel);
}

// 札の押し分け・割れた表紙の差し替え・虫眼鏡。一覧 (#grid) と、Home の作者頁の本の並び
// (src/renderer/home.js) が同じ物を使う (本の札を押した時の動きを本体と揃えるため)
function bindCardEvents(root) {
  // error は泡立たない: 捕捉相で受けて、割れた表紙を代わりの絵に差し替える
  root.addEventListener('error', (event) => {
    const img = event.target;
    if (!img || img.tagName !== 'IMG' || !img.closest('.cover')) return;
    swapCoverBlank(img);
  }, true);

  root.addEventListener('click', (event) => {
    // フォロー (pixiv の作者の札の字の釦)。札は開かない
    const follow = event.target.closest('[data-follow]');
    if (follow) {
      event.stopPropagation();
      togglePixivFollow(follow.dataset.follow);
      return;
    }
    const act = event.target.closest('.card-act');
    if (act) {
      const owner = act.closest('.card[data-id]');
      if (!owner) return;
      event.stopPropagation();
      if (act.dataset.act === 'save') startDownload(owner.dataset.id);
      else if (act.dataset.act === 'paw-fav') togglePawFav(owner.dataset.id);
      else if (act.dataset.act === 'paw-link') openPawPicker(owner.dataset.id);
      else if (act.dataset.act === 'paw-folder') openPawCreatorFolders(owner.dataset.id);

      else if (act.dataset.act === 'open-owned') {
        const gallery = findGallery(owner.dataset.id);
        if (gallery) openOwnedWork(gallery);
      } else openDetail(owner.dataset.id);
      return;
    }
    const card = event.target.closest('.card[data-id]');
    if (!card) return;
    const id = card.dataset.id;
    clearTimeout(cardClickTimer);
    // Home の作者の見出し: 左は詳細、右とダブルクリックは作者頁 (マウスの割り当てに依らない)
    if (window.BunkoHome?.press(id, event.detail > 1 ? 'double' : 'left')) return;
    pressLeft(event, () => performCardAction(cardAction('Left'), id));
  });

  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.target.closest('.card-act') || event.target.closest('[data-follow]')) return;
    const card = event.target.closest('.card[data-id]');
    if (!card) return;
    event.preventDefault();
    if (window.BunkoHome?.press(card.dataset.id, 'left')) return;
    performCardAction(cardAction('Left'), card.dataset.id);
  });

  root.addEventListener('dblclick', (event) => {
    // the hover buttons own their own presses: a double tap on 保存 is two saves,
    // not two saves plus whatever the double click is mapped to
    if (event.target.closest('.card-act')) return;
    const card = event.target.closest('.card[data-id]');
    if (!card) return;
    event.preventDefault();
    clearTimeout(cardClickTimer);
    if (window.BunkoHome?.press(card.dataset.id, 'double')) return;
    performCardAction(cardAction('Double'), card.dataset.id);
  });

  root.addEventListener('contextmenu', (event) => {
    const card = event.target.closest('.card[data-id]');
    if (!card) return;
    event.preventDefault();
    clearTimeout(cardClickTimer);
    if (window.BunkoHome?.press(card.dataset.id, 'right')) return;
    performCardAction(cardAction('Right'), card.dataset.id);
  });

  root.addEventListener('mouseover', (event) => {
    if (!loupeEnabled()) return;
    const card = event.target.closest('.card[data-id]');
    if (!card) {
      cancelLoupeTimer();
      return;
    }
    // the loupe belongs to the thumbnail only: moving onto the title block dismisses it
    const cover = event.target.closest('.cover');
    if (!cover || !card.contains(cover)) {
      cancelLoupeTimer();
      hideLoupe(false);
      return;
    }
    const gallery = findGallery(card.dataset.id);
    if (!els.loupe.hidden) {
      cancelLoupeTimer();
      showLoupe(card, gallery);
      return;
    }
    if (pendingLoupeCard === card) return;
    cancelLoupeTimer();
    pendingLoupeCard = card;
    showLoupeTimer = setTimeout(() => {
      pendingLoupeCard = null;
      // 待っている間に一覧が描き直されて札が外れていたら、左上に化けて出るだけ
      if (!card.isConnected) return;
      showLoupe(card, findGallery(card.dataset.id) || gallery);
    }, 180);
  });

  root.addEventListener('mouseleave', () => {
    cancelLoupeTimer();
    hideLoupe(false);
  });
}

// 虫眼鏡そのものと、ホイールに乗っている札の大きさ
function bindLoupe() {
  els.loupe.addEventListener('mouseenter', () => clearTimeout(hideLoupeTimer));
  els.loupe.addEventListener('mouseleave', () => hideLoupe(false));
  window.addEventListener('scroll', () => {
    // ルーペが閉じていて、出待ちの札もないなら何もすることがない。
    // 通常のグリッドスクロールを毎回 DOM 掃除で汚さないための早期 return
    // (pendingLoupeCard は表示タイマーと常に対で立つ/消える)
    if (els.loupe.hidden && !pendingLoupeCard) return;
    cancelLoupeTimer();
    hideLoupe(true);
  }, true);

  let lastLoupeFlip = 0;
  window.addEventListener('wheel', (event) => {
    // 通常のグリッドスクロール (リーダー非表示・ルーペ非表示・ctrl 無し) は素通し。
    // Reader.handleWheel は els.reader.hidden なら即 false を返すだけなので、
    // この 3 条件が揃うとき下の各分岐はどれも何もしない
    if (els.reader.hidden && els.loupe.hidden && !event.ctrlKey) return;
    // the reader owns the wheel while it is open: turn pages, never zoom the grid
    if (Reader.handleWheel(event)) return;
    if (event.ctrlKey && els.reader.hidden) {
      event.preventDefault();
      applyZoom(state.zoom + (event.deltaY > 0 ? -1 : 1));
      return;
    }
    if (!els.loupe.hidden && (els.loupe.matches(':hover') || event.target.closest('.card'))) {
      event.preventDefault();
      const now = Date.now();
      if (now - lastLoupeFlip < 80) return;
      lastLoupeFlip = now;
      stepLoupe(event.deltaY > 0 ? 1 : -1);
    }
  }, { passive: false });

  // 表示の釦は左で表示の小窓 (bunko-ui.js)。右クリックの一段送りは外した (2026-09-27 利用者:
  // 大きさは Ctrl+ホイールと小窓の「表紙の大きさ」だけで替える)
}

// 詳細パネル (開き方の釦・タグ・紐付けピッカー)
async function readRelatedWork(id) {
  const gallery=relatedDetailItems.get(String(id)) || await window.hitomi.gallery(id);
  if (gallery) await Reader.open(await withPageCount(gallery));
}
// 詳細の関連作品の札も一覧の札と同じ割り当てで押し分ける (左 / 右 / ダブル → 詳細 / 読む / 保存)
async function pressRelatedDetail(kind, id) {
  const action = cardAction(kind);
  // Eagle が持ち主の本 (Home の「最近の本」) に保存は無い: 一覧の札と同じく読むほうに回す
  const act = action === 'save' && isEagleItem(findGallery(id) || relatedDetailItems.get(String(id))) ? 'read' : action;
  if (act === 'detail') {
    if (state.selected?.id != null) detailTrail.push(String(state.selected.id));
    await openDetail(id, {keepTrail:true});
    els.detail.scrollTop=0;
  } else if (act === 'read') {
    try { await readRelatedWork(id); } catch(error) { toast(error.message); }
  } else if (act === 'save') startDownload(id);
}
function bindDetail() {
  els.detail.addEventListener('contextmenu', event => {
    const row=event.target.closest('[data-related-detail]');
    if (!row) return;
    event.preventDefault();
    clearTimeout(cardClickTimer);
    pressRelatedDetail('Right', row.dataset.relatedDetail);
  });
  els.detail.addEventListener('dblclick', event => {
    const row=event.target.closest('[data-related-detail]');
    if (!row) return;
    event.preventDefault();
    clearTimeout(cardClickTimer);
    pressRelatedDetail('Double', row.dataset.relatedDetail);
  });
  els.detailClose.addEventListener('click', () => {
    state.selected = null;
    renderDetail(null);
  });

  els.detail.addEventListener('click', onDetailClick);
}

// 詳細の釦の受け手。読む画面の板の「情報」(同じ中身) からも呼ぶ: その時は state.selected を板の作品に差し替えてから
async function onDetailClick(event) {
  {
    const urlLink=event.target.closest('[data-caption-url]');
    if(urlLink){event.preventDefault();try{await window.hitomi.openCaptionUrl(urlLink.dataset.captionUrl);}catch(error){toast(error.message);}return;}
    const caption = event.target.closest('[data-caption-work]');
    if (caption) { event.preventDefault(); await openDetail(caption.dataset.captionWork,{keepTrail:true}); els.detail.scrollTop=0; return; }
    const related = event.target.closest('[data-related-detail]');
    if (related) { const id = related.dataset.relatedDetail; pressLeft(event, () => pressRelatedDetail('Left', id)); return; }
    const read = event.target.closest('[data-read]');
    const save = event.target.closest('[data-save]');
    const eagle = event.target.closest('[data-eagle]');
    const site = event.target.closest('[data-site]');
    const tag = event.target.closest('[data-query]');
    const link = event.target.closest('[data-link]');
    const unlink = event.target.closest('[data-unlink]');
    const trash = event.target.closest('[data-trash]');
    const hit = event.target.closest('[data-eagle-item]');
    const creator = event.target.closest('[data-creator]');
    const variant = event.target.closest('[data-variant]');

    const follow = event.target.closest('[data-follow]');
    if (follow) togglePixivFollow(follow.dataset.follow);
    // 一覧に既に居る作品は詳細を待たずに開く (7be8d95) ので、state.selected の頁数は
    // 名前由来のことがある。読む直前に原本から数え直す
    if (read && state.selected) Reader.open(await withPageCount(state.selected));
    const aiMeta = event.target.closest('[data-ai-meta]');
    if (aiMeta && state.selected) Reader.open(await withPageCount(state.selected), 0, { side: 'prompt' });
    // 作品一覧へ移ったら詳細は用済み: 結果が見えるように畳む
    if (creator && openCreator(creator.dataset.creator)) {
      state.selected = null;
      renderDetail(null);
    }
    if (save) startDownload(save.dataset.save);
    if (eagle) window.hitomi.openEagle(eagle.dataset.eagle);
    if (site) window.hitomi.openExternal(site.dataset.site);
    if (tag) applyQuery(tag.dataset.query);
    if (link) toggleLinkPicker();
    if (unlink) unlinkOwned(unlink.dataset.unlink);
    if (trash) trashOwned(trash.dataset.trash);
    if (hit) linkOwned(hit.dataset.eagleItem, hit.dataset.itemTitle, hit.dataset.relink === '1');
    // 版違いへ渡る: 今の詳細を道筋に積んで、マウスの戻るで帰れるようにする
    if (variant) {
      if (state.selected?.id != null) detailTrail.push(String(state.selected.id));
      openDetail(variant.dataset.variant, { keepTrail: true });
    }
  }

  els.detail.addEventListener('input', (event) => {
    const field = event.target.closest('.link-query');
    if (field) scheduleLinkSearch(field.value);
  });
}

// 設定の窓とその中身 (ヘルプ・pawchive の紐付け窓・帯の高さもここから繋ぐ)
function bindSettings() {
  document.getElementById('btn-settings').addEventListener('click', openSettings);

  els.settingsClose.addEventListener('click', closeSettings);

  bindSettingsTabs();

  els.settings.addEventListener('click', (event) => {
    if (event.target === els.settings) closeSettings();
  });

  bindPawPicker();
  watchRailHeight();

  els.helpClose.addEventListener('click', closeHelp);

  els.help.addEventListener('click', (event) => {
    if (event.target === els.help) closeHelp();
  });

  els.setDownloadChoose.addEventListener('click', async () => {
    const before = state.settings.downloadDir || '';
    state.settings = await window.hitomi.chooseFolder('download');
    fillSettingsFields();
    renderJobs();
    if ((state.settings.downloadDir || '') !== before) toast('設定を保存しました');
  });

  els.setDownloadOpen.addEventListener('click', () => {
    window.hitomi.openFolder();
  });

  els.setEagleChoose.addEventListener('click', async () => {
    const before = state.settings.eagleLibrary || '';
    state.settings = await window.hitomi.chooseFolder('eagle');
    fillSettingsFields();
    if ((state.settings.eagleLibrary || '') === before) return;
    toast('設定を保存しました');
    runRescan();
  });

  // pixiv の行 (ログイン・token・ログアウト・AI を隠す・付け直し)
  if (els.setPixivLogin) {
    els.setPixivLogin.addEventListener('click', pixivLogin);
    els.setPixivToken.addEventListener('click', pixivPasteToken);
    els.setPixivLogout.addEventListener('click', pixivLogout);
    els.setPixivRelabel.addEventListener('click', pixivRelabel);
    els.setPixivHideAi.addEventListener('click', async () => {
      const next = !hideAiEnabled();
      if (!await saveSetting({ pixivHideAi: next })) return;
      fillPixivSettings();
      applyHideAi();
      // 伏せた数と「該当なし」の文が変わる: 件数の行を描き直す
      renderResultInfo(state.interpreted || []);
      updateEmptyState();
    });
    if (els.setAiMetaBackfill) {
      els.setAiMetaBackfill.addEventListener('click', async () => {
        const running = state.aiMetaBackfill && state.aiMetaBackfill.running;
        try {
          const out = await window.hitomi.pixiv({ action: 'ai-meta-backfill', op: running ? 'stop' : 'start' });
          state.aiMetaBackfill = out && out.backfill ? out.backfill : null;
        } catch (error) { toast(error.message, { type: 'error' }); }
        paintAiMetaBackfill(state.aiMetaBackfill);
      });
      window.hitomi.onAiMetaBackfill?.((status) => { state.aiMetaBackfill = status; paintAiMetaBackfill(status); });
    }
    if (els.setAitag) {
      els.setAitag.addEventListener('click', async () => {
        const next = !aitagEnabled();
        if (!await saveSetting({ aitagEnabled: next })) return;
        fillPixivSettings();
        window.BunkoAiMeta?.resetMarks?.();
      });
    }
    if (els.setPixivReadOriginal) {
      els.setPixivReadOriginal.addEventListener('click', async () => {
        const next = !readOriginalEnabled();
        if (!await saveSetting({ pixivReadOriginal: next })) return;
        fillPixivSettings();
      });
    }
  }

  // 全件を読み直す。整形の版を上げた回や、控えが古いと疑うときに利用者が押す。
  // 写しでは控えを捨てず、写した棚 DB を読み直すだけなので訊かない
  els.setRescan.addEventListener('click', async () => {
    if (els.setRescan.disabled) return;
    if (readOnlyMode()) {
      runRescan();
      return;
    }
    const ok = await confirmDialog(
      '走査の控えを捨てて、全件から組み直しますか?\n'
      + 'Eagle ライブラリの全アイテムを読み直すので、SMB 越しでは十数秒かかります。',
      { okLabel: '組み直す', cancelLabel: 'やめる' },
    );
    if (ok) runRescan();
  });

  els.setSyncHomecore.addEventListener('click', () => runSyncHomecore());

  els.setEagleClear.addEventListener('click', async () => {
    // 取り消せない側の操作。外した瞬間に済 の判定が全部落ち、棚の所持が 0 になる。
    // 何を失うのかを数で見せてから訊く (項目 5-3)
    const status = state.library || {};
    const owned = Number(status.owned) || 0;
    const detail = owned
      ? `所持と判定している ${owned} 件の印が出なくなります。`
      : 'ライブラリを外すと、所持の判定が出なくなります。';
    const ok = await confirmDialog(
      `Eagle ライブラリの指定を外しますか?
${detail}
`
      + '控えと台帳はそのまま残るので、同じフォルダを指し直せば元に戻ります。',
      { okLabel: '外す', cancelLabel: 'やめる' },
    );
    if (!ok) return;
    if (await saveSetting({ eagleLibrary: '' })) fillSettingsFields();
  });

  els.setLan.addEventListener('click', () => toggleLanShare());

  els.setLanCopy.addEventListener('click', async () => {
    if (!lanStatus.running || !lanStatus.url) return;
    try {
      await navigator.clipboard.writeText(lanStatus.url);
      toast('アドレスをコピーしました');
    } catch {
      toast('コピーできませんでした', { type: 'error' });
    }
  });

  els.setLanTsCopy.addEventListener('click', async () => {
    const ts = lanStatus.running ? lanStatus.tailscale : null;
    if (!ts || !ts.url) return;
    try {
      await navigator.clipboard.writeText(ts.url);
      toast('Tailscale のアドレスをコピーしました');
    } catch {
      toast('コピーできませんでした', { type: 'error' });
    }
  });

  els.setLoupe.addEventListener('click', async () => {
    const next = !loupeEnabled();
    if (!await saveSetting({ loupeEnabled: next })) return;
    fillLoupeToggle();
    if (!next) {
      cancelLoupeTimer();
      hideLoupe(true);
    }
  });

  els.setReaderNextCard.addEventListener('click', async () => {
    const next = !readerNextCardEnabled();
    if (await saveSetting({ readerNextCard: next })) fillReaderNextCardToggle();
  });

  els.setReaderResume.addEventListener('click', async () => {
    const next = !readerResumeEnabled();
    if (await saveSetting({ readerResume: next })) fillReaderResumeToggle();
  });

  els.setOwnedConfirm.addEventListener('click', async () => {
    const next = !ownedSaveConfirmEnabled();
    if (await saveSetting({ ownedSaveConfirm: next })) fillOwnedConfirmToggle();
  });

  els.setAutoSync.addEventListener('click', async () => {
    const next = !autoSyncEnabled();
    if (await saveSetting({ autoSync: next })) fillAutoSyncToggle();
  });

  els.setShowUnmatched.addEventListener('click', async () => {
    const next = !showUnmatchedEnabled();
    if (!await saveSetting({ showUnmatchedEagle: next })) return;
    fillShowUnmatchedToggle();
    // 所持一覧を見ている最中なら、混ざり方の変化をその場で反映する
    if (libraryScope()) await runSearch({ reset: true });
  });

  // select ひとつが設定キーひとつ。保存に失敗したら保存前の値に戻す
  const bindSettingSelect = (select, key, currentValue) => {
    select.addEventListener('change', async () => {
      if (!await saveSetting({ [key]: select.value })) select.value = currentValue();
    });
  };

  bindSettingSelect(els.setMouseLeft, 'mouseLeft', () => cardAction('Left'));
  bindSettingSelect(els.setMouseRight, 'mouseRight', () => cardAction('Right'));
  bindSettingSelect(els.setMouseDouble, 'mouseDouble', () => cardAction('Double'));
  bindSettingSelect(els.setSaveFormat, 'saveFormat', saveFormat);
  // 保存が終わってから描き直す (2 本に分けると、描画側が古い設定を読む)
  els.setOpenOwned.addEventListener('change', async () => {
    if (!await saveSetting({ openOwned: els.setOpenOwned.value })) {
      els.setOpenOwned.value = openOwnedPrefersEagle() ? 'eagle' : 'app';
      return;
    }
    if (state.galleries.length) renderGrid(false);
    if (state.selected) renderDetail(state.selected);
  });
  // Home の一覧を「判定できなかった作者だけ」に (保存が済んでから引き直す)
  els.setHomeUnresolved.addEventListener('change', async () => {
    const next = els.setHomeUnresolved.value === 'on';
    if (!await saveSetting({ homeUnresolvedOnly: next })) {
      els.setHomeUnresolved.value = homeUnresolvedOnly() ? 'on' : 'off';
      return;
    }
    if (state.source === 'home') runSearch({ reset: true });
  });

  // 基準を動かすと ★ の札の名乗りも変わる。絞り込み中なら結果も引き直す
  els.setFavoriteStars.addEventListener('change', async () => {
    const next = Math.round(Number(els.setFavoriteStars.value));
    if (!await saveSetting({ favoriteMinStars: next })) {
      fillFavoriteSetting();
      return;
    }
    fillFavoriteSetting();
    fillFavToggle();
    if (libraryScope() && favoritesOnlyEnabled()) await runSearch({ reset: true });
  });

  els.setConcurrency.addEventListener('change', () => saveLimit('concurrency', els.setConcurrency, 1, 16));
  els.setMaxGalleries.addEventListener('change', () => saveLimit('maxGalleries', els.setMaxGalleries, 1, 8));
  els.setPawBulkConcurrency.addEventListener('change', () => saveLimit('pawBulkConcurrency', els.setPawBulkConcurrency, 1, 6));
  els.setTrayClose.addEventListener('change', () => saveLimit('trayCloseMinutes', els.setTrayClose, 0, 1440));

  els.setPawBulkChoose.addEventListener('click', async () => {
    const before = state.settings.pawBulkDir || '';
    state.settings = await window.hitomi.chooseFolder('pawBulk');
    fillSettingsFields();
    if ((state.settings.pawBulkDir || '') !== before) toast('設定を保存しました');
  });

  els.setPawBulkOpen.addEventListener('click', () => {
    window.hitomi.openFolder(state.settings.pawBulkDir || '');
  });
}

// ダウンロードの控え室 (開閉・一括操作・行ごとの釦)
function bindQueue() {
  document.getElementById('btn-queue').addEventListener('click', () => {
    els.queue.hidden = !els.queue.hidden;
  });

  document.getElementById('open-dest').addEventListener('click', () => {
    window.hitomi.openFolder();
  });

  document.getElementById('clear-finished').addEventListener('click', async () => {
    try {
      state.downloads = await window.hitomi.clearFinished();
      renderJobs();
    } catch {
      toast('完了の消去に失敗しました', { type: 'error' });
    }
  });

  document.getElementById('cancel-all').addEventListener('click', async () => {
    const targets = state.downloads.filter((job) => job.status === 'queued' || job.status === 'running');
    if (!targets.length) return;
    try {
      await Promise.all(targets.map((job) => window.hitomi.cancel(job.id)));
      toast('中止を要求しました');
    } catch {
      toast('中止できませんでした', { type: 'error' });
    }
  });

  const onJobClick = (event) => {
    const open = event.target.closest('[data-open]');
    // 済んだ仕事の「開く」は Eagle のアイテムを開く。落とした先の道は
    // 取り込みと同時に消えるので、そこを開こうとすると網の向こうを探しに行く
    const openEagle = event.target.closest('[data-open-eagle]');
    const show = event.target.closest('[data-show]');
    const cancel = event.target.closest('[data-cancel]');
    const retry = event.target.closest('[data-retry]');
    if (open) window.hitomi.openFolder(open.dataset.open);
    if (openEagle) window.hitomi.openEagle(openEagle.dataset.openEagle);
    if (show) window.hitomi.showInFolder(show.dataset.show);
    if (cancel) window.hitomi.cancel(cancel.dataset.cancel);
    if (retry) window.hitomi.retryDownload(retry.dataset.retry);
    // pixiv の取り込みが作者フォルダを決めかねている行の答え
    const answer = event.target.closest('[data-answer]');
    if (answer) {
      const same = answer.dataset.answer === 'same';
      window.hitomi.pixiv({
        action: 'answer',
        userId: answer.dataset.user || '',
        folderId: same ? answer.dataset.folder || null : null,
        name: same ? answer.dataset.name || '' : '',
      }).catch(() => toast('答えを届けられませんでした', { type: 'error' }));
    }
  };
  els.jobs.addEventListener('click', onJobClick);
  els.jobsDone.addEventListener('click', onJobClick);
}

// 「次の作品」が一覧のどちら隣か (設定 readerNextOrder)。'up' = 一つ上の行 (既定)、'down' = 一つ下の行
function readerNextOrder() {
  return (state.settings || {}).readerNextOrder === 'down' ? 'down' : 'up';
}

// リーダーから見た隣の作品。delta > 0 が「次」(最終頁の先)、< 0 が「前」。
// 次 = リーダーを開いた一覧の隣の行 (向きは設定)。作者の札と読めない行は飛ばす。
// 一覧に居ない作品 (詳細だけ開いたものなど) には隣が無い
function readerNeighbor(id, delta) {
  const forward = delta > 0;
  const step = (readerNextOrder() === 'up') === forward ? -1 : 1;
  // Home の作者頁を開いている間は、その頁に並んだ本の順 (一覧の札は作者なので次が無い)
  const items = window.BunkoHome?.readingOrder() || visibleGridItems();
  const from = items.findIndex((item) => sameId(item.id, id));
  if (from < 0) return null;
  for (let i = from + step; i >= 0 && i < items.length; i += step) {
    const item = items[i];
    if (item && !item.error && item.kind !== 'creator') return item;
  }
  return null;
}

// リーダーの繋ぎ込みと、リーダーから見た「次の作品」の引き当て
function bindReader() {
  Reader.bind();

  Reader.setNeighborProvider(readerNeighbor);

  // 継ぎ目の作者名 → その作者の作品一覧。語は札の作者と同じ道 (pixiv は user:<番号>)。
  // 読み手を閉じてから引く。Home から読んでいた時はその本の源泉のタブへ移る (詳細のタグと同じ)
  Reader.setCreatorOpener((gallery) => {
    const tag = (gallery.artists || [])[0] || (gallery.groups || [])[0];
    if (!tag) return false;
    const query = tagQuery(tag, gallery);
    if (!query) return false;
    Reader.close();
    if (state.source === 'home' && !libraryScope()) {
      state.selected = gallery;
      applyQueryFromHome(query);
    } else {
      applyQuery(query);
    }
    return true;
  });

  // 継ぎ目の作品の札 (次の作品・関連作品) の押し分け。読む画面の中なので、左は割り当てに依らず
  // いつも「読む」= その作品へ渡る (読み手の足跡に積む。利用者の決め 2026-09-27)。
  // 右とダブルは一覧の札と同じ割り当て: 詳細は読み手を閉じて開き、保存はその場で落とす。
  // 左はダブルに割り当てがある間は一呼吸待つ (ダブルクリックの一打目で渡ってしまわない)
  Reader.setWorkPress((kind, gallery, event, cross) => {
    const run = () => {
      // 待っている間に継ぎ目が畳まれた (閉じた・頁へ戻った) なら何もしない
      if (!state.reader?.boundary) return;
      const action = kind === 'Left' ? 'read' : cardAction(kind);
      const act = action === 'save' && isEagleItem(gallery) ? 'read' : action;
      if (act === 'read') cross();
      if (act !== 'detail' && act !== 'save') return;
      const id = String(gallery.id);
      if (!findGallery(id)) keepRelatedItems([gallery]);
      if (act === 'save') {
        startDownload(id);
        return;
      }
      Reader.close();
      openDetail(id);
    };
    if (kind === 'Left') pressLeft(event, run);
    else {
      clearTimeout(cardClickTimer);
      run();
    }
  });
}

// 画面ぜんぶに掛かる操作 (控え室の外を押す・戻る/進む・打鍵)
function bindGlobalKeys() {
  document.addEventListener('click', (event) => {
    if (els.queue.hidden) return;
    if (event.target.closest('#queue') || event.target.closest('#btn-queue')) return;
    els.queue.hidden = true;
  });

  document.addEventListener('mouseup', (event) => {
    if (event.button !== 3 && event.button !== 4) return;
    event.preventDefault();
    if (event.button === 3) navBack();
    else navForward();
  });

  window.hitomi.onNavCommand((cmd) => {
    if (cmd === 'browser-backward') navBack();
    else navForward();
  });

  document.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    // ヘルプは一番上に載っている: 他の Esc 処理より先に取る
    if (event.key === 'Escape' && !els.help.hidden) {
      closeHelp();
      return;
    }
    // 紐付けの窓もヘルプと同じ高さに居る
    if (event.key === 'Escape' && !els.pawLink.hidden) {
      closePawPicker();
      return;
    }
    if (event.key === '?' && !isTypingGlobal()) {
      event.preventDefault();
      Reader.dismissHint();
      // サムネイル一覧 (ヘルプより高い層) を開いたままだと、見えないヘルプに
      // 次の Esc が吸われる。ヘルプを出す前に畳む
      Reader.closeThumbs();
      toggleHelp();
      return;
    }
    // 設定は一番上に載っている: リーダーより先に Esc を取る
    if (event.key === 'Escape' && !els.settings.hidden) {
      closeSettings();
      return;
    }
    if (Reader.handleKey(event)) return;
    // 入力欄に居るときの / は文字。検索欄への飛び先にしない (紐付けピッカー等)
    if (event.key === '/' && !isTypingGlobal() && !Reader.isOpen()) {
      event.preventDefault();
      els.query.focus();
    }
    if (event.key === 'Escape' && !els.detail.hidden) {
      // 紐付けピッカーが開いていれば、まずそれだけ畳む
      if (closeLinkPicker()) return;
      state.selected = null;
      renderDetail(null);
    }
  });
}

// 主側から押し出されてくる知らせ (ライブラリ・一括更新・走査・保存・台帳)
function bindIpc() {
  window.hitomi.onLibraryProgress?.((status) => applyLibrary(status));

  window.hitomi.onPawBulkProgress?.((status) => { applyPawBulk(status); });
  window.hitomi.onPixivBulkProgress?.((status) => { applyPixivBulk(status); });

  window.hitomi.onCatalogProgress(({ scanned, total, reread }) => {
    if (!state.scanning) return;
    state.scanProgress = { scanned, total, reread };
    renderLibrary();
  });

  window.hitomi.onDownloads((jobs) => {
    const newlyDone = [];
    jobs.forEach((job) => {
      const previous = jobStatuses.get(job.id);
      if (previous === job.status) return;
      jobStatuses.set(job.id, job.status);
      if (job.status === 'done') {
        newlyDone.push(job);
        if (previous !== undefined) toast(`保存完了: ${job.title}`, { type: 'success' });
      }
      if (job.status === 'error' && previous !== undefined && (job.attempts || 0) >= 4) {
        toast(`保存に失敗: ${job.title}`, { type: 'error' });
      }
    });
    const live = new Set(jobs.map((job) => job.id));
    [...jobStatuses.keys()].forEach((id) => {
      if (!live.has(id)) jobStatuses.delete(id);
    });

    state.downloads = jobs;
    renderJobs();
    updateJobStrips(jobs);
    if (!newlyDone.length) return;
    newlyDone.forEach((job) => {
      const gallery = state.galleries.find((item) => sameId(item.id, job.id));
      if (gallery) gallery.owned = true;
      // 詳細やリーダーで同じ作品を開いたままなら、そちらの持ち分にも 済 を立てる
      if (state.selected && sameId(state.selected.id, job.id)) {
        state.selected.owned = true;
        if (!els.detail.hidden) renderDetail(state.selected);
      }
      if (state.reader?.gallery && sameId(state.reader.gallery.id, job.id)) {
        state.reader.gallery.owned = true;
      }
    });
    updateOwnedMarks(newlyDone.map((job) => job.id));
  });

  window.hitomi.onCatalog(async (snapshot) => {
    applyCatalog(snapshot);
    // 走査が済んだ (scanned) / 写しの台帳が丸ごと差し替わった (mirrorReloaded) 知らせ。
    // 所持作品の一覧は台帳から引き直さないと増減が画面に出ない。見ている場所はそのまま
    if ((snapshot.scanned || snapshot.mirrorReloaded) && state.scope === 'library') {
      refreshLibraryInPlace().catch(() => {});
      return;
    }
    if (snapshot.scanning || !state.galleries.length) return;
    const epoch = searchEpoch;
    const fresh = await window.hitomi.annotate(state.galleries);
    // 待っている間に検索が切り替わっていたら、古い一覧で上書きしない
    if (epoch !== searchEpoch) return;
    state.galleries = fresh;
    adoptAnnotated(fresh);
    updateOwnedMarks(state.galleries.filter((item) => item.owned).map((item) => item.id));
  });
}

async function boot() {
  // 器 (els) が欠けていると、どこかの bind で静かに TypeError が起きて
  // 途中から何も動かなくなる。先に名指しで知らせる
  for (const [key, node] of Object.entries(els)) {
    if (!node) console.error(`els.${key} の要素が見つかりません (index.html の id を確認)`);
  }
  fillIcons();
  bind();
  let viewportFrame = 0;
  const refreshGridWindow = () => {
    if (viewportFrame || !state.galleries.length || state.discovery) return;
    viewportFrame = requestAnimationFrame(() => {
      viewportFrame = 0;
      renderGrid(false, false);
    });
  };
  window.addEventListener('scroll', refreshGridWindow, { passive: true });
  window.addEventListener('resize', () => {
    const anchor = currentScrollAnchor();
    const fallbackScroll = window.scrollY;
    gridRowHeight = 360;
    refreshGridWindow();
    if (anchor) requestAnimationFrame(() => {
      renderGrid(false, true);
      requestAnimationFrame(() => restoreScroll(anchor, fallbackScroll));
    });
  });
  // 設定だけは先に要る: 続きの復元も初期描画もここを土台にしている
  state.settings = await window.hitomi.settings();
  state.source = shownSourceOr(state.settings.source || 'hitomi');
  // サイトもスコープも区別しない単一の settings.sort は読まない。所持作品で
  // 選んだ 保存日 が、次の起動で web hitomi の既定まで潰していた
  state.sortBySource = state.settings.sortBySource || {};
  state.language = state.settings.language || '';
  const session = state.settings.session;
  if (session) {
    // 並びから外した源泉 (E-Hentai) で閉じていたら hitomi から始める (語は持ち越さない)
    const closedOn = session.source || state.source;
    state.query = sourceShown(closedOn) ? session.query || '' : '';
    state.source = shownSourceOr(closedOn);
    state.scope = session.scope === 'library' ? 'library' : 'all';
    state.language = session.language || state.language;
    state.type = session.type || '';
    state.excludedTypes = normalizeExcludedTypes(session.excludedTypes);
    els.query.value = state.query;
  }
  // 並びを決めるのは**サイトとスコープが確定した後**。先に決めると sortMemoryKey が
  // 'all:hitomi' を引き、所持作品で閉じた続きの並びが復元されない。
  // 閉じた時の並びは、今のサイトの表に在る時だけ引き継ぐ
  const closedWith = session && session.sort;
  state.pixivPeriod = session?.pixivPeriod || 'year';
  const openOptions = state.scope === 'library'
    ? (state.source === 'pawchive' ? PAW_LIBRARY_SORTS : LIBRARY_SORTS)
    : sortsFor(state.source);
  state.sort = (closedWith && openOptions.some((item) => item.id === closedWith))
    ? closedWith
    : sortForSource(state.source);
  state.readerRtl = state.settings.readerRtl !== false;
  state.readerFit = state.settings.readerFit === 'width' ? 'width' : 'contain';
  state.readerSpread = state.settings.readerSpread === true;
  applyReadOnly();
  Reader.applyPrefs();
  fillSettingsFields();
  fillHideOwnedToggle();
  fillFavToggle();
  fillSelect(els.language, LANGUAGES, state.language);
  // Home の部品 (作者頁の器・詳細の結びの口) を据えてから源泉を描く (renderSources が Home の顔を合わせる)
  window.BunkoHome?.init();
  renderSources();
  renderTypes();
  renderRecents();
  window.BunkoUI?.init();
  // ここから先は互いに独立した問い合わせ: 直列に待たず一度にまとめて出す。
  // 一括更新の様子は起動時に一度引く (走っている最中に画面を開き直したときのため)
  const imageBasePromise = window.hitomi.imageBase();
  const downloadsPromise = window.hitomi.downloads();
  const catalogPromise = window.hitomi.catalog();
  // 引けなくても釦そのものは押せる
  const pawBulkPromise = window.hitomi.pawBulk({ action: 'status' }).catch(() => null);
  const libraryPromise = refreshLibrary();
  // 画像口は台帳を待たず数 ms で返る。先に確定させ、最初の検索を他の台帳待ちと
  // 同時に発射する: 検索も台帳待ちなので、往復ぶんがまるごと待ちの裏に隠れる
  state.imageBase = await imageBasePromise;
  applyZoom(Number(session?.zoom ?? state.settings.zoom ?? 3), false);
  const restoreToken = (historyRestoreToken += 1);
  // 所持作品の棚は前回の頁数ぶんを一度に取る (手元の台帳なので数百件でも数十 ms)。
  // 以前は 24 頁を直列に 24 往復していた。網の検索は 1 頁ずつ (下の追い読み)
  const restorePages = Math.max(1, Number(session?.loadedPages) || 1);
  const searchPromise = runSearch({
    reset: true, restoreToken, spanPages: libraryScope() ? Math.min(60, restorePages) : 1,
  });
  const [downloads, catalog, pawBulkStatus] = await Promise.all([
    downloadsPromise,
    catalogPromise,
    pawBulkPromise,
    libraryPromise,
  ]);
  state.downloads = downloads;
  syncJobStatuses();
  // 台帳は refreshLibrary のあとに映す: 走査中かどうかは台帳側が決める
  applyCatalog(catalog);
  if (pawBulkStatus) state.pawBulk = pawBulkStatus;
  fillPawBulk();
  renderJobs();
  await searchPromise;
  while (restoreToken === historyRestoreToken && state.page < restorePages && !state.done && !state.error) {
    const before = state.page;
    await runSearch({ reset: false, restoreToken });
    if (restoreToken !== historyRestoreToken || state.page <= before) break;
  }
  if (session?.scroll || session?.scrollAnchor) {
    requestAnimationFrame(() => {
      if (restoreToken === historyRestoreToken) restoreScroll(session.scrollAnchor, session.scroll);
    });
  }
}

// 試験は harness の印を立ててから読む (振る舞いを見るために、走り出す前に掴む)。
// const は vm の外から見えないので、試験が触る必要のある物だけ印の下で渡す
if (globalThis.__BUNKO_HARNESS__) {
  globalThis.__harness = {
    state,
    els,
    renderDetail,
    renderGrid,
    setGalleries: (list) => { state.galleries = list; },
    refreshAfterLink,
    refreshOwnedMarks,
  };
} else {
  boot();
}
