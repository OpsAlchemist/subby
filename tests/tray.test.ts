import { afterEach, describe, it, expect, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Tray icon loader (Story 4.4) — Req 13.3.
 *
 * The real Electron `Tray` + window lifecycle cannot be driven headlessly in a
 * Node test env, so these tests exercise the pure-ish `loadTrayImage` seam
 * (`path → NativeImage with fallback`) and the `buildTrayIcon` resolve+fallback
 * path — where the story's crash-safety + macOS template-image contract lives:
 *   - a real icon path (the committed `resources/trayTemplate.png`) → a
 *     NON-empty image;
 *   - on macOS the loaded image is marked a TEMPLATE image; on Windows/Linux it
 *     is NOT;
 *   - a bogus path → the empty `nativeImage` fallback and NO throw (never
 *     marked template), so a subsequent `new Tray(...)` always constructs.
 *
 * `electron` is unavailable as a real module under vitest's node env, so we
 * stub its `nativeImage` with a thin, FAITHFUL `node:fs`-backed fake:
 * `createFromPath` reads the file and reports `isEmpty()` from whether real
 * bytes were read — mirroring Electron's own behavior (a missing/unreadable
 * path yields an empty image rather than throwing), and records whether
 * `setTemplateImage(true)` was called. `app` is stubbed because `tray.ts` /
 * `resourceReader.ts` import it at module load; `buildTrayIcon`'s dev path reads
 * `app.isPackaged`/`app.getAppPath()`.
 */

// A minimal fake NativeImage: tracks its byte length and template flag.
interface FakeNativeImage {
  _len: number;
  _template: boolean;
  isEmpty(): boolean;
  setTemplateImage(flag: boolean): void;
}

function makeFakeImage(len: number): FakeNativeImage {
  return {
    _len: len,
    _template: false,
    isEmpty() {
      return this._len === 0;
    },
    setTemplateImage(flag: boolean) {
      this._template = flag;
    },
  };
}

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    // Lazy: resolved only when production wiring calls it, after module init
    // (avoids referencing a file-scope const during hoisted-factory eval).
    getAppPath: () => dirname(dirname(fileURLToPath(import.meta.url))),
  },
  nativeImage: {
    // Faithful to Electron: a missing/unreadable path yields an EMPTY image
    // (never throws). A readable file yields a non-empty image sized by bytes.
    createFromPath: (p: string): FakeNativeImage => {
      try {
        if (!existsSync(p)) return makeFakeImage(0);
        const bytes = readFileSync(p);
        return makeFakeImage(bytes.length);
      } catch {
        return makeFakeImage(0);
      }
    },
    createEmpty: (): FakeNativeImage => makeFakeImage(0),
  },
}));

// A controllable `resolveResourceDir` so `buildTrayIcon` can be driven down both
// the happy dev path and the resolver-throws degradation path. The spy ALWAYS
// backs the mock; its default delegates to the real pure resolver, `afterEach`
// restores that default, and a single test overrides it to throw.
const hoisted = vi.hoisted(() => ({
  resolveSpy: vi.fn(),
  defaultResolve: undefined as
    | ((opts: { isPackaged: boolean; resourcesPath: string; appPath: string }) => string)
    | undefined,
}));
vi.mock("../electron/storage/resourceReader", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../electron/storage/resourceReader")>();
  hoisted.defaultResolve = actual.resolveResourceDir;
  hoisted.resolveSpy.mockImplementation(actual.resolveResourceDir);
  return { ...actual, resolveResourceDir: hoisted.resolveSpy };
});
const { resolveSpy } = hoisted;

import {
  buildTrayIcon,
  loadTrayImage,
  TRAY_ICON_RESOURCE,
} from "../electron/services/tray";

// Repo root is the parent of this `tests/` directory — where `resources/` lives.
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** The real committed asset path (a valid 32×32 monochrome RGBA PNG). */
const REAL_ICON_PATH = join(REPO_ROOT, "resources", TRAY_ICON_RESOURCE);

/** PNG magic header: the 8 signature bytes every PNG begins with. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Cast helper: read the fake's bookkeeping fields back off a returned image. */
function asFake(img: ReturnType<typeof loadTrayImage>): FakeNativeImage {
  return img as unknown as FakeNativeImage;
}

