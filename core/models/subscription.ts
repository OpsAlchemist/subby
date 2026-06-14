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
