@echo off
REM POS V2 Android helper. Run from the project path without parentheses:
REM   D:\POS_V2\mobile
REM
REM Usage:
REM   android-build.bat                       — build debug APK
REM   android-build.bat run                   — flutter run (live, hot reload)
REM   android-build.bat release               — build release APK
REM   android-build.bat clean                 — flutter clean
REM
REM Edit POS_API_BASE for your backend's LAN IP if running on a real device.

set PROJECT=D:\POS_V2
set MOBILE_DIR=%PROJECT%\mobile

REM Default: emulator (10.0.2.2 = host PC's localhost from emulator's view)
REM For real device, change this to http://<your-windows-LAN-IP>:4000
if "%POS_API_BASE%"=="" set POS_API_BASE=http://10.0.2.2:4000

if not exist "%MOBILE_DIR%\pubspec.yaml" (
  echo ERROR: mobile project not found at "%MOBILE_DIR%"
  exit /b 1
)

pushd "%MOBILE_DIR%"

set FLUTTER=D:\flutter\bin\flutter.bat

set ADB=C:\Users\PIC_DEV\AppData\Local\Android\sdk\platform-tools\adb.exe
set APK=%MOBILE_DIR%\build\app\outputs\flutter-apk\app-debug.apk
set PKG=com.pos_v2.pos_v2_mobile

if "%1"=="run" (
  echo Running on connected device with POS_API_BASE=%POS_API_BASE%
  call %FLUTTER% run --dart-define=POS_API_BASE=%POS_API_BASE%
) else if "%1"=="release" (
  echo Building release APK with POS_API_BASE=%POS_API_BASE%
  call %FLUTTER% build apk --release --dart-define=POS_API_BASE=%POS_API_BASE%
) else if "%1"=="install" (
  echo Installing already-built APK + launching app
  "%ADB%" install -r "%APK%"
  if errorlevel 1 goto :install_fail
  "%ADB%" shell am start -n "%PKG%/.MainActivity"
  goto :install_done
  :install_fail
  echo APK install failed.
  :install_done
) else if "%1"=="build-install" (
  echo Build debug APK + install + launch
  call %FLUTTER% build apk --debug --dart-define=POS_API_BASE=%POS_API_BASE%
  if errorlevel 1 goto :bi_fail
  "%ADB%" install -r "%APK%"
  "%ADB%" shell am start -n "%PKG%/.MainActivity"
  goto :bi_done
  :bi_fail
  echo Build failed; not installing.
  :bi_done
) else if "%1"=="clean" (
  call %FLUTTER% clean
) else (
  echo Building debug APK with POS_API_BASE=%POS_API_BASE%
  call %FLUTTER% build apk --debug --dart-define=POS_API_BASE=%POS_API_BASE%
)

set EXIT=%errorlevel%
popd
exit /b %EXIT%

