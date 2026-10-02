@echo off
title Discord + Proxy Restarter

echo [1/3] Terminating active Discord instances...
taskkill /F /IM Discord.exe /T >nul 2>&1

echo [2/3] Relaunching Official Discord App...
start "" "%LOCALAPPDATA%\Discord\Update.exe" --processStart Discord.exe

echo [3/3] Restarting PM2 Proxy...
cd /d "%~dp0"

if exist "%APPDATA%\npm\pm2.cmd" (
    call "%APPDATA%\npm\pm2.cmd" restart discord-dm-proxy >nul 2>&1 || call "%APPDATA%\npm\pm2.cmd" start index.js --name "discord-dm-proxy"
    echo.
    echo Attaching live console logs - Press Ctrl+C to stop viewing logs
    echo =========================================================================================
    call "%APPDATA%\npm\pm2.cmd" logs discord-dm-proxy
) else (
    call npx pm2 restart discord-dm-proxy >nul 2>&1 || call npx pm2 start index.js --name "discord-dm-proxy"
    echo.
    echo Attaching live console logs - Press Ctrl+C to stop viewing logs
    echo =========================================================================================
    call npx pm2 logs discord-dm-proxy
)