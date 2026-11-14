/**
 * Catalog of the modules of a Sparkle emitter, sorted by part of its body: properties, emitter spawn, particle spawn,
 * particle update, render and events (inspired by Niagara). Units of the file: seconds, blocks, blocks per second,
 * blocks per second squared, degrees, percents. The runtime of the mod reads the same names (SparkleEmitter.java).
 */

export type SectionKind = 'EmitterSpawn' | 'ParticleSpawn' | 'ParticleUpdate' | 'Render' | 'Event';

export type ModuleKind =
    | 'Lifecycle'
    | 'Identity'
    | 'SpawnParticles'
    | 'Velocity'
    | 'Gravity'
    | 'Collision'
    | 'Scale'
    | 'Texture'
    | 'GenerateDeathEvent'
    | 'GenerateTimeEvent'
    | 'GenerateLocationEvent'
    | 'GenerateCollisionEvent'
    | 'ReceiveDeathEvent';

export type EventKind = 'Death' | 'Time' | 'Location' | 'Collision';

export type SettingType = 'Number' | 'Integer' | 'Boolean' | 'Choice' | 'Vector' | 'Color' | 'TextureList' | 'EmitterId';

export interface Choice {
    readonly value: string;
    readonly label: string;
}

/** A setting of a module. Values are stored as text: "2.5", "true", the name of a choice, "x y z", "#RRGGBB", "a;b". */
export interface SettingInfo {
    readonly name: string;
    readonly label: string;
    readonly type: SettingType;
    readonly defaultValue: string;
    readonly hint?: string;
    readonly min?: number;
    readonly max?: number;
    readonly choices?: readonly Choice[];
    /** Shown only when the choice setting `name` has one of these values. */
    readonly visibleWhen?: { readonly name: string; readonly values: readonly string[] };
}

export interface ModuleInfo {
    readonly kind: ModuleKind;
    readonly section: SectionKind;
    readonly title: string;
    readonly description: string;
    readonly settings: readonly SettingInfo[];
    /** Can be switched off (gravity, collision, the events); the others always apply. */
    readonly optional: boolean;
    /** State of an optional module in a new emitter. */
    readonly enabledByDefault: boolean;
}

/** Texture of a new emitter: a soft star of the game. */
export const DEFAULT_TEXTURE = 'minecraft:glitter_7';

/** Most particles a system shows at once in the preview (the game removes the oldest ones past 16384). */
export const ENGINE_LIMIT = 16384;

export const SECTIONS: readonly { readonly kind: SectionKind; readonly title: string }[] = [
    { kind: 'EmitterSpawn', title: 'Emitter spawn' },
    { kind: 'ParticleSpawn', title: 'Particle spawn' },
    { kind: 'ParticleUpdate', title: 'Particle update' },
    { kind: 'Render', title: 'Render' },
    { kind: 'Event', title: 'Event' },
];

const text = (value: number): string => String(value);

function num(name: string, label: string, value: number, min = 0, max = 10000, extra: Partial<SettingInfo> = {}): SettingInfo {
    return { name, label, type: 'Number', defaultValue: text(value), min, max, ...extra };
}

function int(name: string, label: string, value: number, min = 0, max = 100000, extra: Partial<SettingInfo> = {}): SettingInfo {
    return { name, label, type: 'Integer', defaultValue: text(value), min, max, ...extra };
}

function bool(name: string, label: string, value: boolean): SettingInfo {
    return { name, label, type: 'Boolean', defaultValue: value ? 'true' : 'false' };
}

function vec(name: string, label: string, x: number, y: number, z: number, extra: Partial<SettingInfo> = {}): SettingInfo {
    return { name, label, type: 'Vector', defaultValue: `${x} ${y} ${z}`, min: -10000, max: 10000, ...extra };
}

function choice(name: string, label: string, choices: Choice[], extra: Partial<SettingInfo> = {}): SettingInfo {
    return { name, label, type: 'Choice', defaultValue: choices[0].value, choices, ...extra };
}

const when = (name: string, ...values: string[]) => ({ visibleWhen: { name, values } });

function module(kind: ModuleKind, section: SectionKind, title: string, description: string, settings: SettingInfo[],
    optional = false, enabledByDefault = true): ModuleInfo {
    return { kind, section, title, description, settings, optional, enabledByDefault };
}

