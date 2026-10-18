'use strict';

// AI 生成情報の取り出し (src/lib/ai-meta.js / ai-meta-service.js)。
// 使うのは test/helpers/ai-meta-fixtures.js の合成した画像だけ (他人の作品は使わない)。
// docs/research/pixiv-ai-meta/test_extract.py の 5 件を移し、issue #3 の追加分
// (無圧縮・RGB・workflow だけの A1111・EXIF の JPEG / WebP・壊れた gzip・長さ違い・主スレッドの詰まり) を足した。

const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./helpers/ai-meta-fixtures');
const meta = require('../src/lib/ai-meta');
const service = require('../src/lib/ai-meta-service');

const extract = (bytes) => meta.extractFromBytes(bytes, { pixels: F.sharpPixels(bytes) });

test('NovelAI の tEXt: 正・負・キャラ・seed・モデル', async () => {
  const r = await extract(F.png({ width: 64, height: 64, text: F.naiDict() }));
  assert.equal(r.foundIn, 'png_text');
  assert.equal(r.format, 'NovelAI');
  assert.equal(r.positive, '1girl, smile');
  assert.equal(r.negative, 'lowres');
  assert.deepEqual(r.characters, ['girl, red hair']);
  assert.deepEqual(r.characterNegatives, []);
  assert.equal(r.settings.seed, 123);
  assert.equal(r.settings.model, 'NovelAI Diffusion V5 TEST');
  assert.equal(r.settings.sampler, 'k_euler_ancestral');
  assert.equal(r.settings.cfgRescale, 0.1);
  assert.equal(r.settings.requestType, 'PromptGenerateRequest');
});

test('NovelAI の zTXt / iTXt (圧縮) も同じに読める。キャラ別ネガティブも拾う', async () => {
  const dict = F.naiDict({ negChars: ['', 'bad hands'] });
  for (const textKind of ['zTXt', 'iTXt']) {
    const r = await extract(F.png({ width: 64, height: 64, text: dict, textKind }));
    assert.equal(r.format, 'NovelAI', textKind);
    assert.deepEqual(r.characterNegatives, ['', 'bad hands'], textKind);
  }
});

test('NovelAI のステルス (stealth_pngcomp、アルファ、列優先): tEXt 版と同じ中身に正規化される', async () => {
  const dict = F.naiDict();
  const text = await extract(F.png({ width: 64, height: 64, text: dict }));
  const stealth = await extract(F.stealthPng({ dict, mode: 'alpha', compressed: true }));
  assert.equal(stealth.foundIn, 'stealth_pngcomp');
  assert.equal(stealth.settings.model, 'NovelAI Diffusion V5 TEST');
  assert.deepEqual({ ...stealth, foundIn: '' }, { ...text, foundIn: '' });
});

test('ステルスの他の三つ: stealth_pnginfo (無圧縮) / stealth_rgbcomp / stealth_rgbinfo (RGB は RGBA の絵でも)', async () => {
  const dict = F.naiDict({ seed: 777 });
  const cases = [
    ['stealth_pnginfo', { mode: 'alpha', compressed: false }],
    ['stealth_rgbcomp', { mode: 'rgb', compressed: true }],
    ['stealth_rgbinfo', { mode: 'rgb', compressed: false }],
    ['stealth_rgbcomp', { mode: 'rgb', compressed: true, channels: 4 }],
  ];
  for (const [sig, opts] of cases) {
    const r = await extract(F.stealthPng({ dict, ...opts }));
    assert.ok(r, sig);
    assert.equal(r.foundIn, sig, JSON.stringify(opts));
    assert.equal(r.settings.seed, 777);
  }
});

test('ステルスは左端の列だけ読む (本体が長いと二度目に広げる)。要らない幅は頼まない', async () => {
  const dict = F.naiDict({ chars: Array.from({ length: 12 }, (_, i) => `character ${i}, long caption ${'x'.repeat(200)}`) });
  const bytes = F.stealthPng({ dict, width: 400, height: 400 });
  const asked = [];
  const inner = F.sharpPixels(bytes);
  const r = await meta.extractFromBytes(bytes, { pixels: async (q) => { asked.push(q.columns); return inner(q); } });
  assert.equal(r.foundIn, 'stealth_pngcomp');
  assert.equal(r.characters.length, 12);
  assert.ok(asked.length >= 1 && asked.length <= 2, `問い合わせ ${asked.length} 回`);
  assert.ok(asked[0] <= 1, '最初は署名と長さのぶんだけ');
  assert.ok(asked[asked.length - 1] < 400, `全幅は頼まない (${asked[asked.length - 1]})`);
});

