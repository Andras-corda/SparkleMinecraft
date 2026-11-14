import { ENGINE_LIMIT, EventKind, generatorOf, splitTextures } from './catalog';
import { Emitter, eventId, eventSource, getModule, isEventDriven, Module, Reader, receivedEvent, sends, UserParameter, uses, Vector } from './model';

/** A particle of the preview (positions in blocks, y goes up, the system plays at 0 0 0). */
export interface Particle {
    readonly emitter: number;
    position: Vector;
    velocity: Vector;
    age: number;
    readonly lifetime: number;
    readonly randomScale: number;
    size: number;
    sprite: number;
    dead: boolean;
    timeEvents: number;
    inZone: boolean;
    touching: boolean;
    hit: boolean;
}

/** A random generator with a seed, so that a restart plays the same particles. */
export class Random {
    private state: number;

    constructor(seed = 1) {
        this.state = seed >>> 0 || 1;
    }

    /** 0 (included) to 1 (excluded). */
    next(): number {
        // Mulberry32.
        this.state = (this.state + 0x6D2B79F5) >>> 0;
        let t = this.state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    nextInt(bound: number): number {
        return Math.floor(this.next() * bound);
    }
}

const add = (a: Vector, b: Vector): Vector => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sub = (a: Vector, b: Vector): Vector => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const mul = (a: Vector, k: number): Vector => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const length = (a: Vector): number => Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
const normalized = (a: Vector): Vector => {
    const l = length(a);
    return l > 1e-9 ? mul(a, 1 / l) : { x: 0, y: 0, z: 0 };
};
const cross = (a: Vector, b: Vector): Vector => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const ZERO: Vector = { x: 0, y: 0, z: 0 };

interface EmitterState {
    readonly included: boolean;
    spawned: number;
    loop: number;
}

/**
 * Plays a Sparkle system for the preview, in seconds, like the runtime of the mod does in ticks: the lifecycle of the
 * emitters, the spawn, the velocity, the gravity, a ground at y = 0 for the collisions, the size and the events.
 */
export class Simulation {
    private readonly states: EmitterState[];
    private readonly reader: Reader;
    private readonly random: Random;
    private readonly list: Particle[] = [];
    time = 0;
    events = 0;

    constructor(private readonly emitters: readonly Emitter[], parameters: readonly UserParameter[] = [],
        included: (emitter: Emitter) => boolean = () => true, readonly ground: number | undefined = 0, seed = 1,
        readonly maxParticles = ENGINE_LIMIT) {
        this.reader = new Reader(parameters);
        this.random = new Random(seed);
        this.states = emitters.map(e => ({ included: included(e), spawned: 0, loop: -1 }));
    }

    get particles(): readonly Particle[] {
        return this.list;
    }

    /** Every emitter that follows its lifecycle is over and every particle is dead. */
    get finished(): boolean {
        return this.list.length === 0 && this.emitters.every((e, i) => !this.states[i].included || isEventDriven(e) || this.lifecycleOver(e, this.time));
    }

    /** Length of a play in seconds (to the death of the last particle), undefined when an emitter never stops. */
    static length(emitters: readonly Emitter[], parameters: readonly UserParameter[] = [], included: (e: Emitter) => boolean = () => true): number | undefined {
        const reader = new Reader(parameters);
        const ends = new Map<number, number>();
        let total = 0;
        const longestLife = (e: Emitter) => {
            const spawn = getModule(e, 'SpawnParticles');
            return Math.max(reader.number(spawn, 'lifetimeMin'), reader.number(spawn, 'lifetimeMax'));
        };
        for (const emitter of emitters.filter(e => included(e) && !isEventDriven(e))) {
            const loops = loopCount(reader, emitter);
            if (loops === Infinity) {
                return undefined;
            }

            const lifecycle = getModule(emitter, 'Lifecycle');
            const end = reader.number(lifecycle, 'delay') + reader.number(lifecycle, 'duration') * loops + longestLife(emitter);
            ends.set(eventId(emitter), Math.max(ends.get(eventId(emitter)) ?? 0, end));
            total = Math.max(total, end);
        }

        // Each pass adds one level of events (a chain of n emitters needs n passes; a loop stops at the count).
        for (let pass = 0; pass < emitters.length; pass++) {
            for (const emitter of emitters.filter(e => included(e) && isEventDriven(e))) {
                const source = eventSource(emitter);
                const sourceEnd = source === undefined ? undefined : ends.get(source);
                if (sourceEnd !== undefined) {
                    const end = sourceEnd + longestLife(emitter);
                    ends.set(eventId(emitter), Math.max(ends.get(eventId(emitter)) ?? 0, end));
                    total = Math.max(total, end);
                }
            }
        }

        return total;
    }

