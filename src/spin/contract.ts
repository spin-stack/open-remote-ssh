// What the spin CLI answers with `-o json` (spin-stack/spin#833): one JSON object on stdout and
// exit 0, or an error envelope on stdout and exit 1. `spin code` writes JSON Lines - a
// `{"preparing": ...}` line while the installation prepares the server, then its result - so its
// answer is its last line.

/** `spin code <workspace> --no-open --vscode-commit <commit> -o json`. */
export interface CodeResult {
    workspace_id: string;
    host: string;
    folder_uri: string;
    /**
     * Where the workspace's server for that commit is: `carried` on the extension disk the
     * installation publishes, `downloaded` by an earlier client into $HOME, or `missing`.
     */
    server: 'carried' | 'downloaded' | 'missing';
    /** Why the installation could not give the workspace the server, when it could not. */
    not_given?: string;
}

/** The CLI's error envelope (cmd/cli/cmd/errcode.go). */
export interface CliError {
    code: string;
    message: string;
    action: string;
    release?: string;
    workspace_id?: string;
    url?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asCliError(value: unknown): CliError | undefined {
    if (!isRecord(value) || !isRecord(value.error)) {
        return undefined;
    }
    const e = value.error;
    if (typeof e.code !== 'string' || typeof e.message !== 'string' || typeof e.action !== 'string') {
        return undefined;
    }
    const out: CliError = { code: e.code, message: e.message, action: e.action };
    for (const key of ['release', 'workspace_id', 'url'] as const) {
        if (typeof e[key] === 'string') {
            out[key] = e[key];
        }
    }
    return out;
}

/**
 * The last JSON object a command wrote, or undefined when it wrote none. `spin code` writes JSON
 * Lines and its envelope indented, so stdout is objects one after another, each of any number
 * of lines: they are told apart by their braces, outside strings.
 */
function lastObject(stdout: string): unknown {
    let last: unknown;
    let depth = 0;
    let start = -1;
    let inString = false;
    for (let i = 0; i < stdout.length; i++) {
        const c = stdout[i];
        if (inString) {
            if (c === '\\') {
                i++;
            } else if (c === '"') {
                inString = false;
            }
        } else if (c === '"') {
            inString = depth > 0;
        } else if (c === '{') {
            if (depth++ === 0) {
                start = i;
            }
        } else if (c === '}' && depth > 0 && --depth === 0) {
            try {
                last = JSON.parse(stdout.slice(start, i + 1));
            } catch {
                // Not JSON after all: what came before stands.
            }
        }
    }
    return last;
}

export type Answer<T> = { ok: T } | { error: CliError };

/**
 * Reads `spin code`'s answer. An envelope is the CLI's refusal; anything else that is not a
 * result is a CLI this extension does not understand, said with what it wrote on stderr.
 */
export function readCodeAnswer(stdout: string, stderr: string, exitCode: number | null): Answer<CodeResult> {
    const last = lastObject(stdout);
    const error = asCliError(last);
    if (error) {
        return { error };
    }
    if (exitCode === 0 && isRecord(last)
        && typeof last.workspace_id === 'string' && typeof last.host === 'string'
        && typeof last.folder_uri === 'string'
        && (last.server === 'carried' || last.server === 'downloaded' || last.server === 'missing')) {
        const result: CodeResult = {
            workspace_id: last.workspace_id, host: last.host, folder_uri: last.folder_uri, server: last.server,
        };
        if (typeof last.not_given === 'string') {
            result.not_given = last.not_given;
        }
        return { ok: result };
    }
    const said = stderr.trim().split(/\r?\n/).pop() || `it exited ${exitCode} and wrote no answer`;
    return { error: { code: 'internal', action: 'details', message: `spin code: ${said}` } };
}
