import * as vscode from 'vscode';
import { ProjectFiles } from './shared/project';

/** "mymod:fire" for ".../assets/mymod/sparkle/fire.json"; undefined for another file. */
export function systemKey(uri: vscode.Uri): string | undefined {
    const match = /\/assets\/([^/]+)\/sparkle\/(.+)\.json$/.exec(uri.path);
    return match ? `${match[1]}:${match[2]}` : undefined;
}

export async function exists(uri: vscode.Uri): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}

export async function readText(uri: vscode.Uri): Promise<string | undefined> {
    try {
        return new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri));
    } catch {
        return undefined;
    }
}

export async function writeText(uri: vscode.Uri, text: string): Promise<void> {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
}

/** The files of a project folder, for the detection. */
export function projectFiles(root: vscode.Uri): ProjectFiles {
    return {
        read: path => readText(vscode.Uri.joinPath(root, path)),
        javaFiles: async () => {
            const pattern = new vscode.RelativePattern(root, 'src/main/java/**/*.java');
            const files = await vscode.workspace.findFiles(pattern, undefined, 5000);
            return files.map(f => f.path.substring(root.path.length + 1));
        },
    };
}

/**
 * The mod projects of the open folders: a folder with build.gradle and src/main (the folder itself, or a sub-folder of
 * a multi-loader project such as "forge" or "fabric").
 */
export async function findProjects(): Promise<vscode.Uri[]> {
    const builds = await vscode.workspace.findFiles('{build.gradle,build.gradle.kts,*/build.gradle,*/build.gradle.kts}', '**/node_modules/**', 50);
    const projects: vscode.Uri[] = [];
    for (const build of builds) {
        const folder = vscode.Uri.joinPath(build, '..');
        if (await exists(vscode.Uri.joinPath(folder, 'src', 'main')) && !projects.some(p => p.toString() === folder.toString())) {
            projects.push(folder);
        }
    }

    return projects.sort((a, b) => a.path.localeCompare(b.path));
}

/** The project that holds a file (the nearest folder with build.gradle above it). */
export async function projectOf(uri: vscode.Uri): Promise<vscode.Uri | undefined> {
    let folder = uri;
    for (let i = 0; i < 12; i++) {
        if (await exists(vscode.Uri.joinPath(folder, 'build.gradle')) || await exists(vscode.Uri.joinPath(folder, 'build.gradle.kts'))) {
            return folder;
        }

        const parent = vscode.Uri.joinPath(folder, '..');
        if (parent.path === folder.path) {
            break;
        }

        folder = parent;
    }

    return undefined;
}

/** Asks for the project when there are several; the one of the file when a file is given. */
export async function chooseProject(from?: vscode.Uri): Promise<vscode.Uri | undefined> {
    if (from) {
        const project = await projectOf(from);
        if (project) {
            return project;
        }
    }

    const projects = await findProjects();
    if (projects.length <= 1) {
        return projects[0];
    }

    const picked = await vscode.window.showQuickPick(projects.map(p => ({ label: vscode.workspace.asRelativePath(p) || p.path, uri: p })), {
        placeHolder: vscode.l10n.t('Which mod project?'),
    });
    return picked?.uri;
}
