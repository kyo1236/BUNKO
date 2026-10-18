'use strict';
// 走っている BUNKO (--remote-debugging-port=9222) の本窓へ CDP で繋ぐ小さな口。ui-probe.js が使う。
// 9222 の先頭の頁は隠れた焼き窓 (baker) のことがあるので、題「文匣」の頁 (無ければ src/renderer/ の頁) を選ぶ。
//
//   const cdp = await require('./cdp-page').connect();
//   await cdp.eval('1 + 1');                          // 値で返す (awaitPromise)
//   await cdp.send('Input.dispatchMouseEvent', {...}); // 素の CDP
//   cdp.on('Runtime.consoleAPICalled', (params) => …); cdp.close();
const PORT = Number(process.env.BUNKO_CDP_PORT || 9222);

async function pickPage() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const pages = list.filter((item) => item.type === 'page');
  return pages.find((p) => p.title === '文匣')
    || pages.find((p) => /\/src\/renderer\//.test(p.url || ''))
    || null;
}

async function connect() {
  const page = await pickPage();
  if (!page) throw new Error(`文匣 の頁が見つからない (BUNKO を --remote-debugging-port=${PORT} で起こす)`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    } else if (message.method && listeners.has(message.method)) {
      for (const fn of listeners.get(message.method)) fn(message.params);
    }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, (message) => {
      if (message.error) reject(new Error(`${method}: ${JSON.stringify(message.error)}`));
      else resolve(message.result);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression, { timeoutMs = 30000 } = {}) => {
    const run = send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    const timer = new Promise((_, reject) => setTimeout(() => reject(new Error('eval timeout')), timeoutMs));
    const out = await Promise.race([run, timer]);
    if (out.exceptionDetails) {
      const d = out.exceptionDetails;
      throw new Error('page: ' + ((d.exception && d.exception.description) || d.text || 'exception').split('\n')[0]);
    }
    return out.result.value;
  };
  const on = (method, fn) => {
    if (!listeners.has(method)) listeners.set(method, []);
    listeners.get(method).push(fn);
  };
  return { send, eval: evaluate, on, close: () => ws.close(), page: { title: page.title } };
}

module.exports = { connect, pickPage, PORT };

// node scripts/tools/cdp-page.js "<式>"   本窓で式を評価して値を出す (錠を持つ会だけ: BUNKO_SESSION=<会の名>)
if (require.main === module) {
  (async () => {
    const expr = process.argv[2];
    if (!expr) throw new Error('usage: BUNKO_SESSION=<会の名> node scripts/tools/cdp-page.js "<式>"');
    if (!process.env.BUNKO_LOCK_IGNORE) {
      const why = require('./deploy-lock').blocker(process.env.BUNKO_SESSION || '');
      if (why) throw new Error(why);
    }
    const cdp = await connect();
    try { console.log(JSON.stringify(await cdp.eval(expr), null, 2)); } finally { cdp.close(); }
  })().catch((error) => { console.error('[NG] ' + error.message); process.exit(1); });
}
