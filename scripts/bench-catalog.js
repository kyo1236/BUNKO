'use strict';

const { performance } = require('node:perf_hooks');
const fs = require('fs');
const path = require('path');
const assert = require('node:assert');
const Module = require('node:module');
const { installStub } = require('../test/helpers/stub-electron-2.js');

installStub();
const { Catalog } = require('../src/lib/catalog.js');

const GALLERIES = Number(process.env.BENCH_GALLERIES) || 4000;
const RUNS = Number(process.env.BENCH_RUNS) || 12;

// この作業の開始時実装を、最終ソースから性能差分だけ逆変換してメモリ上へ読む。
// 一時ソースを生成しないため、既存の未コミット変更を含む開始時catalogが基準になる。
function baselineCatalogClass() {
  const filename = path.join(__dirname, '..', 'src', 'lib', 'catalog.js');
  let source = fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n');
  const replace = (from, to) => {
    assert.ok(source.includes(from), `baseline変換対象が見つからない: ${from.slice(0, 60)}`);
    source = source.replace(from, to);
  };
  replace(
    "  getGalleryMeta(id) {\n"
      + "    const numeric = numericGalleryId(id);\n"
      + "    if (numeric == null) return null;\n"
      + "    return this.getGalleryMetaBatch([numeric]).get(numeric) || null;\n"
      + "  }",
    "  getGalleryMeta(id) {\n"
      + "    if (!this.db) return null;\n"
      + "    const numeric = numericGalleryId(id);\n"
      + "    if (numeric == null) return null;\n"
      + "    const rows = this.queryRows('SELECT * FROM galleries WHERE id = ?', [numeric]);\n"
      + "    if (!rows.length) return null;\n"
      + "    const row = rows[0];\n"
      + "    const grouped = { artists: [], groups: [], series: [], characters: [], tags: [] };\n"
      + "    const tagRows = this.queryRows(\n"
      + "      'SELECT type, name FROM gallery_tags WHERE gallery_id = ? ORDER BY type, name',\n"
      + "      [numeric],\n"
      + "    );\n"
      + "    for (const tag of tagRows) {\n"
      + "      const bucket = META_TAG_GROUPS.get(String(tag.type));\n"
      + "      if (!bucket) continue;\n"
      + "      grouped[bucket].push({ type: String(tag.type), name: String(tag.name), negative: false });\n"
      + "    }\n"
      + "    return {\n"
      + "      id: numeric, source: 'hitomi', sourceId: numeric, title: row.title || String(numeric),\n"
      + "      type: row.type || '',\n"
      + "      language: row.language ? { name: row.language, localName: row.language_local || row.language } : null,\n"
      + "      artists: grouped.artists, groups: grouped.groups, series: grouped.series,\n"
      + "      characters: grouped.characters, tags: grouped.tags, pageCount: Number(row.page_count) || 0,\n"
      + "      addedDate: row.added_date || null, publishedDate: row.published_date || null,\n"
      + "      isBlocked: false, hasVideo: false,\n"
      + "      url: row.url || `https://hitomi.la/galleries/${numeric}.html`, offline: true,\n"
      + "    };\n"
      + "  }",
  );
  replace(
    "let order = readingSort ? LIBRARY_ORDER.title : (LIBRARY_ORDER[payload.sort] || LIBRARY_ORDER.added);",
    'let order = LIBRARY_ORDER[payload.sort] || LIBRARY_ORDER.added;',
  );
  replace(
    "    // 未知のsortとrandom+未照合はJS比較器が追加日へフォールバックする。\n"
      + "    // addedを参照しないことが確実な並びだけ集計JOINを外す。\n"
      + "    const needsAdded = !['published', 'title', 'star', 'reread', 'finished'].includes(payload.sort);\n"
      + "    const from = ` FROM galleries g${ITEM_STAR_JOIN}${needsAdded ? ITEM_ADDED_JOIN : ''}`\n"
      + "      + ` WHERE ${where.join(' AND ')}`;\n"
      + "    const countFrom = ` FROM galleries g${minStar > 0 ? ITEM_STAR_JOIN : ''}`\n"
      + "      + ` WHERE ${where.join(' AND ')}`;",
    "    const from = ` FROM galleries g${ITEM_STAR_JOIN}${ITEM_ADDED_JOIN} WHERE ${where.join(' AND ')}`;",
  );
  replace("${needsAdded ? ITEM_ADDED_EXPR : '0'} AS added_ms", '${ITEM_ADDED_EXPR} AS added_ms');
  replace(
    '          + ` g.published_date AS published${from}`,\n        params,',
    '          + ` g.published_date AS published${from} ORDER BY ${order}`,\n        params,',
  );
  replace('`SELECT COUNT(*) AS n${countFrom}`', '`SELECT COUNT(*) AS n${from}`');
  replace(
    '    const metaById = this.getGalleryMetaBatch(slice.filter((row) => !row.eagleId).map((row) => row.id));\n',
    '',
  );
  replace('const meta = metaById.get(Number(row.id));', 'const meta = this.getGalleryMeta(row.id);');
  replace(
    "      const compare = libraryComparator(payload.sort, payload.sortDir, payload.reading);\n"
      + "      const merged = rows.concat(unmatched).sort((a, b) => {\n"
      + "        const result = compare(a, b);\n"
      + "        if (result) return result;\n"
      + "        // gallery id と Eagle id が同じ文字列になった場合も、従来の連結順を固定する。\n"
      + "        return Number(Boolean(a.eagleId)) - Number(Boolean(b.eagleId));\n"
      + "      });",
    "      const merged = rows.concat(unmatched)\n"
      + "        .sort(libraryComparator(payload.sort, payload.sortDir, payload.reading));",
  );
  // 開始時は同じ # なしパスでも行ごとに存在確認していた。
  replace('let state = pathState.get(sourcePath);', 'let state;');
  replace('            pathState.set(sourcePath, state);\n', '');
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = module.paths;
  loaded._compile(source, filename);
  return loaded.exports.Catalog;
}

