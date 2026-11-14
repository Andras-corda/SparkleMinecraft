/**
 * Runs the extension in a real VS Code on a copy of a mod project (see README: "Integration test"). The questions of the
 * extension are answered by stubs of vscode.window; the steps and their results go to the file SPARKLE_IT_RESULT.
 * SPARKLE_IT_HOLD keeps the editor open for some seconds at the end (for a screenshot).
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';

interface Answers {
    /** First part of a question (any language) to the button to press; the first button otherwise. */
    buttons: [RegExp, string | undefined][];
    pick?: (label: string) => boolean;
    input?: string;
}

const answers: Answers = { buttons: [] };
const log: string[] = [];
const resultPath = process.env.SPARKLE_IT_RESULT ?? join(process.cwd(), 'sparkle-it.log');

function note(line: string): void {
    log.push(line);
    appendFileSync(resultPath, line + '\n');
}

function stub(): void {
    const window = vscode.window as unknown as Record<string, unknown>;
    const answer = (kind: string) => async (message: string, ...rest: unknown[]) => {
        const items = rest.filter(r => typeof r === 'string') as string[];
        const options = rest.find(r => typeof r === 'object' && r !== null && !Array.isArray(r)) as { detail?: string } | undefined;
        const rule = answers.buttons.find(([pattern]) => pattern.test(message));
        const chosen = rule ? rule[1] : items[0];
        note(`  [${kind}] ${message}${options?.detail ? ` | ${options.detail.replace(/\n/g, ' / ')}` : ''} -> ${chosen ?? '(closed)'}`);
        return chosen;
    };
    window.showInformationMessage = answer('info');
    window.showWarningMessage = answer('warning');
    window.showErrorMessage = answer('error');
    window.showQuickPick = async (items: readonly vscode.QuickPickItem[] | Thenable<readonly vscode.QuickPickItem[]>) => {
        const list = await items;
        const chosen = list.find(i => answers.pick?.(i.label) ?? true);
        note(`  [pick] ${list.map(i => i.label).join(' | ')} -> ${chosen?.label}`);
        return chosen;
    };
    window.showInputBox = async (options?: vscode.InputBoxOptions) => {
        const value = answers.input;
        const error = value !== undefined ? await options?.validateInput?.(value) : undefined;
        note(`  [input] ${options?.prompt} -> ${value}${error ? ` (refused: ${typeof error === 'string' ? error : error.message})` : ''}`);
        return error ? undefined : value;
    };
}

function check(condition: boolean, text: string): void {
    note(`${condition ? 'PASS' : 'FAIL'} ${text}`);
    if (!condition) {
        failures++;
    }
}

let failures = 0;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function javaFolder(root: string): string | undefined {
    const find = (folder: string): string | undefined => {
        for (const entry of readdirSync(folder, { withFileTypes: true })) {
            const path = join(folder, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'sparkle' && existsSync(join(path, 'Sparkle.java'))) {
                    return path;
                }

                const found = find(path);
                if (found) {
                    return found;
                }
            }
        }

        return undefined;
    };
    const java = join(root, 'src', 'main', 'java');
    return existsSync(java) ? find(java) : undefined;
}

