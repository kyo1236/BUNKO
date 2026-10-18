const TTL_MS = 10 * 60 * 1000;

function createRemotePager(fetchPage, { ttl = TTL_MS, maxEntries = 100 } = {}) {
  const entries = new Map();

  async function waitLoading(entry, loading, signal) {
    loading.subscribers += 1;
    let onAbort;
    try {
      if (!signal) return await loading.promise;
      if (signal.aborted) throw signal.reason || new Error('aborted');
      const aborted = new Promise((_, reject) => {
        onAbort = () => reject(signal.reason || new Error('aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
      });
      return await Promise.race([loading.promise, aborted]);
    } finally {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      loading.subscribers -= 1;
      if (signal?.aborted && loading.subscribers === 0) {
        if (entry.loading === loading) entry.loading = null;
        loading.controller.abort(signal.reason);
      }
    }
  }

  return async function pageFor(key, page, pageSize, { signal } = {}) {
    let entry = entries.get(key);
    if (!entry || Date.now() - entry.at > ttl) {
      entry = { at: Date.now(), rows: [], next: 0, ended: false, total: null, loading: null };
      entries.set(key, entry);
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    }
    const end = (page + 1) * pageSize;
    while (!entry.ended && entry.rows.length < end) {
      if (entry.loading?.controller.signal.aborted) entry.loading = null;
      if (!entry.loading) {
        const controller = new AbortController();
        const loading = { controller, subscribers: 0, promise: null };
        loading.promise = Promise.resolve(fetchPage(entry.next, key, { signal: controller.signal })).then((result) => {
          if (entry.loading !== loading) return;
          const rows = Array.isArray(result?.rows) ? result.rows : [];
          entry.rows.push(...rows);
          entry.next += 1;
          if (Number.isFinite(result?.total)) entry.total = result.total;
          // 空の頁でも、取り手が「まだ先がある」と言えば続ける (札の側で間引いた頁が
          // 空になることがある: pixiv の種別・AI の絞り)。何も言わない空は終わり
          entry.ended = result?.hasNext === false || (rows.length === 0 && result?.hasNext !== true)
            || (entry.total != null && entry.rows.length >= entry.total);
          entry.at = Date.now();
        }).finally(() => { if (entry.loading === loading) entry.loading = null; });
        entry.loading = loading;
      }
      await waitLoading(entry, entry.loading, signal);
    }
    const start = page * pageSize;
    const rows = entry.rows.slice(start, end);
    return {
      rows,
      total: entry.total == null ? start + rows.length : entry.total,
      hasNext: !entry.ended || end < entry.rows.length,
    };
  };
}

module.exports = { createRemotePager };
