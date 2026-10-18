// Home の作者の結びの候補のうち、所持 2 冊の確認 (home-link-verify) で決められなかった物を、
// Codex (OpenAI の模型) に網で確かめさせる (2026-09-25、利用者の指示「怪しいやつはまとめて gpt6-sol で確かめて」)。
// 手順は .claude/skills/home-author-links/SKILL.md。画面へ出すのは数だけ (作者名・URL は出さない)。
// 名前の入った物 (束・答え) はリポジトリの外 (HOME_SURVEY_DIR、無ければ OS の一時フォルダの bunko-home-survey/codex)。
//
// 走らせ方 (BUNKO を --remote-debugging-port=9222 で起こしてから):
//   node scripts/home-link-codex.cjs batch    verify-results.json の候補で「確か」でない物を 12 件ずつの束に切る
//   node scripts/home-link-codex.cjs run      束ごとに codex exec を回し、答え (link / reject / unresolved) を控える (途中から続けられる)
//   node scripts/home-link-codex.cjs apply    答えを BUNKO の口へ: link → 結ぶ (accept)、reject → 違う、unresolved → 候補に「決められなかった」の印
//   node scripts/home-link-codex.cjs report   答えの一覧 (HTML。名前入り。Claude は開かない)
//   オプション: --model gpt-6-astra (既定。gpt-6-sol は ChatGPT の口では 400 で断られる) --limit N (束の数を絞る。試し) --tag x
//              --min-confidence 0.9 (apply: これ未満の link / reject は「決められなかった」に回す)
//
// Codex に渡す物: 人の名前 (Home の見出し)・種別・サイトと候補の URL・突き合わせの根拠の文・所持の冊数・確認の結果の数・
// 所持の本の題 (新しい 6 冊。BUNKO の口が返す題)・相手の名前と handle・相手の新しい作品の題 (一頁目)・確かな他サイトの結び。
// Eagle のライブラリの中身 (metadata.json・サムネイル) は渡さない。
// Codex は網の頁を自分では開けない (一束目は 12 件とも「開けなかった」) ので、添えた根拠で同じ人かを答える (網の検索は補助)。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseSiteUrl } = require(path.join(__dirname, '..', 'src/lib/home-authors.js'));

const OUT_DIR = process.env.HOME_SURVEY_DIR || path.join(os.tmpdir(), 'bunko-home-survey');
const ARGS = process.argv.slice(3);
const option = (name, fallback = '') => {
  const index = ARGS.indexOf(`--${name}`);
  return index >= 0 && ARGS[index + 1] ? ARGS[index + 1] : fallback;
};
const TAG = option('tag').replace(/[^a-z0-9-]/gi, '');
const MODEL = option('model', 'gpt-6-astra');
const LIMIT = Number(option('limit', '0')) || 0;
// apply: この確信度に満たない link / reject は「決められなかった」に回す (--min-confidence 0.9)
const MIN_CONFIDENCE = Math.min(1, Math.max(0, Number(option('min-confidence', '0.9')) || 0.9));
const VERIFY = path.join(OUT_DIR, TAG ? `verify-results-${TAG}.json` : 'verify-results.json');
const DIR = path.join(OUT_DIR, TAG ? `codex-${TAG}` : 'codex');
fs.mkdirSync(DIR, { recursive: true });
const BATCH_SIZE = 12;
const BY = `Codex ${MODEL} の確認`;
const LABEL = { pixiv: 'pixiv', pawchive: 'Pawchive', hitomi: 'hitomi', nhentai: 'nhentai' };

// 答えの形 (codex exec --output-schema)
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'verdict', 'confidence', 'reason'],
        properties: {
          key: { type: 'string' },
          verdict: { type: 'string', enum: ['link', 'reject', 'unresolved'] },
          confidence: { type: 'number' },
          reason: { type: 'string' },
        },
      },
    },
  },
};

function keyOf(row) {
  return `${row.id}|${row.site}|${row.value}`;
}

async function connect() {
  const list = await (await fetch('http://127.0.0.1:9222/json')).json();
  const page = list.find((item) => item.type === 'page' && /文匣/.test(item.title || ''));
  if (!page) throw new Error('文匣 の頁が見つからない (BUNKO を --remote-debugging-port=9222 で起こす)');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) pending.get(message.id)(message);
  });
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, (message) => (message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 600000 });
    if (r.exceptionDetails) throw new Error(String((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text).split('\n')[0].slice(0, 200));
    return r.result.value;
  };
  return { evaluate, close: () => ws.close() };
}

