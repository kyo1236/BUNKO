'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const pawCookies = require('./paw-cookies');

// pawchive の取り込みを外部エンジン (Python 製 CLI の kemono-dl) の子プロセスに任せる
// ためのラッパ。API の癖 (403 の躱し方・再試行・.part でのレジューム) は向こうが
// 何年もかけて育てたもので、こちらで書き直すより借りた方が確かに落ちてくる。
//
// electron は require しない: 置き場の解決は kemono-paths が持ち、こちらは
// 「渡された command を走らせて口を読む」だけにしてある (単体テストでは
//  偽エンジンを command に差し込んで、実ランタイム抜きで挙動を固定する)。

// 直列化の芯はモジュールに一本だけ持つ。kemono-dl は同じ置き場へ書きに行くうえ、
// 相手の API も並べて叩くと 429 を返す: 誰が呼んでも順番待ちになるよう、
// インスタンスではなくモジュールに持たせる (全プロセス横断で一本)
let chain = Promise.resolve();

// 使い捨ての作業場に付ける連番。Date.now を使わないのは、同じミリ秒に二つ作ると
// 衝突するため。落ちた run の残骸と鉢合わせしないよう乱数も混ぜる
let runSeq = 0;

const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

// links がこの本数を超えたら urls.txt に落とす。Windows のコマンドライン長には
// 上限があり、長い URL を並べると黙って切れる: 数本までは --links で十分速い
const INLINE_LINK_LIMIT = 3;

// 子の言い分を末尾だけ持ち回る本数。全部持つと長い取り込みで際限なく太るし、
// 死因が書いてあるのはたいてい最後の数行 (Python の traceback もそう)
const TAIL_LINES = 20;

// --- 取り込みの共有語彙 ----------------------------------------------
// 「どの種別を取りに行くか」「どこに一度受けるか」「落ちてきた実体をどの鍵で
// 引くか」は、一括更新 (paw-bulk) と手動保存 (downloader) が同じ答えを出さないと
// 綴じ先がずれる: 判断の元をエンジン側に一本だけ置き、両者はここから引く

const IMAGE_TYPES = ['jpg', 'jpeg', 'png', 'webp'];
const VIDEO_TYPES = ['gif', 'mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v'];

// 取り込み中の実体を一度受ける隠し箱。出力先の中に切るのは同じボリュームに
// 置くためで、そうすると組み直しが写しではなく rename で済む。先頭のドットで
// Eagle と catalog の走査からは外れる
const STAGING_DIR = '.kemono-staging';

// pawchive の添付は path に 64 桁の 16 進 hash が埋まっていて、kemono-dl の
// {hash} もそこを取る。落ちてきた実体とこちらが持つ添付一覧を結ぶ唯一の鍵
// (向こうが元ファイル名から作る名は、重複時に細工が入るので当てにしない)
function fileHashOf(value) {
  const hit = /[0-9a-f]{64}/i.exec(String(value || ''));
  return hit ? hit[0].toLowerCase() : '';
}

// os.path.splitext と同じ切り方。先頭に連なるドットは拡張子と見なさない
// ('.gitignore' は拡張子なし) ので、素朴な lastIndexOf では合わない
function splitExt(name) {
  const text = String(name || '');
  const dot = text.lastIndexOf('.');
  if (dot < 0) return '';
  for (let index = 0; index < dot; index += 1) {
    if (text[index] !== '.') return text.slice(dot + 1);
  }
  return '';
}

// kemono-dl (third_party/kemono-dl/src/main.py:588-594) が添付に付ける拡張子と
// 同じ規則で当てる。向こうは name があればその名から、無ければ path のベース名
// (割るのは '/' だけ) から splitext する: こちらが別の規則で当てると落ちてきた
// 実体の名を言い当てられず、「取れているのに欠けている」判定になる
function kemonoExt(file) {
  const source = file || {};
  const name = typeof source.name === 'string' ? source.name : '';
  if (name) return splitExt(name).toLowerCase();
  const filePath = typeof source.path === 'string' ? source.path : '';
  if (!filePath) return '';
  return splitExt(filePath.split('/').pop()).toLowerCase();
}

