import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sshOptions } from '../../src/spin/connection';
import { checkBanner, checkOpenSSH } from '../../src/spin/openssh';
import { SpinRefusal } from '../../src/spin/refusal';

// A workspace's sshd accepts mlkem768x25519-sha256 alone (spin-stack/spin-machine#245), which
// OpenSSH has from 9.9: an older ssh is refused before anything is asked, in words that say why,
// and every ssh this extension runs asks for it and is held to the claim's host key.

function refusalOf(f: () => unknown) {
    try {
        f();
    } catch (e) {
        if (e instanceof SpinRefusal) {
            return e.refusal;
        }
        throw e;
    }
    return undefined;
}

describe('checkBanner', () => {
    it.each([
        ['Ubuntu 24.04\'s', 'OpenSSH_9.6p1 Ubuntu-3ubuntu13.20, OpenSSL 3.0.13 30 Jan 2024', 'ssh is OpenSSH 9.6 (OpenSSH_9.6p1 Ubuntu-3ubuntu13.20)'],
        ['the last without it', 'OpenSSH_9.8p1, LibreSSL 3.3.6', 'ssh is OpenSSH 9.8 (OpenSSH_9.8p1)'],
        ['Windows\'', 'OpenSSH_for_Windows_9.5p1, LibreSSL 3.8.2', 'ssh is OpenSSH 9.5 (OpenSSH_for_Windows_9.5p1)'],
        ['an old major', 'OpenSSH_8.9p1 Ubuntu-3ubuntu0.10, OpenSSL 3.0.2 15 Mar 2022', 'ssh is OpenSSH 8.9'],
    ])('refuses %s, saying what it is, what is needed and why', (_name, banner, says) => {
        const refusal = refusalOf(() => checkBanner(`${banner}\n`));
        expect(refusal?.code).toBe('ssh_outdated');
        expect(refusal?.temporary).toBe(false);
        expect(refusal?.message).toContain(says);
        expect(refusal?.message).toContain('a workspace needs OpenSSH 9.9 or newer');
        expect(refusal?.message).toContain('post-quantum key exchange mlkem768x25519-sha256');
        expect(refusal?.message).toContain('refuses older clients');
    });

    it.each([
        ['macOS\'s 9.9', 'OpenSSH_9.9p2, LibreSSL 3.3.6'],
        ['Windows\' 9.9', 'OpenSSH_for_Windows_9.9p1, LibreSSL 3.8.2'],
        ['a 10', 'OpenSSH_10.2p1 Ubuntu-2ubuntu3.8, OpenSSL 3.5.5 27 Jan 2026'],
        ['a minor past 9', 'OpenSSH_9.10p1'],
    ])('lets %s through, saying nothing', (_name, banner) => {
        expect(checkBanner(banner)).toEqual({});
    });

    it.each([['not OpenSSH', 'Dropbear v2024.86'], ['nothing', '']])('lets %s through, warned', (_name, banner) => {
        expect(checkBanner(banner).warning).toMatch(/^could not tell which OpenSSH ssh is .*no matching key exchange method found/);
    });
});

describe('checkOpenSSH', () => {
    let bin: string;
    beforeEach(() => {
        bin = fs.mkdtempSync(path.join(os.tmpdir(), 'spin-openssh-'));
    });
    afterEach(() => {
        fs.rmSync(bin, { recursive: true, force: true });
    });

    function ssh(banner: string) {
        fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh\necho '${banner}' >&2\n`, { mode: 0o755 });
    }

    it('asks the ssh on the PATH, and asks again after a refusal, as the refusal says to', async () => {
        ssh('OpenSSH_9.6p1 Ubuntu-3ubuntu13.20, OpenSSL 3.0.13 30 Jan 2024');
        await expect(checkOpenSSH({ PATH: bin })).rejects.toMatchObject({ refusal: { code: 'ssh_outdated' } });
        ssh('OpenSSH_10.2p1, OpenSSL 3.5.5 27 Jan 2026');
        await expect(checkOpenSSH({ PATH: bin })).resolves.toEqual({});
    });

    it('refuses a PATH with no ssh', async () => {
        await expect(checkOpenSSH({ PATH: bin })).rejects.toMatchObject({ refusal: { code: 'ssh_not_found' } });
    });
});

describe('sshOptions', () => {
    const options = sshOptions(
        { proxyCommand: '\'/opt/spin\' tunnel \'ABC\'', identity: '/home/me/.ssh/id_ed25519' },
        { knownHosts: '/tmp/spinbox-x/known_hosts', certificate: '/tmp/spinbox-x/id-cert.pub', controlPath: '/tmp/spinbox-x/mux' },
    );

    function option(name: string): string | undefined {
        const at = options.findIndex((o, i) => options[i - 1] === '-o' && o.startsWith(`${name}=`));
        return at < 0 ? undefined : options[at].slice(name.length + 1);
    }

    it('asks for ML-KEM alone, carried by the tunnel', () => {
        expect(option('KexAlgorithms')).toBe('mlkem768x25519-sha256');
        expect(option('ProxyCommand')).toBe('\'/opt/spin\' tunnel \'ABC\'');
    });

    it('accepts the one host key it was given, from the one file it is in, and learns none', () => {
        expect(option('UserKnownHostsFile')).toBe('/tmp/spinbox-x/known_hosts');
        expect(option('GlobalKnownHostsFile')).toBe('/dev/null');
        expect(option('StrictHostKeyChecking')).toBe('yes');
        expect(option('UpdateHostKeys')).toBe('no');
        expect(option('HostKeyAlias')).toBe('spinbox-workspace');
    });

    it('logs in with the certificate alone, asking nobody, and reads no config of the person\'s', () => {
        expect(options.slice(0, 2)).toEqual(['-F', '/dev/null']);
        expect(options[options.indexOf('-i') + 1]).toBe('/home/me/.ssh/id_ed25519');
        expect(option('CertificateFile')).toBe('/tmp/spinbox-x/id-cert.pub');
        expect(option('IdentitiesOnly')).toBe('yes');
        expect(option('BatchMode')).toBe('yes');
    });

    it('doubles a % in what ssh would read as a token', () => {
        const odd = sshOptions({ proxyCommand: '\'/opt/100%/spin\' tunnel \'ABC\'', identity: '/home/me/%u' },
            { knownHosts: '/k', certificate: '/c', controlPath: '/m' });
        expect(odd).toContain('ProxyCommand=\'/opt/100%%/spin\' tunnel \'ABC\'');
        expect(odd[odd.indexOf('-i') + 1]).toBe('/home/me/%%u');
    });
});
