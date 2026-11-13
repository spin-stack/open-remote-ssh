// The spin CLI, the resolver's only client of a Spinbox installation: `spin code` to have the
// workspace running with the server for this editor's commit, `spin ssh-session` to open a
// session into it, and `spin tunnel` to carry the connection, as ssh's ProxyCommand. The CLI
// keeps the credentials; this extension holds none.

import { spawn } from 'child_process';
import { type Answer, type CodeResult, readCodeAnswer, readSessionAnswer, type SessionResult } from './contract';
import { escapeShellArg } from './serverStart';

export interface CodeOptions {
    workspace: string;
    /** The editor's commit, whose server the workspace is to carry. */
    commit: string;
    version?: string;
    /** Start the workspace when it is stopped. */
    start: boolean;
}

interface Ran {
    stdout: string;
    stderr: string;
    exitCode: number | null;
}

export class SpinCli {
    constructor(
        private readonly binary: string,
        /** The CLI's environment, and the ssh's that runs it as ProxyCommand. */
        readonly env: NodeJS.ProcessEnv = process.env,
    ) { }

    private run(args: string[], timeoutMs: number): Promise<Ran> {
        return new Promise((resolve, reject) => {
            const child = spawn(this.binary, args, { env: this.env, stdio: ['ignore', 'pipe', 'pipe'] });
            let stdout = '';
            let stderr = '';
            const timer = setTimeout(() => {
                child.kill();
                reject(new Error(`spin ${args[0]} did not answer in ${timeoutMs / 1000} s`));
            }, timeoutMs);
            child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
            child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
            child.on('error', e => {
                clearTimeout(timer);
                reject(new Error(`running ${this.binary}: ${e.message}`));
            });
            child.on('close', exitCode => {
                clearTimeout(timer);
                resolve({ stdout, stderr, exitCode });
            });
        });
    }

    /**
     * The workspace, running, with the server for commit attached when the installation
     * publishes it. Publishing one takes minutes the first time (`spin code` waits up to six).
     */
    async code(o: CodeOptions): Promise<Answer<CodeResult>> {
        const args = ['code', o.workspace, '--no-open', '--vscode-commit', o.commit, '-o', 'json'];
        if (o.version) {
            args.push('--vscode-version', o.version);
        }
        if (o.start) {
            args.push('--start');
        }
        const ran = await this.run(args, 10 * 60_000);
        return readCodeAnswer(ran.stdout, ran.stderr, ran.exitCode);
    }

    /**
     * A session into the workspace's sshd, after the CLI held the guest's key to its launch's
     * claim: the session to carry, the certificate, that key, and the identity the CLI chose.
     */
    async session(workspace: string): Promise<Answer<SessionResult>> {
        // The CLI bounds asking a host for a session at 45 s, and waits for a start under way.
        const ran = await this.run(['ssh-session', workspace, '-o', 'json'], 3 * 60_000);
        return readSessionAnswer(ran.stdout, ran.stderr, ran.exitCode);
    }

    /**
     * ssh's ProxyCommand that carries the session ssh-session opened: `spin tunnel <session>`, as
     * the shell ssh runs it through reads it back.
     */
    tunnelCommand(session: string): string {
        return `${escapeShellArg(this.binary)} tunnel ${escapeShellArg(session)}`;
    }
}
