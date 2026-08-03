@echo off
setlocal
rem Created by DINKIssTyle on 2026. Copyright (C) 2026 DINKI'ssTyle. All rights reserved.

pushd "%~dp0"
if errorlevel 1 goto :fail

echo [INFO] Starting Windows build for "DKST Terminal AI"...

where npm >nul 2>&1
if errorlevel 1 (
    echo [ERROR] npm was not found in PATH.
    goto :fail
)

where wails >nul 2>&1
if errorlevel 1 (
    echo [ERROR] wails was not found in PATH.
    goto :fail
)

rem Wails generates bindings, runs the locked npm ci install from wails.json,
rem builds the frontend, and then packages the application exactly once.
rem Never trust Wails' generated dependency cache from another machine.
if exist "frontend\package.json.md5" del /f /q "frontend\package.json.md5"
if errorlevel 1 goto :fail
wails build -platform windows/amd64 -o "DKST Terminal AI.exe"

if errorlevel 1 goto :fail

echo [SUCCESS] Build complete: build/bin/"DKST Terminal AI.exe"
popd
pause
exit /b 0

:fail
set "BUILD_EXIT_CODE=%errorlevel%"
if "%BUILD_EXIT_CODE%"=="0" set "BUILD_EXIT_CODE=1"
echo [ERROR] Build failed with exit code %BUILD_EXIT_CODE%.
popd
pause
exit /b %BUILD_EXIT_CODE%
