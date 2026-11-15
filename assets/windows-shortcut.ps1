# Writes a Brosr shortcut with the Brosr mark. Windows draws the shortcut, the
# Start entry and a pinned tile from brosr.ico. A running window keeps the Zen
# icon, because the process is zen.exe and Windows reads the icon from it.
param(
  [string]$Zen = "C:\Program Files\Zen Browser\zen.exe",
  [string]$Profile = (Join-Path $PSScriptRoot "..\zen\.runtime\profile"),
  [string]$Room = "http://127.0.0.1:8787/room-b.html?role=host&room=live&peer=host&name=Host",
  [string]$Name = "Brosr room"
)

$icon = Join-Path $PSScriptRoot "brosr.ico"
if (-not (Test-Path $icon)) {
  Write-Error "No icon at $icon. Run node assets/icons.mjs first."
  exit 1
}

$desktop = [Environment]::GetFolderPath("Desktop")
$link = Join-Path $desktop "$Name.lnk"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($link)
$shortcut.TargetPath = $Zen
$shortcut.Arguments = "--profile `"$Profile`" --no-remote --new-instance `"$Room`""
$shortcut.IconLocation = "$icon,0"
$shortcut.WorkingDirectory = (Split-Path $Zen)
$shortcut.Description = "Brosr room"
$shortcut.Save()
Write-Output "wrote $link"
