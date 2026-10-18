// ID の表現・判定は ids.js に集約してある。ここから再エクスポートするので、
// 使う側は normalize ひとつを引けば足りる
const ids = require('./ids');
const { hasCjk } = require('../search-text');

function tag(type, name) {
  return { type, name: String(name || ''), negative: false };
}

// E-Hentai 式の題から飾りを剥がす。
//   "(C81) [サークル (作者)] 題 (原作) [DL版]" -> "題"
// nhentai はこの形をそのまま題に持つが、hitomi は素の題しか持たない。
// 剥がさないと (1) 札が読みにくい (2) **所持照合が噛み合わない**。
// 実測 (2026-09-15): 所持作品の照合率 61.6% -> 82.9%。
// 先頭と末尾だけを繰り返し剥がす — 真ん中の括弧は題の一部なので触らない。
// 全部剥がれてしまう題 (括弧だけの題) は元のまま返す
function stripCircleDecorations(title) {
  const PAIRS = { '(': ')', '[': ']' };
  // 対応する閉じ括弧を数えて探す。[AERIAL RAVE (Jacky)] のように入れ子が
  // あるので、最初に見つけた閉じ括弧で切ると ']' が残る
  const closeOf = (text, from) => {
    const open = text[from];
    const close = PAIRS[open];
    let depth = 0;
    for (let i = from; i < text.length; i += 1) {
      if (text[i] === open) depth += 1;
      else if (text[i] === close) {
        depth -= 1;
        if (!depth) return i;
      }
    }
    return -1;
  };
  const openOf = (text, from) => {
    const close = text[from];
    const open = close === ')' ? '(' : '[';
    let depth = 0;
    for (let i = from; i >= 0; i -= 1) {
      if (text[i] === close) depth += 1;
      else if (text[i] === open) {
        depth -= 1;
        if (!depth) return i;
      }
    }
    return -1;
  };

  let text = String(title || '').trim();
  let before;
  do {
    before = text;
    if (PAIRS[text[0]]) {
      const close = closeOf(text, 0);
      if (close > 0) text = text.slice(close + 1).trim();
    }
    const last = text.length - 1;
    if (last > 0 && (text[last] === ')' || text[last] === ']')) {
      const open = openOf(text, last);
      if (open > 0) text = text.slice(0, open).trim();
    }
  } while (text !== before && text);
  return text.trim() || String(title || '').trim();
}

function pickJapanese(english, japanese) {
  const jp = String(japanese || '').trim();
  const en = String(english || '').trim();
  // 字クラスの原本は search-text.hasCjk
  if (hasCjk(jp)) return jp;
  if (hasCjk(en)) return en;
  return jp || en || '';
}

function record(partial) {
  return {
    id: String(partial.id),
    source: partial.source,
    title: partial.title || String(partial.id),
    type: partial.type || '',
    language: partial.language || null,
    artists: partial.artists || [],
    groups: partial.groups || [],
    series: partial.series || [],
    characters: partial.characters || [],
    tags: partial.tags || [],
    pageCount: Number(partial.pageCount) || 0,
    addedDate: partial.addedDate || null,
    publishedDate: partial.publishedDate || null,
    isBlocked: false,
    hasVideo: false,
    url: partial.url || '',
    owned: false,
    kind: partial.kind || 'gallery',
    badge: partial.badge || '',
    ...coverSize(partial.width, partial.height),
  };
}

// 表紙の寸法 (分かる源泉だけ載せる)。流しの並べ方が絵を待たずに札の高さを決められる。
// 無いと表紙が届くたびに縦横比を知って並べ直し、初めて見る一覧と送りで札が跳ぶ (ui-probe で CLS 0.09 前後)
function coverSize(width, height) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  return w > 0 && h > 0 ? { width: w, height: h } : {};
}

// どの URL がどの置き場のものかは、各アダプタが自分で名乗る (detectUrl)。
// アダプタはこのファイルを使う側なので、先に読むと循環参照になる: 呼ばれた時点で引く
let urlAdapters = null;

// 並びがそのまま判定の順。先に置いたものが勝つ
function adapters() {
  if (!urlAdapters) {
    urlAdapters = [
      require('./hitomi'),
      require('./nhentai'),
      require('./ehentai'),
      require('./pawchive'),
      require('./pixiv'),
    ];
  }
  return urlAdapters;
}

function detectInput(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  for (const adapter of adapters()) {
    const hit = adapter.detectUrl ? adapter.detectUrl(text) : null;
    if (hit) return hit;
  }
  return null;
}

// Eagle の星は 0〜5 の整数。欠損・範囲外は「評価なし」= 0 に寄せる。
// 台帳 (catalog) と paw 所持庫で同じ値に丸めないと、済 の印の星が食い違う
function normalizeStar(value) {
  const numeric = Math.round(Number(value));
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.min(5, numeric);
}

module.exports = {
  tag, pickJapanese, stripCircleDecorations, record, coverSize, detectInput, normalizeStar, ...ids,
};
