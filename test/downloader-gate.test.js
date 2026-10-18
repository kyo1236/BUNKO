'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Gate } = require('../src/lib/downloader');

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('Gate: release は空いた枠の数だけを予約して待機者を起こす', async () => {
  const gate = new Gate(2);
  await gate.acquire();
  await gate.acquire();
  let entered = 0;
  const waiters = Array.from({ length: 4 }, async () => {
    await gate.acquire();
    entered += 1;
  });

  gate.release();
  await tick();
  assert.equal(entered, 1);
  assert.equal(gate.active, 2);

  gate.release();
  await tick();
  assert.equal(entered, 2);
  assert.equal(gate.active, 2);

  gate.release();
  gate.release();
  await Promise.all(waiters);
  assert.equal(entered, 4);
  assert.equal(gate.active, 2);
});

test('Gate: setLimit は増えた枠だけを即時予約する', async () => {
  const gate = new Gate(1);
  await gate.acquire();
  let entered = 0;
  const waiters = Array.from({ length: 4 }, async () => {
    await gate.acquire();
    entered += 1;
  });

  gate.setLimit(3);
  await tick();
  assert.equal(entered, 2);
  assert.equal(gate.active, 3);

  gate.setLimit(2);
  gate.release();
  await tick();
  assert.equal(entered, 2);
  gate.release();
  await tick();
  assert.equal(entered, 3);

  gate.release();
  await Promise.all(waiters);
  assert.equal(entered, 4);
});
