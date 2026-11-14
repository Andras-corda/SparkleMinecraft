/** Messages between the extension and the webview of the editor. */

/** A particle texture of the project: its name in the particle atlas and the address the webview loads it from. */
export interface TextureEntry {
    readonly name: string;
    readonly uri: string;
}

export type ToWebview =
    | { readonly type: 'init'; readonly text: string; readonly strings: Record<string, string>; readonly textures: readonly TextureEntry[]; readonly systemKey: string }
    /** The document changed outside the webview (text editor, undo, git). */
    | { readonly type: 'update'; readonly text: string }
    | { readonly type: 'textures'; readonly textures: readonly TextureEntry[] }
    /** Answer to pickTexture: the texture chosen for the setting, or nothing. */
    | { readonly type: 'texturePicked'; readonly request: number; readonly name?: string };

export type ToExtension =
    | { readonly type: 'ready' }
    /** The new text of the whole document. */
    | { readonly type: 'edit'; readonly text: string }
    | { readonly type: 'pickTexture'; readonly request: number }
    | { readonly type: 'openText' }
    | { readonly type: 'copyPlayCode' }
    | { readonly type: 'installRuntime' };

/** Texts of the webview that are not in the catalog (English: the key; the extension gives their translation). */
export const WEBVIEW_TEXTS: readonly string[] = [
    'Emitters',
    'Add',
    'Add an emitter',
    'Duplicate',
    'Delete',
    'Shown in the preview',
    'Name',
    'User parameters',
    'Add a parameter',
    'Number',
    'Vector',
    'Color',
    'Yes / no',
    'Values given by the code of the mod when the system plays: Sparkle.play(level, "{0}", x, y, z, SparkleParameters.create().number("speed", 2)).',
    'No emitter selected.',
    'Problems',
    'No problem.',
    'Play',
    'Pause',
    'Restart',
    'Ground',
    'Speed',
    '{0} particles',
    '{0} s',
    'Length: {0} s',
    'Length: without end',
    'Drag to turn, wheel to zoom.',
    'Not bound',
    'Bound to the user parameter "{0}"',
    'Bind to a user parameter',
    'Pick a texture of the project',
    'Remove',
    'Texture of the game (not in the project): shown as a dot.',
    'The file cannot be read: {0}',
    'Open as text',
    'Copy the code that plays it',
    'Install the runtime',
    'Emitter',
    'The emitter is not in the preview.',
    'Copy',
    'trail',
];
