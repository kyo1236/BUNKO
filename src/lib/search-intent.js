// Lossless terms retained across sites; native query strings are only projections.
(() => {
'use strict';
const node = typeof module !== 'undefined' && module.exports;
const {tokenizeQuery,parseTypePrefix} = node ? require('./search-type') : window.BunkoSearchType;
const {registry} = node ? require('./search-providers') : window.BunkoSearchProviders;
const atom = name => String(name || '').trim().replace(/\s+/g,'_');
const quote = name => /\s/.test(name) ? JSON.stringify(name) : name;
function parse(query, source, context = {}, providers = registry) {
  const tokens=tokenizeQuery(query), combined=[];
  for(let i=0;i<tokens.length;i++) {
    let end=i+1;
    for(let j=tokens.length;j>i+1;j--) if(context.selections?.[`${source}:${tokens.slice(i,j).join(' ')}`]) {end=j;break;}
    combined.push(tokens.slice(i,end).join(' '));i=end-1;
  }
  return {version:1, source, query:String(query || '').trim(), terms:combined.map(raw => {
    const selection=context.selections?.[`${source}:${raw}`];
    if (selection?.name) return {kind:selection.type==='artist'?'author':'tag',type:selection.type,name:selection.name,label:selection.label,raw,source,negative:raw.startsWith('-'),native:{...selection.native}};
    const typed = parseTypePrefix(raw);
    const native = providers.get(source)?.identity;
    const identity = native && new RegExp(native).test(raw);
    const name = context.creatorQueries?.[`${source}:${raw}`] || (source==='pixiv' && context.pixivAuthors?.[raw.slice(5)]);
    if (identity) return {kind:'author',type:'artist',name:name || '',raw,source,negative:false,native:{[source]:raw}};
    if (typed) return {kind:typed.type==='artist'?'author':'tag',type:typed.type,name:typed.name,raw,source,negative:typed.negative,native:{}};
    if (/^(?:https?:\/\/|folder:|-?(?:user|exact|since|until|date|id|bm|bookmarks):)/i.test(raw) || /^\d{3,}$/.test(raw) || /^[\w.-]+\/[^\s/]+(?:\/[^\s/]+)?$/.test(raw)) return {kind:'native',raw,source,native:{[source]:raw}};
    return {kind:'text',name:raw,raw,source,native:{}};
  }).map(term=>({...term,origin:{type:term.type,name:term.name,label:term.label}}))};
}
function enrich(intent, context = {}) {
  return {...intent,terms:intent.terms.map(term => {
    const next = {...term,native:{...term.native},resolutions:{...term.resolutions}};
    const resolution=context.resolutions?.[`${term.source}:${term.raw}`];
    if(resolution && context.target) next.resolutions[context.target]=resolution;
    const token = `${term.negative?'-':''}${term.type}:${atom(term.name)}`;
    const vocab = context.vocabulary?.[token] || context.vocabulary?.[term.raw];
    if (vocab && term.kind!=='text' && term.kind!=='native') { next.name=vocab.name || next.name; next.type=vocab.type || next.type; next.kind=next.type==='artist'?'author':'tag'; next.label=vocab.label || next.label; next.aliases=vocab.aliases || next.aliases; }
    next.label = context.labels?.[token] || next.label;
    for (const [site,value] of Object.entries(next.native)) {
      const name=context.creatorQueries?.[`${site}:${value}`] || (site==='pixiv' && context.pixivAuthors?.[value.slice(5)]);
      if (!next.name && name) next.name=name;
      Object.assign(next.native,context.links?.[`${site}:${value}`] || {});
    }
    return next;
  })};
}
function compile(intent, target, context = {}, providers = registry) {
  const model=enrich(intent,context), provider=providers.get(target), kept=[], unsupported=[], unresolved=[];
  for (const term of model.terms) {
    if (term.native[target] && !term.negative) {kept.push(term.native[target]);continue;}
    if (term.kind==='native') {unsupported.push(term.raw);continue;}
    if (term.kind==='text') {kept.push(term.name);continue;}
    if (provider?.tagsRequireAuthor && term.kind==='tag' && !model.terms.some(t=>t.kind==='author' && !t.negative)) {unsupported.push(term.raw);continue;}
    const resolution=term.resolutions?.[target];
    if(resolution && ['unmapped','ambiguous','unavailable'].includes(resolution.status)) {
      unresolved.push({raw:term.raw,...resolution});kept.push(term.raw);continue;
    }
    const effective=resolution?.status==='resolved' ? {...term,...resolution.value} : term;
    const mapping=provider?.namespaces?.[effective.type];
    if (mapping===undefined || !effective.name || (term.negative && term.kind==='author' && provider.authorCandidates)) {unsupported.push(term.raw);continue;}
    let name=provider.translatedLabels && effective.label ? effective.label : effective.name;
    if(provider.lowerCase) name=name.toLowerCase();
    const sign=term.negative?'-':'';
    kept.push(mapping ? `${sign}${mapping}:${atom(name)}` : `${sign}${provider.barePhrases ? name : quote(name)}`);
  }
  return {intent:model,query:kept.join(' '),dropped:unsupported,unresolved,blocked:unresolved.length>0 || (!!model.terms.length && !kept.length)};
}
// Adapter boundary: every selectable item has a nonempty value and semantic term.
function normalizeSuggestions(items, source) {
  return (Array.isArray(items)?items:[]).flatMap(item => {
    if (!item || typeof item!=='object') return [];
    const name=String(item.name || item.label || '').trim();
    const type=item.type || 'tag';
    const fallback=source==='pixiv' && type!=='artist' ? name : `${type}:${atom(name)}`;
    const value=typeof item.value==='string' && item.value.trim() ? item.value.trim() : name ? fallback : '';
    if (!value || value==='undefined') return [];
    const metric=item.metric?.site===source && Number.isFinite(item.metric.value) && item.metric.value>=0 ? item.metric : null;
    return [{...item,name,value,label:String(item.label || name || value),metric,count:metric?.value??null,term:{type,name,label:String(item.label || name),native:{[source]:value}}}];
  });
}
// Full untyped phrases are candidates too (e.g. a two-word creator name).
function completionRanges(query) {
  const text=String(query || '').trimEnd();
  const tokens=[...text.matchAll(/(?:[^\s"]+|"[^"]*")+/g)];
  if (!tokens.length) return [];
  const last=tokens[tokens.length-1], ranges=[{text:last[0],start:last.index,end:text.length}];
  if(tokens.length>1 && tokens.every(t=>!t[0].includes(':') && !t[0].startsWith('-'))) return [{text:text.trim(),start:text.search(/\S/),end:text.length}];
  return ranges;
}
function authorNames(intent) {
  const author=intent?.terms?.find(term=>term.kind==='author' && !term.negative);
  if(!author) return [];
  return [...new Set([author.name,author.label,...(author.aliases || [])].filter(value=>typeof value==='string' && value.trim()).map(value=>value.replace(/_/g,' ').trim()))].slice(0,3);
}
const api={parse,enrich,compile,normalizeSuggestions,completionRanges,authorNames};
if (node) module.exports=api; else window.BunkoSearchIntent=api;
})();
