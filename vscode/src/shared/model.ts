import { EventKind, generatorOf, isModuleKind, ModuleKind, moduleInfo, MODULES, settingInfo, SettingType } from './catalog';

/**
 * A Sparkle system file ("assets/<namespace>/sparkle/<name>.json"): the format of the Sparkle editor of Mine Engine,
 * read by the runtime of the mod. Unknown fields and modules are kept as they are when the file is saved again.
 */
export interface SparkleFile {
    format?: number;
    emitters: Emitter[];
    userParameters: UserParameter[];
    [extra: string]: unknown;
}

export interface Emitter {
    id: string;
    name: string;
    /** Shown in the preview of the editor; it has no effect in the game. */
    preview: boolean;
    /** Position of its node in Mine Engine (kept for it); it has no effect on the particles. */
    x: number;
    y: number;
    modules: Module[];
    [extra: string]: unknown;
}

export interface Module {
    kind: string;
    enabled: boolean;
    /** Missing settings take their default; "@<id>" binds a setting to a user parameter. */
    values: Record<string, string>;
    [extra: string]: unknown;
}

export type UserParameterType = 'Number' | 'Vector' | 'Color' | 'Boolean';

/** A value given by the code of the mod when the system plays (Sparkle.play(..., SparkleParameters)). */
export interface UserParameter {
    id: string;
    name: string;
    type: UserParameterType;
    value: string;
}

export const FORMAT = 1;
const BINDING = '@';

export interface Vector {
    x: number;
    y: number;
    z: number;
}

export function newId(): string {
    let id = '';
    for (let i = 0; i < 32; i++) {
        id += Math.floor(Math.random() * 16).toString(16);
    }

    return id;
}

export function emptySystem(): SparkleFile {
    return { format: FORMAT, emitters: [], userParameters: [] };
}

export function createModule(kind: ModuleKind): Module {
    const info = moduleInfo(kind);
    return { kind, enabled: !info.optional || info.enabledByDefault, values: {} };
}

/** A new emitter with every module at its default, and the given identifier for the events. */
export function createEmitter(name: string, eventId: number): Emitter {
    const emitter: Emitter = { id: newId(), name, preview: true, x: 0, y: 0, modules: MODULES.map(info => createModule(info.kind)) };
    setValue(emitter, 'Identity', 'id', String(eventId));
    return emitter;
}

/** Copy with new identifiers (settings unchanged). */
export function duplicateEmitter(emitter: Emitter, name: string, eventId: number): Emitter {
    const copy = JSON.parse(JSON.stringify(emitter)) as Emitter;
    copy.id = newId();
    copy.name = name;
    setValue(copy, 'Identity', 'id', String(eventId));
    return copy;
}

/** The module of a kind; a default one (not added to the emitter) when the file does not have it. */
export function getModule(emitter: Emitter, kind: ModuleKind): Module {
    return emitter.modules.find(m => m.kind === kind) ?? createModule(kind);
}

/** The module of a kind, added to the emitter when the file does not have it. */
export function ensureModule(emitter: Emitter, kind: ModuleKind): Module {
    let found = emitter.modules.find(m => m.kind === kind);
    if (!found) {
        found = createModule(kind);
        emitter.modules.push(found);
    }

    return found;
}

export function setValue(emitter: Emitter, kind: ModuleKind, name: string, value: string): void {
    ensureModule(emitter, kind).values[name] = value;
}

export function setEnabled(emitter: Emitter, kind: ModuleKind, enabled: boolean): void {
    ensureModule(emitter, kind).enabled = enabled;
}

/** True if the module applies (always for a module that cannot be switched off). */
export function uses(emitter: Emitter, kind: ModuleKind): boolean {
    return !moduleInfo(kind).optional || getModule(emitter, kind).enabled;
}

