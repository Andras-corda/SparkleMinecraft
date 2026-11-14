// Builds the extension (Node, CommonJS), the webview of the editor (browser) and, with --tests, the unit tests.
import * as esbuild from 'esbuild';
import { readdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const tests = process.argv.includes('--tests');
const integration = process.argv.includes('--integration');

const builds = [
    {
        entryPoints: ['src/extension.ts'],
        outfile: 'dist/extension.js',
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node18',
        external: ['vscode'],
        // jsonc-parser: its ES modules (the UMD build loads its parts at run time, which a bundle cannot follow).
        mainFields: ['module', 'main'],
        sourcemap: true,
    },
    {
        entryPoints: ['src/webview/main.ts'],
        outfile: 'dist/webview.js',
        bundle: true,
        platform: 'browser',
        format: 'iife',
        target: 'es2022',
        sourcemap: true,
    },
];

if (tests) {
    builds.push({
        entryPoints: readdirSync('test').filter(f => f.endsWith('.test.ts')).map(f => `test/${f}`),
        outdir: 'out/test',
        bundle: true,
        mainFields: ['module', 'main'],
        platform: 'node',
        format: 'cjs',
        target: 'node18',
    });
}

if (integration) {
    builds.push({
        entryPoints: ['test-integration/index.ts'],
        outfile: 'out/integration/index.js',
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node18',
        external: ['vscode'],
    });
}

if (watch) {
    for (const options of builds) {
        const context = await esbuild.context(options);
        await context.watch();
    }
} else {
    await Promise.all(builds.map(options => esbuild.build(options)));
}
