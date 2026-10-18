'use strict';
// ui-probe が押す釦の名簿と、場面ごとの順番。**名簿に無い物は押さない。**
//
// 載せない物 (押すと機体の外や利用者の持ち物が変わる / OS の窓が CDP を塞ぐ):
//   取り込み (保存・札のダブルクリック・#paw-bulk・#reader-download)・Eagle への書き込み (.rstar・ゴミ箱・結び/外し)・
//   pixiv のフォロー・Pawchive のお気に入り・Home の名前/結び/★/表紙/Ctrl+Z・発掘の札 (台帳に「見せた」を書く)・
//   同期・全件読み直し・LAN・ログイン・token・フォルダ/ブラウザ/Eagle を開く・[data-folder] (OS の窓)・クリップボード・
//   設定の「適用」「変更を保存」・表示の「元に戻す」(.display-reset は頁ごとの表紙の大きさを全部消す)・
//   素の h / n / p キー (サイトを替えて検索する)。
// 読む画面は閉じるたびに栞を書く (reading.json)。場面 reader は --with-reader の時だけ走らせる。
//
// 検索が走ると searchHistory / session / sortBySource が書かれる。ui-probe.js が頭で控え、終わりに戻す。
// purpose は Jev に渡す英語の役目の説明 (ソースの働きから書く)。

const ESC = { keys: ['Escape'] };
const PREF_CATEGORIES = ['reading', 'library', 'download', 'sources', 'devices', 'appearance'];
// 設定の窓の中で下書きだけを変える欄 (適用・保存を押さない限り config.json は変わらない)
const PREF_DRAFT_CHECKS = ['readerResume', 'showUnmatchedEagle', 'ownedSaveConfirm', 'pixivHideAi', 'pixivReadOriginal'];

// 作品の札だけ (作者の札は押すと作者の一覧へ行くので、詳細の試験に使わない)
const WORK_CARD = '#grid .card[data-id]:not(.is-creator):not(.pixiv-creator-card):not(.paw-fan)';

const visibleCount = (t, sel) => t.eval(`[...document.querySelectorAll(${JSON.stringify(sel)})].filter((e) => window.__probe.visible(e)).length`);

// 上のサイトの札 (.ui-sources) を本当に押す
async function clickSource(t, src, step) {
  return t.click(step || `source:${src}`, `.ui-sources [data-ui-value="${src}"]`, {
    purpose: `Click the "${src}" site button in the top bar. The grid is replaced by that site's list (or the Home view for "home"); there should be no blank gap and no layout jump.`,
    expect: { source: src },
    collect: { untilCards: true, untilImages: true, minMs: 700, maxMs: 12000 },
  });
}

// 棚を六目盛り送って Home キーで頭へ戻す (仮想の棚の描き足し・絵の読み込みの空白・続きの読み込み)
async function scrollShelf(t, step) {
  await t.act(`${step}:down`, async () => {
    for (let i = 0; i < 6; i++) {
      await t.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 640, y: 800, deltaX: 0, deltaY: 600 });
      await t.sleep(120);
    }
  }, { purpose: 'Scroll the grid down with the mouse wheel. Cards and covers should already be there, with no blank area or jump.', collect: { untilImages: true, minMs: 700, maxMs: 6000 } });
  await t.act(`${step}:top`, () => t.key('Home'), {
    purpose: 'The Home key scrolls the grid back to the top.', collect: { untilImages: true, minMs: 400, maxMs: 4000 },
  });
}

