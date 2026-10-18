// Search syntax belongs to providers, not to pairs of sites.
(() => {
'use strict';
const common = {artist:'artist',group:'group',character:'character',language:'language',tag:'tag'};
const definitions = {
  hitomi: {label:'hitomi', lowerCase:true, namespaces:{...common,series:'series',type:'type',male:'male',female:'female',either:'either'}},
  nhentai: {label:'nhentai', lowerCase:true, namespaces:{...common,series:'parody',type:'',male:'tag',female:'tag',either:'tag'}},
  ehentai: {label:'E-Hentai', lowerCase:true, namespaces:{...common,series:'parody',type:'',male:'male',female:'female',either:'tag'}},
  pawchive: {label:'pawchive', tagsRequireAuthor:true, namespaces:{artist:'artist',tag:'tag',series:'tag',character:'tag',male:'tag',female:'tag',either:'tag'}, identity:'^(\\w+)/([^/\\s]+)$', authorCandidates:true},
  pixiv: {label:'pixiv', barePhrases:true, namespaces:{artist:'artist',tag:'',series:'',character:'',male:'',female:'',either:''}, identity:'^user:(\\d+)$', authorCandidates:true, translatedLabels:true},
};
function createRegistry(initial = definitions) {
  const entries = new Map(Object.entries(initial));
  return {
    get: id => entries.get(id),
    list: () => [...entries].map(([id, value]) => ({id,...value})),
    register(id, spec) { if (!id || !spec?.namespaces) throw new Error('Invalid search provider'); entries.set(id,spec); },
    remove: id => entries.delete(id),
  };
}
const registry = createRegistry();
const api = {definitions,createRegistry,registry};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else window.BunkoSearchProviders = api;
})();
