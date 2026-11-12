import { describe, expect, it } from 'vitest';
import { parseSpinAuthority } from '../../src/spin/authority';

describe('parseSpinAuthority', () => {
    it.each([
        ['spin+my-ws', 'my-ws', 'spin.my-ws'],
        ['spin+0192f3a4_b', '0192f3a4_b', 'spin.0192f3a4_b'],
    ])('%s opens workspace %s as host %s', (authority, workspace, host) => {
        expect(parseSpinAuthority(authority)).toEqual({ workspace, host });
    });

    it.each([
        'ssh-remote+my-ws',
        'spin',
        'spin+',
        'spin+-leading-dash',
        'spin+a.b',
        'spin+a/../b',
        'spin+a b',
        'spin+a+b',
        "spin+a';rm",
    ])('refuses %s', (authority) => {
        expect(() => parseSpinAuthority(authority)).toThrow(/not a Spinbox workspace/);
    });
});
