'use strict';
function captionWebUrl(value) {
  if (typeof value !== 'string' || /[\x00-\x20]/.test(value)) throw new Error('URLが不正です');
  const url=new URL(value);
  if (!['https:','http:'].includes(url.protocol) || url.username || url.password) throw new Error('WebのURLだけを開けます');
  return url.href;
}
module.exports={captionWebUrl};