/** The text of a setting as written (a binding stays "@id"); its default when missing. */
export function rawValue(module: Module, name: string): string {
    const value = module.values[name];
    if (value !== undefined) {
        return value;
    }

    return isModuleKind(module.kind) ? settingInfo(module.kind, name)?.defaultValue ?? '' : '';
}

export function boundParameterId(value: string | undefined): string | undefined {
    return value !== undefined && value.length > 1 && value[0] === BINDING ? value.substring(1) : undefined;
}

export function binding(parameter: UserParameter): string {
    return BINDING + parameter.id;
}

/** A user parameter can drive a setting of this type. */
export function accepts(parameter: UserParameterType, setting: SettingType): boolean {
    switch (parameter) {
        case 'Number': return setting === 'Number' || setting === 'Integer';
        case 'Vector': return setting === 'Vector';
        case 'Color': return setting === 'Color';
        case 'Boolean': return setting === 'Boolean';
    }
}

export function defaultParameterValue(type: UserParameterType): string {
    switch (type) {
        case 'Vector': return '0 0 0';
        case 'Color': return '#FFFFFF';
        case 'Boolean': return 'false';
        default: return '0';
    }
}

/**
 * Reads the settings of a system with its user parameters resolved: a bound setting takes the value of its parameter
 * (the value of the file, the one the system plays with when the code gives none).
 */
export class Reader {
    private readonly parameters: Map<string, UserParameter>;

    constructor(parameters: readonly UserParameter[] = []) {
        this.parameters = new Map(parameters.map(p => [p.id, p]));
    }

    value(module: Module, name: string): string {
        const raw = rawValue(module, name);
        const bound = boundParameterId(raw);
        if (bound === undefined) {
            return raw;
        }

        const parameter = this.parameters.get(bound);
        return parameter ? parameter.value : defaultOf(module, name);
    }

    /** Number of a setting, clamped to its bounds (its default when the text is invalid). */
    number(module: Module, name: string): number {
        const info = isModuleKind(module.kind) ? settingInfo(module.kind, name) : undefined;
        const parse = (text: string): number | undefined => {
            const value = Number(text.trim());
            if (text.trim() === '' || !Number.isFinite(value)) {
                return undefined;
            }

            const clamped = Math.min(info?.max ?? Number.MAX_VALUE, Math.max(info?.min ?? -Number.MAX_VALUE, value));
            return info?.type === 'Integer' ? Math.round(clamped) : clamped;
        };
        return parse(this.value(module, name)) ?? parse(info?.defaultValue ?? '0') ?? 0;
    }

    boolean(module: Module, name: string): boolean {
        return this.value(module, name).trim().toLowerCase() === 'true';
    }

    vector(module: Module, name: string): Vector {
        return parseVector(this.value(module, name)) ?? parseVector(defaultOf(module, name)) ?? { x: 0, y: 0, z: 0 };
    }

    /** Value of a choice setting, or its default when the text is not one of its values. */
    choice(module: Module, name: string): string {
        const value = this.value(module, name);
        const info = isModuleKind(module.kind) ? settingInfo(module.kind, name) : undefined;
        return !info?.choices || info.choices.some(c => c.value === value) ? value : info.defaultValue;
    }

    /** "#RRGGBB" as 0xRRGGBB (white when invalid). */
    color(module: Module, name: string): number {
        return parseColor(this.value(module, name)) ?? 0xFFFFFF;
    }
}

function defaultOf(module: Module, name: string): string {
    return isModuleKind(module.kind) ? settingInfo(module.kind, name)?.defaultValue ?? '' : '';
}

/** Reads "x y z" (or "x, y, z"); undefined when it is invalid. */
export function parseVector(text: string | undefined): Vector | undefined {
    const parts = (text ?? '').split(/[\s,;]+/).filter(p => p.length > 0).map(Number);
    return parts.length === 3 && parts.every(Number.isFinite) ? { x: parts[0], y: parts[1], z: parts[2] } : undefined;
}

