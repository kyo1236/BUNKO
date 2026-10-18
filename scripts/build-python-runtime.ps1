<#
.SYNOPSIS
  third_party\kemono-dl を動かすための、埋め込み版 Python ランタイムを third_party\python に構築する。

.DESCRIPTION
  配布先の PC にシステム Python が入っている保証は無いので、python.org 配布の
  「埋め込み用 zip (embeddable package)」を third_party\python に展開して同梱する。
  埋め込み版には pip が入っていないため、依存パッケージのインストールだけは
  ホスト側 (このマシンの通常版 Python) の pip に --target で行わせ、
  結果を埋め込み版の Lib\site-packages に置く。

  ダウンロード元は python.org の固定 URL のみ。取得した zip は SHA256 で照合する
  ($ZIP_SHA256 を埋めていれば厳格に検証、空なら警告のみで先へ進む)。
  改ざん・差し替え検知と、更新時に「今 落ちてくる物」が意図した版かの確認を兼ねる。

  実行のたびに third_party\python を空にしてから作り直すので、何度流しても
  結果は同じになる (冪等)。手元の Lib\site-packages に前回のゴミが残らない。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-python-runtime.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# ── バージョン固定 ─────────────────────────────────────────────────
# 更新するときはここだけ書き換える。ZIP_SHA256 は空のまま一度実行すると
# 実測値が画面に出るので、それをここへ貼り直してから使うこと。
$PY_VERSION = '3.13.14'
$ZIP_SHA256 = '90B4E5B9898B72D744650524BFF92377C367F44BD5FBD09E3148656C080AD907'

# 版に紐づく綴りは $PY_VERSION から導く。python313._pth / python313.zip /
# py -3.13 をベタ書きすると、版を上げたときに書き換え漏れた 1 箇所だけが
# 古い綴りのまま残り、「展開は通ったのに import できない」形で後から転ぶ
$PY_PARTS = $PY_VERSION.Split('.')
# 埋め込み版のファイル名に埋まる綴り (3.13 → 313)
$PY_TAG = "$($PY_PARTS[0])$($PY_PARTS[1])"
# py ランチャーに渡す版の指定 (3.13 → -3.13)
$PY_LAUNCHER_TAG = "-$($PY_PARTS[0]).$($PY_PARTS[1])"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$RuntimeDir = Join-Path $RepoRoot 'third_party\python'
$RequirementsFile = Join-Path $PSScriptRoot 'python-runtime-requirements.txt'
$DownloadUrl = "https://www.python.org/ftp/python/$PY_VERSION/python-$PY_VERSION-embed-amd64.zip"

function Resolve-HostPython {
  # 埋め込み版には pip が無いので、依存パッケージの取得だけホストの
  # 通常版 Python にやらせる。入れる物は純 Python の wheel (requests / bs4 とその依存) なので、
  # ホストの版は埋め込み版と揃っていなくてよい。順に: 環境変数 BUNKO_HOST_PYTHON →
  # py ランチャーの同じ版 → py の 3 系 → PATH の python。
  # 戻り値は python.exe そのものの単一パス (配列で返すと呼び出し側で
  # 1 要素配列がスカラーに潰れる PowerShell の罠を踏むため、あえて避ける)
  if ($env:BUNKO_HOST_PYTHON -and (Test-Path -LiteralPath $env:BUNKO_HOST_PYTHON)) {
    return $env:BUNKO_HOST_PYTHON
  }
  $pyLauncher = Get-Command py -ErrorAction SilentlyContinue
  if ($pyLauncher) {
    # 2>$null は付けない。PS 5.1 では native コマンドの stderr を明示的に
    # 振り替えると各行が ErrorRecord に包まれ、$ErrorActionPreference='Stop'
    # の下では NativeCommandError として投げられる: 望みの版が入っていない
    # だけで、下の案内まで道連れになる。握り潰すのは try/catch の役目
    $resolved = $null
    try {
      $resolved = & py $PY_LAUNCHER_TAG -c "import sys; print(sys.executable)"
    } catch {
      $resolved = $null
    }
    if ($LASTEXITCODE -eq 0 -and $resolved) {
      # 複数行返ってきても先頭だけ採る (単一パスで返す約束を守る)
      return ([string]($resolved | Select-Object -First 1)).Trim()
    }
    $resolved = $null
    try {
      $resolved = & py -3 -c "import sys; print(sys.executable)"
    } catch {
      $resolved = $null
    }
    if ($LASTEXITCODE -eq 0 -and $resolved) {
      return ([string]($resolved | Select-Object -First 1)).Trim()
    }
  }
  $onPath = Get-Command python -ErrorAction SilentlyContinue
  if ($onPath) {
    $resolved = $null
    try {
      $resolved = & python -c "import sys; print(sys.executable)"
    } catch {
      $resolved = $null
    }
    if ($LASTEXITCODE -eq 0 -and $resolved) {
      return ([string]($resolved | Select-Object -First 1)).Trim()
    }
  }
  throw "ホストの Python が見つかりません (py も PATH の python も無い)。python.org の通常版 Python を入れるか、環境変数 BUNKO_HOST_PYTHON に python.exe の道を入れてから流し直すこと"
}

