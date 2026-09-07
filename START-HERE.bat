@echo off
REM The app lives in zillow-tracker\. This forwards there so that double-clicking
REM works from the folder you land in after extracting the download.
cd /d "%~dp0zillow-tracker"
call START-HERE.bat
