// Bundles the extension into lib/extension.js. vscode is VS Code's own, never bundled. ssh2's
// native crypto binding and cpu-features are optional: ssh2 requires each inside a try and falls
// back to Node's crypto, so leaving them external ships a bundle with no native code.
import { build } from "esbuild"

await build({
  entryPoints: ["src/extension.ts"],
  outfile: "lib/extension.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node16",
  external: ["vscode", "cpu-features", "*.node"],
  sourcemap: false,
  minify: true,
  logLevel: "warning",
})
