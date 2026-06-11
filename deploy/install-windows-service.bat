@echo off
REM Install POS_V2 as Windows services using nssm.
REM Prereqs:
REM   1. Download nssm from https://nssm.cc/ and put nssm.exe in PATH (or this folder)
REM   2. Run this script as Administrator
REM
REM This sets up TWO services:
REM   pos-v2-backend  → node ..\backend\src\server.js
REM   pos-v2-web      → next start (Next.js production)
REM
REM Both auto-restart on failure and start at boot. Logs go to backend\logs and customer-web\logs.

setlocal
set ROOT=%~dp0..
set NODE=%ProgramFiles%\nodejs\node.exe
set NPM=%ProgramFiles%\nodejs\npm.cmd
set NSSM=nssm.exe

echo === POS_V2 — installing Windows services via nssm ===

REM Build customer-web first (production needs prebuilt assets)
echo Building customer-web...
pushd "%ROOT%\customer-web"
call "%NPM%" run build || goto :error
popd

REM ─── backend ────────────────────────────────────────────
%NSSM% install pos-v2-backend "%NODE%" "%ROOT%\backend\src\server.js" || goto :error
%NSSM% set pos-v2-backend AppDirectory "%ROOT%\backend"
%NSSM% set pos-v2-backend DisplayName "POS V2 — Backend (Express)"
%NSSM% set pos-v2-backend Description "POS_V2 REST + Socket.io + ESC/POS print queue"
%NSSM% set pos-v2-backend AppStdout "%ROOT%\backend\logs\out.log"
%NSSM% set pos-v2-backend AppStderr "%ROOT%\backend\logs\err.log"
%NSSM% set pos-v2-backend AppRotateFiles 1
%NSSM% set pos-v2-backend AppRotateBytes 10485760
%NSSM% set pos-v2-backend Start SERVICE_AUTO_START
mkdir "%ROOT%\backend\logs" 2>nul

REM ─── customer-web ──────────────────────────────────────
%NSSM% install pos-v2-web "%NODE%" "%ROOT%\customer-web\node_modules\next\dist\bin\next" "start" "-p" "3000" || goto :error
%NSSM% set pos-v2-web AppDirectory "%ROOT%\customer-web"
%NSSM% set pos-v2-web DisplayName "POS V2 — Web (Next.js)"
%NSSM% set pos-v2-web Description "POS_V2 customer/staff/kitchen/admin web UI"
%NSSM% set pos-v2-web AppStdout "%ROOT%\customer-web\logs\out.log"
%NSSM% set pos-v2-web AppStderr "%ROOT%\customer-web\logs\err.log"
%NSSM% set pos-v2-web AppRotateFiles 1
%NSSM% set pos-v2-web AppRotateBytes 10485760
%NSSM% set pos-v2-web Start SERVICE_AUTO_START
mkdir "%ROOT%\customer-web\logs" 2>nul

REM ─── start them ────────────────────────────────────────
%NSSM% start pos-v2-backend
%NSSM% start pos-v2-web

echo.
echo === Done. Verify with: ===
echo   sc query pos-v2-backend
echo   sc query pos-v2-web
echo Logs:
echo   %ROOT%\backend\logs\
echo   %ROOT%\customer-web\logs\
goto :eof

:error
echo FAILED, exit code %errorlevel%
exit /b %errorlevel%
