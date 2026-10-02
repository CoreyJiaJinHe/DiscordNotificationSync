@echo off
title Discord + Proxy Launcher

echo Launching Official Discord App...
start "" "%LOCALAPPDATA%\Discord\Update.exe" --processStart Discord.exe

echo Launching PM2 Proxy...
cd /d "%~dp0"

:: 1. Attempt to execute pm2 via full APPDATA path
:: 2. Fall back to call npx pm2 if path differs
:: Start PM2 process
if exist "%APPDATA%\npm\pm2.cmd" (
    call "%APPDATA%\npm\pm2.cmd" start index.js --name "discord-dm-proxy"
    echo.
    echo Attaching live console logs - Press Ctrl+C to stop viewing logs
    echo =========================================================================================
    call "%APPDATA%\npm\pm2.cmd" logs discord-dm-proxy
) else (
    call npx pm2 start index.js --name "discord-dm-proxy"
    echo.
    echo Attaching live console logs - Press Ctrl+C to stop viewing logs
    echo =========================================================================================
    call npx pm2 logs discord-dm-proxy
)