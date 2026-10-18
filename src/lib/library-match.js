const { hitomi, serializeGallery } = require('./hitomi-service');
// 題の鍵だけが要る。catalog を引くと 3,200 行と electron まで付いてくる (項目 10-1)
const { titleKey, titleKeyWeight, volumeSafeContains } = require('./title-keys');

// 421 件の未照合を人手で総ざらいした結果 (2026-08-28)、none 判定の 7 割前後が
// 実在した。敗因は二つ: (1) 長い日本語題での検索が 0 件になる、(2) 短い・汎用的な
// 題は同名の別作品を恐れて自動採用できない。対策もこの二本立て:
// searchPlans の拡充 (特徴語の切り出し・先頭切り詰め) と、作者集合との積による
// 検証付き採用 (creatorIntersect)。

const ITEM_DELAY = 500;
const CANDIDATE_DELAY = 250;
const MAX_CANDIDATES = 10;
// 先頭 10 件で確定できず続刊疑いが並んだときだけ、ここまで範囲を広げる
const MAX_CANDIDATES_EXTENDED = 30;
const NOTIFY_EVERY = 5;
const NOTIFY_INTERVAL = 3000;
const MAX_CONSECUTIVE_ERRORS = 10;

// 照合ルールの版。cleanName / classify / 検索の試行列を変えたら上げる。
// 版が上がると none/ambiguous の冷却が一度だけ解かれ、新ルールで再挑戦する
const TITLE_MATCH_RULES_VERSION = 3;

// 作者集合との積で見るギャラリーの上限。積がこれより多いのは題の語が緩すぎる
// 証拠なので、絞れていないまま舐めない
const MAX_INTERSECT_RETRIEVE = 8;

// pixiv からの取り込みは [日付] + 連番の機械名。hitomi に同じ題は無いので引かない
const SERIAL_NAME = /^\[20\d{6}\]/;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Eagle 側だけに付く装飾を剥がす: 「_他n件_結合」(結合取り込み) と「-1of6」
// (分割取り込み) は作品の同一性を変えない目印なので、鍵を作る前に落とす。
// 「#n」は剥がさない: hitomi の実タイトルに「〜 #1」が付く実例があり、
// 剥がすと exact が壊れる。「第n話」等の巻数も別巻なので剥がさない
function stripEagleDecorations(text) {
  let t = String(text || '');
  t = t.replace(/[_\s]*他\d+件[_\s]*結合[_\s]*$/u, '');
  t = t.replace(/[\s\-_~〜]*[0-9]+\s*of\s*[0-9]+\s*$/iu, '');
  return t.trim();
}

// 先頭/末尾の [] () グループ(作者名・種別など)と Eagle 装飾を剥がす。
// nfkc:false は検索語用の生の姿 (下の searchPlans を参照)
function strippedName(name, { nfkc = true } = {}) {
  let text = String(name || '');
  if (nfkc) text = text.normalize('NFKC');
  text = text.trim();
  text = text.replace(/^(?:[[(（【][^\][)（）【】]*[\])）】]\s*)+/, '');
  text = text.replace(/(?:\s*[[(（【][^\][)（）【】]*[\])）】])+$/, '');
  return stripEagleDecorations(text);
}

// 名前から検索語を作る: 先頭/末尾の [] () グループ(作者名・種別など)を剥がす
function cleanName(name) {
  return strippedName(name);
}

// hitomi のタイトル索引は語単位。長い語ほど絞れるので、重い順に最大 2 語で引く
function searchTerms(cleaned) {
  const words = String(cleaned || '').split(/\s+/).filter((word) => word.length >= 2);
  if (!words.length) return null;
  words.sort((a, b) => titleKeyWeight(titleKey(b)) - titleKeyWeight(titleKey(a)));
  return words.slice(0, 2).join(' ');
}

// 題を 〜「」【】等の飾り記号でも切って、特徴的な区画を語にする。
// 「悪徳レズクリニック〜おまんこおあずけ精密検査〜」は空白が無いため全体が
// 1 語となり検索 0 件になるが、区画に割れば当たる (実例)
function segmentTerms(title) {
  const cleaned = String(cleanName(title))
    .replace(/[〜～~「」『』【】()（）_・:：、。｜|!！?？]/g, ' ');
  return searchTerms(cleaned);
}

