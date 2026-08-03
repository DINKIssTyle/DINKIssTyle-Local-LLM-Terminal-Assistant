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
