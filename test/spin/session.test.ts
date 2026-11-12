import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hostDir, readIdentity, readLeft, readPinnedHostKey } from '../../src/spin/session';

// A real ed25519 public key (ssh-keygen), as ssh-prepare writes it after the launch claim.
const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
const RSA = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQDDHr/jh2Jy4yALcK4JyWbVkPRaWmhck3IgCoeOO3z1e2dBowLh64QAM+Qb72pxekALga2oi4GvT+TlWNhzPH4V';

let home: string;
beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'spin-session-'));
});
afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
});

function write(rel: string, body: string) {
    const file = path.join(home, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
}

describe('readIdentity', () => {
    it('reads the IdentityFile spin wrote, unquoted', () => {
        write('.spin/ssh/config', 'Match host spin.* exec "exec spin ssh-prepare --identity /k %h"\n  User root\n  IdentityFile "/home/me/.ssh/id_ed25519"\n');
        expect(readIdentity(home)).toBe('/home/me/.ssh/id_ed25519');
    });

    it('says to run spin when there is no config', () => {
        expect(() => readIdentity(home)).toThrow(/spin code writes it/);
    });
});

describe('readLeft', () => {
    const dir = () => hostDir(home, 'spin.ws');

    it('finds the session left for this pid', () => {
        write('.spin/ssh/hosts/spin.ws/42.tunnel', 'wss://x');
        expect(readLeft(dir(), 42)).toEqual({ session: true });
    });

    it('splits a failure into the fix and what failed', () => {
        write('.spin/ssh/hosts/spin.ws/42.error', 'Add the key this machine logs in with: spin ssh-key add\nrefused (403): key not enrolled');
        expect(readLeft(dir(), 42)).toEqual({
            session: false, fix: 'Add the key this machine logs in with: spin ssh-key add', failure: 'refused (403): key not enrolled',
        });
    });

    it('does not take another process\'s session', () => {
        write('.spin/ssh/hosts/spin.ws/41.tunnel', 'wss://x');
        expect(readLeft(dir(), 42)).toBeUndefined();
    });
});

describe('readPinnedHostKey', () => {
    const dir = () => hostDir(home, 'spin.ws');

    it('reads the one key under the comment as its wire encoding', () => {
        write('.spin/ssh/hosts/spin.ws/known_hosts', `# spin: workspace w1\nspin.ws ${KEY}\n`);
        const key = readPinnedHostKey(dir(), 'spin.ws');
        expect(key.type).toBe('ssh-ed25519');
        expect(key.blob.equals(Buffer.from(KEY.split(' ')[1], 'base64'))).toBe(true);
    });

    it.each([
        ['no key', '# spin: workspace w1\n', /holds 0 host keys/],
        ['two keys', `spin.ws ${KEY}\nspin.ws ${RSA}\n`, /holds 2 host keys/],
        ['another host\'s key', `spin.other ${KEY}\n`, /does not hold one key for spin.ws/],
        ['a key under another type', `spin.ws ssh-rsa ${KEY.split(' ')[1]}\n`, /is not a ssh-rsa key/],
    ])('refuses %s', (_name, body, error) => {
        write('.spin/ssh/hosts/spin.ws/known_hosts', body);
        expect(() => readPinnedHostKey(dir(), 'spin.ws')).toThrow(error);
    });
});
