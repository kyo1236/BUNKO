'use strict';
// ui-probe の測りを Jev に見立ててもらう。測りそのもの (数) は決まりが出す。Jev に聞くのは
// 「この反応はこの釦の役目らしいか」「利用者が一番気にする困り事はどれか」「どのくらい困るか」だけ。
// 送る state は英語の役目の説明・ソースに書かれた UI の語 (伏せ字済み)・数・セレクタだけ (線 1)。
//
//   node scripts/tools/ui-probe-jev.js <report.json>   保存した記録を見立て直し、report.json と report.md を書き直す
//
// 2026-09-27 の一回目で分かった事: 観測に「何が変わったか」の証拠 (DOM の変化の量と場所) が無いと、
// 設定の区分の切り替えのような正しい反応を「何も起きていない」と見る。クリック直後の予定どおりの組み直しと、
// 遅れて来たずれ・枠の動きを分けて渡さないと、何でも layout_jump に寄せる。
const fs = require('fs');
const path = require('path');
const { ask } = require('./jev');

const APP = 'BUNKO is a desktop app for browsing online comic galleries and reading owned books. '
  + 'Its top quality rule: it must feel instant and steady. The two most disliked things are blank areas while something loads '
  + 'and layout jumps. New banners, badges, notices and side panels should overlay existing content, never push or re-flow it. '
  + 'Motion should use transform/opacity and finish without dropped frames.';

const QUESTIONS = {
  fits: {
    type: 'noul',
    instructions: 'Given `control.purpose`, does `observed` show the reaction a user would expect from this action? Treat dom_mutations and changed_areas as evidence that content was redrawn even when no panel opened or closed.',
    criteria: {
      true: 'The visible outcome matches the purpose: the named panel opened or closed, the named list or pane was redrawn, the named setting or view changed, or the control toggled.',
      false: 'Nothing visible happened, or something different from the purpose happened, or the app ended in an unexpected state.',
    },
  },
  problem: {
    type: 'choice',
    instructions: 'Which single user-visible problem is most important in this interaction? Thresholds: feedback later than 100 ms feels slow; blank_ms of 200 or more is a blank; frames over 33 ms during motion are dropped frames; a main-thread task of 200 ms or more is a stall. '
      + 'Re-arranging cards is expected only when `control.purpose` itself says the cards change size, layout, order or content.',
    criteria: {
      none: 'No problem a user would notice.',
      no_visible_reaction: 'The action produced no visible change at all.',
      wrong_reaction: 'The app reacted, but not in the way the purpose describes.',
      slow_or_blank: 'The response was slow, or an area stayed blank while loading.',
      layout_jump: 'Content the user was looking at moved without the purpose asking for it: `pushed_reflow` (cards re-flowed because a panel or bar took space), `late_shifts` (content moved after it had settled), or `frame_moved` (the top bar or filter bar moved or changed height).',
      choppy_motion: 'Animation or scrolling dropped frames, or the main thread stalled during the interaction.',
      error: 'A script error or console error happened.',
      stuck: 'The app could not be returned to its previous state afterwards.',
    },
  },
  severity: {
    type: 'score',
    instructions: 'How much would this interaction bother a user who cares above all about a quick, steady interface?',
    criteria: [
      'Not at all: it behaves as intended with no visible flaw.',
      'Slightly: a flaw visible only on close inspection.',
      'Noticeably: a user would see the flaw and be mildly annoyed.',
      'Badly: the interaction feels broken or unreliable.',
    ],
  },
};

