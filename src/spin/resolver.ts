// The `spin` remote authority: VS Code asks it for `spin+<workspace>`, and it answers with a
// local port carried to the workspace's server (open.ts). What refuses is shown in VS Code with
// the one thing to do, never left in a log.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type Log from '../logger';
import { parseSpinAuthority, SPIN_AUTHORITY } from './authority';
import { SpinCli } from './cli';
import { openWorkspace, type OpenedWorkspace } from './open';
import { type Refusal, SpinRefusal } from './refusal';

/** The Spinbox extension, which carries the spin CLI of its release. */
const SPINBOX_EXTENSION = 'spin-stack.spinbox';

/**
 * The spin CLI to run: remote.spin.cliPath when set; else the one the Spinbox extension carries
 * (bin/<platform>-<arch>/spin, vscode-spinbox's src/cli/binary.ts); else spin on the PATH.
 */
export function spinBinary(setting: string, spinboxPath: string | undefined, platform: string, arch: string): string {
    if (setting) {
        return setting;
    }
    if (spinboxPath) {
        const carried = path.join(spinboxPath, 'bin', `${platform}-${arch}`, 'spin');
        if (fs.existsSync(carried)) {
            return carried;
        }
    }
    return 'spin';
}

/** This editor's commit, whose server the workspace runs. A build from source has none. */
function editorCommit(): string {
    const commit = vscode.env.appCommit;
    if (!commit) {
        throw new Error('this VS Code names no commit: Spinbox opens workspaces in a released VS Code');
    }
    return commit;
}

export class SpinboxResolver implements vscode.RemoteAuthorityResolver, vscode.Disposable {
    private opened: OpenedWorkspace | undefined;

    constructor(private readonly logger: Log) { }

    async resolve(authority: string, context: vscode.RemoteAuthorityResolverContext): Promise<vscode.ResolvedAuthority> {
        const { workspace, host } = parseSpinAuthority(authority);
        this.logger.info(`Resolving Spinbox workspace '${workspace}' (attempt #${context.resolveAttempt})`);
        await this.close();
        const commit = editorCommit();
        const cli = new SpinCli(spinBinary(
            vscode.workspace.getConfiguration('remote.spin').get<string>('cliPath', ''),
            vscode.extensions.getExtension(SPINBOX_EXTENSION)?.extensionPath,
            process.platform === 'win32' ? 'win32' : process.platform,
            process.arch,
        ));

        try {
            const opened = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Opening Spinbox workspace ${workspace}`,
            }, () => openWorkspace({
                cli, workspace, host, commit, version: vscode.version, start: true,
                home: os.homedir(), pid: process.pid, log: line => this.logger.trace(line),
            }));
            this.opened = opened;
            const localPort = await opened.connection.forwardLocal(opened.port);
            this.logger.info(`Spinbox workspace '${workspace}' (${opened.workspaceId}) open on 127.0.0.1:${localPort}`);
            return new vscode.ResolvedAuthority('127.0.0.1', localPort, opened.connectionToken);
        } catch (e) {
            await this.close();
            if (e instanceof SpinRefusal) {
                this.logger.error(`Spinbox refused '${workspace}': ${e.refusal.code}`, e.message);
                // VS Code tries a temporary one again by itself: said once, on the first try.
                if (!e.refusal.temporary || context.resolveAttempt === 1) {
                    void showRefusal(workspace, e.refusal);
                }
                throw e.refusal.temporary
                    ? vscode.RemoteAuthorityResolverError.TemporarilyNotAvailable(e.message)
                    : vscode.RemoteAuthorityResolverError.NotAvailable(e.message, true);
            }
            this.logger.error(`Opening Spinbox workspace '${workspace}' failed`, e);
            throw vscode.RemoteAuthorityResolverError.TemporarilyNotAvailable(e instanceof Error ? e.message : String(e));
        }
    }

    /** Ends the last resolve's connection, its tunnel with it, so a reconnect holds one. */
    private async close() {
        const opened = this.opened;
        this.opened = undefined;
        await opened?.connection.close().catch(() => undefined);
    }

    dispose() {
        void this.close();
    }
}

export { SPIN_AUTHORITY };

/** Shows refusal where the person is looking, with its action as the one button. */
async function showRefusal(workspace: string, refusal: Refusal): Promise<void> {
    const action = refusal.action;
    const pick = await vscode.window.showErrorMessage(
        `Spinbox could not open ${workspace}: ${refusal.message}`,
        { modal: true },
        ...(action ? [action.title] : []),
    );
    if (!action || pick !== action.title) {
        return;
    }
    if (action.url) {
        await vscode.env.openExternal(vscode.Uri.parse(action.url));
    } else if (action.command) {
        const terminal = vscode.window.createTerminal({ name: 'Spinbox' });
        terminal.show();
        terminal.sendText(action.command, false);
    }
}
