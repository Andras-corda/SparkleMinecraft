import { isModuleKind, ModuleInfo, MODULES, SECTIONS, SettingInfo, splitTextures, joinTextures, ModuleKind } from '../shared/catalog';
import {
    accepts, binding, boundParameterId, defaultParameterValue, duplicateEmitter, Emitter, eventId, formatColor, getModule,
    nextEventId, parseColor, parseSystem, parseVector, rawValue, serializeSystem, SparkleFile, uniqueEmitterName, UserParameterType, validate, newId,
    ensureModule,
} from '../shared/model';
import { TextureEntry, ToExtension, ToWebview } from '../shared/messages';
import { createFromTemplate, EMITTER_TEMPLATES, EmitterTemplate } from '../shared/templates';
import { Preview } from './preview';

declare function acquireVsCodeApi(): { postMessage(message: ToExtension): void; getState(): unknown; setState(state: unknown): void };

const vscode = acquireVsCodeApi();
const app = document.getElementById('app')!;

let strings: Record<string, string> = {};
let file: SparkleFile | undefined;
let parseError: string | undefined;
let selected: string | undefined;
let systemKey = '';
let textures: TextureEntry[] = [];
const collapsed = new Set<string>(((vscode.getState() as { collapsed?: string[] } | undefined)?.collapsed) ?? []);
let preview: Preview | undefined;
let pickRequest = 0;
const pickHandlers = new Map<number, (name: string | undefined) => void>();

/** The text in the language of VS Code, with {0}, {1}... replaced. */
function t(text: string, ...args: (string | number)[]): string {
    const translated = strings[text] ?? text;
    return translated.replace(/\{(\d+)\}/g, (match, index: string) => args[Number(index)] !== undefined ? String(args[Number(index)]) : match);
}

function post(message: ToExtension): void {
    vscode.postMessage(message);
}

/** Saves the system in the document (undo, redo and save are the ones of VS Code). */
function commit(): void {
    if (!file) {
        return;
    }

    post({ type: 'edit', text: serializeSystem(file) });
    render();
}

function load(text: string): void {
    const result = parseSystem(text);
    file = result.file;
    parseError = result.error;
    if (file && !file.emitters.some(e => e.id === selected)) {
        selected = file.emitters[0]?.id;
    }

    render();
}

window.addEventListener('message', (event: MessageEvent<ToWebview>) => {
    const message = event.data;
    switch (message.type) {
        case 'init':
            strings = message.strings;
            textures = [...message.textures];
            systemKey = message.systemKey;
            load(message.text);
            break;
        case 'update':
            load(message.text);
            break;
        case 'textures':
            textures = [...message.textures];
            preview?.setTextures(textures);
            render();
            break;
        case 'texturePicked':
            pickHandlers.get(message.request)?.(message.name);
            pickHandlers.delete(message.request);
            break;
    }
});

// ----- DOM helpers -----

type Child = Node | string | undefined | false;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<Record<string, unknown>> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (value === undefined || value === false) {
            continue;
        }

        if (key.startsWith('on') && typeof value === 'function') {
            element.addEventListener(key.substring(2).toLowerCase(), value as EventListener);
        } else if (key === 'className') {
            element.className = String(value);
        } else if (key === 'value') {
            (element as HTMLInputElement).value = String(value);
        } else if (key === 'checked') {
            (element as HTMLInputElement).checked = value === true;
        } else {
            element.setAttribute(key, value === true ? '' : String(value));
        }
    }

    for (const child of children) {
        if (child !== undefined && child !== false) {
            element.append(child);
        }
    }

    return element;
}

function button(label: string, onClick: () => void, title?: string, className = ''): HTMLButtonElement {
    return el('button', { className, title, onClick: (e: Event) => { e.stopPropagation(); onClick(); } }, label);
}

// ----- Render -----

function render(): void {
    // Keeps the field being typed in focused across the render.
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.key;
    preview ??= new Preview(t);
    app.replaceChildren();
    if (!file) {
        app.append(el('div', { className: 'error' }, t('The file cannot be read: {0}', parseError ?? ''), ' ',
            button(t('Open as text'), () => post({ type: 'openText' }))));
        return;
    }

    preview.setTextures(textures);
    preview.setSystem(file);
    app.append(el('div', { className: 'layout' },
        el('aside', { className: 'side' }, systemPanel(), emittersPanel(file), parametersPanel(file), problemsPanel(file)),
        el('main', { className: 'center' }, preview.element),
        el('aside', { className: 'inspector' }, inspector(file)),
    ));

    if (focused) {
        const target = app.querySelector<HTMLElement>(`[data-key="${CSS.escape(focused)}"]`);
        target?.focus();
    }
}

