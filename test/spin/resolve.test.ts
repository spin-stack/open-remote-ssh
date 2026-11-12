import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { Server } from 'ssh2';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type * as vscodeTypes from 'vscode';
import { activate } from '../../src/extension';
import { configOverrides, env, ResolvedAuthority, RemoteAuthorityResolverError, resolvers, shownErrors } from '../mocks/vscode';

// `spin+<workspace>` from the extension's activation to a request answered by the workspace's
// server, with the CLI and the workspace standing in: a spin that answers `code`, leaves what
// `ssh-prepare` leaves, and carries `ssh-proxy` to an ssh2 server that admits only the
// workspace's certificate and answers the server start as the workspace would. What OpenSSH
// makes of the certificate is keys.sshd.test.ts's, and what the real CLI and workspace do is
// test/e2e's.

const COMMIT = '69047191fc427f2f92828279aae1d90d8eeda7ab';
const TOKEN = 'the-servers-token';
const CERT_TYPE = 'ssh-ed25519-cert-v01@openssh.com';

let dir: string;
let home: string;
let fixture: string;
let sshd: Server;
let codeServer: http.Server;
const savedHome = process.env.HOME;
const said: string[] = [];

function keygen(...args: string[]) {
    execFileSync('ssh-keygen', ['-q', ...args], { stdio: 'ignore' });
}

function listen(server: net.Server): Promise<number> {
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
}

// The spin CLI as the resolver runs it: what it was asked is logged in calls, what `code`
// answers is code.json.
const FAKE_SPIN = `#!/usr/bin/env node
const fs = require('fs'), net = require('net'), path = require('path');
const fixture = process.env.FAKE_SPIN_FIXTURE;
const [cmd, ...args] = process.argv.slice(2);
fs.appendFileSync(path.join(fixture, 'calls'), JSON.stringify([cmd, ...args]) + '\\n');
if (cmd === 'code') {
    const a = JSON.parse(fs.readFileSync(path.join(fixture, 'code.json'), 'utf8'));
    process.stdout.write(JSON.stringify(a.answer) + '\\n');
    process.exit(a.exit);
} else if (cmd === 'ssh-prepare') {
    const host = args[args.length - 1];
    const d = path.join(process.env.HOME, '.spin', 'ssh', 'hosts', host);
    fs.mkdirSync(d, { recursive: true });
    const key = fs.readFileSync(path.join(fixture, 'host.pub'), 'utf8').split(' ').slice(0, 2).join(' ');
    fs.writeFileSync(path.join(d, 'known_hosts'), '# spin: workspace\\n' + host + ' ' + key + '\\n');
    fs.copyFileSync(path.join(fixture, 'user-cert.pub'), path.join(d, 'id-cert.pub'));
    fs.writeFileSync(path.join(d, process.ppid + '.tunnel'), '');
} else if (cmd === 'ssh-proxy') {
    const s = net.connect(Number(fs.readFileSync(path.join(fixture, 'port'), 'utf8')), '127.0.0.1');
    process.stdin.pipe(s);
    s.pipe(process.stdout);
    s.on('close', () => process.exit(0));
}
`;

function answerCode(answer: unknown, exit = 0) {
    fs.writeFileSync(path.join(fixture, 'code.json'), JSON.stringify({ answer, exit }));
}

function calls(): string[][] {
    return fs.readFileSync(path.join(fixture, 'calls'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as string[]);
}

beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spin-resolve-'));
    home = path.join(dir, 'home');
    fixture = path.join(dir, 'fixture');
    fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
    fs.mkdirSync(path.join(home, '.spin', 'ssh'), { recursive: true });
    fs.mkdirSync(fixture);
    const identity = path.join(home, '.ssh', 'id_ed25519');
    keygen('-t', 'ed25519', '-N', '', '-f', identity);
    keygen('-t', 'ed25519', '-N', '', '-f', path.join(fixture, 'ca'));
    keygen('-t', 'ed25519', '-N', '', '-f', path.join(fixture, 'host'));
    keygen('-s', path.join(fixture, 'ca'), '-I', 'spin-test', '-n', 'root', '-V', '+5m', `${identity}.pub`);
    fs.renameSync(`${identity}-cert.pub`, path.join(fixture, 'user-cert.pub'));
    fs.writeFileSync(path.join(home, '.spin', 'ssh', 'config'), `Match host spin.*\n  IdentityFile "${identity}"\n`);
    const certBlob = Buffer.from(fs.readFileSync(path.join(fixture, 'user-cert.pub'), 'utf8').split(' ')[1], 'base64');

    codeServer = http.createServer((req, res) => {
        res.writeHead(req.url === `/version?tkn=${TOKEN}` ? 200 : 403).end(COMMIT);
    });
    const codePort = await listen(codeServer);

    sshd = new Server({ hostKeys: [fs.readFileSync(path.join(fixture, 'host'))] }, client => {
        client.on('authentication', ctx => {
            if (ctx.method === 'publickey' && ctx.username === 'root' && ctx.key.algo === CERT_TYPE && ctx.key.data.equals(certBlob)) {
                return ctx.accept();
            }
            ctx.reject(['publickey']);
        }).on('ready', () => {
            client.on('session', accept => {
                accept().on('exec', (acceptExec, _reject, info) => {
                    said.push(info.command);
                    const id = /echo "(spinbox-[0-9a-f]+): start"/.exec(info.command)?.[1];
                    const stream = acceptExec();
                    stream.write(`${id}: start\nexitCode==0==\nlisteningOn==${codePort}==\nconnectionToken==${TOKEN}==\n${id}: end\n`);
                    stream.exit(0);
                    stream.end();
                });
            }).on('tcpip', (acceptTcp, reject, info) => {
                if (info.destIP !== '127.0.0.1' || info.destPort !== codePort) {
                    reject();
                    return;
                }
                const channel = acceptTcp();
                const socket = net.connect(codePort, '127.0.0.1');
                channel.pipe(socket).pipe(channel);
            });
        }).on('error', () => undefined);
    });
    fs.writeFileSync(path.join(fixture, 'port'), String(await listen(sshd as unknown as net.Server)));

    const spin = path.join(fixture, 'spin');
    fs.writeFileSync(spin, FAKE_SPIN, { mode: 0o755 });
    env.appCommit = COMMIT;
    configOverrides.set('remote.spin.cliPath', spin);
    process.env.HOME = home;
    process.env.FAKE_SPIN_FIXTURE = fixture;
    // Each test asserts on its own resolve: the subscriptions are disposed in afterAll.
    activate(context);
}, 30_000);

