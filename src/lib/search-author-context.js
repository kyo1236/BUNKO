'use strict';
const { tokenizeQuery, parseTypePrefix } = require('./search-type');

// Only existing user-confirmed folder bindings establish cross-site identity.
// Numeric ID equality and display-name equality are not identity evidence.
function searchAuthorContext(query, from, { pixiv = {}, pawchive = {}, label = () => '', describe = () => null, creatorName = () => '', intent, selections, target, resolve } = {}) {
  const links = {}, labels = {}, pixivAuthors = {}, vocabulary = {}, creatorQueries = {};
  for (const token of tokenizeQuery(query).slice(0, 64)) {
    const typed = parseTypePrefix(token);
    const description=describe(token);
    if(description) vocabulary[token]=description;
    if (typed) {
      const value = label(typed.type, typed.name);
      if (value) labels[typed.token] = value;
    }
    const px = from === 'pixiv' && /^user:(\d+)$/.exec(token);
    const pw = from === 'pawchive' && /^(\w+)\/([^/\s]+)$/.exec(token);
    if (pw) {
      const name=creatorName(pw[1],pw[2]);
      if(name) {
        creatorQueries[`${from}:${token}`]=name;
        const info=describe(`artist:${name.replace(/\s+/g,'_')}`);
        if(info) vocabulary[token]=info;
      }
    }
    const folder = px ? pixiv[px[1]]?.folderId : pw ? pawchive[`${pw[1]}:${pw[2]}`] : '';
    if (px && pixiv[px[1]]?.name) {
      const name=pixiv[px[1]].name;
      pixivAuthors[px[1]]=name;
      const info=describe(`artist:${name.replace(/\s+/g,'_')}`);
      if(info) vocabulary[token]=info;
    }
    if (!folder) continue;
    const destinations = {};
    const pxMatches = Object.entries(pixiv).filter(([id, row]) => /^\d+$/.test(id) && row?.folderId === folder);
    const pwMatches = Object.entries(pawchive).filter(([id, value]) => value === folder && /^\w+:[^:\s/]+$/.test(id));
    if (pxMatches.length === 1) destinations.pixiv = `user:${pxMatches[0][0]}`;
    if (pwMatches.length === 1) destinations.pawchive = pwMatches[0][0].replace(':', '/');
    if (Object.keys(destinations).length) links[`${from}:${token}`] = destinations;
  }
  const context={ links, labels, pixivAuthors, vocabulary, creatorQueries };
  if(target && resolve) {
    const model=intent?.terms ? intent : require('./search-intent').parse(query,from,{...context,selections});
    context.target=target;context.resolutions={};
    for(const term of model.terms.slice(0,64)) {
      if(!term || typeof term.raw!=='string') continue;
      context.resolutions[`${term.source}:${term.raw}`]=resolve({...term,...term.origin},target);
    }
  }
  return context;
}
module.exports = { searchAuthorContext };
