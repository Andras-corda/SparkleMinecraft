import * as vscode from 'vscode';
import { SparkleEditorProvider } from './editor';
import { installRuntime } from './installer';
import { chooseProject, exists, projectFiles, readText, systemKey, writeText } from './paths';
import { parseSystem, serializeSystem } from './shared/model';
import { detectProject } from './shared/project';
import { createSystem, SYSTEM_TEMPLATES, SystemTemplate } from './shared/templates';

export function activate(context: vscode.ExtensionContext): void {
    const output = vscode.window.createOutputChannel('Sparkle');
    context.subscriptions.push(
        output,
        SparkleEditorProvider.register(context),
        vscode.commands.registerCommand('sparkle.newSystem', (uri?: vscode.Uri) => newSystem(uri)),
        vscode.commands.registerCommand('sparkle.installRuntime', (uri?: vscode.Uri) => installRuntime(context, output, uri)),
        vscode.commands.registerCommand('sparkle.copyPlayCode', (uri?: vscode.Uri) => copyPlayCode(uri)),
        vscode.commands.registerCommand('sparkle.openAsText', (uri?: vscode.Uri) => openAsText(uri)),
    );
}

export function deactivate(): void {
}

/** Asks for a template and a name, writes "assets/<mod>/sparkle/<name>.json" and opens it in the editor. */
async function newSystem(from?: vscode.Uri): Promise<void> {
    const folder = await systemsFolder(from);
    if (!folder) {
        return;
    }

    const template = await vscode.window.showQuickPick(SYSTEM_TEMPLATES.map(t => ({
        label: vscode.l10n.t(t.title), detail: vscode.l10n.t(t.description), template: t.template as SystemTemplate,
    })), { placeHolder: vscode.l10n.t('Template of the new particle system') });
    if (!template) {
        return;
    }

    const name = await vscode.window.showInputBox({
        prompt: vscode.l10n.t('Name of the system (the file and the name given to Sparkle.play)'),
        value: template.template === 'Empty' || template.template === 'Sparks' ? 'sparks' : template.template.toLowerCase(),
        validateInput: async value => {
            if (!/^[a-z0-9_][a-z0-9_./-]*$/.test(value) || value.endsWith('/')) {
                return vscode.l10n.t('Lower case letters, digits, "_", "-", "." and "/" only (a name of resource of Minecraft).');
            }

            return await exists(vscode.Uri.joinPath(folder, `${value}.json`)) ? vscode.l10n.t('A system with this name already exists.') : undefined;
        },
    });
    if (!name) {
        return;
    }

    const file = vscode.Uri.joinPath(folder, `${name}.json`);
    if (await exists(file)) {
        // Checked again: never write over a file.
        void vscode.window.showErrorMessage(vscode.l10n.t('A system with this name already exists.'));
        return;
    }

    const emitterName = vscode.l10n.t(template.template === 'Sparks' ? 'Sparks' : SYSTEM_TEMPLATES.find(t => t.template === template.template)!.title);
    const trail = (head: string) => vscode.l10n.t('{0} trail', head);
    await writeText(file, serializeSystem(createSystem(template.template, emitterName, trail)));
    await vscode.commands.executeCommand('vscode.openWith', file, SparkleEditorProvider.viewType);

    const project = await chooseProject(file);
    if (project && !await exists(vscode.Uri.joinPath(project, '.sparkle', 'runtime.json'))) {
        const install = vscode.l10n.t('Install the runtime');
        const answer = await vscode.window.showInformationMessage(
            vscode.l10n.t('The mod needs the runtime of Sparkle to play the systems in the game (a few Java classes, for Forge, NeoForge and Fabric).'), install);
        if (answer === install) {
            await vscode.commands.executeCommand('sparkle.installRuntime', file);
        }
    }
}

/** The folder "assets/<mod id>/sparkle" of the project (the selected folder when it is already one). */
async function systemsFolder(from?: vscode.Uri): Promise<vscode.Uri | undefined> {
    if (from && /\/assets\/[^/]+\/sparkle(\/.*)?$/.test(from.path)) {
        return from;
    }

    const project = await chooseProject(from);
    if (!project) {
        void vscode.window.showErrorMessage(vscode.l10n.t('Open the folder of a mod (with build.gradle) to make a particle system.'));
        return undefined;
    }

    const detected = await detectProject(projectFiles(project));
    let modId = detected.modId;
    if (!modId) {
        modId = await vscode.window.showInputBox({
            prompt: vscode.l10n.t('Mod id (the namespace of the resources)'),
            validateInput: value => /^[a-z0-9_.-]+$/.test(value) ? undefined : vscode.l10n.t('Lower case letters, digits, "_", "-" and "." only.'),
        });
    }

    return modId ? vscode.Uri.joinPath(project, 'src', 'main', 'resources', 'assets', modId, 'sparkle') : undefined;
}

/** Copies the Java code that plays the system, with its user parameters. */
async function copyPlayCode(uri?: vscode.Uri): Promise<void> {
    uri ??= activeSystem();
    const key = uri ? systemKey(uri) : undefined;
    if (!uri || !key) {
        void vscode.window.showErrorMessage(vscode.l10n.t('Select a particle system (assets/<mod>/sparkle/<name>.json).'));
        return;
    }

    const parsed = parseSystem((await readText(uri)) ?? '');
    const parameters = (parsed.file?.userParameters ?? []).map(p => {
        switch (p.type) {
            case 'Vector': return `.vector("${p.name}", 0, 0, 0)`;
            case 'Color': return `.color("${p.name}", 0x${(p.value.replace('#', '') || 'FFFFFF').toUpperCase()})`;
            case 'Boolean': return `.flag("${p.name}", ${p.value === 'true'})`;
            default: return `.number("${p.name}", ${p.value || '0'})`;
        }
    });
    const code = parameters.length === 0
        ? `Sparkle.play(level, "${key}", x, y, z);`
        : `Sparkle.play(level, "${key}", x, y, z, SparkleParameters.create()${parameters.join('')});`;
    await vscode.env.clipboard.writeText(code);
    void vscode.window.showInformationMessage(vscode.l10n.t('Copied: {0}', code));
}

function activeSystem(): vscode.Uri | undefined {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (tab instanceof vscode.TabInputCustom || tab instanceof vscode.TabInputText) {
        return tab.uri;
    }

    return undefined;
}

async function openAsText(uri?: vscode.Uri): Promise<void> {
    uri ??= activeSystem();
    if (uri) {
        await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
    }
}
