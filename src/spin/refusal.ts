// What a person is shown when a workspace does not open: the CLI's own words, and the one thing
// to do about it. The codes are the CLI's (cmd/cli/cmd/errcode.go); `key_not_enrolled` is the
// tunnel's 403 with `Spin-Refused: key-not-enrolled`, and the link it carries is the page that
// enrolls the key.

import type { CliError } from './contract';

export interface Refusal {
    /** The CLI's code, or the resolver's own for what it refuses itself. */
    code: string;
    message: string;
    /** A button: a page to open, or a command to run in a terminal. */
    action?: { title: string; url?: string; command?: string };
    /**
     * Whether trying again as it is can work: VS Code retries a resolve it is told is temporary,
     * and a refusal it would only meet again is said once instead.
     */
    temporary: boolean;
}

export class SpinRefusal extends Error {
    constructor(readonly refusal: Refusal) {
        super(refusal.message);
    }
}

export function refusalOf(e: CliError): Refusal {
    const r = (action: Refusal['action'], temporary = false): Refusal => ({ code: e.code, message: e.message, action, temporary });
    switch (e.code) {
        case 'key_not_enrolled':
            return r(e.url ? { title: 'Add This Machine\'s Key', url: e.url } : { title: 'Add This Machine\'s Key', command: 'spin ssh-key add' });
        case 'not_signed_in':
            return r({ title: 'Sign In', command: 'spin login' });
        case 'cli_outdated':
            return r({ title: 'Update spin', command: 'spin update' });
        case 'workspace_stopped':
            return r(undefined);
        case 'workspace_failed':
            return r(e.url ? { title: 'Open the Dashboard', url: e.url } : undefined);
        case 'no_capacity':
        case 'unreachable':
            return r(undefined, true);
        default:
            return r(e.url ? { title: 'Details', url: e.url } : undefined);
    }
}
