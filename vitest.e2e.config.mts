import * as path from "node:path"
import { defineConfig } from "vitest/config"

// task test:e2e: the resolver against spin's e2e stack and the real CLI (test/e2e/).
export default defineConfig({
  test: {
    include: ["test/e2e/**/*.e2e.test.ts"],
    environment: "node",
    // One stack, one workspace: the cases run in order, and the reconnect needs the first open.
    sequence: { concurrent: false },
    fileParallelism: false,
  },
  resolve: {
    alias: {
      vscode: path.resolve(import.meta.dirname, "test/mocks/vscode.ts"),
    },
  },
})
