import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

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
