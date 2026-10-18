# Rebuild the working copy and restart its test window (own profile, debug port 9223).
# Only touches Electron processes started from prism-work, never the everyday Prism.
param([switch]$NoBuild)
$work = Split-Path $PSScriptRoot -Parent
Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$work\*" } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 800
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Remove-Item Env:\ELECTRON_NO_ATTACH_CONSOLE -ErrorAction SilentlyContinue
if (-not $NoBuild) {
  Push-Location $work
  $out = & node node_modules\electron-vite\bin\electron-vite.js build 2>&1 | Out-String
  Pop-Location
  if ($LASTEXITCODE -ne 0) { $out -split "`n" | Select-Object -Last 25; throw 'build failed' }
}
$env:PRISM_USER_DATA = "$env:APPDATA\prism-dev"
$env:PRISM_DEBUG_PORT = '9223'
$env:ELECTRON_ENABLE_LOGGING = '1'
$log = "$env:TEMP\prism-test.log"
$p = Start-Process -FilePath "$work\node_modules\electron\dist\electron.exe" -ArgumentList '.' -WorkingDirectory $work -RedirectStandardOutput $log -RedirectStandardError "$log.err" -PassThru
Start-Sleep -Seconds 7
"test window pid $($p.Id), running: $(-not $p.HasExited)"
