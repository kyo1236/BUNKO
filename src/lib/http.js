const fs = require('fs');
const http = require('http');
const https = require('https');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

// 表紙は一覧ぶんまとめて取りに行く: 毎回 TCP+TLS を張り直すと握手だけで数百 ms 積む。
// 接続を使い回して二枚目以降を握手ぶんだけ速くする
// 同時 16 は downloader の取得ゲート (最大 10) と先読み (4) を詰まらせない下限
const AGENT_OPTIONS = { keepAlive: true, maxSockets: 16, maxFreeSockets: 4, timeout: 30000 };
const httpAgent = new http.Agent(AGENT_OPTIONS);
const httpsAgent = new https.Agent(AGENT_OPTIONS);

function agentFor(target) {
  return target.protocol === 'http:' ? httpAgent : httpsAgent;
}

function retryAfterOf(headers) {
  const value = headers && headers['retry-after'];
  if (value == null) return {};
  const seconds = Number(value);
  const parsed = Number.isFinite(seconds)
    ? Math.max(0, seconds * 1000)
    : Date.parse(value) - Date.now();
  return Number.isFinite(parsed)
    ? { retryAfter: value, retryAfterMs: Math.max(0, parsed) }
    : { retryAfter: value };
}

// 順番待ちの期限切れ。冷却中に当たったなら「流量で断られた」と分かる形にする
function lateError(scheduler, host) {
  const cool = scheduler.coolingMs ? scheduler.coolingMs(host) : 0;
  const error = new Error(cool ? `deadline ${host} (429 冷却中)` : `deadline ${host}`);
  if (cool) {
    error.status = 429;
    error.retryAfterMs = cool;
    error.throttled = true;
  }
  return error;
}

class SiteScheduler {
  // 既存 Agent の maxSockets と揃え、downloader が指定する最大10並列を狭めない。
  // 個別サイトの抑制は Retry-After cooldown で行う。
  constructor(limit = 16) {
    this.limit = limit;
    this.sites = new Map();
  }

  state(host) {
    if (!this.sites.has(host)) {
      this.sites.set(host, {
        active: 0, waiters: [], blockedUntil: 0, timer: null, limit: 0, interval: 0, nextAt: 0,
      });
    }
    return this.sites.get(host);
  }

  // 相手が決めた作法を宛先ごとに持つ。limit = 同時に出す本数、interval = 出す間隔 (ms)。
  // 0 なら既定 (同時は this.limit、間は空けない)。Pawchive のファイル置き場は
  // 「1 秒に 1 本・同時 5 本まで」と名指しで求める (sources/pawchive.js が差す)
  configure(host, { limit = 0, interval = 0 } = {}) {
    const state = this.state(host);
    state.limit = Number(limit) > 0 ? Math.floor(Number(limit)) : 0;
    state.interval = Number(interval) > 0 ? Number(interval) : 0;
    this.pump(host);
  }

  acquire(host, { signal, deadline, priority = 10 } = {}) {
    return new Promise((resolve, reject) => {
      const state = this.state(host);
      let timer;
      let onAbort;
      const remove = () => {
        const index = state.waiters.indexOf(waiter);
        if (index >= 0) state.waiters.splice(index, 1);
      };
      const cleanup = () => {
        clearTimeout(timer);
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      };
      const waiter = {
        priority: Number(priority) || 0,
        queuedAt: Date.now(),
        grant: () => { cleanup(); resolve(); },
      };
      const cancel = (error) => {
        remove();
        cleanup();
        reject(error);
      };
      if (signal?.aborted) {
        reject(signal.reason || new Error('aborted'));
        return;
      }
      if (deadline !== undefined) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          reject(lateError(this, host));
          return;
        }
        timer = setTimeout(() => cancel(lateError(this, host)), remaining);
      }
      if (signal) {
        onAbort = () => cancel(signal.reason || new Error('aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
      }
      state.waiters.push(waiter);
      this.pump(host);
    });
  }

  release(host) {
    const state = this.state(host);
    state.active = Math.max(0, state.active - 1);
    this.pump(host);
  }

  cooldown(host, ms) {
    const state = this.state(host);
    state.blockedUntil = Math.max(state.blockedUntil, Date.now() + Math.max(0, ms || 0));
    this.pump(host);
  }

  // 冷やしている残り (ms)。冷えていなければ 0。
  // 順番待ちで期限切れになった回が「流量で断られた」のかを呼び手へ伝えるために要る
  coolingMs(host) {
    const state = this.state(host);
    return Math.max(0, state.blockedUntil - Date.now());
  }

