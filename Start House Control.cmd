@echo off
rem House Control - double-click to start the hub on this PC.
rem First run installs what it needs and builds the phone app; after that it just starts.
setlocal
cd /d "%~dp0"
title House Control hub

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Installing what the hub needs - first run only, takes a minute...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo The install failed. Check the internet connection and run this again.
    pause
    exit /b 1
  )
)

if not exist "app\dist\index.html" (
  echo Building the phone app - first run only...
  call npm run build
  if errorlevel 1 (
    echo The build failed. See the messages above.
    pause
    exit /b 1
  )
)

echo.
echo Starting House Control. Leave this window open.
echo On this PC open:  http://localhost:8080
echo.
call npm start
echo.
echo The hub stopped.
pause
