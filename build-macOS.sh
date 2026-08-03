#!/bin/bash
# Created by DINKIssTyle on 2026. Copyright (C) 2026 DINKI'ssTyle. All rights reserved.

set -e

APP_NAME="DKST Terminal AI"
APP_PATH="build/bin/${APP_NAME}.app"

echo "[INFO] Starting macOS build for DKST Terminal AI..."

# Build the Foundation Models bridge as a universal helper. On SDKs that do
# not provide FoundationModels, the helper still builds and reports that the
# capability is unavailable at runtime.
echo "[INFO] Building Apple Intelligence helper..."
HELPER_TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${HELPER_TMP_DIR}"' EXIT
export CLANG_MODULE_CACHE_PATH="/tmp/dkst-terminal-clang-module-cache"
export SWIFTPM_MODULECACHE_OVERRIDE="/tmp/dkst-terminal-swift-module-cache"
xcrun swiftc -parse-as-library -O \
    -target arm64-apple-macosx12.0 \
    build/darwin/apple_intelligence_helper.swift \
    -o "${HELPER_TMP_DIR}/DKSTAppleIntelligenceHelper-arm64"
xcrun swiftc -parse-as-library -O \
    -target x86_64-apple-macosx12.0 \
    build/darwin/apple_intelligence_helper.swift \
    -o "${HELPER_TMP_DIR}/DKSTAppleIntelligenceHelper-x86_64"
lipo -create \
    -output "${HELPER_TMP_DIR}/DKSTAppleIntelligenceHelper" \
    "${HELPER_TMP_DIR}/DKSTAppleIntelligenceHelper-arm64" \
    "${HELPER_TMP_DIR}/DKSTAppleIntelligenceHelper-x86_64"

# Clear previous build artifacts to avoid lipo directory conflicts
echo "[INFO] Cleaning old build artifacts..."
rm -rf "${APP_PATH}"
rm -f "${APP_PATH}-amd64"
rm -f "${APP_PATH}-arm64"
rm -f "${APP_PATH}.lipo"

# Run wails build (Universal for Mac M1/M2/M3 and Intel)
# IMPORTANT: Use the name without .app to avoid directory/file collision during lipo
echo "[INFO] Running wails build (darwin/universal)..."
rm -f frontend/package.json.md5
wails build -clean -platform darwin/universal -o "${APP_NAME}"

if [ ! -d "${APP_PATH}" ]; then
    echo "[ERROR] Expected app bundle was not created: ${APP_PATH}"
    exit 1
fi

cp "${HELPER_TMP_DIR}/DKSTAppleIntelligenceHelper" "${APP_PATH}/Contents/MacOS/DKSTAppleIntelligenceHelper"

# Sign the app (Ad-hoc if no identity is provided, otherwise use current identity)
# Using entitlements helps macOS understand app capabilities and can reduce recurring TCC prompts.
SIGN_IDENTITY="${CODESIGN_IDENTITY:--}"
ENTITLEMENTS="build/darwin/entitlements.plist"

echo "[INFO] Signing app with identity: ${SIGN_IDENTITY} using ${ENTITLEMENTS}..."
codesign --force --deep --options=runtime --sign "${SIGN_IDENTITY}" --entitlements "${ENTITLEMENTS}" "${APP_PATH}"

echo "[SUCCESS] Build complete: ${APP_PATH}"
echo "[INFO] Bundle identifier is fixed in build/darwin/Info.plist as com.dinkisstyle.terminalai"
echo "[INFO] For stable macOS permissions, run the same signed app bundle from a fixed location such as /Applications."
