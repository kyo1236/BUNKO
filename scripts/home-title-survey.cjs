// Home の作者の頁を、作者の作品の題 + サイトの検索で探す (2026-09-24、利用者の指示)。
// 画面へ出すのは数だけ (作者名・作品名は出さない)。名前と題の入った控えはリポジトリの外
// (環境変数 HOME_SURVEY_DIR、無ければ OS の一時フォルダの bunko-home-survey) に置く。
//
// 走らせ方 (BUNKO を --remote-debugging-port=9222 で起こしてから。終わったら普通に起こし直す):
//   node scripts/home-title-survey.cjs collect   結んでいないサイトごとに、所持の本の題でそのサイトを引いて突き合わせる
//   node scripts/home-title-survey.cjs apply     確かな物を home の口 (link) で結び、怪しい物を候補 (suggest) に足す
//   node scripts/home-title-survey.cjs report    怪しい物の一覧 (HTML。名前と題入り)
//   オプション: --sites pawchive (引くサイトを絞る) --delay 6000 (検索の間の休み ms) --tag paw (控えの名前を分ける)
//   Pawchive は短い間に何百回も引くと HTTP 429 で断る (2026-09-24 に踏んだ): 休みを入れて引き、429 なら長く休んでから引き直す
//
// 突き合わせ: 題は home-bundle.js の題の鍵 (飾り・即売会の記号・見本や告知の語・頁数の印を剥がし、巻数は残す) が
// 一致した時だけ当たりとする。当たりの持ち主 (pixiv の利用者・Pawchive の作者・hitomi の artist / group) ごとに数え、
//   別々の題が二つ以上当たった持ち主                       → 結ぶ
//   題が一つ当たり、持ち主の名 (pixiv の利用者名・Pawchive の作者名・hitomi のタグ) が作者の名と合う → 候補
//     (2026-09-24 まではこれも結んだ。今は apply が候補に回す。前の動きは apply --direct)
//   それ以外 (題が一つ当たっただけ・持ち主が割れた)        → 候補 (怪しい)
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { nfkc, hiraToKata, kataToRomaji, foldRomajiName } = require(path.join(ROOT, 'src/lib/search-text.js'));
const HomeBundle = require(path.join(ROOT, 'src/renderer/home-bundle.js'));
const DupeCluster = require(path.join(ROOT, 'src/renderer/dupe-cluster.js'));

const OUT_DIR = process.env.HOME_SURVEY_DIR || path.join(os.tmpdir(), 'bunko-home-survey');
fs.mkdirSync(OUT_DIR, { recursive: true });
const ARGS = process.argv.slice(3);
const option = (name, fallback = '') => {
  const index = ARGS.indexOf(`--${name}`);
  return index >= 0 && ARGS[index + 1] ? ARGS[index + 1] : fallback;
};
const TAG = option('tag').replace(/[^a-z0-9-]/gi, '');
const ONLY_SITES = option('sites') ? option('sites').split(',').map((site) => site.trim()).filter(Boolean) : null;
const DELAY_MS = Math.max(0, Number(option('delay', '0')) || 0);
const OUT = path.join(OUT_DIR, TAG ? `title-results-${TAG}.json` : 'title-results.json');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const BY = '題の突き合わせ 2026-09-24';
// 一人あたり、サイトあたりに引く題の数 (pixiv の API 車線と Pawchive を塞がない)
const TITLES_PER_SITE = 2;

async function connect() {
  const list = await (await fetch('http://127.0.0.1:9222/json')).json();
  const page = list.find((item) => item.type === 'page' && /文匣/.test(item.title || ''));
  if (!page) throw new Error('文匣 の頁が見つからない');
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

function nameKey(value) {
  return hiraToKata(nfkc(String(value == null ? '' : value))).toLowerCase().replace(/[\s_・･.\-]+/g, '');
}
function romaKey(value) {
  const text = nfkc(String(value || '')).trim();
  if (!text) return '';
  if (/^[\x20-\x7e]+$/.test(text)) return foldRomajiName(text);
  const roma = kataToRomaji(text);
  return roma ? foldRomajiName(roma) : '';
}
function units(key) {
  let n = 0;
  for (const ch of key) n += /[぀-ヿ㐀-鿿]/.test(ch) ? 2 : 1;
  return n;
}

// 検索に渡す語: 先頭の即売会・サークルと末尾の注記を剥がし、括弧の中身も落とした題の本文
function queryOf(title) {
  let text = DupeCluster.stripLeadingCredits(nfkc(String(title || '')).trim());
  text = text.replace(/[[【(（][^\]】)）]*[\]】)）]/g, ' ').replace(/\s+/g, ' ').trim();
  return text.slice(0, 40);
}

