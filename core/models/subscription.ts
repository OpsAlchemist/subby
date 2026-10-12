/**
 * Subscription model (Req 3.4, 6.2).
 *
 * Platform-independent. MUST NOT import from `electron`, `react`, or Node's `fs`.
 * Currency is single-currency (INR) for this build but retained per
 * subscription for future multi-currency support (Req 6.2).
 */

export type BillingCycle =
  | "Weekly"
  | "Monthly"
  | "Quarterly"
  | "Half-Yearly"
  | "Yearly"
  | "Custom";

export interface CustomInterval {
  // Used only when billingCycle === "Custom"
  unit: "day" | "week" | "month" | "year";
  count: number; // positive integer
}

export interface Subscription {
  id: string; // unique (uuid v4)
  name: string; // required, non-empty
  provider: string;
  category: string; // Category name
  amount: number; // non-negative
  currency: string; // e.g. "INR"
  billingCycle: BillingCycle;
  customInterval?: CustomInterval; // present when billingCycle === "Custom"
  nextRenewal: string; // ISO date (YYYY-MM-DD)
  startDate: string; // ISO date
  paymentMethod: string;
  website: string;
  notes: string;
  color: string; // hex, for UI accent
  icon: string; // lucide icon key or provider slug
  isActive: boolean;
  autoRenew: boolean;
  createdAt: string; // ISO datetime
  updatedAt: string; // ISO datetime
}

/** Root file shape for `subscriptions.json` (Req 1.2). */
export interface SubscriptionsFile {
  version: number;
  subscriptions: Subscription[];
}

// --- v2 shapes (additive; AD-10, AD-17, AD-21) -------------------------------
// These are the migration/Epic-2/Epic-3 targets. They are added as new
// definitions; the v1 shapes above stay unchanged and the running app keeps
// using them until Epic 3 flips the renderer and the setState IPC. No code
// reads or writes `version: 2` files on disk in this story (that is Story
// 1.3/1.4) — these shapes only *define* the target.

/**
 * Three-way subscription State (AD-17). Replaces v1's boolean `isActive`
 * (migration maps `true` -> "Active", `false` -> "Paused"). `Trial` is a
 * distinct state so a free trial never pollutes current spend (Trial = $0
 * until it converts; the Active count is Active + Trial).
 */
export type SubscriptionState = "Active" | "Paused" | "Trial";

/**
 * Embedded trial, present only when `state === "Trial"` (AD-17 / AD-18).
 *
 * Trial length is only ever an explicit `endDate` OR `startDate` + `lengthDays`
 * — **months are deliberately unrepresentable** (AD-18). `postAmountMinor` is
 * the amount (integer minor units, Native Currency) that will be charged once
 * the trial converts.
 */
export type TrialV2 =
  | {
      // Explicit end date; the subscription converts on this calendar day.
      endDate: string; // ISO date (YYYY-MM-DD)
      startDate?: string; // ISO date, optional context
      lengthDays?: never;
      postAmountMinor: number; // integer minor units, Native Currency
    }
  | {
      // Start + a whole number of days; conversion day is derived from these.
      startDate: string; // ISO date (YYYY-MM-DD)
      lengthDays: number; // positive integer number of DAYS (never months)
      endDate?: never;
      postAmountMinor: number; // integer minor units, Native Currency
    };

/**
 * One append-only price-history entry embedded on a v2 Subscription (AD-21).
 * Amounts are integer minor units in the entry's own `currency`.
 */
export interface PriceEntryV2 {
  amountMinor: number; // integer minor units
  currency: string; // the Native Currency at the time of this entry
  date: string; // ISO date (YYYY-MM-DD) this price took effect
}

/**
 * v2 Subscription (AD-10 / AD-17 / AD-21). Differences from v1:
 *   - `amount` (float major) -> `amountMinor` (integer minor units) in `money.ts`.
 *   - `currency` is the subscription's Native Currency.
 *   - `isActive` (boolean) -> `state` (three-way enum) with optional `trial`.
 *   - adds append-only `priceHistory` and free-form `tags`.
 * All other fields carry over unchanged from v1.
 */
export interface SubscriptionV2 {
  id: string; // unique (uuid v4)
  name: string; // required, non-empty
  provider: string;
  category: string; // Category name
  amountMinor: number; // integer minor units, Native Currency (AD-10)
  currency: string; // Native Currency, e.g. "USD"
  billingCycle: BillingCycle;
  customInterval?: CustomInterval; // present when billingCycle === "Custom"
  nextRenewal: string; // ISO date (YYYY-MM-DD)
  startDate: string; // ISO date
  paymentMethod: string;
  website: string;
  notes: string;
  color: string; // hex, for UI accent
  icon: string; // lucide icon key or provider slug
  state: SubscriptionState; // AD-17 (replaces isActive)
  trial?: TrialV2; // embedded, present when state === "Trial"
  priceHistory: PriceEntryV2[]; // append-only (AD-21)
  tags: string[]; // free-form labels
  autoRenew: boolean;
  createdAt: string; // ISO datetime
  updatedAt: string; // ISO datetime
}

/** Root file shape for `subscriptions.json` under schema v2 (`version: 2`). */
export interface SubscriptionsFileV2 {
  version: 2;
  subscriptions: SubscriptionV2[];
}
