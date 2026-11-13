// OpenSSH's own sshd, configured as a workspace's is (spin's internal/sshauth, and the image's
// key exchange, spin-stack/spin-machine#245): certificates from one CA and nothing else, and
// mlkem768x25519-sha256 alone - so what a test proves of a connection is what sshd decides. It
// runs as this user, and so lets in only this user.

import { execFileSync, spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';

export function keygen(...args: string[]) {
    execFileSync('ssh-keygen', ['-q', ...args], { stdio: 'ignore' });
}

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const s = net.createServer().listen(0, '127.0.0.1', () => {
            const p = (s.address() as net.AddressInfo).port;
            s.close(() => resolve(p));
        }).on('error', reject);
    });
}

async function waitForPort(p: number) {
    for (let i = 0; i < 100; i++) {
        const open = await new Promise<boolean>(resolve => {
            const c = net.connect(p, '127.0.0.1', () => { c.destroy(); resolve(true); }).on('error', () => resolve(false));
        });
        if (open) {
            return;
        }
        await new Promise(r => setTimeout(r, 50));
    }
    throw new Error(`sshd did not listen on ${p}`);
}

export interface Sshd {
    port: number;
    process: ChildProcess;
}

/**
 * sshd in dir, presenting dir/host and trusting certificates dir/ca signs. kex is what it accepts
 * (the workspace's by default); forceCommand, when given, is what every exec runs instead.
 */
export async function startSshd(dir: string, name: string, o: { kex?: string; forceCommand?: string } = {}): Promise<Sshd> {
    const port = await freePort();
    const config = path.join(dir, `${name}_config`);
    fs.writeFileSync(config, [
        `ListenAddress 127.0.0.1:${port}`,
        `HostKey ${path.join(dir, 'host')}`,
        `TrustedUserCAKeys ${path.join(dir, 'ca.pub')}`,
        'AuthorizedKeysFile none',
        'PasswordAuthentication no',
        'KbdInteractiveAuthentication no',
        'UsePAM no',
        'StrictModes no',
        `KexAlgorithms ${o.kex ?? 'mlkem768x25519-sha256'}`,
        // A refused login is one from 127.0.0.1, and a penalised source has the next test's
        // refused before it is asked.
        'PerSourcePenalties no',
        ...(o.forceCommand ? [`ForceCommand ${o.forceCommand}`] : []),
        `PidFile ${path.join(dir, `${name}.pid`)}`,
        'LogLevel ERROR',
        '',
    ].join('\n'));
    // Both lines take OpenSSH 9.9 or newer, as a workspace's sshd is: an older one is no stand-in.
    try {
        execFileSync('/usr/sbin/sshd', ['-t', '-f', config], { stdio: 'pipe' });
    } catch (e) {
        throw new Error(`this sshd refuses a workspace's config (OpenSSH 9.9 or newer takes it): ${(e as { stderr?: Buffer }).stderr?.toString() ?? e}`);
    }
    const sshd = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', config], { stdio: ['ignore', 'ignore', 'pipe'] });
    let said = '';
    sshd.stderr?.on('data', (d: Buffer) => { said += d.toString(); });
    sshd.on('error', e => { said += e.message; });
    await waitForPort(port).catch(e => {
        throw new Error(`${(e as Error).message}: ${said || `exit ${sshd.exitCode}`}`);
    });
    return { port, process: sshd };
}
