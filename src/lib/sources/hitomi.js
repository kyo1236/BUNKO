const service = require('../hitomi-service');

// この置き場の顔。main 側の「外部ブラウザで開いて良い先」もここを集めて決める
const hosts = ['hitomi.la'];

// 画廊 ID を持つ URL の形。galleries/reader/manga/… はどれも同じ番号を指す
const GALLERY_URL = /hitomi\.la\/(?:galleries|reader|manga|doujinshi|artistcg|gamecg|imageset|anime)\/[^\d]*(\d{3,})/i;
const GALLERY_HTML = /hitomi\.la\/.*?(\d{4,})\.html/i;
// URL の形はしていないが番号が埋まっている入力の受け皿 (検索欄への貼り付け向け)
const LOOSE_ID = /(?:^|[^\d])(\d{6,})(?:[^\d]|$)/;

// 検索欄に貼られた URL を「この置き場のこの画廊」と読む。
// 他所の URL なら null を返し、次のアダプタに渡す
function detectUrl(text) {
  const value = String(text);
  const hit = value.match(GALLERY_URL) || value.match(GALLERY_HTML);
  return hit ? { source: 'hitomi', query: hit[1] } : null;
}

// detectUrl より緩い版: 生の番号と、番号だけが混じった文字列も拾う。
// hitomi-service の parseQuery が「これは ID 指定か」を決めるのに使う
function extractGalleryId(raw) {
  const text = String(raw).trim();
  if (/^\d{3,}$/.test(text)) return Number(text);
  const hit = text.match(GALLERY_URL) || text.match(GALLERY_HTML) || text.match(LOOSE_ID);
  return hit ? Number(hit[1]) : null;
}

// hitomi の画廊は他の口と持ち物が違う (isBlocked / hasVideo / 言語の localName など) ので、
// normalize.record() には寄せず hitomi-service の serialize をそのまま出す
function withSource(gallery) {
  if (!gallery || gallery.error) return gallery;
  return { source: 'hitomi', ...gallery, id: gallery.id, sourceId: gallery.id };
}

async function search(payload = {}) {
  const raw = await service.search(payload);
  return { ...raw, galleries: raw.galleries.map(withSource) };
}

async function getGallery(key) {
  return withSource(service.serializeGallery(await service.getGallery(key)));
}

function fetchImage(key, index, options = {}) {
  return service.fetchImage(key, index, options);
}

// 札の補完を持つのはこの口だけ。持たない口は sources/index が黙って飛ばす
function suggestTags(term) {
  return service.suggestTags(term);
}

module.exports = {
  hosts,
  detectUrl,
  extractGalleryId,
  search,
  getGallery,
  fetchImage,
  suggestTags,
  pickTitle: service.pickTitle,
  sanitizeName: service.sanitizeName,
};
