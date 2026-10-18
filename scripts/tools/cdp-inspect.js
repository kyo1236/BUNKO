const fs = require('fs');

(async () => {
  const list = await (await fetch('http://127.0.0.1:9222/json')).json();
  const page = list.find((item) => item.type === 'page');
  if (!page) throw new Error('no page');

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
    expression: `({
      cards: document.querySelectorAll('.card').length,
      loaded: [...document.querySelectorAll('.cover img')].filter((img) => img.naturalWidth > 0).length,
      broken: [...document.querySelectorAll('.cover img')].filter((img) => img.complete && img.naturalWidth === 0).length,
      meta: document.querySelector('#result-meta').textContent,
      status: document.querySelector('#status').textContent,
      statusHidden: document.querySelector('#status').hidden,
      firstTitle: document.querySelector('.card-title') && document.querySelector('.card-title').textContent,
      firstSrc: document.querySelector('.cover img') && document.querySelector('.cover img').src
    })`,
    returnByValue: true,
  });

  console.log(JSON.stringify(evaluated.result.value, null, 2));

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync('_tmp', { recursive: true });
  fs.writeFileSync('_tmp/ui.png', Buffer.from(shot.data, 'base64'));
  console.log('screenshot saved');
  ws.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
