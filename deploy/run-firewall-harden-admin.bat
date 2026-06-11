@echo off
:: Re-launch elevated, then run firewall-harden.ps1
net session >nul 2>&1
if %errorLevel% == 0 (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0firewall-harden.ps1"
  pause
  exit /b %errorlevel%
)
powershell -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File ""%~dp0firewall-harden.ps1""'"
exit /b 0
