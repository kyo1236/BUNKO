'use strict';

// 済んだ仕事の行き先の割り振り。題は合成の物だけを使う。
//
// 元の不具合: 完了した仕事の「開く」が、落としている間の置き場を開こうとして
// いた。そこは Eagle の見張りフォルダなので、取り込みが済むと実体ごと消える
// (網越しの道なら、消えた先を探しに行って時間切れになる)。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { decorateJobs } = require('../src/lib/download-decorate');

const INBOX = path.join('\\\\synthetic-host', 'Inbox');
const IMAGES = path.join('D:', 'synthetic-library', 'images');

function deps({ byGallery = {}, basePath = {}, posts = {}, pawFolder = null } = {}) {
  return {
    catalog: {
      eagleByGallery: new Map(Object.entries(byGallery)),
      eagleBasePath: new Map(Object.entries(basePath)),
    },
    pawLinks: { getPost: (service, user, postId) => posts[`${service}/${user}/${postId}`] || null },
    pawLibrary: { itemFolder: (id) => (pawFolder ? path.join(IMAGES, `${id}.info`) : null) },
  };
}

const doneJob = (id) => ({
  id, title: 'Synthetic Work', status: 'done', dest: path.join(INBOX, 'synthetic-work.pdf'),
});

test('取り込み済みの仕事は Eagle のアイテムと手元の道を持つ', () => {
  const [job] = decorateJobs([doneJob('111')], deps({
    byGallery: { 111: 'SYNTH0001' },
    basePath: { SYNTH0001: path.join(IMAGES, 'SYNTH0001.info') },
  }));
  assert.equal(job.eagleItemId, 'SYNTH0001', '開く先は Eagle のアイテム');
  assert.equal(job.finalPath, path.join(IMAGES, 'SYNTH0001.info'), '出す先は取り込み後の道');
  assert.equal(job.downloadDest, path.join(INBOX, 'synthetic-work.pdf'), '落とした先は落とした先で残す');
  // 元の道は残すが、釦の行き先ではなくなった
  assert.notEqual(job.finalPath, job.downloadDest);
});

test('まだ取り込まれていない仕事は行き先を名乗らない (消える道を掴ませない)', () => {
  const [job] = decorateJobs([doneJob('222')], deps({}));
  assert.equal(job.eagleItemId, null);
  assert.equal(job.finalPath, '');
  // 落とした先は控えとして残る (画面はこれを釦に使わない)
  assert.equal(job.downloadDest, path.join(INBOX, 'synthetic-work.pdf'));
});

test('取り込まれていても手元の道が引けなければ、開く先だけ渡す', () => {
  const [job] = decorateJobs([doneJob('333')], deps({ byGallery: { 333: 'SYNTH0003' } }));
  assert.equal(job.eagleItemId, 'SYNTH0003', 'Eagle では開ける');
  assert.equal(job.finalPath, '', 'フォルダは出せない');
});

test('pawchive の仕事は投稿の三つ組から引く', () => {
  const job = { ...doneJob('pw:synthservice:synthuser:9001') };
  const [out] = decorateJobs([job], deps({
    posts: { 'synthservice/synthuser/9001': 'SYNTH0009' },
    pawFolder: true,
  }));
  assert.equal(out.eagleItemId, 'SYNTH0009');
  assert.equal(out.finalPath, path.join(IMAGES, 'SYNTH0009.info'), '向こうの控えが道を知っている');
});

test('済んでいない仕事は索引を引かない (進捗は毎秒何度も流れる)', () => {
  let asked = 0;
  const base = deps({ byGallery: { 111: 'SYNTH0001' } });
  base.catalog.eagleByGallery = { get: () => { asked += 1; return 'SYNTH0001'; } };
  const jobs = decorateJobs([
    { id: '111', status: 'running', dest: '', done: 3, total: 10 },
    { id: '112', status: 'queued', dest: '' },
    { id: '113', status: 'error', dest: '' },
  ], base);
  assert.equal(asked, 0, '走っている仕事のために台帳を引かない');
  jobs.forEach((job) => {
    assert.equal(job.eagleItemId, undefined, '済むまでは行き先を名乗らない');
  });
});

test('台帳がまだ空でも落ちない', () => {
  const [job] = decorateJobs([doneJob('111')], {});
  assert.equal(job.eagleItemId, null);
  assert.equal(job.finalPath, '');
});
