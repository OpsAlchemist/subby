import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub Electron's native `dialog` so `runChooseDataFolder` can be driven without
// booting Electron. `showOpenDialog` is controlled per-test via the mock below.
const showOpenDialog = vi.fn();
vi.mock("electron", () => ({
  dialog: {
    showOpenDialog: (...args: unknown[]) => showOpenDialog(...args),
  },
}));

import {
  formatForPath,
  runChooseDataFolder,
  type DialogServices,
} from "../electron/services/dialog";
import { SYNCED_FOLDER_CAVEAT } from "../electron/appWiring";
import type { BrowserWindow } from "electron";
import type { Settings } from "core/models/settings";

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

/**
 * `runChooseDataFolder` surfaces the single-machine synced-folder caveat (AD-31,
 * Story 1.7) on a successful folder choice so the UI can present it. These tests
 * drive the composable helper with a stubbed native dialog and a fake
 * `setDataFolder` service.
 */
describe("runChooseDataFolder: synced-folder caveat (AD-31)", () => {
  const fakeWindow = {} as unknown as BrowserWindow;
  const fakeSettings = { dataFolder: "/picked/dir" } as unknown as Settings;
  const services: DialogServices = {
    setDataFolder: vi.fn(async () => fakeSettings),
    // Unused by this path, present to satisfy the type.
    applyImport: vi.fn(),
    exportData: vi.fn(),
  } as unknown as DialogServices;

  beforeEach(() => {
    showOpenDialog.mockReset();
    (services.setDataFolder as ReturnType<typeof vi.fn>).mockClear();
  });

  it("carries caveat === SYNCED_FOLDER_CAVEAT on a successful choice", async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ["/picked/dir"] });

    const result = await runChooseDataFolder(fakeWindow, services);

    expect(result.cancelled).toBe(false);
    if (!result.cancelled) {
      expect(result.path).toBe("/picked/dir");
      expect(result.settings).toBe(fakeSettings);
      expect(result.caveat).toBe(SYNCED_FOLDER_CAVEAT);
    }
    expect(services.setDataFolder).toHaveBeenCalledWith("/picked/dir");
  });

  it("on cancel: a no-op result with no caveat (folder unchanged)", async () => {
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });

    const result = await runChooseDataFolder(fakeWindow, services);

    expect(result).toEqual({ cancelled: true });
    expect(result).not.toHaveProperty("caveat");
    expect(services.setDataFolder).not.toHaveBeenCalled();
  });
});