const context = { subscriptions: [] as { dispose(): unknown }[] } as unknown as vscodeTypes.ExtensionContext;

afterEach(() => {
    fs.rmSync(path.join(fixture, 'calls'), { force: true });
    shownErrors.length = 0;
});

afterAll(async () => {
    for (const s of context.subscriptions) {
        s.dispose();
    }
    process.env.HOME = savedHome;
    delete process.env.FAKE_SPIN_FIXTURE;
    configOverrides.clear();
    sshd?.close();
    codeServer?.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

function resolver() {
    const r = resolvers.get('spin') as vscodeTypes.RemoteAuthorityResolver | undefined;
    expect(r, 'activate registers the spin authority').toBeDefined();
    return r!;
}

function resolve(authority: string) {
    return resolver().resolve(authority, { resolveAttempt: 1 } as vscodeTypes.RemoteAuthorityResolverContext) as Promise<ResolvedAuthority>;
}

function get(port: number, urlPath: string): Promise<{ status?: number; body: string }> {
    return new Promise((done, fail) => {
        http.get({ host: '127.0.0.1', port, path: urlPath }, res => {
            let body = '';
            res.on('data', (d: Buffer) => { body += d.toString(); }).on('end', () => done({ status: res.statusCode, body }));
        }).on('error', fail);
    });
}

describe('spin+<workspace>', () => {
    it('resolves to a local port that reaches the workspace\'s server, with its token', async () => {
        answerCode({ workspace_id: 'w1', host: 'spin.unit-ws', folder_uri: 'vscode-remote://spin+unit-ws/root', server: 'carried' });
        const resolved = await resolve('spin+unit-ws');

        expect(resolved.host).toBe('127.0.0.1');
        expect(resolved.connectionToken).toBe(TOKEN);
        expect(await get(resolved.port, `/version?tkn=${TOKEN}`)).toEqual({ status: 200, body: COMMIT });
        // The workspace was asked for this editor's server, and the CLI opened the session.
        expect(calls().map(c => c[0])).toEqual(['code', 'ssh-prepare', 'ssh-proxy']);
        expect(calls()[0]).toEqual(['code', 'unit-ws', '--no-open', '--vscode-commit', COMMIT, '-o', 'json', '--vscode-version', '1.146.0', '--start']);
        expect(said[said.length - 1]).toContain(`/run/spin-stack/vsc-${COMMIT.slice(0, 12)}/servers/${COMMIT}/server/bin/code-server`);
    }, 30_000);

    it('shows a refusal with its one action, and tells VS Code not to retry it', async () => {
        answerCode({ error: { code: 'key_not_enrolled', message: 'this machine\'s key is not enrolled', action: 'enroll', url: 'https://app.example/settings/keys' } }, 1);
        const failed = await resolve('spin+unit-ws').catch((e: unknown) => e);

        expect(failed).toBeInstanceOf(RemoteAuthorityResolverError);
        expect((failed as RemoteAuthorityResolverError).temporary).toBe(false);
        expect(shownErrors).toEqual([['Spinbox could not open unit-ws: this machine\'s key is not enrolled', { modal: true }, 'Add This Machine\'s Key']]);
        expect(calls().map(c => c[0])).toEqual(['code']);
    }, 30_000);

    it('refuses an authority that is not a workspace before running anything', async () => {
        await expect(resolve('spin+../etc')).rejects.toThrow(/not a Spinbox workspace/);
        expect(fs.existsSync(path.join(fixture, 'calls'))).toBe(false);
    });
});
