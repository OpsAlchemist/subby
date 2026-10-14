/**
 * Reminder-ledger domain types (Epic 4, Story 4.1 — AD-18 / AD-19).
 *
 * Platform-independent. MUST NOT import from `electron`, `react`, or Node's `fs`.
 *
 * The ledger is the app's PERSISTED, exactly-once dedupe memory for fired
 * reminders — it replaces the in-memory `Set` that any restart wiped. Its event
 * list is a discriminated union designed, from the start, to carry BOTH the
 * recurring renewal lead-time entries this epic emits AND the one-shot
 * trial-end entries Epic 5 will emit — same fields, distinct `kind` — so Epic 5
 * appends through the identical write path with no schema change on this, the
 * most correctness-critical file.
 *
 * The zod schema + the `defaultReminderLedger()` factory live in `schema.ts`,
 * mirroring how `models/category.ts` keeps the plain TS types here and the
 * runtime validators next door.
 */

import type { ReminderLeadTime } from "./settings";

/**
 * What a fired reminder was FOR. `renewal` is a recurring billing-cycle renewal
 * reminder (this epic); `trial-end` is a one-shot trial-conversion reminder
 * (Epic 5). The two shapes are identical — only the discriminant differs — so a
 * single `ReminderEvent` type, a single schema, and a single dedupe identity
 * serve both.
 */
export type ReminderEventKind = "renewal" | "trial-end";

/**
 * One fired-reminder record. Its DEDUPE IDENTITY is the tuple
 * `(kind, subscriptionId, leadTime, localDay)`: a reminder fires exactly once
 * per that tuple, and a different `kind` (renewal vs trial-end) is a distinct
 * event even for the same subscription/leadTime/day.
 *
 * `localDay` is a `YYYY-MM-DD` canonical LOCAL calendar day produced ONLY by
 * `reminderDay(instant, tzOffsetMinutes)` (AD-18) — never by a second clock.
 */
export interface ReminderEvent {
  kind: ReminderEventKind;
  subscriptionId: string;
  leadTime: ReminderLeadTime;
  localDay: string; // YYYY-MM-DD (canonical local day, from reminderDay)
}

/**
 * Root file shape for `reminder-ledger.json` (AD-19). Versioned so the file
 * participates in the same version-gated safe-read path as the other data
 * files; `version` is a literal `1` for this story.
 *
 *   - `lastRunAt` — the UTC ISO instant of the last completed scheduler pass, or
 *     `null` when the scheduler has never completed a pass. The launch catch-up
 *     pass (Story 4.3) anchors its look-back window on this value.
 *   - `fired`     — the discriminated fired-reminder events (renewal + trial-end).
 */
export interface ReminderLedger {
  version: 1;
  lastRunAt: string | null; // UTC ISO instant of the last completed pass, or null
  fired: ReminderEvent[];
}
