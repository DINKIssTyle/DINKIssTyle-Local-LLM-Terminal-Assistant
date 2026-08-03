---
name: windows-powershell-commands
description: Use native Windows PowerShell commands for terminal operations, system inspection, files, processes, services, networking, packages, and environment configuration. Apply when DKST Terminal AI runs on Windows and the user requests a local terminal or operating-system task.
---

# Windows PowerShell Commands

Use PowerShell syntax only. Prefer built-in cmdlets and return observable output after changes.

## Command set

### Location and files

```powershell
Get-Location
Get-ChildItem -Force
Get-ChildItem -LiteralPath 'C:\path' -Force
Get-Content -LiteralPath 'C:\path\file.txt' -Raw
New-Item -ItemType Directory -Path 'C:\path\folder' -Force
Copy-Item -LiteralPath 'C:\source' -Destination 'C:\target' -Recurse
Move-Item -LiteralPath 'C:\source' -Destination 'C:\target'
Remove-Item -LiteralPath 'C:\target' -Recurse -Force
```

Use `-LiteralPath` for user-provided paths. Inspect a target before deleting it.

### System and storage

```powershell
Get-ComputerInfo | Select-Object WindowsProductName, WindowsVersion, OsArchitecture
Get-CimInstance Win32_Processor | Select-Object Name, NumberOfCores, NumberOfLogicalProcessors
Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize, FreePhysicalMemory, LastBootUpTime
Get-Volume | Select-Object DriveLetter, FileSystemLabel, Size, SizeRemaining
```

### Processes and services

```powershell
Get-Process | Sort-Object CPU -Descending | Select-Object -First 20
Get-Service | Sort-Object Status, DisplayName
Get-Service -Name 'service-name'
Start-Service -Name 'service-name'
Stop-Service -Name 'service-name'
```

Confirm before stopping services or processes unless the user explicitly requested the exact target.

### Network

```powershell
Get-NetIPConfiguration
Get-NetTCPConnection -State Listen
Test-NetConnection -ComputerName 'example.com' -Port 443
Resolve-DnsName 'example.com'
```

### Packages and environment

```powershell
winget list
winget search 'package-name'
winget install --id 'Publisher.Package' --exact
[Environment]::GetEnvironmentVariable('PATH', 'User')
[Environment]::SetEnvironmentVariable('NAME', 'value', 'User')
```

## Execution rules

- Do not emit Bash operators or Unix-only commands.
- Quote paths with single quotes; escape an embedded single quote by doubling it.
- Prefer one read-only command that gathers all requested fields.
- After a mutation, run a separate read-only check that proves the result.
- Treat registry edits, recursive deletion, service changes, and system-wide package changes as sensitive operations.
