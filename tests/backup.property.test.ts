import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { backupFileName } from "core/backup";

/**
 * Property 22: Backup file names follow the timestamp format.
 * Validates: Requirements 18.1
 *
 * Req 18.1 — a timestamped backup file name of the form `YYYY-MM-DD-HH-MM.json`.
 *
 * For any Date, `backupFileName(date)`:
 *   - matches /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/, and
 *   - embeds the UTC year/month/day/hour/minute of the date, each zero-padded,
 *     with month being the 1-based calendar month (getUTCMonth() + 1), in 01–12.
 */

const NUM_RUNS = 200;

const FORMAT = /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/;

/**
 * Dates spanning a wide range, including single-digit components that exercise
 * zero-padding (e.g. January, day 1, hour 0, minute 5).
 */
const anyDateArb = fc.date({
  min: new Date("0001-01-01T00:00:00.000Z"),
  max: new Date("9999-12-31T23:59:59.999Z"),
  noInvalidDate: true,
});

describe("Feature: subby, Property 22: Backup file names follow the timestamp format", () => {
  it("Feature: subby, Property 22: name matches YYYY-MM-DD-HH-MM.json (Req 18.1)", () => {
    fc.assert(
      fc.property(anyDateArb, (date) => {
        expect(backupFileName(date)).toMatch(FORMAT);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("Feature: subby, Property 22: components equal the zero-padded UTC parts (Req 18.1)", () => {
    fc.assert(
      fc.property(anyDateArb, (date) => {
        const name = backupFileName(date);
        const match = FORMAT.exec(name);
        expect(match).not.toBeNull();

        // Decompose the produced name into its five components.
        const [body] = name.split(".");
        const [year, month, day, hour, minute] = body.split("-");

        // Each component reflects the UTC value of the date, zero-padded.
        expect(year).toBe(String(date.getUTCFullYear()).padStart(4, "0"));
        // getUTCMonth() is 0-based; the name uses the 1-based calendar month.
        expect(month).toBe(String(date.getUTCMonth() + 1).padStart(2, "0"));
        expect(day).toBe(String(date.getUTCDate()).padStart(2, "0"));
        expect(hour).toBe(String(date.getUTCHours()).padStart(2, "0"));
        expect(minute).toBe(String(date.getUTCMinutes()).padStart(2, "0"));

        // Month is always a valid 1-based calendar month.
        const monthNum = Number(month);
        expect(monthNum).toBeGreaterThanOrEqual(1);
        expect(monthNum).toBeLessThanOrEqual(12);
        // It is exactly the 0-based getUTCMonth() shifted by one.
        expect(monthNum).toBe(date.getUTCMonth() + 1);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
