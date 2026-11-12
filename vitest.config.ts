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
    },
    resolve: {
        alias: {
            vscode: path.resolve(__dirname, 'test/mocks/vscode.ts'),
        },
    },
});