// staging に落ち切った実体を hash で引ける形にする。
// - .part は書き途中 (次の走りのレジューム資産) なので数えない
// - 0 バイトは掴んだだけで中身の無い欠片
// - '_statuscode416' 付きは、kemono-dl が「バイト数が合わない」と明言したうえで
//   残した欠片 (main.py:817-825。hash 照合を通らずに最終名へ昇格する唯一の道)。
//   捨てはしないが broken を立て、同じ hash に正常な実体があればそちらを採る
// - '_noserverhash' 付きは正常扱い。サーバが hash を返さなかっただけで、
//   落ちたバイト列そのものは揃っている (main.py:899-905)
// ext は path.extname と同じくドット込みで返す (綴じ先の名の尾にそのまま付く形)
function collectStaged(dir) {
  const found = new Map();
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    // まだ 1 つも落ちていない投稿。呼び手からは「全部欠けている」と見える
    return found;
  }
  for (const name of names) {
    if (name.toLowerCase().endsWith('.part')) continue;
    const hash = fileHashOf(name);
    if (!hash) continue;
    const file = path.join(dir, name);
    let stat = null;
    try {
      stat = fs.statSync(file);
    } catch {
      continue; // 読めない欠片は無かったことにする (取り直しに回る)
    }
    if (!stat.isFile() || !(stat.size > 0)) continue;
    const broken = name.includes('_statuscode416');
    const current = found.get(hash);
    // 同じ hash が複数並ぶのは、欠片と取り直しが同居しているとき。健全な方を残す
    if (current && (!current.broken || broken)) continue;
    found.set(hash, { file, ext: path.extname(name), size: stat.size, broken });
  }
  return found;
}

// --- クッキーの綴じ替え ----------------------------------------------
// 利用者のクッキーは .pawchive.st に綴じられているが、今の API とファイル置き場は
// pawchive.pw にある。kemono-dl は MozillaCookieJar + requests で宛先の綴じを
// 厳格に照合する (args.py:320-334 がするのは先頭のドット化だけ) ので、そのまま
// 渡すと pawchive.pw へは一枚も送られない = 数枚で 403 に落ちる。
// run ごとの作業場に「両方のドメインへ綴じ直した写し」を書いてそれを渡す。
// 作業場は run の終わりに消えるので、資格情報の写しは残らない
const COOKIE_DOMAINS = ['.pawchive.pw', '.pawchive.st'];
// MozillaCookieJar は読み込み時に期限切れを捨てる。写しは run の間しか生きないので
// 期限は 32 ビットの上限まで押しておく (2038 年まで有効なら十分先)
const COOKIE_EXPIRY = 2147483647;
const COOKIE_UNREADABLE = 'クッキーが読めない形式です (Netscape 形式で書き出し直してください)。素性を持たずに取りに行きます。';

// 値はログにも画面にも出さない。書き出す先も run ごとの作業場の中だけ
function rewriteCookies(cookieFile, runDir) {
  const source = String(cookieFile || '').trim();
  // 持っていないのは普通のこと (素のままでも取れる道は塞がっていない)
  if (!source || !fs.existsSync(source)) return { file: '', warning: '' };

  let pairs = [];
  try {
    pairs = pawCookies.parsePairs(fs.readFileSync(source, 'utf8'));
  } catch {
    pairs = [];
  }
  if (!pairs.length) {
    // 空や別形式のファイルをそのまま渡すと、向こうは LoadError を stdout に
    // 一行 print して即 exit する (args.py:310-318)。こちらからは無言死に
    // 見えるので、渡さずに理由だけ持ち帰る
    return { file: '', warning: COOKIE_UNREADABLE };
  }

  const lines = ['# Netscape HTTP Cookie File'];
  for (const domain of COOKIE_DOMAINS) {
    for (const pair of pairs) {
      // 綴りを壊す制御文字は落とす (列の区切りが増えると向こうが行ごと捨てる)
      const name = String(pair.name).replace(/[\t\r\n]/g, '');
      const value = String(pair.value).replace(/[\t\r\n]/g, '');
      if (!name) continue;
      // domain / includeSubdomains / path / secure / expiry / name / value
      lines.push([domain, 'TRUE', '/', 'TRUE', String(COOKIE_EXPIRY), name, value].join('\t'));
    }
  }
  const dest = path.join(runDir, 'cookies.txt');
  try {
    fs.writeFileSync(dest, `${lines.join('\n')}\n`, 'utf8');
  } catch {
    // 書けなくても素のまま走らせる (取り込みごと止める理由にはならない)
    return { file: '', warning: COOKIE_UNREADABLE };
  }
  return { file: dest, warning: '' };
}