function seed(catalog) {
  catalog.db.run('BEGIN');
  try {
    for (let id = 1; id <= GALLERIES; id += 1) {
      const title = id % 7 === 0 ? `magic shelf ${id}` : `book ${id}`;
      catalog.db.run(
        'INSERT INTO galleries (id,title,type,language,language_local,page_count,added_date,published_date,url,fetched_at)'
          + ' VALUES (?,?,?,?,?,?,?,?,?,?)',
        [id, title, id % 4 ? 'doujinshi' : 'manga', 'japanese', '日本語', 20 + (id % 80),
          '2026-01-01', `2025-${String((id % 12) + 1).padStart(2, '0')}-01`, '', Date.now()],
      );
      for (let item = 0; item < 2; item += 1) {
        catalog.db.run(
          'INSERT INTO items (source,path,gallery_id,title,title_key,updated_at,star,added_at) VALUES (?,?,?,?,?,?,?,?)',
          ['eagle', `Z:\\bench\\item-${id}.info#${item}`, id, title, title, Date.now(), (id + item) % 6, id * 10 + item],
        );
      }
      catalog.db.run('INSERT INTO gallery_tags (gallery_id,type,name) VALUES (?,?,?)', [id, 'artist', `artist-${id % 50}`]);
      catalog.db.run('INSERT INTO gallery_tags (gallery_id,type,name) VALUES (?,?,?)', [id, 'tag', id % 3 ? 'color' : 'mono']);
    }
    for (let id = 1; id <= Math.ceil(GALLERIES / 20); id += 1) {
      catalog.db.run(
        'INSERT INTO items (source,path,gallery_id,title,title_key,updated_at,star,added_at) VALUES (?,?,?,?,?,?,?,?)',
        ['eagle', `Z:\\bench\\unmatched-${id}.info`, null, `unmatched magic ${id}`,
          `unmatched magic ${id}`, Date.now(), id % 6, id],
      );
    }
    catalog.db.run('COMMIT');
  } catch (error) {
    catalog.db.run('ROLLBACK');
    throw error;
  }
}

function timedRebuild(catalog) {
  const originalExists = fs.existsSync;
  let existsChecks = 0;
  fs.existsSync = (value) => {
    if (String(value).includes('Z:\\bench')) existsChecks += 1;
    return false;
  };
  const started = performance.now();
  try {
    catalog.rebuildMemory();
  } finally {
    fs.existsSync = originalExists;
  }
  return { ms: Number((performance.now() - started).toFixed(2)), existsChecks };
}

function timed(catalog, payload) {
  let queries = 0;
  const original = catalog.queryRows;
  catalog.queryRows = function counted(...args) {
    queries += 1;
    return original.apply(this, args);
  };
  const started = performance.now();
  let result;
  for (let i = 0; i < RUNS; i += 1) result = catalog.searchLibrary(payload);
  const elapsed = performance.now() - started;
  catalog.queryRows = original;
  return {
    ms: Number((elapsed / RUNS).toFixed(2)),
    queries: Number((queries / RUNS).toFixed(1)),
    total: result.total,
    first: result.galleries[0] && result.galleries[0].id,
    ids: result.galleries.map((gallery) => gallery.id || gallery.eagleId).join(','),
  };
}

function comparisonCases() {
  const cases = {};
  const reading = {};
  for (let id = 1; id <= GALLERIES; id += 1) {
    reading[String(id)] = { finishedCount: id % 5, finishedAt: id * 3, updatedAt: id * 7 };
  }
  for (const sort of ['added', 'published', 'title', 'star', 'reread', 'finished', 'random', 'unknown']) {
    for (const includeUnmatched of [false, true]) {
      for (const sortDir of [undefined, 'asc']) {
        const name = `${sort}-${includeUnmatched ? 'mixed' : 'linked'}-${sortDir || 'default'}`;
        cases[name] = { sort, includeUnmatched, sortDir, seed: 7341, reading, pageSize: 24 };
      }
    }
  }
  cases.freeText = { query: 'magic -140', includeUnmatched: true, pageSize: 24 };
  cases.typedTag = { query: 'artist:artist-7 -tag:mono', includeUnmatched: true, pageSize: 24 };
  cases.minStar = { minStar: 4, includeUnmatched: true, pageSize: 24 };
  return cases;
}

(async () => {
  const BaselineCatalog = baselineCatalogClass();
  const baseline = new BaselineCatalog();
  const final = new Catalog();
  await baseline.init();
  await final.init();
  for (const catalog of [baseline, final]) {
    if (catalog.persistTimer) clearTimeout(catalog.persistTimer);
    seed(catalog);
  }
  const rebuild = { baseline: timedRebuild(baseline), final: timedRebuild(final) };
  const output = {};
  for (const [name, payload] of Object.entries(comparisonCases())) {
    const beforeResult = baseline.searchLibrary(payload);
    const afterResult = final.searchLibrary(payload);
    assert.deepStrictEqual(afterResult, beforeResult, `${name}の検索結果が開始時と異なる`);
    output[name] = { baseline: timed(baseline, payload), final: timed(final, payload) };
  }
  process.stdout.write(`${JSON.stringify({ galleries: GALLERIES, runs: RUNS, rebuild, cases: output }, null, 2)}\n`);
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
