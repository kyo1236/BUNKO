'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const engine=require('../src/lib/search-intent');
const {createRegistry}=require('../src/lib/search-providers');
const {portQuery}=require('../src/lib/sources/query-port');

test('provider roundtrip preserves typed tags, exclusions and identities through an unsupported site',()=>{
  const intent=engine.parse('artist:example_name female:sample -tag:night language:japanese','hitomi');
  const paw=engine.compile(intent,'pawchive');
  assert.equal(paw.query,'artist:example_name tag:sample -tag:night');
  assert.deepEqual(paw.dropped,['language:japanese']);
  const px=engine.compile(paw.intent,'pixiv');
  assert.equal(px.query,'artist:example_name sample -night');
  assert.equal(engine.compile(px.intent,'hitomi').query,'artist:example_name female:sample -tag:night language:japanese');
});

test('a selected creator carries a name as well as a provider identity on every hop',()=>{
  const [item]=engine.normalizeSuggestions([{type:'artist',name:'Example Name',value:'fanbox/123'}],'pawchive');
  const intent=engine.parse('fanbox/123 winter','pawchive',{selections:{'pawchive:fanbox/123':item.term}});
  const hitomi=engine.compile(intent,'hitomi');
  assert.equal(hitomi.query,'artist:example_name winter');
  assert.equal(engine.compile(hitomi.intent,'pawchive').query,'fanbox/123 winter');
  assert.equal(engine.compile(hitomi.intent,'pixiv').query,'artist:Example_Name winter');
});

test('known labels affect pixiv without erasing canonical names used by other providers',()=>{
  const intent=engine.parse('artist:example_name tag:blue_sky','hitomi');
  const context={labels:{'artist:example_name':'見本作者','tag:blue_sky':'青空'}};
  const px=engine.compile(intent,'pixiv',context);
  assert.equal(px.query,'artist:見本作者 青空');
  assert.equal(engine.compile(px.intent,'pawchive').query,'artist:example_name tag:blue_sky');
});

test('a new provider is registered without adding source-pair conversions',()=>{
  const providers=createRegistry();
  providers.register('sample',{label:'Sample',namespaces:{artist:'creator',tag:'topic'}});
  const intent=engine.parse('artist:example_name tag:sky','hitomi');
  assert.equal(engine.compile(intent,'sample',{},providers).query,'creator:example_name topic:sky');
  providers.remove('sample');
  assert.equal(engine.compile(intent,'sample',{},providers).blocked,true);
});

test('missing suggestion values are normalized, empty or invalid candidates rejected',()=>{
  const items=engine.normalizeSuggestions([{type:'tag',name:'two words'},null,{}, {value:'undefined'}],'pixiv');
  assert.equal(items.length,1);assert.equal(items[0].value,'two words');
  const intent=engine.parse(items[0].value,'pixiv',{selections:{'pixiv:two words':items[0].term}});
  assert.equal(intent.terms.length,1);
  assert.equal(engine.compile(intent,'nhentai').query,'tag:two_words');
  const pixiv=require('../src/lib/sources/pixiv');
  assert.equal(pixiv.parseQuery(items[0].value).exact,false,'a multiword suggestion must not switch to exact-tag mode');
});

test('completion ranges consume the entire free phrase or one quoted typed token',()=>{
  assert.deepEqual(engine.completionRanges('example name')[0],{text:'example name',start:0,end:12});
  assert.deepEqual(engine.completionRanges('winter artist:"example name"'),[{text:'artist:"example name"',start:7,end:28}]);
});

test('unportable identities never trigger broad search or turn into another site ID',()=>{
  const intent=engine.parse('fanbox/123','pawchive');
  const out=engine.compile(intent,'hitomi');
  assert.equal(out.blocked,true);assert.equal(out.query,'');
  assert.equal(engine.compile(out.intent,'pawchive').query,'fanbox/123');
  assert.equal(engine.compile(engine.parse('tag:sky','hitomi'),'pawchive').blocked,true,'Pawchive has no global tag index');
});

test('late verified author context enriches the retained intent without guessing numeric identities',()=>{
  const initial=portQuery('user:77 winter','pixiv','pawchive',{retainIntent:true});
  const out=portQuery('user:77 winter','pixiv','pawchive',{retainIntent:true,intent:initial.intent,links:{'pixiv:user:77':{pawchive:'patreon/88'}},pixivAuthors:{77:'Example'}});
  assert.equal(out.query,'patreon/88 winter');
  assert.equal(engine.compile(out.intent,'hitomi').query,'artist:example winter');
});

test('the real sources suggestion boundary guarantees the renderer contract',async()=>{
  require('./helpers/stub-electron');
  const sources=require('../src/lib/sources');
  const restore=sources._setAdapterForTest('pixiv',{suggestTags:async()=>[{type:'tag',name:'見本'}]});
  try {const rows=await sources.suggestTags('見本','pixiv');assert.equal(rows[0].value,'見本');assert.equal(rows[0].term.type,'tag');}
  finally {restore();}
});

test('free text remains free text even when it has a dictionary meaning',()=>{
  const intent=engine.parse('winter','hitomi'),context={vocabulary:{winter:{type:'tag',name:'winter',label:'冬'}}};
  assert.equal(engine.compile(intent,'pawchive',context).query,'winter');
  assert.equal(engine.compile(engine.compile(intent,'pixiv',context).intent,'hitomi').query,'winter');
});
