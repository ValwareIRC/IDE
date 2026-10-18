# Installs a built Prism over the running one and brings it back up.
#
# Installing shuts the running Prism. At the desk that is a shrug; from the phone app,
# away from the computer, it means the thing you are talking to has gone and cannot be
# brought back. So an upgrade always has to bring Prism back by itself.
#
# The catch, learned the hard way: anything the agent runs is one of Prism's own shell
# jobs, and Prism kills every one of them as it quits (host.dispose -> killAllJobs), so
# a script that installs and then restarts gets killed between the two. It would say
# "installer finished" and then simply stop, leaving Prism shut.
#
# So this registers the real work as a scheduled task and returns at once. A task is
# run by Windows, not by Prism, so nothing in Prism's shutdown can reach it. It writes
# a log, which is the only way to find out afterwards what happened.
#
# Usage:  .\scripts\upgrade.ps1            the newest build in dist (or $PrismDist, scripts/local.ps1)
#         .\scripts\upgrade.ps1 0.21.7     a particular one
#         (-Run is the task calling itself back; do not use it by hand)
param(
  [string]$Version = '',
  [switch]$Run,
  [string]$Log = ''
)

# This computer's own folders, if it keeps them somewhere else: scripts/local.ps1 (not in git)
# can set $PrismDist (where installers and APKs go) and $PrismJavaHome (a Java 21 for the APK).
$work = Split-Path $PSScriptRoot -Parent
$PrismDist = Join-Path $work 'dist'
$PrismJavaHome = $env:JAVA_HOME
if (Test-Path "$PSScriptRoot\local.ps1") { . "$PSScriptRoot\local.ps1" }
$dist = $PrismDist
$installed = "$env:LOCALAPPDATA\Programs\Prism\Prism.exe"
$taskName = 'PrismUpgrade'

function Find-Setup([string]$want) {
  if ($want) { return Get-Item "$dist\Prism-Setup-$want.exe" -ErrorAction SilentlyContinue }
  return Get-ChildItem "$dist\Prism-Setup-*.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
}

# ---------------------------------------------------------------- the work itself
if ($Run) {
  function Say([string]$line) {
    $stamp = (Get-Date).ToString('HH:mm:ss')
    Add-Content -Path $Log -Value "[$stamp] $line" -Encoding utf8
  }
  try {
    $setup = Find-Setup $Version
    if (-not $setup) { Say "no installer for '$Version' in $dist"; return }
    $want = [regex]::Match($setup.Name, 'Prism-Setup-(.+)\.exe').Groups[1].Value
    Say "installing $want"

    Start-Process -FilePath $setup.FullName -ArgumentList '/S' -Wait
    Say 'installer finished'

    # The installer returns before the files have settled, so wait for the version on
    # disk to really be the new one rather than trusting the exit code.
    $deadline = (Get-Date).AddMinutes(4)
    $onDisk = ''
    while ((Get-Date) -lt $deadline) {
      Start-Sleep -Seconds 3
      if (Test-Path $installed) {
        $onDisk = (Get-Item $installed).VersionInfo.FileVersion
        if ($onDisk -eq $want) { break }
      }
    }
    if ($onDisk -ne $want) { Say "FAILED: after 4 minutes the installed Prism is still '$onDisk', not $want"; return }
    Say "installed $onDisk"

    # The installer usually starts it again; if it did not, or it started and died, start it.
    $deadline = (Get-Date).AddMinutes(3)
    while ((Get-Date) -lt $deadline) {
      if (@(Get-Process Prism -ErrorAction SilentlyContinue).Count -gt 0) {
        # give it a moment to get past the splash before believing it
        Start-Sleep -Seconds 6
        if (@(Get-Process Prism -ErrorAction SilentlyContinue).Count -gt 0) {
          Say "Prism $want is up (pids: $((Get-Process Prism | Select-Object -ExpandProperty Id) -join ', '))"
          return
        }
      }
      Say 'starting Prism'
      Start-Process -FilePath $installed | Out-Null
      Start-Sleep -Seconds 8
    }
    Say "FAILED: Prism $want installed but will not stay running"
  } catch {
    Say "FAILED: $_"
  } finally {
    try { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue } catch {}
  }
  return
}

# ---------------------------------------------------------------- handing it to Windows
$setup = Find-Setup $Version
if (-not $setup) { throw "no installer found in $dist" }
$want = [regex]::Match($setup.Name, 'Prism-Setup-(.+)\.exe').Groups[1].Value
$before = if (Test-Path $installed) { (Get-Item $installed).VersionInfo.FileVersion } else { '(none)' }
if ($before -eq $want) { "[upgrade] already on $want"; return }

$logFile = Join-Path $env:TEMP "prism-upgrade-$want.log"
Set-Content -Path $logFile -Value "[$((Get-Date).ToString('HH:mm:ss'))] handed to Windows: $before -> $want" -Encoding utf8

$me = $MyInvocation.MyCommand.Path
$args = "-NoProfile -ExecutionPolicy Bypass -File `"$me`" -Run -Version $want -Log `"$logFile`""
try { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue } catch {}
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $args
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(15)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -StartWhenAvailable
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description 'Installs a new Prism and starts it again' | Out-Null

"[upgrade] $before -> $want"
"[upgrade] Windows will do it in 15 seconds, so Prism closing cannot stop it half-done."
"[upgrade] log: $logFile"
