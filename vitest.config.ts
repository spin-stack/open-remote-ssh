import * as path from 'path';
import { defineConfig } from 'vitest/config';

// The unit tests, in Node. The `vscode` module exists only in the extension host, so it is
// test/mocks/vscode.ts here.
export default defineConfig({
    test: {
        include: ['test/**/*.test.ts'],
        // test:e2e's, which need spin's e2e stack.
        exclude: ['test/e2e/**'],
        environment: 'node',
        coverage: {
            provider: 'v8',
            // Every file under src/, so one no unit test imports counts as uncovered rather than
            // absent.
            include: ['src/**'],
            // json-summary is what CI's job summary reads (hack/coverage-summary.mjs);
            // reportOnFailure keeps a red suite from leaving it nothing to read.
            reporter: ['text', 'json-summary', 'html'],
            reportOnFailure: true,
            // A floor below the 92.0% of statements measured on 2026-11-14. Raise it when the
            // number has moved up and stayed; never lower it to let a change through.
            thresholds: { statements: 90 },
        },
    },
    resolve: {
        alias: {
            vscode: path.resolve(__dirname, 'test/mocks/vscode.ts'),
        },
    },
});
