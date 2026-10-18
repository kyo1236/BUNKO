const { get } = require('../../src/lib/http');

async function tryGet(url) {
  try {
    const res = await get(url);
    const text = res.text();
    let preview = text.slice(0, 180).replace(/\s+/g, ' ');
    try {
      const json = JSON.parse(text);
      if (Array.isArray(json)) {
        preview = `array ${json.length} first=${json[0] && (json[0].title || json[0].name || json[0].id)}`;
      } else {
        preview = `keys=${Object.keys(json).join(',')} total=${json.total || json.count || ''}`;
      }
    } catch {
      // html
    }
    console.log(res.status, url, preview);
  } catch (error) {
    console.log('ERR', url, error.message, error.body && error.body.toString().slice(0, 120));
  }
}

(async () => {
  const urls = [
    'https://pawchive.pw/api/v1/posts/popular',
    'https://pawchive.pw/api/v1/posts?o=0',
    'https://pawchive.pw/api/v1/posts?q=fanbox&order=popular',
    'https://pawchive.pw/api/v1/posts?q=fanbox&sort=popular',
    'https://pawchive.pw/api/v1/creators?q=&o=0',
    'https://pawchive.pw/api/v1/creators?order=favorited',
    'https://e-hentai.org/popular',
    'https://e-hentai.org/?inline_set=dm_t&f_srdd=1',
    'https://nhentai.net/api/v2/search?query=blue+archive&sort=popular&page=1',
    'https://nhentai.net/api/v2/search?query=blue+archive&sort=popular-today&page=1',
  ];
  for (const url of urls) await tryGet(url);
})();
