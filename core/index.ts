/**
 * Platform-independent Business_Logic entry point (Req 2.2).
 *
 * Modules in `core/` MUST NOT import from `electron`, `react`, or Node's `fs`.
 * They are pure and portable to future Tauri / React Native / Web backends.
 * Concrete modules (billing, renewal, search, import, export, backup,
 * analytics, models, ports) are added in subsequent tasks.
 */
export const CORE_SCAFFOLD_READY = true;
