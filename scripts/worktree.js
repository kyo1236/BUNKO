'use strict';
// 機能ごとの枝を、枝ごとの作業木 (git worktree) で扱う道具。複数の会が同時に働くための土台。
//
//   node scripts/worktree.js new <枝>        master から枝を切り .claude/worktrees/<枝>/ に作業木を作る (既にある枝ならそれを載せる)
//   node scripts/worktree.js list            作業木と枝の一覧 (未コミットの数つき)
//   node scripts/worktree.js sync <枝>       その作業木に master を merge する (母屋の進みを取り込む)
//   node scripts/worktree.js merge <枝>      母屋 (master) に --no-ff で取り込む。先に作業木で npm test を通す。**利用者の指示があった時だけ**
//   node scripts/worktree.js remove <枝>     作業木を外す (未コミットがあれば断る。--force で強行)。合流済みなら枝も消す
//
// 作法 (CLAUDE.md「枝と作業木」):
//   - 母屋 (この repo の直下) は master のまま動かさない。配布 (npm run dist → deploy) は母屋からだけ
//   - 作業木の置き場は .claude/worktrees/<枝> に固定。repo の下に居るので node_modules は親を辿って引ける (npm install 不要)
//   - work/ (調べの材料、版に入れない) は試験と scripts/ が ROOT/work で読むので、母屋の work/ へのジャンクションを張る
//   - 試写台の口 (18790〜18793) は母屋と重なるので、作業木では PORT=<別の番号> で起こす
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WT_DIR = path.join(ROOT, '.claude', 'worktrees');
const LINKED = ['work', 'node_modules'];   // 母屋からジャンクションで見せる物 (node_modules は require では親を辿れるが、fs の道で node_modules を指す所 (lan-desktop の pdf.js など) が worktree では見つからない)

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: opts.cwd || ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', opts.quiet ? 'ignore' : 'inherit'] }).trim();
}
function branchOf(dir) { return git(['-C', dir, 'branch', '--show-current']); }
// 作業木でない場所 (外し損ねて空になった dir など) で status を取ると母屋に落ちて母屋の差分を数えてしまう → 先に頂上を確かめる
function isWorktree(dir) { try { return path.resolve(git(['-C', dir, 'rev-parse', '--show-toplevel'], { quiet: true })) === path.resolve(dir); } catch { return false; } }
function dirty(dir) { if (!isWorktree(dir)) throw new Error('作業木ではない: ' + dir); return git(['-C', dir, 'status', '--porcelain']).split('\n').filter(Boolean).length; }
function exists(p) { try { fs.lstatSync(p); return true; } catch { return false; } }
function validName(name) {
  if (!name || !/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(name) || name === 'master' || name.endsWith('/')) throw new Error('枝の名前が変: ' + name);
  return name;
}
function wtPath(name) { return path.join(WT_DIR, name.replace(/\//g, '--')); }
function branchExists(name) { return spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/' + name], { cwd: ROOT }).status === 0; }

function link(dir) {
  for (const rel of LINKED) {
    const target = path.join(ROOT, rel), at = path.join(dir, rel);
    if (!exists(target)) continue;
    if (exists(at)) continue;
    fs.symlinkSync(target, at, 'junction');   // Windows のジャンクション: 管理者権限が要らない
    console.log('  link ' + rel + ' -> ' + target);
  }
}

function cmdNew(name) {
  validName(name);
  if (branchOf(ROOT) !== 'master') throw new Error('母屋が master に居ない (' + branchOf(ROOT) + ')。母屋は動かさない');
  const dir = wtPath(name);
  if (exists(dir)) throw new Error('作業木が既にある: ' + dir);
  fs.mkdirSync(WT_DIR, { recursive: true });
  if (branchExists(name)) git(['worktree', 'add', dir, name]);
  else git(['worktree', 'add', '-b', name, dir, 'master']);
  link(dir);
  console.log('[OK] ' + name + ' -> ' + dir);
  console.log('     ここで働く: cd "' + dir + '"  / 試験: npm test  / 試写: PORT=28791 node scripts/renderer-preview.js');
}

function cmdList() {
  const out = git(['worktree', 'list', '--porcelain']).split('\n\n').filter(Boolean);
  for (const block of out) {
    const dir = (block.match(/^worktree (.+)$/m) || [])[1];
    const br = (block.match(/^branch refs\/heads\/(.+)$/m) || [])[1] || '(detached)';
    if (!dir) continue;
    const n = exists(dir) && isWorktree(dir) ? dirty(dir) : '?';
    const mark = path.resolve(dir) === path.resolve(ROOT) ? '母屋' : '枝';
    console.log(`${mark}\t${br}\t未コミット ${n}\t${dir}`);
  }
}

function cmdSync(name) {
  const dir = wtPath(validName(name));
  if (!exists(dir)) throw new Error('作業木が無い: ' + dir);
  if (dirty(dir)) throw new Error('未コミットがある。先にコミットするか stash する');
  git(['-C', dir, 'merge', '--no-edit', 'master']);
  console.log('[OK] master を ' + name + ' に取り込んだ');
}

function cmdMerge(name) {
  const dir = wtPath(validName(name));
  if (!exists(dir)) throw new Error('作業木が無い: ' + dir);
  if (branchOf(ROOT) !== 'master') throw new Error('母屋が master に居ない');
  if (dirty(ROOT)) throw new Error('母屋に未コミットがある。先に片付ける');
  if (dirty(dir)) throw new Error('作業木に未コミットがある。先にコミットする');
  console.log('[--] 作業木で npm test');
  const t = spawnSync('npm.cmd', ['test'], { cwd: dir, encoding: 'utf8', shell: true });
  const pass = (t.stdout.match(/^# pass (\d+)/m) || [])[1], fail = (t.stdout.match(/^# fail (\d+)/m) || [])[1];
  if (t.status !== 0 || !pass || fail !== '0') throw new Error(`試験が緑でない (pass ${pass} / fail ${fail})`);
  console.log(`[OK] 試験 ${pass} 件緑`);
  git(['merge', '--no-ff', '--no-edit', name]);
  console.log('[OK] master に取り込んだ: ' + git(['log', '--oneline', '-1']));
}

function cmdRemove(name, force) {
  const dir = wtPath(validName(name));
  if (!exists(dir)) throw new Error('作業木が無い: ' + dir);
  if (!isWorktree(dir)) {   // 前の remove が途中で落ちて空の dir だけ残った時: 登録を掃いて dir を消す
    git(['worktree', 'prune']);
    if (fs.readdirSync(dir).length === 0) { fs.rmdirSync(dir); console.log('[OK] 空の dir を消した (登録は prune 済み): ' + dir); }
    else throw new Error('作業木として登録されていないのに中身がある。手で確かめる: ' + dir);
    return;
  }
  const n = dirty(dir);
  if (n && !force) throw new Error(`未コミットが ${n} 件。--force で捨てる`);
  for (const rel of LINKED) { const at = path.join(dir, rel); if (exists(at) && fs.lstatSync(at).isSymbolicLink()) fs.unlinkSync(at); }
  git(force ? ['worktree', 'remove', '--force', dir] : ['worktree', 'remove', dir]);
  const merged = git(['branch', '--merged', 'master']).split('\n').map((s) => s.replace(/^[*+ ]+/, '').trim());
  if (merged.includes(name)) { git(['branch', '-d', name]); console.log('[OK] 作業木と枝 ' + name + ' を外した (合流済み)'); }
  else console.log('[OK] 作業木を外した。枝 ' + name + ' は未合流なので残した (消すなら git branch -D)');
}

function main() {
  const [cmd, name, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'new': return cmdNew(name);
    case 'list': return cmdList();
    case 'sync': return cmdSync(name);
    case 'merge': return cmdMerge(name);
    case 'remove': return cmdRemove(name, rest.includes('--force') || name === '--force');
    default: console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 8).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); return;
  }
}
if (require.main === module) {
  try { main(); } catch (e) { console.error('[NG] ' + e.message); process.exit(1); }
}
