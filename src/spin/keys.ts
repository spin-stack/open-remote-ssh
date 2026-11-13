// The host key a Spinbox connection is held to: the one the workspace's launch claim names, which
// is the only key its sshd may answer with. ssh is given it as the one line of a known_hosts of
// the connection's own (connection.ts), written from the key as parsed here, never as answered.

export interface PinnedKey {
    type: string;
    /** The key's SSH wire encoding, as a server presents it in the key exchange. */
    blob: Buffer;
}

/**
 * The host key ssh-session answered, `<type> <base64>`. Anything else - no key, a line of more,
 * a blob of another type than the line names - is refused rather than guessed at: a connection
 * with no key to check is accepted with whatever answers.
 */
export function parseHostKey(line: string): PinnedKey {
    const [type, base64, ...rest] = line.trim().split(/\s+/);
    if (!type || !base64 || rest.length > 0) {
        throw new Error(`the workspace's host key is not one key: ${JSON.stringify(line)}`);
    }
    const blob = Buffer.from(base64, 'base64');
    // The blob begins with its own type: one that says another is not the key the line names.
    const named = blob.length >= 4 ? blob.subarray(4, 4 + blob.readUInt32BE(0)).toString() : '';
    if (named !== type) {
        throw new Error(`the workspace's host key is not a ${type} key`);
    }
    return { type, blob };
}
