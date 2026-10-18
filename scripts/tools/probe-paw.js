const https = require('https');

function req(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.get({
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*' },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        type: res.headers['content-type'],
        loc: res.headers.location,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    }).on('error', (e) => resolve({ status: 0, err: e.message, body: '' }));
  });
}

(async () => {
  const post = await req('https://pawchive.pw/fanbox/user/492957/post/12441034');
  console.log('page', post.status, post.type, post.body.length);
  const imgs = [...post.body.matchAll(/https?:\/\/[^"' \n>]+\.(?:jpe?g|png|webp|gif)/gi)].map((m) => m[0]);
  console.log('imgs', [...new Set(imgs)].slice(0, 20));
  const data = [...post.body.matchAll(/\/data\/[a-z0-9/.]+/gi)].map((m) => m[0]);
  console.log('data paths', [...new Set(data)].slice(0, 10));

  const hash = 'cad309bd667b90f0ae65c9a52cd820daa527e94e8fb2e6077a63211ce179e3d4.jpeg';
  const tries = [
    `https://pawchive.pw/data/ca/d3/${hash}`,
    `https://img.pawchive.pw/data/ca/d3/${hash}`,
    `https://cdn.pawchive.pw/data/ca/d3/${hash}`,
    `https://files.pawchive.pw/data/ca/d3/${hash}`,
    `https://pawchive.pw/thumbnail/ca/d3/${hash}`,
    `https://pawchive.pw/thumbnails/ca/d3/${hash}`,
    `https://pawchive.pw/posts/data/ca/d3/${hash}`,
    `https://c1.pawchive.pw/data/ca/d3/${hash}`,
  ];
  for (const t of tries) {
    const r = await req(t);
    console.log(r.status, r.type || r.err, t);
  }
})();
