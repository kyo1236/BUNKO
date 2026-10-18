const CJK_OR_KANA = /[぀-ヿ㐀-䶿一-鿿ｦ-ﾟ]/;
const HIRA = /[\u3041-\u3096]/g;

function nfkc(value) {
  return String(value || '').normalize('NFKC');
}

function hiraToKata(value) {
  return String(value || '').replace(HIRA, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60));
}

function aliasKey(value) {
  return hiraToKata(nfkc(value))
    .toLowerCase()
    .replace(/[\s_\-−–—・･.。、,，!！?？'"“”‘’~～:：;；/\\[\]()（）【】『』「」]/g, '');
}

function hasCjk(value) {
  return CJK_OR_KANA.test(String(value || ''));
}

// ローマ字 (hitomi の作家名) をカタカナに起こす。漢字の名の「読み」は台帳の
// どこにも無いが、hitomi のタグ名がヘボン式の読みそのものなので、これを仮名に
// 直せば ひらがな入力の照合に使える (aliasKey が ひら→カタ を吸収する)。
// 起こし切れない字が混ざる語 (欧文の名義・数字入り) は '' を返して諦める
const ROMAJI_MAP = (() => {
  const rows = {
    a: 'ア', i: 'イ', u: 'ウ', e: 'エ', o: 'オ',
    ka: 'カ', ki: 'キ', ku: 'ク', ke: 'ケ', ko: 'コ',
    sa: 'サ', si: 'シ', su: 'ス', se: 'セ', so: 'ソ', shi: 'シ',
    ta: 'タ', ti: 'チ', tu: 'ツ', te: 'テ', to: 'ト', chi: 'チ', tsu: 'ツ',
    na: 'ナ', ni: 'ニ', nu: 'ヌ', ne: 'ネ', no: 'ノ',
    ha: 'ハ', hi: 'ヒ', hu: 'フ', he: 'ヘ', ho: 'ホ', fu: 'フ',
    ma: 'マ', mi: 'ミ', mu: 'ム', me: 'メ', mo: 'モ',
    ya: 'ヤ', yu: 'ユ', yo: 'ヨ',
    ra: 'ラ', ri: 'リ', ru: 'ル', re: 'レ', ro: 'ロ',
    wa: 'ワ', wo: 'ヲ', wi: 'ウィ', we: 'ウェ',
    ga: 'ガ', gi: 'ギ', gu: 'グ', ge: 'ゲ', go: 'ゴ',
    za: 'ザ', zi: 'ジ', zu: 'ズ', ze: 'ゼ', zo: 'ゾ', ji: 'ジ',
    da: 'ダ', di: 'ヂ', du: 'ヅ', de: 'デ', do: 'ド',
    ba: 'バ', bi: 'ビ', bu: 'ブ', be: 'ベ', bo: 'ボ',
    pa: 'パ', pi: 'ピ', pu: 'プ', pe: 'ペ', po: 'ポ',
    fa: 'ファ', fi: 'フィ', fe: 'フェ', fo: 'フォ',
    va: 'ヴァ', vi: 'ヴィ', vu: 'ヴ', ve: 'ヴェ', vo: 'ヴォ',
    kya: 'キャ', kyu: 'キュ', kyo: 'キョ',
    gya: 'ギャ', gyu: 'ギュ', gyo: 'ギョ',
    sha: 'シャ', shu: 'シュ', sho: 'ショ', she: 'シェ',
    sya: 'シャ', syu: 'シュ', syo: 'ショ',
    ja: 'ジャ', ju: 'ジュ', jo: 'ジョ', je: 'ジェ',
    jya: 'ジャ', jyu: 'ジュ', jyo: 'ジョ',
    zya: 'ジャ', zyu: 'ジュ', zyo: 'ジョ',
    cha: 'チャ', chu: 'チュ', cho: 'チョ', che: 'チェ',
    tya: 'チャ', tyu: 'チュ', tyo: 'チョ',
    nya: 'ニャ', nyu: 'ニュ', nyo: 'ニョ',
    hya: 'ヒャ', hyu: 'ヒュ', hyo: 'ヒョ',
    bya: 'ビャ', byu: 'ビュ', byo: 'ビョ',
    pya: 'ピャ', pyu: 'ピュ', pyo: 'ピョ',
    mya: 'ミャ', myu: 'ミュ', myo: 'ミョ',
    rya: 'リャ', ryu: 'リュ', ryo: 'リョ',
    dya: 'ヂャ', dyu: 'ヂュ', dyo: 'ヂョ',
    tsa: 'ツァ', tsi: 'ツィ', tse: 'ツェ', tso: 'ツォ',
    thi: 'ティ', dhi: 'ディ',
  };
  return new Map(Object.entries(rows));
})();

function romajiToKata(value) {
  const text = String(value || '').normalize('NFKC').toLowerCase();
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    // 区切りは読まない (aliasKey 側でも落とされる)
    if (ch === ' ' || ch === '_' || ch === '-' || ch === '.' || ch === "'") { i += 1; continue; }
    // 促音: 同じ子音の連なり (nn は撥音の並びなので別扱い)
    if (i + 1 < text.length && ch === text[i + 1] && 'kstpgzbdfhjmyrwc'.includes(ch)) {
      out += 'ッ';
      i += 1;
      continue;
    }
    if (ch === 't' && text.startsWith('tch', i)) { out += 'ッ'; i += 1; continue; }
    // 撥音: n の後ろが母音でも y でもない、または語末
    if (ch === 'n') {
      const next = text[i + 1];
      if (!next || !'aiueoy'.includes(next)) { out += 'ン'; i += 1; continue; }
    }
    let hit = '';
    for (const len of [3, 2, 1]) {
      const part = text.slice(i, i + len);
      if (ROMAJI_MAP.has(part)) { hit = part; break; }
    }
    if (!hit) return '';
    out += ROMAJI_MAP.get(hit);
    i += hit.length;
  }
  return out;
}

// カタカナ・ひらがなをヘボン式へ落とす。ROMAJI_MAP を裏返して作るので
// 表を二つ持たない (romajiToKata と同じ対応がそのまま逆に効く)。
// 漢字は読めないので、漢字が混ざる語は '' を返して諦める
const KATA_TO_ROMAJI = (() => {
  const rows = [...ROMAJI_MAP.entries()].sort((a, b) => b[1].length - a[1].length);
  const out = new Map();
  for (const [romaji, kana] of rows) {
    // 同じ仮名に複数の綴りがある時は、短く素直な方 (shi より si ではなく shi) を採る:
    // 先に入った物を残し、より短い綴りが来たら差し替える
    const current = out.get(kana);
    if (!current || romaji.length < current.length) out.set(kana, romaji);
  }
  return out;
})();

function kataToRomaji(value) {
  const text = hiraToKata(nfkc(value)).replace(/[・\s]/g, '');
  if (!text) return '';
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === 'ー') { i += 1; continue; }              // 長音は落とす (bakuon → bakuon)
    if (ch === 'ッ') {                                   // 促音は次の子音を重ねる
      const next = KATA_TO_ROMAJI.get(text.slice(i + 1, i + 3)) || KATA_TO_ROMAJI.get(text[i + 1]) || '';
      if (next) out += next[0];
      i += 1;
      continue;
    }
    if (ch === 'ン') { out += 'n'; i += 1; continue; }
    const pair = KATA_TO_ROMAJI.get(text.slice(i, i + 2));
    if (pair) { out += pair; i += 2; continue; }
    const one = KATA_TO_ROMAJI.get(ch);
    if (one) { out += one; i += 1; continue; }
    return '';                                           // 漢字など読めない字
  }
  return out;
}

