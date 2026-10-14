import { describe, it, expect } from "vitest";

import {
  catchUp,
  prune,
  reminderDay,
  unfired,
  type CatchUpSubscription,
} from "core/notify";
import type { ReminderEvent, ReminderLedger } from "core/models/reminder";

/**
 * Concrete example tests for the Story 4.1 reminder-ledger decision helpers —
 * the I/O & Edge-Case Matrix rows plus the amended fail-CLOSED guard cases.
 *
 * These complement the fast-check property tests in `notify.property.test.ts`:
 * the properties pin the general invariants; these pin the specific numbers in
 * the spec's matrix (IST/PST day boundaries, distinct-kind dedupe, catch-up
 * window edges) and the exact fail-closed behaviors (RangeError on bad input,
 * `[]` on a bad window, no-op on a bad `today`).
 */

function ledger(partial: Partial<ReminderLedger> = {}): ReminderLedger {
  return { version: 1, lastRunAt: null, fired: [], ...partial };
}

describe("reminderDay — canonical local calendar day (AD-18)", () => {
  it("IST (+330) near a UTC midnight returns the LOCAL day, not the UTC day", () => {
    // 2026-03-07T23:30:00Z is 2026-03-08T05:00 IST → local day is the 8th.
    expect(reminderDay("2026-03-07T23:30:00Z", 330)).toBe("2026-03-08");
  });

  it("PST (-480) just after a UTC midnight returns the PREVIOUS local day", () => {
    // 2026-03-07T02:00:00Z is 2026-03-06T18:00 PST → local day is the 6th.
    expect(reminderDay("2026-03-07T02:00:00Z", -480)).toBe("2026-03-06");
  });

  it("UTC (offset 0) returns the UTC day", () => {
    expect(reminderDay("2026-03-07T23:30:00Z", 0)).toBe("2026-03-07");
  });

  it("fail-closed: throws RangeError on an unparseable instant (never 'NaN-NaN-NaN')", () => {
    expect(() => reminderDay("garbage", 0)).toThrow(RangeError);
    // Explicitly confirm the forbidden NaN day never escapes.
    let out = "";
    try {
      out = reminderDay("garbage", 0);
    } catch {
      out = "threw";
    }
    expect(out).toBe("threw");
    expect(out).not.toContain("NaN");
  });

  it("fail-closed: throws RangeError on a non-finite offset", () => {
    expect(() => reminderDay("2026-03-07T00:00:00Z", Number.NaN)).toThrow(RangeError);
    expect(() => reminderDay("2026-03-07T00:00:00Z", Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("fail-closed: throws RangeError on a finite-but-out-of-range offset (never a NaN day)", () => {
    // 1e20 minutes shifts the epoch past Date's valid range → Invalid Date.
    expect(() => reminderDay("2026-03-07T00:00:00Z", 1e20)).toThrow(RangeError);
  });
});

describe("unfired — set-difference on the identity tuple", () => {
  const renewalA: ReminderEvent = {
    kind: "renewal",
    subscriptionId: "a",
    leadTime: "one-day",
    localDay: "2026-06-10",
  };

  it("filters a due event whose exact tuple is already fired", () => {
    expect(unfired([renewalA], ledger({ fired: [renewalA] }))).toEqual([]);
  });

  it("a different kind is NOT deduped (distinct identity)", () => {
    const trialEndA: ReminderEvent = { ...renewalA, kind: "trial-end" };
    // Ledger has the RENEWAL fired; the trial-end of the same id/leadTime/day
    // is a different event and must still be returned.
    expect(unfired([trialEndA], ledger({ fired: [renewalA] }))).toEqual([trialEndA]);
  });

  it("preserves input order of surviving events", () => {
    const e1: ReminderEvent = { ...renewalA, subscriptionId: "a" };
    const e2: ReminderEvent = { ...renewalA, subscriptionId: "b" };
    const e3: ReminderEvent = { ...renewalA, subscriptionId: "c" };
    // e2 is already fired; e1 and e3 survive in order.
    expect(unfired([e1, e2, e3], ledger({ fired: [e2] }))).toEqual([e1, e3]);
  });
});

describe("catchUp — events whose moment passed while closed (AD-20)", () => {
  const now = "2026-06-15T12:00:00.000Z";

  function sub(overrides: Partial<CatchUpSubscription> = {}): CatchUpSubscription {
    return { id: "a", nextRenewal: "2026-06-15", state: "Active", ...overrides };
  }

  it("returns a renewal event whose fire-moment is within [now-lookback, now]", () => {
    // same-day lead on a renewal that is today → fire moment 2026-06-15T00:00Z,
    // which is 12h before `now` → inside a 24h look-back.
    const result = catchUp([sub()], ledger(), now, 24);
    const sameDay = result.find((e) => e.leadTime === "same-day");
    expect(sameDay).toBeDefined();
    expect(sameDay?.kind).toBe("renewal");
    expect(sameDay?.localDay).toBe("2026-06-15");
  });

  it("excludes an event whose moment is OLDER than the look-back window", () => {
    // lastRunAt 2 days ago, lookback 24h → anchor is now-24h. A three-days lead
    // on a renewal 3 days from now fires on 2026-06-15 (today) — in window; but a
    // same-day lead on a renewal that was 2 days ago fires 2 days ago — excluded.
    const past = catchUp(
      [sub({ nextRenewal: "2026-06-13" })], // same-day fires 2026-06-13T00:00Z
      ledger({ lastRunAt: "2026-06-13T12:00:00.000Z" }),
      now,
      24,
    );
    expect(past.some((e) => e.leadTime === "same-day")).toBe(false);
  });

  it("anchors on lastRunAt when it is NEWER than now-lookback", () => {
    // lastRunAt is 6h ago; lookback is 240h. The anchor is lastRunAt (6h ago),
    // so a same-day renewal that fired 12h ago (00:00Z today) is BEFORE the
    // anchor and excluded, even though it is within the raw 240h look-back.
    const result = catchUp(
      [sub()],
      ledger({ lastRunAt: "2026-06-15T06:00:00.000Z" }),
      now,
      240,
    );
    expect(result.some((e) => e.leadTime === "same-day")).toBe(false);
  });

  it("skips a Paused sub entirely", () => {
    expect(catchUp([sub({ state: "Paused" })], ledger(), now, 24)).toEqual([]);
  });

  it("includes a Trial sub (eligible like Active)", () => {
    const result = catchUp([sub({ state: "Trial" })], ledger(), now, 24);
    expect(result.length).toBeGreaterThan(0);
  });

  it("does not re-fire an event already in the ledger", () => {
    const alreadyFired: ReminderEvent = {
      kind: "renewal",
      subscriptionId: "a",
      leadTime: "same-day",
      localDay: "2026-06-15",
    };
    const result = catchUp([sub()], ledger({ fired: [alreadyFired] }), now, 24);
    expect(result.some((e) => e.leadTime === "same-day")).toBe(false);
  });

  it("fail-closed: a bad `now` returns [] (never emits every event)", () => {
    expect(catchUp([sub()], ledger(), "not-a-date", 24)).toEqual([]);
  });

  it("fail-closed: a non-finite `lookbackHours` returns []", () => {
    expect(catchUp([sub()], ledger(), now, Number.NaN)).toEqual([]);
    expect(catchUp([sub()], ledger(), now, Number.POSITIVE_INFINITY)).toEqual([]);
  });

  it("fail-closed: a sub with an unparseable nextRenewal is skipped, others still fire", () => {
    const good = sub({ id: "good", nextRenewal: "2026-06-15" });
    const bad = sub({ id: "bad", nextRenewal: "nope" });
    const result = catchUp([bad, good], ledger(), now, 24);
    // The bad sub emits nothing; the good one still fires its same-day event.
    expect(result.every((e) => e.subscriptionId === "good")).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("prune — retention window on localDay", () => {
  const base = (localDay: string): ReminderEvent => ({
    kind: "renewal",
    subscriptionId: "a",
    leadTime: "one-day",
    localDay,
  });

  it("drops entries older than today - retentionDays, keeps newer + lastRunAt", () => {
    const l = ledger({
      lastRunAt: "2026-06-15T00:00:00.000Z",
      fired: [base("2026-05-01"), base("2026-06-10"), base("2026-06-15")],
    });
    // retention 30 days from 2026-06-15 → cutoff 2026-05-16.
    const result = prune(l, "2026-06-15", 30);
    expect(result.fired.map((e) => e.localDay)).toEqual(["2026-06-10", "2026-06-15"]);
    // lastRunAt untouched.
    expect(result.lastRunAt).toBe("2026-06-15T00:00:00.000Z");
  });

  it("fail-closed: clamps a negative retentionDays to 0 (keeps only today-or-newer)", () => {
    const l = ledger({ fired: [base("2026-06-14"), base("2026-06-15"), base("2026-06-16")] });
    const result = prune(l, "2026-06-15", -10);
    // cutoff clamps to today (2026-06-15) → the 14th drops, 15th/16th stay.
    expect(result.fired.map((e) => e.localDay)).toEqual(["2026-06-15", "2026-06-16"]);
  });

  it("fail-closed: an unparseable `today` leaves the ledger UNCHANGED (never drops newer)", () => {
    const l = ledger({ fired: [base("2026-06-14"), base("2026-06-15")] });
    const result = prune(l, "garbage", 30);
    expect(result.fired).toEqual(l.fired);
  });

  it("fail-closed: a non-finite retentionDays leaves the ledger UNCHANGED (never drops off a NaN cutoff)", () => {
    const l = ledger({ fired: [base("2026-06-14"), base("2026-06-15"), base("2026-06-16")] });
    // NaN and +Infinity are both non-finite → no-op (fired preserved verbatim).
    expect(prune(l, "2026-06-15", Number.NaN).fired).toEqual(l.fired);
    expect(prune(l, "2026-06-15", Number.POSITIVE_INFINITY).fired).toEqual(l.fired);
  });
});
