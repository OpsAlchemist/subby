import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  catchUp,
  dueLeadTimes,
  prune,
  reminderDay,
  unfired,
  type CatchUpSubscription,
} from "core/notify";
import type { ISODate } from "core/renewal";
import type { Subscription } from "core/models/subscription";
import type { ReminderLeadTime } from "core/models/settings";
import type { ReminderEvent, ReminderLedger } from "core/models/reminder";

/**
 * Property 17: Due lead times are exactly the enabled ones whose target date is today.
 * Validates: Requirements 13.1, 13.5
 *
 * Req 13.1 — for each enabled reminder lead time (same-day / one-day / three-days),
 *            a notification is due when the configured lead time targets today
 *            relative to `nextRenewal`.
 * Req 13.5 — only the currently-enabled lead times are considered, so updated
 *            notification timing applies to subsequent evaluations.
 *
 * For an arbitrary subscription, an arbitrary `today`, and an arbitrary subset of
 * enabled lead times, `dueLeadTimes` returns EXACTLY the lead times that are both
 *   (a) in the enabled set, AND
 *   (b) whose target date (`today + offset(leadTime)`) equals `sub.nextRenewal`.
 *
 * The `offsetDays` generator constructs `nextRenewal = today + offsetDays`, drawing
 * `offsetDays` from {0, 1, 3} (the qualifying offsets) and other values (negative,
 * 2, 4, 5, 7, ...) so both the inclusion and the exclusion branches are exercised.
 */

const NUM_RUNS = 300;

// --- Reference date math (independent of the implementation) ----------------

