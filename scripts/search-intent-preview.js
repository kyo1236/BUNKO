// Runs the real renderer and suggestion boundary against synthetic provider data.
const fs = require('fs');
const Module = require('module');
const path = require('path');
let source = fs.readFileSync(path.join(__dirname,'lan-desktop-preview.js'),'utf8');
source = source.replace("ipc.handle('suggest', async () => []);", `
const sources = require('../src/lib/sources');
sources._setAdapterForTest('pixiv', {suggestTags: async term => [{type:'tag',name:term,label:term}]});
sources._setAdapterForTest('pawchive', {suggestTags: async term => [{type:'artist',name:'Terasu MC',label:'Terasu MC',value:'fanbox/5678',source:'creator'}]});
sources._setAdapterForTest('hitomi', {suggestTags: async term => [{type:'artist',name:'terasu mc',value:'artist:terasu_mc',label:''}]});
ipc.handle('suggest', async (_,term,site) => sources.suggestTags(term,site));
ipc.handle('search-author-context', async (_,p) => require('../src/lib/search-author-context').searchAuthorContext(p.query,p.from,{target:p.to,intent:p.intent,selections:p.selections,resolve:require('../src/lib/search-vocabulary').resolve,describe:require('../src/lib/search-aliases').describeTerm,pixiv:{1234:{folderId:'fixture-author',name:'見本作家'}},pawchive:{'fanbox:5678':'fixture-author'}}));
`);
const fixture = new Module(path.join(__dirname,'search-fixture.js'),module);
fixture.filename=path.join(__dirname,'search-fixture.js');fixture.paths=module.paths;
fixture._compile(source,fixture.filename);
