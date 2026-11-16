// Compile test of the Java runtime: for each "loader:minecraft" given, makes a small mod project with the real Gradle
// plugin of the loader, installs the runtime as the extension does, and compiles it.
//
//   node test-runtime/compile.mjs fabric:1.21.4 neoforge:1.21.4 forge:1.21.4
//   node test-runtime/compile.mjs --keep fabric:26.1      (keeps .test-runtime/<loader>-<version> at the root of the repository to look at)
//
// Gradle runs on JAVA25_HOME (Java 25 or later: Fabric Loom, ModDevGradle, ForgeGradle 7) or on JAVA21_HOME (Java 21:
// ForgeGradle 6, up to Minecraft 1.21.5); both default to JAVA_HOME. The Java of Minecraft itself (21 or 25) is
// downloaded by Gradle when missing. The first build of a version downloads Minecraft and the loader (a few hundred
// MB, kept in the Gradle cache).
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
// Outside the extension folder: vsce would read (and package) its thousands of Gradle files.
const work = join(root, '..', '.test-runtime');
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const targets = args.filter(a => !a.startsWith('--'));
if (targets.length === 0) {
    console.error('Usage: node test-runtime/compile.mjs [--keep] <loader>:<minecraft> ...');
    process.exit(1);
}

const esbuild = createRequire(join(root, 'package.json'))('esbuild');
mkdirSync(work, { recursive: true });
await esbuild.build({
    entryPoints: [join(here, 'install.ts')], outfile: join(work, `install-${process.pid}.cjs`), bundle: true, platform: 'node', format: 'cjs',
    mainFields: ['module', 'main'], logLevel: 'warning',
});
const { installRuntime } = await import(pathToFileURL(join(work, `install-${process.pid}.cjs`)).href);

const MOD_ID = 'sparkletest';
const PACKAGE = 'com.example.sparkletest';

/** 1.21.4 → [1, 21, 4]; 26.1 → [26, 1, 0]. */
const parts = v => v.split('.').map(Number).concat([0, 0]).slice(0, 3);
const atLeast = (v, min) => {
    const a = parts(v), b = parts(min);
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return true;
};

/** Minecraft 26.1 and later is not obfuscated any more and needs Java 25. */
const unobfuscated = mc => atLeast(mc, '26.1');
const javaOf = mc => unobfuscated(mc) ? 25 : atLeast(mc, '1.20.5') ? 21 : 17;

/** The text of a URL, read once per run (with a few tries: the mavens sometimes drop a connection). */
const fetched = new Map();
async function text(url) {
    if (!fetched.has(url)) {
        fetched.set(url, (async () => {
            for (let attempt = 1; ; attempt++) {
                try {
                    const response = await fetch(url);
                    if (!response.ok) throw new Error(`${url}: ${response.status}`);
                    return await response.text();
                } catch (error) {
                    if (attempt >= 4) throw error;
                    await new Promise(resolve => setTimeout(resolve, 3000 * attempt));
                }
            }
        })());
    }

    return fetched.get(url);
}

const mavenVersions = async url => [...(await text(url)).matchAll(/<version>([^<]+)<\/version>/g)].map(m => m[1]);

async function fabricVersions(mc) {
    const loader = JSON.parse(await text('https://meta.fabricmc.net/v2/versions/loader')).find(l => l.stable).version;
    const api = (await mavenVersions('https://maven.fabricmc.net/net/fabricmc/fabric-api/fabric-api/maven-metadata.xml')).filter(v => v.endsWith(`+${mc}`)).pop();
    if (!api) throw new Error(`No Fabric API for ${mc}`);
    return { loader, api };
}

async function neoforgeVersion(mc) {
    const [major, minor, patch] = parts(mc);
    // 1.21.4 → 21.4.x; 26.1.2 → 26.1.2.x
    const prefix = major === 1 ? `${minor}.${patch}.` : `${major}.${minor}.${patch}.`;
    const all = (await mavenVersions('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml')).filter(v => v.startsWith(prefix));
    const version = all.filter(v => !v.includes('-')).pop() ?? all.pop();
    if (!version) throw new Error(`No NeoForge for ${mc}`);
    return version;
}

async function forgeVersion(mc) {
    const promos = JSON.parse(await text('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json')).promos;
    const version = promos[`${mc}-recommended`] ?? promos[`${mc}-latest`];
    if (!version) throw new Error(`No Forge for ${mc}`);
    return `${mc}-${version}`;
}

const SETTINGS_REPOS = {
    fabric: `maven { url = 'https://maven.fabricmc.net/' }`,
    neoforge: `maven { url = 'https://maven.neoforged.net/releases' }`,
    forge: `maven { url = 'https://maven.minecraftforge.net/' }`,
};

