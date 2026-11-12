// The two keys a Spinbox connection is held to: the certificate the workspace signed for this
// machine's key, which is how its sshd lets a person in (AuthorizedKeysFile none,
// TrustedUserCAKeys: spin's internal/sshauth), and the host key the workspace's launch claim
// names, which is the only key it may answer with.

import { utils, type AuthHandlerResult, type ConnectConfig } from 'ssh2';
import type { ParsedKey as Ssh2StreamsKey } from 'ssh2-streams';
import type { PinnedKey } from './session';

/** ssh2 1.x's parsed key, which the typings this tree pins (ssh2-streams') describe in part. */
export type ParsedKey = Ssh2StreamsKey & { isPrivateKey(): boolean };

const CERT_SUFFIX = '-cert-v01@openssh.com';

// RSA is left out on purpose: ssh2 signs an ssh-rsa key with SHA-1 unless the server lists
// rsa-sha2 for that very key type, which it does not for a certificate, and OpenSSH refuses SHA-1.
const CERTIFIED_TYPES = new Set(['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521']);

/**
 * privateKey, presented as the certificate certificateLine (an id-cert.pub line): offered under
 * the certificate's name and blob, signed with the private key. ssh2 has no certificates of its
 * own; patches/ssh2@1.17.0.patch names the signature by the certified key's algorithm, as
 * OpenSSH expects.
 */
export function certificateKey(privateKey: ParsedKey, certificateLine: string): ParsedKey {
    const [certType, base64] = certificateLine.trim().split(/\s+/);
    if (!certType?.endsWith(CERT_SUFFIX) || !base64) {
        throw new Error('the certificate is not an OpenSSH certificate line');
    }
    const keyType = certType.slice(0, -CERT_SUFFIX.length);
    if (!CERTIFIED_TYPES.has(keyType)) {
        throw new Error(`a ${keyType} certificate cannot be used: Spinbox signs ed25519 and ecdsa keys`);
    }
    if (privateKey.type !== keyType || !privateKey.isPrivateKey()) {
        throw new Error(`the certificate is for a ${keyType} key, and the identity is a ${privateKey.type} key`);
    }
    const blob = Buffer.from(base64, 'base64');
    return Object.create(privateKey, {
        type: { value: certType },
        getPublicSSH: { value: () => blob },
    }) as ParsedKey;
}

/** ssh2's authHandler that offers key, once, and then gives up: there is nothing else to try. */
export function offerOnce(username: string, key: ParsedKey): NonNullable<ConnectConfig['authHandler']> {
    let offered = false;
    return (_methodsLeft, _partialSuccess, callback) => {
        if (offered) {
            return callback(false);
        }
        offered = true;
        const offer: AuthHandlerResult = { type: 'publickey', username, key };
        callback(offer);
    };
}

/** Reads the identity at path as a private key, refusing what is not one. */
export function parsePrivateKey(data: Buffer, path: string): ParsedKey {
    const parsed = utils.parseKey(data);
    const key = (Array.isArray(parsed) ? parsed[0] : parsed) as ParsedKey | Error | undefined;
    if (!key || key instanceof Error || !key.isPrivateKey()) {
        throw new Error(`${path} is not a private key this extension can read${key instanceof Error ? `: ${key.message}` : ''}`);
    }
    return key;
}

/**
 * ssh2's hostVerifier for a connection that may meet only pinned: with no hostHash, ssh2 hands
 * it the key's wire encoding, which has to be pinned's byte for byte.
 */
export function pinnedHostVerifier(pinned: PinnedKey): (key: Buffer) => boolean {
    return (key: Buffer) => Buffer.isBuffer(key) && key.equals(pinned.blob);
}
