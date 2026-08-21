@echo off
REM Double-click this file to install and start the app.
REM
REM It exists because "run `npm run go` in a terminal" is not a thing you can find in a
REM folder. This is.
title Zillow Tracker

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed, or Windows cannot find it yet.
  echo.
  echo   1. Install the LTS version from https://nodejs.org
  echo   2. Close this window, then double-click this file again.
  echo.
  pause
  exit /b 1
)

echo.
echo   Starting. The first run takes a few minutes to install everything.
echo   When it says "Ready", open http://localhost:3000 in your browser.
echo.

call npm run go

echo.
echo   The app has stopped.
pause
