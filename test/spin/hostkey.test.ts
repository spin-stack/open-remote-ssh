import { describe, expect, it } from 'vitest';
import { parseHostKey } from '../../src/spin/keys';

// A real ed25519 public key (ssh-keygen), as ssh-session answers it after the launch claim.
const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
const RSA = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQDDHr/jh2Jy4yALcK4JyWbVkPRaWmhck3IgCoeOO3z1e2dBowLh64QAM+Qb72pxekALga2oi4GvT+TlWNhzPH4V';

describe('parseHostKey', () => {
    it('reads the one key as its wire encoding', () => {
        const key = parseHostKey(KEY);
        expect(key.type).toBe('ssh-ed25519');
        expect(key.blob.equals(Buffer.from(KEY.split(' ')[1], 'base64'))).toBe(true);
    });

    it.each([
        ['no key', '', /is not one key/],
        ['a type alone', 'ssh-ed25519', /is not one key/],
        ['two keys', `${KEY}\n${RSA}`, /is not one key/],
        ['a key under another type', `ssh-rsa ${KEY.split(' ')[1]}`, /is not a ssh-rsa key/],
    ])('refuses %s', (_name, line, error) => {
        expect(() => parseHostKey(line)).toThrow(error);
    });
});
