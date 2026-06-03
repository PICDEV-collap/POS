@echo off
setlocal

set "SERVICE_DIR=%~dp0"
set "ROOT_DIR=%SERVICE_DIR%\..\.."
set "LOG_DIR=%ROOT_DIR%\deploy\logs"
set "NGROK_PORT=%NGROK_PORT%"
if "%NGROK_PORT%"=="" set "NGROK_PORT=3000"
if "%NGROK_CONFIG%"=="" if exist "%ROOT_DIR%\deploy\ngrok.yml" set "NGROK_CONFIG=%ROOT_DIR%\deploy\ngrok.yml"
if "%NGROK_TUNNEL%"=="" if not "%NGROK_CONFIG%"=="" set "NGROK_TUNNEL=pos-v2"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>nul

pushd "%SERVICE_DIR%\..\.." >nul

echo Restarting POS V2 backend...
"%SERVICE_DIR%pos-v2-backend.exe" restart
if errorlevel 1 goto fail

echo Restarting POS V2 web...
"%SERVICE_DIR%pos-v2-web.exe" restart
if errorlevel 1 goto fail

call :restart_ngrok

echo.
echo POS V2 services restarted successfully.
popd >nul
exit /b 0

:fail
echo.
echo Failed to restart POS V2 services.
popd >nul
exit /b 1

:restart_ngrok
echo Restarting ngrok tunnel...

powershell -NoProfile -ExecutionPolicy Bypass -File "%SERVICE_DIR%start-ngrok-hidden.ps1"
exit /b 0
