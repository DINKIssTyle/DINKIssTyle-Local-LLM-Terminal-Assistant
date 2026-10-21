// Compare the app's existing complexity heuristic on exactly the primary cases.
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const ts = require('../../frontend/node_modules/typescript');
const source = fs.readFileSync(path.resolve(__dirname, '../../frontend/src/prompt/harness.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const loaded = { exports: {} };
new Function('exports', 'module', 'require', compiled)(loaded.exports, loaded, require);
const result = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'results/multilingual-cpu.json'), 'utf8'));
const rows = result.rows.filter(row => row.variant === 'original' && row.group === 'intent').map(row => ({
    id: row.id,
    expectedPlanned: row.expected === 'C',
    heuristicPlanned: loaded.exports.shouldUseComplexTaskMode(row.state),
    layaPlanned: row.predicted === 'C',
}));
const report = {
    harnessSha256: crypto.createHash('sha256').update(source).digest('hex'),
    note: 'Binary planned-task detection only; the app heuristic is a hint, not its full execution behavior.',
    cases: rows.length,
    heuristicCorrect: rows.filter(r => r.expectedPlanned === r.heuristicPlanned).length,
    layaCorrect: rows.filter(r => r.expectedPlanned === r.layaPlanned).length,
    rows,
};
fs.writeFileSync(path.resolve(__dirname, 'results/intent-baseline.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
