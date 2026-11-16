/**
 * Finds what the runtime of Sparkle needs in a mod project: the loader, the version of Minecraft, the mod id, the
 * package of the mod and, on Fabric, the mappings. Pure functions on the text of the files, so that they can be tested.
 */

export type Loader = 'forge' | 'neoforge' | 'fabric';

/** Variant of the particle classes: Minecraft 1.20 to 1.20.4, or 1.20.5 and later. */
export type McVariant = '1.20' | '1.21';

export type Mappings = 'mojang' | 'yarn' | 'unknown';

/** Reads the files of the project folder (paths relative to it, with "/"). */
export interface ProjectFiles {
    read(path: string): Promise<string | undefined>;
    /** Java files of src/main/java (relative paths). */
    javaFiles(): Promise<string[]>;
}

export interface Project {
    readonly loader?: Loader;
    readonly minecraft?: string;
    readonly modId?: string;
    /** Package of the main class of the mod ("com.example.mymod"). */
    readonly modPackage?: string;
    readonly mappings: Mappings;
    /** Fabric: Fabric API is in the dependencies (the runtime needs it). */
    readonly fabricApi: boolean;
    /** Messages for the user, in English with {0}... */
    readonly problems: readonly Message[];
}

export interface Message {
    readonly text: string;
    readonly args: readonly string[];
}

const message = (text: string, ...args: string[]): Message => ({ text, args });

const RESOURCES = 'src/main/resources';
const TEMPLATES = 'src/main/templates';

export async function detectProject(files: ProjectFiles): Promise<Project> {
    const gradle = (await files.read('build.gradle')) ?? (await files.read('build.gradle.kts')) ?? '';
    const properties = parseProperties((await files.read('gradle.properties')) ?? '');
    const fabricJson = await files.read(`${RESOURCES}/fabric.mod.json`);
    // The MDKs of 1.20.5 and later keep the toml in src/main/templates (filled by Gradle).
    const neoToml = (await files.read(`${RESOURCES}/META-INF/neoforge.mods.toml`)) ?? (await files.read(`${TEMPLATES}/META-INF/neoforge.mods.toml`));
    const forgeToml = (await files.read(`${RESOURCES}/META-INF/mods.toml`)) ?? (await files.read(`${TEMPLATES}/META-INF/mods.toml`));
    const problems: Message[] = [];

    let loader: Loader | undefined;
    if (fabricJson !== undefined || /fabric-loom|net\.fabricmc/.test(gradle)) {
        loader = 'fabric';
    } else if (neoToml !== undefined || /net\.neoforged/.test(gradle)) {
        loader = 'neoforge';
    } else if (forgeToml !== undefined || /net\.minecraftforge/.test(gradle)) {
        loader = 'forge';
    }

    const minecraft = properties.get('minecraft_version') ?? properties.get('mc_version')
        ?? /com\.mojang:minecraft:([0-9][0-9.]*)/.exec(gradle)?.[1]
        ?? /minecraft\s*[:=]\s*['"]?([0-9]+\.[0-9]+(?:\.[0-9]+)?)/.exec(gradle)?.[1];

    let modId = properties.get('mod_id');
    const toml = neoToml ?? forgeToml;
    if (!modId && toml) {
        modId = /modId\s*=\s*"([^"]+)"/.exec(toml)?.[1];
    }

    let fabricMain: string | undefined;
    if (fabricJson !== undefined) {
        try {
            const json = JSON.parse(fabricJson) as { id?: unknown; entrypoints?: { main?: unknown[] } };
            if (!modId && typeof json.id === 'string') {
                modId = json.id;
            }

            const main = json.entrypoints?.main?.[0];
            fabricMain = typeof main === 'string' ? main : typeof (main as { value?: unknown })?.value === 'string' ? (main as { value: string }).value : undefined;
        } catch {
            problems.push(message('fabric.mod.json is not valid JSON.'));
        }
    }

    if (modId && modId.includes('${')) {
        // "${mod_id}" in the toml: the value comes from gradle.properties.
        modId = properties.get(modId.replace(/^\$\{|\}$/g, ''));
    }

    let modPackage: string | undefined;
    if (fabricMain && fabricMain.includes('.')) {
        modPackage = fabricMain.substring(0, fabricMain.lastIndexOf('.'));
    } else if (loader === 'forge' || loader === 'neoforge') {
        modPackage = await findModPackage(files);
    }

    modPackage ??= properties.get('mod_group_id') ?? properties.get('maven_group');

    let mappings: Mappings = 'unknown';
    if (loader === 'fabric') {
        if (/officialMojangMappings\s*\(/.test(gradle)) {
            mappings = 'mojang';
        } else if (/yarn/.test(gradle) || properties.has('yarn_mappings')) {
            mappings = 'yarn';
        }
    } else if (loader) {
        // Forge and NeoForge use the names of Mojang (with Parchment or not).
        mappings = 'mojang';
    }

    const fabricApi = loader === 'fabric' && (/fabric-api|fabric_version|fabric_api_version/.test(gradle) || properties.has('fabric_version'));
    return { loader, minecraft, modId, modPackage, mappings, fabricApi, problems };
}