// 引いて当てる値になる、区別の付く題 (鍵が漢字かな 4 字 / 英数 8 字以上)
function distinctTitles(books) {
  const seen = new Set();
  const out = [];
  for (const book of books) {
    const keys = HomeBundle.titleKeys(book.title).filter((key) => units(key) >= 8);
    if (!keys.length) continue;
    const key = keys[0];
    if (seen.has(key)) continue;
    const query = queryOf(book.title);
    if (!query || units(nameKey(query)) < 8) continue;
    seen.add(key);
    out.push({ title: book.title, key, keys, query, origin: book.origin });
  }
  return out;
}

async function listPersons(cdp) {
  return cdp.evaluate(`(async () => {
    const out = []; let page = 0;
    for (let tries = 0; page < 80 && tries < 200; tries += 1) {
      let r;
      try { r = await window.hitomi.search({ background: true, requestId: 'ts-' + page + '-' + tries, query: '', source: 'home', scope: 'all', sort: 'title', sortDir: 'asc', type: '', page, pageSize: 60, spanPages: 1 }); }
      catch (error) { continue; }
      for (const g of r.galleries || []) out.push({ id: g.id, title: g.title, home: g.home });
      if (!r.hasNext) break;
      page += 1;
    }
    return out;
  })()`);
}

async function ownedBooks(cdp, id) {
  return cdp.evaluate(`(async () => {
    const p = await window.hitomi.home({ action: 'author', id: ${JSON.stringify(id)} });
    return ((p && p.books) || []).filter((b) => !b.candidate).map((b) => ({ title: String((b.gallery && b.gallery.title) || ''), origin: b.origin }));
  })()`);
}

// サイトの検索。休みを入れ、429 (断られた) なら長く休んでから一度だけ引き直す
async function siteSearch(cdp, site, query) {
  if (DELAY_MS) await sleep(DELAY_MS);
  let got = await siteSearchOnce(cdp, site, query);
  for (const wait of [90000, 180000]) {
    if (!got.error || !/429/.test(got.error)) break;
    await sleep(wait);
    got = await siteSearchOnce(cdp, site, query);
  }
  return got;
}

// サイトの検索の一回 (BUNKO の検索の口で。控え・作法・素性のクッキーは BUNKO が持つ)
async function siteSearchOnce(cdp, site, query) {
  const payload = site === 'hitomi'
    ? { source: 'hitomi', query, language: 'japanese', sort: 'added', page: 0, pageSize: 25 }
    : { source: site, query, sort: 'added', page: 0, pageSize: site === 'pixiv' ? 30 : 50 };
  return cdp.evaluate(`(async () => {
    try {
      const r = await window.hitomi.search({ background: true, requestId: 'ts-q-' + Date.now() + '-' + Math.random().toString(36).slice(2), scope: 'all', ...${JSON.stringify(payload)} });
      return { rows: (r.galleries || []).filter((g) => g && !g.error && g.kind !== 'creator').map((g) => ({
        title: String(g.title || ''),
        userId: String(g.userId || ''),
        userName: String((g.artists && g.artists[0] && (g.artists[0].label || g.artists[0].name)) || ''),
        id: String(g.id || ''),
        artists: (g.artists || []).map((a) => String(a && a.name || '')).filter(Boolean),
        groups: (g.groups || []).map((a) => String(a && a.name || '')).filter(Boolean),
        labels: [...(g.artists || []), ...(g.groups || [])].map((a) => String(a && (a.label || '') || '')).filter(Boolean),
      })) };
    } catch (error) { return { rows: [], error: String(error && error.message || error).slice(0, 80) }; }
  })()`);
}

// 当たりの持ち主。pixiv は利用者 ID、Pawchive は service:user、hitomi は artist / group のタグ
function ownersOf(site, row) {
  if (site === 'pixiv') return row.userId ? [{ value: row.userId, names: [row.userName] }] : [];
  if (site === 'pawchive') {
    const m = row.id.match(/^pw:([a-z]+):([^:]+):/);
    return m ? [{ value: `${m[1]}:${m[2]}`, names: [row.userName] }] : [];
  }
  const out = [];
  for (const group of row.groups) out.push({ value: `group:${group}`, names: [group, ...row.labels] });
  for (const artist of row.artists) out.push({ value: artist, names: [artist, ...row.labels] });
  return out;
}

function siteUrl(site, value) {
  if (site === 'pixiv') return `https://www.pixiv.net/users/${value}`;
  if (site === 'pawchive') { const cut = value.indexOf(':'); return `https://pawchive.pw/${value.slice(0, cut)}/user/${encodeURIComponent(value.slice(cut + 1))}`; }
  if (value.startsWith('group:')) return `https://hitomi.la/group/${encodeURIComponent(value.slice(6))}-all.html`;
  return `https://hitomi.la/artist/${encodeURIComponent(value)}-all.html`;
}

