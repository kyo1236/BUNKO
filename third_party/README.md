# third_party/

同梱するが版 (git) には入れない物の置き場。`npm run setup` (`scripts/setup-third-party.js`) が取り直す。
配布 (`npm run dist`) の前に必ず通すこと (`package.json` の `extraResources` がここを `resources/` へ写す)。

| 置き場 | 何か | 版に入れない理由 |
|---|---|---|
| `kemono-dl/` | pawchive の落とし手 (Python 製 CLI)。`kemono-dl.py` / `requirements.txt` / `src/` | 上流にライセンスが無い (再配布の許しが無い) |
| `python/` | 埋め込み版 CPython 3.13 + `requests` / `beautifulsoup4` | 約 20MB のバイナリ。`scripts/build-python-runtime.ps1` が python.org から取って SHA256 で照合する |
| `kemono-dl.patch` | 上流に当てる差分 (版に入れる) | 利用者自身の改変と文脈行だけなので公開できる |
| `better-sqlite3/electron-v<ABI>-<os>-<arch>/better_sqlite3.node` | 生成情報の控え (`ai-meta.sqlite`) の本体の、Electron 向けの .node。`prebuild-install` が GitHub の prebuild から取る | 約 2MB のバイナリ。node_modules の方は素の node 向けのまま (npm test が読む)。`npmRebuild: false` で builder に入れ替えさせない |

## kemono-dl

- 上流: https://github.com/L4cache/kemono-dl (`AlphaSlayer1964/kemono-dl` のフォーク系列)。
  本家もフォークも LICENSE ファイルが無い (`licenseInfo` は null)。そのためこのリポジトリには本文を置かず、
  setup の時に各自が上流から取る。
- 基点のコミット: `77cdb70ea6ea4c4b1c70e85fb2ebd8d2ec168955` (`origin/main` 上にある)。
- 取るファイル: `kemono-dl.py`、`requirements.txt` (来歴として。実際の依存の固定は `scripts/python-runtime-requirements.txt`)、
  `src/` 一式 (`__pycache__` と `api_test.py` を除く)。
- `kemono-dl.patch` を `git apply --directory=third_party/kemono-dl -p1 --ignore-whitespace` で当てる。

### patch に入っている改変

上流の基点から見た差分を一つの patch にしてある。中身は二層:

1. **Pawchive 対応と台帳の SQLite 化** (利用者自身の改変。`--site-url` / `--file-url` / `--state-db`、
   URL の正規表現に `pawchive.*` を足す、並列で回した時の archive の錠、`.part` を毎塊で書く)。
2. **BUNKO の同梱のための 3 点**:
   - `src/main.py`: Pillow を遅延 import にする (埋め込み Python に Pillow を入れない。`--icon` / `--banner` の時だけ import)。
   - `kemono-dl.py`: 先頭で自分のディレクトリを `sys.path.insert(0, ...)` する
     (埋め込み版は `python313._pth` 構成で、実行スクリプトの場所を sys.path に足さず、PYTHONPATH も無視する)。
   - `src/main.py` の `download_file`: 受信した塊を溜めずにそのまま書く (BUNKO が `.part` の大きさで進み具合を出すため。
     上流は 32MB 溜めてから書くので、一枚落ち切るまで 0 のままだった)。

### 更新の仕方

1. 上流の新しいコミットを基点にしたい時は、`scripts/setup-third-party.js` の `KEMONO_DL_COMMIT` を上げる。
2. `third_party/kemono-dl/` を消して `npm run setup` を流す。patch が当たらなければ手で直し、
   `git diff --no-index --ignore-cr-at-eol <上流の基点の写し> third_party/kemono-dl` で patch を作り直す
   (`a/` `b/` の接頭辞の下がファイルの相対パスになる形に揃える)。
3. この README の基点のコミットと改変の一覧を書き直す。

## python

`scripts/build-python-runtime.ps1` を見ること。ホストに通常版の Python (`py` 起動器か PATH の `python`、無ければ環境変数 `BUNKO_HOST_PYTHON`) が要る
(埋め込み版には pip が無いので、依存の取得だけホストの pip に `--target` でやらせる。入れる物は純 Python の wheel なので版は揃っていなくてよい)。
