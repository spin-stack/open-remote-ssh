import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SpinCli } from '../../src/spin/cli';
import { openWorkspace } from '../../src/spin/open';
import { SpinRefusal } from '../../src/spin/refusal';

// The refusals the real CLI gives before there is any installation to ask: the CLI alone
// (SPIN_E2E_CLI), no stack. What the person is shown is the CLI's own words and action.

const cliPath = process.env.SPIN_E2E_CLI ?? '';
const COMMIT = 'e646868227c3e3a9e3f24277c8c7220be42c0be7';

let home: string;
beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'spin-cli-e2e-'));
});
afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
});

async function refusal(start: boolean) {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
    for (const name of ['SPIN_ENDPOINT', 'SPIN_TOKEN', 'SPIN_PROFILE']) {
        delete env[name];
    }
    try {
        await openWorkspace({
            cli: new SpinCli(cliPath, env), workspace: 'ws', host: 'spin.ws', commit: COMMIT, start,
            home, pid: process.pid, log: () => undefined,
        });
    } catch (e) {
        if (e instanceof SpinRefusal) {
            return e.refusal;
        }
        throw e;
    }
    throw new Error('the workspace opened');
}

describe('the real spin CLI with no installation', () => {
    it('is given', () => {
        expect(cliPath, 'SPIN_E2E_CLI: a spin CLI').toBeTruthy();
    });

    it('says to sign in when there is no profile', async () => {
        expect(await refusal(true)).toEqual({
            code: 'not_signed_in',
            message: 'not logged in: run \'spin login\', or set SPIN_ENDPOINT and SPIN_TOKEN',
            action: { title: 'Sign In', command: 'spin login' },
            temporary: false,
        });
    });

    it('says an installation that does not answer is unreachable, to try again', async () => {
        fs.mkdirSync(path.join(home, '.spin'));
        fs.writeFileSync(path.join(home, '.spin', 'config.yaml'), 'profiles:\n  default:\n    endpoint: http://127.0.0.1:1\n    token: st_x\n');
        const r = await refusal(false);
        expect(r.code).toBe('unreachable');
        expect(r.temporary).toBe(true);
        expect(r.message).toMatch(/connection refused/);
    }, 5 * 60_000);
});
