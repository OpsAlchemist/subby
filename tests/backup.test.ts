import { describe, it, expect } from "vitest";

import { backupDue, backupFileName, backupTimestamp, DAY_MS, WEEK_MS } from "core/backup";

/**
 * Unit matrix for the pure `backupDue` scheduled-cadence predicate (Story 7.3).
 *
 * `backupDue(frequency, lastBackupAt, nowIso)` is PURE — it reads NO ambient
 * clock, only its injected ISO-string arguments — so every case here is a plain,
 * deterministic input→output assertion with no mocks or fake timers.
 *
 * The matrix mirrors the spec I/O table: off→never; null→due; daily/weekly
 * boundaries at exactly the period; a future last-backup (clock skew)→not due; an
 * unparseable last-backup→due (safe over-backup, self-heals on the next stamp).
 */

/** A fixed "now" instant all relative cases anchor on. */
const NOW = "2026-03-07T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);

/** Build an ISO instant `ms` milliseconds before NOW. */
function beforeNow(ms: number): string {
  return new Date(NOW_MS - ms).toISOString();
}

/** Build an ISO instant `ms` milliseconds AFTER NOW (future / clock-skew). */
function afterNow(ms: number): string {
  return new Date(NOW_MS + ms).toISOString();
}

describe("backupDue — scheduled-cadence predicate (Story 7.3)", () => {
  it("exposes the DAY_MS / WEEK_MS period constants", () => {
    expect(DAY_MS).toBe(24 * 60 * 60 * 1000);
    expect(WEEK_MS).toBe(7 * DAY_MS);
  });

  it("off → false (never), regardless of lastBackupAt", () => {
    expect(backupDue("off", null, NOW)).toBe(false);
    expect(backupDue("off", beforeNow(WEEK_MS * 10), NOW)).toBe(false);
    expect(backupDue("off", afterNow(DAY_MS), NOW)).toBe(false);
    expect(backupDue("off", "not-a-date", NOW)).toBe(false);
  });

  it("never backed up (lastBackupAt null) → due for daily and weekly", () => {
    expect(backupDue("daily", null, NOW)).toBe(true);
    expect(backupDue("weekly", null, NOW)).toBe(true);
  });

  it("daily: <24h elapsed → not due; >=24h → due (boundary inclusive)", () => {
    // 1h ago → not due.
    expect(backupDue("daily", beforeNow(60 * 60 * 1000), NOW)).toBe(false);
    // Just under 24h → not due.
    expect(backupDue("daily", beforeNow(DAY_MS - 1), NOW)).toBe(false);
    // Exactly 24h → due (>= boundary).
    expect(backupDue("daily", beforeNow(DAY_MS), NOW)).toBe(true);
    // 25h ago → due.
    expect(backupDue("daily", beforeNow(25 * 60 * 60 * 1000), NOW)).toBe(true);
  });

  it("weekly: <7d elapsed → not due; >=7d → due (boundary inclusive)", () => {
    // 3d ago → not due.
    expect(backupDue("weekly", beforeNow(3 * DAY_MS), NOW)).toBe(false);
    // Just under 7d → not due.
    expect(backupDue("weekly", beforeNow(WEEK_MS - 1), NOW)).toBe(false);
    // Exactly 7d → due.
    expect(backupDue("weekly", beforeNow(WEEK_MS), NOW)).toBe(true);
    // 8d ago → due.
    expect(backupDue("weekly", beforeNow(8 * DAY_MS), NOW)).toBe(true);
  });

  it("future last-backup (clock skew, negative elapsed) → NOT due (no spurious backup)", () => {
    expect(backupDue("daily", afterNow(60 * 60 * 1000), NOW)).toBe(false);
    expect(backupDue("weekly", afterNow(DAY_MS), NOW)).toBe(false);
  });

  it("unparseable last-backup (NaN elapsed) → due (safe over-backup, self-heals)", () => {
    expect(backupDue("daily", "not-a-date", NOW)).toBe(true);
    expect(backupDue("weekly", "garbage", NOW)).toBe(true);
  });

  it("zero elapsed (lastBackupAt === nowIso) → NOT due", () => {
    // Exactly 0ms elapsed is below BOTH thresholds (the `>=` fires only AT the
    // period, never at 0) — a backup taken this very instant is not re-due.
    expect(backupDue("daily", NOW, NOW)).toBe(false);
    expect(backupDue("weekly", NOW, NOW)).toBe(false);
  });

  it("unparseable nowIso (NaN elapsed) → due (defensive backstop)", () => {
    // The live app always passes `new Date().toISOString()` for nowIso, so this
    // branch is a defensive backstop — but a NaN from either operand must land
    // on the safe over-backup side, never silently never-fire.
    expect(backupDue("daily", beforeNow(DAY_MS), "garbage")).toBe(true);
    expect(backupDue("weekly", null, "not-a-date")).toBe(true); // null short-circuits → true anyway
  });
});

