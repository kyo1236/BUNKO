<#
.SYNOPSIS
  BUNKO を「ログイン時に --read-only --data-dir=<ミラー> で自動起動」させる (Homecore 用)。

.DESCRIPTION
  HKCU の Run キーに登録するだけの簡単な仕組み。管理者権限は不要。
  インストーラーと一緒に配られる (インストール先の resources\scripts\ に入る)。
  その場合は隣の BUNKO.exe を自動で見つける。

  -DataDir は母艦の sync-to-homecore.ps1 が書くミラー置き場。Homecore 実機では
  母艦から見た <写しの置き場> が Homecore 自身のローカルディスク上のパスに
  見えるはずなので、実機のローカルパスで指定すること。空文字 ('') を渡すと
  --data-dir を付けず、従来どおり %APPDATA%\hitomi-box を読む登録になる。

  同じ内容を「起動用の一枚」(%APPDATA%\hitomi-box\config.json の dataDir /
  readOnly) にも書く。BUNKO は起動引数が無いときだけそこを見るので、Run キーを
  通らない素のアイコン起動でも写しモードになる。-Remove はどちらも取り消す。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File enable-readonly-autostart.ps1
.EXAMPLE
  powershell ... -File enable-readonly-autostart.ps1 -DataDir <写しから見た置き場>
.EXAMPLE
  powershell ... -File enable-readonly-autostart.ps1 -Remove
#>
[CmdletBinding()]
param(
  # BUNKO.exe の場所。省略時はインストール先の定番を順に探す
  [string]$ExePath = '',
  # BUNKO に読ませるデータ置き場 (--data-dir)。写しの機体から見た、母艦の同期先の道。
  # 省略すると --data-dir 無し (通常の userData を読み取り専用で開く)
  [string]$DataDir = '',
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$valueName = 'BUNKO-ReadOnly'

# 「起動用の一枚」= %APPDATA%\hitomi-box\config.json。BUNKO は起動引数が何も
# 無いときだけ、ここの dataDir / readOnly を見て置き場とモードを決める。
# Run キーと同じ内容をここにも書いておくと、スタートメニューやデスクトップの
# アイコンから素で起動しても写しモードで立ち上がる。
# 既存の設定はそのまま残し、この 2 つだけ差し替える
function Set-BootConfig {
  param(
    [string]$BootDataDir = '',
    [switch]$Clear
  )

  $bootDir = Join-Path $env:APPDATA 'hitomi-box'
  $bootFile = Join-Path $bootDir 'config.json'
  $boot = [ordered]@{}
  if (Test-Path -LiteralPath $bootFile) {
    try {
      # BOM 付きで書かれていることがある。剥がしてから解く
      $text = [System.IO.File]::ReadAllText($bootFile)
      $existing = ConvertFrom-Json ($text.TrimStart([char]0xFEFF))
      foreach ($property in $existing.PSObject.Properties) { $boot[$property.Name] = $property.Value }
    } catch {
      Write-Warning "起動用の config.json を解けませんでした。触らずに残します: $bootFile"
      return
    }
  } elseif ($Clear) {
    return
  } else {
    New-Item -ItemType Directory -Path $bootDir -Force | Out-Null
  }

  if ($Clear) {
    $boot.Remove('dataDir')
    $boot.Remove('readOnly')
  } else {
    if ($BootDataDir) { $boot['dataDir'] = $BootDataDir } else { $boot.Remove('dataDir') }
    $boot['readOnly'] = $true
  }

  # PS5.1 の -Encoding utf8 は BOM を付ける。BOM 付きの設定ファイルで
  # 中身を失ったことがあるので、必ず BOM なしの UTF-8 で書く
  $json = ConvertTo-Json -InputObject $boot -Depth 20
  [System.IO.File]::WriteAllText($bootFile, $json, (New-Object System.Text.UTF8Encoding $false))
  if ($Clear) {
    Write-Host "起動用の一枚から dataDir / readOnly を外しました: $bootFile"
  } else {
    Write-Host "起動用の一枚にも書きました (素のアイコン起動でも写しモード): $bootFile"
  }
}

if ($Remove) {
  try {
    Remove-ItemProperty -Path $runKey -Name $valueName -ErrorAction Stop
    Write-Host "自動起動を解除しました ($valueName)"
  } catch {
    Write-Host "自動起動は登録されていません ($valueName)"
  }
  # Run キーだけ外して起動用の一枚を残すと、素の起動が写しモードのままになる
  Set-BootConfig -Clear
  exit 0
}

if (-not $ExePath) {
  # resources\scripts\ に置かれた場合、exe は 2 つ上 (インストール先の根)
  $candidates = @(
    (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'BUNKO.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\BUNKO\BUNKO.exe')
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) { $ExePath = $candidate; break }
  }
}
if (-not $ExePath -or -not (Test-Path -LiteralPath $ExePath)) {
  Write-Error 'BUNKO.exe が見つかりません。-ExePath で場所を指定してください。'
  exit 1
}
$ExePath = (Resolve-Path -LiteralPath $ExePath).Path

$arguments = '--read-only'
if ($DataDir) {
  # 空白入りのパスは引数ごと引用する (Run キーの値は CreateProcess にそのまま渡る)
  if ($DataDir -match '\s') {
    $arguments = "$arguments --data-dir=`"$DataDir`""
  } else {
    $arguments = "$arguments --data-dir=$DataDir"
  }
  if (-not (Test-Path -LiteralPath $DataDir)) {
    Write-Warning "DataDir がまだありません: $DataDir (母艦の初回 sync 前なら、このままで問題ありません)"
  }
}

Set-ItemProperty -Path $runKey -Name $valueName -Value "`"$ExePath`" $arguments"
Write-Host "ログイン時に読み取り専用で自動起動するよう登録しました:"
Write-Host "  $valueName = `"$ExePath`" $arguments"
Set-BootConfig -BootDataDir $DataDir
exit 0
