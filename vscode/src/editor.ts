import * as vscode from 'vscode';
import { catalogTexts } from './shared/catalog';
import { TextureEntry, ToExtension, ToWebview, WEBVIEW_TEXTS } from './shared/messages';
import { EMITTER_TEMPLATES } from './shared/templates';
import { systemKey } from './paths';

/**
 * The editor of the Sparkle systems: a webview over the JSON document. Every change goes through a WorkspaceEdit, so
 * undo, redo, save and the text editor work as for any file.
 */
export class SparkleEditorProvider implements vscode.CustomTextEditorProvider {
    static readonly viewType = 'sparkle.systemEditor';

    constructor(private readonly context: vscode.ExtensionContext) {
    }

    static register(context: vscode.ExtensionContext): vscode.Disposable {
        return vscode.window.registerCustomEditorProvider(SparkleEditorProvider.viewType, new SparkleEditorProvider(context), {
            webviewOptions: { retainContextWhenHidden: true },
        });
    }

    async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
        const webview = panel.webview;
        const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri);
        webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist'), vscode.Uri.joinPath(this.context.extensionUri, 'media'), ...folders],
        };
        webview.html = this.html(webview);

        /** The last text sent by the webview: its own change coming back is not sent to it again. */
        let fromWebview: string | undefined;
        const post = (message: ToWebview) => void webview.postMessage(message);
        const sendTextures = async () => post({ type: 'textures', textures: await findTextures(webview) });

        const subscriptions: vscode.Disposable[] = [];
        subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document.uri.toString() !== document.uri.toString() || event.contentChanges.length === 0) {
                return;
            }

            const text = document.getText();
            if (text !== fromWebview) {
                post({ type: 'update', text });
            }
        }));

        const watcher = vscode.workspace.createFileSystemWatcher('**/assets/*/textures/particle/**/*.png');
        subscriptions.push(watcher, watcher.onDidCreate(sendTextures), watcher.onDidDelete(sendTextures));

        subscriptions.push(webview.onDidReceiveMessage(async (message: ToExtension) => {
            switch (message.type) {
                case 'ready':
                    post({ type: 'init', text: document.getText(), strings: strings(), textures: await findTextures(webview), systemKey: systemKey(document.uri) ?? '' });
                    break;
                case 'edit':
                    if (message.text !== document.getText()) {
                        fromWebview = message.text;
                        const edit = new vscode.WorkspaceEdit();
                        edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), message.text);
                        await vscode.workspace.applyEdit(edit);
                    }

                    break;
                case 'pickTexture':
                    post({ type: 'texturePicked', request: message.request, name: await pickTexture() });
                    break;
                case 'openText':
                    await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
                    break;
                case 'copyPlayCode':
                    await vscode.commands.executeCommand('sparkle.copyPlayCode', document.uri);
                    break;
                case 'installRuntime':
                    await vscode.commands.executeCommand('sparkle.installRuntime', document.uri);
                    break;
            }
        }));

        panel.onDidDispose(() => subscriptions.forEach(s => s.dispose()));
    }

    private html(webview: vscode.Webview): string {
        const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'));
        const style = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'editor.css'));
        const nonce = makeNonce();
        return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Sparkle</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
    }
}

/** The texts of the webview in the language of VS Code. */
function strings(): Record<string, string> {
    const result: Record<string, string> = {};
    const texts = [...catalogTexts(), ...WEBVIEW_TEXTS, ...EMITTER_TEMPLATES.flatMap(t => [t.title, t.description]), ...PROBLEM_TEXTS];
    for (const text of texts) {
        // The texts with {0} are translated as they are; the webview puts the values in.
        result[text] = vscode.l10n.t(text, ...placeholders(text));
    }

    return result;
}

/** "{0}", "{1}"... given back as they are, so that the translation keeps them for the webview. */
function placeholders(text: string): string[] {
    const count = (text.match(/\{\d+\}/g) ?? []).length;
    return Array.from({ length: count }, (_, i) => `{${i}}`);
}

/** Texts of the problems found by the validation (model.ts). */
const PROBLEM_TEXTS = [
    'The system has no emitter: it shows nothing.',
    'Several emitters have the ID {0}: {1}.',
    'A user parameter has no name: the code cannot give it a value.',
    'Several user parameters are named "{0}".',
    'The emitter "{0}" receives the events of the ID {1}, but no other emitter has this ID.',
    'The emitter "{0}" receives events that the emitter of the ID {1} does not send: switch on its module "{2}".',
    'The emitter "{0}" sends collision events but has no Collision module: its particles never hit anything.',
    'The emitter "{0}" uses a user parameter that no longer exists (module {1}).',
];

/** The particle textures of the open folders: "assets/<namespace>/textures/particle/<path>.png" is "<namespace>:<path>". */
export async function findTextures(webview?: vscode.Webview): Promise<TextureEntry[]> {
    const files = await vscode.workspace.findFiles('**/assets/*/textures/particle/**/*.png', '{**/build/**,**/out/**,**/run/**,**/node_modules/**,**/bin/**}', 2000);
    const byName = new Map<string, TextureEntry>();
    for (const file of files) {
        const match = /\/assets\/([^/]+)\/textures\/particle\/(.+)\.png$/.exec(file.path);
        if (match) {
            const name = `${match[1]}:${match[2]}`;
            // src/main/resources wins over a generated copy.
            if (!byName.has(name) || file.path.includes('/src/main/resources/')) {
                byName.set(name, { name, uri: webview ? webview.asWebviewUri(file).toString() : file.toString() });
            }
        }
    }

    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function pickTexture(): Promise<string | undefined> {
    const textures = await findTextures();
    const typed = vscode.l10n.t('Type a texture of the game or of another mod ("minecraft:flame")...');
    const items: vscode.QuickPickItem[] = textures.map(t => ({ label: t.name, description: vscode.workspace.asRelativePath(vscode.Uri.parse(t.uri)) }));
    items.push({ label: typed, alwaysShow: true });
    const picked = await vscode.window.showQuickPick(items, { placeHolder: vscode.l10n.t('Texture of the particles (assets/<namespace>/textures/particle/)') });
    if (!picked) {
        return undefined;
    }

    if (picked.label !== typed) {
        return picked.label;
    }

    return vscode.window.showInputBox({
        prompt: vscode.l10n.t('Name in the particle atlas: namespace:name'),
        value: 'minecraft:',
        validateInput: value => /^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(value) ? undefined : vscode.l10n.t('Lower case letters, digits, "_", "-", "." and "/": "minecraft:flame".'),
    });
}

function makeNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let nonce = '';
    for (let i = 0; i < 32; i++) {
        nonce += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    return nonce;
}
