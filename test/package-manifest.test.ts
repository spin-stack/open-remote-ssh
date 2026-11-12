import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { KILL_WORKSPACE_SESSIONS_COMMAND_ID } from '../src/commands';
import { TMUX_PROFILE_ID, TMUX_PROFILE_TITLE } from '../src/extension';

// Drift guard: package.json's `contributes` is hand-authored and easy to let go
// stale (settings renamed/typo'd, a command's id changed in one place but not the
// other). These tests read the manifest itself — no fixture copy — so a future
// edit to package.json or src/*.ts registrations trips a real assertion instead of
// silently drifting apart.

const repoRoot = path.resolve(__dirname, '..');
const packageJsonPath = path.resolve(repoRoot, 'package.json');
const srcDir = path.resolve(repoRoot, 'src');

interface JsonObject {
    [key: string]: unknown;
}

function readPackageJson(): JsonObject {
    const raw = fs.readFileSync(packageJsonPath, 'utf8');
    return JSON.parse(raw) as JsonObject;
}

/** Recursively collect every `.ts` file under `dir` (source only, no `.d.ts`). */
function collectTsFiles(dir: string): string[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...collectTsFiles(entryPath));
        } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
            files.push(entryPath);
        }
    }
    return files;
}

/** Recursively collect every `.md` file under `dir`. */
function collectAllMarkdownFiles(dir: string): string[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...collectAllMarkdownFiles(entryPath));
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
            files.push(entryPath);
        }
    }
    return files;
}

/** The user-facing documentation: README.md and everything under docs/. */
function documentation(): string[] {
    return [path.resolve(repoRoot, 'README.md'), ...collectAllMarkdownFiles(path.resolve(repoRoot, 'docs'))];
}

/**
 * Every `export const NAME = '<string literal>'` in `src/`, so a `registerCommand(NAME)`
 * call (an identifier, not an inline literal) can be resolved back to the id it registers.
 */
