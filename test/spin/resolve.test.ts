import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type * as vscodeTypes from 'vscode';
import { activate } from '../../src/extension';
import { configOverrides, env, ResolvedAuthority, RemoteAuthorityResolverError, resolvers, shownErrors } from '../mocks/vscode';
import { keygen, type Sshd, startSshd } from '../sshd';

// `spin+<workspace>` from the extension's activation to a request answered by the workspace's
// server, with the CLI and the workspace standing in: a spin that answers `code` and
// `ssh-session`, and carries `tunnel` to OpenSSH's sshd, set up as a workspace's (test/sshd.ts),
// whose every exec answers the server start as the workspace would. The ssh is this machine's,
// through a wrapper that records what it was run with and logs in as this user, the only one a
// test's sshd lets in. What the real CLI and workspace do is test/e2e's.

const COMMIT = '69047191fc427f2f92828279aae1d90d8eeda7ab';
const TOKEN = 'the-servers-token';
const SESSION = 'ORWU6TGORHKIKCHPMWRLHNZSR4';

let dir: string;
let home: string;
let fixture: string;
let sshd: Sshd;
let codeServer: http.Server;
const saved = { HOME: process.env.HOME, PATH: process.env.PATH };

function listen(server: net.Server): Promise<number> {
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
}

// The spin CLI as the resolver runs it: what it was asked is logged in calls, what `code` and
// `ssh-session` answer is code.json and session.json.
const FAKE_SPIN = `#!/usr/bin/env node
const fs = require('fs'), net = require('net'), path = require('path');
const fixture = process.env.FAKE_SPIN_FIXTURE;
const [cmd, ...args] = process.argv.slice(2);
fs.appendFileSync(path.join(fixture, 'calls'), JSON.stringify([cmd, ...args]) + '\\n');
if (cmd === 'code' || cmd === 'ssh-session') {
    const a = JSON.parse(fs.readFileSync(path.join(fixture, cmd === 'code' ? 'code.json' : 'session.json'), 'utf8'));
    process.stdout.write(JSON.stringify(a.answer, null, 2) + '\\n');
    process.exit(a.exit);
} else if (cmd === 'tunnel' && args[0] === '${SESSION}') {
    const s = net.connect(Number(fs.readFileSync(path.join(fixture, 'port'), 'utf8')), '127.0.0.1');
    process.stdin.pipe(s);
    s.pipe(process.stdout);
    s.on('close', () => process.exit(0));
} else {
    process.stderr.write('no session ' + args[0] + '\\n');
    process.exit(1);
}
`;

// The ssh the resolver runs: this machine's, recording its arguments, as this user rather than
// root. The rotation keeps every argument as one word.
const sshWrapper = (real: string) => `#!/bin/sh
[ "$1" = -V ] || printf '%s\\036' "$*" >> "$FAKE_SPIN_FIXTURE/ssh-calls"
for a; do shift; case "$a" in root@*) set -- "$@" "$TEST_SSH_USER@\${a#root@}";; *) set -- "$@" "$a";; esac; done
exec ${real} "$@"
`;

// The workspace's every exec: the server start's answer, for the id the script names, and what it
// was asked kept in said.
const FORCE_COMMAND = (codePort: number) => `#!/bin/sh
printf '%s\\n' "$SSH_ORIGINAL_COMMAND" >> "${fixture}/said"
id=$(printf '%s\\n' "$SSH_ORIGINAL_COMMAND" | sed -n 's/.*echo "\\(spinbox-[0-9a-f]*\\): start".*/\\1/p' | head -n 1)
printf '%s: start\\nexitCode==0==\\nlisteningOn==%s==\\nconnectionToken==%s==\\n%s: end\\n' "$id" ${codePort} ${TOKEN} "$id"
`;

function answerCode(answer: unknown, exit = 0) {
    fs.writeFileSync(path.join(fixture, 'code.json'), JSON.stringify({ answer, exit }));
}

function answerSession(answer: unknown, exit = 0) {
    fs.writeFileSync(path.join(fixture, 'session.json'), JSON.stringify({ answer, exit }));
}

/** ssh-session's answer when it opened a session: the fixture's certificate, host key and identity. */
let opensSession: () => void;

