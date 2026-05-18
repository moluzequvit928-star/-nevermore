@echo off
title FUTIKA Support Portal - Dev Server
echo ===================================================
echo   FUTIKA SUPPORT PORTAL - LOCAL DEVELOPMENT SERVER
echo ===================================================
echo.
echo [1/3] Checking dependencies (npm install)...
call npm install
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Failed to install dependencies. Please ensure Node.js is installed correctly!
    pause
    exit /b %errorlevel%
)
echo.
echo [2/3] Opening browser at http://localhost:3000...
timeout /t 2 /nobreak > nul
start http://localhost:3000
echo.
echo [3/3] Starting Express Server...
echo.
npm run dev
pause
