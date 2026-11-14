import { splitTextures } from '../shared/catalog';
import { Emitter, getModule, Reader, serializeSystem, SparkleFile, Vector } from '../shared/model';
import { TextureEntry } from '../shared/messages';
import { Simulation } from '../shared/simulation';

type Translate = (text: string, ...args: (string | number)[]) => string;

/** The textures of an emitter, read once per system. */
interface EmitterLook {
    readonly textures: readonly string[];
    readonly tint: string;
}

const SPEEDS = [0.25, 0.5, 1, 2];

/**
 * The 3D preview of a system: the simulation of the plugin (the same rules as the runtime of the mod), drawn on a
 * canvas with an orbit camera. The system plays at 0 0 0, the ground (y = 0) stops the particles with a collision.
 */
export class Preview {
    readonly element: HTMLElement;
    private readonly canvas: HTMLCanvasElement;
    private readonly context: CanvasRenderingContext2D;
    private readonly stats: HTMLElement;
    private readonly playButton: HTMLButtonElement;
    private system?: SparkleFile;
    private systemText = '';
    private simulation?: Simulation;
    private looks: EmitterLook[] = [];
    private length: number | undefined;
    private playing = true;
    private ground = true;
    private speed = 1;
    private yaw = 0.7;
    private pitch = 0.35;
    private distance = 9;
    private target: Vector = { x: 0, y: 1, z: 0 };
    private finishedAt: number | undefined;
    private last = 0;
    private readonly images = new Map<string, HTMLImageElement>();
    private readonly tinted = new Map<string, HTMLCanvasElement>();
    private textureUris = new Map<string, string>();

    constructor(private readonly t: Translate) {
        this.canvas = document.createElement('canvas');
        this.context = this.canvas.getContext('2d')!;
        this.stats = document.createElement('span');
        this.stats.className = 'stats';
        this.playButton = this.button('', () => {
            this.playing = !this.playing;
            this.updateButtons();
        });
        const restart = this.button(t('Restart'), () => this.restart());
        const ground = this.check(t('Ground'), this.ground, value => {
            this.ground = value;
            this.restart();
        });
        const speed = document.createElement('select');
        speed.title = t('Speed');
        for (const value of SPEEDS) {
            const option = document.createElement('option');
            option.value = String(value);
            option.textContent = `×${value}`;
            option.selected = value === this.speed;
            speed.append(option);
        }

        speed.addEventListener('change', () => this.speed = Number(speed.value));
        const bar = document.createElement('div');
        bar.className = 'preview-bar';
        bar.append(this.playButton, restart, ground, speed, this.stats);
        const hint = document.createElement('div');
        hint.className = 'preview-hint';
        hint.textContent = t('Drag to turn, wheel to zoom.');
        this.element = document.createElement('div');
        this.element.className = 'preview';
        this.element.append(bar, this.canvas, hint);
        this.updateButtons();
        this.listen();
        new ResizeObserver(() => this.resize()).observe(this.canvas);
        requestAnimationFrame(time => this.frame(time));
    }

    setTextures(textures: readonly TextureEntry[]): void {
        this.textureUris = new Map(textures.map(e => [e.name, e.uri]));
        this.tinted.clear();
    }

    /** A new version of the system: the preview restarts when it changed. */
    setSystem(system: SparkleFile): void {
        const text = serializeSystem(system);
        if (text === this.systemText) {
            return;
        }

        this.system = system;
        this.systemText = text;
        this.restart();
    }

    private restart(): void {
        const system = this.system;
        if (!system) {
            return;
        }

        // A copy: the editor changes the objects of the system.
        const copy = JSON.parse(this.systemText) as SparkleFile;
        const included = (e: Emitter) => e.preview !== false;
        this.simulation = new Simulation(copy.emitters, copy.userParameters, included, this.ground ? 0 : undefined, 1, 4000);
        this.length = Simulation.length(copy.emitters, copy.userParameters, included);
        const reader = new Reader(copy.userParameters);
        this.looks = copy.emitters.map(e => {
            const texture = getModule(e, 'Texture');
            return { textures: splitTextures(reader.value(texture, 'texture')), tint: '#' + reader.color(texture, 'tint').toString(16).padStart(6, '0') };
        });
        this.finishedAt = undefined;
    }

