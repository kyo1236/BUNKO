<#
.SYNOPSIS
  BUNKO 同期 (sync-to-homecore.ps1) の毎時タスク登録と、
  デスクトップの「文庫を今すぐ反映」ショートカット作成。

.DESCRIPTION
  実行すると:
    1. タスクスケジューラに毎時のタスク (既定名 'BUNKO Homecore Sync') を登録する。
    2. デスクトップに「文庫を今すぐ反映.lnk」を作る (同じ同期をその場で走らせる)。
  -Unregister でタスクとショートカットを取り除く。

  ※ このスクリプトは「登録するだけ」で、同期そのものはここでは走らせない。
    送り先 (<写しの置き場> 等) の整備が済んでから実行すること。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-sync-task.ps1
.EXAMPLE
  powershell ... -File scripts\register-sync-task.ps1 -Dest <写しの置き場>
.EXAMPLE
  powershell ... -File scripts\register-sync-task.ps1 -Unregister
#>
[CmdletBinding()]
param(
  [string]$TaskName = 'BUNKO Homecore Sync',
  # 同期スクリプト本体 (既定: このスクリプトと同じ場所の sync-to-homecore.ps1)
  [string]$SyncScript = (Join-Path $PSScriptRoot 'sync-to-homecore.ps1'),
  # 同期スクリプトへ渡す送り先 (写しの置き場)。必須
  [string]$Dest = '',
  # 同期スクリプトへ追加で渡す引数 (例: '-MediaDirs C:\BUNKO-media')
  [string]$ExtraArgs = '',
  [string]$ShortcutName = '文庫を今すぐ反映',
  [switch]$NoShortcut,
  [switch]$Unregister
)

$ErrorActionPreference = 'Stop'
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop ($ShortcutName + '.lnk')

if ($Unregister) {
  try {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
    Write-Host "タスクを削除しました: $TaskName"
  } catch {
    Write-Host "タスクは登録されていません: $TaskName"
  }
  if (Test-Path -LiteralPath $shortcutPath) {
    Remove-Item -LiteralPath $shortcutPath -Force
    Write-Host "ショートカットを削除しました: $shortcutPath"
  }
  exit 0
}

if (-not $Dest) {
  Write-Error '送り先 (-Dest) を渡してください (写しの置き場。アプリの設定「同期先」と同じ物)'
  exit 2
}
if (-not (Test-Path -LiteralPath $SyncScript)) {
  Write-Error "同期スクリプトが見つかりません: $SyncScript"
  exit 1
}
$SyncScript = (Resolve-Path -LiteralPath $SyncScript).Path

# -WindowStyle Hidden: 毎時のタスクがコンソール窓を出さないように (項目 6-11)。
# 釦の側は execFile の windowsHide で既に隠している
$argLine = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$SyncScript`" -Dest `"$Dest`""
if ($ExtraArgs) { $argLine = $argLine + ' ' + $ExtraArgs }

# ── 毎時のタスク登録 ──────────────────────────────────────────────
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argLine
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) `
  -RepetitionInterval (New-TimeSpan -Hours 1) `
  -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Description 'BUNKO の棚 DB と焼き頁を Homecore へ毎時反映する' `
  -Force | Out-Null
Write-Host "毎時タスクを登録しました: $TaskName"
Write-Host "  powershell.exe $argLine"

# ── デスクトップのショートカット ─────────────────────────────────
if (-not $NoShortcut) {
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut($shortcutPath)
  $lnk.TargetPath = 'powershell.exe'
  $lnk.Arguments = $argLine
  $lnk.WorkingDirectory = Split-Path -Parent $SyncScript
  $lnk.Description = 'BUNKO の棚 DB と焼き頁を Homecore へいま反映する'
  $icon = Join-Path (Split-Path -Parent $PSScriptRoot) 'assets\icon.ico'
  if (Test-Path -LiteralPath $icon) { $lnk.IconLocation = $icon }
  $lnk.Save()
  Write-Host "ショートカットを作りました: $shortcutPath"
}
exit 0