    step(delta: number): void {
        if (delta <= 0) {
            return;
        }

        const from = this.time;
        this.time += delta;
        this.emitters.forEach((emitter, i) => {
            if (this.states[i].included && !isEventDriven(emitter)) {
                this.spawnOwn(i, from, this.time);
            }
        });

        // The events spawn particles: they are sent once every particle has moved.
        const dying: Particle[] = [];
        const events: [Particle, EventKind][] = [];
        for (const particle of this.list) {
            this.update(particle, delta);
            this.collectEvents(particle, events);
            if (particle.dead || particle.age >= particle.lifetime) {
                particle.dead = true;
                dying.push(particle);
            }
        }

        for (let i = this.list.length - 1; i >= 0; i--) {
            if (this.list[i].dead) {
                this.list.splice(i, 1);
            }
        }

        for (const [particle, kind] of events) {
            this.send(particle, kind);
        }

        for (const particle of dying) {
            this.send(particle, 'Death');
        }
    }

    private lifecycleOver(emitter: Emitter, time: number): boolean {
        const loops = loopCount(this.reader, emitter);
        const lifecycle = getModule(emitter, 'Lifecycle');
        return loops !== Infinity && time >= this.reader.number(lifecycle, 'delay') + this.reader.number(lifecycle, 'duration') * loops;
    }

    private spawnOwn(index: number, from: number, to: number): void {
        const emitter = this.emitters[index];
        const state = this.states[index];
        const lifecycle = getModule(emitter, 'Lifecycle');
        const spawn = getModule(emitter, 'SpawnParticles');
        const delay = this.reader.number(lifecycle, 'delay');
        const duration = this.reader.number(lifecycle, 'duration');
        const loops = loopCount(this.reader, emitter);
        const count = this.reader.number(spawn, 'count');
        const burst = this.reader.choice(spawn, 'mode') === 'Burst';

        // Walks through the loops crossed by this step (several when the step is long).
        for (let time = Math.max(from, delay); time < to;) {
            const loop = Math.floor((time - delay) / duration);
            if (loop >= loops) {
                return;
            }

            const loopStart = delay + loop * duration;
            const loopEnd = Math.min(to, loopStart + duration);
            if (state.loop !== loop) {
                state.loop = loop;
                state.spawned = 0;
            }

            const wanted = burst ? count : Math.min(count, count * (loopEnd - loopStart) / duration);
            for (let n = Math.floor(state.spawned); n < Math.floor(wanted); n++) {
                this.spawn(index, undefined, undefined);
            }

            state.spawned = Math.max(state.spawned, wanted);
            time = loopEnd === to ? to : loopEnd + 1e-9;
        }
    }

