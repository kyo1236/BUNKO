const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// pawchive の手動紐付け。
//   { creators: { "<service>:<user>": "<folderId>" },
//     posts:    { "<service>:<user>:<postId>": "<eagleId>" } }
//
// Eagle 側のアイテム名に [postId] が入っていない作品 (実データで約 1000 件) は
// 自動照合の届かない場所にいる。作者ごとにフォルダが分かれているので、
// 「作者 → フォルダ」を一度決めておけば、投稿の紐付けはその中から選ぶだけで済む。
let cached = null;
let writeTimer = null;

function storePath() {
  return path.join(app.getPath('userData'), 'paw-links.json');
}

function blank() {
  return { creators: {}, posts: {} };
}

function plain(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function load() {
  if (cached) return cached;
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
    cached = { creators: plain(parsed?.creators), posts: plain(parsed?.posts) };
  } catch {
    cached = blank();
  }
  return cached;
}

function write() {
  if (!cached) return;
  try {
    // 素の上書きだと書き込み中のクラッシュで手動紐付けが全損する
    require('./state-file').writeText('paw-links', storePath(), JSON.stringify(cached, null, 2));
  } catch {
    // 書けなくても画面の紐付けはその場では効いている
  }
}

function writeSoon() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    write();
  }, 300);
}

function flush() {
  if (!writeTimer) return;
  clearTimeout(writeTimer);
  writeTimer = null;
  write();
}

function creatorKey(service, user) {
  const svc = String(service || '').trim().toLowerCase();
  const usr = String(user || '').trim();
  return svc && usr ? `${svc}:${usr}` : '';
}

function postKey(service, user, postId) {
  const base = creatorKey(service, user);
  const post = String(postId == null ? '' : postId).trim();
  return base && post ? `${base}:${post}` : '';
}

function getCreator(service, user) {
  const key = creatorKey(service, user);
  if (!key) return null;
  const value = load().creators[key];
  return value ? String(value) : null;
}

// folderId に null / '' を渡すと解除。戻りは決まったあとの値
function setCreator(service, user, folderId) {
  const key = creatorKey(service, user);
  if (!key) return null;
  const store = load();
  const value = String(folderId || '').trim();
  if (!value) delete store.creators[key];
  else store.creators[key] = value;
  writeSoon();
  return value || null;
}

function getPost(service, user, postId) {
  const key = postKey(service, user, postId);
  if (!key) return null;
  const value = load().posts[key];
  return value ? String(value) : null;
}

function setPost(service, user, postId, eagleId) {
  const key = postKey(service, user, postId);
  const value = String(eagleId || '').trim();
  if (!key || !value) return null;
  const store = load();
  store.posts[key] = value;
  writeSoon();
  return value;
}

function removePost(service, user, postId) {
  const key = postKey(service, user, postId);
  if (!key) return false;
  const store = load();
  if (!(key in store.posts)) return false;
  delete store.posts[key];
  writeSoon();
  return true;
}

// 手で紐付け済みの eagleId。候補一覧で「もう使った札」を後ろに回すために引く
function linkedEagleIds() {
  return new Set(Object.values(load().posts).map((value) => String(value)));
}

function all() {
  const store = load();
  return { creators: { ...store.creators }, posts: { ...store.posts } };
}

// 試験・調査用: 次の load で読み直させる
function reset() {
  flush();
  cached = null;
}

module.exports = {
  getCreator,
  setCreator,
  getPost,
  setPost,
  removePost,
  linkedEagleIds,
  all,
  creatorBindings: () => ({ ...load().creators }),
  flush,
  reset,
  creatorKey,
  postKey,
};
