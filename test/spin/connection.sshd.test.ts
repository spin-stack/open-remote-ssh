import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import SSHConnection, { type SSHLogin } from '../../src/spin/connection';
import { parseHostKey } from '../../src/spin/keys';
import { escapeShellArg } from '../../src/spin/serverStart';
import { keygen, type Sshd, startSshd } from '../sshd';

// The connection, this machine's OpenSSH, against a real sshd set up as a workspace's is: only a
// certificate the workspace's CA signed lets anyone in, only the host key the claim names is
// accepted, and only mlkem768x25519-sha256 is negotiated. The ProxyCommand stands in for
// `spin tunnel`: it carries the connection to the sshd's port.

const user = os.userInfo().username;
let dir: string;
let workspace: Sshd;
let classical: Sshd;
let web: http.Server;
let webPort: number;
const opened: SSHConnection[] = [];

// `spin tunnel` as ssh runs it: stdin and stdout carried to a port.
const PROXY = `const s = require('net').connect(Number(process.argv[2]), '127.0.0.1');
process.stdin.pipe(s); s.pipe(process.stdout); s.on('close', () => process.exit(0)); s.on('error', () => process.exit(1));
`;

beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spin-connection-'));
    keygen('-t', 'ed25519', '-N', '', '-f', path.join(dir, 'ca'));
    keygen('-t', 'ed25519', '-N', '', '-f', path.join(dir, 'host'));
    for (const [name, type] of [['user-ed25519', 'ed25519'], ['user-ecdsa', 'ecdsa'], ['stranger', 'ed25519']]) {
        keygen('-t', type, '-N', '', '-f', path.join(dir, name));
    }
    keygen('-s', path.join(dir, 'ca'), '-I', 'spin-test', '-n', user, '-V', '+5m', path.join(dir, 'user-ed25519.pub'));
    keygen('-s', path.join(dir, 'ca'), '-I', 'spin-test', '-n', user, '-V', '+5m', path.join(dir, 'user-ecdsa.pub'));
    // A certificate for another principal: signed by the same CA, for nobody here.
    keygen('-s', path.join(dir, 'ca'), '-I', 'spin-test', '-n', 'someone-else', '-V', '+5m', path.join(dir, 'stranger.pub'));
    fs.writeFileSync(path.join(dir, 'proxy.js'), PROXY);
    workspace = await startSshd(dir, 'workspace');
    // The same sshd as an OpenSSH before 9.9 would meet it: curve25519, and no ML-KEM.
    classical = await startSshd(dir, 'classical', { kex: 'curve25519-sha256' });
    web = http.createServer((_req, res) => res.end('the server'));
    webPort = await new Promise(resolve => web.listen(0, '127.0.0.1', () => resolve((web.address() as net.AddressInfo).port)));
}, 30_000);

afterAll(async () => {
    await Promise.all(opened.map(c => c.close()));
    workspace?.process.kill();
    classical?.process.kill();
    web?.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

function hostKey(file = 'host.pub') {
    return parseHostKey(fs.readFileSync(path.join(dir, file), 'utf8').trim().split(' ').slice(0, 2).join(' '));
}

function login(name: string, o: Partial<SSHLogin> & { port?: number; certificate?: string } = {}): SSHConnection {
    const said: string[] = [];
    const c = new SSHConnection({
        user,
        proxyCommand: `${escapeShellArg(process.execPath)} ${escapeShellArg(path.join(dir, 'proxy.js'))} ${o.port ?? workspace.port}`,
        identity: path.join(dir, name),
        certificate: o.certificate ?? fs.readFileSync(path.join(dir, `${name}-cert.pub`), 'utf8'),
        hostKey: o.hostKey ?? hostKey(),
        env: process.env,
        log: line => said.push(line),
        readyTimeoutMs: 20_000,
    });
    opened.push(c);
    return c;
}

/** What connecting and running `echo ok` answers: the output, or the error. */
async function run(c: SSHConnection): Promise<string> {
    try {
        await c.connect();
        return (await c.exec('echo ok')).stdout.trim();
    } catch (e) {
        return `error: ${(e as Error).message}`;
    }
}

describe('a connection to a workspace sshd', () => {
    it.each(['user-ed25519', 'user-ecdsa'])('logs in with %s presented as its certificate', async (name) => {
        expect(await run(login(name))).toBe('ok');
    }, 30_000);

    it('is refused for the same key without its certificate', async () => {
        const out = await run(login('user-ed25519', { certificate: fs.readFileSync(path.join(dir, 'user-ed25519.pub'), 'utf8') }));
        expect(out).toMatch(/^error: ssh could not connect to the workspace .*Permission denied \(publickey\)/s);
    }, 30_000);

    it('is refused for a certificate for another principal', async () => {
        expect(await run(login('stranger'))).toMatch(/^error: ssh could not connect to the workspace .*Permission denied \(publickey\)/s);
    }, 30_000);

    it('hangs up on a host whose key is not the pinned one', async () => {
        const out = await run(login('user-ed25519', { hostKey: hostKey('ca.pub') }));
        expect(out).toMatch(/^error: ssh could not connect to the workspace .*Host key verification failed/s);
    }, 30_000);

    it('negotiates ML-KEM or nothing', async () => {
        const out = await run(login('user-ed25519', { port: classical.port }));
        expect(out).toMatch(/^error: ssh could not connect to the workspace .*no matching key exchange method found/s);
    }, 30_000);

    it('carries a loopback port to the workspace\'s, for as long as it is open', async () => {
        const c = login('user-ed25519');
        const port = await c.forwardLocal(webPort);
        for (let i = 0; i < 2; i++) {
            const body = await new Promise<string>((resolve, reject) => {
                http.get({ host: '127.0.0.1', port, path: '/' }, res => {
                    let b = '';
                    res.on('data', (d: Buffer) => { b += d.toString(); }).on('end', () => resolve(b));
                }).on('error', reject);
            });
            expect(body).toBe('the server');
        }
        await c.close();
        await expect(c.exec('echo ok').then(r => r.code)).resolves.not.toBe(0);
    }, 30_000);
});
