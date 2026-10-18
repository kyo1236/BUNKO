const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');

test('folder selection can be cancelled or staged without saving, while legacy callers still save',async()=>{
  const handlers=new Map(),saved=[];
  let response={canceled:false,filePaths:['C:/chosen.library']};
  const current={eagleLibrary:'C:/existing.library'};
  const ctx={module:{exports:{}},require:id=>id==='electron'?{ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},dialog:{showOpenDialog:async()=>response},shell:{}}:id.includes('paw-cookies')?{}:{allowedHosts:()=>[]}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/main/ipc/settings-ipc.js'),'utf8'),ctx);
  ctx.module.exports.registerSettingsIpc({config:{load:()=>current,save:p=>{saved.push(p);return {...current,...p};}},settingsView:x=>x,getMainWindow:()=>null});
  const choose=handlers.get('choose-folder');
  assert.equal((await choose(null,{kind:'eagle',pickOnly:true})).path,'C:/chosen.library');
  assert.equal(saved.length,0);
  response={canceled:true,filePaths:[]};
  assert.equal((await choose(null,{kind:'eagle',pickOnly:true})).path,null);
  assert.equal(saved.length,0);
  response={canceled:false,filePaths:['C:/chosen.library']};
  assert.equal((await choose(null,'eagle')).eagleLibrary,'C:/chosen.library');
  assert.equal(saved.length,1);
});