// 束: 候補で「確か」でない物 (弱い・無し・引けなかった)。同じ人の物は同じ束に (他サイトの結びが手がかりになる)。
// Codex は網の頁を自分で開けない (2026-09-25 の一束目は 12 件とも「開けなかった」) ので、根拠は BUNKO の口で先に集めて添える:
//   相手の名前と handle (pixiv の利用者の札 pxu:<id> / Pawchive の作者の札 pw:<service>:<user>:profile)、
//   相手の新しい作品の題 (一頁目)、その人の所持の本の題 (新しい方から 6 冊)、確かな他サイトの結び
const EVIDENCE_DELAY = { pixiv: 1500, pawchive: 8000, hitomi: 1500 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ownedTitles(cdp, id) {
  return cdp.evaluate(`(async () => {
    const p = await window.hitomi.home({ action: 'author', id: ${JSON.stringify(id)} });
    const seen = new Set(); const out = [];
    for (const b of ((p && p.books) || []).filter((b) => !b.candidate)) {
      const t = String((b.gallery && b.gallery.title) || '').trim();
      if (!t || seen.has(t)) continue;
      seen.add(t); out.push(t);
      if (out.length >= 6) break;
    }
    return out;
  })()`);
}

async function candidateEvidence(cdp, site, value, cache) {
  const key = `${site}:${value}`;
  if (cache.has(key)) return cache.get(key);
  await sleep(EVIDENCE_DELAY[site] || 1500);
  let query;
  let profileId = '';
  if (site === 'pixiv') {
    query = { source: 'pixiv', query: `user:${value}`, sort: 'added', page: 0, pageSize: 30 };
    profileId = `pxu:${value}`;
  } else if (site === 'pawchive') {
    const cut = value.indexOf(':');
    query = { source: 'pawchive', query: `${value.slice(0, cut)}/${value.slice(cut + 1)}`, sort: 'added', page: 0, pageSize: 50 };
    profileId = `pw:${value.slice(0, cut)}:${value.slice(cut + 1)}:profile`;
  } else {
    const group = value.startsWith('group:');
    query = { source: 'hitomi', query: `${group ? 'group' : 'artist'}:${(group ? value.slice(6) : value).replace(/\s+/g, '_')}`, language: 'japanese', sort: 'added', page: 0, pageSize: 25 };
  }
  const got = await cdp.evaluate(`(async () => {
    const out = { name: '', account: '', titles: [], error: '' };
    try {
      if (${JSON.stringify(profileId)}) {
        const g = await window.hitomi.gallery(${JSON.stringify(profileId)});
        if (g && !g.error) { out.name = String(g.title || ''); out.account = String(g.account || ''); }
      }
    } catch {}
    try {
      const r = await window.hitomi.search({ background: true, requestId: 'cx-' + Date.now() + '-' + Math.random().toString(36).slice(2), scope: 'all', ...${JSON.stringify(query)} });
      out.titles = (r.galleries || []).filter((g) => g && !g.error && g.kind !== 'creator').map((g) => String(g.title || '')).filter(Boolean).slice(0, 12);
      if (!out.name) { const g = (r.galleries || []).find((g) => g && g.kind === 'creator'); if (g) out.name = String(g.title || ''); }
    } catch (error) { out.error = String(error && error.message || error).slice(0, 80); }
    return out;
  })()`);
  cache.set(key, got);
  return got;
}

async function batch() {
  const data = JSON.parse(fs.readFileSync(VERIFY, 'utf8'));
  // 既に Codex が答えた物 (verdict-*.json) は束に入れ直さない (二度目以降は新しい候補だけ)
  const answered = verdicts();
  const rows = data.results.filter((row) => row.state === 'candidate' && row.verdict !== 'sure' && !(row.applied && row.applied.ok)
    && !answered.has(keyOf(row)) && !(row.codex && row.codex.applied));
  const byPerson = new Map();
  for (const row of rows) {
    if (!byPerson.has(row.id)) byPerson.set(row.id, []);
    byPerson.get(row.id).push(row);
  }
  // その人の確かな結び (他サイト) を手がかりとして添える
  const sureOf = new Map();
  for (const row of data.results) {
    if (row.verdict !== 'sure' && row.state !== 'linked') continue;
    if (!sureOf.has(row.id)) sureOf.set(row.id, []);
    sureOf.get(row.id).push({ site: LABEL[row.site], url: row.url, confirmed: row.state === 'linked' ? 'linked' : `${row.count} owned works found` });
  }
  const cdp = await connect();
  const cache = new Map();
  const items = [];
  let fetched = 0;
  for (const [id, list] of byPerson) {
    const owned = await ownedTitles(cdp, id);
    for (const row of list) {
      const evidence = await candidateEvidence(cdp, row.site, row.value, cache);
      fetched += 1;
      items.push({
        key: keyOf(row),
        person: row.display,
        kind: row.kind === 'folder' ? 'author folder (user-curated)' : row.kind === 'circle' ? 'doujin circle' : 'artist',
        owned_works: row.owned,
        owned_sample_titles: owned,
        site: LABEL[row.site],
        candidate_url: row.url,
        candidate_profile: { name: evidence.name, account_handle: evidence.account },
        candidate_recent_titles: evidence.titles,
        fetch_error: evidence.error || '',
        how_found: row.note || '',
        ownership_check: `${row.verdict}: ${row.count} of the user's owned works found among ${row.works} works listed on the page${row.error ? ` (fetch error: ${row.error})` : ''}`,
        known_links: (sureOf.get(id) || []).filter((link) => link.url !== row.url),
      });
    }
  }
  cdp.close();
  for (const file of fs.readdirSync(DIR)) if (/^batch-\d+\.json$/.test(file)) fs.unlinkSync(path.join(DIR, file));
  let n = 0;
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    n += 1;
    fs.writeFileSync(path.join(DIR, `batch-${n}.json`), JSON.stringify(items.slice(i, i + BATCH_SIZE), null, 1));
  }
  fs.writeFileSync(path.join(DIR, 'schema.json'), JSON.stringify(SCHEMA, null, 1));
  console.log(JSON.stringify({ candidates: items.length, persons: byPerson.size, batches: n, fetched, dir: path.basename(DIR) }));
}

