// Prepares the files that the IntelliJ plugin takes from the VS Code extension, so that both stay the same:
// the editor webview, its style, the French texts, the JSON schema, the Java runtime and the system templates.
// Usage: node web/build.mjs <output folder>  (writes <output folder>/sparkle/...)
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const vscode = resolve(here, '../../vscode');
const output = process.argv[2];
if (!output) {
    console.error('Usage: node web/build.mjs <output folder>');
    process.exit(1);
}

if (!existsSync(join(vscode, 'node_modules', 'esbuild'))) {
    console.error(`The packages of the VS Code extension are missing: run "npm install" in ${vscode}`);
    process.exit(1);
}

const esbuild = createRequire(join(vscode, 'package.json'))('esbuild');
const target = join(resolve(output), 'sparkle');
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

// The editor: the same webview as in VS Code.
await esbuild.build({
    entryPoints: [join(vscode, 'src/webview/main.ts')],
    outfile: join(target, 'webview.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    logLevel: 'warning',
});

cpSync(join(vscode, 'media/editor.css'), join(target, 'editor.css'));
// French texts: the bundle of the extension, plus the names of its commands (package.nls.*.json), by English text.
const readJson = path => JSON.parse(readFileSync(join(vscode, path), 'utf8'));
const french = readJson('l10n/bundle.l10n.fr.json');
const englishNls = readJson('package.nls.json');
const frenchNls = readJson('package.nls.fr.json');
for (const [key, english] of Object.entries(englishNls)) {
    if (frenchNls[key] && !(english in french)) {
        french[english] = frenchNls[key];
    }
}

writeFileSync(join(target, 'l10n.fr.json'), JSON.stringify(french, null, 2) + '\n');
cpSync(join(vscode, 'schemas/sparkle-system.schema.json'), join(target, 'schema.json'));

// The runtime, with the list of its files (a jar cannot list a folder).
const runtime = {};
for (const folder of readdirSync(join(vscode, 'runtime'))) {
    runtime[folder] = readdirSync(join(vscode, 'runtime', folder)).filter(f => f.endsWith('.java')).sort();
    cpSync(join(vscode, 'runtime', folder), join(target, 'runtime', folder), { recursive: true });
}

writeFileSync(join(target, 'runtime', 'index.json'), JSON.stringify(runtime, null, 2) + '\n');

// The templates of "New particle system", made by the code of the extension.
const exporter = join(resolve(output), 'export.cjs');
await esbuild.build({
    entryPoints: [join(here, 'export.ts')],
    outfile: exporter,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    mainFields: ['module', 'main'],
    logLevel: 'warning',
});

const { exportTemplates } = await import(pathToFileURL(exporter).href);
writeFileSync(join(target, 'templates.json'), JSON.stringify(exportTemplates(join(vscode, 'l10n/bundle.l10n.fr.json')), null, 2) + '\n');
rmSync(exporter);
console.log(`Sparkle web files written to ${target}`);
