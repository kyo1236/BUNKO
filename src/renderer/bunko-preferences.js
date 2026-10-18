/* Approved P6 preferences. Form edits are drafts; operational buttons keep their IPC handlers. */
window.BunkoPreferences = (() => {
  let panel, legacy, content, search, status, category = 'appearance', draft = {}, baseline = {}, busy = false;
  const live = new Map();
  const choice = (key, label, options, value, hint = '') => ({ key, label, options, value, hint });
  const check = (key, label, value, hint = '') => ({ key, label, value, hint, type: 'checkbox' });
  const path = (key, label, kind) => ({ key, label, kind, value: '', type: 'path' });
  const text = (key, label, hint = '') => ({ key, label, hint, value: '', type: 'text' });
  const action = (id, label, hint = '') => ({ id, label, hint, type: 'action' });
  const groups = [
    { id: 'appearance', title: '外観', icon: '◌', intro: '一覧の見え方を整えます。', fields: [
      choice('uiTheme', 'テーマ', [['dark','墨'],['navy','紺'],['light','明']], 'dark'),
    ] },
    { id: 'reading', title: '読む・操作', icon: 'book', intro: '作品を開くときと、読み進めるときの動作。', fields: [
      choice('openOwned','所持作品を開く先',[['app','文匣'],['eagle','Eagle']],'app','Eagle にない作品は文匣で開きます。'),
      check('readerResume','前回のページから再開',true),
      choice('readerNextCard','読み終えたとき',[[true,'次の作品を案内'],[false,'次の作品を開く']],false),
      choice('readerNextOrder','次の作品は一覧の',[['up','一つ上'],['down','一つ下']],'up','最終頁の先で渡る作品。前の作品はその反対側です。'),
      ...[['mouseLeft','クリック','detail'],['mouseRight','右クリック','read'],['mouseDouble','ダブルクリック','save']].map(([key,label,value]) => choice(key,label,[['detail','詳細を開く'],['read','読む'],['save','保存'],['none','何もしない']],value)),
    ] },
    { id: 'library', title: 'ライブラリ', icon: 'library', intro: '所持作品と Eagle の紐付けを管理します。', fields: [
      action('set-rescan','ライブラリの状態','所持作品の索引と自動同期の状態を確認します。'),
      action('set-sync-homecore','棚・読書データをミラーへ同期','棚と読書データを同期先へ送ります。'),
      path('syncDest','同期先（写しの置き場）','syncDest'),
      path('eagleLibrary','Eagle ライブラリ','eagle'),
      text('pawEagleFolder','Pawchive の作者フォルダ（Eagle のフォルダ ID）','未設定だと Pawchive の所持は数えません。'),
      check('showUnmatchedEagle','未紐付けのEagle作品も表示',true,'サイトの作品情報と紐付いていない Eagle アイテムも一覧に含めます。'),
      { ...choice('favoriteMinStars','お気に入りの評価',[[3,'★3 以上'],[4,'★4 以上'],[5,'★5 のみ']],4), type:'select' },
      check('autoSync','作品情報・タグを自動同期',true,'作品情報・タグ・作者名を更新します。'),
    ] },
    { id: 'download', title: '保存・取り込み', icon: 'download', intro: '保存形式と取り込み時の動作。', fields: [
      path('downloadDir','保存先','download'),
      choice('saveFormat','保存形式',[['zip','ZIP'],['pdf','PDF'],['raw','フォルダ']],'zip'),
      check('ownedSaveConfirm','所持作品の保存前に確認',true,'同じ作品を重複して保存するのを防ぎます。'),
      { ...choice('concurrency','同時に取得する画像',Array.from({length:16},(_,i)=>[i+1,String(i+1)]),4), type:'select' },
      { ...choice('maxGalleries','同時に保存する作品',Array.from({length:8},(_,i)=>[i+1,String(i+1)]),8), type:'select' },
      path('pawBulkDir','Pawchiveの保存先','pawBulk'),
    ] },
    { id: 'sources', title: 'ソース', icon: 'sources', intro: 'サイトごとの表示と読み込み。', fields: [
      action('set-pixiv-login','pixiv の接続'),
      action('set-pixiv-relabel','旧形式のpixiv作品を再紐付け','旧形式で保存した作品の投稿 ID から紐付けを修復します。'),
      check('pixivHideAi','pixiv の AI 生成を隠す',false,'一覧から AI 生成の作品を除きます。'),
      check('pixivReadOriginal','pixivを原寸で読む（保存は常に原寸）',true,'オフでは閲覧用サイズを使います。保存する画像は常に原寸です。'),
      { ...choice('pawBulkConcurrency','同時に確認する作者',Array.from({length:6},(_,i)=>[i+1,String(i+1)]),2), type:'select' },
      action('language','表示する言語'),
    ] },
    { id: 'devices', title: '端末で読む', icon: 'device', intro: '同じネットワークのスマートフォンやタブレットで読みます。', fields: [
      action('set-lan','端末で読む','配信の開始・停止はすぐに反映されます。'),
      action('set-lan-copy','接続用アドレス・QRコード'),
      { ...choice('trayCloseMinutes','閉じた後の待機時間',[[0,'終了する'],[15,'15 分'],[30,'30 分'],[60,'60 分'],[120,'120 分']],30,'端末で読み続けられるよう、文匣をトレイに残す時間です。'), type:'select' },
    ] },
  ];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const icon = name => {
    const paths = { book:'M3 4h7l2 2 2-2h7v16h-7l-2 2-2-2H3z M12 6v16', library:'M5 3h14v18H5z M8 7h8 M8 11h8 M8 15h8', download:'M12 3v12m-4-4 4 4 4-4 M5 18v3h14v-3', sources:'M3 5h18v15H3z M8 5V3h8v2 M9 11h6', device:'M7 2h10v20H7z M11 18h2', folder:'M3 7V4h6l2 3h10v13H3z M3 10h18', search:'M16 16l5 5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0', close:'m6 6 12 12 M18 6 6 18', '◌':'M12 3a9 9 0 1 0 0 18h2a2 2 0 0 0 1-4c-2-1-1-3 1-3h2c5 0 2-11-6-11z M7 9h.01 M11 6h.01 M16 8h.01' };
    return `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] || paths.sources}"/></svg>`;
  };
  function pending() { return Object.fromEntries(Object.entries(draft).filter(([key,value]) => value !== baseline[key])); }
  function dirty() {
    const changed = Object.keys(pending()).length > 0;
    status.textContent = changed ? '未保存の変更があります' : '';
    panel.querySelector('[data-apply]').disabled = busy || !changed;
  }
  function row(field) {
    const id = `pref-${field.key || field.id}`, value = draft[field.key];
    let control;
    if (field.type === 'action') control = `<div data-live="${field.id}"></div>`;
    else if (field.type === 'checkbox') control = `<input type="checkbox" id="${id}" data-key="${field.key}" ${value ? 'checked' : ''}>`;
    else if (field.type === 'text') control = `<input type="text" id="${id}" data-key="${field.key}" value="${esc(value)}">`;
    else if (field.type === 'path') control = `<input type="text" id="${id}" data-key="${field.key}" value="${esc(value)}"><button type="button" class="ib folder-browse" data-folder="${field.key}" aria-label="${field.label}を参照">${icon('folder')}</button>`;
    else if (field.type === 'select') {
      const options = field.options.some(([v]) => v === value) ? field.options : [...field.options,[value,String(value)]];
      control = `<select id="${id}" data-key="${field.key}">${options.map(([v,label])=>`<option value="${esc(v)}" ${v === value ? 'selected' : ''}>${label}</option>`).join('')}</select>`;
    } else control = `<div class="pref-radios" role="radiogroup" aria-labelledby="${id}-label">${field.options.map(([v,label])=>`<label><input type="radio" name="${id}" data-key="${field.key}" value="${v}" ${v === value ? 'checked' : ''}>${label}</label>`).join('')}</div>`;
    return `<div class="preference-row"><div><label id="${id}-label" for="${id}">${field.label}</label></div><div class="preference-control">${control}</div></div>`;
  }
  function render() {
    // Detach live IPC controls before replacing the form so their event handlers and status survive.
    for (const n of live.values()) legacy.append(n);
    const q = search.value.trim().toLowerCase();
    panel.querySelector('[data-title]').textContent = q ? '検索結果' : groups.find(g=>g.id===category).title;
    for (const b of panel.querySelectorAll('[data-category]')) { b.classList.toggle('is-on',!q && b.dataset.category===category); b.setAttribute('aria-current',!q && b.dataset.category===category ? 'page' : 'false'); }
    content.innerHTML = groups.filter(g=>q || g.id===category).map(g=>{
      const fields = g.fields.filter(f=>!q || `${g.title} ${f.label} ${f.hint || ''}`.toLowerCase().includes(q));
      return fields.length ? `<section class="preference-group">${q ? `<h3>${g.title}</h3>` : `<p class="preference-intro">${g.intro}</p>`}<div class="preference-box">${fields.map(row).join('')}</div></section>` : '';
    }).join('') || '<p class="preference-intro">該当する設定がありません。</p>';
    for (const holder of content.querySelectorAll('[data-live]')) if (live.has(holder.dataset.live)) holder.replaceWith(live.get(holder.dataset.live));
    content.scrollTop = 0;
  }
  async function apply(closeAfter) {
    if (busy) return;
    const patch = pending();
    if (Object.keys(patch).length) {
      const committed = {...draft};
      busy = true; panel.inert = true; dirty();
      let saved;
      try { saved = await saveSetting(patch, {announce:false}); }
      finally { busy = false; panel.inert = false; }
      if (!saved) { dirty(); status.textContent='保存できませんでした。もう一度お試しください。'; return; }
      baseline = committed;
      fillSettingsFields(); fillFavToggle(); fillPixivSettings();
      window.BunkoUI.sync();
      applyHideAi();
      if ('eagleLibrary' in patch) runRescan();
      if (state.selected) renderDetail(state.selected);
      if ('pixivHideAi' in patch || 'showUnmatchedEagle' in patch || 'favoriteMinStars' in patch || 'eagleLibrary' in patch) await runSearch({reset:true});
      else renderGrid(false);
    }
    dirty(); status.textContent='設定を適用しました';
    if (closeAfter) closeSettings();
  }
  function init() {
    legacy = els.settings.querySelector('.settings-panel');
    legacy.hidden = true; legacy.className = 'legacy-settings';
    legacy.querySelectorAll('.settings-tab').forEach(n=>n.classList.remove('settings-tab'));
    legacy.querySelectorAll('.settings-tabpanel').forEach(n=>n.classList.remove('settings-tabpanel'));
    panel = document.createElement('div'); panel.className = 'preferences';
    panel.innerHTML = `<div class="preferences-shell"><aside class="preferences-sidebar"><h2>環境設定</h2><label class="preferences-search">${icon('search')}<input type="search" placeholder="設定を検索" aria-label="設定を検索"></label><nav aria-label="設定カテゴリ">${groups.map(g=>`<button type="button" data-category="${g.id}">${icon(g.icon)}${g.title}</button>`).join('')}</nav><span class="preferences-brand">文匣 <small>BUNKO</small></span></aside><section class="preferences-main"><header><h2 data-title>外観</h2><button type="button" class="ib" data-close aria-label="設定を閉じる">${icon('close')}</button></header><div class="preferences-content"></div><footer><span class="preference-status" role="status"></span><button type="button" class="pref-button" data-close>キャンセル</button><button type="button" class="pref-button save" data-save>変更を保存</button><button type="button" class="pref-button" data-apply>適用</button></footer></section></div>`;
    els.settings.append(panel); els.settings.setAttribute('aria-label','環境設定');
    content=panel.querySelector('.preferences-content'); search=panel.querySelector('input[type=search]'); status=panel.querySelector('.preference-status');
    for (const f of groups.flatMap(g=>g.fields).filter(f=>f.type==='action')) {
      const original=document.getElementById(f.id); if (!original) continue;
      const box=document.createElement('div'); box.className='pref-live';
      if (f.id==='language') { original.setAttribute('aria-label','表示する言語'); box.append(original); }
      else {
        const oldRow=original.closest('.set-row');
        for (const value of [...oldRow.children].filter(n=>n.classList.contains('set-value'))) box.append(value);
        box.append(oldRow.querySelector('.set-acts'));
        if (f.id==='set-lan-copy') for (const id of ['set-lan-qr','set-lan-ts-row','set-lan-ts-qr','set-lan-note']) box.append(document.getElementById(id));
        if (f.id==='set-rescan') box.append(document.getElementById('set-library-bar'));
        if (f.id==='set-lan') {
          const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.setAttribute('aria-label','端末で読む');original.hidden=true;box.prepend(checkbox);
          const update=()=>{checkbox.checked=original.getAttribute('aria-pressed')==='true';checkbox.disabled=original.disabled;};
          new MutationObserver(update).observe(original,{attributes:true});update();checkbox.onchange=()=>original.click();
        }
      }
      live.set(f.id,box); legacy.append(box);
    }
    document.getElementById('set-sync-homecore').textContent='今すぐ同期';
    panel.addEventListener('click', async e=>{
      if (e.target.closest('[data-close]')) { closeSettings(); return; }
      const tab=e.target.closest('[data-category]');if(tab){category=tab.dataset.category;search.value='';render();return;}
      if(e.target.closest('[data-save]')){await apply(true);return;}
      if(e.target.closest('[data-apply]')){await apply(false);return;}
      const folder=e.target.closest('[data-folder]');if(folder){const field=groups.flatMap(g=>g.fields).find(f=>f.key===folder.dataset.folder);try{const result=await window.hitomi.chooseFolder({kind:field.kind,pickOnly:true});if(result?.path){draft[field.key]=result.path;render();dirty();}}catch{status.textContent='フォルダを選べませんでした';}}
    });
    panel.addEventListener('input',e=>{
      const key=e.target.dataset.key;if(!key)return;
      const field=groups.flatMap(g=>g.fields).find(f=>f.key===key);
      draft[key]=e.target.type==='checkbox'?e.target.checked:field.options?.find(([v])=>String(v)===e.target.value)?.[0] ?? e.target.value;dirty();
    });
    search.addEventListener('input',render);
  }
  function open() {
    fillSettingsFields(); refreshLibrary(); refreshPixivStatus();
    baseline=Object.fromEntries(groups.flatMap(g=>g.fields).filter(f=>f.key).map(f=>[f.key,state.settings[f.key] ?? f.value]));
    draft={...baseline};search.value='';render();dirty();els.settings.hidden=false;search.focus();
  }
  function discard(){draft={...baseline};}
  return {init,open,discard};
})();