/** The Gradle files of a mod project, as made by the MDK (or the template mod) of the loader. */
async function gradleProject(loader, mc) {
    const java = javaOf(mc);
    const settings = `pluginManagement {
    repositories {
        ${SETTINGS_REPOS[loader]}
        gradlePluginPortal()
    }
}
plugins {
    id 'org.gradle.toolchains.foojay-resolver-convention' version '1.0.0'
}
rootProject.name = '${MOD_ID}'
`;
    const toolchain = `java.toolchain.languageVersion = JavaLanguageVersion.of(${java})\n`;
    if (loader === 'fabric') {
        const { loader: fabricLoader, api } = await fabricVersions(mc);
        const loom = unobfuscated(mc)
            ? `plugins { id 'net.fabricmc.fabric-loom' version '1.19.4' }`
            : `plugins { id 'fabric-loom' version '1.19.4' }`;
        const deps = unobfuscated(mc)
            ? `    minecraft "com.mojang:minecraft:${mc}"
    implementation "net.fabricmc:fabric-loader:${fabricLoader}"
    implementation "net.fabricmc.fabric-api:fabric-api:${api}"`
            : `    minecraft "com.mojang:minecraft:${mc}"
    mappings loom.officialMojangMappings()
    modImplementation "net.fabricmc:fabric-loader:${fabricLoader}"
    modImplementation "net.fabricmc.fabric-api:fabric-api:${api}"`;
        return {
            gradle: '9.8.0',
            files: {
                'settings.gradle': settings,
                'build.gradle': `${loom}\n${toolchain}dependencies {\n${deps}\n}\n`,
                'gradle.properties': `minecraft_version=${mc}\nmod_id=${MOD_ID}\nfabric_version=${api}\norg.gradle.jvmargs=-Xmx3G\n`,
                'src/main/resources/fabric.mod.json': JSON.stringify({
                    schemaVersion: 1, id: MOD_ID, version: '1.0.0', environment: '*',
                    entrypoints: { main: [`${PACKAGE}.SparkleTest`] }, depends: { fabricloader: '*', 'fabric-api': '*' },
                }, null, 2) + '\n',
            },
            mainClass: `public class SparkleTest implements net.fabricmc.api.ModInitializer {\n    @Override\n    public void onInitialize() {\n    }\n}\n`,
        };
    }

    if (loader === 'neoforge') {
        const neo = await neoforgeVersion(mc);
        return {
            gradle: '9.8.0',
            files: {
                'settings.gradle': settings,
                'build.gradle': `plugins {\n    id 'java'\n    id 'net.neoforged.moddev' version '2.0.148'\n}\n${toolchain}neoForge {\n    version = '${neo}'\n}\n`,
                'gradle.properties': `minecraft_version=${mc}\nneo_version=${neo}\nmod_id=${MOD_ID}\norg.gradle.jvmargs=-Xmx3G\n`,
                'src/main/templates/META-INF/neoforge.mods.toml': `modLoader="javafml"\nloaderVersion="[1,)"\nlicense="MIT"\n[[mods]]\nmodId="\${mod_id}"\nversion="1.0.0"\n`,
            },
            mainClass: `import net.neoforged.fml.common.Mod;

@Mod("${MOD_ID}")\npublic class SparkleTest {\n}\n`,
        };
    }

    const forge = await forgeVersion(mc);
    // ForgeGradle 6 up to 1.21.1, ForgeGradle 7 (Gradle 9) after, as in the MDKs of Forge.
    const fg7 = atLeast(mc, '1.21.2');
    const mappings = unobfuscated(mc) ? '' : `minecraft {\n    mappings channel: 'official', version: '${mc}'\n}\n`;
    const build = fg7
        ? `plugins {\n    id 'java'\n    id 'net.minecraftforge.gradle' version '[7.0.17,8)'\n}\n${toolchain}${mappings}repositories {\n    minecraft.mavenizer(it)\n    maven fg.forgeMaven\n    maven fg.minecraftLibsMaven\n}\ndependencies {\n    implementation minecraft.dependency('net.minecraftforge:forge:${forge}')\n}\n`
        : `plugins {\n    id 'net.minecraftforge.gradle' version '[6.0,6.2)'\n}\n${toolchain}minecraft {\n    mappings channel: 'official', version: '${mc}'\n}\ndependencies {\n    minecraft 'net.minecraftforge:forge:${forge}'\n}\n`;
    return {
        gradle: fg7 ? '9.8.0' : '8.12.1',
        files: {
            'settings.gradle': settings,
            'build.gradle': build,
            'gradle.properties': `minecraft_version=${mc}\nforge_version=${forge}\nmod_id=${MOD_ID}\norg.gradle.jvmargs=-Xmx3G\n`,
            'src/main/resources/META-INF/mods.toml': `modLoader="javafml"\nloaderVersion="[1,)"\nlicense="MIT"\n[[mods]]\nmodId="${MOD_ID}"\nversion="1.0.0"\n`,
        },
        mainClass: `import net.minecraftforge.fml.common.Mod;

@Mod("${MOD_ID}")\npublic class SparkleTest {\n}\n`,
    };
}

