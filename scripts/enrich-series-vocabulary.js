'use strict';
// hitomi の series で「日本語がどこにも無い」物に、公式の日本語題を足す。
//
// なぜ辞書に無かったか: aliases.json は danbooru の正準名から hitomi を探す。
// danbooru は `meitantei_conan`、hitomi は `detective conan`。英語の綴りが
// 違うだけで丸ごと落ちていた (名探偵コナン・ハイキュー・けいおん が引けない正体)。
// 綴りの橋は機械では作れないので、作品そのものの台帳 (AniList) に訊く。
//
// 採る条件 (どれか一つでも欠けたら採らない):
//   - AniList の english か romaji か別名が、hitomi の語とそっくり同じに正規化される
//   - 作品の出どころが日本 (countryOfOrigin=JP)。中国語・韓国語の native を拾わない
//   - native に かな か 漢字 があり、簡体字だけではない
//   - hitomi に その series が実在する (全語一覧 + tagindex で確かめる)
//   - 既に日本語を持っている語は触らない (重複追加しない)
//
// 出力は提案だけ。取り込みは scripts/apply-series-vocabulary.js。
//   node scripts/enrich-series-vocabulary.js [件数]
const fs = require('fs');
const path = require('path');
const https = require('https');
const { get } = require('../src/lib/http');
const { aliasKey, hasCjk } = require('../src/lib/search-text');
const { tagNameKey } = require('../src/lib/title-keys');

const ROOT = path.join(__dirname, '..');
const WORK = path.join(ROOT, 'work', 'vocabulary-audit-2026-09-21');
const OUT = path.join(WORK, 'series-proposals.json');
const LIMIT = Number(process.argv[2] || 400);
const UA = 'bunko/1.0 (series title lookup; local desktop app; one user)';

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 簡体字だけの表記は日本語の正式名ではない
const SIMPLIFIED = /[贼灭档兽绘将级战术记录乐动画恋书爱读会园头发师龙风开关铁门问间际队马鸟鱼黄单双变现实处涩纱织丽艳侦柯灵]/;
const hasKana = (s) => /[ぁ-んァ-ヶー]/.test(s);
const japanese = (s) => hasCjk(s) && !(SIMPLIFIED.test(s) && !hasKana(s));
// 比較用: 記号と空白を落として突き合わせる ("Detective Conan" ↔ "detective conan")
const norm = (s) => aliasKey(String(s || '').replace(/[^\p{L}\p{N}\s]/gu, ' '));

function anilist(search) {
  const query = `query($s:String){Page(perPage:10){media(search:$s){id type format countryOfOrigin startDate{year} title{romaji english native} synonyms siteUrl}}}`;
  const body = JSON.stringify({ query, variables: { s: search } });
  return new Promise((resolve) => {
    const req = https.request('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA, 'Content-Length': Buffer.byteLength(body) },
      timeout: 20000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve({ status: res.statusCode, media: [] });
        try { resolve({ status: 200, media: JSON.parse(data).data.Page.media || [] }); } catch { resolve({ status: 200, media: [] }); }
      });
    });
    req.on('error', () => resolve({ status: 0, media: [] }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, media: [] }); });
    req.end(body);
  });
}

const encodeTermPath = (term) => String(term).split('').map((ch) => (ch === ' ' ? '_' : ch === '/' ? 'slash' : ch === '.' ? 'dot' : encodeURIComponent(ch))).join('/');

// hitomi 側の実在を、配布時と同じ公開索引で確かめる。全語一覧は控えなので二重に見る
async function confirmHitomi(name) {
  const url = `https://tagindex.hitomi.la/series/${encodeTermPath(name)}.json`;
  try {
    const res = await get(url, { Referer: 'https://hitomi.la/' });
    const rows = await res.json();
    const hit = Array.isArray(rows) && rows.find((row) => row[0] === name && row[2] === 'series');
    return hit ? { url, checkedAt: new Date().toISOString(), count: hit[1] } : null;
  } catch { return null; }
}

