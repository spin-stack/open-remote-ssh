import { describe, expect, it } from 'vitest';
import { readCodeAnswer, readSessionAnswer } from '../../src/spin/contract';

const result = { workspace_id: 'w1', host: 'spin.ws', folder_uri: 'vscode-remote://ssh-remote+spin.ws/root', server: 'carried' };

describe('readCodeAnswer', () => {
    it('takes the result after the preparing lines', () => {
        const stdout = [
            JSON.stringify({ preparing: { vscode_version: '1.143.1', vscode_commit: 'c', step: 'publishing' } }),
            JSON.stringify(result),
            '',
        ].join('\n');
        expect(readCodeAnswer(stdout, '', 0)).toEqual({ ok: result });
    });

    it('keeps why the installation could not give the server', () => {
        const stdout = JSON.stringify({ ...result, server: 'missing', not_given: 'the terms are not accepted' });
        expect(readCodeAnswer(stdout, '', 0)).toEqual({ ok: { ...result, server: 'missing', not_given: 'the terms are not accepted' } });
    });

    it('reads a refusal as the envelope the CLI wrote, with its link', () => {
        const envelope = {
            error: {
                code: 'key_not_enrolled', action: 'add_key', workspace_id: 'w1', url: 'https://app/settings/keys',
                message: 'opening a tunnel to workspace w1: refused (403): key not enrolled',
            },
        };
        expect(readCodeAnswer(JSON.stringify(envelope), 'Error: ...', 1)).toEqual({ error: envelope.error });
    });

    // As spin code (v20261112, origin/main) writes it: indented, after the JSON Lines it wrote.
    it('reads an indented envelope after preparing lines', () => {
        const stdout = [
            JSON.stringify({ preparing: { vscode_version: '1.143.1', vscode_commit: 'c', step: 'publishing {x}' } }),
            '{',
            '  "error": {',
            '    "code": "unreachable",',
            '    "message": "getting workspace ws: unavailable: dial tcp 127.0.0.1:1: connect: connection refused \\"}\\"",',
            '    "action": "retry"',
            '  }',
            '}',
            '',
        ].join('\n');
        expect(readCodeAnswer(stdout, 'Error: ...', 1)).toEqual({
            error: { code: 'unreachable', action: 'retry', message: 'getting workspace ws: unavailable: dial tcp 127.0.0.1:1: connect: connection refused "}"' },
        });
    });

    it.each([
        ['no answer at all', '', 'Error: unknown command "code"', 1, 'spin code: Error: unknown command "code"'],
        ['a result with an exit status', JSON.stringify(result), '', 1, 'spin code: it exited 1 and wrote no answer'],
        ['a server state it does not know', JSON.stringify({ ...result, server: 'elsewhere' }), '', 0, 'spin code: it exited 0 and wrote no answer'],
    ])('reads %s as an internal error with what the CLI said', (_name, stdout, stderr, exit, message) => {
        expect(readCodeAnswer(stdout, stderr, exit)).toEqual({ error: { code: 'internal', action: 'details', message } });
    });
});

const session = {
    workspace_id: 'w1', session: 'ORWU6TGORHKIKCHPMWRLHNZSR4', identity: '/home/me/.ssh/id_ed25519',
    certificate: 'ssh-ed25519-cert-v01@openssh.com AAAAcert', host_key: 'ssh-ed25519 AAAAhost',
};

describe('readSessionAnswer', () => {
    // As spin ssh-session writes it: one indented document.
    it('takes the session', () => {
        expect(readSessionAnswer(`${JSON.stringify(session, null, 2)}\n`, 'Opening a session into ws...', 0)).toEqual({ ok: session });
    });

    it('reads a refusal as the envelope the CLI wrote', () => {
        const envelope = { error: { code: 'workspace_stopped', action: 'start', workspace_id: 'w1', message: 'workspace ws is stopped' } };
        expect(readSessionAnswer(JSON.stringify(envelope, null, 2), 'Error: ...', 1)).toEqual({ error: envelope.error });
    });

    it.each([
        ['no answer at all', '', 'Error: unknown command "ssh-session"', 1, 'spin ssh-session: Error: unknown command "ssh-session"'],
        ['a session with an exit status', JSON.stringify(session), '', 1, 'spin ssh-session: it exited 1 and wrote no answer'],
        ['a session with no host key', JSON.stringify({ ...session, host_key: '' }), '', 0, 'spin ssh-session: it exited 0 and wrote no answer'],
        ['a session with no certificate', JSON.stringify({ ...session, certificate: undefined }), '', 0, 'spin ssh-session: it exited 0 and wrote no answer'],
    ])('reads %s as an internal error with what the CLI said', (_name, stdout, stderr, exit, message) => {
        expect(readSessionAnswer(stdout, stderr, exit)).toEqual({ error: { code: 'internal', action: 'details', message } });
    });
});
