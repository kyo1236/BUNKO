'use strict';

// renderer (app.js / reader.js) と手のひら版 (lan/shelf.js / lan/read.js) を
// vm に載せて振る舞いを見るための土台。
//
// 本体の末尾は `if (!globalThis.__BUNKO_HARNESS__)` で守ってあるので、
// 読んだだけでは走り出さない (棚を引きに行かない・検索を撃たない)。
// 画面の要素は id ごとに一枚の張りぼてを憶えて返す: 同じ id を二度引いても同じ物が返る。
//
// test/reader-lifecycle.test.js:40-79 の形を、123 本の getElementById を持つ
// app.js にも通るように広げた物。
//
// 注意: vm の中で作られた object は原型が別の realm の物になるので、
// assert.deepStrictEqual は中身が同じでも落ちる。JSON を通して値だけ見ること。

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function classList(node) {
  const set = new Set();
  return {
    add(...names) { names.forEach((n) => n && set.add(n)); node.className = [...set].join(' '); },
    remove(...names) { names.forEach((n) => set.delete(n)); node.className = [...set].join(' '); },
    toggle(name, on) {
      const want = on === undefined ? !set.has(name) : !!on;
      if (want) set.add(name); else set.delete(name);
      node.className = [...set].join(' ');
      return want;
    },
    contains(name) { return set.has(name); },
    get length() { return set.size; },
  };
}

// 画面の要素の張りぼて。持っているのは「試験が読む物」だけで、
// 描画はしない (高さも位置も 0)
// autoQuery: querySelector が「訊かれた選択子ぶんの張りぼて」を作って返す。
// innerHTML を組み立てて querySelector で拾い直す作り (confirmDialog など) を
// 動かすために要る。既定は切ってある: `if (!el) return` の早戻りを殺さないため
function element(tag = 'div', { autoQuery = false } = {}) {
  const listeners = new Map();
  const found = new Map();
  const node = {
    tagName: String(tag).toUpperCase(),
    className: '',
    id: '',
    hidden: false,
    disabled: false,
    value: '',
    checked: false,
    textContent: '',
    innerHTML: '',
    title: '',
    src: '',
    href: '',
    max: '',
    min: '',
    scrollTop: 0,
    scrollLeft: 0,
    scrollHeight: 0,
    clientHeight: 0,
    offsetWidth: 0,
    offsetHeight: 0,
    children: [],
    childNodes: [],
    dataset: {},
    style: new Proxy({ setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; }, getPropertyValue(name) { return this[name] || ''; } }, {
      get: (t, k) => (typeof t[k] === 'function' ? t[k].bind(t) : (t[k] || '')),
      set: (t, k, v) => { t[k] = v; return true; },
    }),
    attributes: {},
    parentElement: null,
    firstElementChild: null,
    lastElementChild: null,
    isConnected: true,
    __listeners: listeners,
  };
  node.classList = classList(node);
  node.addEventListener = (type, fn) => {
    const list = listeners.get(type) || [];
    list.push(fn);
    listeners.set(type, list);
  };
  node.removeEventListener = (type, fn) => {
    listeners.set(type, (listeners.get(type) || []).filter((f) => f !== fn));
  };
  node.dispatch = (type, event = {}) => {
    for (const fn of listeners.get(type) || []) fn({ type, target: node, preventDefault() {}, stopPropagation() {}, ...event });
  };
  node.setAttribute = (name, value) => { node.attributes[name] = String(value); };
  node.getAttribute = (name) => (name in node.attributes ? node.attributes[name] : null);
  node.removeAttribute = (name) => { delete node.attributes[name]; };
  node.hasAttribute = (name) => name in node.attributes;
  node.append = (...kids) => kids.forEach((k) => node.appendChild(k));
  node.appendChild = (kid) => {
    if (kid && typeof kid === 'object') { kid.parentElement = node; node.children.push(kid); }
    node.firstElementChild = node.children[0] || null;
    node.lastElementChild = node.children[node.children.length - 1] || null;
    return kid;
  };
  node.insertBefore = (kid) => node.appendChild(kid);
  node.removeChild = (kid) => {
    node.children = node.children.filter((c) => c !== kid);
    node.firstElementChild = node.children[0] || null;
    node.lastElementChild = node.children[node.children.length - 1] || null;
    return kid;
  };
  node.remove = () => { if (node.parentElement) node.parentElement.removeChild(node); };
  node.replaceChildren = (...kids) => { node.children = []; kids.forEach((k) => node.appendChild(k)); };
  node.insertAdjacentHTML = (_where, html) => { node.innerHTML += html; };
  node.querySelector = (selector) => {
    if (!autoQuery) return null;
    const key = String(selector);
    if (!found.has(key)) found.set(key, element(tag, { autoQuery }));
    return found.get(key);
  };
  // querySelectorAll は autoQuery でも空のまま。こちらは「本物の DOM を歩く」
  // 用途で使われるので、張りぼてを一枚返すと歩いた先で落ちる
  node.querySelectorAll = () => [];
  node.closest = () => null;
  node.contains = () => false;
  node.matches = () => false;
  node.focus = () => {};
  node.blur = () => {};
  node.click = () => node.dispatch('click');
  node.scrollIntoView = () => {};
  node.scrollTo = () => {};
  node.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 });
  node.animate = () => ({ finished: Promise.resolve(), cancel() {} });
  return node;
}

