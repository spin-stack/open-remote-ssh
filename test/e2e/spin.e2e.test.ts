import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { SpinCli } from '../../src/spin/cli';
import { openWorkspace, type OpenedWorkspace } from '../../src/spin/open';
import { SpinRefusal } from '../../src/spin/refusal';

// The resolver's core against a real Spinbox installation and the real spin CLI - nothing
// stands in for either. It needs spin's e2e stack (`task e2e:up` and `task e2e:workspaces` in
// spin, which need KVM and sudo -n) and is run by `go tool task test:e2e`, which says what to set:
//
//   SPIN_E2E_CLI   spin's bin/spin, the stack's release
//   SPIN_E2E_HOME  a person's home from spin's hack/e2estack (_output/run/e2e/people/user): a
//                  profile signed in to the stack, an enrolled key, the stack's CA in .trust
//   SPIN_E2E_COMMIT the VS Code commit the stack publishes a server for (spin's versions.yaml vscode)
//
// What it asserts is what a person is shown: a server that answers, the same one on a
// reconnect, and each refusal's words and action.

const cliPath = process.env.SPIN_E2E_CLI ?? '';
const home = process.env.SPIN_E2E_HOME ?? '';
const commit = process.env.SPIN_E2E_COMMIT ?? '';
const running = process.env.SPIN_E2E_RUNNING ?? 'e2e-running';
const stopped = process.env.SPIN_E2E_STOPPED ?? 'e2e-stopped';

// OpenSSH reads the config of the passwd entry's home, not $HOME's, and a fixture person's home
// is not that: the ssh `spin code` checks the workspace with is told the person's config, as it
// would find it on a machine of theirs.
const sshShim = fs.mkdtempSync(path.join(os.tmpdir(), 'spin-e2e-ssh-'));
fs.writeFileSync(path.join(sshShim, 'ssh'), '#!/bin/sh\nexec /usr/bin/ssh -F "$HOME/.ssh/config" "$@"\n', { mode: 0o755 });

function cliFor(h: string) {
    return new SpinCli(cliPath, {
        ...process.env, HOME: h, SSL_CERT_DIR: `/etc/ssl/certs:${path.join(h, '.trust')}`, PATH: `${sshShim}:${process.env.PATH}`,
    });
}

function open(workspace: string, h = home, start = true) {
    return openWorkspace({
        cli: cliFor(h), workspace, host: `spin.${workspace}`, commit, start, home: h, pid: process.pid,
        log: line => console.log(line),
    });
}

async function refusalOf(p: Promise<OpenedWorkspace>) {
    try {
        const opened = await p;
        await opened.connection.close();
    } catch (e) {
        if (e instanceof SpinRefusal) {
            return e.refusal;
        }
        throw e;
    }
    throw new Error('the workspace opened');
}

/** An HTTP request to the server through the connection, answering its status line. */
async function statusLine(o: OpenedWorkspace): Promise<string> {
    const channel = await o.connection.forwardOut('127.0.0.1', 0, '127.0.0.1', o.port);
    return new Promise((resolve, reject) => {
        let data = '';
        channel.on('data', (d: Buffer) => { data += d.toString(); });
        channel.on('close', () => resolve(data.split('\r\n')[0]));
        channel.on('error', reject);
        channel.end(`GET /version?tkn=${o.connectionToken} HTTP/1.0\r\nHost: localhost\r\n\r\n`);
    });
}

const opened: OpenedWorkspace[] = [];
afterAll(async () => {
    await Promise.all(opened.map(o => o.connection.close().catch(() => undefined)));
    fs.rmSync(sshShim, { recursive: true, force: true });
});

describe('a Spinbox workspace through the real CLI', () => {
    it('is set up for', () => {
        expect(cliPath && home && commit, 'SPIN_E2E_CLI, SPIN_E2E_HOME and SPIN_E2E_COMMIT: go tool task test:e2e says how').toBeTruthy();
        expect(fs.existsSync(path.join(home, '.spin', 'config.yaml')), `${home} has no signed-in profile`).toBe(true);
    });

    it('opens, with the server the installation carries, answering through the tunnel', async () => {
        const o = await open(running);
        opened.push(o);
        expect(await statusLine(o)).toMatch(/^HTTP\/1\.1 200/);
        // Held to the launch claim's key: ssh-prepare wrote it, and it is the only one.
        const knownHosts = fs.readFileSync(path.join(home, '.spin', 'ssh', 'hosts', `spin.${running}`, 'known_hosts'), 'utf8');
        expect(knownHosts).toMatch(new RegExp(`^spin\\.${running} ssh-`, 'm'));
    }, 15 * 60_000);

    it('reconnects to the same server', async () => {
        const first = opened[0] ?? await open(running);
        const again = await open(running);
        opened.push(again);
        expect(again.port).toBe(first.port);
        expect(again.connectionToken).toBe(first.connectionToken);
        expect(await statusLine(again)).toMatch(/^HTTP\/1\.1 200/);
    }, 5 * 60_000);

    it('says a stopped workspace is stopped when it is not to be started', async () => {
        const refusal = await refusalOf(open(stopped, home, false));
        expect(refusal.code).toBe('workspace_stopped');
        expect(refusal.message).toMatch(/stopped/i);
    }, 5 * 60_000);

    it('says a key the installation does not know is not enrolled, with where to add it', async () => {
        // The same person on a machine whose only key nobody enrolled.
        const stranger = fs.mkdtempSync(path.join(os.tmpdir(), 'spin-e2e-stranger-'));
        fs.mkdirSync(path.join(stranger, '.ssh'), { mode: 0o700 });
        fs.cpSync(path.join(home, '.spin', 'config.yaml'), path.join(stranger, '.spin', 'config.yaml'));
        fs.cpSync(path.join(home, '.trust'), path.join(stranger, '.trust'), { recursive: true });
        execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(stranger, '.ssh', 'id_ed25519')]);
        try {
            const refusal = await refusalOf(open(running, stranger));
            expect(refusal.code).toBe('key_not_enrolled');
            expect(refusal.action?.title).toBe('Add This Machine\'s Key');
            expect(refusal.action?.url).toMatch(/\/settings\/keys/);
        } finally {
            fs.rmSync(stranger, { recursive: true, force: true });
        }
    }, 5 * 60_000);
});
