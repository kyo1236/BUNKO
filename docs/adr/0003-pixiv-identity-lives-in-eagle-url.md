# pixiv の本の同一性は名前でなく Eagle の url に持つ

pawchive の本はファイル名の `[投稿 ID]` で同一性を持つが、利用者は pixiv の本の題に ID を付けたくない。
そこで pixiv の本は Eagle の url 欄に `https://www.pixiv.net/artworks/<投稿 ID>` を持たせ、
名前は題だけにする (メモに投稿日・頁数・シリーズ)。走査の控えは url を既に運んでいるので、
所持の照合は url から読む。この形は見張りフォルダでは作れないため、Eagle へは API の `item/addFromPath` で入れる。

## 帰結

- Eagle が母艦で起動している時だけ取り込みが進む (止まっていれば待つ)
- 既にある PPD 形の 106 投稿は古い名前から ID を読み、url を API で一度だけ書いて揃える。名前の変更は API に無いので手で直す
