const {
  aliasKey, hasCjk, isMostlyLatin, nfkc, romajiToKata, kataToRomaji,
} = require('./search-text');

// ヘボン式と訓令式 (shirasu / sirasu、chi / ti) を一つの形へ畳む。
// 一度かなに起こしてから読み直すので、どちらの綴りで打っても同じ鍵になる
function canonicalRomaji(value) {
  const kana = romajiToKata(value);
  return kana ? kataToRomaji(kana) : '';
}
const { tagNameKey } = require('./title-keys');

const { parseTypePrefix, TYPE_ALIASES, TAG_TYPES } = require('./search-type');

// 札 (表示名) の出どころの強さ。強い方が勝つ。読み込む順に依らせない。
//   0 一般則 (pickLabel)  1 横断語彙の行き先の札  2 監査済みの上書き  3 手で決めた物
const LABEL_RANK = { picked: 0, vocabulary: 1, override: 2, manual: 3 };

function setLabel(entry, label, rank) {
  const text = String(label || '').trim();
  if (!text) return;
  if (entry.labelRank != null && entry.labelRank > rank) return;
  entry.label = text;
  entry.labelRank = rank;
}

// "series my hero academia" / "character akane_tendo" のどちらの綴りでも
// 同じ値に落とす。台帳 (catalog.importDictLabels) と同じ正規化を使う
function overrideValue(key) {
  const space = String(key).indexOf(' ');
  if (space < 1) return null;
  const type = String(key).slice(0, space).toLowerCase().trim();
  const name = tagNameKey(String(key).slice(space + 1));
  if (!type || !name || !TAG_TYPES.has(type)) return null;
  return { type, name: name.replace(/ /g, '_'), value: `${type}:${name.replace(/ /g, '_')}` };
}

function hasKana(value) {
  return /[ぁ-んァ-ヶー]/.test(String(value || ''));
}

function pickLabel(labels) {
  const list = labels.filter((s) => {
    if (!s || /(これ|淫夢|部|パロ|イラコン|化)$/.test(s)) return false;
    if (/^[ぁ-んァ-ヶー]+$/.test(s) && labels.some((other) => other !== s && other.endsWith(s))) return false;
    return true;
  });
  const kata = list.filter((s) => /^[ァ-ヶー]{3,8}$/.test(s) && !/^(デカ|超|ガチ)/.test(s));
  if (kata.length) return kata.sort((a, b) => a.length - b.length || a.localeCompare(b, 'ja'))[0];
  const kanji = list.filter((s) => /^[\u4E00-\u9FFF]{2}$/.test(s));
  if (kanji.length) return kanji.sort((a, b) => a.length - b.length || a.localeCompare(b, 'ja'))[0];
  const mixed = list.filter((s) => hasKana(s) && /[\u4E00-\u9FFF]/.test(s) && s.length <= 8 && !/^(デカ|超|ガチ)/.test(s));
  if (mixed.length) return mixed.sort((a, b) => a.length - b.length || a.localeCompare(b, 'ja'))[0];
  const other = list.filter((s) => hasKana(s) && s.length >= 3);
  if (other.length) return other.sort((a, b) => a.length - b.length || a.localeCompare(b, 'ja'))[0];
  return list[0] || labels[0] || '';
}

// 人と作品の札は「一般則で短い物を選ぶ」ではなく「正式名を選ぶ」。
// 中野梓 を ゆいあず (カップリング名) と出したり、ワンピース を アニワン と
// 出したりしていたのがこれ。辞書の並びは danbooru の other_names 順で、
// 正式名が先頭に来る。先頭から順に「正式名らしい字面」を探す。
// 当てはまらなければ一般則 (pickLabel) に戻す — 適当な日本語は作らない
const NAMED_TYPES = new Set(['character', 'artist', 'group', 'series']);
const NICKNAME_TAIL = /(これ|淫夢|部|パロ|イラコン|化|組|一家|トリオ|コンビ)$/;

