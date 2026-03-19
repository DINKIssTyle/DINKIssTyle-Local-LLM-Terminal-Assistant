@echo off
rem Created by DINKIssTyle on 2026. Copyright (C) 2026 DINKI'ssTyle. All rights reserved.

echo [INFO] Starting Windows build for "DKST Terminal Assistant"...

rem Ensure frontend is built
cd frontend
call npm install
call npm run build
cd ..

rem Run wails build
wails build -platform windows/amd64 -o "DKST Terminal Assistant.exe"

if %errorlevel% neq 0 (
    echo [ERROR] Build failed!
    pause
    exit /b %errorlevel%
)

echo [SUCCESS] Build complete: build/bin/"DKST Terminal Assistant.exe"
pause
