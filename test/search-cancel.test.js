'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
require('./helpers/stub-electron');
const sources = require('../src/lib/sources');

test('同一検索の一方をcancelしても、残る購読者のHTTP処理は中断しない', async () => {
  let calls = 0;
  let aborted = 0;
  let finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  const restore = sources._setAdapterForTest('hitomi', {
    async search({ signal }) {
      calls += 1;
      signal.addEventListener('abort', () => { aborted += 1; }, { once: true });
      await gate;
      return { galleries: [{ id: 'cancel-race', title: 'ok' }] };
    },
  });
  try {
    const one = new AbortController();
    const two = new AbortController();
    const payload = { source: 'hitomi', query: `cancel-race-${Date.now()}`, page: 0 };
    const first = sources.search(payload, { signal: one.signal });
    const second = sources.search(payload, { signal: two.signal });
    one.abort(new Error('cancel first'));
    await assert.rejects(first, /cancel first/);
    assert.equal(calls, 1);
    assert.equal(aborted, 0);
    finish();
    const result = await second;
    assert.equal(result.galleries[0].title, 'ok');
    assert.equal(aborted, 0);
  } finally {
    restore();
  }
});

test('全購読者cancel済みのflightへ後続検索を参加させず、旧finallyも新flightを消さない', async () => {
  const gates = [];
  let calls = 0;
  const restore = sources._setAdapterForTest('hitomi', {
    search({ signal }) {
      calls += 1;
      return new Promise((resolve, reject) => {
        const gate = { resolve, reject };
        gates.push(gate);
        signal.addEventListener('abort', () => reject(signal.reason || new Error('aborted')), { once: true });
      });
    },
  });
  try {
    const payload = { source: 'hitomi', query: `replace-aborted-${Date.now()}` };
    const firstController = new AbortController();
    const first = sources.search(payload, { signal: firstController.signal });
    firstController.abort(new Error('drop old'));
    await assert.rejects(first, /drop old/);

    const second = sources.search(payload);
    assert.equal(calls, 2);
    gates[1].resolve({ galleries: [{ id: 'new', title: 'new' }] });
    assert.equal((await second).galleries[0].id, 'new');

    const preaborted = new AbortController();
    preaborted.abort(new Error('already gone'));
    await assert.rejects(sources.search({ ...payload, query: `${payload.query}-pre` }, {
      signal: preaborted.signal,
    }), /already gone/);
    assert.equal(calls, 2);
  } finally {
    restore();
  }
});

test('中断を無視して遅れて完了した検索は新しい検索キャッシュを上書きしない', async () => {
  const gates = [];
  const restore = sources._setAdapterForTest('hitomi', {
    search() { return new Promise((resolve) => gates.push(resolve)); },
  });
  try {
    const payload = { source: 'hitomi', query: `late-cache-${Date.now()}` };
    const controller = new AbortController();
    const first = sources.search(payload, { signal: controller.signal });
    controller.abort(new Error('old cancelled'));
    await assert.rejects(first, /old cancelled/);
    const second = sources.search(payload);
    gates[1]({ galleries: [{ id: 'new' }] });
    await second;
    gates[0]({ galleries: [{ id: 'old' }] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await sources.search(payload)).galleries[0].id, 'new');
    assert.equal(gates.length, 2);
  } finally { restore(); }
});

test('pixivの日本語検索は応答・キャッシュでもHitomiの別名へ書き換えない', async () => {
  const seen=[];
  const restore=sources._setAdapterForTest('pixiv',{rewritesAliases:false,async search({query}){seen.push(query);return {galleries:[],total:0};}});
  try{
    const payload={source:'pixiv',query:'にじさんじ',sort:'added',pageSize:17,page:321};
    const first=await sources.search(payload),second=await sources.search(payload);
    assert.equal(first.query,'にじさんじ');assert.equal(second.query,'にじさんじ');assert.deepEqual(first.interpreted,[]);
    assert.ok(seen.every(q=>q==='にじさんじ'));
  }finally{restore();}
});
