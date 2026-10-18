'use strict';

// `node --test "test/*.test.js"` は、当たるファイルが 0 件でも
// 「tests 0 / 終了コード 0」で成功として終わる (実測)。
// 綴りの取り違え・場所の移動・別の作業場所からの起動で試験が丸ごと消えても、
// npm test は緑のまま通ってしまう。走る前に一度だけ数を検める。

const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'test');
const MIN = 20; // 今 37 本。半分以下に減ったら取り違えを疑う

let names = [];
try {
  names = fs.readdirSync(dir).filter((name) => name.endsWith('.test.js'));
} catch (error) {
  console.error(`[check-tests] test/ を読めません: ${(error && error.message) || error}`);
  process.exit(1);
}

if (names.length < MIN) {
  console.error(`[check-tests] 試験が ${names.length} 本しかありません (最低 ${MIN} 本のはず)。`);
  console.error('[check-tests] 走らせる場所か、ファイルの綴りを確かめてください。');
  process.exit(1);
}

console.log(`[check-tests] ${names.length} 本を走らせます`);
