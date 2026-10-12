import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { backupFileName } from "core/backup";

/**
 * Property 22: Collision-proof backup file names (Story 1.5 / AD-16).
 * Validates: Requirements 18.1, 18.2; AD-16; AD-27.
 *
 * Story 1.5 extends the Req 18.1 minute-granularity name into a collision-proof
 * one: it keeps the zero-padded `YYYY-MM-DD-HH-MM` prefix (so newest-first
 * lexicographic ordering — AD-27 — still holds) and appends `-SS-mmm` (seconds +
 * milliseconds) plus, when the adapter supplies it, `-SSSS` (a monotonic
 * counter). No two backups taken in the same minute — even the same millisecond,
 * via `seq` — can share a name.
 *
 * The generator stays **pure** (AD-1): it reads neither the wall clock nor
 * entropy. `now` and any `seq` are injected; this test proves the formatting and
 * the ordering/uniqueness properties over arbitrary injected inputs.
 */

const NUM_RUNS = 300;

/** `YYYY-MM-DD-HH-MM-SS-mmm` with no `seq` segment. */
const FORMAT_NO_SEQ = /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-\d{3}\.json$/;
/** `YYYY-MM-DD-HH-MM-SS-mmm-SSSS` with the 4-digit `seq` segment. */
const FORMAT_WITH_SEQ = /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-\d{3}-\d{4}\.json$/;
/** The legacy minute-granularity format still on disk from before Story 1.5. */
const LEGACY_FORMAT = /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/;

/**
 * Dates spanning a wide range, including single-digit components that exercise
 * zero-padding (e.g. January, day 1, hour 0, minute 5, second 3, millis 7).
 */
const anyDateArb = fc.date({
  min: new Date("0001-01-01T00:00:00.000Z"),
  max: new Date("9999-12-31T23:59:59.999Z"),
  noInvalidDate: true,
});

/** A monotonic-counter value the adapter might inject (0..9999 fits 4 digits). */
const seqArb = fc.integer({ min: 0, max: 9999 });

