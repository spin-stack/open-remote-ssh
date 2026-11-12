import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { carriedServer, readServerStart, serverStartScript, shCommand } from '../../src/spin/serverStart';

const COMMIT = 'e646868227c3e3a9e3f24277c8c7220be42c0be7';
const ID = 'spin-test';

describe('carriedServer', () => {
    it('is the server on the commit\'s extension disk', () => {
        expect(carriedServer(COMMIT)).toBe(`/run/spin-stack/vsc-e646868227c3/servers/${COMMIT}/server/bin/code-server`);
    });

    it.each(['', 'e646868', `${COMMIT}0`, `${COMMIT.slice(0, 39)}/`, 'E646868227C3E3A9E3F24277C8C7220BE42C0BE7'])('refuses %j as a commit', (commit) => {
        expect(() => carriedServer(commit)).toThrow(/not a VS Code commit/);
    });
});

describe('the start script, run by sh', () => {
    let home: string;
    beforeEach(() => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'spin-start-'));
    });
    afterEach(() => {
        fs.rmSync(home, { recursive: true, force: true });
    });

    // ssh's exec hands the command to the login shell, which runs sh -c: the same here.
    function run(): string {
        return execFileSync('/bin/sh', ['-c', shCommand(serverStartScript(COMMIT, ID))], { env: { HOME: home, PATH: process.env.PATH }, encoding: 'utf8' });
    }

    // The run below stops at the first answer; the start path after it is the e2e harness's
    // (test/e2e), but sh has to read all of it.
    it('is a script sh reads whole', () => {
        expect(() => execFileSync('/bin/sh', ['-n', '-c', serverStartScript(COMMIT, ID)])).not.toThrow();
    });

    it('refuses a workspace without the server, downloading nothing', () => {
        const out = run();
        expect(() => readServerStart(out, ID, COMMIT)).toThrow(/does not carry the server for VS Code/);
        // Nothing was made: a missing server is not one to fetch.
        expect(fs.readdirSync(home)).toEqual([]);
    });
});

describe('readServerStart', () => {
    const answer = (lines: string[]) => [`${ID}: start`, ...lines, `${ID}: end`].join('\n');

    it('reads the port and the token', () => {
        expect(readServerStart(answer(['exitCode==0==', 'listeningOn==40123==', 'connectionToken==abc==']), ID, COMMIT))
            .toEqual({ port: 40123, connectionToken: 'abc' });
    });

    it.each([
        ['no answer', 'sh: 1: syntax error', /did not answer/],
        ['a server that did not start', answer(['exitCode==3==', 'listeningOn====', 'connectionToken====']), /did not start in the workspace \(exit 3\)/],
        ['a port that is not one', answer(['exitCode==0==', 'listeningOn==/tmp/sock==', 'connectionToken==abc==']), /did not start/],
        ['no token', answer(['exitCode==0==', 'listeningOn==40123==', 'connectionToken====']), /did not start/],
    ])('refuses %s', (_name, out, error) => {
        expect(() => readServerStart(out, ID, COMMIT)).toThrow(error);
    });
});
