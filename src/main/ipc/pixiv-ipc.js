// pixiv の IPC。口は一つ ('pixiv') で action で分ける (paw-links と同じ造り)。
// 読み書き混在の口なので、読み取り専用モードは書く action だけを中で塞ぐ。
//
//   status         状態 (ログイン・作法・取り込みの待ち・付け直しの候補)          読み
//   login          初回ログイン (窓で code を拾う)                                 書き
//   token          貼った refresh token を検めて持つ                               書き
//   logout                                                                           書き
//   bookmark       候補へ (ブックマークを付ける / 外す)                             書き
//   ask-creator    この投稿の作者は作者フォルダと同じ人かを訊く必要があるか        読み
//   bind-creator   答え (同じ人 → そのフォルダ / 別の人 → 新しく作る)             書き
//   answer         取り込みが 'asking' で止まっている物への答え                     書き
//   bulk           作者の一括 / 候補の一括 (start / stop / status)                   書き
//   relabel        古い名前 (PPD 形) の項目に url を書いて台帳へ (付け直し)          書き
//   import-retry   取り込みで転んだ job を入れ直す                                  書き
//   discover       発見: おすすめの作者 (投稿 3 枚つき) とおすすめの投稿               読み
//   follow         作者をフォローする / 外す (pixiv 側に書く)                          書き
//   ai-meta        AI 作品の生成情報 (プロンプト・設定)。aitag.win を主に、無ければ原寸の絵から自前で読む (issue #3)   読み
//                  { id: 'px:<投稿>', index, source?: 'original', fresh? } → { status: 'ok' | 'none' | 'no-original', source: 'aitag' | 'original', meta }
//   ai-marks       札の印: { ids: ['px:…' | { id, fresh }] } か { userId } → { marks: { 'px:…': 'yes' | 'no' | 'unknown' } }   読み
//   ai-meta-status 列と表の様子                                                                                    読み
//   ai-meta-backfill 所持の埋め戻し (op: start / stop / status)                                                    書き
const { ipcMain } = require('electron');
const trace = require('../../lib/trace');
const pixiv = require('../../lib/pixiv');
const { pkce, loginUrl, AuthError } = require('../../lib/pixiv/auth');
const { nextOffset } = require('../../lib/pixiv/api');
const { artworkUrl, LEGACY_NAME } = require('../../lib/pixiv/library');
const { getGallery } = require('../../lib/sources');
const pixivSource = require('../../lib/sources/pixiv');
const eagleApi = require('../../lib/eagle-api');
const aiMeta = require('../../lib/ai-meta-service');
const { AitagClient } = require('../../lib/aitag');
const { createStore } = require('../../lib/ai-meta-store');
const { AiMetaQueue } = require('../../lib/ai-meta-queue');

const WRITE_ACTIONS = new Set(['login', 'token', 'logout', 'bookmark', 'bind-creator', 'answer', 'bulk', 'relabel', 'import-retry', 'follow', 'ai-meta-backfill']);