function noopObserver() {
  return function Observer() {
    return { observe() {}, unobserve() {}, disconnect() {}, takeRecords: () => [] };
  };
}

function storage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null),
    setItem: (k, v) => map.set(String(k), String(v)),
    removeItem: (k) => map.delete(String(k)),
    clear: () => map.clear(),
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    __map: map,
  };
}

// index.html / reader.html が読む順。先に読む物が後の物の前置きになる
const DEPS = {
  'src/renderer/app.js': [
    'src/renderer/reader.js',
    'src/renderer/downloads-ui.js',
    'src/renderer/dupe-cluster.js',
    'src/renderer/navigation-state.js',
    'src/renderer/virtual-grid.js',
  ],
  'src/lan/read.js': ['src/lan/shelf.js'],
};

// file を vm に読み込む。globals で足りない物を注ぎ、context を返す。
// 前置きの script (index.html と同じ順) も同じ context に読む。
// context.byId(id) でその id の張りぼてを掴める
function loadInVm(file, { globals = {}, html = '', deps, autoQuery = false } = {}) {
  const el = (tag) => element(tag, { autoQuery });
  const nodes = new Map();
  const byId = (id) => {
    const key = String(id);
    if (!nodes.has(key)) {
      const node = el();
      node.id = key;
      nodes.set(key, node);
    }
    return nodes.get(key);
  };

  const body = el('body');
  const documentElement = el('html');
  const document = {
    body,
    documentElement,
    head: el('head'),
    title: '',
    hidden: false,
    visibilityState: 'visible',
    activeElement: null,
    readyState: 'complete',
    cookie: '',
    getElementById: byId,
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementsByClassName: () => [],
    createElement: (tag) => el(tag),
    createDocumentFragment: () => el('fragment'),
    createTextNode: (text) => ({ textContent: String(text) }),
    addEventListener: body.addEventListener,
    removeEventListener: body.removeEventListener,
    dispatchEvent: () => true,
    execCommand: () => false,
    exitFullscreen: () => Promise.resolve(),
    fullscreenElement: null,
  };
  document.documentElement.innerHTML = html;

  const timers = new Set();
  const context = {
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    document,
    navigator: { onLine: true, userAgent: 'harness', clipboard: { writeText: () => Promise.resolve() },
      language: 'ja', maxTouchPoints: 0 },
    location: { href: 'http://harness.test/', search: '', hash: '', pathname: '/', origin: 'http://harness.test',
      protocol: 'http:', host: 'harness.test', reload() {}, assign() {}, replace() {} },
    history: { state: null, length: 1, pushState(s) { this.state = s; }, replaceState(s) { this.state = s; },
      back() {}, forward() {}, go() {} },
    localStorage: storage(),
    sessionStorage: storage(),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
    getComputedStyle: () => ({
      getPropertyValue: () => '',
      gridTemplateColumns: '200px 200px 200px',
      width: '600px',
      height: '800px',
    }),
    ResizeObserver: noopObserver(),
    IntersectionObserver: noopObserver(),
    MutationObserver: noopObserver(),
    requestAnimationFrame: (fn) => { const t = setTimeout(() => fn(Date.now()), 0); timers.add(t); return t; },
    cancelAnimationFrame: (t) => clearTimeout(t),
    requestIdleCallback: (fn) => { const t = setTimeout(() => fn({ timeRemaining: () => 0 }), 0); timers.add(t); return t; },
    cancelIdleCallback: (t) => clearTimeout(t),
    setTimeout: (fn, ms, ...rest) => { const t = setTimeout(fn, ms, ...rest); timers.add(t); return t; },
    clearTimeout,
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); timers.add(t); return t; },
    clearInterval,
    queueMicrotask,
    Promise,
    AbortController,
    Blob,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    Math,
    Date,
    JSON,
    Intl,
    fetch: () => Promise.reject(new Error('harness: fetch は試験ごとに注ぐ')),
    Image: function Image() { return el('img'); },
    CustomEvent: function CustomEvent(type, init) { return { type, ...(init || {}) }; },
    Event: function Event(type) { return { type }; },
    performance: { now: () => Date.now() },
    crypto: { randomUUID: () => 'harness-uuid', getRandomValues: (a) => a },
    // 本体の末尾を走らせない印
    __BUNKO_HARNESS__: true,
    ...globals,
  };
  // window 自身も要素と同じく聞き耳を持つ (lan の棚が scroll を待つ)
  const win = el('window');
  context.addEventListener = win.addEventListener;
  context.removeEventListener = win.removeEventListener;
  context.dispatch = win.dispatch;
  context.innerWidth = 800;
  context.innerHeight = 1200;
  context.devicePixelRatio = 2;
  context.scrollTo = () => {};
  context.scrollY = 0;
  context.screen = { width: 800, height: 1200 };
  context.window = context;
  context.globalThis = context;
  context.self = context;
  vm.createContext(context);

  const root = path.join(__dirname, '..', '..');
  const resolve = (f) => (path.isAbsolute(f) ? f : path.join(root, f));
  const key = String(file).split(path.sep).join('/');
  const order = [...(deps || DEPS[key] || []), file];
  for (const one of order) {
    vm.runInContext(fs.readFileSync(resolve(one), 'utf8'), context, { filename: String(one) });
  }

  context.byId = byId;
  context.__nodes = nodes;
  context.__stopTimers = () => { timers.forEach((t) => { clearTimeout(t); clearInterval(t); }); timers.clear(); };
  return context;
}