    private spawn(index: number, at: Vector | undefined, inherited: Vector | undefined): void {
        if (this.list.length >= this.maxParticles) {
            return;
        }

        const emitter = this.emitters[index];
        const r = this.reader;
        const spawn = getModule(emitter, 'SpawnParticles');
        const center = add(at ?? ZERO, r.vector(spawn, 'offset'));
        const position = add(center, this.shapePoint(spawn));
        let velocity = this.velocity(getModule(emitter, 'Velocity'), sub(position, center));
        if (inherited) {
            velocity = add(velocity, mul(inherited, r.number(getModule(emitter, 'ReceiveDeathEvent'), 'inheritVelocity') / 100));
        }

        const lifetime = this.between(r.number(spawn, 'lifetimeMin'), r.number(spawn, 'lifetimeMax'));
        const scale = getModule(emitter, 'Scale');
        const particle: Particle = {
            emitter: index, position, velocity, age: 0, lifetime,
            randomScale: this.between(r.number(scale, 'min'), r.number(scale, 'max')),
            size: 0, sprite: 0, dead: false, timeEvents: 0, inZone: false, touching: false, hit: false,
        };
        particle.size = this.size(emitter, particle);
        const texture = getModule(emitter, 'Texture');
        const textures = splitTextures(r.value(texture, 'texture')).length;
        if (textures > 1 && r.choice(texture, 'spriteMode') === 'Random') {
            particle.sprite = this.random.nextInt(textures);
        }

        // Born inside its zone, a particle has not entered it: it sends the event once it comes back in.
        particle.inZone = uses(emitter, 'GenerateLocationEvent') && this.inZone(getModule(emitter, 'GenerateLocationEvent'), position);
        this.list.push(particle);
    }

    private shapePoint(spawn: Module): Vector {
        const r = this.reader;
        switch (r.choice(spawn, 'shape')) {
            case 'Sphere':
                // Uniform in the volume of the ball.
                return mul(this.randomUnit(), r.number(spawn, 'radius') * Math.cbrt(this.random.next()));
            case 'Box': {
                const size = r.vector(spawn, 'size');
                return { x: size.x * (this.random.next() - 0.5), y: size.y * (this.random.next() - 0.5), z: size.z * (this.random.next() - 0.5) };
            }
            case 'Line':
                // From the coordinates (the center) to the end of the line.
                return mul(sub(r.vector(spawn, 'lineEnd'), r.vector(spawn, 'offset')), this.random.next());
            default:
                return ZERO;
        }
    }

    private velocity(module: Module, fromCenter: Vector): Vector {
        const r = this.reader;
        const speed = this.between(r.number(module, 'speedMin'), r.number(module, 'speedMax'));
        const axis = normalized(r.vector(module, 'direction'));
        let direction: Vector;
        switch (r.choice(module, 'mode')) {
            case 'Cone':
                direction = this.inCone(length(axis) === 0 ? { x: 0, y: 1, z: 0 } : axis, r.number(module, 'angle') * Math.PI / 180);
                break;
            case 'Radial':
                direction = length(fromCenter) > 1e-9 ? normalized(fromCenter) : this.randomUnit();
                break;
            default:
                direction = axis;
        }

        return mul(direction, speed);
    }

    private inCone(axis: Vector, angle: number): Vector {
        const cos = 1 - this.random.next() * (1 - Math.cos(angle));
        const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
        const turn = this.random.next() * 2 * Math.PI;
        const helper = Math.abs(axis.y) < 0.99 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
        const u = normalized(cross(axis, helper));
        const v = cross(axis, u);
        return add(add(mul(axis, cos), mul(u, sin * Math.cos(turn))), mul(v, sin * Math.sin(turn)));
    }

    private randomUnit(): Vector {
        const y = this.random.next() * 2 - 1;
        const turn = this.random.next() * 2 * Math.PI;
        const r = Math.sqrt(1 - y * y);
        return { x: r * Math.cos(turn), y, z: r * Math.sin(turn) };
    }

    private between(a: number, b: number): number {
        return Math.min(a, b) + this.random.next() * Math.abs(b - a);
    }

    private update(particle: Particle, delta: number): void {
        const emitter = this.emitters[particle.emitter];
        particle.age += delta;
        if (uses(emitter, 'Gravity')) {
            particle.velocity = add(particle.velocity, mul(this.reader.vector(getModule(emitter, 'Gravity'), 'acceleration'), delta));
        }

        particle.position = add(particle.position, mul(particle.velocity, delta));
        particle.hit = false;
        if (this.ground !== undefined && uses(emitter, 'Collision') && particle.position.y < this.ground) {
            particle.hit = true;
            const collision = getModule(emitter, 'Collision');
            if (this.reader.boolean(collision, 'die')) {
                particle.dead = true;
            }

            particle.position = { ...particle.position, y: this.ground };
            particle.velocity = { ...particle.velocity, y: -particle.velocity.y * this.reader.number(collision, 'bounce') };
        }

        particle.size = this.size(emitter, particle);
    }