function calls(): string[][] {
    return fs.readFileSync(path.join(fixture, 'calls'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as string[]);
}

/** Each run of ssh, its arguments in a line - the server's start a script of several - ended by \x1e. */
function sshCalls(): string[] {
    return fs.readFileSync(path.join(fixture, 'ssh-calls'), 'utf8').split('\x1e').filter(Boolean);
}

beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spin-resolve-'));
    home = path.join(dir, 'home');
    fixture = path.join(dir, 'fixture');
    fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
    fs.mkdirSync(path.join(fixture, 'bin'), { recursive: true });
    const identity = path.join(home, '.ssh', 'id_ed25519');
    const user = os.userInfo().username;
    keygen('-t', 'ed25519', '-N', '', '-f', identity);
    keygen('-t', 'ed25519', '-N', '', '-f', path.join(fixture, 'ca'));
    keygen('-t', 'ed25519', '-N', '', '-f', path.join(fixture, 'host'));
    // For this user, whom the wrapper logs in as: a workspace's certificate names root.
    keygen('-s', path.join(fixture, 'ca'), '-I', 'spin-test', '-n', user, '-V', '+5m', `${identity}.pub`);
    fs.renameSync(`${identity}-cert.pub`, path.join(fixture, 'user-cert.pub'));
    opensSession = () => answerSession({
        workspace_id: 'w1', session: SESSION, identity,
        certificate: fs.readFileSync(path.join(fixture, 'user-cert.pub'), 'utf8').trim(),
        host_key: fs.readFileSync(path.join(fixture, 'host.pub'), 'utf8').trim().split(' ').slice(0, 2).join(' '),
    });

    codeServer = http.createServer((req, res) => {
        res.writeHead(req.url === `/version?tkn=${TOKEN}` ? 200 : 403).end(COMMIT);
    });
    const codePort = await listen(codeServer);
    fs.writeFileSync(path.join(fixture, 'workspace.sh'), FORCE_COMMAND(codePort), { mode: 0o755 });
    sshd = await startSshd(fixture, 'sshd', { forceCommand: path.join(fixture, 'workspace.sh') });
    fs.writeFileSync(path.join(fixture, 'port'), String(sshd.port));

    const real = execFileSync('sh', ['-c', 'command -v ssh'], { encoding: 'utf8' }).trim();
    fs.writeFileSync(path.join(fixture, 'bin', 'ssh'), sshWrapper(real), { mode: 0o755 });
    const spin = path.join(fixture, 'spin');
    fs.writeFileSync(spin, FAKE_SPIN, { mode: 0o755 });
    env.appCommit = COMMIT;
    configOverrides.set('remote.spin.cliPath', spin);
    process.env.HOME = home;
    process.env.PATH = `${path.join(fixture, 'bin')}:${saved.PATH}`;
    process.env.FAKE_SPIN_FIXTURE = fixture;
    process.env.TEST_SSH_USER = user;
    // Each test asserts on its own resolve: the subscriptions are disposed in afterAll.
    activate(context);
}, 30_000);

const context = { subscriptions: [] as { dispose(): unknown }[] } as unknown as vscodeTypes.ExtensionContext;

afterEach(() => {
    for (const f of ['calls', 'ssh-calls']) {
        fs.rmSync(path.join(fixture, f), { force: true });
    }
    shownErrors.length = 0;
});

