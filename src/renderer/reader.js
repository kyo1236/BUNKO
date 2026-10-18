// リーダー一式。app.js より先に読まれるので、els / state / toast などの共有物には
// 関数の中からだけ触る (トップレベルで参照すると app.js の初期化前に当たる)
const Reader = (() => {
  const MIN_SCALE = 1;
  const MAX_SCALE = 4;
  const PAN_THRESHOLD = 5;
  const NAV_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

  // 横長と分かった頁。open ごとに捨てる
  let landscape = new Set();
  let groups = [];
  let groupOf = [];

  let scale = 1;
  let panX = 0;
  let panY = 0;
  let panId = -1;
  let panFromX = 0;
  let panFromY = 0;
  let panBaseX = 0;
  let panBaseY = 0;
  let panMoved = false;
  let swallowClick = false;

  // クリックは即座に頁を送る。続けて二打目が来たらその送りを取り消してズームへ回す
  let turnedFrom = -1;
  let turnedAt = 0;

  let saveTimer = 0;
  let savePending = null;
  // ホイールの溜め。刻みの深いマウスは一目盛りで一度しか寄越さず、刻みの細かい
  // マウスや板は同じ一目盛りを何度にも分けて寄越す。時間で間引くと前者の目盛りが
  // 落ちて「回したのに送られない」になる: 落とさずに量で数える
  // 一目盛りは Windows の「一度にスクロールする行数」で 33 (1 行) から 133 (4 行)。
  // 敷居はその一番小さい 33 より下に置く: どの設定でも一目盛りで確かに一組送る
  const WHEEL_STEP = 30;
  const WHEEL_EDGE = 60;   // 横フィットの端では、もう一押しぶん溜まって初めて送る
  const WHEEL_IDLE = 200;  // これだけ間が空いたら別の動作: 溜めは繰り越さない
  // 深い刻みの一発は指が回した一目盛りそのものなので、間隔を見ずに必ず送る。
  // 細かい刻み (板や自由回転) だけ下限間隔で抑える。流れは続いているので、
  // ここで待たせた溜めは次の一発で送られる
  const WHEEL_UNIT = 20;   // これ未満の一発は「細かい刻み」とみなす
  const WHEEL_FINE = 120;
  let wheelAcc = 0;
  let wheelAt = 0;
  let wheelBoundary = '';
  let lastTurn = 0;
  // 直近にめくった向き (1 = 先へ / -1 = 戻り)。先読みをその先へ厚く配るために持つ
  let turnDir = 1;

  // 初回だけの手引き: 一度出したら二度と出さない
  const HINT_KEY = 'hitomi-box-reader-hint-shown';
  let hintTimer = 0;

  // ---- ローカル原本 (PDF) ----------------------------------------------
  // pawchive の所持作品は Eagle の中に 1 投稿 = 1 PDF で入っている。
  // 頁は要るぶんだけ描いて object URL に落とし、古いものから捨てる
  const PDF_CACHE_MAX = 16;
  const PDF_WIDTH = 1600;
  const PDF_THUMB_WIDTH = 220;

  let pdfDoc = null;
  let pdfToken = 0;            // 開き直しで古い描画を捨てるための番号
  let pdfUrls = new Map();     // 頁 → object URL
  let pdfOrder = [];           // LRU の順 (末尾が新しい)
  let pdfPending = new Map();  // 描画中の頁 → Promise
  let pdfQueue = [];
  let pdfActive = 0;
  const pdfRenderTasks = new Set();
  let pendingOpen = null;
  let thumbObserver = null;

  // ---- 右の板 (情報 / プロンプト) ------------------------------------------
  // 中身は ai-meta-ui.js (window.BunkoAiMeta)。ここは開閉と、頁が動いた時に知らせるだけ。
  // 開くと絵の側 (reader-body) を板の幅だけ左へ寄せる (重ねない: 絵と並べて読む)。
  let side = '';            // '' | 'info' | 'prompt'
  let pendingSide = '';     // open(gallery, page, { side }) の言付け

  function sideHost() { return els.readerSide || document.getElementById('reader-side'); }
  function sideButton(kind) { return document.getElementById(kind === 'info' ? 'reader-info' : 'reader-prompt'); }
  function paintSideButtons() {
    for (const kind of ['info', 'prompt']) {
      const btn = sideButton(kind);
      if (!btn) continue;
      btn.setAttribute('aria-pressed', side === kind ? 'true' : 'false');
      btn.classList.toggle('active', side === kind);
    }
  }
  // 帯のプロンプトの釦: 今の頁にプロンプトがあれば (板を閉じていても) 青で知らせる
  function paintPromptButton() {
    const btn = sideButton('prompt');
    if (!btn || !state.reader || !window.BunkoAiMeta) return;
    const { gallery, page } = state.reader;
    const has = window.BunkoAiMeta.canPrompt(gallery) && window.BunkoAiMeta.pageHasPrompt(gallery.id, groupAt(page)[0]);
    btn.classList.toggle('has-prompt', has);
    btn.title = has ? 'プロンプトあり — p' : 'プロンプト — p';
  }
  function refreshSide() {
    if (!side || !state.reader || !window.BunkoAiMeta) return;
    const { gallery, page } = state.reader;
    window.BunkoAiMeta.render(sideHost(), { kind: side, gallery, page: groupAt(page)[0] });
  }
  function openSide(kind, { paint = true } = {}) {
    if (!state.reader) return;
    if (kind === 'prompt' && !(window.BunkoAiMeta && window.BunkoAiMeta.canPrompt(state.reader.gallery))) kind = 'info';
    side = kind;
    els.reader.classList.add('has-side');
    const host = sideHost();
    if (host) host.hidden = false;
    window.BunkoAiMeta?.bind({ onPage: (n) => setPage(n), onClose: () => closeSide() });
    paintSideButtons();
    if (paint) refreshSide();
  }
  function closeSide() {
    if (!side) return false;
    side = '';
    els.reader.classList.remove('has-side');
    window.BunkoAiMeta?.clear();
    const host = sideHost();
    if (host) host.hidden = true;
    paintSideButtons();
    return true;
  }
  function toggleSide(kind) {
    if (side === kind) closeSide();
    else openSide(kind);
  }
  function sideOpen() { return side; }

  // 読み手が出すために頼む頁。母屋はこれを合図に、その本の残りを裏で用意する
  // (札を眺めているだけの本まで丸ごと用意させない)。
  // 所持の本は網の版と URL を分ける (own=1): 同じ URL だと、所持になる前に網から読んだ軽い絵
  // (pixiv は 1200 px) がブラウザの控え (immutable、7 日) から出続け、原本を読んでいるつもりで
  // 粗い絵を見る (2026-09-20 に利用者が Eagle と並べて気づいた)
  // 網の pixiv も、原寸 (rs=o) と 1200 px (rs=r) で URL を分ける: 設定を切り替えた時に前の大きさの控えを掴まない
  function readUrl(id, index) {
    const gallery = state.reader && state.reader.gallery;
    let tail = '';
    if (gallery && (gallery.owned || gallery.eagleId)) tail = '&own=1';
    else if (gallery && gallery.source === 'pixiv') tail = `&rs=${(state.settings || {}).pixivReadOriginal === false ? 'r' : 'o'}`;
    return `${imgUrl(id, index, 'full')}&read=1${tail}`;
  }

  function localSession() {
    return state.reader && state.reader.local ? state.reader.local : null;
  }

  // 原本を renderer 側で開く道 (pdf.js)。普段は母屋が綴じ目から頁を配るので通らず、
  // 母屋が頁数すら出せなかった本 (綴じ方が読めない等) の保険として残してある。
  //
  // **落とす前に数える** (項目 8-1)。この道が本当に 0 回なら pdf.js 一式
  // (/pwfile/ と /pdfworker と 1.6 MB の worker) を落とせるが、
  // 0 でない本が残っているなら落としてはいけない
  function readsLocal(gallery) {
    const local = Boolean(gallery && gallery.eagleId && !Number(gallery.pageCount));
    if (local) {
      try {
        window.hitomi.noteFallback?.('reader-local-pdfjs');
      } catch {
        /* 数えられなくても読むのは続ける */
      }
    }
    return local;
  }

  function disposeLocal() {
    pdfToken += 1;
    if (pendingOpen) {
      pendingOpen.controller?.abort();
      try { pendingOpen.loadingTask?.destroy(); } catch { /* best effort */ }
      pendingOpen = null;
    }
    for (const task of pdfRenderTasks) {
      try { task.cancel(); } catch { /* already complete */ }
    }
    pdfRenderTasks.clear();
    for (const entry of pdfQueue) entry.resolve(null);
    pdfQueue = [];
    pdfActive = 0;
    pdfPending = new Map();
    pdfOrder = [];
    for (const url of pdfUrls.values()) URL.revokeObjectURL(url);
    pdfUrls = new Map();
    if (thumbObserver) {
      thumbObserver.disconnect();
      thumbObserver = null;
    }
    const doc = pdfDoc;
    pdfDoc = null;
    if (doc) {
      try {
        doc.destroy();
      } catch {
        /* 破棄できなくても開き直しは進める */
      }
    }
  }

  function rememberPage(index, url) {
    pdfUrls.set(index, url);
    pdfOrder = pdfOrder.filter((page) => page !== index);
    pdfOrder.push(index);
    while (pdfOrder.length > PDF_CACHE_MAX) {
      const drop = pdfOrder.shift();
      const old = pdfUrls.get(drop);
      if (old) {
        URL.revokeObjectURL(old);
        pdfUrls.delete(drop);
      }
    }
  }

  async function drawPdfPage(index, token, width) {
    if (!pdfDoc) return null;
    const page = await pdfDoc.getPage(index + 1);
    if (token !== pdfToken || !pdfDoc) return null;
    const base = page.getViewport({ scale: 1 });
    const zoom = Math.max(0.1, Math.min(3, width / (base.width || width)));
    const viewport = page.getViewport({ scale: zoom });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    const renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport });
    pdfRenderTasks.add(renderTask);
    try {
      await renderTask.promise;
    } finally {
      pdfRenderTasks.delete(renderTask);
    }
    return token === pdfToken ? canvas : null;
  }

  function pumpPdfQueue() {
    while (pdfQueue.length) {
      const entry = pdfQueue[0];
      // 先読みは1枠だけ使い、表示頁が必ずもう1枠へ割り込めるようにする。
      if (pdfActive >= (entry.priority ? 2 : 1)) return;
      pdfQueue.shift();
      if (entry.token !== pdfToken) {
        entry.resolve(null);
        continue;
      }
      pdfActive += 1;
      entry.run().then(entry.resolve, entry.reject).finally(() => {
        if (entry.token === pdfToken) {
          pdfActive = Math.max(0, pdfActive - 1);
          pumpPdfQueue();
        }
      });
    }
  }

  function ensurePdfPage(index, priority = true) {
    const local = localSession();
    if (!local || local.kind !== 'pdf' || !pdfDoc) return null;
    if (!Number.isInteger(index) || index < 0 || index >= pageCount()) return null;
    const have = pdfUrls.get(index);
    if (have) {
      rememberPage(index, have);
      return Promise.resolve(have);
    }
    const running = pdfPending.get(index);
    if (running) {
      if (priority) {
        const queuedIndex = pdfQueue.findIndex((entry) => entry.index === index);
        if (queuedIndex >= 0) {
          const [entry] = pdfQueue.splice(queuedIndex, 1);
          entry.priority = true;
          pdfQueue.unshift(entry);
          pumpPdfQueue();
        }
      }
      return running;
    }
    const token = pdfToken;
    let resolveQueued;
    let rejectQueued;
    const queued = new Promise((resolve, reject) => {
      resolveQueued = resolve;
      rejectQueued = reject;
    });
    const run = async () => {
      const canvas = await drawPdfPage(index, token, PDF_WIDTH);
      if (!canvas || token !== pdfToken) return null;
      const blob = await new Promise((done) => canvas.toBlob(done, 'image/jpeg', 0.92));
      if (!blob || token !== pdfToken) return null;
      const url = URL.createObjectURL(blob);
      rememberPage(index, url);
      return url;
    };
    const job = queued.catch((error) => {
      // 閉じた・開き直した拍子の中断は事故ではない: 黙って捨てる
      const cancelled = token !== pdfToken || error?.name === 'RenderingCancelledException';
      if (!cancelled) console.warn('[reader] PDF の頁を描けませんでした', index, error);
      return null;
    }).then((url) => {
      if (pdfPending.get(index) === job) pdfPending.delete(index);
      return url;
    });
    pdfPending.set(index, job);
    const entry = { index, token, priority, run, resolve: resolveQueued, reject: rejectQueued };
    if (priority) pdfQueue.unshift(entry);
    else pdfQueue.push(entry);
    pumpPdfQueue();
    return job;
  }

  // 描かなくても寸法は引ける: 見開きの組を先に直しておく
  async function notePdfShape(index, token) {
    if (!pdfDoc) return;
    try {
      const page = await pdfDoc.getPage(index + 1);
      const viewport = page.getViewport({ scale: 1 });
      if (token !== pdfToken || !state.reader) return;
      noteLandscape(index, { naturalWidth: viewport.width, naturalHeight: viewport.height });
    } catch {
      /* 寸法が引けなければ組はそのまま */
    }
  }

  function dismissHint() {
    if (!els.readerHint || els.readerHint.hidden) return;
    els.readerHint.hidden = true;
    clearTimeout(hintTimer);
    hintTimer = 0;
  }

  function maybeShowHint() {
    if (!els.readerHint) return;
    try {
      if (localStorage.getItem(HINT_KEY)) return;
      localStorage.setItem(HINT_KEY, '1');
    } catch {
      return;
    }
    els.readerHint.hidden = false;
    hintTimer = setTimeout(dismissHint, 6000);
  }

  // ---- 作品の継ぎ目 ----------------------------------------------------
  // 端の頁の先で隣の作品の札を挟む。頁ではないので組にも位置の記憶にも入れない

  // 一覧での隣を教えてもらう口。リーダーは一覧そのものを知らない
  let neighborProvider = null;

  function setNeighborProvider(fn) {
    neighborProvider = typeof fn === 'function' ? fn : null;
  }

  // 端の先へ送ったら隣へ渡るのは常に。設定が決めるのは、渡る前に札を一度挟むかどうかだけ
  function showsNextCard() {
    return (state.settings || {}).readerNextCard === true;
  }

  function neighborOf(delta) {
    if (!neighborProvider || !state.reader) return null;
    try {
      return neighborProvider(state.reader.gallery.id, delta) || null;
    } catch {
      // 一覧側の都合で継ぎ目が出ないだけ: 読みは止めない
      return null;
    }
  }

  function creatorOf(gallery) {
    const first = (gallery.artists || [])[0] || (gallery.groups || [])[0];
    return first ? String(first.label || first.name || '') : '';
  }

  function hideBoundary() {
    if (state.reader) state.reader.boundary = null;
    if (!els.readerBoundary || els.readerBoundary.hidden) return;
    els.readerBoundary.hidden = true;
    els.readerBoundary.innerHTML = '';
    // 分かれ道の印も外す: 残すと次に開いた作品で、畳んだはずの幕が grid のまま頁を覆う
    if (els.readerBoundary.classList) els.readerBoundary.classList.remove('with-related');
  }

  // 継ぎ目で待たせないよう、端まで来たら隣の表紙だけ温める
  function warmNeighbor(side) {
    const other = neighborOf(side);
    if (other) new Image().src = imgUrl(other.id, 0, 'small');
  }

  // 作者名を押した時に作者の投稿一覧へ渡す口 (app.js が据える。リーダーは検索を知らない)
  let creatorOpener = null;

  function setCreatorOpener(fn) {
    creatorOpener = typeof fn === 'function' ? fn : null;
  }

  function creatorMarkup(gallery, klass) {
    const creator = creatorOf(gallery);
    if (!creator) return '';
    // 押せるのは渡す口がある時だけ。無ければ今までどおり文字
    return creatorOpener
      ? `<button type="button" class="${klass} reader-creator-link" data-related-creator="${escapeHtml(String(gallery.id))}" title="この作者の作品一覧へ">${escapeHtml(creator)}</button>`
      : `<p class="${klass}">${escapeHtml(creator)}</p>`;
  }

  // related: 関連作品と並ぶ札 (分かれ道の送る側)。押して渡る (data-next)。関連の無い札は今までどおり入力を通す。
  // 関連と並ぶ札は表紙・題・作者だけ (見出しの語も「もう一度で開く」の案内も付けない。利用者の決め 2026-09-27)
  function nextMarkup(gallery, side, related = false) {
    const star = Math.round(Number(gallery.star)) || 0;
    const kicker = related ? '' : `<p class="reader-next-kicker">${side > 0 ? '次の作品' : '前の作品'}</p>`;
    return `
      <div class="reader-next"${related ? ' data-next="1" role="button" tabindex="0"' : ''}>
        <img class="reader-next-cover" src="${imgUrl(gallery.id, 0, 'small')}" alt="" />
        <div class="reader-next-text">
          ${kicker}
          <p class="reader-next-title">${escapeHtml(gallery.title || '')}</p>
          ${creatorMarkup(gallery, 'reader-next-creator')}
          ${star > 0 ? `<p class="reader-next-star">★${star}</p>` : ''}
        </div>
      </div>`;
  }

  // 顔だけ見せて、同じ向きにもう一度送られたら開く。札自身は入力を取らない (下の頁が受ける)。
  // pixiv の読み終わり (先へ) は分かれ道: 送る側に次の札、細い縦の線、残りに関連作品。
  // 一覧に次が無くても関連だけは出す (gallery = null): 関連から渡った作品でも次の関連へ辿れる。
  // 関連の札が出ている間は「押して進む」: ホイールは格子を巻き、頁の空白を押しても渡らない
  function showBoundary(gallery, side) {
    if (!els.readerBoundary || !state.reader) return;
    const withRelated = side > 0 && showsRelated();
    if (!gallery && !withRelated) return;
    state.reader.boundary = { gallery, dir: side, related: withRelated, at: Date.now() };
    if (withRelated) warmRelated();
    els.readerBoundary.innerHTML = (gallery ? nextMarkup(gallery, side, withRelated) : '')
      + (withRelated ? `${gallery ? '<div class="reader-related-rule"></div>' : ''}${relatedMarkup()}` : '');
    if (els.readerBoundary.classList) els.readerBoundary.classList.toggle('with-related', withRelated);
    els.readerBoundary.hidden = false;
  }

  // ---- 関連作品 (pixiv) ------------------------------------------------
  // 読み終わりの継ぎ目に pixiv の関連作品を並べる。引くのは母屋の pixiv 'related'
  // (詳細の「関連作品」と同じ口。控えも同じ)。一作品につき一度、端の組まで来た時に引く。
  // 届いた格子は札を押しのけない: 札と格子は別の欄 (styles.css の分かれ道)、格子は欄の中で余りを切る。
  // 続きはホイールで格子を巻いて見る。底が近づいたら次の 30 件を頼んで格子の末尾に足す
  // (母屋が next_url を辿る。本家の「関連作品」が下るほど増えるのと同じ)。上限は母屋と同じ 150
  const RELATED_MAX = 30;      // 一度に頼む幅 (初回、および足すごと)
  const RELATED_TOTAL = 150;   // これ以上は頼まない (母屋の RELATED_TOTAL と揃える)
  const RELATED_WARM = 12;     // 表紙を先に温めるのは最初に見える分だけ
  const RELATED_NEAR = 320;    // 底からこの高さ以内に来たら続きを頼む
  // { id, rows, error, limit, done, loading }: 直近に引いた作品の分だけ持つ
  let related = null;

  function relatable(gallery) {
    return Boolean(gallery && gallery.source === 'pixiv' && /^px:\d+$/.test(String(gallery.id)));
  }

  function showsRelated() {
    return showsNextCard() && Boolean(state.reader) && relatable(state.reader.gallery);
  }

  function relatedRows() {
    const gallery = state.reader && state.reader.gallery;
    return related && gallery && related.id === String(gallery.id) ? related.rows : null;
  }

  // retry: 失敗した分を引き直してよいか。最終頁に着き直した時だけ許す (札を出すたびには引き直さない)
  function warmRelated(retry = false) {
    if (!showsRelated()) return;
    const id = String(state.reader.gallery.id);
    if (related && related.id === id && !(retry && related.error)) return;
    const api = window.hitomi && window.hitomi.pixiv;
    if (typeof api !== 'function') return;
    const entry = { id, rows: null, error: false, limit: RELATED_MAX, done: false, loading: true };
    related = entry;
    requestRelated(entry, api)
      .then((rows) => {
        // 遅れて届いた分が別の作品の継ぎ目に混ざらないよう、持ち主を確かめる
        if (related !== entry) return;
        entry.rows = usableRelated(rows, id);
        // 継ぎ目で待たせないよう表紙だけ温める (次の作品の札と同じ)
        for (const g of entry.rows.slice(0, RELATED_WARM)) new Image().src = imgUrl(g.id, 0, 'small');
        fillRelated();
      })
      .catch(() => {
        if (related !== entry) return;
        entry.error = true;
        fillRelated();
      });
  }

  // 母屋に entry.limit 件まで頼む。返りが頼んだ数に届かなければ、それが最後 (done)
  function requestRelated(entry, api) {
    entry.loading = true;
    let request;
    try {
      request = Promise.resolve(api({ action: 'related', id: entry.id, limit: entry.limit }));
    } catch (error) {
      request = Promise.reject(error);
    }
    return request.then((rows) => {
      const list = Array.isArray(rows) ? rows : [];
      entry.loading = false;
      if (list.length < entry.limit || entry.limit >= RELATED_TOTAL) entry.done = true;
      return list;
    }, (error) => {
      entry.loading = false;
      throw error;
    });
  }

  // 読める物だけ並べる: うごイラ (頁の無い物)・作者の札・自分自身は落とす
  function usableRelated(rows, id) {
    return rows.filter((g) => g && !g.error && g.kind !== 'creator' && Number(g.pageCount) > 0 && String(g.id) !== id);
  }

  // 格子の底が近づいたら続き (次の 30 件) を頼み、届いた分だけ末尾に足す。
  // 格子は組み直さない (scrollTop が戻ってガタつく)。一度に一つ、上限まで
  function loadMoreRelated() {
    const entry = related;
    if (!entry || !entry.rows || entry.done || entry.loading || entry.error) return;
    if (!state.reader || entry.id !== String(state.reader.gallery.id)) return;
    const api = window.hitomi && window.hitomi.pixiv;
    if (typeof api !== 'function') return;
    const had = entry.rows.length;
    entry.limit = Math.min(RELATED_TOTAL, entry.limit + RELATED_MAX);
    requestRelated(entry, api)
      .then((rows) => {
        if (related !== entry) return;
        const fresh = usableRelated(rows, entry.id).slice(had);
        if (!fresh.length) {
          entry.done = true;
          return;
        }
        entry.rows.push(...fresh);
        appendRelated(fresh);
      })
      .catch(() => {
        // 続きが引けなくても、出ている分はそのまま。次の底で頼み直す
      });
  }

  function appendRelated(rows) {
    const boundary = state.reader && state.reader.boundary;
    if (!boundary || !boundary.related) return;
    const box = relatedElement();
    const grid = box && typeof box.querySelector === 'function' ? box.querySelector('.reader-related-grid') : null;
    if (grid && typeof grid.insertAdjacentHTML === 'function') grid.insertAdjacentHTML('beforeend', rows.map(relatedItem).join(''));
    else fillRelated();
    window.BunkoAiMeta?.want(rows);
  }

  // 一枚の札 = 作品 (表紙と題) の釦 + 作者名の釦。釦の中に釦は置けないので二つに分ける
  function relatedItem(g) {
    const badge = typeof pageCountBadge === 'function' ? pageCountBadge(g) : '';
    // プロンプトのある作品は青枠 (印は ai-meta-ui が控え、届けば data-related で写す)
    const prompt = window.BunkoAiMeta && window.BunkoAiMeta.markOf(g.id) === 'yes' ? ' has-prompt' : '';
    return `<div class="reader-related-item">
        <button type="button" class="reader-related-work${prompt}" data-related="${escapeHtml(String(g.id))}" title="${escapeHtml(g.title || '')}">
          <span class="reader-related-cover"><img src="${imgUrl(g.id, 0, 'small')}" alt="" />${badge}${g.owned ? '<span class="owned-mark">済</span>' : ''}</span>
          <span class="reader-related-title">${escapeHtml(g.title || '')}</span>
        </button>
        ${creatorMarkup(g, 'reader-related-creator')}
      </div>`;
  }

  function relatedElement() {
    if (!els.readerBoundary || els.readerBoundary.hidden) return null;
    return typeof els.readerBoundary.querySelector === 'function'
      ? els.readerBoundary.querySelector('.reader-related') : null;
  }

  // 継ぎ目に出ている作品 (次の札か関連の札) を id で引く
  function boundaryGallery(key) {
    const boundary = state.reader && state.reader.boundary;
    if (boundary && boundary.gallery && String(boundary.gallery.id) === key) return boundary.gallery;
    return (relatedRows() || []).find((g) => String(g.id) === key) || null;
  }

  // 関連の格子をホイールで巻く。天辺でさらに上へ回したら札を畳んで頁へ戻る。
  // 札が出た直後の同じ勢いは捨てる (出した一回しで格子まで動かない)
  // 天辺の区切り: 巻き上げて天辺に着いた勢いでは畳まない。一度手を止めて (RELATED_REST)、
  // 改めて上へ回した時だけ畳む。畳んだ後も同じだけ間を置かないと頁は動かない
  // (格子 → 頁 → 前の頁 と一息に流れないようにする)
  const RELATED_REST = 500;
  let relatedClosedAt = 0;   // 天辺で畳んだ時刻
  let relatedWheelAt = 0;    // 格子を最後に回した時刻
  let scrollbarTimer = 0;

  // 巻いている間だけ右の棒を薄く出す (CSS の .is-scrolling)
  function flashScrollbar(box) {
    if (!box.classList) return;
    box.classList.add('is-scrolling');
    clearTimeout(scrollbarTimer);
    scrollbarTimer = setTimeout(() => {
      const live = relatedElement();
      if (live && live.classList) live.classList.remove('is-scrolling');
    }, 900);
  }

  // 格子は一目盛りで一気に飛ばさず滑らせる: 行き先 (target) を持ち、毎コマ残りの一部ずつ寄せる。
  // 続けて回すと行き先が先へ延びるだけで、動きは途切れない (止まってから動き直さない)。
  // 位置は自前で持つ (scrollTop は画素に丸めて返るので、読み戻すと端数で止まれなくなる)。
  // requestAnimationFrame の無い所 (試験) はその場で着く
  const GLIDE_RATE = 0.2;    // 一コマ (60fps) で残りのこの割合を寄せる: 一目盛りが 0.2 秒ほどで着く
  let glide = null;          // { box, pos, target, frame, at }

  // 格子の行き先。滑っている途中なら着く所、止まっていれば今の位置
  function relatedOffset(box) {
    return glide && glide.box === box ? glide.target : (Number(box.scrollTop) || 0);
  }

  function glideRelated(box, target) {
    if (typeof requestAnimationFrame !== 'function') {
      box.scrollTop = target;
      return;
    }
    if (!glide || glide.box !== box) {
      stopGlide();
      glide = { box, pos: Number(box.scrollTop) || 0, target, frame: 0, at: 0 };
    }
    glide.target = target;
    if (!glide.frame) glide.frame = requestAnimationFrame(stepGlide);
  }

  function stepGlide(now) {
    const g = glide;
    if (!g) return;
    g.frame = 0;
    // 格子が差し替わった・継ぎ目が畳まれた: 滑りはそこで捨てる
    if (g.box !== relatedElement()) {
      glide = null;
      return;
    }
    const dt = g.at ? Math.min(50, Math.max(0, now - g.at)) : 1000 / 60;
    g.at = now;
    const rest = g.target - g.pos;
    // 残りが一画素を切ったら着いたことにする (端数を這い続けない)
    if (Math.abs(rest) < 1) {
      g.box.scrollTop = g.target;
      glide = null;
      return;
    }
    g.pos += rest * (1 - Math.pow(1 - GLIDE_RATE, dt * 60 / 1000));
    g.box.scrollTop = g.pos;
    g.frame = requestAnimationFrame(stepGlide);
  }

  function stopGlide() {
    if (glide && glide.frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(glide.frame);
    glide = null;
  }

  function scrollRelated(delta, now) {
    const boundary = state.reader && state.reader.boundary;
    if (!boundary || !boundary.related) return now - relatedClosedAt < RELATED_REST;
    if (now - (boundary.at || 0) < 400) return true;
    const box = relatedElement();
    if (!box) return true;
    // 天辺・底は着く所で見る (滑っている途中の scrollTop は遅れている)
    const at = relatedOffset(box);
    const top = at <= 0;
    if (delta < 0 && top) {
      // 天辺に着いた勢いの続きは吸う。手を止めてから改めて回した一発で畳む
      const rested = now - relatedWheelAt >= RELATED_REST;
      relatedWheelAt = now;
      if (!rested) return true;
      hideBoundary();
      relatedClosedAt = now;
      return true;
    }
    relatedWheelAt = now;
    const max = Math.max(0, (Number(box.scrollHeight) || 0) - (Number(box.clientHeight) || 0));
    const target = clamp(at + delta, 0, max);
    glideRelated(box, target);
    flashScrollbar(box);
    // 底が近い: 続きを頼む (届いたら末尾に足すので、巻き続ければそのまま見える)
    if (delta > 0 && target >= max - RELATED_NEAR) loadMoreRelated();
    return true;
  }

  function relatedMarkup() {
    const rows = relatedRows();
    let body;
    if (!rows) body = `<p class="reader-related-note">${related && related.error ? '関連作品を取得できませんでした' : '読み込み中…'}</p>`;
    else if (!rows.length) body = '<p class="reader-related-note">関連作品はありません</p>';
    else body = `<div class="reader-related-grid">${rows.map(relatedItem).join('')}</div>`;
    return `<div class="reader-related"><p class="reader-related-head">関連作品</p>${body}</div>`;
  }

  // 出ている継ぎ目の格子だけ差し替える。札 (次の作品) は触らない: 幕 (fade) をやり直させない
  function fillRelated() {
    const boundary = state.reader && state.reader.boundary;
    if (!boundary || !boundary.related) return;
    const slot = relatedElement();
    if (slot) slot.outerHTML = relatedMarkup();
    window.BunkoAiMeta?.want(relatedRows() || []);
  }

  function datasetOf(node, name) {
    if (!node) return '';
    if (node.dataset && node.dataset[name] != null) return String(node.dataset[name]);
    return typeof node.getAttribute === 'function' ? String(node.getAttribute('data-' + name.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())) || '') : '';
  }

  // 継ぎ目の作品の札 (次の札・関連の札) の押し分けは一覧の札と同じ (設定のマウスの割り当て)。
  // 割り当てを読み、詳細・保存へ回すのは app.js が据える口: (kind, gallery, event, cross)。
  // kind は 'Left' / 'Right' / 'Double'、cross() でその作品へ渡る。口が無ければ左で渡るだけ
  let workPress = null;

  function setWorkPress(fn) {
    workPress = typeof fn === 'function' ? fn : null;
  }

  // 作品の札を押した: 関連の札 → その作品、次の札 → 次の作品。作品の札でなければ false
  function pressWork(event, kind) {
    const target = event.target;
    if (!target || typeof target.closest !== 'function' || !state.reader) return false;
    // 作者名 (次の札の中にもある) は作品の札の押し分けに入れない
    if (target.closest('[data-related-creator]')) return false;
    const work = target.closest('[data-related]') || target.closest('[data-next]');
    if (!work) return false;
    event.preventDefault();
    event.stopPropagation();
    const key = datasetOf(work, 'related');
    const boundary = state.reader.boundary;
    const gallery = key ? boundaryGallery(key) : boundary && boundary.gallery;
    if (!gallery) return true;
    const side = key ? 1 : boundary.dir;
    // 渡るのは継ぎ目が出ている間だけ (左の一呼吸の間に畳まれたら渡らない)
    const cross = () => {
      if (state.reader && state.reader.boundary) crossTo(gallery, side);
    };
    if (workPress) workPress(kind, gallery, event, cross);
    else if (kind === 'Left') cross();
    return true;
  }

  // 継ぎ目の札を押す: 作者名 → 作者の一覧、作品の札 → 割り当てのとおり (上の pressWork)。
  // 関連が出ている間、頁の空白を押しても渡らない
  function onBoundaryClick(event) {
    const target = event.target;
    if (!target || typeof target.closest !== 'function' || !state.reader) return;
    const creator = target.closest('[data-related-creator]');
    if (creator) {
      event.preventDefault();
      event.stopPropagation();
      const gallery = boundaryGallery(datasetOf(creator, 'relatedCreator'));
      if (gallery && creatorOpener) {
        try { creatorOpener(gallery); } catch { /* 一覧側の都合。読みは続ける */ }
      }
      return;
    }
    pressWork(event, 'Left');
  }

  const dir = () => (state.readerRtl ? -1 : 1);

  function isOpen() {
    return Boolean(state.reader || pendingOpen);
  }

  function pageCount() {
    return state.reader ? Number(state.reader.gallery.pageCount) || 0 : 0;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  // ---- 組み立て --------------------------------------------------------

  // 横長の頁は常に単独。それ以外は ずらし を見て 2 枚組にする
  function computeGroups() {
    const count = pageCount();
    groups = [];
    groupOf = new Array(count).fill(0);
    if (!count) return;
    if (!state.readerSpread) {
      for (let i = 0; i < count; i += 1) {
        groupOf[i] = groups.length;
        groups.push([i]);
      }
      return;
    }
    let i = 0;
    if (state.readerOffset === 1) {
      groupOf[0] = 0;
      groups.push([0]);
      i = 1;
    }
    while (i < count) {
      if (landscape.has(i) || i + 1 >= count || landscape.has(i + 1)) {
        groupOf[i] = groups.length;
        groups.push([i]);
        i += 1;
        continue;
      }
      groupOf[i] = groups.length;
      groupOf[i + 1] = groups.length;
      groups.push([i, i + 1]);
      i += 2;
    }
  }

  function groupIndexAt(page) {
    if (!groups.length) computeGroups();
    if (!groups.length) return 0;
    const index = groupOf[clamp(page, 0, groupOf.length - 1)];
    return Number.isInteger(index) ? index : 0;
  }

  function groupAt(page) {
    return groups[groupIndexAt(page)] || [0];
  }

  function noteLandscape(index, img) {
    if (!state.reader || !Number.isInteger(index)) return;
    // 繋ぎのサムネイルは切り抜きの寸法: これで組を決めると本物と食い違う
    if (img.dataset && img.dataset.placeholder) return;
    if (!img.naturalWidth || !img.naturalHeight) return;
    if (img.naturalWidth <= img.naturalHeight) return;
    // 一度入れた頁は二度と入らない: 再 render で onload が再発火しても組は動かない
    if (landscape.has(index)) return;
    landscape.add(index);
    if (!state.readerSpread) return;
    const before = groupAt(state.reader.page);
    computeGroups();
    const after = groupAt(state.reader.page);
    if (before.length !== after.length || before[0] !== after[0]) render();
  }

  // ---- ズームとパン ----------------------------------------------------

  function zoomable() {
    return state.readerFit !== 'width';
  }

  function applyTransform() {
    els.readerPages.style.transform = scale === 1
      ? ''
      : `translate(${panX}px, ${panY}px) scale(${scale})`;
    els.reader.classList.toggle('is-zoomed', scale > 1);
  }

  function clampPan() {
    const rect = els.readerStage.getBoundingClientRect();
    panX = clamp(panX, rect.width - rect.width * scale, 0);
    panY = clamp(panY, rect.height - rect.height * scale, 0);
  }

  function resetZoom() {
    scale = 1;
    panX = 0;
    panY = 0;
    applyTransform();
  }

  // カーソルの下にある一点を動かさずに倍率だけ変える
  function zoomAt(next, clientX, clientY) {
    const target = clamp(next, MIN_SCALE, MAX_SCALE);
    if (target === scale) return;
    const rect = els.readerStage.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const cx = (px - panX) / scale;
    const cy = (py - panY) / scale;
    scale = target;
    panX = px - cx * scale;
    panY = py - cy * scale;
    clampPan();
    applyTransform();
  }

  function panBy(dx, dy) {
    panX += dx;
    panY += dy;
    clampPan();
    applyTransform();
  }

  // ---- 位置の記憶 ------------------------------------------------------

  function flushProgress() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    const entry = savePending;
    savePending = null;
    if (!entry) return;
    try {
      const result = window.hitomi.readingSet?.(entry.id, entry);
      if (result && typeof result.then === 'function') result.catch(() => {});
    } catch {
      // 位置の記憶は best effort
    }
  }

  // 栞の鍵。pixiv の所持の本は机上では px:<投稿 ID>、手のひら版では pweagle:<eagleId>
  // (作者根の項目) で開く。鍵を Eagle の項目に寄せて、続きをどちらでも読めるようにする
  function readingKeyOf(gallery) {
    if (gallery && gallery.source === 'pixiv' && gallery.owned && gallery.eagleId) {
      return `pweagle:${gallery.eagleId}`;
    }
    return String(gallery.id);
  }

  // 栞に添える作者 (Home の「最近読んだ順」が、他のタブで読んだ本を作者で人へ寄せる)。
  // pixiv は user id、hitomi / nhentai / E-Hentai は作者とサークルの名。Pawchive は栞の鍵 (pw:<service>:<user>:…) が作者を言う
  function readingCreatorsOf(gallery) {
    const out = [];
    if (gallery.source === 'pixiv') {
      const userId = String(gallery.userId || ((gallery.artists || [])[0] || {}).userId || '');
      if (/^\d+$/.test(userId)) out.push(`pixiv:${userId}`);
    } else if (['hitomi', 'nhentai', 'ehentai'].includes(gallery.source)) {
      for (const item of gallery.artists || []) if (item && item.name) out.push(`name:${item.name}`);
      for (const item of gallery.groups || []) if (item && item.name) out.push(`group:${item.name}`);
    }
    return out.slice(0, 8);
  }

  function saveProgress(immediate = false) {
    if (!state.reader) return;
    const { gallery, page } = state.reader;
    const count = Number(gallery.pageCount) || 0;
    savePending = {
      id: readingKeyOf(gallery),
      page,
      pageCount: count,
      finished: count > 0 && page >= count - 1 && !state.reader.enteredAtEnd,
      by: readingCreatorsOf(gallery),
    };
    if (immediate) {
      flushProgress();
      return;
    }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushProgress, 500);
  }

  async function restorePage(session) {
    // 設定で切っている間は毎回先頭から。位置の記録じたいは続ける
    // (再びオンにしたとき、最後に読んでいた頁から再開できるように)
    if ((state.settings || {}).readerResume === false) return;
    const initial = session.page;
    let saved = null;
    try {
      saved = await window.hitomi.readingGet?.(readingKeyOf(session.gallery));
    } catch {
      return;
    }
    if (state.reader !== session || !saved || saved.finished) return;
    // 待っている間に自分で頁を送っていたら、引き戻さない
    if (session.page !== initial) return;
    const count = pageCount();
    const resume = Math.round(Number(saved.page) || 0);
    if (resume < 1 || resume >= count - 1) return;
    session.page = resume;
    render();
    toast(`前回の続き p.${resume + 1} から再開`);
  }

  // ---- 頁の入れ替え ----------------------------------------------------
  // 送る前の絵を影として重ね、新しい頁が出てから薄くして消す。
  // 写すのは見えていた位置と大きさだけ: 動かさないのでズームや折り返しには触らない

  const FADE_MS = 60;
  const FADE_GUARD = 150;  // これより短い間隔の連打は影を出さない (溜めずに素通し)
  const FADE_WAIT = 400;   // 新しい頁がこれだけ待っても来なければ影は諦める

  let ghost = null;
  let ghostTimer = 0;
  let ghostAt = 0;

  function dropGhost() {
    clearTimeout(ghostTimer);
    ghostTimer = 0;
    if (!ghost) return;
    ghost.remove();
    ghost = null;
  }

  function raiseGhost() {
    // 消えかけの影が残っていても新しい送りが勝つ: 溜めずにその場で捨てる
    const fading = Boolean(ghost);
    dropGhost();
    const now = Date.now();
    const rapid = now - ghostAt < FADE_GUARD;
    ghostAt = now;
    // 連打の途中と拡大中は影を出さない (拡大は倍率が変わると位置が食い違う)
    if (rapid || fading || scale > 1 || !els.readerBody) return;
    const box = els.readerBody.getBoundingClientRect();
    const node = document.createElement('div');
    node.className = 'reader-ghost';
    [els.readerImage, els.readerImage2].forEach((img) => {
      if (img.hidden || !img.naturalWidth) return;
      const rect = img.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const copy = document.createElement('img');
      copy.style.cssText = `left:${rect.left - box.left}px;top:${rect.top - box.top}px;width:${rect.width}px;height:${rect.height}px;`;
      // PDF の頁は LRU で object URL ごと消える: 影の読み損ないは黙って捨てる
      copy.onerror = () => copy.remove();
      copy.src = img.currentSrc || img.src;
      node.appendChild(copy);
    });
    if (!node.children.length) return;
    els.readerBody.appendChild(node);
    ghost = node;
    ghostTimer = setTimeout(dropGhost, FADE_WAIT);
  }

  // 新しい頁が出た合図。ここで初めて薄くしはじめる
  function releaseGhost() {
    if (!ghost || ghost.classList.contains('is-out')) return;
    clearTimeout(ghostTimer);
    // 差し込んだ直後だと初期値が計算されておらず遷移が起きない: 一度測って確定させる
    void ghost.offsetWidth;
    ghost.classList.add('is-out');
    ghostTimer = setTimeout(dropGhost, FADE_MS + 40);
  }

  // ---- 表示 ------------------------------------------------------------

  // 頁 1 枚を img に載せる。ローカル原本のときは描き上がってから差す
  function setPageSrc(img, gallery, index, size) {
    img.dataset.page = String(index);
    const local = localSession();
    if (!local) {
      img.src = size === 'full' ? readUrl(gallery.id, index) : imgUrl(gallery.id, index, size);
      return;
    }
    if (local.kind === 'image') {
      img.src = local.url;
      return;
    }
    const cached = pdfUrls.get(index);
    if (cached) {
      delete img.dataset.placeholder;
      rememberPage(index, cached);
      img.src = cached;
      return;
    }
    // 表紙だけは Eagle のサムネイルが (格子で読んだぶん) 手元にある: 描き上がるまでの繋ぎに出す
    if (index === 0 && local.cover) {
      img.dataset.placeholder = '1';
      img.src = local.cover;
    } else {
      delete img.dataset.placeholder;
      img.removeAttribute('src');
    }
    const token = pdfToken;
    const job = ensurePdfPage(index);
    if (!job) return;
    job.then((url) => {
      if (token !== pdfToken || !state.reader) return;
      if (!sameId(state.reader.gallery.id, gallery.id)) return;
      // 頁が動いたあとに届いた描画は捨てる
      if (Number(img.dataset.page) !== index) return;
      if (!url) {
        setPageStatus(img, 'error', index);
        return;
      }
      delete img.dataset.placeholder;
      img.src = url;
    });
  }

  function pageSlot(img) {
    return img.closest('.reader-page-slot');
  }

  function setPageStatus(img, status, index) {
    const node = pageSlot(img)?.querySelector('.reader-page-status');
    if (!node) return;
    if (status === 'error') {
      node.innerHTML = `画像を読めませんでした <button type="button" data-reader-retry="${index}">再試行</button>`;
    } else {
      node.textContent = status === 'loading' ? '読み込み中…' : '';
    }
  }

  function prepareImage(img, gallery, index) {
    setPageStatus(img, 'loading', index);
    img.onload = () => {
      if (Number(img.dataset.page) !== index) return;
      setPageStatus(img, 'ready', index);
      releaseGhost();
      noteLandscape(index, img);
    };
    img.onerror = () => {
      if (Number(img.dataset.page) !== index) return;
      setPageStatus(img, 'error', index);
    };
    setPageSrc(img, gallery, index, 'full');
    if (img.complete && img.naturalWidth) img.onload();
  }

  // 先読みした頁 (頁番号 → Image)。参照を手放すと画に起こしたぶんまで捨てられ、
  // 送った先で復号し直しになる: 温めている間だけ抱えておく (LAN の read.js の warm と同じ手)
  const warm = new Map();

  function warmPage(gallery, page) {
    const have = warm.get(page);
    if (have) return have;
    const img = new Image();
    img.decoding = 'async';
    // 先読みで横長が分かれば、表示に回る前に組を直せる。
    // 遅れて届いた分が次の作品の組に混ざらないよう、持ち主を確かめる
    img.onload = () => {
      if (!state.reader || !sameId(state.reader.gallery.id, gallery.id)) return;
      noteLandscape(page, img);
    };
    img.src = readUrl(gallery.id, page);
    // 取ってくるだけでなく画に起こすところまで先に済ませる。送ってから復号すると、
    // 届いている頁でもその一拍だけ白が見える
    if (img.decode) img.decode().catch(() => { /* 出せない頁は出す時に諦める */ });
    warm.set(page, img);
    return img;
  }

  function preloadGroup(group) {
    const { gallery } = state.reader;
    const index = groupIndexAt(group[group.length - 1]);
    const pages = [];
    // めくっている向きへ 6 組、逆向きは 2 組温める。
    // 帯域は main 側の同時取得の枠が抑えるので、深めに配っても取り合いにはならない。
    // 所持作品は main が裏で本ごと用意しているので、ここは連続めくりで追い越さないための保険
    const ahead = turnDir < 0 ? 2 : 6;
    const behind = turnDir < 0 ? 6 : 2;
    for (let step = 1; step <= ahead; step += 1) {
      const next = groups[index + step];
      if (next) pages.push(...next);
    }
    for (let step = 1; step <= behind; step += 1) {
      const prev = groups[index - step];
      if (prev) pages.push(...prev);
    }
    const local = localSession();
    if (local) {
      if (local.kind !== 'pdf') return;
      const token = pdfToken;
      pages.forEach((page) => {
        notePdfShape(page, token);
        ensurePdfPage(page, false);
      });
      return;
    }
    pages.forEach((page) => warmPage(gallery, page));
    // 温める範囲から外れた頁は手放す (今出ている組は抱えたまま: 戻りが速い)。
    // 参照を捨てるだけでは取得が続き、Chromium の同時接続 (同じ相手に 6 本) を
    // 塞いだままになる: 連続めくりで今の頁の要求が古い先読みの後ろに並び、
    // 「読み込み中…」のまま止まって見えた。src を空にして取得そのものを止める
    const keep = new Set([...pages, ...group]);
    for (const [page, img] of [...warm.entries()]) {
      if (keep.has(page)) continue;
      warm.delete(page);
      if (!img.complete) img.src = '';
    }
  }

  function render() {
    if (!state.reader) return;
    const { gallery, page } = state.reader;
    const group = groupAt(page);
    els.readerLoading.classList.add('is-hidden');
    prepareImage(els.readerImage, gallery, group[0]);
    if (group.length > 1) {
      els.readerImage2.hidden = false;
      pageSlot(els.readerImage2).hidden = false;
      prepareImage(els.readerImage2, gallery, group[1]);
      els.readerPage.textContent = `${group[0] + 1}-${group[1] + 1} / ${gallery.pageCount}`;
    } else {
      els.readerImage2.onload = null;
      els.readerImage2.hidden = true;
      pageSlot(els.readerImage2).hidden = true;
      setPageStatus(els.readerImage2, 'ready', -1);
      els.readerImage2.removeAttribute('src');
      els.readerPage.textContent = `${group[0] + 1} / ${gallery.pageCount}`;
    }
    els.readerSeek.value = String(group[0]);
    if (state.readerFit === 'width') els.readerStage.scrollTop = 0;
    preloadGroup(group);
    // 端の組まで来たら隣の作品の表紙だけ温める。それ以上は先読みしない
    const edge = groupIndexAt(page);
    if (edge === groups.length - 1) {
      warmNeighbor(1);
      warmRelated(true);
    }
    if (edge === 0) warmNeighbor(-1);
    if (!els.readerThumbs.hidden) markThumb();
    refreshSide();
    paintPromptButton();
  }

  function setPage(next, save = true) {
    if (!state.reader) return;
    // 頁が動くなら継ぎ目の札は用済み (シーク・一覧・ジャンプからも来る)
    hideBoundary();
    const count = pageCount();
    if (!count) return;
    const to = clamp(Math.round(Number(next) || 0), 0, count - 1);
    // 同じ組に留まる指定 (見開きの相方など) は入れ替えではない: 影を出す幕もない
    const fromGroup = groupIndexAt(state.reader.page);
    const toGroup = groupIndexAt(to);
    if (toGroup !== fromGroup) {
      raiseGhost();
      turnDir = toGroup > fromGroup ? 1 : -1;
    }
    if (to !== state.reader.page) state.reader.enteredAtEnd = false;
    state.reader.page = to;
    resetZoom();
    render();
    if (save) saveProgress();
  }

  // 隣の作品へ渡る。前の作品へは巻き戻りなので最後の頁から入る。
  // 継ぎ目で去るときも閉じるときと同じに: 今いた頁を記録してから次を開く。
  // 渡った足跡 (trail) を積む: マウスの戻るで一つ前の作品 (居た頁) へ帰れる。
  // 一覧や詳細から開き直したら足跡は捨てる (別の旅)
  let trail = [];
  let crossing = false;

  function crossTo(other, side) {
    const from = state.reader ? { gallery: state.reader.gallery, page: state.reader.page } : null;
    hideBoundary();
    saveProgress(true);
    crossing = true;
    try {
      open(other, side > 0 ? 0 : 'last');
      if (from && state.reader && state.reader.gallery === other) trail.push(from);
    } finally {
      crossing = false;
    }
  }

  function trailLength() {
    return trail.length;
  }

  // 一つ前の作品へ (居た頁で)。足跡が無ければ false: 呼び手が閉じる側へ回す
  function back() {
    if (!state.reader || !trail.length) return false;
    const prev = trail.pop();
    hideBoundary();
    saveProgress(true);
    crossing = true;
    try {
      open(prev.gallery, prev.page);
    } finally {
      crossing = false;
    }
    return true;
  }

  function move(delta) {
    if (!state.reader) return;
    // 札を出したのと同じ向きへもう一度なら開く。逆向きは札を畳んで元の頁に留まる
    if (state.reader.boundary) {
      const { gallery: other, dir: side } = state.reader.boundary;
      if ((delta > 0) !== (side > 0)) {
        hideBoundary();
        return;
      }
      // 次の無い札 (関連作品だけ) は同じ向きでも留まる: 渡る先は関連の札を押して選ぶ
      if (other) crossTo(other, side);
      return;
    }
    const next = groups[groupIndexAt(state.reader.page) + (delta > 0 ? 1 : -1)];
    if (next) {
      setPage(next[0]);
      return;
    }
    // 端から先へ送ったら隣へ。隣が無ければ今までどおり何も起きない
    // (pixiv で札を挟む設定なら、隣が無くても関連作品の札は出す)。
    // 設定で札を挟むなら顔だけ見せて、同じ向きにもう一度で渡る。挟まないなら直に渡る
    const side = delta > 0 ? 1 : -1;
    const other = neighborOf(side);
    if (!other && !(side > 0 && showsRelated())) return;
    if (showsNextCard()) showBoundary(other, side);
    else crossTo(other, side);
  }

  // ---- ツールバーの見た目 ----------------------------------------------

  // ★ (Eagle 評価)。読みながら付けられるよう、題の隣に 5 つ並べる。
  // Eagle のアイテムに紐付いている作品でだけ出す (書き込む先が無いと意味がない)

  // Eagle と同じ、角の尖った五芒星。塗り/輪郭の切り替えは CSS (.on) に任せる
  const SHARP_STAR = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M12 1.8l3.15 6.68 7.05.98-5.18 5.12 1.28 7.14L12 18.32l-6.3 3.38 1.28-7.14L1.8 9.46l7.05-.98z"/></svg>';

  function currentStar() {
    const gallery = state.reader && state.reader.gallery;
    return Math.max(0, Math.min(5, Math.round(Number(gallery && gallery.star) || 0)));
  }

  function paintStars(preview) {
    const shown = preview == null ? currentStar() : preview;
    els.readerStars.querySelectorAll('[data-star]').forEach((btn) => {
      btn.classList.toggle('on', Number(btn.dataset.star) <= shown);
      // 読み上げには確定値だけ伝える (ホバーの仮点灯は視覚だけの話)
      if (preview == null) {
        btn.setAttribute('aria-checked', Number(btn.dataset.star) === shown ? 'true' : 'false');
      }
    });
  }

  function renderStars() {
    const gallery = state.reader && state.reader.gallery;
    const eagleId = gallery && gallery.eagleId ? String(gallery.eagleId) : '';
    els.readerStars.hidden = !eagleId;
    if (!eagleId) {
      els.readerStars.innerHTML = '';
      return;
    }
    els.readerStars.setAttribute('role', 'radiogroup');
    els.readerStars.setAttribute('aria-label', 'Eagle の評価');
    els.readerStars.innerHTML = [1, 2, 3, 4, 5].map((n) => (
      `<button type="button" class="rstar" role="radio" data-star="${n}" title="★${n}" aria-label="★${n}">${SHARP_STAR}</button>`
    )).join('');
    paintStars(null);
  }

  async function rateStar(n) {
    const gallery = state.reader && state.reader.gallery;
    if (!gallery || !gallery.eagleId) return;
    // Eagle の API は「星の解除 (0)」を受け付けない (0/null を送っても無視される)。
    // 「同じ星で解除」はアプリ内の記録と Eagle が食い違う源だったので置かない。
    // 外したいときは Eagle 側で外す (次の走査・注釈で追いつく)
    if (n === currentStar()) return;

    // 先に画面側の全コピー (リーダー・一覧・詳細) へ楽観的に反映する。
    // 書き込み中に注釈の引き直し (annotate) が走ると、一覧が持っている星を
    // そのまま返してくるので、古い値のままだと完了後に巻き戻されて見える
    const touched = [];
    const apply = (obj) => {
      if (!obj) return;
      touched.push({ obj, star: obj.star });
      obj.star = n;
    };
    apply(gallery);
    try {
      for (const item of state.galleries || []) {
        if (item && item !== gallery && sameId(item.id, gallery.id)) apply(item);
      }
      if (state.selected && state.selected !== gallery && sameId(state.selected.id, gallery.id)) {
        apply(state.selected);
      }
    } catch {
      // 配り損ねても本命 (gallery) には効いている
    }
    paintStars(null);

    let result = null;
    try {
      result = await window.hitomi.setEagleStar(String(gallery.eagleId), n);
    } catch {
      result = null;
    }
    if (!result || !result.ok) {
      // 書けなかったら元へ戻す
      for (const entry of touched) entry.obj.star = entry.star;
      paintStars(null);
      toast('Eagle に評価を書き込めませんでした — Eagle が起動しているか確認', { type: 'error' });
      return;
    }
    try {
      for (const item of state.galleries || []) {
        if (item && sameId(item.id, gallery.id)) refreshCard(item);
      }
    } catch {
      // 札の描き直しに失敗しても値は配れている
    }
    toast(`★${result.star} を付けました`);
  }

  function applyDir() {
    els.reader.classList.toggle('is-rtl', state.readerRtl);
    els.readerRtl.innerHTML = state.readerRtl ? ICON.bindRtl : ICON.bindLtr;
    const bindLabel = state.readerRtl ? '右綴じ' : '左綴じ';
    els.readerRtl.title = `${bindLabel} — d`;
    els.readerRtl.setAttribute('aria-label', bindLabel);
    els.readerPrev.setAttribute('aria-label', state.readerRtl ? '次へ' : '前へ');
    els.readerNext.setAttribute('aria-label', state.readerRtl ? '前へ' : '次へ');
  }

  function applyFit() {
    const wide = state.readerFit === 'width';
    els.reader.classList.toggle('fit-width', wide);
    // アイコンは今ではなく次を見せる: 押したらどうなるかを先に言う
    els.readerFit.innerHTML = wide ? ICON.fitHeight : ICON.fitWidth;
    const next = wide ? '縦幅に合わせる' : '横幅に合わせる';
    els.readerFit.title = `${next} — 押すと切替`;
    els.readerFit.setAttribute('aria-label', next);
    // 横フィットは縦スクロールが仕事: ズームは畳む
    if (wide) {
      resetZoom();
      els.readerStage.scrollTop = 0;
    }
  }

  function setFit(fit) {
    if (state.readerFit === fit) return;
    state.readerFit = fit;
    state.settings.readerFit = fit;
    window.hitomi.saveSettings({ readerFit: fit });
    applyFit();
  }

  function applySpread() {
    els.reader.classList.toggle('is-spread', state.readerSpread);
    els.readerSpread.innerHTML = state.readerSpread ? ICON.spread : ICON.single;
    const spreadLabel = state.readerSpread ? '見開き' : '単ページ';
    els.readerSpread.title = `${spreadLabel} — s`;
    els.readerSpread.setAttribute('aria-label', spreadLabel);
    els.readerSpread.classList.toggle('active', state.readerSpread);
    els.readerSpread.setAttribute('aria-pressed', state.readerSpread ? 'true' : 'false');
    els.readerOffset.hidden = !state.readerSpread;
    els.readerOffset.classList.toggle('active', state.readerOffset === 1);
    if (state.reader) computeGroups();
  }

  function applyPrefs() {
    applyDir();
    applyFit();
    applySpread();
  }

  async function toggleFullscreen() {
    try {
      const fs = await window.hitomi.toggleFullscreen();
      state.readerFullscreen = Boolean(fs);
    } catch {
      toast('全画面を切り替えられませんでした', { type: 'error' });
    }
  }

  // ---- 頁ジャンプ ------------------------------------------------------

  function jumpOpen() {
    if (!state.reader || !els.readerPageInput.hidden) return;
    els.readerPageInput.max = String(pageCount());
    els.readerPageInput.value = String(state.reader.page + 1);
    els.readerPage.hidden = true;
    els.readerPageInput.hidden = false;
    els.readerPageInput.focus();
    els.readerPageInput.select();
  }

  // 後ろの棚を止める (body.reader-open の overflow)。止めるとスクロールバーが消えて棚の幅が変わり、
  // 流しが組み直される: 開く・閉じるたびに後ろの札が跳んでいた。消える幅を先に測り、その分の右の余白で幅を保つ
  // (html の scrollbar-gutter は overflow を止めると効かない。Chromium で測った)
  function lockPage() {
    if (document.body.classList.contains('reader-open')) return;
    const root = document.documentElement;
    const gap = root && root.clientWidth ? Math.max(0, (window.innerWidth || 0) - root.clientWidth) : 0;
    if (document.body.style.setProperty) document.body.style.setProperty('--reader-scrollbar-gap', `${gap}px`);
    document.body.classList.add('reader-open');
  }

  function unlockPage() {
    document.body.classList.remove('reader-open');
    if (document.body.style.removeProperty) document.body.style.removeProperty('--reader-scrollbar-gap');
  }

  function jumpClose() {
    if (els.readerPageInput.hidden) return;
    els.readerPageInput.hidden = true;
    els.readerPage.hidden = false;
  }

  function jumpCommit() {
    const raw = String(els.readerPageInput.value || '').trim();
    jumpClose();
    // 空のまま Enter は「やめた」: Number('') が 0 になって 1 頁目へ飛ばさない
    if (!raw) return;
    const value = Math.round(Number(raw));
    if (!Number.isFinite(value)) return;
    setPage(value - 1);
  }

  // ---- サムネイル一覧 --------------------------------------------------

  function thumbsOpen() {
    return !els.readerThumbs.hidden;
  }

  function markThumb() {
    const current = new Set(groupAt(state.reader.page));
    let first = null;
    [...els.readerThumbsGrid.children].forEach((node) => {
      const on = current.has(Number(node.dataset.page));
      node.classList.toggle('current', on);
      if (on && !first) first = node;
    });
    if (first) first.scrollIntoView({ block: 'center' });
  }

  function renderThumbs() {
    const { gallery } = state.reader;
    const local = localSession();
    const cells = [];
    for (let i = 0; i < gallery.pageCount; i += 1) {
      // ローカル原本は描かないと絵が無い: 見えた札から順に埋める
      const src = local ? '' : ` src="${imgUrl(gallery.id, i, 'small')}"`;
      cells.push(`<button type="button" class="reader-thumb" data-page="${i}"><img${src} alt="" loading="lazy" /><span>${i + 1}</span></button>`);
    }
    els.readerThumbsGrid.innerHTML = cells.join('');
    if (local) fillLocalThumbs();
  }

  async function drawThumb(node) {
    const index = Number(node.dataset.page);
    const token = pdfToken;
    let canvas = null;
    try {
      canvas = await drawPdfPage(index, token, PDF_THUMB_WIDTH);
    } catch (error) {
      if (token === pdfToken && error?.name !== 'RenderingCancelledException') {
        console.warn('[reader] 一覧の頁を描けませんでした', index, error);
      }
      return;
    }
    if (!canvas || token !== pdfToken || !node.isConnected) return;
    const img = node.querySelector('img');
    // 一覧は閉じるときに丸ごと消える: data URL なら解放を気にしなくていい
    if (img) img.src = canvas.toDataURL('image/jpeg', 0.7);
  }

  function fillLocalThumbs() {
    const local = localSession();
    if (!local) return;
    if (local.kind === 'image') {
      const img = els.readerThumbsGrid.querySelector('.reader-thumb img');
      if (img) img.src = local.url;
      return;
    }
    if (thumbObserver) thumbObserver.disconnect();
    thumbObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        thumbObserver.unobserve(entry.target);
        drawThumb(entry.target);
      });
    }, { root: els.readerThumbs, rootMargin: '300px' });
    [...els.readerThumbsGrid.children].forEach((node) => thumbObserver.observe(node));
  }

  function closeThumbs() {
    if (thumbObserver) {
      thumbObserver.disconnect();
      thumbObserver = null;
    }
    els.readerThumbs.hidden = true;
    els.readerThumbsGrid.innerHTML = '';
  }

  function openThumbs() {
    if (!state.reader) return;
    els.readerThumbs.hidden = false;
    renderThumbs();
    markThumb();
  }

  function toggleThumbs() {
    if (thumbsOpen()) closeThumbs();
    else openThumbs();
  }

  // ---- 開閉 ------------------------------------------------------------

  // while the reader is open the downloader yields bandwidth to page fetches
  function readerPriority(active) {
    try {
      const result = window.hitomi.readerActive?.(active);
      if (result && typeof result.then === 'function') result.catch(() => {});
    } catch {
      /* the hint is best effort */
    }
  }

  function begin(gallery, page, local) {
    // 網から読むときは前の原本を抱えたままにしない
    if (!local) disposeLocal();
    dropRedoUnlessRestoring();
    // 'last' は開くまで頁数が分からない呼び出し (ローカル原本) からの言付け: ここで初めて解ける
    const last = Math.max(0, (Number(gallery.pageCount) || 0) - 1);
    const explicit = page === 'last' || Number(page) > 0;
    const start = page === 'last' ? last : clamp(Math.round(Number(page) || 0), 0, last);
    // 'last' で入った (前の作品へ巻き戻った) 印。頁を一度でも動かすまでは「読み終えた」に数えない:
    // 先頭で前へ送っただけで、読んでいない前の作品が読了 (finishedCount +1) になっていた
    const session = { gallery, page: start, local: local || null, enteredAtEnd: page === 'last' };
    pendingOpen = null;
    state.reader = session;
    state.readerOffset = 0;
    landscape = new Set();
    // 頁番号は作品ごとの数え: 前の作品の絵を持ち越すと別の頁として当たる
    warm.clear();
    hideBoundary();
    dropGhost();
    // 前の作品で押した一打目の取り消し先は、次の作品では意味を成さない
    turnedFrom = -1;
    // 開いた直後は先へ読み進む前提に戻す ('last' で入っても組は 1 つしかない)
    turnDir = 1;
    resetZoom();
    jumpClose();
    closeThumbs();
    readerPriority(true);
    els.reader.hidden = false;
    lockPage();
    els.readerTitle.textContent = gallery.title;
    renderStars();
    // 保存先の無い開き方 (ローカル原本・Eagle アイテム) では保存釦を出さない。
    // 押しても失敗トーストにしかならない
    const dlBtn = document.getElementById('reader-download');
    if (dlBtn) {
      dlBtn.hidden = Boolean(local)
        || (typeof isEagleItem === 'function' && isEagleItem(gallery));
    }
    els.readerSeek.max = Math.max(0, gallery.pageCount - 1);
    els.readerSeek.value = String(start);
    // プロンプトの釦は pixiv の AI 作品だけ。板は開いたまま次の作品へ渡れる (プロンプトが出せない作品では情報に替わる)
    const promptBtn = sideButton('prompt');
    const canPrompt = Boolean(window.BunkoAiMeta && window.BunkoAiMeta.canPrompt(gallery));
    if (promptBtn) promptBtn.hidden = !canPrompt;
    if (canPrompt) window.BunkoAiMeta.want([gallery]);   // 印が届けば paintPromptButton が色を付ける
    applyDir();
    applyFit();
    applySpread();
    computeGroups();
    // 板の言付けは組 (groups) が決まってから: render() が板を描くので、ここでは開くだけ
    if (pendingSide) { side = ''; openSide(pendingSide, { paint: false }); pendingSide = ''; } else if (side === 'prompt' && !canPrompt) openSide('info', { paint: false });
    render();
    maybeShowHint();
    // 呼び出し元が頁を指しているとき (redo 復元・継ぎ目からの巻き戻り) はそちらを優先
    if (!explicit) restorePage(session);
  }

  // worker は file:// から直に起こせない: 画像サーバから取って blob に包む。
  // 包めなくても pdf.js は本体側で描くので、開けないことにはしない
  let workerPrepared = false;

  async function prepareWorker(lib) {
    if (workerPrepared || lib.GlobalWorkerOptions.workerSrc) return;
    workerPrepared = true;
    try {
      const res = await fetch(`${state.imageBase}/pdfworker`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const code = await res.text();
      lib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    } catch (error) {
      console.warn('[reader] pdf.js の worker を用意できませんでした', error);
    }
  }

  // 原本が読めなかったとき。網の頁があるならそちらで、無ければ Eagle に投げる
  function localFallback(gallery, page, token) {
    if (token !== pdfToken) return;
    pendingOpen = null;
    if (Number(gallery.pageCount) > 0 && gallery.kind !== 'eagleItem') {
      begin(gallery, page, null);
      return;
    }
    try {
      window.hitomi.openEagle(gallery.eagleId);
    } catch {
      toast('作品を開けませんでした', { type: 'error' });
    }
  }

  // 開けた doc を受け取って作品として出す。追い越されていたら黙って捨てる
  function beginPdf(doc, gallery, page, token) {
    if (token !== pdfToken) {
      try {
        doc.destroy();
      } catch {
        /* 開き直しに追い越された分 */
      }
      return false;
    }
    pdfDoc = doc;
    const cover = gallery.eagleId ? `${state.imageBase}/pweagle/${encodeURIComponent(gallery.eagleId)}` : '';
    begin({ ...gallery, pageCount: doc.numPages }, page, { kind: 'pdf', cover });
    return true;
  }

  async function openLocal(gallery, page) {
    disposeLocal();
    const token = pdfToken;
    const controller = new AbortController();
    pendingOpen = { token, controller, loadingTask: null };
    const src = `${state.imageBase}/pwfile/${encodeURIComponent(gallery.eagleId)}`;
    readerPriority(true);
    els.reader.hidden = false;
    lockPage();
    els.readerTitle.textContent = gallery.title || '';
    els.readerLoading.innerHTML = '読み込み中… <button id="reader-cancel" type="button">キャンセル</button>';
    els.readerLoading.classList.remove('is-hidden');

    // 原本は数百 MB になることがある: まず種別だけ聞いて、PDF なら範囲取得で頭から描き始める
    let type = '';
    try {
      const probe = await fetch(src, { method: 'HEAD', signal: controller.signal });
      if (!probe.ok) throw new Error(`HTTP ${probe.status}`);
      type = String(probe.headers.get('content-type') || '').toLowerCase();
    } catch (error) {
      if (token !== pdfToken || error?.name === 'AbortError') return;
      console.warn('[reader] ローカル原本を取れませんでした', gallery.eagleId, error);
      localFallback(gallery, page, token);
      return;
    }
    if (token !== pdfToken) return;

    const lib = window.pdfjsLib;
    if (type.includes('pdf') && lib) {
      try {
        await prepareWorker(lib);
        // 256KB 単位。1 頁目に要るぶんだけ取れれば、丸ごと落とすより桁で速い
        const loadingTask = lib.getDocument({ url: src, rangeChunkSize: 262144, withCredentials: false });
        if (pendingOpen?.token === token) pendingOpen.loadingTask = loadingTask;
        const doc = await loadingTask.promise;
        if (beginPdf(doc, gallery, page, token)) return;
        return;
      } catch (error) {
        if (token !== pdfToken) return;
        // 範囲取得が通らない環境もある: 諦める前に丸ごと取る昔の道を試す
        console.warn('[reader] 範囲取得で PDF を開けませんでした', gallery.eagleId, error);
        if (token !== pdfToken) return;
      }
    }

    let blob = null;
    try {
      const res = await fetch(src, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      blob = await res.blob();
    } catch (error) {
      if (token !== pdfToken || error?.name === 'AbortError') return;
      console.warn('[reader] ローカル原本を取れませんでした', gallery.eagleId, error);
      localFallback(gallery, page, token);
      return;
    }
    if (token !== pdfToken) return;
    const blobType = String(blob.type || type).toLowerCase();

    if (blobType.includes('pdf')) {
      if (!lib) {
        console.warn('[reader] pdf.js が読み込まれていません');
        localFallback(gallery, page, token);
        return;
      }
      try {
        await prepareWorker(lib);
        const buffer = await blob.arrayBuffer();
        if (token !== pdfToken) return;
        const loadingTask = lib.getDocument({ data: new Uint8Array(buffer) });
        if (pendingOpen?.token === token) pendingOpen.loadingTask = loadingTask;
        const doc = await loadingTask.promise;
        beginPdf(doc, gallery, page, token);
      } catch (error) {
        if (token !== pdfToken) return;
        console.warn('[reader] PDF を開けませんでした', gallery.eagleId, error);
        disposeLocal();
        // disposeLocal advances the generation; this failure still belongs to the
        // current request, so use the new generation for its deliberate fallback.
        localFallback(gallery, page, pdfToken);
      }
      return;
    }

    // 紛れ込んだ画像は 1 頁の作品として出す。動画などは Eagle の仕事
    if (blobType.startsWith('image/')) {
      const url = URL.createObjectURL(blob);
      if (token !== pdfToken) {
        URL.revokeObjectURL(url);
        return;
      }
      rememberPage(0, url);
      begin({ ...gallery, pageCount: 1 }, 0, { kind: 'image', url });
      return;
    }
    console.warn('[reader] 読める形式ではありません', gallery.eagleId, blobType);
    localFallback(gallery, page, token);
  }

  function open(gallery, page = 0, opts = {}) {
    wheelBoundary = ''; wheelAcc = 0;
    pendingSide = opts && (opts.side === 'prompt' || opts.side === 'info') ? opts.side : '';
    if (!crossing) trail = [];
    // 作者の札は作品ではない: 開く先が無いので黙って何もしない
    // (呼び出し側が作品一覧へ送るのが筋)
    if (gallery && gallery.kind === 'creator') return;
    if (readsLocal(gallery)) {
      openLocal(gallery, page);
      return;
    }
    if (!Number(gallery?.pageCount)) {
      toast('ページ情報がありません', { type: 'error' });
      return;
    }
    begin(gallery, page, null);
  }

  function close() {
    if (!state.reader && !pendingOpen) return;
    dismissHint();
    if (state.reader) saveProgress(true);
    if (state.readerFullscreen) {
      state.readerFullscreen = false;
      window.hitomi.toggleFullscreen();
    }
    hideBoundary();
    dropGhost();
    warm.clear();
    closeSide();
    state.reader = null;
    readerPriority(false);
    jumpClose();
    closeThumbs();
    resetZoom();
    els.reader.hidden = true;
    unlockPage();
    els.readerImage.removeAttribute('src');
    els.readerImage2.removeAttribute('src');
    els.readerImage2.hidden = true;
    pageSlot(els.readerImage2).hidden = true;
    disposeLocal();
  }

  // ---- 入力 ------------------------------------------------------------

  function isTyping() {
    const node = document.activeElement;
    if (!node) return false;
    const tag = node.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable;
  }

  // 単位を画素に揃える。行 (1) や画面 (2) で寄越す環境がある
  function wheelDelta(event) {
    const raw = Number(event.deltaY) || 0;
    if (event.deltaMode === 1) return raw * 20;
    if (event.deltaMode === 2) return raw * 100;
    return raw;
  }

  // 溜めが敷居を越えたら一組だけ送る。一度の wheel で二組以上は送らない:
  // OS がまとめて寄越した時に三組飛ぶほうが、間引かれるより嫌われる
  function wheelTurn(delta, now, step) {
    const idle = now - wheelAt > 320;
    const dirNow = delta > 0 ? 1 : -1;
    const edge = state.reader && !groups[groupIndexAt(state.reader.page) + dirNow];
    // A wheel burst must stop at the work boundary, even when the preview card is disabled.
    // pixiv の関連作品の札 (隣が無くても出る) の前でも同じに止まる
    if (edge && (neighborOf(dirNow) || (dirNow > 0 && showsRelated()))) {
      const key = `${state.reader.gallery.id}:${dirNow}`;
      if (wheelBoundary !== key || !idle) {
        wheelBoundary = key;
        wheelAt = now;
        wheelAcc = 0;
        if (showsNextCard() && !state.reader.boundary) showBoundary(neighborOf(dirNow), dirNow);
        return;
      }
    } else wheelBoundary = '';
    // 向きが変わったら溜めは捨てる。間が空いた時も同じ
    if (wheelAcc && ((delta > 0) !== (wheelAcc > 0) || now - wheelAt > WHEEL_IDLE)) wheelAcc = 0;
    wheelAt = now;
    wheelAcc += delta;
    if (Math.abs(wheelAcc) < step) return;
    // 細かい刻みだけ間隔を空ける。深い刻みをここで落とすと、速く回した時に
    // 束の最後の一目盛りが行き場を失う (直す前の間引きと同じことになる)
    if (Math.abs(delta) < WHEEL_UNIT && now - lastTurn < WHEEL_FINE) return;
    lastTurn = now;
    const dir = wheelAcc > 0 ? 1 : -1;
    wheelAcc = 0;
    move(dir);
  }

  function handleWheel(event) {
    if (!isOpen() || els.reader.hidden) return false;
    dismissHint();
    if (thumbsOpen()) return false;
    // 右の板 (情報 / プロンプト) の上のホイールは板を巻く: 頁は送らない (preventDefault もしない)
    if (side && event.target && typeof event.target.closest === 'function' && event.target.closest('#reader-side')) return true;
    const now = Date.now();

    if (event.ctrlKey) {
      event.preventDefault();
      if (!zoomable()) return true;
      zoomAt(scale * (event.deltaY > 0 ? 0.85 : 1.18), event.clientX, event.clientY);
      return true;
    }

    // 拡大中は縦パン。横フィットは元々スクロールなのでここには来ない
    if (scale > 1 && zoomable()) {
      event.preventDefault();
      panBy(0, -event.deltaY);
      return true;
    }

    const stage = els.readerStage;
    const delta = wheelDelta(event);
    const wide = state.readerFit === 'width';
    // 横倒しのホイール (deltaY が 0) で頁を動かさない
    if (!delta) {
      if (!wide) event.preventDefault();
      return true;
    }

    // 関連作品の札が出ている間、ホイールは格子を巻く (渡るのは札を押して)
    if (scrollRelated(delta, now)) {
      event.preventDefault();
      return true;
    }

    if (wide) {
      const atBottom = stage.scrollTop + stage.clientHeight >= stage.scrollHeight - 2;
      const atTop = stage.scrollTop <= 0;
      if ((delta > 0 && atBottom) || (delta < 0 && atTop)) {
        event.preventDefault();
        // 端に着けた一目盛りは本文を流すのに使われ、送りはその次の一目盛りから。
        // 刻みの細かいホイールでは、端で敷居ぶん溜まって初めて送る
        wheelTurn(delta, now, WHEEL_EDGE);
      } else {
        // 本文を流している間は溜めない (端に着いた瞬間に繰り越さないため)
        wheelAcc = 0;
        wheelAt = now;
      }
      return true;
    }

    event.preventDefault();
    wheelTurn(delta, now, WHEEL_STEP);
    return true;
  }

  function handleKey(event) {
    if (!isOpen() || event.isComposing) return false;
    dismissHint();

    if (thumbsOpen()) {
      if (event.key === 'Escape' || event.key === 't' || event.key === 'T') {
        event.preventDefault();
        closeThumbs();
        return true;
      }
      // 一覧が出ている間は頁送りを止める
      if (NAV_KEYS.has(event.key)) {
        event.preventDefault();
        return true;
      }
      return false;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      if (!els.readerPageInput.hidden) jumpClose();
      else if (side) closeSide();   // 板 → 読む画面 の順に一枚ずつ閉じる
      else close();
      return true;
    }

    if (isTyping()) return false;
    if (event.ctrlKey || event.metaKey || event.altKey) return false;
    if (event.key === 'i' || event.key === 'I') { event.preventDefault(); toggleSide('info'); return true; }
    if ((event.key === 'p' || event.key === 'P') && window.BunkoAiMeta?.canPrompt(state.reader.gallery)) { event.preventDefault(); toggleSide('prompt'); return true; }

    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        move(dir());
        return true;
      case 'ArrowLeft':
        event.preventDefault();
        move(dir() * -1);
        return true;
      case ' ':
      case 'PageDown':
        event.preventDefault();
        move(1);
        return true;
      case 'PageUp':
        event.preventDefault();
        move(-1);
        return true;
      case 'Home':
        event.preventDefault();
        setPage(0);
        return true;
      case 'End':
        event.preventDefault();
        setPage(pageCount() - 1);
        return true;
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault();
        const back = event.key === 'ArrowUp';
        if (scale > 1 && zoomable()) panBy(0, back ? 120 : -120);
        else if (state.readerFit === 'width') els.readerStage.scrollBy(0, back ? -120 : 120);
        else move(back ? -1 : 1);
        return true;
      }
      case 'f':
      case 'F':
        event.preventDefault();
        toggleFullscreen();
        return true;
      case 's':
      case 'S':
        event.preventDefault();
        els.readerSpread.click();
        return true;
      case 'd':
      case 'D':
        event.preventDefault();
        els.readerRtl.click();
        return true;
      case 't':
      case 'T':
        event.preventDefault();
        toggleThumbs();
        return true;
      case 'g':
      case 'G':
        event.preventDefault();
        jumpOpen();
        return true;
      default:
        return false;
    }
  }

  function onPointerDown(event) {
    if (event.button !== 0) return;
    panMoved = false;
    if (scale <= 1 || !zoomable()) return;
    panId = event.pointerId;
    panFromX = event.clientX;
    panFromY = event.clientY;
    panBaseX = panX;
    panBaseY = panY;
    els.readerPages.setPointerCapture(panId);
  }

  function onPointerMove(event) {
    if (panId !== event.pointerId) return;
    const dx = event.clientX - panFromX;
    const dy = event.clientY - panFromY;
    // 5px 未満はクリックのつもり: 頁送りに譲る
    if (!panMoved && Math.hypot(dx, dy) < PAN_THRESHOLD) return;
    panMoved = true;
    panX = panBaseX + dx;
    panY = panBaseY + dy;
    clampPan();
    applyTransform();
  }

  function onPointerUp(event) {
    if (panId !== event.pointerId) return;
    try {
      els.readerPages.releasePointerCapture(panId);
    } catch {
      /* already gone */
    }
    panId = -1;
    if (panMoved) swallowClick = true;
  }

  function onClick(event) {
    if (swallowClick) {
      swallowClick = false;
      return;
    }
    if (!state.reader) return;
    // 二打目は一打目の送りを取り消す側 (dblclick) の持ち物: ここでは送らない
    if (event.detail > 1) return;
    // 関連作品の札が出ている間は、頁の空白を押しても渡らない (渡るのは札を押して)
    if (state.reader.boundary && state.reader.boundary.related) return;
    turnedFrom = state.reader.page;
    turnedAt = Date.now();
    move(1);
  }

  function onDoubleClick(event) {
    if (!state.reader || !zoomable()) return;
    const zoomed = scale > 1;
    // 一打目が送ってしまった頁を戻してからズームへ
    if (turnedFrom >= 0 && Date.now() - turnedAt < 600) {
      const back = turnedFrom;
      turnedFrom = -1;
      setPage(back, false);
      // 一打目が予約した「進んだ頁」の保存が 500ms 後に落ちてくる。
      // 戻した頁で上書きしないと、次に開いたとき 1 組先から再開してしまう
      saveProgress();
    }
    if (zoomed) resetZoom();
    else zoomAt(actualPixelScale() || 2, event.clientX, event.clientY);
  }

  // 原寸 (絵の 1 画素 = 画面の 1 画素) になる倍率。頁は窓に合わせて縮めて出しているので、
  // 大きい絵ほど原寸には遠い (pixiv の原寸 3000 px を 1300 px の窓で見ると 43%)。
  // 絵が窓より小さければ 0 を返し、呼び手は今までどおり 2 倍にする。上限は MAX_SCALE
  function actualPixelScale() {
    const img = [els.readerImage, els.readerImage2]
      .find((node) => node && !node.hidden && Number(node.naturalHeight) > 0);
    if (!img || typeof img.getBoundingClientRect !== 'function') return 0;
    const rect = img.getBoundingClientRect();
    if (!rect || !rect.height) return 0;
    const dpr = (typeof window !== 'undefined' && Number(window.devicePixelRatio)) || 1;
    const ratio = Number(img.naturalHeight) / (rect.height * dpr);
    return ratio > 1.1 ? ratio : 0;
  }

  function bind() {
    els.reader.addEventListener('pointerdown', dismissHint);
    document.getElementById('reader-close').addEventListener('click', close);
    els.readerLoading.addEventListener('click', (event) => {
      if (event.target.closest('#reader-cancel')) close();
    });
    els.readerPrev.addEventListener('click', () => move(dir() * -1));
    els.readerNext.addEventListener('click', () => move(dir()));

    els.readerPages.addEventListener('click', onClick);
    els.readerPages.addEventListener('click', (event) => {
      const retry = event.target.closest('[data-reader-retry]');
      if (!retry || !state.reader) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const index = Number(retry.dataset.readerRetry);
      const img = Number(els.readerImage.dataset.page) === index ? els.readerImage : els.readerImage2;
      img.removeAttribute('src');
      prepareImage(img, state.reader.gallery, index);
    }, true);
    els.readerPages.addEventListener('dblclick', onDoubleClick);
    // 継ぎ目の関連作品。札そのものは入力を通す (pointer-events) ので、届くのは関連の札を押した時だけ
    if (els.readerBoundary) {
      els.readerBoundary.addEventListener('click', onBoundaryClick);
      els.readerBoundary.addEventListener('dblclick', (event) => pressWork(event, 'Double'));
      els.readerBoundary.addEventListener('contextmenu', (event) => pressWork(event, 'Right'));
    }
    els.readerPages.addEventListener('pointerdown', onPointerDown);
    els.readerPages.addEventListener('pointermove', onPointerMove);
    els.readerPages.addEventListener('pointerup', onPointerUp);
    els.readerPages.addEventListener('pointercancel', onPointerUp);

    els.readerRtl.addEventListener('click', () => {
      state.readerRtl = !state.readerRtl;
      state.settings.readerRtl = state.readerRtl;
      window.hitomi.saveSettings({ readerRtl: state.readerRtl });
      applyDir();
    });

    els.readerFit.addEventListener('click', () => {
      setFit(state.readerFit === 'width' ? 'contain' : 'width');
    });

    // ★: 撫でた所まで仮に灯し、離れたら戻す。押した時だけ書き込む
    els.readerStars.addEventListener('mouseover', (event) => {
      const btn = event.target.closest('[data-star]');
      if (btn) paintStars(Number(btn.dataset.star));
    });
    els.readerStars.addEventListener('mouseleave', () => paintStars(null));
    els.readerStars.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-star]');
      if (btn) rateStar(Number(btn.dataset.star));
    });

    els.readerSpread.addEventListener('click', () => {
      state.readerSpread = !state.readerSpread;
      state.settings.readerSpread = state.readerSpread;
      window.hitomi.saveSettings({ readerSpread: state.readerSpread });
      applySpread();
      if (state.reader) {
        resetZoom();
        render();
      }
    });

    els.readerOffset.addEventListener('click', () => {
      state.readerOffset = state.readerOffset === 1 ? 0 : 1;
      applySpread();
      if (state.reader) {
        resetZoom();
        render();
      }
    });

    els.readerThumbs.addEventListener('click', (event) => {
      const thumb = event.target.closest('.reader-thumb[data-page]');
      if (!thumb) {
        if (event.target === els.readerThumbs) closeThumbs();
        return;
      }
      setPage(Number(thumb.dataset.page));
      closeThumbs();
    });

    els.readerPage.addEventListener('click', jumpOpen);
    els.readerPage.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      jumpOpen();
    });
    els.readerPageInput.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        jumpCommit();
      } else if (event.key === 'Escape') {
        // ここで欄を畳んだ後に文書の keydown (handleKey) まで届くと、欄はもう閉じているので
        // 読む画面ごと閉じていた (ui-probe で見つけた)。欄で済ませたキーはここで止める
        event.preventDefault();
        event.stopPropagation();
        jumpClose();
      }
    });
    els.readerPageInput.addEventListener('blur', jumpClose);

    document.getElementById('reader-download').addEventListener('click', () => {
      if (state.reader) startDownload(state.reader.gallery.id);
    });
    const infoBtn = document.getElementById('reader-info');
    const promptBtn = document.getElementById('reader-prompt');
    if (infoBtn) {
      infoBtn.innerHTML = window.BunkoAiMeta?.ICON?.info || '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 11.5v5M12 7.51l.01-.011"/><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10Z"/></svg>';
      infoBtn.addEventListener('click', () => toggleSide('info'));
    }
    if (promptBtn) {
      promptBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 10h8M8 14h5"/><path d="M4 6.6v10.8a.6.6 0 0 0 .6.6h14.8a.6.6 0 0 0 .6-.6V6.6a.6.6 0 0 0-.6-.6H4.6a.6.6 0 0 0-.6.6ZM8 3v3M16 3v3"/></svg>';
      promptBtn.addEventListener('click', () => toggleSide('prompt'));
      window.BunkoAiMeta?.onMarks?.(() => paintPromptButton());
    }

    els.readerSeek.addEventListener('input', () => {
      if (!state.reader) return;
      setPage(groupAt(Number(els.readerSeek.value))[0]);
    });
  }

  // 開いている作品の値が外で動いたとき (紐付けの付け替えなど) に呼ぶ。
  // 開いていなければ何もしない。頁は触らないので送りは乱れない
  function repaintMeta() {
    if (!state.reader) return;
    paintStars(null);
  }

  return {
    open,
    close,
    isOpen,
    move,
    repaintMeta,
    bind,
    setNeighborProvider,
    setCreatorOpener,
    setWorkPress,
    back,
    trailLength,
    applyPrefs,
    handleKey,
    handleWheel,
    dismissHint,
    closeThumbs,
    openSide,
    closeSide,
    sideOpen,
  };
})();
