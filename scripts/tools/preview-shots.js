// 試写台 (renderer-preview) の画面を 画面 × 主題 で撮る台。playwright MCP の browser_run_code_unsafe に filename で渡す:
//   { "filename": "scripts/tools/preview-shots.js" }
// 先に node scripts/renderer-preview.js (既定 18791) を起こす。写真は .playwright-mcp/shots/<名>-<主題>.png (版に入らない)。
// 見本の棚だけを撮る (Eagle にも網にも触らない)。globalThis.__shots / __themes / __base で差し替えられる。
// 主題は state.settings.uiTheme を替えて BunkoUI.sync() で当てる (data-ui-theme を直に書くより本体の道に近い)。
// 裏に回った窓では transition が進まないので、撮る前に getAnimations().finish() で駒を送る。
async (page) => {
  const base = globalThis.__base || 'http://127.0.0.1:18791/';
  const shots = globalThis.__shots || [
    ['list', ''], ['detail', '?view=detail'], ['settings', '?view=settings'], ['listrows', '?zoom=list'],
    ['pixiv', '?source=pixiv'], ['home', '?source=home'], ['queue', '?view=queue'], ['reader', '?view=reader'],
  ];
  const themes = globalThis.__themes || ['dark', 'navy', 'light'];
  await page.setViewportSize({ width: 1440, height: 900 });
  const done = [];
  for (const theme of themes) {
    for (const [name, q] of shots) {
      await page.goto(base + q);
      await page.waitForTimeout(900);
      await page.mouse.move(5, 895);   // 覗き窓が札に被らないよう指を端へ
      await page.evaluate((t) => {
        if (window.state && window.BunkoUI) { state.settings.uiTheme = t; BunkoUI.sync(); } else document.body.dataset.uiTheme = t;
        document.getAnimations().forEach((a) => { try { a.finish(); } catch (_) { /* 無限の物 */ } });
      }, theme);
      await page.waitForTimeout(200);
      const file = `.playwright-mcp/shots/${name}-${theme}.png`;
      await page.screenshot({ path: file });
      done.push(file);
    }
  }
  return done.join('\n');
}
