#!/bin/bash
# Created by DINKIssTyle on 2026. Copyright (C) 2026 DINKI'ssTyle. All rights reserved.

set -e

echo "[INFO] Starting macOS build for DKST Terminal Assistant..."

# Ensure frontend is built
echo "[INFO] Building frontend..."
cd frontend
if [ ! -d "node_modules" ]; then
    echo "[INFO] node_modules not found, running npm install..."
    npm install --no-audit --no-fund
else
    echo "[INFO] node_modules exists, skipping npm install."
fi
npm run build
cd ..

# Clear previous build artifacts to avoid lipo directory conflicts
echo "[INFO] Cleaning old build artifacts..."
rm -rf "build/bin/DKST Terminal Assistant.app"
rm -f "build/bin/DKST Terminal Assistant.app-amd64"
rm -f "build/bin/DKST Terminal Assistant.app-arm64"
rm -f "build/bin/DKST Terminal Assistant.app.lipo"

# Run wails build (Universal for Mac M1/M2/M3 and Intel)
# IMPORTANT: Use the name without .app to avoid directory/file collision during lipo
echo "[INFO] Running wails build (darwin/universal)..."
wails build -platform darwin/universal -o "DKST Terminal Assistant"

echo "[SUCCESS] Build complete: build/bin/DKST Terminal Assistant.app"
