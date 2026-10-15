/**
 * Notification decision logic (Req 13.1, 13.5; Epic 4 — AD-18 / AD-19).
 *
 * Platform-independent. MUST NOT import from `electron`, `react`, or Node's `fs`,
 * and reads NO argless wall clock — every instant/offset is a PARAMETER so the
 * impure electron layer owns the clock and the OS timezone offset.
 *
 * Date math is performed in UTC to avoid timezone drift. Dates are handled as
 * ISO date strings (`YYYY-MM-DD`). The platform Notification_Service maps the
 * output of `dueLeadTimes` to actual `new Notification(...)` calls.
 *
 * This file also carries the persisted-reminder-ledger decision helpers
 * (`reminderDay`, `unfired`, `catchUp`, `prune`) the scheduler (4.2) and launch
 * catch-up (4.3) consume — see the ledger section below.
 */

import type { ReminderLeadTime } from "./models/settings";
import type { ISODate } from "./renewal";
import type { SubscriptionState, TrialV2 } from "./models/subscription";
import { conversionDate } from "./trial";
import type {
  ReminderEvent,
  ReminderEventKind,
  ReminderLedger,
} from "./models/reminder";

/**
 * The only subscription field {@link dueLeadTimes} reads: the renewal date.
 * Structural so it serves both v1 `Subscription` and v2 `SubscriptionV2` (the
 * field is identical across versions).
 */
interface RenewableSubscription {
  nextRenewal: string;
}

/** Days before `nextRenewal` that each lead time targets. */
const LEAD_TIME_OFFSET_DAYS: Record<ReminderLeadTime, number> = {
  "same-day": 0,
  "one-day": 1,
  "three-days": 3,
};

/**
 * Canonical, deterministic ordering for emitted lead times. Independent of the
 * order of the `enabled` argument so the result is stable for a given input set.
 */
const LEAD_TIME_ORDER: readonly ReminderLeadTime[] = ["same-day", "one-day", "three-days"];

/** Parses an `YYYY-MM-DD` string into its numeric year/month/day parts. */
function parseISODate(date: ISODate): { year: number; month: number; day: number } {
  const [year, month, day] = date.split("-").map((part) => Number.parseInt(part, 10));
  return { year, month, day };
}

