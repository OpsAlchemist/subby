import { describe, it, expect } from "vitest";

import { backupDue, DAY_MS, WEEK_MS } from "core/backup";

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
