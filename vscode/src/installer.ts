import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { chooseProject, projectFiles, readText, writeText } from './paths';
import { backupFolder, Manifest, MANIFEST_PATH, parseManifest, patchFabricModJson, planInstall, PlannedFile } from './shared/install';
import { detectProject, fillTemplate, loaderName, Message, runtimeFolders, runtimePackage, support } from './shared/project';

/** Version of the runtime written in the manifest. */
const RUNTIME_VERSION = '0.1.0';

/** SHA-256 of a text, line endings ignored (git may change them). */
export function hash(text: string): string {
    return createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

function format(message: Message): string {
    return vscode.l10n.t(message.text, ...message.args);
}

/**
 * Installs (or updates) the runtime of Sparkle in a mod project: a few Java classes in "<package of the mod>.sparkle",
 * registered by the loader without any change to the code of the mod (Fabric: two entry points in fabric.mod.json, after
 * asking). A file changed by hand is never written over without asking, and a copy goes to .sparkle/backup.
 */
export async function installRuntime(context: vscode.ExtensionContext, output: vscode.OutputChannel, from?: vscode.Uri): Promise<void> {
    const root = await chooseProject(from);
    if (!root) {
        void vscode.window.showErrorMessage(vscode.l10n.t('Open the folder of a mod (with build.gradle) to install the runtime.'));
        return;
    }

    const project = await detectProject(projectFiles(root));
    const result = support(project);
    output.appendLine(`[${new Date().toLocaleTimeString()}] ${vscode.l10n.t('Project: {0}', root.fsPath)}`);
    output.appendLine(`  loader=${project.loader ?? '?'} minecraft=${project.minecraft ?? '?'} modId=${project.modId ?? '?'} package=${project.modPackage ?? '?'} mappings=${project.mappings}`);
    for (const problem of result.problems) {
        output.appendLine(`  - ${format(problem)}`);
    }

    if (!result.supported) {
        output.show(true);
        void vscode.window.showErrorMessage(vscode.l10n.t('The runtime cannot be installed: {0}', format(result.problems[result.problems.length - 1])), { modal: true });
        return;
    }

    const packageName = runtimePackage(project);
    const javaFolder = `src/main/java/${packageName.replace(/\./g, '/')}`;
    const wanted = new Map<string, string>();
    for (const folder of runtimeFolders(result)) {
        const source = vscode.Uri.joinPath(context.extensionUri, 'runtime', folder);
        for (const [name, type] of await vscode.workspace.fs.readDirectory(source)) {
            if (type === vscode.FileType.File && name.endsWith('.java')) {
                const text = (await readText(vscode.Uri.joinPath(source, name))) ?? '';
                wanted.set(`${javaFolder}/${name}`, fillTemplate(text, packageName, project.modId!, result.renames));
            }
        }
    }

    const manifest = parseManifest(await readText(vscode.Uri.joinPath(root, MANIFEST_PATH)));
    const existing = new Map<string, string>();
    for (const path of new Set([...wanted.keys(), ...Object.keys(manifest?.files ?? {})])) {
        const text = await readText(vscode.Uri.joinPath(root, path));
        if (text !== undefined) {
            existing.set(path, text);
        }
    }

    const plan = planInstall(wanted, existing, manifest, hash);
    const toWrite = plan.files.filter(f => f.status !== 'same');
    const install = vscode.l10n.t('Install');
    const warnings = result.problems.map(p => `- ${format(p)}`).join('\n');
    const summary = vscode.l10n.t('Install the Sparkle runtime for {0} {1} in the package {2}? {3} files to write, {4} already up to date.',
        loaderName(project.loader!), project.minecraft!, packageName, String(toWrite.length), String(plan.files.length - toWrite.length));
    const answer = await vscode.window.showInformationMessage(summary, { modal: true, detail: warnings || undefined }, install);
    if (answer !== install) {
        return;
    }

    // Files changed by hand, or of the user: one question each.
    const written: PlannedFile[] = [];
    const backups: string[] = [];
    for (const file of toWrite) {
        if (file.status === 'modified' || file.status === 'foreign') {
            const replace = vscode.l10n.t('Replace (copy kept)');
            const keep = vscode.l10n.t('Keep mine');
            const question = file.status === 'modified'
                ? vscode.l10n.t('{0} was changed since the runtime was installed. Replace it with the new version?', file.path)
                : vscode.l10n.t('{0} already exists and was not written by Sparkle. Replace it?', file.path);
            const choice = await vscode.window.showWarningMessage(question, { modal: true, detail: vscode.l10n.t('A copy of your file is kept in {0}.', '.sparkle/backup') }, replace, keep);
            if (choice === undefined) {
                output.appendLine(`  ${vscode.l10n.t('Cancelled: nothing was written.')}`);
                return;
            }

            if (choice === keep) {
                output.appendLine(`  ${vscode.l10n.t('Kept: {0}', file.path)}`);
                continue;
            }

            backups.push(file.path);
        }

        written.push(file);
    }

    let removed: string[] = [];
    if (plan.obsolete.length > 0) {
        const remove = vscode.l10n.t('Move to the backup');
        const keep = vscode.l10n.t('Keep them');
        const list = plan.obsolete.map(o => `- ${o.path}${o.modified ? ` (${vscode.l10n.t('changed by hand')})` : ''}`).join('\n');
        const choice = await vscode.window.showWarningMessage(
            vscode.l10n.t('These files of the previous install are not used any more (another loader or package): they may not compile. Move them to {0}?', '.sparkle/backup'),
            { modal: true, detail: list }, remove, keep);
        if (choice === remove) {
            removed = plan.obsolete.map(o => o.path);
        }
    }

    const backup = backupFolder(new Date());
    for (const path of [...backups, ...removed]) {
        const text = existing.get(path);
        if (text !== undefined) {
            await writeText(vscode.Uri.joinPath(root, backup, path), text);
        }
    }

    for (const file of written) {
        await writeText(vscode.Uri.joinPath(root, file.path), file.content);
        output.appendLine(`  ${file.status === 'create' ? '+' : '~'} ${file.path}`);
    }

    for (const path of removed) {
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(root, path));
        output.appendLine(`  - ${path}`);
    }

    // The manifest knows the files as the plugin wrote them. A file the user kept keeps the hash of the last install,
    // so that the next one still sees it as changed by hand (a file of the user stays out of it).
    const files: Record<string, string> = {};
    for (const file of plan.files) {
        if (file.status === 'same' || written.includes(file)) {
            files[file.path] = hash(file.content);
        } else if (manifest?.files[file.path]) {
            files[file.path] = manifest.files[file.path];
        }
    }

    for (const old of plan.obsolete) {
        if (!removed.includes(old.path) && manifest?.files[old.path]) {
            files[old.path] = manifest.files[old.path];
        }
    }

    const newManifest: Manifest = { runtime: RUNTIME_VERSION, loader: project.loader!, minecraft: project.minecraft!, package: packageName, files };
    await writeText(vscode.Uri.joinPath(root, MANIFEST_PATH), JSON.stringify(newManifest, null, 2) + '\n');

    if (project.loader === 'fabric') {
        await addFabricEntryPoints(root, packageName, backup, output);
    }

    output.appendLine(`  ${vscode.l10n.t('Done. Play a system from the server: Sparkle.play(level, "{0}:<name>", x, y, z);', project.modId!)}`);
    output.show(true);
    if (backups.length + removed.length > 0) {
        output.appendLine(`  ${vscode.l10n.t('Copies of the replaced files: {0}', backup)}`);
    }

    void vscode.window.showInformationMessage(vscode.l10n.t('Sparkle runtime installed for {0} {1}: {2} files written. Use {3}.Sparkle.play(...) from the server.',
        loaderName(project.loader!), project.minecraft!, String(written.length), packageName));
}