// 今走っている子。アプリを閉じたときに置き去りにすると、親が消えたあとも
// python が同じ staging へ書き続け、次の起動の走りと鉢合わせて実体を壊す
let activeChild = null;

function killActive() {
  const child = activeChild;
  activeChild = null;
  if (!child) return false;
  try {
    child.kill();
    return true;
  } catch {
    return false; // もう死んでいる
  }
}

// 子を起こさずに返すときの器。呼び手が result の形で場合分けせずに済むよう、
// 走ったときと同じ鍵を全部持たせる
function idleResult(extra = {}) {
  return {
    errors: [],
    cancelled: false,
    timedOut: false,
    exitCode: null,
    spawnError: null,
    failure: null,
    warning: '',
    stdoutTail: [],
    stderrTail: [],
    ...extra,
  };
}

// 「何も落とさないまま非 0 で死んだ」ときだけ致命死として文言を組む。
// 途中まで落ちている走り (file 系のイベントが出ている) の成否は、呼び手が
// 成果物の実在で決める約束なので、ここでは断じない。
// こちらから殺した回 (取り消し・打ち切り) も、理由はもう別の旗が持っている
function buildFailure({ exitCode, sawFile, cancelled, timedOut, stderrTail, stdoutTail }) {
  if (sawFile || cancelled || timedOut) return null;
  if (typeof exitCode !== 'number' || exitCode === 0) return null;
  const tail = (stderrTail.length ? stderrTail : stdoutTail).slice(-2);
  const summary = tail.join(' / ').slice(0, 300);
  return `エンジンが異常終了しました (exit ${exitCode}): ${summary || '何も言い残していません'}`;
}

// kemono-dl の stderr は logging の '%(levelname)s:%(message)s'。
// 種別ごとに意味のある行だけ拾い、残りは raw のまま渡す (画面のログに出す用)
function parseStderrLine(line) {
  const matched = /^([A-Z]+):(.*)$/.exec(line);
  if (!matched) return { type: 'raw', line };
  const [, level, body] = matched;

  if (level === 'INFO') {
    let hit = /^Downloading Post \| (.*)$/.exec(body);
    if (hit) return { type: 'post-start', title: hit[1] };
    hit = /^Downloading: (.*)$/.exec(body);
    if (hit) return { type: 'file-start', name: hit[1] };
    // 「なぜ飛ばしたか」は ' | ' の後ろに続く。理由は今のところ使わないので名前だけ拾う
    hit = /^Skipping: (.*?)(?: \| .*)?$/.exec(body);
    if (hit) return { type: 'file-skip', name: hit[1] };
    hit = /^Skipping post (.+?)(?: \| .*)?$/.exec(body);
    if (hit) return { type: 'post-skip', id: hit[1] };
    return { type: 'raw', line };
  }
  if (level === 'ERROR') return { type: 'file-error', line };
  if (level === 'WARNING') return { type: 'warn', line };
  return { type: 'raw', line };
}

class KemonoEngine {
  constructor() {
    this.command = '';
    this.baseArgs = [];
    this.workDir = '';
  }

  // command = python.exe の道、baseArgs = ['-B', kemono-dl.py の道]、
  // workDir = 使い捨ての作業場を切る親 (子プロセスの cwd はこの下に作る)
  init({ command, baseArgs, workDir } = {}) {
    this.command = String(command || '');
    this.baseArgs = Array.isArray(baseArgs) ? baseArgs.map((arg) => String(arg)) : [];
    this.workDir = String(workDir || '');
    return this;
  }

  // baseArgs の中で旗でない最初のものが台本 (kemono-dl.py)。
  // 別ワーカーが third_party を組む前でも起動できるよう、欠品は落ちずに見えるようにする
  scriptPath() {
    return this.baseArgs.find((arg) => !arg.startsWith('-')) || '';
  }

