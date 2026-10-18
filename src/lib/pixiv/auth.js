'use strict';

// pixiv 公式アプリ API の認証 (docs/pixiv-design-2026-09-19.md §2)。
//
// 定数は pixivpy / pixez / gallery-dl と同じ公開値。パスワードの口は 2021 年に閉じたので、
// 初回は PKCE のログイン頁 (ブラウザまたは Electron の窓) で code を受け取り、
// 以後は refresh token だけを持つ。access token は 1 時間で切れる (5 分前に更新)。
//
// 置き場 (store) は差し込む: main は config に、試験は素の object に持つ。
// electron を引かない。網の口 (http) も差し込める。

const crypto = require('crypto');

const CLIENT_ID = 'MOBrBDS8blbauoSck0ZfDbtuzpyT';
const CLIENT_SECRET = 'lsACyCD94FhDUtGTXi3QzcFE2uU1hqtDaKeqrdwj';
const HASH_SALT = '28c1fdd170a5204386cb1313c7077b34f83e4aaf4aa829ce78c231e05b0bae2c';
const USER_AGENT = 'PixivAndroidApp/5.0.234 (Android 11; Pixel 5)';
const TOKEN_URL = 'https://oauth.secure.pixiv.net/auth/token';
const LOGIN_URL = 'https://app-api.pixiv.net/web/v1/login';
const REDIRECT_URI = 'https://app-api.pixiv.net/web/v1/users/auth/pixiv/callback';
// ログインが済むとこの scheme へ飛ぶ。窓はこれを拾って閉じる
const CALLBACK_PREFIX = 'pixiv://account/login';

// 切れる 5 分前に取り直す
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// 頭の三つ。X-Client-Hash は時刻 + salt の md5 (公式アプリが付ける物と同じ)
function clientHeaders(now = new Date()) {
  const time = formatClientTime(now);
  return {
    'User-Agent': USER_AGENT,
    'X-Client-Time': time,
    'X-Client-Hash': crypto.createHash('md5').update(time + HASH_SALT, 'utf8').digest('hex'),
    'App-OS': 'android',
    'App-OS-Version': '11',
    'App-Version': '5.0.234',
    'Accept-Language': 'ja',
  };
}

// 2026-09-19T12:34:56+09:00 の形 (小数無し、時差付き)
function formatClientTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

// PKCE。verifier は乱数、challenge はその sha256 の base64url
function pkce() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier, 'ascii').digest());
  return { verifier, challenge };
}

function loginUrl(challenge) {
  const params = new URLSearchParams({
    code_challenge: challenge,
    code_challenge_method: 'S256',
    client: 'pixiv-android',
  });
  return `${LOGIN_URL}?${params}`;
}

// 戻り先 (pixiv://account/login?code=…&via=login) から code を読む。違う URL なら null
function codeFromCallbackUrl(url) {
  const text = String(url || '');
  if (!text.startsWith(CALLBACK_PREFIX)) return null;
  const query = text.slice(text.indexOf('?') + 1);
  if (query === text) return null;
  const code = new URLSearchParams(query).get('code');
  return code ? String(code) : null;
}

class AuthError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

// store: { get() -> { refreshToken, user } | null, set(patch) }
class PixivAuth {
  constructor({ store, http, now = Date.now } = {}) {
    if (!store) throw new Error('pixiv auth: store が無い');
    this.store = store;
    this.http = http || require('../http');
    this.now = now;
    this.access = null;            // { token, expiresAt }
    this.inflight = null;
    // refresh token が拒まれた: ログインし直すまで網の呼び出しは即失敗 (連打しない)
    this.needsLogin = false;
  }

  saved() {
    let value = null;
    try { value = this.store.get(); } catch { value = null; }
    return value && typeof value === 'object' ? value : {};
  }

  get user() {
    const saved = this.saved();
    return saved.user && typeof saved.user === 'object' ? saved.user : null;
  }

