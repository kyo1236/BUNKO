// Home の作者の結び (と候補) を「所持の作品が相手に 2 冊以上居るか」で確かめる (2026-09-24、利用者の指示)。
// 手順は .claude/skills/home-author-links/SKILL.md。画面へ出すのは数だけ (作者名・作品名は出さない)。
// 名前と題の入った控えはリポジトリの外 (環境変数 HOME_SURVEY_DIR、無ければ OS の一時フォルダの bunko-home-survey)。
//
// 走らせ方 (BUNKO を --remote-debugging-port=9222 で起こしてから。終わったら普通に起こし直す):
//   node scripts/home-link-verify.cjs collect   結び済みと候補の相手の作品一覧を引き、所持の本と突き合わせて数える (途中から続けられる)
//   node scripts/home-link-verify.cjs apply     2 冊以上確かめた候補を結ぶ。結び済みは外さない (弱い物は report に出すだけ)
//   node scripts/home-link-verify.cjs report    弱い結び・確かめた候補の一覧 (HTML。名前入り。Claude は開かない)
//   オプション: --sites pawchive,pixiv (引くサイト) --delay 1500 (引く間の休み ms。Pawchive は 8000) --only linked|candidate
//              --tag x (控えの名前を分ける) --fresh (控えを捨てて最初から)
//              --person home:f:XXXX,home:c:YYYY (その人だけ。試しに回す時)
//
// 確かめ方 (相手の作品を一つずつ数え、同じ作品・同じ所持の本を二度数えない):
//   ID    相手の作品の ID が所持の本と同じ (hitomi の gid・pixiv の投稿 px:<id>・Pawchive の投稿 ID)
//   題    題の鍵 (home-bundle.js の titleKeys。飾り・即売会・見本の語・頁数を剥がし巻数は残す) が一致し、
//         鍵が漢字かな 3 字 / 英数 6 字以上 (短い題は偶然当たる)
//   判定  確か = 2 冊以上 / 弱い = 1 冊 / 無し = 0 冊 / 不明 = 相手の一覧が引けなかった
//         見出しそのものの名乗り (hitomi の札の名乗り、外せない物) は数えない (self)
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { nfkc } = require(path.join(ROOT, 'src/lib/search-text.js'));
const HomeBundle = require(path.join(ROOT, 'src/renderer/home-bundle.js'));
const { parseSiteUrl, parseHandleValue } = require(path.join(ROOT, 'src/lib/home-authors.js'));

