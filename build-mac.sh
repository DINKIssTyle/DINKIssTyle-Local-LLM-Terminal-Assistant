#!/bin/bash
# Created by DINKIssTyle on 2026. Copyright (C) 2026 DINKI'ssTyle. All rights reserved.

set -e

echo "[INFO] Starting macOS build for DKST Terminal Assistant..."

# Ensure frontend is built
cd frontend
npm install
npm run build
cd ..

# Run wails build (Universal for Mac M1/M2/M3 and Intel)
wails build -platform darwin/universal -o "DKST Terminal Assistant.app"

echo "[SUCCESS] Build complete: build/bin/DKST Terminal Assistant.app"
