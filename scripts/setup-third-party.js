'use strict';
// 版に入れない同梱物 (third_party/) を取り直す。`npm run setup`。
//
//   node scripts/setup-third-party.js           欠けている物だけ取る
//   node scripts/setup-third-party.js --check   欠品の一覧を出すだけ (網を触らない)
//   node scripts/setup-third-party.js --force   あっても取り直す
//
// - kemono-dl: 上流 (L4cache/kemono-dl) にライセンスが無いので本文は版に置かず、
//   基点のコミットを浅く取って third_party/kemono-dl.patch を当てる (third_party/README.md)。
// - python: scripts/build-python-runtime.ps1 (python.org から埋め込み版を取り、SHA256 で照合、
//   依存はホストの pip で入れる)。Windows だけ。
//
// 網を触るので postinstall には繋がない。本体は欠品を「同梱物が欠けています」と案内する
// (src/lib/kemono-engine.js の runtimeError)。
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const THIRD = path.join(ROOT, 'third_party');
const KEMONO_DIR = path.join(THIRD, 'kemono-dl');
const PYTHON_DIR = path.join(THIRD, 'python');
const PATCH = path.join(THIRD, 'kemono-dl.patch');

const KEMONO_DL_REPO = 'https://github.com/L4cache/kemono-dl.git';
// 上流にある基点。patch はこのコミットの kemono-dl.py / src/ に当たる (third_party/README.md)
const KEMONO_DL_COMMIT = '77cdb70ea6ea4c4b1c70e85fb2ebd8d2ec168955';
// 取るのはこの 3 つだけ (src/ の __pycache__ と api_test.py は除く)
const KEMONO_FILES = ['kemono-dl.py', 'requirements.txt', 'src'];

const args = new Set(process.argv.slice(2));
const CHECK = args.has('--check');
const FORCE = args.has('--force');

function git(cwd, ...argv) {
  return execFileSync('git', argv, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
}

function kemonoReady() {
  return fs.existsSync(path.join(KEMONO_DIR, 'kemono-dl.py'))
    && fs.existsSync(path.join(KEMONO_DIR, 'src', 'main.py'));
}

function pythonReady() {
  return fs.existsSync(path.join(PYTHON_DIR, 'python.exe'))
    && fs.existsSync(path.join(PYTHON_DIR, 'Lib', 'site-packages', 'requests'));
}

function copyTree(from, to) {
  const stat = fs.statSync(from);
  if (stat.isDirectory()) {
    if (path.basename(from) === '__pycache__') return;
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) {
      if (name === 'api_test.py') continue;
      copyTree(path.join(from, name), path.join(to, name));
    }
    return;
  }
  fs.copyFileSync(from, to);
}