/** Formats numeric year/month/day parts back into an `YYYY-MM-DD` string. */
function formatISODate(year: number, month: number, day: number): ISODate {
  const yyyy = String(year).padStart(4, "0");
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Adds a whole number of days to an ISO date using UTC arithmetic. */
function addDays(date: ISODate, days: number): ISODate {
  const { year, month, day } = parseISODate(date);
  const utc = new Date(Date.UTC(year, month - 1, day));
  utc.setUTCDate(utc.getUTCDate() + days);
  return formatISODate(utc.getUTCFullYear(), utc.getUTCMonth() + 1, utc.getUTCDate());
}

/**
 * Returns the subset of `enabled` lead times whose target date equals `today`
 * for the given subscription (Req 13.1, 13.5):
 *
 * - "same-day"   qualifies when `sub.nextRenewal === today`
 * - "one-day"    qualifies when `sub.nextRenewal === today + 1 day`
 * - "three-days" qualifies when `sub.nextRenewal === today + 3 days`
 *
 * Only lead times that are both enabled AND due today are returned. The result
 * is in a deterministic canonical order (same-day, one-day, three-days),
 * regardless of the order of the `enabled` argument, and contains no duplicates.
 *
 * The subscription's `nextRenewal` is the source of truth; callers that roll
 * past renewals forward should do so before calling this function. Reading the
 * current `enabled` lead times on each evaluation lets updated notification
 * timing apply to subsequent evaluations (Req 13.5).
 */
export function dueLeadTimes(
  sub: RenewableSubscription,
  today: ISODate,
  enabled: ReminderLeadTime[],
): ReminderLeadTime[] {
  const enabledSet = new Set(enabled);
  return LEAD_TIME_ORDER.filter((leadTime) => {
    if (!enabledSet.has(leadTime)) return false;
    const targetDate = addDays(today, LEAD_TIME_OFFSET_DAYS[leadTime]);
    return sub.nextRenewal === targetDate;
  });
}

/**
 * The minimal, structural subscription shape {@link trialEndDue} reads: the
 * three-way `state` (only a `Trial` carries a trial) and the optional embedded
 * `trial`, plus the `id` that keys the emitted events. Structural so it serves
 * the live `SubscriptionV2` and any test fixture without a breaking retype.
 */
export interface TrialEndSubscription {
  id: string;
  state: SubscriptionState;
  trial?: TrialV2;
}

/**
 * The due TRIAL-END reminder events for a Trial subscription (Story 5.2) — the
 * one-shot sibling of {@link dueLeadTimes}'s recurring renewal decision, keyed
 * on the trial's conversion date instead of a billing renewal.
 *
 * Returns `[]` unless `sub.state === "Trial"` (only a Trial carries a trial — an
 * Active/Paused sub has no conversion to warn about). For each ENABLED lead time
 * it computes the STABLE target fire date
 * `targetDay = addDays(conversionDate(trial), -LEAD_TIME_OFFSET_DAYS[leadTime])`
 * and includes a `{kind:"trial-end", subscriptionId, leadTime, localDay: targetDay}`
 * event when `targetDay === localToday || targetDay === utcToday`.
 *
 * CONSERVATIVE earlier-of-local/UTC (AD-18): a trial reminder that arrives AFTER
 * the card is charged is worthless, so the due check fires on whichever of the
 * local-wall-clock or UTC calendar interpretation reaches the target day FIRST
 * (the earlier interpretation triggers first → NEVER after the charge). Keying
 * the dedupe `localDay` on the STABLE `targetDay` (derived from the trial, not
 * from `today`) means the periodic tick and the launch catch-up stamp an
 * IDENTICAL `(trial-end, sub, leadTime, conversion)` identity, so a reminder
 * shown by one path is never re-shown by the other (same seam discipline as the
 * renewal fix in 4.3). Result is in canonical lead-time order, no duplicates.
 *
 * Pure and total: it reads only the sub's state/trial and the two injected
 * calendar days; it never reads a wall clock and never throws (a Trial always
 * carries its `trial` per the v2 schema invariant, so the guard is defensive).
 */
export function trialEndDue(
  sub: TrialEndSubscription,
  localToday: ISODate,
  utcToday: ISODate,
  enabled: ReminderLeadTime[],
): ReminderEvent[] {
  // Only a Trial has a conversion to warn about; Active/Paused never fire a
  // trial-end reminder. The `trial` guard is defensive (the schema guarantees a
  // Trial carries it) so a malformed fixture degrades to [] rather than throwing.
  if (sub.state !== "Trial" || sub.trial === undefined) {
    return [];
  }
  const converts = conversionDate(sub.trial);
  // FAIL-CLOSED (symmetric with `catchUpTrialEnds`): a trial whose conversion
  // date is unparseable emits nothing — skip it explicitly rather than relying on
  // the no-match path, so a NaN-bearing target can never leak into a dedupe key.
  if (!isParseableISODate(converts)) {
    return [];
  }
  const enabledSet = new Set(enabled);
  const out: ReminderEvent[] = [];
  for (const leadTime of LEAD_TIME_ORDER) {
    if (!enabledSet.has(leadTime)) continue;
    const targetDay = addDays(converts, -LEAD_TIME_OFFSET_DAYS[leadTime]);
    // Earlier-of-local/UTC: due the moment EITHER calendar interpretation
    // reaches the target day — the earlier one fires before the later charge.
    if (targetDay === localToday || targetDay === utcToday) {
      out.push({
        kind: "trial-end" satisfies ReminderEventKind,
        subscriptionId: sub.id,
        leadTime,
        // STABLE target-day dedupe bucket (derived from the trial, not `today`)
        // — identical across the tick and the catch-up (seam-safe, SM-2).
        localDay: targetDay,
      });
    }
  }
  return out;
}

// =============================================================================
// Persisted reminder ledger decision logic (Epic 4, Story 4.1 — AD-18 / AD-19).
//
// These helpers are the PURE core the scheduler (4.2) and launch catch-up (4.3)
// will consume. They stay pure: no `electron`/`react`/`fs`, and NO argless wall
// clock — every instant/offset is a PARAMETER so the impure electron layer owns
// the clock and the OS timezone offset.
//
// FAIL-CLOSED CONTRACT (amended iteration 1): callers pass schema-validated
// values, but these guards are defense-in-depth so a bad value degrades to
// UNDER-firing (safe) rather than OVER-firing or data loss. A NaN/unparseable
// input must NEVER make `catchUp` emit every event or `reminderDay` return
// `"NaN-NaN-NaN"` as a persisted dedupe key.
// =============================================================================

const MS_PER_HOUR = 3_600_000;
const MS_PER_MINUTE = 60_000;

/**
 * The dedupe IDENTITY of a reminder event: the tuple
 * `(kind, subscriptionId, leadTime, localDay)` joined with a NUL separator.
 *
 * The separator is the ESCAPE sequence `"\u0000"` — a NUL character — chosen
 * because it can never appear inside any of the four fields, so no field value
 * can collide across the join boundary (e.g. an `id` ending in a dash plus a
 * `leadTime` starting with one). It MUST be written as this escape, never as a
 * raw NUL byte in source: a raw NUL makes this `.ts` file non-UTF-8 and git
 * treats it as binary. The escape compiles to the identical runtime character.
 */
function eventIdentity(event: ReminderEvent): string {
  return [event.kind, event.subscriptionId, event.leadTime, event.localDay].join(
    "\u0000",
  );
}

/**
 * The ONE canonical local-calendar-day function (AD-18). Shifts the UTC
 * `instant` by `tzOffsetMinutes` (minutes EAST of UTC, e.g. IST = +330) and
 * returns the resulting LOCAL `YYYY-MM-DD` calendar day. This single value is
 * the ledger dedupe-key component everywhere — there is no second clock keying
 * reminders differently.
 *
 * Pure: it reads the instant + offset from its arguments, never an argless wall
 * clock. UTC date math (via `Date.UTC` on the shifted epoch) keeps it timezone-
 * drift-free.
 *
 * FAIL-CLOSED: an unparseable `instant` or a non-finite `tzOffsetMinutes` throws
 * a {@link RangeError} rather than returning a `NaN`-bearing `"NaN-NaN-NaN"` day
 * — a NaN day must never be persisted as a dedupe key (it would never dedupe).
 */
export function reminderDay(instant: string, tzOffsetMinutes: number): string {
  if (!Number.isFinite(tzOffsetMinutes)) {
    throw new RangeError(
      `reminderDay: tzOffsetMinutes must be finite, got ${tzOffsetMinutes}`,
    );
  }
  const epochMs = Date.parse(instant);
  if (Number.isNaN(epochMs)) {
    throw new RangeError(`reminderDay: unparseable instant ${JSON.stringify(instant)}`);
  }
  // Shift the instant into local wall-clock time, then read its UTC Y/M/D — the
  // shifted epoch's UTC calendar fields ARE the local calendar fields.
  const shifted = new Date(epochMs + tzOffsetMinutes * MS_PER_MINUTE);
  // A finite-but-huge offset (e.g. 1e20) can push the shifted epoch past Date's
  // valid range, making it an Invalid Date whose fields are NaN. Guard it so the
  // forbidden `NaN`-bearing day can never escape (fail-closed, not just finite).
  if (Number.isNaN(shifted.getTime())) {
    throw new RangeError(
      `reminderDay: offset ${tzOffsetMinutes} produces an out-of-range date`,
    );
  }
  return formatISODate(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
  );
}

/**
 * The due events whose dedupe identity is NOT already present in `ledger.fired`
 * (order-preserving set-difference). A different `kind` is a distinct identity,
 * so a `trial-end` event is never deduped against a `renewal` of the same
 * subscription/leadTime/day and vice-versa.
 *
 * Pure and total: it reads only the identity tuples; it never throws.
 */
export function unfired(
  due: ReminderEvent[],
  ledger: ReminderLedger,
): ReminderEvent[] {
  const fired = new Set(ledger.fired.map(eventIdentity));
  return due.filter((event) => !fired.has(eventIdentity(event)));
}

/**
 * The minimal, structural subscription shape {@link catchUp} reads: the fields
 * it needs and nothing more, so it serves the live `SubscriptionV2` and any
 * test fixture without a breaking retype. `state` gates eligibility
 * (Active/Trial fire; Paused never does); `id` keys the emitted events.
 */
export interface CatchUpSubscription {
  id: string;
  nextRenewal: string; // ISO date (YYYY-MM-DD)
  state: "Active" | "Paused" | "Trial";
}

/**
 * The renewal events whose fire-moment passed while the app was CLOSED — within
 * the look-back window and not already fired — for the launch catch-up pass
 * (Story 4.3 will consume this; 4.1 only ships it).
 *
 * The window is `[anchor, now]` where `anchor = max(lastRunAt ?? -inf,
 * now - lookbackHours)` — anchored on the ledger's `lastRunAt` so a long
 * downtime still only looks back as far as the configured cap, and a short one
 * only re-checks since the last completed pass. Only `Active`/`Trial` subs are
 * eligible — a `Paused` sub NEVER fires. Already-fired identities (per the
 * ledger) are dropped.
 *
 * CONSERVATIVE earlier-of-local/UTC (AD-18): a reminder that fires AFTER the
 * charge is worthless, so where the local-day and UTC-day interpretations of a
 * fire-moment differ, the EARLIER bucket wins. Each `(sub, leadTime)` fires at
 * the START of its target day (`nextRenewal - offsetDays`); its fire-moment is
 * taken as that day's UTC midnight (the earliest instant any timezone assigns to
 * that calendar day), and its `localDay` is the target date itself. Using UTC
 * midnight is the conservative lower bound: it never places the moment later
 * than any real local interpretation would.
 *
 * FAIL-CLOSED: a non-parseable `now` or a non-finite `lookbackHours` returns
 * `[]` (emit NOTHING — never fall through the window guard and fire everything);
 * a per-sub unparseable `nextRenewal` SKIPS that sub only. The result is in a
 * deterministic order: subs in input order, lead times in canonical order.
 */
export function catchUp(
  subs: CatchUpSubscription[],
  ledger: ReminderLedger,
  now: string,
  lookbackHours: number,
): ReminderEvent[] {
  // FAIL-CLOSED guard on the window inputs: a bad `now`/`lookbackHours` must emit
  // NOTHING rather than let a NaN comparison wave every event through.
  const nowMs = Date.parse(now);
  if (Number.isNaN(nowMs) || !Number.isFinite(lookbackHours)) {
    return [];
  }

  // Anchor = max(lastRunAt, now - lookbackHours). A negative `lookbackHours`
  // yields an anchor AFTER `now`, producing an empty window (nothing fires) —
  // the safe direction. An unparseable `lastRunAt` is treated as -inf (ignored),
  // so the look-back cap governs.
  const lookbackMs = lookbackHours * MS_PER_HOUR;
  const windowStartMs = nowMs - lookbackMs;
  let anchorMs = windowStartMs;
  if (ledger.lastRunAt !== null) {
    const lastRunMs = Date.parse(ledger.lastRunAt);
    if (!Number.isNaN(lastRunMs) && lastRunMs > anchorMs) {
      anchorMs = lastRunMs;
    }
  }

  const firedSet = new Set(ledger.fired.map(eventIdentity));
  const out: ReminderEvent[] = [];

  for (const sub of subs) {
    // Eligibility: Active/Trial fire; Paused NEVER does.
    if (sub.state !== "Active" && sub.state !== "Trial") {
      continue;
    }
    // FAIL-CLOSED: a sub with an unparseable renewal date emits nothing — skip it
    // rather than let its NaN fire-moment slip through the window check.
    if (!isParseableISODate(sub.nextRenewal)) {
      continue;
    }
    for (const leadTime of LEAD_TIME_ORDER) {
      const targetDate = addDays(sub.nextRenewal, -LEAD_TIME_OFFSET_DAYS[leadTime]);
      // Conservative lower bound: UTC midnight of the target day is the earliest
      // instant any timezone assigns to that calendar day.
      const fireMomentMs = utcMidnightMs(targetDate);
      if (fireMomentMs < anchorMs || fireMomentMs > nowMs) {
        continue; // outside the catch-up window
      }
      const event: ReminderEvent = {
        kind: "renewal" satisfies ReminderEventKind,
        subscriptionId: sub.id,
        leadTime,
        localDay: targetDate,
      };
      if (!firedSet.has(eventIdentity(event))) {
        out.push(event);
      }
    }
  }
  return out;
}

/**
 * The minimal, structural subscription shape {@link catchUpTrialEnds} reads: the
 * `id` that keys events, the three-way `state` that gates eligibility (only
 * `Trial` fires a trial-end), and the optional embedded `trial` whose conversion
 * date anchors the target. Structural so it serves the live `SubscriptionV2` and
 * any test fixture without a breaking retype.
 */
export interface CatchUpTrialSubscription {
  id: string;
  state: SubscriptionState;
  trial?: TrialV2;
}

/**
 * The TRIAL-END events whose fire-moment passed while the app was CLOSED — the
 * one-shot sibling of {@link catchUp} (which stays renewal-only and is NOT
 * modified). Same window/fail-closed shape; the only differences are the
 * eligibility (`state:"Trial"` only — never Active or Paused) and the target
 * (`addDays(conversionDate(trial), -leadDays)` instead of a renewal offset).
 *
 * The window is `[anchor, now]` where `anchor = max(lastRunAt ?? -inf,
 * now - lookbackHours)` — identical to `catchUp`. Each `(sub, leadTime)` fires at
 * the START of its target day; its fire-moment is that day's UTC midnight (the
 * earliest instant any timezone assigns to the day — the conservative lower
 * bound), and its `localDay` is the target date itself. Because that target is
 * the STABLE `conversionDate - leadDays`, it matches the identity
 * {@link trialEndDue} stamps on the live tick, so a trial-end shown by one path
 * is never re-shown by the other (seam-safe, SM-2). Already-fired identities (per
 * the ledger) are dropped.
 *
 * FAIL-CLOSED (exactly like `catchUp`): a non-parseable `now` or a non-finite
 * `lookbackHours` returns `[]` (emit NOTHING — never wave every event through a
 * NaN comparison); a per-sub unparseable `conversionDate` SKIPS that sub only.
 * The result is in a deterministic order: subs in input order, lead times in
 * canonical order. No `offsetMinutes` parameter — the UTC-midnight fire-moment is
 * offset-independent, so (like the frozen `catchUp`) none is needed.
 *
 * ONE-SHOT CONSEQUENCE: unlike a recurring renewal — which re-arms every billing
 * cycle, so a missed one simply fires on the next cycle — a trial-end is a single
 * event; a trial-end whose moment passed more than LOOKBACK_HOURS (24h) before
 * launch falls outside this inherited window and is UNRECOVERABLE (it never fires
 * at all). This is a conscious trade-off: the 24h value is the PRD FR-7 cap and is
 * NOT widened for trial-end.
 */
export function catchUpTrialEnds(
  subs: CatchUpTrialSubscription[],
  ledger: ReminderLedger,
  now: string,
  lookbackHours: number,
): ReminderEvent[] {
  // FAIL-CLOSED guard on the window inputs: a bad `now`/`lookbackHours` must emit
  // NOTHING rather than let a NaN comparison wave every event through.
  const nowMs = Date.parse(now);
  if (Number.isNaN(nowMs) || !Number.isFinite(lookbackHours)) {
    return [];
  }

  // Anchor = max(lastRunAt, now - lookbackHours) — identical to `catchUp`.
  const lookbackMs = lookbackHours * MS_PER_HOUR;
  const windowStartMs = nowMs - lookbackMs;
  let anchorMs = windowStartMs;
  if (ledger.lastRunAt !== null) {
    const lastRunMs = Date.parse(ledger.lastRunAt);
    if (!Number.isNaN(lastRunMs) && lastRunMs > anchorMs) {
      anchorMs = lastRunMs;
    }
  }

  const firedSet = new Set(ledger.fired.map(eventIdentity));
  const out: ReminderEvent[] = [];

  for (const sub of subs) {
    // Eligibility: ONLY a Trial fires a trial-end — Active AND Paused never do.
    if (sub.state !== "Trial" || sub.trial === undefined) {
      continue;
    }
    const converts = conversionDate(sub.trial);
    // FAIL-CLOSED: a trial whose conversion date is unparseable emits nothing —
    // skip it rather than let its NaN fire-moment slip through the window check.
    if (!isParseableISODate(converts)) {
      continue;
    }
    for (const leadTime of LEAD_TIME_ORDER) {
      const targetDate = addDays(converts, -LEAD_TIME_OFFSET_DAYS[leadTime]);
      // Conservative lower bound: UTC midnight of the target day is the earliest
      // instant any timezone assigns to that calendar day.
      const fireMomentMs = utcMidnightMs(targetDate);
      if (fireMomentMs < anchorMs || fireMomentMs > nowMs) {
        continue; // outside the catch-up window
      }
      const event: ReminderEvent = {
        kind: "trial-end" satisfies ReminderEventKind,
        subscriptionId: sub.id,
        leadTime,
        localDay: targetDate,
      };
      if (!firedSet.has(eventIdentity(event))) {
        out.push(event);
      }
    }
  }
  return out;
}

/**
 * The ledger with `fired` entries whose `localDay` is OLDER than the retention
 * window dropped — the retention prune (Story 4.2/4.3 will schedule it; 4.1 only
 * ships it). An entry is KEPT when `localDay >= today - retentionDays`
 * (lexicographic `YYYY-MM-DD` comparison). `lastRunAt` and newer entries are
 * never touched; order is preserved.
 *
 * FAIL-CLOSED: a negative `retentionDays` is clamped to `0` (keep only
 * today-or-newer — never a negative cutoff that drops newer entries); a
 * non-finite `retentionDays` or an unparseable `today` leaves the ledger
 * UNCHANGED (never drop entries off a NaN cutoff).
 */
export function prune(
  ledger: ReminderLedger,
  today: ISODate,
  retentionDays: number,
): ReminderLedger {
  // FAIL-CLOSED: an unparseable `today` or a non-finite retention is a no-op —
  // better to keep stale entries than to drop valid (newer) ones off a bad
  // cutoff.
  if (!isParseableISODate(today) || !Number.isFinite(retentionDays)) {
    return ledger;
  }
  const clampedRetention = retentionDays < 0 ? 0 : Math.floor(retentionDays);
  const cutoff = addDays(today, -clampedRetention);
  return {
    ...ledger,
    fired: ledger.fired.filter((event) => event.localDay >= cutoff),
  };
}

/** True when `date` is a well-formed, parseable `YYYY-MM-DD` calendar date. */
function isParseableISODate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const { year, month, day } = parseISODate(date);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return false;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  // Reject non-existent calendar days (e.g. 2026-02-30) by round-tripping
  // through UTC date math.
  const utc = new Date(Date.UTC(year, month - 1, day));
  return (
    utc.getUTCFullYear() === year &&
    utc.getUTCMonth() + 1 === month &&
    utc.getUTCDate() === day
  );
}

/** The UTC-midnight epoch-ms of a `YYYY-MM-DD` calendar date. */
function utcMidnightMs(date: ISODate): number {
  const { year, month, day } = parseISODate(date);
  return Date.UTC(year, month - 1, day);
}
