// Starts, in the workspace, the VS Code server the installation publishes for this editor's
// commit: one disk per commit, mounted at /run/spin-stack/vsc-<12 hex>, the server under
// servers/<commit>/server (spin's internal/vm/guestpath). Nothing here downloads one: a
// workspace without it is refused with what to do, since `spin code` already asked the
// installation for it.

const EXTENSIONS_DIR = '/run/spin-stack';
const COMMIT = /^[0-9a-f]{40}$/;

export function carriedServer(commit: string): string {
    if (!COMMIT.test(commit)) {
        throw new Error(`'${commit}' is not a VS Code commit`);
    }
    return `${EXTENSIONS_DIR}/vsc-${commit.slice(0, 12)}/servers/${commit}/server/bin/code-server`;
}

/** Exit codes the script reports, besides 0. */
export const SERVER_MISSING = 2;
export const SERVER_DID_NOT_START = 3;

/**
 * The script, for `sh -c`: it reuses this commit's server when one runs (a reconnect), and
 * otherwise starts it on a fresh port and token, both kept under ~/.vscode-server/spinbox so
 * only root reads them. It answers between `<id>: start` and `<id>: end` as `key==value==`
 * lines, as jeanp413/open-remote-ssh's server-setup.sh does.
 */
export function serverStartScript(commit: string, id: string): string {
    const server = escapeShellArg(carriedServer(commit));
    const dir = `"$HOME/.vscode-server/spinbox/${commit}"`;
    return [
        'umask 077',
        `answer() { echo "${id}: start"; echo "exitCode==$1=="; echo "listeningOn==$2=="; echo "connectionToken==$3=="; echo "${id}: end"; exit 0; }`,
        `S=${server}`,
        `[ -x "$S" ] || answer ${SERVER_MISSING} "" ""`,
        `D=${dir}`,
        'mkdir -p "$D" || answer 1 "" ""',
        'if [ -f "$D/pid" ] && kill -0 "$(cat "$D/pid")" 2>/dev/null; then',
        '  P=$(sed -n "s/.*Extension host agent listening on \\([0-9][0-9]*\\).*/\\1/p" "$D/log" | tail -n 1)',
        '  [ -n "$P" ] && answer 0 "$P" "$(cat "$D/token")"',
        '  kill "$(cat "$D/pid")" 2>/dev/null',
        'fi',
        'head -c 32 /dev/urandom | od -An -tx1 | tr -d " \\n" > "$D/token"',
        'rm -f "$D/log"',
        '"$S" --start-server --host=127.0.0.1 --port=0 --connection-token-file "$D/token" --telemetry-level off --enable-remote-auto-shutdown --accept-server-license-terms > "$D/log" 2>&1 &',
        'echo $! > "$D/pid"',
        'i=0',
        'while [ $i -lt 120 ]; do',
        '  P=$(sed -n "s/.*Extension host agent listening on \\([0-9][0-9]*\\).*/\\1/p" "$D/log" | tail -n 1)',
        '  [ -n "$P" ] && answer 0 "$P" "$(cat "$D/token")"',
        '  kill -0 "$(cat "$D/pid")" 2>/dev/null || break',
        '  sleep 0.5; i=$((i+1))',
        'done',
        `answer ${SERVER_DID_NOT_START} "" ""`,
    ].join('\n');
}

export interface StartedServer {
    port: number;
    connectionToken: string;
}

export class ServerStartError extends Error { }

/** Reads the script's answer, refusing a server it could not find or start. */
export function readServerStart(stdout: string, id: string, commit: string): StartedServer {
    const answer = readAnswer(stdout, id);
    if (!answer) {
        throw new ServerStartError('the workspace did not answer the server start');
    }
    const exitCode = Number(answer.exitCode);
    if (exitCode === SERVER_MISSING) {
        throw new ServerStartError(`this workspace does not carry the server for VS Code ${commit}: the installation has not published it to it`);
    }
    const port = Number(answer.listeningOn);
    if (exitCode !== 0 || !Number.isInteger(port) || port <= 0 || !answer.connectionToken) {
        throw new ServerStartError(`the VS Code server did not start in the workspace (exit ${answer.exitCode}): its log is ~/.vscode-server/spinbox/${commit}/log`);
    }
    return { port, connectionToken: answer.connectionToken };
}

// A value may hold "==" itself: only the last one ends it.
const ANSWER_LINE = /^(\w+)==(.*)==$/;

/** The `key==value==` lines between `<id>: start` and `<id>: end`, or undefined without both. */
function readAnswer(stdout: string, id: string): Record<string, string> | undefined {
    const start = `${id}: start`;
    const from = stdout.indexOf(start);
    const to = from < 0 ? -1 : stdout.indexOf(`${id}: end`, from + start.length);
    if (to < 0) {
        return undefined;
    }
    const answer: Record<string, string> = {};
    for (const line of stdout.slice(from + start.length, to).split(/\r?\n/)) {
        const match = ANSWER_LINE.exec(line);
        if (match) {
            answer[match[1]] = match[2];
        }
    }
    return answer;
}

/** The command that runs script with sh in the workspace, quoted for ssh's exec. */
export function shCommand(script: string): string {
    return `sh -c ${escapeShellArg(script)}`;
}

/** value as one POSIX shell word: single-quoted, each ' inside closed, escaped and reopened. */
export function escapeShellArg(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
