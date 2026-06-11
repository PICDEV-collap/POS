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

if not "%NGROK_EXE%"=="" (
  if not exist "%NGROK_EXE%" (
    echo NGROK_EXE is set but file was not found: %NGROK_EXE%
    exit /b 0
  )
) else (
  where ngrok >nul 2>nul
  if errorlevel 1 (
  if exist "C:\ngrok\ngrok.exe" (
    set "NGROK_EXE=C:\ngrok\ngrok.exe"
  ) else if exist "%USERPROFILE%\ngrok.exe" (
    set "NGROK_EXE=%USERPROFILE%\ngrok.exe"
  ) else if exist "%LOCALAPPDATA%\ngrok\ngrok.exe" (
    set "NGROK_EXE=%LOCALAPPDATA%\ngrok\ngrok.exe"
  ) else if exist "%ROOT_DIR%\tools\ngrok.exe" (
    set "NGROK_EXE=%ROOT_DIR%\tools\ngrok.exe"
  ) else if exist "%ROOT_DIR%\ngrok.exe" (
    set "NGROK_EXE=%ROOT_DIR%\ngrok.exe"
  ) else (
    echo ngrok not found. Install ngrok or set PATH/NGROK_EXE, then run this script again.
    exit /b 0
  )
  ) else (
  set "NGROK_EXE=ngrok"
  )
)

taskkill /IM ngrok.exe /F >nul 2>nul

if not "%NGROK_TUNNEL%"=="" (
  if not "%NGROK_CONFIG%"=="" (
    start "POS V2 ngrok" /min cmd /c ""%NGROK_EXE%" start %NGROK_TUNNEL% --config "%NGROK_CONFIG%" --log=stdout > "%LOG_DIR%\ngrok.out.log" 2> "%LOG_DIR%\ngrok.err.log""
  ) else (
    start "POS V2 ngrok" /min cmd /c ""%NGROK_EXE%" start %NGROK_TUNNEL% --log=stdout > "%LOG_DIR%\ngrok.out.log" 2> "%LOG_DIR%\ngrok.err.log""
  )
) else if not "%NGROK_DOMAIN%"=="" (
  if not "%NGROK_CONFIG%"=="" (
    start "POS V2 ngrok" /min cmd /c ""%NGROK_EXE%" http --domain=%NGROK_DOMAIN% %NGROK_PORT% --config "%NGROK_CONFIG%" --log=stdout > "%LOG_DIR%\ngrok.out.log" 2> "%LOG_DIR%\ngrok.err.log""
  ) else (
    start "POS V2 ngrok" /min cmd /c ""%NGROK_EXE%" http --domain=%NGROK_DOMAIN% %NGROK_PORT% --log=stdout > "%LOG_DIR%\ngrok.out.log" 2> "%LOG_DIR%\ngrok.err.log""
  )
) else (
  if not "%NGROK_CONFIG%"=="" (
    start "POS V2 ngrok" /min cmd /c ""%NGROK_EXE%" http %NGROK_PORT% --config "%NGROK_CONFIG%" --log=stdout > "%LOG_DIR%\ngrok.out.log" 2> "%LOG_DIR%\ngrok.err.log""
  ) else (
    start "POS V2 ngrok" /min cmd /c ""%NGROK_EXE%" http %NGROK_PORT% --log=stdout > "%LOG_DIR%\ngrok.out.log" 2> "%LOG_DIR%\ngrok.err.log""
  )
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 3"
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $t = Invoke-RestMethod -Uri 'http://127.0.0.1:4040/api/tunnels' -TimeoutSec 2; $u = ($t.tunnels | Where-Object { $_.public_url -like 'https://*' } | Select-Object -First 1 -ExpandProperty public_url); if ($u) { Write-Host ('ngrok public URL: ' + $u) } else { Write-Host 'ngrok started; public URL not ready yet.' } } catch { Write-Host 'ngrok started; inspect API not ready yet.' }"
exit /b 0