/** Override `process.platform` for a test; returns a restore callback. */
function stubPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

const ORIGINAL_PLATFORM = process.platform;

afterEach(() => {
  Object.defineProperty(process, "platform", {
    value: ORIGINAL_PLATFORM,
    configurable: true,
  });
  // Restore the default delegation (NOT mockReset, which would leave the spy
  // returning undefined and break the dev-path resolution).
  if (hoisted.defaultResolve) resolveSpy.mockImplementation(hoisted.defaultResolve);
});

describe("the committed trayTemplate.png asset", () => {
  it("is a real, decodable 32×32 PNG (magic header + IHDR), not merely non-empty", () => {
    const bytes = readFileSync(REAL_ICON_PATH);
    // 8-byte PNG signature.
    expect([...bytes.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
    // The first chunk is IHDR; its type tag lives at bytes 12..16.
    expect(bytes.subarray(12, 16).toString("latin1")).toBe("IHDR");
    // IHDR width/height are big-endian uint32 at offsets 16 and 20.
    expect(bytes.readUInt32BE(16)).toBe(32);
    expect(bytes.readUInt32BE(20)).toBe(32);
  });
});

describe("loadTrayImage: crash-safe icon loader (Story 4.4)", () => {
  it("loads the real bundled trayTemplate.png as a NON-empty image", () => {
    stubPlatform("linux");
    const img = loadTrayImage(REAL_ICON_PATH);
    expect(img.isEmpty()).toBe(false);
  });

  it("returns the empty fallback (no throw) for a bogus path", () => {
    const bogus = join(REPO_ROOT, "resources", "does-not-exist-tray.png");
    let img!: ReturnType<typeof loadTrayImage>;
    expect(() => {
      img = loadTrayImage(bogus);
    }).not.toThrow();
    expect(img.isEmpty()).toBe(true);
  });

  it("on macOS marks the real image as a TEMPLATE image", () => {
    stubPlatform("darwin");
    const img = loadTrayImage(REAL_ICON_PATH);
    expect(img.isEmpty()).toBe(false);
    expect(asFake(img)._template).toBe(true);
  });

  it("on Windows/Linux does NOT mark the real image as a template image", () => {
    stubPlatform("win32");
    const win = loadTrayImage(REAL_ICON_PATH);
    expect(asFake(win)._template).toBe(false);

    stubPlatform("linux");
    const linux = loadTrayImage(REAL_ICON_PATH);
    expect(asFake(linux)._template).toBe(false);
  });

  it("never marks the empty fallback as a template image (even on macOS)", () => {
    stubPlatform("darwin");
    const img = loadTrayImage(join(REPO_ROOT, "resources", "missing.png"));
    expect(img.isEmpty()).toBe(true);
    expect(asFake(img)._template).toBe(false);
  });

  it("names the asset with the macOS …Template suffix convention", () => {
    // The `…Template` filename is the Electron convention that triggers macOS
    // template-image treatment; keep that contract explicit.
    expect(TRAY_ICON_RESOURCE).toBe("trayTemplate.png");
    expect(TRAY_ICON_RESOURCE.endsWith("Template.png")).toBe(true);
  });
});

describe("buildTrayIcon: resolve + crash-safe fallback", () => {
  it("resolves the dev resources dir and returns a non-empty image without throwing", () => {
    stubPlatform("linux");
    let img!: ReturnType<typeof buildTrayIcon>;
    expect(() => {
      img = buildTrayIcon();
    }).not.toThrow();
    // Dev path resolves <appPath>/resources/trayTemplate.png → the real asset.
    expect(img.isEmpty()).toBe(false);
  });

  it("degrades to the empty fallback (no throw) when the resolver throws", () => {
    resolveSpy.mockImplementation(() => {
      throw new Error("resolver boom");
    });
    let img!: ReturnType<typeof buildTrayIcon>;
    expect(() => {
      img = buildTrayIcon();
    }).not.toThrow();
    expect(img.isEmpty()).toBe(true);
  });
});