  // 埋め込み版 Python は python.exe の隣に Lib\site-packages を持つ
  // (scripts/build-python-runtime.ps1 が pip --target で置く場所)
  sitePackage(name) {
    if (!this.command) return '';
    return path.join(path.dirname(this.command), 'Lib', 'site-packages', String(name));
  }

  available() {
    if (!this.command || !fs.existsSync(this.command)) return false;
    const script = this.scriptPath();
    if (!script || !fs.existsSync(script)) return false;
    // 依存 (requests) を入れ忘れたビルドでは、子は import に失敗して即死する。
    // 走らせてしまうと画面は「N 枚取り込み中」のまま何も落ちてこない見え方に
    // 化けるので、起こす前に欠品として弾く
    return fs.existsSync(this.sitePackage('requests'));
  }

  // 欠品の説明。使える状態なら空文字 (画面にそのまま出す文言なので日本語で持つ)
  runtimeError() {
    if (!this.command || !fs.existsSync(this.command)) {
      return 'pawchive の取り込みに使う Python が見つかりません (third_party/python)。同梱物が欠けています (開発では npm run setup)。';
    }
    const script = this.scriptPath();
    if (!script || !fs.existsSync(script)) {
      return 'pawchive の取り込みに使う kemono-dl が見つかりません (third_party/kemono-dl)。同梱物が欠けています (開発では npm run setup)。';
    }
    if (!fs.existsSync(this.sitePackage('requests'))) {
      return 'pawchive の取り込みに使う Python の依存 (requests) が見つかりません (third_party/python/Lib/site-packages)。同梱物が欠けています (開発では npm run setup)。';
    }
    return '';
  }