export function formatVector(vector: Vector): string {
    return `${round(vector.x)} ${round(vector.y)} ${round(vector.z)}`;
}

function round(value: number): number {
    return Math.round(value * 1e6) / 1e6;
}

export function parseColor(text: string | undefined): number | undefined {
    const hex = (text ?? '').trim().replace(/^#/, '');
    return /^[0-9a-fA-F]{6}$/.test(hex) ? parseInt(hex, 16) : undefined;
}

export function formatColor(rgb: number): string {
    return '#' + (rgb & 0xFFFFFF).toString(16).toUpperCase().padStart(6, '0');
}

const reader = new Reader();

/** Number used by the events (ID module). */
export function eventId(emitter: Emitter): number {
    return reader.number(getModule(emitter, 'Identity'), 'id');
}

/** Spawns only on the events of another emitter. */
export function isEventDriven(emitter: Emitter): boolean {
    return uses(emitter, 'ReceiveDeathEvent');
}

export function eventSource(emitter: Emitter): number | undefined {
    return isEventDriven(emitter) ? reader.number(getModule(emitter, 'ReceiveDeathEvent'), 'source') : undefined;
}

export function receivedEvent(emitter: Emitter): EventKind | undefined {
    return isEventDriven(emitter) ? reader.choice(getModule(emitter, 'ReceiveDeathEvent'), 'event') as EventKind : undefined;
}

/** True if its particles send this kind of event. */
export function sends(emitter: Emitter, kind: EventKind): boolean {
    return uses(emitter, generatorOf(kind));
}

/** Lowest event identifier not used by an emitter of the system. */
export function nextEventId(file: SparkleFile): number {
    const used = new Set(file.emitters.map(eventId));
    let id = 1;
    while (used.has(id)) {
        id++;
    }

    return id;
}

/** A name not used by another emitter: "Sparks", "Sparks 2"... */
export function uniqueEmitterName(file: SparkleFile, name: string): string {
    const names = new Set(file.emitters.map(e => e.name.toLowerCase()));
    if (!names.has(name.toLowerCase())) {
        return name;
    }

    let n = 2;
    while (names.has(`${name} ${n}`.toLowerCase())) {
        n++;
    }

    return `${name} ${n}`;
}

export interface ParseResult {
    readonly file?: SparkleFile;
    readonly error?: string;
}

/** Reads a system file; a file of Mine Engine (with "properties") is read too. */
export function parseSystem(text: string): ParseResult {
    if (text.trim() === '') {
        return { file: emptySystem() };
    }

    let root: unknown;
    try {
        root = JSON.parse(text);
    } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
    }

    if (!isObject(root)) {
        return { error: 'The file is not a JSON object.' };
    }

    const body = isObject(root.properties) ? root.properties : root;
    const file: SparkleFile = { ...body, emitters: [], userParameters: [] };
    for (const item of Array.isArray(body.emitters) ? body.emitters : []) {
        if (!isObject(item)) {
            continue;
        }

        const modules: Module[] = [];
        for (const m of Array.isArray(item.modules) ? item.modules : []) {
            if (isObject(m) && typeof m.kind === 'string') {
                const values: Record<string, string> = {};
                if (isObject(m.values)) {
                    for (const [key, value] of Object.entries(m.values)) {
                        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
                            values[key] = String(value);
                        }
                    }
                }

                modules.push({ ...m, kind: m.kind, enabled: m.enabled !== false, values });
            }
        }

        file.emitters.push({
            ...item,
            id: typeof item.id === 'string' && item.id.length > 0 ? item.id : newId(),
            name: typeof item.name === 'string' ? item.name : 'Emitter',
            preview: item.preview !== false,
            x: typeof item.x === 'number' ? item.x : 0,
            y: typeof item.y === 'number' ? item.y : 0,
            modules,
        });
    }

    for (const item of Array.isArray(body.userParameters) ? body.userParameters : []) {
        if (isObject(item) && typeof item.id === 'string') {
            const type = (['Number', 'Vector', 'Color', 'Boolean'] as const).find(t => t === item.type) ?? 'Number';
            file.userParameters.push({
                id: item.id,
                name: typeof item.name === 'string' ? item.name : item.id,
                type,
                value: typeof item.value === 'string' ? item.value : defaultParameterValue(type),
            });
        }
    }

    return { file };
}