// 試して捨てた案: 「正準名が日本語のローマ字として読めないなら (aang, helianthus)、
// かなを含む札を先に見る」。中国語訳が札になるのを防ぐつもりだったが、
// 全 17,146 行で当ててみると 213 行の札が変わり、直る数と壊れる数が釣り合わなかった。
//   直る: 绝区零 → ゼンレスゾーンゼロ、可莉 → クレー、爱蜜莉雅 → エミリア
//   壊れる: 原神 → gnsnプラス、逆転裁判 → 逆裁腐向け、銀狼 → ぎんろう、伊19 → イクちゃん
// 理由は `genshin_impact` や `ace_attorney` のような**日本作品の英題**も
// 「ローマ字として読めない」に落ちるから。そこでかなを先に見ると、
// 正しい漢字名より渾名が前に出る。中国語と渾名を一つの物差しでは分けられない。
// 中国語が札に混じる件は既知の限界として docs に残す (label-overrides.json で個別に直せる)
function properName(labels, type) {
  if (!NAMED_TYPES.has(type)) return '';
  for (const raw of labels) {
    const text = String(raw || '').trim();
    if (!text || text.length > 16 || text.length < 2) continue;
    if (/[()（）]/.test(text)) continue;        // 「アズサ(ブルアカ)」は所属の注記
    if (/[a-zA-Z0-9]/.test(text) && !/[぀-ヿ一-鿿]/.test(text)) continue;
    if (!hasCjk(text)) continue;
    if (NICKNAME_TAIL.test(text)) continue;     // 「継続一家」「隊長組」は渾名
    return text;
  }
  return '';
}

function keepLabel(label, value) {
  const text = String(label || '');
  if (!text) return false;
  if (/巨乳/.test(text) && text !== '巨乳' && !value.includes('big_breasts')) return false;
  if (/爆乳/.test(text) && text !== '爆乳' && !value.includes('huge_breasts')) return false;
  return true;
}

let loaded = null;