  // 使い捨ての作業場。kemono-dl は cwd に debug.log を落とすので、run ごとに
  // 切って終わりに消す (urls.txt の置き場も兼ねる)
  makeRunDir() {
    runSeq += 1;
    const stamp = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
    const dir = path.join(this.workDir, `run-${runSeq}-${stamp}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  // 走っている子はモジュールに一本しか無い (直列化の芯と同じ理由) ので、
  // ここは持ち主を問わず同じ一本を殺す。呼び手が engine しか持っていなくても
  // 畳めるように、モジュールの killActive をそのまま生やしておく
  killActive() {
    return killActive();
  }

  // 一本ずつ流す。前の run が転んでも列は止めない
  run(options) {
    const task = chain.then(() => this.execute(options), () => this.execute(options));
    chain = task.then(() => undefined, () => undefined);
    return task;
  }

  async execute({
    links = [],
    outDir = '',
    filenamePattern = '',
    cookieFile = '',
    onlyFiletypes = [],
    extraArgs = [],
    onEvent = null,
    isCancelled = null,
    idleTimeoutMs = IDLE_TIMEOUT_MS,
  } = {}) {
    // 順番待ちの間に取り消されていることがある (列は投稿の数だけ伸びる):
    // 子を起こす前にもう一度見る。ここを見ないと、利用者が止めたあとも
    // 列に積まれた分だけ取り込みが続く
    if (typeof isCancelled === 'function') {
      let stop = false;
      try { stop = isCancelled() === true; } catch { stop = false; }
      if (stop) return idleResult({ cancelled: true });
    }

    const urls = (Array.isArray(links) ? links : [])
      .map((link) => String(link || '').trim())
      .filter(Boolean);
    if (!urls.length) {
      return idleResult({ spawnError: new Error('取りに行く投稿の URL が渡されていません') });
    }

    let runDir = '';
    try {
      runDir = this.makeRunDir();
    } catch (error) {
      return idleResult({ spawnError: error });
    }

    try {
      // 綴じ直した写しを作業場に置いてから渡す (元のファイルには触らない)
      const cookies = rewriteCookies(cookieFile, runDir);
      const args = this.buildArgs({
        urls, outDir, filenamePattern, cookieFile: cookies.file, onlyFiletypes, extraArgs, runDir,
      });
      const result = await this.spawnAndWatch({ args, runDir, onEvent, isCancelled, idleTimeoutMs });
      return { ...result, warning: cookies.warning };
    } finally {
      // 作業場は必ず片付ける (urls.txt には取りに行く先が、debug.log には
      // 通信の跡が残る)。outDir の .part は消さない: あれはレジュームの資産
      try {
        fs.rmSync(runDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch { /* 残っても次の run は別の場所を切る */ }
    }
  }

  buildArgs({ urls, outDir, filenamePattern, cookieFile, onlyFiletypes, extraArgs, runDir }) {
    const args = [];
    if (urls.length > INLINE_LINK_LIMIT) {
      const listFile = path.join(runDir, 'urls.txt');
      fs.writeFileSync(listFile, `${urls.join('\n')}\n`, 'utf8');
      args.push('--from-file', listFile);
    } else {
      args.push('--links', urls.join(','));
    }

    // 置き場と名前はこちらが決める。既定のまま走らせると kemono-dl 自身の
    // Downloads/ に落ちて、Eagle の見張っている並びから外れる
    if (outDir) args.push('--dirname-pattern', String(outDir));
    if (filenamePattern) args.push('--filename-pattern', String(filenamePattern));
    // 宛先は常に名指しする。既定の pawchive.st は落ちていることがあり、そのときは
    // 子が起動直後の app_version 照会で例外死する (main.py:80-84 に try が無い):
    // こちらからは「何も言わずに死んだ」としか見えない
    args.push('--site-url', 'https://pawchive.pw');
    args.push('--file-url', 'https://file.pawchive.pw');
    // 作者一覧に載っていない作者も取れるようにする (一覧 API が落ちていても進む)
    args.push('--force-unlisted');
    // 重複判定は向こうの当て推量 (似た名前を探して hash 比較) で、こちらは
    // 済/未済を自前の台帳で持っている: 二重に判断させない
    args.push('--no-dupe-check');
    // 流量制限の 403 は素の接続で取り直すと通ることがある
    args.push('--retry-403', '2');
    // 無認証だと数枚で 403 に切り替わる。渡すのは綴じ直した写しだけで、
    // 読めなかった回は何も添えない (空や別形式を渡すと向こうが起動時に落ちる)
    if (cookieFile) args.push('--cookies', String(cookieFile));
    const types = (Array.isArray(onlyFiletypes) ? onlyFiletypes : [])
      .map((type) => String(type || '').trim())
      .filter(Boolean);
    if (types.length) args.push('--only-filetypes', types.join(','));
    // --state-db は渡さない: 済の台帳は catalog.sqlite が持つ。向こうにも
    // 持たせると二つの真実ができて、片方だけ消えたときに取りこぼす
    args.push(...(Array.isArray(extraArgs) ? extraArgs.map((arg) => String(arg)) : []));
    return args;
  }

  spawnAndWatch({ args, runDir, onEvent, isCancelled, idleTimeoutMs }) {
    return new Promise((resolve) => {
      const errors = [];
      let cancelled = false;
      let timedOut = false;
      let spawnError = null;
      let settled = false;
      let buffer = '';
      let outBuffer = '';
      let idleTimer = null;
      let cancelTimer = null;
      // 死因はたいてい最後の数行に書いてある。両方の口を末尾だけ持ち回る
      const stdoutTail = [];
      const stderrTail = [];
      // 一枚でも触った走りは「途中で転んだ」であって「起動に失敗した」ではない
      let sawFile = false;

      const pushTail = (tail, line) => {
        const text = String(line).trim();
        if (!text) return;
        tail.push(text);
        if (tail.length > TAIL_LINES) tail.shift();
      };

      const emit = (event) => {
        if (typeof onEvent !== 'function') return;
        // 受け手の例外で取り込みを止めない (画面への押し出しが転んでも保存は続ける)
        try { onEvent(event); } catch { /* ignore */ }
      };

      let child = null;
      try {
        child = spawn(this.command, [...this.baseArgs, ...args], {
          cwd: runDir,
          windowsHide: true,
          // stdin は使わない。stdout も捨てない: ログの大半は stderr だが、
          // 転送中の進捗と、クッキーを読めなかったときの断り書き (args.py の
          // print) は stdout にしか出ない。捨てると死因が丸ごと消える
          stdio: ['ignore', 'pipe', 'pipe'],
          // Windows の既定コードページのままだと日本語のタイトルが化けて
          // 落ちることがある: 子プロセスの内も外も UTF-8 で揃える
          env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
        });
      } catch (error) {
        resolve(idleResult({ spawnError: error }));
        return;
      }

      // アプリを閉じたときに殺せるよう、走っている一本を持っておく
      activeChild = child;

      const finish = (exitCode) => {
        if (settled) return;
        settled = true;
        if (activeChild === child) activeChild = null;
        if (idleTimer) clearTimeout(idleTimer);
        if (cancelTimer) clearInterval(cancelTimer);
        // 終了コードでは成否を判定しない。kemono-dl は一部の失敗を 0 で返し、
        // 逆に取れているのに非 0 で終わることもある: 成果物が実在するかは
        // 呼び出し側が outDir を見て決める (この戻り値は「何が起きたか」の記録)。
        // ただし「一枚も触らずに非 0 で死んだ」だけは取り違えようがない致命死
        // なので、言い残しを添えて failure に組む
        resolve({
          errors,
          cancelled,
          timedOut,
          spawnError,
          exitCode,
          stdoutTail,
          stderrTail,
          warning: '',
          failure: buildFailure({ exitCode, sawFile, cancelled, timedOut, stderrTail, stdoutTail }),
        });
      };

      const kill = () => {
        try { child.kill(); } catch { /* もう死んでいる */ }
      };

      // 何も言ってこないまま固まった子は打ち切る。行が来るたびに数え直す
      const bumpIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (!(idleTimeoutMs > 0)) return;
        idleTimer = setTimeout(() => {
          timedOut = true;
          kill();
        }, idleTimeoutMs);
        if (idleTimer.unref) idleTimer.unref();
      };

      const handleLine = (line) => {
        const text = line.replace(/\r$/, '');
        if (!text.trim()) return;
        bumpIdle();
        pushTail(stderrTail, text);
        const event = parseStderrLine(text);
        if (event.type.startsWith('file-')) sawFile = true;
        if (event.type === 'file-error') errors.push(event.line);
        emit(event);
      };

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (piece) => {
        buffer += piece;
        const lines = buffer.split('\n');
        // 最後の一片は行の途中かもしれない: 次の data と繋ぐまで持ち越す
        buffer = lines.pop();
        for (const line of lines) handleLine(line);
      });
      child.stderr.on('end', () => {
        if (buffer) {
          const rest = buffer;
          buffer = '';
          handleLine(rest);
        }
      });

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (piece) => {
        // 大物を掴んでいる間、口を開くのは stdout の進捗だけ。ここで数え直さないと
        // 転送中の子を「無通信」と見て打ち切ってしまう
        bumpIdle();
        outBuffer += piece;
        // 進捗は \r で行を上書きしてくる: \r も行の切れ目として扱う
        const lines = outBuffer.split(/\r\n|\r|\n/);
        outBuffer = lines.pop();
        for (const line of lines) pushTail(stdoutTail, line);
      });
      child.stdout.on('end', () => {
        if (outBuffer) {
          pushTail(stdoutTail, outBuffer);
          outBuffer = '';
        }
      });

      // kill の直後に書き込まれると EPIPE/ECONNRESET が飛ぶ。拾い手の無い
      // stream の 'error' は main ごと落とすので、何もしない受け手を置く
      child.stdout.on('error', () => { /* 殺した後の書き残し */ });
      child.stderr.on('error', () => { /* 同上 */ });

      child.on('error', (error) => {
        spawnError = error;
        finish(null);
      });
      child.on('close', (code) => finish(code));

      if (typeof isCancelled === 'function') {
        cancelTimer = setInterval(() => {
          let stop = false;
          try { stop = isCancelled() === true; } catch { stop = false; }
          if (!stop) return;
          cancelled = true;
          clearInterval(cancelTimer);
          cancelTimer = null;
          kill();
        }, 250);
        if (cancelTimer.unref) cancelTimer.unref();
      }

      bumpIdle();
    });
  }
}

// 呼び手が共有する一本。init は起動時に main が一度差す
const engine = new KemonoEngine();

module.exports = {
  KemonoEngine,
  engine,
  parseStderrLine,
  killActive,
  fileHashOf,
  kemonoExt,
  collectStaged,
  IMAGE_TYPES,
  VIDEO_TYPES,
  STAGING_DIR,
};
