import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LogoBlobCache,
  extensionFor,
  normalizeDomainKey,
} from "../electron/services/logoBlobCache";

/**
 * Logo blob cache (Story 8.4; AD-13).
 *
 * Covers the file-cache helper the EnrichmentService owns: `has` (never-refetch
 * gate), `write` (atomic persist under `<DataFolder>/logos/`, extension from
 * content-type), and `readAllAsDataUris` (domain→data-URI map for the renderer).
 * Also covers the relocation contract: the cache reads the data folder FRESH on
 * each op, so re-pointing the folder targets the new `logos/` without a move.
 *
 * Pure Node + a temp directory — the StoragePort is NOT involved (AD-13: the
 * cache is parallel to the port, which stays JSON-only).
 */

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "subby-logos-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

/** The `<dataDir>/logos/` directory the cache writes under. */
function logosDir(dir: string): string {
  return join(dir, "logos");
}

describe("extensionFor: content-type → stable extension (null for unknown)", () => {
  it("maps the known image content-types", () => {
    expect(extensionFor("image/png")).toBe("png");
    expect(extensionFor("image/svg+xml")).toBe("svg");
    expect(extensionFor("image/jpeg")).toBe("jpg");
    expect(extensionFor("image/x-icon")).toBe("ico");
  });

  it("normalizes casing and strips a charset parameter", () => {
    expect(extensionFor("IMAGE/PNG")).toBe("png");
    expect(extensionFor("image/svg+xml; charset=utf-8")).toBe("svg");
  });

  it("returns null for an unknown/empty content-type (never a guessed extension)", () => {
    expect(extensionFor("application/json")).toBeNull();
    expect(extensionFor("")).toBeNull();
    expect(extensionFor("text/html")).toBeNull();
  });
});

describe("LogoBlobCache.write + has + readAllAsDataUris", () => {
  it("writes a blob under <DataFolder>/logos/<domain>.<ext> keyed by the domain", async () => {
    const cache = new LogoBlobCache(() => dataDir);
    const bytes = new Uint8Array([1, 2, 3, 4]);

    const written = await cache.write("netflix.com", bytes, "image/png");
    expect(written).toBe(true);

    const file = join(logosDir(dataDir), "netflix.com.png");
    const onDisk = await readFile(file);
    expect(new Uint8Array(onDisk)).toEqual(bytes);
  });

  it("has() is true after a write and false for an uncached domain", async () => {
    const cache = new LogoBlobCache(() => dataDir);
    expect(await cache.has("netflix.com")).toBe(false); // no logos/ dir yet
    await cache.write("netflix.com", new Uint8Array([9]), "image/png");
    expect(await cache.has("netflix.com")).toBe(true);
    expect(await cache.has("NETFLIX.COM")).toBe(true); // case-insensitive
    expect(await cache.has("spotify.com")).toBe(false);
  });

  it("write() returns false and persists nothing for an uncacheable content-type", async () => {
    const cache = new LogoBlobCache(() => dataDir);
    const written = await cache.write("netflix.com", new Uint8Array([1]), "application/json");
    expect(written).toBe(false);
    expect(await cache.has("netflix.com")).toBe(false);
    await expect(readdir(logosDir(dataDir))).rejects.toBeTruthy(); // dir never created
  });

  it("readAllAsDataUris returns a domain→data:<mime>;base64 map", async () => {
    const cache = new LogoBlobCache(() => dataDir);
    await cache.write("netflix.com", new Uint8Array([0xde, 0xad]), "image/png");
    await cache.write("spotify.com", new Uint8Array([0xbe, 0xef]), "image/svg+xml");

    const map = await cache.readAllAsDataUris();
    expect(Object.keys(map).sort()).toEqual(["netflix.com", "spotify.com"]);
    expect(map["netflix.com"]).toBe(
      `data:image/png;base64,${Buffer.from([0xde, 0xad]).toString("base64")}`,
    );
    expect(map["spotify.com"]).toBe(
      `data:image/svg+xml;base64,${Buffer.from([0xbe, 0xef]).toString("base64")}`,
    );
  });

  it("readAllAsDataUris returns {} when the logos/ dir is absent (never throws)", async () => {
    const cache = new LogoBlobCache(() => dataDir);
    expect(await cache.readAllAsDataUris()).toEqual({});
  });

  it("ignores non-logo files (e.g. a stray .tmp or .txt) in the logos dir", async () => {
    await mkdir(logosDir(dataDir), { recursive: true });
    await writeFile(join(logosDir(dataDir), ".abc.tmp"), "mid-write");
    await writeFile(join(logosDir(dataDir), "readme.txt"), "note");
    const cache = new LogoBlobCache(() => dataDir);
    await cache.write("netflix.com", new Uint8Array([1]), "image/png");

    const map = await cache.readAllAsDataUris();
    expect(Object.keys(map)).toEqual(["netflix.com"]);
  });

  it("write is atomic (temp-then-rename): no .tmp file is left behind", async () => {
    const cache = new LogoBlobCache(() => dataDir);
    await cache.write("netflix.com", new Uint8Array([1, 2]), "image/png");
    const entries = await readdir(logosDir(dataDir));
    expect(entries.some((n) => n.endsWith(".tmp"))).toBe(false);
    expect(entries).toContain("netflix.com.png");
  });
});