function loadData() {
  if (loaded) return loaded;
  let raw = { entries: [] };
  try {
    raw = require('./data/aliases.json');
  } catch {
    raw = { entries: [] };
  }

  const byKey = new Map();
  // 候補にだけ使う索引 (hitomi に無い pixiv 専用の語)。書き換えには使わない
  const byHint = new Map();
  const entries = [];
  for (const item of raw.entries || []) {
    const value = String(item.value || '').trim();
    const type = String(item.type || '').trim();
    const name = String(item.name || '').trim();
    if (!value || !type || !name) continue;
    const labels = (Array.isArray(item.labels) ? item.labels.map(String) : [])
      .filter((label) => keepLabel(label, value));
    const keys = (Array.isArray(item.keys) ? item.keys.map(String) : labels)
      .filter((label) => keepLabel(label, value));
    if (!labels.length && !keys.length) continue;
    const entry = {
      value,
      type,
      name,
      label: properName(labels, type) || pickLabel(labels) || name,
      labelRank: LABEL_RANK.picked,
      labels: labels.length ? labels : keys,
      count: Number(item.count) || 0,
    };
    // 所属作品と「どのサイトで引けるか」の印 (rebuild-aliases が付ける)
    if (item.series) entry.series = String(item.series);
    // VTuber の所属事務所。画面に出すだけで、検索条件には使わない
    // (hitomi は hololive と nijisanji しか series を持たないため)
    if (item.vtuber && item.vtuber.label) {
      entry.vtuber = { agency: String(item.vtuber.agency || ''), label: String(item.vtuber.label) };
    }
    if (item.sites && typeof item.sites === 'object') entry.sites = { ...item.sites };
    if (Array.isArray(item.romaji) && item.romaji.length) entry.romaji = item.romaji.map(String);
    entries.push(entry);
    const seen = new Set();
    for (const key of keys) {
      const norm = aliasKey(key);
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      // hitomi に無い語 (pixiv 専用) は **候補にだけ**使う索引へ入れる。
      // byKey に混ぜると rewriteQuery / uniqueLookup が拾い、hitomi で
      // 「しぐれうい」と打った時に hitomi に無いタグへ書き換えて 0 件になる。
      // ローマ字の索引 (byRomaji) を候補専用にしてあるのと同じ理由
      const table = entry.sites && entry.sites.hitomi === false ? byHint : byKey;
      if (!table.has(norm)) table.set(norm, []);
      table.get(norm).push(entry);
    }
  }

  let manual = { entries: [] };
  try {
    manual = require('./data/manual-aliases.json');
  } catch {
    manual = { entries: [] };
  }

  const byValue = new Map(entries.map((entry) => [entry.value, entry]));
  const preferredByKey = new Map();

  // 監査済みの表示名 (label-overrides.json) は画面に出る名前そのもの。
  // 出るのに打てない、が「名探偵コナンと入れても候補が出ない」の正体だったので、
  // 同じ表を検索の鍵にも入れる。札としてはここが一般則より強い。
  // 辞書に無い語 (hitomi にしか無い series) は、この表だけで項目を起こす
  let overrides = {};
  try {
    overrides = require('./data/label-overrides.json');
  } catch {
    overrides = {};
  }
  for (const [key, text] of Object.entries(overrides)) {
    const slot = overrideValue(key);
    const label = String(text || '').trim();
    if (!slot || !label) continue;
    let entry = byValue.get(slot.value);
    if (!entry) {
      entry = { value: slot.value, type: slot.type, name: slot.name, label, labelRank: LABEL_RANK.override, labels: [], count: 0 };
      entries.push(entry);
      byValue.set(slot.value, entry);
    }
    setLabel(entry, label, LABEL_RANK.override);
    if (!entry.labels.includes(label)) entry.labels.push(label);
    const norm = aliasKey(label);
    if (!norm) continue;
    if (!byKey.has(norm)) byKey.set(norm, []);
    if (!byKey.get(norm).includes(entry)) byKey.get(norm).push(entry);
  }
  for (const item of manual.entries || []) {
    const value = String(item.value || '').trim();
    const match = value.match(/^([a-z]+):(.+)$/);
    if (!match || !TAG_TYPES.has(match[1])) continue;
    const labels = (Array.isArray(item.labels) ? item.labels.map(String) : []).filter(Boolean);
    if (!labels.length) continue;
    let entry = byValue.get(value);
    if (!entry) {
      entry = {
        value,
        type: match[1],
        name: match[2],
        label: String(item.label || '') || pickLabel(labels) || match[2],
        labelRank: item.label ? LABEL_RANK.manual : LABEL_RANK.picked,
        labels: [...labels],
        count: Number(item.count) || 0,
        manual: true,
      };
      entries.push(entry);
      byValue.set(value, entry);
    } else {
      for (const label of labels) if (!entry.labels.includes(label)) entry.labels.push(label);
      setLabel(entry, pickLabel(entry.labels), LABEL_RANK.picked);
      if (item.label) setLabel(entry, String(item.label), LABEL_RANK.manual);
      if ((Number(item.count) || 0) > entry.count) entry.count = Number(item.count) || 0;
    }
    for (const label of labels) {
      const norm = aliasKey(label);
      if (!norm) continue;
      if (!byKey.has(norm)) byKey.set(norm, []);
      const group = byKey.get(norm);
      if (!group.includes(entry)) group.push(entry);
      if (item.preferred) preferredByKey.set(norm, entry);
    }
  }

  // Reviewed cross-site vocabulary is also the source of local completions.
  // Keep existing display labels and counts; only exact aliases may rewrite a query.
  // 行き先の札 (outputs.hitomi.label) も鍵にする。入力に無い正式表記 (スパイファミリー)
  // が「詳細には出るのに打てない」状態になっていた
  const vocabulary = require('./data/search-vocabulary.json');
  for (const item of vocabulary.entries || []) {
    const target=item.outputs?.hitomi;
    if (!target || !TAG_TYPES.has(target.type) || !target.name) continue;
    const value=`${target.type}:${target.name.replace(/\s+/g,'_')}`;
    const inputs=(item.inputs || []).filter(input=>input.relation==='exact' && input.site==='pixiv').map(input=>input.name).filter(Boolean);
    const shown=String(target.label || '').trim();
    const labels=[...new Set([...inputs, ...(hasCjk(shown) ? [shown] : [])])];
    if (!labels.length) continue;
    let entry=byValue.get(value);
    if (!entry) {
      entry={value,type:target.type,name:target.name,label:shown || inputs[0],labelRank:LABEL_RANK.vocabulary,labels:[],count:0};
      entries.push(entry);byValue.set(value,entry);
    } else if (hasCjk(shown)) setLabel(entry, shown, LABEL_RANK.vocabulary);
    if (Array.isArray(item.romaji) && item.romaji.length) {
      entry.romaji = [...new Set([...(entry.romaji || []), ...item.romaji.map(String)])];
    }
    for (const label of labels) {
      if (!entry.labels.includes(label)) entry.labels.push(label);
      const key=aliasKey(label);if(!key)continue;
      if(!byKey.has(key))byKey.set(key,[]);
      if(!byKey.get(key).includes(entry))byKey.get(key).push(entry);
    }
  }

  // 曖昧な札を降ろす。「アズサ」は六人ぶんの下の名前で、どれを指すか分からない。
  // 二人以上が同じ札を名乗っていて、その人だけを指す正式名 (三浦あずさ・柏木梓) が
  // 辞書にあるなら、画面にはそちらを出す。降ろした札は鍵としては残る
  // (打てば今まで通り候補に出る)。監査済みの札を捨てるのではなく、並べ方を直す
  // 同じ札を名乗る別人が居るか。同じ人物が二つの語で居るだけ (沖田総司 と
  // 沖田総司〔オルタ〕、noa と noa ushio) なら別人ではない — 名前の語が重なる
  const nameParts = (entry) => new Set(String(entry.name).split('_').filter(Boolean));
  const ambiguousLabel = (entry) => {
    const group = (byKey.get(aliasKey(entry.label)) || []).filter((other) => other.type === entry.type);
    if (group.length <= 1) return false;
    const mine = nameParts(entry);
    // 同じ人物の別表記は、名前の語が片方に丸ごと含まれる
    // (souji_okita ⊂ okita_souji_alter、noa ⊂ noa_ushio)。
    // 三浦あずさ と 柏木梓 はどちらも相手を含まないので別人
    const samePerson = (other) => {
      const theirs = nameParts(other);
      return [...theirs].every((part) => mine.has(part))
        || [...mine].every((part) => theirs.has(part));
    };
    return group.some((other) => other !== entry && !samePerson(other));
  };
  for (const entry of entries) {
    if (entry.labelRank !== LABEL_RANK.override || !ambiguousLabel(entry)) continue;
    const better = properName(entry.labels.filter((label) => aliasKey(label) !== aliasKey(entry.label)), entry.type);
    if (!better) continue;
    const group = byKey.get(aliasKey(better)) || [];
    if (group.filter((other) => other.type === entry.type).length !== 1) continue;
    entry.label = better;
  }

  // ローマ字の索引。**候補にだけ使う**。byKey に混ぜると uniqueLookup / rewriteQuery が
  // 拾ってしまい、"sakura" のような普通の欧文語が character: に化ける
  const byRomaji = new Map();
  const addRomaji = (key, entry) => {
    const norm = aliasKey(key);
    if (!norm || norm.length < 2) return;
    if (!byRomaji.has(norm)) byRomaji.set(norm, []);
    const group = byRomaji.get(norm);
    if (!group.includes(entry)) group.push(entry);
  };
  for (const entry of entries) {
    if (!['character', 'series', 'artist', 'group'].includes(entry.type)) continue;
    const plain = String(entry.name).replace(/_/g, ' ');
    if (!hasCjk(plain)) {
      addRomaji(plain, entry);
      for (const part of plain.split(' ')) addRomaji(part, entry);
    }
    // 日本語の読みのローマ字。二通りの綴り (shirasu / sirasu) を一つの形へ畳む
    for (const reading of entry.romaji || []) {
      addRomaji(reading, entry);
      addRomaji(canonicalRomaji(reading), entry);
      for (const part of String(reading).split(' ')) {
        addRomaji(part, entry);
        addRomaji(canonicalRomaji(part), entry);
      }
    }
    // かなの札はそのまま読める (アスナ → asuna、ブルアカ → buruaka)
    for (const label of entry.labels || []) {
      const reading = kataToRomaji(label);
      if (reading && reading.length >= 2) addRomaji(reading, entry);
    }
  }

  loaded = { byKey, byHint, byRomaji, byValue, entries, preferredByKey, version: raw.version || 0, builtAt: raw.builtAt || '' };
  return loaded;
}