// 長すぎる語は索引と噛み合わず 0 件になる。先頭 8 文字に切り詰めた語も試す
// (人手の総ざらいで none の大半がこれで救えた)
function truncatedTerm(title) {
  const terms = segmentTerms(title);
  if (!terms) return null;
  const head = terms.split(' ')[0];
  if (head.length <= 8) return null;
  // 切り口に数字が残ると索引と噛み合いにくい (「冬優子ちゃんと1」)。数字の手前で切る
  const cut = head.slice(0, 8).replace(/[0-9０-９]+$/, '');
  return cut.length >= 3 ? cut : null;
}

// 検索の試行列: まず現行どおり NFKC 済みの語 (clean)、外れたら NFKC を掛けない
// 生の語 (raw)、飾り記号で切った特徴語、先頭切り詰め語の順に引き直す。
// hitomi の題名索引は生の文字列を語単位で刻んだもので、⑥ や 全角４ を NFKC で
// 半角に寄せると索引と噛み合わず 0 件になる実例がある
function searchPlans(title) {
  const plans = [];
  const push = (terms) => {
    if (terms && !plans.includes(terms)) plans.push(terms);
  };
  push(searchTerms(cleanName(title)));
  push(searchTerms(strippedName(title, { nfkc: false })));
  push(segmentTerms(title));
  push(truncatedTerm(title));
  // の↔ノ は索引上は別の字。「贖罪の間」が hitomi では「贖罪ノ間」の実例があり、
  // 入れ替えた語でも引かないと検索自体が 0 件になって積の材料も残らない
  for (const base of plans.slice(0, 3)) {
    if (/の/.test(base)) push(base.replace(/の/g, 'ノ'));
    else if (/ノ/.test(base)) push(base.replace(/ノ/g, 'の'));
  }
  return plans.slice(0, 5);
}

// 'exact' と 'contains' だけが採用の候補。'near' は続刊の疑いがある取りこぼし。
// はみ出し検査 (volumeSafeContains) はアラビア数字に加えローマ数字・和物の
// 巻数マーカーも見る: 「〜♥」は同じ本、「〜2」「〜iii」「〜下巻」は続刊
function classify(itemTitle, galleryTitle) {
  // アイテム側だけ Eagle 装飾 (結合・分割の目印) を剥がして鍵を作る。
  // gallery 側と volumeSafeContains は現行のまま (別巻の誤マッチ防止を維持)
  const itemKey = titleKey(stripEagleDecorations(String(itemTitle || '').normalize('NFKC')));
  const galleryKey = titleKey(galleryTitle);
  if (!itemKey || !galleryKey) return null;
  if (itemKey === galleryKey) return 'exact';
  if (titleKeyWeight(galleryKey) >= 8 && itemKey.includes(galleryKey)) {
    return volumeSafeContains(itemKey, galleryKey) ? 'contains' : 'near';
  }
  if (titleKeyWeight(itemKey) >= 8 && galleryKey.includes(itemKey)) {
    return volumeSafeContains(galleryKey, itemKey) ? 'contains' : 'near';
  }
  return null;
}

// 作者検証付きパス用のゆるい鍵: の↔ノ と版マーカー (総集編/新装版など) の
// 違いを吸収する。作者集合との積の中でだけ使う — 世界中の同名別作品と競う
// 通常パスでこの緩さを許すと誤マッチの土になる
const EDITION_MARKERS_RE = /総集編|新装版|完全版|dl版|フルカラー版|単行本版/g;

function verifiedKey(text) {
  return titleKey(String(text || '').replace(/ノ/g, 'の'))
    .replace(EDITION_MARKERS_RE, '');
}

// 作者集合の中での分類。作者一致が保証されているぶん、通常の classify より緩い:
// 短い題 (「本能」「落魄」) の exact も、版マーカー違いも採用してよい
function classifyVerified(itemTitle, galleryTitle) {
  const itemKey = verifiedKey(stripEagleDecorations(String(itemTitle || '').normalize('NFKC')));
  const galleryKey = verifiedKey(galleryTitle);
  if (!itemKey || !galleryKey) return null;
  if (itemKey === galleryKey) return 'exact';
  if (titleKeyWeight(galleryKey) >= 5 && itemKey.includes(galleryKey)) {
    return volumeSafeContains(itemKey, galleryKey) ? 'contains' : null;
  }
  if (titleKeyWeight(itemKey) >= 5 && galleryKey.includes(itemKey)) {
    return volumeSafeContains(galleryKey, itemKey) ? 'contains' : null;
  }
  return null;
}

// 同題が並んだときは日本語版を、それでも並ぶなら新しい方を採る
function pick(hits) {
  const japanese = hits.filter((hit) => hit.language === 'japanese');
  const pool = japanese.length ? japanese : hits;
  return pool.reduce((best, hit) => (Number(hit.id) > Number(best.id) ? hit : best), pool[0]);
}

