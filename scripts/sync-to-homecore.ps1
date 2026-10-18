<#
.SYNOPSIS
  BUNKO 母艦 -> Homecore 反映 (二段構え)。

.DESCRIPTION
  母艦 (メイン PC) の BUNKO データを Homecore 共有上のミラー置き場へ写す。
  順序が肝:
    第一段: メディア・焼き頁 (かさばる側) を robocopy /MIR で先に。
    第二段: 棚 DB (catalog.sqlite = sql.js の一枚ファイル) を最後に
            一時名でコピーしてから rename で差し替える。閲覧者 (Homecore 側の
            --read-only BUNKO) が書きかけの DB を掴まないため。

  読書位置 (reading.json) は方式(b) によりミラーしない: Homecore 側は自分の
  読書位置を持ち続ける。config.json / jobs.json も機体ごとの物なので写さない。
  robocopy には保険として /XF reading.json config.json jobs.json を常に添える。

  実データ配置 (コードと実機 config.json で確認済み):
    棚 DB     : %APPDATA%\hitomi-box\catalog.sqlite   (src/lib/catalog.js)
    読書位置  : %APPDATA%\hitomi-box\reading.json     (src/lib/reading-store.js) -> 除外
    焼き頁    : %APPDATA%\hitomi-box\media-cache\img  (src/main.js -> media-cache)
    メディア  : Eagle ライブラリほか。共有ディスク上にあって写しからも見える前提なので
                既定では写さない (-MediaDirs で写せる)。
                母艦ローカルにメディアを置く構成になったら -MediaDirs で指定する。

  送り先の形は userData と同じ並び (<Dest>\catalog.sqlite, <Dest>\media-cache\img, ...)。
  Homecore 側は BUNKO を --read-only --data-dir=<Dest> で起動するだけで、この
  ミラーをそのままデータ置き場として読む。reading.json / config.json / jobs.json は
  写さない (/XF) ので、Homecore 固有のそれらが <Dest> 直下に共存できる。
  logs\ と media\ は BUNKO が読まない名前なので同居してよい。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\sync-to-homecore.ps1
.EXAMPLE
  powershell ... -File scripts\sync-to-homecore.ps1 -Dest <写しの置き場> -MediaDirs C:\BUNKO-media
#>
[CmdletBinding()]
param(
  # 送り元: 母艦側 BUNKO の userData (棚 DB と焼き頁の在り処)
  [string]$DataDir = (Join-Path $env:APPDATA 'hitomi-box'),

  # 送り元: ライブラリ実体 (メディア) の根。複数可。既定は空 (上記の通り、
  # Eagle ライブラリ等は既に Homecore 上にある)
  [string[]]$MediaDirs = @(),

  # 送り先: Homecore 共有上のミラー置き場 (無ければ作る)
  # 送り先 (写しの置き場)。必須: アプリの釦は設定の syncDest を渡し、毎時タスクは register-sync-task.ps1 -Dest で焼く
  [string]$Dest = '',

  # 焼き頁キャッシュ (media-cache\img) も写す場合に指定。既定は写さない ──
  # Homecore はローカルのメディアから自分で焼けるし、/MIR は写し側の
  # 焼き溜め (Homecore が自前で焼いた頁) を消してしまうため
  [switch]$IncludePageCache,

  # ログ置き場。既定は <Dest>\logs と母艦側の両方 (項目 6-6)。
  # 送り先だけに置くと、**送り先が見えない失敗こそ一行も残らない**
  [string]$LogDir = ''
)

$ErrorActionPreference = 'Stop'

# 方式(b): 読書位置は Homecore 側の物を守る。機体ごとの設定・ジョブも写さない
$ExcludeFiles = @('reading.json', 'config.json', 'jobs.json')

if (-not $Dest) {
  Write-Error '送り先 (-Dest) が未設定です。アプリの設定「同期先 (写しの置き場)」を入れるか、-Dest を渡してください'
  exit 2
}
if (-not $LogDir) { $LogDir = Join-Path $Dest 'logs' }
# 母艦側の控え。送り先が見えなくてもここには必ず残る
$script:HomeLogDir = Join-Path $DataDir 'logs'
$script:Failed = $false
$script:Log = ''
$script:HomeLog = ''