  pump(host) {
    const state = this.state(host);
    const limit = state.limit || this.limit;
    while (state.active < limit && state.waiters.length) {
      // 冷却 (Retry-After) と、宛先の作法の間 (interval) が明けるまでは出さない
      const wait = Math.max(state.blockedUntil, state.nextAt) - Date.now();
      if (wait > 0) {
        if (!state.timer) {
          state.timer = setTimeout(() => {
            state.timer = null;
            this.pump(host);
          }, wait);
        }
        return;
      }
      state.active += 1;
      if (state.interval) state.nextAt = Date.now() + state.interval;
      // 小さい値ほど優先。1秒待つごとに一段ずつ上げ、background も枯らさない。
      let best = 0;
      let bestScore = Infinity;
      const now = Date.now();
      for (let i = 0; i < state.waiters.length; i += 1) {
        const waiter = state.waiters[i];
        const score = waiter.priority - Math.floor((now - waiter.queuedAt) / 1000);
        if (score < bestScore) { best = i; bestScore = score; }
      }
      state.waiters.splice(best, 1)[0].grant();
    }
  }
}

const siteScheduler = new SiteScheduler();

// 宛先の作法を差す口 (SiteScheduler.configure を共有の一つに)
function configureHost(host, options) {
  siteScheduler.configure(host, options);
}

async function request(url, options = {}) {
  const timeout = options.timeout ?? 20000;
  const deadline = options.deadline ?? Date.now() + timeout;
  let current = url;
  let hops = options.hops || 0;
  while (true) {
    const host = new URL(current).hostname;
    await siteScheduler.acquire(host, { signal: options.signal, deadline, priority: options.priority });
    try {
      const result = await requestRaw(current, { ...options, timeout, deadline, hops });
      if (result && result[REDIRECT]) {
        current = result.url;
        hops += 1;
        continue;
      }
      return result;
    } catch (error) {
      if ((error.status === 429 || error.status === 503) && error.retryAfterMs) {
        siteScheduler.cooldown(host, error.retryAfterMs);
      }
      throw error;
    } finally {
      siteScheduler.release(host);
    }
  }
}

const REDIRECT = Symbol('redirect');