/** Adds the two entry points of Sparkle to fabric.mod.json, after asking. */
async function addFabricEntryPoints(root: vscode.Uri, packageName: string, backup: string, output: vscode.OutputChannel): Promise<void> {
    const path = 'src/main/resources/fabric.mod.json';
    const uri = vscode.Uri.joinPath(root, path);
    const text = await readText(uri);
    if (text === undefined) {
        return;
    }

    const patch = patchFabricModJson(text, `${packageName}.SparkleFabric`, `${packageName}.SparkleFabricClient`);
    const manual = vscode.l10n.t('Add these entry points to fabric.mod.json: "main": "{0}.SparkleFabric", "client": "{0}.SparkleFabricClient".', packageName);
    if (patch.error) {
        output.appendLine(`  ${vscode.l10n.t(patch.error)} ${manual}`);
        return;
    }

    if (!patch.changed) {
        return;
    }

    const add = vscode.l10n.t('Add');
    const choice = await vscode.window.showInformationMessage(
        vscode.l10n.t('On Fabric, the runtime starts from two entry points of fabric.mod.json. Add them?'),
        { modal: true, detail: patch.added.join('\n') }, add);
    if (choice !== add) {
        output.appendLine(`  ${manual}`);
        return;
    }

    await writeText(vscode.Uri.joinPath(root, backup, path), text);
    await writeText(uri, patch.text);
    output.appendLine(`  ~ ${path} (${patch.added.join(', ')})`);
}
