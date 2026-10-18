/* Home (源泉横断の作者の一覧と作者頁) の画面側。仕様は docs/home-tab-spec-2026-09-23.md、
   母屋の側は src/lib/home-authors.js (一覧は search の口の source:'home'、作者頁と結びは home の口)。

   app.js より先に読むが、app.js の関数と const (state / els / imgUrl / cardMarkup / countBadge /
   openDetail / renderDetail …) は呼ばれた時に引く (bunko-ui.js と同じ作法)。
   app.js からは window.BunkoHome?.… の小さな継ぎ目からだけ呼ばれる:
     cardMarkup   一覧の作者の見出し            detailMarkup  詳細の板の中身
     press        見出しの押し分け (左 と Enter = 詳細、右 と ダブルクリック = 作者頁)
     sync         源泉と語に合わせて Home の顔 (道具の出し入れ・作者頁) を整える
     findBook     作者頁の本 (一覧の外に並ぶ) を詳細・読むに渡す
     readingOrder 読む画面の「次の本」を作者頁の並びで
     toggleOwnedOnly / ownedOnlyActive  右上の「所持作品」釦 (Home では所持作品のスコープへ移らず、
                  作者頁を所持の本だけにする旗。設定の homeOwnedOnly に覚える)
     refresh      表示の切り替え (所持の版違いを隠す・所持を隠す・すべて) を作者頁に写す

   詳細の板の顔 (一番上の表紙) を押すと、その作者の所持の本の表紙を並べた板を顔の下に重ね、見出しの表紙を選べる
   (一覧の見出し・詳細・作者頁の頭が同じ表紙になる。先頭の「自動」で一番新しい本の表紙に戻す)。

   Home で書いた操作 (結ぶ・外す・違う・★・持ち込みの出どころ・名前・表紙) は Ctrl+Z で元に戻し、Ctrl+Shift+Z (Ctrl+Y) でやり直す。
   戻す手順は母屋が書く口の返りに添える (undo)。画面はそれを積んで、home の口の undo に渡すだけ

   作者頁の本は所持の本と網の作品 (hitomi / Pawchive / pixiv) を混ぜ、home-bundle.js で源泉を跨いで束ねる
   (同じ作品の版違い・見本・告知を代表の一冊に畳む)。畳んだ物は本体の札の「同」「重」と同じ旗で、
   本体の表示の切り替え (isCardHidden) がそのまま効く

   2026-09-27 の作り直し (docs/ui-home-author-2026-09-27.md、案 2 改): 見出しは表紙三枚の扇 (顔を正面、次に新しい所持の本二冊を
   傾けて後ろ。触れると開く)、一覧は揃え。一覧の上に「最近の動き」の帯 (一頁目の返りの overview から。2 週間に入れた本がある人だけ)。
   作者頁は 頭 (扇・名・数の札) → ★の高い本 (多くて 5 冊、しばらく読んでいない物から) → 公開時期 (年 / 月の段。新作に「新」の印)。
   本の並びは表示の設定に従い、ウォーターフォールの時は本体と同じ流しで敷く (layoutFlow)。
   縦の年表の軸はやめた。作者頁を開くと、押した所の絵が頭の扇へ飛ぶ (丸い顔は丸から角へ) */