async function collect() {
  const cdp = await connect();
  const persons = await listPersons(cdp);
  const counts = { persons: persons.length, searched: { pixiv: 0, pawchive: 0, hitomi: 0 }, errors: 0 };
  const results = [];
  for (const person of persons) {
    const home = person.home || {};
    const linked = (site) => (home.links[site] || []).some((link) => link.state === 'linked');
    let sites = ['pixiv', 'pawchive'].filter((site) => !linked(site));
    if (home.kind === 'folder' && !linked('hitomi')) sites.push('hitomi');
    if (ONLY_SITES) sites = sites.filter((site) => ONLY_SITES.includes(site));
    if (!sites.length) continue;
    const books = await ownedBooks(cdp, person.id);
    const titles = distinctTitles(books);
    if (!titles.length) continue;
    const names = [person.title, home.name, home.folderName, ...(home.circles || []).map((c) => c.label), ...(home.authors || []).map((a) => a.label)]
      .map((n) => String(n || '').replace(/\s*\((?:作者|\d+)\)$/, '').trim()).filter(Boolean);
    const nameKeys = new Set(names.map(nameKey).filter((k) => k && units(k) >= 4));
    const romaKeys = new Set(names.map(romaKey).filter((k) => k && k.length >= 5));
    for (const site of sites) {
      // その源泉の本の題はそのサイトで引いても本人の投稿しか当たらない (手がかりにならない): 他の源泉の本の題を先に
      const ordered = [...titles.filter((t) => t.origin !== site), ...titles.filter((t) => t.origin === site)].slice(0, TITLES_PER_SITE);
      const tally = new Map();
      for (const title of ordered) {
        counts.searched[site] += 1;
        const got = await siteSearch(cdp, site, title.query);
        if (got.error) counts.errors += 1;
        for (const row of got.rows || []) {
          const keys = HomeBundle.titleKeys(row.title);
          if (!keys.some((key) => title.keys.includes(key))) continue;
          for (const owner of ownersOf(site, row)) {
            if (!tally.has(owner.value)) tally.set(owner.value, { value: owner.value, titles: new Set(), names: new Set() });
            const hit = tally.get(owner.value);
            hit.titles.add(title.key);
            for (const n of owner.names) if (n) hit.names.add(n);
          }
        }
      }
      if (!tally.size) continue;
      const judged = [...tally.values()].map((hit) => {
        const nameAgree = [...hit.names].some((n) => nameKeys.has(nameKey(n)) || romaKeys.has(romaKey(n)));
        const strong = hit.titles.size >= 2 || (hit.titles.size >= 1 && nameAgree);
        return { value: hit.value, titles: hit.titles.size, nameAgree, strong };
      });
      const strong = judged.filter((row) => row.strong);
      // サークルは作者ごとに pixiv / Pawchive を持つことがある (利用者の指摘): 確かな持ち主が二人以上でも割れとしない
      const many = site !== 'hitomi' && (home.kind === 'circle' || (home.circles || []).some((circle) => !circle.minor && !circle.candidate));
      for (const row of judged) {
        const decision = row.strong && (strong.length === 1 || many) ? 'link' : 'suspicious';
        results.push({
          id: person.id, kind: home.kind, display: person.title, site, value: row.value, url: siteUrl(site, row.value), decision,
          titles: row.titles, nameAgree: row.nameAgree,
          reason: decision === 'link' ? '' : (strong.length > 1 ? '持ち主が割れた' : '題が一つ当たっただけ (名前は合わない)'),
          sampleTitles: ordered.map((t) => t.title),
        });
      }
    }
  }
  cdp.close();
  fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), counts, results }, null, 1));
  const tally = {};
  for (const row of results) tally[`${row.site}:${row.decision}`] = (tally[`${row.site}:${row.decision}`] || 0) + 1;
  console.log(JSON.stringify({ counts, tally, people: new Set(results.map((r) => r.id)).size }, null, 1));
}

