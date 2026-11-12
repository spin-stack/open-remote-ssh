// The remote authority a Spinbox workspace opens under: `spin+<workspace>`.

export const SPIN_AUTHORITY = 'spin';

// The CLI's own rule for a workspace name it reaches over ssh (cmd/cli/cmd/sshconfig.go
// hostSafeRe): anything else is no workspace, and is passed to no command.
const WORKSPACE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export interface SpinAuthority {
    /** The workspace's name or id, as the CLI takes it. */
    workspace: string;
}

export function parseSpinAuthority(authority: string): SpinAuthority {
    const [scheme, workspace, ...rest] = authority.split('+');
    if (scheme !== SPIN_AUTHORITY || workspace === undefined || rest.length > 0 || !WORKSPACE.test(workspace)) {
        throw new Error(`'${authority}' is not a Spinbox workspace: one is spin+<workspace>, a name of letters, digits, '-' and '_'`);
    }
    return { workspace };
}
