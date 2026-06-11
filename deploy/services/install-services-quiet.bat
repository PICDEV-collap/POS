@echo off
REM Install POS_V2 services. Logs everything to install.log.
cd /d "%~dp0"
(
  echo === %DATE% %TIME% — installing services ===
  echo
  echo --- pos-v2-backend.exe install ---
  pos-v2-backend.exe install
  echo
  echo --- pos-v2-web.exe install ---
  pos-v2-web.exe install
  echo
  echo --- pos-v2-backend.exe start ---
  pos-v2-backend.exe start
  echo
  echo --- pos-v2-web.exe start ---
  pos-v2-web.exe start
  echo
  echo --- sc query pos-v2-backend ---
  sc query pos-v2-backend
  echo
  echo --- sc query pos-v2-web ---
  sc query pos-v2-web
  echo
  echo === done ===
) > install.log 2>&1
exit /b 0