/** The name to give to Sparkle.play, and the actions on the file. */
function systemPanel(): HTMLElement {
    return el('section', { className: 'system' },
        el('div', { className: 'key', title: systemKey }, systemKey),
        el('div', { className: 'actions' },
            button(t('Copy the code that plays it'), () => post({ type: 'copyPlayCode' }), undefined, 'link'),
            button(t('Install the runtime'), () => post({ type: 'installRuntime' }), undefined, 'link'),
            button(t('Open as text'), () => post({ type: 'openText' }), undefined, 'link')));
}

function emittersPanel(system: SparkleFile): HTMLElement {
    const add = el('select', {
        title: t('Add an emitter'),
        onChange: (e: Event) => {
            const value = (e.target as HTMLSelectElement).value as EmitterTemplate | '';
            if (value) {
                const info = EMITTER_TEMPLATES.find(i => i.template === value)!;
                const name = uniqueEmitterName(system, value === 'Empty' ? t('Emitter') : t(info.title));
                const last = system.emitters[system.emitters.length - 1];
                const used = new Set(system.emitters.map(eventId));
                let next = 1;
                const nextId = () => {
                    while (used.has(next)) {
                        next++;
                    }

                    used.add(next);
                    return next;
                };
                const created = createFromTemplate(value, name, nextId, (last?.x ?? -320) + 320, last?.y ?? 0, head => `${head} ${t('trail')}`);
                system.emitters.push(...created);
                selected = created[0].id;
                commit();
            }
        },
    }, el('option', { value: '' }, `+ ${t('Add')}...`), ...EMITTER_TEMPLATES.map(i => el('option', { value: i.template, title: t(i.description) }, t(i.title))));

    const rows = system.emitters.map(emitter => el('div', {
        className: `row emitter${emitter.id === selected ? ' selected' : ''}`,
        onClick: () => { selected = emitter.id; render(); },
    },
    el('input', {
        type: 'checkbox', checked: emitter.preview, title: t('Shown in the preview'),
        onClick: (e: Event) => e.stopPropagation(),
        onChange: (e: Event) => { emitter.preview = (e.target as HTMLInputElement).checked; commit(); },
    }),
    el('span', { className: 'name' }, emitter.name || '-'),
    el('span', { className: 'badge', title: 'ID' }, String(eventId(emitter))),
    button('⧉', () => {
        const copy = duplicateEmitter(emitter, uniqueEmitterName(system, emitter.name), nextEventId(system));
        copy.x = emitter.x + 40;
        copy.y = emitter.y + 40;
        system.emitters.splice(system.emitters.indexOf(emitter) + 1, 0, copy);
        selected = copy.id;
        commit();
    }, t('Duplicate'), 'icon'),
    button('✕', () => {
        system.emitters = system.emitters.filter(e => e !== emitter);
        if (selected === emitter.id) {
            selected = system.emitters[0]?.id;
        }

        commit();
    }, t('Delete'), 'icon')));

    return el('section', {}, el('h2', {}, t('Emitters')), ...rows, add);
}

function parametersPanel(system: SparkleFile): HTMLElement {
    const types: UserParameterType[] = ['Number', 'Vector', 'Color', 'Boolean'];
    const typeLabel = (type: UserParameterType) => t(type === 'Boolean' ? 'Yes / no' : type);
    const add = el('select', {
        title: t('Add a parameter'),
        onChange: (e: Event) => {
            const type = (e.target as HTMLSelectElement).value as UserParameterType | '';
            if (type) {
                let n = system.userParameters.length + 1;
                while (system.userParameters.some(p => p.name === `param${n}`)) {
                    n++;
                }

                system.userParameters.push({ id: newId(), name: `param${n}`, type, value: defaultParameterValue(type) });
                commit();
            }
        },
    }, el('option', { value: '' }, `+ ${t('Add')}...`), ...types.map(type => el('option', { value: type }, typeLabel(type))));

    const rows = system.userParameters.map(parameter => el('div', { className: 'row parameter' },
        el('input', {
            className: 'param-name', value: parameter.name, 'data-key': `param-name-${parameter.id}`, title: t('Name'),
            onChange: (e: Event) => { parameter.name = (e.target as HTMLInputElement).value.trim(); commit(); },
        }),
        el('span', { className: 'muted' }, typeLabel(parameter.type)),
        valueEditor(parameter.type === 'Boolean' ? 'Boolean' : parameter.type === 'Color' ? 'Color' : parameter.type === 'Vector' ? 'Vector' : 'Number',
            parameter.value, value => { parameter.value = value; commit(); }, `param-value-${parameter.id}`),
        button('✕', () => {
            system.userParameters = system.userParameters.filter(p => p !== parameter);
            // The settings bound to it take back their value of before (the default).
            for (const emitter of system.emitters) {
                for (const module of emitter.modules) {
                    for (const [name, value] of Object.entries(module.values)) {
                        if (boundParameterId(value) === parameter.id) {
                            module.values[name] = parameter.value;
                        }
                    }
                }
            }

            commit();
        }, t('Delete'), 'icon')));

    return el('section', {}, el('h2', { title: t('Values given by the code of the mod when the system plays: Sparkle.play(level, "{0}", x, y, z, SparkleParameters.create().number("speed", 2)).', systemKey) },
        t('User parameters')), ...rows, add);
}

