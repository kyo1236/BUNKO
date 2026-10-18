/* The approved P6 shell, connected to the existing search, reader and IPC handlers. */
window.BunkoUI=(()=>{
  let initialized=false,sortMenu,displayMenu,sourceNav,viewNav,periodNav,rankNav,sortTrigger,pixivFilters;
  let view='', resultAnimation;
  const rankOptions=[['today','デイリー'],['week','ウィークリー'],['month','マンスリー'],['rookie','ルーキー'],['original','オリジナル'],['male','男性に人気'],['female','女性に人気']];
  const periods=['today','week','month','year'];
  const svg=body=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const cards=svg('<rect class="fan-back" x="7" y="4" width="10" height="15" rx="2"/><rect class="fan-mid" x="7" y="4" width="10" height="15" rx="2"/><rect class="fan-front" x="7" y="4" width="10" height="15" rx="2"/>');
  const layoutIcons={flow:svg('<rect x="3" y="3" width="18" height="18" rx="1"/><path d="M9 3v18M15 3v18"/>'),grid:svg('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>')};
  const coverRatios=new Map(),captionHeights=new Map();let layoutFrame=0;
  const button=(id,label,on=false)=>`<button type="button" data-ui-value="${id}" aria-pressed="${on}">${label}</button>`;
  function navItems(nav,items,value){
    const existing=[...nav.querySelectorAll('button')];
    if(existing.map(b=>b.dataset.uiValue).join('|')!==items.map(([id])=>id).join('|')){nav.innerHTML=items.map(([id,label])=>button(id,label,id===value)).join('');nav.classList.remove('has-fluid');return;}
    items.forEach(([id,label],i)=>{existing[i].textContent=label;existing[i].setAttribute('aria-pressed',String(id===value));});
    const marker=nav.querySelector('.ui-fluid'),active=nav.querySelector('[aria-pressed=true]');
    if(marker&&active){const r=active.getBoundingClientRect(),base=nav.getBoundingClientRect();marker.style.left=r.left-base.left+'px';marker.style.top=r.top-base.top+'px';marker.style.width=r.width+'px';marker.style.height=r.height+'px';}
  }
  function make(tag,cls,parent){const n=document.createElement(tag);n.className=cls;parent.append(n);return n;}
  function chooseSort(id){els.sort.value=id;els.sort.dispatchEvent(new Event('change'));sync();}
  // 所持に無いサイト (nhentai など) を所持のスコープで押した時は、スコープだけ全体へ戻してすぐ移る (引き直さない)。
  // 前は setScope が hitomi の全体を引き終わるまで待ってから移っていたので、その間 所持の棚と回る印が残り、
  // サイトの札も押した物に変わらなかった (ui-probe 2026-09-27: 0.9 秒後も前のサイトのまま)
  async function chooseSource(id){const has=()=>[...els.source.options].some(o=>o.value===id);if(!has()&&libraryScope())await setScope('all',{search:false});if(!has())return;els.source.value=id;els.source.dispatchEvent(new Event('change'));sync();}
  function popover(node,anchor){const open=node.hidden;sortMenu.hidden=true;displayMenu.hidden=true;if(!open)return;node.hidden=false;const r=anchor.getBoundingClientRect();node.style.left=Math.max(8,Math.min(innerWidth-node.offsetWidth-8,r.right-node.offsetWidth))+'px';node.style.top=r.bottom+8+'px';}
  function inferView(){if(state.source==='pawchive')return state.sort==='favorites'?'favorites':state.sort==='today'?'creators':'posts';return state.source==='pixiv'?pixivViewKey():'';}
  function sync(){
    if(!initialized)return;
    els.zoomCycle.title='表示設定';els.zoomCycle.setAttribute('aria-label','表示設定');
    els.zoomCycle.innerHTML=layoutIcons[state.settings.uiLayout||'flow'];
    const sourceNames={home:'Home',hitomi:'Hitomi',nhentai:'nhentai',ehentai:'E-Hentai',pawchive:'Pawchive',pixiv:'pixiv'};
    // サイトの札は所持作品のスコープでも全部出しておく (押せば chooseSource が全体へ戻してから移る)。
    // 所持に無いサイトを抜くと札の列が縮み、所持を切り替えるたびに検索欄が 51px 横へ跳んでいた。所持に無い物は薄くするだけ
    navItems(sourceNav,SOURCES.map(s=>[s.id,sourceNames[s.id]||s.label]),state.source);
    for(const b of sourceNav.querySelectorAll('button')){const outside=libraryScope()&&b.dataset.uiValue!=='home'&&!LIBRARY_SOURCES.some(l=>l.id===b.dataset.uiValue);b.classList.toggle('is-outside',outside);b.title=outside?'所持作品には無いサイト — 押すと全体の検索へ':'';}
    view=inferView();const special=!libraryScope()&&['pawchive','pixiv'].includes(state.source);
    els.types.hidden=special;viewNav.hidden=!special;
    const views=state.source==='pawchive'?[['favorites','お気に入り'],['creators','作者を探す'],['posts','投稿']]:[['follow','フォロー'],['bookmarks','ブックマーク'],['recommended','おすすめ'],['ranking','ランキング'],['search','作品検索']];
    navItems(viewNav,views,view);
    // ランキングの時だけ二段目を出す。表示を替えると棚はいったん空になってから入れ替わるので、
    // 帯の高さが変わっても見えている札は動かない (席を常に取る形は、空いた帯が残るだけだったので戻した)
    const rank=state.source==='pixiv'&&!libraryScope()&&view==='ranking';
    rankNav.hidden=!rank;
    const typeParts=pixivTypeParts(state.type);
    // AI 生成のランキングは日間だけ (R-18 にもある)
    const ranks=typeParts.kind==='ai'?rankOptions.slice(0,1):state.type==='r18'?rankOptions.filter(([id])=>['today','week','male','female'].includes(id)):state.type==='manga'?rankOptions.slice(0,3):rankOptions;
    navItems(rankNav,ranks,state.sort);
    pixivFilters.hidden=state.source!=='pixiv'||libraryScope();
    // 種類は押すたびに すべて → 漫画 → AI と巡る。対象 (R-18) はどれとも重ねられる (ランキングの漫画だけ除く)
    const kindName=({manga:'漫画',ai:'AI'})[typeParts.kind]||'すべて',adult=typeParts.r18;
    pixivFilters.innerHTML=button('kind','<span class="ui-key">種類</span>'+kindName,Boolean(typeParts.kind))+button('age','<span class="ui-key">対象</span>'+(adult?'R-18':'すべて'),adult);
    const kindButton=pixivFilters.querySelector('[data-ui-value=kind]');kindButton.setAttribute('aria-label',`種類: ${kindName}`);kindButton.title='押すたびに すべて → 漫画 → AI';
    const ageButton=pixivFilters.querySelector('[data-ui-value=age]');ageButton.setAttribute('aria-label',`対象: ${adult?'R-18':'すべて'}`);ageButton.disabled=rank&&typeParts.kind==='manga';
    const pawPopular=state.source==='pawchive'&&state.sort.startsWith('popular-')&&!libraryScope();
    const pixivSearch=state.source==='pixiv'&&!libraryScope()&&view==='search';
    const popular=(periods.includes(state.sort)&&!rank&&state.source!=='pawchive'||pawPopular)&&!libraryScope();
    periodNav.hidden=!(popular||pixivSearch);
    const names=state.source==='ehentai'?['いま','昨日','今月','今年']:state.source==='nhentai'||state.source==='pixiv'?['今日','今週','今月','全期間']:['今日','今週','今月','今年'];
    navItems(periodNav,pixivSearch?[['year','全期間'],['today','今日'],['week','1週間'],['month','1か月']]:pawPopular?[['popular-day','今日'],['popular-week','今週'],['popular-month','今月']]:periods.map((id,i)=>[id,names[i]]),pixivSearch?state.pixivPeriod:state.sort);
    let choices=activeSorts().filter(x=>!periods.slice(1).includes(x.id)).map(x=>({id:x.id,label:x.id==='today'?'人気順':x.label}));
    let label=choices.find(x=>x.id===state.sort)?.label||'人気順';
    if(special){
      if(state.source==='pawchive'){label=view==='favorites'?'更新日':view==='creators'?'お気に入り数':pawPopular?'人気順':'公開日';choices=view==='posts'?[{id:'added',label:'公開日'},...(!state.query.trim()?[{id:'popular-day',label:'人気順'}]:[])]:[];}
      else if(view==='search'){choices=[{id:'added',label:'公開日'},{id:'year',label:'人気順'}];label=popular?'人気順':'公開日';}
      else {choices=[];label=rank?'順位順':view==='follow'?'公開日':'pixivの表示順';}
    }
    sortTrigger.innerHTML=(sortDirValue()==='asc'?ICON.sortAsc:ICON.sortDesc)+`<span>${label}</span>`+svg('<path d="m7 10 5 5 5-5"/>');sortTrigger.disabled=!choices.length&&!sortDirSupported();
    sortMenu.innerHTML=`<header><h3>並び順</h3>${sortDirSupported()?`<div class="ui-segments">${button('desc','↓ 降順',sortDirValue()==='desc')}${button('asc','↑ 昇順',sortDirValue()==='asc')}</div>`:''}</header>${!sortDirNativeSupported()?`<p class="ui-sort-scope">取得済みの作品内で並べ替え<br>サイトの表示順を基準に反転します</p>`:''}${choices.map(c=>{const on=c.id===state.sort||(c.id==='today'&&popular)||(c.id==='popular-day'&&pawPopular);return `<button type="button" class="ui-sort-option" data-sort="${c.id}" aria-pressed="${on}">${c.label}<span>${on?'✓':''}</span></button>`;}).join('')}`;
    els.hideOwned.dataset.mode=hideOwnedMode();if(!els.hideOwned.querySelector('.fan-front'))els.hideOwned.innerHTML=cards;
    const ownedLabels={none:'すべて表示 → 版違いを隠す',dupes:'所持の版違いを非表示 → 所持を隠す',owned:'所持を非表示 → すべて表示'};
    els.hideOwned.setAttribute('aria-pressed',String(hideOwnedMode()!=='none'));els.hideOwned.title=ownedLabels[hideOwnedMode()];els.hideOwned.setAttribute('aria-label',els.hideOwned.title);
    document.body.classList.toggle('ui-hide-captions',state.settings.uiCaptions===false);
    document.body.classList.toggle('ui-fit',state.settings.uiFit===true);
    document.body.dataset.uiTheme=state.settings.uiTheme||'dark';
    updateTopbar();
  }
  function updateTopbar(){
    const bar=document.querySelector('.ui-topbar');if(!bar)return;
    document.documentElement.style.setProperty('--ui-detail-top',(bar.getBoundingClientRect().bottom+16)+'px');
    document.documentElement.style.setProperty('--ui-topbar-height',bar.offsetHeight+'px');
  }
  function coverSize(){return typeof currentCoverSize==='function'?currentCoverSize():(Number(state.settings.uiCoverSize)||152);}
  // 揃えの一覧 (扇の見出しだけの一覧: Home と Pawchive の作者)。流しにしない
  function uniform(){return Boolean(window.BunkoHome?.uniformList?.()||(typeof pawFanList==='function'&&pawFanList()));}
  function applyLayout(){els.grid.style.setProperty('--card-min',coverSize()+'px');window.BunkoHome?.relayout?.();const flow=(state.settings.uiLayout||'flow')==='flow'&&state.zoom!==0&&!uniform();els.grid.classList.toggle('ui-waterfall',flow);if(!flow)clearWaterfallStyles();renderGrid(false,true);}
  // 流し (Waterfall) を敷く。force=false は送り (scroll の rAF) から: 窓の中身が同じなら何もしない。
  // 前は毎こま、窓の札全部の style を書き直し (同じ文でも変化として数えられ、style の計算が走る)、
  // 字幕の高さを全部読み直していた (書いた直後に読むので毎こま強制レイアウト)。pixiv の送りで 33ms 超のこまが 6〜10 (2026-09-27)。
  // 今は 位置が変わった札だけ書き、字幕はまだ測っていない札だけ測る
  let waterfallKey='';
  function clearWaterfallStyles(){els.grid.style.height='';els.grid._wfHeight='';for(const c of els.grid.children){c.style.cssText='';c._wfPos='';}waterfallKey='';}
  function renderWaterfall(force=true,pass=0){
    if(!initialized)return false;
    if((state.settings.uiLayout||'flow')!=='flow'||state.zoom===0||state.discovery||uniform()){if(els.grid.classList.contains('ui-waterfall')){els.grid.classList.remove('ui-waterfall');clearWaterfallStyles();}return false;}
    els.grid.classList.add('ui-waterfall');
    const min=coverSize(),items=visibleGridItems(),captions=state.settings.uiCaptions!==false,width=els.grid.clientWidth;
    const plan=BunkoUIModel.waterfall(items,{width,min,gap:window.hitomi.remote&&innerWidth<=700?8:20,caption:captions?66:0,scroll:Math.max(0,-els.grid.getBoundingClientRect().top),viewport:innerHeight,ratioFor:item=>coverRatios.get(`${item.source}:${item.id}`),captionFor:(item,w)=>captions?(captionHeights.get(`${item.source}:${item.id}:${Math.round(w)}`)??66):0});
    let sig=0;for(const p of plan.positions)for(const ch of String(p.item.id))sig=(sig*31+ch.charCodeAt(0))|0;
    const key=`${items.length}:${plan.positions.length}:${sig}:${Math.round(width)}:${min}:${captions}`;
    if(!force&&key===waterfallKey)return true;
    waterfallKey=key;
    const focused=document.activeElement?.closest('.card')?.dataset.id;
    const keep=new Set(),desired=plan.positions.map(p=>{const n=cardNode(p.item);keep.add(String(p.item.id));const rk=`${p.item.source}:${p.item.id}`;if(n.dataset.ratioKey!==rk)n.dataset.ratioKey=rk;const pos=`${p.left}|${p.top}|${p.width}|${p.height}|${p.coverHeight}`;if(n._wfPos!==pos){n.style.cssText=`position:absolute;left:${p.left}px;top:${p.top}px;width:${p.width}px;height:${p.height}px;--ui-cover-height:${p.coverHeight}px`;n._wfPos=pos;}return n;});
    reconcileChildren(els.grid,desired);const height=plan.height+'px';if(els.grid._wfHeight!==height){els.grid.style.height=height;els.grid._wfHeight=height;}
    for(const id of cardNodes.keys())if(!keep.has(id))cardNodes.delete(id);
    let captionChanged=false;
    if(captions)for(let i=0;i<desired.length;i++){const p=plan.positions[i],ck=`${p.item.source}:${p.item.id}:${Math.round(p.width)}`;if(captionHeights.has(ck))continue;const body=desired[i].querySelector('.card-body');if(!body)continue;const h=body.offsetHeight+8;captionHeights.set(ck,h);if(h!==66)captionChanged=true;}
    if(captionHeights.size>20000)captionHeights.clear();
    if(captionChanged&&pass<2)return renderWaterfall(true,pass+1);
    markCurrentCard(currentDetailId);stampCreatorFolders();
    if(focused)els.grid.querySelector(`[data-id="${CSS.escape(focused)}"]`)?.focus({preventScroll:true});
    return true;
  }
  function fluid(container){
    let marker,animation;
    container.addEventListener('click',e=>{
      const selected=e.target.closest('button');if(!selected)return;
      const from=(marker?.isConnected?marker:container.querySelector('[aria-pressed=true]'))?.getBoundingClientRect();
      requestAnimationFrame(()=>{const active=container.querySelector('[aria-pressed=true]');if(!active)return;const r=active.getBoundingClientRect(),base=container.getBoundingClientRect();animation?.cancel();marker?.remove();marker=document.createElement('i');marker.className='ui-fluid';marker.style.cssText=`left:${r.left-base.left}px;top:${r.top-base.top}px;width:${r.width}px;height:${r.height}px`;container.prepend(marker);container.classList.add('has-fluid');if(from&&!matchMedia('(prefers-reduced-motion:reduce)').matches){const dx=from.left-r.left;animation=marker.animate([{transform:`translateX(${dx}px) scaleX(${from.width/r.width})`,borderRadius:'12px'},{transform:`translateX(${-dx*.018}px) scaleX(1.03)`,borderRadius:'17px',offset:.72},{transform:'none',borderRadius:'9px'}],{duration:480,easing:'cubic-bezier(.16,1,.3,1)'});}});
    },true);
  }
  function settings(){ window.BunkoPreferences.init(); }
  function init(){
    if(initialized)return;initialized=true;document.body.classList.add('bunko-refined');
    els.grid.addEventListener('load',e=>{const img=e.target;if(img.tagName!=='IMG'||!img.closest('.cover')||!img.naturalWidth)return;const key=img.closest('.card')?.dataset.ratioKey;if(!key)return;if(!matchMedia('(prefers-reduced-motion:reduce)').matches)img.animate([{opacity:.35},{opacity:1}],{duration:110,easing:'ease-out'});const ratio=Math.max(.45,Math.min(2.2,img.naturalHeight/img.naturalWidth));if(Math.abs((coverRatios.get(key)||0)-ratio)<.001)return;coverRatios.set(key,ratio);if(coverRatios.size>20000)coverRatios.delete(coverRatios.keys().next().value);if(!layoutFrame)layoutFrame=requestAnimationFrame(()=>{layoutFrame=0;renderWaterfall();});},true);
    sourceNav=make('nav','ui-sources',document.querySelector('.rail-left'));sourceNav.setAttribute('aria-label','ソース');els.source.hidden=true;
    document.querySelector('.rail-actions').prepend(els.scope);
    const filters=document.querySelector('.filters'),tail=document.querySelector('.filter-tail');
    const rail=document.querySelector('.rail'),topbar=document.createElement('div');topbar.className='ui-topbar';rail.before(topbar);topbar.append(rail,filters);
    viewNav=document.createElement('nav');viewNav.className='ui-views';els.types.after(viewNav);tail.before(els.resultInfo);
    periodNav=make('nav','ui-periods',tail);pixivFilters=make('div','ui-pixiv-filters',tail);
    sortTrigger=make('button','ui-sort-trigger',tail);sortTrigger.type='button';sortTrigger.setAttribute('aria-label','並び順');els.sort.hidden=true;els.sortDir.parentElement.hidden=true;
    tail.append(document.querySelector('.zoom-ctrl'),document.querySelector('.tail-tools'));
    rankNav=make('nav','ui-ranks',filters);rankNav.setAttribute('aria-label','ランキングの種類');
    sortMenu=make('section','ui-popover ui-sort-menu',document.body);sortMenu.hidden=true;sortMenu.setAttribute('aria-label','並び順');
    displayMenu=make('section','ui-popover ui-display-menu',document.body);displayMenu.hidden=true;displayMenu.setAttribute('aria-label','表示設定');
    sortTrigger.addEventListener('click',()=>{sync();popover(sortMenu,sortTrigger);});
    sortMenu.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.sort){chooseSort(b.dataset.sort);sortMenu.hidden=true;}else if(b.dataset.uiValue!==sortDirValue()){els.sortDir.click();sync();}});
    sourceNav.addEventListener('click',e=>{const b=e.target.closest('[data-ui-value]');if(b)chooseSource(b.dataset.uiValue);});
    viewNav.addEventListener('click',e=>{const b=e.target.closest('[data-ui-value]');if(!b)return;if(state.source==='pixiv'&&!libraryScope()){switchPixivTab(b.dataset.uiValue);return;}view=b.dataset.uiValue;const id=({creators:'today',posts:'added',ranking:'today',search:'added'})[view]||view;if(view==='ranking'||view==='recommended'){els.query.value='';state.query='';if(state.type==='manga-r18')state.type='manga';}chooseSort(id);});
    for(const nav of [periodNav,rankNav])nav.addEventListener('click',e=>{
      const b=e.target.closest('[data-ui-value]');if(!b)return;
      if(nav===periodNav&&state.source==='pixiv'&&!libraryScope()&&inferView()==='search'){
        state.pixivPeriod=b.dataset.uiValue;persistSession();runSearch({reset:true});sync();
      }else chooseSort(b.dataset.uiValue);
    });
    pixivFilters.addEventListener('click',e=>{const b=e.target.closest('[data-ui-value]');if(!b)return;let {kind,r18:adult}=pixivTypeParts(state.type);if(b.dataset.uiValue==='kind')kind=({'':'manga',manga:'ai'})[kind]||'';else adult=!adult;if(inferView()==='ranking'&&kind==='manga'){adult=false;if(['rookie','original','male','female'].includes(state.sort))state.sort='today';}if(inferView()==='ranking'&&kind==='ai')state.sort='today';state.type=pixivTypeId({kind,r18:adult});renderTypes();persistSession();runSearch({reset:true});sync();});
    // The existing handler cycles none → dupes → owned, retaining all three filters.
    function displayContents(){
      displayMenu.innerHTML=`<h3>表示設定</h3><div role="group" aria-label="レイアウト">${[['flow','ウォーターフォール'],['grid','整列グリッド']].map(([id,label])=>`<button type="button" class="display-choice" role="radio" data-layout="${id}" aria-checked="${(state.settings.uiLayout||'flow')===id}">${layoutIcons[id]}<span>${label}</span><span class="menu-check">${(state.settings.uiLayout||'flow')===id?'✓':''}</span></button>`).join('')}</div><hr>${(()=>{const page=typeof coverPageKey==='function'?coverPageKey():'';const where=typeof coverPageLabel==='function'?coverPageLabel(page):'';const value=coverSize();return `<label class="size-label" for="ui-cover-size">表紙の大きさ${where?`<small>${where}</small>`:''}<output>${value}</output></label><input id="ui-cover-size" type="range" min="${window.hitomi.remote?48:120}" max="240" step="4" value="${value}" data-setting="uiCoverSizes" data-page="${page}" aria-label="表紙の大きさ${where?` (${where})`:''}">`;})()}<hr><label><input type="checkbox" data-setting="uiCaptions" ${state.settings.uiCaptions!==false?'checked':''}>タイトル・作者を表示</label><label><input type="checkbox" data-setting="uiFit" ${state.settings.uiFit?'checked':''}>整列グリッドで表紙全体を表示</label><label><input type="checkbox" data-setting="loupeEnabled" ${loupeEnabled()?'checked':''}>ホバーで作品の中身を閲覧</label><hr><button type="button" class="display-reset">表示を初期状態に戻す</button>`;
    }
    els.zoomCycle.addEventListener('click',e=>{e.stopImmediatePropagation();displayContents();popover(displayMenu,els.zoomCycle);els.zoomCycle.setAttribute('aria-expanded',String(!displayMenu.hidden));},true);
    displayMenu.addEventListener('click',async e=>{const layout=e.target.closest('[data-layout]'),reset=e.target.closest('.display-reset');if(!layout&&!reset)return;const patch=reset?{uiLayout:'flow',uiCoverSize:window.hitomi.remote?104:152,uiCoverSizes:{},uiCaptions:true,uiFit:false,loupeEnabled:true}:{uiLayout:layout.dataset.layout};if(await saveSetting(patch,{announce:false})){if(state.zoom===0)applyZoom(3,false);sync();applyLayout();displayContents();}});
    displayMenu.addEventListener('input',e=>{if(e.target.type!=='range')return;const page=e.target.dataset.page;if(page&&typeof setCoverSize==='function')setCoverSize(page,Number(e.target.value));else state.settings.uiCoverSize=Number(e.target.value);displayMenu.querySelector('output').textContent=e.target.value;applyLayout();});
    els.zoomCycle.title='表示設定';els.zoomCycle.setAttribute('aria-label','表示設定');
    displayMenu.addEventListener('change',async e=>{const key=e.target.name==='ui-layout'?'uiLayout':e.target.dataset.setting;if(!key)return;const value=e.target.dataset.page?{...(state.settings.uiCoverSizes||{})}:e.target.type==='checkbox'?e.target.checked:e.target.type==='range'?Number(e.target.value):e.target.value;if(await saveSetting({[key]:value},{announce:false})){if(key==='loupeEnabled'){fillLoupeToggle();hideLoupe(true);}sync();applyLayout();}});
    const queueClose=make('button','ghost iconbtn',document.querySelector('#queue .queue-tools'));queueClose.innerHTML=ICON.close;queueClose.setAttribute('aria-label','ダウンロードを閉じる');queueClose.onclick=()=>els.queue.hidden=true;
    document.getElementById('clear-finished').innerHTML=ICON.trash;
    const queueButton=document.getElementById('btn-queue');queueButton.querySelector('svg')?.remove();queueButton.insertAdjacentHTML('afterbegin',window.BunkoIcons.download);
    const count=document.getElementById('queue-count');const updateCount=()=>count.hidden=Number(count.textContent)===0;new MutationObserver(updateCount).observe(count,{childList:true,characterData:true,subtree:true});updateCount();
    const queueEmpty=make('p','ui-queue-empty',els.queue);queueEmpty.textContent='ダウンロードはありません';
    const updateQueue=()=>{queueEmpty.hidden=state.downloads.length>0;document.getElementById('cancel-all').disabled=!state.downloads.some(job=>['queued','running'].includes(job.status));};
    const queueWatch=new MutationObserver(updateQueue);queueWatch.observe(els.jobs,{childList:true});queueWatch.observe(els.jobsDone,{childList:true});updateQueue();
    document.addEventListener('pointerdown',e=>{if(!sortMenu.contains(e.target)&&!sortTrigger.contains(e.target))sortMenu.hidden=true;if(!displayMenu.contains(e.target)&&!els.zoomCycle.contains(e.target))displayMenu.hidden=true;});
    document.addEventListener('keydown',e=>{if(e.key==='Escape'&&(!sortMenu.hidden||!displayMenu.hidden)){e.stopImmediatePropagation();sortMenu.hidden=true;displayMenu.hidden=true;return;}if(e.isComposing||e.repeat||e.ctrlKey||e.metaKey||e.altKey||isTypingGlobal()||Reader.isOpen()||!els.settings.hidden||!els.help.hidden||!els.pawLink.hidden||document.querySelector('dialog[open]'))return;const id=BunkoUIModel.sourceShortcut(e.key,state.source);if(id){e.preventDefault();e.stopImmediatePropagation();chooseSource(id);}},true);
    for(const n of [sourceNav,periodNav,viewNav,rankNav])fluid(n);
    new ResizeObserver(updateTopbar).observe(topbar);
    settings();els.setLoupe.closest('.set-row').hidden=true;sync();applyLayout();
  }
  function revealResults(){
    if(matchMedia('(prefers-reduced-motion:reduce)').matches)return;
    resultAnimation?.cancel();
    resultAnimation=els.grid.animate([{opacity:.55,transform:'translateY(3px)'},{opacity:1,transform:'none'}],{duration:130,easing:'cubic-bezier(.2,.7,.2,1)'});
  }
  // coverRatio: 一覧で覚えた表紙の縦横比 (Home の作者頁の流しが先に使う。同じ絵を二度待たない)
  return {init,sync,renderWaterfall,revealResults,coverRatio:key=>coverRatios.get(key)};
})();
