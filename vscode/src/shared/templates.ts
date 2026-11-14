import { ModuleKind } from './catalog';
import { createEmitter, Emitter, emptySystem, setEnabled, setValue, SparkleFile } from './model';

/** Pre-configured emitters offered when an emitter is added, like the templates of Niagara. */
export type EmitterTemplate = 'Empty' | 'Beam' | 'Fountain' | 'Bounce' | 'Ribbon';

export interface TemplateInfo {
    readonly template: EmitterTemplate;
    readonly title: string;
    readonly description: string;
}

export const EMITTER_TEMPLATES: readonly TemplateInfo[] = [
    { template: 'Empty', title: 'Empty emitter', description: 'An emitter with the default settings.' },
    { template: 'Beam', title: 'Beam', description: 'A ray of light that goes from a point to another (End of the line).' },
    { template: 'Fountain', title: 'Fountain', description: 'Drops thrown up without end, that fall back.' },
    { template: 'Bounce', title: 'Bounce', description: 'Balls that burst out and bounce on the ground until they stop.' },
    { template: 'Ribbon', title: 'Ribbon', description: 'Heads that leave a ribbon behind them: two emitters linked by a time event.' },
];

/** Systems offered by "New particle system". */
export type SystemTemplate = 'Sparks' | 'Empty' | EmitterTemplate;

export const SYSTEM_TEMPLATES: readonly { readonly template: SystemTemplate; readonly title: string; readonly description: string }[] = [
    { template: 'Sparks', title: 'Sparks', description: 'Sparks thrown up in a cone without end: a good start.' },
    { template: 'Beam', title: 'Beam', description: 'A ray of light that goes from a point to another (End of the line).' },
    { template: 'Fountain', title: 'Fountain', description: 'Drops thrown up without end, that fall back.' },
    { template: 'Bounce', title: 'Bounce', description: 'Balls that burst out and bounce on the ground until they stop.' },
    { template: 'Ribbon', title: 'Ribbon', description: 'Heads that leave a ribbon behind them: two emitters linked by a time event.' },
    { template: 'Empty', title: 'Empty system', description: 'A system without emitter.' },
];

type Settings = Partial<Record<ModuleKind, Record<string, string | boolean>>>;

/** Applies settings; a boolean on the key "enabled" switches the module on or off. */
function apply(emitter: Emitter, settings: Settings): Emitter {
    for (const [kind, values] of Object.entries(settings) as [ModuleKind, Record<string, string | boolean>][]) {
        for (const [name, value] of Object.entries(values)) {
            if (name === 'enabled') {
                setEnabled(emitter, kind, value === true);
            } else {
                setValue(emitter, kind, name, String(value));
            }
        }
    }

    return emitter;
}

/** Spacing of the nodes of emitters placed side by side in Mine Engine. */
const NODE_SPACING = 320;

/**
 * The emitters of a template, the first one with its node at (x, y). nextId gives a free event ID at each call;
 * trailName names the second emitter of the ribbon.
 */
export function createFromTemplate(template: EmitterTemplate, name: string, nextId: () => number, x = 0, y = 0,
    trailName = (head: string) => `${head} trail`): Emitter[] {
    const place = (emitter: Emitter, column = 0): Emitter => {
        emitter.x = x + column * NODE_SPACING;
        emitter.y = y;
        return emitter;
    };

    switch (template) {
        case 'Beam':
            return [place(apply(createEmitter(name, nextId()), {
                Lifecycle: { mode: 'Infinite', duration: '1' },
                SpawnParticles: { mode: 'Continuous', count: '120', shape: 'Line', offset: '0 1 0', lineEnd: '0 1 6', lifetimeMin: '0.2', lifetimeMax: '0.35' },
                Velocity: { mode: 'Radial', speedMin: '0', speedMax: '0.2' },
                Gravity: { enabled: false },
                Scale: { mode: 'OverLife', start: '0.25', end: '0.05' },
                Texture: { tint: '#7FE7FF', glow: 'true' },
            }))];
        case 'Fountain':
            return [place(apply(createEmitter(name, nextId()), {
                Lifecycle: { mode: 'Infinite', duration: '1' },
                SpawnParticles: { mode: 'Continuous', count: '60', shape: 'Sphere', radius: '0.1', lifetimeMin: '1.2', lifetimeMax: '1.6' },
                Velocity: { mode: 'Cone', angle: '12', speedMin: '6', speedMax: '8' },
                Collision: { enabled: true, bounce: '0.1' },
                Scale: { mode: 'Random', min: '0.12', max: '0.22' },
                Texture: { tint: '#4FA3FF', glow: 'false' },
            }))];
        case 'Bounce':
            return [place(apply(createEmitter(name, nextId()), {
                Lifecycle: { mode: 'Loop', loops: '3', duration: '2.5' },
                SpawnParticles: { count: '20', offset: '0 1 0', lifetimeMin: '2', lifetimeMax: '2.4' },
                Velocity: { mode: 'Cone', angle: '60', speedMin: '3', speedMax: '6' },
                Collision: { enabled: true, bounce: '0.7' },
                Scale: { value: '0.25' },
                Texture: { tint: '#FFB347' },
            }))];
        case 'Ribbon': {
            const headId = nextId();
            const head = apply(createEmitter(name, headId), {
                Lifecycle: { mode: 'Infinite', duration: '1.5' },
                SpawnParticles: { count: '3', offset: '0 0.5 0', lifetimeMin: '1.2', lifetimeMax: '1.5' },
                Velocity: { mode: 'Cone', angle: '50', speedMin: '4', speedMax: '6' },
                Gravity: { acceleration: '0 -4 0' },
                Scale: { value: '0.2' },
                Texture: { tint: '#FF6FD8' },
                GenerateTimeEvent: { enabled: true, mode: 'Repeat', time: '0.05' },
            });
            const trail = apply(createEmitter(trailName(name), nextId()), {
                SpawnParticles: { lifetimeMin: '0.5', lifetimeMax: '0.6' },
                Velocity: { speedMin: '0', speedMax: '0' },
                Gravity: { enabled: false },
                Scale: { mode: 'OverLife', start: '0.18', end: '0' },
                Texture: { tint: '#C86BFF' },
                ReceiveDeathEvent: { enabled: true, event: 'Time', source: String(headId), count: '1' },
            });
            return [place(head), place(trail, 1)];
        }
        default:
            return [place(createEmitter(name, nextId()))];
    }
}

/** A new system made from a template (the emitters are named with the given title). */
export function createSystem(template: SystemTemplate, emitterName: string, trailName?: (head: string) => string): SparkleFile {
    const file = emptySystem();
    let id = 1;
    const nextId = () => id++;
    if (template === 'Sparks') {
        file.emitters.push(apply(createEmitter(emitterName, nextId()), {
            Velocity: { mode: 'Cone', speedMin: '3', speedMax: '5' },
            Lifecycle: { mode: 'Infinite' },
            Scale: { mode: 'OverLife' },
        }));
    } else if (template !== 'Empty') {
        file.emitters.push(...createFromTemplate(template, emitterName, nextId, 0, 0, trailName));
    }

    return file;
}