export const MODULES: readonly ModuleInfo[] = [
    module('Lifecycle', 'EmitterSpawn', 'Lifecycle', 'How long the emitter spawns particles: once, a number of times, or until the system is stopped.', [
        choice('mode', 'Mode', [{ value: 'Once', label: 'Once' }, { value: 'Loop', label: 'Loops' }, { value: 'Infinite', label: 'Infinite' }]),
        num('duration', 'Duration (s)', 2, 0.05, 3600),
        int('loops', 'Loops', 3, 1, 1000, when('mode', 'Loop')),
        num('delay', 'Delay (s)', 0, 0, 3600),
    ]),
    module('Identity', 'EmitterSpawn', 'ID', 'Number that identifies the emitter in the system: the events are sent and received with it.', [
        int('id', 'ID', 1, 0, 9999),
    ]),
    module('SpawnParticles', 'ParticleSpawn', 'Spawn particle', 'Where the particles appear, how many in all and how long each one lives.', [
        choice('mode', 'Spawn', [{ value: 'Burst', label: 'All at once' }, { value: 'Continuous', label: 'Spread over the duration' }]),
        int('count', 'Number of particles', 30, 1, 10000, { hint: 'In all, for each loop of the emitter.' }),
        choice('shape', 'Shape', [
            { value: 'Point', label: 'Point' }, { value: 'Sphere', label: 'Sphere' }, { value: 'Box', label: 'Box' }, { value: 'Line', label: 'Line' },
        ]),
        vec('offset', 'Coordinates', 0, 0, 0, { hint: 'Relative to the place where the system plays, in blocks.' }),
        num('radius', 'Radius', 0.5, 0, 64, when('shape', 'Sphere')),
        vec('size', 'Size', 1, 1, 1, when('shape', 'Box')),
        vec('lineEnd', 'End of the line', 0, 0, 5, {
            ...when('shape', 'Line'),
            hint: 'The particles appear between the coordinates and this point (a beam), relative to the place where the system plays.',
        }),
        num('lifetimeMin', 'Lifetime min (s)', 1, 0.05, 600),
        num('lifetimeMax', 'Lifetime max (s)', 1.5, 0.05, 600),
    ]),
    module('Velocity', 'ParticleSpawn', 'Velocity', 'Speed and direction of the particles when they appear.', [
        choice('mode', 'Direction', [
            { value: 'Direction', label: 'Fixed direction' }, { value: 'Cone', label: 'Cone' }, { value: 'Radial', label: 'From the center' },
        ]),
        vec('direction', 'Vector', 0, 1, 0, when('mode', 'Direction', 'Cone')),
        num('angle', 'Cone angle (°)', 30, 0, 180, when('mode', 'Cone')),
        num('speedMin', 'Speed min (blocks/s)', 1, 0, 1000),
        num('speedMax', 'Speed max (blocks/s)', 2, 0, 1000),
    ]),
    module('Gravity', 'ParticleUpdate', 'Gravity', 'Constant acceleration applied to the particles.', [
        vec('acceleration', 'Acceleration (blocks/s²)', 0, -9.8, 0),
    ], true, true),
    module('Collision', 'ParticleUpdate', 'Collision', 'The particles stop on the blocks of the world: they bounce or die.', [
        num('bounce', 'Bounce', 0.4, 0, 1, { hint: '0: stops, 1: keeps all its speed.' }),
        bool('die', 'Dies on collision', false),
    ], true, false),
    module('Scale', 'ParticleUpdate', 'Scale', 'Size of the particles: fixed, changing over their life, or random in a range.', [
        choice('mode', 'Mode', [{ value: 'Fixed', label: 'Fixed' }, { value: 'OverLife', label: 'Over the life' }, { value: 'Random', label: 'Random' }]),
        num('value', 'Size (blocks)', 0.2, 0, 64, when('mode', 'Fixed')),
        num('start', 'Size at birth', 0.3, 0, 64, when('mode', 'OverLife')),
        num('end', 'Size at death', 0, 0, 64, when('mode', 'OverLife')),
        num('min', 'Size min', 0.1, 0, 64, when('mode', 'Random')),
        num('max', 'Size max', 0.3, 0, 64, when('mode', 'Random')),
    ]),
    module('Texture', 'Render', 'Texture',
        'Images of the particles, their tint and their light. With several images, each particle takes one at random, or goes through them over its life.', [
            { name: 'texture', label: 'Textures', type: 'TextureList', defaultValue: DEFAULT_TEXTURE },
            choice('spriteMode', 'With several textures', [
                { value: 'Random', label: 'One at random for each particle' }, { value: 'OverLife', label: 'Animated over the life' },
            ]),
            { name: 'tint', label: 'Tint', type: 'Color', defaultValue: '#FFFFFF' },
            bool('glow', 'Glows in the dark', true),
            bool('translucent', 'Translucent', true),
        ]),
    module('GenerateDeathEvent', 'Event', 'Generate death event',
        'When a particle dies, the emitters that receive the events of this one spawn particles (where it died).', [
            num('chance', 'Chance (%)', 100, 0, 100),
        ], true, false),
    module('GenerateTimeEvent', 'Event', 'Generate time event',
        'Each particle sends an event once after a time of its life, or at every interval: the emitters that receive it spawn particles where it is (a trail, sparks...).', [
            choice('mode', 'When', [{ value: 'Once', label: 'Once, after the time' }, { value: 'Repeat', label: 'At every interval' }]),
            num('time', 'Time (s)', 0.5, 0.05, 600, { hint: 'Counted from the birth of the particle.' }),
            num('chance', 'Chance (%)', 100, 0, 100),
        ], true, false),
    module('GenerateLocationEvent', 'Event', 'Generate location event',
        'A particle sends an event when it enters a zone, a sphere or a box: the emitters that receive it spawn particles where it is.', [
            choice('shape', 'Zone', [{ value: 'Sphere', label: 'Sphere' }, { value: 'Box', label: 'Box' }]),
            vec('center', 'Center of the zone', 0, 2, 0, { hint: 'Relative to the place where the system plays, in blocks.' }),
            num('radius', 'Radius', 1, 0, 64, when('shape', 'Sphere')),
            vec('size', 'Size', 2, 2, 2, when('shape', 'Box')),
            num('chance', 'Chance (%)', 100, 0, 100),
        ], true, false),
    module('GenerateCollisionEvent', 'Event', 'Generate collision event',
        'A particle sends an event when it hits a block (with the Collision module): the emitters that receive it spawn particles where it hit (splashes, sparks...).', [
            num('chance', 'Chance (%)', 100, 0, 100),
        ], true, false),
    module('ReceiveDeathEvent', 'Event', 'Receive event',
        'The emitter spawns particles on the events of another emitter (deaths, times, zones or collisions), instead of following its lifecycle.', [
            choice('event', 'Event', [
                { value: 'Death', label: 'Death' }, { value: 'Time', label: 'Time' }, { value: 'Location', label: 'Location (zone)' }, { value: 'Collision', label: 'Collision' },
            ]),
            { name: 'source', label: 'Emitter ID', type: 'EmitterId', defaultValue: '1' },
            int('count', 'Particles per event', 5, 1, 1000),
            bool('atDeath', 'At the place of the event', true),
            num('inheritVelocity', 'Inherited velocity (%)', 0, 0, 100),
        ], true, false),
];

