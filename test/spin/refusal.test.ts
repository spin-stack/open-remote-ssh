import { describe, expect, it } from 'vitest';
import { refusalOf } from '../../src/spin/refusal';

describe('refusalOf', () => {
    it.each([
        ['key_not_enrolled', 'https://app/settings/keys', { title: 'Add This Machine\'s Key', url: 'https://app/settings/keys' }, false],
        ['key_not_enrolled', undefined, { title: 'Add This Machine\'s Key', command: 'spin ssh-key add' }, false],
        ['not_signed_in', undefined, { title: 'Sign In', command: 'spin login' }, false],
        ['cli_outdated', undefined, { title: 'Update spin', command: 'spin update' }, false],
        ['workspace_failed', 'https://app/w/1', { title: 'Open the Dashboard', url: 'https://app/w/1' }, false],
        ['workspace_stopped', undefined, undefined, false],
        ['no_capacity', undefined, undefined, true],
        ['unreachable', undefined, undefined, true],
        ['internal', undefined, undefined, false],
        ['no_vscode_server', 'https://app/admin', { title: 'Details', url: 'https://app/admin' }, false],
    ])('%s (url %s) offers %j, temporary %s', (code, url, action, temporary) => {
        const e = { code, message: `the CLI's words for ${code}`, action: 'x', ...(url ? { url } : {}) };
        expect(refusalOf(e)).toEqual({ code, message: `the CLI's words for ${code}`, action, temporary });
    });
});
