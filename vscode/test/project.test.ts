import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Manifest, patchFabricModJson, planInstall } from '../src/shared/install';
import { detectProject, fillTemplate, Project, ProjectFiles, runtimeFolders, support } from '../src/shared/project';

function files(map: Record<string, string>): ProjectFiles {
    return {
        read: async path => map[path],
        javaFiles: async () => Object.keys(map).filter(p => p.startsWith('src/main/java/') && p.endsWith('.java')),
    };
}

const forge = {
    'build.gradle': "plugins { id 'net.minecraftforge.gradle' version '[6.0,6.2)' }\nminecraft { mappings channel: 'official', version: '1.20.1' }",
    'gradle.properties': 'minecraft_version=1.20.1\nmod_id=e2emod\nmod_group_id=com.example.e2emod\n',
    'src/main/resources/META-INF/mods.toml': 'modLoader="javafml"\n[[mods]]\nmodId="${mod_id}"\n',
    'src/main/java/com/example/e2emod/E2EMod.java': 'package com.example.e2emod;\n\n@Mod(E2EMod.MOD_ID)\npublic class E2EMod {}\n',
};

test('a Forge 1.20.1 project is found', async () => {
    const project = await detectProject(files(forge));
    assert.equal(project.loader, 'forge');
    assert.equal(project.minecraft, '1.20.1');
    assert.equal(project.modId, 'e2emod');
    assert.equal(project.modPackage, 'com.example.e2emod');
    const result = support(project);
    assert.ok(result.supported && result.tested);
    assert.deepEqual(runtimeFolders(result), ['common', 'mc1.20', 'forge']);
});

test('a NeoForge 1.21.1 project takes the 1.21 particle classes', async () => {
    const project = await detectProject(files({
        'build.gradle': "plugins { id 'net.neoforged.moddev' version '2.0.78' }",
        'gradle.properties': 'minecraft_version=1.21.1\nmod_id=demo\n',
        'src/main/templates/META-INF/neoforge.mods.toml': 'modId="${mod_id}"',
        'src/main/java/net/demo/Demo.java': 'package net.demo;\n@Mod("demo")\npublic class Demo {}',
    }));
    const result = support(project);
    assert.equal(project.loader, 'neoforge');
    assert.deepEqual(runtimeFolders(result), ['common', 'mc1.21', 'neoforge']);
});

const fabricJson = `{
  "schemaVersion": 1,
  "id": "fab",
  // A comment that must stay.
  "entrypoints": {
    "main": ["net.fab.FabMod"]
  }
}`;

test('a Fabric project with the Mojang mappings is supported', async () => {
    const project = await detectProject(files({
        'build.gradle': "plugins { id 'fabric-loom' version '1.7-SNAPSHOT' }\ndependencies { mappings loom.officialMojangMappings()\n modImplementation \"net.fabricmc.fabric-api:fabric-api:x\" }",
        'gradle.properties': 'minecraft_version=1.21.1\n',
        'src/main/resources/fabric.mod.json': '{"id":"fab","entrypoints":{"main":["net.fab.FabMod"]}}',
    }));
    assert.equal(project.modId, 'fab');
    assert.equal(project.modPackage, 'net.fab');
    const result = support(project);
    assert.ok(result.supported && result.tested);
    assert.deepEqual(runtimeFolders(result), ['common', 'mc1.21', 'fabric']);
});

test('a Fabric project with Yarn is refused with the reason', async () => {
    const project = await detectProject(files({
        'build.gradle': "plugins { id 'fabric-loom' }\ndependencies { mappings \"net.fabricmc:yarn:${project.yarn_mappings}:v2\" }",
        'gradle.properties': 'minecraft_version=1.20.1\nyarn_mappings=1.20.1+build.10\n',
        'src/main/resources/fabric.mod.json': '{"id":"fab","entrypoints":{"main":["net.fab.FabMod"]}}',
    }));
    const result = support(project);
    assert.equal(result.supported, false);
    assert.match(result.problems[result.problems.length - 1].text, /Yarn/);
});

