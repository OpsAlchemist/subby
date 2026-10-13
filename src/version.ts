/**
 * App version for the sandboxed renderer (Story 3.2).
 *
 * `package.json.version` is injected as a build-time string literal via the Vite
 * `define: { __APP_VERSION__ }` in both `electron.vite.config.ts` (renderer
 * target) and `vitest.config.ts` (so the constant resolves under tests). This is
 * a compile-time constant baked into the bundle — NOT a runtime `fs`/`electron`
 * read — so the renderer sandbox (contextIsolation / sandbox / nodeIntegration)
 * stays intact and no IPC channel is needed just to surface a version string.
 *
 * The `typeof` guard falls back to a non-empty placeholder when the `define` is
 * absent (e.g. a bare `tsc`/`ts-node` context), keeping this module importable
 * everywhere.
 */

declare const __APP_VERSION__: string;

/** The app version baked in at build time, or a safe fallback. */
export const APP_VERSION: string =
  typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.0-dev";
