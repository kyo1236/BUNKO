// 試写台の画面で、字と地の対比 (WCAG) を主題ごとに測る。playwright MCP の browser_run_code_unsafe に filename で渡す:
//   { "filename": "scripts/tools/contrast.js" }   (先に node scripts/renderer-preview.js を起こしておく)
// 主題を替えた直後は transition の始まりの色が返るので、getAnimations().finish() してから読む (2026-09-27 に踏んだ)
async (page) => {
  const url = globalThis.__contrastUrl || 'http://127.0.0.1:18791/?view=detail';
  await page.goto(url);
  await page.waitForTimeout(1000);
  await page.mouse.move(5, 890);
  const out = {};
  for (const theme of ['dark', 'navy', 'light']) {
    // 色の遷移 (120ms) が終わる前に読むと前の主題の色が返る (釦・タグ・チップは color に transition を持つ)
    // 隠れた窓では描画の駒が進まず、遷移が始まりの色のまま止まる → 遷移を終わらせてから読む
    await page.evaluate((t) => { document.body.dataset.uiTheme = t; document.getAnimations().forEach((a) => { try { a.finish(); } catch (_) { /* 無限の物 */ } }); }, theme);
    out[theme] = await page.evaluate((t) => {
      const parse = (c) => {
        if (!c) return null;
        let m = c.match(/^rgba?\(([^)]+)\)/);
        if (m) { const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; }
        m = c.match(/^color\(srgb ([^)]+)\)/);
        if (m) { const p = m[1].split(/[ \/]+/).filter(Boolean).map(Number); return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p.length > 3 ? p[3] : 1 }; }
        return null;
      };
      const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const blend = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
      const ratio = (fg, bg) => { const f = blend(fg, bg); const L1 = lum(f), L2 = lum(bg); return ((Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)).toFixed(2); };
      const bgOf = (el) => { while (el) { const c = parse(getComputedStyle(el).backgroundColor); if (c && c.a > 0.9) return c; el = el.parentElement; } return { r: 255, g: 255, b: 255, a: 1 }; };
      const check = (sel, pseudo) => {
        const el = document.querySelector(sel);
        if (!el) return 'n/a';
        const raw = getComputedStyle(el, pseudo || null).color;
        const fg = parse(raw);
        if (!fg) return 'unparsed ' + raw;
        return ratio(fg, bgOf(el)) + '  ' + raw;
      };
      const sels = globalThis.__contrastSelectors || {
        ownedTitle: '.grid .card.owned .card-title',
        title: '.grid .card:not(.owned) .card-title',
        artist: '.grid .card .card-artist',
        chipIdle: '.chip:not(.active)',
        count: '.result-info',
        tagArtist: '.detail .tag.artist',
        tagSeries: '.detail .tag.series',
        tagChar: '.detail .tag.character',
        tagFemale: '.detail .tag.female',
        tagMale: '.detail .tag.male',
        rowLabel: '.detail .row-label',
        kicker: '.detail .kicker',
        hideOwned: '#hide-owned',
      };
      const res = {};
      for (const [k, s] of Object.entries(sels)) res[k] = check(s);
      res.placeholder = check('#query', '::placeholder');
      return res;
    }, theme);
  }
  return JSON.stringify(out, null, 1);
}
