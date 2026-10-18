const expr = process.argv[2];
if (!expr) {
  console.error('usage: BUNKO_SESSION=<会の名> node scripts/tools/cdp-eval.js <expression>');
  process.exit(1);
}
// 9222 は一つの BUNKO しか持てない。配布の錠を持つ会だけが触る (放送で聞かず錠で決める)。BUNKO_LOCK_IGNORE=1 で見ない
if (!process.env.BUNKO_LOCK_IGNORE) {
  const why = require('./deploy-lock').blocker(process.env.BUNKO_SESSION || '');
  if (why) { console.error('[NG] ' + why); process.exit(1); }
}

(async () => {
  const list = await (await fetch('http://127.0.0.1:9222/json')).json();
  const page = list.find((item) => item.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) pending.get(message.id)(message);
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, (message) => {
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluated = await send('Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  });
  console.log(JSON.stringify(evaluated.result.value ?? evaluated.result, null, 2));
  ws.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
