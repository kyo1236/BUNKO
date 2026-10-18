// Eagle のローカル API (http://localhost:41595) との薄い連携層。
// Node 標準の http だけで完結させる (Eagle は外部ネットワークに出ない)。
const http = require('http');

const HOST = '127.0.0.1';
const PORT = 41595;
const TIMEOUT = 5000;
const TOKEN_TTL = 5 * 60 * 1000; // apiToken はほぼ変わらないので数分キャッシュ

let tokenCache = { value: null, at: 0 };

function requestAt(host, port, pathAndQuery, { method = 'GET', body = null, timeout = TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host,
      port,
      path: pathAndQuery,
      method,
      timeout,
      headers: {
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          reject(new Error('Eagle API: invalid JSON response'));
          return;
        }
        resolve(json);
      });
    });
    req.on('timeout', () => req.destroy(new Error('Eagle API: timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function request(pathAndQuery, opts) {
  return requestAt(HOST, PORT, pathAndQuery, opts);
}

// Eagle 側の設定画面で有効化した Developer API のトークン。
// 接続できない/未発行のときは throw して呼び出し元に委ねる
async function getToken() {
  const now = Date.now();
  if (tokenCache.value && now - tokenCache.at < TOKEN_TTL) return tokenCache.value;
  const json = await request('/api/application/info');
  const token = json && json.data && json.data.preferences
    && json.data.preferences.developer && json.data.preferences.developer.apiToken;
  if (!token) throw new Error('Eagle API: apiToken not available');
  tokenCache = { value: token, at: now };
  return token;
}

async function getItem(id) {
  const token = await getToken();
  const json = await request(`/api/item/info?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`);
  if (!json || json.status !== 'success') throw new Error('Eagle API: item/info failed');
  return json.data || {};
}

async function updateTags(id, tags) {
  const token = await getToken();
  const json = await request('/api/item/update', {
    method: 'POST',
    body: { id, tags: tags || [], token },
  });
  if (!json || json.status !== 'success') throw new Error('Eagle API: item/update failed');
  return json;
}

// 評価 (★0〜5) の書き込み。0 は「評価なし」に戻す
async function setStar(id, star) {
  const token = await getToken();
  const value = Math.max(0, Math.min(5, Math.round(Number(star) || 0)));
  const json = await request('/api/item/update', {
    method: 'POST',
    body: { id, star: value, token },
  });
  if (!json || json.status !== 'success') throw new Error('Eagle API: item/update failed');
  return json;
}

// ゴミ箱送り。Eagle 側で復元できるので、完全削除の API はあえて持たない
async function moveToTrash(id) {
  const token = await getToken();
  const json = await request('/api/item/moveToTrash', {
    method: 'POST',
    body: { itemIds: [id], token },
  });
  if (!json || json.status !== 'success') throw new Error('Eagle API: item/moveToTrash failed');
  return json;
}

// リモート機 (Homecore など) の Eagle にも同じゴミ箱送りを届ける。
// 同じライブラリを二台の Eagle が別々に開いている構成では、片方の削除が
// もう片方へすぐには伝わらない (metadata.json の書き出しが遅い) ための直通便
async function moveToTrashRemote(origin, token, id) {
  const u = new URL(String(origin));
  const json = await requestAt(u.hostname, Number(u.port) || PORT, '/api/item/moveToTrash', {
    method: 'POST',
    body: { itemIds: [id], token: String(token || '') },
  });
  if (!json || json.status !== 'success') throw new Error('Eagle API (remote): item/moveToTrash failed');
  return json;
}

async function isAvailable() {
  try {
    await request('/api/application/info');
    return true;
  } catch {
    return false;
  }
}

// ── pixiv の取り込み (docs/pixiv-design-2026-09-19.md §7) ───────────────────
// 見張りフォルダでなく API で入れる: 名前 (題)・url (投稿の URL)・メモ・入れる先の
// フォルダをこちらで決められる。返事は status だけなので、項目 id は直後に
// listItems で url を照らして探す (importer の仕事)

// 手元のファイルを一つ足す。Eagle が写しを取るので、原本を消すのは受領を確かめてから
async function addFromPath({ path: filePath, name, website = '', annotation = '', tags = [], folderId = '' }) {
  const token = await getToken();
  const body = {
    path: String(filePath), name: String(name || ''), token,
  };
  if (website) body.website = String(website);
  if (annotation) body.annotation = String(annotation);
  if (Array.isArray(tags) && tags.length) body.tags = tags.map(String);
  if (folderId) body.folderId = String(folderId);
  // 大きな PDF (100MB) を共有越しに写すので長めに待つ
  const json = await request('/api/item/addFromPath', { method: 'POST', body, timeout: 120000 });
  if (!json || json.status !== 'success') throw new Error('Eagle API: item/addFromPath failed');
  return json;
}

// フォルダを作る。parent を渡せばその下に。返りは新しいフォルダの id
async function createFolder(folderName, parent = '') {
  const token = await getToken();
  const body = { folderName: String(folderName || ''), token };
  if (parent) body.parent = String(parent);
  const json = await request('/api/folder/create', { method: 'POST', body });
  if (!json || json.status !== 'success' || !json.data || !json.data.id) {
    throw new Error('Eagle API: folder/create failed');
  }
  return String(json.data.id);
}

// 項目の一覧。folders で絞り、orderBy (-CREATEDATE = 新しい順) で並ぶ
// orderBy は Eagle の実測では 'CREATEDATE' が新しい順、'-CREATEDATE' が古い順 (書き方が逆に見える。2026-09-20)。
// 既定は新しい順
async function listItems({ folders = [], orderBy = 'CREATEDATE', limit = 20, offset = 0, keyword = '' } = {}) {
  const token = await getToken();
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset), orderBy, token });
  if (keyword) params.set('keyword', keyword);
  if (folders.length) params.set('folders', folders.map(String).join(','));
  const json = await request(`/api/item/list?${params}`);
  if (!json || json.status !== 'success') throw new Error('Eagle API: item/list failed');
  return Array.isArray(json.data) ? json.data : [];
}

// 既存項目の url を書く (付け直し: 名前に ID を持つ古い項目に同一性を移す)
async function updateUrl(id, url) {
  const token = await getToken();
  const json = await request('/api/item/update', {
    method: 'POST',
    body: { id, url: String(url || ''), token },
  });
  if (!json || json.status !== 'success') throw new Error('Eagle API: item/update failed');
  return json;
}

module.exports = {
  getToken, getItem, updateTags, setStar, moveToTrash, moveToTrashRemote, isAvailable,
  addFromPath, createFolder, listItems, updateUrl,
};