function requestRaw(url, {
  method = 'GET', headers = {}, body = null, hops = 0, retried = false,
  agent, timeout = 20000, signal, deadline = Date.now() + timeout, requestOptions = {},
} = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    const lib = target.protocol === 'http:' ? http : https;
    // 相手が黙って閉じた居抜きの接続を掴むことがある。まだ一文字も受け取っていない
    // GET なら送り直しても副作用は無いので、新しい接続で一度だけやり直す
    let started = false;
    let settled = false;
    let absoluteTimer;
    let onAbort;
    const cleanup = () => {
      clearTimeout(absoluteTimer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    };
    const succeed = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const remaining = Math.max(0, deadline - Date.now());
    const req = lib.request({
      ...requestOptions,
      hostname: target.hostname,
      port: target.port || undefined,
      path: target.pathname + target.search,
      method,
      agent: agent === undefined ? agentFor(target) : agent,
      timeout: Math.min(timeout, remaining),
      headers: {
        'User-Agent': UA,
        Accept: '*/*',
        ...(payload ? { 'Content-Length': payload.length } : {}),
        ...headers,
      },
    }, (res) => {
      started = true;
      res.on('error', fail);
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 6) {
        res.resume();
        const next = new URL(res.headers.location, url).href;
        succeed({ [REDIRECT]: true, url: next });
        return;
      }
      const chunks = [];
      let ended = false;
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        ended = true;
        const buffer = Buffer.concat(chunks);
        if (res.statusCode >= 400) {
          const error = new Error(`HTTP ${res.statusCode} ${target.hostname}`);
          error.status = res.statusCode;
          error.body = buffer;
          Object.assign(error, retryAfterOf(res.headers));
          fail(error);
          return;
        }
        succeed({
          status: res.statusCode,
          headers: res.headers,
          buffer,
          text: () => buffer.toString('utf8'),
          json: () => JSON.parse(buffer.toString('utf8')),
        });
      });
      res.on('aborted', () => fail(new Error(`response aborted ${target.hostname}`)));
      res.on('close', () => {
        if (!ended && !res.complete) fail(new Error(`premature close ${target.hostname}`));
      });
    });
    req.on('timeout', () => req.destroy(new Error(`timeout ${target.hostname}`)));
    req.on('error', (error) => {
      if (error?.code === 'ECONNRESET' && method === 'GET' && !started && !retried) {
        // 使い回しの接続が死んでいただけ: 素の接続で一度だけ引き直す
        succeed(requestRaw(url, {
          method, headers, body, hops, retried: true, agent: false, timeout, signal, deadline, requestOptions,
        }));
        return;
      }
      fail(error);
    });
    absoluteTimer = setTimeout(
      () => req.destroy(new Error(`deadline ${target.hostname}`)),
      remaining,
    );
    if (signal) {
      if (signal.aborted) req.destroy(signal.reason || new Error('aborted'));
      else {
        onAbort = () => req.destroy(signal.reason || new Error('aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    if (payload) req.write(payload);
    req.end();
  });
}

function get(url, headers, options = {}) {
  return request(url, { ...options, headers });
}

// 大きな添付 (zip や動画は 100MB を超えることがある) は記憶に丸ごと載せずに
// ファイルへ直に流す。request と違って本文を Buffer に積まない
async function download(url, dest, options = {}) {
  const idleTimeout = options.idleTimeout ?? options.timeout ?? 60000;
  const deadline = options.deadline
    ?? (options.totalTimeout == null ? undefined : Date.now() + options.totalTimeout);
  let current = url;
  let hops = options.hops || 0;
  while (true) {
    const host = new URL(current).hostname;
    await siteScheduler.acquire(host, { signal: options.signal, deadline, priority: options.priority });
    try {
      const result = await downloadRaw(current, dest, {
        ...options, idleTimeout, deadline, hops,
      });
      if (result && result[REDIRECT]) {
        current = result.url;
        hops += 1;
        continue;
      }
      return result;
    } catch (error) {
      if ((error.status === 429 || error.status === 503) && error.retryAfterMs) {
        siteScheduler.cooldown(host, error.retryAfterMs);
      }
      throw error;
    } finally {
      siteScheduler.release(host);
    }
  }
}

function downloadRaw(url, dest, {
  headers = {}, hops = 0, idleTimeout = 60000, signal, deadline,
} = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'http:' ? http : https;
    let settled = false;
    let absoluteTimer;
    let onAbort;
    let response;
    let out;
    const cleanup = () => {
      clearTimeout(absoluteTimer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    };
    const succeed = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (response && !response.destroyed) response.destroy();
      if (out && !out.destroyed) out.destroy();
      reject(error);
    };
    const remaining = deadline === undefined ? Infinity : Math.max(0, deadline - Date.now());
    const req = lib.request({
      hostname: target.hostname,
      port: target.port || undefined,
      path: target.pathname + target.search,
      method: 'GET',
      agent: agentFor(target),
      timeout: Math.min(idleTimeout, remaining),
      headers: { 'User-Agent': UA, Accept: '*/*', ...headers },
    }, (res) => {
      response = res;
      res.on('error', fail);
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 6) {
        res.resume();
        const next = new URL(res.headers.location, url).href;
        succeed({ [REDIRECT]: true, url: next });
        return;
      }
      if (res.statusCode >= 400) {
        res.resume();
        const error = new Error(`HTTP ${res.statusCode} ${target.hostname}`);
        error.status = res.statusCode;
        Object.assign(error, retryAfterOf(res.headers));
        fail(error);
        return;
      }
      out = fs.createWriteStream(dest);
      let bytes = 0;
      let finished = false;
      res.on('data', (chunk) => { bytes += chunk.length; });
      res.on('error', (error) => {
        out.destroy();
        fail(error);
      });
      res.on('aborted', () => out.destroy(new Error(`response aborted ${target.hostname}`)));
      res.on('close', () => {
        if (!finished && !res.complete) out.destroy(new Error(`premature close ${target.hostname}`));
      });
      out.on('error', fail);
      // finish は書き終わりの合図: ここで初めて中身が揃ったと言える
      out.on('finish', () => {
        finished = true;
        succeed({ status: res.statusCode, headers: res.headers, bytes });
      });
      res.pipe(out);
    });
    req.on('timeout', () => req.destroy(new Error(`timeout ${target.hostname}`)));
    req.on('error', fail);
    if (Number.isFinite(remaining)) {
      absoluteTimer = setTimeout(
        () => req.destroy(new Error(`deadline ${target.hostname}`)),
        remaining,
      );
    }
    if (signal) {
      if (signal.aborted) req.destroy(signal.reason || new Error('aborted'));
      else {
        onAbort = () => req.destroy(signal.reason || new Error('aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    req.end();
  });
}

function postJson(url, data, headers = {}, options = {}) {
  return request(url, {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(data),
  });
}

module.exports = {
  get, postJson, request, download, configureHost, UA, SiteScheduler, _siteScheduler: siteScheduler,
};
