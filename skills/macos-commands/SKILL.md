---
name: macos-commands
description: Use native macOS shell commands for terminal operations, system inspection, files, processes, services, networking, packages, permissions, and application control. Apply when DKST Terminal AI runs on macOS and the user requests a local terminal or operating-system task.
---

# macOS Commands

Prefer macOS-native utilities available in the default shell. Observe the current state before changing it and verify changes afterward.

## Command set

### Location and files

```sh
pwd
ls -la
find '/path' -maxdepth 2 -type f
sed -n '1,160p' '/path/file'
mkdir -p '/path/folder'
cp -R '/source' '/target'
mv '/source' '/target'
rm -i '/path/file'
```

Resolve and display exact targets before recursive deletion. Do not use broad targets such as `/`, `$HOME`, or `~`.

### System and storage

```sh
sw_vers
uname -a
sysctl -n machdep.cpu.brand_string
sysctl -n hw.physicalcpu
sysctl -n hw.logicalcpu
sysctl -n hw.memsize
sysctl -n kern.boottime
df -h
diskutil list
```

### Processes and services

```sh
ps aux
top -l 1 -o cpu -n 20
pgrep -fl 'process-name'
launchctl list
```

Use `kill` only with a verified PID. Avoid `kill -9` unless normal termination has failed and the user requested termination.

### Network

```sh
networksetup -listallhardwareports
ifconfig
lsof -nP -iTCP -sTCP:LISTEN
scutil --dns
curl -I 'https://example.com'
```

### Packages, apps, and settings

```sh
brew list
brew search 'package-name'
brew install 'package-name'
open -a 'Application Name'
open '/path'
defaults read 'domain'
```

### Permissions

```sh
ls -leO@ '/path'
codesign -dv --verbose=4 '/Applications/App.app'
tccutil reset All 'bundle.identifier'
```

Do not reset privacy permissions unless the user explicitly requests it and the bundle identifier is verified.

## Execution rules

- Prefer commands included with macOS before suggesting GNU-only flags.
- Quote user paths with single quotes and escape embedded single quotes safely.
- Combine related read-only inspections when this reduces round trips.
- After a mutation, run a read-only verification command.
- Use `osascript`, `defaults write`, `launchctl`, recursive deletion, and permission changes cautiously.
