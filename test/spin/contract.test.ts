import { describe, expect, it } from 'vitest';
import { readCodeAnswer } from '../../src/spin/contract';

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
