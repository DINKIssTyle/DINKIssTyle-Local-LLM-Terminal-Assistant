#!/bin/bash
# Created by DINKIssTyle on 2026. Copyright (C) 2026 DINKI'ssTyle. All rights reserved.

set -e

APP_NAME="DKST Terminal Assistant"
APP_PATH="build/bin/${APP_NAME}.app"

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
rm -rf "${APP_PATH}"
rm -f "${APP_PATH}-amd64"
rm -f "${APP_PATH}-arm64"
rm -f "${APP_PATH}.lipo"

# Run wails build (Universal for Mac M1/M2/M3 and Intel)
# IMPORTANT: Use the name without .app to avoid directory/file collision during lipo
echo "[INFO] Running wails build (darwin/universal)..."
wails build -clean -platform darwin/universal -o "${APP_NAME}"

if [ ! -d "${APP_PATH}" ]; then
    echo "[ERROR] Expected app bundle was not created: ${APP_PATH}"
    exit 1
fi

# Sign the app (Ad-hoc if no identity is provided, otherwise use current identity)
# Using entitlements helps macOS understand app capabilities and can reduce recurring TCC prompts.
SIGN_IDENTITY="${CODESIGN_IDENTITY:--}"
ENTITLEMENTS="build/darwin/entitlements.plist"

echo "[INFO] Signing app with identity: ${SIGN_IDENTITY} using ${ENTITLEMENTS}..."
codesign --force --deep --options=runtime --sign "${SIGN_IDENTITY}" --entitlements "${ENTITLEMENTS}" "${APP_PATH}"

echo "[SUCCESS] Build complete: ${APP_PATH}"
echo "[INFO] Bundle identifier is fixed in build/darwin/Info.plist as com.dinkisstyle.dkstterminalassistant"
echo "[INFO] For stable macOS permissions, run the same signed app bundle from a fixed location such as /Applications."
