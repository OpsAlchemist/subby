/**
 * Trial tracking and conversion (Story 5.1; AD-17, AD-18).
 *
 * Platform-independent. MUST NOT import from `electron`, `react`, or Node's
 * `fs`, and reads NO wall clock (AD-1) — a trial's conversion day is derived
 * purely from the trial's own `endDate` / `startDate` + `lengthDays`, never from
 * "now". Every function here is PURE: it never mutates its inputs in place
 * (`convertTrial` returns a NEW subscription, leaving the original untouched)
 * and it never reads the clock.
 *
 * This is the pure-core spine Story 5.1's UI renders over, and that Story 5.2
 * (trial-end reminders) and Epic 6.1 (FX dashboard) reuse unchanged:
 *   - {@link conversionDate} answers "what calendar day does this trial convert?"
 *     — the explicit `endDate`, or `startDate` + `lengthDays` via the existing
 *     `core/renewal.addDays`. Total over the valid {@link TrialV2} union; it does
 *     NOT compute the conservative earlier-of-local/UTC fire moment (that is
 *     Story 5.2's firing rule) — this is the plain conversion day.
 *   - {@link trialsConvertFigure} answers "how much more per month, and across how
 *     many trials, when they convert?" — a native-currency minor-unit sum over
 *     the Trial subset (matching the current no-FX Dashboard posture; the
 *     FX-correct `homeTotal` version is Epic 6.1).
 *   - {@link convertTrial} answers "what does a converted trial look like?" — a
 *     Trial → Active transform that applies the post-trial amount and drops the
 *     embedded `trial`, a no-op for a non-Trial subscription.
 *
 * The actual conversion is MANUAL (an action the user takes); nothing here
 * auto-converts a trial when its date passes — that would be scheduler logic and
 * is deliberately out of this story's scope.
 */

import { monthlyAmount } from "./billing";
import type { SubscriptionV2, TrialV2 } from "./models/subscription";
import { addDays, type ISODate } from "./renewal";
import { trialSubscriptionsV2 } from "./subscriptionsV2";

/**
 * The native-currency monthly figure and trial count the Dashboard surfaces as
 * "+ {money}/mo when {count} trials convert".
 */
export interface TrialsConvertFigure {
  /**
   * The summed normalized MONTHLY amount (integer minor units) each trial would
   * add once it converts — a native-currency minor-unit sum with NO FX, matching
   * the current Dashboard's month total (Epic 6.1 brings the convert-before-sum
   * Home total). Fractional after a sub-monthly division; rounded only at display.
   */
  monthlyMinor: number;
  /** The number of Trial subscriptions contributing to {@link monthlyMinor}. */
  count: number;
}

/**
 * The calendar day a trial converts (Req: trial length is an explicit end date
 * OR start + N whole days — never months, AD-18).
 *
 * Returns the explicit `endDate` when the trial carries one; otherwise derives
 * it from `startDate` + `lengthDays` using the UTC-correct {@link addDays} from
 * `core/renewal` (the single day-shift seam). Total over the valid
 * {@link TrialV2} union — exactly one of the two variants is always present.
 *
 * This is the PLAIN conversion day only; the conservative earlier-of-local/UTC
 * fire moment for the trial-end reminder is Story 5.2's concern, not this.
 */
export function conversionDate(trial: TrialV2): ISODate {
  // The endDate variant converts on its explicit day; the start+days variant
  // derives the day. The union guarantees exactly one branch applies.
  if (trial.endDate !== undefined) {
    return trial.endDate;
  }
  return addDays(trial.startDate, trial.lengthDays);
}

/**
 * The trials-convert figure for the Dashboard's muted secondary line.
 *
 * Operates ONLY over the Trial subset (via {@link trialSubscriptionsV2}, the
 * single state seam); plain-Active and Paused subscriptions are ignored — a
 * Trial costs $0 toward current spend, so this is the separate "what converts"
 * figure. For each trial it normalizes the trial's `postAmountMinor` to a
 * monthly amount through the existing {@link monthlyAmount} (reusing the sub's
 * `billingCycle`/`customInterval`), summing into `monthlyMinor` as a native
 * minor-unit sum (no FX — matching the current month total; Epic 6.1 does the
 * convert-before-sum Home version). `count` is the number of trials. Zero trials
 * yields `{ monthlyMinor: 0, count: 0 }`.
 *
 * Never mutates its input.
 */
export function trialsConvertFigure(subs: SubscriptionV2[]): TrialsConvertFigure {
  const trials = trialSubscriptionsV2(subs);
  const monthlyMinor = trials.reduce((acc, s) => {
    // A Trial in the Trial state always carries an embedded `trial` (the v2
    // schema invariant). Normalize its POST-trial amount — the amount that will
    // actually be charged once it converts — to monthly via the sub's own cycle.
    const postAmountMinor = s.trial?.postAmountMinor ?? 0;
    return (
      acc +
      monthlyAmount({
        amountMinor: postAmountMinor,
        billingCycle: s.billingCycle,
        customInterval: s.customInterval,
      })
    );
  }, 0);
  return { monthlyMinor, count: trials.length };
}

/**
 * Convert a Trial subscription to Active (Req: converting a trial flips its
 * State to Active and applies the post-trial amount, AD-17).
 *
 * Returns a NEW subscription with `state: "Active"`, `amountMinor` set to the
 * trial's `postAmountMinor`, and the embedded `trial` removed — every other
 * field preserved. The input is never mutated. A non-Trial subscription (or a
 * Trial missing its `trial` block, which the v2 schema forbids) is returned
 * UNCHANGED — the same reference, no throw — so a stray convert is a safe no-op.
 *
 * This is the pure transform; persistence (advancing `updatedAt`, writing the
 * patch) is the caller's job and rides the existing `subs:update` path — no new
 * channel. Automatic conversion-on-date is deliberately NOT done here.
 */
export function convertTrial(sub: SubscriptionV2): SubscriptionV2 {
  // No-op guard: only a Trial that actually carries its embedded trial converts.
  if (sub.state !== "Trial" || sub.trial === undefined) {
    return sub;
  }
  // Build the Active result WITHOUT the `trial` key (not merely `trial:
  // undefined`): destructure it off so the returned object has no `trial`
  // property at all, honoring the "trial absent unless Trial" schema invariant.
  const { trial, ...rest } = sub;
  return {
    ...rest,
    state: "Active",
    amountMinor: trial.postAmountMinor,
  };
}