function setupKemono() {
  if (!fs.existsSync(PATCH)) throw new Error(`patch が無い: ${PATCH}`);
  const work = fs.mkdtempSync(path.join(require('os').tmpdir(), 'bunko-kemono-dl-'));
  try {
    console.log(`kemono-dl: ${KEMONO_DL_REPO} @ ${KEMONO_DL_COMMIT.slice(0, 7)} を取る`);
    git(work, 'init', '-q');
    git(work, 'fetch', '-q', '--depth', '1', KEMONO_DL_REPO, KEMONO_DL_COMMIT);
    git(work, 'checkout', '-q', 'FETCH_HEAD', '--', ...KEMONO_FILES);
    fs.rmSync(KEMONO_DIR, { recursive: true, force: true });
    fs.mkdirSync(KEMONO_DIR, { recursive: true });
    for (const name of KEMONO_FILES) copyTree(path.join(work, name), path.join(KEMONO_DIR, name));
    console.log('kemono-dl: patch を当てる');
    // 上流も追跡版も行末が CRLF 混在なので、空白の違いは咎めない (--whitespace=nowarn は警告も出さない)
    git(ROOT, 'apply', '--ignore-whitespace', '--whitespace=nowarn', '-p1', '--directory=third_party/kemono-dl', PATCH);
    console.log('kemono-dl: OK');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function setupPython() {
  if (process.platform !== 'win32') {
    throw new Error('埋め込み Python の組み立ては Windows だけ (scripts/build-python-runtime.ps1)');
  }
  console.log('python: scripts/build-python-runtime.ps1 を流す (python.org から取得、SHA256 で照合)');
  const r = spawnSync('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(ROOT, 'scripts', 'build-python-runtime.ps1'),
  ], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`build-python-runtime.ps1 が失敗 (exit ${r.status})`);
  console.log('python: OK');
}

// better-sqlite3 (生成情報の控え ai-meta.sqlite) の Electron 向けの .node。
// 試験は素の node で走るので node_modules の .node は node 向けのまま置き、Electron の ABI の物は third_party に別置きして
// 本体 (src/lib/ai-meta-store.js) が nativeBinding で指す。配布は extraResources が resources/better-sqlite3/ へ写す。
// electron-builder の npmRebuild は切ってある (入れ替えると npm test が ABI 違いで落ちる)
function sqliteDir() {
  const electron = require(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version;
  const abi = require('node-abi').getAbi(electron, 'electron');
  return { electron, dir: path.join(THIRD, 'better-sqlite3', `electron-v${abi}-${process.platform}-${process.arch}`) };
}
function sqliteReady() {
  try { return fs.existsSync(path.join(sqliteDir().dir, 'better_sqlite3.node')); } catch { return false; }
}
function setupSqlite() {
  const { electron, dir } = sqliteDir();
  const pkg = path.join(ROOT, 'node_modules', 'better-sqlite3');
  const built = path.join(pkg, 'build', 'Release', 'better_sqlite3.node');
  const bin = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'prebuild-install.cmd' : 'prebuild-install');
  const run = (args) => {
    const r = spawnSync(bin, args, { cwd: pkg, stdio: 'inherit', shell: process.platform === 'win32' });
    if (r.status !== 0) throw new Error(`prebuild-install が失敗 (exit ${r.status})`);
  };
  console.log(`better-sqlite3: Electron ${electron} 向けの .node を prebuild から取る`);
  run(['--runtime=electron', `--target=${electron}`, `--arch=${process.arch}`, `--platform=${process.platform}`]);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(built, path.join(dir, 'better_sqlite3.node'));
  // node_modules の方は node 向けに戻す (npm test はこちらを読む)
  console.log('better-sqlite3: node_modules を node 向けに戻す');
  run(['--runtime=node', `--target=${process.versions.node}`, `--arch=${process.arch}`, `--platform=${process.platform}`]);
  console.log('better-sqlite3: OK -> ' + path.relative(ROOT, dir));
}

function main() {
  const missing = [];
  if (!kemonoReady()) missing.push('third_party/kemono-dl (pawchive の落とし手)');
  if (!pythonReady()) missing.push('third_party/python (埋め込み Python + requests)');
  if (!sqliteReady()) missing.push('third_party/better-sqlite3 (Electron 向けの .node。生成情報の控え)');
  if (CHECK) {
    if (!missing.length) { console.log('同梱物は揃っている'); return; }
    console.log('欠けている同梱物:');
    for (const m of missing) console.log(`  - ${m}`);
    console.log('取るには: npm run setup');
    process.exitCode = 1;
    return;
  }
  if (FORCE || !kemonoReady()) setupKemono(); else console.log('kemono-dl: ある (取り直すなら --force)');
  if (FORCE || !pythonReady()) setupPython(); else console.log('python: ある (取り直すなら --force)');
  if (FORCE || !sqliteReady()) setupSqlite(); else console.log('better-sqlite3: ある (取り直すなら --force)');
}

try {
  main();
} catch (err) {
  console.error(`setup に失敗: ${err.message}`);
  process.exitCode = 1;
}
