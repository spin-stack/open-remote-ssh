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
    /** Hears that this computer's key waits for the person's passkey, on the page spin opened. */
    onConfirmingKey?: (waiting: ConfirmingKey) => void;
    /** Ends the command when the person cancels the open. */
    signal?: AbortSignal;
}

/**
 * What `spin code` writes, as a line of its own, while this computer's key waits to be added to
 * the person's account with their passkey (spin's cmd/cli/cmd/ssh.go, connectingIdentity).
 */
export interface ConfirmingKey {
    url: string;
    fingerprint: string;
    name: string;
}

function confirmingKeyOf(line: string): ConfirmingKey | undefined {
    if (!line.includes('"confirming_key"')) {
        return undefined;
    }
    try {
        const c = (JSON.parse(line) as { confirming_key?: Partial<ConfirmingKey> }).confirming_key;
        return c && typeof c.url === 'string'
            ? { url: c.url, fingerprint: String(c.fingerprint ?? ''), name: String(c.name ?? 'this computer') }
            : undefined;
    } catch {
        return undefined;
    }
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
        /** The trace every command of this connection joins (trace.ts); none while telemetry is off. */
        private readonly traceparent?: string,
    ) { }

    /** The flag that has a command join the connection's trace, after its own arguments. */
    private traced(): string[] {
        return this.traceparent ? ['--traceparent', this.traceparent] : [];
    }

    /** Runs a command; onLine hears each line of its stdout as it is written. */
    private run(given: string[], timeoutMs: number, onLine?: (line: string) => void, signal?: AbortSignal): Promise<Ran> {
        const args = [...given, ...this.traced()];
        return new Promise((resolve, reject) => {
            const child = spawn(this.binary, args, { env: this.env, stdio: ['ignore', 'pipe', 'pipe'] });
            let stdout = '';
            let stderr = '';
            let heard = 0;
            const timer = setTimeout(() => {
                child.kill();
                reject(new Error(`spin ${args[0]} did not answer in ${timeoutMs / 1000} s`));
            }, timeoutMs);
            // A person who cancels the open ends the command, and its wait for them with it.
            const cancel = () => {
                child.kill();
                reject(new Error(`spin ${args[0]} was cancelled`));
            };
            if (signal?.aborted) {
                cancel();
            }
            signal?.addEventListener('abort', cancel, { once: true });
            child.stdout.on('data', (d: Buffer) => {
                stdout += d.toString();
                for (let end = stdout.indexOf('\n', heard); end >= 0; end = stdout.indexOf('\n', heard)) {
                    onLine?.(stdout.slice(heard, end));
                    heard = end + 1;
                }
            });
            child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
            child.on('error', e => {
                clearTimeout(timer);
                reject(new Error(`running ${this.binary}: ${e.message}`));
            });
            child.on('close', exitCode => {
                signal?.removeEventListener('abort', cancel);
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
        const ran = await this.run(args, 10 * 60_000, line => {
            const waiting = confirmingKeyOf(line);
            if (waiting) {
                o.onConfirmingKey?.(waiting);
            }
        }, o.signal);
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
        return [this.binary, 'tunnel', session, ...this.traced()].map(escapeShellArg).join(' ');
    }
}
