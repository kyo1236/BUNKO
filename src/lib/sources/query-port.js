// Compatibility entry point shared by Electron preload and LAN browser.
// Provider syntax and retained terms have a single owner in search-intent.
(() => {
'use strict';
const node=typeof module!=='undefined' && module.exports;
const engine=node ? require('../search-intent') : window.BunkoSearchIntent;
function portQuery(query,from,to,context={}) {
  const text=String(query || '').trim();
  if(!context.retainIntent && (!text || from===to)) return {query:text,dropped:[]};
  const result=engine.compile(context.intent || engine.parse(text,from,context),to,context);
  return context.retainIntent ? result : {query:result.query,dropped:result.dropped};
}
if(node) module.exports={portQuery}; else window.BunkoQueryPort={portQuery};
})();
