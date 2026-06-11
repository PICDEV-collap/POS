@echo off
REM Install POS_V2 services using WinSW. Run as Administrator.
REM Self-elevates if not already admin.

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting admin privileges...
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

cd /d "%~dp0"

echo === installing pos-v2-backend ===
pos-v2-backend.exe install
if errorlevel 1 echo (might already exist)

echo === installing pos-v2-web ===
pos-v2-web.exe install
if errorlevel 1 echo (might already exist)

echo === starting pos-v2-backend ===
pos-v2-backend.exe start

echo === starting pos-v2-web ===
pos-v2-web.exe start

echo.
echo === current status ===
sc query pos-v2-backend | findstr STATE
sc query pos-v2-web | findstr STATE

echo.
echo Logs:
echo   D:\POS_V2\backend\logs\
echo   D:\POS_V2\customer-web\logs\
echo.
pause
