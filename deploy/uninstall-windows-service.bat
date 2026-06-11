@echo off
REM Stop + remove POS_V2 services. Run as Administrator.
nssm stop pos-v2-web
nssm stop pos-v2-backend
nssm remove pos-v2-web confirm
nssm remove pos-v2-backend confirm
echo Removed.