window.BunkoHome = (() => {
  'use strict';

  const SOURCE = 'home';
  // 詳細の行と見出しの印に出すサイト。並びと鍵は母屋の home-authors の SITE_KEYS と同じ
  // (test/cross-source が突き合わせる)。アイコンは各サイトのファビコンを同梱した物 (網から取らない)
  const SITES = [
    { key: 'pixiv', label: 'pixiv', icon: 'icons/sites/pixiv.ico', hint: 'https://www.pixiv.net/users/…' },
    { key: 'pawchive', label: 'Pawchive', icon: 'icons/sites/pawchive.png', hint: 'https://pawchive.pw/fanbox/user/…' },
    { key: 'hitomi', label: 'hitomi', icon: 'icons/sites/hitomi.png', hint: 'https://hitomi.la/artist/…-all.html' },
    { key: 'nhentai', label: 'nhentai', icon: 'icons/sites/nhentai.png', hint: 'https://nhentai.net/artist/…/' },
  ];
  const SITE_BY_KEY = new Map(SITES.map((site) => [site.key, site]));
  // 本の出どころの印 (題の頭・作者頁の頭のサイトの釦・見出しの左下の帯)。持ち込みの本は、利用者が出どころを
  // 決めるとそのアイコン (Discord)。決めていなければ ?
  const ORIGIN_SITES = [
    ...SITES.filter((site) => site.key !== 'nhentai'),
    { key: 'discord', label: 'Discord', icon: 'icons/sites/discord.png' },
  ];
  const ORIGIN_BY_KEY = new Map(ORIGIN_SITES.map((site) => [site.key, site]));
  const ORIGIN_LABEL = { pixiv: 'pixiv', pawchive: 'Pawchive', hitomi: 'hitomi', discord: 'Discord', local: '持ち込み' };
  // 作者頁の網の作品を引く源泉。並びと鍵は母屋の home-authors の WEB_SITES と同じ (test/cross-source が突き合わせる)。
  // limit は母屋の頁の幅 × 上限 (これより古い物は引かない)
  const WEB_SITES = [
    { key: 'hitomi', label: 'hitomi', limit: 1200 },
    { key: 'pawchive', label: 'Pawchive', limit: 500 },
    { key: 'pixiv', label: 'pixiv', limit: 300 },
  ];
  // 畳んだ物の印 (全て表示の時に見える)。代表が所持なら所持の版違い、そうでなければ重なり
  const FOLD_LABEL = { similar: '版違い', dupe: '重複' };
  const FOLD_TITLE = { similar: '所持の本の版違い・見本 (所持の版違いを隠す で畳む)', dupe: '同じ作品の別の版 (所持の版違いを隠す で代表の一冊に畳む)' };
  // 作者頁ごとの見え方 (出すサイトと年 / 月)。機体ごとの好みなので localStorage。覚える作者の数に上限
  const VIEW_KEY = 'bunko.homeAuthorView';
  const VIEW_MAX = 400;
  // 作者頁の頭のサイトの釦 (本の出どころ)。持ち込み (local) は ? の釦
  const ORIGINS = ['pixiv', 'pawchive', 'hitomi', 'discord', 'local'];
  // 作者頁の控え (本の札の形) を覚えておく人数
  const CACHE_MAX = 24;
  const LINK_REASONS = {
    folder: '作者フォルダの無い作者には結べません',
    fixed: 'この名乗りは外せません',
    missing: 'その結びはもう外れています',
    store: '結びを書けませんでした',
    author: 'この作者は一覧から外れました',
  };
  const LINK_DONE = {
    save: '結びました', accept: '結びました', reject: '候補から外しました', unlink: '外しました',
  };
  // 元に戻す (Ctrl+Z) の札の名 (トーストの言葉)
  const UNDO_LABEL = {
    save: '結び', accept: '結び', reject: '「違う」', unlink: '外し', rate: '★', origin: '持ち込みの出どころ', rename: '名前', cover: '表紙',
  };
  // 名前を変える鉛筆の絵
  const PENCIL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'
    + '<path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
  const UNDO_MAX = 50;
  // 詳細の結びの釦の言葉 (絵は鎖。言葉は title と aria-label で言う)
  const LINK_ACT = {
    save: '結ぶ', accept: '結ぶ', reject: '違う (候補から外す)', unlink: '外す',
  };

  // 白い丸に黒の ?。小さくても読める形 (未確定の候補・出どころの分からない本)
  const QUESTION = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7.5" fill="#fff"/>'
    + '<path d="M5.9 6.1a2.15 2.15 0 1 1 3 2c-.62.3-.95.7-.95 1.35v.3" fill="none" stroke="#111" stroke-width="1.7" stroke-linecap="round"/>'
    + '<circle cx="7.95" cy="11.9" r="1.05" fill="#111"/></svg>';

  let ready = false;
  let view = null;
  // 作者頁の控え: 作者の id → { author, books, handles, signature, web, webLoading, webFailed }
  const entries = new Map();
  // '@名前' → 作者の id
  const queryIds = new Map();
  // '@名前 語' → 作品の検索の絞り ({ words, hits: Set<所持の本の id>, count }。語の無い '@名前' は null)。
  // 作者頁の控え (entries) は語で分けない: 本は全部持ち、当たりの印だけを語ごとに覚える
  const queryFilters = new Map();
  const FILTER_MAX = 64;
  // 詳細を開いた時に先に引いている作者 (二重に引かない): 作者の id → 引き終わりの約束 (表紙を選ぶ板が待つ)
  const prefetching = new Map();
  let shown = null;
  let fetchToken = 0;
  // 作者頁に今並んでいる本 (所持と hitomi の網を束ねて日付順) と、id → 本の札の形
  let books = [];
  let bookIndex = new Map();
  let groupBy = 'year';
  let viewStore = null;
  // ダブルクリックは click の二度目と dblclick の二度届く: 作者頁は一度だけ開く
  let lastOpen = { id: '', at: 0 };
  // 元に戻す / やり直すの積み ({ id: 作者, steps, label })
  const undoStack = [];
  const redoStack = [];
  // 今描いている作者頁の表示の鍵 (所持作品だけ・表示の切り替え・AI を伏せる・網の届いた数)。変わった時だけ描き直す
  let renderedKey = '';
  // 一覧の頭: 一頁目の返りの overview ({ moving })。語の無い一覧の間だけ出す
  let lastOverview = null;
  const overviewById = new Map();
  let strip = null;
  // 作者頁を開く時に押した所の絵。頭の扇が描けたらそこへ飛ばす ({ id, rect, src, round, at })
  let pendingFly = null;
  const FLY_MS = 480;
  const FLY_EASE = 'cubic-bezier(.16,1,.3,1)';
  const FLY_TTL = 2500;
  // 飛んでいる間は作者頁を描き直さない (網の作品が届いても着いてから)。一回目の作者頁は描き込みが重く、重ねると駒が落ちる
  let flying = false;
  let renderAfterFly = false;
  // ★の高い本の冊数 (それより多い時は、しばらく読んでいない物から)
  const STAR_MAX = 12;

  function readViews() {
    if (viewStore) return viewStore;
    try {
      const raw = JSON.parse(localStorage.getItem(VIEW_KEY) || '{}');
      viewStore = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch {
      viewStore = {};
    }
    return viewStore;
  }

  // 作者頁の見え方。既定は全部のサイトを出し、年でまとめる
  function viewPrefs(id) {
    const row = readViews()[String(id)] || {};
    return {
      off: Array.isArray(row.off) ? row.off.filter((origin) => ORIGINS.includes(origin)) : [],
      group: row.group === 'month' ? 'month' : 'year',
    };
  }

  function saveViewPrefs(id, patch) {
    const store = readViews();
    const key = String(id);
    const next = { ...viewPrefs(key), ...patch };
    if (!next.off.length && next.group === 'year') delete store[key];
    else store[key] = { off: next.off, group: next.group, at: Date.now() };
    const keys = Object.keys(store);
    if (keys.length > VIEW_MAX) {
      keys.sort((a, b) => (Number(store[a].at) || 0) - (Number(store[b].at) || 0))
        .slice(0, keys.length - VIEW_MAX).forEach((old) => delete store[old]);
    }
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify(store));
    } catch {
      // 覚えられなくても切り替えそのものは効く
    }
  }

  function viewSignature(entry) {
    if (!entry || !entry.author) return '';
    const prefs = viewPrefs(entry.author.id);
    return `${prefs.group}:${prefs.off.join(',')}`;
  }

  function esc(value) {
    return escapeHtml(value == null ? '' : value);
  }

  function flag(name, on) {
    if (on) document.body.setAttribute(name, '');
    else document.body.removeAttribute(name);
  }

  function isHome(gallery) {
    return Boolean(gallery && gallery.source === SOURCE);
  }

  function onHome() {
    return state.source === SOURCE && !libraryScope();
  }

  // 右上の「所持作品」釦の Home での旗。入 = 作者頁は所持の本だけ (網へ出ない。本体の所持作品のスコープと同じ見え方)
  function ownedOnly() {
    return (state.settings || {}).homeOwnedOnly === true;
  }

  // Home に居て旗が立っている (app.js が釦の絵と #hide-owned の出し入れに使う)
  function ownedOnlyActive() {
    return ready && onHome() && ownedOnly();
  }

  // 作者頁の表示の切り替え。所持の本だけの時は伏せる物が無い (本体の所持作品のスコープと同じ)
  function pageMode() {
    return ownedOnly() ? 'none' : hideMode();
  }

  function viewKey(entry) {
    const filter = pageFilter();
    return [ownedOnly() ? 1 : 0, pageMode(), hideAiEnabled() ? 1 : 0, entry ? entry.version || 0 : 0, viewSignature(entry), filter ? filter.words : ''].join('|');
  }

  // 釦を押した。Home でなければ false (本体のスコープの切り替えに任せる)。
  // 所持作品のスコープへは移らない: 移ると源泉の並びが所持の三つに絞られ、Home ごと hitomi へ移されてしまう
  function toggleOwnedOnly() {
    if (!ready || !onHome()) return false;
    const before = ownedOnly();
    const next = !before;
    state.settings = { ...(state.settings || {}), homeOwnedOnly: next };
    fillScopeToggle();
    fillHideOwnedToggle();
    Promise.resolve(saveSetting({ homeOwnedOnly: next }, { announce: false })).then((ok) => {
      if (ok || ownedOnly() !== next) return;
      // 覚えられなかったら見た目も戻す (表示と覚えた値を食い違わせない)
      state.settings = { ...(state.settings || {}), homeOwnedOnly: before };
      fillScopeToggle();
      fillHideOwnedToggle();
    }).catch(() => {});
    return true;
  }

  // 表示の切り替えを作者頁に写す。本体の源泉の整えから何度も呼ばれるので、何も変わっていなければ描き直さない
  function refresh() {
    if (!ready || !shown || !view || view.hidden || !onHome()) return;
    if (renderedKey === viewKey(shown)) {
      // 表示の設定 (ウォーターフォール / 整列グリッド・表紙の大きさ) だけが変わった時は敷き直すだけ
      layoutFlow();
      return;
    }
    renderKeepingPlace();
    loadWeb(shown);
  }

  // ---- 作者頁の流し (ウォーターフォール) ----
  // 本体の一覧の流し (bunko-ui.js の renderWaterfall) は一覧の器 (#grid) だけを敷くので、作者頁の本の並び
  // (★の高い本と公開時期の段) は同じ計算 (BunkoUIModel.waterfall) でここが敷く。表紙の縦横比は本体が覚えた物を先に、
  // 無ければ作者頁で届いた絵から覚え、覚えるまでは本体と同じ仮の比 (寸法か shape、無ければ 1.414)。段ごとに独りで敷く
  const flowRatios = new Map();
  let flowFrame = 0;
  let flowWidth = 0;

  // Home の作者頁の表紙の大きさ (頁ごとに覚えた 'home:author'。無ければ前からの uiCoverSize)
  function authorCoverSize() {
    if (typeof coverSizeOf === 'function') return coverSizeOf('home:author');
    const settings = state.settings || {};
    return Number(settings.uiCoverSizes && settings.uiCoverSizes['home:author']) || Number(settings.uiCoverSize) || 152;
  }

  function flowOn() {
    const settings = state.settings || {};
    return (settings.uiLayout || 'flow') === 'flow' && state.zoom !== 0 && !els.grid.classList.contains('is-list')
      && Boolean(window.BunkoUIModel && typeof BunkoUIModel.waterfall === 'function');
  }

  function ratioKey(gallery) {
    return gallery ? `${gallery.source}:${gallery.id}` : '';
  }

  function flowRatio(gallery) {
    const key = ratioKey(gallery);
    if (!key) return null;
    if (flowRatios.has(key)) return flowRatios.get(key);
    const known = window.BunkoUI && typeof BunkoUI.coverRatio === 'function' ? BunkoUI.coverRatio(key) : null;
    return known || null;
  }

  function layoutFlow() {
    if (!view || view.hidden) return;
    const on = flowOn();
    const min = authorCoverSize();
    const captions = !(state.settings && state.settings.uiCaptions === false);
    for (const box of view.querySelectorAll('.home-av-cards')) {
      const cards = [...box.children].filter((node) => node.classList && node.classList.contains('card'));
      if (!on) {
        if (box.classList.contains('ui-waterfall')) {
          box.classList.remove('ui-waterfall');
          box.style.height = '';
          box._flowHeight = '';
          for (const card of cards) { card.style.cssText = ''; card._flowPos = ''; }
        }
        continue;
      }
      const width = box.clientWidth;
      if (!width || !cards.length) continue;
      box.classList.add('ui-waterfall');
      const items = cards.map((card) => bookIndex.get(String(card.dataset.id)) || { id: card.dataset.id, source: '' });
      // 全部を敷く (作者頁は段ごとに数十冊。窓の外を省くほどの数ではない)
      const plan = BunkoUIModel.waterfall(items, {
        width, min, gap: 20, caption: captions ? 66 : 0, scroll: 0, viewport: 1e9, overscan: 0, ratioFor: flowRatio,
      });
      // 位置の変わった札だけ書く。表紙が届くたびに敷き直すので、全部を書くと届く絵ごとに 200 枚ぶんの変化と
      // style の計算が走っていた (作者頁の送りで 1686 の変化・33ms 超のこま 6、2026-09-27)
      plan.positions.forEach((position, index) => {
        const card = cards[index];
        if (!card) return;
        const pos = `${position.left}|${position.top}|${position.width}|${position.height}|${position.coverHeight}`;
        if (card._flowPos === pos) return;
        card.style.cssText = `position:absolute;left:${position.left}px;top:${position.top}px;width:${position.width}px;height:${position.height}px;--ui-cover-height:${position.coverHeight}px`;
        card._flowPos = pos;
      });
      const height = `${plan.height}px`;
      if (box._flowHeight !== height) { box.style.height = height; box._flowHeight = height; }
    }
  }

  // 届いた表紙の縦横比を覚えて、敷き直す (一こまにまとめる。読んでいる所は動かさない)
  function onViewImageLoad(event) {
    const img = event.target;
    if (!img || img.tagName !== 'IMG' || !img.naturalWidth || !img.closest('.home-av-cards .cover')) return;
    const card = img.closest('.card');
    const gallery = card && bookIndex.get(String(card.dataset.id));
    const key = ratioKey(gallery);
    if (!key) return;
    const ratio = Math.max(0.45, Math.min(2.2, img.naturalHeight / img.naturalWidth));
    const before = flowRatio(gallery);
    if (before && Math.abs(before - ratio) < 0.001) return;
    flowRatios.set(key, ratio);
    if (flowRatios.size > 20000) flowRatios.delete(flowRatios.keys().next().value);
    if (!flowOn() || flowFrame) return;
    flowFrame = requestAnimationFrame(() => {
      flowFrame = 0;
      keepPlace(layoutFlow);
    });
  }

  function authorQuery() {
    const query = String(state.query || '').trim();
    return query.startsWith('@') ? query : '';
  }

  // ---- 一覧の作者の見出し ------------------------------------------------

  // 左下: つながっているサイトのアイコン (結び済みか、その源泉の所持の本があるサイトだけ。母屋が決める)。
  // 未確定の候補か出どころの分からない本がある時は ? を一つ
  function siteIcons(home) {
    const out = [];
    for (const key of home.sites || []) {
      const site = SITE_BY_KEY.get(key) || ORIGIN_BY_KEY.get(key);
      if (site) out.push(`<span class="home-site" title="${esc(site.label)}"><img src="${esc(site.icon)}" alt="${esc(site.label)}"></span>`);
    }
    if (home.unsure) {
      const title = out.length ? '未確定の候補か、出どころの分からない本がある' : 'つながっているサイトが分からない';
      out.push(`<span class="home-site is-unknown" title="${title}">${QUESTION}</span>`);
    }
    return out.join('');
  }

  // 扇の三枚: 顔を正面に、次に新しい所持の本二冊 (母屋の home.stack) を傾けて後ろに。後ろの二枚は遅れて読む
  function fanImages(home) {
    return fanFromUrls(
      home.cover ? imgUrl(home.cover, 0, 'big') : '',
      (Array.isArray(home.stack) ? home.stack : []).map((id) => imgUrl(id, 0, 'big')),
    );
  }

  // 扇の三枚を絵の URL から組む。Pawchive の作者の見出しも同じ物を使う (app.js の pawFanCardMarkup)
  function fanFromUrls(frontUrl, backUrls) {
    const front = frontUrl
      ? `<img class="home-fan-card is-front" src="${esc(frontUrl)}" alt="" loading="lazy" decoding="async" draggable="false" />`
      : `<span class="home-fan-card is-front is-blank">${coverBlank()}</span>`;
    const back = (Array.isArray(backUrls) ? backUrls : []).filter(Boolean).slice(0, 2)
      .map((url, index) => `<img class="home-fan-card is-back is-back-${index + 1}" src="${esc(url)}" alt="" loading="lazy" decoding="async" draggable="false" />`)
      .join('');
    return back + front;
  }

  // 見出しの下の数: 所持の冊数・発見の新作・作者の★。作品の検索の間は、当たった冊数を所持の冊数の前に
  // (語が作者の名に当たっただけの人は全部が当たりなので、いつもの冊数)
  function fanMeta(home) {
    const count = Number(home.count) || 0;
    const news = Number(home.newCount) || 0;
    const rating = Number(home.rating) || 0;
    const matched = home.matched == null || home.matchedByName ? null : Number(home.matched) || 0;
    return [
      matched != null
        ? `<span class="home-fan-count is-matched" title="検索に当たった本 ${matched} 冊 / 所持 ${count} 冊">${matched} / ${count} 冊</span>`
        : (count > 0 ? `<span class="home-fan-count" title="所持 ${count} 冊">${count} 冊</span>` : ''),
      news > 0 ? `<span class="home-fan-new" title="発見の新作 ${news} 冊">新作 +${news}</span>` : '',
      rating > 0 ? `<span class="home-fan-rating" title="作者の★ ${rating}">★${rating}</span>` : '',
    ].filter(Boolean).join('<span class="home-fan-dot" aria-hidden="true">·</span>');
  }

  // 一覧の見出し = 扇。題はサークルを先に (母屋が決める)、その下に作者名を小さく、その下に数。
  // サイトの帯は正面の表紙に重ねる (高さは取らない)。触れると扇が開く (transform だけ、見出しの高さは変わらない)
  function authorCardMarkup(gallery) {
    const home = gallery.home || {};
    return `<article class="card is-creator home-author home-fan" tabindex="0" role="button" data-id="${esc(gallery.id)}">`
      + `<div class="cover home-fan-cover">${fanImages(home)}<span class="home-sites">${siteIcons(home)}</span></div>`
      + `<div class="card-body"><div class="card-heading"><h3 class="card-title">${esc(gallery.title)}</h3></div>`
      // 本体の作者の見出しは .card-meta を伏せる (bunko-ui.css) ので、扇の字は別の器に置く
      + (home.authorLine ? `<p class="home-author-line"><span class="card-artist">${esc(home.authorLine)}</span></p>` : '')
      + `<p class="home-fan-meta">${fanMeta(home)}</p>`
      + '</div></article>';
  }

  // Home の一覧は揃え (扇は同じ大きさの札。流しにしない)。bunko-ui.js の流しの判定が訊く
  function uniformList() {
    return Boolean(typeof state !== 'undefined' && state && onHome());
  }

  // 表示の設定 (表紙の大きさ・ウォーターフォール / 整列グリッド・表示の大きさの段) が変わった時に本体から呼ばれる。
  // 作者頁の公開時期の段だけを新しい大きさで敷き直す (★の高い本は大きさが決まっている)
  function relayout() {
    if (!ready || !view || view.hidden || !onHome()) return;
    view.style.setProperty('--card-min', `${authorCoverSize()}px`);
    keepPlace(layoutFlow);
  }

  function cssId(id) {
    const value = String(id);
    return window.CSS && typeof CSS.escape === 'function' ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&');
  }

  // 作者頁を開く時に押した所の絵を控える (頭の扇が描けたら、そこから飛ばす)
  function captureFly(id, img, round = false) {
    pendingFly = null;
    if (!img || typeof img.getBoundingClientRect !== 'function') return;
    const rect = img.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    pendingFly = { id: String(id), rect, src: img.currentSrc || img.src || '', round, at: Date.now() };
  }

  // 作者頁を描き直す。飛んでいる間は着くまで待たせる
  function renderSoon() {
    if (flying) {
      renderAfterFly = true;
      return;
    }
    renderKeepingPlace();
  }

  function landed() {
    flying = false;
    if (!renderAfterFly) return;
    renderAfterFly = false;
    if (shown && view && !view.hidden && renderedKey !== viewKey(shown)) renderKeepingPlace();
  }

  // 押した所から頭の扇の正面へ、影武者の絵を飛ばす。動かすのは transform だけ (合成で描けるので主の流れが重くても駒が落ちない。
  // 角の丸みは動かさない)。絵の読み解きと作者頁の描き込みが済んでから二こま待って動かし始め、それまでは押した所に止めておく。
  // 着くまで本物は伏せる (窓が裏に回って動かない時も、1.5 秒で本物に戻す)
  function runFly(authorId) {
    const job = pendingFly;
    pendingFly = null;
    if (!job || job.id !== String(authorId) || Date.now() - job.at > FLY_TTL || !job.src || !view) return;
    if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const target = view.querySelector('.home-av-fan .home-fan-card.is-front');
    if (!target || typeof target.getBoundingClientRect !== 'function' || typeof document.body.animate !== 'function') return;
    const to = target.getBoundingClientRect();
    if (!to.width || !to.height) return;
    const ghost = document.createElement('img');
    ghost.className = 'home-fly';
    ghost.src = job.src;
    ghost.alt = '';
    const from = job.rect;
    const start = `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`;
    ghost.style.cssText = `left:${to.left}px;top:${to.top}px;width:${to.width}px;height:${to.height}px;transform:${start}`;
    if (job.round) ghost.classList.add('is-round');
    document.body.appendChild(ghost);
    target.style.opacity = '0';
    flying = true;
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(safety);
      target.style.opacity = '';
      ghost.remove();
      landed();
    };
    const safety = setTimeout(done, FLY_MS + 1000);
    const go = () => {
      if (finished) return;
      const anim = ghost.animate([{ transform: start }, { transform: 'none' }], { duration: FLY_MS, easing: FLY_EASE, fill: 'both' });
      anim.finished.then(done, done);
    };
    const decoded = typeof ghost.decode === 'function' ? ghost.decode().catch(() => {}) : Promise.resolve();
    decoded.then(() => requestAnimationFrame(() => requestAnimationFrame(go)));
  }

  // 見出しの押し分け。左 (と Enter) は詳細の板、右とダブルクリックは作者頁 (マウスの割り当てに依らない)。
  // Home の見出しでなければ false (本体の割り当てに任せる)
  function press(id, kind) {
    if (!ready || !onHome()) return false;
    const gallery = state.galleries.find((item) => sameId(item.id, id));
    if (!isHome(gallery)) return false;
    cancelLoupeTimer();
    hideLoupe(true);
    if (kind === 'left') {
      openDetail(gallery.id);
      return true;
    }
    if (kind === 'right' || kind === 'double') {
      const now = Date.now();
      if (lastOpen.id === String(gallery.id) && now - lastOpen.at < 600) return true;
      lastOpen = { id: String(gallery.id), at: now };
      captureFly(gallery.id, els.grid.querySelector(`.card[data-id="${cssId(gallery.id)}"] .home-fan-card.is-front`));
      // 作者頁へ移ったら詳細は用済み (ダブルクリックの一度目が開いた板も畳む)
      if (state.selected) {
        state.selected = null;
        renderDetail(null);
      }
      openAuthor(gallery);
    }
    return true;
  }

  // pawchive の作者棚と同じく、検索語で移る (@作者名)。作品の検索の一覧から移る時は、打っていた語を後ろに付けて
  // 作者頁を当たった本だけにする ('@作者名 語'。語を消せばその場で全部の本に戻る)
  function openAuthor(gallery) {
    const name = (gallery.home && gallery.home.name) || gallery.title;
    const words = searchWordsFor(gallery);
    openQuery(words ? `@${name} ${words}` : `@${name}`);
  }

  // 一覧が作品の検索の返り (見出しに当たった冊数がある) で、語が作者の名に当たっただけでない時の語
  function searchWordsFor(gallery) {
    const query = String(state.query || '').trim();
    const home = (gallery && gallery.home) || {};
    if (!query || query.startsWith('@') || home.matched == null || home.matchedByName) return '';
    return query;
  }

  // 作者頁の語 (@名前) で移る。詳細の板の「作者」から飛ぶ時も同じ道
  function openQuery(query) {
    clearTimeout(liveSearchTimer);
    hideSuggest();
    // 打ちながら引いた語 (live) は足跡に残っていない: 今の一覧を一つの足跡にしてから写す
    // (でないと語の返りの一覧が前の足跡 (語の無い一覧) に写り、戻った時に一覧は当たりのままで語の欄が空になる)
    const current = history[historyIndex];
    if (current && !current.view && current.query !== state.query && !state.loading) pushHistory();
    // 今の一覧を足跡に写しておく: マウスの戻るで、見ていた所へそのまま帰る
    snapshotCurrentHistory();
    state.query = query;
    els.query.value = state.query;
    syncQueryClear();
    renderSources();
    runSearch({ reset: true });
  }

  // ---- 詳細の板 (右クリック) ----------------------------------------------

  // 結びの釦は鎖の絵 (本体の手の紐付けと同じ絵): 結ぶ = 鎖、違う・外す = 切れた鎖。言葉は title と aria-label
  function actButton(op, site, url) {
    const icon = op === 'reject' || op === 'unlink' ? ICON.unlink : ICON.link;
    const label = LINK_ACT[op] || op;
    return `<button type="button" class="home-link-act is-${op}" data-home-link="${op}" data-home-site="${site}"${url ? ` data-home-url="${esc(url)}"` : ''} title="${esc(label)}" aria-label="${esc(label)}">${icon}</button>`;
  }

  // 結びの今の印: 結び済みは鎖 (水色)、候補は点線の鎖 (琥珀)。候補は名前が一致しただけか、突き合わせの答え
  function chainMark(candidate, suggested = false) {
    let label = '結び済み';
    if (candidate) label = suggested ? '候補 (突き合わせの答え。確かめて結ぶか違うを押す)' : '候補 (名前が一致しただけ)';
    return `<span class="home-chain${candidate ? ' is-candidate' : ''}" title="${label}" aria-label="${label}" role="img">${ICON.link}</span>`;
  }

  // 一つの行 (サイト)。どれも URL だけ (所持の冊数などは出さない)。
  //   結び済み: 鎖の印・URL (押すとサイトで開く)・外す (切れた鎖)
  //   候補:     点線の鎖の印・URL・結ぶ (鎖)・違う (切れた鎖)
  //   未結び:   URL の入力欄と結ぶ (鎖)
  function linkCell(home, site, readOnly) {
    const links = (home.links && home.links[site.key]) || [];
    const linkable = !readOnly && Boolean(home.linkable && home.linkable[site.key]);
    const parts = links.map((link) => {
      const candidate = link.state === 'candidate';
      const url = `<button type="button" class="home-url${candidate ? ' is-candidate' : ''}" data-site="${esc(link.url)}" title="サイトで開く">${esc(link.url)}</button>`;
      if (candidate) {
        const acts = linkable ? actButton('accept', site.key, link.url) + actButton('reject', site.key, link.url) : '';
        return `<span class="home-link">${chainMark(true, link.suggested === true)}${url}${acts}</span>`;
      }
      const acts = linkable && !link.fixed ? actButton('unlink', site.key, link.url) : '';
      return `<span class="home-link">${chainMark(false)}${url}${acts}</span>`;
    });
    if (!links.length) {
      if (linkable) parts.push(urlEdit(site));
      else parts.push('<span class="home-url-none">—</span>');
    } else if (linkable) {
      // もう一つ結ぶ (pixiv の別の垢・hitomi の別の名乗りを結んで同じ人に束ねる など)
      parts.push(`<button type="button" class="home-link-add" data-home-add="${site.key}" title="${esc(site.label)} の URL をもう一つ結ぶ" aria-label="${esc(site.label)} の URL をもう一つ結ぶ">＋</button>`);
    }
    return parts.join('');
  }

  function urlEdit(site) {
    return `<span class="home-url-edit"><input type="url" class="home-url-input" data-home-input="${site.key}" placeholder="${esc(site.hint)}" spellcheck="false" aria-label="${esc(site.label)} の URL" />${actButton('save', site.key, '')}</span>`;
  }

  // 持ち込みの本 (出どころの分からない本) の出どころ。決めると ? の印がそのサイトのアイコンになる
  function originPicker(home, readOnly) {
    const current = String(home.localOrigin || '');
    const discord = ORIGIN_BY_KEY.get('discord');
    const choices = [
      { value: '', label: '分からない', icon: QUESTION },
      { value: 'discord', label: 'Discord', icon: `<img src="${esc(discord.icon)}" alt="">` },
    ];
    return '<span class="home-origin-pick" role="group" aria-label="持ち込みの本の出どころ">'
      + choices.map((choice) => `<button type="button" class="home-origin-choice${choice.value === current ? ' is-on' : ''}" data-home-origin-set="${choice.value}" aria-pressed="${choice.value === current}" title="${esc(choice.label)}"${readOnly ? ' disabled' : ''}>${choice.icon}<span>${esc(choice.label)}</span></button>`).join('')
      + '</span>';
  }

  // 詳細の「サークル」「作者」。作者の名前は押せて、その作者の頁へ飛ぶ (母屋が語を添えた物だけ)
  function personList(list, kind) {
    return list.map((row) => {
      const cls = `home-person${row.candidate ? ' is-candidate' : ''}${row.minor ? ' is-minor' : ''}`;
      const hint = row.candidate ? ' (候補)' : '';
      if (kind === 'author' && row.query) {
        return `<button type="button" class="${cls} is-link" data-home-query="${esc(row.query)}" title="${esc(`${row.label} の頁へ${hint}`)}">${esc(row.label)}</button>`;
      }
      return `<span class="${cls}"${hint ? ' title="候補 (名前が一致しただけ)"' : ''}>${esc(row.label)}</span>`;
    }).join('');
  }

  // 詳細の名前。鉛筆で名前を決められる (「〜に統一」。サークル名や作者名より先に立つ)。決めた名前は元に戻せる
  function nameHeading(gallery, readOnly) {
    const home = gallery.home || {};
    const edit = readOnly || !home.linkable ? ''
      : `<button type="button" class="home-rename" data-home-rename title="名前を変える" aria-label="名前を変える">${PENCIL}</button>`;
    const reset = !readOnly && home.renamed
      ? '<button type="button" class="home-rename-reset" data-home-rename-reset title="決めた名前を外して元の名前に戻す">元の名前に戻す</button>' : '';
    return `<h2 class="home-name"><span class="home-name-text">${esc(gallery.title)}</span>${edit}</h2>${reset}`;
  }

  function nameEditor(gallery) {
    return `<span class="home-name-edit"><input type="text" class="home-name-input" data-home-name-input value="${esc(gallery.title)}" maxlength="80" aria-label="名前" spellcheck="false" />`
      + '<button type="button" class="home-link-act is-save" data-home-rename-save title="決める (Enter)" aria-label="決める">✓</button></span>';
  }

  // 名前を決める ('' で決めた名前を外す)。作者頁を開いている時は、新しい名前の作者頁へ移り直す
  async function runRename(gallery, name) {
    const before = String(gallery.title || '');
    let reply = null;
    try {
      reply = await window.hitomi.home({ action: 'rename', id: gallery.id, name });
    } catch (error) {
      reply = null;
      toast(`名前を変えられませんでした: ${ipcErrorText(error && error.message ? error.message : error)}`, { type: 'error' });
    }
    if (!reply || !reply.ok) {
      if (reply) toast('名前を変えられませんでした', { type: 'error' });
      if (state.selected && sameId(state.selected.id, gallery.id)) renderDetail(state.selected);
      return;
    }
    pushUndo(gallery.id, reply.undo, UNDO_LABEL.rename);
    const onPage = shown && shown.author && sameId(shown.author.id, gallery.id);
    // 作品の検索で絞った作者頁なら、新しい名前でも同じ語で絞る
    const filter = onPage ? pageFilter() : null;
    adoptAuthor(reply.author || null, gallery.id);
    const next = reply.author && reply.author.title;
    if (onPage && next && next !== before) openQuery(filter ? `@${next} ${filter.words}` : `@${next}`);
  }

  // 作者の★ (1〜5)。同じ星をもう一度押すと外す
  function starsMarkup(home, readOnly) {
    const rating = Number(home.rating) || 0;
    const editable = !readOnly && home.rateable !== false;
    const buttons = [1, 2, 3, 4, 5].map((n) => {
      const on = n <= rating;
      const title = n === rating ? '★を外す' : `★${n}`;
      return `<button type="button" class="home-star${on ? ' is-on' : ''}" data-home-rate="${n}" aria-pressed="${on}" title="${title}" aria-label="${title}"${editable ? '' : ' disabled'}>${on ? ICON.starOn : ICON.star}</button>`;
    }).join('');
    return `<span class="home-stars${editable ? '' : ' is-readonly'}" role="group" aria-label="作者の★">${buttons}</span>`;
  }

  function originMark(origin) {
    const site = ORIGIN_BY_KEY.get(origin);
    if (site) return `<span class="home-origin" title="${esc(site.label)}"><img src="${esc(site.icon)}" alt=""></span>`;
    return `<span class="home-origin is-unknown" title="${esc(ORIGIN_LABEL.local)}">${QUESTION}</span>`;
  }

  // 「最近の本」: pixiv の詳細の関連作品と同じ部品で大きく。押すとその本の詳細、右で読む (本体の口のまま)
  function recentItem(book) {
    const pages = Number(book.pages) || 0;
    const meta = `${ORIGIN_LABEL[book.origin] || ''}${book.date ? ` · ${String(book.date).replace(/-/g, '.')}` : ''}`;
    return `<button type="button" class="pixiv-related-item" data-related-detail="${esc(book.id)}">`
      + `<div class="pixiv-related-cover"><img src="${esc(imgUrl(book.id, 0, 'big'))}" loading="lazy" alt="">${pages > 1 ? countBadge(pages, `${pages}ページ`) : ''}</div>`
      + `<span><strong>${originMark(book.origin)}${esc(book.title)}</strong>`
      + `<span class="pixiv-related-meta"><span class="pixiv-related-author">${esc(meta)}</span></span></span></button>`;
  }

  // 詳細の顔 (一番上の表紙)。表紙を選べる人は顔を押すと選ぶ板が開く (指を載せた時だけ「表紙を選ぶ」の札が出る)
  function faceMarkup(home, readOnly) {
    const img = home.cover ? `<img src="${esc(imgUrl(home.cover, 0, 'big'))}" alt="" />` : '';
    if (!img || readOnly || !home.coverable) return `<div class="detail-cover home-face">${img}</div>`;
    const title = home.coverChosen ? '表紙を選ぶ (いまは選んだ本)' : '表紙を選ぶ (いまは自動: 一番新しい本)';
    return `<div class="detail-cover home-face is-pickable" data-home-cover-open>${img}`
      + `<button type="button" class="home-face-pick" data-home-cover-open title="${esc(title)}" aria-label="表紙を選ぶ">${ICON.image}<span>表紙を選ぶ</span></button></div>`;
  }

  function detailMarkup(gallery) {
    const home = gallery.home || {};
    // 手のひら版 (hitomi.remote) では結び・名前・★・表紙・出どころの釦を出さない: 橋が書く action を断るし、
    // 電話が繋ぐ写しで書いても次の同期で母艦の物に上書きされる (lib/lan-desktop.js)
    const readOnly = readOnlyMode() || window.hitomi.remote === true;
    // 詳細を描き直す: 開いていた表紙を選ぶ板は中身ごと入れ替わるので、控えと聞き手を先に片付ける
    if (picking) closePicker({ restore: false });
    const circles = (home.circles || []).filter((row) => row && row.label);
    const authors = (home.authors || []).filter((row) => row && row.label);
    const people = (circles.length ? detailRow('サークル', `<span class="home-people">${personList(circles, 'circle')}</span>`) : '')
      + (authors.length ? detailRow('作者', `<span class="home-people">${personList(authors, 'author')}</span>`) : '');
    // 「持ち込み」(出どころを決める行) は詳細の板に出さない (2026-09-27 の指示)
    const rows = detailRow('作者の★', starsMarkup(home, readOnly))
      + people
      + SITES.map((site) => detailRow(site.label, linkCell(home, site, readOnly))).join('');
    const recent = (home.recent || []).map(recentItem).join('');
    const bookIcon = (window.BunkoIcons && window.BunkoIcons['open-book']) || ICON.book;
    // 最近の本を押した時に待たせない (本の札の形を先に引いておく)
    prefetch(gallery);
    const kind = home.kind === 'circle' ? 'サークル' : '作者';
    return faceMarkup(home, readOnly)
      + nameHeading(gallery, readOnly)
      + `<p class="kicker">${kind} · 所持 ${Number(home.count) || 0} 冊</p>`
      + `<div class="detail-actions"><button class="primary" type="button" data-home-open="${esc(gallery.id)}">${bookIcon}作品を見る</button></div>`
      + `<dl class="detail-rows home-links">${rows}</dl>`
      + (recent ? `<details class="pixiv-detail-related" open><summary>最近の本</summary><div class="pixiv-related-list">${recent}</div></details>` : '');
  }

  function prefetch(gallery) {
    const id = String(gallery && gallery.id || '');
    if (!id || !window.hitomi.home) return Promise.resolve(null);
    if (entries.has(id)) return Promise.resolve(entries.get(id));
    if (prefetching.has(id)) return prefetching.get(id);
    const job = Promise.resolve(window.hitomi.home({ action: 'author', id }))
      .then((payload) => (payload && payload.author
        ? remember(payload, `@${(payload.author.home && payload.author.home.name) || payload.author.title}`).entry : null))
      .catch(() => null)
      .then((entry) => {
        prefetching.delete(id);
        return entry;
      });
    prefetching.set(id, job);
    return job;
  }

  function showUrlError(cell, label) {
    if (!cell) return;
    cell.querySelector('.home-url-error')?.remove();
    cell.insertAdjacentHTML('beforeend', `<span class="home-url-error">${esc(label)} の URL の形ではありません</span>`);
  }

  async function runLink(gallery, button) {
    const site = button.dataset.homeSite;
    const op = button.dataset.homeLink;
    const cell = button.closest('.row-value');
    const label = (SITE_BY_KEY.get(site) || {}).label || site;
    let url = button.dataset.homeUrl || '';
    if (op === 'save') {
      const input = cell && cell.querySelector('[data-home-input]');
      url = input ? String(input.value || '').trim() : '';
    }
    cell?.querySelector('.home-url-error')?.remove();
    if (!url) {
      showUrlError(cell, label);
      return;
    }
    if (button.disabled) return;
    button.disabled = true;
    let reply = null;
    try {
      reply = await window.hitomi.home({
        action: 'link', id: gallery.id, site, op, url,
      });
    } catch (error) {
      button.disabled = false;
      toast(`結べませんでした: ${ipcErrorText(error && error.message ? error.message : error)}`, { type: 'error' });
      return;
    }
    if (!reply || !reply.ok) {
      button.disabled = false;
      if (reply && reply.reason === 'form') showUrlError(cell, label);
      else toast(LINK_REASONS[reply && reply.reason] || '結べませんでした', { type: 'error' });
      return;
    }
    toast(LINK_DONE[op] || '結びました');
    pushUndo(gallery.id, reply.undo, UNDO_LABEL[op]);
    adoptAuthor(reply.author || null, gallery.id);
  }

  // ---- 元に戻す (Ctrl+Z) / やり直す (Ctrl+Shift+Z・Ctrl+Y) ----
  function pushUndo(id, steps, label) {
    if (!Array.isArray(steps) || !steps.length) return;
    undoStack.push({ id: String(id), steps, label: label || '操作' });
    if (undoStack.length > UNDO_MAX) undoStack.shift();
    redoStack.length = 0;
  }

  async function replay(from, to, redo) {
    const entry = from.pop();
    if (!entry) {
      toast(redo ? 'やり直す操作がありません' : '元に戻す操作がありません');
      return;
    }
    let reply = null;
    try {
      reply = await window.hitomi.home({ action: 'undo', id: entry.id, steps: entry.steps });
    } catch (error) {
      reply = null;
      toast(`${redo ? 'やり直せ' : '元に戻せ'}ませんでした: ${ipcErrorText(error && error.message ? error.message : error)}`, { type: 'error' });
      return;
    }
    if (!reply || !reply.ok) {
      toast(redo ? 'やり直せませんでした' : '元に戻せませんでした', { type: 'error' });
      return;
    }
    to.push({ id: entry.id, steps: reply.redo, label: entry.label });
    toast(`${entry.label}を${redo ? 'やり直しました' : '元に戻しました'}`);
    adoptAuthor(reply.author || null, entry.id);
  }

  function onUndoKey(event) {
    if (!ready || !onHome()) return;
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.isComposing) return;
    const target = event.target;
    // 文字を打っている所では、その欄の元に戻すのまま
    if (target && (target.isContentEditable || /^(input|textarea|select)$/i.test(String(target.tagName || '')))) return;
    const key = String(event.key || '').toLowerCase();
    if (key === 'z' && !event.shiftKey) {
      event.preventDefault();
      replay(undoStack, redoStack, false);
    } else if ((key === 'z' && event.shiftKey) || key === 'y') {
      event.preventDefault();
      replay(redoStack, undoStack, true);
    }
  }

  // 持ち込みの本の出どころを決める
  async function runOrigin(gallery, button) {
    if (!button || button.disabled) return;
    const value = String(button.dataset.homeOriginSet || '');
    if (value === String((gallery.home && gallery.home.localOrigin) || '')) return;
    const group = button.closest('.home-origin-pick');
    group?.querySelectorAll('button').forEach((node) => { node.disabled = true; });
    let reply = null;
    try {
      reply = await window.hitomi.home({ action: 'origin', id: gallery.id, origin: value });
    } catch (error) {
      reply = null;
      toast(`出どころを決められませんでした: ${ipcErrorText(error && error.message ? error.message : error)}`, { type: 'error' });
    }
    if (!reply || !reply.ok) {
      group?.querySelectorAll('button').forEach((node) => { node.disabled = false; });
      if (reply) toast('出どころを決められませんでした', { type: 'error' });
      return;
    }
    pushUndo(gallery.id, reply.undo, UNDO_LABEL.origin);
    adoptAuthor(reply.author || null, gallery.id);
  }

  // 作者の★。同じ星をもう一度押すと外す
  async function runRate(gallery, button) {
    if (!button || button.disabled) return;
    const n = Number(button.dataset.homeRate) || 0;
    const current = Number(gallery.home && gallery.home.rating) || 0;
    const star = n === current ? 0 : n;
    const group = button.closest('.home-stars');
    group?.querySelectorAll('button').forEach((node) => { node.disabled = true; });
    let reply = null;
    try {
      reply = await window.hitomi.home({ action: 'rate', id: gallery.id, star });
    } catch (error) {
      reply = null;
      toast(`★を付けられませんでした: ${ipcErrorText(error && error.message ? error.message : error)}`, { type: 'error' });
    }
    if (!reply || !reply.ok) {
      group?.querySelectorAll('button').forEach((node) => { node.disabled = false; });
      if (reply) toast('★を付けられませんでした', { type: 'error' });
      return;
    }
    pushUndo(gallery.id, reply.undo, UNDO_LABEL.rate);
    adoptAuthor(reply.author || null, gallery.id, { keepPage: true });
  }

  // ---- 表紙を選ぶ (詳細の顔を押すと開く) ----------------------------------------
  // その作者の確かな所持の本 (候補の本は除く) の表紙を並べた板を、顔の下に重ねる (詳細の行は押しのけない)。
  // 表紙に指を載せると顔がその本になって試せ、押すと決まる。先頭の「自動」は一番新しい本 (決めた表紙を外す)。
  // 開いている間は顔の高さを留め、板の外で詳細を送らない (試しで縦横の違う表紙に替えても何も動かない)
  let picking = null;
  let coverBusy = false;

  function coverTile(id, src, { title = '', auto = false, current = false } = {}) {
    return `<button type="button" class="home-cover-tile${auto ? ' is-auto' : ''}${current ? ' is-current' : ''}" data-home-cover="${esc(id)}" title="${esc(title)}" aria-pressed="${current}">`
      + `<img src="${esc(src)}" alt="" loading="lazy" draggable="false">`
      + (auto ? '<span class="home-cover-tag">自動</span>' : '')
      + '</button>';
  }

  // 並べる本: 作者頁の返り (所持の本。新しい順)。まだ届いていなければ詳細の「最近の本」だけを先に並べる
  function coverChoices(gallery) {
    const entry = entries.get(String(gallery.id));
    if (entry) {
      const list = (entry.books || []).filter((book) => !book.candidate)
        .map((book) => ({ id: String(book.id), title: String((book.gallery && book.gallery.title) || '') }));
      return { list, complete: true };
    }
    const recent = ((gallery.home && gallery.home.recent) || []).filter((book) => !book.candidate)
      .map((book) => ({ id: String(book.id), title: String(book.title || '') }));
    return { list: recent, complete: false };
  }

  function coverTiles(gallery) {
    const home = gallery.home || {};
    const current = home.coverChosen ? String(home.cover || '') : '';
    const { list, complete } = coverChoices(gallery);
    const tiles = [];
    if (home.coverAuto) tiles.push(coverTile('', imgUrl(home.coverAuto, 0, 'big'), { title: '自動 (一番新しい本)', auto: true, current: !current }));
    for (const book of list) tiles.push(coverTile(book.id, imgUrl(book.id, 0, 'big'), { title: book.title, current: book.id === current }));
    return { html: tiles.join(''), count: list.length, complete };
  }

  function coverCount(tiles) {
    return tiles.complete ? `所持 ${tiles.count} 冊` : '読み込み中…';
  }

  function pickerMarkup(gallery) {
    const tiles = coverTiles(gallery);
    return '<div class="home-cover-pick" role="dialog" aria-label="表紙を選ぶ">'
      + '<div class="home-cover-pick-head"><span class="home-cover-pick-title">表紙を選ぶ</span>'
      + `<span class="home-cover-pick-count">${esc(coverCount(tiles))}</span>`
      + `<button type="button" class="home-cover-pick-close" data-home-cover-close title="閉じる (Esc)" aria-label="閉じる">${ICON.close}</button></div>`
      + `<div class="home-cover-grid">${tiles.html}</div></div>`;
  }

  function pickerSheet() {
    return els.detailBody.querySelector('.home-cover-pick');
  }

  // 板を顔の下から詳細の見えている下端までに置く。顔が見えていない・下が狭すぎる時は詳細の上から覆う
  function placePicker() {
    if (!pickerAlive()) return;
    const sheet = pickerSheet();
    const panel = els.detail;
    const box = panel.getBoundingClientRect();
    const visible = panel.clientHeight;
    const gap = 12;
    let top = picking.face.getBoundingClientRect().bottom - box.top - (panel.clientTop || 0) + gap;
    if (top < gap || visible - top - gap < 200) top = gap;
    sheet.style.top = `${panel.scrollTop + top}px`;
    sheet.style.height = `${Math.max(120, visible - top - gap)}px`;
  }

  // 板がまだ見えているか。詳細が描き直された・閉じた後なら、残った控えと聞き手を片付けて false
  function pickerAlive() {
    if (picking && picking.face.isConnected && pickerSheet() && !els.detail.hidden) return true;
    if (picking) closePicker({ restore: false });
    return false;
  }

  // 試し: 指を載せた表紙を顔に出す (tile が無ければ元の顔に戻す)
  function previewCover(tile) {
    if (!picking || !picking.img) return;
    const img = tile && tile.querySelector('img');
    const src = img ? (img.currentSrc || img.getAttribute('src')) : picking.src;
    if (src && picking.img.getAttribute('src') !== src) picking.img.setAttribute('src', src);
  }

  // 板の外の送りは止める。表紙の並びの中は、並びが送れる向きだけ通す (詳細の送りへ伝わらない)
  function onPickerWheel(event) {
    if (!pickerAlive()) return;
    const grid = event.target && event.target.closest ? event.target.closest('.home-cover-grid') : null;
    if (grid) {
      const down = event.deltaY > 0;
      const room = down ? grid.scrollHeight - grid.clientHeight - grid.scrollTop > 1 : grid.scrollTop > 0;
      if (room) return;
    }
    event.preventDefault();
  }

  function onPickerOver(event) {
    const tile = event.target && event.target.closest ? event.target.closest('[data-home-cover]') : null;
    if (tile) previewCover(tile);
  }

  function onPickerLeave() {
    previewCover(null);
  }

  function openPicker(gallery) {
    if (!gallery || !gallery.home || !gallery.home.coverable || readOnlyMode()) return;
    closePicker();
    const face = els.detailBody.querySelector('.home-face');
    if (!face) return;
    const img = face.querySelector('img');
    // 試しの間は顔の高さを留める (縦横の違う表紙に替えても、下に重ねた板がずれない)
    face.style.height = `${face.getBoundingClientRect().height}px`;
    face.classList.add('is-picking');
    face.insertAdjacentHTML('afterend', pickerMarkup(gallery));
    const sheet = pickerSheet();
    if (!sheet) return;
    const grid = sheet.querySelector('.home-cover-grid');
    picking = { id: String(gallery.id), face, img, src: img ? img.getAttribute('src') : '', grid };
    placePicker();
    grid?.addEventListener('mouseover', onPickerOver);
    grid?.addEventListener('focusin', onPickerOver);
    grid?.addEventListener('mouseleave', onPickerLeave);
    els.detail.addEventListener('wheel', onPickerWheel, { passive: false });
    els.detail.addEventListener('scroll', placePicker, { passive: true });
    showCurrentTile();
    if (!coverChoices(gallery).complete) {
      // 本の一覧がまだ届いていない (詳細を開いた直後): 届いたら並べ直す (先頭の「最近の本」はそのまま、後ろに足す)
      prefetch(gallery).then(() => refillPicker(gallery.id));
    }
  }

  // 今の表紙が見える所まで並びを送る (並びの中だけ。詳細は動かさない)
  function showCurrentTile() {
    const grid = picking && picking.grid;
    const tile = grid && grid.querySelector('.home-cover-tile.is-current');
    if (!tile || tile.classList.contains('is-auto')) return;
    grid.scrollTop = Math.max(0, tile.offsetTop - (grid.clientHeight - tile.offsetHeight) / 2);
  }

  function refillPicker(id) {
    if (!picking || picking.id !== String(id) || !pickerSheet()) return;
    const gallery = state.selected && sameId(state.selected.id, id) ? state.selected : null;
    if (!isHome(gallery)) return;
    const tiles = coverTiles(gallery);
    const top = picking.grid.scrollTop;
    picking.grid.innerHTML = tiles.html;
    picking.grid.scrollTop = top;
    const count = pickerSheet().querySelector('.home-cover-pick-count');
    if (count) count.textContent = tiles.complete ? coverCount(tiles) : `${tiles.count} 冊 (全部は読めませんでした)`;
  }

  // 板を畳む。restore: 試しで替えた顔を元に戻す (決めた時は詳細ごと描き直すので戻さない)
  function closePicker({ restore = true } = {}) {
    if (!picking) return;
    const { face, grid } = picking;
    if (restore) previewCover(null);
    grid?.removeEventListener('mouseover', onPickerOver);
    grid?.removeEventListener('focusin', onPickerOver);
    grid?.removeEventListener('mouseleave', onPickerLeave);
    els.detail.removeEventListener('wheel', onPickerWheel, { passive: false });
    els.detail.removeEventListener('scroll', placePicker, { passive: true });
    picking = null;
    pickerSheet()?.remove();
    if (face && face.isConnected) {
      face.style.height = '';
      face.classList.remove('is-picking');
    }
  }

  function onPickerKey(event) {
    if (event.key !== 'Escape' || event.isComposing || !pickerAlive()) return;
    // 詳細を閉じる Esc より先に、板だけを畳む
    event.preventDefault();
    event.stopImmediatePropagation();
    closePicker();
  }

  // 表紙を決める ('' で自動の顔に戻す)。一覧の見出し・詳細・作者頁の頭が同じ表紙になる
  async function runCover(gallery, id) {
    const home = gallery.home || {};
    const current = home.coverChosen ? String(home.cover || '') : '';
    if (id === current) {
      closePicker();
      return;
    }
    // 返りを待つ間の二度押しは受けない
    if (coverBusy) return;
    coverBusy = true;
    pickerSheet()?.classList.add('is-busy');
    let reply = null;
    try {
      reply = await window.hitomi.home({ action: 'cover', id: gallery.id, cover: id });
    } catch (error) {
      reply = null;
      toast(`表紙を変えられませんでした: ${ipcErrorText(error && error.message ? error.message : error)}`, { type: 'error' });
    }
    coverBusy = false;
    if (!reply || !reply.ok) {
      if (reply) toast('表紙を変えられませんでした', { type: 'error' });
      pickerSheet()?.classList.remove('is-busy');
      return;
    }
    pushUndo(gallery.id, reply.undo, UNDO_LABEL.cover);
    closePicker({ restore: false });
    adoptAuthor(reply.author || null, gallery.id, { keepPage: true });
  }

  // 作者頁の頭の顔だけ差し替える (本の札は描き直さない)
  function paintHeadFace() {
    const node = view && view.querySelector('.home-av-face');
    const home = shown && shown.author && shown.author.home;
    if (!node || !home) return;
    const src = home.cover ? imgUrl(home.cover, 0, 'big') : '';
    const img = node.querySelector('img');
    if ((img ? img.getAttribute('src') : '') === src) return;
    node.innerHTML = src ? `<img src="${esc(src)}" alt="">` : '';
  }

  // 結びが変わった作者を一覧・詳細・作者頁に写す
  function adoptAuthor(fresh, id, { keepPage = false } = {}) {
    const key = String(id);
    // 作者頁の控えは結びが変わると本の出し方 (候補・hitomi の網) が変わる: 捨てて引き直させる
    if (!keepPage) {
      entries.delete(key);
      for (const [query, value] of [...queryIds]) if (value === key) queryIds.delete(query);
    } else if (entries.has(key) && fresh) {
      entries.get(key).author = fresh;
    }
    if (fresh) {
      const index = state.galleries.findIndex((item) => sameId(item.id, key));
      if (index >= 0) state.galleries[index] = fresh;
    }
    if (state.selected && sameId(state.selected.id, key)) {
      if (fresh) {
        state.selected = fresh;
        const top = els.detail.scrollTop;
        renderDetail(fresh);
        els.detail.scrollTop = top;
      } else {
        state.selected = null;
        renderDetail(null);
      }
    }
    if (shown && shown.author && shown.author.id === key) {
      if (keepPage && fresh) {
        // ★や表紙だけ変わった: 作者頁の本はそのまま (頭の顔だけ差し替える)
        shown.author = fresh;
        paintHeadFace();
      } else {
        shown = null;
        sync(true);
      }
    }
    refreshList();
  }

  // 一覧をその場で引き直す (見ている場所は動かさない)。結びで作者が束なる・候補が消えることがある
  async function refreshList() {
    if (!onHome() || authorQuery() || state.loading || !state.galleries.length) return;
    const epoch = searchEpoch;
    const anchor = currentScrollAnchor();
    const fallback = window.scrollY;
    const span = Math.max(1, Math.min(60, state.page || 1));
    let result = null;
    try {
      result = await window.hitomi.search({
        requestId: `home-${Date.now().toString(36)}`,
        query: state.query,
        source: SOURCE,
        scope: state.scope,
        sort: state.sort,
        sortDir: sortDirValue(),
        type: state.type,
        unresolvedOnly: (state.settings || {}).homeUnresolvedOnly === true,
        page: 0,
        pageSize: state.pageSize,
        spanPages: span,
      });
    } catch {
      return;
    }
    if (!result || epoch !== searchEpoch || state.loading || !onHome() || authorQuery()) return;
    state.galleries = result.galleries || [];
    state.total = result.total;
    state.done = !result.hasNext;
    state.page = span;
    renderResultInfo(state.interpreted || []);
    renderGrid(false, true);
    restoreScroll(anchor, fallback);
  }

  function onDetailClick(event) {
    const gallery = state.selected;
    if (!isHome(gallery)) return;
    // 表紙を選ぶ板: 顔を押すと開け閉め、並びの表紙を押すと決める
    const pickToggle = event.target.closest('[data-home-cover-open]');
    if (pickToggle) {
      event.preventDefault();
      if (pickerAlive()) closePicker();
      else openPicker(gallery);
      return;
    }
    if (event.target.closest('[data-home-cover-close]')) {
      event.preventDefault();
      closePicker();
      return;
    }
    const cover = event.target.closest('[data-home-cover]');
    if (cover) {
      event.preventDefault();
      runCover(gallery, String(cover.dataset.homeCover || ''));
      return;
    }
    const open = event.target.closest('[data-home-open]');
    if (open) {
      event.preventDefault();
      // 作者頁へ移ったら詳細は用済み: 本が見えるように畳む (作品一覧の釦と同じ)
      captureFly(gallery.id, els.detailBody.querySelector('.home-face img'));
      state.selected = null;
      renderDetail(null);
      openAuthor(gallery);
      return;
    }
    const jump = event.target.closest('[data-home-query]');
    if (jump) {
      event.preventDefault();
      state.selected = null;
      renderDetail(null);
      openQuery(jump.dataset.homeQuery);
      return;
    }
    const rate = event.target.closest('[data-home-rate]');
    if (rate) {
      event.preventDefault();
      runRate(gallery, rate);
      return;
    }
    const rename = event.target.closest('[data-home-rename]');
    if (rename) {
      event.preventDefault();
      const heading = rename.closest('.home-name');
      if (heading) {
        heading.innerHTML = nameEditor(gallery);
        const input = heading.querySelector('[data-home-name-input]');
        input?.focus?.();
        input?.select?.();
      }
      return;
    }
    const save = event.target.closest('[data-home-rename-save]');
    if (save) {
      event.preventDefault();
      const input = save.closest('.home-name-edit')?.querySelector('[data-home-name-input]');
      const value = input ? String(input.value || '').trim() : '';
      if (value && value !== gallery.title) runRename(gallery, value);
      else renderDetail(gallery);
      return;
    }
    if (event.target.closest('[data-home-rename-reset]')) {
      event.preventDefault();
      runRename(gallery, '');
      return;
    }
    const origin = event.target.closest('[data-home-origin-set]');
    if (origin) {
      event.preventDefault();
      runOrigin(gallery, origin);
      return;
    }
    const add = event.target.closest('[data-home-add]');
    if (add) {
      event.preventDefault();
      const site = SITE_BY_KEY.get(add.dataset.homeAdd);
      if (!site) return;
      add.insertAdjacentHTML('afterend', urlEdit(site));
      const input = add.parentNode && add.parentNode.querySelector ? add.parentNode.querySelector(`[data-home-input="${site.key}"]`) : null;
      add.remove();
      input?.focus?.();
      return;
    }
    const act = event.target.closest('[data-home-link]');
    if (act) {
      event.preventDefault();
      runLink(gallery, act);
    }
  }

  function onDetailKey(event) {
    const naming = event.target && event.target.closest ? event.target.closest('[data-home-name-input]') : null;
    if (naming && !event.isComposing && (event.key === 'Enter' || event.key === 'Escape')) {
      const gallery = state.selected;
      if (!isHome(gallery)) return;
      event.preventDefault();
      const value = String(naming.value || '').trim();
      if (event.key === 'Enter' && value && value !== gallery.title) runRename(gallery, value);
      else renderDetail(gallery);
      return;
    }
    const input = event.target && event.target.closest ? event.target.closest('[data-home-input]') : null;
    if (!input || event.key !== 'Enter' || event.isComposing) return;
    const gallery = state.selected;
    if (!isHome(gallery)) return;
    event.preventDefault();
    const button = input.closest('.home-url-edit')?.querySelector('[data-home-link="save"]');
    if (button) runLink(gallery, button);
  }

  // ---- 作者頁 (@名前) --------------------------------------------------------

  function bookSignature(list) {
    return (list || []).map((book) => `${book.id}:${book.gallery && book.gallery.owned ? 1 : 0}:${book.gallery && book.gallery.star || 0}`).join('|');
  }

  function authorSignature(author) {
    const home = (author && author.home) || {};
    return JSON.stringify([author && author.title, home.count, home.sites, home.unsure, home.links, home.cover]);
  }

  // 母屋の返り (作者と所持の本) を控える。同じ作者なら入れ物は使い回し、変わったかを返す
  function remember(payload, query) {
    const id = String(payload.author.id);
    const signature = `${authorSignature(payload.author)}#${bookSignature(payload.books)}`;
    let entry = entries.get(id);
    let changed = true;
    if (entry) {
      changed = entry.signature !== signature;
      entries.delete(id);
    } else {
      // web: 源泉ごとの網の作品 { works, more, failed, unavailable }。webLoading: 引いている源泉
      entry = { web: {}, webLoading: new Set(), version: 0 };
    }
    entry.author = payload.author;
    entry.books = Array.isArray(payload.books) ? payload.books : [];
    entry.handles = Number(payload.handles) || 0;
    // 発見の新作の hitomi の id (公開時期の「新」の印)
    entry.newIds = new Set((Array.isArray(payload.newIds) ? payload.newIds : []).map(String));
    entry.signature = signature;
    if (changed) entry.version = (entry.version || 0) + 1;
    entries.set(id, entry);
    while (entries.size > CACHE_MAX) {
      const oldest = entries.keys().next().value;
      if (entries.get(oldest) === shown) break;
      entries.delete(oldest);
    }
    if (query) {
      queryIds.set(query, id);
      rememberFilter(query, payload.filter);
    }
    return { entry, changed };
  }

  // 作品の検索の絞り (母屋の filter: { words, hits, count }) を語ごとに覚える。打つたびに語が変わるので数に上限
  function rememberFilter(query, filter) {
    queryFilters.delete(query);
    queryFilters.set(query, filter && filter.words
      ? { words: String(filter.words), hits: new Set((Array.isArray(filter.hits) ? filter.hits : []).map(String)), count: Number(filter.count) || 0 }
      : null);
    while (queryFilters.size > FILTER_MAX) {
      const oldest = queryFilters.keys().next().value;
      queryFilters.delete(oldest);
      if (oldest !== query && queryIds.has(oldest)) queryIds.delete(oldest);
    }
  }

  // 今の作者頁の絞り (語の無い作者頁と一覧では null)
  function pageFilter() {
    const query = authorQuery();
    return query ? queryFilters.get(query) || null : null;
  }

  // 源泉と語に合わせる。settled は「一覧の差し替えが済んだ」(検索の返り・写しの戻し) の印で、
  // 作者頁を畳むのはその時だけ (先に畳むと一覧の返りまでの間に空の棚が出る)。
  // result は検索の返り: @名前 なら母屋が作者と所持の本を添えてくる (同じ一巡で並べる)
  function sync(settled, result) {
    if (!ready) return;
    const home = onHome();
    flag('data-home', home);
    // 表示の切り替えの釦の出し入れ。所持作品だけの旗は Home の中だけなので、源泉を移るたびに合わせ直す
    // (本体の fillHideOwnedToggle は源泉の移りでは呼ばれない。一覧の描き直しは要らないので直に)
    if (els.hideOwned) els.hideOwned.hidden = libraryScope() || (home && ownedOnly());
    if (!home) {
      hide();
      paintOverview();
      return;
    }
    // 一頁目の返りに載ってきた総覧を控える (語や種別のある返りは null。前の総覧は語が消えたら出し直す)
    if (result && result.overview) setOverview(result.overview);
    const query = authorQuery();
    if (!query) {
      if (settled) hide();
      paintOverview();
      return;
    }
    paintOverview();
    if (result && Object.prototype.hasOwnProperty.call(result, 'homeAuthor')) {
      if (result.homeAuthor && result.homeAuthor.author) {
        const { entry, changed } = remember(result.homeAuthor, query);
        show(entry, { top: true, changed });
      } else {
        showMissing(query, false);
      }
      return;
    }
    // 控えの作者頁は、その語の絞りも覚えている時だけ使う (語の当たりを知らずに全部を出さない)
    const cached = queryFilters.has(query) ? entries.get(queryIds.get(query)) : null;
    if (cached) {
      show(cached);
      return;
    }
    if (!settled) return;
    // 戻る・進むの写しから来た時は、作者頁の本を母屋に訊き直す
    const token = ++fetchToken;
    Promise.resolve(window.hitomi.home({ action: 'author', query })).then((payload) => {
      if (token !== fetchToken || !onHome() || authorQuery() !== query) return;
      if (!payload || !payload.author) {
        showMissing(query, false);
        return;
      }
      show(remember(payload, query).entry);
    }).catch(() => {
      if (token === fetchToken && onHome() && authorQuery() === query) showMissing(query, true);
    });
  }

  function hide() {
    flag('data-home-author', false);
    if (!view || view.hidden) return;
    view.hidden = true;
    view.innerHTML = '';
    shown = null;
    books = [];
    bookIndex = new Map();
  }

  function show(entry, { top = false, changed = false } = {}) {
    const same = shown === entry && !view.hidden && renderedKey === viewKey(entry);
    shown = entry;
    if (!same || changed) {
      render();
      if (top) window.scrollTo(0, 0);
    }
    runFly(entry.author && entry.author.id);
    loadWeb(entry);
    loadWebHits(entry);
    loadPages(entry);
  }

  // 所持の本のうち名前に頁数の無い物 (Discord から持ち込んだ PDF など) の頁数を母屋に数えさせ、札の右上に出す。
  // 一度数えれば母屋の控え (page-counts) に残るので、次からは作者頁の返りに最初から入っている
  function loadPages(entry) {
    if (!entry || entry.pagesAsked || !window.hitomi.home) return;
    const ids = (entry.books || [])
      .filter((book) => book.gallery && book.gallery.kind === 'eagleItem' && !(Number(book.gallery.pageCount) > 1))
      .map((book) => String(book.id));
    if (!ids.length) return;
    entry.pagesAsked = true;
    Promise.resolve(window.hitomi.home({ action: 'pages', id: entry.author.id, ids })).then((reply) => {
      const counts = (reply && reply.counts) || {};
      let changed = false;
      for (const book of entry.books || []) {
        const pages = Number(counts[book.id]) || 0;
        if (pages > 1 && book.gallery && Number(book.gallery.pageCount) !== pages) {
          book.gallery = { ...book.gallery, pageCount: pages };
          changed = true;
        }
      }
      if (!changed) return;
      entry.version = (entry.version || 0) + 1;
      if (shown === entry && view && !view.hidden) renderSoon();
    }).catch(() => {});
  }

  function showMissing(query, failed) {
    pendingFly = null;
    shown = null;
    books = [];
    bookIndex = new Map();
    view.innerHTML = '<header class="home-av-head">'
      + `<div class="home-av-title"><h2>${esc(query.slice(1))}</h2>`
      + `<p><span class="home-av-status">${failed ? '作者頁を読めませんでした' : 'この名前の作者は見つかりません'}</span></p></div>`
      + '</header>';
    view.hidden = false;
    flag('data-home-author', true);
  }

  // 網の作品を引く源泉: hitomi は名乗り (結び済みと候補) がある時、Pawchive と pixiv は結び済みの時だけ
  function webSites(entry) {
    const links = (entry && entry.author && entry.author.home && entry.author.home.links) || {};
    return WEB_SITES.filter((site) => (site.key === 'hitomi'
      ? Number(entry.handles) > 0
      : (links[site.key] || []).some((link) => link && link.state === 'linked')));
  }

  // 作者の網の作品 (hitomi は日本語だけ・Pawchive・pixiv)。未所持も最初から全部並べる。源泉ごとに並べて投げ、
  // 届いた順に混ぜる (読んでいる所は動かさない)。読み込みの間は頭に「… を読み込み中…」だけを出す
  // (待たせる札は出さない)。所持作品だけの表示の間は引かない
  function loadWeb(entry) {
    if (!entry || !entry.author || ownedOnly() || !window.hitomi.home) return;
    if (!entry.web || Array.isArray(entry.web.works)) entry.web = {};
    if (!(entry.webLoading instanceof Set)) entry.webLoading = new Set();
    let started = false;
    for (const site of webSites(entry)) {
      if (entry.web[site.key] || entry.webLoading.has(site.key)) continue;
      entry.webLoading.add(site.key);
      started = true;
      Promise.resolve(window.hitomi.home({ action: 'web', id: entry.author.id, site: site.key })).then((reply) => {
        const works = reply && Array.isArray(reply.works) ? reply.works : null;
        entry.web[site.key] = {
          works: works || [],
          more: Boolean(reply && reply.more),
          failed: !works || reply.error === true,
          unavailable: Boolean(reply && reply.unavailable),
        };
      }, () => {
        entry.web[site.key] = { works: [], more: false, failed: true, unavailable: false };
      }).then(() => {
        entry.webLoading.delete(site.key);
        if (entry.web[site.key].works.length) entry.version = (entry.version || 0) + 1;
        if (shown !== entry || !view || view.hidden || ownedOnly()) return;
        if (renderedKey !== viewKey(entry)) renderSoon();
        else paintStatus();
      });
    }
    if (started) paintStatus();
  }

  function statusText(entry) {
    if (!entry || ownedOnly()) return '';
    const web = entry.web || {};
    // 作品の検索で絞っている間は、網の作品の当たりを訊いている源泉も読み込み中に数える
    const loading = WEB_SITES.filter((site) => (entry.webLoading instanceof Set && entry.webLoading.has(site.key))
      || (web[site.key] && web[site.key].hitsAsking)).map((site) => site.label);
    if (loading.length) return `${loading.join('・')} を読み込み中…`;
    const failed = WEB_SITES.filter((site) => web[site.key] && web[site.key].failed).map((site) => site.label);
    const capped = WEB_SITES.filter((site) => web[site.key] && web[site.key].more).map((site) => `${site.label} は新しい ${site.limit} 件まで`);
    return [failed.length ? `${failed.join('・')} を読めませんでした` : '', ...capped].filter(Boolean).join(' · ');
  }

  function paintStatus() {
    const node = view && view.querySelector('.home-av-status');
    if (node) node.textContent = statusText(shown);
  }

  // 作品の検索で絞った作者頁の、網の作品の当たり。源泉ごとに、届いている網の作品について母屋に訊く
  // (母屋は網の頁の控えから当てるので網へは出ない)。語が変わったら訊き直す。当たりが届くまでその源泉の作品は出さない
  function loadWebHits(entry) {
    const filter = pageFilter();
    if (!entry || !entry.author || !filter || ownedOnly() || !window.hitomi.home || !entry.web) return;
    const { words } = filter;
    for (const site of WEB_SITES) {
      const slot = entry.web[site.key];
      if (!slot || !Array.isArray(slot.works) || !slot.works.length) continue;
      if ((slot.hits && slot.hits.words === words) || slot.hitsAsking === words) continue;
      slot.hitsAsking = words;
      Promise.resolve(window.hitomi.home({ action: 'webHits', id: entry.author.id, site: site.key, words })).then((reply) => {
        slot.hits = { words, ids: new Set((reply && Array.isArray(reply.hits) ? reply.hits : []).map(String)) };
      }, () => {
        slot.hits = { words, ids: new Set() };
      }).then(() => {
        if (slot.hitsAsking === words) slot.hitsAsking = '';
        entry.version = (entry.version || 0) + 1;
        const now = pageFilter();
        if (shown !== entry || !view || view.hidden || ownedOnly() || !now || now.words !== words) return;
        // 作者頁を開いた直後に届くことが多い: 飛んでいる間は着くまで待たせる
        renderSoon();
      });
    }
  }

  // 網の作品が作品の検索に当たっているか (絞っていなければ全部)。当たりが届いていない源泉の作品は出さない
  function webWorkShown(entry, work, filter) {
    if (!filter) return true;
    const slot = entry.web && entry.web[work.origin];
    return Boolean(slot && slot.hits && slot.hits.words === filter.words && slot.hits.ids.has(String(work.id)));
  }

  // 源泉ごとの網の作品を一列に (前の版の { works } の形も受ける)
  function webWorks(entry) {
    const web = entry && entry.web;
    if (!web) return [];
    if (Array.isArray(web.works)) return web.works;
    return WEB_SITES.flatMap((site) => (web[site.key] && Array.isArray(web[site.key].works) ? web[site.key].works : []));
  }

  // 所持の本と網の作品を一つに。発表の日付の新しい順、日付不明は最後。所持作品だけの表示では網を混ぜない。
  // 同じ物は網から足さない: 同じ id か、網の札が所持の本と同じ Eagle の項目を ID で確かに指す時
  // (Pawchive の網の投稿は pw:…、所持の本は pweagle:… で id が違う)。題が一致しただけの 済 は重ねない
  // (束ねの方で所持の版違いとして畳む)。owned は所持の本の一覧から来た印 (束ねの代表選びが見る)
  // 作品の検索で絞った作者頁 ('@名前 語') は、語に当たった本だけ。当たらなかった所持の本も「同じ物」の目印には残す
  // (その本の網の写しを未所持として出さない)
  function merged(entry, { web = !ownedOnly() } = {}) {
    const filter = pageFilter();
    const list = [];
    const have = new Set();
    const eagle = new Set();
    for (const book of entry.books || []) {
      const id = String(book.id);
      if (have.has(id)) continue;
      have.add(id);
      const eagleId = book.gallery && book.gallery.eagleId;
      if (eagleId) eagle.add(String(eagleId));
      if (filter && !filter.hits.has(id)) continue;
      list.push({ ...book, owned: true });
    }
    if (web) {
      for (const work of webWorks(entry)) {
        const id = String(work.id);
        if (have.has(id)) continue;
        const gallery = work.gallery || {};
        if (gallery.eagleId && gallery.owned && gallery.idOwned && eagle.has(String(gallery.eagleId))) continue;
        have.add(id);
        if (!webWorkShown(entry, work, filter)) continue;
        list.push({ ...work, owned: false });
      }
    }
    return list.sort((a, b) => {
      const x = a.date || '';
      const y = b.date || '';
      if (x === y) return 0;
      if (!x) return 1;
      if (!y) return -1;
      return x < y ? 1 : -1;
    });
  }

  function groupKey(date) {
    if (!date) return '?';
    return groupBy === 'month' ? String(date).slice(0, 7) : String(date).slice(0, 4);
  }

  function groupLabel(key) {
    if (key === '?') return '日付不明';
    if (groupBy === 'year') return key;
    return `${key.slice(0, 4)}年${Number(key.slice(5, 7))}月`;
  }

  // 即売会の記号 (C104 夏) は、その年 (月) の段に添える
  function eventsOf(list) {
    const found = new Map();
    for (const book of list) {
      const event = book.event;
      if (!event || !event.code) continue;
      const hit = found.get(event.code) || { ...event, count: 0 };
      hit.count += 1;
      found.set(event.code, hit);
    }
    return [...found.values()].sort((a, b) => Number(b.code.slice(1)) - Number(a.code.slice(1)));
  }

  function eventKey(event) {
    return groupBy === 'year' ? String(event.year) : `${event.year}-${String(event.month).padStart(2, '0')}`;
  }

  // 本の札は本体の見出しの部品のまま。題の頭に出どころのサイトの印、名前が一致しただけの候補には表紙の左上に ?
  function bookCard(book, { fresh = false } = {}) {
    let html = String(cardMarkup(book.gallery)).trim();
    html = html.replace('<article class="card', `<article class="card home-book${book.candidate ? ' is-candidate' : ''}${fresh ? ' is-new' : ''}`);
    if (fresh) html = html.replace('<div class="card-acts">', '<span class="home-new-stamp" title="発見の新作">新</span><div class="card-acts">');
    html = html.replace('<h3 class="card-title">', `<h3 class="card-title">${originMark(book.origin)}`);
    if (book.candidate) {
      html = html.replace('<div class="card-acts">', `<span class="home-book-q" title="名前が一致しただけの候補">${QUESTION}</span><div class="card-acts">`);
    }
    const marks = bookMarks(book.info) + dateGuessMark(book);
    if (marks) html = html.replace('<div class="card-acts">', `<span class="home-marks">${marks}</span><div class="card-acts">`);
    return html;
  }

  // 網で見つけた推定の公開日 (題がほぼ一致・日付の割れる一致・hitomi への掲載日など) の本には「頃」
  const DATE_BASIS = {
    'pixiv-post': 'pixiv の投稿日',
    'pawchive-post': 'Pawchive の投稿日',
    'hitomi-published': 'hitomi の発行日',
    'hitomi-uploaded': 'hitomi への掲載日 (発行より遅いことがある)',
    'pixiv-id-estimate': 'pixiv の投稿 ID からの推定',
  };

  function dateGuessMark(book) {
    if (!book || !book.dateGuess || !book.date) return '';
    const from = DATE_BASIS[book.dateBasis] || '網で見つけた日付';
    return `<span class="home-mark is-guess" title="${esc(`公開日は推定 (${from})`)}">頃</span>`;
  }

  // 表紙の左下の印: 役 (見本・告知・差分・再掲。点だけで決めた物は ?) と、畳んだ物 (全て表示の時に見える)
  function bookMarks(info) {
    if (!info) return '';
    const out = [];
    const role = window.HomeBundle ? HomeBundle.roleBadge(info) : '';
    if (role) {
      const why = info.sure ? '決め手の規則で判じた役' : '手がかりの点で判じた役 (これだけでは畳まない)';
      out.push(`<span class="home-mark is-role${info.sure ? '' : ' is-guess'}" title="${esc(why)}">${esc(role)}</span>`);
    }
    if (info.folded && FOLD_LABEL[info.as]) {
      out.push(`<span class="home-mark is-fold" title="${esc(FOLD_TITLE[info.as])}">${FOLD_LABEL[info.as]}</span>`);
    }
    return out.join('');
  }

  // 束ねの結果を札の形に写す (元の札は触らない: 束ね直すたびに前の印が残らないように)。
  // 畳んだ物は代表が所持なら本体の「同」(所持の版違い)、そうでなければ「重」の旗 (表示の切り替えがそのまま効く)
  function decorate(book, info) {
    const gallery = book.gallery || {};
    if (!info || !info.folded) return gallery;
    return {
      ...gallery,
      similarOwned: Boolean(gallery.similarOwned) || info.as === 'similar',
      dupeHidden: info.as === 'dupe',
    };
  }

  // 今の表示の切り替えで伏せるか。本体の isCardHidden に、作者頁で束ねた物を足す
  // (網の札の「題だけの 済」は本体では伏せないが、作者頁ではその所持の本に束ねてあるので畳んでよい)
  function hiddenOnPage(book, mode) {
    if (isCardHidden(book.gallery, mode)) return true;
    return mode !== 'none' && Boolean(book.info && book.info.folded);
  }

  // 新作 (発見の新作の id に当たる未所持の本) か
  function isNewBook(entry, book) {
    return Boolean(entry && entry.newIds && !book.owned && entry.newIds.has(String(book.id)));
  }

  // ★の高い本: 所持の ★4・5。多くて 5 冊。それより多い時は最後に読んだのが古い物から (読んだ記録の無い物が先)。
  // 並びは ★ の多い順、同じなら読んだのが古い順。数字は付けない (2026-09-27 の答え)
  function starBooks(list) {
    const since = (book) => Number(book.readAt) || 0;
    const starred = list.filter((book) => book.owned && !book.candidate && Number(book.gallery && book.gallery.star) >= 4);
    const picked = starred.length > STAR_MAX ? starred.slice().sort((a, b) => since(a) - since(b)).slice(0, STAR_MAX) : starred.slice();
    picked.sort((a, b) => Number(b.gallery.star) - Number(a.gallery.star) || since(a) - since(b));
    return { total: starred.length, picked };
  }

  // ★の高い本の札: 表紙いっぱいに絵、下に題と★を重ね、右上に頁数 (本の見出しと同じ印)。押すと本の見出しと同じ (詳細・読む)
  function bentoCell(book) {
    const gallery = book.gallery || {};
    const id = String(gallery.id != null ? gallery.id : book.id);
    const pages = Number(gallery.pageCount) || 0;
    return `<article class="card home-book home-bento-cell${gallery.owned ? ' owned' : ''}" tabindex="0" data-id="${esc(id)}">`
      + `<div class="cover"><img src="${esc(imgUrl(id, 0, 'big'))}" alt="" loading="lazy" decoding="async" draggable="false" />`
      + (pages > 1 ? countBadge(pages, `${pages}ページ`) : '')
      + '</div>'
      + `<div class="home-bento-cap"><p class="home-bento-title">${originMark(book.origin)}${esc(gallery.title || '')}</p>`
      + `<span class="home-bento-star">★${Number(gallery.star) || 0}</span></div></article>`;
  }

  function render() {
    const entry = shown;
    if (!entry || !view) return;
    const author = entry.author;
    const home = author.home || {};
    const mode = pageMode();
    // 作品の検索で絞っている時の語。網の作品が届いた後の描き直しで、その当たりを訊く (訊き済みなら何もしない)
    const filter = pageFilter();
    loadWebHits(entry);
    // 作者頁ごとの見え方 (出すサイトと年 / 月)。出さないサイトの本は束ねる前に外す (代表にもならない)
    const prefs = viewPrefs(author.id);
    groupBy = prefs.group;
    const off = new Set(prefs.off);
    const everything = merged(entry);
    const present = ORIGINS.filter((origin) => everything.some((book) => (ORIGINS.includes(book.origin) ? book.origin : 'local') === origin));
    const all = everything.filter((book) => !off.has(ORIGINS.includes(book.origin) ? book.origin : 'local'));
    const marks = window.HomeBundle ? HomeBundle.mark(all) : new Map();
    const rows = all.map((book) => {
      const info = marks.get(String(book.id)) || null;
      return { ...book, info, gallery: decorate(book, info) };
    });
    // 冊数も段も、今の表示の切り替えで見えている本だけで数える
    books = rows.filter((book) => !hiddenOnPage(book, mode));
    const hiddenCount = rows.length - books.length;
    bookIndex = new Map(rows.map((book) => [String(book.id), book.gallery]));
    const groups = new Map();
    for (const book of books) {
      const key = groupKey(book.date);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(book);
    }
    const keys = [...groups.keys()].filter((key) => key !== '?').sort((x, y) => (x < y ? 1 : (x > y ? -1 : 0)));
    if (groups.has('?')) keys.push('?');
    const events = eventsOf(books);
    const list = els.grid.classList.contains('is-list');
    const zoom = els.grid.dataset.zoom || '';
    const gridAttrs = `${list ? ' is-list' : ''}"${zoom ? ` data-zoom="${esc(zoom)}"` : ''}`;
    // 本の札の節は使い回す: 年 / 月の切り替え・網の作品が届いた後の描き直しで、同じ文の札は作り直さず
    // 新しい段へ移すだけ (200 枚の札と表紙を作り直すと、開き直しのたびに 60〜100ms の詰まりと表紙の復号のやり直し)。
    // 試験の張りぼての DOM では innerHTML の文がそのまま見えるように、前どおり文で入れる
    const reuse = !globalThis.__BUNKO_HARNESS__ && typeof document.createDocumentFragment === 'function' && typeof view.querySelectorAll === 'function';
    const existing = reuse ? new Map([...view.querySelectorAll('.home-av-cards > .card[data-id]')].map((node) => [node.dataset.id, node])) : null;
    const cardHtml = new Map();
    const sections = keys.map((key) => {
      const rows = groups.get(key);
      const unowned = rows.filter((book) => !(book.gallery && book.gallery.owned)).length;
      const fresh = rows.filter((book) => isNewBook(entry, book)).length;
      const chips = key === '?' ? '' : events.filter((event) => eventKey(event) === key)
        .map((event) => `<span class="home-av-ev" title="${esc(`${event.code} ${event.year} ${event.season} ${event.count} 冊`)}"><b>${esc(event.code)}</b>${esc(event.season)}</span>`).join('');
      return `<section class="home-av-group${key === '?' ? ' is-unknown' : ''}" data-key="${esc(key)}">`
        + `<h3 class="home-av-label"><span class="home-av-y">${esc(groupLabel(key))}</span>${chips}`
        + `<small>${rows.length} 冊${unowned ? ` (未所持 ${unowned})` : ''}</small>`
        + (fresh ? `<span class="home-av-fresh" title="発見の新作 ${fresh} 冊">新 ${fresh}</span>` : '')
        + '</h3>'
        + `<div class="grid home-av-cards${gridAttrs} data-key="${esc(key)}">${rows.map((book) => {
          const html = bookCard(book, { fresh: isNewBook(entry, book) });
          cardHtml.set(String(book.id), html);
          return reuse ? '' : html;
        }).join('')}</div>`
        + '</section>';
    }).join('');
    const dated = keys.filter((key) => key !== '?');
    const first = dated.length ? dated[dated.length - 1].slice(0, 4) : '';
    const last = dated.length ? dated[0].slice(0, 4) : '';
    const span = first ? (first === last ? first : `${first}–${last}`) : '';
    const unownedTotal = books.filter((book) => !(book.gallery && book.gallery.owned)).length;
    const offCount = everything.length - all.length;
    const hints = [
      hiddenCount ? `表示の切り替えで ${hiddenCount} 冊` : '',
      offCount ? `切ったサイトの ${offCount} 冊` : '',
    ].filter(Boolean);
    const countTitle = hints.length ? ` title="${esc(`${hints.join('、')}を隠しています`)}"` : '';
    const empty = hints.length
      ? `<p class="home-av-empty">表示している本はありません (${esc(hints.join('、'))}を隠しています)</p>`
      : (filter ? `<p class="home-av-empty">「${esc(filter.words)}」に当たる本はありません</p>` : '<p class="home-av-empty">本がありません</p>');
    // 数の札: 冊数・未所持・年の幅・★4・5 の割合・作者の★・発見の新作 (押すと最初の新作へ)
    const ownedRows = books.filter((book) => book.owned && !book.candidate);
    const high = ownedRows.filter((book) => Number(book.gallery && book.gallery.star) >= 4).length;
    const rating = Number(home.rating) || 0;
    const news = Number(home.newCount) || 0;
    const pills = [
      // 作品の検索の絞り。押すと語を外して全部の本 (検索の語は数の札の並びに置く: 頭の高さを変えない)
      filter ? `<button type="button" class="home-av-pill is-filter" data-home-unfilter title="「${esc(filter.words)}」に当たる本だけを出しています。押すとすべての本">「${esc(filter.words)}」<span aria-hidden="true">×</span></button>` : '',
      `<span class="home-av-pill home-av-count"${countTitle}>${books.length} 冊</span>`,
      unownedTotal ? `<span class="home-av-pill">未所持 ${unownedTotal}</span>` : '',
      span ? `<span class="home-av-pill">${esc(span)}</span>` : '',
      ownedRows.length >= 3 ? `<span class="home-av-pill" title="所持の本のうち Eagle の★4・5 の割合">★4・5 ${Math.round((high / ownedRows.length) * 100)}%</span>` : '',
      rating ? `<span class="home-av-pill is-rating" title="作者の★">作者 ★${rating}</span>` : '',
      news ? `<button type="button" class="home-av-pill is-new" data-home-first-new title="最初の新作へ">新作 +${news}</button>` : '',
    ].filter(Boolean).join('');
    const stars = starBooks(books);
    const starKick = stars.total > STAR_MAX
      ? `Eagle の ★5・★4 · ${stars.total} 冊のうち、しばらく読んでいない ${STAR_MAX} 冊`
      : `Eagle の ★5・★4 · ${stars.total} 冊`;
    const starSection = stars.picked.length
      ? '<section class="home-av-stars">'
        + `<h3 class="home-av-kick">★の高い本<small>${esc(starKick)}</small></h3>`
        + `<div class="home-av-bento${stars.picked.length >= 5 ? ' is-five' : ''}">${stars.picked.map(bentoCell).join('')}</div>`
        + '</section>'
      : '';
    // 本の札の大きさは一覧と揃える (一覧の Waterfall は表紙の大きさの設定を段の幅の下限に使う)
    const cardMin = window.BunkoUI
      ? `${authorCoverSize()}px`
      : els.grid.style.getPropertyValue('--card-min');
    if (cardMin) view.style.setProperty('--card-min', cardMin);
    view.innerHTML = '<header class="home-av-head">'
      + `<div class="home-fan home-av-fan" aria-hidden="true">${fanImages(home)}</div>`
      + `<div class="home-av-title"><h2>${esc(author.title)}</h2>`
      + (home.authorLine ? `<p class="home-av-sub">${esc(home.authorLine)}</p>` : '')
      + `<p class="home-av-pills">${pills}</p>`
      + `<p class="home-av-line">${present.length ? `<span class="home-av-sites" role="group" aria-label="出すサイト">${originToggles(present, off)}</span>` : ''}`
      + `<span class="home-av-status">${esc(statusText(entry))}</span></p></div>`
      + '</header>'
      + starSection
      + '<div class="home-av-years"><h3 class="home-av-kick">公開時期'
      + '<span class="ui-segments home-av-mode" role="group" aria-label="まとめ方">'
      + `<button type="button" data-home-group="year" aria-pressed="${groupBy === 'year'}">年</button>`
      + `<button type="button" data-home-group="month" aria-pressed="${groupBy === 'month'}">月</button></span></h3>`
      + `${sections || empty}</div>`;
    if (reuse) fillCardBoxes(keys, groups, cardHtml, existing);
    view.hidden = false;
    flag('data-home-author', true);
    renderedKey = viewKey(entry);
    layoutFlow();
  }

  // 段の器 (.home-av-cards) に本の札を入れる。前の描き直しの節 (existing) と文が同じ札はそのまま移す
  function fillCardBoxes(keys, groups, cardHtml, existing) {
    const used = new Set();
    const escape = window.CSS && typeof CSS.escape === 'function' ? CSS.escape : (s) => s;
    for (const key of keys) {
      const box = view.querySelector(`.home-av-cards[data-key="${escape(key)}"]`);
      if (!box) continue;
      const frag = document.createDocumentFragment();
      for (const book of groups.get(key)) {
        const id = String(book.id);
        const html = cardHtml.get(id);
        let node = existing.get(id);
        if (!node || node._bookHtml !== html || used.has(node)) {
          const tpl = document.createElement('template');
          tpl.innerHTML = html;
          node = tpl.content.firstElementChild;
          if (!node) continue;
          node._bookHtml = html;
        }
        used.add(node);
        frag.appendChild(node);
      }
      box.appendChild(frag);
    }
  }

  function topLine() {
    const bar = document.querySelector('.ui-topbar');
    return (bar ? bar.getBoundingClientRect().bottom : 120) + 14;
  }

  // 描き直しても読んでいる所を動かさない (網の作品が入った時・年と月を切り替えた時)。
  // 上部の下に最初に見えている札を目印にして、描き直した後も同じ高さに据える
  function renderKeepingPlace() {
    keepPlace(render);
  }

  // 上部の下に最初に見えている札を目印に、work の後も同じ高さに据える
  function keepPlace(work) {
    const line = topLine();
    let anchor = null;
    if (window.scrollY > 0) {
      for (const card of view.querySelectorAll('.card[data-id]')) {
        const top = card.getBoundingClientRect().top;
        if (top >= line - 4) {
          anchor = { id: card.dataset.id, top };
          break;
        }
      }
    }
    work();
    if (!anchor) return;
    const selector = window.CSS && typeof CSS.escape === 'function' ? CSS.escape(anchor.id) : anchor.id;
    const card = view.querySelector(`.card[data-id="${selector}"]`);
    if (card) window.scrollBy(0, card.getBoundingClientRect().top - anchor.top);
  }

  // 頭の「新作 +N」: 公開時期の最初の新作の本まで送り、縁を一度だけ光らせる (高さは動かさない)
  function jumpToFirstNew() {
    const card = view && view.querySelector('.home-av-years .home-book.is-new');
    if (!card) return;
    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    card.classList.remove('is-ping');
    void card.offsetWidth;
    card.classList.add('is-ping');
  }

  function onViewClick(event) {
    if (!shown || !shown.author) return;
    const id = shown.author.id;
    if (event.target.closest('[data-home-first-new]')) {
      jumpToFirstNew();
      return;
    }
    // 作品の検索の絞りを外す: 語の無い作者頁へ (戻るで絞った頁へ帰れる)
    if (event.target.closest('[data-home-unfilter]')) {
      openQuery(`@${(shown.author.home && shown.author.home.name) || shown.author.title}`);
      return;
    }
    const mode = event.target.closest('[data-home-group]');
    if (mode && mode.dataset.homeGroup !== groupBy) {
      // 年 / 月は作者頁ごとに覚える
      saveViewPrefs(id, { group: mode.dataset.homeGroup === 'month' ? 'month' : 'year' });
      renderKeepingPlace();
      return;
    }
    const toggle = event.target.closest('[data-home-origin]');
    if (toggle) {
      // 出すサイトの切り替えも作者頁ごとに覚える (切ったサイトはアイコンが薄くなる)
      const origin = toggle.dataset.homeOrigin;
      const off = new Set(viewPrefs(id).off);
      if (off.has(origin)) off.delete(origin);
      else off.add(origin);
      saveViewPrefs(id, { off: ORIGINS.filter((key) => off.has(key)) });
      renderKeepingPlace();
    }
  }

  // ---- 一覧の頭: 最近の動きの帯 ----

  function setOverview(overview) {
    lastOverview = {
      moving: Array.isArray(overview.moving) ? overview.moving : [],
    };
    overviewById.clear();
    for (const card of lastOverview.moving) if (card && card.id != null) overviewById.set(String(card.id), card);
    if (strip) strip.innerHTML = stripMarkup();
  }

  // 語・「判定できなかった作者だけ」の無い一覧の時だけ帯を出す (作者頁の間は CSS が畳む)
  function listingPlain() {
    return onHome() && !authorQuery() && !String(state.query || '').trim()
      && !(typeof homeUnresolvedOnly === 'function' && homeUnresolvedOnly());
  }

  function faceSrc(card) {
    const home = (card && card.home) || {};
    return home.cover ? esc(imgUrl(home.cover, 0, 'big')) : '';
  }

  function stripMarkup() {
    const moving = (lastOverview && lastOverview.moving) || [];
    if (!moving.length) return '';
    const items = moving.map((card) => {
      const home = card.home || {};
      const news = Number(home.newCount) || 0;
      const src = faceSrc(card);
      return `<button type="button" class="home-strip-item" data-home-person="${esc(card.id)}" title="${esc(card.title)}">`
        + `<span class="home-strip-face">${src ? `<img src="${src}" alt="" loading="lazy" draggable="false" />` : ''}${news > 0 ? `<span class="home-strip-new">+${news}</span>` : ''}</span>`
        + `<span class="home-strip-name">${esc(card.title)}</span>`
        + (home.authorLine ? `<span class="home-strip-sub">${esc(home.authorLine)}</span>` : '')
        + '</button>';
    }).join('');
    return `<h2 class="home-strip-kick">最近の動き<small>直近 2 週間 · ${moving.length} 人</small></h2>`
      + `<div class="home-strip-shelf"><div class="home-strip-clip"><div class="home-strip-row">${items}</div></div></div>`;
  }

  // 帯が溢れている時は横に巻ける (人数は 2 週間の動きで決まり、16 人で切らない)。端の暈しは巻ける向きにだけ。
  // 溢れた人数の「+N」は送った後も残って気になる (2026-09-27、利用者) ので出さない
  function fitStrip() {
    if (!strip || strip.hidden) return;
    const clip = strip.querySelector('.home-strip-clip');
    const row = strip.querySelector('.home-strip-row');
    if (!clip || !row) return;
    const over = row.scrollWidth - clip.clientWidth;
    strip.classList.toggle('is-over', over > 0);
    edgeStrip(clip);
  }

  function edgeStrip(clip) {
    const left = Number(clip.scrollLeft) || 0;
    strip.classList.toggle('at-start', left <= 1);
    strip.classList.toggle('at-end', left + clip.clientWidth >= clip.scrollWidth - 1);
  }

  // 最近の動きの送り: 右の端 (140px) に寄せたら一面ぶん先へ、左の端に寄せたら一面ぶん前へ (端に入った時に一度)。
  // 真ん中では今のまま。横のホイールと Shift + ホイールでも巻ける
  let stripZone = 0;
  function onStripMove(event) {
    if (!strip || !strip.classList.contains('is-over')) return;
    const clip = strip.querySelector('.home-strip-clip');
    if (!clip) return;
    const box = clip.getBoundingClientRect();
    const zone = event.clientX > box.right - 140 ? 1 : (event.clientX < box.left + 140 ? -1 : 0);
    if (zone === stripZone) return;
    stripZone = zone;
    if (zone && typeof clip.scrollBy === 'function') clip.scrollBy({ left: zone * Math.max(110, clip.clientWidth - 280), behavior: 'smooth' });
  }

  function paintOverview() {
    if (strip) {
      const show = Boolean(lastOverview && lastOverview.moving.length && listingPlain());
      strip.hidden = !show;
      if (show && !strip.firstChild) strip.innerHTML = stripMarkup();
      if (show) fitStrip();
    }
  }

  // 帯の丸い顔から作者頁へ
  function overviewTarget(event) {
    const item = event.target.closest('[data-home-person]');
    if (!item) return null;
    const card = overviewById.get(String(item.dataset.homePerson));
    return card ? { item, card } : null;
  }

  function openFromOverview(item, card) {
    captureFly(card.id, item.querySelector('img'), item.classList.contains('home-strip-item'));
    if (state.selected) {
      state.selected = null;
      renderDetail(null);
    }
    openAuthor(card);
  }

  // 最近の動きの丸い顔は、左クリックでも作者頁 (詳細は開かない。2026-09-27 の三回目の答え)
  function onStripClick(event) {
    const hit = overviewTarget(event);
    if (!hit) return;
    const now = Date.now();
    if (lastOpen.id === String(hit.card.id) && now - lastOpen.at < 600) return;
    lastOpen = { id: String(hit.card.id), at: now };
    openFromOverview(hit.item, hit.card);
  }

  function onStripContext(event) {
    const hit = overviewTarget(event);
    if (!hit) return;
    event.preventDefault();
    lastOpen = { id: String(hit.card.id), at: Date.now() };
    openFromOverview(hit.item, hit.card);
  }

  // 「ホーム」の札: 語 (作品の検索・作者頁の @名前) を外して一覧の一頁目へ戻る (一頁目へ引き直すのは本体の聞き手)。
  // 作者頁からなら今の頁を足跡に写すので、マウスの戻るで作者頁へ帰れる
  function onTypesCapture(event) {
    if (!ready || !onHome() || !event.target.closest('[data-type]')) return;
    // 打っていた語の候補の箱も閉じる (残ると一覧の頭を覆う)
    if (typeof hideSuggest === 'function') hideSuggest();
    if (!String(state.query || '').trim()) return;
    if (authorQuery()) snapshotCurrentHistory();
    state.query = '';
    els.query.value = '';
    syncQueryClear();
  }

  // 作者頁の頭のサイトの釦 (その作者頁に本がある出どころだけ)。押すとそのサイトの本を出す / 出さない
  function originToggles(present, off) {
    return present.map((origin) => {
      const site = ORIGIN_BY_KEY.get(origin);
      const label = site ? site.label : ORIGIN_LABEL.local;
      const on = !off.has(origin);
      const icon = site ? `<img src="${esc(site.icon)}" alt="">` : QUESTION;
      const title = `${label} の本を${on ? '隠す' : '出す'}`;
      return `<button type="button" class="home-origin-toggle${on ? '' : ' is-off'}${site ? '' : ' is-unknown'}" data-home-origin="${origin}" aria-pressed="${on}" title="${esc(title)}" aria-label="${esc(title)}">${icon}</button>`;
    }).join('');
  }

  // 作者頁の本 (一覧の外に並ぶ) を詳細・読むへ渡す。Home に居る間だけ
  function findBook(id) {
    if (!ready || !onHome()) return null;
    const key = String(id);
    if (overviewById.has(key)) return overviewById.get(key);
    if (bookIndex.has(key)) return bookIndex.get(key);
    for (const entry of entries.values()) {
      const own = (entry.books || []).find((book) => String(book.id) === key);
      if (own) return own.gallery;
      const web = webWorks(entry).find((work) => String(work.id) === key);
      if (web) return web.gallery;
    }
    return null;
  }

  // 読む画面の「次の本」: 作者頁を開いている間はその並び。それ以外は null (本体の一覧のまま)
  function readingOrder() {
    if (!ready || !onHome() || !view || view.hidden || !books.length) return null;
    return books.map((book) => book.gallery).filter(Boolean);
  }

  function init() {
    if (ready || typeof els === 'undefined' || !els.grid) return;
    view = document.createElement('section');
    view.id = 'home-author-view';
    view.className = 'home-author-view';
    view.hidden = true;
    const parent = els.grid.parentNode || els.grid.parentElement;
    if (parent && typeof parent.insertBefore === 'function') parent.insertBefore(view, els.grid);
    // 最近の動きの帯 (一覧の上)。一頁目の返りと同じ一巡で出す (後から一覧を押し下げない)
    strip = document.createElement('section');
    strip.className = 'home-strip';
    strip.setAttribute('aria-label', '最近の動き');
    strip.hidden = true;
    if (parent && typeof parent.insertBefore === 'function') parent.insertBefore(strip, els.grid);
    strip.addEventListener('click', onStripClick);
    strip.addEventListener('contextmenu', onStripContext);
    strip.addEventListener('mousemove', onStripMove);
    strip.addEventListener('mouseleave', () => {
      stripZone = 0;
    });
    strip.addEventListener('scroll', (event) => {
      if (event.target && event.target.classList && event.target.classList.contains('home-strip-clip')) edgeStrip(event.target);
    }, true);
    if (els.types && typeof els.types.addEventListener === 'function') els.types.addEventListener('click', onTypesCapture, true);
    // 本の札の押し分け・表紙の差し替え・虫眼鏡は一覧と同じ物
    bindCardEvents(view);
    view.addEventListener('load', onViewImageLoad, true);
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => {
        const width = view.clientWidth;
        if (!width || width === flowWidth) return;
        flowWidth = width;
        if (flowOn()) keepPlace(layoutFlow);
      }).observe(view);
    }
    view.addEventListener('click', onViewClick);
    els.detailBody.addEventListener('click', onDetailClick, true);
    els.detailBody.addEventListener('keydown', onDetailKey);
    window.addEventListener('resize', () => {
      fitStrip();
      placePicker();
    });
    document.addEventListener('keydown', onUndoKey);
    // 表紙を選ぶ板の Esc は、詳細を閉じる Esc (app.js) より先に取る
    document.addEventListener('keydown', onPickerKey, true);
    ready = true;
  }

  return {
    SOURCE,
    SITES,
    init,
    sync,
    press,
    findBook,
    readingOrder,
    cardMarkup: authorCardMarkup,
    fanFromUrls,
    detailMarkup,
    uniformList,
    relayout,
    toggleOwnedOnly,
    ownedOnlyActive,
    refresh,
    WEB_SITES,
    // 試験用
    bookCard,
    linkCell,
    merged,
    statusText,
    pickerMarkup,
    prefetch,
    viewHtml: () => (view ? String(view.innerHTML || '') : ''),
    viewNode: () => view,
    stripNode: () => strip,
    undoDepth: () => ({ undo: undoStack.length, redo: redoStack.length }),
  };
})();
