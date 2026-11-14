import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { SHOW_LOG_COMMAND } from '../src/extension';
import { SPIN_AUTHORITY } from '../src/spin/authority';

// package.json is written by hand, and what it names VS Code holds the code to: an authority
// with no activation event never resolves, a command it contributes and the code does not
// register fails when picked, and a setting nothing reads is a promise nothing keeps.

const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8')) as {
    activationEvents: string[];
    enabledApiProposals: string[];
    contributes: {
        configuration: { properties: Record<string, { scope?: string }> };
        commands: { command: string }[];
        resourceLabelFormatters: { authority: string }[];
    };
};

function sources(dir = path.resolve(__dirname, '..', 'src')): string {
    return fs.readdirSync(dir, { withFileTypes: true }).map(e => {
        const p = path.join(dir, e.name);
        return e.isDirectory() ? sources(p) : e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') ? fs.readFileSync(p, 'utf8') : '';
    }).join('\n');
}

describe('package.json', () => {
    it('activates for the authority the resolver registers, and labels its folders', () => {
        expect(pkg.activationEvents).toContain(`onResolveRemoteAuthority:${SPIN_AUTHORITY}`);
        expect(pkg.contributes.resourceLabelFormatters.map(f => f.authority)).toEqual([`${SPIN_AUTHORITY}+*`]);
        expect(pkg.enabledApiProposals).toEqual(['resolvers']);
    });

    // VS Code activates an extension for a command it contributes by itself: an onCommand event
    // beside it would be a second list to keep in step with the first.
    it('contributes the commands the extension registers', () => {
        expect(pkg.contributes.commands.map(c => c.command)).toEqual([SHOW_LOG_COMMAND]);
        expect(pkg.activationEvents).toEqual([`onResolveRemoteAuthority:${SPIN_AUTHORITY}`]);
    });

    it('declares the settings the code reads, and no other', () => {
        const src = sources();
        const read = [...src.matchAll(/getConfiguration\('([\w.]+)'\)\.get<\w+>\('([\w.]+)'/g)].map(m => `${m[1]}.${m[2]}`);
        expect(Object.keys(pkg.contributes.configuration.properties).sort()).toEqual([...new Set(read)].sort());
    });

    // Every setting is of the machine the resolver runs on, which is the window's own and never
    // the workspace's: application scope is read from the person's settings in every window. A
    // machine one is not, once the window is remote: VS Code reconnecting a dropped window read
    // remote.spin.cliPath as empty and ran another spin (test:spin-remote in vscode-spinbox).
    it('scopes every setting to the application', () => {
        for (const [name, setting] of Object.entries(pkg.contributes.configuration.properties)) {
            expect(setting.scope, name).toBe('application');
        }
    });
});
