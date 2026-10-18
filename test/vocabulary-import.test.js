'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {importReviewed}=require('../scripts/import-search-vocabulary');
test('bulk import requires independent acceptance, exact target evidence and provenance',()=>{
 const rows=[
 {id:1,type:'female',canonical:'sample',input:'見本',translation:'human',claude:'accept',parent:'accept'},
 {id:2,type:'female',canonical:'other',input:'他',translation:'human',claude:'accept',parent:'exclude'},
 {id:3,type:'female',canonical:'absent',input:'未確認',translation:'human',claude:'accept',parent:'accept'},
 ];
 const evidence=['female','male'].map(type=>({type,name:'sample',status:200,exact:[{type,name:'sample'}],url:`https://example.test/${type}`,checkedAt:'2026-09-21'}));
 const result=importReviewed({base:{entries:[]},rows,evidence,sources:[{file:'danbooru-jp.csv',url:'https://example.test/dictionary',sha256:'abc',checkedAt:'2026-09-21'}],describe:()=>null});
 assert.equal(result.data.entries.length,1);
 assert.equal(result.data.entries[0].outputs.hitomi.type,'either');
 assert.deepEqual(result.skipped,[{id:3,reason:'target not verified'}]);
 assert.equal(result.data.entries[0].evidence.length,3);
 assert.equal(result.data.entries[0].review.parentReviewed,true);
});

test('shipped user regression resolves both directions and local completion uses the same data',()=>{
 const vocab=require('../src/lib/search-vocabulary'),aliases=require('../src/lib/search-aliases');
 const term={kind:'tag',type:'tag',source:'pixiv',name:'おしっこ',native:{pixiv:'おしっこ'}};
 const result=vocab.resolve(term,'hitomi');
 assert.equal(result.status,'resolved');assert.equal(result.value.type,'either');assert.equal(result.value.name,'urination');
 assert.equal(vocab.resolve({kind:'tag',type:'either',source:'hitomi',name:'urination'},'pixiv').value.name,'おしっこ');
 assert.ok(aliases.suggestAliases('おしっこ').some(row=>row.value==='either:urination'));
 assert.equal(vocab.resolve({...term,name:'黒髪眼鏡'},'hitomi').status,'ambiguous');
});
