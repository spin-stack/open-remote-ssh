// Opens a Spinbox workspace for VS Code, with no VS Code in it so the e2e harness drives it as
// the resolver does: the workspace running with this commit's server (`spin code`), a session
// opened by the CLI (`spin ssh-prepare`), ssh2 over the CLI's tunnel (`spin ssh-proxy`) held to
// the launch claim's host key and authenticated by the workspace's certificate, and the server
// started from the extension disk. Every refusal is a SpinRefusal saying what to do.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { spawn } from 'child_process';
import type { ConnectConfig } from 'ssh2';
import SSHConnection from '../ssh/sshConnection';
import type { SpinCli } from './cli';
import { certificateKey, offerOnce, parsePrivateKey, pinnedHostVerifier } from './keys';
import { refusalOf, SpinRefusal } from './refusal';
import { readServerStart, serverStartScript, ServerStartError, shCommand } from './serverStart';
import { hostDir, readCertificate, readIdentity, readLeft, readPinnedHostKey } from './session';

export interface OpenOptions {
    cli: SpinCli;
    workspace: string;
    host: string;
    commit: string;
    version?: string;
    start: boolean;
    /** The home the CLI keeps ~/.spin in: the extension host's. */
    home: string;
    /** The process ssh-prepare and ssh-proxy are children of, which keys their session. */
    pid: number;
    log: (line: string) => void;
    readyTimeoutMs?: number;
}

export interface OpenedWorkspace {
    workspaceId: string;
    connection: SSHConnection;
    /** The server's port inside the workspace, and the token it admits. */
    port: number;
    connectionToken: string;
}

const WORKSPACE_USER = 'root';

export async function openWorkspace(o: OpenOptions): Promise<OpenedWorkspace> {
    o.log(`spin code ${o.workspace} (VS Code ${o.version ?? ''} ${o.commit})`);
    const answer = await o.cli.code({ workspace: o.workspace, commit: o.commit, version: o.version, start: o.start });
    if ('error' in answer) {
        throw new SpinRefusal(refusalOf(answer.error));
    }
    if (answer.ok.server !== 'carried') {
        throw new SpinRefusal({
            code: 'server_not_carried',
            message: `${o.workspace} has no server for VS Code ${o.version ?? o.commit} on the installation's extension disk`
                + (answer.ok.not_given ? `: ${answer.ok.not_given}` : '')
                + '. Spinbox does not download one: an administrator publishes it in Admin → Extensions.',
            temporary: false,
        });
    }

    const identity = readIdentity(o.home);
    await releaseSharedConnection(o.host, o.log);
    await o.cli.prepare(o.host, identity);
    const dir = hostDir(o.home, o.host);
    const left = readLeft(dir, o.pid);
    if (!left) {
        throw new SpinRefusal({ code: 'no_session', message: `spin ssh-prepare opened no session into ${o.workspace}`, temporary: true });
    }
    if (!left.session) {
        // The fix is the CLI's when it has one for what failed, and empty when it has none.
        throw new SpinRefusal({ code: 'refused', message: left.fix ? `${left.fix} (${left.failure})` : left.failure, temporary: false });
    }

    const pinned = readPinnedHostKey(dir, o.host);
    const key = certificateKey(parsePrivateKey(fs.readFileSync(identity), identity), readCertificate(dir));
    const connection = new SSHConnection({
        sock: o.cli.proxy(o.host, line => o.log(`spin ssh-proxy: ${line}`)),
        username: WORKSPACE_USER,
        readyTimeout: o.readyTimeoutMs ?? 60_000,
        strictVendor: false,
        // A tunnel is a session spin opened once: a reconnect is a new resolve, with a new one.
        reconnect: false,
        hostVerifier: pinnedHostVerifier(pinned) as unknown as ConnectConfig['hostVerifier'],
        authHandler: offerOnce(WORKSPACE_USER, key),
    });
    try {
        await connection.connect();
        const id = `spinbox-${crypto.randomBytes(8).toString('hex')}`;
        const { stdout } = await connection.exec(shCommand(serverStartScript(o.commit, id)));
        const started = readServerStart(stdout, id, o.commit);
        return { workspaceId: answer.ok.workspace_id, connection, ...started };
    } catch (e) {
        await connection.close().catch(() => undefined);
        if (e instanceof ServerStartError) {
            throw new SpinRefusal({ code: 'server_did_not_start', message: e.message, temporary: false });
        }
        throw e;
    }
}

/**
 * ssh-prepare opens nothing when an OpenSSH connection to host is open to share - `spin code`'s
 * own check leaves one for ten minutes - since ssh would carry the next connection on it, and
 * this one is not ssh's. Told to stop, that connection takes no more sharers and keeps the
 * sessions it carries.
 */
async function releaseSharedConnection(host: string, log: (line: string) => void): Promise<void> {
    if (process.platform === 'win32' || typeof process.getuid !== 'function') {
        return;
    }
    const socket = path.join('/tmp', `spin-${process.getuid()}`, host);
    const answers = await new Promise<boolean>(resolve => {
        const c = net.connect(socket, () => { c.destroy(); resolve(true); }).on('error', () => resolve(false));
    });
    if (!answers) {
        return;
    }
    log(`ssh -O stop: ${socket} would carry this connection on ssh's`);
    await new Promise<void>(resolve => {
        spawn('ssh', ['-O', 'stop', '-o', `ControlPath=${socket}`, host], { stdio: 'ignore' })
            .on('error', () => resolve()).on('close', () => resolve());
    });
}
