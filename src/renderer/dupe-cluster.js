// 同作束ね (再掲・伏字題・ローマ字題・翻訳版を代表 1 枚に畳む) の純粋ロジック。
// app.js より先に読まれるので、DOM / state / els には一切触らない
// (テストから Node で require できることが、この分離の目的でもある)。
//
// 束ねの辺は 5 系統:
//   R1 家族   … hitomi が言う言語違い (自分の ID + translationIds) が交わる札。作家不問
//   R2 鍵一致 … 同じ dupeKey × 同じ作家
//   R3 伏字   … 催●性指導 と 催眠性指導 のように、違いが伏字記号だけの題
//   R4 飾り剥がし … 先頭のサークル表記・末尾の注記を落とすと同題になる札
//   R5 橋渡し … 非CJK題 ↔ CJK題。文字では突き合わせられないので、
//               数字・頁数・シリーズ・キャラ・**タグの重なり** をすべて課す
// つながりは Union-Find で連結成分にまとめ、代表は所持版を最優先、
// いなければ先に並んだ札 (通常は新着順なので最新版が代表になる)
const DupeCluster = (() => {
  // 伏字 (催●性指導 等) とみなす記号。この位置だけ違う題は同作とみなす
  const CENSOR_CHAR = /[●○◯〇×✕✖*＊☆★■□?？]/;
  const CJK_TITLE = /[぀-ヿ㐀-䶿一-鿿ｦ-ﾟ]/;

  // R5 の証拠となるタグの重なり。真ペアは 0.93、偽ペアは 0.42〜0.67 に落ちる。
  // 札の少ない中文再掲を巻き込まないよう、母数の下限も課す。
  //
  // 包含率ちょうど 0.75 は「谷」ではなく、この作家のタグの底値だった:
  // 実データ (group:50on 302件) の 0.750 ちょうどの組はすべて
  //   女:巨乳 / 女:人妻 / 女:洗脳 …のような、その作家のどの作品にも付く語だけの重なりで、
  //   2336273 (催眠性指導 小幡夏美の場合, タグ4枚) は正しい相手 (1569020) にも
  //   まったく別の作品 (3722642 妊婦性交指導) にも同じ 0.750 を返す。
  //   同じ値が真偽どちらにも出るなら、それは証拠ではなく雑音なので、
  //   底値ちょうどは証拠として採らない (> であって >= ではない)
  const TAG_CONTAINMENT_FLOOR = 0.75;
  const TAG_MIN_SIZE = 4;
  // 橋渡しの候補が「ひとつの作品群」に収まるかを見るときの、鍵の最短長
  const GROUP_KEY_MIN = 6;

  function censorNormalize(title) {
    return String(title || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  }

  // 題に含まれる数字の並び (巻数のつもり)。橋渡しで 4巻 と 5巻 を混ぜないための守り。
  // 全角は NFKC で半角に寄せてから拾う。(C90) のようなイベント表記を巻数と
  // 読み違えないよう、呼ぶ側は stripLeadingCredits を通した題を渡すこと
  function titleDigits(title) {
    return (String(title || '').normalize('NFKC').match(/\d+/g) || []).join(',');
  }

  // 再掲・翻訳版は表紙や奥付の増減でページ数が少しずれる。
  // ±4p か ±10% の大きい方まで同じ本とみなす。どちらか不明 (0) なら証拠にしない
  function pagesNearlyEqual(a, b) {
    const pa = Number(a) || 0;
    const pb = Number(b) || 0;
    if (!pa || !pb) return false;
    return Math.abs(pa - pb) <= Math.max(4, Math.ceil(Math.max(pa, pb) * 0.1));
  }

  const LEADING_DECOR = /^\s*(?:\[[^\]]*\]|【[^】]*】|\([^)]*\)|（[^）]*）)\s*/;
  // ハイフンで括られた短い頭書き (-50on! (愛上陸)- の類) だけ剥がす
  const LEADING_DASHED = /^\s*[-‐‑−–—][^-‐‑−–—]{1,40}[-‐‑−–—]\s*/;
  // 末尾の注記 ((Dakuon 6) [Chinese]（个人汉化） の類)。入れ子を跨がないよう
  // 中身に同種の括弧を許さない
  const TRAILING_NOTE = /\s*(?:\[[^[\]]*\]|【[^【】]*】|\([^()]*\)|（[^（）]*）)\s*$/;

  // 先頭のクレジット飾りと末尾の注記を剥がす。題そのものではないので、
  // 剥がした残りが一致すれば同題とみなしてよい。
  // 括弧の対応が壊れた題 ((C90) [50on! … [English] [Tremalkinger] の類) で
  // 全部を飾りと読んで空にしてしまわないよう、空になる一手は戻す
  function stripLeadingCredits(title) {
    let text = String(title || '').trim();
    let prev = null;
    while (prev !== text) {
      prev = text;
      let next = text.replace(LEADING_DECOR, '').replace(LEADING_DASHED, '');
      next = next.replace(TRAILING_NOTE, '').trim();
      text = next || prev;
    }
    return text.trim();
  }

  // 同じ長さで、違う位置がすべて伏字記号なら同題 (伏字は3文字まで:
  // 記号だらけの短題同士が偶然揃うのを防ぐ)
  function censoredTitleMatch(a, b) {
    if (!a || !b || a === b || a.length !== b.length) return false;
    let censored = 0;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] === b[i]) continue;
      if (!CENSOR_CHAR.test(a[i]) && !CENSOR_CHAR.test(b[i])) return false;
      censored += 1;
      if (censored > 3) return false;
    }
    return censored > 0;
  }

  function hasCjkTitle(title) {
    return CJK_TITLE.test(String(title || ''));
  }

  // 言語名。本番の札は { name, localName } のオブジェクト、
  // テストデータや別ソースでは 'japanese' の文字列で来る
  function languageName(gallery) {
    const raw = gallery && gallery.language;
    if (!raw) return '';
    const name = typeof raw === 'string' ? raw : (raw.name || '');
    return String(name).trim().toLowerCase();
  }

  // 「原版」= 日本語題 (CJK) か、hitomi が日本語と言っている札。
  // 家族にこれが居るなら、その家族の原版はもう手元にある
  function isOriginalEdition(gallery) {
    return hasCjkTitle(gallery && gallery.title) || languageName(gallery) === 'japanese';
  }

  function numericId(id) {
    const value = Number(String(id == null ? '' : id).replace(/^hitomi:/, ''));
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  // 家族 = 自分の数値 ID + translationIds。hitomi が言語違いとしてリンクした集合
  function familyKeys(gallery) {
    const keys = [];
    const self = numericId(gallery && gallery.id);
    if (self) keys.push(self);
    const links = Array.isArray(gallery && gallery.translationIds) ? gallery.translationIds : [];
    for (const raw of links) {
      const key = numericId(raw);
      if (key) keys.push(key);
    }
    return keys;
  }

  // 札のタグ/シリーズ/キャラは本番では {type,name} の配列、
  // テストデータや別ソースでは 'female:xxx' のような文字列で来る。両方受ける
  function labelOf(entry, withType) {
    if (entry == null) return '';
    if (typeof entry === 'string') return entry.trim().toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ');
    const name = String(entry.name || entry.label || '').trim().toLowerCase()
      .replace(/_/g, ' ')
      .replace(/\s+/g, ' ');
    if (!name) return '';
    const type = String(entry.type || '').trim().toLowerCase();
    return withType && type ? `${type}:${name}` : name;
  }

  function nameSet(list, withType) {
    const set = new Set();
    if (!Array.isArray(list)) return set;
    for (const entry of list) {
      const key = labelOf(entry, withType);
      if (key) set.add(key);
    }
    return set;
  }

  function intersectionSize(a, b) {
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    let hits = 0;
    for (const key of small) if (large.has(key)) hits += 1;
    return hits;
  }

  // タグ証拠: 包含率 |A∩B| / min(|A|,|B|)。小さい側が丸ごと入っているかを見るので、
  // タグ数の違う再掲 (中文版は少なめ) でも通る。ただし母数が細いと偶然が通るため下限あり
  function tagContainment(a, b) {
    const ta = nameSet(a && a.tags, true);
    const tb = nameSet(b && b.tags, true);
    const min = Math.min(ta.size, tb.size);
    if (!min) return { ratio: 0, min: 0, hits: 0 };
    const hits = intersectionSize(ta, tb);
    return { ratio: hits / min, min, hits };
  }

  function tagEvidence(a, b) {
    const { ratio, min } = tagContainment(a, b);
    return min >= TAG_MIN_SIZE && ratio > TAG_CONTAINMENT_FLOOR;
  }

  // シリーズ / キャラの無矛盾: 両方が名乗っていて、ひとつも重ならないなら別作。
  // 片方が空 (中文再掲はしばしばメタが空) なら矛盾なしとみなす。
  // 「艦これ」と「original」のような食い違いをここで落とす
  function attributeCompatible(a, b, field) {
    const sa = nameSet(a && a[field], false);
    const sb = nameSet(b && b[field], false);
    if (!sa.size || !sb.size) return true;
    return intersectionSize(sa, sb) > 0;
  }

  // R5 の証拠条件 (対で判定できるぶん)。曖昧検査だけは候補全体を見ないと決まらない
  function bridgeEvidence(roman, cjk) {
    if (titleDigits(stripLeadingCredits(roman.title)) !== titleDigits(stripLeadingCredits(cjk.title))) return false;
    if (!pagesNearlyEqual(roman.pageCount, cjk.pageCount)) return false;
    if (!attributeCompatible(roman, cjk, 'series')) return false;
    if (!attributeCompatible(roman, cjk, 'characters')) return false;
    return tagEvidence(roman, cjk);
  }

  function groupKeyOf(gallery) {
    return gallery.dupeKey || censorNormalize(gallery.title);
  }

  // 候補の日本語題たちが「ひとつの作品群」に収まるか。鍵が等しいか、
  // 短い方 (6文字以上) が長い方に丸ごと入るなら同じ群。別作品が混ざる橋は架けない
  function keysConnected(keys) {
    if (keys.length < 2) return true;
    const parent = keys.map((_, i) => i);
    const find = (x) => {
      let node = x;
      while (parent[node] !== node) {
        parent[node] = parent[parent[node]];
        node = parent[node];
      }
      return node;
    };
    for (let a = 0; a < keys.length; a += 1) {
      for (let b = a + 1; b < keys.length; b += 1) {
        const ka = keys[a];
        const kb = keys[b];
        let linked = ka === kb;
        if (!linked) {
          const [shorter, longer] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
          linked = shorter.length >= GROUP_KEY_MIN && longer.includes(shorter);
        }
        if (linked) {
          const ra = find(a);
          const rb = find(b);
          if (ra !== rb) parent[rb] = ra;
        }
      }
    }
    const root = find(0);
    return keys.every((_, i) => find(i) === root);
  }

  function eligible(gallery) {
    return Boolean(gallery) && !gallery.error
      && (gallery.source || 'hitomi') === 'hitomi'
      && gallery.kind !== 'creator';
  }

  function artistOfSafe(artistOf, gallery) {
    if (typeof artistOf !== 'function') return '';
    return artistOf(gallery) || '';
  }

  const preparedValueCache = new WeakMap();

  // mark 中で何度も使う派生値。札ごとに一度だけ計算し、比較時の正規化と
  // Set 構築を避ける。配列の順序や Union の順序は変えない。
  function prepare(gallery, index, artistOf) {
    const ok = eligible(gallery);
    if (!ok) return { index, eligible: false };
    let cached = preparedValueCache.get(gallery);
    if (!cached) {
      const title = gallery.title;
      const strippedTitle = stripLeadingCredits(title);
      cached = {
        familyKeys: familyKeys(gallery),
        original: isOriginalEdition(gallery),
        norm: censorNormalize(title),
        strippedNorm: censorNormalize(strippedTitle),
        digits: titleDigits(strippedTitle),
        cjk: hasCjkTitle(title),
        tags: nameSet(gallery.tags, true),
        series: nameSet(gallery.series, false),
        characters: nameSet(gallery.characters, false),
        groupKey: groupKeyOf(gallery),
      };
      preparedValueCache.set(gallery, cached);
    }
    return {
      ...cached,
      index,
      eligible: true,
      artist: artistOfSafe(artistOf, gallery),
    };
  }

  function prepareBridgeSets(prepared, gallery) {
    if (prepared.tags) return;
    prepared.tags = nameSet(gallery.tags, true);
    prepared.series = nameSet(gallery.series, false);
    prepared.characters = nameSet(gallery.characters, false);
  }

  function preparedAttributeCompatible(a, b, field) {
    const sa = a[field];
    const sb = b[field];
    return !sa.size || !sb.size || intersectionSize(sa, sb) > 0;
  }

  function preparedBridgeEvidence(roman, cjk, romanGallery, cjkGallery) {
    if (roman.digits !== cjk.digits) return false;
    if (!pagesNearlyEqual(romanGallery.pageCount, cjkGallery.pageCount)) return false;
    prepareBridgeSets(roman, romanGallery);
    prepareBridgeSets(cjk, cjkGallery);
    if (!preparedAttributeCompatible(roman, cjk, 'series')) return false;
    if (!preparedAttributeCompatible(roman, cjk, 'characters')) return false;
    const min = Math.min(roman.tags.size, cjk.tags.size);
    return min >= TAG_MIN_SIZE
      && intersectionSize(roman.tags, cjk.tags) / min > TAG_CONTAINMENT_FLOOR;
  }

  function mark(items, artistOf) {
    const list = Array.isArray(items) ? items : [];
    const prepared = list.map((gallery, index) => prepare(gallery, index, artistOf));
    const parent = list.map((_, index) => index);
    const find = (x) => {
      let node = x;
      while (parent[node] !== node) {
        parent[node] = parent[parent[node]];
        node = parent[node];
      }
      return node;
    };
    const union = (a, b) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    };

    // R1) 家族: 共通の ID を持つ札同士を繋ぐ。伏字版と英語版が互いを知らなくても、
    // 両方が同じ無修正版を指していれば束になる (本体が検索結果に居なくてもよい)
    const family = new Map();
    list.forEach((g, i) => {
      if (!prepared[i].eligible) return;
      for (const key of prepared[i].familyKeys) {
        if (!family.has(key)) family.set(key, []);
        family.get(key).push(i);
      }
    });
    for (const members of family.values()) {
      for (let n = 1; n < members.length; n += 1) union(members[0], members[n]);
    }

    // 家族に原版 (CJK 題、または hitomi が日本語と言う札) が居るローマ字題は
    // R5 の対象外にする: 正しい相手を hitomi 自身が教えてくれているのだから、
    // 推測を足さない。作品の原版は一つなので、推測で見つけた別の CJK 題は
    // 定義上べつの作品になる (倉敷玲奈の家族が妊婦性交指導を掴んだ実例がある)
    const familyOriginals = new Map();
    for (const [key, members] of family) {
      const originals = new Set();
      for (const i of members) if (prepared[i].original) originals.add(i);
      familyOriginals.set(key, originals);
    }
    const familyHasOriginal = new Array(list.length).fill(false);
    list.forEach((g, i) => {
      if (!prepared[i].eligible) return;
      for (const key of prepared[i].familyKeys) {
        const originals = familyOriginals.get(key);
        if (originals && (originals.size > 1 || (originals.size === 1 && !originals.has(i)))) {
          familyHasOriginal[i] = true;
          break;
        }
      }
    });

    // R2〜R5 は同じ作家の札の中だけで見る (題だけの曖昧さに裏付けを足す)
    const buckets = new Map();
    list.forEach((g, i) => {
      if (!prepared[i].eligible) return;
      const artist = prepared[i].artist;
      if (!buckets.has(artist)) buckets.set(artist, []);
      buckets.get(artist).push(i);
    });

    for (const [artist, indexes] of buckets) {
      // R2) 同じ鍵 (annotate の dupeKey) — 従来どおりの再掲
      const keyMap = new Map();
      for (const i of indexes) {
        const key = list[i].dupeKey;
        if (!key) continue;
        const prev = keyMap.get(key);
        if (prev !== undefined) union(prev, i);
        else keyMap.set(key, i);
      }
      // ここから先の曖昧マッチは作家名のある札に限る
      if (!artist) continue;

      // R4) クレジット飾りを剥がした題での一致
      const strippedMap = new Map();
      for (const i of indexes) {
        const stripped = prepared[i].strippedNorm;
        if (!stripped) continue;
        const prev = strippedMap.get(stripped);
        if (prev !== undefined) union(prev, i);
        else strippedMap.set(stripped, i);
      }

      // R3) 伏字だけ違う題。伏字記号を含む題が居るときだけ総当たりする
      const norms = indexes.map((i) => prepared[i].norm);
      const indexesByNormLength = new Map();
      for (let b = 0; b < indexes.length; b += 1) {
        const length = norms[b].length;
        if (!indexesByNormLength.has(length)) indexesByNormLength.set(length, []);
        indexesByNormLength.get(length).push(b);
      }
      for (let a = 0; a < indexes.length; a += 1) {
        if (!CENSOR_CHAR.test(norms[a])) continue;
        for (const b of indexesByNormLength.get(norms[a].length) || []) {
          if (a === b) continue;
          if (censoredTitleMatch(norms[a], norms[b])) union(indexes[a], indexes[b]);
        }
      }

      // R5) 文字種の橋渡し。証拠 (数字・頁数・シリーズ・キャラ・タグの重なり) を
      // すべて満たす CJK 題だけを候補にし、その候補が複数の作品群に散るなら見送る
      const cjkByDigits = new Map();
      for (const jIndex of indexes) {
        if (!prepared[jIndex].cjk) continue;
        const digits = prepared[jIndex].digits;
        if (!cjkByDigits.has(digits)) cjkByDigits.set(digits, []);
        cjkByDigits.get(digits).push(jIndex);
      }
      for (const rIndex of indexes) {
        const roman = list[rIndex];
        if (prepared[rIndex].cjk) continue;
        if (familyHasOriginal[rIndex]) continue;
        const candidates = [];
        for (const jIndex of cjkByDigits.get(prepared[rIndex].digits) || []) {
          if (jIndex === rIndex) continue;
          if (!preparedBridgeEvidence(prepared[rIndex], prepared[jIndex], roman, list[jIndex])) continue;
          candidates.push(jIndex);
        }
        if (!candidates.length) continue;
        if (!keysConnected(candidates.map((i) => prepared[i].groupKey))) continue;
        for (const jIndex of candidates) union(rIndex, jIndex);
      }
    }

    // 連結成分ごとに代表を選び、残りを伏せる
    const groups = new Map();
    list.forEach((g, i) => {
      if (!eligible(g)) return;
      const root = find(i);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(i);
    });
    const changed = [];
    const setHidden = (gallery, hidden) => {
      if (Boolean(gallery.dupeHidden) !== hidden) {
        gallery.dupeHidden = hidden;
        changed.push(gallery);
      }
    };
    list.forEach((g) => {
      if (g && !eligible(g)) {
        if (g.dupeHidden) setHidden(g, false);
        if (g.dupeClusterId) g.dupeClusterId = null;
      }
    });
    for (const [root, members] of groups) {
      const clusterId = members.length > 1 ? `c${root}` : null;
      let rep = members.find((i) => list[i].owned);
      if (rep === undefined) rep = members[0];
      for (const i of members) {
        list[i].dupeClusterId = clusterId;
        setHidden(list[i], i !== rep);
      }
    }
    return { changed };
  }

  // 一覧の外から開いた作品にも変種を出すための対判定。
  // R5 の曖昧検査 (候補全体を見る) と家族の CJK 検査は対では効かせられないが、
  // 証拠条件そのものは同じだけ課す
  function sameWork(a, b, artistOf) {
    if (!a || !b || a.error || b.error) return false;
    if (String(a.id) === String(b.id)) return false;
    // R1) 家族が交われば同作 (作家不問)
    const fa = new Set(familyKeys(a));
    for (const key of familyKeys(b)) if (fa.has(key)) return true;

    const artist = artistOfSafe(artistOf, a);
    if (artist !== artistOfSafe(artistOf, b)) return false;
    // R2) 同じ鍵
    if (a.dupeKey && a.dupeKey === b.dupeKey) return true;
    if (!artist) return false;
    // R4) 飾りを剥がした題の一致
    const strippedA = censorNormalize(stripLeadingCredits(a.title));
    if (strippedA && strippedA === censorNormalize(stripLeadingCredits(b.title))) return true;
    // R3) 伏字だけ違う題
    if (censoredTitleMatch(censorNormalize(a.title), censorNormalize(b.title))) return true;
    // R5) 文字種の橋渡し
    const aCjk = hasCjkTitle(a.title);
    if (aCjk === hasCjkTitle(b.title)) return false;
    return bridgeEvidence(aCjk ? b : a, aCjk ? a : b);
  }

  return {
    mark,
    sameWork,
    // 以下は検証・診断のための口 (app.js は使わない)
    eligible,
    censorNormalize,
    stripLeadingCredits,
    censoredTitleMatch,
    titleDigits,
    pagesNearlyEqual,
    hasCjkTitle,
    languageName,
    isOriginalEdition,
    familyKeys,
    tagContainment,
    attributeCompatible,
    bridgeEvidence,
    tagEvidence,
    groupKeyOf,
    keysConnected,
    thresholds: { TAG_CONTAINMENT_FLOOR, TAG_MIN_SIZE, GROUP_KEY_MIN },
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = DupeCluster;
if (typeof window !== 'undefined') window.DupeCluster = DupeCluster;
