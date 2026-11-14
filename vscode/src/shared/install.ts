import { applyEdits, modify, parse, ParseError } from 'jsonc-parser';

/**
 * Plans the install of the runtime in a project without losing anything: a file changed by hand since the last install
 * (or a file of the user with the same name) is never written over without asking. Pure functions, tested.
 */

/** ".sparkle/runtime.json": what was installed, with the hash of each file as written. */
export interface Manifest {
    readonly runtime: string;
    readonly loader: string;
    readonly minecraft: string;
    readonly package: string;
    /** Path (relative to the project, with "/") to the SHA-256 of the file as written. */
    readonly files: Readonly<Record<string, string>>;
}

export const MANIFEST_PATH = '.sparkle/runtime.json';
export const BACKUP_FOLDER = '.sparkle/backup';

export type FileStatus =
    /** Not there: written. */
    | 'create'
    /** Already the same text: nothing to do. */
    | 'same'
    /** Written by the last install and not changed since: written again. */
    | 'update'
    /** Written by the last install, then changed by hand: asks. */
    | 'modified'
    /** There, but not written by the plugin: asks. */
    | 'foreign';

export interface PlannedFile {
    readonly path: string;
    readonly content: string;
    readonly status: FileStatus;
}

/** A file of the last install that the new one does not write (another loader or package). */
export interface ObsoleteFile {
    readonly path: string;
    /** Changed by hand since it was written. */
    readonly modified: boolean;
}

export interface Plan {
    readonly files: readonly PlannedFile[];
    readonly obsolete: readonly ObsoleteFile[];
}

export function planInstall(wanted: ReadonlyMap<string, string>, existing: ReadonlyMap<string, string>, manifest: Manifest | undefined,
    hash: (text: string) => string): Plan {
    const files: PlannedFile[] = [];
    for (const [path, content] of wanted) {
        const current = existing.get(path);
        let status: FileStatus;
        if (current === undefined) {
            status = 'create';
        } else if (normalize(current) === normalize(content)) {
            status = 'same';
        } else if (manifest?.files[path] === undefined) {
            status = 'foreign';
        } else {
            status = manifest.files[path] === hash(current) ? 'update' : 'modified';
        }

        files.push({ path, content, status });
    }

    const obsolete: ObsoleteFile[] = [];
    for (const [path, written] of Object.entries(manifest?.files ?? {})) {
        const current = existing.get(path);
        if (!wanted.has(path) && current !== undefined) {
            obsolete.push({ path, modified: hash(current) !== written });
        }
    }

    return { files, obsolete };
}

/** Line endings do not count: git may change them. */
function normalize(text: string): string {
    return text.replace(/\r\n/g, '\n');
}

/** Reads the manifest; undefined when it is missing or broken (every file then counts as not written by the plugin). */
export function parseManifest(text: string | undefined): Manifest | undefined {
    if (!text) {
        return undefined;
    }

    try {
        const json = JSON.parse(text) as Partial<Manifest>;
        return json && typeof json.files === 'object' && json.files !== null ? json as Manifest : undefined;
    } catch {
        return undefined;
    }
}

export interface FabricPatch {
    readonly text: string;
    readonly changed: boolean;
    /** The entry points that were added. */
    readonly added: readonly string[];
    readonly error?: string;
}

/**
 * Adds the entry points of Sparkle to fabric.mod.json ("main" and "client"), keeping the rest of the file as it is
 * (comments, order, spaces). An entry point already there is not added twice.
 */
export function patchFabricModJson(text: string, mainClass: string, clientClass: string): FabricPatch {
    const errors: ParseError[] = [];
    const json = parse(text, errors, { allowTrailingComma: true }) as { entrypoints?: Record<string, unknown> } | undefined;
    if (errors.length > 0 || typeof json !== 'object' || json === null) {
        return { text, changed: false, added: [], error: 'fabric.mod.json cannot be read.' };
    }

    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? '  ';
    const formatting = { insertSpaces: !indent.includes('\t'), tabSize: indent.includes('\t') ? 1 : indent.length, eol };
    let result = text;
    const added: string[] = [];
    for (const [point, className] of [['main', mainClass], ['client', clientClass]] as const) {
        const current = parse(result, [], { allowTrailingComma: true }) as { entrypoints?: Record<string, unknown> };
        const list = current.entrypoints?.[point];
        const names = Array.isArray(list) ? list.map(e => typeof e === 'string' ? e : (e as { value?: unknown })?.value) : [];
        if (names.includes(className)) {
            continue;
        }

        const path = Array.isArray(list) ? ['entrypoints', point, list.length] : ['entrypoints', point];
        const value = Array.isArray(list) ? className : [className];
        result = applyEdits(result, modify(result, path, value, { formattingOptions: formatting, isArrayInsertion: Array.isArray(list) }));
        added.push(`${point}: ${className}`);
    }

    return { text: result, changed: added.length > 0, added };
}

/** Folder of a backup: ".sparkle/backup/2026-11-14T10-30-00". */
export function backupFolder(date: Date): string {
    return `${BACKUP_FOLDER}/${date.toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, '')}`;
}
