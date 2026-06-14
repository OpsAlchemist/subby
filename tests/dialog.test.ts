import { describe, it, expect } from "vitest";

import { formatForPath } from "../electron/services/dialog";

/**
 * Unit tests for the pure path→format inference used by the import dialog
 * helper (Req 16.1). The native dialog primitives and composable channel
 * helpers depend on Electron's `dialog`/`BrowserWindow` and are exercised by
 * the IPC integration tests (task 13.4), not here.
 */
describe("formatForPath", () => {
  it("maps .json to json (case-insensitive)", () => {
    expect(formatForPath("/tmp/subby-export.json")).toBe("json");
    expect(formatForPath("/tmp/SUBBY.JSON")).toBe("json");
  });

  it("maps .csv to csv (case-insensitive)", () => {
    expect(formatForPath("/tmp/subby-export.csv")).toBe("csv");
    expect(formatForPath("/tmp/Data.CSV")).toBe("csv");
  });

  it("returns null for unsupported or missing extensions", () => {
    expect(formatForPath("/tmp/data.txt")).toBeNull();
    expect(formatForPath("/tmp/data")).toBeNull();
    expect(formatForPath("/tmp/archive.json.gz")).toBeNull();
  });
});