// 札の表紙に載せて拡大 (ルーペ) を出し、外して消す
async function loupe(t, step) {
  if ((await t.eval('window.hitomi.settings().then((s) => s.loupeEnabled)')) === false) { t.note(`${step}:loupe`, { skipped: 'ルーペは設定で切ってある' }); return; }
  const n = await visibleCount(t, '#grid .card .cover');
  if (!n) return;
  const at = await t.eval(`(() => { const c = [...document.querySelectorAll('#grid .card .cover')].find((e) => window.__probe.visible(e)); const r = c.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  await t.act(`${step}:loupe`, async () => {
    await t.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
  }, { purpose: 'Hovering a cover for a moment shows the enlarged preview (loupe) near the card.', collect: { minMs: 700, maxMs: 3000 } });
  await t.act(`${step}:loupe-off`, async () => {
    await t.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
  }, { purpose: 'Moving the mouse off the cover hides the enlarged preview.', collect: { minMs: 400, maxMs: 2000 } });
}

// 札を開く・別の札へ切り替える・詳細の中の読むだけの道具・Esc で閉じる
async function detailRound(t, prefix) {
  const cards = await visibleCount(t, WORK_CARD);
  if (cards < 2) { t.note(`${prefix}:cards`, { skipped: '作品の札が 2 枚無い', cards }); return; }
  await t.click(`${prefix}:card-open`, WORK_CARD, { index: 0, purpose: 'Left-click a card in the grid: the detail panel opens in a column beside the grid. By design the grid narrows to make room (the panel must not cover any book), so the cards re-flow once.', expect: { opens: 'detail', reflow: true }, collect: { minMs: 600, maxMs: 5000 } });
  await t.click(`${prefix}:card-switch`, WORK_CARD, { index: 1, purpose: 'Left-click another card while the detail panel is open: the panel switches to that work in place.', expect: { opens: 'detail' }, collect: { minMs: 600, maxMs: 5000 } });
  t.note(`${prefix}:detail-controls`, await t.eval(`(() => { const cs = window.__probe.controls('#detail'); return { total: cs.length, covered: cs.filter((c) => c.covered).map((c) => c.sel + ' <- ' + c.coveredBy).slice(0, 5) }; })()`));
  if (await visibleCount(t, '#detail .quiet-act[data-link]')) {
    await t.click(`${prefix}:link-picker`, '#detail .quiet-act[data-link]', { purpose: 'Open the inline picker that lists library items to link to this work (read-only list).', undo: ESC, collect: { minMs: 500, maxMs: 4000 } });
  }
  await t.click(`${prefix}:detail-close`, '#detail-close', { purpose: 'The close button closes the detail column; by design the grid widens back and the cards re-flow once.', expect: { closes: 'detail', reflow: true } });
  await t.click(`${prefix}:card-reopen`, WORK_CARD, { index: 0, purpose: 'Left-click a card in the grid: the detail panel opens in a column beside the grid. By design the grid narrows to make room (the panel must not cover any book), so the cards re-flow once.', expect: { opens: 'detail', reflow: true }, collect: { minMs: 600, maxMs: 5000 } });
  await t.act(`${prefix}:detail-esc`, () => t.key('Escape'), { purpose: 'The Escape key closes the detail column; by design the grid widens back and the cards re-flow once.', expect: { closes: 'detail', reflow: true } });
}

const scenes = [
  {
    name: 'settings',
    about: '環境設定の窓 (区分の切り替え・下書きの欄・検索・キャンセル・×・Esc)',
    async run(t) {
      await t.click('settings-open', '#btn-settings', { purpose: 'Open the preferences dialog.', expect: { opens: 'settings' } });
      for (const cat of PREF_CATEGORIES) {
        await t.click(`pref-category:${cat}`, `#settings [data-category="${cat}"]`, { purpose: `Show the "${cat}" category of the preferences dialog in the right pane.` });
        for (const k of PREF_DRAFT_CHECKS) {
          const sel = `#settings input[type=checkbox][data-key="${k}"]`;
          if (!(await visibleCount(t, sel))) continue;
          await t.click(`pref-draft:${k}`, sel, {
            purpose: 'Toggle a checkbox in the preferences draft. It flips immediately and enables the Apply button; nothing is saved until Apply/Save.',
            undo: { click: sel },
          });
        }
      }
      await t.act('pref-search', () => t.eval(`(() => { const s = document.querySelector('#settings input[type=search]'); s.focus(); s.value = '保存'; s.dispatchEvent(new Event('input', { bubbles: true })); })()`),
        { purpose: 'Typing in the preferences search box filters the rows to matching settings.' });
      await t.act('pref-search-clear', () => t.eval(`(() => { const s = document.querySelector('#settings input[type=search]'); s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); })()`),
        { purpose: 'Clearing the preferences search box shows the current category again.' });
      await t.click('pref-cancel', '#settings .pref-button[data-close]', { purpose: 'Cancel: close the preferences dialog and discard the draft.', expect: { closes: 'settings' } });
      await t.click('settings-reopen', '#btn-settings', { purpose: 'Open the preferences dialog again.', expect: { opens: 'settings' } });
      await t.click('pref-close-x', '#settings .ib[data-close]', { purpose: 'The X button in the header closes the preferences dialog.', expect: { closes: 'settings' } });
      await t.click('settings-open-for-esc', '#btn-settings', { purpose: 'Open the preferences dialog.', expect: { opens: 'settings' } });
      await t.act('settings-esc', () => t.key('Escape'), { purpose: 'The Escape key closes the preferences dialog.', expect: { closes: 'settings' } });
    },
  },
  {
    name: 'chrome',
    about: 'ヘルプ (? と Esc と ×)・検索欄へ飛ぶ /',
    async run(t) {
      await t.act('help-key', () => t.key('?'), { purpose: 'The ? key opens the keyboard help overlay.', expect: { opens: 'help' } });
      await t.click('help-close', '#help-close', { purpose: 'Close the help overlay.', expect: { closes: 'help' } });
      await t.act('help-key-again', () => t.key('?'), { purpose: 'The ? key opens the keyboard help overlay.', expect: { opens: 'help' } });
      await t.act('help-esc', () => t.key('Escape'), { purpose: 'The Escape key closes the help overlay.', expect: { closes: 'help' } });
      await t.act('slash-focus', () => t.key('/'), { purpose: 'The / key moves keyboard focus to the search box without typing a slash.', undo: ESC });
    },
  },
  {
    name: 'filters',
    about: '並びの窓・向き・表示の窓 (並べ方・字幕・収め・ルーペ)・所持を隠す',
    async run(t) {
      await t.click('sort-menu', '.ui-sort-trigger', { purpose: 'Open the sort popover menu under the sort button.', undo: ESC });
      // 向き: 窓を開けて逆を押し、また開けて元へ
      await t.click('sort-menu-open', '.ui-sort-trigger', { purpose: 'Open the sort popover menu.' });
      const dir = await t.eval(`(() => { const on = document.querySelector('.ui-sort-menu [data-ui-value="asc"].is-on, .ui-sort-menu [data-ui-value="asc"][aria-pressed="true"]'); return on ? 'asc' : 'desc'; })()`);
      const other = dir === 'asc' ? 'desc' : 'asc';
      if (await visibleCount(t, `.ui-sort-menu [data-ui-value="${other}"]`)) {
        await t.click(`sort-dir:${other}`, `.ui-sort-menu [data-ui-value="${other}"]`, { purpose: `Switch the sort direction to ${other === 'asc' ? 'ascending' : 'descending'}; the grid re-orders.`, collect: { untilCards: true, untilImages: true, minMs: 600, maxMs: 8000 } });
        if (!(await visibleCount(t, `.ui-sort-menu [data-ui-value="${dir}"]`))) await t.click('sort-menu-reopen', '.ui-sort-trigger', { purpose: 'Open the sort popover menu.' });
        await t.click(`sort-dir:${dir}`, `.ui-sort-menu [data-ui-value="${dir}"]`, { purpose: 'Switch the sort direction back; the grid re-orders.', collect: { untilCards: true, untilImages: true, minMs: 600, maxMs: 8000 } });
      }
      await t.key('Escape'); await t.sleep(300);

      await t.click('display-menu', '#zoom-cycle', { purpose: 'Left-click the display button: a small display-settings popover opens (layout, captions, fit, loupe, cover size).' });
      for (const layout of ['grid', 'flow']) {
        const sel = `.ui-display-menu [data-layout="${layout}"]`;
        if (await visibleCount(t, sel)) await t.click(`display-layout:${layout}`, sel, { purpose: `Switch the grid layout to "${layout}" (${layout === 'grid' ? 'uniform grid' : 'flowing masonry'}); cards re-flow in place.`, collect: { untilImages: true, minMs: 600, maxMs: 5000 } });
      }
      for (const key of ['uiCaptions', 'uiFit', 'loupeEnabled']) {
        const sel = `.ui-display-menu input[data-setting="${key}"]`;
        if (!(await visibleCount(t, sel))) continue;
        await t.click(`display-toggle:${key}`, sel, { purpose: `Toggle the "${key}" display option; the grid updates immediately.`, undo: { click: sel, wait: 600 }, collect: { minMs: 500, maxMs: 4000 } });
      }
      await t.act('display-menu-esc', () => t.key('Escape'), { purpose: 'The Escape key closes the display-settings popover.' });
      // 表示の釦の右クリック (一段送り) は 2026-09-27 に外した: 大きさは Ctrl+ホイールと小窓の「表紙の大きさ」だけ

      if (await visibleCount(t, '#hide-owned')) {
        await t.click('hide-owned:1', '#hide-owned', { purpose: 'Cycle the "hide owned works" mode (3 modes: hide duplicates / hide owned / show all); owned cards dim or disappear.', collect: { untilImages: true, minMs: 500, maxMs: 4000 } });
        await t.click('hide-owned:2', '#hide-owned', { purpose: 'Cycle the "hide owned works" mode to the next of 3 modes.', collect: { untilImages: true, minMs: 500, maxMs: 4000 } });
        await t.click('hide-owned:3', '#hide-owned', { purpose: 'Cycle the "hide owned works" mode back to where it started.', collect: { untilImages: true, minMs: 500, maxMs: 4000 } });
      }
    },
  },
  {
    name: 'sources',
    about: 'サイトの札を押す・札を開く/切り替える/閉じる・ルーペ・棚の送り・所持の切り替え・見方の札',
    async run(t) {
      const first = (await t.snap()).source;
      const mouse = await t.eval('window.hitomi.settings().then((s) => s.mouseLeft || "detail")');
      const order = ['hitomi', 'nhentai', 'pixiv', 'pawchive'].filter((s) => s !== first);
      if (first !== 'home') order.push(first);
      for (const src of order) {
        await clickSource(t, src);
        await t.settle(8000);
        if (mouse === 'detail') await detailRound(t, src); else t.note(`${src}:cards`, { skipped: 'mouseLeft が detail でない' });
        await loupe(t, src);
        await scrollShelf(t, `${src}:scroll`);
        // 見方の札 (pawchive: favorites/creators/posts, pixiv: follow/bookmarks/…)。一つ隣へ行って戻る
        const views = await t.eval(`[...document.querySelectorAll('.ui-views [data-ui-value]')].filter((e) => window.__probe.visible(e)).map((e) => ({ v: e.dataset.uiValue, on: e.classList.contains('is-on') || e.getAttribute('aria-pressed') === 'true' || e.getAttribute('aria-selected') === 'true' }))`);
        const cur = (views.find((x) => x.on) || views[0] || {}).v;
        const next = views.map((x) => x.v).find((v) => v !== cur && v !== 'recommended');
        if (cur && next) {
          await t.click(`${src}:view:${next}`, `.ui-views [data-ui-value="${next}"]`, { purpose: `Switch this site's view tab to "${next}"; the grid is replaced by that list.`, collect: { untilCards: true, untilImages: true, minMs: 700, maxMs: 10000 } });
          await t.click(`${src}:view:${cur}`, `.ui-views [data-ui-value="${cur}"]`, { purpose: `Switch this site's view tab back to "${cur}"; the previous list returns.`, collect: { untilCards: true, untilImages: true, minMs: 700, maxMs: 10000 } });
        }
        // 種類の札 (hitomi / nhentai): 一つ選んで「すべて」へ戻る
        const chips = await t.eval(`[...document.querySelectorAll('#types .chip[data-type]')].filter((e) => window.__probe.visible(e)).map((e) => e.dataset.type)`);
        if (chips.includes('doujinshi') && chips.includes('')) {
          await t.click(`${src}:type:doujinshi`, '#types .chip[data-type="doujinshi"]', { purpose: 'Click a work-type chip to filter the grid to that type.', collect: { untilCards: true, untilImages: true, minMs: 700, maxMs: 10000 } });
          await t.click(`${src}:type:all`, '#types .chip[data-type=""]', { purpose: 'Click the "all" chip to remove the type filter.', collect: { untilCards: true, untilImages: true, minMs: 700, maxMs: 10000 } });
        }
        await t.click(`${src}:scope`, '#scope', {
          purpose: 'Toggle "search only owned works" (library scope). The grid switches between owned works and the whole site.',
          collect: { untilCards: true, untilImages: true, minMs: 700, maxMs: 10000 },
          undo: { click: '#scope', wait: 2500 },
        });
        await t.settle(8000);
      }
    },
  },
  {
    name: 'home',
    about: 'Home (作者の一覧・人の札の詳細・作者頁・年月の束ね・所持だけ)',
    async run(t) {
      const first = (await t.snap()).source;
      await clickSource(t, 'home');
      await t.settle(8000);
      const mouse = await t.eval('window.hitomi.settings().then((s) => s.mouseLeft || "detail")');
      if (mouse === 'detail' && (await visibleCount(t, '#grid .card[data-id]')) >= 2) {
        await t.click('home:person-open', '#grid .card[data-id]', { index: 0, purpose: 'Left-click a person card on Home: the detail column opens beside the list with that author\'s summary; by design the list narrows and re-flows once.', expect: { opens: 'detail', reflow: true }, collect: { minMs: 600, maxMs: 5000 } });
        await t.click('home:person-switch', '#grid .card[data-id]', { index: 1, purpose: 'Left-click another person card: the detail panel switches in place.', expect: { opens: 'detail' }, collect: { minMs: 600, maxMs: 5000 } });
        await t.act('home:detail-esc', () => t.key('Escape'), { purpose: 'The Escape key closes the detail column; by design the grid widens back and the cards re-flow once.', expect: { closes: 'detail', reflow: true } });
      }
      await loupe(t, 'home');
      await scrollShelf(t, 'home:scroll');
      if (await visibleCount(t, '.home-strip .home-strip-item[data-home-person]')) {
        await t.click('home:strip-author', '.home-strip .home-strip-item[data-home-person]', { purpose: 'Click an author in the Home strip: the author page opens in place of the list.', collect: { untilCards: true, untilImages: true, minMs: 800, maxMs: 12000 } });
        for (const g of ['month', 'year']) {
          const sel = `[data-home-group="${g}"]`;
          if (await visibleCount(t, sel)) await t.click(`home:group:${g}`, sel, { purpose: `Group the author page's works by ${g}.`, collect: { untilImages: true, minMs: 500, maxMs: 5000 } });
        }
        await scrollShelf(t, 'home:author-scroll');
        const back = '#types .chip[data-type=""]';
        if (await visibleCount(t, back)) await t.click('home:back-to-list', back, { purpose: 'Click the "Home" chip to return from the author page to the author list.', collect: { untilCards: true, untilImages: true, minMs: 700, maxMs: 8000 } });
      }
      await t.click('home:owned-only', '#scope', { purpose: 'On Home, toggle "owned only": the list narrows to authors with owned works.', collect: { untilCards: true, untilImages: true, minMs: 600, maxMs: 8000 }, undo: { click: '#scope', wait: 2000 } });
      if (first && first !== 'home') { await clickSource(t, first, `source:${first}:back`); await t.settle(8000); }
    },
  },
];