/** Adds a whole number of days to an `YYYY-MM-DD` date using UTC arithmetic. */
function addDays(date: ISODate, days: number): ISODate {
  const [year, month, day] = date.split("-").map((p) => Number.parseInt(p, 10));
  const utc = new Date(Date.UTC(year, month - 1, day));
  utc.setUTCDate(utc.getUTCDate() + days);
  const yyyy = String(utc.getUTCFullYear()).padStart(4, "0");
  const mm = String(utc.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(utc.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Days before `nextRenewal` that each lead time targets (per the spec). */
const OFFSET_BY_LEAD_TIME: Record<ReminderLeadTime, number> = {
  "same-day": 0,
  "one-day": 1,
  "three-days": 3,
};

const ALL_LEAD_TIMES: readonly ReminderLeadTime[] = ["same-day", "one-day", "three-days"];

// --- Generators --------------------------------------------------------------

/** A valid YYYY-MM-DD calendar date (day capped at 28 to stay month-agnostic). */
const isoDateArb = fc
  .record({
    year: fc.integer({ min: 2000, max: 2099 }),
    month: fc.integer({ min: 1, max: 12 }),
    day: fc.integer({ min: 1, max: 28 }),
  })
  .map(
    ({ year, month, day }) =>
      `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(
        day,
      ).padStart(2, "0")}`,
  );

const leadTimeArb = fc.constantFrom<ReminderLeadTime>("same-day", "one-day", "three-days");

/** An arbitrary subset (possibly empty) of the three lead times. */
const enabledArb = fc.uniqueArray(leadTimeArb, { maxLength: 3 });

/**
 * Offset (in days) used to place `nextRenewal` relative to `today`. Biased toward
 * the three qualifying offsets {0, 1, 3} but also drawing nearby and far values
 * (including negatives) so exclusion is heavily exercised.
 */
const offsetDaysArb = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(0, 1, 3) },
  { weight: 2, arbitrary: fc.integer({ min: -5, max: 10 }) },
);

/**
 * A full, type-valid subscription. Only `nextRenewal` matters to `dueLeadTimes`,
 * but a complete object keeps the test honest against the real type. `nextRenewal`
 * is derived from `today + offsetDays` by the caller below.
 */
function makeSubscription(nextRenewal: ISODate): Subscription {
  return {
    id: "sub-1",
    name: "Test",
    provider: "Provider",
    category: "Streaming",
    amount: 100,
    currency: "INR",
    billingCycle: "Monthly",
    nextRenewal,
    startDate: "2020-01-01",
    paymentMethod: "card",
    website: "",
    notes: "",
    color: "#000000",
    icon: "tv",
    isActive: true,
    autoRenew: true,
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
  };
}

describe("Feature: subby, Property 17: Due lead times are exactly the enabled ones whose target date is today", () => {
  it("Feature: subby, Property 17: returns exactly the enabled lead times due today, ordered and de-duplicated (Req 13.1, 13.5)", () => {
    fc.assert(
      fc.property(isoDateArb, offsetDaysArb, enabledArb, (today, offsetDays, enabled) => {
        const nextRenewal = addDays(today, offsetDays);
        const sub = makeSubscription(nextRenewal);
        const enabledSet = new Set(enabled);

        const result = dueLeadTimes(sub, today, enabled);

        // Independent reference: a lead time is due iff it is enabled AND its
        // target date (today + offset) equals nextRenewal. In canonical order.
        const expected = ALL_LEAD_TIMES.filter(
          (lt) =>
            enabledSet.has(lt) &&
            addDays(today, OFFSET_BY_LEAD_TIME[lt]) === sub.nextRenewal,
        );

        // EXACT match (set + canonical ordering).
        expect(result).toEqual(expected);

        // Only enabled lead times are ever returned (Req 13.5).
        for (const lt of result) {
          expect(enabledSet.has(lt)).toBe(true);
        }

        // A lead time is returned iff nextRenewal == today + offset(leadTime).
        for (const lt of ALL_LEAD_TIMES) {
          const due = sub.nextRenewal === addDays(today, OFFSET_BY_LEAD_TIME[lt]);
          const shouldBeReturned = enabledSet.has(lt) && due;
          expect(result.includes(lt)).toBe(shouldBeReturned);
        }

        // No duplicates in the result.
        expect(new Set(result).size).toBe(result.length);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("Feature: subby, Property 17: disabled lead times are never returned even when their date is due (Req 13.5)", () => {
    // Force nextRenewal to be exactly due for `target`, then only enable the
    // OTHER lead times: the due one must be excluded purely because it is disabled.
    fc.assert(
      fc.property(isoDateArb, leadTimeArb, (today, target) => {
        const nextRenewal = addDays(today, OFFSET_BY_LEAD_TIME[target]);
        const sub = makeSubscription(nextRenewal);
        const enabledWithoutTarget = ALL_LEAD_TIMES.filter((lt) => lt !== target);

        const result = dueLeadTimes(sub, today, enabledWithoutTarget);

        expect(result.includes(target)).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// =============================================================================
// Persisted reminder-ledger decision helpers (Story 4.1 — AD-18 / AD-19).
//
// Property coverage for the four pure helpers the scheduler/catch-up consume:
//   - reminderDay round-trips a known offset table (local, not UTC, day).
//   - unfired never returns a fired identity tuple and preserves order.
//   - prune keeps exactly the entries within retention (and never newer ones).
//   - catchUp never returns a Paused sub nor an already-fired event, and
//     respects the look-back window.
// =============================================================================

const eventKindArb = fc.constantFrom<ReminderEvent["kind"]>("renewal", "trial-end");
const stateArb = fc.constantFrom<CatchUpSubscription["state"]>("Active", "Paused", "Trial");

/** An arbitrary fired-reminder event over a bounded id/day space. */
const reminderEventArb: fc.Arbitrary<ReminderEvent> = fc.record({
  kind: eventKindArb,
  subscriptionId: fc.constantFrom("a", "b", "c", "d"),
  leadTime: leadTimeArb,
  localDay: isoDateArb,
});

/** The identity tuple used to compare events (kind + id + leadTime + localDay). */
function identity(e: ReminderEvent): string {
  return `${e.kind}|${e.subscriptionId}|${e.leadTime}|${e.localDay}`;
}

/** Reference local-day shift, independent of the implementation. */
function referenceReminderDay(instant: string, tzOffsetMinutes: number): string {
  const shifted = new Date(Date.parse(instant) + tzOffsetMinutes * 60_000);
  const yyyy = String(shifted.getUTCFullYear()).padStart(4, "0");
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(shifted.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

describe("Feature: subby, Story 4.1: reminderDay is the one canonical local-day function (AD-18)", () => {
  it("matches an independent UTC-shift reference across a known offset table", () => {
    const offsets = [0, 330, -480, 60, -60, 720, -720, 345]; // UTC, IST, PST, …
    fc.assert(
      fc.property(
        fc.date({ min: new Date("2000-01-01T00:00:00Z"), max: new Date("2099-12-31T23:59:59Z") }),
        fc.constantFrom(...offsets),
        (d, offset) => {
          const instant = d.toISOString();
          expect(reminderDay(instant, offset)).toBe(referenceReminderDay(instant, offset));
          // Never a NaN-bearing day.
          expect(reminderDay(instant, offset)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("throws RangeError on an unparseable instant or a non-finite offset (fail-closed)", () => {
    expect(() => reminderDay("not-a-date", 0)).toThrow(RangeError);
    expect(() => reminderDay("2026-03-07T00:00:00Z", Number.NaN)).toThrow(RangeError);
    expect(() => reminderDay("2026-03-07T00:00:00Z", Infinity)).toThrow(RangeError);
  });
});

describe("Feature: subby, Story 4.1: unfired is an order-preserving set-difference on identity", () => {
  it("never returns an already-fired identity tuple and preserves input order", () => {
    fc.assert(
      fc.property(
        fc.array(reminderEventArb, { maxLength: 12 }),
        fc.array(reminderEventArb, { maxLength: 12 }),
        (due, firedEvents) => {
          const ledger: ReminderLedger = { version: 1, lastRunAt: null, fired: firedEvents };
          const result = unfired(due, ledger);
          const firedIds = new Set(firedEvents.map(identity));

          // (1) No result event is in the fired set.
          for (const e of result) {
            expect(firedIds.has(identity(e))).toBe(false);
          }
          // (2) Order-preserving: the result is `due` with fired items removed,
          // in the same relative order.
          const expected = due.filter((e) => !firedIds.has(identity(e)));
          expect(result).toEqual(expected);
          // (3) Every un-fired due event survives (no over-filtering).
          expect(result.length).toBe(expected.length);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("treats a different kind as a distinct identity (not deduped)", () => {
    fc.assert(
      fc.property(reminderEventArb, (base) => {
        const renewal: ReminderEvent = { ...base, kind: "renewal" };
        const trialEnd: ReminderEvent = { ...base, kind: "trial-end" };
        const ledger: ReminderLedger = { version: 1, lastRunAt: null, fired: [renewal] };
        // The trial-end event has the same id/leadTime/day but a different kind,
        // so it is NOT deduped against the fired renewal.
        expect(unfired([trialEnd], ledger)).toEqual([trialEnd]);
        // The renewal itself IS deduped.
        expect(unfired([renewal], ledger)).toEqual([]);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("Feature: subby, Story 4.1: prune keeps exactly the entries within retention", () => {
  it("keeps entries with localDay >= today - retentionDays, drops older, never newer", () => {
    fc.assert(
      fc.property(
        isoDateArb,
        fc.integer({ min: 0, max: 400 }),
        fc.array(reminderEventArb, { maxLength: 20 }),
        fc.option(isoDateArb, { nil: null }),
        (today, retentionDays, firedEvents, lastRunAt) => {
          const ledger: ReminderLedger = { version: 1, lastRunAt, fired: firedEvents };
          const cutoff = addDays(today, -retentionDays);
          const result = prune(ledger, today, retentionDays);

          // Independent reference: keep iff localDay >= cutoff.
          const expectedKept = firedEvents.filter((e) => e.localDay >= cutoff);
          expect(result.fired).toEqual(expectedKept);
          // Every kept entry is within retention; nothing older survives.
          for (const e of result.fired) {
            expect(e.localDay >= cutoff).toBe(true);
          }
          // lastRunAt is never touched.
          expect(result.lastRunAt).toBe(lastRunAt);
          expect(result.version).toBe(1);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("clamps a negative retentionDays to 0 (keeps only today-or-newer, never drops newer)", () => {
    fc.assert(
      fc.property(
        isoDateArb,
        fc.integer({ min: -400, max: -1 }),
        fc.array(reminderEventArb, { maxLength: 20 }),
        (today, negativeRetention, firedEvents) => {
          const ledger: ReminderLedger = { version: 1, lastRunAt: null, fired: firedEvents };
          const result = prune(ledger, today, negativeRetention);
          // Clamp to 0 → cutoff === today → keep only localDay >= today.
          const expectedKept = firedEvents.filter((e) => e.localDay >= today);
          expect(result.fired).toEqual(expectedKept);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("Feature: subby, Story 4.1: catchUp never fires a Paused or already-fired event, respects the window", () => {
  it("returns only Active/Trial due renewal events in [max(lastRunAt, now-lookback), now], not already fired", () => {
    fc.assert(
      fc.property(
        // A set of subs with varied states and renewal dates near `now`. Ids are
        // UNIQUE: the real catch-up caller passes the live subscription list
        // (unique ids), and the helper deliberately does not dedupe duplicate
        // identical events within one pass (triage finding E — not a defect).
        fc.uniqueArray(
          fc.record({
            id: fc.constantFrom("a", "b", "c", "d"),
            dayOffset: fc.integer({ min: -5, max: 10 }),
            state: stateArb,
          }),
          { maxLength: 4, selector: (s) => s.id },
        ),
        fc.integer({ min: 1, max: 240 }), // lookbackHours
        fc.option(fc.integer({ min: 1, max: 480 }), { nil: null }), // lastRunAt hours before now
        fc.array(reminderEventArb, { maxLength: 8 }), // pre-fired
        (subSpecs, lookbackHours, lastRunHoursAgo, firedEvents) => {
          // Anchor `now` at a fixed instant so the test is deterministic.
          const nowMs = Date.parse("2026-06-15T12:00:00.000Z");
          const now = new Date(nowMs).toISOString();
          const nowDay = "2026-06-15";

          const subs: CatchUpSubscription[] = subSpecs.map((s) => ({
            id: s.id,
            // nextRenewal is `now`'s day shifted by dayOffset (unique per id not
            // required for this property).
            nextRenewal: addDays(nowDay, s.dayOffset),
            state: s.state,
          }));

          const lastRunAt =
            lastRunHoursAgo === null
              ? null
              : new Date(nowMs - lastRunHoursAgo * 3_600_000).toISOString();
          const ledger: ReminderLedger = { version: 1, lastRunAt, fired: firedEvents };
          const firedIds = new Set(firedEvents.map(identity));

          const anchorMs = Math.max(
            nowMs - lookbackHours * 3_600_000,
            lastRunAt === null ? -Infinity : Date.parse(lastRunAt),
          );

          const result = catchUp(subs, ledger, now, lookbackHours);

          for (const e of result) {
            // (1) Only renewal events.
            expect(e.kind).toBe("renewal");
            // (2) Never a Paused sub.
            const sub = subs.find((s) => s.id === e.subscriptionId);
            expect(sub).toBeDefined();
            expect(sub?.state === "Active" || sub?.state === "Trial").toBe(true);
            // (3) Never an already-fired identity.
            expect(firedIds.has(identity(e))).toBe(false);
            // (4) The fire-moment (UTC midnight of localDay) is within the window.
            const fireMs = Date.parse(`${e.localDay}T00:00:00.000Z`);
            expect(fireMs >= anchorMs && fireMs <= nowMs).toBe(true);
          }
          // No duplicate identities in a single pass over unique-id subs.
          expect(new Set(result.map(identity)).size).toBe(result.length);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