async function apply() {
  const data = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  const cdp = await connect();
  const tally = { ok: 0, fail: 0, reasons: {}, suggested: 0 };
  // 2026-09-24 から: 直に結ぶのは別々の題が 2 つ以上当たった持ち主だけ (所持の作品 2 冊の確認)。
  // 「題が一つ + 名前が合う」は候補に回し、scripts/home-link-verify.cjs で確かめる。前の動きは --direct
  if (!ARGS.includes('--direct')) {
    for (const row of data.results) {
      if (row.decision === 'link' && row.titles < 2) {
        row.decision = 'suspicious';
        row.reason = '題が一つ当たっただけ (所持の作品 2 冊の確認待ち)';
      }
    }
  }
  const links = data.results.filter((row) => row.decision === 'link').sort((a, b) => (a.site === 'hitomi') - (b.site === 'hitomi'));
  for (const row of links) {
    const note = `題 ${row.titles} 件が一致${row.nameAgree ? '・持ち主の名も一致' : ''}`;
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
  const linkedSites = new Set(links.filter((row) => row.applied && row.applied.ok).map((row) => `${row.id}|${row.site}`));
  const rows = data.results.filter((row) => row.decision !== 'link' && !linkedSites.has(`${row.id}|${row.site}`))
    .map((row) => ({ id: row.id, site: row.site, url: row.url, note: `${row.reason}: 題 ${row.titles} 件が一致` }));
  if (rows.length) {
    const reply = await cdp.evaluate(`(async () => {
      try { return await window.hitomi.home({ action: 'suggest', by: ${JSON.stringify(BY)}, rows: ${JSON.stringify(rows)} }); }
      catch (error) { return { ok: false, reason: String(error && error.message || error).slice(0, 80) }; }
    })()`);
    tally.suggested = reply && reply.added ? reply.added : 0;
    data.suggested = reply;
  }
  cdp.close();
  fs.writeFileSync(OUT, JSON.stringify(data, null, 1));
  console.log(JSON.stringify(tally));
}

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function report() {
  const data = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  const linkedSites = new Set(data.results.filter((row) => row.decision === 'link' && row.applied && row.applied.ok).map((row) => `${row.id}|${row.site}`));
  const doubt = data.results.filter((row) => (row.decision !== 'link' || (row.applied && !row.applied.ok)) && !linkedSites.has(`${row.id}|${row.site}`));
  const done = data.results.filter((row) => row.decision === 'link' && row.applied && row.applied.ok);
  const byPerson = new Map();
  for (const row of doubt) {
    if (!byPerson.has(row.id)) byPerson.set(row.id, []);
    byPerson.get(row.id).push(row);
  }
  const label = { pixiv: 'pixiv', pawchive: 'Pawchive', hitomi: 'hitomi' };
  const sections = [...byPerson.values()].sort((a, b) => String(a[0].display).localeCompare(String(b[0].display), 'ja')).map((rows) => {
    const head = rows[0];
    const kind = head.kind === 'folder' ? '作者フォルダ' : (head.kind === 'circle' ? 'サークル' : '作者');
    return `<section><h2>${esc(head.display)} <small>${kind}</small></h2><p class="t">引いた題: ${head.sampleTitles.map(esc).join(' / ')}</p><ul>${rows.map((row) => `<li><span class="site">${label[row.site]}</span> <a href="${esc(row.url)}">${esc(row.url)}</a><div class="doubt">${esc(row.reason)} (題 ${row.titles} 件)</div></li>`).join('')}</ul></section>`;
  }).join('\n');
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>題の突き合わせの怪しい物</title>
<style>
:root{--bg:#15171a;--fg:#e8e6e1;--dim:#9a978f;--line:#2c3036}
@media (prefers-color-scheme: light){:root{--bg:#fafaf7;--fg:#1d1f22;--dim:#6b6860;--line:#ddd9cf}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 system-ui,sans-serif}
main{max-width:980px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:20px;margin:0 0 4px} p.lead{color:var(--dim);margin:0 0 20px}
section{border-top:1px solid var(--line);padding:14px 0} h2{font-size:16px;margin:0 0 4px} h2 small{font-weight:400;color:var(--dim);margin-left:8px;font-size:12px}
p.t{color:var(--dim);font-size:12px;margin:0 0 6px} ul{margin:0;padding-left:18px} li{margin:6px 0}
.site{display:inline-block;min-width:68px;font-weight:600} a{color:#7fb8e8;word-break:break-all} .doubt{color:var(--dim);font-size:12px}
</style></head><body><main>
<h1>題の突き合わせで怪しかった物 (${byPerson.size} 人・${doubt.length} 件)</h1>
<p class="lead">作品の題でサイトを引いて、題が一致した持ち主です。結んだ物 ${done.length} 件は詳細の板に鎖の印 (水色) で出ています。<br>
ここに並ぶ物は結んでいません。BUNKO の詳細の板に候補 (点線の琥珀の鎖) として出ているので、「候補あり」で絞って確かめてください。</p>
${sections}
</main></body></html>`;
  const file = path.join(OUT_DIR, TAG ? `home-title-doubtful-${TAG}.html` : 'home-title-doubtful.html');
  fs.writeFileSync(file, html);
  console.log(JSON.stringify({ file, people: byPerson.size, items: doubt.length, linked: done.length }));
}

const command = process.argv[2];
(async () => {
  if (command === 'collect') await collect();
  else if (command === 'apply') await apply();
  else if (command === 'report') report();
  else console.log('usage: collect | apply | report');
})().catch((error) => { console.error(String(error && error.message || error).slice(0, 300)); process.exit(1); });