const BY_KIND = new Map<ModuleKind, ModuleInfo>(MODULES.map(info => [info.kind, info]));

export function moduleInfo(kind: ModuleKind): ModuleInfo {
    const info = BY_KIND.get(kind);
    if (!info) {
        throw new Error(`Unknown module: ${kind}`);
    }

    return info;
}

export function isModuleKind(kind: string): kind is ModuleKind {
    return BY_KIND.has(kind as ModuleKind);
}

export function settingInfo(kind: ModuleKind, name: string): SettingInfo | undefined {
    return moduleInfo(kind).settings.find(setting => setting.name === name);
}

/** Module whose particles send a kind of event. */
export function generatorOf(kind: EventKind): ModuleKind {
    switch (kind) {
        case 'Time': return 'GenerateTimeEvent';
        case 'Location': return 'GenerateLocationEvent';
        case 'Collision': return 'GenerateCollisionEvent';
        default: return 'GenerateDeathEvent';
    }
}

/** Textures of a texture list ("a;b"), in their order; never empty. */
export function splitTextures(value: string | undefined): string[] {
    const textures = (value ?? '').split(';').map(t => t.trim()).filter(t => t.length > 0);
    return textures.length > 0 ? textures : [DEFAULT_TEXTURE];
}

export function joinTextures(textures: readonly string[]): string {
    return textures.map(t => t.trim()).filter(t => t.length > 0).join(';');
}

/** Every text shown by the editor that comes from the catalog (for the translations). */
export function catalogTexts(): string[] {
    const texts = new Set<string>();
    for (const section of SECTIONS) {
        texts.add(section.title);
    }

    for (const info of MODULES) {
        texts.add(info.title);
        texts.add(info.description);
        for (const setting of info.settings) {
            texts.add(setting.label);
            if (setting.hint) {
                texts.add(setting.hint);
            }

            for (const option of setting.choices ?? []) {
                texts.add(option.label);
            }
        }
    }

    return [...texts];
}
