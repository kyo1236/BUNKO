// Home の作者頁の束ね: 源泉 (所持・hitomi・Pawchive・pixiv) を跨いで同じ作品を一冊に畳み、
// 見本・告知・表紙の一枚を本体の下に畳む純粋な部品。
// 考え方は docs/light-logic-and-fun-features-2026-09-23.md §3 (役の判じ) と §4-3 (文字の鍵)、
// 画面での効き方は docs/home-tab-spec-2026-09-23.md の「表示の切り替えと束ね」。
// dupe-cluster.js と同じく DOM / state / els に触らない (試験から Node で require できる)。
//
// 一冊の形 (home.js の merged の返り): { id, origin, candidate, date, event, owned, gallery }
//   owned は所持の本の一覧から来た物 (作者根・pixiv の台帳・hitomi の台帳) の印
//
// 誤るなら見せる側に誤る (fail-open):
//   役   決め手の規則 (A1 [見本] / A2 [ページ欠落] / A3 続きは FANBOX / A4 宣言の頁数より少ない / A5 お品書き)
//        が当たればその役。当たらなければ点の規則 (B1〜B11) を足し、一番が二番より 2 点以上高ければその役。
//        点だけで決まった役は印 (見本? など) を付けるだけで、それを理由には畳まない
//   結び 題の鍵 (飾り・即売会の記号・見本や告知の語・頁数の印を剥がした題。『』「」の中身も鍵) と、
//        製品を語る投稿どうしの店の URL。短い鍵は日付が近い時だけ、決まり文句 (ラクガキ等) と
//        同じ源泉で三度以上使われた鍵は三日以内だけ結ぶ
//   畳み 束ごとに代表を一冊選ぶ (見本・告知と決まった物と欠け版は後ろ → 頁が揃っている → 所持 → 頁が多い →
//        本体らしい → 所持の本 → hitomi → Pawchive → pixiv)。代表に「覆われる」物だけを畳む:
//        頁数が近い (版違い・再掲) か、代表より頁が少ない (見本・告知・表紙の一枚)。
//        代表より頁の多い物は畳まない (所持が見本だけの時に、網の本体を隠さない)。
//        ただし決め手の規則で見本・告知と決まった物は、見本でない代表の下なら頁数に依らず畳む
//        (FANBOX の本体が PDF 一つの添付で 1 頁に数えられ、pixiv の見本の方が頁が多いことがある)。
//        所持の本は代表でなくても畳まない (Eagle に在る物は全て見せる。畳むのは網の札だけ)
const HomeBundle = (() => {
  'use strict';

  const DC = (typeof DupeCluster !== 'undefined' && DupeCluster)
    || (typeof module !== 'undefined' && module.exports && typeof require === 'function' ? require('./dupe-cluster') : null);

  const ROLE_LABELS = {
    main: '本体', sample: '見本', notice: '告知', variant: '差分', repost: '再掲', single: '一枚絵',
  };
  // 束の代表を選ぶ時の源泉の順 (所持の本は owned の印で先に立つ)
  const ORIGIN_RANK = { local: 0, hitomi: 1, pawchive: 2, discord: 3, pixiv: 4 };
  // 一つの束がこれより大きいのは結びが暴れた時: その束では何も畳まない
  const CLUSTER_MAX = 16;
  // 短い鍵 (漢字かなで 3 字まで・英数で 7 字まで) は日付がこの日数以内の時だけ結ぶ
  const SHORT_KEY_UNITS = 8;
  const SHORT_KEY_DAYS = 120;
  // 決まり文句の鍵と、同じ源泉で三度以上使われた鍵はこの日数以内だけ
  const GENERIC_DAYS = 3;
  const GENERIC_REPEAT = 3;
  // 揃った本とみなす頁の割合 (束の一番頁の多い物に対して)
  const COMPLETE_RATIO = 0.8;

  // ---- 文字の下ごしらえ ----------------------------------------------------

  function norm(value) {
    return String(value == null ? '' : value).normalize('NFKC').toLowerCase();
  }

  const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

  // 鍵の長さ。漢字かなは 2、英数は 1 と数える (漢字かなの 4 字 ≒ 英数の 8 字)
  function units(key) {
    let n = 0;
    for (const ch of key) n += WIDE.test(ch) ? 2 : 1;
    return n;
  }

  // 題から剥がす語。見本・告知の語、版の違いの注記、即売会の記号、頁数の印
  const MARKERS = [
    /(?<![a-z])c\d{2,3}(?![0-9])/g,
    /(?:コミックマーケット|コミケ|comiket|例大祭|コミティア|comitia)\s*\d*/g,
    /冬コミ|夏コミ/g,
    /\d{1,3}\s*(?:p|ページ|頁|枚)(?![a-z])/g,
    /表情差分|差分|文字なし|文字無し|おまけ/g,
    /サンプル|見本|sample|試し読み|新刊|既刊|告知|お知らせ|お品書き|頒布|委託|通販|予約|進捗|wip|ラフ/g,
    /再掲|再録|完成版|完全版|修正版|dl版|電子版|デジタル版|無修正|uncensored|decensored|高画質版?|先行公開|先行|公開|支援者様?限定|限定/g,
    /fanbox版?|pixiv版?/g,
  ];
  const QUOTED = /[『「“"]([^』」”"]{2,60})[』」”"]/g;
  // 題の末尾の括弧の巻数 ((2)・[上]・（後編）) は飾りではない: 剥がす前に括弧を外して題に残す
  // (残さないと「題」と「題 (2)」が同じ鍵になる)
  const VOLUME_NOTE = /[(（[【]\s*(\d{1,3}|前編|中編|後編|上|中|下|完結編?|総集編)\s*[)）\]】]/g;
  // これだけの題は誰の投稿にもある (三日以内だけ結ぶ)
  const GENERIC = /^(?:らくがき|ラクガキ|落書き?|まとめ|ログ|log|イラスト|illust(?:ration)?|漫画|マンガ|manga|支援|リクエスト|request|お礼|ありがとう|謹賀新年|あけましておめでとう(?:ございます)?|メリークリスマス|ハロウィン|バレンタイン|ホワイトデー|happynewyear|merrychristmas|halloween|練習|模写|無題|untitled|fanart|ファンアート|告知|お知らせ|進捗)$/;

  function squeeze(text) {
    let out = norm(text);
    for (const re of MARKERS) out = out.replace(re, ' ');
    return out.replace(/[^\p{L}\p{N}]+/gu, '');
  }

  // 題の鍵 (一冊に一つか二つ)。飾りを剥がした題そのものと、『』「」の中身
  function titleKeys(title) {
    const text = norm(title).replace(VOLUME_NOTE, ' $1 ');
    if (!text.trim()) return [];
    const keys = new Set();
    const stripped = DC && typeof DC.stripLeadingCredits === 'function' ? DC.stripLeadingCredits(text) : text;
    for (const candidate of [stripped, text]) {
      const key = squeeze(candidate);
      if (units(key) >= 4) {
        keys.add(key);
        break;
      }
    }
    let hit;
    QUOTED.lastIndex = 0;
    while ((hit = QUOTED.exec(text))) {
      const key = squeeze(hit[1]);
      if (units(key) >= 4) keys.add(key);
    }
    return [...keys];
  }

  // ---- 役 --------------------------------------------------------------------

  const SAMPLE_BRACKET = /[[【(（]\s*(?:見本|サンプル|sample)\s*[\]】)）]/;
  const INCOMPLETE_BRACKET = /[[【(（]\s*(?:ページ欠落|incomplete)\s*[\]】)）]/;
  // A3: 本体は FANBOX の側。FANBOX のプロフィールの URL だけ (毎回の説明の定型) では当てない
  const FANBOX_TEASER = /(?:続き|全編|全体|完全版|高画質版?|差分)(?:は|を)?\s*(?:pixiv\s*)?fanbox|fanbox\.cc\/@[\w-]+\/posts\/\d+|[\w-]+\.fanbox\.cc\/posts\/\d+/;
  const OSHINAGAKI = /お品書き/;
  const B_RULES = [
    { re: /新刊|サンプル|試し読み|sample/, add: { sample: 2, notice: 1 } },                                   // B1
    { re: /booth\.pm|dlsite|dmm\.co|fanza|melonbooks|toranoana|とらのあな|メロンブックス/, add: { sample: 1, notice: 2 } }, // B2
    { re: /通販|委託|予約|dl\s*開始|頒布|配信開始|発売/, add: { notice: 2 } },                               // B3
    { re: /進捗|wip|ラフ/, add: { notice: 2 } },                                                            // B4
    { re: /表情差分|差分|文字なし|文字無し/, add: { variant: 3 } },                                            // B5
    { re: /再掲|再録|初出/, add: { repost: 2 } },                                                            // B6
    { re: /ログまとめ|まとめ/, add: { main: 2 } },                                                           // B7
  ];
  // 店の URL (製品を語る投稿どうしを結ぶ鍵)
  const STORE_RES = [
    [/booth\.pm\/(?:[a-z-]+\/)?items\/(\d+)/g, 'booth'],
    [/dlsite\.com\/\S*?(rj\d{6,8})/g, 'dlsite'],
    [/melonbooks\.co\.jp\/detail\/detail\.php\?product_id=(\d+)/g, 'melon'],
    [/toranoana\.jp\/\S*?(\d{12})/g, 'tora'],
    [/(?:dmm\.co\.jp|fanza)\S*?cid=([a-z]_\d+)/g, 'fanza'],
  ];

  function pagesOf(book) {
    return Number(book && book.gallery && book.gallery.pageCount) || 0;
  }

  function titleOf(book) {
    return String((book && book.gallery && book.gallery.title) || (book && book.title) || '');
  }

  // 網の投稿の説明とタグ (pixiv は説明を持つ。hitomi のタグは中身の札なので役の手がかりにしない)
  function postText(book) {
    const gallery = (book && book.gallery) || {};
    if (book.origin !== 'pixiv' && book.origin !== 'pawchive') return '';
    const tags = (gallery.tags || []).map((tag) => (tag && (tag.label || tag.name)) || '').join(' ');
    return `${norm(gallery.caption || '')} ${norm(tags)}`;
  }

  // 仕様の一行の宣言頁数 (B5/28P/700円、全28ページ、【28P】)。4 頁以上だけを宣言とみなす
  function declaredPages(text) {
    const source = norm(text);
    let best = 0;
    const patterns = [
      /(?:^|[\s/|・,、])(?:[ab][4-6])\s*[/・\s]\s*(\d{1,3})\s*(?:p|ページ|頁)(?![a-z])/g,
      /全\s*(\d{1,3})\s*(?:p|ページ|頁)(?![a-z])/g,
      /【\s*(\d{1,3})\s*p\s*】/g,
      /(\d{1,3})\s*(?:p|ページ|頁)\s*[/]\s*\d{2,5}\s*円/g,
    ];
    for (const re of patterns) {
      let hit;
      re.lastIndex = 0;
      while ((hit = re.exec(source))) {
        const n = Number(hit[1]);
        if (n >= 4 && n <= 999 && n > best) best = n;
      }
    }
    return best;
  }

  function dayOf(date) {
    const ms = Date.parse(String(date || ''));
    return Number.isFinite(ms) ? Math.floor(ms / 86400000) : null;
  }

  // 即売会の日のおよそ (夏は 8 月 12 日、冬は 12 月 29 日)
  function eventDay(event) {
    if (!event || !event.year) return null;
    if (Number(event.month) === 8) return dayOf(`${event.year}-08-12`);
    if (Number(event.month) === 12) return dayOf(`${event.year}-12-29`);
    return null;
  }

  const roleMemo = new WeakMap();

  // 一冊の役。{ role, sure (決め手), decided (点で決まったか決め手), reason, incomplete, declared }
  function roleOf(book) {
    const gallery = (book && book.gallery) || null;
    if (gallery && roleMemo.has(gallery)) return roleMemo.get(gallery);
    const title = norm(titleOf(book));
    const text = postText(book);
    const pages = pagesOf(book);
    const incomplete = INCOMPLETE_BRACKET.test(title);
    const declared = declaredPages(`${title} ${text}`);
    let result = null;
    if (SAMPLE_BRACKET.test(title)) result = { role: 'sample', sure: true, reason: 'A1' };
    else if (book.origin === 'pixiv' && FANBOX_TEASER.test(text)) result = { role: 'sample', sure: true, reason: 'A3' };
    else if (declared && pages >= 1 && pages < declared) result = { role: 'sample', sure: true, reason: 'A4' };
    else if (/^【\s*お品書き\s*】/.test(title) || (OSHINAGAKI.test(title) && pages <= 3)) result = { role: 'notice', sure: true, reason: 'A5' };
    if (!result) {
      const scores = { main: 0, sample: 0, notice: 0, variant: 0, repost: 0 };
      const hay = `${title} ${text}`;
      for (const rule of B_RULES) {
        if (!rule.re.test(hay)) continue;
        for (const [role, add] of Object.entries(rule.add)) scores[role] += add;
      }
      const day = dayOf(book.date);
      const eday = eventDay(book.event);
      if (day != null && eday != null && day >= eday - 30 && day <= eday + 1) {           // B8
        scores.sample += 1;
        scores.notice += 1;
      }
      if (book.origin === 'pixiv' && gallery && gallery.type === 'manga' && gallery.series) scores.main += 2; // B9
      if (pages >= 8) scores.main += 2;                                                     // B10
      if (book.origin === 'hitomi') scores.main += 2;                                       // B11
      const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
      if (ranked[0][1] > 0 && ranked[0][1] - ranked[1][1] >= 2) {
        result = { role: ranked[0][0], sure: false, reason: 'B' };
      } else {
        result = { role: pages === 1 ? 'single' : 'main', sure: false, reason: '', undecided: true };
      }
    }
    const out = { ...result, decided: !result.undecided, incomplete, declared };
    if (gallery) roleMemo.set(gallery, out);
    return out;
  }

  const keyMemo = new WeakMap();

  function keysOf(book) {
    const gallery = (book && book.gallery) || null;
    if (gallery && keyMemo.has(gallery)) return keyMemo.get(gallery);
    const title = titleOf(book);
    const titles = titleKeys(title);
    // 店の URL は製品を語る投稿 (新刊・サンプル・通販・委託… の語がある) だけの鍵にする
    // (説明の定型に毎回同じ店の URL を置く作者がいる: それで無関係の絵まで束ねない)
    const stores = [];
    const text = postText(book);
    if (text && /新刊|サンプル|試し読み|sample|通販|委託|予約|頒布|発売/.test(`${norm(title)} ${text}`)) {
      for (const [re, name] of STORE_RES) {
        let hit;
        re.lastIndex = 0;
        while ((hit = re.exec(text))) stores.push(`${name}:${hit[1]}`);
      }
    }
    const out = { titles, stores: [...new Set(stores)] };
    if (gallery) keyMemo.set(gallery, out);
    return out;
  }

  // ---- 束ねる ----------------------------------------------------------------

  function pagesNear(a, b) {
    if (DC && typeof DC.pagesNearlyEqual === 'function') return DC.pagesNearlyEqual(a, b);
    return Boolean(a && b) && Math.abs(a - b) <= Math.max(4, Math.ceil(Math.max(a, b) * 0.1));
  }

  function isOwned(book) {
    const gallery = (book && book.gallery) || {};
    return Boolean(book && book.owned) || Boolean(gallery.owned && gallery.idOwned);
  }

  // books: 並べる順の一冊ずつ。返り: Map<id, { role, sure, decided, folded, under, as, cluster, size }>
  //   folded  畳む (所持の版違いを隠す・所持を隠すで伏せる)
  //   as      'similar' (代表が所持 = 所持の版違い) / 'dupe' (代表が未所持 = 重なり)。所持の本は畳まない
  function mark(books) {
    const list = Array.isArray(books) ? books.filter(Boolean) : [];
    const n = list.length;
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
    const roles = list.map(roleOf);
    const keys = list.map(keysOf);
    const days = list.map((book) => dayOf(book.date));

    // 題の鍵ごとの札。同じ源泉で三度以上使われた鍵は決まり文句
    const byKey = new Map();
    list.forEach((book, index) => {
      for (const key of keys[index].titles) {
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(index);
      }
    });
    for (const [key, members] of byKey) {
      if (members.length < 2) continue;
      const perOrigin = new Map();
      for (const index of members) {
        const origin = list[index].origin || '';
        perOrigin.set(origin, (perOrigin.get(origin) || 0) + 1);
      }
      const repeated = [...perOrigin.values()].some((count) => count >= GENERIC_REPEAT);
      const generic = repeated || GENERIC.test(key);
      const span = generic ? GENERIC_DAYS : (units(key) < SHORT_KEY_UNITS ? SHORT_KEY_DAYS : Infinity);
      if (span === Infinity) {
        for (let i = 1; i < members.length; i += 1) union(members[0], members[i]);
        continue;
      }
      // 日付の近い組だけ。日付の無い札は短い鍵・決まり文句では結ばない
      const dated = members.filter((index) => days[index] != null).sort((a, b) => days[a] - days[b]);
      for (let i = 1; i < dated.length; i += 1) {
        for (let j = i - 1; j >= 0 && days[dated[i]] - days[dated[j]] <= span; j -= 1) union(dated[i], dated[j]);
      }
    }
    // 製品を語る投稿どうしの店の URL
    const byStore = new Map();
    list.forEach((book, index) => {
      for (const key of keys[index].stores) {
        if (byStore.has(key)) union(byStore.get(key), index);
        else byStore.set(key, index);
      }
    });

    const groups = new Map();
    for (let i = 0; i < n; i += 1) {
      const root = find(i);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(i);
    }

    const out = new Map();
    for (const [root, members] of groups) {
      const size = members.length;
      const cluster = size > 1 ? `h${root}` : null;
      const settle = (index, extra) => {
        const role = roles[index];
        out.set(String(list[index].id), {
          role: role.role, sure: role.sure, decided: role.decided, reason: role.reason,
          folded: false, under: null, as: null, cluster, size, ...extra,
        });
      };
      if (size === 1 || size > CLUSTER_MAX) {
        for (const index of members) settle(index, {});
        continue;
      }
      const maxPages = Math.max(0, ...members.map((index) => pagesOf(list[index])));
      const complete = (index) => {
        const pages = pagesOf(list[index]);
        // 頁の分からない所持の本は揃っているとみなす (名前に頁数の印が無いだけのことが多い)
        if (!pages) return isOwned(list[index]);
        return pages >= maxPages * COMPLETE_RATIO;
      };
      const weak = (index) => roles[index].incomplete || (roles[index].sure && (roles[index].role === 'sample' || roles[index].role === 'notice'));
      const roleRank = (index) => (roles[index].decided && roles[index].role === 'main' ? 0 : (roles[index].role === 'main' ? 1 : 2));
      const ranked = members.slice().sort((a, b) => (
        (weak(a) - weak(b))
        || (complete(b) - complete(a))
        || (isOwned(list[b]) - isOwned(list[a]))
        || (pagesOf(list[b]) - pagesOf(list[a]))
        || (roleRank(a) - roleRank(b))
        || (Number(Boolean(list[b].owned)) - Number(Boolean(list[a].owned)))
        || ((ORIGIN_RANK[list[a].origin] ?? 9) - (ORIGIN_RANK[list[b].origin] ?? 9))
        || (a - b)
      ));
      const rep = ranked[0];
      const repPages = pagesOf(list[rep]);
      const repOwned = isOwned(list[rep]);
      settle(rep, { representative: true });
      for (const index of members) {
        if (index === rep) continue;
        // 所持の本は畳まない: 同じ作品を二版とも持っていても、見本だけ持っていても、Eagle に在る物は全て見せる
        if (isOwned(list[index])) {
          settle(index, {});
          continue;
        }
        const pages = pagesOf(list[index]);
        // 代表に覆われるか: 頁が近い (版違い・再掲) か代表より少ない。分からない時は代表が所持なら覆う
        let covered;
        if (pages && repPages) covered = pagesNear(pages, repPages) || pages < repPages;
        else covered = !pages || repOwned;
        if (!covered && weak(index) && !roles[index].incomplete && !weak(rep)) covered = true;
        if (!covered) {
          settle(index, {});
          continue;
        }
        const as = repOwned ? 'similar' : 'dupe';
        settle(index, { folded: true, under: String(list[rep].id), as });
      }
    }
    return out;
  }

  // 札に重ねる役の印 (見本・告知・差分・再掲)。点だけで決まった物は「?」を添える。本体と一枚絵は出さない
  function roleBadge(info) {
    if (!info || !info.decided) return '';
    if (!['sample', 'notice', 'variant', 'repost'].includes(info.role)) return '';
    return `${ROLE_LABELS[info.role]}${info.sure ? '' : '?'}`;
  }

  return {
    mark,
    roleOf,
    roleBadge,
    titleKeys,
    declaredPages,
    ROLE_LABELS,
    thresholds: {
      CLUSTER_MAX, SHORT_KEY_UNITS, SHORT_KEY_DAYS, GENERIC_DAYS, GENERIC_REPEAT, COMPLETE_RATIO,
    },
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = HomeBundle;
if (typeof window !== 'undefined') window.HomeBundle = HomeBundle;
