'use strict';

// LAN サーバの門 (lan-server.js の handle 前半) と、宛先・素性の判定 (lan-net.js)。
// ここが緩むと所持作品がそのまま外へ出るので、断り方を一つずつ固定する。
// electron は偽物に差し替え、handle() を偽 req/res で叩く (実際には listen しない)。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const { installStub } = require('./helpers/stub-electron-2.js');
installStub();

const { LanServer } = require('../src/lib/lan-server.js');
const { isPrivateAddress, isTailscaleAddress, hostAllowed } = require('../src/lib/lan-net.js');

// 締め出しの閾値と時間はモジュール内の定数。数字を二重に持たず、ソースから読む
const lanSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'lib', 'lan-server.js'), 'utf8',
);
const maxFailsHit = lanSource.match(/const MAX_FAILS = (\d+);/);
const lockoutHit = lanSource.match(/const LOCKOUT_MS = (\d+) \* 1000;/);
assert.ok(maxFailsHit, 'MAX_FAILS が読めない');
assert.ok(lockoutHit, 'LOCKOUT_MS が読めない');
const MAX_FAILS = Number(maxFailsHit[1]);
const LOCKOUT_SECONDS = Number(lockoutHit[1]);

const TOKEN = 'b'.repeat(32);
const ADDRESS = '192.168.0.2';
const PORT = 18766;

function makeServer() {
  const server = new LanServer({
    catalog: {},
    reading: { all: () => ({}), get: () => null, set: () => null },
    settings: () => ({}),
    saveSettings() {},
  });
  server.address = ADDRESS;
  server.port = PORT;
  server.token = TOKEN;
  return server;
}

// 偽の req/res。writeHead に渡った見出しも掴んでおく (Set-Cookie / Location 用)
async function call(server, target, options = {}) {
  const req = Readable.from([]);
  req.method = options.method || 'GET';
  req.url = target;
  req.headers = {
    host: options.host === undefined ? `${ADDRESS}:${PORT}` : options.host,
    ...(options.cookie ? { cookie: options.cookie } : {}),
  };
  req.socket = { remoteAddress: options.remote || '192.168.0.30' };
  let status = 0;
  let headers = {};
  let body = '';
  const res = {
    setHeader(name, value) { headers[name] = value; },
    writeHead(code, sent) { status = code; headers = { ...headers, ...(sent || {}) }; },
    end(chunk) { body = chunk == null ? '' : String(chunk); },
  };
  await server.handle(req, res);
  return { status, headers, body };
}

// --- 門 -------------------------------------------------------------------

test('私的でない発信元は何も見せずに 403', async () => {
  const server = makeServer();
  const out = await call(server, '/api/books', { remote: '203.0.113.9', cookie: `bunko_lan=${TOKEN}` });
  assert.strictEqual(out.status, 403);
  assert.strictEqual(out.body, 'forbidden');
});

test('Host が自分の宛先と違えば 403 (DNS rebinding を通さない)', async () => {
  const server = makeServer();
  const wrongName = await call(server, '/api/books', {
    host: 'evil.example.com', cookie: `bunko_lan=${TOKEN}`,
  });
  assert.strictEqual(wrongName.status, 403);
  assert.strictEqual(wrongName.body, 'bad host');
  // 港が違うのも通さない
  const wrongPort = await call(server, '/api/books', {
    host: `${ADDRESS}:1`, cookie: `bunko_lan=${TOKEN}`,
  });
  assert.strictEqual(wrongPort.status, 403);
  // Host そのものが無いのも通さない
  const noHost = await call(server, '/api/books', { host: '', cookie: `bunko_lan=${TOKEN}` });
  assert.strictEqual(noHost.status, 403);
});

test('合言葉が無ければ 401 (画面は案内、それ以外は素っ気なく)', async () => {
  const server = makeServer();
  const api = await call(server, '/api/books');
  assert.strictEqual(api.status, 401);
  assert.strictEqual(api.body, '合言葉が要ります');
  const page = await call(server, '/');
  assert.strictEqual(page.status, 401);
  assert.match(page.headers['Content-Type'], /text\/html/);
  // 空手 (合言葉を名乗っていない) は締め出しの回数に数えない
  assert.strictEqual(server.fails.size, 0);
});

test('keep 無しの ?k= は札に移して裸の URL へ送り直す (302)', async () => {
  const server = makeServer();
  const out = await call(server, `/api/reading?k=${TOKEN}&x=1`);
  assert.strictEqual(out.status, 302);
  assert.strictEqual(out.headers.Location, '/api/reading?x=1'); // k が剥がれている
  assert.match(out.headers['Set-Cookie'], new RegExp(`^bunko_lan=${TOKEN};`));
  assert.match(out.headers['Set-Cookie'], /HttpOnly/);
  assert.match(out.headers['Set-Cookie'], /SameSite=Strict/);

  // keep 付き (ホーム画面に据える入り口) は剥がさず、札を貼って中身まで通す
  const kept = await call(server, `/api/reading?k=${TOKEN}&keep=1`);
  assert.strictEqual(kept.status, 200);
  assert.match(kept.headers['Set-Cookie'], new RegExp(`^bunko_lan=${TOKEN};`));
});

