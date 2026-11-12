import { describe, expect, it } from 'vitest';
import { parseSpinAuthority } from '../../src/spin/authority';

describe('parseSpinAuthority', () => {
    it.each([
        ['spin+my-ws', 'my-ws'],
        ['spin+0192f3a4_b', '0192f3a4_b'],
    ])('%s opens workspace %s', (authority, workspace) => {
        expect(parseSpinAuthority(authority)).toEqual({ workspace });
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
