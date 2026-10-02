@echo off
title Stop Discord Proxy

echo Stopping PM2 Discord Proxy...

if exist "%APPDATA%\npm\pm2.cmd" (
    call "%APPDATA%\npm\pm2.cmd" stop discord-dm-proxy
) else (
    call npx pm2 stop discord-dm-proxy
)

echo.
echo Proxy process stopped successfully!
timeout /t 3