function pickMedia(media, name) {
  const target = norm(name);
  const matches = media.filter((m) => {
    if (m.countryOfOrigin !== 'JP') return false;
    const titles = [m.title && m.title.english, m.title && m.title.romaji, ...(m.synonyms || [])];
    return titles.some((t) => t && norm(t) === target);
  });
  if (!matches.length) return null;
  // 親作品を採る。劇場版・続編は年が後、TV/漫画が先
  const rank = (m) => (m.format === 'TV' || m.format === 'MANGA' ? 0 : m.format === 'TV_SHORT' || m.format === 'ONA' ? 1 : 2);
  matches.sort((a, b) => rank(a) - rank(b) || ((a.startDate && a.startDate.year) || 9999) - ((b.startDate && b.startDate.year) || 9999));
  const best = matches.find((m) => m.title && japanese(m.title.native));
  return best || null;
}

async function main() {
  const hitomi = readJson(path.join(ROOT, 'work/vocabulary-research/data/hitomi-vocabulary.json'), null);
  const nhentai = readJson(path.join(ROOT, 'work/vocabulary-research/data/nhentai-vocabulary.json'), null);
  if (!hitomi) throw new Error('hitomi 全語一覧がありません');
  const series = hitomi.namespaces.series;
  const nhParody = (nhentai && nhentai.namespaces && nhentai.namespaces.parody) || {};

  // 既に日本語を持っている語を集める (三つの辞書すべて)
  const covered = new Set();
  for (const e of readJson(path.join(ROOT, 'src/lib/data/aliases.json'), { entries: [] }).entries) {
    if (e.type === 'series' && (e.labels || []).some(hasCjk)) covered.add(tagNameKey(e.name));
  }
  for (const key of Object.keys(readJson(path.join(ROOT, 'src/lib/data/label-overrides.json'), {}))) {
    if (key.startsWith('series ')) covered.add(tagNameKey(key.slice(7)));
  }
  for (const e of readJson(path.join(ROOT, 'src/lib/data/search-vocabulary.json'), { entries: [] }).entries) {
    const out = e.outputs && e.outputs.hitomi;
    if (out && out.type === 'series') covered.add(tagNameKey(out.name));
  }

  const gaps = Object.entries(series)
    .filter(([name]) => !covered.has(tagNameKey(name)))
    .sort((a, b) => b[1] - a[1]).slice(0, LIMIT);
  console.log(`日本語を持たない series: ${gaps.length} 件を検める (辞書済み ${covered.size})`);

  const proposals = [];
  const rejected = [];
  for (let i = 0; i < gaps.length; i += 1) {
    const [name, count] = gaps[i];
    const res = await anilist(name);
    await sleep(750);
    if (res.status !== 200) { rejected.push({ name, count, reason: `anilist ${res.status}` }); continue; }
    const media = pickMedia(res.media, name);
    if (!media) { rejected.push({ name, count, reason: '正規化した題が一致しない' }); continue; }
    const native = String(media.title.native).trim();
    const confirm = await confirmHitomi(name);
    await sleep(350);
    if (!confirm) { rejected.push({ name, count, reason: 'hitomi 索引で確かめられない' }); continue; }
    proposals.push({
      hitomi: { type: 'series', name, label: native, count: confirm.count },
      nhentai: Object.prototype.hasOwnProperty.call(nhParody, name) ? { type: 'series', name, label: native } : null,
      japanese: native,
      anilist: { id: media.id, url: media.siteUrl, english: media.title.english, romaji: media.title.romaji, format: media.format, year: media.startDate && media.startDate.year },
      evidence: [
        { url: `https://graphql.anilist.co (search=${name})`, checkedAt: new Date().toISOString(), method: 'anilist-official-title; english/romaji exact after normalisation', license: 'AniList public API' },
        { url: confirm.url, checkedAt: confirm.checkedAt, method: 'tagindex-exact' },
      ],
    });
    if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${gaps.length} (採用 ${proposals.length})`);
  }

  fs.mkdirSync(WORK, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), examined: gaps.length, proposals, rejected }, null, 1));
  console.log(JSON.stringify({ examined: gaps.length, accepted: proposals.length, rejected: rejected.length }, null, 2));
  console.log(`-> ${OUT}`);
}

// 直に叩かれた時だけ走る。require しただけで網へ出て辞書を書き換えないこと
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { main };
