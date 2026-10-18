'use strict';

const { app, BrowserWindow } = require('electron');
const VirtualGrid = require('../../src/renderer/virtual-grid');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { sandbox: true } });
  const items = Array.from({ length: 4800 }, (_, id) => ({ id }));
  const plan = VirtualGrid.plan({ items, columns: 6, rowHeight: 210, scrollTop: 300000, viewportHeight: 800, overscanRows: 3 });
  const cards = plan.items.map((item) => `<article class="card" data-id="${item.id}"></article>`).join('');
  const html = `<style>body{margin:0}.grid{display:grid;grid-template-columns:repeat(6,1fr);gap:10px}.card{height:200px}.spacer{grid-column:1/-1}</style><main class="grid"><div class="spacer" style="height:${Math.max(0, plan.topSpacer - 10)}px"></div>${cards}<div class="spacer" style="height:${Math.max(0, plan.bottomSpacer - 10)}px"></div></main>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  const measured = await win.webContents.executeJavaScript(`({ cards: document.querySelectorAll('.card').length, height: document.querySelector('.grid').scrollHeight })`);
  const expectedHeight = plan.totalHeight;
  if (measured.cards > 100 || Math.abs(measured.height - expectedHeight) > 20) {
    throw new Error(`virtual grid layout mismatch: ${JSON.stringify({ measured, expectedHeight })}`);
  }
  console.log(JSON.stringify({ ...measured, totalItems: items.length, expectedHeight }));
  await win.close();
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
