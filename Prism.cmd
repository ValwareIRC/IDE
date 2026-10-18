@echo off
rem Opens Prism. Rebuilds first when the code changed since the last build,
rem and fetches new dependencies first when the list of them changed.
setlocal
cd /d "%~dp0"
rem VS Code terminals set this; with it Electron would run as plain Node.
set ELECTRON_RUN_AS_NODE=
set ELECTRON_NO_ATTACH_CONSOLE=

set REV=none
for /f %%i in ('git rev-parse HEAD 2^>nul') do set REV=%%i
set BUILT=
if exist "out\.built-rev" set /p BUILT=<"out\.built-rev"
rem The dependency list of this version, and the one that was last installed.
set DEPS=none
for /f %%i in ('git rev-parse HEAD:pnpm-lock.yaml 2^>nul') do set DEPS=%%i
set HAVE=
if exist "node_modules\.deps-rev" set /p HAVE=<"node_modules\.deps-rev"

if not exist "node_modules\electron\dist\electron.exe" goto install
if not exist "out\renderer\index.html" goto build
rem Already open from this folder: rebuilding would pull files out from under the running window. Just open it.
powershell -NoProfile -Command "if (Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '%~dp0*' }) { exit 0 } else { exit 1 }" && goto run
if not "%REV%"=="%BUILT%" goto build
goto run

:install
echo Setting Prism up for the first time...
call corepack pnpm install || goto failed
if not exist "node_modules\electron\dist\electron.exe" node node_modules\electron\install.js
> "node_modules\.deps-rev" echo %DEPS%
set HAVE=%DEPS%

:build
if "%DEPS%"=="%HAVE%" goto compile
echo Fetching what this version of Prism needs...
call corepack pnpm install || goto failed
if not exist "node_modules\electron\dist\electron.exe" node node_modules\electron\install.js
> "node_modules\.deps-rev" echo %DEPS%

:compile
echo Getting Prism ready (about half a minute)...
call corepack pnpm build || goto failed
> "out\.built-rev" echo %REV%

:run
start "" "node_modules\electron\dist\electron.exe" .
exit /b 0

:failed
echo.
echo Prism could not be built. The messages above say why.
pause
exit /b 1
