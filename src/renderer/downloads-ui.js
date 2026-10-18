// キューパネル一式。app.js より先に読まれるので、els / state / escapeHtml などの
// 共有物には関数の中からだけ触る
const DownloadsUI = (() => {
  const STATUS_LABELS = {
    queued: '待機中',
    running: '取得中',
    // pixiv: 頁は揃い、Eagle へ入れている最中 / 作者フォルダの確認待ち
    importing: 'Eagle へ',
    asking: '同じ人?',
    error: '失敗',
    done: '完了',
    cancelled: '中止',
  };

  // 進行中セクションは 失敗 を先頭に。完了セクションは 完了 が先。
  // ここに無い status の行は一覧から消える: 新しい status は必ずここと ACTIVE に足す
  const RANK = {
    error: 0, asking: 1, running: 2, importing: 3, queued: 4, done: 5, cancelled: 6,
  };
  const ACTIVE = new Set(['error', 'asking', 'running', 'importing', 'queued']);

  // id -> { bytes, time, rate }。rate は EMA した bytes/sec
  const rates = new Map();
  const SMOOTH = 0.3;

  function sampleRates(jobs) {
    const now = Date.now();
    const live = new Set();
    jobs.forEach((job) => {
      const id = String(job.id);
      live.add(id);
      if (job.status !== 'running') {
        rates.delete(id);
        return;
      }
      const bytes = job.bytes || 0;
      const prev = rates.get(id);
      if (!prev) {
        rates.set(id, { bytes, time: now, rate: 0 });
        return;
      }
      const seconds = (now - prev.time) / 1000;
      const delta = bytes - prev.bytes;
      if (delta < 0) {
        // やり直しで巻き戻った
        rates.set(id, { bytes, time: now, rate: 0 });
        return;
      }
      // 短すぎる間隔だと数字が暴れるので溜まるまで待つ
      if (seconds < 0.5) return;
      const sample = delta / seconds;
      const rate = prev.rate ? prev.rate * (1 - SMOOTH) + sample * SMOOTH : sample;
      rates.set(id, { bytes, time: now, rate });
    });
    [...rates.keys()].forEach((id) => {
      if (!live.has(id)) rates.delete(id);
    });
  }

  function rateOf(job) {
    const entry = rates.get(String(job.id));
    return entry && entry.rate > 0 ? entry.rate : 0;
  }

  function formatRate(rate) {
    if (rate >= 1048576) return `${(rate / 1048576).toFixed(1)} MB/s`;
    return `${Math.max(1, Math.round(rate / 1024))} KB/s`;
  }

  function formatEta(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return '';
    if (seconds < 60) return `残り ${Math.max(1, Math.round(seconds))}秒`;
    return `残り ${Math.round(seconds / 60)}分`;
  }

  // 残りページ数 × 平均ページサイズ を速度で割る
  function etaOf(job, rate) {
    if (!rate || !job.total || !job.done) return '';
    const remaining = job.total - job.done;
    if (remaining <= 0) return '';
    const perPage = (job.bytes || 0) / job.done;
    if (!perPage) return '';
    return formatEta((remaining * perPage) / rate);
  }

  function failedPagesText(job, limit) {
    const pages = Array.isArray(job.failedPages) ? job.failedPages : [];
    if (!pages.length) return '';
    const sorted = [...pages].sort((a, b) => a - b).map((index) => index + 1);
    const head = sorted.slice(0, limit).join(', ');
    return `失敗ページ: ${head}${sorted.length > limit ? ' …' : ''}`;
  }

  // Edge の一覧のように、状態語は最小限にして数字で語らせる。
  // 節の見出し (進行中/完了) が状態を言っているので、行では繰り返さない
  function meta(job) {
    const mb = ((job.bytes || 0) / 1048576).toFixed(1);
    if (job.status === 'done') return `${job.total || job.done}ページ · ${mb} MB`;
    if (job.status === 'cancelled') return `${STATUS_LABELS.cancelled} · ${mb} MB`;
    if (job.status === 'error') {
      return `${STATUS_LABELS.error} · ${job.done}/${job.total || '?'}${job.failed ? ` (${job.failed})` : ''}`;
    }
    if (job.status === 'queued') {
      return job.attempts ? `再試行 ${job.attempts}` : STATUS_LABELS.queued;
    }
    if (job.status === 'importing') return `${STATUS_LABELS.importing} · ${job.total || job.done}ページ · ${mb} MB`;
    if (job.status === 'asking') {
      const ask = job.ask || {};
      return `作者フォルダ「${ask.folderName || '?'}」と同じ人?`;
    }
    let text = `${job.done}/${job.total || '?'}${job.failed ? ` · 失敗 ${job.failed}` : ''} · ${mb} MB`;
    const rate = rateOf(job);
    if (rate) {
      text += ` · ${formatRate(rate)}`;
      const eta = etaOf(job, rate);
      if (eta) text += ` · ${eta}`;
    }
    return text;
  }

  function percent(job) {
    return job.total ? Math.round((job.done / job.total) * 100) : 0;
  }

  function errorHtml(job) {
    if (job.status !== 'error') return '';
    const pages = failedPagesText(job, 10);
    const line = [job.error || '原因不明', pages].filter(Boolean).join(' · ');
    const full = [job.error || '原因不明', failedPagesText(job, 40)].filter(Boolean).join('\n');
    return `<div class="job-error" title="${escapeHtml(full)}">${escapeHtml(line)}</div>`;
  }

  // 済んだ仕事の行き先。落としている間の置き場 (downloadDest) は Eagle の
  // 見張りフォルダなので、取り込みが済むと消える。開く先は Eagle のアイテム、
  // フォルダを出す先は取り込み後の道 (finalPath) — 別物なので分けて持つ。
  //
  // 釦は消さずに死なせる。取り込みが済んだ瞬間に釦が増えると、控え室の行が
  // 横にずれて読んでいる目が飛ぶ
  function doneActs(job) {
    if (job.status !== 'done') return '';
    const eagleId = job.eagleItemId || '';
    const folder = job.finalPath || '';
    const openAttrs = eagleId
      ? `data-open-eagle="${escapeHtml(eagleId)}" title="Eagle で開く" aria-label="Eagle で開く"`
      : 'disabled title="Eagle への取り込みを待っています" aria-label="開く"';
    const showAttrs = folder
      ? `data-show="${escapeHtml(folder)}" title="フォルダ内で表示" aria-label="フォルダ内で表示"`
      : 'disabled title="取り込み後に使えます" aria-label="フォルダ内で表示"';
    // 開く先は別のアプリ (Eagle) なので、外へ出る印にする。
    // フォルダの印は「フォルダ内で表示」に譲る
    return `
        <button type="button" class="job-icon" ${openAttrs}>${ICON.external}</button>
        <button type="button" class="job-icon" ${showAttrs}>${ICON.folderShow}</button>`;
  }

  // 「同じ人?」の答え (pixiv の取り込みが作者フォルダを決めかねている行)。
  // 押した時に訊くのが本筋で、ここは再起動で復元した job の保険
  function askActs(job) {
    if (job.status !== 'asking' || !job.ask) return '';
    const ask = job.ask;
    const common = `data-user="${escapeHtml(ask.userId || '')}" data-name="${escapeHtml(ask.folderName || '')}"`;
    return `
        <button type="button" class="ghost sm" data-answer="same" data-folder="${escapeHtml(ask.folderId || '')}" ${common}>同じ人</button>
        <button type="button" class="ghost sm" data-answer="other" ${common}>別の人</button>`;
  }

  function inner(job) {
    return `
      <div>
        <strong>${escapeHtml(job.title)}</strong>
        <div class="meta">${escapeHtml(meta(job))}</div>
      </div>
      <div class="job-actions">
        ${doneActs(job)}
        ${askActs(job)}
        ${job.status === 'error' ? `<button type="button" class="job-icon" data-retry="${escapeHtml(job.id)}" title="再試行" aria-label="再試行">${ICON.rescan}</button>` : ''}
        ${job.status === 'queued' || job.status === 'running' ? `<button type="button" class="job-icon" data-cancel="${escapeHtml(job.id)}" title="中止" aria-label="中止">${ICON.close}</button>` : ''}
      </div>
      ${errorHtml(job)}
      <div class="bar"><span style="width:${percent(job)}%"></span></div>
  `;
  }

  function renderList(list, jobs) {
    const seen = new Set();
    let anchor = null;
    jobs.forEach((job) => {
      const id = String(job.id);
      seen.add(id);
      let li = list.querySelector(`li[data-job-id="${id}"]`);
      if (!li) {
        li = document.createElement('li');
        li.dataset.jobId = id;
        li.dataset.status = job.status;
        li.className = `job ${job.status}`;
        li.innerHTML = inner(job);
      } else if (li.dataset.status !== job.status) {
        li.dataset.status = job.status;
        li.className = `job ${job.status}`;
        li.innerHTML = inner(job);
      } else {
        const metaNode = li.querySelector('.meta');
        if (metaNode) metaNode.textContent = meta(job);
        const bar = li.querySelector('.bar > span');
        if (bar) bar.style.width = `${percent(job)}%`;
      }
      const target = anchor ? anchor.nextSibling : list.firstChild;
      if (li !== target) list.insertBefore(li, target);
      anchor = li;
    });

    [...list.children].forEach((li) => {
      if (!seen.has(li.dataset.jobId)) li.remove();
    });
  }

  function render() {
    const jobs = state.downloads || [];
    sampleRates(jobs);

    const active = jobs.filter((job) => ['queued', 'running', 'importing', 'asking'].includes(job.status)).length;
    els.queueCount.textContent = String(active);

    const visible = jobs
      .filter((job) => RANK[job.status] !== undefined)
      .reverse()
      .sort((a, b) => RANK[a.status] - RANK[b.status]);

    const running = visible.filter((job) => ACTIVE.has(job.status));
    const finished = visible.filter((job) => !ACTIVE.has(job.status));

    renderList(els.jobs, running);
    renderList(els.jobsDone, finished);

    els.queueActive.hidden = running.length === 0;
    els.queueActiveCount.textContent = String(running.length);
    els.queueDone.hidden = finished.length === 0;
    els.queueDoneCount.textContent = String(finished.length);
  }

  return { render, meta, percent };
})();
