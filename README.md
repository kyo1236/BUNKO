# 文匣 (BUNKŌ)

BUNKO is a personal Electron desktop app for Windows: search hitomi / nhentai / pixiv / Pawchive in one window,
and read the books you already own in an [Eagle](https://eagle.cool/) library. Japanese UI. MIT licensed
(some bundled data has its own terms, see below).

hitomi / nhentai / pixiv / Pawchive を一つの画面で探し、Eagle ライブラリにある所持の本を読むための
個人用デスクトップアプリ (Electron、Windows)。一人で使う前提で作ってあるが、他の人が動かせる形にしてある。

- 言葉の定義 (源泉・本・見出し・詳細・読む画面 …) は [CONTEXT.md](CONTEXT.md)
- 設計の決め (なぜそうしたか) は [docs/adr/](docs/adr/)
- コードの識別子 (`hitomi-box` など) は歴史的な物で、画面の言葉とは別

## 前提

| 物 | 何に |
|---|---|
| Windows 10 / 11 | 配布物は Windows だけ。開発も Windows (PowerShell の台本がある) |
| Node.js 22 以降 | 本体と試験 |
| [Eagle](https://eagle.cool/) | 所持の本の置き場。Eagle を起こしておくと API (`127.0.0.1:41595`) で取り込みとタグの書き込みができる |
| 通常版の Python 3.x (`py` 起動器か PATH の `python`) | Pawchive の取り込み (kemono-dl) に使う埋め込み Python を組む時だけ (依存を pip で入れる)。無ければ環境変数 `BUNKO_HOST_PYTHON` に python.exe の道 |

## 動かす

```bash
npm install
npm run setup
npm start
```

- `npm run setup` は版に入れていない同梱物を取る: Pawchive の落とし手 kemono-dl (上流にライセンスが無いので
  本文を持たず、setup の時に上流から取って patch を当てる) と埋め込み Python。網を触るので `npm install` とは別。
  Pawchive を使わないなら省いてよい (取り込みの口が「同梱物が欠けています」と言うだけ)。詳しくは [third_party/README.md](third_party/README.md)。
- `start.bat` をダブルクリックでも起動する。
- 試験は `npm test`。**終了コードではなく `# pass` の数を見る** (`node --test` は当たるファイルが 0 件でも成功で終わる)。

### 初期設定 (設定画面)

| 設定 | 何を |
|---|---|
| Eagle ライブラリ | `xxx.library` フォルダ。所持の判定と読む画面の元 |
| 保存先 / Pawchive の保存先 | 落とした本の置き場 (既定は Downloads の下) |
| Pawchive の作者フォルダ | Pawchive の所持を数える Eagle のフォルダ ID (Eagle でフォルダを開いた時の URL の末尾)。未設定なら数えない |
| pixiv の接続 | pixiv のログイン (refresh token はこの機体の設定にだけ残る) |
| Pawchive のクッキー | ブラウザ拡張で書き出した Netscape 形式のファイルを Downloads に落とすと拾う |
| 端末で読む | 同じ Wi-Fi の電話から読む LAN 配信 (合言葉と QR)。既定は切 |

設定と台帳は `%APPDATA%\hitomi-box` に入る (`config.json` / `catalog.sqlite` / 走査の控え / 読書位置)。

| 起動引数 | 意味 |
|---|---|
| `--read-only` | 書き込みに繋がる口を塞ぐ (写しの起動に使う) |
| `--data-dir=<path>` | 置き場 (userData) を差し替える。写しは `--read-only --data-dir=<写しの置き場>` |
| `--remote-debugging-port=9222` | CDP で画面を操る時だけ (`scripts/tools/`) |

## 二台で使う (任意)

一台を書き手 (母艦: 走査・取り込み・Eagle への書き込み)、もう一台を読み手 (写し: `--read-only`、電話への LAN 配信) にできる。
母艦の設定「同期先 (写しの置き場)」に共有フォルダを入れ、「今すぐ同期」か毎時のタスク (`scripts/register-sync-task.ps1 -Dest <写しの置き場>`)
で台帳を写す。写しは `scripts/enable-readonly-autostart.ps1 -DataDir <写しから見た置き場>` でログイン時に写しモードで上がる。
手順の詳細は [scripts/README.md](scripts/README.md)「Homecore 同期」。

## 組む (配布物)

```bash
npm run setup
npm run dist
```

`dist/win-unpacked` と `dist/BUNKO-Setup-<版>.exe` ができる。同梱物 (`third_party/`) は `resources/` に入る。

## フォルダの地図

| 場所 | 中身 |
|---|---|
| `src/main.js` | 起動・窓・画像の口・所持の本の頁配り |
| `src/main/ipc/` | IPC を役ごとに分けた口 |
| `src/lib/` | 台帳 (`catalog.js`)・Eagle 走査の控え・源泉のアダプタ (`sources/`)・PDF の直読み・LAN の口 |
| `src/lib/data/` | 検索の語彙 (別名・日本語名)。出どころとライセンスは `src/lib/data/licenses/README.md` |
| `src/renderer/` | 机上版の画面。`app.js` 一覧・詳細・設定 / `reader.js` 読む画面 / `bunko-ui.*` 上部と主題 (墨・紺・明) / `home.*` Home |
| `src/lan/` | 手のひら版 (電話から見る一覧と読む画面) |
| `test/` | 試験 (`node --test`)。画面は `test/helpers/vm-dom.js` で vm に載せて試す |
| `scripts/` | 台本。地図は [scripts/README.md](scripts/README.md)。手で叩く調べ道具は `scripts/tools/` |
| `docs/adr/` | 設計の決めの記録 |
| `assets/` | アイコンとインストーラの設定 |
| `third_party/` | 同梱物の置き場 (版に入れない。`npm run setup` が取る) と kemono-dl の patch |
| `work/` `_tmp/` `frames/` `dist/` | 調べの材料・一時物・組み上がり (版に入れない) |
| `bunko.local.json` | 機体固有の道 (版に入れない。雛形は `bunko.local.example.json`) |

## 検索の書き方

| 入力 | 意味 |
| --- | --- |
| `blue_archive` | タイトル語 |
| `female:sole_female` | タグ |
| `-tag:group` | 除外 |
| `language:japanese` | 言語 |
| `type:manga` | 種別 |
| `1234567` | ギャラリー ID |
| `https://hitomi.la/galleries/1234567.html` | hitomi URL |
| `https://nhentai.net/g/123456/` | nhentai (サイトが切り替わる) |
| `https://pawchive.pw/fanbox/user/…/post/…` | Pawchive (FANBOX / Patreon) |

## ライセンスと断り

- コードは MIT ([LICENSE](LICENSE))。
- `src/lib/data/` の一部は別の条件: E-Hentai のタグの日本語名 660 件は
  [EhTagTranslation/Database](https://github.com/EhTagTranslation/Database) 由来で **CC BY-NC-SA 3.0**
  (帰属・非営利・継承)。Danbooru と hitomi から取った語と件数は事実の一覧で明示ライセンスは無い。
  詳しくは [src/lib/data/licenses/README.md](src/lib/data/licenses/README.md)。
- kemono-dl は上流にライセンスが無いので同梱せず、各自が setup で取る ([third_party/README.md](third_party/README.md))。
- 各サイト (hitomi / nhentai / pixiv / Pawchive) の利用規約と、落とした物の扱いは使う人の責任。
  このリポジトリには作品の画像や題を入れない。