const OUT_DIR = process.env.HOME_SURVEY_DIR || path.join(os.tmpdir(), 'bunko-home-survey');
fs.mkdirSync(OUT_DIR, { recursive: true });
const ARGS = process.argv.slice(3);
const option = (name, fallback = '') => {
  const index = ARGS.indexOf(`--${name}`);
  return index >= 0 && ARGS[index + 1] ? ARGS[index + 1] : fallback;
};
const TAG = option('tag').replace(/[^a-z0-9-]/gi, '');
const SITES = (option('sites') || 'hitomi,pawchive,pixiv,nhentai').split(',').map((site) => site.trim()).filter(Boolean);
const ONLY = option('only');
const PERSONS = option('person') ? option('person').split(',') : null;
const DELAY_MS = Math.max(0, Number(option('delay', '1500')) || 0);
// --pages N: 相手の一覧を追う頁の上限を全サイトで N に (Pawchive は 8 秒の休み × 10 頁で一件 80 秒かかった。新しい方の数頁で足りる)
const PAGES_CAP = Math.max(0, Number(option('pages', '0')) || 0);
const OUT = path.join(OUT_DIR, TAG ? `verify-results-${TAG}.json` : 'verify-results.json');
const BY = '所持 2 冊の確認 (home-link-verify)';
// 結ぶのに要る冊数 (利用者の決め: 複数の作品で所持を確かめた物だけ)
const NEED = 2;
// これだけ確かめたら相手の一覧を引くのをやめる (網を塞がない)
const ENOUGH = 3;
// サイトごとの一頁の幅と上限 (作者頁の網と同じか浅く)
const LIMITS = {
  hitomi: { pageSize: 60, maxPages: 10 },
  pawchive: { pageSize: 50, maxPages: 10 },
  pixiv: { pageSize: 30, maxPages: 10 },
  nhentai: { pageSize: 25, maxPages: 8 },
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function units(key) {
  let n = 0;
  for (const ch of key) n += /[぀-ヿ㐀-鿿]/.test(ch) ? 2 : 1;
  return n;
}

// 題の鍵のうち、偶然当たらない長さの物
function strongKeys(title) {
  return HomeBundle.titleKeys(nfkc(String(title || ''))).filter((key) => units(key) >= 6);
}

// 所持の本の ID の印 (相手の作品の ID と突き合わせる)
function ownedMarks(book) {
  const marks = [];
  const id = String(book.id || '');
  if (/^\d+$/.test(id)) marks.push(`hitomi:${id}`);
  if (id.startsWith('px:')) marks.push(`pixiv:${id.slice(3)}`);
  if (book.postId) marks.push(`paw:${book.postId}`);
  return marks;
}

function workMarks(site, work) {
  const id = String(work.id || '');
  if (site === 'hitomi' && /^\d+$/.test(id)) return [`hitomi:${id}`];
  if (site === 'pixiv') {
    const m = id.match(/(\d+)$/);
    return m ? [`pixiv:${m[1]}`] : [];
  }
  if (site === 'pawchive') {
    const m = id.match(/^pw:[^:]+:[^:]+:(.+)$/);
    return m ? [`paw:${m[1]}`] : [];
  }
  return [];
}

// 相手の作品一覧の語 (Home の作者頁の網と同じ形。nhentai は artist: / group: の語)
function queryFor(site, value, page) {
  const { pageSize } = LIMITS[site];
  if (site === 'hitomi') {
    const parsed = parseHandleValue(value);
    return { source: 'hitomi', query: `${parsed.type}:${parsed.name.replace(/\s+/g, '_')}`, language: 'japanese', sort: 'added', page, pageSize };
  }
  if (site === 'pawchive') {
    const cut = value.indexOf(':');
    return { source: 'pawchive', query: `${value.slice(0, cut)}/${value.slice(cut + 1)}`, sort: 'added', page, pageSize };
  }
  if (site === 'pixiv') return { source: 'pixiv', query: `user:${value}`, sort: 'added', page, pageSize };
  const group = value.startsWith('group:');
  const slug = group ? value.slice(6) : value;
  return { source: 'nhentai', query: `${group ? 'group' : 'artist'}:${slug.replace(/-/g, '_')}`, sort: 'added', page, pageSize };
}

async function searchOnce(cdp, payload) {
  return cdp.evaluate(`(async () => {
    try {
      const r = await window.hitomi.search({ background: true, requestId: 'lv-' + Date.now() + '-' + Math.random().toString(36).slice(2), scope: 'all', ...${JSON.stringify(payload)} });
      return {
        hasNext: typeof r.hasNext === 'boolean' ? r.hasNext : null,
        total: typeof r.total === 'number' ? r.total : null,
        rows: (r.galleries || []).filter((g) => g && !g.error && g.id != null && g.kind !== 'creator').map((g) => ({ id: String(g.id), title: String(g.title || '') })),
      };
    } catch (error) { return { rows: [], error: String(error && error.message || error).slice(0, 80) }; }
  })()`);
}

// 休みを入れて引く。429 (断られた) なら長く休んで二度まで引き直す
async function search(cdp, payload) {
  if (DELAY_MS) await sleep(DELAY_MS);
  let got = await searchOnce(cdp, payload);
  for (const wait of [90000, 180000]) {
    if (!got.error || !/429/.test(got.error)) break;
    await sleep(wait);
    got = await searchOnce(cdp, payload);
  }
  return got;
}

async function listPersons(cdp) {
  return cdp.evaluate(`(async () => {
    const out = []; let page = 0;
    for (let tries = 0; page < 80 && tries < 200; tries += 1) {
      let r;
      try { r = await window.hitomi.search({ background: true, requestId: 'lv-list-' + page + '-' + tries, query: '', source: 'home', scope: 'all', sort: 'title', sortDir: 'asc', type: '', page, pageSize: 60, spanPages: 1 }); }
      catch (error) { continue; }
      for (const g of r.galleries || []) out.push({ id: g.id, title: g.title, kind: g.home && g.home.kind, links: g.home && g.home.links });
      if (!r.hasNext) break;
      page += 1;
    }
    return out;
  })()`);
}

async function ownedBooks(cdp, id) {
  return cdp.evaluate(`(async () => {
    const p = await window.hitomi.home({ action: 'author', id: ${JSON.stringify(id)} });
    return ((p && p.books) || []).filter((b) => !b.candidate).map((b) => ({
      id: String(b.id), origin: b.origin, title: String((b.gallery && b.gallery.title) || ''), postId: String((b.gallery && b.gallery.postId) || ''),
    }));
  })()`);
}

// 相手の一覧を頁ごとに引き、所持の本が何冊居るか数える
async function verifyLink(cdp, site, value, books) {
  const byMark = new Map();
  const byKey = new Map();
  books.forEach((book, index) => {
    for (const mark of ownedMarks(book)) byMark.set(mark, index);
    for (const key of strongKeys(book.title)) if (!byKey.has(key)) byKey.set(key, index);
  });
  const found = new Map();
  const used = new Set();
  const { pageSize } = LIMITS[site];
  const maxPages = PAGES_CAP ? Math.min(LIMITS[site].maxPages, PAGES_CAP) : LIMITS[site].maxPages;
  let pages = 0;
  let works = 0;
  let error = '';
  for (let page = 0; page < maxPages; page += 1) {
    const got = await search(cdp, queryFor(site, value, page));
    pages += 1;
    if (got.error) {
      error = got.error;
      break;
    }
    works += got.rows.length;
    // 数えるのは相手の作品 (一冊の作品に所持の写しが二つあっても一つ)。所持の一冊も二つの作品に数えない
    for (const work of got.rows) {
      if (found.has(work.id)) continue;
      const byIdHit = workMarks(site, work).map((mark) => byMark.get(mark)).find((index) => index != null && !used.has(index));
      const byTitleHit = byIdHit != null ? null : strongKeys(work.title).map((key) => byKey.get(key)).find((index) => index != null && !used.has(index));
      const index = byIdHit != null ? byIdHit : byTitleHit;
      if (index == null) continue;
      used.add(index);
      found.set(work.id, { how: byIdHit != null ? 'id' : 'title', index });
    }
    if (found.size >= ENOUGH) break;
    const ended = typeof got.hasNext === 'boolean' ? !got.hasNext
      : (got.rows.length < pageSize || (got.total != null && (page + 1) * pageSize >= got.total));
    if (ended) break;
  }
  const count = found.size;
  const byId = [...found.values()].filter((hit) => hit.how === 'id').length;
  const verdict = error && !works ? 'unknown' : count >= NEED ? 'sure' : count === 1 ? 'weak' : 'none';
  return {
    verdict, count, byId, byTitle: count - byId, pages, works, error,
    matched: [...found.values()].map((hit) => books[hit.index].title),
  };
}

function load() {
  if (ARGS.includes('--fresh') || !fs.existsSync(OUT)) return { at: new Date().toISOString(), results: [] };
  return JSON.parse(fs.readFileSync(OUT, 'utf8'));
}

async function collect() {
  const data = load();
  const done = new Set(data.results.map((row) => `${row.id}|${row.site}|${row.value}`));
  const cdp = await connect();
  const persons = await listPersons(cdp);
  const tally = { persons: persons.length, checked: 0, skipped: 0 };
  const save = () => fs.writeFileSync(OUT, JSON.stringify(data, null, 1));
  for (const person of persons) {
    if (PERSONS && !PERSONS.includes(person.id)) continue;
    const targets = [];
    for (const site of SITES) {
      for (const link of (person.links && person.links[site]) || []) {
        if (link.fixed) continue;
        if (ONLY && link.state !== ONLY) continue;
        // nhentai の推測 (名乗りから作った候補) は数えない。確かめるのは結び済みと、突き合わせの候補
        if (site === 'nhentai' && link.state !== 'linked') continue;
        const value = parseSiteUrl(site, link.url);
        if (!value || done.has(`${person.id}|${site}|${value}`)) continue;
        targets.push({ site, value, url: link.url, state: link.state, suggested: Boolean(link.suggested), note: String(link.note || '') });
      }
    }
    if (!targets.length) continue;
    const books = await ownedBooks(cdp, person.id);
    for (const target of targets) {
      // その人の所持が 2 冊に満たなければ 2 冊は確かめられない (数えるだけ数える)
      const result = await verifyLink(cdp, target.site, target.value, books);
      data.results.push({ id: person.id, kind: person.kind, display: person.title, owned: books.length, ...target, ...result, at: new Date().toISOString() });
      done.add(`${person.id}|${target.site}|${target.value}`);
      tally.checked += 1;
      if (tally.checked % 10 === 0) save();
    }
  }
  cdp.close();
  save();
  const counts = {};
  for (const row of data.results) {
    const key = `${row.site}:${row.state}:${row.verdict}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  console.log(JSON.stringify({ ...tally, rows: data.results.length, counts }, null, 1));
}

async function apply() {
  const data = load();
  const cdp = await connect();
  const tally = { ok: 0, fail: 0, reasons: {} };
  // pixiv と Pawchive を先に (hitomi を結ぶと見出しが作者フォルダに寄って id が変わる)
  const todo = data.results.filter((row) => row.state === 'candidate' && row.verdict === 'sure' && !(row.applied && row.applied.ok))
    .sort((a, b) => (a.site === 'hitomi') - (b.site === 'hitomi'));
  for (const row of todo) {
    const note = `所持の作品 ${row.count} 冊を相手の一覧で確認 (ID ${row.byId}・題 ${row.byTitle})`;
    const reply = await cdp.evaluate(`(async () => {
      try {
        const r = await window.hitomi.home({ action: 'link', id: ${JSON.stringify(row.id)}, site: ${JSON.stringify(row.site)}, op: 'save', url: ${JSON.stringify(row.url)}, by: ${JSON.stringify(BY)}, note: ${JSON.stringify(note)} });
        return { ok: Boolean(r && r.ok), reason: (r && r.reason) || '' };
      } catch (error) { return { ok: false, reason: String(error && error.message || error).slice(0, 60) }; }
    })()`);
    row.applied = reply;
    if (reply.ok) tally.ok += 1;
    else {
      tally.fail += 1;
      tally.reasons[reply.reason] = (tally.reasons[reply.reason] || 0) + 1;
    }
  }
  cdp.close();
  fs.writeFileSync(OUT, JSON.stringify(data, null, 1));
  const weakLinked = data.results.filter((row) => row.state === 'linked' && (row.verdict === 'weak' || row.verdict === 'none')).length;
  console.log(JSON.stringify({ ...tally, weakLinked, note: '結び済みの弱い物は外していない。report で利用者に見せる' }));
}

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function report() {
  const data = load();
  const label = { pixiv: 'pixiv', pawchive: 'Pawchive', hitomi: 'hitomi', nhentai: 'nhentai' };
  const verdictLabel = { sure: '確か', weak: '弱い (1 冊)', none: '無し (0 冊)', unknown: '引けなかった' };
  const groups = [
    ['結び済みで弱い物 (所持の作品が 0〜1 冊しか相手に居ない)', data.results.filter((row) => row.state === 'linked' && (row.verdict === 'weak' || row.verdict === 'none'))],
    ['候補で確かめた物 (2 冊以上。apply で結んだ)', data.results.filter((row) => row.state === 'candidate' && row.verdict === 'sure')],
    ['候補で足りない物 (結んでいない)', data.results.filter((row) => row.state === 'candidate' && row.verdict !== 'sure')],
    ['引けなかった物', data.results.filter((row) => row.verdict === 'unknown')],
  ];
  const section = ([title, rows]) => {
    if (!rows.length) return '';
    const items = rows.sort((a, b) => String(a.display).localeCompare(String(b.display), 'ja')).map((row) => `<li><b>${esc(row.display)}</b>
      <span class="site">${label[row.site]}</span> <a href="${esc(row.url)}">${esc(row.url)}</a>
      <div class="d">${verdictLabel[row.verdict]} · 所持 ${row.owned} 冊中 ${row.count} 冊 (ID ${row.byId}・題 ${row.byTitle}) · 相手の作品 ${row.works} 件を見た${row.error ? ` · ${esc(row.error)}` : ''}${row.applied ? ` · 結び ${row.applied.ok ? '済' : `失敗 ${esc(row.applied.reason)}`}` : ''}</div>
      ${row.matched && row.matched.length ? `<div class="d">一致: ${row.matched.map(esc).join(' / ')}</div>` : ''}</li>`).join('');
    return `<section><h2>${esc(title)} <small>${rows.length} 件</small></h2><ul>${items}</ul></section>`;
  };
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>作者の結びの確かめ</title>
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
<h1>作者の結びの確かめ (所持の作品 ${NEED} 冊以上)</h1>
<p class="lead">相手のサイトの作品一覧に、あなたの所持の作品が何冊居るかを数えました。結び済みの物は外していません。
弱い物は BUNKO の詳細の板の切れた鎖で外せます。<br>
弱い = 間違い、ではありません。所持が同人誌 (hitomi) だけの人の pixiv / Pawchive は、相手がイラストや支援の投稿で題が合わないので、
正しい結びでも数が出ません。外すのは、相手の頁を見て別人だと分かった時だけにしてください。</p>
${groups.map(section).join('\n')}
</main></body></html>`;
  const file = path.join(OUT_DIR, TAG ? `home-link-verify-${TAG}.html` : 'home-link-verify.html');
  fs.writeFileSync(file, html);
  const counts = Object.fromEntries(groups.map(([title, rows], index) => [['weakLinked', 'sureCandidate', 'shortCandidate', 'unknown'][index], rows.length]));
  console.log(JSON.stringify({ file, ...counts }));
}

const command = process.argv[2];
(async () => {
  if (command === 'collect') await collect();
  else if (command === 'apply') await apply();
  else if (command === 'report') report();
  else console.log('usage: collect | apply | report  [--sites a,b] [--delay ms] [--only linked|candidate] [--tag x] [--fresh] [--person id,id]');
})().catch((error) => { console.error(String(error && error.message || error).slice(0, 300)); process.exit(1); });
