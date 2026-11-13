// The OpenSSH a Spinbox connection runs. A workspace's sshd accepts one key exchange,
// mlkem768x25519-sha256 (spin-stack/spin-machine#245): post-quantum, at what a curve25519 login
// costs. OpenSSH has it from 9.9, and an older client is refused with "no matching key exchange
// method found", which says nothing of why - so the version is asked first, and an older one is
// refused here in words that do, as the spin CLI refuses it (cmd/cli/remote/openssh.go).

import { execFile } from 'child_process';
import { SpinRefusal } from './refusal';

export const KEX_ALGORITHM = 'mlkem768x25519-sha256';

const MIN_OPENSSH = { major: 9, minor: 9 };
const MIN = `${MIN_OPENSSH.major}.${MIN_OPENSSH.minor}`;

/** The version in what `ssh -V` prints: OpenSSH_9.6p1 Ubuntu-..., OpenSSH_9.9p2, OpenSSH_for_Windows_9.5p1. */
const OPENSSH = /\bOpenSSH(?:_for_Windows)?_(\d+)\.(\d+)/;

/**
 * What `ssh -V` printing banner means for connecting: a refusal of an OpenSSH older than 9.9, and
 * a warning where banner names no OpenSSH version at all. That one is let through: a client this
 * cannot read - a vendor's build, a wrapper - may well negotiate the key exchange, and refusing it
 * would lock out somebody whose ssh works; the warning says what its refusal would mean.
 */
export function checkBanner(banner: string): { warning?: string } {
    const said = banner.trim();
    const match = OPENSSH.exec(said);
    if (!match) {
        return {
            warning: `could not tell which OpenSSH ssh is (ssh -V said ${JSON.stringify(said)}). A workspace accepts only the `
                + `post-quantum key exchange ${KEX_ALGORITHM}, which OpenSSH has from ${MIN}: an older ssh is refused with `
                + '"no matching key exchange method found"',
        };
    }
    const major = Number(match[1]);
    const minor = Number(match[2]);
    if (major < MIN_OPENSSH.major || (major === MIN_OPENSSH.major && minor < MIN_OPENSSH.minor)) {
        throw new SpinRefusal({
            code: 'ssh_outdated',
            message: `ssh is OpenSSH ${major}.${minor} (${said.split(',')[0]}); a workspace needs OpenSSH ${MIN} or newer. `
                + `Its sshd accepts only the post-quantum key exchange ${KEX_ALGORITHM}, which OpenSSH added in ${MIN}, `
                + 'and refuses older clients. Update OpenSSH (on macOS, \'brew install openssh\') and open the workspace again.',
            temporary: false,
        });
    }
    return {};
}

/**
 * Each PATH's ssh, asked once: a reconnect does not ask again. A refusal is not kept, so an ssh
 * updated after it is asked again on the next open, as the refusal says to.
 */
const checked = new Map<string, Promise<{ warning?: string }>>();

/**
 * Refuses the ssh env's PATH runs when it cannot connect to a workspace - none, or one older than
 * OpenSSH 9.9 - before anything is asked of the installation. One whose version it cannot read
 * passes, with a warning to log.
 */
export function checkOpenSSH(env: NodeJS.ProcessEnv): Promise<{ warning?: string }> {
    const key = env.PATH ?? '';
    let check = checked.get(key);
    if (!check) {
        check = new Promise((resolve, reject) => {
            // -V prints to stderr, and exits 0.
            execFile('ssh', ['-V'], { env, timeout: 10_000 }, (err, stdout, stderr) => {
                if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
                    return reject(new SpinRefusal({
                        code: 'ssh_not_found',
                        message: `a workspace is reached with OpenSSH ${MIN} or newer, and there is no ssh on this machine's PATH`,
                        temporary: false,
                    }));
                }
                try {
                    resolve(checkBanner(`${stderr}${stdout}`));
                } catch (e) {
                    reject(e);
                }
            });
        });
        checked.set(key, check);
        check.catch(() => checked.delete(key));
    }
    return check;
}
