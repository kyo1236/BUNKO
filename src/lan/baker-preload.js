'use strict';

// 焼き場 (baker.html) の窓口。窓の中には node を持ち込まず、要る二つだけ通す。
// PDF は手元の物とはいえ外から貰った束でもある: pdf.js が転んだ時に
// node がそのまま握られる形は避ける

const fs = require('fs');
const path = require('path');
const { contextBridge } = require('electron');

const { unpackedPath } = require('../lib/asar-path');

// 下働き (worker) は梱包後に app.asar.unpacked 側へ落ちている (package.json の asarUnpack と対)
const WORKER = unpackedPath(
  path.join(__dirname, '..', '..', 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.js')
);

contextBridge.exposeInMainWorld('host', {
  // file:// の窓からは worker を直に起こせない。原本を渡して blob に包ませる
  workerBytes: () => new Uint8Array(fs.readFileSync(WORKER)),
  fileBytes: (file) => new Uint8Array(fs.readFileSync(String(file))),
});
