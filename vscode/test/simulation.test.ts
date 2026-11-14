import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEmitter, Emitter, setEnabled, setValue } from '../src/shared/model';
import { Random, Simulation } from '../src/shared/simulation';
import { createSystem } from '../src/shared/templates';

function emitter(settings: [Parameters<typeof setValue>[1], string, string][], configure?: (e: Emitter) => void): Emitter {
    const e = createEmitter('A', 1);
    for (const [kind, name, value] of settings) {
        setValue(e, kind, name, value);
    }

    configure?.(e);
    return e;
}

test('a burst spawns all its particles at the start', () => {
    const simulation = new Simulation([emitter([['SpawnParticles', 'count', '30']])]);
    simulation.step(0.05);
    assert.equal(simulation.particles.length, 30);
});

test('a continuous spawn spreads its particles over the duration', () => {
    const simulation = new Simulation([emitter([['SpawnParticles', 'mode', 'Continuous'], ['SpawnParticles', 'count', '40'], ['Lifecycle', 'duration', '2'],
        ['SpawnParticles', 'lifetimeMin', '5'], ['SpawnParticles', 'lifetimeMax', '5']])]);
    simulation.step(1);
    assert.equal(simulation.particles.length, 20);
    simulation.step(1);
    assert.equal(simulation.particles.length, 40);
});

test('a system played once ends when its particles are dead', () => {
    const simulation = new Simulation([emitter([['SpawnParticles', 'lifetimeMin', '0.5'], ['SpawnParticles', 'lifetimeMax', '0.5'], ['Lifecycle', 'duration', '1']])]);
    for (let i = 0; i < 40 && !simulation.finished; i++) {
        simulation.step(0.05);
    }

    assert.ok(simulation.finished);
    assert.equal(Simulation.length([emitter([['SpawnParticles', 'lifetimeMin', '0.5'], ['SpawnParticles', 'lifetimeMax', '0.5'], ['Lifecycle', 'duration', '1']])]), 1.5);
});

test('an infinite system has no length', () => {
    assert.equal(Simulation.length(createSystem('Sparks', 'S').emitters), undefined);
});

test('the gravity pulls the particles down', () => {
    const simulation = new Simulation([emitter([['Velocity', 'speedMin', '0'], ['Velocity', 'speedMax', '0'], ['SpawnParticles', 'offset', '0 10 0']])], [], () => true, undefined);
    simulation.step(0.05);
    simulation.step(0.5);
    assert.ok(simulation.particles.every(p => p.position.y < 10 && p.velocity.y < 0));
});

test('the ground stops the particles that collide', () => {
    const e = emitter([['Velocity', 'direction', '0 -1 0'], ['Velocity', 'speedMin', '5'], ['Velocity', 'speedMax', '5'], ['SpawnParticles', 'offset', '0 1 0'],
        ['Collision', 'bounce', '0.5']], x => setEnabled(x, 'Collision', true));
    const simulation = new Simulation([e]);
    for (let i = 0; i < 10; i++) {
        simulation.step(0.05);
    }

    assert.ok(simulation.particles.every(p => p.position.y >= 0));
});

test('the ribbon trail spawns on the time events of the heads', () => {
    const file = createSystem('Ribbon', 'Ribbon');
    const simulation = new Simulation(file.emitters, file.userParameters);
    for (let i = 0; i < 20; i++) {
        simulation.step(0.05);
    }

    assert.ok(simulation.events > 0);
    assert.ok(simulation.particles.some(p => p.emitter === 1), 'no particle of the trail');
});

test('an emitter left out of the preview spawns nothing', () => {
    const simulation = new Simulation([createEmitter('A', 1)], [], () => false);
    simulation.step(0.5);
    assert.equal(simulation.particles.length, 0);
});

test('the same seed plays the same particles', () => {
    const play = () => {
        const simulation = new Simulation(createSystem('Fountain', 'F').emitters, [], () => true, 0, 42);
        for (let i = 0; i < 10; i++) {
            simulation.step(0.05);
        }

        return simulation.particles.map(p => p.position);
    };
    assert.deepEqual(play(), play());
});

test('the particle limit is kept', () => {
    const simulation = new Simulation([emitter([['SpawnParticles', 'count', '5000']])], [], () => true, 0, 1, 1000);
    simulation.step(0.05);
    assert.equal(simulation.particles.length, 1000);
});

test('the random numbers stay between 0 and 1', () => {
    const random = new Random(7);
    for (let i = 0; i < 1000; i++) {
        const value = random.next();
        assert.ok(value >= 0 && value < 1);
    }
});
