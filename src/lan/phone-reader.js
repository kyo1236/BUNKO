'use strict';
const Reader = (() => {
  let frame, ready, mode = '', epoch = 0, neighbors = () => null;
  let previousFocus, overflow;
  const items = new Map();
  const books = new Map();
  const keyOf = item => item.source === 'pixiv' && item.owned && item.eagleId ? `pweagle:${item.eagleId}` : String(item.id);
  const lanIdOf = item => item.owned && item.eagleId ? `pw_${item.eagleId}` : /^\d+$/.test(String(item.id)) && item.owned ? String(item.id) : /^pweagle:/.test(String(item.id)) ? `pw_${String(item.id).slice(8)}` : null;
  function remember(item) { if (item) items.set(String(item.id), item); return item; }
  function ensureFrame() {
    if (ready) return ready;
    frame = document.createElement('iframe');
    frame.title = '作品詳細・読書';
    frame.className = 'phone-reader-frame';
    frame.hidden = true;
    ready = new Promise((resolve, reject) => {
      frame.onload = () => frame.contentWindow.BUNKO?.reader ? resolve(frame.contentWindow.BUNKO) : reject(new Error('読書画面を読み込めませんでした'));
      frame.onerror = () => reject(new Error('読書画面を読み込めませんでした'));
    });
    frame.src = '/phone-reader';
    document.body.appendChild(frame);
    return ready;
  }
  function show(next) {
    if (!mode) { previousFocus = document.activeElement; overflow = document.documentElement.style.overflow; }
    mode = next;
    document.documentElement.style.overflow = 'hidden';
    frame.hidden = false;
    frame.focus();
  }
  function hide() {
    epoch++;
    if (!mode) return;
    mode = '';
    frame.hidden = true;
    document.documentElement.style.overflow = overflow || '';
    previousFocus?.focus?.({ preventScroll: true });
  }
  async function book(id) {
    const item = remember(await window.hitomi.gallery(id));
    if (!item || item.error) throw new Error(item?.error || '作品を取得できませんでした');
    const lanId = lanIdOf(item);
    let data;
    if (lanId) {
      const response = await fetch(`/api/book/${encodeURIComponent(lanId)}`);
      if (!response.ok) throw new Error('所持作品のページを取得できませんでした');
      data = await response.json();
    } else {
      data = { pageCount: item.pageCount, ratios: [] };
    }
    if (!data.pageCount) throw new Error('読めるページがありません');
    const result = { ...data, id: String(id), title: item.title, reading: await window.hitomi.readingGet(keyOf(item)), lanId };
    books.set(String(id), result);
    return result;
  }
  const host = {
    extraMarkup(item) { return detailExtras(item); },
    relatedMarkup(item) { return detailRelatedMarkup(item); },
    loadRelated(item, container) { return loadDetailRelated(item,container); },
    openCaptionUrl(url) { return window.hitomi.openCaptionUrl(url); },
    readRelated(id) { return readRelatedWork(id); },
    relatedDetail(id) { hide(); return openDetail(id,{keepTrail:true}); },
    api(path) { const match = /^\/api\/book\/([^/]+)$/.exec(path); return match ? book(decodeURIComponent(match[1])) : Promise.reject(new Error('未対応の操作です')); },
    coverUrl(id) {
      const item = items.get(String(id));
      return item?.eagleId ? `/media/pweagle/${encodeURIComponent(item.eagleId)}` : `/media/img?id=${encodeURIComponent(id)}&i=0&size=thumb`;
    },
    pageUrl(id, index, width, version) {
      const data = books.get(String(id));
      return data?.lanId ? `/api/book/${encodeURIComponent(data.lanId)}/page/${index}?w=${width}&v=${version || 0}` : `/media/img?id=${encodeURIComponent(id)}&i=${index}&size=full`;
    },
    saveReading(id, mark) { return window.hitomi.readingSet(keyOf(items.get(String(id)) || { id }), mark); },
    neighbor(id, side) { return remember(neighbors(id, side)); },
    tagQuery(tag, owner) { return tagQuery(tag, owner); },
    filter(query, owner) {
      hide();
      // A detail tag opens work search, even when the work came from recommendations/bookmarks.
      if (owner?.source === 'pixiv' && state.source === 'pixiv' && !libraryScope()) {
        state.sort = 'added';
        fillSelect(els.sort, activeSorts(), state.sort);
      }
      applyQuery(query);
      window.BunkoUI?.sync();
    },
    save(item) { hide(); startDownload(item.id); },
    say(message) { toast(message); },
    closed: hide,
    reading() { mode = 'reader'; },
  };
  async function detail(item) {
    const token = ++epoch;
    remember(item);
    try {
      const [legacy, mark] = await Promise.all([ensureFrame(), window.hitomi.readingGet(keyOf(item))]);
      if (token !== epoch) return;
      show('detail');
      legacy.shelf.openDetail(item, mark);
    } catch (error) { if (token === epoch) { hide(); toast(error.message); } }
  }
  async function open(item, page) {
    const token = ++epoch;
    remember(item);
    try {
      const legacy = await ensureFrame();
      if (token !== epoch) return;
      if (mode === 'detail') legacy.shelf.closeDetail(true);
      show('reader');
      legacy.reader.open(item, { start: page === 0 ? 'first' : 'resume' });
    } catch (error) { if (token === epoch) { hide(); toast(error.message); } }
  }
  function close() {
    epoch++;
    if (mode === 'reader') frame.contentWindow.BUNKO.reader.close();
    else if (mode === 'detail') frame.contentWindow.BUNKO.shelf.closeDetail();
  }
  window.BunkoPhone = { detail, host, close: hide };
  // 机上版の Reader が持つ口は全部ここにも置く (app.js は bindReader で無条件に呼ぶ。一つでも欠けると
  // 起動で TypeError になり手のひら版の画面が空になる — 2026-09-27 の setCreatorOpener で起きた)。
  // 手のひらの読み手は継ぎ目の作者名・作品の札・足跡を持たないので、口だけ受けて何もしない。
  // 机上版の口を増やしたら test/cross-source.test.js が捕まえる
  return { open, close, isOpen: () => mode === 'reader', setNeighborProvider(fn) { neighbors = fn; },
    bind() {}, applyPrefs() {}, move() {}, repaintMeta() {}, handleKey: () => false, handleWheel: () => false, dismissHint() {}, closeThumbs() {},
    setCreatorOpener() {}, setWorkPress() {}, trailLength: () => 0, back: () => false };
})();