// 台帳 (所持庫) から来る動的な別名の出どころ。静的な aliases.json は世間一般の
// 語の辞書で、所持作家の日本語名・読みは台帳にしか無い。台帳が起きた時に
// { lookup(term)→entries, suggest(term, limit)→entries } を差し込む
let dynamicSource = null;

function setDynamicSource(source) {
  dynamicSource = source || null;
}

function dynamicLookup(term) {
  if (!dynamicSource) return [];
  try {
    return dynamicSource.lookup(term) || [];
  } catch {
    return [];
  }
}

function lookup(term) {
  const key = aliasKey(term);
  if (!key) return [];
  const hits = loadData().byKey.get(key) || [];
  const seen = new Set();
  return hits.filter((item) => {
    if (seen.has(item.value)) return false;
    seen.add(item.value);
    return true;
  });
}

// 飾り付け専用の引き。byKey に加えて候補専用の索引 (byHint) も見る。
//
// サイト自身の補完から来る候補は「型の無い素の語」(pixiv が返す `小森めと`)。
// それを辞書に当てる時、byKey だけ見ていると pixiv 専用の人物に届かず、
// 日本語名も所属事務所も付かないまま素のタグとして出てしまう。
//
// **書き換え (rewriteQuery / uniqueLookup) はこれを使わない。** あちらはサイトを
// 知らないので、pixiv 専用の語を混ぜると hitomi の検索語が化ける
function lookupForDisplay(term) {
  const key = aliasKey(term);
  if (!key) return [];
  const data = loadData();
  const hits = [...(data.byKey.get(key) || []), ...(data.byHint.get(key) || [])];
  const seen = new Set();
  return hits.filter((item) => {
    if (seen.has(item.value)) return false;
    seen.add(item.value);
    return true;
  });
}

