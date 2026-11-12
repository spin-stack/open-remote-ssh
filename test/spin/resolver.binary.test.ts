import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spinBinary } from '../../src/spin/resolver';

describe('spinBinary', () => {
    let spinbox: string;
    beforeEach(() => {
        spinbox = fs.mkdtempSync(path.join(os.tmpdir(), 'spinbox-ext-'));
        fs.mkdirSync(path.join(spinbox, 'bin', 'linux-x64'), { recursive: true });
        fs.writeFileSync(path.join(spinbox, 'bin', 'linux-x64', 'spin'), '');
    });
    afterEach(() => {
        fs.rmSync(spinbox, { recursive: true, force: true });
    });

    it('runs the setting when it is set', () => {
        expect(spinBinary('/opt/spin', spinbox, 'linux', 'x64')).toBe('/opt/spin');
    });

    it('runs the CLI the Spinbox extension carries for this platform', () => {
        expect(spinBinary('', spinbox, 'linux', 'x64')).toBe(path.join(spinbox, 'bin', 'linux-x64', 'spin'));
    });

    it.each([
        ['without the Spinbox extension', undefined, 'x64'],
        ['when it carries no CLI for this platform', 'spinbox', 'arm64'],
    ])('runs spin on the PATH %s', (_name, ext, arch) => {
        expect(spinBinary('', ext && spinbox, 'linux', arch)).toBe('spin');
    });
});