function Write-Log([string]$Message) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  Write-Host $line
  # 二箇所へ書く。送り先 (Dest) は見えない回があるので、母艦側が本命
  if ($script:HomeLog) {
    try { Add-Content -LiteralPath $script:HomeLog -Value $line -Encoding UTF8 } catch {}
  }
  if ($script:Log) {
    try { Add-Content -LiteralPath $script:Log -Value $line -Encoding UTF8 } catch {}
  }
}

# 同時に二つ走らせない (項目 6-9)。釦・毎時タスク・手打ちの三つの起こし方があり、
# どれにも錠が無かったので、重なると同じ一時名を取り合って半端な控えが残りうる
function Enter-SyncLock {
  $script:Mutex = New-Object System.Threading.Mutex($false, 'Global\BUNKO-sync')
  try {
    if (-not $script:Mutex.WaitOne(0)) {
      Write-Log '[--] 別の同期が走っています。今回は見送ります'
      return $false
    }
  } catch [System.Threading.AbandonedMutexException] {
    # 前の回が畳まずに落ちた。錠は手に入っているので進む
  }
  return $true
}

function Exit-SyncLock {
  if ($script:Mutex) {
    try { $script:Mutex.ReleaseMutex() } catch {}
    try { $script:Mutex.Dispose() } catch {}
    $script:Mutex = $null
  }
}

function Invoke-Mirror([string]$Source, [string]$Target, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Source)) {
    Write-Log "[NG] $Label : 送り元がありません: $Source"
    $script:Failed = $true
    return
  }
  Write-Log "[..] $Label : robocopy /MIR `"$Source`" -> `"$Target`""
  # /MIR: 完全鏡像 (消えた物は消す) / /FFT: 共有先のタイムスタンプ粒度差を吸収
  # /R:2 /W:5: 掴まれていた時に粘りすぎない / /NP /NFL /NDL: ログを要点だけに
  $logArg = '/LOG+:' + $script:Log
  & robocopy $Source $Target /MIR /FFT /R:2 /W:5 /NP /NFL /NDL /XF $ExcludeFiles $logArg | Out-Null
  $code = $LASTEXITCODE
  # robocopy の戻り値: 0-7 は成功 (差分の有無など)、8 以上が失敗
  if ($code -ge 8) {
    Write-Log "[NG] $Label : robocopy が失敗しました (exit $code)"
    $script:Failed = $true
  } else {
    Write-Log "[OK] $Label (robocopy exit $code)"
  }
}

# 棚 DB など「一枚物」の差し替え: 一時名でコピー -> rename。
# rename は同一ボリューム内で一息に済むので、閲覧者が書きかけを掴まない
function Copy-ThenRename([string]$Source, [string]$TargetDir, [switch]$Required) {
  $name = Split-Path -Leaf $Source
  if (-not (Test-Path -LiteralPath $Source)) {
    if ($Required) {
      Write-Log "[NG] $name : 送り元がありません: $Source"
      $script:Failed = $true
    } else {
      Write-Log "[--] $name : 送り元に無いので飛ばします"
    }
    return
  }
  try {
    if (-not (Test-Path -LiteralPath $TargetDir)) {
      New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
    }
    # 一時名は「.tmp を含まない」こと: BUNKO 起動時の掃除 (src/lib/catalog.js) が
    # catalog.sqlite.*tmp* を書きかけの残骸とみなして消すため、.tmp-sync だと
    # Homecore 側の起動と重なった時にコピー途中の一時ファイルを消されうる
    # 一時名は走りごとに変える。固定名だと、重なって走った二つが
    # 同じ一時ファイルを取り合い、半端な中身を rename しうる (項目 6-9)
    $temp = Join-Path $TargetDir ($name + '.sync-part-' + $PID)
    $final = Join-Path $TargetDir $name
    Copy-Item -LiteralPath $Source -Destination $temp -Force
    Move-Item -LiteralPath $temp -Destination $final -Force
    Write-Log "[OK] $name -> $final"
  } catch {
    Write-Log "[NG] $name : $($_.Exception.Message)"
    $script:Failed = $true
  }
}

