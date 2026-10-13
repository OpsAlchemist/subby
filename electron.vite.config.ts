import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

import pkg from "./package.json";

// Shared path aliases so `core/*`, `shared/*`, and `@/*` resolve in every target.
const alias = {
  core: resolve(__dirname, "core"),
  shared: resolve(__dirname, "shared"),
  "@": resolve(__dirname, "src"),
};

// Bake the app version into the renderer bundle as a build-time string literal
// (Story 3.2). `src/version.ts` re-exports it as `APP_VERSION`; the About screen
// renders it. Compile-time constant → no IPC, renderer sandbox intact.
const define = {
  __APP_VERSION__: JSON.stringify(pkg.version),
};

export default defineConfig({
  // Main process (Node side): app lifecycle, storage adapter, services.
  main: {
    resolve: { alias },
    build: {
      outDir: "out/main",
      lib: {
        entry: resolve(__dirname, "electron/main.ts"),
      },
    },
  },
  // Preload: the only renderer <-> main bridge (contextBridge).
  // Forced to CommonJS `.js` because sandboxed preloads (sandbox: true)
  // cannot be ES modules.
  preload: {
    resolve: { alias },
    build: {
      outDir: "out/preload",
      lib: {
        entry: resolve(__dirname, "electron/preload.ts"),
      },
      rollupOptions: {
        output: {
          format: "cjs",
          entryFileNames: "preload.js",
        },
      },
    },
  },
  // Renderer (Chromium, sandboxed): React UI. No fs/electron imports.
  renderer: {
    root: resolve(__dirname, "src"),
    resolve: { alias },
    define,
    plugins: [react()],
    build: {
      outDir: "out/renderer",
      rollupOptions: {
        input: resolve(__dirname, "src/index.html"),
      },
    },
  },
});