const FRAME = /^(#search-form|header\.rail|#app > div\.ui-topbar|#app > main\.workspace|section\.filters|div\.rail-|#app > div\.ui-topbar > )/;

function overlayDelta(b, a) {
  const opened = []; const closed = [];
  for (const k of Object.keys(b.overlays)) {
    if (!b.overlays[k] && a.overlays[k]) opened.push(k);
    if (b.overlays[k] && !a.overlays[k]) closed.push(k);
  }
  return { opened, closed };
}

// ずれを三つに分ける: 押した直後の棚の組み直し / 遅れて来たずれ / 枠 (上の帯・絞りの帯・棚の器) の動き
function splitShifts(shifts) {
  const moved = (s) => Math.abs(s.dy) >= 2 || Math.abs(s.dh) >= 2 || Math.abs(s.dx || 0) >= 2;
  const frame = []; const early = []; const late = [];
  for (const e of shifts) {
    for (const s of e.sources.filter(moved)) {
      if (FRAME.test(s.node || '')) frame.push({ node: s.node, dx: s.dx || 0, dy: s.dy, dh: s.dh, at_ms: e.at });
      else if (e.input) early.push({ node: s.node, dx: s.dx || 0, dy: s.dy });
      else late.push({ node: s.node, dx: s.dx || 0, dy: s.dy, dh: s.dh, at_ms: e.at });
    }
  }
  const cls = (list) => Math.round(list.reduce((n, e) => n + e.value, 0) * 1000) / 1000;
  const maxMove = (list) => list.reduce((m, s) => Math.max(m, Math.abs(s.dx), Math.abs(s.dy)), 0);
  return {
    reflow_after_click: { moved_nodes: early.length, max_move_px: maxMove(early), shift_score: cls(shifts.filter((e) => e.input)) },
    late_shifts: late.slice(0, 5),
    frame_moved: frame.slice(0, 5),
  };
}

function stateOf(rec) {
  const r = rec.result; const b = r.before; const a = r.after;
  const { opened, closed } = overlayDelta(b, a);
  const c = rec.control || {};
  const gw = (s) => (s.regions && s.regions.grid ? s.regions.grid.w : 0);
  const split = splitShifts(r.shifts || []);
  return {
    app: APP,
    control: {
      selector: rec.selector || rec.step,
      label: c.label || null, title: c.title || null, aria_label: c.aria || null,
      purpose: rec.purpose || 'unknown',
      state_before: r.controlBefore || (c.pressed ? { pressed: c.pressed } : null),
      state_after: r.controlAfter || null,
      hidden_under_other_element: rec.click && rec.click.covered ? rec.click.coveredBy : null,
    },
    observed: {
      first_dom_change_ms: r.firstMutationMs,
      dom_mutations: r.mutations,
      changed_areas: r.changedAreas || undefined,
      settled_after_ms: r.settleMs,
      panels_opened: opened, panels_closed: closed,
      site_before: b.source, site_after: a.source,
      owned_only_before: b.scope, owned_only_after: a.scope,
      home_view_before: b.homeShown, home_view_after: a.homeShown,
      cards_in_view_before: b.cardsInView, cards_in_view_after: a.cardsInView,
      grid_width_before_px: gw(b), grid_width_after_px: gw(a),
      focused_element_after: a.active,
      blank_ms: r.blank.ms, first_cards_visible_ms: r.firstCardsMs,
      reader_loading_indicator_ms: r.readerWaitMs || 0,
      pushed_reflow: gw(b) && gw(a) && gw(b) !== gw(a) && !/size|layout|zoom|width/i.test(rec.purpose || '')
        ? { grid_width_change_px: gw(a) - gw(b), ...split.reflow_after_click } : null,
      reflow_right_after_click: split.reflow_after_click,
      late_shifts: split.late_shifts,
      frame_moved: split.frame_moved,
      animations: r.anims.slice(0, 6).map((x) => ({ target: x.target, properties: x.props, layout_properties: x.layoutProps, duration_ms: x.duration })),
      animation_count: r.anims.length,
      longest_main_thread_task_ms: r.longtasks.length ? Math.max(...r.longtasks.map((x) => x.ms)) : 0,
      frames_over_33ms: r.frames.over33, max_frame_gap_ms: r.frames.maxGap, frames: r.frames.count,
      script_errors: r.errors.length + (rec.consoleErrors || []).filter((e) => e.kind !== 'console-warning').length,
      returned_to_previous_state: rec.restore ? rec.restore.ok : null,
      restore_differences: rec.restore ? rec.restore.diff : [],
    },
  };
}

const round = (x) => (typeof x === 'number' ? Math.round(x * 1000) / 1000 : x);

async function judgeAll(records, { log = () => {}, concurrency = 4 } = {}) {
  let i = 0; let tokens = 0; let failed = 0;
  async function worker() {
    for (;;) {
      const rec = records[i++];
      if (!rec) return;
      try {
        const out = await ask({ state: stateOf(rec), questions: QUESTIONS });
        const an = out.answers;
        rec.jev = {
          model: out.model,
          fits: round(an.fits.noul),
          problem: an.problem.choice, problemConf: round(an.problem.confidence),
          problemProbs: Object.fromEntries(Object.entries(an.problem.probabilities || {}).map(([k, v]) => [k, round(v)])),
          severity: round(an.severity.score), severityConf: round(an.severity.confidence),
        };
        tokens += (out.usage && out.usage.input_tokens) || 0;
      } catch (error) {
        failed++;
        rec.jev = { error: String(error && error.message).slice(0, 160) };
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  log(`[--] Jev: ${records.length - failed}/${records.length} 件を見立てた (入力 ${tokens} tokens)`);
}

if (require.main === module) {
  (async () => {
    const file = process.argv[2];
    if (!file) throw new Error('usage: node scripts/tools/ui-probe-jev.js <report.json>');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    await judgeAll(data.records.filter((r) => r.result), { log: (s) => console.log(s) });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    fs.writeFileSync(path.join(path.dirname(file), 'report.md'), require('./ui-probe-report').markdown(data.records, { stamp: data.stamp }));
    console.log('[OK] 見立て直した → ' + path.dirname(file));
  })().catch((error) => { console.error('[NG] ' + error.message); process.exit(1); });
}

module.exports = { judgeAll, stateOf, QUESTIONS, splitShifts };