try {
  # 母艦側の記録を先に開く。送り先が見えない回でも、ここには必ず残る (項目 6-6)
  try {
    New-Item -ItemType Directory -Force -Path $script:HomeLogDir | Out-Null
    $script:HomeLog = Join-Path $script:HomeLogDir ('sync-{0}.log' -f (Get-Date -Format 'yyyyMMdd'))
  } catch {
    $script:HomeLog = ''
  }

  if (-not (Enter-SyncLock)) { exit 0 }

  if (-not (Test-Path -LiteralPath $DataDir)) {
    Write-Log "[NG] DataDir がありません: $DataDir"
    exit 1
  }

  # 送り先が見えないときは、ここで理由を残してから止まる。
  # 以前は New-Item が投げて記録の口すら開かないまま落ちていた
  try {
    New-Item -ItemType Directory -Force -Path $Dest, $LogDir | Out-Null
    $script:Log = Join-Path $LogDir ('sync-{0}.log' -f (Get-Date -Format 'yyyyMMdd'))
  } catch {
    Write-Log "[NG] 送り先を開けません: $Dest ($($_.Exception.Message))"
    exit 1
  }
  Write-Log "==== BUNKO 同期開始: $DataDir -> $Dest ===="

  # ── 第一段: メディア・焼き頁 (robocopy /MIR) ─────────────────────────
  foreach ($media in $MediaDirs) {
    $leaf = Split-Path -Leaf ($media.TrimEnd('\'))
    Invoke-Mirror $media (Join-Path (Join-Path $Dest 'media') $leaf) "メディア ($leaf)"
  }
  if ($IncludePageCache) {
    $pageCache = Join-Path $DataDir 'media-cache\img'
    if (Test-Path -LiteralPath $pageCache) {
      Invoke-Mirror $pageCache (Join-Path $Dest 'media-cache\img') '焼き頁 (media-cache\img)'
    } else {
      Write-Log '[--] 焼き頁 (media-cache\img) がまだ無いので飛ばします'
    }
  } else {
    Write-Log '[--] 焼き頁は写しません (Homecore が自前で焼く。-IncludePageCache で写せる)'
  }

  # ── 第二段: 棚 DB (最後に、一時名コピー -> rename) ────────────────────
  # 走査の控え (Eagle の全 .info の一覧)。読み手はこれでアイテムの実在を引き、
  # ライブラリへ行ごとに訊かずに済む。棚 DB より先に写す: 読み手の見張りは
  # catalog.sqlite の差し替えで読み直すので、その時点で控えも新しくなっていること
  Copy-ThenRename (Join-Path $DataDir 'eagle-scan-cache.json') $Dest
  # userData と同じ並びで <Dest> 直下に置く (--data-dir=<Dest> がそのまま読める形)
  Copy-ThenRename (Join-Path $DataDir 'catalog.sqlite') $Dest -Required
  # pawchive の小さな台帳。読み手にあると便利だが、無くても致命ではない
  Copy-ThenRename (Join-Path $DataDir 'paw-favorites.txt') $Dest
  Copy-ThenRename (Join-Path $DataDir 'paw-links.json') $Dest
  # pixiv の所持の台帳 (投稿 ID <-> Eagle 項目)。写しの手のひら版が pixiv の本を見分けるのに使う
  Copy-ThenRename (Join-Path $DataDir 'pixiv-library.json') $Dest
  # hitomi / nhentai の名乗りと作者の結び (Home の詳細で結ぶ)。写しの Home がつながりの印を出すのに使う
  Copy-ThenRename (Join-Path $DataDir 'creator-links.json') $Dest
  # 名前に日付の無い所持の本の公開日 (網で見つけた物)。写しの Home の作者頁が年表に並べるのに使う
  Copy-ThenRename (Join-Path $DataDir 'release-dates.json') $Dest
  # AI 作品の生成情報の控え (better-sqlite3 の一枚ファイル)。写しの読む画面の板と札の印が使う。母艦が止まっている間に写す
  Copy-ThenRename (Join-Path $DataDir 'ai-meta.sqlite') $Dest

  # 旧レイアウト (<Dest>\data\catalog.sqlite) の残骸があれば知らせる (自動では消さない)
  if (Test-Path -LiteralPath (Join-Path $Dest 'data\catalog.sqlite')) {
    Write-Log "[--] 旧レイアウトの $((Join-Path $Dest 'data')) が残っています。--data-dir は <Dest> 直下を読むので、確認のうえ手で削除してください"
  }

  if ($script:Failed) {
    Write-Log '==== 同期は失敗を含んで終了 ===='
    exit 1
  }
  Write-Log '==== 同期完了 ===='
  exit 0
} catch {
  Write-Log "[NG] 予期しない失敗: $($_.Exception.Message)"
  exit 1
} finally {
  Exit-SyncLock
}