function problemsPanel(system: SparkleFile): HTMLElement {
    const problems = validate(system);
    return el('section', {}, el('h2', {}, t('Problems')),
        problems.length === 0
            ? el('div', { className: 'muted' }, t('No problem.'))
            : el('ul', { className: 'problems' }, ...problems.map(p => el('li', {
                className: p.severity,
                onClick: () => { if (p.emitter) { selected = p.emitter; render(); } },
            }, t(p.message, ...p.args.map((a, i) => p.translatedArgs?.includes(i) ? t(a) : a))))));
}

function inspector(system: SparkleFile): HTMLElement {
    const emitter = system.emitters.find(e => e.id === selected);
    if (!emitter) {
        return el('div', { className: 'muted' }, t('No emitter selected.'));
    }

    const head = el('div', { className: 'head' },
        el('input', {
            className: 'emitter-name', value: emitter.name, 'data-key': `emitter-name-${emitter.id}`, title: t('Name'),
            onChange: (e: Event) => { emitter.name = (e.target as HTMLInputElement).value; commit(); },
        }),
        !emitter.preview && el('div', { className: 'muted' }, t('The emitter is not in the preview.')));

    const sections = SECTIONS.map(section => {
        const modules = MODULES.filter(m => m.section === section.kind);
        return el('div', { className: 'section' }, el('h3', {}, t(section.title)), ...modules.map(info => moduleCard(system, emitter, info)));
    });

    // Modules of a newer format: kept in the file, not editable here.
    const unknown = emitter.modules.filter(m => !isModuleKind(m.kind)).map(m => el('div', { className: 'muted' }, m.kind));
    return el('div', {}, head, ...sections, ...unknown);
}

function moduleCard(system: SparkleFile, emitter: Emitter, info: ModuleInfo): HTMLElement {
    const module = getModule(emitter, info.kind);
    const key = `${emitter.id}/${info.kind}`;
    const open = !collapsed.has(info.kind);
    const enabled = !info.optional || module.enabled;
    const title = el('div', {
        className: 'module-title',
        onClick: () => {
            if (collapsed.has(info.kind)) {
                collapsed.delete(info.kind);
            } else {
                collapsed.add(info.kind);
            }

            vscode.setState({ collapsed: [...collapsed] });
            render();
        },
    },
    el('span', { className: 'chevron' }, open ? '▾' : '▸'),
    info.optional && el('input', {
        type: 'checkbox', checked: module.enabled, 'data-key': `${key}/enabled`,
        onClick: (e: Event) => e.stopPropagation(),
        onChange: (e: Event) => { ensureModule(emitter, info.kind).enabled = (e.target as HTMLInputElement).checked; commit(); },
    }),
    el('span', { title: t(info.description) }, t(info.title)));

    const body = open && enabled ? el('div', { className: 'module-body' },
        el('div', { className: 'description' }, t(info.description)),
        ...info.settings
            .filter(setting => !setting.visibleWhen || setting.visibleWhen.values.includes(rawValue(module, setting.visibleWhen.name)))
            .map(setting => settingRow(system, emitter, info.kind, setting))) : undefined;

    return el('div', { className: `module${enabled ? '' : ' off'}` }, title, body);
}

