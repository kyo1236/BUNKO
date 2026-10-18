/* 文匣 手のひら版 — 棚 / 検索 / 胴 / 一冊の紙
 *
 * 骨組み (reader.html) が渡してくるのは #shelf / #drum / #sheet の三つの空箱だけ。
 * 中身はここで組む。意匠と DOM の形はモック (mock-src.html) から移した。
 * 読む画面は read.js の担当なので、ここは BUNKO.reader.open() を呼ぶところで手を離す。
 */
(function () {
  'use strict';

  window.BUNKO = window.BUNKO || {};

  var RECENT_MAX = 4;      // 帯は棚への入り口。並べ過ぎると棚が始まらない
  var FRESH_MS = 24 * 60 * 60 * 1000; // 角は一日で伸びる。ずっと折れていると目印にならない
  var ROW = 44;            // 胴の一段
  var SETTLE_MS = 140;     // 回すのを止めてから決めるまで
  var DEBOUNCE_MS = 300;   // 打っている最中に棚を組み直さない
  var SUGGEST_MS = 250;    // 候補は棚より軽い。組み直しより一足先に出して、指を降ろさせる
  var DWELL_MS = 300;      // 紙に居た時間。これを越えたら母艦に焼き始めさせる
  var SHEET_MS = 420;      // 紙が沈み切るまで (--t-sheet と同じ間)
  var HOLD_MS = 450;       // 帯を押さえ続けて紙が出るまで (一突きは再開に譲った)
  var HOLD_SLOP = 10;      // これだけ動いたら帯を送っている指。長押しの計時をやめる
  var PULL_DAMP = 0.5;     // 引いた分の半分だけ糸が伸びる。指より遅れて来る方が静か
  var PULL_MAX = 70;       // 糸が伸び切る所。ここまで伸ばして離したら引き直す
  var PULL_WAIT = 8000;    // 母艦が黙り込んだ時に糸を消す退き際
  var CLOSE_TRIP = 100;    // 紙と胴を下に払って閉じる境
  var DRAG_SLOP = 10;      // 釦の上の指が「押下」から「引き」に変わる距離
  var SRC_SWAP_MS = 80;    // 台帳の小文字が退くまで (--t-fast の半分。出て入るので一段は短く)
  var NAV_SLOP = 8;        // 浮きの釦が退き/現れを決める送り幅 (Safari の帯と同じ程度)

  // 頁の幅は read.js と同じ式で、**同じ時点 (初回に要る時)** に決める。
  // 以前はここだけ読み込み時に確定していたので、読み込みと最初の要求の間に
  // 画面の向きが変わると、棚が温める一枚と読み手が頼む一枚の URL が食い違い、
  // 母艦が同じ頁を二度焼いていた (項目 8-3)。一度決めたら動かさないのは同じ:
  // 途中で変えると本一冊ぶんの焼き直しになる
  var WIDTH = 0;
  function widthOnce() {
    if (!WIDTH) {
      var box = Math.min(window.innerWidth, window.innerHeight * 0.72);
      WIDTH = Math.round(box * Math.min(window.devicePixelRatio || 1, 2));
    }
    return WIDTH;
  }

  // 契約書の札。モックの並びとは少し違う (画像集がある / ★は「評価」)
  var TYPES = [
    { id: '', label: 'すべて' },
    { id: 'doujinshi', label: '同人誌' },
    { id: 'manga', label: '漫画' },
    { id: 'artistcg', label: 'Artist CG' },
    { id: 'gamecg', label: 'Game CG' },
    { id: 'imageset', label: '画像集' }
  ];
  var SORTS = [
    { id: 'added', label: '追加日' },
    { id: 'published', label: '公開日' },
    { id: 'title', label: '題名' },
    { id: 'star', label: '評価' },
    { id: 'random', label: 'ランダム' },
    // 再読の棚。専用の枠は作らず、並びの一つとして出す (栞が持ち主)
    { id: 'reread', label: '読了回数' },
    { id: 'finished', label: '最終読了日' }
  ];

  // 作者の棚 (paw で語が無い画面) に出す並び。作者は作品ではないので、
  // 公開日・評価・読了回数・最終読了日 は意味を持たない。母艦もこの四つには
  // 分岐を持たず既定へ落とすので (lan-server.servePawFolders)、選択肢に出すと
  // 「釦は真鍮に灯り、棚は組み直り、一字も並びが変わらない」という嘘になる
  var FOLDER_SORTS = ['added', 'title', 'random'];

  // 覚えていた値がいまの選択肢に無ければ倒す。消えた id を握ったままだと、
  // 種別なら空の棚が返り、並びなら釦だけが灯って並びは既定になる
  function inList(list, value, fallback) {
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].id === value) return value;
    }
    return fallback;
  }

  // ── 印 (欄の名を書かずに、何の欄かを言うもの) ─────────────────

  var ICON = {
    by: '<path d="M8 8.2a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2 14.5c0-2.5 2.7-4 6-4s6 1.5 6 4"/>',
    group: '<circle cx="6" cy="6.4" r="2.4"/><circle cx="11" cy="8" r="1.9"/><path d="M1.5 14c0-2.2 2-3.5 4.5-3.5s4.5 1.3 4.5 3.5M11 10.4c2 .2 3.5 1.4 3.5 3.1"/>',
    series: '<path d="M8 4.2C6.8 3.3 5 3 2.5 3.2v9.2c2.5-.2 4.3.1 5.5 1 1.2-.9 3-1.2 5.5-1V3.2C11 3 9.2 3.3 8 4.2z"/><path d="M8 4.2v9"/>',
    chara: '<circle cx="8" cy="8" r="6"/><path d="M5.8 6.6h.01M10.2 6.6h.01" stroke-linecap="round" stroke-width="1.8"/><path d="M5.6 10.2c1.4 1.2 3.4 1.2 4.8 0"/>',
    type: '<rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/>',
    sort: '<path d="M2.5 4h11M2.5 8h7M2.5 12h4" stroke-linecap="round"/>',
    down: '<path d="M8 3v10M4 9.2l4 3.8 4-3.8" stroke-linecap="round"/>',
    up: '<path d="M8 13V3M4 6.8l4-3.8 4 3.8" stroke-linecap="round"/>'
  };

  function icon(name, size) {
    var s = size || 16;
    return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 16 16" fill="none" '
      + 'stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true">'
      + ICON[name] + '</svg>';
  }

  function star(on) {
    return '<svg class="' + (on ? '' : 'off') + '" width="14" height="14" viewBox="0 0 16 16" '
      + 'fill="' + (on ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="1.2" '
      + 'stroke-linejoin="round" aria-hidden="true">'
      + '<path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z"/></svg>';
  }

  // 机上版の帯の左肩と同じ紋章。枠は絵の丈に切ってあり、題字と肩が揃う
  var BRAND_SVG = '<svg viewBox="13 15 74 70" role="img" aria-label="文匣"><g fill="currentColor">'
    + '<rect x="14" y="16" width="72" height="6"/>'
    + '<rect x="14" y="16" width="6" height="68"/>'
    + '<rect x="14" y="78" width="72" height="6"/>'
    + '<rect x="30" y="38" width="10" height="40" transform="rotate(-14 40 78)"/>'
    + '<rect x="44" y="43" width="10" height="35"/>'
    + '<rect x="57" y="37" width="10" height="41"/>'
    + '<rect x="70" y="44" width="9" height="34"/>'
    + '<rect x="38" y="34.5" width="26" height="8" transform="rotate(-24 38 42.5)"/>'
    + '</g></svg>';

  // ── 状態 ──────────────────────────────────────────────────────

  var state = {
    q: '',
    // どちらの台帳を見ているか。母艦は src 無しを従来 (hitomi) と読むので、
    // 覚えていた値が壊れていても hitomi に倒しておけば棚は必ず組める
    src: read('bunko.src', 'hitomi') === 'paw' ? 'paw' : 'hitomi',
    type: inList(TYPES, read('bunko.type', ''), ''),
    sort: inList(SORTS, read('bunko.sort', 'added'), 'added'),
    // 並びの向き。desc が既定 (机上版と同じ)。random のときは意味を持たない
    dir: read('bunko.dir', 'desc') === 'asc' ? 'asc' : 'desc',
    // ★4 以上だけを見る絞り
    star4: read('bunko.star4', '') === '1',
    // random の種。同じ種なら頁をまたいでも並びが揺れない。混ぜ直しは種の取り直し
    seed: (Math.floor(Math.random() * 2147483647) || 1),
    page: 0,
    hasMore: true,
    loading: false,
    fills: 0,        // 画面が埋まるまでの自動追い足しの回数 (暴走止め)
    reading: {}      // id → { page, pageCount, updatedAt, finished }
  };
  var seen = Object.create(null); // id → item。一度見た本は覚えておく (帯を組み直すのに要る)
  var sheetItem = null;           // 今 紙に載っている一冊
  var wantedId = null;            // 温めてよい相手 (紙に載っているか、読み始めた本)
  var warmHold = null;            // 温めた頁。捨てられないように掴んでおく

  function read(key, fallback) {
    try {
      var v = localStorage.getItem(key);
      return v === null ? fallback : v;
    } catch (e) { return fallback; }
  }
  function write(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* 覚えられなくても棚は引ける */ }
  }

  function api(path, options) {
    if (window.BUNKO.host) return window.BUNKO.host.api(path, options);
    return fetch(path, Object.assign({ credentials: 'same-origin' }, options || {}))
      .then(function (res) {
        if (!res.ok) throw new Error(String(res.status));
        return res.json();
      });
  }

  // ── 棚の骨 ────────────────────────────────────────────────────

  var shelf = document.getElementById('shelf');
  var drum = document.getElementById('drum');
  var sheet = document.getElementById('sheet');

  // モックでは .screen が状態を持っていた。実装に額縁は無いので body が持つ
  var host = document.body;

  shelf.classList.add('view');
  drum.classList.add('filters');
  sheet.classList.add('sheet');

  shelf.innerHTML =
    '<div class="shelfHead">'
    + '<div class="shelfTop">'
    // 紋章は台帳の切り替え釦を兼ねる。棚の頭に釦を増やすより、既に「ここは文匣だ」と
    // 言っている札に「どの匣か」を言わせる方が、頭の並びが増えない。
    // 小文字 (BUNKŌ) の席を台帳の名に譲る — 綴りは今どちらを見ているかの唯一の表示
    + '<button class="brand" id="btnSrc" type="button" '
    + 'aria-label="台帳を切り替える (今は ' + srcLabel() + ')">'
    + '<span class="brandMark">' + BRAND_SVG + '</span>'
    + '<div class="brandText"><strong>文匣</strong>'
    + '<em class="brandSrc" id="brandSrc">' + srcLabel() + '</em></div>'
    + '</button>'
    + '</div>'
    + '<div class="search">'
    + '<svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" '
    + 'stroke-width="1.4" aria-hidden="true"><circle cx="6.5" cy="6.5" r="4.6"/>'
    + '<path d="M10 10l3.4 3.4" stroke-linecap="round"/></svg>'
    + '<input id="q" type="search" placeholder="題名・作者・タグ" aria-label="棚を検索" '
    + 'autocomplete="off" enterkeyhint="search">'
    // 打った語を一括で消す ✕。素の search の消去釦は意匠が合わず隠しているので自前
    + '<button class="fieldBtn qClear" id="btnQClear" type="button" aria-label="検索語を消す" hidden>'
    + '<svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" '
    + 'stroke-width="1.5" aria-hidden="true"><path d="M3.5 3.5l8 8M11.5 3.5l-8 8" stroke-linecap="round"/></svg>'
    + '</button>'
    + '<button class="fieldBtn" id="btnType" type="button" aria-label="種別">' + icon('type', 17) + '</button>'
    + '<button class="fieldBtn" id="btnSort" type="button" aria-label="並び">' + icon('sort', 17) + '</button>'
    // 作者名の候補。検索枠にぶら下がるので枠の中に置く (座標の親が要る)。
    // 中身は打つたびに組み直すので、ここでは空の紙だけを吊っておく
    + '<div class="suggest" id="suggest" role="listbox" aria-label="作者の候補" aria-hidden="true"></div>'
    + '</div>'
    + '</div>'
    + '<div class="shelfBody" id="shelfBody">'
    // 引き直しの糸。丈を持たないので、居ても棚の並びは一切ずれない
    + '<div class="pullLine" id="pullLine" aria-hidden="true"><i></i><i></i></div>'
    + '<div class="groupLabel" id="resumeGroup" hidden>最近読んだ</div>'
    + '<div class="resume" id="resume" hidden></div>'
    // 見出し行が絞りと向きの席を兼ねる: 名を突くと ★4 以上だけに切り替わり
    // (罫が真鍮に灯る)、右端の小さな矢印が並びの向き
    + '<div class="groupLabel allHead" id="allGroup">'
    + '<button class="groupTitle" id="btnStarMode" type="button" '
    + 'aria-label="★4以上だけの表示と切り替える">すべて</button>'
    + '<i class="ruleLine" aria-hidden="true"></i>'
    + '<button class="dirBtn" id="btnDir" type="button" aria-label="並びの向き"></button>'
    + '</div>'
    + '<div class="grid" id="grid"></div>'
    + '<div class="note" id="note"></div>'
    + '</div>';

  var qInput = document.getElementById('q');
  var searchBox = shelf.querySelector('.search');
  var suggestBox = document.getElementById('suggest');
  var shelfBody = document.getElementById('shelfBody');
  var pullLine = document.getElementById('pullLine');
  var resume = document.getElementById('resume');
  var resumeGroup = document.getElementById('resumeGroup');
  var allGroup = document.getElementById('allGroup');
  var grid = document.getElementById('grid');
  var note = document.getElementById('note');
  var btnType = document.getElementById('btnType');
  var btnSort = document.getElementById('btnSort');
  var btnDir = document.getElementById('btnDir');
  var btnStarMode = document.getElementById('btnStarMode');
  var btnSrc = document.getElementById('btnSrc');
  var brandSrc = document.getElementById('brandSrc');

  // 紙や胴の後ろに敷く幕。骨組みには無いので、ここで作って body に挿す
  var scrim = document.createElement('button');
  scrim.className = 'scrim';
  scrim.id = 'scrim';
  scrim.type = 'button';
  scrim.setAttribute('aria-label', '閉じる');
  scrim.hidden = true;
  host.insertBefore(scrim, drum);

  // ── 札 ────────────────────────────────────────────────────────

