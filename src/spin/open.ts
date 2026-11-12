// Opens a Spinbox workspace for VS Code, with no VS Code in it so the e2e harness drives it as
// the resolver does: the workspace running with this commit's server (`spin code`), a session
// opened by the CLI (`spin ssh-session`), ssh2 over the CLI's tunnel (`spin tunnel`) held to the
// launch claim's host key and authenticated by the workspace's certificate, and the server
// started from the extension disk. Every refusal is a SpinRefusal saying what to do.

import * as crypto from 'crypto';
import * as fs from 'fs';
import type { ConnectConfig } from 'ssh2';
import type { SpinCli } from './cli';
import SSHConnection from './connection';
import { certificateKey, offerOnce, parseHostKey, parsePrivateKey, pinnedHostVerifier } from './keys';
import { refusalOf, SpinRefusal } from './refusal';
import { readServerStart, serverStartScript, ServerStartError, shCommand } from './serverStart';

export interface OpenOptions {
    cli: SpinCli;
    workspace: string;
    commit: string;
    version?: string;
    start: boolean;
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

    o.log(`spin ssh-session ${o.workspace}`);
    const session = await o.cli.session(o.workspace);
    if ('error' in session) {
        throw new SpinRefusal(refusalOf(session.error));
    }
    const { identity, certificate, host_key: hostKey } = session.ok;
    const pinned = parseHostKey(hostKey);
    const key = certificateKey(parsePrivateKey(fs.readFileSync(identity), identity), certificate);
    const connection = new SSHConnection({
        sock: o.cli.tunnel(session.ok.session, line => o.log(`spin tunnel: ${line}`)),
        username: WORKSPACE_USER,
        readyTimeout: o.readyTimeoutMs ?? 60_000,
        strictVendor: false,
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