function registerPixivIpc(deps) {
  const ipcMain = deps.ipcMain || require('electron').ipcMain;
  const {
    config, downloader, pawLibrary, reading, readOnly, READ_ONLY_ERROR, send,
    getPixivLibrary, getPixivImporter, getMainWindow, openPixivLogin,
  } = deps;

  // 一括の走り (同時に一つ)
  let bulk = null;
  // 付け直しの走り
  let relabel = null;
  const analyzeAiMeta = deps.analyzeAiMeta || aiMeta.analyze;
  // 生成情報の控えの表 (ai-meta.sqlite、userData)。aitag.win の口 (主) もこの表に書く。設定 aitagEnabled (既定オン) で切れる
  const aiMetaStore = deps.aiMetaStore || (deps.aitag && deps.aitag.store) || createStore({ dir: require('electron').app.getPath('userData') });
  const aitag = deps.aitag || new AitagClient({ store: aiMetaStore, enabled: () => config.load().aitagEnabled !== false });
  // 一本の列: 押した物を先頭に、確定 (新着) と埋め戻し (所持) は後ろから。写しでは press だけ
  const aiMetaQueue = deps.aiMetaQueue || new AiMetaQueue({
    store: aiMetaStore, aitag, pixivSource, analyze: analyzeAiMeta, send, readOnly: Boolean(readOnly),
    pdfPages: deps.aiMetaPdfPages || null,
  });

  function status() {
    const auth = pixiv.auth();
    const library = getPixivLibrary();
    const importer = getPixivImporter();
    const user = auth.user;
    let manners = null;
    try {
      manners = pixiv.manners().state();
    } catch {
      manners = null;
    }
    return {
      loggedIn: auth.loggedIn(),
      needsLogin: auth.needsLogin === true,
      user: user ? { id: user.id, name: user.name, premium: user.premium === true } : null,
      pausedForMs: manners ? manners.pausedForMs : 0,
      // 車線の混み具合 (直近 10 分の件数と、間隔を空ける段に入ったか)
      lanes: manners ? { api: manners.api, image: manners.image, view: manners.view } : null,
      pending: importer ? importer.pending() : { count: 0, waitingEagle: 0, asking: [], errors: 0 },
      legacy: library ? library.legacyCandidates().length : 0,
      library: library ? library.stats() : null,
      bulk: bulkStatus(),
      relabel: relabel ? { ...relabel.progress } : null,
    };
  }

  function bulkStatus() {
    if (!bulk) return { running: false };
    return { running: !bulk.done, ...bulk.progress };
  }

  function sendBulk() {
    try { send('pixiv-bulk-progress', bulkStatus()); } catch { /* 画面が居なくても続ける */ }
  }

  // 一括: 作者の投稿 (user) か 候補 (bookmarks) を全頁繰り、未所持だけ積む。
  // 作法の一走り (300 件で 10 分休む) に乗る。止めれば次の頁で止まる
  async function runBulk(kind, userId) {
    const api = pixiv.api();
    const library = getPixivLibrary();
    const run = pixiv.manners().createRun(kind);
    const progress = {
      kind, userId: userId || '', seen: 0, queued: 0, skipped: 0, pages: 0, resting: false, error: '',
    };
    bulk = { run, progress, done: false };
    sendBulk();
    const current = config.load();
    try {
      const me = pixiv.auth().user;
      const sides = kind === 'bookmarks'
        ? (current.pixivBookmarkPrivate === false ? ['public'] : ['public', 'private'])
        : ['user'];
      for (const side of sides) {
        let offset = 0;
        while (!run.stopped) {
          await run.tick();
          progress.resting = run.resting;
          let json;
          if (kind === 'bookmarks') {
            json = await api.bookmarks({ userId: me ? me.id : '', restrict: side, offset });
          } else {
            json = await api.userIllusts(userId, { offset });
          }
          const rows = Array.isArray(json && json.illusts) ? json.illusts : [];
          progress.pages += 1;
          for (const illust of rows) {
            progress.seen += 1;
            const pid = String(illust.id);
            if (illust.type === 'ugoira' || library.has(pid)) {
              progress.skipped += 1;
              continue;
            }
            downloader.enqueue({
              id: `px:${pid}`,
              title: String(illust.title || pid),
              downloadDir: current.downloadDir,
              format: 'pdf',
            });
            progress.queued += 1;
          }
          sendBulk();
          const next = nextOffset(json);
          if (next == null || !rows.length) break;
          offset = next;
        }
      }
    } catch (error) {
      if (!run.stopped) progress.error = (error && error.message) || String(error);
    } finally {
      bulk.done = true;
      progress.resting = false;
      sendBulk();
    }
  }

  // 付け直し (D19): 名前が <ID>_p<n>-題 で url の無い項目に url を書き、台帳へ
  async function runRelabel() {
    const library = getPixivLibrary();
    const candidates = library.legacyCandidates();
    relabel = { progress: { total: candidates.length, done: 0, failed: 0 } };
    const folders = pawLibrary.creatorFolders();
    for (const row of candidates) {
      try {
        await eagleApi.updateUrl(row.eagleId, artworkUrl(row.pid));
        const folder = folders.find((f) => (row.folders || []).map(String).includes(f.folderId));
        library.record({
          pid: row.pid,
          eagleId: row.eagleId,
          title: String(row.name || '').replace(LEGACY_NAME, '').trim() || row.name,
          userName: folder ? folder.name : '',
        });
        relabel.progress.done += 1;
      } catch {
        relabel.progress.failed += 1;
      }
      // Eagle の API を連打しない (eagle-tagger と同じ 250ms)
      await new Promise((resolve) => setTimeout(resolve, 250));
      send('library-progress', null);
    }
    library.reconcile();
    return { ...relabel.progress };
  }

  ipcMain.handle('pixiv', async (_event, payload) => {
    const request = payload || {};
    const action = String(request.action || 'status');
    if (readOnly && WRITE_ACTIONS.has(action)) throw new Error(READ_ONLY_ERROR);
    const auth = pixiv.auth();
    const library = getPixivLibrary();
    const importer = getPixivImporter();

    if (action === 'status') return status();

    if (action === 'login') {
      const { verifier, challenge } = pkce();
      const code = await openPixivLogin(loginUrl(challenge), { parent: getMainWindow() });
      await auth.loginWithCode(code, verifier);
      trace.flag('pixiv-relogin', false);
      return status();
    }
    if (action === 'token') {
      try {
        await auth.adoptRefreshToken(request.token);
      } catch (error) {
        if (error instanceof AuthError) throw new Error(`token を受け付けられません (${error.message})`);
        throw error;
      }
      trace.flag('pixiv-relogin', false);
      return status();
    }
    if (action === 'logout') {
      auth.logout();
      return status();
    }
    if (action === 'bookmark') {
      const pid = String(request.pid || '').replace(/^px:/, '');
      if (!pid) throw new Error('投稿の番号が無い');
      if (request.on === false) await pixiv.api().bookmarkDelete(pid);
      else await pixiv.api().bookmarkAdd(pid, { restrict: pixiv.settings().bookmarkRestrict });
      return { pid, on: request.on !== false };
    }
    if (action === 'ask-creator') {
      // 押した時に訊く (§15 U3): 台帳が知らない作者で、作者フォルダに同じ名前があれば問う
      const gallery = await getGallery(String(request.id || ''));
      const userId = String((gallery && gallery.userId) || '');
      const userName = String((gallery && gallery.artists && gallery.artists[0] && gallery.artists[0].name) || '');
      if (!userId || !library || library.creatorFolder(userId)) return { ask: null, userId, userName };
      let folders = [];
      try {
        folders = pawLibrary.creatorFolders();
      } catch {
        folders = [];
      }
      const match = library.constructor.matchCreatorFolder(userName, folders);
      return {
        userId,
        userName,
        ask: match ? { userId, userName, folderId: match.folderId, folderName: match.name } : null,
      };
    }
    if (action === 'bind-creator') {
      const userId = String(request.userId || '');
      if (!userId) throw new Error('作者の番号が無い');
      if (request.folderId) library.bindCreator(userId, String(request.folderId), String(request.name || ''));
      if (importer) importer.answer(userId, request.folderId ? String(request.folderId) : null, String(request.name || ''));
      return { userId, folderId: request.folderId || null };
    }
    if (action === 'answer') {
      if (importer) importer.answer(String(request.userId || ''), request.folderId ? String(request.folderId) : null, String(request.name || ''));
      return status();
    }
    if (action === 'bulk') {
      const op = String(request.op || 'status');
      if (op === 'stop') {
        if (bulk && !bulk.done) bulk.run.stop();
        return bulkStatus();
      }
      if (op === 'start') {
        if (bulk && !bulk.done) return bulkStatus();
        const kind = request.kind === 'bookmarks' ? 'bookmarks' : 'user';
        const userId = String(request.userId || '');
        if (kind === 'user' && !userId) throw new Error('作者の番号が無い');
        runBulk(kind, userId).catch(() => {});
        return bulkStatus();
      }
      return bulkStatus();
    }
    if (action === 'relabel') {
      if (relabel && relabel.progress.done + relabel.progress.failed < relabel.progress.total) return { ...relabel.progress };
      return runRelabel();
    }
    if (action === 'import-retry') {
      return importer ? importer.retry(String(request.jobId || '')) : false;
    }
    if (action === 'related') {
      const list = await pixivSource.related(request.id, { limit: Number(request.limit) || undefined });
      return library ? library.annotate(list) : list;
    }
    if (action === 'discover') {
      const view = await pixivSource.discover({ fresh: request.fresh === true });
      const mark = (list) => (library ? library.annotate(list) : list);
      const marks = reading?.summary?.() || {};
      library?.load();
      const seeds = [...new Set(Object.entries(marks).sort((a,b) => b[1].updatedAt - a[1].updatedAt)
        .map(([id]) => /^px:\d+$/.test(id) ? id : id.startsWith('pweagle:') && library?.pidOfEagle?.(id.slice(8)) ? `px:${library.pidOfEagle(id.slice(8))}` : null).filter(Boolean))].slice(0, 3);
      const recent = [];
      // Keep the extra requests bounded and let one unavailable work leave the other shelves usable.
      for (const id of seeds) {
        try {
          const seed = await getGallery(id);
          recent.push({ seed, illusts: mark(await pixivSource.related(id)) });
        } catch { recent.push({ seed: { id, title: '最近読んだ作品' }, illusts: [], error: '関連作品を取得できませんでした' }); }
      }
      return {
        at: view.at,
        recent,
        users: view.users.map((row) => ({ creator: row.creator, illusts: mark(row.illusts) })),
        illusts: mark(view.illusts),
      };
    }
    if (action === 'follow') {
      const userId = String(request.userId || '').replace(/^pxu:/, '');
      if (!userId) throw new Error('作者の番号が無い');
      if (request.on === false) await pixiv.api().followDelete(userId);
      else await pixiv.api().followAdd(userId, { restrict: 'public' });
      return { userId, on: request.on !== false };
    }
    if (action === 'ai-meta') {
      // 表 → aitag → 先頭 64KB → 原寸 の順に一本の列 (ai-meta-queue) が確かめる。押した物は列の先頭へ。
      // source: 'original' は原寸から読み直す。失敗 (ログイン切れ・網) は投げる (列が 429 で止まった時は待つ)
      const pid = String(request.id || '').replace(/^px:/, '');
      const index = Math.max(0, Math.floor(Number(request.index) || 0));
      if (!/^\d+$/.test(pid)) throw new Error('投稿の番号が無い');
      const out = await aiMetaQueue.press(pid, index, { fresh: request.fresh === true, force: request.source === 'original' ? 'original' : '' });
      return { pid, index, status: out.status, source: out.source || '', meta: out.meta || undefined };
    }
    if (action === 'ai-marks') {
      if (request.userId) {
        const ids = await aitag.byUser(String(request.userId));
        return { marks: Object.fromEntries(ids.map((id) => [`px:${id}`, 'yes'])) };
      }
      const rows = Array.isArray(request.ids) ? request.ids.slice(0, 60) : [];
      const marks = await aitag.marks(rows);
      // aitag に無かった物は、後ろの列で確定させる (先頭 64KB → 原寸。触れた物・フォロー・ブックマークの範囲)
      for (const row of rows) {
        const id = typeof row === 'string' ? row : row && row.id;
        if (id && marks[id] === 'no') aiMetaQueue.confirm(id, { fresh: typeof row === 'object' && row && row.fresh === true });
      }
      return { marks };
    }
    if (action === 'ai-meta-status') {
      return { ...aiMetaQueue.status(), rows: aiMetaStore.count(), sqlite: aiMetaStore.available() };
    }
    if (action === 'ai-meta-backfill') {
      // 所持の埋め戻し (一度だけ)。台帳の投稿 ID を後ろの列に積む
      const op = String(request.op || 'status');
      if (op === 'stop') return aiMetaQueue.stopBackfill();
      if (op === 'start') {
        const lib = getPixivLibrary();
        const pids = lib && typeof lib.pids === 'function' ? lib.pids() : [];
        return aiMetaQueue.startBackfill(pids);
      }
      return aiMetaQueue.status();
    }
    throw new Error(`pixiv: 知らない action ${action}`);
  });
  return { aiMetaStore, aiMetaQueue, aitag };
}

module.exports = { registerPixivIpc, WRITE_ACTIONS };