function isMostlyLatin(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  return !hasCjk(text) && /[a-z0-9]/i.test(text);
}

// 同じ名前のローマ字の揺れを一つの形へ畳む。長音 (toosaka / tosaka、hyuuga / hyuga)、
// 記号 (haikyuu!! / haikyuu、fate/grand_order)、語順 (danbooru は 姓_名、hitomi は 名 姓)。
//
// romajiToKata を通す canonicalRomaji とは役目が違う。あちらは「日本語の読みを
// 二通りの綴りで書いた物」(shirasu / sirasu) を畳む。こちらは「同じ名前を長さの
// 揺れで書いた物」を畳む。canonicalRomaji は toosaka を toosaka のまま返す。
//
// 使う所が二つある (組み直しの番人と、その試験) ので、ここに一つだけ置く。
// 両方に書くと、片方だけ直した時にずれる
function foldRomajiName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/ou/g, 'o')
    .replace(/oo/g, 'o')
    .replace(/uu/g, 'u')
    // `ee` は畳まない。日本語の長音では稀 (oneesan くらい) なのに、欧文名で
    // 別物をぶつける: eevee を畳むと eve になり、ポケモンのイーブイと
    // 人名の Eve (156 冊) が同じ鍵になっていた。得より害が大きい
    .split(' ')
    .filter(Boolean)
    .sort()
    .join(' ');
}

module.exports = {
  nfkc,
  hiraToKata,
  aliasKey,
  hasCjk,
  isMostlyLatin,
  romajiToKata,
  kataToRomaji,
  foldRomajiName,
};