function exportedStringConstants(): Map<string, string> {
    const constants = new Map<string, string>();
    const exportedConst = /export const (\w+)\s*=\s*(['"])([^'"]+)\2/g;
    for (const file of collectTsFiles(srcDir)) {
        const contents = fs.readFileSync(file, 'utf8');
        for (const match of contents.matchAll(exportedConst)) {
            constants.set(match[1], match[3]);
        }
    }
    return constants;
}

/**
 * Every command id passed as the first argument to a `registerCommand(` call across
 * `src/` — whether an inline string literal or an identifier referencing an exported
 * `const` (resolved via {@link exportedStringConstants}).
 */
function registeredCommandIds(): Set<string> {
    const ids = new Set<string>();
    const constants = exportedStringConstants();
    const registerCommandCall = /registerCommand\(\s*(?:(['"])([^'"]+)\1|([A-Za-z_$][\w$]*))/g;
    for (const file of collectTsFiles(srcDir)) {
        const contents = fs.readFileSync(file, 'utf8');
        for (const match of contents.matchAll(registerCommandCall)) {
            const [, , literal, identifier] = match;
            if (literal !== undefined) {
                ids.add(literal);
            } else if (identifier !== undefined && constants.has(identifier)) {
                ids.add(constants.get(identifier)!);
            }
        }
    }
    return ids;
}

/** Concatenation of every `src/*.ts` file's contents, for simple substring/regex drift
 * guards that don't care which file a match lives in. */
function allSrcContents(): string {
    return collectTsFiles(srcDir).map(file => fs.readFileSync(file, 'utf8')).join('\n');
}

describe('package.json manifest drift guard', () => {
    const pkg = readPackageJson();
    const contributes = pkg.contributes as JsonObject;
    const configuration = contributes.configuration as JsonObject;
    const properties = configuration.properties as Record<string, JsonObject>;
    const commands = contributes.commands as Array<{ command: string }>;

    describe('tmux settings', () => {
        it('declares remote.SSH.tmux.enabled with the documented default', () => {
            const enabled = properties['remote.SSH.tmux.enabled'];
            expect(enabled).toBeDefined();
            expect(enabled.type).toBe('string');
            expect(enabled.default).toBe('auto');
            expect(enabled.enum).toEqual(['auto', 'off', 'on']);
        });

        it('declares remote.SSH.tmux.historyLimit with the documented default', () => {
            const historyLimit = properties['remote.SSH.tmux.historyLimit'];
            expect(historyLimit).toBeDefined();
            expect(historyLimit.type).toBe('number');
            expect(historyLimit.default).toBe(50000);
        });

        it('declares remote.SSH.tmux.reapOnConnect with the documented default', () => {
            const reapOnConnect = properties['remote.SSH.tmux.reapOnConnect'];
            expect(reapOnConnect).toBeDefined();
            expect(reapOnConnect.type).toBe('boolean');
            expect(reapOnConnect.default).toBe(true);
        });

        it('every remote.SSH.tmux.* setting the documentation mentions exists in package.json', () => {
            const mentionedSettingsInDocs = new Set<string>();
            const tmuxSettingRegex = /remote\.SSH\.tmux\.\w+/g;

            for (const file of documentation()) {
                const contents = fs.readFileSync(file, 'utf8');
                for (const match of contents.matchAll(tmuxSettingRegex)) {
                    mentionedSettingsInDocs.add(match[0]);
                }
            }

            const missingSettings = [...mentionedSettingsInDocs].filter(setting => !properties[setting]);

            expect(
                missingSettings,
                `These remote.SSH.tmux.* settings are mentioned in the documentation but missing from package.json configuration: ${missingSettings.join(', ')}`
            ).toEqual([]);
        });

        // The reverse: a setting shipped in package.json that nobody documented.
        it('every remote.SSH.tmux.* setting in package.json is mentioned in the documentation', () => {
            const docsContents = documentation().map(file => fs.readFileSync(file, 'utf8')).join('\n');

            const tmuxSettingKeys = Object.keys(properties).filter(key => key.startsWith('remote.SSH.tmux.'));
            expect(tmuxSettingKeys.length).toBeGreaterThan(0);

            const undocumented = tmuxSettingKeys.filter(key => !docsContents.includes(key));

            expect(
                undocumented,
                `These remote.SSH.tmux.* settings exist in package.json but are never mentioned in the documentation: ${undocumented.join(', ')}`
            ).toEqual([]);
        });

        // Would have caught the two dead tmux settings shipped in 1.0.0: declared in
        // package.json but never read by any `config.get(...)` call in src/, so changing
        // them from the Settings UI silently did nothing.
        it('every remote.SSH.tmux.* setting in package.json is read by a config.get(...) call in src/', () => {
            const tmuxSettingKeys = Object.keys(properties).filter(key => key.startsWith('remote.SSH.tmux.'));
            expect(tmuxSettingKeys.length).toBeGreaterThan(0);

            const srcContents = allSrcContents();
            const unread = tmuxSettingKeys.filter(key => {
                // `getConfiguration('remote.SSH')` sections off the `remote.SSH.` prefix, so
                // the read call only needs to reference the `tmux.*` suffix (e.g. `tmux.enabled`).
                const suffix = key.replace(/^remote\.SSH\./, '');
                const readCall = new RegExp(`\\.get(?:<[^>]*>)?\\(\\s*['"]${suffix.replace(/\./g, '\\.')}['"]`);
                return !readCall.test(srcContents);
            });

            expect(
                unread,
                `These remote.SSH.tmux.* settings are declared in package.json but never read via config.get(...) in src/: ${unread.join(', ')}`
            ).toEqual([]);
        });

        // Would have caught a declared enum value (e.g. a new `'on'`/`'off'`/`'auto'` state)
        // that the handling code in extension.ts never actually branches on.
        it('every declared remote.SSH.tmux.enabled enum value is handled in src/extension.ts', () => {
            const enabled = properties['remote.SSH.tmux.enabled'];
            const enumValues = enabled.enum as string[];
            expect(enumValues.length).toBeGreaterThan(0);

            const extensionSrc = fs.readFileSync(path.resolve(srcDir, 'extension.ts'), 'utf8');
            const unhandled = enumValues.filter(value => !extensionSrc.includes(`'${value}'`));

            expect(
                unhandled,
                `These remote.SSH.tmux.enabled enum values are declared but never referenced in src/extension.ts: ${unhandled.join(', ')}`
            ).toEqual([]);
        });
    });

    describe('activation events', () => {
        it('includes onTerminalProfile:tmux to activate when the tmux profile is requested', () => {
            const activationEvents = pkg.activationEvents as string[] | undefined;
            expect(activationEvents, 'activationEvents is missing').toBeDefined();
            expect(activationEvents!.some(e => e === 'onTerminalProfile:tmux')).toBe(true);
        });

        // `engines.vscode` (^1.70.2) predates VS Code's implicit-activation-events cutoff
        // (~1.74), so every command that can actually be invoked before the extension is
        // otherwise activated needs its own `onCommand:<id>` entry. Commands hidden from
        // the palette via a `"when": "false"` `menus.commandPalette` entry are view-only
        // (context menu/inline icon) — they can't be reached until the view is visible,
        // which already activates the extension via `onView:sshHosts`, so they're exempt.
        it('every palette-invokable command has a matching onCommand activation event', () => {
            const activationEvents = pkg.activationEvents as string[] | undefined;
            expect(activationEvents, 'activationEvents is missing').toBeDefined();

            const menus = contributes.menus as JsonObject | undefined;
            const commandPaletteEntries = (menus?.commandPalette ?? []) as Array<{ command: string; when?: string }>;
            const paletteExempt = new Set(
                commandPaletteEntries.filter(e => e.when === 'false').map(e => e.command)
            );

            const missing = commands
                .map(c => c.command)
                .filter(id => !paletteExempt.has(id))
                .filter(id => !activationEvents!.includes(`onCommand:${id}`));

            expect(
                missing,
                `These palette-invokable commands have no matching onCommand:<id> activation event: ${missing.join(', ')}`
            ).toEqual([]);
        });
    });

    describe('tmux terminal profile', () => {
        // contributes.terminal.profiles had been mis-authored as a top-level
        // `"terminal.profiles"` key — an unrecognized contribution point VS Code silently
        // ignores, so `registerTerminalProfileProvider('tmux', ...)` never had a matching
        // profile and "New Terminal" launched a plain shell.
        it('contributes a real contributes.terminal.profiles entry (not a stray top-level key)', () => {
            expect(contributes['terminal.profiles'], 'contributes["terminal.profiles"] is not a real VS Code extension point — it is silently ignored').toBeUndefined();

            const terminal = contributes.terminal as JsonObject | undefined;
            expect(terminal, 'contributes.terminal is missing').toBeDefined();
            const profiles = terminal!.profiles as Array<{ id: string; title: string }> | undefined;
            expect(profiles, 'contributes.terminal.profiles is missing').toBeDefined();
            expect(profiles!.some(p => p.id === 'tmux')).toBe(true);
        });

        it('the contributed profile id matches TMUX_PROFILE_ID in src/extension.ts', () => {
            const terminal = contributes.terminal as JsonObject;
            const profiles = terminal.profiles as Array<{ id: string; title: string }>;
            expect(profiles.some(p => p.id === TMUX_PROFILE_ID)).toBe(true);
        });

        // Two direct registerTerminalProfileProvider calls on the same contributed id is
        // how v1.0.0 shipped — VS Code throws "already registered" on the second, the tmux
        // layer never wired, and "Persistent Shell" silently opened a plain bash terminal.
        it('registers the profile id in exactly one place (the registration owner)', () => {
            // Comments are stripped first: the guard is about calls in *code*, and the
            // modules explaining this very regression name the API in their prose.
            const stripComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
            const callers = fs.readdirSync(srcDir, { recursive: true, encoding: 'utf8' })
                .filter(file => file.endsWith('.ts'))
                .filter(file => /registerTerminalProfileProvider\s*\(/.test(stripComments(fs.readFileSync(path.resolve(srcDir, file), 'utf8'))));
            expect(callers, 'registerTerminalProfileProvider must be called only by tmux/profileRegistration.ts')
                .toEqual(['tmux/profileRegistration.ts']);
        });

        // The default-profile reconcile (extension.ts) selects/clears the tmux profile by
        // its *title* (`terminal.integrated.defaultProfile.linux` is a title, not an id).
        it('the contributed profile title matches TMUX_PROFILE_TITLE in src/extension.ts', () => {
            const terminal = contributes.terminal as JsonObject;
            const profiles = terminal.profiles as Array<{ id: string; title: string }>;
            const tmuxProfile = profiles.find(p => p.id === 'tmux');
            expect(tmuxProfile, 'no contributed profile with id "tmux"').toBeDefined();
            expect(tmuxProfile!.title).toBe(TMUX_PROFILE_TITLE);
        });
    });

    it('the kill command\'s manifest id matches the constant exported by commands.ts', () => {
        const killCommand = commands.find(c => c.command === KILL_WORKSPACE_SESSIONS_COMMAND_ID);
        expect(killCommand, `expected contributes.commands to contain "${KILL_WORKSPACE_SESSIONS_COMMAND_ID}"`).toBeDefined();
    });

    it('every contributes.commands id is backed by a real registerCommand(...) call in src/', () => {
        const registered = registeredCommandIds();
        const missing = commands
            .map(c => c.command)
            .filter(id => !registered.has(id));

        expect(missing, `command ids with no matching registerCommand(...) in src/: ${missing.join(', ')}`).toEqual([]);
    });
});