describe("LogoBlobCache: Data-Folder relocation is a re-point, not a move (AD-13)", () => {
  it("reads the data folder FRESH each op, so re-pointing targets the new logos/", async () => {
    const other = await mkdtemp(join(tmpdir(), "subby-logos-b-"));
    try {
      // A mutable pointer the cache reads fresh on every op (mirrors the storage
      // adapter's getDataFolder, which reflects a live setDataFolder).
      let active = dataDir;
      const cache = new LogoBlobCache(() => active);

      await cache.write("netflix.com", new Uint8Array([1]), "image/png");
      expect(await cache.has("netflix.com")).toBe(true);

      // Relocate: the OLD blob is NOT moved; the new folder starts empty.
      active = other;
      expect(await cache.has("netflix.com")).toBe(false);
      expect(await cache.readAllAsDataUris()).toEqual({});

      // A write now lands under the NEW folder.
      await cache.write("spotify.com", new Uint8Array([2]), "image/png");
      expect(await readFile(join(logosDir(other), "spotify.com.png"))).toBeTruthy();
      // The old folder still holds its original blob (left in place).
      expect(await readFile(join(logosDir(dataDir), "netflix.com.png"))).toBeTruthy();
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});

describe("normalizeDomainKey: fail-closed path-traversal / shape guard (SECURITY)", () => {
  it("accepts a plain registrable domain (trim + lowercase)", () => {
    expect(normalizeDomainKey("netflix.com")).toBe("netflix.com");
    expect(normalizeDomainKey("  NETFLIX.COM ")).toBe("netflix.com");
    expect(normalizeDomainKey("music.youtube.com")).toBe("music.youtube.com");
    expect(normalizeDomainKey("foo-bar.co.uk")).toBe("foo-bar.co.uk");
  });

  it("refuses path-traversal / separator / dotless / empty-label keys (returns null)", () => {
    for (const bad of [
      "../../evil",
      "..",
      "../etc/passwd",
      "a/b.com",
      "a\\b.com",
      "netflix.com/../x",
      "acme", // no dot
      "", // empty
      "   ", // whitespace only
      ".leadingdot",
      "trailingdot.",
      "double..dot",
      "has space.com",
    ]) {
      expect(normalizeDomainKey(bad), `"${bad}" must be refused`).toBeNull();
    }
  });
});

describe("LogoBlobCache: path-traversal keys write nothing outside logos/ (SECURITY)", () => {
  it("write() refuses a `../`-style key and creates no file (fail-closed)", async () => {
    const cache = new LogoBlobCache(() => dataDir);

    const written = await cache.write("../../evil", new Uint8Array([1, 2]), "image/png");
    expect(written).toBe(false);
    // has() also refuses it.
    expect(await cache.has("../../evil")).toBe(false);

    // Nothing escaped: the parent of dataDir has no stray `evil.*` file, and the
    // logos/ dir was never even created by the refused write.
    const parent = join(dataDir, "..");
    const parentEntries = await readdir(parent);
    expect(parentEntries.some((n) => n.startsWith("evil"))).toBe(false);
    await expect(readdir(logosDir(dataDir))).rejects.toBeTruthy();
  });

  it("write() refuses a separator / dotless key too (no file written)", async () => {
    const cache = new LogoBlobCache(() => dataDir);
    expect(await cache.write("a/b.com", new Uint8Array([1]), "image/png")).toBe(false);
    expect(await cache.write("acme", new Uint8Array([1]), "image/png")).toBe(false);
    await expect(readdir(logosDir(dataDir))).rejects.toBeTruthy();
  });
});