    private frame(time: number): void {
        const delta = Math.min(0.1, Math.max(0, (time - this.last) / 1000));
        this.last = time;
        const simulation = this.simulation;
        if (simulation && this.playing) {
            simulation.step(delta * this.speed);
            if (simulation.finished) {
                // A finished system plays again after a short pause.
                this.finishedAt ??= time;
                if (time - this.finishedAt > 800) {
                    this.restart();
                }
            }
        }

        this.draw();
        requestAnimationFrame(next => this.frame(next));
    }

    private draw(): void {
        const ctx = this.context;
        const width = this.canvas.width;
        const height = this.canvas.height;
        if (width === 0 || height === 0) {
            return;
        }

        const style = getComputedStyle(document.body);
        ctx.fillStyle = style.getPropertyValue('--vscode-editor-background') || '#1e1e1e';
        ctx.fillRect(0, 0, width, height);
        const camera = this.camera(width, height);
        if (this.ground) {
            this.drawGrid(camera);
        }

        this.drawAxes(camera);
        const simulation = this.simulation;
        if (!simulation) {
            return;
        }

        const projected = simulation.particles
            .map(p => ({ particle: p, screen: camera.project(p.position) }))
            .filter(p => p.screen !== undefined)
            .sort((a, b) => b.screen!.depth - a.screen!.depth);
        ctx.imageSmoothingEnabled = false;
        for (const { particle, screen } of projected) {
            const look = this.looks[particle.emitter];
            if (!look || !screen) {
                continue;
            }

            const half = Math.max(0.5, particle.size / 2 * camera.focal / screen.depth);
            const texture = look.textures[simulation.sprite(particle, look.textures.length)];
            const sprite = this.sprite(texture, look.tint);
            ctx.drawImage(sprite, screen.x - half, screen.y - half, half * 2, half * 2);
        }

        this.stats.textContent = [
            this.t('{0} particles', simulation.particles.length),
            this.t('{0} s', simulation.time.toFixed(1)),
            this.length === undefined ? this.t('Length: without end') : this.t('Length: {0} s', this.length.toFixed(1)),
        ].join('   ');
    }

    /** The texture tinted like in the game (multiplied by the tint); a soft dot for a texture that is not in the project. */
    private sprite(texture: string, tint: string): CanvasImageSource {
        const key = `${texture}|${tint}`;
        const cached = this.tinted.get(key);
        if (cached) {
            return cached;
        }

        const uri = this.textureUris.get(texture);
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d')!;
        if (uri) {
            const image = this.image(uri);
            if (!image.complete || image.naturalWidth === 0) {
                // Not loaded yet: a dot this time, the texture once it is there.
                return this.dot(tint);
            }

            // An animated texture (a strip) shows its first frame.
            const size = Math.min(image.naturalWidth, image.naturalHeight);
            canvas.width = size;
            canvas.height = size;
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(image, 0, 0, size, size, 0, 0, size, size);
            ctx.globalCompositeOperation = 'multiply';
            ctx.fillStyle = tint;
            ctx.fillRect(0, 0, size, size);
            ctx.globalCompositeOperation = 'destination-in';
            ctx.drawImage(image, 0, 0, size, size, 0, 0, size, size);
            this.tinted.set(key, canvas);
            return canvas;
        }

        const dot = this.dot(tint);
        this.tinted.set(key, dot);
        return dot;
    }

