const fs = require('node:fs');
const path = require('node:path');

const frontendRoot = path.resolve(__dirname, '..');
const fontsDirectory = path.join(frontendRoot, 'src', 'assets', 'fonts');
const manifestPath = path.join(fontsDirectory, 'material-symbols-outlined.icons.txt');
const outputPath = path.join(fontsDirectory, 'material-symbols-outlined.woff2');
const appSourcePath = path.join(frontendRoot, 'src', 'App.tsx');

const icons = fs.readFileSync(manifestPath, 'utf8')
    .split(/\r?\n/)
    .map(value => value.trim())
    .filter(Boolean);
const expected = [...new Set(icons)].sort();

if (icons.some(name => !/^[a-z0-9_]+$/.test(name))) {
    throw new Error('Material Symbol names may contain only lowercase letters, numbers, and underscores.');
}
if (icons.join('\n') !== expected.join('\n')) {
    throw new Error('Material Symbol names must be unique and alphabetically sorted.');
}

const appSource = fs.readFileSync(appSourcePath, 'utf8');
const usedIcons = new Set();
const iconComponents = appSource.match(/<MaterialIcon\b[\s\S]*?\/>/g) || [];
for (const component of iconComponents) {
    for (const match of component.matchAll(/['"]([a-z][a-z0-9_]*)['"]/g)) {
        usedIcons.add(match[1]);
    }
}
const messageIconFunction = appSource.match(/function getMessageIcon\b[\s\S]*?\n}/)?.[0] || '';
for (const match of messageIconFunction.matchAll(/return\s+['"]([a-z][a-z0-9_]*)['"]/g)) {
    usedIcons.add(match[1]);
}
const missingIcons = [...usedIcons].filter(name => !icons.includes(name)).sort();
if (missingIcons.length > 0) {
    throw new Error(`Material Symbols manifest is missing icons used by App.tsx: ${missingIcons.join(', ')}`);
}

const cssURL = new URL('https://fonts.googleapis.com/css2');
cssURL.searchParams.set('family', 'Material Symbols Outlined');
cssURL.searchParams.set('icon_names', icons.join(','));
cssURL.searchParams.set('display', 'block');

async function download() {
    const cssResponse = await fetch(cssURL, {
        headers: {
            'User-Agent': 'Mozilla/5.0 AppleWebKit/537.36 Chrome/130 Safari/537.36',
        },
    });
    if (!cssResponse.ok) {
        throw new Error(`Google Fonts CSS request failed: HTTP ${cssResponse.status}`);
    }
    const css = await cssResponse.text();
    const fontURL = css.match(/src:\s*url\((https:\/\/[^)]+)\)\s*format\(['"]woff2['"]\)/i)?.[1];
    if (!fontURL) {
        throw new Error(`Google Fonts CSS did not contain a WOFF2 URL:\n${css}`);
    }

    const fontResponse = await fetch(fontURL);
    if (!fontResponse.ok) {
        throw new Error(`Material Symbols font request failed: HTTP ${fontResponse.status}`);
    }
    const bytes = Buffer.from(await fontResponse.arrayBuffer());
    if (bytes.subarray(0, 4).toString('ascii') !== 'wOF2') {
        throw new Error('Downloaded file is not a WOFF2 font.');
    }

    fs.writeFileSync(outputPath, bytes);
    process.stdout.write(`Updated ${path.relative(frontendRoot, outputPath)} with ${icons.length} icons (${bytes.length} bytes).\n`);
}

download().catch(error => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
});
