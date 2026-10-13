import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveResourceDir,
  readBundledResource,
  readBundledFxSnapshot,
  ResourceReadError,
  FX_SNAPSHOT_RESOURCE,
  type ResolveResourceDirOptions,
} from "../electron/storage/resourceReader";
import { FX_SNAPSHOT_SCHEMA_VERSION } from "core/fxSnapshot";

/**
 * Bundled resource reader (FR-12, AD-24, AD-30; Story 2.3).
 *
 * Proves the asar-aware resolution is dev-vs-packaged correct as a PURE string
 * transform, and that the REAL shipped `resources/fx-snapshot.json` resolves,
 * reads, and validates end-to-end without booting Electron. A missing resource
 * must throw loudly (never a silent empty object).
 */

// The repo root is the parent of this `tests/` directory — the dev `appPath`
// where `resources/` lives, mirroring what `app.getAppPath()` yields in dev.
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Resolution options pointing at the real repo `resources/` (dev / unpackaged). */
const devOpts: ResolveResourceDirOptions = {
  isPackaged: false,
  resourcesPath: "/unused/in/dev",
  appPath: REPO_ROOT,
};

const SHIP_LIST_SIZE = 31;

describe("resolveResourceDir: dev vs packaged resolution (pure)", () => {
  it("dev (unpackaged) resolves <appPath>/resources", () => {
    expect(
      resolveResourceDir({ isPackaged: false, resourcesPath: "/pkg/Resources", appPath: "/repo" }),
    ).toBe(join("/repo", "resources"));
  });

  it("packaged resolves <process.resourcesPath>/resources (outside the asar)", () => {
    expect(
      resolveResourceDir({ isPackaged: true, resourcesPath: "/pkg/Resources", appPath: "/pkg/app.asar" }),
    ).toBe(join("/pkg/Resources", "resources"));
  });

  it("the packaged dir is NOT inside the asar app path", () => {
    const dir = resolveResourceDir({
      isPackaged: true,
      resourcesPath: "/pkg/Resources",
      appPath: "/pkg/Resources/app.asar",
    });
    expect(dir).not.toContain("app.asar");
  });
});

describe("readBundledResource / readBundledFxSnapshot: real shipped bundle", () => {
  it("reads and parses the real resources/fx-snapshot.json into a valid BundledFxSnapshot", () => {
    const snapshot = readBundledFxSnapshot(devOpts);
    expect(snapshot.asOf).toBe("2026-10-01");
    expect(snapshot.schemaVersion).toBe(FX_SNAPSHOT_SCHEMA_VERSION);
    expect(snapshot.base).toBe("EUR");
    expect(snapshot.rates.EUR).toBe("1");
    expect(Object.keys(snapshot.rates).length).toBe(SHIP_LIST_SIZE);
    // Every rate is a positive decimal string.
    for (const [, rate] of Object.entries(snapshot.rates)) {
      expect(typeof rate).toBe("string");
      expect(Number(rate)).toBeGreaterThan(0);
    }
  });

  it("readBundledResource returns the raw parsed JSON object for the FX snapshot", () => {
    const raw = readBundledResource(FX_SNAPSHOT_RESOURCE, devOpts) as Record<string, unknown>;
    expect(raw.schemaVersion).toBe(1);
    expect(raw.base).toBe("EUR");
    expect(typeof raw.attribution).toBe("string");
    expect(String(raw.attribution)).toMatch(/European Central Bank|ECB/);
  });

  it("a missing resource throws ResourceReadError (never a silent {})", () => {
    try {
      readBundledResource("does-not-exist.json", devOpts);
      expect.unreachable("expected ResourceReadError");
    } catch (err) {
      expect(err).toBeInstanceOf(ResourceReadError);
      expect((err as ResourceReadError).reason).toBe("missing");
      expect((err as ResourceReadError).resource).toBe("does-not-exist.json");
    }
  });

  it("a present-but-invalid-JSON resource throws ResourceReadError (reason \"malformed\")", () => {
    // Build a temp appPath whose `resources/` dir holds a non-JSON file, so
    // resolveResourceDir({ appPath }) -> <tmp>/resources resolves to it.
    const appPath = mkdtempSync(join(tmpdir(), "subby-resreader-"));
    try {
      mkdirSync(join(appPath, "resources"), { recursive: true });
      writeFileSync(join(appPath, "resources", "broken.json"), "{ not valid json", "utf8");
      try {
        readBundledResource("broken.json", {
          isPackaged: false,
          resourcesPath: "/unused/in/dev",
          appPath,
        });
        expect.unreachable("expected ResourceReadError");
      } catch (err) {
        expect(err).toBeInstanceOf(ResourceReadError);
        expect((err as ResourceReadError).reason).toBe("malformed");
        expect((err as ResourceReadError).resource).toBe("broken.json");
      }
    } finally {
      rmSync(appPath, { recursive: true, force: true });
    }
  });
});
