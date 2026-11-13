// Bundles the extension into lib/extension.js. vscode is VS Code's own, never bundled.
import { build } from "esbuild"

await build({
  entryPoints: ["src/extension.ts"],
  outfile: "lib/extension.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["vscode"],
  sourcemap: false,
  minify: true,
  logLevel: "warning",
})
