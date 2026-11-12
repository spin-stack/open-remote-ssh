import { execFileSync, spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { Client, type ConnectConfig } from 'ssh2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { certificateKey, offerOnce, parseHostKey, parsePrivateKey, pinnedHostVerifier } from '../../src/spin/keys';

// Against a real OpenSSH sshd set up as a workspace's is (spin's internal/sshauth):
// AuthorizedKeysFile none, so only a certificate a trusted CA signed lets anyone in. ssh-keygen
// makes the CA, the host key and the certificates, as the workspace's supervisor does.

const user = os.userInfo().username;
let dir: string;
let sshd: ChildProcess;
let port: number;

function keygen(...args: string[]) {
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

beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spin-keys-'));
    keygen('-t', 'ed25519', '-N', '', '-f', path.join(dir, 'ca'));
    keygen('-t', 'ed25519', '-N', '', '-f', path.join(dir, 'host'));
    for (const [name, type] of [['user-ed25519', 'ed25519'], ['user-ecdsa', 'ecdsa'], ['stranger', 'ed25519']]) {
        keygen('-t', type, '-N', '', '-f', path.join(dir, name));
    }
    keygen('-s', path.join(dir, 'ca'), '-I', 'spin-test', '-n', user, '-V', '+5m', path.join(dir, 'user-ed25519.pub'));
    keygen('-s', path.join(dir, 'ca'), '-I', 'spin-test', '-n', user, '-V', '+5m', path.join(dir, 'user-ecdsa.pub'));
    // A certificate for another principal: signed by the same CA, for nobody here.
    keygen('-s', path.join(dir, 'ca'), '-I', 'spin-test', '-n', 'someone-else', '-V', '+5m', path.join(dir, 'stranger.pub'));
    port = await freePort();
    fs.writeFileSync(path.join(dir, 'sshd_config'), [
        `ListenAddress 127.0.0.1:${port}`,
        `HostKey ${path.join(dir, 'host')}`,
        `TrustedUserCAKeys ${path.join(dir, 'ca.pub')}`,
        'AuthorizedKeysFile none',
        'PasswordAuthentication no',
        'KbdInteractiveAuthentication no',
        'UsePAM no',
        'StrictModes no',
        `PidFile ${path.join(dir, 'sshd.pid')}`,
        'LogLevel ERROR',
        '',
    ].join('\n'));
    // OpenSSH 9.8+ shuts out a source after failed logins, and the refusals below are failed
    // logins from 127.0.0.1: without this, a test after them would meet a closed door. An older
    // sshd (Ubuntu 24.04's 9.6) has no penalties, and refuses the option.
    fs.appendFileSync(path.join(dir, 'sshd_config'), 'PerSourcePenalties no\n');
    try {
        execFileSync('/usr/sbin/sshd', ['-t', '-f', path.join(dir, 'sshd_config')], { stdio: 'ignore' });
    } catch {
        const config = fs.readFileSync(path.join(dir, 'sshd_config'), 'utf8');
        fs.writeFileSync(path.join(dir, 'sshd_config'), config.replace('PerSourcePenalties no\n', ''));
    }
    sshd = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', path.join(dir, 'sshd_config')], { stdio: ['ignore', 'ignore', 'pipe'] });
    let said = '';
    sshd.stderr?.on('data', (d: Buffer) => { said += d.toString(); });
    sshd.on('error', e => { said += e.message; });
    await waitForPort(port).catch(e => {
        throw new Error(`${(e as Error).message}: ${said || `exit ${sshd.exitCode}`}`);
    });
}, 30_000);

afterAll(() => {
    sshd?.kill();
    fs.rmSync(dir, { recursive: true, force: true });
});

/** Connects as user and runs `echo ok`, answering what the outside sees: the output, or the error. */
function run(config: ConnectConfig): Promise<string> {
    return new Promise(resolve => {
        const c = new Client();
        c.on('ready', () => {
            c.exec('echo ok', (err, stream) => {
                if (err) {
                    c.end();
                    return resolve(`exec: ${err.message}`);
                }
                let out = '';
                stream.on('data', (d: Buffer) => { out += d.toString(); }).on('close', () => { c.end(); resolve(out.trim()); });
            });
        }).on('error', e => resolve(`error: ${e.message}`)).connect({ host: '127.0.0.1', port, username: user, readyTimeout: 10_000, ...config });
    });
}

function pinnedHost() {
    return parseHostKey(fs.readFileSync(path.join(dir, 'host.pub'), 'utf8').trim().split(' ').slice(0, 2).join(' '));
}

function identity(name: string) {
    return parsePrivateKey(fs.readFileSync(path.join(dir, name)), name);
}

function cert(name: string) {
    return fs.readFileSync(path.join(dir, `${name}-cert.pub`), 'utf8');
}

describe('a workspace sshd that admits certificates only', () => {
    it.each(['user-ed25519', 'user-ecdsa'])('lets in %s presented as its certificate', async (name) => {
        const out = await run({
            hostVerifier: pinnedHostVerifier(pinnedHost()) as unknown as ConnectConfig['hostVerifier'],
            authHandler: offerOnce(user, certificateKey(identity(name), cert(name))),
        });
        expect(out).toBe('ok');
    });

    it('refuses the same key without its certificate', async () => {
        const out = await run({
            hostVerifier: pinnedHostVerifier(pinnedHost()) as unknown as ConnectConfig['hostVerifier'],
            authHandler: offerOnce(user, identity('user-ed25519')),
        });
        expect(out).toMatch(/^error: All configured authentication methods failed/);
    });

    it('refuses a certificate for another principal', async () => {
        const out = await run({
            hostVerifier: pinnedHostVerifier(pinnedHost()) as unknown as ConnectConfig['hostVerifier'],
            authHandler: offerOnce(user, certificateKey(identity('stranger'), cert('stranger'))),
        });
        expect(out).toMatch(/^error: All configured authentication methods failed/);
    });

    it('hangs up on a host whose key is not the pinned one', async () => {
        const other = { type: 'ssh-ed25519', blob: Buffer.from(fs.readFileSync(path.join(dir, 'ca.pub'), 'utf8').split(' ')[1], 'base64') };
        const out = await run({
            hostVerifier: pinnedHostVerifier(other) as unknown as ConnectConfig['hostVerifier'],
            authHandler: offerOnce(user, certificateKey(identity('user-ed25519'), cert('user-ed25519'))),
        });
        expect(out).toMatch(/^error: .*verification failed/i);
    });
});

describe('certificateKey', () => {
    it('refuses a certificate for another kind of key', () => {
        expect(() => certificateKey(identity('user-ecdsa'), cert('user-ed25519'))).toThrow(/for a ssh-ed25519 key, and the identity is a ecdsa/);
    });

    it('refuses what is not a certificate', () => {
        expect(() => certificateKey(identity('user-ed25519'), fs.readFileSync(path.join(dir, 'user-ed25519.pub'), 'utf8'))).toThrow(/not an OpenSSH certificate/);
    });
});