test('versions before 1.20 are refused, newer ones are allowed with a warning', () => {
    const base: Project = { loader: 'forge', modId: 'm', modPackage: 'p', mappings: 'mojang', fabricApi: false, problems: [] };
    assert.equal(support({ ...base, minecraft: '1.19.2' }).supported, false);
    const newer = support({ ...base, minecraft: '1.21.4' });
    assert.ok(newer.supported && !newer.tested);
    assert.ok(newer.problems.some(p => p.text.includes('newer than 1.21.1')));
    assert.equal(support({ ...base, loader: 'neoforge', minecraft: '1.20.1' }).adapter, 'forge');
    assert.equal(support({ ...base, loader: 'neoforge', minecraft: '1.20.4' }).supported, false);
});

test('the templates take the package and the mod id', () => {
    assert.equal(fillTemplate('package __PACKAGE__; "__MODID__"', 'a.b.sparkle', 'mod'), 'package a.b.sparkle; "mod"');
});

const hash = (text: string) => `h${text.replace(/\r\n/g, '\n').length}:${text.replace(/\r\n/g, '\n')}`;

test('the install never writes over a file changed by hand without asking', () => {
    const manifest: Manifest = { runtime: '0', loader: 'forge', minecraft: '1.20.1', package: 'p', files: { 'A.java': hash('old A'), 'B.java': hash('old B'), 'Old.java': hash('old') } };
    const wanted = new Map([['A.java', 'new A'], ['B.java', 'new B'], ['C.java', 'new C'], ['D.java', 'same'], ['E.java', 'new E']]);
    const existing = new Map([['A.java', 'old A'], ['B.java', 'changed B'], ['D.java', 'same'], ['E.java', 'mine'], ['Old.java', 'old']]);
    const plan = planInstall(wanted, existing, manifest, hash);
    const status = Object.fromEntries(plan.files.map(f => [f.path, f.status]));
    assert.deepEqual(status, { 'A.java': 'update', 'B.java': 'modified', 'C.java': 'create', 'D.java': 'same', 'E.java': 'foreign' });
    assert.deepEqual(plan.obsolete, [{ path: 'Old.java', modified: false }]);
});

test('line endings changed by git do not count as a change', () => {
    const manifest: Manifest = { runtime: '0', loader: 'forge', minecraft: '1.20.1', package: 'p', files: { 'A.java': hash('a\nb') } };
    const plan = planInstall(new Map([['A.java', 'a\nb']]), new Map([['A.java', 'a\r\nb']]), manifest, hash);
    assert.equal(plan.files[0].status, 'same');
});

test('the Fabric entry points are added once, and the rest of fabric.mod.json stays', () => {
    const patch = patchFabricModJson(fabricJson, 'net.fab.sparkle.SparkleFabric', 'net.fab.sparkle.SparkleFabricClient');
    assert.ok(patch.changed);
    assert.ok(patch.text.includes('// A comment that must stay.'));
    const json = JSON.parse(patch.text.replace(/^\s*\/\/.*$/m, ''));
    assert.deepEqual(json.entrypoints.main, ['net.fab.FabMod', 'net.fab.sparkle.SparkleFabric']);
    assert.deepEqual(json.entrypoints.client, ['net.fab.sparkle.SparkleFabricClient']);
    const again = patchFabricModJson(patch.text, 'net.fab.sparkle.SparkleFabric', 'net.fab.sparkle.SparkleFabricClient');
    assert.equal(again.changed, false);
    assert.equal(again.text, patch.text);
});

test('a broken fabric.mod.json is not touched', () => {
    const patch = patchFabricModJson('{ "id": ', 'a.B', 'a.C');
    assert.equal(patch.changed, false);
    assert.ok(patch.error);
});
