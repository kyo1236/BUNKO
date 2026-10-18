'use strict';

// pixiv の部品の束。認証・API の客・作法は一つずつしか要らないので、ここで遅く組む。
// config (electron を引く) は組む時に初めて読む: アダプタや試験が require しただけでは触らない。
// 試験は _setForTest で偽物を差し込む。

const { PixivAuth } = require('./auth');
const { PixivApi } = require('./api');
const { createManners } = require('./manners');

let bundle = null;
let override = null;

function configStore(config) {
  return {
    get() {
      const current = config.load();
      return {
        refreshToken: String(current.pixivRefreshToken || ''),
        user: current.pixivUser && typeof current.pixivUser === 'object' ? current.pixivUser : null,
      };
    },
    set(patch) {
      const out = {};
      if (Object.prototype.hasOwnProperty.call(patch, 'refreshToken')) out.pixivRefreshToken = String(patch.refreshToken || '');
      if (Object.prototype.hasOwnProperty.call(patch, 'user')) out.pixivUser = patch.user || null;
      if (Object.keys(out).length) config.save(out);
    },
  };
}

function build() {
  const config = require('../config');
  let mannersConfig = {};
  try {
    const raw = config.load().pixivManners;
    if (raw && typeof raw === 'object') mannersConfig = raw;
  } catch {
    mannersConfig = {};
  }
  const manners = createManners({ config: mannersConfig });
  const auth = new PixivAuth({ store: configStore(config) });
  const api = new PixivApi({ auth, manners });
  return { auth, api, manners };
}

function get() {
  if (override) return override;
  if (!bundle) bundle = build();
  return bundle;
}

// 画面の設定のうち、網の一覧の組み方に効く物だけ (アダプタが読む)
function settings() {
  if (override && override.settings) return override.settings;
  try {
    const current = require('../config').load();
    return {
      hideAi: current.pixivHideAi === true,
      bookmarkPrivate: current.pixivBookmarkPrivate !== false,
      bookmarkRestrict: current.pixivBookmarkRestrict === 'public' ? 'public' : 'private',
      // 読み手で網の投稿を原寸で読む (既定は原寸。切ると 1200 px の webp)
      readOriginal: current.pixivReadOriginal !== false,
    };
  } catch {
    return { hideAi: false, bookmarkPrivate: true, bookmarkRestrict: 'private', readOriginal: true };
  }
}

module.exports = {
  get,
  settings,
  auth: () => get().auth,
  api: () => get().api,
  manners: () => get().manners,
  // 試験用: 偽物の束を差し込む。null で元に戻す
  _setForTest(fake) {
    override = fake || null;
    return () => { override = null; };
  },
};