/** The text of the file: two spaces, the emitters then the user parameters, a new line at the end. */
export function serializeSystem(file: SparkleFile): string {
    const { format, emitters, userParameters, ...rest } = file;
    return JSON.stringify({ format: format ?? FORMAT, ...rest, emitters, userParameters }, null, 2) + '\n';
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type Severity = 'error' | 'warning';

export interface Problem {
    readonly severity: Severity;
    /** English text with {0}, {1}... (translated by the editor). */
    readonly message: string;
    readonly args: readonly string[];
    readonly emitter?: string;
    /** Indexes of the arguments that are texts of the catalog, translated with the message. */
    readonly translatedArgs?: readonly number[];
}

/** What would not work as expected in the game: the editor lists it, the runtime still plays what it can. */
export function validate(file: SparkleFile): Problem[] {
    const problems: Problem[] = [];
    const add = (severity: Severity, message: string, args: string[] = [], emitter?: string, translatedArgs?: number[]) =>
        problems.push({ severity, message, args, emitter, translatedArgs });
    if (file.emitters.length === 0) {
        add('warning', 'The system has no emitter: it shows nothing.');
    }

    const byId = new Map<number, Emitter[]>();
    for (const emitter of file.emitters) {
        byId.set(eventId(emitter), [...(byId.get(eventId(emitter)) ?? []), emitter]);
    }

    for (const [id, twins] of byId) {
        if (twins.length > 1) {
            add('error', 'Several emitters have the ID {0}: {1}.', [String(id), twins.map(e => e.name).join(', ')]);
        }
    }

    const names = new Map<string, number>();
    for (const parameter of file.userParameters) {
        const key = parameter.name.trim().toLowerCase();
        names.set(key, (names.get(key) ?? 0) + 1);
        if (parameter.name.trim() === '') {
            add('error', 'A user parameter has no name: the code cannot give it a value.');
        }
    }

    for (const [name, count] of names) {
        if (count > 1 && name !== '') {
            add('warning', 'Several user parameters are named "{0}".', [name]);
        }
    }

    const parameterIds = new Set(file.userParameters.map(p => p.id));
    for (const emitter of file.emitters) {
        const source = eventSource(emitter);
        const kind = receivedEvent(emitter);
        if (source !== undefined && kind !== undefined) {
            const senders = file.emitters.filter(e => e !== emitter && eventId(e) === source);
            if (senders.length === 0) {
                add('error', 'The emitter "{0}" receives the events of the ID {1}, but no other emitter has this ID.', [emitter.name, String(source)], emitter.id);
            } else if (!senders.some(e => sends(e, kind))) {
                add('warning', 'The emitter "{0}" receives events that the emitter of the ID {1} does not send: switch on its module "{2}".',
                    [emitter.name, String(source), moduleInfo(generatorOf(kind)).title], emitter.id, [2]);
            }
        }

        if (sends(emitter, 'Collision') && !uses(emitter, 'Collision')) {
            add('warning', 'The emitter "{0}" sends collision events but has no Collision module: its particles never hit anything.', [emitter.name], emitter.id);
        }

        for (const module of emitter.modules) {
            for (const value of Object.values(module.values)) {
                const bound = boundParameterId(value);
                if (bound !== undefined && !parameterIds.has(bound)) {
                    add('error', 'The emitter "{0}" uses a user parameter that no longer exists (module {1}).', [emitter.name, module.kind], emitter.id);
                }
            }
        }
    }

    return problems;
}