function decide(hits) {
  const exact = hits.filter((hit) => hit.quality === 'exact');
  const chosen = (() => {
    if (exact.length) return pick(exact);
    if (!hits.length) return null;
    if (hits.length === 1) return hits[0];
    const key = titleKey(hits[0].title);
    if (hits.every((hit) => titleKey(hit.title) === key)) return pick(hits);
    return null;
  })();
  // 「Ci-en」のような短い汎用題は同名の別作品を掴みうる。自動採用しない
  if (chosen && titleKeyWeight(titleKey(chosen.title)) < 5) return null;
  return chosen;
}

class LibraryMatch {
  constructor({ catalog, onProgress, delay, priorityOptions } = {}) {
    this.catalog = catalog;
    this.onProgress = onProgress || null;
    this.priorityOptions = typeof priorityOptions === 'function' ? priorityOptions : null;
    this.delay = Number.isFinite(delay) ? Number(delay) : ITEM_DELAY;
    this.running = false;
    this.stopping = false;
    this.done = 0;
    this.matched = 0;
    this.ambiguous = 0;
    this.skipped = 0;
    this.failed = 0;
    this.total = 0;
    this.queue = [];
    this.cursor = 0;
    this.errors = 0;
    this.nextAt = 0;
    this.lastNotify = 0;
    this.sinceNotify = 0;
    this.job = null;
    this.japaneseIds = null;
  }

  status() {
    const handled = this.done + this.failed;
    return {
      running: this.running,
      done: this.done,
      matched: this.matched,
      ambiguous: this.ambiguous,
      skipped: this.skipped,
      failed: this.failed,
      remaining: Math.max(0, this.total - handled),
      total: this.total,
    };
  }

  notify(force = false) {
    if (!this.onProgress) return;
    this.sinceNotify += 1;
    const now = Date.now();
    if (!force && this.sinceNotify < NOTIFY_EVERY && now - this.lastNotify < NOTIFY_INTERVAL) return;
    this.sinceNotify = 0;
    this.lastNotify = now;
    try {
      this.onProgress(this.status());
    } catch {
      // ignore listener errors
    }
  }

  async gate() {
    const now = Date.now();
    const wait = Math.max(0, this.nextAt - now);
    this.nextAt = Math.max(now, this.nextAt) + this.delay;
    if (wait > 0) await sleep(wait);
  }

  start() {
    if (this.running) return this.job || Promise.resolve(this.status());
    this.job = this.run().catch(() => this.status());
    return this.job;
  }

  stop() {
    this.stopping = true;
    return this.job || Promise.resolve(this.status());
  }

  async run() {
    if (!this.catalog || typeof this.catalog.pendingTitleMatchTargets !== 'function') {
      return this.status();
    }
    if (typeof this.catalog.expireTitleMatchCooldowns === 'function') {
      try {
        this.catalog.expireTitleMatchCooldowns(TITLE_MATCH_RULES_VERSION);
      } catch {
        // 冷却が解けなくても照合そのものは続ける
      }
    }
    this.queue = this.catalog.pendingTitleMatchTargets(
      this.priorityOptions ? this.priorityOptions() : {},
    );
    this.cursor = 0;
    this.done = 0;
    this.matched = 0;
    this.ambiguous = 0;
    this.skipped = 0;
    this.failed = 0;
    this.errors = 0;
    this.total = this.queue.length;
    this.stopping = false;
    this.nextAt = 0;
    this.sinceNotify = 0;
    this.lastNotify = 0;
    if (!this.total) return this.status();

    this.running = true;
    this.notify(true);
    // 日本語ギャラリーの ID 集合を実行のあいだだけ持つ。翻訳版が索引の先頭に
    // 並んで日本語の原典が候補窓 (30件) に入らない取りこぼしを防ぐための地図。
    // 取れなければ従来どおり索引順のみで走査する (照合の可否には影響しない)
    this.japaneseIds = null;
    try {
      const refs = await hitomi.galleries.list({ tags: hitomi.tags.parse('language:japanese') });
      if (Array.isArray(refs) && refs.length) {
        this.japaneseIds = new Set(refs.map((ref) => Number(ref.id)));
      }
    } catch {
      // 圏外や索引の不調。絞り込みなしで続行
    }
    try {
      while (!this.stopping && this.cursor < this.queue.length) {
        const target = this.queue[this.cursor];
        this.cursor += 1;
        await this.gate();
        if (this.stopping) break;
        const ok = await this.handle(target);
        if (ok) {
          this.errors = 0;
        } else {
          this.failed += 1;
          this.errors += 1;
          // 立て続けに落ちるのは圏外のとき。台帳を汚さずに畳んで、次回やり直す
          if (this.errors >= MAX_CONSECUTIVE_ERRORS) break;
        }
        this.notify();
      }
    } finally {
      this.running = false;
      this.job = null;
      this.japaneseIds = null; // 55万件規模の集合なので実行の外へ持ち越さない
      if (this.catalog.learnCreatorLabels) {
        try {
          this.catalog.learnCreatorLabels();
        } catch {
          // ignore
        }
      }
      if (this.catalog.flushPersist) {
        try {
          this.catalog.flushPersist();
        } catch {
          // ignore
        }
      }
      this.notify(true);
    }
    return this.status();
  }

