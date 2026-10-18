const test=require('node:test');
const assert=require('node:assert/strict');
const {waterfall,sourceShortcut}=require('../src/renderer/bunko-ui-model');
test('source shortcuts distinguish the two p sources and ignore unrelated keys',()=>{
  assert.equal(sourceShortcut('p','pawchive'),'pixiv');assert.equal(sourceShortcut('P','pixiv'),'pawchive');assert.equal(sourceShortcut('h','pixiv'),'hitomi');assert.equal(sourceShortcut('n','hitomi'),'nhentai');assert.equal(sourceShortcut('e','hitomi'),'ehentai');assert.equal(sourceShortcut('Escape','hitomi'),null);
});
test('waterfall positions never overlap and retain order within each column',()=>{
  const items=Array.from({length:80},(_,i)=>({id:i,width:100,height:i%3?145:70}));
  const plan=waterfall(items,{width:1000,viewport:20000});
  assert.equal(plan.positions.length,80);
  for(const a of plan.positions)for(const b of plan.positions)if(a!==b&&a.left===b.left&&a.top<b.top)assert.ok(a.top+a.height<=b.top);
  assert.ok(plan.positions.every(p=>p.left+p.width<=1000));
});
test('waterfall only mounts nearby cards while retaining full scroll extent',()=>{
  const items=Array.from({length:5000},(_,id)=>({id}));
  const top=waterfall(items,{width:1000,scroll:0}),middle=waterfall(items,{width:1000,scroll:15000});
  assert.ok(top.positions.length<70);assert.ok(middle.positions.length<100);assert.equal(top.height,middle.height);assert.ok(middle.positions[0].item.id>100);
  assert.equal(waterfall([],{width:300}).height,0);
});
test('loaded cover ratios determine card height without changing column order',()=>{
  const items=[{id:1},{id:2},{id:3}];
  const plan=waterfall(items,{width:324,min:152,ratioFor:item=>item.id===1?.5:2});
  assert.equal(plan.positions[0].coverHeight,76);
  assert.equal(plan.positions[1].coverHeight,304);
  assert.equal(plan.positions[2].left,0);
  assert.ok(plan.positions[2].top>=plan.positions[0].height);
});

test('waterfall uses measured caption heights without reserving a second title line',()=>{
  const plan=waterfall([{id:1},{id:2},{id:3}],{width:152,min:152,captionFor:item=>item.id===1?32:49});
  assert.equal(plan.positions[0].height-plan.positions[0].coverHeight,32);
  assert.equal(plan.positions[1].height-plan.positions[1].coverHeight,49);
  assert.equal(plan.positions[1].top,plan.positions[0].height+20);
});

test('waterfall fills from the left when columns are almost the same height (no gap left of a nearly equal column)',()=>{
  // 左の二段が一画素だけ高い: 右へ回さず、左から埋める (2026-09-27、左に隙間が残っていた)
  const ratios={1:1.42,2:1.42,3:1.41,4:1.41,5:1.41,6:1.4,7:1.4};
  const plan=waterfall([1,2,3,4,5,6,7].map(id=>({id})),{width:5*152+4*20,min:152,viewport:20000,ratioFor:item=>ratios[item.id]});
  assert.equal(plan.positions[5].left,0,'六冊目は左端の段へ');
  assert.ok(plan.positions[6].left>0&&plan.positions[6].left<200,'七冊目は二段目へ');
});