test('A1111 の parameters: 正・負・設定の表 (引用符の中の , で割れない)。Size は幅と高さに', async () => {
  const r = await extract(F.png({ width: 64, height: 64, text: { parameters: F.A1111_TEXT } }));
  assert.equal(r.format, 'A1111');
  assert.equal(r.positive, '1girl, smile');
  assert.equal(r.negative, 'lowres');
  assert.equal(r.settings.steps, 20);
  assert.equal(r.settings.sampler, 'Euler a');
  assert.equal(r.settings.scale, 7);
  assert.equal(r.settings.seed, 1);
  assert.equal(r.settings.width, 64);
  assert.equal(r.settings.height, 64);
  assert.equal(r.settings.model, 'testmodel');
  assert.equal(r.extra['Lora hashes'], 'a: 1, b: 2');
});

test('ComfyUI の prompt (API 形式): KSampler の positive / negative の繋ぎで正負を決める。設定とモデルも', async () => {
  const r = await extract(F.png({ width: 64, height: 64, text: { prompt: JSON.stringify(F.COMFY_GRAPH), workflow: JSON.stringify(F.COMFY_WORKFLOW) } }));
  assert.equal(r.format, 'ComfyUI');
  assert.equal(r.positive, '1girl, smile');
  assert.equal(r.negative, 'lowres');
  assert.equal(r.settings.steps, 25);
  assert.equal(r.settings.seed, 5);
  assert.equal(r.settings.scale, 6);
  assert.equal(r.settings.model, 'test.safetensors');
  assert.equal(r.extra.denoise, 1);
  assert.equal(r.workflowTexts.length, 1);
  assert.equal(r.workflowTexts[0].title, 'Positive');
});

test('正プロンプトが空で workflow にだけ文字列がある A1111+ComfyUI: workflow の文字列を出し、どれが正かは決めない', async () => {
  const params = 'Negative prompt: lowres\nSteps: 20, Sampler: Euler a, CFG scale: 7, Seed: 1, Size: 64x64';
  const r = await extract(F.png({ width: 64, height: 64, text: { parameters: params, workflow: JSON.stringify(F.COMFY_WORKFLOW) } }));
  assert.equal(r.format, 'A1111');
  assert.equal(r.positive, '');
  assert.equal(r.negative, 'lowres');
  assert.equal(r.note, 'workflow-only');
  assert.deepEqual(r.workflowTexts.map((t) => t.text), ['1girl, smile']);
});

test('EXIF の UserComment: JPEG (ASCII の A1111 形式) と WebP (UNICODE の JSON、BOM 無し BE)', async () => {
  const jpeg = await meta.extractFromBytes(F.jpegWithExif(F.A1111_TEXT));
  assert.equal(jpeg.foundIn, 'exif');
  assert.equal(jpeg.format, 'A1111');
  assert.equal(jpeg.settings.steps, 20);
  const webp = await meta.extractFromBytes(F.webpWithExif(JSON.stringify(F.naiDict({ seed: 9 })), { unicode: true }));
  assert.equal(webp.foundIn, 'exif');
  assert.equal(webp.format, 'NovelAI');
  assert.equal(webp.settings.seed, 9);
  // PNG の eXIf チャンクも同じ道
  const png = await meta.extractFromBytes(F.png({ width: 8, height: 8, exif: F.exifTiff(F.A1111_TEXT) }));
  assert.equal(png.foundIn, 'exif');
});

test('情報なし: 何も無い PNG / JPEG / 画像でない物は null (エラーにしない)', async () => {
  assert.equal(await extract(F.png({ width: 64, height: 64 })), null);
  assert.equal(await extract(F.png({ width: 64, height: 64, channels: 4 })), null);
  assert.equal(await meta.extractFromBytes(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), null);
  assert.equal(await meta.extractFromBytes(Buffer.from('not an image at all, really')), null);
  assert.equal(await meta.extractFromBytes(Buffer.alloc(0)), null);
  // 関係ない tEXt だけ (Software しか無い) も null
  assert.equal(await extract(F.png({ width: 64, height: 64, text: { Software: 'Some Paint Tool' } })), null);
});

