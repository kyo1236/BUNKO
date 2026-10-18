'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const engine=require('../src/lib/search-intent');
const {loadInVm}=require('./helpers/vm-dom');
const {portQuery}=require('../src/lib/sources/query-port');

function app(context) {
 const searches=[];
 const hitomi={portQuery,searchAuthorContext:context,saveSettings:async()=>{},cancelSearch:async()=>{},
 search:async p=>{searches.push(p.query);return {galleries:[],total:0,hasNext:false};}};
 const ctx=loadInVm('src/renderer/app.js',{globals:{hitomi}});
 const {state,els}=ctx.__harness;
 state.source='pixiv';state.scope='all';state.sort='added';state.settings={};ctx.renderGrid=()=>{};
 ctx.bindSearchControls();
 return {ctx,state,els,searches,change:async(source)=>{els.source.value=source;await Promise.all(els.source.__listeners.get('change').map(fn=>fn({})));}};
}

test('unknown selected tag blocks search including partial queries while retaining the origin',()=>{
 const [item]=engine.normalizeSuggestions([{type:'tag',name:'未対応の見本'}],'pixiv');
 const original=engine.parse('未対応の見本 winter','pixiv',{selections:{'pixiv:未対応の見本':item.term}});
 const plan=engine.compile(original,'hitomi',{target:'hitomi',resolutions:{'pixiv:未対応の見本':{status:'unmapped'}}});
 assert.equal(plan.blocked,true);assert.equal(plan.unresolved.length,1);assert.equal(plan.query,'未対応の見本 winter');
 assert.equal(engine.compile(plan.intent,'pixiv').query,'未対応の見本 winter');
});

test('late vocabulary is applied before search and survives roundtrips',async()=>{
 const h=app(async p=>({target:p.to,resolutions:{'pixiv:見本':{status:'resolved',value:{type:'either',name:'sample',label:'見本'}}}}));
 h.state.query=h.ctx.tagQuery({type:'tag',name:'見本'},{source:'pixiv'});
 await h.change('hitomi');assert.equal(h.state.query,'either:sample');assert.deepEqual(h.searches,['either:sample']);
 await h.change('pixiv');assert.equal(h.state.query,'見本');
 await h.change('hitomi');assert.equal(h.state.query,'either:sample');h.ctx.__stopTimers();
});

test('unmapped tag and failed context never silently run a partial or untranslated search',async()=>{
 for(const fail of [false,true]) {
 const h=app(async p=>{if(fail)throw Error('offline');return {target:p.to,resolutions:{'pixiv:見本':{status:'unmapped'}}};});
 h.state.query=h.ctx.tagQuery({type:'tag',name:'見本'},{source:'pixiv'});
 await h.change('hitomi');assert.equal(h.searches.length,0);assert.match(h.els.status.textContent,/対応/);
 await h.change('pixiv');assert.equal(h.state.query,'見本');h.ctx.__stopTimers();
 }
});

test('pixiv suggestions show a single neutral label; metrics require their own site and kind',()=>{
 const h=app(async()=>({}));
 h.ctx.renderSuggest(engine.normalizeSuggestions([{type:'tag',name:'見本',count:990}], 'pixiv'));
 assert.equal((h.els.suggest.innerHTML.match(/見本<\/span>/g)||[]).length,1);
 assert.doesNotMatch(h.els.suggest.innerHTML,/class="kind"|class="count"/);
 h.state.source='hitomi';
 h.ctx.renderSuggest(engine.normalizeSuggestions([{name:'sample',type:'tag',label:'見本',metric:{site:'hitomi',kind:'works',value:0}}],'hitomi'));
 assert.match(h.els.suggest.innerHTML,/>0<\/span>/);
 h.state.source='pawchive';
 h.ctx.renderSuggest(engine.normalizeSuggestions([{name:'Sample',type:'artist',value:'fanbox/77',metric:{site:'pawchive',kind:'favorites',value:4}}],'pawchive'));
 assert.match(h.els.suggest.innerHTML,/お気に入り 4/);
 assert.equal(engine.normalizeSuggestions([{name:'sample',count:10,metric:{site:'hitomi',kind:'works',value:10}}],'nhentai')[0].metric,null);
 h.ctx.__stopTimers();
});

test('ambiguous suggestions replace only their original term, leaving other conditions intact',async()=>{
 const h=app(async p=>({target:p.to,resolutions:{'pixiv:見本':{status:'ambiguous',candidates:[{type:'tag',name:'sample',label:'近いタグ'}]}}}));
 h.state.query=h.ctx.tagQuery({type:'tag',name:'見本'},{source:'pixiv'})+' winter';
 await h.change('hitomi');assert.equal(h.searches.length,0);assert.equal(h.state.suggestItems.length,1);
 h.ctx.acceptSuggestion(h.state.suggestItems[0]);
 assert.equal(h.state.query,'tag:sample winter');assert.deepEqual(h.searches,['tag:sample winter']);h.ctx.__stopTimers();
});

test('late context rejection cannot overwrite a newer site transition',async()=>{
 let rejectFirst;
 const h=app(p=>p.to==='hitomi'?new Promise((resolve,reject)=>{rejectFirst=reject}):Promise.resolve({}));
 h.state.query=h.ctx.tagQuery({type:'tag',name:'見本'},{source:'pixiv'});
 const first=h.change('hitomi');
 await h.change('pixiv');
 rejectFirst(Error('old request failed'));await first;
 assert.equal(h.state.source,'pixiv');assert.equal(h.state.query,'見本');
 await h.ctx.runSearch({reset:true});
 assert.ok(h.searches.length>0);assert.doesNotMatch(h.els.status.textContent,/確認できません/);
 h.ctx.__stopTimers();
});

test('selected negative tags remain exclusions at another site',()=>{
 const model=engine.parse('-either:sample','hitomi',{selections:{'hitomi:-either:sample':{type:'either',name:'sample',native:{hitomi:'-either:sample'}}}});
 assert.equal(engine.compile(model,'nhentai').query,'-tag:sample');
});
