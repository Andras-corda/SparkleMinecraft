// The system templates of the VS Code extension, in English and in French, for "New particle system" of IntelliJ.
import { readFileSync } from 'node:fs';
import { serializeSystem } from '../../vscode/src/shared/model';
import { createSystem, SYSTEM_TEMPLATES } from '../../vscode/src/shared/templates';

export interface ExportedTemplate {
    readonly template: string;
    readonly title: string;
    readonly description: string;
    /** Name proposed for the new system. */
    readonly name: string;
    /** The text of the new file, by language ("en", "fr"). */
    readonly text: Record<string, string>;
}

export function exportTemplates(frenchBundle: string): ExportedTemplate[] {
    const french = JSON.parse(readFileSync(frenchBundle, 'utf8')) as Record<string, string>;
    const languages: Record<string, (text: string) => string> = {
        en: text => text,
        fr: text => french[text] ?? text,
    };

    return SYSTEM_TEMPLATES.map(info => {
        const text: Record<string, string> = {};
        for (const [language, t] of Object.entries(languages)) {
            const emitterName = t(info.template === 'Sparks' ? 'Sparks' : info.title);
            const trail = (head: string) => t('{0} trail').replace('{0}', head);
            text[language] = serializeSystem(createSystem(info.template, emitterName, trail));
        }

        return {
            template: info.template,
            title: info.title,
            description: info.description,
            name: info.template === 'Empty' || info.template === 'Sparks' ? 'sparks' : info.template.toLowerCase(),
            text,
        };
    });
}