    private dot(tint: string): HTMLCanvasElement {
        const canvas = document.createElement('canvas');
        canvas.width = 32;
        canvas.height = 32;
        const ctx = canvas.getContext('2d')!;
        const gradient = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
        gradient.addColorStop(0, '#ffffff');
        gradient.addColorStop(0.35, tint);
        gradient.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, 32, 32);
        return canvas;
    }

    private image(uri: string): HTMLImageElement {
        let image = this.images.get(uri);
        if (!image) {
            image = new Image();
            image.src = uri;
            image.onload = () => this.tinted.clear();
            this.images.set(uri, image);
        }

        return image;
    }

    private camera(width: number, height: number) {
        const cosPitch = Math.cos(this.pitch);
        const eye: Vector = {
            x: this.target.x + this.distance * cosPitch * Math.sin(this.yaw),
            y: this.target.y + this.distance * Math.sin(this.pitch),
            z: this.target.z + this.distance * cosPitch * Math.cos(this.yaw),
        };
        const forward = normalize(sub(this.target, eye));
        const right = normalize(cross(forward, { x: 0, y: 1, z: 0 }));
        const up = cross(right, forward);
        const focal = height / (2 * Math.tan(Math.PI / 6));
        return {
            focal,
            project(point: Vector): { x: number; y: number; depth: number } | undefined {
                const d = sub(point, eye);
                const depth = dot(d, forward);
                if (depth < 0.05) {
                    return undefined;
                }

                return { x: width / 2 + dot(d, right) * focal / depth, y: height / 2 - dot(d, up) * focal / depth, depth };
            },
        };
    }

    private drawGrid(camera: ReturnType<Preview['camera']>): void {
        const ctx = this.context;
        ctx.strokeStyle = 'rgba(128,128,128,0.25)';
        ctx.lineWidth = 1;
        for (let i = -6; i <= 6; i++) {
            this.line(camera, { x: i, y: 0, z: -6 }, { x: i, y: 0, z: 6 });
            this.line(camera, { x: -6, y: 0, z: i }, { x: 6, y: 0, z: i });
        }
    }

    private drawAxes(camera: ReturnType<Preview['camera']>): void {
        const ctx = this.context;
        ctx.lineWidth = 2;
        for (const [axis, color] of [[{ x: 1, y: 0, z: 0 }, '#e05555'], [{ x: 0, y: 1, z: 0 }, '#55c055'], [{ x: 0, y: 0, z: 1 }, '#5580e0']] as const) {
            ctx.strokeStyle = color;
            this.line(camera, { x: 0, y: 0, z: 0 }, axis);
        }
    }

    private line(camera: ReturnType<Preview['camera']>, a: Vector, b: Vector): void {
        const pa = camera.project(a);
        const pb = camera.project(b);
        if (pa && pb) {
            const ctx = this.context;
            ctx.beginPath();
            ctx.moveTo(pa.x, pa.y);
            ctx.lineTo(pb.x, pb.y);
            ctx.stroke();
        }
    }

    private resize(): void {
        const ratio = window.devicePixelRatio || 1;
        this.canvas.width = Math.max(1, Math.floor(this.canvas.clientWidth * ratio));
        this.canvas.height = Math.max(1, Math.floor(this.canvas.clientHeight * ratio));
    }

    private listen(): void {
        let dragging: { x: number; y: number } | undefined;
        this.canvas.addEventListener('pointerdown', e => {
            dragging = { x: e.clientX, y: e.clientY };
            this.canvas.setPointerCapture(e.pointerId);
        });
        this.canvas.addEventListener('pointermove', e => {
            if (dragging) {
                this.yaw -= (e.clientX - dragging.x) * 0.01;
                this.pitch = Math.max(-1.4, Math.min(1.4, this.pitch + (e.clientY - dragging.y) * 0.01));
                dragging = { x: e.clientX, y: e.clientY };
            }
        });
        this.canvas.addEventListener('pointerup', () => dragging = undefined);
        this.canvas.addEventListener('wheel', e => {
            e.preventDefault();
            this.distance = Math.max(1.5, Math.min(80, this.distance * Math.exp(e.deltaY * 0.001)));
        }, { passive: false });
    }

    private updateButtons(): void {
        this.playButton.textContent = this.playing ? this.t('Pause') : this.t('Play');
    }

    private button(label: string, onClick: () => void): HTMLButtonElement {
        const button = document.createElement('button');
        button.textContent = label;
        button.addEventListener('click', onClick);
        return button;
    }

    private check(label: string, value: boolean, onChange: (value: boolean) => void): HTMLLabelElement {
        const wrapper = document.createElement('label');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = value;
        box.addEventListener('change', () => onChange(box.checked));
        wrapper.append(box, ` ${label}`);
        return wrapper;
    }
}

const sub = (a: Vector, b: Vector): Vector => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vector, b: Vector): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vector, b: Vector): Vector => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const normalize = (a: Vector): Vector => {
    const length = Math.sqrt(dot(a, a));
    return length > 1e-9 ? { x: a.x / length, y: a.y / length, z: a.z / length } : a;
};
