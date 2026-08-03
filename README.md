<!--
Created by DINKIssTyle on 2026.
Copyright (C) 2026 DINKI'ssTyle. All rights reserved.
-->

# DKST Terminal AI

## 한국어 소개 (Korean)

이 앱은 로컬 LLM, 특히 LM Studio 사용에 최적화된 앱으로, 로컬 LLM과 터미널 창을 결합하여 자연어로 터미널을 다룰 수 있도록 돕습니다. 사용자가 자연어로 명령을 내리면 LLM이 적절한 터미널 명령어를 제안하고 시스템과 상호작용할 수 있도록 지원하는 지능형 터미널 어시스턴트입니다.

### 주요 기능
- **로컬 LLM 최적화**: LM Studio와 같은 로컬 환경의 LLM과 매끄럽게 연동됩니다.
- **Apple Intelligence 지원**: 지원되는 macOS 26 이상 Mac에서는 서버나 API 키 없이 온디바이스 모델을 사용할 수 있습니다.
- **자연어 터미널 제어**: 복잡한 터미널 명령어를 외울 필요 없이 일상적인 언어로 터미널을 조작하고 실행 결과를 확인할 수 있습니다.
- **크로스 플랫폼 지원**: Windows, macOS, Linux 운영체제 환경을 모두 지원합니다.
- **Linux 사용자 설치**: 설정의 Linux 설치 영역에서 현재 빌드를 `~/.local`과 앱 메뉴에 설치하거나 제거할 수 있습니다.
- **내장 및 사용자 스킬**: 운영체제별 명령 스킬이 앱에 포함되며 설정에서 사용자 스킬 폴더를 열어 스킬을 추가하거나 같은 이름의 기본 스킬을 덮어쓸 수 있습니다.

### 빌드 방법
각 운영체제에 맞는 아래의 전용 빌드 스크립트를 사용하여 애플리케이션을 빌드할 수 있습니다.

- **macOS**: `./build-macOS.sh` 실행
- **Linux**: `./build-Linux.sh` 실행
- **Windows**: `build-Windows.bat` 실행

---

## English Introduction (English)

This application is an optimized Terminal Assistant designed for Local LLMs, particularly LM Studio. It seamlessly integrates a Local LLM with a terminal window, empowering users to control and interact with the terminal using natural language.

### Key Features
- **Local LLM Optimized**: Perfectly integrated to work with local LLM environments like LM Studio.
- **Apple Intelligence**: On supported Macs running macOS 26 or later, the on-device model works without a server or API key.
- **Natural Language Terminal Control**: Manage terminal operations and check execution results using everyday language, without the need to memorize complex CLI commands.
- **Cross-Platform Support**: Fully supports Windows, macOS, and Linux operating systems.
- **Linux User Installation**: Install the current build under `~/.local` and add it to the app menu, or remove it, from Settings.
- **Built-in and User Skills**: OS-specific command skills are bundled with the app. Open the user skills folder from Settings to add skills or override a bundled skill with the same name.

### How to Build
You can build the application using the OS-specific build scripts provided in the root directory.

- **macOS**: Run `./build-macOS.sh`
- **Linux**: Run `./build-Linux.sh`
- **Windows**: Run `build-Windows.bat`
