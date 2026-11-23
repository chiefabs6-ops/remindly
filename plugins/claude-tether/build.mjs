// Bundles the MCP server and hook into self-contained ESM files (no node_modules needed at runtime).
import { build } from "esbuild";

await build({
  entryPoints: { server: "src/server.ts", hook: "src/hook.ts" },
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  legalComments: "none",
  logLevel: "info",
});