  record(target, galleryId, matchedTitle, status) {
    try {
      this.catalog.addTitleMatch(target.eagleId, galleryId, target.title, matchedTitle, status);
    } catch {
      // 台帳が書けなくても走査そのものは続ける
    }
  }

  // 戻り値は「台帳に結論を書けたか」。false は通信の失敗で、記録せずに次へ送る
  async handle(target) {
    const title = String(target.title || '');
    if (!target.eagleId) return true;
    if (SERIAL_NAME.test(title)) {
      this.record(target, null, '', 'skipped');
      this.skipped += 1;
      this.done += 1;
      return true;
    }
    const plans = searchPlans(title);
    if (!plans.length) {
      this.record(target, null, '', 'none');
      this.done += 1;
      return true;
    }

    // 同じギャラリーを試行列やパスをまたいで引き直さないための控え
    const retrieved = new Map(); // id -> gallery | null (消えたギャラリー)
    // 作者検証付きパス用に、各試行の検索結果 (ID のみ) を取っておく
    const seenRefIds = new Set();
    let ambiguousSample = null;

    for (const terms of plans) {
      // 2 本目以降の検索も 1 件分の間隔 (gate) を空けてから引く
      if (terms !== plans[0]) await this.gate();
      let refs = [];
      try {
        // page と併用するとタイトル条件が無視される。ページ指定なしで引いて切る
        refs = await hitomi.galleries.list({ title: terms });
      } catch {
        return false;
      }
      const pool = refs || [];
      for (const ref of pool) seenRefIds.add(Number(ref.id));
      // 日本語ギャラリーを先に見る: 翻訳版が索引の先頭に並び、日本語の原典が
      // 候補窓に入らない取りこぼしが実際にあった。日本語側で確定しなければ、
      // 従来どおり索引順の先頭も走査する (非日本語との紐付けを失わないため)
      const jp = this.japaneseIds
        ? pool.filter((ref) => this.japaneseIds.has(Number(ref.id)))
        : [];
      const passes = jp.length && jp.length < pool.length ? [jp, pool] : [pool];

      for (const pass of passes) {
        const hits = [];
        const near = [];
        const scanRefs = async (list) => {
          for (const ref of list) {
            if (this.stopping) return;
            const key = Number(ref.id);
            let gallery;
            if (retrieved.has(key)) {
              gallery = retrieved.get(key);
            } else {
              try {
                gallery = serializeGallery(await hitomi.galleries.retrieve(ref.id));
              } catch {
                gallery = null; // 消えたギャラリー: 候補から外すだけ
              }
              retrieved.set(key, gallery);
              await sleep(CANDIDATE_DELAY);
            }
            if (!gallery) continue;
            const quality = classify(title, gallery.title);
            if (quality === 'near') {
              near.push(gallery);
            } else if (quality) {
              hits.push({
                id: Number(gallery.id),
                title: String(gallery.title || ''),
                language: gallery.language ? gallery.language.name : null,
                quality,
                gallery,
              });
            }
          }
        };
        await scanRefs(pass.slice(0, MAX_CANDIDATES));
        // 「〜 2」のような続刊は、無印や別編が索引の前に並んで正しい巻が 10 件に
        // 入らないことがある。曖昧のまま台帳に書く前に、範囲を広げて確定を探す
        if (!this.stopping && !decide(hits) && (hits.length || near.length)) {
          await scanRefs(pass.slice(MAX_CANDIDATES, MAX_CANDIDATES_EXTENDED));
        }
        if (this.stopping) return true;

        const chosen = decide(hits);
        if (chosen) {
          try {
            this.catalog.storeGalleryMeta(chosen.gallery);
          } catch {
            // メタが書けなくても紐付けは残す
          }
          this.record(target, chosen.id, chosen.title, 'matched');
          this.matched += 1;
          this.done += 1;
          return true;
        }
        if (!ambiguousSample && (hits.length || near.length)) {
          ambiguousSample = hits.length ? hits[0].title : String(near[0].title || '');
        }
      }
    }

    // 題名だけで決められなかった: Eagle タグの作者名を台帳の名義索引で引き、
    // その作者の作品集合と題名検索の積で検証付きの採用を試す
    const verified = await this.creatorIntersect(target, seenRefIds, retrieved);
    if (verified) {
      try {
        this.catalog.storeGalleryMeta(verified.gallery);
      } catch {
        // メタが書けなくても紐付けは残す
      }
      this.record(target, Number(verified.gallery.id), String(verified.gallery.title || ''), 'matched');
      this.matched += 1;
      this.done += 1;
      return true;
    }

    if (ambiguousSample) {
      this.record(target, null, ambiguousSample, 'ambiguous');
      this.ambiguous += 1;
    } else {
      this.record(target, null, '', 'none');
    }
    this.done += 1;
    return true;
  }

