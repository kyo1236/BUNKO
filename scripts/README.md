# scripts/

台本の置き場の地図。**npm・梱包・本体・試験から名前で呼ばれる物は直下に据え置き**、
手で叩く使い捨ての調べ道具だけを `tools/` に分けてある (改善の棚卸し 11-8 の形。2026-09-27 に分けた)。
直下の台本を動かす時は、下の表の呼び手も一緒に直すこと。

## 名前で呼ばれる物

| 呼び手 | 台本 |
|---|---|
| npm (`package.json`) | `check-tests.js` (pretest。試験の本数を検める) / `patch-node-hitomi.js` (postinstall) / `build-aliases.js` (aliases・aliases:verify) / `bench-catalog.js` `bench-dupe.js` `bench-archive.js` `bench-media.js` (bench:*) |
| 梱包 (`build.extraResources` → 配布先の `resources\scripts\`) | `sync-to-homecore.ps1` / `enable-readonly-autostart.ps1` |
| 本体 | `sync-to-homecore.ps1` (`src/main.js` の同期の口。開発時は直下のこれを呼ぶ) |
| 試験 | `lan-preview.js` / `build-aliases.js` / `rebuild-aliases.js` / `apply-vocabulary-audit.js` / `import-search-vocabulary.js` / `bench-dupe.js` |
| 試写台の口 | `renderer-preview.js` (18791) / `home-preview.js` (18793) / `lan-preview.js` (18790) |
| 配布 | `sync-to-homecore.ps1` / `register-sync-task.ps1` (下の「Homecore 同期」) |
| 枝の作業木 | `worktree.js` (new / list / sync / merge / remove) |

## 用途で見る

| 用途 | 台本 |
|---|---|
| 試写台 (画面を実機なしで見る) | `renderer-preview.js` 机上版・偽の棚 / `lan-preview.js` 手のひら版・偽の棚 / `lan-desktop-preview.js` 手のひら版を机上の口で・偽の棚 / `search-intent-preview.js` 検索結果候補・偽の源泉 / `home-preview.js` Home・**手元の台帳と控えを読むだけ** (Eagle の項目のファイルは開かない) |
| 検索の語彙 (辞書の組み立て) | `build-aliases.js` / `rebuild-aliases.js` / `repair-aliases.js` / `audit-label-overrides.js` / `audit-paren-labels.js` / `apply-vocabulary-audit.js` / `apply-vocabulary-gaps.js` / `enrich-series-vocabulary.js` / `import-search-vocabulary.js` / `japanese-script.js` / `vocab-collect.js` / `vocab-crosssite.js` / `vocab-check.js` / `vocab-agent-bridge.js`。調べの材料は `work/` にある |
| Home の作者の結び | `home-link-survey.cjs` / `home-link-verify.cjs` / `home-link-codex.cjs` / `home-title-survey.cjs` |
| 速さを測る | `bench-*.js` (`bench-pdf.js` だけは npm に無く手で叩く。合成した頁で測る) |
| 二台の運用 | `sync-to-homecore.ps1` / `register-sync-task.ps1` / `enable-readonly-autostart.ps1` |
| 同梱物 (版に入れない) | `setup-third-party.js` (`npm run setup`。kemono-dl を上流から取って `third_party/kemono-dl.patch` を当て、Python は下を呼ぶ) / `build-python-runtime.ps1` + `python-runtime-requirements.txt` |

## tools/ (手で叩く道具)

**繰り返す仕事の道具** (考えずに走らせる物):

| 台本 | 何をするか |
|---|---|
| `replace-exact.js` | 完全一致の置換。一回だけ当たる時に置き、CRLF と BOM を保つ (`<file> <spec.json>` か `--from/--to`) |
| `asar-check.js` | 組み上がりの app.asar に「その回の新しい名前」が入っているか |
| `wait-catalog-idle.js` | 台帳 (catalog.sqlite) の書き出しが落ち着くまで待つ (同期の前) |
| `preview-shots.js` / `contrast.js` | 試写台の写真 (画面 × 主題) と字の対比。playwright MCP の run_code に filename で渡す |
| `tidy-root.js` | 作業木の直下の一時物 (.tmp-* など) を `_tmp/leftovers-<日付>/` へ寄せる |
| `local-config.js` | 機体固有の道 (`mothership` / `mirror` / `mirrorData` / `repo`) を母屋の `bunko.local.json` から引く。版に入れない。雛形は `bunko.local.example.json` |
| `deploy-lock.js` | 配布の錠 (take / free / show / check)。組む・配る・9222 の前に取り、終わったら空ける。他の会には放送しない。deploy.ps1 (-Owner) と cdp-eval.js (BUNKO_SESSION) が検める |
| `mothership.js` | 母艦の BUNKO を起こし直す。`probe <会の名>` で `--read-only --remote-debugging-port=9222`、`plain` で素 (試験の後は必ず)、`status` |
| `cdp-page.js` | 9222 の本窓 (題「文匣」。隠れた焼き窓 baker を掴まない) へ繋ぐ口。`node cdp-page.js "<式>"` で式も投げられる (錠を持つ会だけ) |
| `ui-probe.js` (+ `-kit` `-plan` `-jev` `-report`) | 走っている母艦の釦を CDP の本物のマウスで押し、反応・空白・ずれ・動き・コマ落ち・主スレッドの詰まり・戻りを測る。`--jev` で Jev に「役目どおりか」を見立ててもらう。押すのは `ui-probe-plan.js` の名簿だけ。設定は頭で控えて終わりに戻す |
| `cdp-profile.js` | 一つの操作のあいだ CPU を測り、時間を食った関数 (名前と src の行) を出す。ui-probe で long-task の旗が立った時に |
| `jev.js` | Jev (TypeSafe) を呼ぶ口。キーは母屋の `Jev-API_key.txt` から台本だけが読む (会は開かない)。`ping` / `ask <req.json>` |

**使い捨ての調べ道具** (どこからも呼ばれない):**網へ実際に通信する物が混ざっている** (probe-* は hitomi・nhentai・E-Hentai・Pawchive へ投げる)
ので、中身を読まずに一括で回さないこと。

| 台本 | 何をするか |
|---|---|
| `probe.js` `probe-multi.js` `probe-alias.js` `probe-sort.js` `probe-sort2.js` `probe-sites.js` `probe-paw.js` | 源泉の応答や並びを一度だけ確かめた跡 (実通信) |
| `probe-catalog.js` | electron を差し替えて台帳を手元で開く (userData は `_tmp/`) |
| `cdp-eval.js` / `cdp-inspect.js` | `--remote-debugging-port=9222` で起こした BUNKO へ CDP で式を投げる・画面の様子を撮る |
| `check-virtual-grid.js` | 一覧の仮想化の高さを electron の窓で測る検証台 |

---

## Homecore 同期と読み取り専用自動起動

母艦 (メイン PC) が唯一の書き手。Homecore (`D:` = `<共有>`) に写しを置き、
Homecore 側の BUNKO は `--read-only` で立てて iPhone から lan/ 画面を読む構成。

### 何を写すか (実データ配置はコードで確認済み)

| 対象 | 実体 (母艦) | 扱い |
|---|---|---|
| 棚 DB | `%APPDATA%\hitomi-box\catalog.sqlite` (src/lib/catalog.js) | **写す**。最後に一時名コピー → rename |
| 焼き頁 | `%APPDATA%\hitomi-box\media-cache\img` (src/main.js → media-cache。`cache` は Chromium の Cache と同じフォルダになり起動ごとに消されるので使わない) | **写さない (既定)**: Homecore はローカルのメディアから必要時に自前で焼ける。/MIR で写すと写し側の焼き溜めを消すため。`-IncludePageCache` で写すことも可 |
| paw 台帳 | `%APPDATA%\hitomi-box\paw-favorites.txt` / `paw-links.json` | 写す (小物) |
| メディア実体 | `<Eagle ライブラリ>`、`<取り込み口>` (実機 config.json) | **写さない**: すでに Homecore 共有上にある。母艦ローカルに移したら `-MediaDirs` で指定 |
| 読書位置 | `%APPDATA%\hitomi-box\reading.json` (src/lib/reading-store.js) | **写さない** (方式(b): Homecore 側が自分の位置を持つ)。robocopy にも /XF で保険 |
| 機体ごとの物 | `config.json` / `jobs.json` | 写さない (/XF) |

送り先の形は userData と同じ並び (Homecore 側が `--data-dir=<送り先>` でそのまま読める形):

```
<写しの置き場>\
  catalog.sqlite       ← 母艦から (rename 差し替え)
  paw-favorites.txt    ← 母艦から
  paw-links.json       ← 母艦から
  media-cache\img\...  ← 母艦から (robocopy /MIR、-IncludePageCache のときだけ)
  reading.json         ← Homecore 固有 (写さない: 方式(b))
  config.json          ← Homecore 固有 (写さない)
  logs\                ← 同期ログ。BUNKO は読まない名前なので同居してよい
  media\               ← -MediaDirs 使用時のみ。同上
```

### 使い方

```powershell
# 手動で一度反映する (-Dest は必須。アプリの釦は設定「同期先」を渡す)
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\sync-to-homecore.ps1 -Dest <写しの置き場>

# 毎時タスク + デスクトップ「文庫を今すぐ反映」ショートカットを登録する
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-sync-task.ps1 -Dest <写しの置き場>

# 解除
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-sync-task.ps1 -Unregister
```

失敗時は非ゼロ exit。ログは `<送り先>\logs\sync-YYYYMMDD.log`。

### Homecore 側の準備

手動取り込みもジャンクションも不要。BUNKO の `--data-dir=<path>` 起動引数で
ミラー置き場をそのままデータディレクトリ (userData) として読ませる。
`reading.json`(読書位置) は同じ場所に Homecore 固有の物として書かれ、
母艦の sync は /XF で写さないので衝突しない。

手順:

1. Homecore に BUNKO をインストールする。
2. インストール先の `resources\scripts\enable-readonly-autostart.ps1` を一度実行する
   (下記)。ログイン時に `--read-only --data-dir=<ミラー>` で自動起動するようになる。
3. 母艦で初回の sync を走らせる (`scripts\sync-to-homecore.ps1`)。
4. Homecore で BUNKO を起動する (ログインし直すか、Run キーと同じ引数で手起動)。

注意:

- `-DataDir` は写しの機体から見た道で指定する (母艦から見た共有パスと、写し自身のローカルの道は違う)。
  省略すると `--data-dir` 無し (通常の userData を読み取り専用で開く)。
- 棚 DB の中の実体パスは母艦の絶対パス (`D:\share\...` 等) のまま。Homecore 側でも
  同じ実体が同じドライブ文字 `D:` で見えるようにしておくこと (割り当て or subst)。
- 母艦が差し替えた `catalog.sqlite` は、起動中の BUNKO には反映されない
  (台帳は起動時に一度だけ読み込む)。Homecore 側 BUNKO の再起動で最新になる。

### ログイン時に --read-only + --data-dir で自動起動 (Homecore 用)

```powershell
# インストール先の resources\scripts\ (リポジトリでは scripts\) にある
powershell -NoProfile -ExecutionPolicy Bypass -File enable-readonly-autostart.ps1 `
  -DataDir <写しから見た置き場>   # ミラーの Homecore 実機パス (省略すると --data-dir 無し)
```

HKCU の Run キーに `"<インストール先>\BUNKO.exe" --read-only --data-dir=<path>` が
登録される。解除は `-Remove`。`-DataDir` を省くと --data-dir 無し (従来どおり
`%APPDATA%\hitomi-box` を読む) の登録になる。

二重起動しても 2 本目は静かに退き、先客の窓が (トレイに畳んでいても) 前に出る。
錠は置き場ごとなので、`--data-dir` の違う写しと素の BUNKO は同居できる。

#### 起動用の一枚 (引数なしでも写しモードにする)

同じスクリプトが `%APPDATA%\hitomi-box\config.json` にも `dataDir` と
`readOnly: true` を書く (既存の設定は読み込んでからこの 2 つだけ差し替え、BOM なし
UTF-8 で保存)。BUNKO は起動引数 (`--data-dir` / `--user-data-dir`) が何も無いときだけ
この一枚を `config.load()` を通さず生読みし (`src/lib/boot-config.js`)、置き場と
読み取り専用を決める。おかげで Run キーを通らない素のアイコン起動でも写しモードで
立ち上がる。引数を付けた起動では一枚は見ない (引数が常に優先)。`-Remove` は Run キーと
この 2 つの両方を取り消す。