afterAll(async () => {
    for (const s of context.subscriptions) {
        s.dispose();
    }
    process.env.HOME = saved.HOME;
    process.env.PATH = saved.PATH;
    delete process.env.FAKE_SPIN_FIXTURE;
    delete process.env.TEST_SSH_USER;
    configOverrides.clear();
    sshd?.process.kill();
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
        opensSession();
        const resolved = await resolve('spin+unit-ws');

        expect(resolved.host).toBe('127.0.0.1');
        expect(resolved.connectionToken).toBe(TOKEN);
        expect(await get(resolved.port, `/version?tkn=${TOKEN}`)).toEqual({ status: 200, body: COMMIT });
        // The workspace was asked for this editor's server, the CLI opened the session, and the
        // tunnel carried it by its name: no credential on a command line, no file read.
        expect(calls()).toEqual([
            ['code', 'unit-ws', '--no-open', '--vscode-commit', COMMIT, '-o', 'json', '--vscode-version', '1.146.0', '--start'],
            ['ssh-session', 'unit-ws', '-o', 'json'],
            ['tunnel', SESSION],
        ]);
        const said = fs.readFileSync(path.join(fixture, 'said'), 'utf8');
        expect(said).toContain(`/run/spin-stack/vsc-${COMMIT.slice(0, 12)}/servers/${COMMIT}/server/bin/code-server`);
        // Every ssh - the login, the server's start, the request's way in - asked for ML-KEM alone
        // and held the workspace to the claim's key.
        const ran = sshCalls();
        expect(ran.length).toBeGreaterThanOrEqual(3);
        for (const run of ran) {
            expect(run).toContain('-o KexAlgorithms=mlkem768x25519-sha256');
            expect(run).toContain('-o StrictHostKeyChecking=yes');
        }
        expect(ran.some(r => /-W 127\.0\.0\.1:\d+ root@/.test(r)), 'the request went through ssh -W').toBe(true);
    }, 30_000);

    it('refuses a workspace that answers with another host key than the session\'s', async () => {
        answerCode({ workspace_id: 'w1', host: 'spin.unit-ws', folder_uri: 'vscode-remote://spin+unit-ws/root', server: 'carried' });
        opensSession();
        const answer = JSON.parse(fs.readFileSync(path.join(fixture, 'session.json'), 'utf8')) as { answer: Record<string, string> };
        answerSession({ ...answer.answer, host_key: fs.readFileSync(path.join(fixture, 'ca.pub'), 'utf8').trim().split(' ').slice(0, 2).join(' ') });

        await expect(resolve('spin+unit-ws')).rejects.toBeInstanceOf(RemoteAuthorityResolverError);
        expect(calls().map(c => c[0])).toEqual(['code', 'ssh-session', 'tunnel']);
    }, 30_000);

    it.each([
        ['spin code', 'code', ['code']],
        ['spin ssh-session', 'session', ['code', 'ssh-session']],
    ])('shows a refusal of %s with its one action, and tells VS Code not to retry it', async (_name, refuses, ran) => {
        const refusal = { error: { code: 'key_not_enrolled', message: 'this machine\'s key is not enrolled', action: 'add_key', url: 'https://app.example/settings/keys' } };
        answerCode(refuses === 'code' ? refusal : { workspace_id: 'w1', host: 'spin.unit-ws', folder_uri: 'vscode-remote://spin+unit-ws/root', server: 'carried' }, refuses === 'code' ? 1 : 0);
        answerSession(refusal, 1);
        const failed = await resolve('spin+unit-ws').catch((e: unknown) => e);

        expect(failed).toBeInstanceOf(RemoteAuthorityResolverError);
        expect((failed as RemoteAuthorityResolverError).temporary).toBe(false);
        expect(shownErrors).toEqual([['Spinbox could not open unit-ws: this machine\'s key is not enrolled', { modal: true }, 'Add This Machine\'s Key']]);
        expect(calls().map(c => c[0])).toEqual(ran);
    }, 30_000);

    it('refuses an ssh older than OpenSSH 9.9 before running anything, and says why', async () => {
        const old = path.join(dir, 'old');
        fs.mkdirSync(old, { recursive: true });
        fs.writeFileSync(path.join(old, 'ssh'), '#!/bin/sh\necho \'OpenSSH_9.6p1 Ubuntu-3ubuntu13.20, OpenSSL 3.0.13 30 Jan 2024\' >&2\n', { mode: 0o755 });
        const path_ = process.env.PATH;
        process.env.PATH = `${old}:${saved.PATH}`;
        try {
            const failed = await resolve('spin+unit-ws').catch((e: unknown) => e);
            expect(failed).toBeInstanceOf(RemoteAuthorityResolverError);
            expect((failed as RemoteAuthorityResolverError).temporary).toBe(false);
        } finally {
            process.env.PATH = path_;
        }
        expect(shownErrors).toEqual([[
            'Spinbox could not open unit-ws: ssh is OpenSSH 9.6 (OpenSSH_9.6p1 Ubuntu-3ubuntu13.20); a workspace needs OpenSSH 9.9 or newer. '
            + 'Its sshd accepts only the post-quantum key exchange mlkem768x25519-sha256, which OpenSSH added in 9.9, and refuses older '
            + 'clients. Update OpenSSH (on macOS, \'brew install openssh\') and open the workspace again.',
            { modal: true },
        ]]);
        expect(fs.existsSync(path.join(fixture, 'calls')), 'the CLI was asked for a workspace this ssh cannot reach').toBe(false);
    }, 30_000);

    it('refuses an authority that is not a workspace before running anything', async () => {
        await expect(resolve('spin+../etc')).rejects.toThrow(/not a Spinbox workspace/);
        expect(fs.existsSync(path.join(fixture, 'calls'))).toBe(false);
    });
});