describe("Feature: subby, Property 22: Collision-proof backup file names", () => {
  it("Feature: subby, Property 22: name matches YYYY-MM-DD-HH-MM-SS-mmm[.json] without a seq (Req 18.1)", () => {
    fc.assert(
      fc.property(anyDateArb, (date) => {
        expect(backupFileName(date)).toMatch(FORMAT_NO_SEQ);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("Feature: subby, Property 22: a supplied seq adds the zero-padded 4-digit tail (Req 18.1)", () => {
    fc.assert(
      fc.property(anyDateArb, seqArb, (date, seq) => {
        expect(backupFileName(date, { seq })).toMatch(FORMAT_WITH_SEQ);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("Feature: subby, Property 22: components equal the zero-padded UTC parts (Req 18.1)", () => {
    fc.assert(
      fc.property(anyDateArb, seqArb, (date, seq) => {
        const name = backupFileName(date, { seq });
        expect(FORMAT_WITH_SEQ.exec(name)).not.toBeNull();

        const [body] = name.split(".");
        const [year, month, day, hour, minute, second, millis, seqSeg] =
          body.split("-");

        expect(year).toBe(String(date.getUTCFullYear()).padStart(4, "0"));
        // getUTCMonth() is 0-based; the name uses the 1-based calendar month.
        expect(month).toBe(String(date.getUTCMonth() + 1).padStart(2, "0"));
        expect(day).toBe(String(date.getUTCDate()).padStart(2, "0"));
        expect(hour).toBe(String(date.getUTCHours()).padStart(2, "0"));
        expect(minute).toBe(String(date.getUTCMinutes()).padStart(2, "0"));
        expect(second).toBe(String(date.getUTCSeconds()).padStart(2, "0"));
        expect(millis).toBe(String(date.getUTCMilliseconds()).padStart(3, "0"));
        expect(seqSeg).toBe(String(seq).padStart(4, "0"));

        const monthNum = Number(month);
        expect(monthNum).toBeGreaterThanOrEqual(1);
        expect(monthNum).toBeLessThanOrEqual(12);
        expect(monthNum).toBe(date.getUTCMonth() + 1);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("Feature: subby, Property 22: the YYYY-MM-DD-HH-MM prefix is byte-identical to the legacy name (AD-27)", () => {
    // The leading minute-granularity prefix is byte-identical to the legacy
    // name, so for ANY two backups in *different* minutes (the common case)
    // ordering is decided entirely by this shared, zero-padded prefix — exactly
    // as before Story 1.5. The within-same-minute legacy-vs-new edge is covered
    // and waived separately below.
    fc.assert(
      fc.property(anyDateArb, seqArb, (date, seq) => {
        const name = backupFileName(date, { seq });
        const legacyPrefix =
          `${String(date.getUTCFullYear()).padStart(4, "0")}-` +
          `${String(date.getUTCMonth() + 1).padStart(2, "0")}-` +
          `${String(date.getUTCDate()).padStart(2, "0")}-` +
          `${String(date.getUTCHours()).padStart(2, "0")}-` +
          `${String(date.getUTCMinutes()).padStart(2, "0")}`;
        // The new name begins with the legacy minute prefix followed by `-SS...`.
        expect(name.startsWith(`${legacyPrefix}-`)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("Feature: subby, Property 22: cross-minute ordering is governed by the shared prefix (AD-27)", () => {
    // Two backups in DIFFERENT minutes always sort by their minute prefix,
    // regardless of the suffix — this is the ordering guarantee that actually
    // matters in practice (same-minute collisions are rare; cross-minute is the
    // norm). Build two instants a full minute apart and assert the later one
    // sorts lexicographically greater.
    fc.assert(
      fc.property(
        fc.date({
          min: new Date("2000-01-01T00:00:00.000Z"),
          max: new Date("2999-12-31T23:58:00.000Z"),
          noInvalidDate: true,
        }),
        seqArb,
        seqArb,
        (earlierDate, seqA, seqB) => {
          // laterDate is at least a full minute after earlierDate.
          const laterDate = new Date(earlierDate.getTime() + 60_000);
          const earlier = backupFileName(earlierDate, { seq: seqA });
          const later = backupFileName(laterDate, { seq: seqB });
          // Different minute prefix => later sorts strictly greater, regardless
          // of the sub-minute suffix or counter.
          expect(earlier < later).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("Feature: subby, Property 22: same-minute, same-instant backups differ when the counter differs (AD-16)", () => {
    // Two backups at the SAME instant (identical seconds + millis) but different
    // monotonic counters must yield distinct names — the collision-proof guarantee
    // the pre-migration safety backup relies on.
    fc.assert(
      fc.property(
        anyDateArb,
        fc.integer({ min: 0, max: 9998 }),
        (date, seq) => {
          const a = backupFileName(date, { seq });
          const b = backupFileName(date, { seq: seq + 1 });
          expect(a).not.toBe(b);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("Feature: subby, Property 22: monotonic counter order matches lexicographic name order (AD-27)", () => {
    // For a fixed instant, a strictly larger counter yields a lexicographically
    // larger name, so newest-first (descending) sort stays chronological even
    // among same-millisecond backups.
    fc.assert(
      fc.property(
        anyDateArb,
        fc.integer({ min: 0, max: 9998 }),
        (date, seq) => {
          const earlier = backupFileName(date, { seq });
          const later = backupFileName(date, { seq: seq + 1 });
          expect(earlier.localeCompare(later)).toBeLessThan(0);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("Feature: subby, Property 22: the seq segment stays width-stable (4 digits) and sort-correct across its whole range (AD-16, AD-27)", () => {
    // Regression guard against an accumulating counter widening past 4 digits: a
    // 5-digit seq would break both the documented format AND ordering (e.g.
    // "...-9999.json" would sort NEWER than "...-10000.json" because '9' > '1').
    // Across the full valid seq range at a fixed instant, assert the segment is
    // ALWAYS exactly 4 digits and that lexicographic order equals numeric order.
    const fixed = new Date("2026-03-07T09:05:42.137Z");
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 9998 }),
        fc.integer({ min: 1, max: 9999 }),
        (lo, delta) => {
          const hi = Math.min(lo + delta, 9999);
          fc.pre(hi > lo);
          const nameLo = backupFileName(fixed, { seq: lo });
          const nameHi = backupFileName(fixed, { seq: hi });
          // Both seq segments are exactly 4 digits (never 5+).
          const segLo = nameLo.split(".")[0].split("-").at(-1);
          const segHi = nameHi.split(".")[0].split("-").at(-1);
          expect(segLo).toHaveLength(4);
          expect(segHi).toHaveLength(4);
          // Numeric order (lo < hi) == lexicographic order of the names.
          expect(nameLo < nameHi).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("example: cross-minute names sort newest-first correctly (Req 18.2)", () => {
    // The common, practically-relevant case: backups in different minutes always
    // order by the shared zero-padded prefix. A legacy minute-only name from an
    // earlier minute sorts as older; a new-format name from a later minute sorts
    // as newer. Verified under the same descending `localeCompare` that
    // `listBackups` uses.
    const legacyEarlier = "2025-03-07-09-05.json";
    const newLater = "2025-03-07-09-06-42-137-0003.json"; // one minute later
    expect(legacyEarlier).toMatch(LEGACY_FORMAT);
    expect(newLater).toMatch(FORMAT_WITH_SEQ);
    const names = [legacyEarlier, newLater].sort((a, b) => b.localeCompare(a));
    expect(names).toEqual([newLater, legacyEarlier]);
  });

  it("example: within the SAME minute, a legacy name sorts as newest — a benign, waived edge (AD-16 design note)", () => {
    // Documented edge: `.` (0x2E) > `-` (0x2D), so at the point the two names
    // diverge the legacy `...-MM.json` is lexicographically GREATER than a
    // same-minute `...-MM-SS...json`. Under newest-first (descending) sort the
    // legacy name therefore appears first. This is harmless: a legacy name only
    // ever exists from BEFORE this change shipped, so any same-minute pairing is
    // vanishingly rare and the legacy backup is, in wall-clock terms, the older
    // one. Cross-minute ordering (the case that matters) is always correct.
    const legacy = "2025-03-07-09-05.json";
    const newSameMinute = "2025-03-07-09-05-42-137-0003.json";
    const names = [legacy, newSameMinute].sort((a, b) => b.localeCompare(a));
    // Actual, asserted behavior (not an aspiration): legacy sorts first.
    expect(names).toEqual([legacy, newSameMinute]);
  });
});
