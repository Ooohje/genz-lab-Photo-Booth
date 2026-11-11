@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Booth Server - close this window to stop

REM --- node path ---
set "NODE=node"
where node >nul 2>nul || set "NODE=%ProgramFiles%\nodejs\node.exe"

REM --- install libraries on first run ---
if not exist "node_modules" (
  echo Installing libraries for the first run, please wait...
  call npm install
  if not exist "node_modules" call "%ProgramFiles%\nodejs\npm.cmd" install
)

REM --- stop any server already using port 5173 ---
for /f "tokens=5" %%p in ('netstat -ano ^| findstr LISTENING ^| findstr /c:":5173 "') do taskkill /F /PID %%p >nul 2>nul

REM --- if Tailscale exists, enable Funnel and print the public URL here ---
set "TS="
where tailscale >nul 2>nul && set "TS=tailscale"
if not defined TS if exist "%ProgramFiles%\Tailscale\tailscale.exe" set "TS=%ProgramFiles%\Tailscale\tailscale.exe"
if defined TS (
  echo.
  echo ==================================================================
  echo   PUBLIC BOOTH URL ^(open this on the Galaxy Tab / phone^):
  "%TS%" funnel --bg 5173
  echo ==================================================================
)

REM --- Korean guidance (external UTF-8 file, avoids batch encoding issues) ---
if exist "_booth_msg.txt" type "_booth_msg.txt"

echo.
"%NODE%" server.mjs
pause
