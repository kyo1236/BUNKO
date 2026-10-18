(function(root,factory){const model=factory();if(typeof module==='object')module.exports=model;else root.BunkoUIModel=model;})(typeof globalThis!=='undefined'?globalThis:this,()=>{
  function sourceShortcut(key,current){return {h:'hitomi',n:'nhentai',e:'ehentai',p:current==='pawchive'?'pixiv':'pawchive'}[String(key).toLowerCase()]||null;}
  function waterfall(items,{width,min=152,gap=20,caption=68,scroll=0,viewport=900,overscan=600,ratioFor=()=>null,captionFor=null}){
    const columns=Math.max(1,Math.floor((width+gap)/(min+gap))),cardWidth=(width-gap*(columns-1))/columns;
    const heights=Array(columns).fill(0),positions=[];
    for(const item of items){const lowest=Math.min(...heights),column=heights.findIndex(height=>height<=lowest+cardWidth*.12);const ratio=ratioFor(item)||(item.width&&item.height?Math.max(.45,Math.min(2.2,item.height/item.width)):item.shape==='wide'?.707:1.414);
      const height=cardWidth*ratio+(captionFor?captionFor(item,cardWidth):caption),top=heights[column];heights[column]+=height+gap;
      if(top+height>=scroll-overscan&&top<=scroll+viewport+overscan)positions.push({item,left:column*(cardWidth+gap),top,width:cardWidth,height,coverHeight:cardWidth*ratio});
    }
    return {positions,height:Math.max(0,...heights)- (items.length?gap:0),columns};
  }
  return {sourceShortcut,waterfall};
});
