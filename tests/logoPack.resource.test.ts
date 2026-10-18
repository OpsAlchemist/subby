import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  readBundledLogoPack,
  LOGO_PACK_RESOURCE,
  type ResolveResourceDirOptions,
} from "../electron/storage/resourceReader";
import { EMPTY_LOGO_PACK, LOGO_PACK_SCHEMA_VERSION } from "core/logo";

/**
 * Bundled Logo Pack resource (Story 8.3; FR-26, AD-25, SM-C2).
 *
 * Reads the REAL committed `resources/logo-pack.json` end-to-end (no Electron
 * boot) and enforces the budget the spec mandates:
 *   - ≤ ~250 icons AND the committed file is < 1MB ("lightness is the product").
 *   - every entry is a well-formed `{ title, hex, path }`, keyed by a lowercased
 *     registrable domain so lookup matches `domainFromWebsite`'s output.
 *
 * The size guard FAILS LOUDLY if a future regeneration blows the budget.
 */

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Resolution options pointing at the real repo `resources/` (dev / unpackaged). */
const devOpts: ResolveResourceDirOptions = {
  isPackaged: false,
  resourcesPath: "/unused/in/dev",
  appPath: REPO_ROOT,
};

const MAX_ICONS = 250;
const MAX_BYTES = 1_000_000; // < 1MB

describe("Logo Pack: the real committed resources/logo-pack.json", () => {
  it("reads and validates into a typed LogoPack with the supported schema version", () => {
    const pack = readBundledLogoPack(devOpts);
    expect(pack.version).toBe(LOGO_PACK_SCHEMA_VERSION);
    const domains = Object.keys(pack.icons);
    expect(domains.length).toBeGreaterThan(100); // a real, non-trivial curated pack
  });

  it("includes a known bundled brand (netflix.com) resolving to a real SVG mark", () => {
    const pack = readBundledLogoPack(devOpts);
    const netflix = pack.icons["netflix.com"];
    expect(netflix, "netflix.com must be in the curated pack").toBeDefined();
    expect(netflix.title).toBe("Netflix");
    expect(netflix.hex).toMatch(/^[0-9a-fA-F]{3,8}$/);
    expect(netflix.path.length).toBeGreaterThan(0);
  });

  it("every entry is a well-formed {title, hex, path}, keyed by a lowercased registrable domain", () => {
    const pack = readBundledLogoPack(devOpts);
    for (const [domain, icon] of Object.entries(pack.icons)) {
      expect(domain, "domain key must be lowercased").toBe(domain.toLowerCase());
      expect(domain.includes("."), `domain ${domain} must have a dot`).toBe(true);
      expect(typeof icon.title).toBe("string");
      expect(icon.title.length).toBeGreaterThan(0);
      expect(icon.hex).toMatch(/^[0-9a-fA-F]{3,8}$/);
      expect(icon.path.length).toBeGreaterThan(0);
    }
  });

  it("INVARIANT: every icon key equals its own last-two-label reduction (no unreachable subdomain keys)", () => {
    // domainFromWebsite reduces a website to its last two non-empty labels, so a
    // key that is NOT its own reduction (e.g. "music.apple.com") can never be
    // produced from a `website` and would be dead weight. Guard it permanently.
    const reduce = (d: string): string =>
      d.split(".").filter(Boolean).slice(-2).join(".");
    const pack = readBundledLogoPack(devOpts);
    for (const key of Object.keys(pack.icons)) {
      expect(
        key,
        `"${key}" is an unreachable subdomain key (reduces to "${reduce(key)}")`,
      ).toBe(reduce(key));
    }
  });

  it("SIZE GUARD: ≤ 250 icons and the committed file is < 1MB (SM-C2)", () => {
    const pack = readBundledLogoPack(devOpts);
    const iconCount = Object.keys(pack.icons).length;
    expect(
      iconCount,
      `Logo Pack has ${iconCount} icons; the budget is ≤ ${MAX_ICONS}`,
    ).toBeLessThanOrEqual(MAX_ICONS);

    const path = join(REPO_ROOT, "resources", LOGO_PACK_RESOURCE);
    const bytes = statSync(path).size;
    expect(
      bytes,
      `logo-pack.json is ${bytes} bytes; the budget is < ${MAX_BYTES}`,
    ).toBeLessThan(MAX_BYTES);
  });

  it("the committed JSON is valid and uses the compact {version, generatedAt, note, icons} shape", () => {
    const path = join(REPO_ROOT, "resources", LOGO_PACK_RESOURCE);
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(raw.version).toBe(LOGO_PACK_SCHEMA_VERSION);
    expect(typeof raw.generatedAt).toBe("string");
    expect(typeof raw.note).toBe("string");
    // The note names Simple Icons + the CC0 license (the AD-25 provenance).
    expect(String(raw.note)).toMatch(/Simple Icons/i);
    expect(String(raw.note)).toMatch(/CC0/i);
    expect(typeof raw.icons).toBe("object");
  });
});

describe("readBundledLogoPack: degrade-to-EMPTY (diverges from the loud FX reader)", () => {
  it("a missing logo-pack.json returns EMPTY_LOGO_PACK (no throw)", () => {
    // An appPath whose resources/ dir has no logo-pack.json → ResourceReadError
    // "missing" inside the reader, which the reader swallows into the empty pack.
    const appPath = mkdtempSync(join(tmpdir(), "subby-logopack-missing-"));
    try {
      mkdirSync(join(appPath, "resources"), { recursive: true });
      const pack = readBundledLogoPack({
        isPackaged: false,
        resourcesPath: "/unused/in/dev",
        appPath,
      });
      expect(pack).toEqual(EMPTY_LOGO_PACK);
    } finally {
      rmSync(appPath, { recursive: true, force: true });
    }
  });

  it("a malformed logo-pack.json returns EMPTY_LOGO_PACK (no throw)", () => {
    const appPath = mkdtempSync(join(tmpdir(), "subby-logopack-malformed-"));
    try {
      mkdirSync(join(appPath, "resources"), { recursive: true });
      writeFileSync(
        join(appPath, "resources", LOGO_PACK_RESOURCE),
        "{ not valid json",
        "utf8",
      );
      const pack = readBundledLogoPack({
        isPackaged: false,
        resourcesPath: "/unused/in/dev",
        appPath,
      });
      expect(pack).toEqual(EMPTY_LOGO_PACK);
    } finally {
      rmSync(appPath, { recursive: true, force: true });
    }
  });
});
