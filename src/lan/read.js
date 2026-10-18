'use strict';
/* 文匣 手のひら版 — 読む画面と道シルベ。
   #reader の中身と #coach の中身はここで組む (reader.html は骨組みだけ)。
   意匠はモック、速さの仕組みは旧実装 (reader-v1) から移した。 */
(function () {
  var BUNKO = (window.BUNKO = window.BUNKO || {});

  // ── 決めごと ───────────────────────────────────────────────
  var AHEAD = 3;          // 進む先に温める頁数。焼いた頁は 100KB 台なので抱えても困らない
  var BEHIND = 1;         // 戻る先
  var SPIN_WAIT = 200;    // 読み込み表示を出すまでの遅れ。すぐ来た頁で明滅させない
  var SAVE_WAIT = 800;    // 位置を投げるまでの待ち
  var HUD_WAIT = 3200;    // 操作板が独りでに引くまで
  var SWIPE_MIN = 40;     // 継ぎ目の上での横払い: これ未満は「開く」にしない (突いた指の揺れ)
  // 横滑り (Kindle と同じ、前後の頁が一本の帯で繋がった送り)。
  // 数字は iOS の頁送り (UIScrollView のページング) に寄せた: 遊び 10px、
  // 指を離した時に 0.3px/ms 以上なら指の向きに一枚、遅ければ幅の 35% を越えたら一枚。
  // 突いて送る時は 280ms、指から離れた後は速さに応じて 150〜280ms (速く払えば速く着く)。
  // Kindle 自身の数字は公開されていない (2026-09-11 調査)。曲線は様式の --ease-out と同じ
  var DRAG_SLOP = 10;
  var FLICK_V = 0.3;
  var COMMIT_RATIO = 0.35;
  var TURN_MS = 280;
  var SNAP_MS = 220;
  var TURN_EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';
  var RUBBER = 0.55;      // 端で引いた時の伸び (iOS のラバーバンドと同じ係数)
  var CLOSE_WAIT = 320;   // 閉じる動き (--t-base) を見せてから hidden に戻すまで
  var BACK_MIN = 5;       // つまみでこれ未満しか跳んでいないなら戻り札は出さない
  // 隅の小さな印にしたので、急いで引っ込めない。気づいて戻るまでの猶予
  var BACK_LIFE = 15000;
  // 二本指。写真アプリと同じ文法で、つまむと一覧へ引き、開くと頁へ戻る。
  // 0.75 / 1.33 は互いの逆数。同じ量の指の動きで、行きも帰りも同じ手ごたえになる
  var PINCH_IN = 0.75;
  var PINCH_OUT = 1.33;
  var MOSAIC_DEAF = 400;  // 一覧が開いた直後の押下は捨てる (つまんだ指の離れ際)
  // 下へ引いて閉じる。指の実距離で判じ、紙の沈みはその 0.55 倍に減衰させる
  // (指の通りに沈むと、閉じる前から画面が半分抜けて見える)
  var PULL_MAX = 110;
  var PULL_DAMP = 0.55;
  // これ未満の縦は、まだ払いか引きか決めない。実機で横払いの初動が斜めに入ると
  // 引きに化けて本が閉じたので、名前を付けるまでの間合いを広めに取る
  var PULL_SLOP = 14;
  var KEY_COACH = 'bunko.coach.seen';
  var KEY_DIR = 'bunko.read.dir';
  var KEY_FLOW = 'bunko.read.flow';

  var reader = document.getElementById('reader');
  var coach = document.getElementById('coach');
  if (!reader || !coach) return;

  // ── 印 (モックからそのまま) ────────────────────────────────
  function svg(w, h, body, extra) {
    return '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" fill="none" '
      + 'stroke="currentColor" stroke-width="' + (extra || '1.5') + '" aria-hidden="true">' + body + '</svg>';
  }
  var I_BACK = svg(20, 20, '<path d="M12.5 4L6.5 10l6 6" stroke-linecap="round" stroke-linejoin="round"/>', '1.6');
  var I_INFO = svg(19, 19, '<circle cx="9.5" cy="9.5" r="7"/><path d="M9.5 8.6v4.2M9.5 6.2v.9" stroke-linecap="round"/>');
  var I_PREFS = svg(19, 19, '<path d="M3 5.5h13M3 13.5h13" stroke-linecap="round"/>'
    + '<circle cx="7" cy="5.5" r="2.1" fill="#05070a"/><circle cx="12.5" cy="13.5" r="2.1" fill="#05070a"/>');
  var I_LTR = svg(34, 18, '<rect x="1" y="2" width="9" height="14" rx="1"/><rect x="24" y="2" width="9" height="14" rx="1"/>'
    + '<path d="M14 9h6M17.6 6.6L20 9l-2.4 2.4" stroke-linecap="round" stroke-linejoin="round"/>', '1.3');
  var I_RTL = svg(34, 18, '<rect x="1" y="2" width="9" height="14" rx="1"/><rect x="24" y="2" width="9" height="14" rx="1"/>'
    + '<path d="M20 9h-6M16.4 6.6L14 9l2.4 2.4" stroke-linecap="round" stroke-linejoin="round"/>', '1.3');
  var I_ONE = svg(34, 18, '<rect x="12" y="1.5" width="10" height="15" rx="1"/>', '1.3');
  var I_FLOW = svg(34, 18, '<rect x="12" y="-2.5" width="10" height="9" rx="1"/><rect x="12" y="8" width="10" height="9" rx="1"/>'
    + '<path d="M27.5 5v6M25.5 9.2l2 2 2-2" stroke-linecap="round" stroke-linejoin="round"/>', '1.3');
  var I_CHEV_L = svg(22, 22, '<path d="M13 5L7 11l6 6" stroke-linecap="round" stroke-linejoin="round"/>');
  var I_CHEV_R = svg(22, 22, '<path d="M9 5l6 6-6 6" stroke-linecap="round" stroke-linejoin="round"/>');
  var I_PANEL = svg(22, 22, '<rect x="3" y="6" width="16" height="10" rx="2"/>');

  // ── 骨 (モックの読む画面をそのまま移す) ────────────────────
  reader.className = 'view';
  reader.setAttribute('aria-label', '読む');
  reader.innerHTML = ''
    + '<div class="pageStage" id="pageStage">'
    +   '<div class="pageStrip" id="pageStrip">'
    +     '<div class="pageSheet" id="pageA"></div>'
    +     '<div class="pageSheet" id="pageB"></div>'
    +     '<div class="pageSheet" id="pageC"></div>'
    +   '</div>'
    + '</div>'
    + '<button class="zone l" id="zoneL" type="button" aria-label="前の頁"></button>'
    + '<button class="zone c" id="zoneC" type="button" aria-label="操作を出す"></button>'
    + '<button class="zone r" id="zoneR" type="button" aria-label="次の頁"></button>'
    + '<div class="chromeTop">'
    +   '<button class="iconBtn" id="btnBack" type="button" aria-label="棚へ戻る">' + I_BACK + '</button>'
    +   '<span class="readTitle" id="readTitle"></span>'
    +   '<button class="iconBtn" id="btnCoachOpen" type="button" aria-label="操作のしかた">' + I_INFO + '</button>'
    + '</div>'
    + '<div class="chromeBot">'
    +   '<div class="scrub">'
    +     '<div class="scrubRail" id="scrubRail" role="slider" tabindex="0" aria-label="頁を送る" '
    +       'aria-valuemin="1" aria-valuemax="1" aria-valuenow="1">'
    +       '<div class="scrubDone" id="scrubDone"></div>'
    +       '<div class="scrubKnob" id="scrubKnob"></div>'
    +       '<span class="scrubNum" id="scrubNum"><span id="pageNow">1</span><span id="pageOf"></span></span>'
    +     '</div>'
    +   '</div>'
    +   '<div class="readActs">'
    +     '<span class="spacer"></span>'
    +     '<button class="iconBtn" id="btnPrefs" type="button" aria-label="読み方を変える">' + I_PREFS + '</button>'
    +   '</div>'
    + '</div>'
    + '<section class="prefs" id="prefs" aria-label="読み方">'
    +   '<div class="grabber"></div>'
    +   '<div class="prefRow"><span class="prefLabel">めくる向き</span>'
    +     '<div class="segmented" role="group">'
    +       '<button class="seg" type="button" data-dir="ltr" aria-pressed="true" aria-label="左から右へ進む">' + I_LTR + '</button>'
    +       '<button class="seg" type="button" data-dir="rtl" aria-pressed="false" aria-label="右から左へ進む">' + I_RTL + '</button>'
    +     '</div>'
    +   '</div>'
    +   '<div class="prefRow"><span class="prefLabel">並べ方</span>'
    +     '<div class="segmented" role="group">'
    +       '<button class="seg" type="button" data-flow="page" aria-pressed="true" aria-label="1 頁ずつ出す">' + I_ONE + '</button>'
    +       '<button class="seg" type="button" data-flow="scroll" aria-pressed="false" aria-label="縦につづけて出す">' + I_FLOW + '</button>'
    +     '</div>'
    +   '</div>'
    + '</section>';

  coach.className = 'coach';

  function $(id) { return document.getElementById(id); }
  var pageStage = $('pageStage');
  var strip = $('pageStrip');
  var sheets = [$('pageA'), $('pageB'), $('pageC')];
  var readTitle = $('readTitle');
  var rail = $('scrubRail');
  var pageNow = $('pageNow');
  var pageOf = $('pageOf');

  // 縦送りの器はモックに無い (一頁ずつの意匠だけが描かれている)。
  // 様式が来ないので、要る寸法だけを直に張って自前で持つ
  var flow = document.createElement('div');
  flow.id = 'pageFlow';
  flow.className = 'pageFlow';
  flow.hidden = true;
  flow.style.cssText = 'position:absolute;inset:0;overflow-y:auto;overflow-x:hidden;'
    + '-webkit-overflow-scrolling:touch;overscroll-behavior:contain;';
  reader.insertBefore(flow, reader.children[1]);

  // 読み込み表示。モックには無いが「200ms 遅れて出す」ために要る。
  // 回転は Web Animations でつける (様式ファイルに keyframes を足さずに済む)
  var spin = document.createElement('div');
  spin.hidden = true;
  spin.style.cssText = 'position:absolute;left:50%;top:50%;z-index:50;pointer-events:none;'
    + 'transform:translate(-50%,-50%);width:22px;height:22px;';
  var spinRing = document.createElement('div');
  spinRing.style.cssText = 'width:22px;height:22px;border-radius:50%;'
    + 'border:2px solid #635015;border-top-color:#c9a227;';
  spin.appendChild(spinRing);
  reader.appendChild(spin);

  // 戻り札と読み終わりの重ね紙。どちらもモックには無いので、器だけ自前で足す。
  // hidden で伏せておき、出す時は道シルベと同じ「hidden 外し → reflow → 札」の順
  // (hidden のまま札を張ると、出る動きが省かれて瞬間で現れる)
  var backPill = document.createElement('button');
  backPill.type = 'button';
  backPill.id = 'backPill';
  backPill.className = 'backPill';
  backPill.hidden = true;
  // 文言も頁数も書かない。隅の ↩ 一つで「戻れる」が伝われば足りる
  backPill.setAttribute('aria-label', 'さっきの頁へ');
  backPill.innerHTML = svg(20, 20,
    '<path d="M8.2 5.2L4.6 8.8l3.6 3.6" stroke-linecap="round" stroke-linejoin="round"/>'
    + '<path d="M4.6 8.8h7.2a3.6 3.6 0 0 1 0 7.2h-2.6" stroke-linecap="round" stroke-linejoin="round"/>',
    '1.5');
  reader.appendChild(backPill);

  // 作品の継ぎ目 (机上版 reader-boundary と同じ意匠)。舞台の黒に隣の本の顔を浮かべ、
  // もう一度同じ向きに送るか、顔を突いたら開く。下に小さな「棚へ戻る」
  var boundary = document.createElement('div');
  boundary.id = 'readBoundary';
  boundary.className = 'readBoundary';
  boundary.hidden = true;
  reader.appendChild(boundary);

  // 頁の一覧 (モザイク)。二本指でつまむと開く 3 列の格子。
  // 器そのものが格子なので、中に紙を挟まず直にタイルを並べる
  var mosaic = document.createElement('div');
  mosaic.id = 'pageMosaic';
  mosaic.className = 'pageMosaic';
  mosaic.hidden = true;
  reader.appendChild(mosaic);

  // ── 状態 ───────────────────────────────────────────────────
  var book = null;        // { id, title, pageCount, version, ratios }
  var at = 0;             // 今の頁 (0 起点)
  var warm = new Map();   // 温めた頁 (index → Image)
  var renderToken = 0;    // 出す途中で頁が変わったら古い方を捨てる
  var sheetPage = [-1, -1, -1];  // 三枚の紙がそれぞれ抱えている頁 (-1 は空)
  var shownAt = -1;       // 帯の x=0 に居る頁。at と違う間は滑りの途中
  var slide = null;       // 走っている滑り { anim, to }
  var drag = null;        // 横の引き { id, x, y, on, base, last, t, v, w }
  var opened = false;
  // 既定は右→左 (漫画の向き)。Kindle の漫画と同じく、次の頁は左に控えていて
  // 右へ払うと出てくる。左→右派のために切替は読み方の紙に残す
  // (2026-09-11 に既定を ltr から改めた: 進み具合の棒を右から左へ、という指定に合わせて)
  var rtl = true;
  var vertical = false;
  var centerWatch = null;
  var spinTimer = null, hudTimer = null, saveTimer = null, closeTimer = null, resizeTimer = null;
  var dirty = false;      // まだ投げていない位置があるか
  // 継ぎ目から前の作品へ巻き戻って最終頁から入った印。頁を動かすまでは読了に数えない (机上版と同じ):
  // 先頭で前へ送っただけで、読んでいない前の作品が読了になっていた
  var enteredAtEnd = false;
  var enteredPage = -1;
  var pushed = false;     // 端末の「戻る」で閉じるための履歴を積んだか
  var held = false;       // つまみを掴んでいる間
  var heldAt = 0;
  var swallow = false;    // 払った直後の押下を捨てる
  var backFrom = -1;      // つまみで跳ぶ前に居た頁 (-1 は帰り道なし)
  var backTimer = null;
  var bound = null;       // 出ている継ぎ目 { item, side }。null なら頁の上に居る
  var mosaicOn = false;   // 頁の一覧が開いているか
  var mosaicFor = '';     // 一覧を組んである本 (id:版:頁数)。違えば組み直す
  var mosaicTimer = null;
  var mosaicOpened = 0;   // 開いた時刻
  var pinch = null;       // 二本指 { d0 }。d0 は始まりの間合い
  var pull = null;        // 下への引き { x, y, dy, on }
  var pullBox = null;     // 指に付いて沈む器 (一頁ずつなら舞台、縦送りなら流し)

  try {
    if (localStorage.getItem(KEY_DIR) === 'ltr') rtl = false;
    if (localStorage.getItem(KEY_FLOW) === 'scroll') vertical = true;
  } catch (e) { /* 覚えられなくても読める */ }

  function remember(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* 同上 */ }
  }

  // ── サーバの口 ─────────────────────────────────────────────
  function api(path, options) {
    if (BUNKO.host) return BUNKO.host.api(path, options);
    return fetch(path, Object.assign({ credentials: 'same-origin' }, options || {}))
      .then(function (res) {
        if (!res.ok) throw new Error(String(res.status));
        return res.json();
      });
  }

  // 頁は母艦がこの幅に焼いてから配る。出る大きさの実画素ぶんだけ頼めば足りる。
  // 一度決めたら動かさない: 幅を変えると焼き直しになる
  var WIDTH = 0;
  function widthOnce() {
    if (!WIDTH) {
      var box = Math.min(window.innerWidth, window.innerHeight * 0.72);
      WIDTH = Math.round(box * Math.min(window.devicePixelRatio || 1, 2));
    }
    return WIDTH;
  }

  // v は母艦が持つ実体の版。欠かすと差し替え後も古い頁を掴み続ける
  function pageUrl(index) {
    if (BUNKO.host) return BUNKO.host.pageUrl(book.id, index, widthOnce(), book.version);
    return '/api/book/' + encodeURIComponent(book.id) + '/page/' + index
      + '?w=' + widthOnce() + '&v=' + (book.version || 0);
  }

  // ── 先読み ─────────────────────────────────────────────────
  function warmPage(index) {
    if (!book || index < 0 || index >= book.pageCount) return null;
    var have = warm.get(index);
    if (have) return have;
    var img = new Image();
    img.decoding = 'async';
    img.alt = '';
    // 様式が svg 前提でも紙が枠を割らないよう、寸法だけは直に張る
    img.style.cssText = 'display:block;max-width:100%;max-height:100%;'
      + 'width:auto;height:auto;object-fit:contain;box-shadow:0 0 40px rgba(0,0,0,.7);';
    img.src = pageUrl(index);
    // 取ってくるだけでなく画に起こすところまで先に済ませる。送る時まで復号を
    // 残すと、届いている頁でもその一拍だけ白が見える (机上の reader.js と同じ手)
    if (img.decode) img.decode().catch(function () { /* 出せない頁は出す時に諦める */ });
    warm.set(index, img);
    return img;
  }

  // 進む向きへ 3 頁、戻る向きへ 1 頁。行き過ぎた分は手放す
  // (端末の中には残るので、戻っても取り直しにはならない)
  function warmAround() {
    var i;
    for (i = 1; i <= AHEAD; i += 1) warmPage(at + i);
    for (i = 1; i <= BEHIND; i += 1) warmPage(at - i);
    warm.forEach(function (img, index) {
      if (index < at - BEHIND - 1 || index > at + AHEAD + 1) warm.delete(index);
    });
  }

  function whenReady(img) {
    // decode まで待つ。load だけで出すと、画に起こす間が最初の描画で見える
    if (img.decode) return img.decode().catch(function () { /* 出せない頁は空のまま */ });
    if (img.complete) return Promise.resolve();
    return new Promise(function (done) {
      img.addEventListener('load', done);
      img.addEventListener('error', done);
    });
  }

  function startSpin() {
    clearTimeout(spinTimer);
    spinTimer = setTimeout(function () {
      spin.hidden = false;
      if (spinRing.animate && !spinRing.__turning) {
        spinRing.__turning = true;
        spinRing.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
          { duration: 900, iterations: Infinity });
      }
    }, SPIN_WAIT);
  }

  function stopSpin() {
    clearTimeout(spinTimer);
    spin.hidden = true;
  }

  // ── 一頁ずつ (三枚の紙を一本の帯にして横に滑らせる) ─────────
  // Kindle と同じ組み方: 前の頁・今の頁・次の頁を帯に並べ、帯ごと指に付いて動く。
  // 「次」が左に控えるのが rtl (既定)、右に控えるのが ltr。動くのは帯の x だけで、
  // 紙は帯の中で位置が決まっている。着地したら紙を積み替えて帯を 0 に戻す
  // (積み替えと戻しは同じ一手で行うので、見た目は一枚も動かない)。
  // 滑りは Web Animations で走らせる: 指が触れたら今の位置を読んで途中から引き継げる
  var reduceMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

  function nextSide() { return rtl ? -1 : 1; }
  function stageWidth() { return pageStage.clientWidth || window.innerWidth || 1; }

  // 頁 index を x=0 に出すのに要る帯の x (px)
  function stripXFor(index) { return -(index - shownAt) * nextSide() * stageWidth(); }

  function setStripX(x) {
    strip.style.transform = Math.abs(x) < 0.5 ? '' : 'translate3d(' + x.toFixed(1) + 'px,0,0)';
  }

  // 走っている滑りの途中でも、今まさに見えている x を返す
  function currentStripX() {
    var m = getComputedStyle(strip).transform;
    if (!m || m === 'none') return 0;
    var hit = m.match(/matrix(?:3d)?\(([^)]+)\)/);
    if (!hit) return 0;
    var list = hit[1].split(',');
    return parseFloat(list.length > 6 ? list[12] : list[4]) || 0;
  }

  function fillSheet(i, index) {
    var sheet = sheets[i];
    if (sheetPage[i] === index && (index < 0 || sheet.firstChild)) return;  // 同じ頁なら触らない (絵が一瞬消える)
    sheetPage[i] = index;
    var img = index >= 0 ? warmPage(index) : null;
    if (!img) { sheet.textContent = ''; return; }
    if (sheet.firstChild !== img) { sheet.textContent = ''; sheet.appendChild(img); }
  }

  // shownAt を x=0 に、その両隣を左右に置き、帯の x を 0 に戻す
  function layout() {
    if (!book || shownAt < 0) return;
    var cur = sheetPage.indexOf(shownAt);
    if (cur < 0) { cur = 0; sheetPage[0] = -1; }   // 誰も抱えていない (開いた直後・跳んだ時)
    var free = [0, 1, 2].filter(function (i) { return i !== cur; });
    // 既にその頁を抱えている紙はそのまま使う (積み替えると絵が一瞬消える)
    var p = sheetPage.indexOf(shownAt - 1);
    var n = sheetPage.indexOf(shownAt + 1);
    if (free.indexOf(p) < 0) p = -1;
    if (free.indexOf(n) < 0) n = -1;
    if (p < 0) p = free[0] === n ? free[1] : free[0];
    if (n < 0) n = free[0] === p ? free[1] : free[0];
    fillSheet(cur, shownAt);
    fillSheet(p, shownAt > 0 ? shownAt - 1 : -1);
    fillSheet(n, shownAt + 1 < book.pageCount ? shownAt + 1 : -1);
    var side = nextSide();
    sheets[cur].style.transform = '';
    sheets[p].style.transform = 'translateX(' + (-side * 100) + '%)';
    sheets[n].style.transform = 'translateX(' + (side * 100) + '%)';
    setStripX(0);
  }

  function stopSlide() {
    if (!slide) return;
    var anim = slide.anim;
    slide = null;
    anim.cancel();
  }

  // 頁 index に着地する。走っている滑りは打ち切って、その頁の紙を x=0 に据える
  function commit(index) {
    stopSlide();
    shownAt = index;
    layout();
    warmAround();
  }

  function slideTo(index, ms) {
    if (shownAt < 0) { commit(index); return; }
    var from = currentStripX();
    stopSlide();
    var to = stripXFor(index);
    if (!strip.animate || ms <= 0 || (reduceMotion && reduceMotion.matches) || Math.abs(to - from) < 1) {
      commit(index);
      return;
    }
    setStripX(from);   // cancel で戻った値を、今見えていた所へ上書きしてから走らせる
    var anim = strip.animate(
      [{ transform: 'translate3d(' + from.toFixed(1) + 'px,0,0)' },
       { transform: 'translate3d(' + to.toFixed(1) + 'px,0,0)' }],
      { duration: ms, easing: TURN_EASE, fill: 'forwards' });
    slide = { anim: anim, to: index };
    anim.onfinish = function () {
      if (slide && slide.anim === anim) commit(index);
    };
  }

  // 突いて・鍵盤で送る。at はもう新しい頁になっている。
  // 届いていない頁は待ってから滑らせる (空の紙が滑ってくるのは見せない)
  function turn() {
    var token = ++renderToken;
    var img = warmPage(at);
    if (!img) return;
    startSpin();
    whenReady(img).then(function () {
      if (token !== renderToken) return;
      stopSpin();
      // 帯に居ない頁 (滑りの途中で二度目の送り) は、走っている滑りを先に着地させる
      if (Math.abs(at - shownAt) > 1 && slide) commit(slide.to);
      if (Math.abs(at - shownAt) > 1) { commit(at); return; }
      slideTo(at, TURN_MS);
    });
  }

  // 開いた時・跳んだ時。滑らせない (行き先が遠すぎて目が追えない)
  function showFlat() {
    var token = ++renderToken;
    var img = warmPage(at);
    if (!img) return;
    // 前の頁は出したまま待つ。先に消すと、速く来た時でも暗転だけが見える
    startSpin();
    whenReady(img).then(function () {
      if (token !== renderToken) return;
      stopSpin();
      commit(at);
    });
  }

  function resetSheets() {
    stopSlide();
    drag = null;
    shownAt = -1;
    sheetPage = [-1, -1, -1];
    for (var i = 0; i < sheets.length; i += 1) {
      sheets[i].textContent = '';
      sheets[i].style.transform = '';
    }
    setStripX(0);
  }

  // ── 縦につづけて ───────────────────────────────────────────
  function ratioAt(index) {
    var list = (book && book.ratios) || [];
    return list[index] || list[0] || 0.72;
  }

  function teardownFlow() {
    if (centerWatch) { centerWatch.disconnect(); centerWatch = null; }
  }

  function buildFlow() {
    teardownFlow();
    flow.textContent = '';
    for (var i = 0; i < book.pageCount; i += 1) {
      var img = document.createElement('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      // 縦横比は先に貰っている: 出る前から場所を取らせて、読む所が飛ばないようにする
      img.style.cssText = 'display:block;width:100%;margin:0 auto 2px;object-fit:contain;background:#0a0a0a;';
      img.style.aspectRatio = String(ratioAt(i));
      img.dataset.index = String(i);
      img.src = pageUrl(i);
      img.alt = '';
      flow.appendChild(img);
    }
    // 真ん中の帯に入っている頁を「今の頁」とみなす
    centerWatch = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var index = Number(entry.target.dataset.index);
        if (index === at) return;
        at = index;
        updateHud();
        saveSoon();
      });
    }, { root: flow, rootMargin: '-45% 0px -45% 0px' });
    for (var k = 0; k < flow.children.length; k += 1) centerWatch.observe(flow.children[k]);
  }

  // scrollIntoView は使わない: あれは祖先を全部たぐる。overflow:hidden の
  // #reader もプログラムからは動いてしまい、頁が上に見切れ・下端の外に控えた
  // 紙 (読み方) が覗く事故になった (実機で発覚)。動かすのは器一つだけ
  function scrollTo0(container, el, center) {
    if (!el) return;
    var top = el.offsetTop;
    if (center) top -= Math.max(0, (container.clientHeight - el.offsetHeight) / 2);
    container.scrollTop = Math.max(0, top);
  }

  function showFlow() {
    if (flow.childElementCount !== book.pageCount) buildFlow();
    scrollTo0(flow, flow.children[at]);
    stopSpin();
  }

  // 送り帯を退ける場面が三つある: 縦送り (帯が縦の指を横取りする)、
  // 継ぎ目 (帯が上に居ると隣の本の顔を突けない)、頁の一覧 (帯が上に居ると
  // 縦に繰れないしタイルも突けない)。まとめて一か所で判じる
  function syncZones() {
    var off = vertical || !boundary.hidden || mosaicOn;
    $('zoneL').hidden = off;
    $('zoneR').hidden = off;
    $('zoneC').hidden = off;
  }

  function applyFlowMode() {
    pageStage.hidden = vertical;
    flow.hidden = !vertical;
    syncZones();
    if (!vertical) { teardownFlow(); flow.textContent = ''; }
  }

  // ── 出す ───────────────────────────────────────────────────
  function render() {
    if (!book) return;
    if (at < 0) at = 0;
    if (at > book.pageCount - 1) at = book.pageCount - 1;
    if (vertical) showFlow();
    else showFlat();
    updateHud();
    saveSoon();
  }

  function step(forward) {
    if (!book) return;
    var side = forward ? 1 : -1;
    var next = at + side;
    if (next < 0 || next >= book.pageCount) {
      // 端に着いただけでは何も出さない。そこからもう一度送ろうとした仕草を
      // 「隣へ渡りたい」の合図として受ける (着地と読了は別の出来事)。
      // 継ぎ目が既に出ているところへ同じ向きの送りが来たら、それが「開く」
      if (bound && bound.side === side) {
        if (bound.item) openBound();
        return;
      }
      showBoundary(side);
      return;
    }
    hideBack();                    // 手でめくったなら帰り道は用済み
    if (bound) hideBoundary();     // 継ぎ目から頁へ戻った
    at = next;
    if (vertical) { render(); return; }
    // 帯が滑って隣の頁が入ってくる。どちら側から来るかは layout が rtl で決めている
    turn();
    updateHud();
    saveSoon();
  }

  function goTo(index) {
    if (!book || index === at) return;
    at = index;
    render();
  }

  // ── 戻り札 (つまみで跳んだ後の帰り道) ──────────────────────
  function showBack() {
    clearTimeout(backTimer);
    backPill.hidden = false;
    void backPill.offsetWidth;
    backPill.classList.add('on');
    backTimer = setTimeout(hideBack, BACK_LIFE);
  }

  function hideBack() {
    if (backPill.hidden || !backPill.classList.contains('on')) return;
    clearTimeout(backTimer);
    backFrom = -1;
    backPill.classList.remove('on');
    // 引っ込む動きを見せてから伏せる (出し直しが挟まったら触らない)
    backTimer = setTimeout(function () {
      if (!backPill.classList.contains('on')) backPill.hidden = true;
    }, CLOSE_WAIT);
  }

  backPill.addEventListener('click', function () {
    var to = backFrom;
    hideBack();               // 先に引っ込める。戻った先で札は出し直さない (一往復だけ)
    if (to >= 0) goTo(to);
  });

  // ── 作品の継ぎ目 (机上版と同じ) ────────────────────────────
  function esc(text) {
    return String(text).replace(/[&<>"]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;';
    });
  }

  // 素性は {name, label} で来る (label は日本語札)。古い形 (文字列) も受ける
  function creatorOf(item) {
    var first = (item.artists && item.artists[0]) || (item.groups && item.groups[0]) || null;
    if (!first) return '';
    if (typeof first === 'string') return first;
    return first.label || first.name || '';
  }

  // 隣 = 棚の並びの一つ隣 (机上版と同じ「開いた一覧での次の行」)。棚が知っている
  function neighborOf(side) {
    if (!book || !BUNKO.shelf || typeof BUNKO.shelf.neighbor !== 'function') return null;
    try {
      return BUNKO.shelf.neighbor(book.id, side) || null;
    } catch (e) {
      return null;
    }
  }

  function showBoundary(side) {
    if (!book) return;
    var item = neighborOf(side);
    bound = { item: item, side: side };
    var card;
    if (item) {
      var creator = creatorOf(item);
      var star = Math.round(Number(item.star)) || 0;
      card = '<div class="reader-next" data-bound="open">'
        + '<img class="reader-next-cover" alt="" decoding="async" '
        +   'src="/api/book/' + encodeURIComponent(item.id) + '/cover">'
        + '<div class="reader-next-text">'
        + '<p class="reader-next-kicker">' + (side > 0 ? '次の作品' : '前の作品') + '</p>'
        + '<p class="reader-next-title">' + esc(item.title || '') + '</p>'
        + (creator ? '<p class="reader-next-creator">' + esc(creator) + '</p>' : '')
        + (star > 0 ? '<p class="reader-next-star">★' + star + '</p>' : '')
        + '</div></div>';
    } else {
      // 棚の端まで来た。隣は無いが、読み終えたことだけ静かに言う
      card = '<div class="reader-next"><div class="reader-next-text">'
        + '<p class="reader-next-kicker eol">' + (side > 0 ? '読み終えた' : '最初の頁') + '</p>'
        + '</div></div>';
    }
    boundary.innerHTML = card
      + '<button class="boundaryShelf" type="button" data-bound="shelf">棚へ戻る</button>';
    boundary.hidden = false;
    syncZones();     // 帯を退けて、顔と釦に指が届くようにする
    hideBack();
  }

  function hideBoundary() {
    bound = null;
    if (boundary.hidden) return;
    boundary.hidden = true;
    boundary.innerHTML = '';
    syncZones();
  }

  function openBound() {
    if (!bound || !bound.item) return;
    var item = bound.item;
    var side = bound.side;
    hideBoundary();
    // 渡る前に栞を投げ切る。openReader は closeReader を通らないので、
    // 800ms の書き待ちが残っていると読了が消える
    saveNow();
    // 前の作品へは巻き戻りなので最後の頁から入る (机上版と同じ)
    openReader(item, { start: side > 0 ? 'resume' : 'last' });
  }

  boundary.addEventListener('click', function (e) {
    var hit = e.target.closest ? e.target.closest('[data-bound]') : null;
    if (!hit) { hideBoundary(); return; }   // 黒の余白を突いたら頁へ戻るだけ
    if (hit.dataset.bound === 'shelf') { hideBoundary(); requestClose(); return; }
    openBound();
  });

  // ── 頁の一覧 (二本指でつまむと開く) ───────────────────────
  // タイルは読む画面と同じ URL (= 同じ幅の焼き上がり) を流用する。
  // 一覧のために別の幅を頼むと、母艦が全頁をもう一度焼き直すことになる。
  // 訪れた頁は端末に残っているので即出て、未訪の頁だけが lazy で焼き場へ届く
  function buildMosaic() {
    var key = book.id + ':' + (book.version || 0) + ':' + book.pageCount;
    if (mosaicFor === key) return;
    mosaicFor = key;
    var frag = document.createDocumentFragment();
    for (var i = 0; i < book.pageCount; i += 1) {
      var tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'mosaicTile';
      tile.dataset.index = String(i);
      // 面には数字を書かない (絵と並びで足りる)。ただし読み上げでは頁を
      // 名指せないと選びようがないので、名前だけは番号で与える
      tile.setAttribute('aria-label', (i + 1) + ' 頁');
      var img = document.createElement('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = '';
      // 箱の縦横比は様式が持つ (表紙と同じ縦長で固定)。頁ごとの比で箱を
      // 変えると、横長の頁が混ざった時に格子が乱れて目で追えない
      img.src = pageUrl(i);
      tile.appendChild(img);
      frag.appendChild(tile);
    }
    mosaic.textContent = '';
    mosaic.appendChild(frag);
  }

  // 今の頁だけ真鍮の枠。開いた時はその枠が真ん中に来るまで繰っておく
  function markMosaicNow(center) {
    var kids = mosaic.children;
    for (var i = 0; i < kids.length; i += 1) kids[i].classList.toggle('now', i === at);
    if (center) scrollTo0(mosaic, kids[at], true);
  }

  function openMosaic() {
    if (!book || mosaicOn) return;
    buildMosaic();
    mosaicOn = true;
    mosaicOpened = Date.now();
    clearTimeout(mosaicTimer);
    mosaic.hidden = false;
    void mosaic.offsetWidth;   // hidden を外した所を確定させてから札を張る (出る動きのため)
    flag('mosaicOn', true);
    clearTimeout(hudTimer);
    flag('chromeOn', false);   // 一覧の間は操作板を引かせる (選ぶ所だけを見せる)
    flag('prefsOn', false);    // 読み方の紙が出たまま一覧に引くと、紙が上に残る
    syncZones();
    markMosaicNow(true);
    // 万一 #reader がずれていても、ここで必ず 0 に戻す (見切れの保険)
    reader.scrollTop = 0;
  }

  function closeMosaic() {
    if (!mosaicOn) return;
    mosaicOn = false;
    flag('mosaicOn', false);
    syncZones();
    // 引く動きを見せてから伏せる (開き直しが挟まったら触らない)
    clearTimeout(mosaicTimer);
    mosaicTimer = setTimeout(function () {
      if (!mosaicOn) mosaic.hidden = true;
    }, CLOSE_WAIT);
  }

  function resetMosaic() {
    clearTimeout(mosaicTimer);
    mosaicOn = false;
    flag('mosaicOn', false);
    mosaic.hidden = true;
    mosaic.textContent = '';
    mosaicFor = '';
  }

  mosaic.addEventListener('click', function (e) {
    var tile = e.target.closest ? e.target.closest('.mosaicTile') : null;
    // タイルの間の地を突いたら閉じるだけ (外を突けば閉じる、の共通文法)
    if (!tile) { closeMosaic(); return; }
    // つまみ終えて離した指が、そのまま下のタイルを突いてしまわないように
    if (Date.now() - mosaicOpened < MOSAIC_DEAF) return;
    var index = Number(tile.dataset.index);
    closeMosaic();
    if (index === at) return;   // 真鍮の枠 (今の頁) を突いたら、跳ばずにただ閉じる
    var from = at;
    goTo(index);
    // つまみの跳びと同じ扱い。大きく跳んだ時だけ帰り道を残す
    if (Math.abs(index - from) >= BACK_MIN) { backFrom = from; showBack(); }
    else hideBack();
  });

  // 本を替えるとき・閉じるときは、前の本の札をその場で片づける
  function resetExtras() {
    clearTimeout(backTimer);
    backFrom = -1;
    backPill.classList.remove('on');
    backPill.hidden = true;
    resetMosaic();
    hideBoundary();
    endPull(false);
    stopSlide();
    drag = null;
    // 引きかけのまま本が替わっても、次の本が沈んだ所から始まらないように
    pageStage.style.transform = '';
    pageStage.classList.remove('pullBack');
    flow.style.transform = '';
    flow.classList.remove('pullBack');
  }

  // ── 操作板とつまみ ─────────────────────────────────────────
  function updateHud() {
    if (!book) return;
    var shown = held ? heldAt : at;
    // 丸は 1 頁目で端に、最後の頁で反対の端に着く (Kindle の位置つまみと同じ)。
    // どちらの端から始まるかは読む向きが決める: rtl なら右から左へ進む
    var pct = book.pageCount > 1 ? (shown / (book.pageCount - 1)) * 100 : 100;
    rail.classList.toggle('rtl', rtl);
    rail.style.setProperty('--pct', pct.toFixed(2) + '%');
    pageNow.textContent = String(shown + 1);
    pageOf.textContent = ' / ' + book.pageCount;
    rail.setAttribute('aria-valuemax', String(book.pageCount));
    rail.setAttribute('aria-valuenow', String(shown + 1));
  }

  function flag(name, on) {
    // モックの .screen に当たる器がここには無い。胴 (body) を器として使い、
    // #reader にも同じ札を張る (様式がどちらを見ていても効くように)
    document.body.classList.toggle(name, on);
    reader.classList.toggle(name, on);
  }

  function showHud(on) {
    flag('chromeOn', on);
    clearTimeout(hudTimer);
    if (on) hudTimer = setTimeout(function () { flag('chromeOn', false); }, HUD_WAIT);
  }

  function seekRatio(clientX) {
    var box = rail.getBoundingClientRect();
    if (!box.width) return 0;
    var r = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
    return rtl ? 1 - r : r;   // 右から左へ進む棒では、右端が 0
  }

  function railIndex(clientX) {
    var n = Math.round(seekRatio(clientX) * (book.pageCount - 1));
    return Math.min(book.pageCount - 1, Math.max(0, n));
  }

  rail.addEventListener('pointerdown', function (e) {
    if (!book) return;
    if (rail.setPointerCapture) rail.setPointerCapture(e.pointerId);
    held = true;
    heldAt = railIndex(e.clientX);
    rail.classList.add('held');
    clearTimeout(hudTimer);   // 掴んでいる間は操作板を引かせない
    updateHud();
  });
  rail.addEventListener('pointermove', function (e) {
    // 掴んでいる間は数字とつまみだけ動かす。1 頁ごとに焼き場を叩かない
    if (!held || !book) return;
    heldAt = railIndex(e.clientX);
    updateHud();
  });
  function releaseRail() {
    if (!held) return;
    held = false;
    rail.classList.remove('held');
    var from = at;
    goTo(heldAt);   // 離したところの頁へ
    // 大きく跳んだ時だけ帰り道を残す。数頁の送りで札が出ると、ただの邪魔になる。
    // 跳び直したら取り直す (帰り道は常に「直前に居た頁」の一つだけ)
    if (Math.abs(heldAt - from) >= BACK_MIN) { backFrom = from; showBack(); }
    else hideBack();
    showHud(true);
  }
  rail.addEventListener('pointerup', releaseRail);
  rail.addEventListener('pointercancel', function () {
    held = false;
    rail.classList.remove('held');
    updateHud();
    showHud(true);
  });
  rail.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft') { step(rtl); e.preventDefault(); }
    if (e.key === 'ArrowRight') { step(!rtl); e.preventDefault(); }
  });

  // ── 読み方 ─────────────────────────────────────────────────
  function markSegs(attr, value) {
    var list = reader.querySelectorAll('.seg[data-' + attr + ']');
    for (var i = 0; i < list.length; i += 1) {
      list[i].setAttribute('aria-pressed', String(list[i].dataset[attr] === value));
    }
  }

  function applyDir() {
    markSegs('dir', rtl ? 'rtl' : 'ltr');
    // 帯の名も向きに従う。左が「次」になるのは rtl に切り替えたときだけ
    $('zoneL').setAttribute('aria-label', rtl ? '次の頁' : '前の頁');
    $('zoneR').setAttribute('aria-label', rtl ? '前の頁' : '次の頁');
  }

  reader.addEventListener('click', function (e) {
    var seg = e.target.closest ? e.target.closest('.seg') : null;
    if (!seg) return;
    if (seg.dataset.dir) {
      rtl = seg.dataset.dir === 'rtl';
      remember(KEY_DIR, rtl ? 'rtl' : 'ltr');
      applyDir();
      fillCoach();
      // 隣の頁が控える側と、棒の進む向きが入れ替わる
      if (!vertical && shownAt >= 0) commit(at);
      updateHud();
    } else if (seg.dataset.flow) {
      var want = seg.dataset.flow === 'scroll';
      if (want === vertical) return;
      vertical = want;
      remember(KEY_FLOW, vertical ? 'scroll' : 'page');
      markSegs('flow', vertical ? 'scroll' : 'page');
      renderToken += 1;   // 出しかけの頁を捨ててから組み替える
      stopSpin();
      applyFlowMode();
      if (!vertical) resetSheets();
      render();
    }
  });

  $('btnPrefs').addEventListener('click', function () {
    flag('prefsOn', true);
    clearTimeout(hudTimer);
  });
  function closePrefs() {
    if (!document.body.classList.contains('prefsOn')) return false;
    flag('prefsOn', false);
    showHud(true);
    return true;
  }

  // 閉じる釦は置かない (利用者判断)。紙と胴と同じく、下に払って閉じる。
  // 段の釦 (seg) の上で始まった指も、10px 動くまでは押下として扱う
  var prefsEl = $('prefs');
  var prefsDrag = null;
  prefsEl.addEventListener('touchstart', function (e) {
    prefsDrag = e.touches.length === 1 ? { y: e.touches[0].clientY, dy: 0, on: false } : null;
  }, { passive: true });
  prefsEl.addEventListener('touchmove', function (e) {
    if (!prefsDrag || e.touches.length !== 1) return;
    var dy = e.touches[0].clientY - prefsDrag.y;
    if (!prefsDrag.on) {
      if (Math.abs(dy) < 10) return;
      if (dy < 0) { prefsDrag = null; return; }   // 上への指は紙の用ではない
      prefsDrag.on = true;
      prefsEl.style.transition = 'none';          // 引いている間は指に直結
    }
    prefsDrag.dy = Math.max(0, dy);
    e.preventDefault();
    prefsEl.style.transform = 'translateY(' + prefsDrag.dy + 'px)';
  }, { passive: false });
  function endPrefsDrag() {
    if (!prefsDrag) return;
    var far = prefsDrag.on && prefsDrag.dy > 90;
    prefsDrag = null;
    prefsEl.style.transition = '';
    prefsEl.style.transform = '';
    if (far) closePrefs();
  }
  prefsEl.addEventListener('touchend', endPrefsDrag);
  prefsEl.addEventListener('touchcancel', endPrefsDrag);

  // ── 道シルベ ───────────────────────────────────────────────
  function cell(mark, label) {
    return '<div class="coachCell">' + mark + '<b>' + label + '</b></div>';
  }
  function fillCoach() {
    coach.innerHTML = ''
      + cell(I_CHEV_L, rtl ? '次へ' : '前へ')
      + cell(I_PANEL, '操作を出す')
      + cell(I_CHEV_R, rtl ? '前へ' : '次へ')
      + '<div class="coachFoot">'
      +   '<p>横に払っても送れます</p>'
      +   '<button class="btn primary" id="btnCoach" type="button">閉じる</button>'
      + '</div>';
  }
  function openCoach() {
    fillCoach();
    coach.hidden = false;
    void coach.offsetWidth;   // hidden を外した状態を一度確定させないと、出る動きが省かれる
    flag('coachOn', true);
    clearTimeout(hudTimer);
  }
  function closeCoach() {
    flag('coachOn', false);
    setTimeout(function () {
      if (!document.body.classList.contains('coachOn')) coach.hidden = true;
    }, CLOSE_WAIT);
    showHud(true);
  }
  coach.addEventListener('click', function (e) {
    // 重ね紙のどこを突いても閉じてよい (説明を読み終えたら退く紙なので)
    if (e.target.closest && e.target.closest('.coachCell')) return;
    closeCoach();
  });
  $('btnCoachOpen').addEventListener('click', openCoach);

  // ── 位置を残す ─────────────────────────────────────────────
  function saveSoon() {
    if (enteredAtEnd && at !== enteredPage) enteredAtEnd = false;
    dirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, SAVE_WAIT);
  }

  function saveNow() {
    if (!book || !dirty) return;
    dirty = false;
    clearTimeout(saveTimer);
    if (BUNKO.host) {
      BUNKO.host.saveReading(book.id, { page: at, pageCount: book.pageCount, finished: finishedNow() }).catch(function () {});
      return;
    }
    // 画面を閉じる瞬間でも飛ぶように keepalive で投げる
    fetch('/api/reading/' + encodeURIComponent(book.id), {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page: at, pageCount: book.pageCount, finished: finishedNow() }),
      keepalive: true
    }).catch(function () { /* 位置が残らなくても読書は続く */ });
  }

  function finishedNow() {
    return !!book && at >= book.pageCount - 1 && !enteredAtEnd;
  }

  // ── 文書スクロールの錠 ─────────────────────────────────────
  // 棚は文書ごとスクロールする (Safari の帯を畳ませる合図)。読む画面が上に
  // 居る間は、裏の棚が流れないよう body を今の位置で固定し、閉じる時に戻す
  // 錠は html の overflow:hidden (reader.css の html.reading)。以前は body を position:fixed
  // で今の位置に固定していたが、それだと文書が画面の高さまで縮み、iPhone の据え置き
  // (status bar を透かす全画面) では WebKit が fixed の基準を文書の矩形に閉じ込めるので
  // 読む画面が status bar のぶん (62px) 短く切れて下に帯が残った (2026-09-11 実測・調査)。
  // 文書を縮めなければ基準は棚と同じく底まで届く。overflow:hidden が据え置きで効かない
  // 古い癖は iOS 15.5 で直っている (WebKit 220908)
  var lockY = 0;
  function lockScroll() {
    lockY = window.scrollY || 0;
    document.documentElement.classList.add('reading');
  }
  function unlockScroll() {
    document.documentElement.classList.remove('reading');
    window.scrollTo(0, lockY);
  }

  // ── 開く / 閉じる ──────────────────────────────────────────
  function openReader(item, opts) {
    var start = (opts && opts.start) || 'resume';
    clearTimeout(closeTimer);
    warm.clear();
    renderToken += 1;
    teardownFlow();
    flow.textContent = '';
    resetSheets();
    at = 0;
    dirty = false;
    book = null;
    opened = true;
    resetExtras();   // 前の本から渡ってきた時のために、札は先に片づける

    // 題は一覧のものを先に出す。/api/book の返りを待つと上帯が空のまま見える
    readTitle.textContent = (item && item.title) || '';
    reader.hidden = false;
    void reader.offsetWidth;   // hidden を外した所を確定させてから札を張る (出る動きのため)
    flag('reading', true);
    flag('prefsOn', false);
    showHud(true);
    startSpin();
    // 背後の棚 (文書スクロール) に錠を掛ける。overflow:hidden だけでは iOS は
    // 裏の文書が指で動いてしまうので、body を今の位置のまま固定する
    lockScroll();

    // 端末の「戻る」で閉じられるようにする。繋がないと全画面ごと落ちる癖がある
    if (!pushed) {
      try { history.pushState({ bunko: 'reader' }, ''); pushed = true; } catch (e) { pushed = false; }
    }

    api('/api/book/' + encodeURIComponent(item.id))
      .then(function (data) {
        if (!opened) return;
        book = {
          id: String(data.id != null ? data.id : item.id),
          title: data.title || (item && item.title) || '',
          pageCount: Math.max(1, data.pageCount || (item && item.pageCount) || 1),
          version: data.version || 0,
          ratios: data.ratios || []
        };
        readTitle.textContent = book.title;
        var mark = data.reading;
        // 続きから。読み終えた本は頭に戻す (最後の頁を開いても仕方がない)。
        // 'last' は継ぎ目から前の作品へ巻き戻るときだけ
        at = start === 'last' ? Math.max(0, book.pageCount - 1)
          : (start !== 'first' && mark && !mark.finished && mark.page > 0 && mark.page < book.pageCount)
            ? mark.page : 0;
        enteredAtEnd = start === 'last';
        enteredPage = at;
        applyDir();
        markSegs('flow', vertical ? 'scroll' : 'page');
        applyFlowMode();
        render();
        dirty = false;   // 開いただけでは書き戻さない
        clearTimeout(saveTimer);
        showCoachOnce();
      })
      .catch(function (error) {
        // 黙って閉じない (項目 9-10)。母屋は理由を返しているのに、手のひら版だけが
        // 輪を止めて棚へ戻していたので、こちらの操作が悪いのか母艦が寝ているのか
        // 分からなかった。机上版は頁ごとに理由と再試行を出している
        stopSpin();
        closeReader();
        BUNKO.shelf.say(readerErrorText(error), { retry: function () { openReader(item, opts); } });
      });
  }

  // 失敗の顔を分ける。合言葉切れ・母艦が寝ている・本が無い は別の手当てが要る
  function readerErrorText(error) {
    var code = Number((error && error.message) || 0);
    if (code === 401 || code === 403) return '合言葉が切れました。開き直してください';
    if (code === 404) return 'この本は母艦から見えなくなっています';
    if (code >= 500) return '母艦が本を開けませんでした';
    return '母艦につながりません (寝ているかもしれません)';
  }

  // 道シルベは初めの一度だけ独りでに出す。以後は上帯の情報印から
  function showCoachOnce() {
    var seen = null;
    try { seen = localStorage.getItem(KEY_COACH); } catch (e) { seen = '1'; }
    if (seen) return;
    remember(KEY_COACH, '1');
    openCoach();
  }

  function closeReader() {
    if (!opened) return;
    opened = false;
    var mark = book
      ? { id: book.id, page: at, pageCount: book.pageCount, finished: finishedNow() }
      : null;
    saveNow();
    renderToken += 1;
    stopSpin();
    teardownFlow();
    warm.clear();
    clearTimeout(hudTimer);
    flag('reading', false);
    flag('chromeOn', false);
    flag('prefsOn', false);
    flag('coachOn', false);
    coach.hidden = true;
    resetExtras();
    unlockScroll();
    book = null;
    // 動きを見せてから片づける。すぐ hidden にすると畳まれる所が飛ぶ
    closeTimer = setTimeout(function () {
      if (opened) return;
      reader.hidden = true;
      resetSheets();
      flow.textContent = '';
    }, CLOSE_WAIT);

    if (!mark && BUNKO.host) BUNKO.host.closed();
    if (mark && BUNKO.shelf && typeof BUNKO.shelf.readerClosed === 'function') {
      try { BUNKO.shelf.readerClosed(mark); } catch (e) { /* 棚が転んでも読む方は閉じ切る */ }
    }
  }

  // 閉じる釦は履歴を一つ戻す。popstate 側で実際に閉じるので、道は一本になる
  function requestClose() {
    if (pushed) { pushed = false; history.back(); return; }
    closeReader();
  }
  $('btnBack').addEventListener('click', requestClose);

  window.addEventListener('popstate', function () {
    if (!opened) return;
    pushed = false;
    closeReader();
  });

  // ── 指 ─────────────────────────────────────────────────────
  // 読み方の紙が出ている時の外への一突きは「閉じる」— 頁送りには使わない
  $('zoneL').addEventListener('click', function () { if (closePrefs()) return; if (!swallow) step(rtl); });
  $('zoneR').addEventListener('click', function () { if (closePrefs()) return; if (!swallow) step(!rtl); });
  $('zoneC').addEventListener('click', function () {
    if (closePrefs()) return;
    if (swallow) return;
    showHud(!document.body.classList.contains('chromeOn'));
  });
  // 縦送りでは帯を退けてあるので、紙そのものを突いて操作板を出す
  flow.addEventListener('click', function () {
    if (closePrefs()) return;
    showHud(!document.body.classList.contains('chromeOn'));
  });

  // 指で帯を引いて送る。送り帯が上に載っているので、受けるのは #reader の側。
  // 帯は指に 1:1 で付いてくる (Kindle と同じ)。次の頁が控えている側へ引けば次が、
  // 反対へ引けば前が覗く。端では伸びて戻り、強く引けば継ぎ目 (隣の作品) を出す。
  // 継ぎ目 (.readBoundary) の上では帯を動かさず、同じ向きへもう一度払えたかだけ見る
  // (それが「開く」の合図だから)
  function inChrome(target) {
    return !!(target && target.closest
      && target.closest('.chromeTop, .chromeBot, .prefs, .coach, .backPill, .pageMosaic'));
  }

  // 端を越えた分は iOS のラバーバンドと同じ式で縮める
  function rubber(over, w) {
    return over * w * RUBBER / (w + RUBBER * Math.abs(over));
  }

  // 帯が今の頁から動ける範囲 [min, max]。無い側 (先頭の前・末尾の次) は 0 で止める
  function stripRange(w) {
    var side = nextSide();
    var toNext = shownAt + 1 < book.pageCount ? -side * w : 0;
    var toPrev = shownAt > 0 ? side * w : 0;
    return [Math.min(toNext, toPrev), Math.max(toNext, toPrev)];
  }

  function clampStripX(x, w) {
    var range = stripRange(w);
    if (x < range[0]) return range[0] + rubber(x - range[0], w);
    if (x > range[1]) return range[1] + rubber(x - range[1], w);
    return x;
  }

  reader.addEventListener('pointerdown', function (e) {
    drag = null;
    if (e.isPrimary === false || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (!book || vertical || mosaicOn || held || inChrome(e.target)) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, on: false, base: 0,
      last: e.clientX, t: e.timeStamp, v: 0, w: stageWidth() };
  });

  reader.addEventListener('pointermove', function (e) {
    if (!drag || e.pointerId !== drag.id) return;
    var dx = e.clientX - drag.x;
    var dy = e.clientY - drag.y;
    if (!drag.on) {
      if (pull && pull.on) { drag = null; return; }   // 先に「下へ引く」と決まった指
      if (Math.abs(dx) < DRAG_SLOP || Math.abs(dx) < Math.abs(dy)) return;
      drag.on = true;
      pull = null;               // 横と決まったら引きは取り下げる
      if (reader.setPointerCapture) {
        try { reader.setPointerCapture(e.pointerId); } catch (err) { /* 掴めなくても動く */ }
      }
      // 滑りの途中で触れたら、その場所から指に引き継ぐ (入力を締め出さない)
      drag.base = bound ? 0 : currentStripX();
      stopSlide();
      renderToken += 1;          // 待たせていた送り (turn) は捨てる。指の方が正
      stopSpin();
      if (!bound) setStripX(drag.base);
      drag.x = e.clientX;        // 遊びを越えた所を 0 にする (帯が 10px 跳ばない)
      drag.last = e.clientX;
      drag.t = e.timeStamp;
      dx = 0;
    }
    // 速さは直近の動きに重みを置いて均す (最後の一拍だけで決めると指の震えを拾う)
    var dt = Math.max(1, e.timeStamp - drag.t);
    var inst = (e.clientX - drag.last) / dt;
    drag.v = drag.v === 0 ? inst : drag.v * 0.5 + inst * 0.5;
    drag.last = e.clientX;
    drag.t = e.timeStamp;
    if (bound) return;
    setStripX(clampStripX(drag.base + dx, drag.w));
  });

  function endDrag(e, cancelled) {
    if (!drag) return;
    var d = drag;
    drag = null;
    if (!d.on) return;
    // 引いた後にくる帯の押下は捨てる。着地した先の頁がもう一枚進んでしまう
    swallow = true;
    setTimeout(function () { swallow = false; }, 350);
    if (reader.releasePointerCapture) {
      try { reader.releasePointerCapture(d.id); } catch (err) { /* 既に離れている */ }
    }
    var side = nextSide();
    var dx = e ? e.clientX - d.x : 0;
    if (bound) {
      // 継ぎ目の上: 帯は動いていない。同じ向きへもう一度払えたかだけ判じる
      if (!cancelled && Math.abs(dx) >= SWIPE_MIN) step(dx * -side > 0);
      return;
    }
    var w = d.w;
    var raw = d.base + dx;             // 伸びを掛ける前の、指どおりの位置
    var v = cancelled ? 0 : d.v;
    var dir = 0;                       // +1 次へ / -1 前へ
    if (!cancelled) {
      if (Math.abs(v) >= FLICK_V) dir = v * -side > 0 ? 1 : -1;          // 速ければ指の向きに
      else if (Math.abs(raw) >= w * COMMIT_RATIO) dir = raw * -side > 0 ? 1 : -1;
      // 向こう側へ弾いても、帯がまだこちら側に居るなら元の頁へ戻すだけ
      if (dir && (dir === 1 ? raw * -side < 0 : raw * side < 0)) dir = 0;
    }
    var target = shownAt + dir;
    var pastEdge = 0;
    if (target < 0 || target >= book.pageCount) {
      // 端を越えて引いた。戻してから、端で送ろうとした時と同じく継ぎ目を出す
      pastEdge = dir;
      target = shownAt;
    }
    if (target !== at) {
      hideBack();
      at = target;
      updateHud();
      saveSoon();
    }
    var from = currentStripX();
    var dist = Math.abs(stripXFor(target) - from);
    var ms = target === shownAt ? SNAP_MS
      : Math.max(150, Math.min(TURN_MS, dist / Math.max(Math.abs(v), 1)));
    slideTo(target, ms);
    if (pastEdge) showBoundary(pastEdge);
  }

  reader.addEventListener('pointerup', function (e) { endDrag(e, false); });
  reader.addEventListener('pointercancel', function (e) { endDrag(e, true); });

  // ── 二本指 (つまむと一覧・開くと頁へ) ──────────────────────
  // pointer では二本目が別の道で来るので、間合いを測るのは touch の側でやる
  function touchSpan(e) {
    var a = e.touches[0], b = e.touches[1];
    var dx = a.clientX - b.clientX;
    var dy = a.clientY - b.clientY;
    return Math.sqrt(dx * dx + dy * dy) || 1;
  }

  // 読み方・道シルベ・継ぎ目が出ている間はつままない (下の頁は今の話題ではない)
  function pinchOk() {
    if (!book) return false;
    if (!boundary.hidden) return false;
    var body = document.body.classList;
    return !body.contains('coachOn') && !body.contains('prefsOn');
  }

  // ── 下へ引いて本を閉じる ───────────────────────────────────
  function pullOk(target) {
    if (!book || mosaicOn || held) return false;
    if (!boundary.hidden) return false;
    if (inChrome(target)) return false;
    var body = document.body.classList;
    if (body.contains('coachOn') || body.contains('prefsOn')) return false;
    // 縦送りでは一番上に居る時だけ。途中で引いたら、それはただの繰りである
    if (vertical && flow.scrollTop > 0) return false;
    return true;
  }

  function startPull(e) {
    pull = null;
    if (!pullOk(e.target)) return;
    var t = e.touches[0];
    pull = { x: t.clientX, y: t.clientY, dy: 0, on: false };
  }

  function movePull(e) {
    if (!pull || e.touches.length !== 1) return;
    var t = e.touches[0];
    var dx = t.clientX - pull.x;
    var dy = t.clientY - pull.y;
    if (!pull.on) {
      // どちらの動きか、まだ名前が付かない間は何もしない (指の揺れで決めない)
      if (Math.abs(dx) < PULL_SLOP && Math.abs(dy) < PULL_SLOP) return;
      // 下向きで、横の 2 倍を越えた縦だけが「引き」。
      // それ以外 (横払い・上への繰り・斜め) はここで手を引き、
      // 一度譲ったら同じ指では取り返さない
      if (dy <= PULL_SLOP || dy <= Math.abs(dx) * 2) { pull = null; return; }
      pull.on = true;
      pullBox = vertical ? flow : pageStage;
      pullBox.classList.remove('pullBack');   // 掴み直しは跳ね戻りを待たない
    }
    pull.dy = dy;
    // 引き始めたら横の送りは殺す (pointermove 側の縦横比の判じとは別に、念のため)
    drag = null;
    e.preventDefault();
    pullBox.style.transform = 'translateY(' + (dy * PULL_DAMP).toFixed(1) + 'px)';
  }

  // release=false は指が取り上げられた時 (二本目が乗った・端末に横取りされた)。
  // その場合は閉じずに戻すだけ
  function endPull(release) {
    if (!pull) return;
    var far = pull.on && release && pull.dy > PULL_MAX;
    var moved = pull.on;
    pull = null;
    if (!moved || !pullBox) return;
    var box = pullBox;
    box.classList.add('pullBack');
    box.style.transform = '';
    setTimeout(function () { box.classList.remove('pullBack'); }, CLOSE_WAIT);
    if (far) requestClose();
  }

  reader.addEventListener('touchstart', function (e) {
    if (e.touches.length >= 2) {
      // 二本指が乗った時点で一本指の仕事は取り下げる。払いも引きも誤発火させない
      endDrag(null, true);
      endPull(false);
      pinch = pinchOk() ? { d0: touchSpan(e) } : null;
      return;
    }
    pinch = null;
    startPull(e);
  }, { passive: true });

  // 非受動でないと、つまむ指が端末の拡大に、引く指が繰りに持っていかれる
  reader.addEventListener('touchmove', function (e) {
    if (pinch && e.touches.length >= 2) {
      e.preventDefault();
      var ratio = touchSpan(e) / pinch.d0;
      if (!mosaicOn && ratio < PINCH_IN) { pinch = null; openMosaic(); }
      else if (mosaicOn && ratio > PINCH_OUT) { pinch = null; closeMosaic(); }
      return;
    }
    // 横に引いている間は端末に何もさせない (帯は pointermove の側で動かしている)
    if (drag && drag.on) { e.preventDefault(); return; }
    movePull(e);
  }, { passive: false });

  reader.addEventListener('touchend', function (e) {
    if (e.touches.length === 0) pinch = null;
    endPull(true);
  });
  reader.addEventListener('touchcancel', function () {
    pinch = null;
    endPull(false);
  });

  window.addEventListener('keydown', function (e) {
    if (!opened) return;
    // 重なっている物から順に畳む。一覧 → 継ぎ目 → 本そのもの
    if (e.key === 'Escape') {
      if (mosaicOn) closeMosaic();
      else if (bound) hideBoundary();
      else requestClose();
      return;
    }
    if (mosaicOn) return;   // 一覧の上では鍵盤で頁を送らない (選ぶ場面なので)
    // 矢印は帯 (zone) と同じ向き: 次の頁が控えている側の矢印で進む
    if (e.key === 'ArrowLeft') step(rtl);
    if (e.key === 'ArrowRight') step(!rtl);
    if (e.key === ' ') { e.preventDefault(); step(true); }
  });

  window.addEventListener('pagehide', function () { saveNow(); });
  document.addEventListener('visibilitychange', function () {
    // 端末によっては閉じる時に pagehide が来ない。隠れた時にも投げておく
    if (document.visibilityState === 'hidden') saveNow();
  });

  // 画面を回しても枠は縦横比で伸びる (組み直しは要らない)。読んでいた頁へ寄せ直すだけ
  window.addEventListener('resize', function () {
    if (!book || !vertical) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (!book || !vertical) return;
      scrollTo0(flow, flow.children[at]);
    }, 250);
  });

  applyDir();
  // 試験は harness の印を立ててから読む (画面を組む前に掴む)
  if (!globalThis.__BUNKO_HARNESS__) {
    markSegs('flow', vertical ? 'scroll' : 'page');
    fillCoach();
  }

  // ── 窓口 ───────────────────────────────────────────────────
  BUNKO.reader = {
    close: requestClose,
    // item: 一覧の item そのまま。opts.start: 'resume'(既定) | 'first'
    open: function (item, opts) {
      if (!item || item.id == null) return;
      openReader(item, opts);
    }
  };
})();
