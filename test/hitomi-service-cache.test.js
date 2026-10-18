'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { _internals } = require('../src/lib/hitomi-service');

test('Hitomi 検索キャッシュは TTL 内だけ再利用し、参照で LRU 更新する', () => {
  const originalNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  try {
    _internals.searchCache.clear();
    const ids = [3, 2, 1];
    _internals.rememberSearch('q', ids);
    assert.strictEqual(_internals.recallSearch('q'), ids);
    now += _internals.SEARCH_CACHE_TTL + 1;
    assert.equal(_internals.recallSearch('q'), null);
    assert.equal(_internals.searchCache.has('q'), false);
  } finally {
    Date.now = originalNow;
    _internals.searchCache.clear();
  }
});

test('missing Hitomi tag indexes return no matches, popularity falls back, other failures remain errors', async () => {
  const service=require('../src/lib/hitomi-service');
  const original=service.hitomi.galleries.list;
  let calls=[];
  try {
    service._internals.searchCache.clear();
    service.hitomi.galleries.list=async options=>{calls.push(options.orderBy);throw new Error('[https://example.test/artist/name.nozomi] must not respond with 404');};
    const result=await service.search({query:'artist:missing_unique_name',sort:'month',sortDir:'asc'});
    assert.equal(result.total,0);assert.equal(result.hasNext,false);assert.equal(calls.length,2);
    calls=[];
    service.hitomi.galleries.list=async options=>{calls.push(options.orderBy);if(calls.length===1)throw new Error('[https://example.test/artist/name.nozomi] must not respond with 404');return [];};
    await service.search({query:'artist:another_missing_name',sort:'month',sortDir:'asc'});
    assert.equal(calls.length,2);
    service.hitomi.galleries.list=async()=>{throw new Error('HTTP 503 unavailable');};
    await assert.rejects(service.search({query:'artist:server_failure',sort:'added',sortDir:'asc'}),/503/);
  } finally { service.hitomi.galleries.list=original;service._internals.searchCache.clear(); }
});

test('hitomi の取得は、網の瞬断と相手の一時的な不調だけを一回、新しい接続で引き直す (一枚目が稀に落ちる件)', async () => {
  const { withRetry, retryKind, freshScope } = require('../src/lib/hitomi-service')._internals;
  const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  assert.equal(retryKind(reset), 'network');
  assert.equal(retryKind(new Error('https://x.test/a.webp must not respond with 503')), 'network');
  assert.equal(retryKind(new Error('https://x.test/a.webp must not respond with 404')), '', '目録の 404 は作品が無い: 引き直さない');
  assert.equal(retryKind(new Error('https://x.test/a.webp must not respond with 404'), { image: true }), 'context', '絵の 404 は置き場の表が古いかもしれない');
  assert.equal(retryKind(new Error('Extension must be available')), '', '形の誤りは引き直さない');

  // 一回目が切れていたら、二回目は新しい接続 (freshScope の中) で
  const scopes = [];
  let calls = 0;
  const value = await withRetry(async () => {
    calls += 1;
    scopes.push(Boolean(freshScope.getStore()));
    if (calls === 1) throw reset;
    return 'bytes';
  });
  assert.equal(value, 'bytes');
  assert.deepEqual(scopes, [false, true], '引き直しは居抜きの接続を使わない');

  // 引き直しは一回だけ: 二回目も落ちたらその誤りのまま
  let twice = 0;
  await assert.rejects(withRetry(async () => { twice += 1; throw reset; }), /socket hang up/);
  assert.equal(twice, 2);
  // 形の誤りは一回目で諦める
  let once = 0;
  await assert.rejects(withRetry(async () => { once += 1; throw new Error('image not found'); }), /image not found/);
  assert.equal(once, 1);
});

test('hitomi の目録は同じ作品を同時に一本だけ引き、瞬断は引き直して控える', async () => {
  const service = require('../src/lib/hitomi-service');
  const original = service.hitomi.galleries.retrieve;
  const id = 987654321;
  let calls = 0;
  try {
    service._internals.galleryCache.delete(id);
    service.hitomi.galleries.retrieve = async (numeric) => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (calls === 1) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      return { id: numeric, files: [] };
    };
    const [a, b, c] = await Promise.all([service.getGallery(id), service.getGallery(String(id)), service.getGallery(id)]);
    assert.equal(calls, 2, '三つの頼みは一本にまとめ、切れた一回だけ引き直す');
    assert.equal(a.id, id);
    assert.strictEqual(a, b);
    assert.strictEqual(b, c);
    await service.getGallery(id);
    assert.equal(calls, 2, '二度目からは控え');
  } finally {
    service.hitomi.galleries.retrieve = original;
    service._internals.galleryCache.delete(id);
  }
});
