const { get, postJson } = require('../http');
const { tag, pickJapanese, record } = require('./normalize');
const { createRemotePager } = require('./remote-pages');
// 語彙は hitomi と同じ。こちらの符丁 (either:) だけ外して渡す
const { forEhentai } = require('./tag-query');

const META_TTL = 24 * 60 * 60 * 1000;
const PAGE_KEY_TTL = 60 * 60 * 1000;
const metaCache = new Map();
const metaInflight = new Map();
const pageKeyCache = new Map();
const CACHE_MAX = 500;

function trim(cache, max = CACHE_MAX) {
  while (cache.size > max) cache.delete(cache.keys().next().value);
}

async function joinFlight(flight, signal) {
  flight.subscribers += 1;
  let onAbort;
  try {
    if (!signal) return await flight.promise;
    if (signal.aborted) throw signal.reason || new Error('aborted');
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(signal.reason || new Error('aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    return await Promise.race([flight.promise, aborted]);
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    flight.subscribers -= 1;
    if (signal?.aborted && flight.subscribers === 0) flight.controller.abort(signal.reason);
  }
}

// この置き場の顔。main 側の「外部ブラウザで開いて良い先」もここを集めて決める
const hosts = ['e-hentai.org', 'exhentai.org'];

// 画廊は gid と token の対で決まる。ex- と e- はどちらも同じものを指す
const GALLERY_URL = /e[x-]?hentai\.org\/g\/(\d+)\/([0-9a-f]{5,})/i;

// 検索欄に貼られた URL を「この置き場のこの画廊」と読む。
// 他所の URL なら null を返し、次のアダプタに渡す
function detectUrl(text) {
  const hit = String(text).match(GALLERY_URL);
  return hit ? { source: 'ehentai', query: `${hit[1]}/${hit[2]}` } : null;
}

function parseTags(list) {
  const groups = { artists: [], groups: [], series: [], characters: [], tags: [] };
  for (const raw of list || []) {
    const [ns, name] = String(raw).includes(':') ? String(raw).split(/:(.+)/) : ['tag', raw];
    const item = tag(ns === 'parody' ? 'series' : ns, name);
    if (ns === 'artist') groups.artists.push(item);
    else if (ns === 'group') groups.groups.push(item);
    else if (ns === 'parody') groups.series.push(item);
    else if (ns === 'character') groups.characters.push(item);
    else groups.tags.push(item);
  }
  return groups;
}

function typeFromCategory(category) {
  const map = {
    Doujinshi: 'doujinshi',
    Manga: 'manga',
    'Artist CG': 'artistcg',
    'Game CG': 'gamecg',
    'Image Set': 'imageset',
    Western: 'imageset',
    Cosplay: 'imageset',
    Misc: 'imageset',
    'Non-H': 'manga',
  };
  return map[category] || String(category || '').toLowerCase().replace(/\s+/g, '');
}

function serialize(meta) {
  const languageTag = (meta.tags || []).find((item) => String(item).startsWith('language:'));
  const language = languageTag ? languageTag.split(':')[1] : null;
  return record({
    id: `eh:${meta.gid}:${meta.token}`,
    source: 'ehentai',
    title: pickJapanese(meta.title, meta.title_jpn) || meta.title,
    type: typeFromCategory(meta.category),
    language: language ? { name: language, localName: language } : null,
    ...parseTags(meta.tags),
    pageCount: Number(meta.filecount) || 0,
    addedDate: meta.posted ? new Date(Number(meta.posted) * 1000).toISOString() : null,
    url: `https://e-hentai.org/g/${meta.gid}/${meta.token}/`,
  });
}

async function gdata(pairs, { signal, priority = 10 } = {}) {
  if (!pairs.length) return [];
  const missing = [];
  const waiting = [];
  for (const [gid, token] of pairs) {
    const key = `${gid}:${token}`;
    const cached = metaCache.get(key);
    if (cached && Date.now() - cached.at <= META_TTL) continue;
    if (metaInflight.has(key)) {
      const flight = metaInflight.get(key);
      if (!flight.controller.signal.aborted) waiting.push(flight);
      else {
        if (metaInflight.get(key) === flight) metaInflight.delete(key);
        missing.push([gid, token]);
      }
    } else missing.push([gid, token]);
  }
  for (let i = 0; i < missing.length; i += 25) {
    const slice = missing.slice(i, i + 25);
    const controller = new AbortController();
    const flight = { controller, subscribers: 0, promise: null };
    flight.promise = postJson('https://api.e-hentai.org/api.php', {
      method: 'gdata',
      gidlist: slice,
      namespace: 1,
    }, {}, { signal: controller.signal, priority }).then((res) => {
      const rows = res.json().gmetadata || [];
      for (const row of rows) {
        if (row.error) continue;
        metaCache.set(`${row.gid}:${row.token}`, { value: row, at: Date.now() });
        trim(metaCache);
      }
      return rows;
    }).finally(() => {
      for (const [gid, token] of slice) {
        const key = `${gid}:${token}`;
        if (metaInflight.get(key) === flight) metaInflight.delete(key);
      }
    });
    for (const [gid, token] of slice) {
      const key = `${gid}:${token}`;
      metaInflight.set(key, flight);
    }
    await joinFlight(flight, signal);
  }
  if (waiting.length) await Promise.all([...new Set(waiting)].map((flight) => joinFlight(flight, signal)));
  // cache hit と新規取得が混じっても、検索 HTML の入力順を保つ。
  return pairs.map(([gid, token]) => metaCache.get(`${gid}:${token}`)?.value).filter(Boolean);
}

function parseSearchHtml(html) {
  const found = [];
  const seen = new Set();
  const re = /https?:\/\/e-hentai\.org\/g\/(\d+)\/([0-9a-f]{5,})\//gi;
  let match;
  while ((match = re.exec(html))) {
    const key = `${match[1]}:${match[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push([Number(match[1]), match[2]]);
  }
  return found;
}

// 人気系の置き場 (/popular と toplist) は**絞り込みを受け付けない**ページなので、
// 語がある時は使えず通常検索へ落ちる。ここへ渡すのは利用者が打った生の語だけ:
// 言語・種別を継ぎ足した q を渡していたので、言語を一つ選んでいるだけで
// 人気・いま/昨日/月/年 が全部ふつうの投稿日順に化けていた
function popularUrl(sort, query, page) {
  const empty = !String(query || '').trim();
  if (empty && sort === 'today') return `https://e-hentai.org/popular?inline_set=dm_t`;
  if (empty && (sort === 'week' || sort === 'month' || sort === 'year')) {
    const tl = sort === 'week' ? 11 : sort === 'month' ? 12 : 13;
    return `https://e-hentai.org/toplist.php?tl=${tl}&p=${page}&inline_set=dm_t`;
  }
  return null;
}

async function search({ query = '', language = '', type = '', sort = 'added', page = 0, pageSize = 24, signal } = {}) {
  const direct = String(query).trim().match(/^(\d+)\/([0-9a-f]{5,})$/i);
  if (direct) {
    const rows = await gdata([[Number(direct[1]), direct[2]]], { signal });
    return { total: rows.length, page: 0, pageSize, galleries: rows.map(serialize) };
  }

  const parts = [];
  const translated = forEhentai(query);
  if (translated) parts.push(translated);
  if (language) parts.push(`language:${language}`);
  if (type === 'doujinshi') parts.push('doujinshi');
  if (type === 'manga') parts.push('manga');
  const q = parts.join(' ');
  // raw = 利用者が打った語だけ (言語・種別を含まない)。人気系へ行けるかの判じに使う
  const loaded = await loadSearchPage(
    JSON.stringify({ q, sort, raw: String(query || '').trim() }), page, pageSize, { signal },
  );
  const pairs = loaded.rows;
  const rows = await gdata(pairs, { signal });
  return {
    total: loaded.total,
    approximate: loaded.hasNext,
    hasNext: loaded.hasNext,
    page,
    pageSize,
    galleries: rows.map(serialize),
  };
}

const searchContinuations = new Map();
const loadSearchPage = createRemotePager(async (remotePage, key, { signal } = {}) => {
  const { q, sort, raw } = JSON.parse(key);
  const ranked = popularUrl(sort, raw === undefined ? q : raw, remotePage);
  // popular は単一ページ。toplist と通常検索だけが page を持つ。
  let urls = searchContinuations.get(key);
  if (!urls) {
    urls = [];
    searchContinuations.set(key, urls);
    trim(searchContinuations, 100);
  }
  const url = urls[remotePage] || ranked || (q
    ? `https://e-hentai.org/?f_search=${encodeURIComponent(q)}&page=${remotePage}&inline_set=dm_t`
    : `https://e-hentai.org/?page=${remotePage}&inline_set=dm_t`);
  const html = (await get(url, { Referer: 'https://e-hentai.org/' }, { signal, priority: 10 })).text();
  const rows = parseSearchHtml(html);
  const hrefs = [...html.matchAll(/href="([^"]+)"/gi)].map((match) => match[1].replace(/&amp;/g, '&'));
  const next = hrefs.find((href) => /[?&]next=\d+/i.test(href))
    || hrefs.find((href) => new RegExp(`[?&](?:page|p)=${remotePage + 1}(?:&|$)`).test(href));
  if (next) urls[remotePage + 1] = new URL(next, 'https://e-hentai.org/').toString();
  const hasNext = Boolean(next) && !ranked?.includes('/popular?');
  return { rows, hasNext };
});

async function loadPageKey(gid, token, index, { signal, priority = 0 } = {}) {
  const cacheKey = `${gid}:${token}`;
  let entry = pageKeyCache.get(cacheKey);
  if (!entry || Date.now() - entry.at > PAGE_KEY_TTL) {
    entry = { at: Date.now(), keys: [], pages: new Map(), pageSize: 0 };
    pageKeyCache.set(cacheKey, entry);
    trim(pageKeyCache, 100);
  }
  async function load(p) {
    if (entry.pages.has(p)) {
      const saved = entry.pages.get(p);
      if (!saved.controller.signal.aborted) return joinFlight(saved, signal);
      if (entry.pages.get(p) === saved) entry.pages.delete(p);
    }
    const controller = new AbortController();
    const flight = { controller, subscribers: 0, promise: null };
    flight.promise = get(`https://e-hentai.org/g/${gid}/${token}/${p ? `?p=${p}` : ''}`, {
      Referer: 'https://e-hentai.org/',
    }, { signal: controller.signal, priority }).then((res) => {
      const html = res.text();
      const found = [...html.matchAll(new RegExp(`/s/([0-9a-f]+)/${gid}-(\\d+)`, 'gi'))];
      for (const match of found) {
        entry.keys[Number(match[2]) - 1] = match[1];
      }
      if (p === 0) entry.pageSize = new Set(found.map((match) => Number(match[2]))).size;
      entry.at = Date.now();
    }).catch((error) => {
      if (entry.pages.get(p) === flight) entry.pages.delete(p);
      throw error;
    });
    entry.pages.set(p, flight);
    return joinFlight(flight, signal);
  }
  await load(0);
  if (entry.keys[index]) return entry.keys[index];
  if (entry.pageSize > 0) await load(Math.floor(index / entry.pageSize));
  return entry.keys[index];
}

async function getGallery(key) {
  const [gid, token] = String(key).split(':');
  const rows = await gdata([[Number(gid), token]]);
  if (!rows[0]) throw new Error('gallery not found');
  return serialize(rows[0]);
}

async function fetchImage(key, index, { size = 'full', signal, priority = 0 } = {}) {
  const [gid, token] = String(key).split(':');
  const meta = (await gdata([[Number(gid), token]], { signal, priority }))[0];
  if ((size === 'small' || size === 'big' || size === 'medium') && index === 0 && meta?.thumb) {
    try {
      const res = await get(meta.thumb, { Referer: 'https://e-hentai.org/' }, { signal, priority });
      return { bytes: res.buffer, type: res.headers['content-type'] || 'image/jpeg', name: 'thumb.jpg' };
    } catch {
      // hath / ehgt が落ちていてもページ画像で続行する
    }
  }
  const imgkey = await loadPageKey(gid, token, index, { signal, priority });
  if (!imgkey) {
    const error = new Error('image not found');
    error.status = 404;
    throw error;
  }
  const page = await get(`https://e-hentai.org/s/${imgkey}/${gid}-${index + 1}`, {
    Referer: `https://e-hentai.org/g/${gid}/${token}/`,
  }, { signal, priority });
  const src = page.text().match(/id="img"[^>]*src="([^"]+)"/) || page.text().match(/<img[^>]+id="img"[^>]+src="([^"]+)"/);
  if (!src) throw new Error('image url missing');
  const image = await get(src[1], { Referer: `https://e-hentai.org/s/${imgkey}/${gid}-${index + 1}` }, { signal, priority });
  const name = decodeURIComponent((src[1].split('/').pop() || 'image.webp').split('?')[0]);
  return { bytes: image.buffer, type: image.headers['content-type'] || 'image/jpeg', name };
}

// popularUrl は試験用。人気系へ行けるかの判じは絞り込みで壊れやすく、
// 壊れても画面は「投稿日順の一覧」が出るだけなので気付けない
module.exports = { search, getGallery, fetchImage, hosts, detectUrl, popularUrl };
