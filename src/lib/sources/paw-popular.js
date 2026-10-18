const decode = text => String(text).replace(/<[^>]*>/g, '').replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (_, code) => {
  if(code[0]==='#'){const n=code[1].toLowerCase()==='x'?parseInt(code.slice(2),16):Number(code.slice(1));return n>0&&n<=0x10ffff?String.fromCodePoint(n):'';}
  return {amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',nbsp:' '}[code.toLowerCase()];
}).replace(/\s+/g,' ').trim();
function parsePopular(html){
  const posts=[];
  for(const m of html.matchAll(/<article\b([^>]*)>([\s\S]*?)<\/article>/gi)){
    const attr=name=>m[1].match(new RegExp(`\\b${name}=["']([^"']+)["']`))?.[1];
    const id=attr('data-id'),service=attr('data-service'),user=attr('data-user');
    if(!id||!service||!user)continue;
    const body=m[2],src=body.match(/<img\b[^>]*src=["']([^"']+)["']/i)?.[1]||'';
    const path=src.match(/\/thumbnail\/data([^?"']+)/)?.[1];
    posts.push({id,service,user,title:decode(body.match(/<header\b[^>]*>([\s\S]*?)<\/header>/i)?.[1]||id),published:body.match(/datetime=["']([^"']+)/)?.[1]||null,file:path?{path,name:path.split('/').pop()}:null});
  }
  if(!posts.length&&!/paginator|No posts|No results/i.test(html))throw new Error('Pawchiveの人気一覧を取得できませんでした');
  return {posts,hasNext:/class=["'][^"']*\bnext\b/.test(html)};
}
module.exports={parsePopular};