    /** Size of the particle (blocks) at its age. */
    size(emitter: Emitter, particle: Particle): number {
        const scale = getModule(emitter, 'Scale');
        const r = this.reader;
        switch (r.choice(scale, 'mode')) {
            case 'OverLife':
                return r.number(scale, 'start') + (r.number(scale, 'end') - r.number(scale, 'start')) * progress(particle);
            case 'Random':
                return particle.randomScale;
            default:
                return r.number(scale, 'value');
        }
    }

    /** The texture shown by the particle among the ones of its emitter. */
    sprite(particle: Particle, textures: number): number {
        if (textures <= 1) {
            return 0;
        }

        const texture = getModule(this.emitters[particle.emitter], 'Texture');
        return this.reader.choice(texture, 'spriteMode') === 'OverLife'
            ? Math.min(textures - 1, Math.floor(progress(particle) * textures))
            : Math.max(0, Math.min(textures - 1, particle.sprite));
    }

    private collectEvents(particle: Particle, events: [Particle, EventKind][]): void {
        const emitter = this.emitters[particle.emitter];
        const r = this.reader;
        if (uses(emitter, 'GenerateTimeEvent')) {
            const time = getModule(emitter, 'GenerateTimeEvent');
            const interval = Math.max(0.05, r.number(time, 'time'));
            let due = Math.floor(particle.age / interval + 1e-9);
            if (r.choice(time, 'mode') !== 'Repeat') {
                due = Math.min(1, due);
            }

            for (; particle.timeEvents < due; particle.timeEvents++) {
                events.push([particle, 'Time']);
            }
        }

        if (uses(emitter, 'GenerateCollisionEvent')) {
            if (particle.hit && !particle.touching) {
                events.push([particle, 'Collision']);
            }

            particle.touching = particle.hit;
        }

        if (uses(emitter, 'GenerateLocationEvent')) {
            const inside = this.inZone(getModule(emitter, 'GenerateLocationEvent'), particle.position);
            if (inside && !particle.inZone) {
                events.push([particle, 'Location']);
            }

            particle.inZone = inside;
        }
    }

    inZone(zone: Module, point: Vector): boolean {
        const offset = sub(point, this.reader.vector(zone, 'center'));
        if (this.reader.choice(zone, 'shape') === 'Box') {
            const size = this.reader.vector(zone, 'size');
            return Math.abs(offset.x) <= size.x / 2 && Math.abs(offset.y) <= size.y / 2 && Math.abs(offset.z) <= size.z / 2;
        }

        return length(offset) <= this.reader.number(zone, 'radius');
    }

    private send(particle: Particle, kind: EventKind): void {
        const emitter = this.emitters[particle.emitter];
        if (!sends(emitter, kind) || this.random.next() * 100 >= this.reader.number(getModule(emitter, generatorOf(kind)), 'chance')) {
            return;
        }

        this.events++;
        const id = eventId(emitter);
        this.emitters.forEach((receiver, i) => {
            if (i === particle.emitter || !this.states[i].included || eventSource(receiver) !== id || receivedEvent(receiver) !== kind) {
                return;
            }

            const receive = getModule(receiver, 'ReceiveDeathEvent');
            const at = this.reader.boolean(receive, 'atDeath') ? particle.position : undefined;
            const count = this.reader.number(receive, 'count');
            for (let n = 0; n < count; n++) {
                this.spawn(i, at, particle.velocity);
            }
        });
    }
}

function loopCount(reader: Reader, emitter: Emitter): number {
    const lifecycle = getModule(emitter, 'Lifecycle');
    switch (reader.choice(lifecycle, 'mode')) {
        case 'Loop': return reader.number(lifecycle, 'loops');
        case 'Infinite': return Infinity;
        default: return 1;
    }
}

export function progress(particle: Particle): number {
    return particle.lifetime <= 0 ? 1 : Math.max(0, Math.min(1, particle.age / particle.lifetime));
}
