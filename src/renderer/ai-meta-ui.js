'use strict';
// pixiv の AI 作品の「プロンプト」と「情報」の板 (読む画面の右) と、札の「プロンプトあり」の印 (issue #3)。
// 読む画面 (reader.js) からは render / mount だけ呼ばれる。中身・コピー・重みの色・タグ表示はここで持つ。
// app.js からは 札の印 (markOf / scan / resetMarks) と 詳細の釦の状態だけ。
//
// 生成情報は主プロセスの 'ai-meta' (aitag.win が主、無ければ原寸の絵から自前で) から貰う。
// 同じ頁は画面の側でも控える (頁を行き来しても待たせない)。
// 送るのは投稿の番号と頁だけ。所持の本の題やタグは送らない。
//
// 試験は test/helpers/vm-dom.js で読む: 末尾の __BUNKO_HARNESS__ の守りで、読んだだけでは何もしない。

window.BunkoAiMeta = (() => {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const svg = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const ICON = {
    copy: svg('<path d="M19.4 20H9.6a.6.6 0 0 1-.6-.6V9.6a.6.6 0 0 1 .6-.6h9.8a.6.6 0 0 1 .6.6v9.8a.6.6 0 0 1-.6.6Z"/><path d="M15 9V4.6a.6.6 0 0 0-.6-.6H4.6a.6.6 0 0 0-.6.6v9.8a.6.6 0 0 0 .6.6H9"/>'),
    prev: svg('<path d="M15 6l-6 6 6 6"/>'),
    next: svg('<path d="M9 6l6 6-6 6"/>'),
    close: svg('<path d="M6.76 6.76 17.24 17.24M6.76 17.24 17.24 6.76"/>'),
    retry: svg('<path d="M21.17 8A10 10 0 0 0 3.2 7.3M2.83 16a10 10 0 0 0 17.97.7"/><path d="M22 3v5h-5M2 21v-5h5"/>'),
    image: svg('<path d="M21 3.6v16.8a.6.6 0 0 1-.6.6H3.6a.6.6 0 0 1-.6-.6V3.6a.6.6 0 0 1 .6-.6h16.8a.6.6 0 0 1 .6.6Z"/><path d="m3 16 7-3 11 5M16 10a2 2 0 1 1 0-4 2 2 0 0 1 0 4Z"/>'),
    info: svg('<path d="M12 11.5v5M12 7.51l.01-.011"/><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10Z"/>'),
    prompt: svg('<path d="M8 10h8M8 14h5"/><path d="M4 6.6v10.8a.6.6 0 0 0 .6.6h14.8a.6.6 0 0 0 .6-.6V6.6a.6.6 0 0 0-.6-.6H4.6a.6.6 0 0 0-.6.6ZM8 3v3M16 3v3"/>'),
    reload: svg('<path d="M3 12a9 9 0 1 0 2.64-6.36"/><path d="M3 3v5h5"/>'),
  };
  const VIEW_KEY = 'bunko-ai-meta-view';
  const UNKNOWN_TTL = 2 * 60 * 1000;

  // ---- 重みの記法を色分けする (NovelAI の n::x:: と {} []、A1111 の (x:1.2) と ()[]) ----
  // 壊れていても落とさない。返すのは HTML。上げる = w-up、下げる = w-down (色は bunko-ui.css の語)
  function colorize(text) {
    const s = String(text || '');
    let out = '';
    let i = 0;
    const re = /(-?\d+(?:\.\d+)?)::([\s\S]*?)::|\(([^()]*?):(\d+(?:\.\d+)?)\)|(\{+)([^{}]*?)(\}+)|(\[+)([^\[\]]*?)(\]+)/g;
    let m;
    while ((m = re.exec(s))) {
      out += esc(s.slice(i, m.index));
      if (m[1] !== undefined) {
        const cls = Number(m[1]) >= 1 ? 'w-up' : 'w-down';
        out += `<span class="${cls}"><span class="w-n">${esc(m[1])}::</span>${esc(m[2])}<span class="w-n">::</span></span>`;
      } else if (m[3] !== undefined) {
        const cls = Number(m[4]) >= 1 ? 'w-up' : 'w-down';
        out += `<span class="${cls}"><span class="w-n">(</span>${esc(m[3])}<span class="w-n">:${esc(m[4])})</span></span>`;
      } else if (m[5] !== undefined) {
        out += `<span class="w-up"><span class="w-n">${esc(m[5])}</span>${esc(m[6])}<span class="w-n">${esc(m[7])}</span></span>`;
      } else {
        out += `<span class="w-down"><span class="w-n">${esc(m[8])}</span>${esc(m[9])}<span class="w-n">${esc(m[10])}</span></span>`;
      }
      i = m.index + m[0].length;
    }
    return out + esc(s.slice(i));
  }

  // タグに割る (, で切る。{} [] () と n::x:: の中の , は切らない)
  function splitTags(text) {
    const out = [];
    const s = String(text || '');
    let depth = 0;
    let buf = '';
    let inWeight = false;
    for (let i = 0; i < s.length; i += 1) {
      const ch = s[i];
      if (ch === ':' && s[i + 1] === ':') { inWeight = !inWeight; buf += '::'; i += 1; continue; }
      if ('{[('.includes(ch)) depth += 1;
      if ('}])'.includes(ch)) depth = Math.max(0, depth - 1);
      if ((ch === ',' || ch === '\n') && depth === 0 && !inWeight) { if (buf.trim()) out.push(buf.trim()); buf = ''; continue; }
      buf += ch;
    }
    if (buf.trim()) out.push(buf.trim());
    return out;
  }
  function weightClass(tag) {
    const t = String(tag || '');
    if (/^-/.test(t) || /^\[/.test(t) || /\(.*:0(\.\d+)?\)$/.test(t)) return 'w-down';
    if (/^\d+(\.\d+)?::/.test(t) && !/^(0|0\.\d+)::/.test(t)) return 'w-up';
    if (/^\{/.test(t) || /\(.*:\d+(\.\d+)?\)$/.test(t)) return 'w-up';
    return '';
  }

  // ---- 設定の表と、貼りやすい字 ----
  const SETTING_LABELS = [
    ['model', 'モデル'], ['seed', 'seed'], ['steps', 'steps'], ['scale', 'scale (CFG)'], ['cfgRescale', 'cfg_rescale'],
    ['sampler', 'sampler'], ['noiseSchedule', 'noise'], ['size', 'サイズ'], ['smea', 'SMEA'], ['requestType', '生成方法'], ['software', 'ソフト'],
  ];
  function settingRows(meta) {
    const s = (meta && meta.settings) || {};
    const rows = SETTING_LABELS.map(([k, label]) => {
      let v = s[k];
      if (k === 'size') v = s.width && s.height ? `${s.width} × ${s.height}` : undefined;
      if (k === 'smea') v = s.smea === undefined ? undefined : s.smea ? (s.smeaDyn ? 'SMEA + DYN' : 'SMEA') : 'なし';
      if (v === undefined || v === null || v === '') return null;
      return [k, label, String(v)];
    }).filter(Boolean);
    for (const [k, v] of Object.entries((meta && meta.extra) || {})) {
      if (v === undefined || v === null || v === '' || typeof v === 'object') continue;
      rows.push([`extra:${k}`, k, String(v)]);
    }
    return rows;
  }
  function settingsText(meta) { return settingRows(meta).map(([, l, v]) => `${l}: ${v}`).join('\n'); }
  // NovelAI にそのまま貼りやすい形: 見出しを付けて 正・キャラ・ネガ・設定 の順
  function allText(meta) {
    if (!meta) return '';
    const parts = [`# ベース\n${meta.positive || ''}`];
    (meta.characters || []).forEach((c, i) => parts.push(`# キャラ ${i + 1}\n${c}`));
    parts.push(`# ネガティブ\n${meta.negative || ''}`);
    (meta.characterNegatives || []).forEach((c, i) => { if (c) parts.push(`# キャラ ${i + 1} ネガティブ\n${c}`); });
    (meta.workflowTexts || []).forEach((t, i) => parts.push(`# ワークフロー内のテキスト ${i + 1}${t.title ? ` (${t.title})` : ''}\n${t.text}`));
    parts.push(`# 設定\n${settingsText(meta)}`);
    return parts.join('\n\n');
  }

  // ---- コピー ----
  let toastTimer = 0;
  function say(text) {
    if (typeof toast === 'function') { try { toast(text); return; } catch { /* 下へ */ } }
    let el = document.getElementById('ai-meta-toast');
    if (!el) { el = document.createElement('div'); el.id = 'ai-meta-toast'; el.className = 'ai-toast'; document.body.appendChild(el); }
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1400);
  }
  async function copy(text, button, label) {
    let ok = false;
    try { await navigator.clipboard.writeText(String(text)); ok = true; } catch { ok = false; }
    if (!ok) {
      try {
        const ta = document.createElement('textarea');
        ta.value = String(text);
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand && document.execCommand('copy');
        ta.remove();
      } catch { ok = false; }
    }
    if (button && ok) { button.classList.add('is-done'); setTimeout(() => button.classList.remove('is-done'), 1200); }
    say(ok ? `${label || ''}コピーしました` : 'コピーできませんでした');
    return ok;
  }

  // ---- 板の中身 ----
  // state: { kind: 'info'|'prompt', status: 'loading'|'ok'|'none'|'no-original'|'failed'|'off', meta, source, page, pageCount, view, gallery, error }
  function promptMarkup(st) {
    const { status, meta, page = 0, pageCount = 1, view = 'text' } = st;
    const pager = `<div class="ai-pager" title="読む画面の頁と連動"><button type="button" data-ai-prev ${page <= 0 ? 'disabled' : ''} aria-label="前の頁">${ICON.prev}</button><span>${page + 1} / ${pageCount}</span><button type="button" data-ai-next ${page >= pageCount - 1 ? 'disabled' : ''} aria-label="次の頁">${ICON.next}</button></div>`;
    const from = status === 'ok' ? (st.source === 'aitag' ? 'aitag.win' : meta.foundIn === 'png_text' ? 'PNG の文字チャンク' : meta.foundIn === 'exif' ? 'EXIF' : `ステルス情報 (${meta.foundIn})`) : '';
    const head = `<div class="ai-head"><h3>プロンプト</h3>${status === 'ok' ? `<span class="fmt" title="${esc(from)} から">${esc(meta.format)}</span>` : ''}${pager}<button type="button" class="ai-x" data-ai-close aria-label="閉じる">${ICON.close}</button></div>`;
    const tools = `<div class="ai-tools"><div class="seg" role="group" aria-label="見せ方"><button type="button" data-ai-view="text" aria-pressed="${view === 'text'}">文章</button><button type="button" data-ai-view="chips" aria-pressed="${view === 'chips'}">タグ</button></div><span class="spacer"></span><button type="button" class="act" data-ai-copy="settings" ${status !== 'ok' ? 'disabled' : ''}>${ICON.copy}設定</button><button type="button" class="act primary" data-ai-copy="all" ${status !== 'ok' ? 'disabled' : ''}>${ICON.copy}全部コピー</button></div>`;
    let body = '';
    if (status === 'loading') {
      body = `<div class="ai-body ai-skel" aria-busy="true"><div class="ai-card"><div class="bone s"></div><div class="bone l"></div><div class="bone m"></div><div class="bone l"></div></div><div class="ai-card"><div class="bone s"></div><div class="bone m"></div><div class="bone l"></div></div><div class="ai-settings"><div class="bone s"></div><div class="bone m"></div><div class="bone s"></div><div class="bone m"></div></div></div>`;
    } else if (status === 'none' || status === 'no-original' || status === 'off') {
      const note = status === 'no-original'
        ? '原寸の口が無い投稿なので、絵から読めません'
        : status === 'off'
          ? 'aitag.win を切ってあり、原寸の絵からも読めませんでした'
          : '原寸の PNG に文字チャンクもステルス情報も無い物 (投稿前に消されている) は、どこにも情報がありません';
      body = `<div class="ai-body"><div class="ai-empty">${ICON.image}<p>この画像には生成情報が残っていません</p><p class="ai-note">${esc(note)}</p>${st.source !== 'original' && status === 'none' ? `<button type="button" class="retry" data-ai-reload>${ICON.reload}原寸から読み直す</button>` : ''}</div></div>`;
    } else if (status === 'failed') {
      const why = st.error && st.error.code === 'pixiv-login' ? 'pixiv にログインしていません (設定 → 取り込み → pixiv)' : st.error && st.error.rateLimited ? 'pixiv が混んでいます (しばらく待ってからもう一度)' : '原寸の画像を取れませんでした';
      body = `<div class="ai-body"><div class="ai-empty is-fail">${ICON.retry}<p>${esc(why)}</p><button type="button" class="retry" data-ai-retry>もう一度</button></div></div>`;
    } else {
      const text = (t) => (view === 'chips'
        ? `<div class="ai-chips">${splitTags(t).map((tag) => `<button type="button" class="${weightClass(tag)}" data-ai-tag="${esc(tag)}" title="押すとこのタグだけコピー">${esc(tag)}</button>`).join('')}</div>`
        : `<p class="ai-text">${colorize(t)}</p>`);
      const card = (label, t, cls = '') => `<section class="ai-card ${cls}"><header><h4>${label}</h4><button type="button" class="copy" data-ai-copy-text="${esc(t)}" title="コピー" aria-label="コピー">${ICON.copy}</button></header>${text(t)}</section>`;
      const cards = [];
      if (meta.positive || !(meta.workflowTexts || []).length) cards.push(card('ベース <b>正</b>', meta.positive || ''));
      (meta.characters || []).forEach((c, i) => cards.push(card(`キャラ <b>${i + 1}</b>`, c)));
      cards.push(card('ネガティブ', meta.negative || '', 'is-neg'));
      (meta.characterNegatives || []).forEach((c, i) => { if (c) cards.push(card(`キャラ <b>${i + 1}</b> ネガティブ`, c, 'is-neg')); });
      (meta.workflowTexts || []).forEach((t, i) => cards.push(card(`ワークフロー内のテキスト <b>${i + 1}</b>${t.title ? ` <small>${esc(t.title)}</small>` : ''}`, t.text, 'is-wf')));
      if (meta.note === 'workflow-only') cards.push('<p class="ai-note">正プロンプトが空で、ワークフローの中にだけ文字列があります (どれが正かは決めていません)</p>');
      const rows = settingRows(meta).map(([k, l, v]) => `<dt>${esc(l)}</dt><dd class="${k === 'model' ? 'is-model' : ''}">${esc(v)}</dd>`).join('');
      cards.push(`<section class="ai-settings"><header><h4>設定</h4><button type="button" class="copy" data-ai-copy="settings" title="設定をコピー" aria-label="設定をコピー">${ICON.copy}</button></header><dl>${rows}</dl></section>`);
      cards.push(`<p class="ai-note">${esc(from)} から${st.source === 'aitag' ? ` · <button type="button" class="ai-link" data-ai-reload>${ICON.reload}原寸から読み直す</button>` : ''}</p>`);
      body = `<div class="ai-body">${cards.join('')}</div>`;
    }
    return head + tools + body;
  }

  // 情報: 詳細の板と同じ行 (日付・種別・作者・タグ …)。タグは見るだけ (読む画面から検索へは飛ばない)
  function infoMarkup(gallery) {
    const g = gallery || {};
    const row = (label, html) => (html ? `<dt>${esc(label)}</dt><dd>${html}</dd>` : '');
    const names = (list) => (Array.isArray(list) && list.length ? list.map((t) => `<span class="tag ${esc(t.type || 'tag')}" title="${esc(t.label && t.label !== t.name ? `${t.label} — ${t.name}` : '')}">${esc(t.name || t.label || '')}</span>`).join('') : '');
    const date = typeof formatDate === 'function' ? formatDate(g.publishedDate || g.addedDate) : String(g.publishedDate || g.addedDate || '');
    const kind = ({ doujinshi: '同人誌', manga: '漫画', artistcg: 'Artist CG', gamecg: 'Game CG', imageset: '画像集', illust: 'イラスト' })[g.type] || g.type || '';
    const flags = [g.source === 'pixiv' ? 'pixiv' : (typeof sourceLabel === 'function' ? sourceLabel(g.source) : g.source), g.badge, g.ai ? 'AI' : '', g.r18 ? 'R-18' : '', g.owned ? '保存済み' : ''].filter(Boolean).join(' · ');
    const series = g.series && !Array.isArray(g.series) && g.series.title ? esc(g.series.title) : names(g.series);
    const star = Math.round(Number(g.star)) || 0;
    const pages = Number(g.pageCount) ? `${g.pageCount} 頁` : '';
    const rows = [
      row('日付', esc(date)), row('種別', esc(kind)), row('頁', esc(pages)), star > 0 ? row('評価', `★${star}`) : '',
      row('作者', names(g.artists)), row('グループ', names(g.groups)), row('原作', series), row('キャラ', names(g.characters)), row('タグ', names(g.tags)),
    ].join('');
    const caption = g.caption || (g.captionHtml ? '' : '');
    return `<div class="ai-head"><h3>情報</h3><button type="button" class="ai-x" data-ai-close aria-label="閉じる">${ICON.close}</button></div>`
      + `<div class="ai-body ai-info"><h4 class="ai-title">${esc(g.title || '')}</h4><p class="ai-note">${esc(flags)}</p><dl class="ai-rows">${rows}</dl>${caption ? `<p class="ai-caption">${esc(caption)}</p>` : ''}${g.url ? `<p class="ai-note"><button type="button" class="ai-link" data-ai-site="${esc(g.url)}">サイトで開く</button></p>` : ''}</div>`;
  }

  // ---- 読む画面の板 (一つ。kind で中身を替える) ----
  const panel = { host: null, state: null, token: 0, onPage: null, onClose: null };
  const metaCache = new Map();   // `${id}:${page}` → { status, meta, source }
  function readView() { try { const v = localStorage.getItem(VIEW_KEY); return v === 'chips' ? 'chips' : 'text'; } catch { return 'text'; } }
  // 情報 = 詳細の板と同じ中身 (app.js の detailBodyMarkup)。無い所 (手のひら版) では簡易の表
  function infoBoard(gallery) {
    if (typeof detailBodyMarkup !== 'function') return infoMarkup(gallery);
    return `<div class="ai-head"><h3>情報</h3><button type="button" class="ai-x" data-ai-close aria-label="閉じる">${ICON.close}</button></div>`
      + `<div class="ai-body ai-info-detail"><div class="ai-detail-body">${detailBodyMarkup(gallery)}</div></div>`;
  }
  function paint() {
    const { host, state } = panel;
    if (!host || !state) return;
    host.innerHTML = state.kind === 'info' ? infoBoard(state.gallery) : promptMarkup(state);
    host.dataset.kind = state.kind;
    if (state.kind === 'info' && typeof detailBodyMarkup === 'function') {
      if (typeof loadDetailRelated === 'function') loadDetailRelated(state.gallery, host);
      // 読む画面の中では意味の無い手は伏せる (読む = 今読んでいる / 紐付け・ゴミ箱は詳細で)
      for (const sel of ['[data-read]', '.detail-quiet', '.detail-danger']) host.querySelectorAll(sel).forEach((n) => { n.hidden = true; });
    }
  }
  function freshOf(gallery) {
    const t = Date.parse((gallery && gallery.publishedDate) || '');
    return Number.isFinite(t) && Date.now() - t < 2 * 60 * 60 * 1000;
  }
  async function fetchPrompt(gallery, page, { source } = {}) {
    const id = String(gallery.id);
    const key = `${id}:${page}`;
    const st = panel.state;
    if (!source && metaCache.has(key)) { Object.assign(st, metaCache.get(key)); paint(); return; }
    st.status = 'loading';
    paint();
    const my = ++panel.token;
    try {
      const out = await window.hitomi.pixiv({ action: 'ai-meta', id, index: page, fresh: freshOf(gallery), ...(source ? { source } : {}) });
      if (my !== panel.token) return;
      const next = { status: out && out.status ? out.status : 'none', meta: out && out.meta ? out.meta : null, source: out && out.source ? out.source : '' };
      if (next.status === 'ok' || next.status === 'none' || next.status === 'no-original') metaCache.set(key, next);
      Object.assign(st, next);
      if (next.status === 'ok') noteMark(id, 'yes');
    } catch (error) {
      if (my !== panel.token) return;
      st.status = 'failed';
      st.error = { code: error && error.code, rateLimited: Boolean(error && error.rateLimited), message: error && error.message };
    }
    paint();
  }
  // reader.js が呼ぶ: 板の中身を今の作品と頁に合わせる
  function render(host, { kind, gallery, page = 0 }) {
    if (!host || !gallery) return;
    mount(host);
    const same = panel.state && panel.state.gallery && String(panel.state.gallery.id) === String(gallery.id) && panel.state.kind === kind;
    const view = panel.state ? panel.state.view : readView();
    panel.state = { kind, gallery, page, pageCount: Math.max(1, Number(gallery.pageCount) || 1), view, status: same ? panel.state.status : 'loading', meta: same ? panel.state.meta : null, source: same ? panel.state.source : '' };
    if (kind === 'info') { panel.token += 1; paint(); return; }
    fetchPrompt(gallery, page);
  }
  function mount(host) {
    if (panel.host === host) return;
    panel.host = host;
    host.addEventListener('click', (event) => {
      const t = event.target.closest('button');
      if (!t || !host.contains(t)) return;
      const st = panel.state;
      if (!st) return;
      if (t.hasAttribute('data-ai-prev')) panel.onPage?.(st.page - 1);
      else if (t.hasAttribute('data-ai-next')) panel.onPage?.(st.page + 1);
      else if (t.dataset.aiView) { st.view = t.dataset.aiView === 'chips' ? 'chips' : 'text'; try { localStorage.setItem(VIEW_KEY, st.view); } catch { /* 無くてよい */ } paint(); }
      else if (t.hasAttribute('data-ai-close')) panel.onClose?.();
      else if (t.hasAttribute('data-ai-retry')) fetchPrompt(st.gallery, st.page);
      else if (t.hasAttribute('data-ai-reload')) fetchPrompt(st.gallery, st.page, { source: 'original' });
      else if (t.dataset.aiCopyText !== undefined) copy(t.dataset.aiCopyText, t);
      else if (t.dataset.aiTag !== undefined) copy(t.dataset.aiTag, t, 'タグを');
      else if (t.dataset.aiCopy === 'settings' && st.meta) copy(settingsText(st.meta), t, '設定を');
      else if (t.dataset.aiCopy === 'all' && st.meta) copy(allText(st.meta), t, '全部');
      else if (t.dataset.aiSite) { try { window.hitomi.openExternal?.(t.dataset.aiSite); } catch { /* 開けなくてよい */ } }
      else if (st.kind === 'info') delegateDetail(event, t, st.gallery);
    });
  }

  // 情報 (詳細と同じ中身) の釦: 読む画面の中で意味が変わる物だけ差し替え、残りは詳細の受け手 (onDetailClick) へ
  async function delegateDetail(event, t, gallery) {
    const reader = typeof Reader !== 'undefined' ? Reader : null;
    if (t.hasAttribute('data-ai-meta')) { reader?.openSide?.('prompt'); return; }
    if (t.hasAttribute('data-related-detail')) {
      // 関連作品は読む画面で開く (詳細は読む画面の下に隠れている)
      if (typeof readRelatedWork === 'function') { try { await readRelatedWork(t.dataset.relatedDetail); } catch { /* 開けなければそのまま */ } }
      return;
    }
    const leaves = t.hasAttribute('data-query') || t.hasAttribute('data-creator') || t.hasAttribute('data-variant') || t.hasAttribute('data-caption-work');
    if (typeof onDetailClick !== 'function' || typeof state === 'undefined') return;
    const prev = state.selected;
    state.selected = gallery;
    try {
      if (leaves) reader?.close?.();   // 一覧や詳細へ移る手は、読む画面を閉じてから
      await onDetailClick(event);
    } finally {
      if (state.selected === gallery && !leaves) state.selected = prev;
    }
  }
  function bind({ onPage, onClose } = {}) { panel.onPage = onPage || null; panel.onClose = onClose || null; }
  function clear() { panel.token += 1; panel.state = null; if (panel.host) panel.host.innerHTML = ''; }
  function canPrompt(gallery) { return Boolean(gallery && gallery.source === 'pixiv' && gallery.ai === true && gallery.kind !== 'creator'); }

  // ---- 札の印 (「プロンプトあり」) ----
  // 控え: id → 'yes' | 'no' | 'unknown'。描く時に読む (仮想の棚は札を作り直すので、class を後から足すだけでは消える)
  const marks = new Map();
  const pendingIds = new Map();   // id → fresh
  let flushTimer = 0;
  let listeners = [];
  function markOf(id) { return marks.get(String(id)) || ''; }
  // その頁にプロンプトがあるか: 板で開いた頁は頁の答え、まだなら作品の印 (yes なら true)
  function pageHasPrompt(id, page = 0) {
    const hit = metaCache.get(`${String(id)}:${Math.max(0, Number(page) || 0)}`);
    if (hit) return hit.status === 'ok';
    return marks.get(String(id)) === 'yes';
  }
  function noteMark(id, value) {
    const key = String(id);
    if (marks.get(key) === value) return;
    marks.set(key, value);
    if (value === 'yes') for (const fn of listeners) { try { fn([key]); } catch { /* 画面側の都合 */ } }
  }
  function onMarks(fn) { listeners.push(fn); return () => { listeners = listeners.filter((f) => f !== fn); }; }
  function resetMarks() { marks.clear(); pendingIds.clear(); }
  function flush() {
    flushTimer = 0;
    const rows = [...pendingIds.entries()].slice(0, 60).map(([id, fresh]) => ({ id, fresh }));
    for (const r of rows) pendingIds.delete(r.id);
    if (!rows.length) return;
    const api = window.hitomi && window.hitomi.pixiv;
    if (typeof api !== 'function') return;
    Promise.resolve(api({ action: 'ai-marks', ids: rows })).then((out) => {
      const got = (out && out.marks) || {};
      const yes = [];
      for (const r of rows) {
        const v = got[r.id] || 'unknown';
        marks.set(r.id, v);
        if (v === 'yes') yes.push(r.id);
        // 分からなかった (口が黙っていた・網の不調) 物は 2 分で忘れ、次に描かれた時に訊き直す
        if (v === 'unknown') setTimeout(() => { if (marks.get(r.id) === 'unknown') marks.delete(r.id); }, UNKNOWN_TTL);
      }
      if (yes.length) for (const fn of listeners) { try { fn(yes); } catch { /* 画面側の都合 */ } }
      if (pendingIds.size) schedule();
    }).catch(() => { for (const r of rows) if (!marks.has(r.id)) marks.set(r.id, 'unknown'); });
  }
  function schedule() { if (!flushTimer) flushTimer = setTimeout(flush, 200); }
  // 見えている札のうち、印が未定の pixiv の AI の作品を訊く。galleries: 札の作品 (id・ai・source・publishedDate)
  function want(galleries) {
    let added = 0;
    for (const g of galleries || []) {
      if (!canPrompt(g)) continue;
      const id = String(g.id);
      if (marks.has(id) || pendingIds.has(id)) continue;
      pendingIds.set(id, freshOf(g));
      added += 1;
    }
    if (added) schedule();
    return added;
  }
  // 作者の一覧 (user:<番号>) は一発で
  async function wantUser(userId) {
    const api = window.hitomi && window.hitomi.pixiv;
    if (typeof api !== 'function') return;
    try {
      const out = await api({ action: 'ai-marks', userId: String(userId) });
      const yes = Object.entries((out && out.marks) || {}).filter(([, v]) => v === 'yes').map(([id]) => id);
      for (const id of yes) marks.set(id, 'yes');
      if (yes.length) for (const fn of listeners) { try { fn(yes); } catch { /* 画面側の都合 */ } }
    } catch { /* 印が付かないだけ */ }
  }
  // root の中の札に印を写す (class だけ。寸法は動かさない)
  function applyMarks(root) {
    if (!root || !root.querySelectorAll) return 0;
    let n = 0;
    for (const node of root.querySelectorAll('[data-id^="px:"], [data-related-detail^="px:"], [data-related^="px:"], [data-ai-meta^="px:"]')) {
      const id = node.dataset.id || node.dataset.relatedDetail || node.dataset.related || node.dataset.aiMeta;
      const on = marks.get(String(id)) === 'yes';
      if (on !== node.classList.contains('has-prompt')) { node.classList.toggle('has-prompt', on); n += 1; }
    }
    return n;
  }

  return {
    colorize, splitTags, weightClass, settingRows, settingsText, allText, copy,
    promptMarkup, infoMarkup, render, mount, bind, clear, canPrompt,
    markOf, pageHasPrompt, noteMark, onMarks, resetMarks, want, wantUser, applyMarks, _metaCache: metaCache, _marks: marks,
  };
})();

if (!globalThis.__BUNKO_HARNESS__) {
  // 本体: 札の印が届いたら、見えている棚・詳細・読む画面に写す
  document.addEventListener('DOMContentLoaded', () => {
    window.BunkoAiMeta.onMarks(() => window.BunkoAiMeta.applyMarks(document));
    // 後ろの列 (確定・埋め戻し) で「あり」に変わった物は、主プロセスから知らせが来る
    window.hitomi?.onAiMetaMark?.((payload) => { if (payload && payload.id && payload.mark) window.BunkoAiMeta.noteMark(payload.id, payload.mark); });
  });
}