// hitomi は同じ人物を二つの語で持っていることがある (`azusa` と `azusa shirasu`、
// `noa` と `noa ushio`)。下の名前が同じで姓が一つしか無いなら一人の話なので、
// 姓まで入った方 (作品数も多い: 199 対 21、1021 対 24) へ倒してよい。
// 姓が二つ以上あるなら別人が混ざっているので、ここでは決めない
function samePerson(hits) {
  if (!hits.every((hit) => hit.type === hits[0].type && hit.type === 'character')) return null;
  const given = new Set(hits.map((hit) => String(hit.name).split('_')[0]));
  if (given.size !== 1) return null;
  const named = hits.filter((hit) => String(hit.name).includes('_'));
  const surnames = new Set(named.map((hit) => String(hit.name).split('_').slice(1).join('_')));
  if (surnames.size !== 1 || !named.length) return null;
  return named.sort((a, b) => (b.count || 0) - (a.count || 0))[0];
}

function uniqueLookup(term) {
  const hits = lookup(term);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    const preferred = loadData().preferredByKey.get(aliasKey(term));
    if (preferred && hits.includes(preferred)) return preferred;
    const person = samePerson(hits);
    if (person) return person;
  }
  if (!hits.length) {
    // 辞書に無い語は所持庫の作家名に訊く。一人に定まる時だけ書き換える
    // (同名が居るなら候補 (suggest) に任せ、勝手にどちらかへ倒さない)
    const dynamic = dynamicLookup(term);
    if (dynamic.length === 1) return dynamic[0];
  }
  return null;
}

function rewriteQuery(raw) {
  const text = String(raw || '').trim();
  if (!text) return { query: '', tokens: [], resolved: [] };

  const tokens = require('./search-type').tokenizeQuery(text);
  const resolved = [];
  const next = tokens.map((token) => {
    const typed = parseTypePrefix(token);
    if (typed) {
      if (!['artist','group'].includes(typed.type)) return typed.token;
      const candidates = [...new Map([...lookup(typed.name), ...dynamicLookup(typed.name)].filter(item=>item.type===typed.type).map(item=>[item.value,item])).values()];
      if (candidates.length !== 1) return typed.token;
      const hit=candidates[0]; const value=`${typed.negative?'-':''}${hit.value}`;
      if (value !== typed.token) resolved.push({from:token,to:value,label:hit.label,type:hit.type});
      return value;
    }
    // 除外の印を落とさない。aliasKey は '-' を捨てるので、素の語に付いた
    // 先頭の '-' を剥いでから引き、答えに付け直す。付け直さないと
    // 「-ふたなり」が「female:futanari」= 含める条件に化けていた
    const negative = token.length > 1 && token.startsWith('-');
    const bare = negative ? token.slice(1) : token;
    const hit = uniqueLookup(bare);
    if (!hit) return token;
    const value = `${negative ? '-' : ''}${hit.value}`;
    resolved.push({ from: token, to: value, label: hit.label, type: hit.type });
    return value;
  });

  return {
    query: next.join(' '),
    tokens: next,
    resolved,
  };
}

