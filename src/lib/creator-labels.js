// 所持作品の作者・サークルのローマ字名義を、nhentai の日本語生タイトルの
// 括弧書き「(イベント) [サークル (作者)] 題名」から日本語表示に解決する。
// hitomi は名義をローマ字でしか持たないが、同じ作品が nhentai には原題のまま
// 載っていることが多い: 所持作品の題で検索し、題が厳密に一致した結果の
// 括弧書きだけを信じる。ラベルの反映先 (tag_labels) は学習機構と共用
// 題の鍵だけが要る (catalog を丸ごと引かない)
const { titleKey } = require('./title-keys');

// nhentai の検索はレート制限が厳しめ (実測で 1.6s 間隔でも十数回で 429)。
// 一度きりの埋め合わせなので大きく間を空け、429 を踏んだら長めに休んで
// 一度だけやり直し、それでも駄目なら走りを畳んで次回に持ち越す
const PACE_MS = 3500;
const RETRY_BACKOFF_MS = 45 * 1000;
const SEARCH_PAGE_SIZE = 24;
// 字クラスの原本は search-text.hasCjk
const { hasCjk } = require('./search-text');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 先頭の (イベント) [サークル (作者)] の並びと、末尾の [DL版] 等の注記を剥がして
// 題の本体だけにする。比較は titleKey の厳密一致 (包含は巻数を跨ぐので使わない)
function coreTitle(raw) {
  let text = String(raw || '').trim();
  let prev = null;
  while (prev !== text) {
    prev = text;
    text = text.replace(/^\s*(?:\([^)]*\)|\[[^\]]*\])\s*/, '');
  }
  text = text.replace(/(?:\s*(?:\([^)]*\)|\[[^\]]*\]))+\s*$/, '');
  return text.trim();
}

// 先頭の [サークル (作者)] を取り出す。イベント名 (C97) 等は読み飛ばす
function leadingCreatorBracket(raw) {
  const text = String(raw || '').trim().replace(/^\s*(?:\([^)]*\)\s*)+/, '');
  const match = text.match(/^\[([^\]]+)\]/);
  if (!match) return null;
  const inner = match[1].trim();
  if (!inner) return null;
  const paren = inner.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (paren) {
    return { group: paren[1].trim() || null, artist: paren[2].trim() || null, solo: null };
  }
  return { group: null, artist: null, solo: inner };
}

class CreatorLabelJob {
  constructor({ catalog, search, pace } = {}) {
    this.catalog = catalog;
    this.search = search; // sources/nhentai の search
    this.pace = Number.isFinite(pace) ? Number(pace) : PACE_MS;
    this.running = false;
    this.stopping = false;
    this.done = 0;
    this.found = 0;
    this.total = 0;
    this.job = null;
  }

  status() {
    return { running: this.running, done: this.done, found: this.found, total: this.total };
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
    if (!this.catalog || typeof this.search !== 'function') return this.status();
    const targets = this.catalog.pendingCreatorLabelTargets();
    this.done = 0;
    this.found = 0;
    this.total = targets.length;
    this.stopping = false;
    if (!targets.length) return this.status();

    this.running = true;
    try {
      for (const target of targets) {
        if (this.stopping) break;
        let label = null;
        let aborted = false;
        for (const candidate of target.candidates.slice(0, 2)) {
          await sleep(this.pace);
          if (this.stopping) break;
          try {
            label = await this.lookup(target, candidate);
          } catch {
            // レート制限か圏外。長めに休んで一度だけやり直す
            await sleep(RETRY_BACKOFF_MS);
            if (this.stopping) break;
            try {
              label = await this.lookup(target, candidate);
            } catch {
              // それでも駄目: この名義には試行を記録せず走りを畳む。
              // 次回の起動やスキャン後にそのままやり直せる
              aborted = true;
              break;
            }
          }
          if (label) break;
        }
        if (aborted) break;
        if (this.stopping) break;
        if (label) {
          this.catalog.storeCreatorLabel(target.type, target.name, label);
          this.found += 1;
        }
        this.catalog.recordCreatorLabelLookup(target.type, target.name, Boolean(label));
        this.done += 1;
      }
    } finally {
      this.running = false;
      this.job = null;
      try {
        this.catalog.flushPersist();
      } catch {
        // 書き出しは persistSoon が拾う
      }
    }
    return this.status();
  }

  // 1 作品ぶんの照会。題が厳密一致した結果の括弧書きを集計し、
  // 全会一致のときだけラベルとして返す (別人の同題作品を拾わないため)
  async lookup(target, candidate) {
    const wanted = titleKey(candidate.title);
    if (!wanted) return null;
    const result = await this.search({ query: candidate.title, pageSize: SEARCH_PAGE_SIZE });
    const votes = new Map();
    for (const hit of (result && result.galleries) || []) {
      if (!hit || hit.error) continue;
      if (titleKey(coreTitle(hit.title)) !== wanted) continue;
      // ページ数が分かっていて大きく違うものは別版とみなして数えない
      const pages = Number(hit.pageCount) || 0;
      if (pages && candidate.pageCount
        && Math.abs(pages - candidate.pageCount) / Math.max(pages, candidate.pageCount) > 0.25) {
        continue;
      }
      const bracket = leadingCreatorBracket(hit.title);
      if (!bracket) continue;
      // [名前] 単独の括弧はサークル名とも作者名とも取れる。hitomi 側に
      // 相方の名義がいない作品のときだけ、探している型の名前とみなす
      const solo = candidate.hasOther ? null : bracket.solo;
      const name = target.type === 'artist'
        ? (bracket.artist || solo)
        : (bracket.group || (bracket.artist ? null : solo));
      const text = String(name || '').trim();
      if (!text || !hasCjk(text)) continue;
      votes.set(text, (votes.get(text) || 0) + 1);
    }
    if (!votes.size) return null;
    const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
    // 候補が割れたら採用しない。表記ゆれで無駄に落とすよりも誤記を避ける
    if (ranked.length > 1) return null;
    return ranked[0][0];
  }
}

module.exports = { CreatorLabelJob, coreTitle, leadingCreatorBracket };