function settingRow(system: SparkleFile, emitter: Emitter, kind: ModuleKind, setting: SettingInfo): HTMLElement {
    const module = getModule(emitter, kind);
    const raw = rawValue(module, setting.name);
    const key = `${emitter.id}/${kind}/${setting.name}`;
    const set = (value: string) => { ensureModule(emitter, kind).values[setting.name] = value; commit(); };
    const bound = boundParameterId(raw);
    const parameter = bound !== undefined ? system.userParameters.find(p => p.id === bound) : undefined;
    const compatible = system.userParameters.filter(p => accepts(p.type, setting.type));

    let editor: HTMLElement;
    if (parameter) {
        editor = el('span', { className: 'bound' }, `← ${parameter.name}`);
    } else if (setting.type === 'Choice') {
        editor = el('select', { 'data-key': key, onChange: (e: Event) => set((e.target as HTMLSelectElement).value) },
            ...(setting.choices ?? []).map(c => el('option', { value: c.value, selected: c.value === raw }, t(c.label))));
    } else if (setting.type === 'TextureList') {
        editor = textureEditor(raw, set, key);
    } else if (setting.type === 'EmitterId') {
        const others = system.emitters.filter(e => e !== emitter);
        editor = el('select', { 'data-key': key, onChange: (e: Event) => set((e.target as HTMLSelectElement).value) },
            ...(others.some(e => String(eventId(e)) === raw) ? [] : [el('option', { value: raw, selected: true }, raw)]),
            ...others.map(e => el('option', { value: String(eventId(e)), selected: String(eventId(e)) === raw }, `${eventId(e)} - ${e.name}`)));
    } else {
        editor = valueEditor(setting.type, raw, set, key, setting);
    }

    const link = compatible.length > 0 || parameter ? el('select', {
        className: 'link', title: parameter ? t('Bound to the user parameter "{0}"', parameter.name) : t('Bind to a user parameter'),
        onChange: (e: Event) => {
            const id = (e.target as HTMLSelectElement).value;
            const chosen = system.userParameters.find(p => p.id === id);
            set(chosen ? binding(chosen) : parameter?.value ?? setting.defaultValue);
        },
    }, el('option', { value: '' }, t('Not bound')), ...compatible.map(p => el('option', { value: p.id, selected: p.id === bound }, p.name))) : undefined;

    return el('div', { className: 'setting' },
        el('label', { title: setting.hint ? t(setting.hint) : undefined }, t(setting.label)),
        el('div', { className: 'value' }, editor, link));
}

/** An editor of a value: number, vector, color or yes / no. */
function valueEditor(type: string, raw: string, set: (value: string) => void, key: string, setting?: SettingInfo): HTMLElement {
    switch (type) {
        case 'Boolean':
            return el('input', { type: 'checkbox', checked: raw.toLowerCase() === 'true', 'data-key': key, onChange: (e: Event) => set((e.target as HTMLInputElement).checked ? 'true' : 'false') });
        case 'Color':
            return el('input', { type: 'color', value: formatColor(parseColor(raw) ?? 0xFFFFFF).toLowerCase(), 'data-key': key, onChange: (e: Event) => set((e.target as HTMLInputElement).value.toUpperCase()) });
        case 'Vector': {
            const vector = parseVector(raw) ?? parseVector(setting?.defaultValue) ?? { x: 0, y: 0, z: 0 };
            const parts = (['x', 'y', 'z'] as const).map(axis => el('input', {
                type: 'number', step: 'any', value: String(vector[axis]), 'data-key': `${key}/${axis}`, title: axis,
                onChange: () => {
                    const values = parts.map(p => Number(p.value));
                    if (values.every(Number.isFinite)) {
                        set(values.join(' '));
                    }
                },
            }));
            return el('div', { className: 'vector' }, ...parts);
        }
        default:
            return el('input', {
                type: 'number', step: type === 'Integer' ? '1' : 'any', min: setting?.min, max: setting?.max, value: raw, 'data-key': key,
                onChange: (e: Event) => {
                    const value = Number((e.target as HTMLInputElement).value);
                    if (Number.isFinite(value)) {
                        const clamped = Math.min(setting?.max ?? Infinity, Math.max(setting?.min ?? -Infinity, value));
                        set(String(type === 'Integer' ? Math.round(clamped) : clamped));
                    }
                },
            });
    }
}

function textureEditor(raw: string, set: (value: string) => void, key: string): HTMLElement {
    const list = splitTextures(raw);
    const rows = list.map((name, index) => {
        const entry = textures.find(e => e.name === name);
        return el('div', { className: 'texture' },
            entry ? el('img', { src: entry.uri, alt: '' }) : el('span', { className: 'dot', title: t('Texture of the game (not in the project): shown as a dot.') }),
            el('input', {
                value: name, 'data-key': `${key}/${index}`,
                onChange: (e: Event) => { list[index] = (e.target as HTMLInputElement).value.trim(); set(joinTextures(list)); },
            }),
            list.length > 1 && button('✕', () => { list.splice(index, 1); set(joinTextures(list)); }, t('Remove'), 'icon'));
    });
    const pick = button(`+ ${t('Add')}`, () => {
        const request = ++pickRequest;
        pickHandlers.set(request, name => {
            if (name) {
                set(joinTextures([...list, name]));
            }
        });
        post({ type: 'pickTexture', request });
    }, t('Pick a texture of the project'));
    return el('div', { className: 'textures' }, ...rows, pick);
}

post({ type: 'ready' });
