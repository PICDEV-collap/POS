@echo off
setlocal

REM Ensure PostgreSQL is running before POS V2 backend can serve login/API.
REM
REM   ensure-postgresql.bat              start PG (Admin -> service; else pg_ctl)
REM   ensure-postgresql.bat check        diagnose only (exit 1 if DB down)
REM   ensure-postgresql.bat emergency    pg_ctl start only
REM   ensure-postgresql.bat admin        Windows service (self-elevates)
REM   ensure-postgresql.bat restart      service + restart pos-v2-backend (self-elevates)
REM
REM Optional env: POS_PG_SERVICE, POS_PG_HOME, POS_PG_DATA

set "SERVICE_DIR=%~dp0"
set "ARG=%~1"

if /I "%ARG%"=="admin-inner" goto do_admin
if /I "%ARG%"=="admin-restart-inner" goto do_admin_restart
if /I "%ARG%"=="check" goto do_check
if /I "%ARG%"=="emergency" goto do_emergency
if /I "%ARG%"=="admin" goto elevate_admin
if /I "%ARG%"=="restart" goto elevate_admin_restart
if "%ARG%"=="" goto do_start_default
echo Unknown mode: %ARG%
echo Usage: ensure-postgresql.bat [start^|check^|emergency^|admin^|restart]
exit /b 2

:do_start_default
net session >nul 2>&1
if %errorlevel% equ 0 goto do_admin
goto do_emergency

:elevate_admin
echo Requesting Administrator privileges...
powershell -Command "Start-Process '%~f0' -Verb RunAs -ArgumentList 'admin-inner'"
exit /b 0

:elevate_admin_restart
echo Requesting Administrator privileges...
powershell -Command "Start-Process '%~f0' -Verb RunAs -ArgumentList 'admin-restart-inner'"
exit /b 0

:do_check
powershell -NoProfile -ExecutionPolicy Bypass -File "%SERVICE_DIR%ensure-postgresql.ps1" -CheckOnly
exit /b %errorlevel%

:do_emergency
powershell -NoProfile -ExecutionPolicy Bypass -File "%SERVICE_DIR%ensure-postgresql.ps1" -Emergency
exit /b %errorlevel%

:do_admin
powershell -NoProfile -ExecutionPolicy Bypass -File "%SERVICE_DIR%ensure-postgresql.ps1"
exit /b %errorlevel%

:do_admin_restart
powershell -NoProfile -ExecutionPolicy Bypass -File "%SERVICE_DIR%ensure-postgresql.ps1" -RestartBackend
exit /b %errorlevel%
