import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  safeReadVersionedJson,
  type SafeReadVersionedResult,
} from "../electron/storage/safeJson";

/**
 * Recovery-seam generality (Story 1.5 / AD-15, AD-16, AD-2).
 *
 * Story 1.5 does NOT create the reminder-ledger or fx-snapshot files (those land
 * with Epic 4 / Epic 8). Its job is to PROVE the Story-1.4 safe-read recovery
 * seam is already general enough that a later story adds a new JSON data file by
 * *reusing* this seam, not by rebuilding recovery.
 *
 * `safeReadVersionedJson` is the version-detection half of the seam. It is
 * **shape-agnostic by construction**: it classifies `missing` / `malformed` and,
 * on success, returns the parsed object plus its detected `version` — it never
 * looks at any field other than `version`, deferring all schema validation (the
 * only source of `corrupt`) to the caller's version-appropriate schema. These
 * tests drive it over arbitrary future-file shapes (a reminder-ledger-like doc
 * and an fx-snapshot-like doc) to lock that generality in: the same seam that
 * serves `subscriptions.json` / `settings.json` today serves an arbitrary
 * versioned JSON file tomorrow, with no new code.
 */

/** A reminder-ledger-like shape (Epic 4) — NOT created here, used only as a probe. */
function ledgerLikeDoc(version: number): Record<string, unknown> {
  return {
    version,
    lastRunAt: "2026-03-07T09:05:42.137Z",
    fired: [
      { subscriptionId: "a", leadTime: "one-day", localDay: "2026-03-06" },
      { subscriptionId: "b", leadTime: "same-day", localDay: "2026-03-07" },
    ],
  };
}

/** An fx-snapshot-like shape (Epic 8) — NOT created here, used only as a probe. */
function fxSnapshotLikeDoc(version: number): Record<string, unknown> {
  return {
    version,
    asOf: "2026-03-01",
    base: "EUR",
    rates: { USD: 1.08, JPY: 160.5, GBP: 0.84 },
  };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "subby-recovery-seam-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("recovery seam generality: shape-agnostic version detection (AD-15)", () => {
  it("detects the version of an arbitrary (reminder-ledger-like) shape it has never seen", async () => {
    const path = join(dir, "reminder-ledger.json");
    await writeFile(path, JSON.stringify(ledgerLikeDoc(2)), "utf8");

    const result = await safeReadVersionedJson(path);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.version).toBe(2);
      // The whole arbitrary object is returned untouched; the seam reads only
      // `version` and leaves every other field for the caller's schema.
      expect(result.value).toMatchObject(ledgerLikeDoc(2));
    }
  });

  it("detects the version of an arbitrary (fx-snapshot-like) shape it has never seen", async () => {
    const path = join(dir, "fx-snapshot.json");
    await writeFile(path, JSON.stringify(fxSnapshotLikeDoc(1)), "utf8");

    const result = await safeReadVersionedJson(path);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.version).toBe(1);
      expect(result.value).toMatchObject(fxSnapshotLikeDoc(1));
    }
  });

  it("surfaces an older-version arbitrary file by its version so a caller can migrate it", async () => {
    // A future `reminder-ledger.json` at v1 against a current of 2 would take the
    // SAME `< current -> migrate-before-validate` branch the subscriptions file
    // takes; the seam just needs to report version 1, which it does regardless of
    // the file's shape.
    const path = join(dir, "reminder-ledger.json");
    await writeFile(path, JSON.stringify(ledgerLikeDoc(1)), "utf8");

    const result = await safeReadVersionedJson(path);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.version).toBe(1);
  });
});

describe("recovery seam generality: classified failures never throw raw (AD-16, Req 19)", () => {
  it("classifies a malformed arbitrary JSON file as 'malformed' (never throws)", async () => {
    const path = join(dir, "reminder-ledger.json");
    await writeFile(path, "{ not: valid json for a ledger", "utf8");

    let result: SafeReadVersionedResult;
    let threw = false;
    try {
      result = await safeReadVersionedJson(path);
    } catch {
      threw = true;
      throw new Error("safeReadVersionedJson threw instead of classifying");
    }
    expect(threw).toBe(false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("malformed");
      expect(result.raw).toBe("{ not: valid json for a ledger");
    }
  });

  it("classifies a version-less arbitrary object as 'malformed' (cannot be gated)", async () => {
    // Valid JSON of an arbitrary shape but with NO usable integer `version`: the
    // seam refuses to assume a version rather than silently guessing, exactly as
    // it does for the subscriptions/settings files.
    const path = join(dir, "fx-snapshot.json");
    await writeFile(
      path,
      JSON.stringify({ asOf: "2026-03-01", base: "EUR", rates: {} }),
      "utf8",
    );

    const result = await safeReadVersionedJson(path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed");
  });

  it("classifies a non-object arbitrary JSON (array) as 'malformed'", async () => {
    const path = join(dir, "weird.json");
    await writeFile(path, JSON.stringify([{ version: 1 }]), "utf8");

    const result = await safeReadVersionedJson(path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed");
  });

  it("classifies a missing arbitrary file as 'missing' (so a caller can recreate/offer restore)", async () => {
    const result = await safeReadVersionedJson(join(dir, "does-not-exist.json"));
    expect(result).toEqual({ ok: false, reason: "missing" });
  });
});
