# Builds the Android app (the phone client) and drops the APK in dist.
# Needs Java 21: Capacitor's Gradle plugin will not compile under 17.
# No $ErrorActionPreference = 'Stop' here: node and gradle write progress to stderr, which PowerShell 5.1
# turns into error records, and the script would stop on a chunk-size warning.
# This computer's own folders, if it keeps them somewhere else: scripts/local.ps1 (not in git)
# can set $PrismDist (where installers and APKs go) and $PrismJavaHome (a Java 21 for the APK).
$work = Split-Path $PSScriptRoot -Parent
$PrismDist = Join-Path $work 'dist'
$PrismJavaHome = $env:JAVA_HOME
if (Test-Path "$PSScriptRoot\local.ps1") { . "$PSScriptRoot\local.ps1" }
$version = (Get-Content "$work\package.json" | ConvertFrom-Json).version
Push-Location $work
npx vite build -c vite.mobile.config.ts
if ($LASTEXITCODE -ne 0) { Pop-Location; throw 'the phone page did not build' }
npx cap sync android
if ($LASTEXITCODE -ne 0) { Pop-Location; throw 'cap sync failed' }
if (-not $PrismJavaHome) { Pop-Location; throw 'Set JAVA_HOME to a Java 21, or $PrismJavaHome in scripts/local.ps1' }
$env:JAVA_HOME = $PrismJavaHome
Push-Location "$work\android"
.\gradlew.bat assembleDebug --no-daemon
$built = $LASTEXITCODE
Pop-Location
Pop-Location
if ($built -ne 0) { throw 'gradle did not build the APK' }
$out = "$work\android\app\build\outputs\apk\debug\app-debug.apk"
New-Item -ItemType Directory -Force $PrismDist | Out-Null
Copy-Item $out "$PrismDist\Prism-phone-$version.apk" -Force
"[apk] $PrismDist\Prism-phone-$version.apk"
