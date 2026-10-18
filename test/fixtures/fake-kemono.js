'use strict';

// kemono-engine のテスト用の偽エンジン。実物 (Python 製の kemono-dl) の代わりに
// node 自身で走らせて、渡された引数・吐く行・落とすファイルを test から操る。
//
// 本物と同じところ:
//   - ログは全部 stderr へ、logging の '%(levelname)s:%(message)s' の形で出す
//   - 成果物は --dirname-pattern の下に落とす
// 違うところ: 通信はしない。振る舞いは --fake-* の旗で test 側が決める。
//
// 旗:
//   --fake-dump  <file>  渡された引数一式と cwd、--from-file / --cookies の中身を JSON で書く
//   --fake-mode  <mode>  exit (既定) / lines / save / plan / sleep / marker / progress / die
//   --fake-sleep <ms>    sleep と marker の待ち時間
//   --fake-marker <file> marker モードで開始/終了の跡を追記するファイル
//   --fake-tag   <tag>   その跡に付ける名前
//   --fake-write <名前,...> save モードで --dirname-pattern の下に置く成果物
//                        ('名前|empty' と書くと 0 バイトで置く = 落ち切っていない欠片)
//   --fake-say-error <文> save モードの最後に吐く ERROR 行 (取りこぼしの相手役)
//   --fake-plan  <file>  plan モードの指図 (投稿 ID → 題と落とす添付) を書いた JSON
//   --fake-hold  <ms>    plan モードで、全部落とし終えた後に居座る長さ
//   --fake-progress-every <ms> / --fake-progress-count <n>  progress モードの刻みと回数
//   --fake-die-where <stdout|stderr>  die モードで traceback を吐く口 (既定 stderr)
//   --fake-exit  <code>  終了コード (既定 0)

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);

function valueOf(name) {
  const at = args.indexOf(name);
  return at >= 0 && at + 1 < args.length ? args[at + 1] : '';
}

