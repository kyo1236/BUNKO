'use strict';
// Offline import: model decisions alone never authorize an entry. Requires a
// parent accept decision and a successful exact match from the public index.
const fs=require('node:fs');
const {aliasKey}=require('../src/lib/search-text');

function importReviewed({base,rows,evidence,sources,describe}) {
  const entries=base.entries.filter(row=>!row.id.startsWith('booru-'));
  const grouped=new Map(), skipped=[];
  const proof=(type,name)=>evidence.find(row=>row.type===type&&row.name===name&&row.status===200&&row.exact?.some(hit=>hit.type===type&&hit.name===name));
  for(const row of rows) {
    if(row.claude!=='accept'||row.parent!=='accept')continue;
    const name=row.canonical.replace(/_/g,' '), target=proof(row.type,name);
    if(!target){skipped.push({id:row.id,reason:'target not verified'});continue;}
    const female=proof('female',name),male=proof('male',name);
    const type=['female','male'].includes(row.type)&&female&&male?'either':row.type;
    const key=type+':'+name;
    let entry=grouped.get(key);
    if(!entry) {
      const previous=describe(`${row.type}:${row.canonical}`);
      // One old alias incorrectly attached Levi Ackerman's name to Levi Elipha.
      const label=row.id===534?row.input:(previous?.label || row.input);
      const nhType=['female','male','either'].includes(type)?'tag':type;
      entry={id:`booru-${type}-${row.canonical}`,inputs:[],outputs:{hitomi:{type,name,label},pixiv:{type:'tag',name:label,label},nhentai:{type:nhType,name,label}},evidence:[],review:{model:'claude-sonnet-5',parentReviewed:true,candidateIds:[]}};
      for(const item of type==='either'?[female,male]:[target]) entry.evidence.push({url:item.url,checkedAt:item.checkedAt,method:'tagindex-exact'});
      grouped.set(key,entry);
    }
    if(!entry.inputs.some(input=>aliasKey(input.name)===aliasKey(row.input)))entry.inputs.push({site:'pixiv',type:'tag',name:row.input,relation:'exact'});
    entry.review.candidateIds.push(row.id);
    const source=sources.find(source=>source.file===(row.translation==='human'?'danbooru-jp.csv':'danbooru-machine-jp.csv'));
    if(!source)throw Error('Missing translation provenance');
    if(!entry.evidence.some(item=>item.url===source.url))entry.evidence.push({url:source.url,sha256:source.sha256,checkedAt:source.checkedAt,method:`public-${row.translation}-translation; model-and-parent-reviewed`,license:'MIT'});
  }
  return {data:{...base,revision:'2026-09-21-vocabulary-2',sources,entries:[...entries,...grouped.values()]},skipped};
}

if(require.main===module) {
  const dir=process.argv[2];if(!dir)throw Error('Usage: node scripts/import-search-vocabulary.js <review-directory>');
  const read=name=>JSON.parse(fs.readFileSync(`${dir}/${name}`,'utf8'));
  const target='src/lib/data/search-vocabulary.json';
  const result=importReviewed({base:JSON.parse(fs.readFileSync(target)),rows:read('parent-audit.json'),evidence:read('tagindex-evidence.json'),sources:read('sources.json'),describe:require('../src/lib/search-aliases').describeTerm});
  fs.writeFileSync(target,JSON.stringify(result.data,null,2)+'\n');
  console.log(JSON.stringify({entries:result.data.entries.length,inputs:result.data.entries.reduce((n,x)=>n+x.inputs.length,0),skipped:result.skipped}));
}
module.exports={importReviewed};