function suggestAliases(term, limit = 8) {
  const needle = aliasKey(term);
  if (!needle) return [];
  if (!hasCjk(term) && needle.length < 2) return [];

  const data = loadData();
  const best = new Map();
  // 候補は両方の索引から。byHint は hitomi に無い pixiv 専用の語で、
  // どのサイトへ出すかは呼ぶ側 (search-decorate の forSite) が sites の印で決める
  for (const [key, group] of [...data.byKey, ...data.byHint]) {
    if (!key.includes(needle)) continue;
    const prefix = key.startsWith(needle);
    if (needle.length <= 2 && !prefix) continue;
    for (const item of group) {
      const score = (prefix ? 0 : 20) + Math.abs(key.length - needle.length)
        - (data.preferredByKey.get(key) === item ? 5 : 0);
      const current = best.get(item.value);
      if (current && current.score <= score) continue;
      best.set(item.value, {
        type: item.type,
        name: item.name,
        value: item.value,
        label: item.label,
        count: item.count || 0,
        metric: item.count>0 ? {site:'hitomi',kind:'works',value:item.count,scope:'tag',observedAt:data.builtAt,approximate:true} : null,
        source: 'alias',
        score,
      });
    }
  }

  // ローマ字 (asuna / kaho) は候補専用の索引で当てる。hitomi の正準名はローマ字なので、
  // 名前そのものと姓・名のどちらでも引ける。書き換え (rewriteQuery) には使わない
  if (!hasCjk(term)) {
    const folded = aliasKey(canonicalRomaji(term));
    for (const [key, group] of data.byRomaji) {
      if (!key.startsWith(needle) && !(folded && key.startsWith(folded))) continue;
      for (const item of group) {
        if (best.has(item.value)) continue;
        best.set(item.value, {
          type: item.type,
          name: item.name,
          value: item.value,
          label: item.label,
          count: item.count || 0,
          metric: item.count > 0 ? { site: 'hitomi', kind: 'works', value: item.count, scope: 'tag', observedAt: data.builtAt, approximate: true } : null,
          source: 'alias',
          score: 10 + Math.abs(key.length - needle.length),
        });
      }
    }
  }

  const ranked = [...best.values()];
  ranked.sort((a, b) => a.score - b.score || (b.count || 0) - (a.count || 0) || a.value.localeCompare(b.value));

  // 所持庫の作家を先に出す。手元にある名前の方が、辞書の一般語より当たりやすい
  let dynamic = [];
  if (dynamicSource) {
    try {
      dynamic = dynamicSource.suggest(term, limit) || [];
    } catch {
      dynamic = [];
    }
  }
  const seen = new Set(dynamic.map((item) => item.value));
  const merged = [...dynamic, ...ranked.filter((item) => !seen.has(item.value))];
  return merged.slice(0, limit).map((item) => {
    const entry = data.byValue.get(item.value);
    if (!entry) return item;
    const out = { ...item };
    if (entry.series) out.series = entry.series;
    if (entry.sites) out.sites = entry.sites;
    if (entry.vtuber) out.vtuber = entry.vtuber;
    return out;
  });
}

function shouldQueryRemoteTags(term) {
  const text = String(term || '').trim();
  if (!text) return false;
  if (text.includes(':')) return true;
  return isMostlyLatin(text) && text.length >= 2;
}

function canSuggestTerm(term) {
  const text = String(term || '').trim();
  if (!text) return false;
  if (hasCjk(text)) return true;
  return text.length >= 2;
}

function describeTerm(raw) {
  const typed=parseTypePrefix(raw), name=typed?.name || String(raw || '').replace(/^"(.*)"$/,'$1');
  const direct=typed && loadData().byValue.get(typed.token.replace(/^-/,''));
  const candidates=direct ? [direct] : [...new Map([...lookup(name),...dynamicLookup(name)].filter(row=>!typed || row.type===typed.type || (typed.type==='tag' && ['male','female','tag','either'].includes(row.type))).map(row=>[row.value,row])).values()];
  if (candidates.length!==1) return null;
  const row=candidates[0];
  return {type:row.type,name:String(row.name || row.value.split(':').slice(1).join(':')).replace(/_/g,' '),label:row.label || '',aliases:row.labels || []};
}
module.exports = {
  describeTerm,
  lookupForDisplay,
  TYPE_ALIASES,
  TAG_TYPES,
  loadData,
  lookup,
  uniqueLookup,
  parseTypePrefix,
  rewriteQuery,
  suggestAliases,
  shouldQueryRemoteTags,
  canSuggestTerm,
  pickLabel,
  setDynamicSource,
};