// --from-file の中身は作業場ごと消えるので、消される前にここで写しておく
function fromFileText() {
  const file = valueOf('--from-file');
  if (!file) return null;
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// --cookies に渡されるのは、呼び手が作業場に書いた綴じ直しの写し。作業場ごと
// 消えてしまうので、綴じ先を test から確かめられるよう消される前に写しておく
function cookiesText() {
  const file = valueOf('--cookies');
  if (!file) return null;
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

const dump = valueOf('--fake-dump');
if (dump) {
  fs.writeFileSync(dump, JSON.stringify({
    args,
    cwd: process.cwd(),
    fromFileText: fromFileText(),
    cookiesText: cookiesText(),
    utf8: process.env.PYTHONUTF8 || '',
    ioencoding: process.env.PYTHONIOENCODING || '',
  }, null, 2), 'utf8');
}

const mode = valueOf('--fake-mode') || 'exit';
const sleepMs = Number(valueOf('--fake-sleep')) || 0;

function say(line) {
  process.stderr.write(`${line}\n`);
}

// 本物が一投稿を取り込むときに流す並び。飛ばし・警告・失敗も一通り混ぜる
function runLines() {
  const outDir = valueOf('--dirname-pattern');
  say('INFO:Downloading Post | 偽エンジンの投稿');
  say('INFO:Downloading: 1_first.jpg');
  if (outDir) {
    const postDir = path.join(outDir, '12345');
    fs.mkdirSync(postDir, { recursive: true });
    fs.writeFileSync(path.join(postDir, 'aaaaaa.jpg'), 'fake-jpeg');
    fs.writeFileSync(path.join(postDir, 'bbbbbb.png'), 'fake-png');
  }
  say('INFO:Skipping: 2_second.png | File already exists');
  say('INFO:Skipping post 98765 | post already archived');
  say('WARNING:server said something odd');
  say('ERROR:failed to get 3_third.zip');
  say('no level prefix here');
}

// 投稿を一つ取り込んだときの並び。何を落とすかは test 側が --fake-write で決める
// (本物と同じく、名前は呼び手が渡した --filename-pattern の展開結果になる)
function runSave() {
  const outDir = valueOf('--dirname-pattern');
  const names = valueOf('--fake-write').split(',').map((name) => name.trim()).filter(Boolean);
  say('INFO:Downloading Post | 偽エンジンの投稿');
  if (outDir) fs.mkdirSync(outDir, { recursive: true });
  for (const entry of names) {
    // '名前|empty' は 0 バイトで置く。本物も掴んだだけで中身の来なかった実体を
    // そのまま残すことがあり、読み手はそれを落ち切った物と数えてはいけない
    const [name, kind] = entry.split('|');
    // 本物も「落とす前」に言うので、跡を追う側は置き場を見て数え直すことになる
    say(`INFO:Downloading: ${name}`);
    if (outDir) fs.writeFileSync(path.join(outDir, name), kind === 'empty' ? '' : `fake-bytes:${name}`);
  }
  const error = valueOf('--fake-say-error');
  if (error) say(`ERROR:${error}`);
}

// 取りに行く先は --links (カンマ区切り) か --from-file (1 行 1 本)。どちらも
// 本物と同じく投稿 URL で受け取るので、投稿 ID はそこから読む
function postIds() {
  const text = valueOf('--links') || fromFileText() || '';
  return text
    .split(/[,\n]/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((url) => (url.match(/\/post\/([^/?#]+)/) || [])[1])
    .filter(Boolean);
}

function readPlan() {
  const file = valueOf('--fake-plan');
  if (!file) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

// 複数の投稿をまとめて取り込んだときの並び。指図 (--fake-plan) にある添付を
// --filename-pattern の名で --dirname-pattern の下に落とす。
// 指図は { "<投稿 ID>": { title, files: [{ hash, ext, body?, bodyBase64?, fail? }] } }。
// 本物と同じく --only-filetypes に無い種別は落とさず Skipping と言い、
// 指図で fail を立てた添付は ERROR を吐いて置かない (取りこぼしの相手役)
function runPlan() {
  const outDir = valueOf('--dirname-pattern');
  const pattern = valueOf('--filename-pattern') || '{id}.{ext}';
  const plan = readPlan();
  const types = String(valueOf('--only-filetypes') || '')
    .split(',')
    .map((type) => type.trim().toLowerCase())
    .filter(Boolean);

  for (const id of postIds()) {
    const post = plan[id];
    if (!post) {
      say(`INFO:Skipping post ${id} | not in plan`);
      continue;
    }
    say(`INFO:Downloading Post | ${post.title || id}`);
    for (const file of post.files || []) {
      const ext = String(file.ext || 'jpg').toLowerCase();
      const name = `${file.hash}.${ext}`;
      if (types.length && !types.includes(ext)) {
        say(`INFO:Skipping: ${name} | filetype not wanted`);
        continue;
      }
      if (file.fail) {
        say(`ERROR:failed to get ${name}`);
        continue;
      }
      say(`INFO:Downloading: ${name}`);
      if (!outDir) continue;
      const dest = path.join(outDir, pattern
        .replace(/{id}/g, id)
        .replace(/{hash}/g, file.hash)
        .replace(/{ext}/g, ext)
        .replace(/{filename}/g, file.name || file.hash));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      // zip のような中身が要る添付は base64 で渡す (JSON に生のバイト列は載らない)
      fs.writeFileSync(dest, file.bodyBase64
        ? Buffer.from(file.bodyBase64, 'base64')
        : (file.body || `fake-bytes:${file.hash}`));
    }
  }

  // 落とし終えてから居座る: 取り消しの相手役 (staging に実体がある状態で切られる)
  const hold = Number(valueOf('--fake-hold')) || 0;
  if (hold > 0) setTimeout(() => {}, hold);
}

// 転送中の進捗。本物と同じく stdout にだけ、\r で行を上書きしながら出す。
// stderr は無音なので、読み手が stdout で数え直さない限り「無通信」に見える
// (大物を掴んでいる最中の子を誤って殺す相手役)
function runProgress() {
  const every = Number(valueOf('--fake-progress-every')) || 100;
  const count = Number(valueOf('--fake-progress-count')) || 10;
  let done = 0;
  const tick = () => {
    done += 1;
    process.stdout.write(`\r  50%|█████     | 5.0M/10.0M [00:0${done}<00:05]`);
    if (done < count) {
      setTimeout(tick, every);
      return;
    }
    process.stdout.write('\n');
  };
  setTimeout(tick, every);
}

// 起動直後に例外で死ぬ子。file 系の行を一つも出さないまま非 0 で終わる
// (依存の欠品・宛先の死・クッキーの読み損ねは、どれもこの形で見える)
function runDie() {
  const stream = valueOf('--fake-die-where') === 'stdout' ? process.stdout : process.stderr;
  stream.write('Traceback (most recent call last):\n');
  stream.write('  File "kemono-dl.py", line 1, in <module>\n');
  stream.write("ModuleNotFoundError: No module named 'requests'\n");
}

function runMarker() {
  const marker = valueOf('--fake-marker');
  const tag = valueOf('--fake-tag') || '?';
  if (marker) fs.appendFileSync(marker, `start:${tag}\n`, 'utf8');
  // 直列化が効いていなければ、二つの start が続けて並ぶ
  setTimeout(() => {
    if (marker) fs.appendFileSync(marker, `end:${tag}\n`, 'utf8');
  }, sleepMs || 150);
}

// process.exit は呼ばない: stderr への書き込みが流れ切る前に落ちることがある
if (mode === 'lines') {
  runLines();
} else if (mode === 'save') {
  runSave();
} else if (mode === 'plan') {
  runPlan();
} else if (mode === 'marker') {
  runMarker();
} else if (mode === 'progress') {
  runProgress();
} else if (mode === 'die') {
  runDie();
} else if (mode === 'sleep') {
  // 何も言わずに居座る (打ち切り・取り消しの相手役)
  setTimeout(() => {}, sleepMs || 5000);
}

// 終了コードは process.exit ではなく exitCode で決める。即座に落とすと、
// 吐いたばかりの stderr が流れ切る前に口が閉じて死因が消える
const exitCode = Number(valueOf('--fake-exit'));
if (Number.isFinite(exitCode) && exitCode !== 0) process.exitCode = exitCode;
