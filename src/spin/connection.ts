// The connection to a workspace's sshd: this machine's own OpenSSH, so it negotiates the one key
// exchange the workspace accepts (openssh.ts), carried by `spin tunnel` as its ProxyCommand, held
// to the host key the launch claim names, and logged in with the certificate the workspace signed.
// It began as sanketbajoria/ssh2-promise's SSHConnection, by way of jeanp413/open-remote-ssh.
//
// One login, a ControlMaster, that everything rides on: the server's start, and each connection
// VS Code makes to the server, as `ssh -W` through it. A session is carried once (`spin tunnel`),
// so a second login would be a second session, certificate and claim check. OpenSSH for Windows
// has no ControlMaster, and there is no spin CLI for Windows, so it is refused first (open.ts).

import { type ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { Duplex } from 'stream';
import type { PinnedKey } from './keys';
import { KEX_ALGORITHM } from './openssh';

export interface SSHLogin {
    user: string;
    /** What carries the connection: ssh runs it through a shell, as ProxyCommand. */
    proxyCommand: string;
    /** The private key, or the .pub of a key ssh-agent holds. */
    identity: string;
    /** The OpenSSH certificate the workspace signed over identity's public key. */
    certificate: string;
    /** The only key the workspace's sshd may answer with. */
    hostKey: PinnedKey;
    /** ssh's environment: the CLI's, which its ProxyCommand runs in. */
    env: NodeJS.ProcessEnv;
    log: (line: string) => void;
    readyTimeoutMs: number;
}

/** The name ssh is given for the workspace: its known_hosts line's. The ProxyCommand routes. */
const HOST = 'spinbox-workspace';

/**
 * Where a connection keeps its known_hosts, certificate and control socket, in a directory of its
 * own (mkdtemp: 0700, a name nobody predicts): /tmp, since a unix socket's address holds 104 bytes
 * on macOS, whose os.tmpdir() is a long path, and ssh binds a name 17 longer before renaming it.
 */
const TMP = '/tmp';

/** A value as ssh's configuration reads it: a % is one of its tokens unless doubled. */
function literal(value: string): string {
    return value.replace(/%/g, '%%');
}

export interface SSHFiles {
    knownHosts: string;
    certificate: string;
    controlPath: string;
}

/**
 * ssh's options for a connection, every run alike - the master and each client of it - so a
 * client that finds no master is the same connection, held the same way, and not another. Its
 * session is carried once, so such a client fails rather than logs in again.
 */
export function sshOptions(login: Pick<SSHLogin, 'proxyCommand' | 'identity'>, files: SSHFiles): string[] {
    return [
        // Nothing of the person's own config: a Host * there - a ProxyJump, a ControlMaster, a
        // forwarded agent - would change what this connection is.
        '-F', '/dev/null',
        '-o', `KexAlgorithms=${KEX_ALGORITHM}`,
        '-o', `ProxyCommand=${literal(login.proxyCommand)}`,
        // The host key: the one line in a known_hosts of this connection's own, and no other file.
        '-o', `HostKeyAlias=${HOST}`,
        '-o', `UserKnownHostsFile=${literal(files.knownHosts)}`,
        '-o', 'GlobalKnownHostsFile=/dev/null',
        '-o', 'StrictHostKeyChecking=yes',
        '-o', 'UpdateHostKeys=no',
        // The login: this key, as the certificate, and nothing else - no prompt, no password.
        '-i', literal(login.identity),
        '-o', `CertificateFile=${literal(files.certificate)}`,
        '-o', 'IdentitiesOnly=yes',
        '-o', 'PreferredAuthentications=publickey',
        '-o', 'BatchMode=yes',
        '-o', `ControlPath=${literal(files.controlPath)}`,
        // Not ERROR: ssh says "no matching key exchange method found" at INFO, and that is the
        // one refusal this connection exists to make clear. What it says goes to the log.
        '-o', 'LogLevel=INFO',
    ];
}

export default class SSHConnection {
    private ready: Promise<void> | undefined;
    private dir: string | undefined;
    private options: string[] = [];
    private master: ChildProcess | undefined;
    private readonly servers: net.Server[] = [];

    constructor(private readonly login: SSHLogin) { }

    private get destination(): string {
        return `${this.login.user}@${HOST}`;
    }

    connect(): Promise<void> {
        this.ready ??= this.start();
        return this.ready;
    }

    private async start(): Promise<void> {
        const dir = fs.mkdtempSync(path.join(TMP, 'spinbox-'));
        this.dir = dir;
        const files: SSHFiles = {
            knownHosts: path.join(dir, 'known_hosts'),
            certificate: path.join(dir, 'id-cert.pub'),
            controlPath: path.join(dir, 'mux'),
        };
        const { hostKey } = this.login;
        fs.writeFileSync(files.knownHosts, `${HOST} ${hostKey.type} ${hostKey.blob.toString('base64')}\n`, { mode: 0o600 });
        fs.writeFileSync(files.certificate, `${this.login.certificate.trim()}\n`, { mode: 0o600 });
        this.options = sshOptions(this.login, files);

        const master = this.ssh(['-M', '-N', '-o', 'ControlPersist=no'], ['ignore', 'ignore', 'pipe']);
        this.master = master;
        let said = '';
        master.stderr?.on('data', (d: Buffer) => {
            said += d.toString();
            this.logLines('ssh', d);
        });
        let gone = false;
        // What it said is why: a host key not the claim's, a certificate refused, no key exchange
        // in common, a session the tunnel could not carry.
        const ended = new Promise<never>((_, reject) => {
            master.on('error', e => reject(new Error(`running ssh: ${e.message}`)));
            master.on('close', code => {
                gone = true;
                reject(new Error(`ssh could not connect to the workspace (exit ${code}): ${said.trim() || 'it said nothing'}`));
            });
        });
        // An end after the connection is up is close()'s, or VS Code's to notice.
        ended.catch(() => undefined);
        // The master opens its control socket once it has logged in.
        const up = (async () => {
            const deadline = Date.now() + this.login.readyTimeoutMs;
            while (!gone && Date.now() < deadline) {
                if (await this.status(['-O', 'check']) === 0) {
                    return;
                }
                await new Promise(r => setTimeout(r, 100));
            }
            if (!gone) {
                throw new Error(`ssh did not connect to the workspace within ${this.login.readyTimeoutMs / 1000} s`);
            }
        })();
        try {
            await Promise.race([up, ended]);
        } catch (e) {
            await this.close();
            throw e;
        }
    }

    /** ssh with this connection's options, args before the destination and after them. */
    private ssh(before: string[], stdio: ('ignore' | 'pipe')[], after: string[] = []): ChildProcess {
        return spawn('ssh', [...this.options, ...before, this.destination, ...after], { env: this.login.env, stdio });
    }

    private logLines(who: string, d: Buffer) {
        for (const line of d.toString().split(/\r?\n/).filter(Boolean)) {
            this.login.log(`${who}: ${line}`);
        }
    }

    private status(before: string[]): Promise<number | null> {
        return new Promise(resolve => {
            const child = this.ssh(before, ['ignore', 'ignore', 'ignore']);
            child.on('error', () => resolve(null));
            child.on('close', code => resolve(code));
        });
    }

    async exec(command: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
        await this.connect();
        return new Promise((resolve, reject) => {
            const child = this.ssh(['-o', 'ControlMaster=no'], ['ignore', 'pipe', 'pipe'], [command]);
            let stdout = '';
            let stderr = '';
            child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
            child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
            child.on('error', e => reject(new Error(`running ssh: ${e.message}`)));
            child.on('close', code => resolve({ stdout, stderr, code }));
        });
    }

    /** A stream to remotePort on the workspace's loopback, through the master (`ssh -W`). */
    async forwardOut(remotePort: number): Promise<Duplex> {
        await this.connect();
        const child = this.ssh(['-o', 'ControlMaster=no', '-W', `127.0.0.1:${remotePort}`], ['pipe', 'pipe', 'pipe']);
        child.stderr?.on('data', (d: Buffer) => this.logLines('ssh -W', d));
        // Not destroyed when ssh exits: what it wrote before is still to be read, and the end of
        // its stdout is the end of the stream.
        const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
        stream.on('close', () => child.kill());
        child.on('error', e => stream.destroy(e));
        return stream;
    }

    /**
     * A port on this machine's loopback, chosen by the system, whose every connection is carried
     * to remotePort on the workspace's loopback. Only this machine reaches it.
     */
    async forwardLocal(remotePort: number): Promise<number> {
        await this.connect();
        const server = net.createServer(socket => {
            this.forwardOut(remotePort).then(stream => {
                // An 'error' on either end left unhandled would end the extension host: the
                // other end is destroyed instead.
                stream.on('error', () => socket.destroy());
                socket.on('error', () => stream.destroy());
                stream.pipe(socket);
                socket.pipe(stream);
            }, () => socket.destroy());
        });
        this.servers.push(server);
        return new Promise((resolve, reject) => {
            server.once('error', reject).listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
        });
    }

    /** Ends the master, which ends every client of it and the tunnel, and removes its files. */
    async close(): Promise<void> {
        // Not waited for: a server closes once its connections have, which the master's end ends.
        for (const s of this.servers.splice(0)) {
            s.close();
        }
        const master = this.master;
        this.master = undefined;
        if (master && master.exitCode === null && master.signalCode === null) {
            const closed = new Promise<void>(resolve => master.once('close', () => resolve()));
            master.kill();
            await closed;
        }
        if (this.dir) {
            fs.rmSync(this.dir, { recursive: true, force: true });
            this.dir = undefined;
        }
    }
}
