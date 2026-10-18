'use strict';
// 机上版の試写台 (node scripts/renderer-preview.js → http://127.0.0.1:18791/)。
// src/renderer の画面 (index.html / styles.css / app.js / reader.js) をそのまま配り、
// 母屋の口 (preload の window.hitomi) は番号入りの偽の棚で代役する。
//
// **Eagle ライブラリにも網にも一切触らない。** 札の題・作者・タグ・表紙・頁は
// すべてここで作る見本で、実在の作品は一つも映らない。帯・札・詳細・読み手の
// 「見た目」を実データを見ずに確かめるためだけの物 (lan-preview.js の机上版)。
//
// 使い方:
//   ?zoom=list|xs|s|m|l|xl   札の段 (既定 m)
//   ?view=detail|reader|spread|settings|queue   起動後にその画面を開く
//   ?theme=<名>              /__theme/<名>.css を styles.css の後ろに重ねる
//                            (置き場は THEME_DIR。既定 docs/ui-proposals-2026-09-20/themes)
//   ?patch=1                 app.js の後ろに /__patch.js を差す (JS 側の小さな直し案の写し)
//   ?count=<n>               札の枚数 (既定 60)
//   ?source=home             Home (作者の一覧) から始める。作者と本は番号の見本 (表紙を選ぶ板・名前の置き方を見る)
//   ?source=pawchive         Pawchive の作者の見出し (扇) の一覧。網 40 人、所持作品の釦で作者フォルダ 40
//   ?people=<数>             Home の見本の人数 (既定 16。一覧が溢れる時の詳細の寄せと送りを見る)
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// 語彙まわりだけは本物を使う。候補・言い換え・札が「配るのと同じ辞書」で
// 出ているかを画面で確かめるため (網にも Eagle にも触らない)
const aliases = require(path.join(ROOT, 'src', 'lib', 'search-aliases'));
const vocabulary = require(path.join(ROOT, 'src', 'lib', 'search-vocabulary'));
const { searchAuthorContext } = require(path.join(ROOT, 'src', 'lib', 'search-author-context'));
const { portQuery } = require(path.join(ROOT, 'src', 'lib', 'sources', 'query-port'));
const RENDERER = path.join(ROOT, 'src', 'renderer');
const THEME_DIR = process.env.THEME_DIR || path.join(ROOT, 'docs', 'ui-proposals-2026-09-20', 'themes');
const PORT = Number(process.env.PORT) || 18791;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function file(res, p) {
  fs.readFile(p, (err, bytes) => {
    if (err) { send(res, 404, 'text/plain', 'not found'); return; }
    send(res, 200, MIME[path.extname(p)] || 'application/octet-stream', bytes);
  });
}

// 表紙の見本: 色相だけ札ごとに変え、絵の代わりに幾何学の塊を置く。
// 文字は番号だけ (題の顔をした文字を載せると実在の物に見えてしまう)
function coverSvg(n, wide) {
  const hue = (n * 47) % 360;
  const w = wide ? 566 : 400;
  const h = wide ? 400 : 566;
  const bg = `hsl(${hue} 22% 74%)`;
  const mid = `hsl(${hue} 30% 58%)`;
  const ink = `hsl(${hue} 35% 30%)`;
  const shape = n % 3 === 0
    ? `<circle cx="${w * 0.55}" cy="${h * 0.42}" r="${w * 0.26}" fill="${mid}"/>`
    : n % 3 === 1
      ? `<rect x="${w * 0.2}" y="${h * 0.18}" width="${w * 0.6}" height="${h * 0.5}" rx="${w * 0.04}" fill="${mid}"/>`
      : `<polygon points="${w * 0.5},${h * 0.15} ${w * 0.85},${h * 0.68} ${w * 0.15},${h * 0.68}" fill="${mid}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<rect width="${w}" height="${h}" fill="${bg}"/>
${shape}
<rect x="0" y="${h * 0.78}" width="${w}" height="${h * 0.22}" fill="${ink}" opacity=".85"/>
<rect x="${w * 0.08}" y="${h * 0.84}" width="${w * 0.5}" height="${h * 0.035}" rx="4" fill="${bg}" opacity=".9"/>
<rect x="${w * 0.08}" y="${h * 0.905}" width="${w * 0.3}" height="${h * 0.025}" rx="4" fill="${bg}" opacity=".6"/>
<text x="${w - 14}" y="${h - 14}" text-anchor="end" font-family="sans-serif" font-size="${w * 0.06}" fill="${bg}" opacity=".8">${n}</text>
</svg>`;
}

