// The remote authority a Spinbox workspace opens under: `spin+<workspace>`, which the spin CLI
// knows as the ssh host `spin.<workspace>`.

export const SPIN_AUTHORITY = 'spin';

const HOST_PREFIX = 'spin.';

// The CLI's own rule for a workspace that is an ssh host (cmd/cli/cmd/sshconfig.go hostSafeRe):
// what it writes under ~/.spin/ssh/hosts/ and passes to ssh, so nothing else may reach it.
const WORKSPACE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export interface SpinAuthority {
    /** The workspace's name or id, as the CLI takes it. */
    workspace: string;
    /** The ssh host the CLI keeps the workspace's session, key and certificate under. */
    host: string;
}

export function parseSpinAuthority(authority: string): SpinAuthority {
    const [scheme, workspace, ...rest] = authority.split('+');
    if (scheme !== SPIN_AUTHORITY || workspace === undefined || rest.length > 0 || !WORKSPACE.test(workspace)) {
        throw new Error(`'${authority}' is not a Spinbox workspace: one is spin+<workspace>, a name of letters, digits, '-' and '_'`);
    }
    return { workspace, host: HOST_PREFIX + workspace };
}
