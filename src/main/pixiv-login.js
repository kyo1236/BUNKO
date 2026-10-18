'use strict';

// pixiv の初回ログインの窓 (docs/pixiv-design-2026-09-19.md §2)。
// PKCE のログイン頁を別 session の BrowserWindow で開き、ログインが済んで
// pixiv://account/login?code=… へ飛ぼうとした瞬間に code を拾って窓を閉じる。
// 拾えない時 (bot 検査など) は設定の「token を貼る」が逃げ道。

const { BrowserWindow } = require('electron');
const { codeFromCallbackUrl } = require('../lib/pixiv/auth');

function openPixivLogin(url, { parent = null } = {}) {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: 480,
      height: 760,
      parent: parent && !parent.isDestroyed() ? parent : undefined,
      title: 'pixiv にログイン',
      autoHideMenuBar: true,
      webPreferences: {
        // 本体とは別の cookie の入れ物。BUNKO 側の session に pixiv のログインを残さない
        partition: 'persist:pixiv-login',
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
      setTimeout(() => {
        try {
          if (!win.isDestroyed()) win.close();
        } catch {
          // 閉じられなくても答えは返っている
        }
      }, 0);
    };
    const look = (target, event) => {
      const code = codeFromCallbackUrl(target);
      if (!code) return false;
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      finish(resolve, code);
      return true;
    };
    const contents = win.webContents;
    contents.on('will-navigate', (event, target) => look(target, event));
    contents.on('will-redirect', (event, target) => look(target, event));
    // 外部の scheme への遷移は読み込みの失敗として上がることがある
    contents.on('did-fail-load', (_event, _code, _desc, validatedUrl) => look(validatedUrl));
    contents.setWindowOpenHandler(({ url: target }) => {
      if (look(target)) return { action: 'deny' };
      return { action: 'allow' };
    });
    win.on('closed', () => finish(reject, new Error('ログインの窓が閉じられました')));
    win.loadURL(url).catch((error) => {
      if (!look(String((error && error.url) || ''))) finish(reject, error);
    });
  });
}

module.exports = { openPixivLogin };