/** Uses the API of the runtime the way a mod does, so that its signatures are compiled too. */
const USE = `package ${PACKAGE};

import ${PACKAGE}.sparkle.Sparkle;
import ${PACKAGE}.sparkle.SparkleParameters;
import net.minecraft.core.BlockPos;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.level.Level;

public final class UseSparkle {
    private UseSparkle() {
    }

    public static void use(Level level, Entity entity) {
        Sparkle.play(level, "fire", 0, 64, 0);
        Sparkle.play(level, "${MOD_ID}:beam", BlockPos.ZERO, SparkleParameters.create().vector("end", 0, 1, 8).color("tint", 0xFF8800).number("speed", 4));
        Sparkle.playOn(entity, "aura");
        Sparkle.stopOn(entity);
        Sparkle.stopAt(level, 0, 64, 0, 5.0);
    }
}
`;

function gradleHome(version) {
    const dists = join(process.env.USERPROFILE ?? process.env.HOME, '.gradle', 'wrapper', 'dists', `gradle-${version}-bin`);
    return dists;
}

async function compile(target) {
    const [loader, mc] = target.split(':');
    const folder = join(work, `${loader}-${mc}`);
    rmSync(folder, { recursive: true, force: true });
    mkdirSync(folder, { recursive: true });
    const project = await gradleProject(loader, mc);
    for (const [path, content] of Object.entries(project.files)) {
        mkdirSync(dirname(join(folder, path)), { recursive: true });
        writeFileSync(join(folder, path), content);
    }

    const javaFolder = join(folder, 'src/main/java', ...PACKAGE.split('.'));
    mkdirSync(javaFolder, { recursive: true });
    writeFileSync(join(javaFolder, 'SparkleTest.java'), `package ${PACKAGE};\n\n${project.mainClass}`);
    writeFileSync(join(javaFolder, 'UseSparkle.java'), USE);

    const installed = await installRuntime(folder, join(root, 'runtime'));
    if (!installed.supported) {
        return { target, ok: false, summary: `refused: ${installed.problems.at(-1)}` };
    }

    // Gradle wrapper of the version the loader needs.
    cpSync(join(root, '..', 'intellij', 'gradle'), join(folder, 'gradle'), { recursive: true });
    cpSync(join(root, '..', 'intellij', 'gradlew'), join(folder, 'gradlew'));
    cpSync(join(root, '..', 'intellij', 'gradlew.bat'), join(folder, 'gradlew.bat'));
    const properties = join(folder, 'gradle', 'wrapper', 'gradle-wrapper.properties');
    writeFileSync(properties, readFileSync(properties, 'utf8').replace(/gradle-[\d.]+-bin\.zip/, `gradle-${project.gradle}-bin.zip`));

    const windows = process.platform === 'win32';
    const started = Date.now();
    const javaHome = project.gradle.startsWith('8.') ? process.env.JAVA21_HOME : process.env.JAVA25_HOME;
    const env = { ...process.env, JAVA_HOME: javaHome ?? process.env.JAVA_HOME };
    const run = spawnSync(windows ? `"${join(folder, 'gradlew.bat')}"` : './gradlew', ['compileJava', '--console=plain', '--no-configuration-cache', '-q'], {
        cwd: folder, env, encoding: 'utf8', shell: windows, maxBuffer: 64 * 1024 * 1024,
    });
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    writeFileSync(join(folder, 'compile.log'), output);
    const seconds = Math.round((Date.now() - started) / 1000);
    const errors = output.split(/\r?\n/).filter(l => /error:|\.java:\d+: |FAILURE|What went wrong|> /.test(l)).slice(0, 25);
    if (run.status === 0 && !keep) {
        rmSync(join(folder, 'src'), { recursive: true, force: true });
    }

    return {
        target, ok: run.status === 0,
        summary: `${run.status === 0 ? 'compiled' : 'FAILED'} in ${seconds} s with ${installed.folders.join(' + ')}`
            + (installed.problems.length ? `\n    warnings: ${installed.problems.join(' | ')}` : '')
            + (run.status === 0 ? '' : `\n    ${errors.join('\n    ')}\n    full log: ${join(folder, 'compile.log')}`),
    };
}

const results = [];
for (const target of targets) {
    try {
        const result = await compile(target);
        console.log(`${result.ok ? 'OK  ' : 'FAIL'} ${result.target}: ${result.summary}`);
        results.push(result);
    } catch (error) {
        console.log(`FAIL ${target}: ${error.message}`);
        results.push({ target, ok: false });
    }
}

process.exit(results.every(r => r.ok) ? 0 : 1);
