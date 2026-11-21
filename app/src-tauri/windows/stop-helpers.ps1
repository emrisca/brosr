param(
  [string]$InstallDir
)

if ([string]::IsNullOrWhiteSpace($InstallDir)) {
  exit 0
}

try {
  $root = [System.IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
} catch {
  exit 0
}

$appExe = "$root\Brosr.exe"
$resourcesPrefix = "$root\resources\"

function Get-BundledProcesses {
  param(
    [string]$AppPath,
    [string]$ResourcesPath
  )

  try {
    return @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
      $exe = $_.ExecutablePath
      $exe -and (
        $exe.Equals($AppPath, [System.StringComparison]::OrdinalIgnoreCase) -or
        $exe.StartsWith($ResourcesPath, [System.StringComparison]::OrdinalIgnoreCase)
      )
    } | ForEach-Object {
      [pscustomobject]@{ Pid = $_.ProcessId; Path = $_.ExecutablePath }
    })
  } catch {
    return @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
      $exe = $_.Path
      $exe -and (
        $exe.Equals($AppPath, [System.StringComparison]::OrdinalIgnoreCase) -or
        $exe.StartsWith($ResourcesPath, [System.StringComparison]::OrdinalIgnoreCase)
      )
    } | ForEach-Object {
      [pscustomobject]@{ Pid = $_.Id; Path = $_.Path }
    })
  }
}

for ($round = 0; $round -lt 5; $round++) {
  $matches = @(Get-BundledProcesses -AppPath $appExe -ResourcesPath $resourcesPrefix)
  if ($matches.Count -eq 0) {
    break
  }

  # Stop Brosr.exe first so its polling timers cannot spawn another node.exe
  # while we terminate the bundled Node and relay helpers.
  $ordered = @($matches | Sort-Object {
    if ($_.Path.Equals($appExe, [System.StringComparison]::OrdinalIgnoreCase)) { 0 } else { 1 }
  })

  foreach ($proc in $ordered) {
    & "$env:SystemRoot\System32\taskkill.exe" /PID $proc.Pid /T /F 2>$null | Out-Null
  }

  Start-Sleep -Milliseconds 300
}

exit 0