test('壊れたステルス: gzip が壊れている / 長さが絵に入り切らない / 長さ 0 → 落ちずに null', async () => {
  const dict = F.naiDict();
  assert.equal(await extract(F.stealthPng({ dict, corruptGzip: true })), null);
  assert.equal(await extract(F.stealthPng({ dict, lengthBits: 64 * 64 * 64 })), null);
  assert.equal(await extract(F.stealthPng({ dict, lengthBits: 0 })), null);
  assert.equal(await extract(F.stealthPng({ dict, lengthBits: 0xffffffff })), null);
});

test('壊れたチャンク (長さが足りない・zTXt が展開できない) でも読める鍵は読む', async () => {
  const good = F.png({ width: 8, height: 8, text: { parameters: F.A1111_TEXT } });
  const cut = good.subarray(0, good.length - 20);   // IEND と IDAT の尻が欠けた物
  const r = await meta.extractFromBytes(cut);
  assert.equal(r && r.format, 'A1111');
  const zlib = require('zlib');
  const broken = F.png({ width: 8, height: 8, text: { Comment: 'x' }, textKind: 'zTXt' });
  assert.equal(await meta.extractFromBytes(broken.subarray(0)), null);
  assert.ok(zlib);
});

test('normalize: NovelAI の Comment の中身そのもの (EXIF の JSON) も読む。読めない dict は null', () => {
  const r = meta.normalize({ prompt: 'a', uc: 'b', seed: 1, model_name: 'm' });
  assert.equal(r.format, 'NovelAI');
  assert.equal(r.settings.model, 'm');
  assert.equal(meta.normalize({ foo: 'bar' }), null);
  assert.equal(meta.normalize('string'), null);
  assert.equal(meta.normalize(null), null);
});

test('service.analyze: 2048×2048 の RGBA PNG のステルスを読んでも主スレッドが詰まらない', async () => {
  const dict = F.naiDict({ seed: 2048 });
  const bytes = F.stealthPng({ dict, width: 2048, height: 2048 });
  let worst = 0;
  let last = Date.now();
  const timer = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last - 10); last = now; }, 10);
  const r = await service.analyze(bytes);
  clearInterval(timer);
  assert.equal(r && r.settings.seed, 2048);
  assert.equal(r.foundIn, 'stealth_pngcomp');
  // 復号は sharp (libuv のスレッド)、ビットの読みは数十 KB ぶんだけ。10ms の時計が 150ms より遅れたら主を止めている
  assert.ok(worst < 150, `主スレッドの最長の詰まり ${worst}ms`);
});

test('service.analyze: sharp 無し (BUNKO_NO_SHARP) でもチャンクと EXIF は読め、ステルスは null で済む', async () => {
  const { spawnSync } = require('node:child_process');
  const script = `
    const F = require('./test/helpers/ai-meta-fixtures');
    const s = require('./src/lib/ai-meta-service');
    Promise.all([
      s.analyze(F.png({ width: 16, height: 16, text: { parameters: F.A1111_TEXT } })),
      s.analyze(F.stealthPng({ dict: F.naiDict() })),
    ]).then(([a, b]) => console.log(JSON.stringify([a && a.format, b])));
  `;
  const out = spawnSync(process.execPath, ['-e', script], { cwd: require('path').join(__dirname, '..'), env: { ...process.env, BUNKO_NO_SHARP: '1' }, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout.trim()), ['A1111', null]);
});

test('createCache: 投稿 + 頁で控え、「情報なし」(null) も控える。走っている物は一つにまとめ、失敗は控えない', async () => {
  const cache = service.createCache({ max: 2 });
  let calls = 0;
  const fetch = (value) => async () => { calls += 1; await new Promise((r) => setTimeout(r, 5)); return value; };
  const [a, b] = await Promise.all([cache.resolve('1', 0, fetch({ x: 1 })), cache.resolve('1', 0, fetch({ x: 2 }))]);
  assert.deepEqual(a, { x: 1 });
  assert.equal(b, a);
  assert.equal(calls, 1, '同じ頁の同時の頼みは一度だけ');
  assert.equal(await cache.resolve('1', 0, fetch({ x: 3 })), a, '二度目は控えから');
  assert.equal(await cache.resolve('1', 1, fetch(null)), null);
  assert.equal(await cache.resolve('1', 1, fetch({ x: 9 })), null, '情報なしも控える (網に出ない)');
  assert.equal(calls, 2);
  await assert.rejects(cache.resolve('2', 0, async () => { throw new Error('429'); }));
  assert.equal(cache.has('2', 0), false, '失敗は控えない');
  await cache.resolve('3', 0, fetch({ x: 4 }));
  assert.equal(cache.size, 2, '上限を超えた古い物は捨てる');
  assert.equal(cache.has('1', 0), false);
});