function pageCountBadge(gallery) {
  const count = Number(gallery?.pageCount);
  if (gallery?.kind === 'creator' || !Number.isSafeInteger(count) || count <= 1) return '';
  return `<span class="page-count-badge" aria-label="${count}ページ"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 17h8a2 2 0 0 0 2-2V7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><rect x="2" y="2" width="12" height="12" rx="2" fill="currentColor"/></svg><span>${count}</span></span>`;
}

  function coverUrl(id) { if (window.BUNKO.host) return window.BUNKO.host.coverUrl(id); return '/api/book/' + encodeURIComponent(id) + '/cover'; }

  // 栞の updatedAt は母艦が書くと Date.now() の数値、こちらで書き足すと文字列。
  // どちらで来ても時刻に直す (数値を Date.parse に通すと NaN になる)
  function when(value) {
    if (typeof value === 'number') return value;
    var t = Date.parse(value);
    return isNaN(t) ? 0 : t;
  }

  // 角が折れているのは「24 時間以内にここに居た」という印。
  // 読んだ位置そのものは別に残るので、角が伸びても「続きから読む」は出る
  function fresh(mark) {
    if (!mark || !mark.updatedAt) return false;
    var t = when(mark.updatedAt);
    return t > 0 && (Date.now() - t) < FRESH_MS;
  }

  // 角だけを付け替える。札ごと作り直すと、入場の動きがもう一度走ってしまう
  function paintDogear(card) {
    var cover = card.querySelector('.cover');
    if (!cover) return;
    var mark = state.reading[card.dataset.id];
    var old = cover.querySelector('.dogear');
    if (!fresh(mark)) {
      if (old && old.parentNode) old.parentNode.removeChild(old);
      return;
    }
    var el = old || document.createElement('div');
    el.className = 'dogear' + (mark.finished ? ' done' : '');
    if (!old) cover.appendChild(el);
  }

  // 棚に出すのは表紙と題だけ。作者も数字も、一冊を開いたときに読めばよい。
  // onTap を渡さなければ紙を開く: 格子の札はこれ (帯だけが別の答え方をする)
  function bookNode(item, onTap) {
    seen[item.id] = item;
    var el = document.createElement('button');
    el.className = 'book';
    el.type = 'button';
    el.dataset.id = item.id;

    var wrap = document.createElement('div');
    wrap.className = 'coverWrap';
    var cover = document.createElement('div');
    cover.className = 'cover';
    var img = document.createElement('img');
    img.className = 'coverImg';
    img.loading = 'lazy';       // 見えている分だけ落とす。棚は長い
    img.decoding = 'async';
    img.src = coverUrl(item.id);
    img.alt = '';
    cover.appendChild(img);
    cover.insertAdjacentHTML('beforeend', pageCountBadge(item));
    wrap.appendChild(cover);

    var title = document.createElement('div');
    title.className = 'bookTitle';
    title.textContent = item.title || '';

    el.appendChild(wrap);
    el.appendChild(title);
    paintDogear(el);
    el.addEventListener('click', function () {
      // 作者フォルダの札は一冊ではなく棚の入り口。突いたらその作者の棚へ潜る
      // (folder: の語が検索欄に入るので、✕ で作者一覧へ戻れる)
      if (item.folder) { filterBy('folder:' + item.folder); return; }
      if (onTap) onTap(item); else openSheet(item);
    });
    return el;
  }

  // 置いた順に一枚ずつ現れる。番号は「その束の中で」0 から数える:
  // 追い足した分を通し番号で続けると、二百枚目が五秒も待たされることになる
  function stagger(nodes) {
    nodes.forEach(function (el, i) { el.style.setProperty('--i', i); });

    var placed = false;
    function place() {
      if (placed) return;
      placed = true;
      nodes.forEach(function (el) { el.classList.add('in'); });
    }

    // 二段挟むのは、置いた姿を一度描かせてから動かすため
    // (挟まないと、下からせり上がる代わりに いきなり現れる)
    requestAnimationFrame(function () { requestAnimationFrame(place); });

    // 札の見え方を rAF だけに預けない保険。.book は opacity:0 で組まれ、
    // .in を付けるのがここしかないので、rAF が来なければ本が一冊も出ない。
    // 時計は rAF が止まっても進むので、こちらで必ず置く。
    //
    // 註: 2026-08-20 に iPad で出た「読み込んでも何も出ず、触った途端に一斉に出る」は
    // これが原因ではなかった。実測では rAF は 60fps で回っており、犯人は
    // prefers-reduced-motion 下の遷移が始点で止まることだった (reader.css を見よ)。
    // ここはその件の直しではなく、あくまで一般の備え。
    //
    // 300ms にしてあるのは、ただ遅いだけの端末から動きを取り上げないため
    // (60Hz なら二段 rAF は 33ms で来る)。.in は見た目専用で、開いているか等の
    // 判じには一切使われていないので、二重に付いても害は無い
    setTimeout(place, 300);
  }

  // ── 一覧 ──────────────────────────────────────────────────────

  function listUrl() {
    // 絞りは常に付ける。付け忘れると、二枚目から絞りの外れた本が混ざる。
    // 種別だけは pawchive の投稿が持たない。母艦が解さない語を送っても
    // 通ってしまう恐れがあるので、こちらで落としてから訊く
    return '/api/books?page=' + state.page
      + '&q=' + encodeURIComponent(state.q)
      + (state.src === 'paw' ? '' : '&type=' + encodeURIComponent(state.type))
      + '&sort=' + encodeURIComponent(state.sort)
      + (state.sort === 'random' ? '&seed=' + state.seed : (state.dir === 'asc' ? '&dir=asc' : ''))
      + (state.star4 ? '&minStar=4' : '')
      + srcParam();
  }

  function nearEnd() {
    if (shelfBody.scrollHeight > shelfBody.clientHeight + 4) {
      return shelfBody.scrollTop + shelfBody.clientHeight >= shelfBody.scrollHeight - 400;
    }
    var doc = document.scrollingElement || document.documentElement;
    return doc.scrollTop + window.innerHeight >= doc.scrollHeight - 400;
  }

  var listToken = 0;

  // 次に返る一頁目で、いま並んでいる札を置き換えるか (reset が立てる)
  var replaceOnNext = false;

  function loadMore() {
    if (state.loading || !state.hasMore) return;
    state.loading = true;
    // 頼んだ時点で預かる。返事が来るまでに別の頼みが挟まっても取り違えない
    var replacing = replaceOnNext;
    replaceOnNext = false;
    if (state.page === 0) note.textContent = '読み込み中…';
    var mine = ++listToken;
    api(listUrl())
      .then(function (data) {
        if (mine !== listToken) return; // 打ち直された後の返事は捨てる
        // 置き換える頁では、いま並んでいる札を id で引けるようにしておく。
        // 同じ本が残るならその札を**そのまま使い回す**: 作り直すと入場の動きが
        // 端から端まで走り直して、打鍵のたびに棚が波打つ
        var have = {};
        if (replacing) {
          [].forEach.call(grid.children, function (el) {
            if (el.dataset && el.dataset.id) have[el.dataset.id] = el;
          });
        }
        var ordered = [];
        var added = [];
        (data.items || []).forEach(function (item) {
          var kept = replacing ? have[String(item.id)] : null;
          if (kept) {
            seen[item.id] = item;   // 札は使い回すが、中身は新しい返事で上書きする
            paintDogear(kept);
            delete have[String(item.id)];
            ordered.push(kept);
            return;
          }
          var node;
          if (state.src === 'paw' && !item.folder) {
            // paw の作品札は一突きで即読む。**常に頭から** — 栞の位置は見ない
            // (利用者指定 2026-08-20。紙は長押しで残す)。hitomi 側は従来どおり紙
            node = bookNode(item, function (it) { toReaderDirect(it, 'first'); });
            bindHold(node, item);
          } else {
            node = bookNode(item);
          }
          ordered.push(node);
          added.push(node);
        });
        if (replacing) {
          // 要らなくなった札だけ外してから、残す札を順に置き直す。
          // appendChild は既に子である節点を**動かす**ので、作り直しは起きない
          Object.keys(have).forEach(function (id) {
            if (have[id] && have[id].parentNode === grid) grid.removeChild(have[id]);
          });
          grid.classList.remove('stale');
        }
        ordered.forEach(function (node) { grid.appendChild(node); });
        state.hasMore = Boolean(data.hasMore);
        state.page += 1;
        state.loading = false;
        // 入場の動きを付けるのは新しく組んだ札だけ (使い回した札は既に置いてある)
        stagger(added);
        // 引き直しの糸は、一覧の一枚目が返った所で消す。ここから先 (帯や
        // 追い足し) を待たせると、棚が並び終えた後も糸だけが残って見える
        endRefresh();
        var empty = !grid.children.length;
        note.textContent = (empty && !state.hasMore) ? '見つかりません' : '';
        // ★絞りで空振りしたときは見出しを残す — 絞りの解除口が見出しの名なので、
        // 隠すと戻る手立てが消える
        allGroup.hidden = empty && !state.star4;
        // 見出しは今なにが並んでいるか: 作者の棚ならその名、★絞り中は「お気に入り」、
        // paw の入り口なら「作者」。行ごと書き換えると罫と向きの釦が消えるので、
        // 名の釦にだけ書く
        btnStarMode.textContent = data.folderName
          || (state.star4 ? 'お気に入り'
            : (state.src === 'paw' && !state.q ? '作者' : 'すべて'));
        // 画面が埋まらないうちは続きを取りに行く (絞りで大半が落ちた場合)。
        // 棚が伸び続ける組み方でも止まるよう、回数で頭を打っておく。
        //
        // **否定を付けない。** nearEnd() は巻きの耳 (下の二つ) でも「続きを取る合図」
        // として否定なしで使う。ここだけ反対に書いてあったので、
        //   画面が埋まっていない時 … 取りに行かない (巻けないので二度と継がれない)
        //   画面が埋まっている時   … 8 頁ぶん先まで取ってしまう
        // と、両方向とも註の反対に動いていた。手のひら版が生まれた時からの食い違い
        if (state.hasMore && state.fills < 8 && nearEnd()) {
          state.fills += 1;
          loadMore();
        }
      })
      .catch(function (error) {
        if (mine !== listToken) return;
        state.loading = false;
        // 取りに行けなかった時は古い棚をそのまま残す (白くするより見える物が要る)
        grid.classList.remove('stale');
        endRefresh(); // 引けなかった時も糸は消す (灯りっぱなしは嘘になる)
        // 合言葉切れ・母艦が寝ている・置き場が見えない を同じ顔にしない (項目 9-10)
        var code = Number((error && error.message) || 0);
        say(code === 401 || code === 403
          ? '合言葉が切れました。開き直してください'
          : (code >= 500 ? '母艦が棚を組めませんでした' : '母艦につながりません'),
        { retry: function () { refreshAll(); } });
      });
  }

  // 棚を組み直す。**ここで札を捨てない** — 捨ててから取りに行くと、打鍵のたび・
  // 並びを変えるたび・台帳を移るたびに棚が真っ白になる。返事が来た所で、
  // 残る札は使い回し、要らない札だけ外す (掟: 読み込み中の空白が一番嫌われる)
  function reset() {
    settleSort();
    state.page = 0;
    state.hasMore = true;
    state.loading = false;
    state.fills = 0;
    allGroup.hidden = false;
    replaceOnNext = true;
    grid.classList.add('stale');   // 古い棚だと分かる薄さ。高さは動かさない
    loadMore();
  }

  shelfBody.addEventListener('scroll', function () {
    if (nearEnd()) loadMore();
  }, { passive: true });
  window.addEventListener('scroll', function () {
    if (nearEnd()) loadMore();
  }, { passive: true });

  var searchTimer = null;

  // 語を決めて棚を組み直す。変換中の断片では呼ばない
  function commitQuery() {
    clearTimeout(searchTimer);
    var next = qInput.value.trim();
    if (next === state.q) return;
    var wasSearching = Boolean(state.q);
    state.q = next;
    // 打っている最中の一字ずつを履歴に積むと、電話の「戻る」が語を一字ずつ遡る。
    // 積むのは検索に入る時と出る時だけで、語から語への打ち直しは上書きにする
    pushShelf(wasSearching && Boolean(next));
    reset();
  }

  qInput.addEventListener('input', function (event) {
    syncClear();
    clearTimeout(searchTimer);
    // 変換中の断片で棚を組み直さない。composing は候補の側が持っている印、
    // event.isComposing は compositionstart を取り逃す IME への保険 (机上版と同じ二重)
    if (composing || (event && event.isComposing)) return;
    searchTimer = setTimeout(commitQuery, DEBOUNCE_MS);
  });

  // 鍵盤の「検索」を押した時 (enterkeyhint="search")。待たずに決めて鍵盤を退ける
  qInput.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    commitQuery();
    qInput.blur();
  });

  // 検索語の一括消し。語が入っている間だけ ✕ が出る。
  // 値を手続きで書き換える所 (候補の選択・素性タップ) からも呼ぶこと
  var btnQClear = document.getElementById('btnQClear');
  function syncClear() {
    btnQClear.hidden = !qInput.value;
  }
  btnQClear.addEventListener('click', function () {
    qInput.value = '';
    syncClear();
    closeSuggest();
    clearTimeout(searchTimer);
    if (state.q !== '') {
      state.q = '';
      pushShelf();
      reset();
    }
    // 消したあとは打ち直すのが自然な流れ。鍵盤を呼び戻す
    qInput.focus();
  });

  // ── 作者名の候補 ──────────────────────────────────────────────
  //
  // 母艦の索引は「artist:kagaribi_makibi」の形でしか引けないのに、手で打てるのは
  // 「篝火」までだったりする。そこを繋ぐのがこの紙。訊くのは打っている最後の語
  // だけで、選んだらその語だけを型付きトークンに差し替える (既に絞った他の語は残す)。
  // 件数は出さない — この画面は数字で語らない側なので、候補も名前だけを言う

  var suggestTimer = null;
  var suggestToken = 0;
  var composing = false;   // IME の変換中。確定前の断片で母艦を叩いても当たらない

  // 語の切れ目は空白。末尾が空白なら「その語は打ち終わった」ということなので
  // 候補は畳む (机上版は trim して直前の語を出し続けるが、手のひらでは
  // 打ち終わった後まで紙が居座ると棚が見えない)
  function lastWord() {
    return qInput.value.split(/\s+/).pop() || '';
  }

  function closeSuggest() {
    clearTimeout(suggestTimer);
    suggestToken += 1;   // 飛んでいる問い合わせの返事も、ここで縁を切る
    suggestBox.classList.remove('on');
    suggestBox.setAttribute('aria-hidden', 'true');
    // 行は消さない。消すと去り際の一瞬だけ空の紙が残って見える。
    // 次に出すときは必ず組み直すので、古い行が出ることは無い
  }

  function paintSuggest(items) {
    suggestBox.innerHTML = items.map(function (item) {
      var name = item.name || '';
      var label = item.label || '';
      // 日本語の札を持たない作家は、ローマ字が主役の一行になる。
      // 添え物の埃色のまま一行だけ置くと、居るのに読めない札になる
      var series = item.secondary || '';
      // 机上版と同じ組み方: 日本語名 + 所属作品 (同じ行) / 送る値 (下段)。
      // 種類は左端の線の色で言う (詳細画面のタグと同じ色)
      var head = label
        ? '<span class="suggestLabel">' + esc(label) + '</span>'
          + (series ? '<span class="suggestSeries">' + esc(series) + '</span>' : '')
        : '<span class="suggestLabel solo">' + esc(name) + '</span>';
      var lines = '<span class="suggestHead">' + head + '</span>'
        + (label ? '<span class="suggestName">' + esc(name) + '</span>' : '');
      return '<button class="suggestRow" type="button" role="option" '
        + 'data-kind="' + esc(item.type || 'tag') + '" '
        + 'data-suggest="' + esc(item.value) + '">'
        + '<span class="suggestBar" aria-hidden="true"></span>'
        + '<span class="suggestBody">' + lines + '</span>'
        + '</button>';
    }).join('');
    suggestBox.classList.add('on');
    suggestBox.setAttribute('aria-hidden', 'false');
  }

  function askSuggest() {
    if (composing) return;
    var word = lastWord();
    if (!word) { closeSuggest(); return; }
    var mine = ++suggestToken;
    api('/api/suggest?q=' + encodeURIComponent(word) + srcParam())
      .then(function (data) {
        // 遅れて返った古い語の候補は出さない。打鍵が進んでいたら、それは
        // もう別の語への返事で、突かれると見当違いの棚が組まれる
        if (mine !== suggestToken || composing || lastWord() !== word) return;
        var items = (data && data.items) || [];
        if (!items.length) { closeSuggest(); return; }
        paintSuggest(items);
      })
      .catch(function () { closeSuggest(); });
  }

  function scheduleSuggest() {
    clearTimeout(suggestTimer);
    if (composing) return;
    suggestTimer = setTimeout(askSuggest, SUGGEST_MS);
  }

  // 棚の組み直し (上の耳) とは別の耳で聞く。間合いが違うので、一つに束ねると
  // どちらかが相手の都合で遅れる
  qInput.addEventListener('input', scheduleSuggest);
  qInput.addEventListener('compositionstart', function () {
    composing = true;
    closeSuggest();
  });
  qInput.addEventListener('compositionend', function () {
    composing = false;
    scheduleSuggest();   // 確定した語で改めて訊く
    // 棚も改めて組み直す。input を compositionend より先に投げる IME があり、
    // その一発は変換中として捨てているので、ここで拾わないと語が棚に届かない
    clearTimeout(searchTimer);
    searchTimer = setTimeout(commitQuery, DEBOUNCE_MS);
  });

  // 検索枠の外を突いたら畳む。候補の紙は枠の中に居るので、枠ごと見れば
  // 「候補を選ぶ指」は外れない (絞りの釦も枠の中なので、そちらは openDrum が閉じる)
  document.addEventListener('pointerdown', function (e) {
    // In a frame, wait for click: hiding on pointerdown sends pointerup to the parent list.
    if (window.BUNKO.host) return;
    if (!suggestBox.classList.contains('on')) return;
    if (searchBox.contains(e.target)) return;
    closeSuggest();
  }, true);

  // 突かれた候補で、打っている最後の語だけを差し替える。紙の素性を突いたとき
  // (filterBy) と違って欄を空にしないのは、絞り込みを重ねている途中だから
  suggestBox.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-suggest]') : null;
    if (!el || !suggestBox.contains(el)) return;
    var parts = qInput.value.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) parts.push('');
    parts[parts.length - 1] = el.getAttribute('data-suggest');
    var next = parts.join(' ');
    closeSuggest();
    qInput.value = next;
    syncClear();
    // 選んだ時点で打鍵は終わり。鍵盤を退かせて、組み直った棚を見せる
    qInput.blur();
    // 打ちかけの語が後から棚を上書きしないように、待たせてある組み直しは捨てる
    clearTimeout(searchTimer);
    if (next === state.q) return;
    state.q = next;
    pushShelf();
    reset();
  });

  // ── 台帳の切り替え ────────────────────────────────────────────
  //
  // 母艦は同じ口で二つの台帳を配る (src=paw を付けるか付けないかだけの差)。
  // id が pw_ の名前空間で分かれているので、表紙も一冊も頁も栞も、この先は
  // 何も分岐しない。切り替えで変わるのは「一覧と候補を誰に訊くか」だけ

  function srcLabel() { return state.src === 'paw' ? 'PAWCHIVE' : 'HITOMI'; }

  // 台帳の指し先。hitomi は既定なので付けない (母艦は src 無しを従来の台帳と読む)
  function srcParam() { return state.src === 'paw' ? '&src=paw' : ''; }

  // pawchive の投稿に種別は無い。釦を残すと「押しても何も変わらない」札になるので
  // 伏せる。state.type は消さない — hitomi に戻った時、絞っていた所へそのまま帰す
  function applySrc() {
    btnType.hidden = state.src === 'paw';
    btnSrc.setAttribute('aria-label', '台帳を切り替える (今は ' + srcLabel() + ')');
  }

  var srcSwapTimer = null;

  // 小文字は 6px 上へ退き、入れ替わった名が 6px 下から起きる。台帳が入れ替わった
  // ことを言うのはこの一行だけなので、静かでも「入れ替わった」と読める間を置く
  function paintSrcName() {
    clearTimeout(srcSwapTimer);
    brandSrc.classList.remove('under');
    brandSrc.classList.add('out');
    srcSwapTimer = setTimeout(function () {
      brandSrc.textContent = srcLabel();
      brandSrc.classList.remove('out');
      // 間合いを持たない下の位置へ一度飛ばしてから放す。そのまま外すと、
      // 退いた上の位置から降りてきて「戻った」ように見える
      brandSrc.classList.add('under');
      requestAnimationFrame(function () {
        brandSrc.classList.remove('under');
      });
    }, SRC_SWAP_MS);
  }

  // 台帳を移った先で意味を持たない語を落とす。いまの所これは folder: だけ —
  // pawchive の作者の棚を指す語で、hitomi の台帳にはその概念が無い。持ち越すと
  // 必ず 0 件になり、利用者には棚が壊れたように見える (机上版の query-port と同じ考え。
  // あちらは四つのサイトを相手にするので表が要る)。落とした事は検索欄が変わって伝わる
  function dropForeignTerms(query, to) {
    if (to === 'paw') return { query: String(query || ''), dropped: 0 };
    var dropped = 0;
    var kept = String(query || '').split(/\s+/).filter(function (word) {
      if (!word) return false;
      if (word.indexOf('folder:') !== 0) return true;
      dropped += 1;
      return false;
    });
    return { query: kept.join(' '), dropped: dropped };
  }

  btnSrc.addEventListener('click', function () {
    var to = state.src === 'paw' ? 'hitomi' : 'paw';
    var ported = dropForeignTerms(state.q, to);
    if (ported.dropped) {
      state.q = ported.query;
      qInput.value = ported.query;
      syncClear();
    }
    state.src = to;
    write('bunko.src', state.src);
    // 打ちかけの語に付いた候補は、もう別の台帳の作家を指している
    closeSuggest();
    applySrc();
    paintSrcName();
    pushShelf();
    // 検索語も並びも保つ。同じ問いを別の台帳に投げ直す、という切り替え
    reset();
    // 組み直した棚は頭から見せる (素性を突いた時と同じ寄せ方)
    shelfBody.scrollTop = 0;
    var doc = document.scrollingElement || document.documentElement;
    if (doc) doc.scrollTop = 0;
  });

  // ── 最近読んだ ────────────────────────────────────────────────

  // 帯は「続きを読む入り口」なので、一突きで紙を飛ばして読む画面まで通す。
  // 素性を見たいときのために長押しを残す (押さえていると紙が出る)
  function tapResume(item) {
    var mark = state.reading[item.id];
    // 読み終えた本に「続き」は無い。紙の釦と同じ判じ方をする
    toReaderDirect(item, mark && mark.finished ? 'first' : 'resume');
  }

  function bindHold(node, item) {
    var timer = null;
    var sx = 0;
    var sy = 0;

    function stopHold() { clearTimeout(timer); timer = null; }

    node.addEventListener('pointerdown', function (e) {
      sx = e.clientX;
      sy = e.clientY;
      stopHold();
      timer = setTimeout(function () {
        timer = null;
        openSheet(item);
        // 紙を開いた上に再開まで走らせない。続けて来る click を一度食う
        swallowNextClick();
      }, HOLD_MS);
    });
    // 帯は横に流れる。送っているだけの指を長押しと取り違えない
    node.addEventListener('pointermove', function (e) {
      if (!timer) return;
      if (Math.abs(e.clientX - sx) > HOLD_SLOP || Math.abs(e.clientY - sy) > HOLD_SLOP) stopHold();
    });
    node.addEventListener('pointerup', stopHold);
    node.addEventListener('pointercancel', stopHold);
  }

  // 「最近読んだ」の帯。**作り直さない** — 中身が同じでも毎回捨てて組み直すと、
  // 本を閉じて棚へ戻るたびに帯がいったん消えて生え直し、下の棚が丸ごと
  // 230px ほど飛ぶ (掟: 帯は押しのけず重ねる・高さを動かさない)。
  // 読んだ本が帯の頭へ回るだけの時は、札を使い回して並べ替えるので丈が動かない
  function paintRecent(items) {
    var list = items.slice(0, RECENT_MAX);
    var have = {};
    [].forEach.call(resume.children, function (el) {
      if (el.dataset && el.dataset.id) have[el.dataset.id] = el;
    });
    var ordered = [];
    var added = [];
    list.forEach(function (item) {
      var kept = have[String(item.id)];
      if (kept) {
        seen[item.id] = item;   // 札は使い回すが、中身は新しい栞で上書きする
        paintDogear(kept);
        delete have[String(item.id)];
        ordered.push(kept);
        return;
      }
      var node = bookNode(item, tapResume);
      node.classList.add('resumeCard');
      bindHold(node, item);
      ordered.push(node);
      added.push(node);
    });
    // 帯から外れた札だけ外し、残る札は appendChild で順に置き直す (動かすだけ)
    Object.keys(have).forEach(function (id) {
      if (have[id] && have[id].parentNode === resume) resume.removeChild(have[id]);
    });
    ordered.forEach(function (node) { resume.appendChild(node); });
    var empty = ordered.length === 0;
    resume.hidden = empty;
    resumeGroup.hidden = empty;
    // 入場の動きを付けるのは新しく入った札だけ
    if (added.length) stagger(added);
  }

  // 本を閉じた後の組み直しは、覚えている本から自前で並べる。
  // ここで /api/recent を引き直すと、閉じた瞬間に母艦へ余計な仕事が増える
  function recentFromMarks() {
    return Object.keys(state.reading)
      .filter(function (id) { return seen[id] && fresh(state.reading[id]); })
      .sort(function (a, b) {
        return when(state.reading[b].updatedAt) - when(state.reading[a].updatedAt);
      })
      .map(function (id) { return seen[id]; });
  }

  // ── 棚を下に引いて引き直す ────────────────────────────────────
  //
  // 母艦の棚は端末を見ていない間にも増える。取りに行く釦を置くより、
  // 上端で更に下へ引く方が「もう一度見せて」に近い。
  // 出すのは棚の頭から左右に伸びる真鍮の糸だけ: 輪も数字も文言も置かない。
  // 何が起きたかは、札が並び直る動きそのものが言う

  var pull = { armed: false, on: false, y0: 0, x0: 0, raw: 0, busy: false, guard: null };

  function paintPull(px) {
    pullLine.style.setProperty('--pull', String(px / PULL_MAX));
  }

  // 引いている最中は指に直結させ、離した時だけ滑らせて戻す
  function pullEase(on) { pullLine.classList.toggle('ease', on); }

  // 起動時と同じ順で引き直す。栞が先なのは、並べ終えた札の角を後から
  // 折り直さずに済ませるため。絞りも検索語も state に載ったままなので保たれる
  function refreshAll() {
    closeSuggest(); // 棚を丸ごと組み直す間、打ちかけの語の候補は用が無い
    // 引き直しはランダムの「混ぜ直し」でもある: 種を取り直してから組む
    if (state.sort === 'random') {
      state.seed = (Math.floor(Math.random() * 2147483647) || 1);
    }
    return api('/api/reading')
      .then(function (data) { state.reading = data || {}; })
      .catch(function () { /* 栞が引けなくても、覚えている分で棚は組める */ })
      .then(function () {
        reset();
        return api('/api/recent').catch(function () { return { items: [] }; });
      })
      .then(function (data) { paintRecent((data && data.items) || []); });
  }

  function startRefresh() {
    if (pull.busy) return; // 引き直しの最中に また引かれても、二度は走らせない
    pull.busy = true;
    pullEase(true);
    paintPull(PULL_MAX);
    pullLine.classList.add('lit');
    // 母艦が黙り込んだ時に糸が灯りっぱなしにならないよう、退き際を用意しておく
    clearTimeout(pull.guard);
    pull.guard = setTimeout(endRefresh, PULL_WAIT);
    refreshAll();
  }

  function endRefresh() {
    if (!pull.busy) return;
    pull.busy = false;
    clearTimeout(pull.guard);
    pullLine.classList.remove('lit');
    pullEase(true);
    paintPull(0);
  }

  // 棚を送るのは文書 (Safari の帯を畳ませるため内側の箱は使っていない)。
  // 「上端に居るか」も文書の側で見る
  function atTop() {
    var doc = document.scrollingElement || document.documentElement;
    return (doc.scrollTop || 0) <= 0 && shelfBody.scrollTop <= 0;
  }

  shelfBody.addEventListener('touchstart', function (e) {
    // 二本指は拡大や勢いのある送り。引きに取り違えない。
    // 引き直しの最中は端から構えない (棚は普段どおり跳ねてよい)
    pull.armed = !pull.busy && e.touches.length === 1 && atTop();
    pull.on = false;
    pull.raw = 0;
    if (!pull.armed) return;
    pull.y0 = e.touches[0].clientY;
    pull.x0 = e.touches[0].clientX;
  }, { passive: true });

  shelfBody.addEventListener('touchmove', function (e) {
    if (!pull.armed) return;
    if (e.touches.length !== 1) { pull.armed = false; return; }
    var dy = e.touches[0].clientY - pull.y0;
    var dx = e.touches[0].clientX - pull.x0;
    if (!pull.on) {
      // 上へ向かった指は素直な送り。掴み直すまで引きは起こさない
      if (dy <= 0) { pull.armed = false; return; }
      // 横に勝っている指は帯 (最近読んだ) を送っている。棚の頭は帯の席でもある
      if (Math.abs(dx) > Math.abs(dy)) { pull.armed = false; return; }
      if (!atTop()) { pull.armed = false; return; }
      pull.on = true;
      pullEase(false);
    }
    // 掴んだまま指を戻された時に糸が裏返らないよう、下向きだけを見る
    pull.raw = Math.max(0, dy) * PULL_DAMP;
    // 引いている間は棚のはずみ (iOS の跳ね返り) に渡さない
    e.preventDefault();
    paintPull(Math.min(pull.raw, PULL_MAX));
  }, { passive: false });

  function endPull(cancelled) {
    var tripped = pull.on && !cancelled && pull.raw >= PULL_MAX;
    pull.armed = false;
    pull.on = false;
    pullEase(true);
    // 届かなかった指には何も言わない。糸を縮めて戻すだけ
    if (!tripped) { paintPull(0); return; }
    startRefresh();
  }

  shelfBody.addEventListener('touchend', function () { endPull(false); });
  shelfBody.addEventListener('touchcancel', function () { endPull(true); });

  // ── 胴 (絞りの選び) ───────────────────────────────────────────

  var FIELDS = {
    type: { key: 'type', name: '種別', list: TYPES, icon: 'type', btn: btnType },
    // list は関数でもよい: 並びは今どの棚を見ているかで変わる
    sort: { key: 'sort', name: '並び', list: sortList, icon: 'sort', btn: btnSort }
  };

  // いまの棚に出してよい並び。paw で語が無い画面 = 作者の棚
  function sortList() {
    if (state.src !== 'paw' || state.q) return SORTS;
    return SORTS.filter(function (row) { return FOLDER_SORTS.indexOf(row.id) >= 0; });
  }

  function listOf(field) {
    return typeof field.list === 'function' ? field.list() : field.list;
  }

  // 選択肢から消えた並びを握ったままにしない。**選択肢を決めた後に検める**
  // (先に検めると、これから出す選択肢ではなく前の画面の選択肢と突き合わせてしまう)
  function settleSort() {
    var list = sortList();
    if (inList(list, state.sort, '') === state.sort) return;
    state.sort = 'added';
    write('bunko.sort', state.sort);
    markFields();
  }

  drum.innerHTML =
    '<div class="grabber"></div>'
    + '<div class="filterHead">'
    + '<span class="filterLabel" id="filterLabel"></span>'
    + '<button class="iconBtn sm" id="btnPickDone" type="button" aria-label="閉じる">'
    + '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" '
    + 'stroke-width="1.7" aria-hidden="true"><path d="M3.5 9.4l3.7 3.7L14.5 5.4" '
    + 'stroke-linecap="round" stroke-linejoin="round"/></svg>'
    + '</button>'
    + '</div>'
    + '<div class="wheel"><div class="wheelBand"></div>'
    + '<div class="wheelTrack" id="wheelTrack"></div></div>';

  var track = document.getElementById('wheelTrack');
  var filterLabel = document.getElementById('filterLabel');
  var openField = null;
  var settleTimer = null;

  // 真ん中からの距離で寝かせて薄くする。円筒に貼ってあるように見せるため
  function shapeWheel() {
    var center = track.scrollTop + track.clientHeight / 2;
    var items = track.children;
    for (var i = 0; i < items.length; i += 1) {
      var el = items[i];
      var d = (el.offsetTop + ROW / 2 - center) / ROW;
      var far = Math.min(Math.abs(d), 3);
      el.style.transform = 'rotateX(' + (-d * 22) + 'deg) translateZ(' + (-far * 10) + 'px)';
      el.style.opacity = String(Math.max(0.18, 1 - far * 0.3));
      el.classList.toggle('sel', Math.abs(d) < 0.5);
    }
  }

  function commitWheel() {
    if (!openField) return;
    var field = FIELDS[openField];
    var rows = listOf(field);
    var index = Math.max(0, Math.min(rows.length - 1, Math.round(track.scrollTop / ROW)));
    var picked = rows[index].id;
    if (state[field.key] === picked) return;
    // ランダムに切り替えた時は種を取り直す (前回のランダムの並びを繰り返さない)
    if (field.key === 'sort' && picked === 'random') {
      state.seed = (Math.floor(Math.random() * 2147483647) || 1);
    }
    state[field.key] = picked;
    write('bunko.' + field.key, picked);
    markFields();
    pushShelf();   // 回している最中ではなく、決まった一つだけが履歴に残る
    reset();
  }

  track.addEventListener('scroll', function () {
    shapeWheel();
    clearTimeout(settleTimer);
    // 止まってから決める。回している最中に棚を組み直すと、指の下が忙しい
    settleTimer = setTimeout(commitWheel, SETTLE_MS);
  }, { passive: true });

  // 既定から動かしている欄は、検索枠の印を真鍮に灯して知らせる
  function markFields() {
    btnType.classList.toggle('on', state.type !== '');
    btnSort.classList.toggle('on', state.sort !== 'added');
    btnDir.classList.toggle('on', state.dir === 'asc');
    // ★絞りは見出し行の色で言う (名と罫が真鍮に灯る)
    allGroup.classList.toggle('starred', state.star4);
    // ランダムに向きは無い。押せない釦は薄めて知らせる (CSP で inline は書けないが
    // JS からの setProperty は通る)
    btnDir.disabled = state.sort === 'random';
    btnDir.style.opacity = btnDir.disabled ? '0.35' : '';
    btnDir.innerHTML = icon(state.dir === 'asc' ? 'up' : 'down', 13);
  }

  function openDrum(name) {
    // 絞りの釦は検索枠の中に居る (外を突いた判定に掛からない)。胴が上がる前に畳む
    closeSuggest();
    var field = FIELDS[name];
    openField = name;
    filterLabel.innerHTML = icon(field.icon, 15) + field.name;

    track.textContent = '';
    listOf(field).forEach(function (row, i) {
      var el = document.createElement('button');
      el.className = 'wheelItem';
      el.type = 'button';
      el.textContent = row.label;
      // 回さずに突いても選べる。狙った所へ寄っていく
      el.addEventListener('click', function () {
        track.scrollTo({ top: i * ROW, behavior: 'smooth' });
      });
      track.appendChild(el);
    });

    show(drum, 'filtersOn');
    // 開いた時点で今の値が真ん中に居るように置く (寸法が要るので、出してから)
    var at = listOf(field).map(function (x) { return x.id; }).indexOf(state[field.key]);
    track.scrollTop = Math.max(0, at) * ROW;
    shapeWheel();
  }

  function closeDrum() {
    clearTimeout(settleTimer);
    openField = null;
    hide(drum, 'filtersOn');
  }

  btnType.addEventListener('click', function () { openDrum('type'); });
  btnSort.addEventListener('click', function () { openDrum('sort'); });

  // 棚の頭から見せ直す (絞りを変えた時の共通の寄せ方)
  function toShelfTop() {
    shelfBody.scrollTop = 0;
    var doc = document.scrollingElement || document.documentElement;
    if (doc) doc.scrollTop = 0;
  }

  btnDir.addEventListener('click', function () {
    state.dir = state.dir === 'asc' ? 'desc' : 'asc';
    write('bunko.dir', state.dir);
    markFields();
    pushShelf();
    reset();
    toShelfTop();
  });

  btnStarMode.addEventListener('click', function () {
    state.star4 = !state.star4;
    write('bunko.star4', state.star4 ? '1' : '');
    markFields();
    pushShelf();
    reset();
    toShelfTop();
  });
  document.getElementById('btnPickDone').addEventListener('click', closeDrum);

  // ── 一冊の紙 ──────────────────────────────────────────────────

  sheet.innerHTML =
    '<div class="grabber"></div>'
    + '<div class="sheetTop">'
    + '<div class="sheetCover">'
    + '<div class="cover" id="sheetCover"></div>'
    + '<div class="coverDate" id="sheetDate"></div>'
    + '</div>'
    + '<div class="sheetInfo">'
    + '<h2 class="sheetTitle" id="sheetTitle"></h2>'
    + '<div class="stars" id="sheetStars" aria-label="評価"></div>'
    + '<div class="facts" id="sheetFacts"></div>'
    + '<button class="tagToggle" id="tagToggle" type="button" aria-expanded="false" '
    + 'aria-controls="tagList"><span id="tagCount"></span>'
    + '<svg class="chev" width="13" height="13" viewBox="0 0 13 13" fill="none" '
    + 'stroke="currentColor" stroke-width="1.4" aria-hidden="true">'
    + '<path d="M3 5l3.5 3.5L10 5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    + '</button>'
    + '<div class="tagList" id="tagList"></div>'
    + '</div>'
    + '</div>'
    + '<div class="pagesRail" id="pagesRail" aria-label="厚みと、どこまで読んだか">'
    + '<div class="pagesFill" id="pagesFill"></div></div>'
    + '<div class="pagesTotal" id="pagesTotal"></div>'
    + '<div class="sheetActs" id="sheetActs">'
    + '<button class="btn primary" id="btnRead" type="button">'
    + '<svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" '
    + 'stroke-width="1.4" aria-hidden="true"><path d="M7.5 3.4C6.2 2.5 4.4 2.2 2 2.4v9.2c2.4-.2 '
    + '4.2.1 5.5 1 1.3-.9 3.1-1.2 5.5-1V2.4c-2.4-.2-4.2.1-5.5 1z" stroke-linejoin="round"/>'
    + '<path d="M7.5 3.4v10.2"/></svg><span id="btnReadLabel">読む</span></button>'
    + '<button class="btn ghost" id="btnRestart" type="button">最初から</button>'
    + '</div>';

  var sheetCover = document.getElementById('sheetCover');
  var sheetDate = document.getElementById('sheetDate');
  var sheetTitle = document.getElementById('sheetTitle');
  var sheetStars = document.getElementById('sheetStars');
  var sheetFacts = document.getElementById('sheetFacts');
  var tagToggle = document.getElementById('tagToggle');
  var tagCount = document.getElementById('tagCount');
  var tagList = document.getElementById('tagList');
  var pagesFill = document.getElementById('pagesFill');
  var pagesTotal = document.getElementById('pagesTotal');
  var btnRead = document.getElementById('btnRead');
  var btnReadLabel = document.getElementById('btnReadLabel');
  var btnRestart = document.getElementById('btnRestart');
  var btnSave = null;
  if (window.BUNKO.host) {
    btnSave = document.createElement('button');
    btnSave.className = 'btn ghost';
    btnSave.type = 'button';
    btnSave.textContent = 'PCに保存';
    btnSave.addEventListener('click', function () {
      if (sheetItem) window.BUNKO.host.save(sheetItem);
    });
    document.getElementById('sheetActs').appendChild(btnSave);
  }

  // 日付は年月日だけ。時刻まで出しても、棚では使い道が無い
  function ymd(value) {
    if (!value) return '';
    var d = new Date(value);
    if (isNaN(d.getTime())) return String(value).slice(0, 10);
    var m = String(d.getMonth() + 1);
    var day = String(d.getDate());
    return d.getFullYear() + '-' + (m.length < 2 ? '0' + m : m) + '-' + (day.length < 2 ? '0' + day : day);
  }

  function esc(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // 母艦の索引は「型:語」の形をそのまま引ける。空白は _ (語の切れ目と紛れないように)
  function token(kind, value, tag) {
    if (window.BUNKO.host) return window.BUNKO.host.tagQuery(
      Object.assign({}, typeof tag === 'object' && tag || {}, { type: kind, name: String(value == null ? '' : value) }), sheetItem);
    return kind + ':' + String(value == null ? '' : value).trim().replace(/\s+/g, '_');
  }

  // 素性の値は一つずつ押せる。押した語で棚を絞るので、「、」で繋いだ一つの塊では
  // どれを押されたか言えない。値ごとに別の要素にし、欄の印は行に一つだけ置く。
  // 値は {name, label} — 見せるのは日本語札 (label)、絞りの道具はローマ字 (name)。
  // 古い形 (文字列) が来ても受ける
  function fact(name, list, kind) {
    if (!list || !list.length) return '';
    var vals = list.map(function (v) {
      var key = (v && v.name) ? v.name : v;
      var face = (v && (v.label || v.name)) ? (v.label || v.name) : v;
      // 値が自前の潜り先 (token) を持っていればそちらを使う (paw の作者 → folder:)
      var tok = !window.BUNKO.host && v && v.token ? v.token : token(kind, key, v);
      return '<button class="factVal" type="button" data-token="' + esc(tok) + '">'
        + esc(face) + '</button>';
    }).join('、');
    return '<div class="fact">' + icon(name) + '<span class="factVals">' + vals + '</span></div>';
  }

  function closeTags() {
    tagToggle.setAttribute('aria-expanded', 'false');
    tagList.classList.remove('open');
  }
  tagToggle.addEventListener('click', function () {
    var open = tagToggle.getAttribute('aria-expanded') === 'true';
    tagToggle.setAttribute('aria-expanded', String(!open));
    tagList.classList.toggle('open', !open);
  });

  // 素性やタグを突いたら、その語で棚を絞る。専用の絞り状態は作らず、
  // 検索欄にトークンを置いて既存の道をそのまま通す (見えるので、消して戻せる)
  function filterBy(tok) {
    if (window.BUNKO.host) { var owner = sheetItem; closeSheet(); window.BUNKO.host.filter(tok, owner); return; }
    closeSheet();
    closeSuggest(); // 欄を丸ごと書き換えるので、打ちかけの語に付いた候補は捨てる
    qInput.value = tok;
    syncClear();
    state.q = tok;
    clearTimeout(searchTimer); // 打ちかけの語が後から棚を上書きしないように
    pushShelf();               // 素性で潜った所。戻る一突きで元の棚へ浮上できる
    reset();
    // 絞った結果は頭から見せる。棚の途中に居たまま組み直すと、何が起きたか読めない
    shelfBody.scrollTop = 0;
    var doc = document.scrollingElement || document.documentElement;
    if (doc) doc.scrollTop = 0;
  }

  // 紙の中身は開くたびに組み直す。札の一つずつに耳を付けると付け替えが要るので、
  // 入れ物の側で受けて data-token を持つ親を探す
  function bindTokens(root) {
    root.addEventListener('click', function (e) {
      var el = e.target && e.target.closest ? e.target.closest('[data-token]') : null;
      if (!el || !root.contains(el)) return;
      filterBy(el.getAttribute('data-token'));
    });
  }
  bindTokens(sheetFacts);
  bindTokens(tagList);

  function openSheet(item) {
    // 作者フォルダの札に紙は無い。どの道から来ても棚へ潜るだけ (念のための受け)
    if (item && item.folder) { filterBy('folder:' + item.folder); return; }
    sheetItem = item;
    var extras = document.getElementById('pixivPhoneExtras');
    if (!extras && window.BUNKO.host) {
      extras = document.createElement('div'); extras.id = 'pixivPhoneExtras';
      extras.addEventListener('click', function(e) {
        var external=e.target.closest('[data-caption-url]');
        if(external){e.preventDefault();window.BUNKO.host.openCaptionUrl(external.dataset.captionUrl);return;}
        var link=e.target.closest('[data-caption-work]');
        if (link) { e.preventDefault(); closeSheet(); sheet.scrollTop=0; window.BUNKO.host.relatedDetail(link.dataset.captionWork); }
      });
      document.getElementById('sheetActs').before(extras);
    }
    if (extras) {
      document.getElementById('tagList').after(extras);
      extras.innerHTML = window.BUNKO.host.extraMarkup(item);
      var relatedBox = document.getElementById('pixivPhoneRelated');
      if (!relatedBox) {
        relatedBox = document.createElement('div'); relatedBox.id = 'pixivPhoneRelated';
        document.getElementById('sheetActs').after(relatedBox);
        relatedBox.addEventListener('contextmenu', function(e){var row=e.target.closest('[data-related-detail]');if(row){e.preventDefault();window.BUNKO.host.readRelated(row.dataset.relatedDetail);}});
        relatedBox.addEventListener('click', function(e) {
          var row = e.target.closest('[data-related-detail]');
          if (row) { closeSheet(); sheet.scrollTop = 0; window.BUNKO.host.relatedDetail(row.dataset.relatedDetail); }
        });
      }
      relatedBox.innerHTML = window.BUNKO.host.relatedMarkup(item);
      window.BUNKO.host.loadRelated(item, relatedBox);
    }

    wantedId = item.id;

    sheetCover.textContent = '';
    var img = document.createElement('img');
    img.className = 'coverImg';
    img.decoding = 'async';
    img.src = coverUrl(item.id);
    img.alt = '';
    sheetCover.appendChild(img);
    sheetCover.insertAdjacentHTML('beforeend', pageCountBadge(item));

    sheetTitle.textContent = item.title || '';

    var stars = '';
    for (var s = 1; s <= 5; s += 1) stars += star(s <= (item.star || 0));
    sheetStars.innerHTML = item.star ? stars : '';

    // 公開日が分かっていればそれを、無ければ手元に入れた日を
    sheetDate.textContent = ymd(item.publishedDate || item.addedDate);

    // 作者とサークルは対なので同じ行に。原作とキャラは長いことがあるので行を分ける
    var lines = [
      fact('by', item.artists, 'artist') + fact('group', item.groups, 'group'),
      fact('series', item.series, 'series'),
      fact('chara', item.characters, 'character'),
      // 源泉の印は角に置かず紙の一行に (棚に出すのは表紙と題だけ、の約束)
      item.source === 'pixiv' ? '<div class="fact"><span class="factVals">pixiv</span></div>' : ''
    ];
    sheetFacts.innerHTML = lines
      .filter(function (line) { return line; })
      .map(function (line) { return '<div class="factLine">' + line + '</div>'; })
      .join('');

    // タグは畳んだまま出す。枚数だけ先に見せて、開くかどうかを決めてもらう
    var tags = item.tags || [];
    // 中身のある釦だけを出す。display を直に触るのは、この二つが
    // 様式で display を持っていて hidden だけでは消えないため (机上版と同じ罠)
    tagToggle.style.display = tags.length ? '' : 'none';
    tagCount.textContent = 'タグ ' + tags.length;
    tagList.innerHTML = tags.map(function (t) {
      var type = (t && t.type) ? String(t.type) : '';
      var name = (t && t.name) ? t.name : t;
      // 見せるのは日本語札 (机上版の tag_labels がそのまま来る)。道具は name のまま
      var face = (t && t.label) ? t.label : name;
      // 接頭辞は型そのもの (female:/male:…)。型を持たないタグは tag: で引ける
      return '<button class="tag' + (type ? ' ' + esc(type) : '') + '" type="button" '
        + 'data-token="' + esc(token(type || 'tag', name, t)) + '">' + esc(face) + '</button>';
    }).join('');
    closeTags();

    // 帯の埋まり具合が、どこまで読んだか。進み具合の数字は出さない
    var mark = state.reading[item.id];
    var total = (mark && mark.pageCount) || item.pageCount || 0;
    var done = Boolean(mark && mark.finished);
    var at = mark ? Math.min(mark.page + 1, total) : 0;
    pagesFill.style.width = (total ? Math.round((done ? total : at) / total * 100) : 0) + '%';
    pagesFill.className = 'pagesFill' + (done ? ' done' : '');
    // 総頁数だけは出してよい。厚みは手に取れば分かるもので、隠しても得が無い
    pagesTotal.textContent = '';

    // 読み終えた本に「続き」は無い。そのまま頭から開く釦にする
    var partway = Boolean(mark && !mark.finished && mark.page > 0);
    btnReadLabel.textContent = partway ? '続きから読む' : (done ? '最初から読む' : '読む');
    btnRestart.style.display = partway ? '' : 'none';
    if (btnSave) btnSave.style.display = item.owned ? 'none' : '';

    show(sheet, 'sheeted');
    startDwell(item.id);
  }

  function closeSheet(keepFrame) {
    clearTimeout(dwellTimer);
    sheetItem = null;
    hide(sheet, 'sheeted');
    if (window.BUNKO.host && keepFrame !== true) window.BUNKO.host.closed();
  }

  // 紙を経ずに読む画面へ。帯の一突きはここへ来る (閉じる紙が無い)
  function toReaderDirect(item, start) {
    if (!item) return;
    if (window.BUNKO.host) window.BUNKO.host.reading();
    wantedId = item.id; // 温めが返ってくるのを待っていることがある
    if (window.BUNKO.reader && window.BUNKO.reader.open) {
      window.BUNKO.reader.open(item, { start: start });
    }
  }

  function toReader(start) {
    var item = sheetItem;
    if (!item) return;
    closeSheet(true);
    toReaderDirect(item, start);
  }

  btnRead.addEventListener('click', function () {
    var mark = sheetItem ? state.reading[sheetItem.id] : null;
    // 読了済みは頭から。最後の頁を開き直しても仕方がない
    toReader(mark && mark.finished ? 'first' : 'resume');
  });
  btnRestart.addEventListener('click', function () { toReader('first'); });

  // ── 滞在プリフェッチ ──────────────────────────────────────────
  // 母艦の焼き場は一冊しか抱えられない。ちらっと開いて閉じただけの本で
  // 焼き場を占めると、本命を開いたときに待たされる。だから 300ms 居た本だけ頼む

  var dwellTimer = null;

  function startDwell(id) {
    if (window.BUNKO.host) return;
    clearTimeout(dwellTimer);
    dwellTimer = setTimeout(function () {
      api('/api/book/' + encodeURIComponent(id))
        .then(function (data) {
          if (wantedId !== id) return; // もう別の本へ移っていた
          var mark = data.reading;
          var at = (mark && !mark.finished) ? (mark.page || 0) : 0;
          var img = new Image();
          img.decoding = 'async';
          img.src = '/api/book/' + encodeURIComponent(id) + '/page/' + at
            + '?w=' + widthOnce() + '&v=' + (data.version || 0);
          warmHold = img;
        })
        .catch(function () { /* 温まらなくても読める */ });
    }, DWELL_MS);
  }

  // ── 出入り ────────────────────────────────────────────────────
  // hidden で消えている物は動かない。一度出して、置き場所を確定させてから
  // 走らせる (挟まないと、下からせり上がる代わりに いきなり現れる)

  var hideTimers = {};

  function show(el, flag) {
    clearTimeout(hideTimers[flag]);
    scrim.hidden = false;
    el.hidden = false;
    void el.offsetWidth;
    host.classList.add(flag);
    el.classList.add('on');
    scrim.classList.add('on');
  }

  function hide(el, flag) {
    host.classList.remove(flag);
    el.classList.remove('on');
    var stillOpen = host.classList.contains('sheeted') || host.classList.contains('filtersOn');
    if (!stillOpen) scrim.classList.remove('on');
    clearTimeout(hideTimers[flag]);
    // 沈み切ってから隠す。先に hidden を張ると、去り際が見えない
    hideTimers[flag] = setTimeout(function () {
      if (host.classList.contains(flag)) return;
      el.hidden = true;
      if (!host.classList.contains('sheeted') && !host.classList.contains('filtersOn')) {
        scrim.hidden = true;
      }
    }, SHEET_MS);
  }

  function closeAll() {
    if (host.classList.contains('filtersOn')) closeDrum();
    if (host.classList.contains('sheeted')) closeSheet();
  }

  scrim.addEventListener('click', function (event) {
    event.preventDefault();
    event.stopPropagation();
    closeAll();
  });

  // 閉じるための一突きが、そのまま下の札を開いてしまわないように、
  // 続けて来る click を一度だけ食う (幕の上でしか起きないが、念のため)
  function swallowNextClick() {
    var timer = null;
    function once(ev) {
      ev.stopPropagation();
      ev.preventDefault();
      clearTimeout(timer);
      document.removeEventListener('click', once, true);
    }
    document.addEventListener('click', once, true);
    timer = setTimeout(function () { document.removeEventListener('click', once, true); }, 400);
  }

  // 幕に触れないときのための受け皿。外を突いたら閉じる、という約束を絵に頼らない
  document.addEventListener('pointerdown', function (e) {
    // In a frame, wait for click: hiding on pointerdown sends pointerup to the parent list.
    if (window.BUNKO.host) return;
    if (!host.classList.contains('sheeted') && !host.classList.contains('filtersOn')) return;
    if (drum.contains(e.target) || sheet.contains(e.target)) return;
    closeAll();
    swallowNextClick();
  }, true);

  // ── 紙と胴を下に払って閉じる ──────────────────────────────────
  //
  // 下から出た物は下へ返す。幕を狙って突くより、出て来た向きへ払う方が短い。
  // 掴んでいる間は指の位置がそのまま紙の位置になり、離した所で「閉じる」か
  // 「戻る」かが決まる。上へは動かさない: 紙は元の高さより上には来ない

  var TAP_GUARD = '.btn, .factVal, .tag, .tagToggle, .iconBtn';

  function hasNear(target, sel) {
    return Boolean(target && target.closest && target.closest(sel));
  }

  // canStart は「この指で払ってよいか」の判じ。胴と紙で答えが違う
  function bindSwipeDown(el, onClose, canStart) {
    var g = { armed: false, on: false, y0: 0, dy: 0, held: false };

    el.addEventListener('touchstart', function (e) {
      g.armed = false;
      g.on = false;
      g.dy = 0;
      if (e.touches.length !== 1) return;
      if (canStart && !canStart(e.target)) return;
      // 釦の上で始まった指は、まず押下として扱う (動いた分で引きに変わる)
      g.held = hasNear(e.target, TAP_GUARD);
      g.y0 = e.touches[0].clientY;
      g.armed = true;
    }, { passive: true });

    el.addEventListener('touchmove', function (e) {
      if (!g.armed) return;
      if (e.touches.length !== 1) { g.armed = false; return; }
      var dy = e.touches[0].clientY - g.y0;
      if (!g.on) {
        if (dy <= 0) { g.armed = false; return; }      // 上へは払えない
        if (g.held && dy < DRAG_SLOP) return;          // まだ押下のうち
        g.on = true;
        // 引いている間だけ開閉の間合いを殺す。挟まったままだと、紙が指に
        // 400ms 遅れて付いてくる (掴んでいる物には見えない)
        el.style.transition = 'none';
        // 釦から引き始めた指は、離した後の click まで届かせない
        if (g.held) swallowNextClick();
      }
      g.dy = Math.max(0, dy);
      // 紙の中身の送りには渡さない。ここは払っている指
      e.preventDefault();
      el.style.transform = 'translateY(' + g.dy + 'px)';
    }, { passive: false });

    function finish(cancelled) {
      g.armed = false;
      if (!g.on) return;
      g.on = false;
      var closing = !cancelled && g.dy > CLOSE_TRIP;
      // 間合いを戻し、translateY は必ず外す。閉じる時も外してから hide に渡し、
      // 沈む動きを一つにする (二重に持たせると、途中で速さが変わって見える)。
      // 届かなかった時は、様式の translateY(0) へ --t-sheet で戻る
      el.style.transition = '';
      el.style.transform = '';
      if (closing) onClose();
    }

    el.addEventListener('touchend', function () { finish(false); });
    el.addEventListener('touchcancel', function () { finish(true); });
  }

  // 紙は全面から掴んでよい。ただし中身を送っている途中 (上端に居ない) は
  // 送りが先: そこで払うと、読みかけの位置まで一緒に戻ってしまう
  bindSwipeDown(sheet, closeSheet, function () { return sheet.scrollTop <= 0; });

  // 胴の本体 (wheelTrack) は回す場所。縦の指はホイールに譲り、
  // 摘みと頭からだけ払える。ここを分けないと、選ぼうとして胴が落ちる
  bindSwipeDown(drum, closeDrum, function (t) {
    return hasNear(t, '.grabber, .filterHead');
  });

  // ── 読む画面からの帰り ────────────────────────────────────────

  // 読み手から理由を出してもらう口。棚の note を借りるので帯は増えない。
  // retry を渡すと「もう一度」を添える (項目 9-10)
  function say(text, opts) {
    if (!note) return;
    note.textContent = String(text || '');
    var again = opts && opts.retry;
    if (!again) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'note-retry';
    btn.textContent = 'もう一度';
    btn.addEventListener('click', function () {
      note.textContent = '';
      again();
    });
    note.appendChild(btn);
  }

  window.BUNKO.shelf = {
    openDetail: function (item, mark) { state.reading[item.id] = mark; openSheet(item); },
    closeDetail: closeSheet,
    say: function (message, options) { if (window.BUNKO.host) window.BUNKO.host.say(message); else say(message, options); },
    // 読む画面の継ぎ目が引く「棚の並びの一つ隣」(机上版の「開いた一覧での次の行」と同じ)。
    // 格子は読める本しか並べていないので、飛ばす判定は要らない
    neighbor: function (id, side) {
      if (window.BUNKO.host) return window.BUNKO.host.neighbor(id, side);
      var cards = grid.children;
      for (var i = 0; i < cards.length; i += 1) {
        if (cards[i].dataset.id !== String(id)) continue;
        var to = i + (side > 0 ? 1 : -1);
        if (to < 0 || to >= cards.length) return null;
        return seen[cards[to].dataset.id] || null;
      }
      return null;
    },

    // C が本を閉じたときに呼ぶ。一覧は引き直さない: 並びも絞りも変わっていないのに
    // 棚が組み直されると、読み終えて戻ってきた場所を見失う
    readerClosed: function (mark) {
      if (window.BUNKO.host) { window.BUNKO.host.closed(); return; }
      if (!mark || mark.id == null) return;
      state.reading[mark.id] = {
        page: mark.page || 0,
        pageCount: mark.pageCount || 0,
        updatedAt: Date.now(),   // 母艦の栞と同じ数値で持つ
        finished: Boolean(mark.finished)
      };
      wantedId = null;
      [].forEach.call(grid.children, paintDogear);
      paintRecent(recentFromMarks());
    }
  };

  // ── 棚の履歴 ──────────────────────────────────────────────────
  //
  // 棚には URL が無い (ずっと一枚の reader.html) ので、「今どこを見ているか」は
  // state の四つ {src, q, type, sort} が全て。それをそのまま history の札に積む。
  // 積むのは棚が組み変わった所だけ — 打鍵の一文字ずつや、胴を回している途中の
  // 通過点まで残すと、戻る釦を十回押しても元の棚に着かない。
  //
  // 読む画面 (read.js) も自分の札 {bunko:'reader'} を積む。互いの popstate は
  // 自分の札だけを見て、他人の札には手を出さない — どちらの耳も独立に鳴る

  var histLock = false;   // 復元中の目印。戻した状態をまた積まないための一本
  var histKey = '';       // 今居る札の写し (文字列にしたもの)

  function snapshot() {
    return {
      src: state.src, q: state.q, type: state.type, sort: state.sort,
      // 向き・★絞り・ランダムの種も棚の姿のうち。種を積むから、戻ったとき
      // 同じランダムの並びに帰れる
      dir: state.dir, star4: state.star4, seed: state.seed,
    };
  }

  // 写しの同じ/違うは文字列で見る。改行は検索語に入り得ない区切り
  function snapKey(s) {
    return [s.src, s.q, s.type, s.sort, s.dir, s.star4 ? '1' : '', s.seed].join('\n');
  }

  // replaceTop を立てると、一区切りを新しく積まずに今の札を書き換える。
  // 語から語への打ち直しがこれ (積むと電話の「戻る」が語を一字ずつ遡る)
  function pushShelf(replaceTop) {
    if (histLock) return;
    var snap = snapshot();
    var key = snapKey(snap);
    if (key === histKey) return;   // 同じ棚を二度積まない
    histKey = key;
    try {
      if (replaceTop) history.replaceState({ shelf: snap }, '');
      else history.pushState({ shelf: snap }, '');
    } catch (e) { /* 積めなくても棚は引ける */ }
  }

  window.addEventListener('popstate', function (e) {
    var snap = e.state && e.state.shelf;
    // 読む画面の札や、据える前から積まれていた素の null はこちらの分ではない
    if (!snap) return;
    var key = snapKey(snap);
    // 本を閉じた戻りは、下に居るのが今と同じ棚の札。ここで組み直すと、
    // 読み終えて帰ってきた場所を見失う (readerClosed が守っているものと同じ)
    if (key === histKey) return;
    histKey = key;

    var wasSrc = state.src;
    histLock = true;
    try {
      state.src = snap.src === 'paw' ? 'paw' : 'hitomi';
      state.q = snap.q || '';
      state.type = snap.type || '';
      state.sort = snap.sort || 'added';
      state.dir = snap.dir === 'asc' ? 'asc' : 'desc';
      state.star4 = Boolean(snap.star4);
      if (snap.seed) state.seed = snap.seed;
      // 覚えている値も戻した先に合わせる。画面と食い違ったまま置くと、
      // 次に開き直した時だけ別の棚が出てくる
      write('bunko.src', state.src);
      write('bunko.type', state.type);
      write('bunko.sort', state.sort);
      write('bunko.dir', state.dir);
      write('bunko.star4', state.star4 ? '1' : '');

      closeSuggest();
      qInput.value = state.q;
      syncClear();
      markFields();
      applySrc();
      if (state.src !== wasSrc) paintSrcName();
      reset();
      // 別の棚が組まれるので頭から見せる (素性を突いた時と同じ寄せ方)
      shelfBody.scrollTop = 0;
      var doc = document.scrollingElement || document.documentElement;
      if (doc) doc.scrollTop = 0;
    } finally {
      histLock = false;
    }
  });

  // ── 浮きの戻る/進む (ホーム画面に据えた時だけ) ────────────────
  //
  // 据えると全画面になり、Safari の戻る/進むごと消える。その代わりを左下に置く。
  // Safari の帯と同じで、下へ送っている間は退き、上へ戻すか上端で現れる —
  // 見ている棚の上に常駐させない。z-index は 18: 紙 (30) と読む画面 (40) の下なので、
  // 一冊を開いている間も本を読んでいる間も、何もしなくても隠れる

  var standalone = navigator.standalone === true
    || Boolean(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);

  if (standalone && !window.BUNKO.host) {
    var nav = document.createElement('div');
    nav.className = 'navPair';
    // 印は矢印ではなく山形。丸の中に置くと Safari の釦と同じ顔になる
    nav.innerHTML = ['back', 'fwd'].map(function (side) {
      var d = side === 'back' ? 'M11.5 4L6 9.5 11.5 15' : 'M7.5 4L13 9.5 7.5 15';
      return '<button class="navBtn" type="button" data-nav="' + side + '" '
        + 'aria-label="' + (side === 'back' ? '戻る' : '進む') + '">'
        + '<svg width="19" height="19" viewBox="0 0 19 19" fill="none" stroke="currentColor" '
        + 'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        + '<path d="' + d + '"/></svg></button>';
    }).join('');
    host.appendChild(nav);

    // 押したら履歴を一つ動かすだけ。行き先に何が居るか (棚か本か) は
    // それぞれの popstate が答える — ここで賢く判じると、答えが二重になる
    nav.addEventListener('click', function (e) {
      var el = e.target && e.target.closest ? e.target.closest('[data-nav]') : null;
      if (!el) return;
      if (el.getAttribute('data-nav') === 'back') history.back();
      else history.forward();
    });

    // これ以上進めない時は › を隠す (Safari と同じ)。ブラウザは「進めるか」を
    // 教えてくれないので、押し込みに番号 (navi) を焼き込んで自前で数える。
    // pushState 自体を包むので、読む画面の押し込み (read.js) もここを通る
    var navPos = 0;
    var navMax = 0;

    function paintFwd() {
      nav.classList.toggle('noFwd', navPos >= navMax);
    }

    var rawPush = history.pushState.bind(history);
    history.pushState = function (data, title, url) {
      navPos += 1;
      navMax = navPos;   // 進む先は書き潰された
      rawPush(Object.assign({}, data || {}, { navi: navPos }), title, url);
      paintFwd();
    };
    window.addEventListener('popstate', function (e) {
      navPos = (e.state && typeof e.state.navi === 'number') ? e.state.navi : 0;
      paintFwd();
    });
    paintFwd();

    var navY = 0;
    var navAway = false;

    function docTop() {
      var doc = document.scrollingElement || document.documentElement;
      return doc ? (doc.scrollTop || 0) : 0;
    }

    function paintNav(away) {
      if (away === navAway) return;
      navAway = away;
      nav.classList.toggle('away', away);
    }

    // 棚は文書スクロール (Safari の帯を畳ませるため)。見るのもそちらの位置。
    // 一往復ぶんの揺れで出たり消えたりしないよう、8px 動くまでは前の答えのまま
    window.addEventListener('scroll', function () {
      var y = docTop();
      if (y <= 0) { navY = y; paintNav(false); return; }
      var dy = y - navY;
      if (Math.abs(dy) < NAV_SLOP) return;
      navY = y;
      paintNav(dy > 0);
    }, { passive: true });
  }

  // ── 起こす ────────────────────────────────────────────────────

  markFields();
  applySrc();   // 覚えていた台帳が pawchive なら、種別の釦は最初から伏せておく

  // 最初の一枚にも札を貼る。貼らないと、一度絞ってから戻った時に素の null が来て、
  // 誰も受けないまま棚が絞られたまま残る (据えた窓では出口も無い)
  histKey = snapKey(snapshot());
  try { history.replaceState({ shelf: snapshot() }, ''); } catch (e) { /* 札が貼れなくても棚は引ける */ }

  // 栞を先に引いてから棚を組む。後から引くと、並べ終えた札の角を折り直すことになる。
  // 引き直し (棚を下に引く) と同じ順なので、起こすのも同じ一本を通す。
  // 試験は harness の印を立ててから読む (棚を引きに行く前に掴む)
  if (!globalThis.__BUNKO_HARNESS__ && !window.BUNKO.host) refreshAll();
})();
