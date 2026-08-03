const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const harnessPath = path.resolve(__dirname, '../src/prompt/harness.ts');
const source = fs.readFileSync(harnessPath, 'utf8');
const compiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
    },
}).outputText;

const loadedModule = { exports: {} };
new Function('exports', 'module', 'require', compiled)(loadedModule.exports, loadedModule, require);
const harness = loadedModule.exports;

const cases = [
    {
        name: 'detects a truncated CPU answer',
        actual: () => harness.getMissingRequestedLocalFacts(
            'CPU 모델: Apple M4 Pro\n물리적 코어 수: 14',
            'CPU model, physical core count, logical core count',
        ),
        expected: ['logical core count'],
    },
    {
        name: 'accepts a complete CPU answer',
        actual: () => harness.getMissingRequestedLocalFacts(
            'CPU 모델: Apple M4 Pro\n물리적 코어 수: 14\n논리 코어 수: 14',
            'CPU model, physical core count, logical core count',
        ),
        expected: [],
    },
    {
        name: 'requires hidden entry coverage',
        actual: () => harness.getMissingRequestedLocalFacts('README.md, frontend', 'list hidden files'),
        expected: ['hidden entries'],
    },
    {
        name: 'accepts an observed hidden entry',
        actual: () => harness.getMissingRequestedLocalFacts('.git, README.md', 'list hidden files'),
        expected: [],
    },
    {
        name: 'blocks an unrequested directory change',
        actual: () => harness.shouldRejectUnexpectedDirectoryChange('list current directory', 'cd ..; pwd'),
        expected: true,
    },
    {
        name: 'allows an explicitly requested directory change',
        actual: () => harness.shouldRejectUnexpectedDirectoryChange('change directory to /tmp', 'cd /tmp; pwd'),
        expected: false,
    },
    {
        name: 'requires a real directory listing',
        actual: () => harness.getMissingRequiredTerminalActions(
            'show current directory and list entries',
            ['cd ..; pwd'],
        ),
        expected: ['directory listing'],
    },
    {
        name: 'rejects a top-level-only largest-file command',
        actual: () => harness.getMissingRequiredTerminalActions(
            'find five largest regular files',
            ['ls -lS | head -5'],
        ),
        expected: ['large-file scan'],
    },
    {
        name: 'accepts a recursive largest-file scan',
        actual: () => harness.getMissingRequiredTerminalActions(
            'find five largest regular files',
            ['find . -type f -exec du -k {} + | sort -nr | head -n 5'],
        ),
        expected: [],
    },
    {
        name: 'recovers a search tool routed as a shell command',
        actual: () => harness.recoverAppToolRoutedAsCommand(
            {
                toolName: 'execute_command',
                commandText: 'search_web M5 Pro GPU 코어 수',
                toolArgs: '{"command":"search_web M5 Pro GPU 코어 수"}',
            },
            [{
                name: 'search_web',
                inputSchema: {
                    properties: { query: { type: 'string' } },
                    required: ['query'],
                },
            }],
        ),
        expected: {
            toolName: 'search_web',
            commandText: 'M5 Pro GPU 코어 수',
            toolArgs: '{"query":"M5 Pro GPU 코어 수"}',
            recovered: true,
        },
    },
    {
        name: 'keeps a real shell command unchanged',
        actual: () => harness.recoverAppToolRoutedAsCommand(
            {
                toolName: 'execute_command',
                commandText: 'uname -a',
                toolArgs: '{"command":"uname -a"}',
            },
            [{
                name: 'search_web',
                inputSchema: {
                    properties: { query: { type: 'string' } },
                    required: ['query'],
                },
            }],
        ),
        expected: {
            toolName: 'execute_command',
            commandText: 'uname -a',
            toolArgs: '{"command":"uname -a"}',
            recovered: false,
        },
    },
    {
        name: 'recovers compact JSON app tool syntax routed as a shell command',
        actual: () => harness.recoverAppToolRoutedAsCommand(
            {
                toolName: 'execute_command',
                commandText: 'search_web{"query":"Apple M5 Pro GPU 코어 개수"}',
                toolArgs: '{"command":"search_web{\\"query\\":\\"Apple M5 Pro GPU 코어 개수\\"}"}',
            },
            [{
                name: 'search_web',
                inputSchema: {
                    properties: { query: { type: 'string' } },
                    required: ['query'],
                },
            }],
        ),
        expected: {
            toolName: 'search_web',
            commandText: '{"query":"Apple M5 Pro GPU 코어 개수"}',
            toolArgs: '{"query":"Apple M5 Pro GPU 코어 개수"}',
            recovered: true,
        },
    },
    {
        name: 'recovers parenthesized JSON app tool syntax routed as a shell command',
        actual: () => harness.recoverAppToolRoutedAsCommand(
            {
                toolName: 'execute_command',
                commandText: 'search_web({"query":"GPU news"})',
                toolArgs: '{"command":"search_web({\\"query\\":\\"GPU news\\"})"}',
            },
            [{
                name: 'search_web',
                inputSchema: {
                    properties: { query: { type: 'string' } },
                    required: ['query'],
                },
            }],
        ),
        expected: {
            toolName: 'search_web',
            commandText: '{"query":"GPU news"}',
            toolArgs: '{"query":"GPU news"}',
            recovered: true,
        },
    },
    {
        name: 'never sends an ambiguous app tool to the shell',
        actual: () => Boolean(harness.recoverAppToolRoutedAsCommand(
            {
                toolName: 'execute_command',
                commandText: 'multi_tool value',
                toolArgs: '{"command":"multi_tool value"}',
            },
            [{
                name: 'multi_tool',
                inputSchema: {
                    properties: { first: { type: 'string' }, second: { type: 'string' } },
                    required: ['first', 'second'],
                },
            }],
        ).error),
        expected: true,
    },
    {
        name: 'suppresses a repeated app tool call',
        actual: () => harness.shouldSuppressDuplicateAppToolCall('search_web', 1),
        expected: true,
    },
    {
        name: 'keeps terminal repetition under terminal-specific recovery',
        actual: () => harness.shouldSuppressDuplicateAppToolCall('execute_command', 1),
        expected: false,
    },
    {
        name: 'recognizes a completed answer before a trailing verification command',
        actual: () => harness.hasSubstantiveAnswerBeforeToolCall(
            '운영체제 버전은 Microsoft Windows 11 Pro (버전 10.0.26200)입니다.\n<execute_command>{"command":"Get-CimInstance Win32_OperatingSystem"}</execute_command>',
            '<execute_command>{"command":"Get-CimInstance Win32_OperatingSystem"}</execute_command>',
        ),
        expected: true,
    },
    {
        name: 'does not mistake command narration for a completed answer',
        actual: () => harness.hasSubstantiveAnswerBeforeToolCall(
            '정확한 버전을 다시 확인하겠습니다.\n<execute_command>{"command":"Get-CimInstance Win32_OperatingSystem"}</execute_command>',
            '<execute_command>{"command":"Get-CimInstance Win32_OperatingSystem"}</execute_command>',
        ),
        expected: false,
    },
    {
        name: 'canonicalizes visually identical terminal commands',
        actual: () => harness.canonicalizeTerminalCommand('  Get-CimInstance   Win32_Processor |\r\n Select-Object Name;  '),
        expected: 'get-ciminstance win32_processor | select-object name',
    },
    {
        name: 'recognizes an explicit request not to repeat a command',
        actual: () => harness.userForbidsCommandRepeat('실패한 명령을 반복하지 말고 다른 안전한 명령을 사용하세요'),
        expected: true,
    },
    {
        name: 'does not block a normal request merely containing 다시',
        actual: () => harness.userForbidsCommandRepeat('CPU 정보를 다시 알려주세요'),
        expected: false,
    },
    {
        name: 'parses a missing-pipe local-model tool token',
        actual: () => harness.parseTokenStyleToolEnvelope(
            '<|tool_call>execute_command{"command":"wmic path win32_videocontroller get caption, adapterram"}',
        ),
        expected: {
            raw: '<|tool_call>execute_command{"command":"wmic path win32_videocontroller get caption, adapterram"}',
            toolName: 'execute_command',
            payloadText: '{"command":"wmic path win32_videocontroller get caption, adapterram"}',
        },
    },
    {
        name: 'keeps PowerShell braces inside token-style JSON strings',
        actual: () => harness.parseTokenStyleToolEnvelope(
            '<|tool_call|>execute_command{"command":"Get-CimInstance X | Select @{N=\'A\';E={$_.B}}"}<|/tool_call|>',
        )?.payloadText,
        expected: '{"command":"Get-CimInstance X | Select @{N=\'A\';E={$_.B}}"}',
    },
    {
        name: 'recognizes a PowerShell prompt after a legacy CWD marker',
        actual: () => harness.looksLikeRecoveredShellPromptLine(
            '2026-06-10 오후 10:36:09\\u0007e]633;cwd=C:\\WorkPS C:\\Work>',
        ),
        expected: true,
    },
    {
        name: 'rejects per-module memory rows as a total-memory check',
        actual: () => harness.getMissingRequiredTerminalActions(
            '설치된 총 메모리 용량을 알려주세요',
            ['Get-CimInstance Win32_PhysicalMemory | Select-Object Capacity, @{N="TotalGB";E={$_.Capacity / 1GB}}'],
        ),
        expected: ['total installed memory aggregation (use Win32_ComputerSystem.TotalPhysicalMemory or Measure-Object Capacity -Sum)'],
    },
    {
        name: 'accepts an explicitly summed physical-memory query',
        actual: () => harness.getMissingRequiredTerminalActions(
            'total installed memory',
            ['(Get-CimInstance Win32_PhysicalMemory | Measure-Object Capacity -Sum).Sum / 1GB'],
        ),
        expected: [],
    },
    {
        name: 'accepts Win32 ComputerSystem total physical memory',
        actual: () => harness.getMissingRequiredTerminalActions(
            'installed RAM',
            ['Get-CimInstance Win32_ComputerSystem | Select-Object TotalPhysicalMemory'],
        ),
        expected: [],
    },
    {
        name: 'corrects a per-module command for a total-memory request',
        actual: () => harness.correctTotalInstalledMemoryCommand(
            '설치된 총 메모리 용량을 알려주세요',
            'Get-CimInstance Win32_PhysicalMemory | Select-Object Capacity',
            true,
        ),
        expected: "Get-CimInstance -ClassName Win32_ComputerSystem | Select-Object @{Name='TotalMemoryGB';Expression={[math]::Round([double]$_.TotalPhysicalMemory / 1GB, 2)}} | ConvertTo-Json -Compress",
    },
    {
        name: 'preserves a memory-module detail query',
        actual: () => harness.correctTotalInstalledMemoryCommand(
            '설치된 메모리 모듈과 제조사를 알려주세요',
            'Get-CimInstance Win32_PhysicalMemory | Select-Object Capacity, Manufacturer',
            true,
        ),
        expected: 'Get-CimInstance Win32_PhysicalMemory | Select-Object Capacity, Manufacturer',
    },
];

let passed = 0;
for (const testCase of cases) {
    const actual = testCase.actual();
    if (JSON.stringify(actual) !== JSON.stringify(testCase.expected)) {
        console.error(`${testCase.name}: expected ${JSON.stringify(testCase.expected)}, got ${JSON.stringify(actual)}`);
        process.exitCode = 1;
        continue;
    }
    passed += 1;
}

console.log(`${passed}/${cases.length} prompt regression cases passed`);