/**
 * Unit matrix for the pure `backupTimestamp` name→instant parser (Story 7.4).
 *
 * `backupTimestamp(name)` is PURE — it reads NO clock (it builds the instant from
 * the parsed integer components via `Date.UTC`, never an argless `new Date()`) —
 * so every case is a plain, deterministic input→output assertion. It is the
 * display inverse of `backupFileName` (which formats UTC components with the
 * `getUTC*` accessors).
 */
describe("backupTimestamp — name→ISO instant parser (Story 7.4)", () => {
  it("parses a full collision-proof name to the exact UTC ISO instant", () => {
    // 2025-03-07 09:05:42.137 UTC; the trailing seq (-0003) is ignored.
    expect(backupTimestamp("2025-03-07-09-05-42-137-0003.json")).toBe(
      "2025-03-07T09:05:42.137Z",
    );
  });

  it("ignores the trailing seq segment (does not affect the instant)", () => {
    const withSeq = backupTimestamp("2025-03-07-09-05-42-137-0003.json");
    const withoutSeq = backupTimestamp("2025-03-07-09-05-42-137.json");
    expect(withSeq).toBe("2025-03-07T09:05:42.137Z");
    expect(withoutSeq).toBe("2025-03-07T09:05:42.137Z");
    expect(withSeq).toBe(withoutSeq);
  });

  it("parses a legacy minute-granularity name (seconds/millis default to 0)", () => {
    expect(backupTimestamp("2025-03-07-09-05.json")).toBe(
      "2025-03-07T09:05:00.000Z",
    );
  });

  it("parses with or without the trailing .json (case-insensitive)", () => {
    expect(backupTimestamp("2025-03-07-09-05-42-137")).toBe(
      "2025-03-07T09:05:42.137Z",
    );
    expect(backupTimestamp("2025-03-07-09-05.JSON")).toBe(
      "2025-03-07T09:05:00.000Z",
    );
  });

  it("returns null for a foreign / truncated / non-conforming name", () => {
    expect(backupTimestamp("export.json")).toBeNull();
    expect(backupTimestamp("2025-03-07.json")).toBeNull(); // date only, no time
    expect(backupTimestamp("2025-03-07-09.json")).toBeNull(); // missing minute
    expect(backupTimestamp("not-a-backup")).toBeNull();
    expect(backupTimestamp("")).toBeNull();
    // Partial sub-minute precision (seconds without millis) is not a valid shape.
    expect(backupTimestamp("2025-03-07-09-05-42.json")).toBeNull();
  });

  it("returns null for a name that violates the fixed-width component shape", () => {
    // A 5-digit year cannot match the anchored, fixed-width `\d{4}` year field,
    // so the whole name fails the pattern and parses to null (never a wrong,
    // silently-rolled-over instant).
    expect(backupTimestamp("99999-03-07-09-05.json")).toBeNull();
  });

  it("returns null for width-correct but OUT-OF-RANGE components (no silent rollover)", () => {
    // Each of these matches the fixed-width regex but names an impossible
    // component. `Date.UTC` would SILENTLY ROLL them over to a valid-but-wrong
    // instant (month 13 → next January, day 32 → next month, hour 25 → next
    // day, minute 61 → +1h, second 99 → +min), which would show a confidently
    // WRONG date on the destructive restore confirm. The round-trip guard must
    // reject every one as null (the row then falls back to the raw name).
    expect(backupTimestamp("2025-13-07-09-05.json")).toBeNull(); // month 13
    expect(backupTimestamp("2025-00-07-09-05.json")).toBeNull(); // month 00
    expect(backupTimestamp("2025-03-32-09-05.json")).toBeNull(); // day 32
    expect(backupTimestamp("2025-03-00-09-05.json")).toBeNull(); // day 00
    expect(backupTimestamp("2025-03-07-25-05.json")).toBeNull(); // hour 25
    expect(backupTimestamp("2025-03-07-09-61.json")).toBeNull(); // minute 61
    expect(backupTimestamp("2025-03-07-09-05-99-000.json")).toBeNull(); // second 99
    expect(backupTimestamp("0000-00-00-00-00.json")).toBeNull(); // all-zero absurd
    // A real last-day-of-month / leap value still parses (sanity: the guard
    // rejects rollover, not every boundary).
    expect(backupTimestamp("2024-02-29-23-59.json")).toBe("2024-02-29T23:59:00.000Z");
    expect(backupTimestamp("2025-12-31-23-59-59-999.json")).toBe(
      "2025-12-31T23:59:59.999Z",
    );
  });

  it("round-trips with backupFileName (display inverse of the formatter)", () => {
    // A fixed instant → name → back to the same ISO instant.
    const instant = new Date("2026-11-23T18:04:09.512Z");
    const name = backupFileName(instant, { seq: 7 });
    expect(backupTimestamp(name)).toBe(instant.toISOString());
    // And without a seq.
    const name2 = backupFileName(instant);
    expect(backupTimestamp(name2)).toBe(instant.toISOString());
  });
});
