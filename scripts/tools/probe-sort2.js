const { get } = require('../../src/lib/http');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function titles(url, n = 5) {
  await sleep(1500);
  const res = await get(url);
  const json = res.json();
  const rows = Array.isArray(json) ? json : json.result || [];
  return rows.slice(0, n).map((row) => row.title || row.name || row.id);
}

(async () => {
  const a = await titles('https://pawchive.pw/api/v1/posts?o=0');
  const b = await titles('https://pawchive.pw/api/v1/posts?order=popular');
  const c = await titles('https://pawchive.pw/api/v1/posts?q=blue+archive');
  const d = await titles('https://pawchive.pw/api/v1/posts?q=blue+archive&order=popular');
  console.log('paw default', a);
  console.log('paw order=popular', b);
  console.log('paw q default', c);
  console.log('paw q popular', d);

  const post = (await get('https://pawchive.pw/api/v1/posts?o=0')).json()[0];
  console.log('post keys', Object.keys(post));

  const creator = (await get('https://pawchive.pw/api/v1/creators?q=')).json()[0];
  console.log('creator', creator);

  const html = (await get('https://e-hentai.org/toplist.php?tl=15')).text();
  const gids = [...html.matchAll(/e-hentai\.org\/g\/(\d+)\/([0-9a-f]+)/g)].slice(0, 3);
  console.log('eh toplist', gids.map((m) => m[0]));
  const pop = (await get('https://e-hentai.org/popular')).text();
  const pg = [...pop.matchAll(/e-hentai\.org\/g\/(\d+)\/([0-9a-f]+)/g)].slice(0, 3);
  console.log('eh popular', pg.map((m) => m[0]));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
