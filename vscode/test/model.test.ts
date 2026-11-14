import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { catalogTexts, MODULES, splitTextures } from '../src/shared/catalog';
import {
    createEmitter, eventId, eventSource, getModule, parseSystem, Reader, receivedEvent, serializeSystem, setEnabled, setValue, validate,
} from '../src/shared/model';
import { createSystem, SYSTEM_TEMPLATES } from '../src/shared/templates';

const runtime = join(__dirname, '..', '..', 'runtime');

test('every setting of the catalog is read by the runtime of the mod, and nothing else', () => {
    const java = readFileSync(join(runtime, 'common', 'SparkleEmitter.java'), 'utf8');
    const handled = new Set([...java.matchAll(/"([A-Z]\w+\.\w+)"/g)].map(m => m[1]));
    const settings = MODULES.flatMap(m => m.settings.map(s => `${m.kind}.${s.name}`));
    for (const setting of settings) {
        assert.ok(handled.has(setting), `${setting} is not read by SparkleEmitter.java`);
    }

    for (const name of handled) {
        assert.ok(settings.includes(name), `SparkleEmitter.java reads ${name}, which is not in the catalog`);
    }
});

test('every optional module can be switched on and off in the runtime', () => {
    const java = readFileSync(join(runtime, 'common', 'SparkleEmitter.java'), 'utf8');
    for (const info of MODULES.filter(m => m.optional)) {
        assert.ok(java.includes(`case "${info.kind}" ->`), `${info.kind} is not switched in SparkleEmitter.enable`);
    }
});

test('the runtime templates only use the tokens of the plugin', () => {
    for (const folder of readdirSync(runtime)) {
        for (const name of readdirSync(join(runtime, folder))) {
            const text = readFileSync(join(runtime, folder, name), 'utf8');
            assert.ok(text.startsWith('package __PACKAGE__;'), `${folder}/${name} has no package token`);
            for (const token of text.match(/__[A-Z]+__/g) ?? []) {
                assert.ok(token === '__PACKAGE__' || token === '__MODID__', `${folder}/${name}: ${token}`);
            }
        }
    }
});

test('a new emitter has every module, with its default state', () => {
    const emitter = createEmitter('Sparks', 3);
    assert.equal(emitter.modules.length, MODULES.length);
    assert.equal(eventId(emitter), 3);
    assert.equal(getModule(emitter, 'Gravity').enabled, true);
    assert.equal(getModule(emitter, 'Collision').enabled, false);
});

test('a file keeps its unknown fields and modules when it is saved again', () => {
    const text = JSON.stringify({
        format: 1, author: 'me',
        emitters: [{ id: 'a', name: 'A', preview: true, x: 1, y: 2, color: 'red', modules: [{ kind: 'Future', enabled: true, values: { x: '1' } }] }],
        userParameters: [],
    });
    const file = parseSystem(text).file!;
    const again = JSON.parse(serializeSystem(file));
    assert.equal(again.author, 'me');
    assert.equal(again.emitters[0].color, 'red');
    assert.deepEqual(again.emitters[0].modules[0], { kind: 'Future', enabled: true, values: { x: '1' } });
});

test('a file of Mine Engine (properties) is read', () => {
    const file = parseSystem(JSON.stringify({ properties: { emitters: [{ id: 'x', name: 'Fire', modules: [] }], userParameters: [] } })).file!;
    assert.equal(file.emitters[0].name, 'Fire');
});

test('a broken file gives an error, not an empty system', () => {
    assert.ok(parseSystem('{ "emitters": [').error);
    assert.equal(parseSystem('').file?.emitters.length, 0);
});

test('a bound setting reads the value of its user parameter', () => {
    const emitter = createEmitter('A', 1);
    setValue(emitter, 'Velocity', 'speedMax', '@p1');
    const reader = new Reader([{ id: 'p1', name: 'speed', type: 'Number', value: '7.5' }]);
    assert.equal(reader.number(getModule(emitter, 'Velocity'), 'speedMax'), 7.5);
    // Without its parameter: the default of the setting.
    assert.equal(new Reader().number(getModule(emitter, 'Velocity'), 'speedMax'), 2);
});

test('numbers are clamped to their bounds and integers rounded', () => {
    const emitter = createEmitter('A', 1);
    setValue(emitter, 'Collision', 'bounce', '3');
    setValue(emitter, 'SpawnParticles', 'count', '12.6');
    const reader = new Reader();
    assert.equal(reader.number(getModule(emitter, 'Collision'), 'bounce'), 1);
    assert.equal(reader.number(getModule(emitter, 'SpawnParticles'), 'count'), 13);
});

test('the validation finds twin IDs and missing event sources', () => {
    const file = createSystem('Empty', 'A');
    const a = createEmitter('A', 1);
    const b = createEmitter('B', 1);
    setEnabled(b, 'ReceiveDeathEvent', true);
    setValue(b, 'ReceiveDeathEvent', 'source', '9');
    file.emitters.push(a, b);
    const messages = validate(file).map(p => p.message);
    assert.ok(messages.includes('Several emitters have the ID {0}: {1}.'));
    assert.ok(messages.includes('The emitter "{0}" receives the events of the ID {1}, but no other emitter has this ID.'));
});

test('every system template is valid', () => {
    for (const template of SYSTEM_TEMPLATES) {
        const file = createSystem(template.template, 'Sparks');
        const errors = validate(file).filter(p => p.severity === 'error');
        assert.deepEqual(errors, [], template.template);
        assert.equal(parseSystem(serializeSystem(file)).file?.emitters.length, file.emitters.length);
    }
});

test('the ribbon trail receives the time events of its head', () => {
    const file = createSystem('Ribbon', 'Ribbon', head => `${head} trail`);
    const [head, trail] = file.emitters;
    assert.equal(trail.name, 'Ribbon trail');
    assert.equal(eventSource(trail), eventId(head));
    assert.equal(receivedEvent(trail), 'Time');
});

test('a texture list is never empty', () => {
    assert.deepEqual(splitTextures(''), ['minecraft:glitter_7']);
    assert.deepEqual(splitTextures('a:b; c:d ;'), ['a:b', 'c:d']);
});

test('the French translation covers every text of the editor', () => {
    const bundle = JSON.parse(readFileSync(join(__dirname, '..', '..', 'l10n', 'bundle.l10n.fr.json'), 'utf8')) as Record<string, string>;
    const missing = catalogTexts().filter(text => bundle[text] === undefined);
    assert.deepEqual(missing, []);
});

test('the JSON schema has the settings of the catalog', () => {
    const schema = JSON.parse(readFileSync(join(__dirname, '..', '..', 'schemas', 'sparkle-system.schema.json'), 'utf8'));
    const modules = schema.properties.emitters.items.properties.modules.items.allOf as { if: { properties: { kind: { const: string } } }; then: { properties: { values: { properties: object } } } }[];
    for (const info of MODULES) {
        const entry = modules.find(m => m.if.properties.kind.const === info.kind);
        assert.ok(entry, info.kind);
        assert.deepEqual(Object.keys(entry.then.properties.values.properties).sort(), info.settings.map(s => s.name).sort(), info.kind);
    }
});