if (-not (Test-Path -LiteralPath $RequirementsFile)) {
  throw "requirements が見つかりません: $RequirementsFile"
}

$tempDir = Join-Path $env:TEMP ('bookshelf-py-embed-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
$zipPath = Join-Path $tempDir "python-$PY_VERSION-embed-amd64.zip"

try {
  Write-Host "ダウンロード: $DownloadUrl"
  Invoke-WebRequest -Uri $DownloadUrl -OutFile $zipPath -UseBasicParsing

  $actualHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash
  Write-Host "SHA256 (実測): $actualHash"
  if ($ZIP_SHA256) {
    if ($actualHash -ne $ZIP_SHA256.ToUpperInvariant()) {
      throw "SHA256 が一致しません。期待=$ZIP_SHA256 実測=$actualHash (差し替え or バージョン不一致の疑い)"
    }
    Write-Host 'SHA256 検証: OK'
  } else {
    Write-Warning "ZIP_SHA256 が空なので検証をスキップしました。上の実測値をスクリプト先頭の `$ZIP_SHA256 に埋めてください。"
  }

  # third_party\python を空にしてから展開し直す (冪等にするため)
  if (Test-Path -LiteralPath $RuntimeDir) {
    Remove-Item -LiteralPath $RuntimeDir -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
  Expand-Archive -LiteralPath $zipPath -DestinationPath $RuntimeDir -Force
} finally {
  Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}

# 埋め込み版の既定の python313._pth は zip 自身と site-packages 探索を絞っているので、
# 同梱した Lib\site-packages を見に行けるよう書き換える。BOM 付きだと Python 側の
# _pth パーサがそのまま解釈できてしまう保証がないので、BOM 無し UTF-8 で書く
# (config.json を BOM 付きで壊した過去の教訓と同じ理由)
$pthPath = Join-Path $RuntimeDir "python$PY_TAG._pth"
$pthContent = "python$PY_TAG.zip`r`n.`r`nLib/site-packages`r`n"
[System.IO.File]::WriteAllText($pthPath, $pthContent, (New-Object System.Text.UTF8Encoding($false)))

$sitePackagesDir = Join-Path $RuntimeDir 'Lib\site-packages'
New-Item -ItemType Directory -Force -Path $sitePackagesDir | Out-Null

$hostPythonExe = Resolve-HostPython
Write-Host "ホスト Python: $hostPythonExe"
& $hostPythonExe -m pip install --target $sitePackagesDir -r $RequirementsFile --no-warn-script-location
if ($LASTEXITCODE -ne 0) {
  throw "pip install が失敗しました (exit $LASTEXITCODE)"
}

# Windows では使わない実行スクリプト置き場やキャッシュを削って軽くする
foreach ($name in @('bin', '__pycache__')) {
  $stale = Get-ChildItem -LiteralPath $sitePackagesDir -Recurse -Directory -Filter $name -ErrorAction SilentlyContinue
  foreach ($dir in $stale) {
    if (Test-Path -LiteralPath $dir.FullName) {
      Remove-Item -LiteralPath $dir.FullName -Recurse -Force
    }
  }
}

# 検煙: この4つが import できれば kemono-dl 本体を動かすのに足りる
$pythonExe = Join-Path $RuntimeDir 'python.exe'
$smoke = & $pythonExe -B -c "import requests, bs4, sqlite3, ssl; print('ok')"
if ($LASTEXITCODE -ne 0 -or $smoke -ne 'ok') {
  throw "検煙に失敗しました: $smoke"
}
Write-Host "検煙: OK ($smoke)"
Write-Host "完了: $RuntimeDir"