// 頁の見本: 白地に薄い罫と大きな頁番号。送りの向きが目で追えるよう左右に印
function pageSvg(n, i) {
  const w = 1000;
  const h = 1414;
  const hue = (n * 47) % 360;
  const ink = `hsl(${hue} 25% 35%)`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<rect width="${w}" height="${h}" fill="#f4f1ea"/>
<rect x="40" y="40" width="${w - 80}" height="${h - 80}" fill="none" stroke="${ink}" stroke-width="3" opacity=".5"/>
<rect x="90" y="120" width="${w - 180}" height="${h * 0.42}" rx="8" fill="hsl(${hue} 20% 88%)"/>
<rect x="90" y="${h * 0.55}" width="${w * 0.4}" height="${h * 0.3}" rx="8" fill="hsl(${hue} 20% 90%)"/>
<rect x="${w * 0.52}" y="${h * 0.55}" width="${w * 0.39}" height="${h * 0.3}" rx="8" fill="hsl(${hue} 20% 86%)"/>
<text x="${w / 2}" y="${h / 2}" text-anchor="middle" font-family="sans-serif" font-size="220" font-weight="700" fill="${ink}" opacity=".35">${i + 1}</text>
<text x="${w - 70}" y="110" text-anchor="end" font-family="sans-serif" font-size="48" fill="${ink}" opacity=".6">右</text>
<text x="70" y="${h - 70}" font-family="sans-serif" font-size="48" fill="${ink}" opacity=".6">左</text>
</svg>`;
}

// 見本の棚 (偽の window.hitomi)。app.js より前に読み込む
const SHIM = `'use strict';
(() => {
  const params = new URLSearchParams(location.search);
  const COUNT = Math.max(1, Number(params.get('count')) || 60);
  const ZOOM = { list: 0, xs: 1, s: 2, m: 3, l: 4, xl: 5 };
  const zoom = ZOOM[params.get('zoom') || 'm'] ?? 3;
  const view = params.get('view') || '';

  // 題は長さ違いを混ぜる: 一行で収まる物と二行に折り返す物が並んだ時の顔を見る
  const TITLES = [
    '見本 短い題',
    '見本 中くらいの長さの題名 (試写用)',
    '見本 二行に折り返すほど長い題名 — 副題つきで札の高さを使い切る文字列',
    '見本 総集編 上',
    '見本 やや長めの題名 第3巻',
  ];
  const NAMES = ['甲', '乙', '丙', '丁', '戊', '己', '庚'];
  const TYPES = ['doujinshi', 'manga', 'artistcg', 'gamecg', 'imageset'];
  // ?source=pixiv: 札を pixiv の顔 (px:<番号>) にし、読み終わりの継ぎ目 (次の作品 + 関連作品) を見る。
  // 関連は同じ見本の棚から借りる (網には出ない)
  const PIXIV = params.get('source') === 'pixiv';
  const items = [];
  for (let i = 0; i < COUNT; i += 1) {
    const owned = i % 5 === 1;
    const similar = !owned && i % 11 === 4;
    const star = owned ? 3 + (i % 3) : 0;
    const artist = NAMES[i % NAMES.length];
    items.push({
      id: PIXIV ? 'px:' + (2000000 + i) : String(2000000 + i),
      source: PIXIV ? 'pixiv' : 'hitomi',
      ai: PIXIV && i % 2 === 0,
      title: TITLES[i % TITLES.length] + ' ' + (i + 1),
      artists: [{ name: 'sample-' + artist, label: '見本作家 ' + artist, type: 'artist' }],
      groups: [],
      series: [{ name: 'sample-series', label: '見本の原作', type: 'series' }],
      characters: [{ name: 'sample-chara', label: '見本の登場人物', type: 'character' }],
      tags: [
        { name: 'sample one', label: '見本タグ 一', type: 'female' },
        { name: 'sample two', label: '見本タグ 二', type: 'female' },
        { name: 'sample three', label: '見本タグ 三', type: 'male' },
        { name: 'sample four', label: '見本タグ 四', type: 'tag' },
        { name: 'full color', label: 'フルカラー', type: 'tag' },
      ],
      type: TYPES[i % TYPES.length],
      language: { name: 'japanese', localName: '日本語' },
      pageCount: 8 + ((i * 7) % 52),
      publishedDate: '2026-09-0' + (1 + (i % 9)),
      addedDate: '2026-09-1' + (i % 9),
      owned,
      idOwned: owned,
      similarOwned: similar,
      star,
      eagleId: owned ? 'sample-eagle-' + i : '',
      linkedEagleId: owned ? 'sample-eagle-' + i : '',
      url: 'https://example.invalid/' + (2000000 + i),
    });
  }
  // 実在の hitomi タグ名を持つ一枚。札は付けずに出し、__labels (本物の辞書) に
  // 埋めさせる。母屋の catalog.withTagLabels と同じ辞書・同じ札の選び方になる
  const REAL = {
    id: '2099999', source: 'hitomi', title: '見本 — 実在のタグ名で札を検める',
    artists: [{ name: 'michiking', type: 'artist' }], groups: [],
    series: [{ name: 'detective conan', type: 'series' }, { name: 'my hero academia', type: 'series' }],
    characters: [{ name: 'azusa shirasu', type: 'character' }, { name: 'keiko ayano', type: 'character' }],
    tags: [{ name: 'futanari', type: 'female' }, { name: 'glasses', type: 'female' }],
    type: 'doujinshi', language: { name: 'japanese', localName: '日本語' },
    pageCount: 24, publishedDate: '2026-09-01', addedDate: '2026-09-21',
    owned: false, idOwned: false, similarOwned: false, star: 0, eagleId: '', linkedEagleId: '',
    url: 'https://example.invalid/2099999',
  };
  items.unshift(REAL);
  const byId = new Map(items.map((g) => [g.id, g]));
  fetch('/__labels', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(REAL) })
    .then((r) => r.json()).then((filled) => { Object.assign(REAL, filled); }).catch(() => {});

  let settings = {
    downloadDir: 'C:/見本/取り込み',
    eagleLibrary: 'D:/見本/eagle.library',
    pawBulkDir: 'C:/見本/pawchive',
    concurrency: 4,
    maxGalleries: 8,
    zoom,
    source: params.get('source') === 'home' ? 'home' : params.get('source') === 'pawchive' ? 'pawchive' : PIXIV ? 'pixiv' : 'hitomi',
    language: '',
    readerRtl: true,
    readerFit: 'contain',
    readerSpread: view === 'spread',
    readerResume: true,
    // ?nextcard=1 で継ぎ目の札を挟む (pixiv の見本は関連作品を見るのが目的なので既定で挟む)
    readerNextCard: PIXIV || params.get('nextcard') === '1',
    pixivLoggedIn: PIXIV,
    loupe: true,
    autoSync: true,
    showUnmatched: false,
    favoriteMinStars: 4,
    saveFormat: 'pdf',
    searchHistory: [
      { query: '見本の語', source: 'hitomi', scope: 'all' },
      { query: '見本 二つ目', source: 'hitomi', scope: 'library' },
    ],
    searchPins: [],
    sortBySource: {},
    session: null,
  };

  const later = (value) => new Promise((resolve) => setTimeout(() => resolve(value), 40));

  // ---- Home の見本 (作者の一覧・詳細・作者頁) ----
  // 作者は番号の名前、本は見本の札 (表紙は /img?id=<番号> の見本の絵)。作者フォルダの人の自動の顔は /pwlibf/ の見本
  const HOME_NAMES = ['見本作家 一', '見本サークル 二', '見本作家 とても長い名前のサークル (見本) 第三', '見本作家 四', '見本 五'];
  const homePeople = [];
  // ?people=<数>: 見本の人数 (既定 16)。一覧が溢れる時の詳細の寄せと送りを確かめる
  const PEOPLE = Math.max(1, Math.min(700, Number(params.get('people')) || 16));
  for (let p = 0; p < PEOPLE; p += 1) {
    const kind = p % 3 === 1 ? 'hitomi' : 'folder';
    const books = [];
    const count = 4 + ((p * 7) % 23);
    for (let b = 0; b < count; b += 1) {
      const n = 3000 + p * 50 + b;
      const date = (2025 - Math.floor(b / 4)) + '-' + String(12 - (b % 4) * 3).padStart(2, '0') + '-01';
      // Eagle の★ (★の高い本の節) と最後に読んだ時 (0 = 読んだ記録なし)
      const star = b % 6 === 0 ? 5 : (b % 4 === 1 ? 4 : b % 3);
      const gallery = Object.assign({}, items[1 + (b % 5)], {
        id: String(n), title: '見本の本 ' + (p + 1) + '-' + (b + 1), owned: true, idOwned: true, similarOwned: false, dupeHidden: false, publishedDate: date, star,
      });
      books.push({ id: String(n), origin: 'hitomi', candidate: b === 2, date, readAt: b % 3 === 0 ? 0 : Date.now() - (b * 3 + p) * 864e5, gallery });
    }
    // 四人に一人は発見の新作 (網の hitomi の作品のうち、新しい三冊)
    const newCount = p % 4 === 0 ? 3 : 0;
    homePeople.push({
      id: kind === 'folder' ? 'home:f:SAMPLE' + p : 'home:h:sample-' + p, kind, key: 'SAMPLE' + p,
      name: (HOME_NAMES[p % HOME_NAMES.length]) + (p >= HOME_NAMES.length ? ' ' + (p + 1) : ''), books, rating: p % 5,
      authorLine: p % 5 === 1 ? '見本作家 甲・見本作家 乙' : '', newCount,
    });
  }
  // 網の作品 (未所持)。発見の新作の人だけ、今年の新しい物を五冊 (そのうち三冊が新作)
  function homeWeb(person) {
    if (!person.newCount) return [];
    const p = homePeople.indexOf(person);
    return [0, 1, 2, 3, 4].map((k) => {
      const id = String(9000 + p * 10 + k);
      const date = '2026-0' + (9 - k) + '-1' + k;
      return {
        id, origin: 'hitomi', date,
        gallery: Object.assign({}, items[1 + (k % 5)], { id, title: '見本の網の本 ' + (p + 1) + '-' + (k + 1), owned: false, idOwned: false, publishedDate: date }),
      };
    });
  }
  const homeCovers = {};
  const homeById = (id) => homePeople.find((person) => person.id === String(id)) || null;
  function homeCard(person) {
    const confirmed = person.books.filter((book) => !book.candidate);
    const auto = person.kind === 'folder' ? 'pwlibf:' + person.key : confirmed[0].id;
    const chosen = confirmed.some((book) => book.id === homeCovers[person.id]) ? homeCovers[person.id] : '';
    return {
      id: person.id, source: 'home', kind: 'creator', title: person.name,
      artists: [], groups: [], series: [], characters: [], tags: [], pageCount: 0, badge: '', owned: false, url: '',
      home: {
        kind: person.kind, name: person.name, folderName: person.name, authorLine: person.authorLine || '',
        cover: chosen || auto, coverAuto: auto, coverChosen: Boolean(chosen),
        count: confirmed.length, newCount: person.newCount || 0, sites: ['hitomi'], unsure: false, rating: person.rating, renamed: false,
        // 扇の後ろの二枚: 顔の次に新しい確かな所持の本 (作者フォルダの自動の顔は一番新しい本なので飛ばす)
        stack: confirmed.filter((book, index) => book.id !== (chosen || auto) && !(person.kind === 'folder' && !chosen && index === 0)).slice(0, 2).map((book) => book.id),
        localCount: 0, localOrigin: '', circles: [],
        authors: [{ label: person.name, artist: '', candidate: false, self: true, query: '' }],
        links: { pixiv: [], pawchive: [], hitomi: [{ url: 'https://example.invalid/artist/sample-all.html', state: 'linked', fixed: true, suggested: false, note: '' }], nhentai: [] },
        linkable: { pixiv: true, pawchive: true, hitomi: true, nhentai: true }, rateable: true, coverable: true,
        recent: person.books.slice(0, 8).map((book) => ({ id: book.id, title: book.gallery.title, date: book.date, origin: book.origin, pages: 20, candidate: book.candidate })),
      },
    };
  }
  // 作品の検索の見本 (母屋の home-authors の読み方をごく小さく真似る): 空白で区切った語が全部、本の題か作者の名に含まれる本
  // (この台本は文字列の中に書いた JS を配るので、逆斜線を使わずに空白を割る)
  const homeWords = (text) => String(text || '').trim().split(/[ 　]+/).filter(Boolean);
  function homeMatch(person, words) {
    const byName = words.every((word) => person.name.includes(word));
    const books = byName ? person.books : person.books.filter((book) => words.every((word) => person.name.includes(word) || book.gallery.title.includes(word)));
    return { books, count: books.filter((book) => !book.candidate).length, byName };
  }
  // '@名前 語': 名前は長い方から切って人を決める
  function homeSplit(query) {
    const rest = String(query || '').trim().slice(1).trim();
    const cuts = [rest.length];
    const gap = (ch) => ch === ' ' || ch === '　';
    for (let i = rest.length - 1; i >= 0; i -= 1) if (gap(rest[i]) && !gap(rest[i - 1] || '')) cuts.push(i);
    for (const cut of cuts) {
      const person = homePeople.find((row) => row.name === rest.slice(0, cut).trim());
      if (person) return { person, words: rest.slice(cut).trim() };
    }
    return { person: null, words: '' };
  }
  const homeAuthor = (person, words = '') => {
    const list = homeWords(words);
    const match = list.length ? homeMatch(person, list) : null;
    return {
      author: homeCard(person), books: person.books, handles: person.newCount ? 1 : 0,
      newIds: homeWeb(person).slice(0, person.newCount).map((work) => work.id),
      filter: match ? { words: String(words).trim(), hits: match.books.map((book) => book.id), count: match.count, interpreted: [] } : null,
    };
  };
  function homeCall(payload) {
    const action = String(payload && payload.action || '');
    const split = payload.id ? null : homeSplit(payload.query);
    const person = payload.id ? homeById(payload.id) : split.person;
    if (action === 'author') return person ? homeAuthor(person, split ? split.words : '') : { author: null, books: [], handles: 0 };
    if (action === 'web') return { works: person && payload.site === 'hitomi' ? homeWeb(person) : [], more: false, error: false };
    if (action === 'webHits') {
      const words = homeWords(payload.words);
      const works = person && payload.site === 'hitomi' ? homeWeb(person) : [];
      return { words: payload.words, hits: works.filter((work) => words.every((word) => person.name.includes(word) || work.gallery.title.includes(word))).map((work) => work.id) };
    }
    if (action === 'pages') return { counts: {} };
    if (!person) return { ok: false, reason: 'author' };
    if (action === 'cover') {
      const value = String(payload.cover || '');
      if (value && !person.books.some((book) => !book.candidate && book.id === value)) return { ok: false, reason: 'cover' };
      const before = homeCovers[person.id] || '';
      if (value) homeCovers[person.id] = value;
      else delete homeCovers[person.id];
      return { ok: true, undo: before === value ? [] : [{ k: 'cover', personId: person.id, id: before }], author: homeCard(person) };
    }
    if (action === 'undo') {
      const redo = [];
      for (const step of payload.steps || []) {
        if (step.k !== 'cover') continue;
        redo.unshift({ k: 'cover', personId: step.personId, id: homeCovers[step.personId] || '' });
        if (step.id) homeCovers[step.personId] = step.id;
        else delete homeCovers[step.personId];
      }
      return redo.length ? { ok: true, redo, author: homeCard(person) } : { ok: false, reason: 'missing' };
    }
    if (action === 'rate') {
      const before = person.rating;
      person.rating = Number(payload.star) || 0;
      return { ok: true, undo: [], author: homeCard(person), before };
    }
    return { ok: false, reason: 'action' };
  }

  const base = {
    // 入力の切り出しは本物を使う (preload と同じ search-intent)
    completionRanges: (input) => window.BunkoSearchIntent.completionRanges(input),
    // preload の portQuery は同期。試写台でも同期で返さないと画面が undefined を掴む
    portQuery: (query, from, to, context) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/__port', false);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(JSON.stringify({ query, from, to, context: context || {} }));
      try { return JSON.parse(xhr.responseText); } catch { return { query, dropped: [] }; }
    },
    searchAuthorContext: (payload) => fetch('/__context', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload) }).then((r) => r.json()),
    imageBase: () => later(location.origin),
    settings: () => later(settings),
    saveSettings: (partial) => { settings = Object.assign({}, settings, partial || {}); return later(settings); },
    search: (payload) => {
      const page = Number(payload.page) || 0;
      const size = Number(payload.pageSize) || 24;
      const span = Math.max(1, Number(payload.spanPages) || 1);
      const q = String(payload.query || '').trim();
      if (payload.source === 'home') {
        if (q.startsWith('@')) {
          const { person, words } = homeSplit(q);
          return later({ requestId: payload.requestId, galleries: [], total: person ? person.books.length : 0, hasNext: false, spanPages: span, query: payload.query, homeAuthor: person ? homeAuthor(person, words) : null });
        }
        // 語があれば作品の検索 (当たった本のある人に、当たった冊数と扇の後ろの当たった本)
        const words = homeWords(q);
        const list = homePeople.map((row) => {
          if (!words.length) return homeCard(row);
          const match = homeMatch(row, words);
          if (!match.count) return null;
          const card = homeCard(row);
          card.home.matched = match.count;
          card.home.matchedByName = match.byName;
          card.home.stack = match.books.filter((book) => !book.candidate && book.id !== card.home.cover).slice(0, 2).map((book) => book.id);
          return card;
        }).filter(Boolean);
        // 一覧の頭: 一頁目の、語の無い時だけ。最近の動き (本物は直近 2 週間に入れた人。見本は 24 人で帯を溢れさせる)
        const overview = page === 0 && !q ? {
          moving: homePeople.slice().reverse().slice(0, 24).map(homeCard),
        } : null;
        return later({ requestId: payload.requestId, galleries: list.slice(page * size, (page + span) * size), total: list.length, hasNext: (page + span) * size < list.length, spanPages: span, query: payload.query, overview });
      }
      // ?source=pawchive: 語が無ければ作者の見出し (網 = pw:<service>:<番号>:profile、所持 = 作者フォルダ pwlibf:<番号>)。
      // 扇の後ろの二枚が一本・二本しか無い作者も混ぜる (網は i=1・2 の絵、所持は fan の数)
      const pawCreators = payload.source === 'pawchive' && !q ? Array.from({ length: 40 }, (_, i) => payload.scope === 'library'
        ? { id: 'pwlibf:' + (100 + i), source: 'pawchive', kind: 'creator', title: '見本の作者フォルダ ' + (i + 1), type: '', badge: (3 + i) + '件', owned: true,
          fan: Array.from({ length: i % 4 === 3 ? 1 : 2 }, (__, k) => 'pweagle:' + (3000 + i * 3 + k)), artists: [], tags: [] }
        : { id: 'pw:' + ['fanbox', 'patreon', 'fantia'][i % 3] + ':' + (5000 + i) + ':profile', source: 'pawchive', kind: 'creator', title: '見本の作者 ' + (i + 1),
          type: ['fanbox', 'patreon', 'fantia'][i % 3], badge: '2026/9/' + (1 + (i % 27)), artists: [], tags: [] }) : null;
      const pool = pawCreators || (payload.scope === 'library' ? items.filter((g) => g.owned) : items);
      const hit = q ? pool.filter((g) => g.title.includes(q)) : pool;
      const slice = hit.slice(page * size, (page + span) * size);
      return later({
        requestId: payload.requestId,
        galleries: slice,
        total: hit.length,
        hasNext: (page + span) * size < hit.length,
        spanPages: span,
        query: payload.query,
      });
    },
    cancelSearch: () => later(null),
    gallery: (id) => later(byId.get(String(id)) || (homeById(id) ? homeCard(homeById(id)) : null)),
    home: (payload) => later(homeCall(payload || {})),
    suggest: (term, source) => fetch('/__suggest?term=' + encodeURIComponent(term || '') + '&source=' + encodeURIComponent(source || 'hitomi')).then((r) => r.json()),
    annotate: (list) => later(list),
    downloads: () => later([]),
    catalog: () => later({ scanning: false }),
    libraryStatus: () => later({ owned: 2061, withMeta: 2061, backfill: null, flags: {}, fallbacks: 0 }),
    pawBulk: () => later({ running: false }),
    pawFavorites: () => later({ items: [] }),
    lanShare: () => later({ running: false }),
    pixiv: (payload) => {
      const action = payload && payload.action;
      // 生成情報 (issue #3): 見本の字だけ。偶数の頁は NovelAI の見本、奇数は「情報なし」。3 の倍数の札は印 (yes)
      if (action === 'ai-meta') {
        const index = Number(payload.index) || 0;
        if (index % 2 === 1) return later({ status: 'none', source: 'aitag' });
        return later({ status: 'ok', source: payload.source === 'original' ? 'original' : 'aitag', meta: {
          format: 'NovelAI', foundIn: 'stealth_pngcomp',
          positive: '1girl, solo, {{masterpiece}}, best quality, 1.3::long hair::, blue eyes, school uniform, -1::text::, [blurry background], looking at viewer, (detailed eyes:1.2), soft lighting, outdoors, cherry blossoms, wind',
          negative: 'lowres, bad anatomy, bad hands, {{worst quality}}, text, error, missing fingers, extra digit, fewer digits, cropped, jpeg artifacts, signature, watermark, username, 1.2::blurry::',
          characters: ['girl, red hair, smile, ribbon', 'boy, black hair, {glasses}, serious'], characterNegatives: ['', 'extra arms'],
          settings: { model: 'NovelAI Diffusion V5 (見本)', seed: 3941043950 + index, steps: 24, scale: 4, cfgRescale: 0.1, sampler: 'k_euler_ancestral', noiseSchedule: 'karras', width: 1024, height: 1024, smea: false, smeaDyn: false, requestType: 'PromptGenerateRequest' },
          extra: {}, workflowTexts: [], note: '',
        } });
      }
      if (action === 'ai-marks') {
        const marks = {};
        for (const row of payload.ids || []) { const id = typeof row === 'string' ? row : row.id; marks[id] = Number(String(id).replace(/[^0-9]/g, '')) % 3 === 2 ? 'yes' : 'no'; }
        return later({ marks });
      }
      // 関連作品: 見本の棚から 12 枚 (自分は外す)。頁の無い物 (うごイラ) も一枚混ぜて、並ばないことを見る
      if (action === 'related') {
        const from = items.findIndex((g) => g.id === String(payload.id));
        const pool = items.filter((g) => g.id !== String(payload.id));
        const n = Math.max(1, Math.min(150, Number(payload.limit) || 12));
        const rows = pool.slice(Math.max(0, from + 7), Math.max(0, from + 7) + n);
        return later(rows.length >= n ? rows : pool.slice(0, n));
      }
      return later({ loggedIn: PIXIV });
    },
    discovery: () => later({ sections: [] }),
    seriesGaps: () => later([]),
    readingGet: () => later(null),
    readingSet: () => later(null),
    readerActive: () => later(null),
    toggleFullscreen: () => later(null),
    noteFallback: () => {},
    openExternal: () => later(null),
    openEagle: () => later(null),
    setEagleStar: (id, star) => later({ ok: true, star }),
  };
  // 名指ししていない口は「何も返さない約束」で埋める。on* は購読なので解除の関数を返す
  window.hitomi = new Proxy(base, {
    get(target, key) {
      if (key in target) return target[key];
      if (typeof key === 'string' && key.startsWith('on')) return () => () => {};
      return () => later(null);
    },
  });

  // 起動後に画面を開く (試写の都合。本体の作法ではない)
  function whenCards(fn, tries = 0) {
    const card = document.querySelector('.card[data-id]');
    if (card) { fn(); return; }
    if (tries > 100) return;
    setTimeout(() => whenCards(fn, tries + 1), 50);
  }
  window.addEventListener('load', () => {
    if (!view) return;
    whenCards(() => {
      const card = document.querySelectorAll('.card[data-id]')[2];
      if (view === 'detail') { card && card.click(); return; }
      if (view === 'reader' || view === 'spread') {
        card && card.click();
        setTimeout(() => document.querySelector('.detail-actions [data-read]')?.click(), 250);
        return;
      }
      if (view === 'settings') { document.getElementById('btn-settings')?.click(); return; }
      if (view === 'queue') { document.getElementById('btn-queue')?.click(); }
    });
  });
})();
`;

// 提案 (JS 側の小さな直し) の写し: タグの "type:語" を <span class="tag-ns">type</span>語 に分ける。
// 本体の tagButtons と同じ判じで、顔だけ変える。tagButtons は app.js の頂上の function 宣言
// (= window の束縛) なので、app.js の後ろで差し替えれば renderDetail はこちらを呼ぶ。?patch=1 の時だけ
const PATCH = `'use strict';
(() => {
  const prior = window.tagButtons;
  if (typeof prior !== 'function') return;
  window.tagButtons = function patchedTagButtons(tags, owner) {
    const box = document.createElement('div');
    box.innerHTML = prior(tags, owner);
    box.querySelectorAll('button.tag').forEach((b) => {
      const text = b.textContent;
      const at = text.indexOf(':');
      if (at <= 0) return;
      const ns = text.slice(0, at);
      const word = text.slice(at + 1);
      b.textContent = '';
      const span = document.createElement('span');
      span.className = 'tag-ns';
      span.textContent = ns;
      b.append(span, document.createTextNode(word));
    });
    return box.innerHTML;
  };
})();
`;

function indexHtml(theme, patch) {
  let html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
  // 語の切り出し・構文・サイトの定義は本物を読ませる (preload と同じ物)
  html = html.replace('<script src="reader.js"></script>', [
    '<script src="/__lib/search-type.js"></script>',
    '<script src="/__lib/search-providers.js"></script>',
    '<script src="/__lib/search-intent.js"></script>',
    '<script src="/__shim.js"></script>',
    '<script src="reader.js"></script>',
  ].join('\n  '));
  if (patch) {
    html = html.replace('<script src="app.js"></script>', '<script src="app.js"></script>\n  <script src="/__patch.js"></script>');
  }
  if (theme) {
    html = html.replace('<link rel="stylesheet" href="styles.css" />',
      `<link rel="stylesheet" href="styles.css" />\n  <link rel="stylesheet" href="/__theme/${encodeURIComponent(theme)}.css" />`);
  }
  return html;
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (p === '/' || p === '/index.html') {
    const theme = String(url.searchParams.get('theme') || '').replace(/[^\w-]/g, '');
    send(res, 200, MIME['.html'], indexHtml(theme, url.searchParams.get('patch') === '1'));
    return;
  }
  if (p === '/__shim.js') { send(res, 200, MIME['.js'], SHIM); return; }
  // ---- 本物の辞書の口 (網にも Eagle にも触らない) ----
  const json = (value) => send(res, 200, 'application/json; charset=utf-8', JSON.stringify(value));
  const body = () => new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
  if (p === '/__suggest') {
    const term = String(url.searchParams.get('term') || '');
    const from = String(url.searchParams.get('source') || 'hitomi');
    // 母屋と同じ道 (sources.suggestTags) を通す。飾りも値もサイトごとに本物
    const { fromDictionary } = require(path.join(ROOT, 'src', 'lib', 'search-decorate'));
    const { normalizeSuggestions } = require(path.join(ROOT, 'src', 'lib', 'search-intent'));
    if (from === 'home') {
      // Home の候補の見本: 辞書の hitomi の語に所持の冊数の見本を付け、Eagle のタグの見本を一つ混ぜる (母屋は所持の本のタグから出す)
      const owned = (value) => [...String(value)].reduce((n, ch) => n + ch.charCodeAt(0), 0) % 40 + 1;
      const rows = (aliases.canSuggestTerm(term) ? fromDictionary(term, 'hitomi', 7) : []).map((row) => ({
        ...row, metric: { site: 'home', kind: 'works', value: owned(row.value), scope: 'owned' },
      }));
      if (term) rows.push({ type: 'tag', name: `${term}の見本`, label: `${term}の見本`, value: `${term}の見本`, secondary: 'Eagle', metric: { site: 'home', kind: 'works', value: 2, scope: 'owned' } });
      json(normalizeSuggestions(rows.sort((a, b) => b.metric.value - a.metric.value), 'home'));
      return;
    }
    const rows = aliases.canSuggestTerm(term) ? fromDictionary(term, from, 8) : [];
    json(normalizeSuggestions(rows, from));
    return;
  }
  if (p === '/__labels') {
    body().then((gallery) => {
      const fill = (list) => (list || []).map((tag) => {
        const described = aliases.describeTerm(`${tag.type}:${String(tag.name).replace(/ /g, '_')}`);
        return described && described.label ? { ...tag, label: described.label } : tag;
      });
      json({ artists: fill(gallery.artists), groups: fill(gallery.groups), series: fill(gallery.series),
        characters: fill(gallery.characters), tags: fill(gallery.tags) });
    });
    return;
  }
  if (p === '/__port') {
    body().then((payload) => json(portQuery(payload.query, payload.from, payload.to, payload.context || {})));
    return;
  }
  if (p === '/__context') {
    body().then((payload) => json(searchAuthorContext(String(payload.query || ''), payload.from, {
      pixiv: {}, pawchive: {}, label: () => '',
      describe: aliases.describeTerm, creatorName: () => '',
      intent: payload.intent, selections: payload.selections, target: payload.to,
      resolve: vocabulary.resolve,
    })));
    return;
  }
  if (p === '/__patch.js') { send(res, 200, MIME['.js'], PATCH); return; }
  let m = p.match(/^\/__lib\/([\w-]+)\.js$/);
  if (m) { file(res, path.join(ROOT, 'src', 'lib', m[1] + '.js')); return; }
  m = p.match(/^\/__theme\/([\w-]+)\.css$/);
  if (m) { file(res, path.join(THEME_DIR, m[1] + '.css')); return; }
  // 提案の一式 (README・写真・意匠帳の写し) も同じ口から見られるようにする: /__docs/shots/a-shelf.png など
  m = p.match(/^\/__docs\/([\w./-]+)$/);
  if (m && !m[1].includes('..')) { file(res, path.join(path.dirname(THEME_DIR), m[1])); return; }
  if (p === '/img') {
    const n = Number(String(url.searchParams.get('id') || '').replace(/\D/g, '')) || 0;
    const i = Number(url.searchParams.get('i')) || 0;
    const size = url.searchParams.get('size') || 'small';
    // Pawchive の網の作者: 絵のある投稿が二本しか無い作者 (番号が 4 で割って 3 余る) は三枚目が無い
    if (/:profile$/.test(url.searchParams.get('id') || '') && i === 2 && n % 4 === 3) { res.writeHead(404); res.end(); return; }
    const body = (i === 0 && size !== 'full') ? coverSvg(n, false) : pageSvg(n, i);
    send(res, 200, MIME['.svg'], body);
    return;
  }
  m = p.match(/^\/pweagle\/(.+)$/);
  if (m) { send(res, 200, MIME['.svg'], coverSvg(Number(m[1].replace(/\D/g, '')) || 1, false)); return; }
  // Home の作者フォルダの札 (自動の顔)。見本の作者の番号から一枚。横長も混ぜる (顔の高さが変わる時の見え方を見る)
  m = p.match(/^\/pwlibf\/(.+)$/);
  if (m) {
    const n = Number(m[1].replace(/\D/g, '')) || 0;
    send(res, 200, MIME['.svg'], coverSvg(900 + n, n % 4 === 3));
    return;
  }
  // 同梱のサイトのアイコン (Home の詳細の行・見出しの帯)
  m = p.match(/^\/icons\/sites\/([\w-]+\.(?:png|ico))$/);
  if (m) { file(res, path.join(RENDERER, 'icons', 'sites', m[1])); return; }
  if (p === '/node_modules/pdfjs-dist/build/pdf.min.js') {
    file(res, path.join(ROOT, 'node_modules', 'pdfjs-dist', 'build', 'pdf.min.js'));
    return;
  }
  m = p.match(/^\/fonts\/([\w-]+\.woff2)$/);
  if (m) { file(res, path.join(RENDERER, 'fonts', m[1])); return; }
  m = p.match(/^\/([\w-]+\.(?:css|js))$/);
  if (m) { file(res, path.join(RENDERER, m[1])); return; }
  send(res, 404, 'text/plain', 'not found');
}).listen(PORT, '127.0.0.1', () => {
  console.log('renderer preview at http://127.0.0.1:' + PORT + '/  (theme dir: ' + THEME_DIR + ')');
});
