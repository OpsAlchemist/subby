import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { CORE_SCAFFOLD_READY } from "core/index";
import type { IpcResult } from "shared/types";

/**
 * Toolchain smoke test. Confirms Vitest runs, the `core/*` and `shared/*` path
 * aliases resolve in tests, and fast-check executes property-based runs. Real
 * property tests for the correctness properties are added in later tasks.
 */
describe("scaffold toolchain", () => {
  it("resolves core and shared path aliases", () => {
    expect(CORE_SCAFFOLD_READY).toBe(true);
    // `shared/*` alias resolves to the IPC contracts module.
    const result: IpcResult<number> = { ok: true, data: 1 };
    expect(result.ok).toBe(true);
  });

  it("runs fast-check property runs", () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => a + b === b + a),
      { numRuns: 100 },
    );
  });
});