/** The package of the class with @Mod (Forge, NeoForge). */
async function findModPackage(files: ProjectFiles): Promise<string | undefined> {
    for (const path of await files.javaFiles()) {
        const text = await files.read(path);
        if (text && /@Mod\s*\(/.test(text)) {
            return /^\s*package\s+([\w.]+)\s*;/m.exec(text)?.[1];
        }
    }

    return undefined;
}

export function parseProperties(text: string): Map<string, string> {
    const values = new Map<string, string>();
    for (const line of text.split(/\r?\n/)) {
        const match = /^\s*([\w.\-]+)\s*[=:]\s*(.*?)\s*$/.exec(line);
        if (match && !line.trim().startsWith('#')) {
            values.set(match[1], match[2]);
        }
    }

    return values;
}

/** [1, 21, 1] for "1.21.1"; undefined when it is not a version. */
export function parseVersion(text: string | undefined): number[] | undefined {
    const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec((text ?? '').trim());
    return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : undefined;
}

export function compareVersions(a: readonly number[], b: readonly number[]): number {
    for (let i = 0; i < 3; i++) {
        if ((a[i] ?? 0) !== (b[i] ?? 0)) {
            return (a[i] ?? 0) - (b[i] ?? 0);
        }
    }

    return 0;
}

/** What is installed for a project: its loader adapter, its variant, and how sure it is to work. */
export interface Support {
    /** The runtime can be installed (a refusal says why in the problems). */
    readonly supported: boolean;
    /** The combination was compiled by the tests of the plugin (test-runtime/compile.mjs). */
    readonly tested: boolean;
    readonly adapter?: Loader;
    readonly variant?: McVariant;
    /** Minecraft 1.21.9 and later: the particles of one quad are SingleQuadParticle (folder mc1.21.9). */
    readonly quadParticles?: boolean;
    /** Folders of the loader adapter for its newer versions, copied after it (neoforge-1.21.4). */
    readonly adapterUpdates?: readonly string[];
    /** Names of the game changed by Mojang, replaced in the files of the runtime when they are installed. */
    readonly renames?: readonly Rename[];
    readonly problems: readonly Message[];
}

/** A name of the game (or of a loader) that changed: the runtime is written with the old one. */
export interface Rename {
    /** First version of Minecraft with the new name. */
    readonly since: readonly number[];
    /** Only for this loader. */
    readonly loader?: Loader;
    readonly from: string;
    readonly to: string;
}

export const RENAMES: readonly Rename[] = [
    { since: [1, 21, 6], loader: 'forge', from: 'net.minecraftforge.eventbus.api.SubscribeEvent', to: 'net.minecraftforge.eventbus.api.listener.SubscribeEvent' },
    { since: [1, 21, 11], from: 'ResourceLocation', to: 'Identifier' },
    { since: [26, 1, 0], from: 'getLightColor', to: 'getLightCoords' },
    { since: [26, 1, 0], loader: 'fabric', from: 'ParticleFactoryRegistry', to: 'ParticleProviderRegistry' },
];

/**
 * The versions the runtime was compiled on by test-runtime/compile.mjs: every release of Minecraft of the loader from
 * "from" to "to". Same list in the IntelliJ plugin (ProjectDetection.kt).
 */
export const TESTED: readonly { readonly loader: Loader; readonly from: string; readonly to: string }[] = [
    { loader: 'forge', from: '1.20.1', to: '1.20.1' },
    { loader: 'forge', from: '1.21.1', to: '26.3' },
    { loader: 'neoforge', from: '1.20.6', to: '1.20.6' },
    { loader: 'neoforge', from: '1.21.1', to: '26.3' },
    { loader: 'fabric', from: '1.20.1', to: '1.20.1' },
    { loader: 'fabric', from: '1.20.4', to: '1.20.4' },
    { loader: 'fabric', from: '1.21.1', to: '26.3' },
];

/** The last version of Minecraft the runtime was compiled on. */
export const LATEST_TESTED = '26.3';

export function isTested(loader: Loader, version: readonly number[]): boolean {
    return TESTED.some(t => t.loader === loader
        && compareVersions(version, parseVersion(t.from)!) >= 0 && compareVersions(version, parseVersion(t.to)!) <= 0);
}

/** "Forge 1.20.1, 1.21.1–26.3; NeoForge 1.20.6, 1.21.1–26.3; Fabric ..." */
export function testedText(): string {
    const byLoader = new Map<Loader, string[]>();
    for (const t of TESTED) {
        byLoader.set(t.loader, [...(byLoader.get(t.loader) ?? []), t.from === t.to ? t.from : `${t.from}–${t.to}`]);
    }

    return [...byLoader].map(([loader, versions]) => `${loaderName(loader)} ${versions.join(', ')}`).join('; ');
}

export function support(project: Project): Support {
    const problems: Message[] = [...project.problems];
    const refuse = (text: string, ...args: string[]): Support => ({ supported: false, tested: false, problems: [...problems, message(text, ...args)] });
    if (!project.loader) {
        return refuse('No Forge, NeoForge or Fabric mod found in this folder (no mods.toml, neoforge.mods.toml or fabric.mod.json).');
    }

    const version = parseVersion(project.minecraft);
    if (!version) {
        return refuse('The version of Minecraft was not found (minecraft_version in gradle.properties).');
    }

    if (!project.modId) {
        return refuse('The mod id was not found (mod_id in gradle.properties, modId in mods.toml or id in fabric.mod.json).');
    }

    if (!project.modPackage) {
        return refuse('The package of the mod was not found (the class with @Mod, or the main entry point of fabric.mod.json).');
    }

    if (compareVersions(version, [1, 20, 0]) < 0) {
        return refuse('Minecraft {0} is not supported: Sparkle needs 1.20 or later.', project.minecraft ?? '');
    }

    const variant: McVariant = compareVersions(version, [1, 20, 5]) < 0 ? '1.20' : '1.21';
    let adapter: Loader = project.loader;
    if (project.loader === 'neoforge' && compareVersions(version, [1, 20, 1]) === 0) {
        // NeoForge 1.20.1 is the Forge of then: same packages.
        adapter = 'forge';
    } else if (project.loader === 'neoforge' && variant === '1.20') {
        return refuse('NeoForge {0} is not supported: NeoForge 1.20.1 or 1.20.5 and later.', project.minecraft ?? '');
    }

    // Minecraft 26.1 and later is not obfuscated: no mappings.
    const unobfuscated = compareVersions(version, [26, 1, 0]) >= 0;
    if (project.loader === 'fabric') {
        if (project.mappings === 'yarn' && !unobfuscated) {
            return refuse('This Fabric project uses the Yarn mappings: the runtime of Sparkle is written with the names of Mojang. Switch to "mappings loom.officialMojangMappings()" in build.gradle.');
        }

        if (project.mappings === 'unknown' && !unobfuscated) {
            problems.push(message('The mappings of the project were not found: the runtime needs the names of Mojang (loom.officialMojangMappings()).'));
        }

        if (!project.fabricApi) {
            problems.push(message('Fabric API was not found in build.gradle: the runtime needs it (particles and resource reload).'));
        }
    }

    const tested = isTested(project.loader, version);
    if (!tested) {
        problems.push(message('{0} {1} was not tested: the runtime was compiled on {2}.', loaderName(project.loader), project.minecraft ?? '', testedText()));
    }

    const latest = parseVersion(LATEST_TESTED)!;
    if (compareVersions(version, latest) > 0) {
        problems.push(message('Minecraft {0} is newer than {1}, the last version tested: the classes of the game may have changed and the runtime may not compile.',
            project.minecraft ?? '', LATEST_TESTED));
    }

    const quadParticles = compareVersions(version, [1, 21, 9]) >= 0;
    const renames = RENAMES.filter(r => compareVersions(version, r.since) >= 0 && (!r.loader || r.loader === adapter));
    // NeoForge 1.21.4 and later: no "bus" in @EventBusSubscriber, and named reload listeners.
    const adapterUpdates = adapter === 'neoforge' && compareVersions(version, [1, 21, 4]) >= 0 ? ['neoforge-1.21.4'] : [];
    return { supported: true, tested, adapter, variant, quadParticles, adapterUpdates, renames, problems };
}

export function loaderName(loader: Loader): string {
    return loader === 'neoforge' ? 'NeoForge' : loader === 'fabric' ? 'Fabric' : 'Forge';
}

/** Package of the runtime: a sub-package of the mod. */
export function runtimePackage(project: Project): string {
    return `${project.modPackage}.sparkle`;
}

/**
 * The runtime folders to copy, in this order: common, variant, loader. A file of a later folder replaces the file of
 * the same name of an earlier one (mc1.21.9/SparkleParticle.java replaces common/SparkleParticle.java).
 */
export function runtimeFolders(support: Support): string[] {
    return ['common', `mc${support.variant}`, ...(support.quadParticles ? ['mc1.21.9'] : []), support.adapter ?? 'forge', ...(support.adapterUpdates ?? [])];
}

/** A file of the runtime with its tokens replaced, and the names changed by Mojang since it was written. */
export function fillTemplate(text: string, packageName: string, modId: string, renames: readonly Rename[] = []): string {
    let result = text.replace(/__PACKAGE__/g, packageName).replace(/__MODID__/g, modId);
    for (const rename of renames) {
        result = result.replace(new RegExp(`\\b${rename.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), rename.to);
    }

    return result;
}
