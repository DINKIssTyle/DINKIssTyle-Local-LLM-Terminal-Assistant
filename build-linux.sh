#!/bin/bash
# Created by DINKIssTyle on 2026. Copyright (C) 2026 DINKI'ssTyle. All rights reserved.

set -e

# Add custom Go path if exists to ensure we have Go 1.24+
if [ -d "/usr/local/go/bin" ]; then
    export PATH="/usr/local/go/bin:$PATH"
fi

# Add user's Go bin path for tools like wails
if [ -d "$HOME/go/bin" ]; then
    export PATH="$HOME/go/bin:$PATH"
fi

echo "[INFO] Starting Linux build for DKST Terminal AI..."
echo "[INFO] Using $(go version)"

# Check Go version (requires 1.24+)
GO_VERSION_STR=$(go version | grep -oE 'go[0-9]+\.[0-9]+(\.[0-9]+)?')
GO_VERSION_SHORT=$(echo $GO_VERSION_STR | sed 's/go//')
GO_MAJOR=$(echo $GO_VERSION_SHORT | cut -d. -f1)
GO_MINOR=$(echo $GO_VERSION_SHORT | cut -d. -f2)

if [ "$GO_MAJOR" -lt 1 ] || ([ "$GO_MAJOR" -eq 1 ] && [ "$GO_MINOR" -lt 24 ]); then
    echo "[ERROR] Go version 1.24 or higher is required. Current version: $GO_VERSION_STR"
    echo "[TIP] Please install a newer Go version or ensure it is in your PATH."
    exit 1
fi

# Handle webkit2gtk-4.0 vs 4.1 discrepancy (common on newer Linux distros)
if ! pkg-config --exists webkit2gtk-4.0; then
    if pkg-config --exists webkit2gtk-4.1; then
        echo "[INFO] webkit2gtk-4.0 not found, but 4.1 is available. Creating temporary shim..."
        mkdir -p .pkgconfig
        PC_DIR=$(pkg-config --variable=pcfiledir webkit2gtk-4.1)
        ln -sf "$PC_DIR/webkit2gtk-4.1.pc" .pkgconfig/webkit2gtk-4.0.pc
        export PKG_CONFIG_PATH="$(pwd)/.pkgconfig:$PKG_CONFIG_PATH"
    fi
fi

# Ensure frontend is built
echo "[INFO] Building frontend..."
cd frontend
if [ ! -d "node_modules" ]; then
    echo "[INFO] node_modules not found, running npm install..."
    npm install --no-audit --no-fund
else
    echo "[INFO] node_modules exists, skipping npm install for speed."
    echo "[TIP] If you have dependency issues, delete frontend/node_modules and run again."
fi
npm run build
cd ..

# Run wails build
echo "[INFO] Running wails build..."
wails build -platform linux/amd64 -o "DKST Terminal AI"

# Cleanup shim
rm -rf .pkgconfig

echo "[SUCCESS] Build complete: build/bin/DKST Terminal AI"