  // 作者集合 × 題名検索の積。Eagle タグに作者名 (日本語) が付いている
  // アイテムだけが対象。積の中でだけ緩い鍵 (classifyVerified) を許す
  async creatorIntersect(target, seenRefIds, retrieved) {
    if (!seenRefIds.size) return null;
    if (!this.catalog || typeof this.catalog.creatorLookup !== 'function') return null;
    const tags = Array.isArray(target.tags) ? target.tags : [];
    if (!tags.length) return null;

    // Eagle タグから引けた名義 (artist/group)。多すぎる照会を避けて 2 名義まで
    const creators = [];
    const seenCreator = new Set();
    for (const tag of tags) {
      let hits = [];
      try {
        hits = this.catalog.creatorLookup(tag) || [];
      } catch {
        hits = [];
      }
      for (const hit of hits) {
        const key = `${hit.type}:${hit.name}`;
        if (!hit.name || seenCreator.has(key)) continue;
        if (hit.type !== 'artist' && hit.type !== 'group') continue;
        seenCreator.add(key);
        creators.push(hit);
      }
      if (creators.length >= 2) break;
    }
    if (!creators.length) return null;

    const hits = [];
    for (const creator of creators.slice(0, 2)) {
      await this.gate();
      let refs = [];
      try {
        refs = await hitomi.galleries.list({
          tags: hitomi.tags.parse(`${creator.type}:${creator.name.replace(/\s+/g, '_')}`),
        });
      } catch {
        continue; // 名義が hitomi に無い (404) 等: 次の名義へ
      }
      const inter = (refs || [])
        .map((ref) => Number(ref.id))
        .filter((id) => seenRefIds.has(id));
      // 積が大きいのは題の語が緩すぎる証拠。絞れていないまま舐めない
      if (!inter.length || inter.length > MAX_INTERSECT_RETRIEVE) continue;
      for (const id of inter) {
        if (this.stopping) return null;
        let gallery;
        if (retrieved.has(id)) {
          gallery = retrieved.get(id);
        } else {
          try {
            gallery = serializeGallery(await hitomi.galleries.retrieve(id));
          } catch {
            gallery = null;
          }
          retrieved.set(id, gallery);
          await sleep(CANDIDATE_DELAY);
        }
        if (!gallery) continue;
        const quality = classifyVerified(target.title, gallery.title);
        if (quality) {
          hits.push({
            id: Number(gallery.id),
            title: String(gallery.title || ''),
            language: gallery.language ? gallery.language.name : null,
            quality,
            gallery,
          });
        }
      }
    }
    if (!hits.length) return null;
    // exact を優先し、同題は日本語版・新しい方。ここでは短い題も許す
    // (作者一致が同名別作品の危険を消している)
    const exact = hits.filter((hit) => hit.quality === 'exact');
    const pool = exact.length ? exact : hits;
    const key = verifiedKey(pool[0].title);
    if (!pool.every((hit) => verifiedKey(hit.title) === key)) return null;
    return pick(pool);
  }
}

module.exports = {
  LibraryMatch,
  cleanName,
  searchTerms,
  searchPlans,
  segmentTerms,
  truncatedTerm,
  stripEagleDecorations,
  classify,
  classifyVerified,
  decide,
  TITLE_MATCH_RULES_VERSION,
};
