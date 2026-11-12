// What `spin ssh-prepare <host>` leaves under ~/.spin/ssh/hosts/<host>/ for the connection it
// prepared (cmd/cli/cmd/sshconfig.go): the workspace's host key, checked against its launch
// claim, as a known_hosts line; the certificate the workspace signed for the identity; and,
// keyed by the pid of the process that ran it, either the session `spin ssh-proxy` carries or
// why there is none. The CLI keys them by its parent's pid, which is ssh's when ssh runs it and
// this extension host's when the resolver does.

import * as fs from 'fs';
import * as path from 'path';

export function hostDir(home: string, host: string): string {
    return path.join(home, '.spin', 'ssh', 'hosts', host);
}

/**
 * The private key `spin code` and `spin ssh-config` chose for this machine: the IdentityFile of
 * ~/.spin/ssh/config, which they write.
 */
export function readIdentity(home: string): string {
    const config = path.join(home, '.spin', 'ssh', 'config');
    let body: string;
    try {
        body = fs.readFileSync(config, 'utf8');
    } catch (e) {
        throw new Error(`${config} cannot be read (${(e as NodeJS.ErrnoException).code}): spin code writes it`);
    }
    const line = body.split(/\r?\n/).map(l => l.trim()).find(l => /^IdentityFile\s/i.test(l));
    const identity = line?.replace(/^IdentityFile\s+/i, '').replace(/^"(.*)"$/, '$1');
    if (!identity) {
        throw new Error(`${config} names no IdentityFile: run spin ssh-config`);
    }
    return identity;
}

export type Left = { session: true } | { session: false; fix: string; failure: string };

/** What ssh-prepare left for the process `pid`: a session, or the fix and the failure. */
export function readLeft(dir: string, pid: number): Left | undefined {
    if (fs.existsSync(path.join(dir, `${pid}.tunnel`))) {
        return { session: true };
    }
    let failure: string;
    try {
        failure = fs.readFileSync(path.join(dir, `${pid}.error`), 'utf8');
    } catch {
        return undefined;
    }
    const newline = failure.indexOf('\n');
    return newline < 0
        ? { session: false, fix: failure, failure }
        : { session: false, fix: failure.slice(0, newline), failure: failure.slice(newline + 1) };
}

export interface PinnedKey {
    type: string;
    /** The key's SSH wire encoding, as a server presents it in the key exchange. */
    blob: Buffer;
}

/**
 * The one host key ssh-prepare wrote for host, after checking the workspace's launch claim:
 * `spin.<ws> <type> <base64>` under a `# spin:` comment. Anything else - no key, two, another
 * host's - is refused rather than guessed at: a connection with no key to check is accepted
 * with whatever answers.
 */
export function readPinnedHostKey(dir: string, host: string): PinnedKey {
    const file = path.join(dir, 'known_hosts');
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.trim() !== '' && !l.startsWith('#'));
    if (lines.length !== 1) {
        throw new Error(`${file} holds ${lines.length} host keys; spin ssh-prepare writes one`);
    }
    const [name, type, base64, ...rest] = lines[0].trim().split(/\s+/);
    if (name !== host || !type || !base64 || rest.length > 0) {
        throw new Error(`${file} does not hold one key for ${host}`);
    }
    const blob = Buffer.from(base64, 'base64');
    // The blob begins with its own type: one that says another is not the key the line names.
    const named = blob.length >= 4 ? blob.subarray(4, 4 + blob.readUInt32BE(0)).toString() : '';
    if (named !== type) {
        throw new Error(`${file}'s key for ${host} is not a ${type} key`);
    }
    return { type, blob };
}

/** The certificate the workspace signed for the identity, as id-cert.pub holds it. */
export function readCertificate(dir: string): string {
    return fs.readFileSync(path.join(dir, 'id-cert.pub'), 'utf8').trim();
}
