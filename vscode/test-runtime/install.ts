// Installs the runtime in a mod project with the rules of the extension (detection, variant, loader adapter), for the
// compile tests of test-runtime/compile.mjs.
import { readdirSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { patchFabricModJson } from '../src/shared/install';
import { detectProject, fillTemplate, ProjectFiles, runtimeFolders, runtimePackage, support } from '../src/shared/project';

export interface Installed {
    readonly supported: boolean;
    readonly folders: string[];
    readonly problems: string[];
}

function files(root: string): ProjectFiles {
    return {
        read: async path => existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : undefined,
        javaFiles: async () => {
            const result: string[] = [];
            const walk = (folder: string) => {
                for (const entry of readdirSync(folder, { withFileTypes: true })) {
                    const path = join(folder, entry.name);
                    if (entry.isDirectory()) {
                        walk(path);
                    } else if (entry.name.endsWith('.java')) {
                        result.push(relative(root, path).replace(/\\/g, '/'));
                    }
                }
            };
            const java = join(root, 'src/main/java');
            if (existsSync(java)) {
                walk(java);
            }

            return result;
        },
    };
}

export async function installRuntime(root: string, runtime: string): Promise<Installed> {
    const project = await detectProject(files(root));
    const result = support(project);
    const problems = result.problems.map(p => p.args.reduce((text, arg, i) => text.replace(`{${i}}`, arg), p.text));
    if (!result.supported) {
        return { supported: false, folders: [], problems };
    }

    const packageName = runtimePackage(project);
    const target = join(root, 'src/main/java', ...packageName.split('.'));
    mkdirSync(target, { recursive: true });
    const folders = runtimeFolders(result);
    for (const folder of folders) {
        for (const name of readdirSync(join(runtime, folder)).filter(f => f.endsWith('.java'))) {
            writeFileSync(join(target, name), fillTemplate(readFileSync(join(runtime, folder, name), 'utf8'), packageName, project.modId!, result.renames));
        }
    }

    const fabricJson = join(root, 'src/main/resources/fabric.mod.json');
    if (project.loader === 'fabric' && existsSync(fabricJson)) {
        const patch = patchFabricModJson(readFileSync(fabricJson, 'utf8'), `${packageName}.SparkleFabric`, `${packageName}.SparkleFabricClient`);
        writeFileSync(fabricJson, patch.text);
    }

    return { supported: true, folders, problems };
}
