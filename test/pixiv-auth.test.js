'use strict';

// pixiv の認証 (src/lib/pixiv/auth.js)。網は偽物で、頭・本文・置き場の動きを釘で留める。

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const auth = require('../src/lib/pixiv/auth');

function memoryStore(initial = {}) {
  let value = { ...initial };
  return {
    get: () => value,
    set: (patch) => { value = { ...value, ...patch }; },
    peek: () => value,
  };
}

// 網の偽物。request の呼び出しを記録し、決めた返事を返す
function fakeHttp(handler) {
  const calls = [];
  return {
    calls,
    request: async (url, options) => {
      calls.push({ url, options });
      return handler(url, options, calls.length);
    },
    get: async () => { throw new Error('not used'); },
  };
}

const ok = (json) => ({ status: 200, headers: {}, json: () => json, text: () => JSON.stringify(json) });
const tokenJson = (over = {}) => ({
  access_token: 'acc-1', expires_in: 3600, refresh_token: 'ref-1',
  user: { id: 123, name: '名前', account: 'acct', is_premium: true },
  ...over,
});

test('X-Client-Hash は 時刻 + salt の md5、時刻は時差付きの秒精度', () => {
  const at = new Date(2026, 8, 19, 12, 34, 56);
  const headers = auth.clientHeaders(at);
  assert.equal(headers['X-Client-Time'], auth.formatClientTime(at));
  assert.match(headers['X-Client-Time'], /^2026-09-19T12:34:56[+-]\d\d:\d\d$/);
  const expected = crypto.createHash('md5').update(headers['X-Client-Time'] + auth.HASH_SALT).digest('hex');
  assert.equal(headers['X-Client-Hash'], expected);
  assert.equal(headers['User-Agent'], auth.USER_AGENT);
  assert.equal(headers['Accept-Language'], 'ja');
});

test('PKCE: challenge は verifier の sha256 を base64url した物、ログイン URL に載る', () => {
  const { verifier, challenge } = auth.pkce();
  assert.match(verifier, /^[A-Za-z0-9_-]{40,}$/);
  const expected = auth.base64url(crypto.createHash('sha256').update(verifier, 'ascii').digest());
  assert.equal(challenge, expected);
  const url = new URL(auth.loginUrl(challenge));
  assert.equal(url.origin + url.pathname, auth.LOGIN_URL);
  assert.equal(url.searchParams.get('code_challenge'), challenge);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('client'), 'pixiv-android');
});

test('戻り先の URL から code を読む。違う URL は null', () => {
  assert.equal(auth.codeFromCallbackUrl('pixiv://account/login?code=abc123&via=login'), 'abc123');
  assert.equal(auth.codeFromCallbackUrl('https://app-api.pixiv.net/web/v1/login?x=1'), null);
  assert.equal(auth.codeFromCallbackUrl('pixiv://account/login'), null);
  assert.equal(auth.codeFromCallbackUrl(''), null);
});

test('refresh: form で grant_type=refresh_token を送り、access と user と新しい refresh を持つ', async () => {
  const store = memoryStore({ refreshToken: 'ref-0' });
  const http = fakeHttp(() => ok(tokenJson()));
  let clock = 1_000_000;
  const a = new auth.PixivAuth({ store, http, now: () => clock });
  assert.equal(a.loggedIn(), true);
  const token = await a.accessToken();
  assert.equal(token, 'acc-1');
  const call = http.calls[0];
  assert.equal(call.url, auth.TOKEN_URL);
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.headers['Content-Type'], 'application/x-www-form-urlencoded');
  const body = new URLSearchParams(call.options.body);
  assert.equal(body.get('grant_type'), 'refresh_token');
  assert.equal(body.get('refresh_token'), 'ref-0');
  assert.equal(body.get('client_id'), auth.CLIENT_ID);
  assert.equal(body.get('include_policy'), 'true');
  assert.ok(call.options.headers['X-Client-Hash']);
  // 置き場: 新しい refresh と利用者
  assert.equal(store.peek().refreshToken, 'ref-1');
  assert.deepEqual(store.peek().user, { id: '123', name: '名前', account: 'acct', premium: true });
  // 切れる前は網に訊かない。5 分前を過ぎたら取り直す
  await a.accessToken();
  assert.equal(http.calls.length, 1);
  clock += 3600 * 1000 - 4 * 60 * 1000;
  await a.accessToken();
  assert.equal(http.calls.length, 2, '切れる 5 分前で取り直す');
});

test('同時に頼まれても更新は一本', async () => {
  const store = memoryStore({ refreshToken: 'ref-0' });
  const http = fakeHttp(async () => { await new Promise((r) => setTimeout(r, 10)); return ok(tokenJson()); });
  const a = new auth.PixivAuth({ store, http });
  await Promise.all([a.accessToken(), a.accessToken(), a.accessToken()]);
  assert.equal(http.calls.length, 1);
});

test('refresh token が拒まれたらログインし直しの状態になり、以後は網に出ない', async () => {
  const store = memoryStore({ refreshToken: 'dead' });
  const http = fakeHttp(() => {
    const error = new Error('HTTP 400');
    error.status = 400;
    error.body = '{"has_error":true,"errors":{"system":{"message":"Invalid refresh token"}}}';
    throw error;
  });
  const a = new auth.PixivAuth({ store, http });
  await assert.rejects(a.accessToken(), (e) => e instanceof auth.AuthError && e.code === 'invalid_grant' && /Invalid refresh token/.test(e.message));
  assert.equal(a.needsLogin, true);
  assert.equal(a.loggedIn(), false);
  await assert.rejects(a.accessToken(), (e) => e.code === 'relogin');
  assert.equal(http.calls.length, 1, '死んだ token で連打しない');
  // token は消さない (利用者が貼り直すか、ログインし直すまで持つ)
  assert.equal(store.peek().refreshToken, 'dead');
});

test('初回ログイン: code と verifier で authorization_code を送る', async () => {
  const store = memoryStore({});
  const http = fakeHttp(() => ok(tokenJson({ refresh_token: 'ref-new' })));
  const a = new auth.PixivAuth({ store, http });
  assert.equal(a.loggedIn(), false);
  const user = await a.loginWithCode('the-code', 'the-verifier');
  const body = new URLSearchParams(http.calls[0].options.body);
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('code'), 'the-code');
  assert.equal(body.get('code_verifier'), 'the-verifier');
  assert.equal(body.get('redirect_uri'), auth.REDIRECT_URI);
  assert.equal(user.name, '名前');
  assert.equal(store.peek().refreshToken, 'ref-new');
  assert.equal(a.loggedIn(), true);
});

test('貼った token は一度更新して検めてから持つ。空は撥ねる', async () => {
  const store = memoryStore({});
  const http = fakeHttp(() => ok(tokenJson({ refresh_token: 'ref-pasted-2' })));
  const a = new auth.PixivAuth({ store, http });
  await assert.rejects(a.adoptRefreshToken('   '), (e) => e.code === 'bad-token');
  await a.adoptRefreshToken(' ref-pasted ');
  assert.equal(new URLSearchParams(http.calls[0].options.body).get('refresh_token'), 'ref-pasted');
  assert.equal(store.peek().refreshToken, 'ref-pasted-2', '返ってきた新しい物を持つ');
  a.logout();
  assert.equal(a.loggedIn(), false);
  assert.equal(store.peek().refreshToken, '');
});