const PROMPT = `You are verifying whether a creator page on a website belongs to the same person as an entry in a personal doujinshi library.
Read ./batch.json (an array of items). The pages themselves are usually NOT reachable from here, so judge primarily from the evidence in each item:
- candidate_profile (display name and account handle of the candidate page), candidate_recent_titles (newest works on that page),
- owned_sample_titles (works the user owns by this person), owned_works (count), ownership_check (how many owned works were found on the page),
- known_links (pages already confirmed for this person on other sites — e.g. a Pawchive fanbox/fantia creator id that should equal the pixiv account handle),
- how_found (why the candidate was proposed: dictionary rows, name match, a title hit).
You may use your web search tool as a supplement when it works, but do not mark "unresolved" just because a page could not be opened if the evidence above is decisive.
Decide for EACH item:
- "link": same creator — e.g. the account handle equals a confirmed handle on another site, a distinctive pen name / circle name matches exactly (not just a common word), or owned titles (or their series) appear among the candidate's recent titles.
- "reject": a different person — a namesake with unrelated works, a different handle where a match was expected, or a genre/language that cannot be this creator.
- "unresolved": the evidence is genuinely insufficient either way.
Answer with a JSON object { "verdicts": [ { "key", "verdict", "confidence" (0..1), "reason" (one short English sentence naming the decisive evidence) } ] } with exactly one verdict per item, same "key" as the item.`;

