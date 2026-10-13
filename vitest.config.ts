import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

import pkg from "./package.json";

// Vitest uses the same path aliases as the build so tests can import
// `core/*`, `shared/*`, and `@/*` exactly like application code.
export default defineConfig({
  resolve: {
    alias: {
      core: resolve(__dirname, "core"),
      shared: resolve(__dirname, "shared"),
      "@": resolve(__dirname, "src"),
    },
  },
  // Mirror the renderer's build-time `__APP_VERSION__` literal (Story 3.2) so
  // `src/version.ts` resolves under tests instead of a ReferenceError.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    globals: true,
    environment: "node",
    include: [
      "tests/**/*.{test,spec}.{ts,tsx}",
      "core/**/*.{test,spec}.{ts,tsx}",
    ],
    // Property-based tests (fast-check) can take longer than the default.
    testTimeout: 20000,
    // The suite stays green even before any tests exist.
    passWithNoTests: true,
  },
});
