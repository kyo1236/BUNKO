'use strict';
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

function sortCreators(value) {
  return (Array.isArray(value) ? value : []).sort((a,b) => (b.favorited || 0) - (a.favorited || 0));
}
if (!isMainThread && workerData?.creatorList) {
  try { parentPort.postMessage({rows:sortCreators(JSON.parse(Buffer.from(workerData.buffer).toString('utf8')))}); }
  catch { parentPort.postMessage({error:'作者一覧の形式を読み取れませんでした'}); }
} else {
  module.exports = async function parseCreatorList(response) {
    if (!response.buffer || response.buffer.length < 256 * 1024) return sortCreators(response.json());
    return new Promise((resolve,reject) => {
      const worker = new Worker(__filename.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'),{workerData:{creatorList:true,buffer:response.buffer}});
      worker.once('message', result => result.error ? reject(new Error(result.error)) : resolve(result.rows));
      worker.once('error', reject);
      worker.once('exit', code => {if (code) reject(new Error('作者一覧の読み込みを完了できませんでした'));});
    });
  };
}