  loggedIn() {
    return Boolean(this.saved().refreshToken) && !this.needsLogin;
  }

  // 網の呼び出しに付ける access token。無い・切れかけなら更新する (同時は一本)
  async accessToken() {
    if (this.needsLogin) throw new AuthError('relogin', 'pixiv にログインし直してください');
    const at = this.now();
    if (this.access && this.access.expiresAt - REFRESH_MARGIN_MS > at) return this.access.token;
    return this.refresh();
  }

  async refresh() {
    if (this.inflight) return this.inflight;
    const saved = this.saved();
    if (!saved.refreshToken) throw new AuthError('no-token', 'pixiv にログインしていません');
    this.inflight = this.exchange({
      grant_type: 'refresh_token',
      refresh_token: saved.refreshToken,
    }).then((token) => token.access_token).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  // 初回ログイン: 窓が拾った code と、その時の verifier で交換する
  async loginWithCode(code, verifier) {
    if (!code || !verifier) throw new AuthError('bad-code', 'code か verifier が無い');
    await this.exchange({
      grant_type: 'authorization_code',
      code: String(code),
      code_verifier: String(verifier),
      redirect_uri: REDIRECT_URI,
    });
    return this.user;
  }

  // 手で貼った refresh token。一度更新して本物か検めてから持つ
  async adoptRefreshToken(token) {
    const value = String(token || '').trim();
    if (!value) throw new AuthError('bad-token', 'token が空');
    await this.exchange({ grant_type: 'refresh_token', refresh_token: value });
    return this.user;
  }

  logout() {
    this.access = null;
    this.needsLogin = false;
    this.store.set({ refreshToken: '', user: null });
  }

  // auth/token との一往復。成功したら access と (返ってきた) refresh を持つ
  async exchange(fields) {
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      include_policy: 'true',
      ...fields,
    }).toString();
    let res;
    try {
      res = await this.http.request(TOKEN_URL, {
        method: 'POST',
        headers: { ...clientHeaders(new Date(this.now())), 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        timeout: 20000,
      });
    } catch (error) {
      if (error && (error.status === 400 || error.status === 401)) {
        // refresh token が死んだ (Invalid refresh token) か、code が古い
        this.access = null;
        if (fields.grant_type === 'refresh_token' && fields.refresh_token === this.saved().refreshToken) {
          this.needsLogin = true;
        }
        throw new AuthError('invalid_grant', describe(error));
      }
      throw error;
    }
    let json = null;
    try { json = res.json(); } catch { json = null; }
    if (!json || !json.access_token) throw new AuthError('bad-response', 'auth/token の返事が読めない');
    const expiresIn = Number(json.expires_in) || 3600;
    this.access = { token: String(json.access_token), expiresAt: this.now() + expiresIn * 1000 };
    this.needsLogin = false;
    const patch = {};
    if (json.refresh_token) patch.refreshToken = String(json.refresh_token);
    if (json.user && typeof json.user === 'object') {
      patch.user = {
        id: String(json.user.id || ''),
        name: String(json.user.name || ''),
        account: String(json.user.account || ''),
        premium: json.user.is_premium === true,
      };
    }
    if (Object.keys(patch).length) this.store.set(patch);
    return json;
  }
}

function describe(error) {
  const body = typeof error.body === 'string' ? error.body : '';
  const hit = body.match(/"message"\s*:\s*"([^"]{1,120})"/);
  return hit ? hit[1] : `HTTP ${error.status}`;
}

module.exports = {
  PixivAuth,
  AuthError,
  clientHeaders,
  formatClientTime,
  pkce,
  loginUrl,
  codeFromCallbackUrl,
  base64url,
  USER_AGENT,
  TOKEN_URL,
  LOGIN_URL,
  REDIRECT_URI,
  CALLBACK_PREFIX,
  CLIENT_ID,
  HASH_SALT,
};