// 母屋の口 (preload の window.hitomi) の張りぼて。
// 知らない名前を訊かれたら「何もしない async」を返すので、boot() が
// 口の増減で落ちない。試験は気にする口だけ overrides で差せばよい。
// on〜 で始まる物は「聞き耳を外す関数」を返す約束なので、その形に合わせる
// boot() が実際に引く口の、形だけ本物に合わせた既定。
// 「配列を返す約束の口」に undefined が返ると boot が途中で落ちるので、ここで揃える
const API_DEFAULTS = {
  imageBase: async () => 'http://img.test',
  settings: async () => ({}),
  saveSettings: async () => ({}),
  libraryStatus: async () => ({ owned: 0, withMeta: 0, unmatchedEagle: 0 }),
  search: async () => ({ galleries: [], total: 0, page: 0, pageSize: 24 }),
  downloads: async () => [],
  discovery: async () => ({ galleries: [], total: 0 }),
  lanStatus: async () => ({ running: false }),
  pawBulkStatus: async () => ({ running: false }),
  suggest: async () => [],
  annotate: async (list) => list || [],
  history: async () => [],
  fallbacks: async () => [],
};

function api(overrides = {}) {
  const calls = [];
  const made = new Map();
  const target = { ...API_DEFAULTS, ...overrides };
  const proxy = new Proxy(target, {
    get(store, name) {
      if (typeof name !== 'string') return store[name];
      if (name in store) return store[name];
      if (!made.has(name)) {
        made.set(name, name.startsWith('on')
          ? (() => () => {})
          : ((...args) => { calls.push({ name, args }); return Promise.resolve(undefined); }));
      }
      return made.get(name);
    },
    has() { return true; },
  });
  return { proxy, calls };
}

module.exports = { loadInVm, element, storage, classList, api };