function run() {
  const files = fs.readdirSync(DIR).filter((file) => /^batch-\d+\.json$/.test(file)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  // 答え済みの束 = 同じ番号の答えの鍵が今の束の鍵と同じ物。前の回の答え (鍵が違う) は verdict-<n>-<時刻>.json に退けて残す
  const keysOf = (file) => new Set(JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8')).map((row) => row.key));
  const done = new Set();
  for (const file of fs.readdirSync(DIR)) {
    const m = file.match(/^verdict-(\d+)\.json$/);
    if (!m) continue;
    if (!fs.existsSync(path.join(DIR, `batch-${m[1]}.json`))) continue;
    const a = keysOf(file);
    const b = keysOf(`batch-${m[1]}.json`);
    if (a.size === b.size && [...a].every((key) => b.has(key))) done.add(m[1]);
    else fs.renameSync(path.join(DIR, file), path.join(DIR, `verdict-${m[1]}-${Date.now()}.json`));
  }
  let ran = 0;
  let failed = 0;
  for (const file of files) {
    const n = file.match(/\d+/)[0];
    if (done.has(n)) continue;
    if (LIMIT && ran >= LIMIT) break;
    const work = path.join(DIR, `work-${n}`);
    fs.mkdirSync(work, { recursive: true });
    fs.copyFileSync(path.join(DIR, file), path.join(work, 'batch.json'));
    const out = path.join(work, 'last.json');
    // 頼みの文は stdin で渡す (Windows の shell 経由では引数の空白で割れて 'unexpected argument' になった)
    const result = spawnSync('codex', [
      'exec', '-m', MODEL, '--skip-git-repo-check', '--ephemeral', '-s', 'workspace-write', '-C', work,
      '--output-schema', path.join(DIR, 'schema.json'), '-o', out, '-',
    ], { input: PROMPT, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', timeout: 20 * 60 * 1000, shell: process.platform === 'win32' });
    ran += 1;
    let verdicts = null;
    try {
      verdicts = JSON.parse(fs.readFileSync(out, 'utf8')).verdicts;
    } catch {
      verdicts = null;
    }
    if (!Array.isArray(verdicts)) {
      failed += 1;
      fs.writeFileSync(path.join(work, 'stderr.txt'), String(result.stderr || '').slice(-4000));
      console.log(JSON.stringify({ batch: n, ok: false, status: result.status }));
      continue;
    }
    fs.writeFileSync(path.join(DIR, `verdict-${n}.json`), JSON.stringify(verdicts, null, 1));
    const tally = {};
    for (const row of verdicts) tally[row.verdict] = (tally[row.verdict] || 0) + 1;
    console.log(JSON.stringify({ batch: n, ok: true, items: verdicts.length, tally }));
  }
  console.log(JSON.stringify({ ran, failed, remaining: files.length - done.size - ran }));
}

function verdicts() {
  const out = new Map();
  for (const file of fs.readdirSync(DIR)) {
    if (!/^verdict-\d+(-\d+)?\.json$/.test(file)) continue;
    for (const row of JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'))) out.set(row.key, row);
  }
  return out;
}

async function apply() {
  const data = JSON.parse(fs.readFileSync(VERIFY, 'utf8'));
  const answers = verdicts();
  const cdp = await connect();
  const tally = { link: 0, reject: 0, unresolved: 0, fail: 0, reasons: {} };
  const marks = [];
  // pixiv と Pawchive を先に (hitomi を結ぶと見出しが作者フォルダに寄って id が変わる)
  const rows = data.results.filter((row) => row.state === 'candidate' && answers.has(keyOf(row)) && !(row.codex && row.codex.applied))
    .sort((a, b) => (a.site === 'hitomi') - (b.site === 'hitomi'));
  for (const row of rows) {
    const answer = { ...answers.get(keyOf(row)) };
    // 確信度が低い答え (既定 0.9 未満) は結ばず・退けず、「決められなかった」として扱う
    if ((Number(answer.confidence) || 0) < MIN_CONFIDENCE && answer.verdict !== 'unresolved') {
      answer.reason = `[${answer.verdict} ${Math.round((Number(answer.confidence) || 0) * 100)}%, below threshold] ${answer.reason || ''}`;
      answer.verdict = 'unresolved';
    }
    const note = `${BY}: ${String(answer.reason || '').slice(0, 300)} (${Math.round((Number(answer.confidence) || 0) * 100)}%)`;
    if (answer.verdict === 'unresolved') {
      marks.push({ id: row.id, site: row.site, url: row.url, unresolved: true, note: row.note || '' });
      row.codex = { ...answer, applied: true };
      tally.unresolved += 1;
      continue;
    }
    const op = answer.verdict === 'link' ? 'accept' : 'reject';
    const reply = await cdp.evaluate(`(async () => {
      try {
        const r = await window.hitomi.home({ action: 'link', id: ${JSON.stringify(row.id)}, site: ${JSON.stringify(row.site)}, op: ${JSON.stringify(op)}, url: ${JSON.stringify(row.url)}, by: ${JSON.stringify(BY)}, note: ${JSON.stringify(note)} });
        return { ok: Boolean(r && r.ok), reason: (r && r.reason) || '' };
      } catch (error) { return { ok: false, reason: String(error && error.message || error).slice(0, 60) }; }
    })()`);
    row.codex = { ...answer, applied: reply.ok, reply };
    if (reply.ok) tally[answer.verdict] += 1;
    else {
      tally.fail += 1;
      tally.reasons[reply.reason] = (tally.reasons[reply.reason] || 0) + 1;
    }
  }
  if (marks.length) {
    const reply = await cdp.evaluate(`(async () => {
      try { return await window.hitomi.home({ action: 'suggest', by: ${JSON.stringify(BY)}, rows: ${JSON.stringify(marks)} }); }
      catch (error) { return { ok: false, reason: String(error && error.message || error).slice(0, 80) }; }
    })()`);
    tally.marked = reply && reply.added;
  }
  cdp.close();
  fs.writeFileSync(VERIFY, JSON.stringify(data, null, 1));
  console.log(JSON.stringify(tally));
}

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function report() {
  const data = JSON.parse(fs.readFileSync(VERIFY, 'utf8'));
  const answers = verdicts();
  // apply と同じ決まり: 確信度が閾値未満の link / reject は「決められなかった」の側に出す
  const effective = (answer) => ((answer.verdict !== 'unresolved' && (Number(answer.confidence) || 0) < MIN_CONFIDENCE) ? 'unresolved' : answer.verdict);
  const rows = data.results.filter((row) => answers.has(keyOf(row))).map((row) => ({ ...row, answer: answers.get(keyOf(row)) }));
  const groups = [
    ['結んだ (Codex が同じ人と判断)', rows.filter((row) => effective(row.answer) === 'link')],
    ['違うと判断した', rows.filter((row) => effective(row.answer) === 'reject')],
    [`決められなかった (確信度 ${MIN_CONFIDENCE} 未満の答えも含む。設定「判定できなかった作者だけ」で Home に絞れる)`, rows.filter((row) => effective(row.answer) === 'unresolved')],
  ];
  const section = ([title, list]) => (!list.length ? '' : `<section><h2>${esc(title)} <small>${list.length} 件</small></h2><ul>${list
    .sort((a, b) => String(a.display).localeCompare(String(b.display), 'ja'))
    .map((row) => `<li><b>${esc(row.display)}</b> <span class="site">${LABEL[row.site]}</span> <a href="${esc(row.url)}">${esc(row.url)}</a>
      <div class="d">${esc(row.answer.reason)} (${Math.round((Number(row.answer.confidence) || 0) * 100)}%)${row.codex && row.codex.applied === false ? ` · 書けなかった: ${esc(row.codex.reply && row.codex.reply.reason)}` : ''}</div>
      <div class="d">手がかり: ${esc(row.note || '')} · 所持 ${row.owned} 冊中 ${row.count} 冊が相手に</div></li>`).join('')}</ul></section>`);
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>Codex の確かめ</title>
<style>
:root{--bg:#15171a;--fg:#e8e6e1;--dim:#9a978f;--line:#2c3036}
@media (prefers-color-scheme: light){:root{--bg:#fafaf7;--fg:#1d1f22;--dim:#6b6860;--line:#ddd9cf}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 system-ui,sans-serif}
main{max-width:980px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:20px;margin:0 0 4px} p.lead{color:var(--dim);margin:0 0 20px}
section{border-top:1px solid var(--line);padding:14px 0} h2{font-size:16px;margin:0 0 8px} h2 small{font-weight:400;color:var(--dim);font-size:12px}
ul{margin:0;padding-left:18px} li{margin:8px 0} .site{display:inline-block;min-width:68px;font-weight:600;margin-left:6px}
a{color:#7fb8e8;word-break:break-all} .d{color:var(--dim);font-size:12px}
</style></head><body><main>
<h1>Codex (${esc(MODEL)}) の確かめ</h1>
<p class="lead">所持 2 冊の確認で決められなかった候補を、Codex が網で見て答えた物です。結んだ物は詳細の板の鎖 (水色)、違う物は退けた記録、
決められなかった物は点線の鎖のまま (設定の棚「Home の一覧 (デバッグ)」で、その作者だけを出せます)。</p>
${groups.map(section).join('\n')}
</main></body></html>`;
  const file = path.join(OUT_DIR, TAG ? `home-link-codex-${TAG}.html` : 'home-link-codex.html');
  fs.writeFileSync(file, html);
  console.log(JSON.stringify({ file, ...Object.fromEntries(groups.map(([, list], index) => [['link', 'reject', 'unresolved'][index], list.length])) }));
}

const command = process.argv[2];
(async () => {
  if (command === 'batch') await batch();
  else if (command === 'run') run();
  else if (command === 'apply') await apply();
  else if (command === 'report') report();
  else console.log('usage: batch | run | apply | report  [--model m] [--limit n] [--tag x]');
})().catch((error) => { console.error(String(error && error.message || error).slice(0, 300)); process.exit(1); });