async function lock(server) {
  for (let i = 0; i < MAX_FAILS; i += 1) {
    const out = await call(server, '/api/books?k=deadbeef');
    assert.strictEqual(out.status, 401, `${i + 1} 回目はまだ 401`);
  }
}

test(`誤った合言葉が ${MAX_FAILS} 回続くと締め出す (429)`, async () => {
  const server = makeServer();
  await lock(server);
  const locked = await call(server, '/api/books?k=deadbeef');
  assert.strictEqual(locked.status, 429);
  assert.strictEqual(locked.body, 'too many attempts');
  assert.strictEqual(locked.headers['Retry-After'], String(LOCKOUT_SECONDS));
});

test('締め出し中も最新 QR は古い cookie を上書きして通る', async () => {
  const server = makeServer();
  await lock(server);
  const out = await call(server, `/api/reading?k=${TOKEN}&keep=1`, {
    cookie: 'bunko_lan=old-token',
  });
  assert.strictEqual(out.status, 200);
  assert.match(out.headers['Set-Cookie'], new RegExp(`^bunko_lan=${TOKEN};`));
  assert.strictEqual(server.fails.size, 0);
});

test('締め出し中も正しい cookie は即座に復帰する', async () => {
  const server = makeServer();
  await lock(server);
  const out = await call(server, '/api/reading', { cookie: `bunko_lan=${TOKEN}` });
  assert.strictEqual(out.status, 200);
  assert.strictEqual(server.fails.size, 0);
});

test('締め出し中の誤った query は 429 のまま、画面には残り時間と再読込案内を出す', async () => {
  const server = makeServer();
  await lock(server);
  const api = await call(server, '/api/books?k=deadbeef');
  assert.strictEqual(api.status, 429);
  assert.strictEqual(api.body, 'too many attempts');
  const page = await call(server, '/?k=deadbeef');
  assert.strictEqual(page.status, 429);
  assert.match(page.headers['Content-Type'], /text\/html/);
  assert.strictEqual(page.headers['Cache-Control'], 'no-store');
  assert.strictEqual(page.headers['Content-Security-Policy'], "default-src 'none'; style-src 'unsafe-inline'");
  assert.match(page.body, /最新 QR を読み直してください/);
  assert.match(page.body, new RegExp(`残り <b>${page.headers['Retry-After']} 秒<\\/b>`));
  assert.doesNotMatch(page.body, new RegExp(TOKEN));
});

test('同じ期限切れ cookie の再送は失効させ、重複加算で締め出さない', async () => {
  const server = makeServer();
  for (let i = 0; i < MAX_FAILS + 2; i += 1) {
    const out = await call(server, '/api/books', { cookie: 'bunko_lan=expired-token' });
    assert.strictEqual(out.status, 401);
    assert.match(out.headers['Set-Cookie'], /Max-Age=0/);
  }
  assert.strictEqual(server.fails.get('192.168.0.30').count, 1);
});

test('異なる誤った cookie は総当たりとして数え、締め出す', async () => {
  const server = makeServer();
  for (let i = 0; i < MAX_FAILS; i += 1) {
    const out = await call(server, '/api/books', { cookie: `bunko_lan=wrong-${i}` });
    assert.strictEqual(out.status, 401);
  }
  const locked = await call(server, '/api/books', { cookie: 'bunko_lan=another-wrong' });
  assert.strictEqual(locked.status, 429);
  assert.match(locked.headers['Set-Cookie'], /Max-Age=0/);
});

test('Retry-After は固定値ではなく締め出しの残り秒数を返す', async () => {
  const server = makeServer();
  await lock(server);
  const record = server.fails.get('192.168.0.30');
  record.until = Date.now() + 5500;
  const out = await call(server, '/api/books?k=deadbeef');
  const seconds = Number(out.headers['Retry-After']);
  assert.strictEqual(out.status, 429);
  assert.ok(seconds >= 5 && seconds <= 6, `残り秒数は 5〜6 のはず: ${seconds}`);
  assert.ok(seconds < LOCKOUT_SECONDS);
});

test('合言葉なしは締め出し回数を増やさず、所持データも返さない', async () => {
  const server = makeServer();
  const out = await call(server, '/api/books');
  assert.strictEqual(out.status, 401);
  assert.strictEqual(out.body, '合言葉が要ります');
  assert.doesNotMatch(out.body, /books|items|title/);
  assert.strictEqual(server.fails.size, 0);
});

// iOS はホーム画面に据える時、顔の絵だけを札の届かない別の口で取りに来る。
// ここで 401 を返すと顔を諦めて題の一文字目で札を描いてしまうので、絵だけは門の前に置く
test('ホーム画面の顔は合言葉なしでも配る (版付き・iOS の素の名も)', async () => {
  const server = makeServer();
  for (const target of [
    '/icon.png',
    '/icon.png?v=abc',
    '/apple-touch-icon.png',
    '/apple-touch-icon-precomposed.png',
  ]) {
    const out = await call(server, target);
    assert.strictEqual(out.status, 200, `${target} は 200 のはず`);
    assert.strictEqual(out.headers['Content-Type'], 'image/png');
    assert.ok(Number(out.headers['Content-Length']) > 0, `${target} の中身が空`);
    // 合言葉を名乗らない要求なので、締め出しの回数にも札の配りにも触れない
    assert.strictEqual(out.headers['Set-Cookie'], undefined);
  }
  assert.strictEqual(server.fails.size, 0);
});