// 読む画面。閉じるたびに栞 (reading.json) を書くので、利用者の許しがある時だけ (--with-reader)。
// 対象は Home の先頭の人 (最近読んだ順なら一番最近読んだ人) の本のうち、既読でない栞が一番新しい 1 冊。
// 既読の本は選ばない: 読む画面は閉じる時に「今の頁が最後か」で既読を書き直すので、既読の本を途中で閉じると
// 既読が外れ、戻し書きで「未読 → 既読」に転じて読了回数が 1 増えてしまう (reading-store の set)。
// 閉じた後に栞の口で頁・頁数・既読・作者を戻す。戻らないのは updatedAt だけ。末尾へは行かない (End も押さない)。
scenes.push({
  name: 'reader',
  optIn: true,
  about: '読む画面 (頁送り・キー・収め・右綴じ・見開き・ずらし・一覧・頁へ飛ぶ・ホイール・閉じる)。栞は閉じた後に戻す',
  async run(t) {
    const first = (await t.snap()).source;
    await clickSource(t, 'home', 'reader:home');
    await t.settle(8000);
    const sort = await t.eval(`({ cur: state.sort, has: [...document.querySelectorAll('#sort option')].some((o) => o.value === 'read') })`);
    if (sort.has && sort.cur !== 'read') {
      await t.act('reader:home-sort-read', () => t.eval(`(() => { const s = document.getElementById('sort'); s.value = 'read'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`),
        { purpose: 'Sort the Home author list by most recently read.', collect: { untilCards: true, untilImages: true, minMs: 600, maxMs: 8000 } });
    }
    t.note('reader:home-sort', { hasRead: sort.has, was: sort.cur === 'read' ? 'read' : 'other' });
    await t.click('reader:person-open', '#grid .card[data-id]', { index: 0, purpose: 'Left-click the first person card on Home: the detail column opens beside the list; by design the list narrows and re-flows once.', expect: { opens: 'detail', reflow: true }, collect: { minMs: 600, maxMs: 5000 } });
    if (!(await visibleCount(t, '#detail [data-home-open]'))) { t.note('reader:skip', { why: 'no author page button' }); return; }
    await t.click('reader:author-page', '#detail [data-home-open]', { purpose: 'Click the "see works" button in the person detail: the author page with their books replaces the list.', collect: { untilImages: true, minMs: 800, maxMs: 10000 } });

    // 栞を読むだけ (書かない) で対象を選ぶ。id は数と印だけを記す
    const pick = await t.eval(`(async () => {
      const ids = [...new Set([...document.querySelectorAll('#home-author-view .card[data-id]')].map((c) => c.dataset.id))].filter((id) => !id.startsWith('px:'));
      let best = null; let newest = null; let marked = 0;
      for (const id of ids.slice(0, 300)) {
        const e = await window.hitomi.readingGet(id);
        if (!e) continue;
        marked++;
        const at = Number(e.updatedAt) || Date.parse(e.updatedAt) || 0;
        if (!newest || at > newest.at) newest = { id, at };
        if (!e.finished && (!best || at > best.at)) best = { id, at, entry: e };
      }
      return { books: ids.length, marked, best, newestIsBest: !!(best && newest && best.id === newest.id) };
    })()`);
    t.note('reader:pick', { books: pick.books, withBookmark: pick.marked, chosen: !!pick.best, newestIsChosen: pick.newestIsBest, page: pick.best && pick.best.entry.page, pageCount: pick.best && pick.best.entry.pageCount });
    if (!pick.best) return;
    const id = pick.best.id;
    const saved = pick.best.entry;
    const card = `#home-author-view .card[data-id=${JSON.stringify(id)}]`;
    await t.eval(`document.querySelector(${JSON.stringify(card)}).scrollIntoView({ block: 'center' })`);
    await t.sleep(700);
    await t.click('reader:book-open', card, { purpose: 'Left-click a book card on the author page: the detail column opens beside the page; by design the page narrows and re-flows once.', expect: { opens: 'detail', reflow: true }, collect: { minMs: 700, maxMs: 5000 } });
    if (!(await visibleCount(t, '#detail [data-read]'))) { t.note('reader:skip', { why: 'no read button' }); return; }

    const restore = async () => {
      await t.sleep(900); // 閉じた時の栞の書き込み (flushProgress) を待つ
      const out = await t.eval(`(async () => {
        const before = ${JSON.stringify(saved)};
        await window.hitomi.readingSet(${JSON.stringify(id)}, before);
        const now = await window.hitomi.readingGet(${JSON.stringify(id)});
        const keys = [...new Set([...Object.keys(before), ...Object.keys(now || {})])];
        return { differ: keys.filter((k) => JSON.stringify(before[k]) !== JSON.stringify((now || {})[k])) };
      })()`);
      t.note('reader:bookmark-restored', out);
    };

    await t.click('reader:open', '#detail [data-read]', { purpose: 'Click the read button in the detail panel: the full-screen reader opens and shows a page (resuming the last read page).', expect: { opens: 'reader' }, collect: { minMs: 1500, maxMs: 8000 } });
    await t.sleep(1500); // 前回の続きへ戻るのを待つ (待たずに閉じると頁 0 で栞を上書きする)
    const info = await t.eval(`(() => ({ open: !!state.reader, same: !!state.reader && String(state.reader.gallery.id) === ${JSON.stringify(id)}, page: state.reader ? state.reader.page : null, count: state.reader ? Number(state.reader.gallery.pageCount) || 0 : 0, rtl: (document.getElementById('reader-rtl') || { getAttribute: () => null }).getAttribute('aria-pressed') }))()`);
    t.note('reader:session', { open: info.open, same: info.same, page: info.page, count: info.count, resumed: info.page === saved.page });
    // 頁送りは最大 2 頁先まで。5 頁あれば末尾 (読了) に届かない
    if (!info.open || !info.same || info.count < 5) {
      if (info.open) await t.click('reader:close', '#reader-close', { purpose: 'Close the reader.', expect: { closes: 'reader' } });
      if (info.open) await restore();
      return;
    }
    // 頁を動かす試験は本の中ほどでだけ。**端 (0 頁目・最終頁) から外へ送ると隣の作品へ渡る**:
    // 前へ渡ると前の作品の最終頁から入り、そこを去る時に「読み終えた」と栞に書く (2026-09-27 に試験が
    // 別の本へ既読の栞を一冊作ってしまった)。右綴じは画面の状態 (state.readerRtl) から読む。釦の印ではない
    const turn = { minMs: 500, maxMs: 6000 };
    const where = () => t.eval(`(() => ({ same: !!state.reader && String(state.reader.gallery.id) === ${JSON.stringify(id)}, page: state.reader ? state.reader.page : -1, count: state.reader ? Number(state.reader.gallery.pageCount) || 0 : 0, rtl: state.readerRtl === true }))()`);
    // 前後どちらへ 1 頁動いても本の中に留まる所か (見開きでも 2 頁ぶんの余裕を見る)
    const safe = async () => { const w = await where(); return w.same && w.page >= 2 && w.page <= w.count - 3 ? w : null; };
    let aborted = '';
    const step = async (name, run) => {
      if (aborted) return;
      const w = await where();
      if (!w.same) { aborted = `${name}: reader left the chosen book`; return; }
      await run(w);
    };
    // まず中ほどへ: 釦で先へ 2 頁 (0 頁目から始まるので 2 頁目。5 頁以上あれば最終頁には届かない)
    for (let i = 1; i <= 2; i++) {
      await step(`next:${i}`, async (w) => {
        if (w.page + 1 > w.count - 2) { aborted = `next:${i}: too close to the last page`; return; }
        await t.click(`reader:next:${i}`, '#reader-next', { purpose: 'Click the next-page arrow: the reader shows the next page immediately, ideally already preloaded, without a blank or a loading indicator.', collect: turn });
      });
    }
    // 中ほどに居る間だけ、キーとホイールを往復で (どちら向きから押しても端を越えない)
    const mid = aborted ? null : await safe();
    if (mid) {
      const nextKey = mid.rtl ? 'ArrowLeft' : 'ArrowRight';
      const prevKey = mid.rtl ? 'ArrowRight' : 'ArrowLeft';
      for (const [k, what] of [[nextKey, 'forward one page (right-to-left books go forward with the left arrow)'], [prevKey, 'back one page']]) {
        await step(`key:${k}`, async () => {
          if (!(await safe())) { aborted = `key:${k}: not in the middle of the book`; return; }
          await t.act(`reader:key:${k}`, () => t.key(k), { purpose: `The ${k} key turns ${what}.`, collect: turn });
        });
      }
      for (const [n, dy] of [[1, 120], [2, -120]]) {
        await step(`wheel-${n}`, async () => {
          if (!(await safe())) { aborted = `wheel-${n}: not in the middle of the book`; return; }
          await t.act(`reader:wheel-${n}`, async () => {
            await t.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 640, y: 700, deltaX: 0, deltaY: dy });
          }, { purpose: 'One mouse-wheel notch over the page turns one page.', collect: turn });
        });
      }
    } else if (!aborted) {
      t.note('reader:keys-skipped', { why: 'the book is too short to stay in the middle' });
    }
    // 釦で 1 頁ずつ戻る。0 頁目より前へは押さない (前の作品へ渡る)
    for (let i = 1; i <= 2; i++) {
      await step(`prev:${i}`, async (w) => {
        if (w.page < 1) { aborted = `prev:${i}: already on the first page`; return; }
        await t.click(`reader:prev:${i}`, '#reader-prev', { purpose: 'Click the previous-page arrow: the reader goes back one page immediately.', collect: turn });
      });
    }
    if (aborted) t.note('reader:moves-stopped', { why: aborted });
    for (const [sel, what] of [['#reader-fit', 'fit mode (whole page / fill width)'], ['#reader-rtl', 'binding direction (right-to-left / left-to-right)']]) {
      await t.click(`reader:${sel.slice(8)}`, sel, { purpose: `Toggle the reader ${what}; the page re-lays out in place.`, collect: { minMs: 500, maxMs: 4000 } });
      await t.click(`reader:${sel.slice(8)}:back`, sel, { purpose: `Toggle the reader ${what} back.`, collect: { minMs: 500, maxMs: 4000 } });
    }
    await t.click('reader:spread', '#reader-spread', { purpose: 'Toggle two-page spread view: two pages side by side appear.', collect: { minMs: 600, maxMs: 5000 } });
    if (await visibleCount(t, '#reader-offset')) {
      await t.click('reader:offset', '#reader-offset', { purpose: 'In spread view, shift the page pairing by one page.', collect: { minMs: 500, maxMs: 4000 } });
      await t.click('reader:offset:back', '#reader-offset', { purpose: 'Shift the page pairing back.', collect: { minMs: 500, maxMs: 4000 } });
    }
    await t.click('reader:spread:back', '#reader-spread', { purpose: 'Toggle spread view off: back to one page.', collect: { minMs: 600, maxMs: 5000 } });
    await t.act('reader:thumbs', () => t.key('t'), { purpose: 'The t key opens the page thumbnail grid over the reader.', collect: { untilImages: false, minMs: 700, maxMs: 5000 } });
    await t.act('reader:thumbs-close', () => t.key('t'), { purpose: 'The t key closes the page thumbnail grid.', collect: { minMs: 500, maxMs: 3000 } });
    if (await visibleCount(t, '#reader-page')) {
      await t.click('reader:jump', '#reader-page', { purpose: 'Click the page number: an input for jumping to a page appears.', collect: { minMs: 400, maxMs: 3000 } });
      await t.act('reader:jump-esc', () => t.key('Escape'), { purpose: 'Escape closes the page-jump input without closing the reader.', collect: { minMs: 400, maxMs: 3000 } });
    }
    const still = await t.eval('!!state.reader && String(state.reader.gallery.id) === ' + JSON.stringify(id));
    if (still) await t.click('reader:close', '#reader-close', { purpose: 'The close button closes the reader and returns to the detail panel.', expect: { closes: 'reader' }, collect: { minMs: 600, maxMs: 4000 } });
    else t.note('reader:closed-early', { why: 'reader was no longer on the chosen book' });
    await restore();
    await t.key('Escape'); await t.sleep(400);
    const homeChip = '#types .chip[data-type=""]';
    if (await visibleCount(t, homeChip)) await t.click('reader:back-to-list', homeChip, { purpose: 'Return from the author page to the Home list.', collect: { untilCards: true, minMs: 600, maxMs: 6000 } });
    if (first && first !== 'home') { await clickSource(t, first, `reader:source:${first}:back`); await t.settle(8000); }
  },
});

module.exports = { scenes, PREF_CATEGORIES, clickSource, scrollShelf };
