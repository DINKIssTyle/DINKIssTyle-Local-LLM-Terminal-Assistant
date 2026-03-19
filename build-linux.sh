#!/bin/bash
# Created by DINKIssTyle on 2026. Copyright (C) 2026 DINKI'ssTyle. All rights reserved.

set -e

echo "[INFO] Starting Linux build for DKST Terminal Assistant..."

# Ensure frontend is built
cd frontend
npm install
npm run build
cd ..

# Run wails build
wails build -platform linux/amd64 -o "DKST Terminal Assistant"

echo "[SUCCESS] Build complete: build/bin/DKST Terminal Assistant"