test('顔を門の前に出しても、他の部品は合言葉なしでは配らない', async () => {
  const server = makeServer();
  for (const target of ['/shelf.js', '/read.js', '/reader.css', '/fonts.css', '/']) {
    const out = await call(server, target);
    assert.strictEqual(out.status, 401, `${target} は 401 のはず`);
  }
});

test('顔も私的でない発信元・違う Host には出さない', async () => {
  const server = makeServer();
  const far = await call(server, '/icon.png', { remote: '203.0.113.9' });
  assert.strictEqual(far.status, 403);
  const bad = await call(server, '/icon.png', { host: 'bunko.example.com' });
  assert.strictEqual(bad.status, 403);
});

test('正しい合言葉が通れば、それまでの失敗は帳消し', async () => {
  const server = makeServer();
  await call(server, '/api/books?k=deadbeef');
  assert.strictEqual(server.fails.size, 1);
  await call(server, `/api/reading?k=${TOKEN}&keep=1`);
  assert.strictEqual(server.fails.size, 0);
});

test('書体の名に ../ が混ざっていれば書体配りへ渡さない (404)', async () => {
  const server = makeServer();
  let reached = false;
  server.serveFont = () => { reached = true; };
  const cookie = `bunko_lan=${TOKEN}`;
  for (const target of [
    '/fonts/../../../../windows/win.ini.woff2',
    '/fonts/%2e%2e/%2e%2e/config.woff2',
    '/fonts/sub/dir.woff2',
    '/fonts/..%2Fconfig.woff2',
  ]) {
    const out = await call(server, target, { cookie });
    assert.strictEqual(out.status, 404, `${target} は 404 のはず`);
  }
  assert.strictEqual(reached, false, '書体配りに渡ってはいけない');
});

// --- 宛先・素性の判定 (lan-net.js) ---------------------------------------

test('isPrivateAddress: 通す帯と通さない帯', () => {
  const table = [
    ['127.0.0.1', true],            // 自分自身
    ['10.1.2.3', true],             // 10/8
    ['172.16.0.1', true],           // 172.16/12 の下端
    ['172.31.255.254', true],       // 同 上端
    ['172.15.0.1', false],
    ['172.32.0.1', false],
    ['192.168.1.5', true],
    ['169.254.7.7', true],          // リンクローカル
    ['100.64.0.1', true],           // Tailscale (CGNAT 帯)
    ['100.127.255.254', true],
    ['100.128.0.1', false],
    ['8.8.8.8', false],
    ['203.0.113.9', false],
    ['999.1.1.1', false],           // 桁あふれ
    ['::ffff:192.168.1.5', true],   // IPv4 射影
    ['::ffff:8.8.8.8', false],
    ['::1', true],
    ['fe80::1%eth0', true],         // 帯記号つきリンクローカル
    ['fd12::1', true],              // ユニークローカル
    ['2001:db8::1', false],
    ['', false],
    [null, false],
  ];
  for (const [input, expected] of table) {
    assert.strictEqual(isPrivateAddress(input), expected, `isPrivateAddress(${input})`);
  }
});

test('isTailscaleAddress: 100.64/10 だけ', () => {
  for (const [input, expected] of [
    ['100.64.0.1', true], ['100.127.0.1', true],
    ['100.63.255.255', false], ['100.128.0.1', false],
    ['192.168.0.1', false], ['', false],
  ]) {
    assert.strictEqual(isTailscaleAddress(input), expected, `isTailscaleAddress(${input})`);
  }
});

test('hostAllowed: 宛先と港がそのまま一致する時だけ', () => {
  assert.strictEqual(hostAllowed('192.168.0.2:8080', '192.168.0.2', 8080), true);
  assert.strictEqual(hostAllowed(' 192.168.0.2:8080 ', '192.168.0.2', 8080), true); // 前後の空白は落とす
  assert.strictEqual(hostAllowed('192.168.0.2:8081', '192.168.0.2', 8080), false);
  assert.strictEqual(hostAllowed('192.168.0.3:8080', '192.168.0.2', 8080), false);
  assert.strictEqual(hostAllowed('192.168.0.2', '192.168.0.2', 8080), false); // 港なしは不一致
  assert.strictEqual(hostAllowed('bunko.local:8080', '192.168.0.2', 8080), false);
  assert.strictEqual(hostAllowed('', '192.168.0.2', 8080), false);
  // 宛先が複数 (家の LAN + Tailscale) ならどちらでも通す
  assert.strictEqual(hostAllowed('100.64.0.5:8080', ['192.168.0.2', '100.64.0.5'], 8080), true);
  assert.strictEqual(hostAllowed('100.64.0.6:8080', ['192.168.0.2', '100.64.0.5'], 8080), false);
});
