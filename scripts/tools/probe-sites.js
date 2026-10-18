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
    }).on('error', reject);
  });
}

(async () => {
  const html = (await req('https://e-hentai.org/g/618395/0439fa3666/')).body;
  const sLinks = [...html.matchAll(/\/s\/([0-9a-f]+)\/618395-(\d+)/g)].slice(0, 8);
  console.log('s links', sLinks.map((m) => m[0]));

  const mpv = await req('https://e-hentai.org/mpv/618395/0439fa3666/');
  const idx = mpv.body.indexOf('imagelist');
  console.log('mpv', mpv.status, 'idx', idx);
  console.log(mpv.body.slice(Math.max(0, idx), Math.max(0, idx) + 400));

  if (sLinks[0]) {
    const page = await req(`https://e-hentai.org${sLinks[0][0]}`);
    const img = page.body.match(/id="img"[^>]+src="([^"]+)"/) || page.body.match(/<img[^>]+id="img"[^>]+src="([^"]+)"/);
    console.log('page img', img && img[1]);
  }

  const paths = [
    'https://pawchive.pw/data/ca/d3/cad309bd667b90f0ae65c9a52cd820daa527e94e8fb2e6077a63211ce179e3d4.jpeg',
    'https://n1.pawchive.pw/data/ca/d3/cad309bd667b90f0ae65c9a52cd820daa527e94e8fb2e6077a63211ce179e3d4.jpeg',
    'https://pawchive.pw/thumbnail/data/ca/d3/cad309bd667b90f0ae65c9a52cd820daa527e94e8fb2e6077a63211ce179e3d4.jpeg',
  ];
  for (const p of paths) {
    const r = await req(p);
    console.log('paw', r.status, r.type, r.body.slice(0, 30));
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
