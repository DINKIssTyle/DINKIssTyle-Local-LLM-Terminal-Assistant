---
name: linux-commands
description: Use portable Linux shell commands for terminal operations, system inspection, files, processes, services, networking, packages, logs, and environment configuration. Apply when DKST Terminal AI runs on Linux and the user requests a local terminal or operating-system task.
---

# Linux Commands

Prefer portable commands first, then use distribution-specific tools only after detecting availability.

## Command set

### Location and files

```sh
pwd
ls -la
find '/path' -maxdepth 2 -type f
sed -n '1,160p' '/path/file'
mkdir -p '/path/folder'
cp -a '/source' '/target'
mv '/source' '/target'
rm -i '/path/file'
```

Inspect exact targets before recursive deletion. Do not use broad targets such as `/`, `$HOME`, or `~`.

### System and storage

```sh
cat /etc/os-release
uname -a
lscpu
free -h
uptime -s
df -h
lsblk -f
```

### Processes, services, and logs

```sh
ps aux --sort=-%cpu
pgrep -af 'process-name'
systemctl --no-pager --type=service --state=running
systemctl status 'service-name' --no-pager
journalctl -u 'service-name' -n 100 --no-pager
```

Detect `systemctl` before use because some distributions and containers use another init system.

### Network

```sh
ip address
ip route
ss -lntup
getent hosts 'example.com'
curl -I 'https://example.com'
```

Use `hostname -I` or `netstat` only as a fallback when the preferred command is unavailable.

### Packages

```sh
command -v apt dnf yum pacman zypper apk
apt list --installed
dnf list installed
pacman -Q
```

Detect the package manager first. Do not add `sudo` unless elevated access is necessary and the user approves the operation.

### Environment and permissions

```sh
printenv
printf '%s\n' "$PATH"
stat '/path'
getfacl '/path'
```

## Execution rules

- Prefer POSIX-compatible syntax unless the active shell is known.
- Quote user paths with single quotes and escape embedded single quotes safely.
- Combine related read-only inspections when this reduces round trips.
- After a mutation, run a read-only verification command.
- Treat `sudo`, recursive deletion, service changes, firewall changes, and system package operations as sensitive.
