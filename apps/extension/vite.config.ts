import { defineConfig } from "vitest/config";

// Builds the MV3 extension into dist/: background.js (module service worker), popup.html and meet.js
// (content script: must stay import-free, so meet.ts only imports ./meet-parse, which no other entry uses).
// Load it in Chrome with "Load unpacked" pointing at apps/extension/dist.
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome120",
    rollupOptions: {
      input: { background: "src/background.ts", popup: "popup.html", meet: "src/meet.ts" },
      output: { entryFileNames: "[name].js", chunkFileNames: "chunks/[name]-[hash].js", assetFileNames: "assets/[name]-[hash][extname]" },
    },
  },
  test: { environment: "node" },
});
