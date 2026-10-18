# src/lib/data/ の出どころとライセンス

コードは MIT (ルートの `LICENSE`) だが、ここのデータは出どころごとに条件が違う。
`search-vocabulary.json` は項目ごとに `evidence[].method` で出どころを持つ。

| ファイル | 出どころ (evidence の method) | 条件 |
|---|---|---|
| `search-vocabulary.json` の `ehtag-translation-name` (660 件) | [EhTagTranslation/Database](https://github.com/EhTagTranslation/Database) の artist / group / character / parody の日本語名。名前の文字列だけ (説明と画像は取っていない) | **CC BY-NC-SA 3.0**。帰属は `ehtag-translation-NOTICE.txt`。この 660 件を含む `search-vocabulary.json` は同じ条件で継承して共有する (非営利・継承) |
| `search-vocabulary.json` の `public-*-translation` / `booru-japanese-tag:*` | [boorutan/booru-japanese-tag](https://github.com/boorutan/booru-japanese-tag) の `danbooru-jp.csv` / `danbooru-machine-jp.csv` | MIT (`booru-japanese-tag-LICENSE.txt`) |
| `search-vocabulary.json` の `danbooru-artist-record` / `danbooru-wiki-other-names` と `aliases.json` (`danbooru-tag-wikis+hitomi-alltags`) | Danbooru の公開 API (`tags.json` / `artists.json`) の名前・別名・件数と、hitomi の全語一覧 (`alltags-*.html` / `tagindex`) の語と件数 | 事実の一覧 (名前と数) で、wiki の本文は取っていない。Danbooru も hitomi もデータ全体への明示ライセンスを公示していない。利用条件は各サイトに従う |
| `search-vocabulary.json` の `tagindex-exact` / `anilist-official-title` | hitomi の tagindex と AniList の公式題 | 事実の一覧 (語・題・件数) |
| `label-overrides.json` / `manual-aliases.json` | 手で選んだ表示名 (hitomi の全語一覧を 2026-08 に監査した物) | MIT |

`search-vocabulary.json` の `sources[]` に各取得の URL・取得日・ハッシュがある。取り直す台本は `scripts/README.md`「検索の語彙」。