export async function run(): Promise<void> {
    writeFileSync(resultPath, '');
    stub();
    const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
    note(`Project: ${root}`);
    note(`Language: ${vscode.env.language}`);
    const extension = vscode.extensions.all.find(e => e.id.endsWith('sparkle-particles'));
    await extension?.activate();
    check(extension?.isActive === true, 'the extension starts');

    note('1. Install the runtime');
    answers.buttons = [];
    await vscode.commands.executeCommand('sparkle.installRuntime');
    const folder = javaFolder(root);
    check(folder !== undefined, `the runtime is written (${folder})`);
    check(existsSync(join(root, '.sparkle', 'runtime.json')), 'the manifest is written');
    const fabric = existsSync(join(root, 'src', 'main', 'resources', 'fabric.mod.json'));
    if (fabric) {
        const json = readFileSync(join(root, 'src', 'main', 'resources', 'fabric.mod.json'), 'utf8');
        check(json.includes('SparkleFabric"') && json.includes('SparkleFabricClient'), 'the Fabric entry points are added');
        check(existsSync(join(folder!, 'SparkleFabric.java')) && !existsSync(join(folder!, 'SparkleForge.java')), 'the Fabric adapter is the one installed');
    } else {
        const neo = /net\.neoforged/.test(readFileSync(join(root, 'build.gradle'), 'utf8'));
        check(existsSync(join(folder!, neo ? 'SparkleNeoForge.java' : 'SparkleForge.java')), `the ${neo ? 'NeoForge' : 'Forge'} adapter is the one installed`);
    }

    const config = readFileSync(join(folder!, 'SparkleConfig.java'), 'utf8');
    check(!config.includes('__MODID__') && !config.includes('__PACKAGE__'), 'the tokens are replaced');

    note('2. Install again: nothing to write');
    const before = log.length;
    await vscode.commands.executeCommand('sparkle.installRuntime');
    check(log.slice(before).some(l => / 0 (files|fichiers)/.test(l)), 'a second install has nothing to write');

    note('3. A file changed by hand is kept, then replaced with a copy');
    const sparkle = join(folder!, 'Sparkle.java');
    const original = readFileSync(sparkle, 'utf8');
    writeFileSync(sparkle, original + '\n// changed by hand\n');
    answers.buttons = [[/Sparkle\.java/, vscode.l10n.t('Keep mine')]];
    await vscode.commands.executeCommand('sparkle.installRuntime');
    check(readFileSync(sparkle, 'utf8').includes('// changed by hand'), '"Keep mine" keeps the file');
    answers.buttons = [];
    const beforeReplace = log.length;
    await vscode.commands.executeCommand('sparkle.installRuntime');
    check(log.slice(beforeReplace).some(l => /Sparkle\.java (was changed since|a été modifié depuis)/.test(l)), 'a kept file is still known as changed by hand');
    check(!readFileSync(sparkle, 'utf8').includes('// changed by hand'), '"Replace" writes the new version');
    const backups = join(root, '.sparkle', 'backup');
    const copies = existsSync(backups) ? readdirSync(backups, { recursive: true }).map(String).filter(p => p.endsWith('Sparkle.java')) : [];
    check(copies.some(p => readFileSync(join(backups, p), 'utf8').includes('// changed by hand')), 'the changed file is in the backup');

    note('4. New particle system from a template');
    answers.pick = label => label === vscode.l10n.t('Ribbon');
    answers.input = 'it_ribbon';
    await vscode.commands.executeCommand('sparkle.newSystem');
    const systems = join(root, 'src', 'main', 'resources', 'assets');
    const created = readdirSync(systems, { recursive: true }).map(String).find(p => p.endsWith('it_ribbon.json'));
    check(created !== undefined, `the system file is written (${created})`);
    const system = created ? JSON.parse(readFileSync(join(systems, created), 'utf8')) : undefined;
    check(system?.emitters?.length === 2, 'the ribbon has its two emitters');
    answers.input = 'it_ribbon';
    const writtenBefore = readFileSync(join(systems, created!), 'utf8');
    await vscode.commands.executeCommand('sparkle.newSystem');
    check(readFileSync(join(systems, created!), 'utf8') === writtenBefore, 'an existing system is never written over');

    await delay(1500);
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    check(tab instanceof vscode.TabInputCustom && tab.viewType === 'sparkle.systemEditor', 'the system opens in the Sparkle editor');

    note('5. Code that plays the system');
    await vscode.commands.executeCommand('sparkle.copyPlayCode', vscode.Uri.file(join(systems, created!)));
    const code = await vscode.env.clipboard.readText();
    check(/^Sparkle\.play\(level, "[a-z0-9_]+:it_ribbon", x, y, z\);$/.test(code), `the code is copied: ${code}`);

    note('6. An edit made as text reaches the editor; undo works');
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(join(systems, created!)));
    const edit = new vscode.WorkspaceEdit();
    const text = document.getText().replace('"name": "', '"name": "Edited ');
    edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), text);
    check(await vscode.workspace.applyEdit(edit), 'a text edit applies');
    await vscode.commands.executeCommand('vscode.openWith', document.uri, 'sparkle.systemEditor');
    await vscode.commands.executeCommand('undo');
    await delay(500);
    check(!document.getText().includes('"name": "Edited '), 'undo takes the edit back');

    const hold = Number(process.env.SPARKLE_IT_HOLD ?? '0');
    if (hold > 0) {
        // Room for the editor: no panel, no secondary side bar.
        await vscode.commands.executeCommand('workbench.action.closePanel');
        await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
        await vscode.commands.executeCommand('vscode.openWith', document.uri, 'sparkle.systemEditor');
        note(`Holding ${hold} s for a screenshot`);
        await delay(hold * 1000);
    }

    note(failures === 0 ? 'ALL PASSED' : `${failures} FAILED`);
    if (failures > 0) {
        throw new Error(`${failures} checks failed`);
    }
}
