---
name: windows-powershell-commands
description: Execute reliable native PowerShell commands for Windows terminal work, including system and hardware inspection, files, processes, services, networking, packages, and environment configuration. Apply whenever DKST Terminal AI runs on Windows and needs to issue, repair, or interpret a local command, especially when quoting, pipelines, Select-Object, CIM/WMI output, prompt recovery, or repeated command attempts are involved.
---

# Windows PowerShell Commands

The app terminal is already PowerShell. Send only a script body to `execute_command`.

## Non-negotiable execution contract

1. Never prefix a command with `powershell`, `powershell.exe`, `pwsh`, or `-Command` when the active terminal is already PowerShell. A nested shell adds another quoting layer and commonly corrupts quotes, pipes, and closing braces.
2. Put only the PowerShell script in the tool's `command` string. The JSON closing `}` and the tool-call closing tag are protocol syntax; never include either in the shell command.
3. Execute one bounded read-only inspection. Combine related properties, but stop when the requested values are visible.
4. When the requested values appear and the `PS ...>` prompt returns, treat the command as successful and answer. Do not run the same command again to reconfirm it.
5. When a command fails, read the `CategoryInfo` and `FullyQualifiedErrorId`, change the faulty syntax, and retry once with a materially different command. Never repeat an identical failed command.

Correct — send the script body directly:

```powershell
Get-CimInstance -ClassName Win32_OperatingSystem | Select-Object Caption, Version
```

Incorrect — never send a nested shell wrapper or a protocol brace:

```powershell
powershell -Command "Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version"}
```

## Syntax and quoting

- Separate `Select-Object` properties with commas: `Select-Object Caption, Version`. A space does not separate property arguments.
- Use full cmdlet names in generated commands. Avoid aliases such as `select`, `where`, `sort`, `cat`, `dir`, or `del`.
- Use single quotes for literal strings and paths. Escape an embedded single quote by doubling it.
- Use double quotes only when PowerShell variable or subexpression expansion is required.
- Do not use C/JSON-style `\"` escaping inside PowerShell. Let the tool-call JSON encode the command once.
- Keep pipeline braces balanced. A calculated property has exactly one hashtable brace pair and one script-block brace pair:

```powershell
@{Name='VRAM_MB'; Expression={[math]::Round([uint64]$_.AdapterRAM / 1MB)}}
```

- Prefer `-LiteralPath` for user-provided filesystem paths.

## Produce observable, compact output

PowerShell tables can wrap or truncate in a narrow terminal. For facts consumed by the assistant, prefer selected properties followed by compact JSON:

```powershell
Get-CimInstance -ClassName Win32_OperatingSystem |
    Select-Object Caption, Version, OSArchitecture, LastBootUpTime |
    ConvertTo-Json -Compress
```

Use a table only when every requested column fits. Do not use `Format-Table` before further processing; it emits display objects.

For multiple rows, retain array shape when it matters:

```powershell
@(Get-CimInstance -ClassName Win32_VideoController |
    Select-Object Name, AdapterCompatibility,
        @{Name='VRAM_MB'; Expression={if ($null -ne $_.AdapterRAM) {[math]::Round([uint64]$_.AdapterRAM / 1MB)} else {$null}}}) |
    ConvertTo-Json -Compress
```

Report `Microsoft Remote Display Adapter` alongside the physical GPU unless the user asks to exclude virtual adapters.

## Interpret the terminal screen correctly

- Treat text after the echoed command and before the next recovered `PS ...>` prompt as the current command's evidence.
- A long prompt or echoed command may wrap across visual lines. Do not mistake wrapped command text for output or truncation.
- A header, separator, and one or more data rows followed by a recovered prompt is a complete successful table.
- Red `CategoryInfo`, `FullyQualifiedErrorId`, `ParserError`, `ParameterBindingException`, or `CommandNotFoundException` lines are failure evidence.
- `>>` is the PowerShell continuation prompt and means a quote, parenthesis, brace, or pipeline is incomplete.
- If output already contains every fact requested, answer from it. Do not inspect all object properties merely because more properties exist.

## Reliable inspection recipes

### Windows version

```powershell
Get-CimInstance -ClassName Win32_OperatingSystem |
    Select-Object Caption, Version, OSArchitecture |
    ConvertTo-Json -Compress
```

Do not use `Get-ComputerInfo -Property WindowsProductName WindowsVersion`; the property names require a comma and may vary by PowerShell version.

### Boot time and uptime

```powershell
$os = Get-CimInstance -ClassName Win32_OperatingSystem; [pscustomobject]@{LastBootUpTime=$os.LastBootUpTime; Uptime=((Get-Date)-$os.LastBootUpTime).ToString()} | ConvertTo-Json -Compress
```

The CIM property is `LastBootUpTime`, not `BootUpTime`. Do not append a stray `}` after the property name.

### GPUs

```powershell
@(Get-CimInstance -ClassName Win32_VideoController | Select-Object Name, AdapterCompatibility, @{Name='VRAM_MB';Expression={if ($null -ne $_.AdapterRAM) {[math]::Round([uint64]$_.AdapterRAM/1MB)} else {$null}}}) | ConvertTo-Json -Compress
```

For other domains, prefer native cmdlets, select only requested properties, and bound large lists with `Select-Object -First N`. Confirm sensitive mutations, inspect exact targets first, and verify a mutation once with a read-only command.

## Recovery map

- `PositionalParameterNotFound`: add missing commas between property names or correct named parameters.
- `UnexpectedToken` or `IncompleteParseException`: remove wrapper-shell quoting, then check the final quote, parenthesis, and brace. Do not paste the tool-call `}` into the command.
- `CommandNotFoundException`: replace cmd.exe, Bash, or alias syntax with a native PowerShell cmdlet.
- Empty result with a recovered prompt: verify the class/property name once or use a documented alternative query.
- Successful result with a recovered prompt: stop executing and answer from the observed rows.
